import {isDeepStrictEqual} from 'node:util';
import type {Store} from '../source/store.js';
import {CalSync, storeAction, type SyncAction} from '../mcp/calendar/sync.js';
import {CALENDAR_SYNC_RETRY_MS, CALENDAR_RECONCILE_RETRY_MS} from '../core/system-config.js';
import {eventTitlePrefixes} from '../core/types.js';

interface CalendarInstance {
  store: Store;
  sync: CalSync;
  actions: Map<string, SyncAction>;
  configuration?: object;
  forward: Set<string>;
  pending: boolean;
  work?: Promise<void>;
  releaseRetryOwner: () => void;
}

const actions = (store: Store) => new Map(store.getActionIds().map(id => [id, structuredClone(storeAction(store, id)!)]));
const configuration = (store: Store) => ({id: store.getManifest().id, ...eventTitlePrefixes(store.getManifest().config)});
const scheduled = (items: Map<string, SyncAction>) => [...items.values()].filter(action =>
  action.frontMatter.scheduled || action.frontMatter.recurrence || action.frontMatter.occurrence);
const usesCalendar = (action?: SyncAction) => !!action?.frontMatter.calendar;
function sameAction(before: SyncAction | undefined, after: SyncAction): boolean {
  if (!before) return false;
  const {delegation: _beforeDelegation, ...beforeMetadata} = before.frontMatter;
  const {delegation: _afterDelegation, ...afterMetadata} = after.frontMatter;
  return before.id === after.id && before.body === after.body && before.description === after.description
    && isDeepStrictEqual(beforeMetadata, afterMetadata);
}

/** Calendar consistency belongs to the instance lifecycle. The syncer retains
 * its domain-specific Calendar protocol, write guards, and operation receipts. */
export class InstanceCalendarLifecycle {
  private readonly instances = new Map<Store, CalendarInstance>();

  constructor(private readonly requestReconciliation: (store: Store, delayMs: number) => void) {
    if (typeof requestReconciliation !== 'function') throw new Error('Calendar lifecycle requires an instance reconciliation scheduler.');
  }

  register(store: Store, sync: CalSync): void {
    if (this.instances.has(store)) return;
    // Establish the baseline before requests can mutate the loaded source.
    // Startup must import Calendar deletions, not recreate every missing event.
    const state: CalendarInstance = {store, sync, actions: actions(store),
      configuration: store.getManifestSourceHealth().complete ? configuration(store) : undefined,
      forward: new Set(), pending: false, releaseRetryOwner: () => {}};
    this.instances.set(store, state);
    state.releaseRetryOwner = sync.setReconciliationOwner(request => {
      if (this.active(state)) this.requestReconciliation(store,
        request.reason === 'lock-contention' ? CALENDAR_RECONCILE_RETRY_MS : CALENDAR_SYNC_RETRY_MS);
    });
  }

  reconcile(store: Store): Promise<void> {
    const state = this.instances.get(store);
    if (!state) return Promise.resolve();
    state.pending = true;
    if (state.work) return state.work;
    const work = Promise.resolve().then(async () => {
      while (this.active(state) && state.pending) {
        state.pending = false;
        // An unreadable manifest is uncertainty, not an identity transition.
        // Preserve the prior generation and its intents until source repair.
        if (!store.getManifestSourceHealth().complete) return;
        const sourceVersion = store.getSourceVersion();
        const current = actions(store), nextConfiguration = configuration(store);
        // The first readable identity establishes a cold baseline. Repairing an
        // unknown initial manifest is not evidence of a deliberate identity edit.
        const configurationChanged = state.configuration !== undefined && !isDeepStrictEqual(state.configuration, nextConfiguration);
        for (const action of current.values()) {
          const previous = state.actions.get(action.id);
          if ((usesCalendar(action) || usesCalendar(previous)) && (configurationChanged || !sameAction(previous, action))) state.forward.add(action.id);
        }
        const forward: SyncAction[] = [];
        for (const id of state.forward) {
          const action = current.get(id), observed = state.sync.status(id);
          // Raw file deletion keeps the existing policy: it does not authorize
          // deleting a Calendar event. Reverse reconciliation drops its cache.
          // A receipt from the previous configuration cannot acknowledge the
          // owner's new replay intent, even if the adapter still reports it.
          if (!action || !configurationChanged && (observed?.status === 'synced' || observed?.status === 'removed')) state.forward.delete(id);
          else forward.push(action);
        }
        const results = await state.sync.syncActions(forward, scheduled(current), {importRecurrenceChanges: true});
        // Only known local intents are retried. A failed cold reverse import
        // must never be reclassified as an intent to recreate a deleted event.
        for (const result of results) if (result.status === 'synced' || result.status === 'deleted'
          || result.status === 'skipped' && (result.reason === 'no event to remove' || result.reason === 'no calendar')) state.forward.delete(result.id);
        state.actions = current;
        state.configuration = nextConfiguration;
        if (!this.active(state)) return;
        // A loaded write can precede its coalesced lifecycle notification.
        // Forward that new snapshot before cold reverse import can interpret
        // a just-created action's missing event as an offline deletion.
        if (state.pending || store.getSourceVersion() !== sourceVersion) {
          state.pending = true;
          continue;
        }
        await state.sync.reconcile(scheduled(current), action =>
          isDeepStrictEqual(nextConfiguration, configuration(store)) && sameAction(current.get(action.id), action));
        // A mutation can also arrive during reverse helper work, before the
        // common owner delivers its next callback. Revisit that loaded revision
        // here; the import predicate kept its local intent intact meanwhile.
        if (store.getSourceVersion() !== sourceVersion) state.pending = true;
      }
      if (state.work === work) state.work = undefined;
    }).finally(() => {if (state.work === work) state.work = undefined;});
    state.work = work;
    return work;
  }

  unregister(store: Store): void {
    // The host owns CalSync disposal; adapters can be reconfigured while the
    // loaded Store and syncer remain alive.
    this.instances.get(store)?.releaseRetryOwner();
    this.instances.delete(store);
  }

  private active(state: CalendarInstance): boolean {return this.instances.get(state.store) === state;}
}
