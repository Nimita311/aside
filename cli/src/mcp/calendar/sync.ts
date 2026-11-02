import { RecurrenceCalSync, isNativeOccurrence } from './recurrence-sync.js';
import { CALENDAR_SYNC_LOCK_TIMEOUT_MS, CALENDAR_SYNC_RETRY_MS, CALENDAR_RECONCILE_RETRY_MS } from '../../core/system-config.js';
import { readManagedText } from '../../core/managed-path.js';
import { formatUtcTimestamp } from '../../core/date.js';
import { dirname, join, relative } from 'node:path';
import { CalClient, CalError, CalUnavailable } from './client.js';
import { SyncLock } from './lock.js';
import { schedulingIssues, isRepeatedSchedule, scheduleInstant } from '../../core/scheduling.js';
import { authorizationDiagnostic, type CalendarDiagnostic } from './diagnostics.js';
import { eventTimingDiagnostic, canReplaceEventTime } from './timing.js';
import { calendarRoutingError, matchingCalendars } from './routing.js';
import { parseActionFile, parseIndex } from '../../core/parser.js';
import { readManifest, readManifestResult } from '../../core/instance.js';
import { isInstanceId, INSTANCE_ID_RULE } from '../../core/identity.js';
import type { Store } from '../store.js';
import type { ActionFrontMatter, InstanceConfig } from '../../core/types.js';
import type { UpsertEventArgs, CalEvent, CalErrorCode, CalCalendar } from './protocol.js';
import {
  buildMarker,
  parseMarker,
  durationMinutes,
  durationIso,
  addMinutesWall,
  startFromScheduled,
  normalizeScheduled,
  type MarkerState,
} from './markers.js';

// The action state forward sync needs: its id, the parsed file, and the one-line
// description from the year index (kept out of the file, included in event notes).
export interface SyncAction {
  id: string;
  frontMatter: ActionFrontMatter;
  body: string;
  description?: string;
}

export type SyncStatus = 'synced' | 'deleted' | 'skipped' | 'error';

export interface SyncResult {
  id: string;
  status: SyncStatus;
  reason?: string; // why skipped / the error
  code?: CalErrorCode; // the helper's structured failure class, when it sent one
  eventId?: string;
  diagnostic?: CalendarDiagnostic;
}

// Latest observable outcome for an action. Pending includes both an active
// helper call and a queued retry; it never means the calendar was updated.
export interface CalendarSyncStatus {
  id: string;
  status: 'pending' | 'synced' | 'removed' | 'disabled' | 'failed';
  reason?: string;
  eventId?: string;
  retry?: boolean;
  diagnostic?: CalendarDiagnostic;
}

interface CalendarFailure {
  id: string;
  reason: string;
  diagnostic?: CalendarDiagnostic;
}

type IndexSnapshot =
  | { descriptions: Map<string, string | undefined> }
  | { error: NodeJS.ErrnoException };

class CalendarIdentityChanged extends Error {}

// Forward sync for one instance. Holds the in-memory event cache (action id ↔
// event id) and syncs actions to their calendar events. The cache is rebuilt by
// a windowed sweep; recurrence handoff hints also seed saved occurrence IDs.
// The daemon runs one syncer per loaded instance; its calendar-mutating phases
// serialize on `lock` (file writes never take it), and stale reverse writes
// are skipped via freshOnDisk.
export class CalSync {
  private recurrenceSync: RecurrenceCalSync;
  private recurrenceFailures = new Map<string, string>();
  private cache = new Map<string, string>();
  private calendars: CalCalendar[] = [];
  private routingBlocked = new Set<string>();
  private timeBlocked = new Map<string, { definition: string; diagnostic: CalendarDiagnostic }>();
  private diagnostics = new Map<string, CalendarDiagnostic>();
  private accessDiagnostic?: CalendarDiagnostic;
  private failureDiagnostic?: CalendarDiagnostic;
  // Events the last sweep matched (action id → event), so a cold reconcile can
  // diff straight from the sweep instead of re-fetching the same events by id.
  private sweptEvents = new Map<string, CalEvent>();
  // Sweep state: `swept` once it has succeeded; `sweepPromise` is the in-flight
  // sweep that concurrent callers share, so a second sync can't race past an
  // unfinished sweep and duplicate an event.
  private swept = false;
  private sweepPromise: Promise<boolean> | null = null;
  // Whether a cold reconcile pass — the one that imports deletions made while
  // the instance was not loaded — has completed. Distinct from `swept`: a capture's
  // syncActions can finish the sweep first, and the first reconcile must still
  // run its startup deletion-import.
  private coldReconciled = false;
  // Actions with a forward op currently in flight, registered before the op's
  // first await and released when it settles. A reconcile racing the op neither
  // imports the (stale) calendar state over the fresh local change nor reads
  // the not-yet-created event as a deletion. Refcounted, not a set: two rapid
  // updates to the same action overlap (both syncActions calls are fire-and-
  // forget), and the first op settling must not strip the guard from the second.
  private inFlight = new Map<string, number>();
  private settled = new Map<string, CalendarSyncStatus>();
  // A positive observation certifies the desired snapshot actually sent to (or
  // observed in) the helper, never a newer Store value read after an await.
  private settledVersions = new Map<string, string>();
  private resultVersions = new WeakMap<SyncResult, string>();
  // A successful floating save is not complete until its canonical wall clock
  // is read back. Keep the saved ID and snapshot through read failures: retries
  // confirm that event, never create another or import a missing-event deletion.
  private confirmations = new Map<string, { action: SyncAction; desired: Extract<Desired, { have: true }>; version: string; eventId: string; instanceId: string }>();
  // delete-event's false result does not distinguish an absent event from one
  // whose marker was removed. Keep that uncertainty until a confirmed outcome.
  private unconfirmedRemovals = new Map<string, string>();
  // Cache a positive access check so we stop round-tripping the helper once
  // granted; keep re-checking while not granted so a later grant is picked up.
  // Reset when the helper dies (a TCC revocation kills it), so revocation
  // degrades to the accurate "no calendar access" path.
  private hasAccess = false;
  // Reporting state for calendar_info. `issues`: actions that should sync but
  // can't (no / missing / read-only calendar) — re-evaluated when the action is
  // next synced. `outbox`: actions whose op hit a transient helper error, retried
  // by the next syncActions or, when no further op comes, by `outboxRetry` — a
  // single self-rescheduling timer, so "will retry" holds even with no further
  // tool call. An action is in at most one of them.
  private issues = new Map<string, string>();
  private outbox = new Map<string, { action: SyncAction; reason: string }>();
  private outboxRetry: ReturnType<typeof setTimeout> | null = null;
  // Actions whose event became part of a recurring series. Sync never modifies,
  // deletes, or imports a recurring event — the action is left unsynced and the
  // condition surfaced via report() until the event is non-recurring again.
  private recurring = new Set<string>();
  // Reverse edits applied since the instance loaded, for calendar_info (capped to the tail).
  private changes: Array<{ id: string; summary: string }> = [];
  // Calendar failures beyond the per-action issues/outbox, also surfaced by
  // calendar_info. `reconcileFailures` is rebuilt every reverse-reconcile pass so
  // it reflects the current state (a clean pass clears it); `sweepFailures` holds
  // problems from the one-time cache sweep (e.g. a duplicate it couldn't prune).
  // Both are scoped by action id, or by the literal `reverse sync` when the whole
  // pass couldn't run.
  private reconcileFailures: CalendarFailure[] = [];
  private sweepFailures: CalendarFailure[] = [];
  // reconcile() serialization: one at a time. `pendingReconcile` doubles as the
  // coalescing queue — a call landing mid-run replaces it, so the single re-run
  // uses the latest caller's action set.
  private reconciling = false;
  private pendingReconcile: SyncAction[] | null = null;
  // Mutation lock on the store's data dir (see lock.ts). Every
  // calendar-mutating phase — a forward batch and a reverse pass, both of which
  // can also prune duplicates via the sweep — runs under it; neither phase calls
  // the other, so holding it across a phase cannot deadlock. `lockRetry` is the
  // single pending re-run of a reconcile that found the lock held — one timer,
  // so contention can't queue retries unboundedly.
  private lock: SyncLock;
  private lockRetry: ReturnType<typeof setTimeout> | null = null;
  private observedIdentity: string | undefined;

  // The manifest values sync depends on (the instance `id` anchoring every
  // marker, and the title-prefix config) are read from the store at use time, so
  // a manifest edit — e.g. adding the missing `id` — takes effect without a
  // restart. `fallbackId` / `fallbackConfig` stand in when there is no store or
  // the manifest doesn't carry the value (tests inject them directly).
  constructor(
    private cal: CalClient,
    private fallbackId: string,
    private store?: Store, // backs reverse sync's action reads and writes; reconcile needs it
    private fallbackConfig?: InstanceConfig,
    private identityBlock?: () => string | null,
  ) {
    this.recurrenceSync = new RecurrenceCalSync(cal);
    this.lock = new SyncLock(store?.getDataDir());
    cal.onExit(() => {
      this.hasAccess = false;
    });
  }

  // Stop the retry timers when the instance unloads; nothing runs on its
  // behalf afterwards.
  dispose(): void {
    if (this.outboxRetry !== null) clearTimeout(this.outboxRetry);
    if (this.lockRetry !== null) clearTimeout(this.lockRetry);
    this.outboxRetry = null;
    this.lockRetry = null;
  }

  // Persist the prior lookup coordinate before an API conversion removes it
  // from the action. This also supports ordinary events from older mirrors.
  prepareTemplateConversion(action: SyncAction): void {
    if (!this.store || !action.frontMatter.scheduled) return;
    try {
      this.recurrenceSync.rememberOrdinaryStart(this.store, this.instanceId, action.id, action.frontMatter.scheduled);
    } catch (error) {
      throw new Error(`Cannot start recurrence because the prior Calendar event's handoff evidence could not be saved: ${(error as Error).message} Repair Calendar integration state and retry; no action records were changed.`, { cause: error });
    }
  }

  private get instanceId(): string {
    return (this.store ? readManifest(this.store.getDataDir()).id : '') || this.fallbackId;
  }

  private manifestReadDiagnostic(): CalendarDiagnostic | undefined {
    if (!this.store) return undefined;
    const issue = readManifestResult(this.store.getDataDir()).issues.find(issue => issue.code === 'read_error');
    return issue ? {
      category: 'instance-manifest-read-error', reason: issue.message,
      recovery: 'Restore the existing aside.md file or its read permissions, preserving its id, then check calendar_info. Pending sync retries remain queued.',
    } : undefined;
  }

  private identityReason(): string | null {
    // A failed read is uncertainty, not an observed identity edit. Keep marker
    // caches and saved-event confirmations intact while all helper work pauses.
    const unreadable = this.manifestReadDiagnostic();
    if (unreadable) return unreadable.reason;
    const id = this.instanceId;
    if (this.observedIdentity !== undefined && this.observedIdentity !== id) {
      // A deliberate manifest identity edit must never reuse another identity's
      // cached event IDs. Queue the current records before reverse reconciliation.
      this.recurrenceSync.reset();
      this.recurrenceFailures.clear();
      this.cache.clear();
      this.sweptEvents.clear();
      this.recurring.clear();
      this.routingBlocked.clear();
      this.timeBlocked.clear();
      this.diagnostics.clear();
      this.sweepFailures = [];
      this.reconcileFailures = [];
      this.settled.clear();
      this.settledVersions.clear();
      this.unconfirmedRemovals.clear();
      this.confirmations.clear();
      this.swept = false;
      this.coldReconciled = false;
      if (this.store) {
        for (const actionId of this.store.getActionIds()) {
          const action = storeAction(this.store, actionId);
          if (action?.frontMatter.scheduled && action.frontMatter.calendar) {
            this.outbox.set(actionId, { action, reason: 'instance identity changed; calendar sync will retry' });
          }
        }
        this.scheduleOutboxRetry();
      }
    }
    this.observedIdentity = id;
    if (!id) return 'instance has no id';
    if (!isInstanceId(id)) return `Invalid instance id ${JSON.stringify(id)}: ${INSTANCE_ID_RULE}; calendar sync is disabled`;
    return this.identityBlock?.() ?? null;
  }

  private requireIdentity(expectedId = this.instanceId): void {
    const previous = this.observedIdentity;
    const reason = this.identityReason();
    if (reason) throw new Error(reason);
    if (expectedId !== this.instanceId || (previous !== undefined && previous !== this.instanceId)) {
      throw new CalendarIdentityChanged('Instance identity changed during calendar sync; retry with the current identity');
    }
  }

  // Event-title prefixes from the instance manifest's `config`, prepended to the
  // action name; defaults applied here — scheduled `▢ `, done `✓ `. Config names
  // prefixes by action lifecycle (scheduled / done); internally a scheduled
  // action's event carries the `active` marker.
  private get prefixes(): { active: string; done: string } {
    const config = this.store?.getManifest().config ?? this.fallbackConfig;
    return { active: config?.scheduledEventTitlePrefix ?? '▢ ', done: config?.doneEventTitlePrefix ?? '✓ ' };
  }

  // The "failure" bucket calendar_info surfaces — the union of every way a change
  // can fail: the instance-level blocker (no id), per-action forward issues and
  // errors, transient forward failures awaiting retry (outbox), actions parked
  // because their event became recurring, and reverse / sweep failures. (The
  // outbox is the retry queue shown here too; statuses() reports completion.)
  report(): Array<{ id: string; reason: string }> {
    const items: Array<{ id: string; reason: string }> = [];
    const identityReason = this.identityReason();
    // The instance id anchors every marker; with none, nothing can sync. Surface
    // it once as a standing failure (per-action would duplicate it N times) rather
    // than skipping silently — there is no fallback, the manifest must carry an `id`.
    if (!this.instanceId) items.push({ id: 'instance', reason: this.manifestReadDiagnostic()?.reason ?? 'aside.md has no `id` — calendar sync is disabled' });
    else {
      if (identityReason) items.push({ id: 'instance', reason: identityReason });
    }
    for (const [id, reason] of this.issues) items.push({ id, reason });
    for (const [id, { reason }] of this.outbox) if (reason !== identityReason) items.push({ id, reason });
    for (const id of this.recurring) {
      items.push({ id, reason: 'calendar event became recurring — recurring events are not synced; remove the recurrence to resume' });
    }
    items.push(...this.sweepFailures, ...this.reconcileFailures);
    return items;
  }

  failureDiagnostics(): Array<{ id: string; diagnostic: CalendarDiagnostic }> {
    const active = new Set(this.report().map(item => item.id));
    const observations = [...this.diagnostics].filter(([id]) => active.has(id)).map(([id, diagnostic]) => ({ id, diagnostic }));
    const manifest = this.manifestReadDiagnostic();
    if (manifest) observations.push({ id: 'instance', diagnostic: manifest });
    // Sweep failures survive a successful primary upsert: that success does not
    // establish that a failed duplicate removal completed.
    for (const failure of [...this.sweepFailures, ...this.reconcileFailures]) {
      if (failure.diagnostic) observations.push({ id: failure.id, diagnostic: failure.diagnostic });
    }
    const unique = new Map(observations.map(item => [JSON.stringify(item), item]));
    return [...unique.values()];
  }

  // Synchronous, so mutation receipts can call this immediately after starting
  // syncActions without waiting on the helper. Live work takes precedence over
  // a previous success, including when multiple updates to one action overlap.
  status(id: string): CalendarSyncStatus | undefined {
    return this.statusForSnapshot(id, new Map());
  }

  private statusForSnapshot(id: string, indexes: Map<string, IndexSnapshot>): CalendarSyncStatus | undefined {
    const state = this.rawStatusForSnapshot(id, indexes);
    if (!state || state.status === 'synced' || state.status === 'removed') return state;
    const diagnostic = this.manifestReadDiagnostic() ?? (!this.cal.available() ? this.cal.availabilityDiagnostic()
      : state.diagnostic ?? this.diagnostics.get(id) ?? (state.status === 'pending' ? { category: 'sync-pending', reason: state.reason ?? 'Calendar sync has not yet been confirmed.', recovery: 'The local record is saved. Check calendar_info for completion; pending retries remain queued.' } : undefined));
    return { ...state, ...(diagnostic ? { diagnostic } : {}) };
  }

  private rawStatusForSnapshot(id: string, indexes: Map<string, IndexSnapshot>): CalendarSyncStatus | undefined {
    const identityReason = this.identityReason();
    if (identityReason) return { id, status: 'disabled', reason: identityReason };
    if (!this.cal.available()) return { id, status: 'disabled', reason: 'calendar helper unavailable' };
    if (this.inFlight.has(id)) return { id, status: 'pending', reason: 'calendar sync in progress' };
    const queued = this.outbox.get(id);
    if (queued) return { id, status: 'pending', reason: queued.reason, retry: true };
    if (this.recurring.has(id)) {
      return { id, status: 'failed', reason: 'calendar event is recurring; remove the recurrence to resume sync' };
    }
    const issue = this.issues.get(id);
    if (issue) return { id, status: issue === 'no calendar' ? 'disabled' : 'failed', reason: issue };
    const failure = [...this.sweepFailures, ...this.reconcileFailures].find((item) => item.id === id);
    if (failure) return { id, status: 'failed', reason: failure.reason, ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}) };
    const result = this.settled.get(id);
    if (result) {
      if (this.store && (result.status === 'synced' || result.status === 'removed')) {
        const file = this.store.getActionFile(id);
        if (!file || !this.store.getAction(id)) return { id, status: 'disabled', reason: 'action no longer exists' };
        let current: SyncAction;
        try {
          const disk = parseActionFile(readManagedText(this.store!.getDataDir(), file)).value;
          current = { id, ...disk };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { id, status: 'disabled', reason: 'action no longer exists' };
          return { id, status: 'failed', reason: `action file unavailable: ${(e as Error).message}` };
        }
        try {
          current.description = this.indexDescriptions(join(dirname(file), 'index.yaml'), indexes).get(id);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') current.description = undefined;
          else return { id, status: 'failed', reason: `action index unavailable: ${(e as Error).message}` };
        }
        const invalid = schedulingIssues(current.frontMatter);
        if (invalid.length) return { id, status: 'failed', reason: invalid.join(' ') };
        if (this.settledVersions.get(id) !== this.desiredVersion(current)) {
          // Direct edits do not queue a forward op. Omit the obsolete positive
          // result until this version is observed, rather than invent pending work.
          if (current.frontMatter.scheduled && !current.frontMatter.calendar) {
            return { id, status: 'disabled', reason: 'no calendar' };
          }
          return undefined;
        }
      }
      return { ...result };
    }
    const action = this.store?.getAction(id);
    if (action?.frontMatter.scheduled && !action.frontMatter.calendar) {
      return { id, status: 'disabled', reason: 'no calendar' };
    }
    return undefined;
  }

  // Share one disk read/parse per year within a report, including read failures.
  // Each new report gets a fresh snapshot so hand edits remain visible.
  private indexDescriptions(file: string, indexes: Map<string, IndexSnapshot>): Map<string, string | undefined> {
    let index = indexes.get(file);
    if (!index) {
      try {
        const descriptions = new Map<string, string | undefined>();
        for (const item of parseIndex(readManagedText(this.store!.getDataDir(), file)).value) {
          if (!descriptions.has(item.id)) descriptions.set(item.id, item.description || undefined);
        }
        index = { descriptions };
      } catch (e) {
        index = { error: e as NodeJS.ErrnoException };
      }
      indexes.set(file, index);
    }
    if ('error' in index) throw index.error;
    return index.descriptions;
  }

  private desiredVersion(action: SyncAction, desired = desiredFromAction(action, this.instanceId, this.prefixes)): string {
    return JSON.stringify({ instance: this.instanceId, desired,
      ...(action.frontMatter.recurrence ? { template: sourceSnapshot(action), prefixes: this.prefixes } : {}) });
  }

  private observeSuccess(action: SyncAction, result: CalendarSyncStatus, version: string): void {
    const current = this.store ? storeAction(this.store, action.id) : action;
    if (current && !current.frontMatter.recurrence && !isNativeOccurrence(this.store, current) &&
      (!this.store || this.freshOnDisk(current)) && this.desiredVersion(current) === version) {
      this.recurrenceSync.acknowledgeOrdinary(action.id, result.status === 'synced' ? result.eventId : undefined, current.frontMatter.scheduled);
    }
    this.settled.set(action.id, result);
    this.settledVersions.set(action.id, version);
    this.clearResolvedFailures(action.id);
  }

  private clearResolvedFailures(id: string): void {
    this.routingBlocked.delete(id);
    this.timeBlocked.delete(id);
    this.diagnostics.delete(id);
    this.issues.delete(id);
    this.unconfirmedRemovals.delete(id);
    this.reconcileFailures = this.reconcileFailures.filter((failure) => failure.id !== id);
  }

  private unobservedFieldsChanged(id: string, desired: Desired): boolean {
    const version = this.settledVersions.get(id);
    if (!version || !desired.have) return false;
    const previous = (JSON.parse(version) as { desired: Desired }).desired;
    // Event reads omit notes. A matching event cannot certify newer local notes;
    // retain the old fingerprint until an actual upsert confirms them.
    return !previous.have || previous.up.notes !== desired.up.notes;
  }

  // Latest states observed since the instance loaded, including positive completion. The
  // action id is canonical and can be used directly in query/update calls.
  statuses(): CalendarSyncStatus[] {
    const ids = new Set([
      ...this.settled.keys(), ...this.inFlight.keys(), ...this.outbox.keys(),
      ...this.issues.keys(), ...this.recurring,
    ]);
    for (const { id } of [...this.sweepFailures, ...this.reconcileFailures]) {
      if (id !== 'reverse sync') ids.add(id);
    }
    for (const id of this.store?.getActionIds() ?? []) {
      const action = this.store!.getAction(id);
      if (action?.frontMatter.scheduled && !action.frontMatter.calendar) ids.add(id);
    }
    const indexes = new Map<string, IndexSnapshot>();
    return [...ids].map((id) => this.statusForSnapshot(id, indexes)!).filter(Boolean);
  }

  // Reverse edits applied since the instance loaded (calendar → action), for calendar_info.
  changesSinceStart(): Array<{ id: string; summary: string }> {
    return this.changes;
  }

  // Append a reverse edit, bounding the log to its recent tail.
  private recordChange(id: string, summary: string): void {
    this.changes.push({ id, summary });
    if (this.changes.length > 100) this.changes.shift();
  }

  // A helper failure that means the process is gone invalidates the cached
  // access check (see hasAccess).
  private noteFailure(e: unknown): void {
    if (e instanceof CalUnavailable) this.hasAccess = false;
    this.failureDiagnostic = this.cal.diagnosticForError(e);
  }

  // The shared access gate: a cached positive check, re-verified while not
  // granted. 'ok' | 'no-access' | the helper error.
  private async checkAccess(): Promise<'ok' | 'no-access' | { error: string }> {
    if (this.hasAccess) return 'ok';
    try {
      const status = (await this.cal.authStatus()).status;
      this.accessDiagnostic = authorizationDiagnostic(status);
      if (status !== 'fullAccess') return 'no-access';
    } catch (e) {
      this.noteFailure(e);
      return { error: (e as Error).message };
    }
    this.hasAccess = true;
    return 'ok';
  }

  // Sync `actions` to events. `allScheduled` seeds the one-time cache sweep so
  // an already-synced action updates its event instead of duplicating it.
  // Best-effort: never throws — failures land in the per-action result.
  //
  // Every attempted action is observable as pending, completed, disabled, or
  // failed. Permanent instance-level blockers skip helper work; transient ones
  // stay in the outbox and remain pending until a retry succeeds.
  async syncActions(actions: SyncAction[], allScheduled: SyncAction[]): Promise<SyncResult[]> {
    const identityReason = this.identityReason();
    if (identityReason) return this.defer(actions, identityReason);
    if (!this.cal.available()) return this.disable(actions, 'calendar helper unavailable');
    // Registered before the first await, so a reconcile overlapping any part of
    // this op leaves these actions alone (see inFlight).
    this.holdInFlight(actions.map((a) => a.id));
    try {
      const access = await this.checkAccess();
      if (access === 'no-access') return this.defer(actions, 'no calendar access', this.accessDiagnostic);
      if (access !== 'ok') return this.defer(actions, `calendar helper error: ${access.error}`, this.failureDiagnostic);
      // The mutating phase (the sweep's duplicate pruning included) serializes
      // with the instance's other phases on the data-dir lock; rather than
      // interleave with a holder that outlasts the wait, defer the batch and retry.
      if (!(await this.lock.acquireWait(CALENDAR_SYNC_LOCK_TIMEOUT_MS))) {
        return this.defer(actions, 'calendar busy (another sync in progress), will retry');
      }
      try {
        this.requireIdentity();
        try { this.calendars = (await this.cal.listCalendars()).calendars; }
        catch (e) { this.noteFailure(e); return this.defer(actions, `calendar routing unavailable, will retry: ${(e as Error).message}`, this.failureDiagnostic); }
        this.requireIdentity();
        // Build the cache before syncing. If the sweep fails we can't tell a new
        // action from an already-synced one, so defer (and retry next call) rather
        // than create a duplicate.
        if (!(await this.ensureCache(allScheduled.filter(a => !a.frontMatter.recurrence && !isNativeOccurrence(this.store, a))))) return this.defer(actions, 'calendar cache unavailable, will retry', this.failureDiagnostic);

        const out: SyncResult[] = [];
        out.push(...await this.syncRecurrences(false));
        for (const a of actions.filter(a => !a.frontMatter.recurrence && !isNativeOccurrence(this.store, a))) out.push(this.record(a, await this.syncOne(a)));
        // Retry transiently-failed/deferred ops from earlier, unless superseded by
        // this batch. Retry the action's *current* state — the snapshot captured at
        // failure time may be stale by now — falling back to the snapshot only when
        // there is no store to re-read from. An action the store no longer knows
        // was deleted: drop its op.
        const batch = new Set(actions.map((a) => a.id));
        for (const [id, { action }] of [...this.outbox]) {
          if (batch.has(id)) continue;
          const fresh = this.store ? storeAction(this.store, id) : action;
          if (!fresh) {
            this.outbox.delete(id);
            this.confirmations.delete(id);
            this.settled.set(id, { id, status: 'disabled', reason: 'action no longer exists' });
            continue;
          }
          if (!fresh.frontMatter.recurrence && !isNativeOccurrence(this.store, fresh)) this.record(fresh, await this.syncOne(fresh));
        }
        return out;
      } finally {
        this.lock.release();
      }
    } catch (e) {
      const blocked = this.identityReason();
      if (blocked) return this.defer(actions, blocked);
      if (e instanceof CalendarIdentityChanged) return this.defer(actions, e.message);
      // Preserve an observable terminal outcome if an unexpected local failure
      // prevents the best-effort batch from reaching record() (e.g. a bad retry
      // action read). A later explicit sync can re-evaluate the failed actions.
      this.noteFailure(e);
      const reason = `calendar sync failed: ${e instanceof Error ? e.message : String(e)}`;
      const ids = new Set([...actions.map((a) => a.id), ...this.outbox.keys()]);
      for (const id of ids) {
        if (this.failureDiagnostic) this.diagnostics.set(id, this.failureDiagnostic);
        this.outbox.delete(id);
        this.issues.set(id, reason);
        this.settled.set(id, { id, status: 'failed', reason });
      }
      return actions.map((a) => ({ id: a.id, status: 'error', reason }));
    } finally {
      this.releaseInFlight(actions.map((a) => a.id));
    }
  }

  // Register (and later release) actions whose forward op is in flight — a
  // refcount, since overlapping ops on one action must not strip each other.
  private holdInFlight(ids: string[]): void {
    for (const id of ids) this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
  }

  private releaseInFlight(ids: string[]): void {
    for (const id of ids) {
      const n = (this.inFlight.get(id) ?? 1) - 1;
      if (n <= 0) this.inFlight.delete(id);
      else this.inFlight.set(id, n);
    }
  }

  private disable(actions: SyncAction[], reason: string): SyncResult[] {
    for (const { id } of actions) this.settled.set(id, { id, status: 'disabled', reason });
    return skip(actions, reason);
  }

  // Queue actions for retry after a transient, whole-batch failure — no access
  // yet, helper down, or cache not ready — and return a skipped result for each.
  // The next syncActions that gets past these gates drains them. (Permanent
  // conditions — no instance id, no helper on this OS — use skip(), not this.)
  private defer(actions: SyncAction[], reason: string, diagnostic?: CalendarDiagnostic): SyncResult[] {
    // A retry-only batch must refresh the blocker for already queued actions.
    const waiting = new Map([...this.outbox].map(([id, item]) => [id, item.action]));
    for (const action of actions) waiting.set(action.id, action);
    for (const a of waiting.values()) {
      if (diagnostic) this.diagnostics.set(a.id, diagnostic);
      this.issues.delete(a.id);
      this.outbox.set(a.id, { action: a, reason });
    }
    this.scheduleOutboxRetry();
    return actions.map((a) => ({ id: a.id, status: 'skipped' as const, reason }));
  }

  // Drive the outbox's "will retry" without waiting for another tool call: one
  // unref'd timer per non-empty outbox, re-armed after each attempt that leaves
  // it non-empty. The empty forward batch makes syncActions drain the outbox
  // alone; scheduled actions seed the sweep as usual.
  private scheduleOutboxRetry(): void {
    if (this.outboxRetry !== null || this.outbox.size === 0) return;
    this.outboxRetry = setTimeout(() => {
      this.outboxRetry = null;
      if (this.outbox.size === 0) return;
      const all = this.store
        ? this.store.getActionIds().map((id) => storeAction(this.store!, id)!).filter((a) => a.frontMatter.scheduled)
        : [...this.outbox.values()].map((o) => o.action);
      void this.syncActions([], all)
        .catch(() => {})
        .then(() => this.scheduleOutboxRetry());
    }, CALENDAR_SYNC_RETRY_MS);
    this.outboxRetry.unref?.();
  }

  // Update issues/outbox from a result and pass it through. An action lands in at
  // most one bucket; a clean sync clears both. Classification is by the helper's
  // structured error code, never by parsing the message.
  private record(action: SyncAction, res: SyncResult): SyncResult {
    if (res.diagnostic || res.code) this.diagnostics.set(action.id, res.diagnostic ?? this.cal.diagnosticForError(new CalError(res.reason ?? '', res.code)));
    else this.diagnostics.delete(action.id);
    if (res.code === 'event-time-unrepresentable') this.blockTime(action, this.diagnostics.get(action.id)!);
    this.issues.delete(action.id);
    this.outbox.delete(action.id);
    if (res.status === 'synced') {
      this.observeSuccess(action, { id: action.id, status: 'synced', eventId: res.eventId }, this.resultVersions.get(res)!);
    } else if (res.status === 'deleted' || (res.status === 'skipped' && res.reason === 'no event to remove')) {
      this.observeSuccess(action, { id: action.id, status: 'removed' }, this.resultVersions.get(res)!);
    } else {
      this.settled.set(action.id, { id: action.id, status: res.status === 'error' ? 'failed' : 'disabled', reason: res.reason });
    }
    if (res.status === 'skipped' && res.reason === 'no calendar') {
      this.issues.set(action.id, 'no calendar');
    } else if (res.status === 'error') {
      const reason = res.reason ?? '';
      if (res.code === 'event-recurring') {
        // The event grew a recurrence rule since we cached it — park the action.
        this.recurring.add(action.id);
      } else if (res.code === 'event-time-unrepresentable' || res.code === 'invalid-scheduling' || res.code === 'calendar-not-found' || res.code === 'calendar-ambiguous' || res.code === 'calendar-read-only' || this.unconfirmedRemovals.has(action.id)) {
        // A standing issue (retrying won't help until it's fixed).
        this.issues.set(action.id, reason);
      } else {
        this.outbox.set(action.id, { action, reason: `sync failed, will retry: ${reason || 'unknown error'}` });
        this.scheduleOutboxRetry();
      }
    }
    return res;
  }

  private startDefinition(action: SyncAction): string {
    return JSON.stringify([action.frontMatter.scheduled ?? null, action.frontMatter.scheduled?.includes('T') ? action.frontMatter.timezone ?? null : null]);
  }

  private recurrenceFailure(action: SyncAction): string | undefined {
    const occurrence = action.frontMatter.occurrence;
    return occurrence && this.recurrenceSync.isOrdinaryPending(action.id) && this.recurrenceSync.hasOwnedOccurrence(occurrence.template, occurrence.original)
      ? this.recurrenceFailures.get(occurrence.template) : undefined;
  }

  private async syncRecurrences(reverse: boolean): Promise<SyncResult[]> {
    const store = this.store;
    if (!store) return [];
    const instance = this.instanceId;
    for (const [id, action] of store.getActions()) if (action.frontMatter.recurrence && this.cache.has(id)) {
      this.recurrenceSync.rememberOrdinary(store, instance, id, this.cache.get(id)!,
        this.sweptEvents.get(id)?.start ?? this.confirmations.get(id)?.action.frontMatter.scheduled);
    }
    const results = await this.recurrenceSync.sync(store, instance, this.calendars, this.prefixes, () => this.requireIdentity(instance), reverse);
    this.recurrenceFailures.clear();
    for (const result of results) if (result.status === 'error' && store.getAction(result.id)?.frontMatter.recurrence !== undefined) {
      this.recurrenceFailures.set(result.id, `Recurrence Calendar reconciliation failed: ${result.reason ?? 'unknown error'}`);
    }
    const out: SyncResult[] = [];
    for (const result of results) {
      const action = storeAction(store, result.id);
      if (action) {
        if (action.frontMatter.recurrence && !this.recurrenceSync.ordinaryEvent(action.id)) {
          this.cache.delete(action.id); this.sweptEvents.delete(action.id); this.confirmations.delete(action.id);
        }
        if (action.frontMatter.occurrence && isNativeOccurrence(store, action)) {
          this.cache.delete(action.id); this.sweptEvents.delete(action.id); this.confirmations.delete(action.id);
          this.settled.delete(action.id); this.settledVersions.delete(action.id);
        }
        if (result.status === 'synced' || result.status === 'deleted') this.resultVersions.set(result, this.desiredVersion(action));
        out.push(this.record(action, result));
      }
    }
    // A template-only change (or an edit made while unloaded) can retire a
    // saved action's native family. Publish its ordinary event through the
    // normal cache/confirmation path, before reverse sync can infer deletion.
    // Keep failed families gated until their owned events are safely pruned.
    for (const [id, action] of store.getActions()) if (action.frontMatter.occurrence && !isNativeOccurrence(store, action)) {
      const eventId = this.recurrenceSync.ordinaryEvent(id);
      if (eventId && !this.cache.has(id)) this.cache.set(id, eventId);
    }
    for (const id of this.recurrenceSync.pendingOrdinary()) {
      const action = storeAction(store, id);
      if (!action || isNativeOccurrence(store, action)) continue;
      const failure = this.recurrenceFailure(action);
      const eventId = this.recurrenceSync.ordinaryEvent(id);
      if (!failure && eventId && this.cache.get(id) === eventId && this.settledVersions.get(id) === this.desiredVersion(action)) {
        this.recurrenceSync.acknowledgeOrdinary(id, eventId); continue;
      }
      this.issues.delete(id);
      this.outbox.set(id, { action, reason: failure ?? 'recurrence schedule changed; awaiting ordinary Calendar sync' });
    }
    this.scheduleOutboxRetry();
    return out;
  }

  private recurrenceSourceIssue(action: SyncAction): string | undefined {
    if (!this.store) return undefined;
    const file = this.store.getActionFile(action.id);
    const issue = this.store.getIssues().find(issue => issue.severity === 'error' &&
      (/recurrence|occurrence/.test(issue.code) || /^(recurrence|occurrence)(?:\W|$)/.test(issue.field ?? '')) &&
      (file && (issue.file === file || issue.file === relative(this.store!.getDataDir(), file)) || issue.message.startsWith(action.id + ':')));
    return issue ? `${issue.message} Preserve the Calendar representation until its recurrence or provenance is repaired.` : undefined;
  }

  private blockTime(action: SyncAction, diagnostic: CalendarDiagnostic): void {
    if (!this.timeBlocked.has(action.id)) this.timeBlocked.set(action.id, { definition: this.startDefinition(action), diagnostic });
    else this.timeBlocked.get(action.id)!.diagnostic = diagnostic;
    this.diagnostics.set(action.id, diagnostic);
    this.issues.set(action.id, diagnostic.reason);
    this.outbox.delete(action.id);
    this.settled.delete(action.id);
  }

  private explicitReschedule(action: SyncAction): boolean {
    const blocked = this.timeBlocked.get(action.id), fm = action.frontMatter;
    return !!blocked && !!fm.calendar && fm.resolution !== 'cancelled' && blocked.definition !== this.startDefinition(action) && !!fm.scheduled &&
      schedulingIssues(fm).length === 0 && scheduleInstant(fm.scheduled, fm.timezone) !== undefined &&
      !isRepeatedSchedule(fm.scheduled, fm.timezone);
  }

  // A timing block is rechecked before either upsert or removal. A start edit
  // must name an unambiguous time; other edits cannot erase the calendar gesture.
  private async timingGate(action: SyncAction): Promise<{ diagnostic?: CalendarDiagnostic; replace?: boolean }> {
    if (!this.timeBlocked.has(action.id)) return {};
    let actual: CalEvent | undefined;
    const eventId = this.cache.get(action.id);
    if (eventId) actual = (await this.cal.getEvents({ eventIds: [eventId] })).events.find(event => event.id === eventId && this.ownActionId(event) === action.id);
    else {
      const found = await this.relocate([action]);
      if (!found.conclusive) return { diagnostic: this.timeBlocked.get(action.id)!.diagnostic };
      actual = found.found.get(action.id);
      if (actual) this.cache.set(action.id, actual.id);
    }
    if (actual) {
      const diagnostic = eventTimingDiagnostic(actual);
      if (diagnostic) {
        this.blockTime(action, diagnostic);
        // A malformed helper response cannot be repaired by changing a record.
        if (canReplaceEventTime(actual) && this.explicitReschedule(action) && (!this.store || this.freshOnDisk(action))) return { replace: true };
        return { diagnostic };
      }
    }
    this.timeBlocked.delete(action.id);
    this.issues.delete(action.id);
    this.diagnostics.delete(action.id);
    return {};
  }

  // Forward sync derives the event from its action. Floating timed saves also
  // confirm Calendar's effective wall clock before claiming completion.
  private async syncOne(action: SyncAction): Promise<SyncResult> {
    if (action.frontMatter.occurrence) this.recurrenceSync.beginOrdinary(action.id);
    const recurrenceFailure = this.recurrenceFailure(action);
    if (recurrenceFailure) return { id: action.id, status: 'error', reason: recurrenceFailure };
    const recurrenceIssue = this.recurrenceSourceIssue(action);
    if (recurrenceIssue) return { id: action.id, status: 'error', code: 'invalid-scheduling', reason: recurrenceIssue };
    const invalid = schedulingIssues(action.frontMatter);
    if (invalid.length) return { id: action.id, status: 'error', code: 'invalid-scheduling', reason: invalid.join(' ') };
    const routing = calendarRoutingError(this.calendars, action.frontMatter);
    if (routing) {
      this.routingBlocked.add(action.id);
      return { id: action.id, status: 'error', code: routing.code, reason: routing.message };
    }
    this.routingBlocked.delete(action.id);
    // A recurring event is never touched — not even to delete it.
    if (this.recurring.has(action.id)) {
      return { id: action.id, status: 'skipped', reason: 'event is recurring — not synced' };
    }
    let timing: { diagnostic?: CalendarDiagnostic; replace?: boolean };
    try { timing = await this.timingGate(action); }
    catch (e) { this.noteFailure(e); return { id: action.id, status: 'error', reason: (e as Error).message, diagnostic: this.cal.diagnosticForError(e) }; }
    if (timing.diagnostic) return { id: action.id, status: 'error', code: 'event-time-unrepresentable', reason: timing.diagnostic.reason, diagnostic: timing.diagnostic };
    const instanceId = this.instanceId;
    const d = desiredFromAction(action, instanceId, this.prefixes);
    const version = this.desiredVersion(action, d);
    if (!d.have) {
      this.confirmations.delete(action.id);
      // 'no calendar' with a cached event means the calendar was cleared after
      // syncing (calendar: null = stop syncing) — remove the now-orphaned event.
      // backlog/cancelled likewise remove any event; an uncached no-calendar
      // action simply isn't synced.
      if (d.reason === 'no calendar' && !this.cache.has(action.id) && !this.unconfirmedRemovals.has(action.id)) {
        return { id: action.id, status: 'skipped', reason: 'no calendar' };
      }
      const result = await this.removeEvent(action);
      this.resultVersions.set(result, version);
      return result;
    }
    try {
      return await this.saveEvent(action, d, version, timing.replace);
    } catch (e) {
      this.noteFailure(e);
      return { id: action.id, status: 'error', reason: (e as Error).message, code: errorCode(e), diagnostic: this.cal.diagnosticForError(e) };
    }
  }

  private async saveEvent(action: SyncAction, desired: Extract<Desired, { have: true }>, version: string, replace?: boolean): Promise<SyncResult> {
    const instanceId = this.instanceId;
    let confirmation = this.confirmations.get(action.id);
    // A newer local edit supersedes the old save, using its retained event ID.
    // The previous snapshot must never be written over the newer file.
    if (confirmation && (confirmation.version !== version || sourceSnapshot(confirmation.action) !== sourceSnapshot(action))) {
      this.confirmations.delete(action.id);
      confirmation = undefined;
    }
    if (!confirmation) {
      const eventId = this.cache.get(action.id);
      this.requireIdentity(instanceId);
      const saved = await this.cal.upsertEvent({ ...desired.up, ...(eventId ? { eventId } : {}), ...(replace ? { allowTimeReplacement: true } : {}) });
      this.requireIdentity(instanceId);
      this.cache.set(action.id, saved.eventId);
      if (desired.up.allDay || desired.up.timezone) {
        const result: SyncResult = { id: action.id, status: 'synced', eventId: saved.eventId };
        this.resultVersions.set(result, version);
        return result;
      }
      confirmation = { action: { ...action, frontMatter: { ...action.frontMatter } }, desired, version, eventId: saved.eventId, instanceId };
      this.confirmations.set(action.id, confirmation);
    }
    this.requireIdentity(confirmation.instanceId);
    const { events } = await this.cal.getEvents({ eventIds: [confirmation.eventId] });
    this.requireIdentity(confirmation.instanceId);
    const actual = events.find(event => event.id === confirmation!.eventId && this.ownActionId(event) === action.id);
    if (!actual) throw new Error('Calendar event was saved but readback did not confirm it; retaining its ID and retrying confirmation');
    if (actual.recurring) throw new CalError('Saved event is part of a recurring series; confirmation is blocked', 'event-recurring');
    const timing = eventTimingDiagnostic(actual);
    if (timing) throw new CalError(timing.reason, 'event-time-unrepresentable', timing);
    // Only the effective start is canonicalized by our own save. Other fields
    // must still confirm the snapshot actually sent to Calendar.
    if (eventsDiffer({ ...confirmation.desired.up, start: actual.start }, actual)) {
      throw new Error('Calendar event was saved but readback differs from the saved definition; retrying confirmation');
    }
    const canonical = { ...confirmation.action, frontMatter: { ...confirmation.action.frontMatter, scheduled: normalizeScheduled(actual.start) } };
    if (canonical.frontMatter.scheduled !== confirmation.action.frontMatter.scheduled) {
      if (!this.store) throw new Error('Calendar normalized the floating start but no action store is available for confirmation');
      if (!this.freshOnDisk(confirmation.action)) throw new Error('Action changed during Calendar save confirmation; retrying its current state');
      // No await between the freshness check and whole-file write. This also
      // applies to done actions, whose ordinary reverse lifecycle import skips
      // time moves; this is confirmation of our own save rather than a gesture.
      this.writeAction(action.id, canonical.frontMatter, canonical.body);
      this.recordChange(action.id, `scheduled ${confirmation.action.frontMatter.scheduled} -> ${canonical.frontMatter.scheduled} (Calendar normalization)`);
    }
    const canonicalDesired: Extract<Desired, { have: true }> = {
      ...confirmation.desired,
      up: { ...confirmation.desired.up, start: actual.start, end: addMinutesWall(actual.start, confirmation.desired.up.durationMinutes!) },
    };
    this.sweptEvents.set(action.id, actual);
    if (this.confirmations.get(action.id) === confirmation) this.confirmations.delete(action.id);
    const result: SyncResult = { id: action.id, status: 'synced', eventId: confirmation.eventId };
    this.resultVersions.set(result, this.desiredVersion(canonical, canonicalDesired));
    return result;
  }

  // Remove an action's event if one is cached. Idempotent: nothing tracked →
  // skipped. The helper deletes only when the event still carries the marker.
  private async removeEvent(action: SyncAction): Promise<SyncResult> {
    const instanceId = this.instanceId;
    const eventId = this.cache.get(action.id);
    if (!eventId) {
      const reason = this.unconfirmedRemovals.get(action.id);
      return reason ? { id: action.id, status: 'error', reason } : { id: action.id, status: 'skipped', reason: 'no event to remove' };
    }
    try {
      this.requireIdentity(instanceId);
      const { deleted } = await this.cal.deleteEvent({ eventId, marker: buildMarker(instanceId, action.id, 'active') });
      this.requireIdentity(instanceId);
      if (!deleted) {
        const { events } = await this.cal.getEvents({ eventIds: [eventId] });
        this.requireIdentity(instanceId);
        const event = events.find((ev) => ev.id === eventId);
        const reason = event && this.ownActionId(event) === action.id
          ? 'calendar did not confirm event removal'
          : 'event missing or no longer owned; removal was not confirmed';
        if (!event || this.ownActionId(event) !== action.id) this.cache.delete(action.id);
        this.unconfirmedRemovals.set(action.id, reason);
        return { id: action.id, status: 'error', reason };
      }
      this.unconfirmedRemovals.delete(action.id);
      this.cache.delete(action.id);
      return { id: action.id, status: 'deleted' };
    } catch (e) {
      this.noteFailure(e);
      return { id: action.id, status: 'error', reason: (e as Error).message, code: errorCode(e), diagnostic: this.cal.diagnosticForError(e) };
    }
  }

  // Reverse reconcile: read the calendar back and bring each action in line with
  // it. Per action, the current event's gestures are imported (move → scheduled,
  // resize → duration, a url suffix → done/cancelled/backlog) and the event is
  // then re-derived from the result — so delete, resync-✓, and deschedule all fall
  // out of forward sync on the mutated action (see reconcileAction). Startup and
  // live share this: a scheduled action with no event is descheduled either way.
  // `allScheduled` seeds the cache sweep on first use. Every write is diff-gated,
  // so reverse → action → forward converges; the action file always wins.
  //
  // Serialized: overlapping calls (back-to-back `changed` signals) don't run
  // concurrently; a signal arriving mid-run re-runs once after, against the
  // latest caller's action set.
  async reconcile(allScheduled: SyncAction[]): Promise<void> {
    this.pendingReconcile = allScheduled;
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      while (this.pendingReconcile) {
        const batch = this.pendingReconcile;
        this.pendingReconcile = null;
        await this.reconcileOnce(batch);
      }
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOnce(allScheduled: SyncAction[]): Promise<void> {
    // No id / no helper / no access: reverse sync can't run, but none is an
    // unreported change — each is already surfaced elsewhere (report()'s standing
    // `instance` failure, calendar_info's `auth: unavailable`, and the auth status
    // plus the forward outbox). Return without recording a duplicate.
    if (this.identityReason() || !this.cal.available()) return;
    const access = await this.checkAccess();
    if (access === 'no-access') return;
    if (access !== 'ok') {
      // The helper IS present but unreachable — a real failure, so record it.
      if (this.failureDiagnostic) this.diagnostics.set('reverse sync', this.failureDiagnostic);
      this.reconcileFailures = [{ id: 'reverse sync', reason: `calendar helper error: ${access.error}` }];
      return;
    }
    // Reverse sync reads and writes actions through the store, which capture/update
    // keep current; with no store there is nothing to reconcile against.
    const store = this.store;
    if (!store) return;

    // The pass mutates the calendar, so it serializes with forward batches on
    // the data-dir lock. A held lock means another phase is running; one
    // delayed re-run covers the (coarse) signal afterwards.
    if (!this.lock.tryAcquire()) {
      if (this.lockRetry === null) {
        this.lockRetry = setTimeout(() => {
          this.lockRetry = null;
          void this.reconcile(allScheduled).catch(() => {});
        }, CALENDAR_RECONCILE_RETRY_MS);
        this.lockRetry.unref?.();
      }
      return;
    }
    try {
      this.requireIdentity();
      try { this.calendars = (await this.cal.listCalendars()).calendars; }
      catch (e) {
        this.noteFailure(e);
        if (this.failureDiagnostic) this.diagnostics.set('reverse sync', this.failureDiagnostic);
        this.reconcileFailures = [{ id: 'reverse sync', reason: `calendar routing unavailable, will retry: ${(e as Error).message}` }];
        return;
      }
      this.requireIdentity();
      await this.reconcileLocked(allScheduled, store);
    } catch (e) {
      if (!this.identityReason()) {
        this.reconcileFailures = [{ id: 'reverse sync', reason: `reverse sync failed: ${(e as Error).message}` }];
      }
    } finally {
      this.lock.release();
    }
  }

  private async reconcileLocked(allScheduled: SyncAction[], store: Store): Promise<void> {
    const instanceId = this.instanceId;
    await this.syncRecurrences(true);
    allScheduled = allScheduled.filter(a => !a.frontMatter.recurrence && !isNativeOccurrence(this.store, a));
    // Cold (first completed reconcile): the deletion-import pass, where every
    // scheduled action is a candidate. Warm: a changed signal re-fetches the
    // tracked events. A null load failed: skip the pass rather than mistake an
    // unreachable helper for a calendar full of deletions.
    const cold = !this.coldReconciled;
    // Whether this pass's events come from the sweep (which sees every live
    // event) or from a fetch of the tracked ids — which says nothing about an
    // untracked candidate, so its absence is inconclusive (see the miss check).
    const sweptBefore = this.swept;
    const current = await this.loadCurrent(allScheduled);
    this.requireIdentity(instanceId);
    if (current === null) {
      if (this.failureDiagnostic) this.diagnostics.set('reverse sync', this.failureDiagnostic);
      this.reconcileFailures = [{ id: 'reverse sync', reason: 'could not read calendar state, will retry' }];
      return;
    }

    this.diagnostics.delete('reverse sync');

    // Failures from this pass; committed at the end so a clean pass clears the
    // last one's (calendar_info reflects the current state, not history).
    const failures: CalendarFailure[] = [];
    // A cold pass collects its deschedules instead of executing them inline, so
    // a bulk disappearance can be capped after the whole calendar has been seen
    // (below). Warm deschedules stay inline and uncapped: the cache vouches for
    // each event having existed since the instance loaded.
    const deschedules: SyncAction[] = [];
    const deferDeschedule = cold ? (a: SyncAction) => deschedules.push(a) : undefined;
    // Candidates: every action we track an event for (events to diff or clean up),
    // plus — only at cold start, where the sweep has seen every live event — every
    // scheduled, calendar-pinned action, so an event deleted while we were off
    // surfaces as a missing event and deschedules its action (the symmetric rule).
    // A warm pass trusts the cache: a `changed` signal concerns tracked events; an
    // untracked scheduled action is left to forward sync (capture/update) / outbox.
    const candidates = new Set<string>(this.cache.keys());
    if (cold) for (const a of allScheduled) if (a.frontMatter.calendar) candidates.add(a.id);

    // A cached id the fetch didn't return is a *miss* — relocate by marker before
    // concluding deletion, so a reassigned/moved id (CalDAV re-sync /
    // cross-calendar move) or an event created by a forward op racing this pass
    // isn't mistaken for one. An untracked cold candidate needs no relocation
    // when this pass's events came from the sweep, which matches by marker —
    // absence is already conclusive; on a cold re-run (after a failure or a
    // deferred deschedule) the tracked-id fetch proves nothing about it, so it
    // is relocated too before its event is declared gone.
    // Best-effort per action: a bad read or write records its failure and
    // diagnostic and never aborts the rest of the pass.
    const fail = (id: string, e: unknown) => {
      const diagnostic = this.cal.diagnosticForError(e);
      this.diagnostics.set(id, diagnostic);
      failures.push({ id, reason: `reverse sync failed: ${(e as Error).message}`, diagnostic });
    };
    // The action as the store holds it now; undefined when the read failed
    // (recorded), null when the action is gone (its cache entry dropped).
    const readAction = (id: string): SyncAction | null | undefined => {
      try {
        const action = storeAction(store, id);
        if (!action) this.cache.delete(id);
        return action;
      } catch (e) {
        fail(id, e);
        return undefined;
      }
    };
    const reconcile = async (action: SyncAction, ev: CalEvent | undefined, defer?: (a: SyncAction) => void) => {
      try {
        await this.reconcileAction(action, ev, defer);
      } catch (e) {
        fail(action.id, e);
      }
    };
    const misses: SyncAction[] = [];
    for (const id of candidates) {
      const action = readAction(id);
      if (!action) continue;
      const ev = current.get(id);
      if (!ev && (this.cache.has(id) || sweptBefore)) {
        misses.push(action); // confirm by marker before treating as deleted
        continue;
      }
      await reconcile(action, ev, deferDeschedule);
    }

    // Resolve the misses: a re-found event is reconciled (import / re-point the
    // cache); a conclusively-absent one is reconciled against no event (→
    // descheduled). A failed re-match query is inconclusive, so leave it tracked
    // and retry rather than deschedule on an unreliable miss. Each action is
    // re-read after relocate()'s awaits — a capture/update landing during them
    // must not be overwritten from the pre-await snapshot.
    if (misses.length > 0) {
      const { found, conclusive } = await this.relocate(misses);
      this.requireIdentity(instanceId);
      for (const miss of misses) {
        const ev = found.get(miss.id);
        if (!ev && !conclusive) continue; // can't prove deletion; retry next pass
        const action = readAction(miss.id);
        if (action) await reconcile(action, ev, deferDeschedule);
      }
      if (!conclusive) failures.push({ id: 'reverse sync', reason: 'could not confirm some events, will retry', diagnostic: this.failureDiagnostic });
    }

    // The cold pass's collected deschedules. Wanting more than 3 AND more than a
    // quarter of the synced actions is a bulk disappearance (offline account,
    // truncated query), not a set of user gestures: execute none, leave every
    // cache/tracking entry untouched, and record ONE pass failure — the bucket
    // the coldReconciled gate below reads, so the next pass retries cold and
    // re-checks the deferred candidates against the calendar. At or below the
    // threshold each deschedule runs on a fresh store read (the pass-time
    // snapshot is stale after the awaits above), through the same guards as an
    // inline one.
    if (deschedules.length > 0) {
      const synced = allScheduled.filter((a) => a.frontMatter.calendar).length;
      if (deschedules.length > 3 && deschedules.length > synced * 0.25) {
        const ids = deschedules.map((a) => a.id);
        failures.push({
          id: 'reverse sync',
          reason: `deferred descheduling ${ids.length} actions (calendar returned no events for them): ${ids.join(', ')}. ` +
            `If these deletions were intentional, clear 'scheduled' on them via update_action; otherwise check the calendar account.`,
        });
      } else {
        for (const stale of deschedules) {
          const action = readAction(stale.id);
          if (action) await reconcile(action, undefined);
        }
      }
    }

    this.reconcileFailures = failures;
    // The deletion-import is done only when a pass completes cleanly. A failed
    // per-action write during the cold pass would otherwise never retry: warm
    // passes only consider tracked events, so an untracked cold candidate whose
    // deschedule failed would drift until restart. Cold candidacy is idempotent
    // (writes are diff-gated), so re-running it until clean is safe.
    if (failures.length === 0) this.coldReconciled = true;
  }

  // Reconcile one action against its current event (or its absence). Calendar-side
  // gestures are imported into the action, then the event is re-derived from the
  // result — so "delete on cancel", "resync ✓ on done", "move/resize", and
  // "deschedule when the event is gone" all reduce to forward sync on the mutated
  // action, and a round-trip converges (the re-derived event already matches, so
  // nothing is written and no further signal matters).
  //
  // Invariant: `action` was read from the store just before this call, and every
  // writeAction below runs on the synchronous path from that read — no `await`
  // between reading the action and writing it back, so a capture/update racing the
  // reconcile's other awaits can't land between them and be clobbered. freshOnDisk
  // (synchronous too) extends the same rule across processes.
  //
  // With `deferDeschedule` (the cold pass), a would-be deschedule is handed to the
  // caller untouched — no write, no tracking change — so it can be capped after
  // the pass has seen the whole calendar.
  private async reconcileAction(
    action: SyncAction,
    actual: CalEvent | undefined,
    deferDeschedule?: (a: SyncAction) => void,
  ): Promise<void> {
    this.requireIdentity();
    const recurrenceFailure = this.recurrenceFailure(action);
    if (recurrenceFailure) throw new Error(recurrenceFailure);
    const recurrenceIssue = this.recurrenceSourceIssue(action);
    if (recurrenceIssue) throw new CalError(recurrenceIssue, 'invalid-scheduling');
    // A forward op in flight (or awaiting retry in the outbox) owns this action:
    // its local state is ahead of the calendar, so neither import the stale event
    // nor read its absence as a deletion — the op or its retry pushes the truth.
    if (this.inFlight.has(action.id) || this.outbox.has(action.id)) return;
    const invalid = schedulingIssues(action.frontMatter);
    if (invalid.length) throw new CalError(invalid.join(' '), 'invalid-scheduling');
    const routing = calendarRoutingError(this.calendars, action.frontMatter);
    if (routing) {
      this.routingBlocked.add(action.id);
      throw new CalError(routing.message, routing.code);
    }
    if (!actual && this.routingBlocked.has(action.id)) {
      // A previously unroutable action may never have had an event. Repair
      // forward first; absence here does not establish a calendar deletion.
      this.outbox.set(action.id, { action, reason: 'calendar routing restored; awaiting sync' });
      this.scheduleOutboxRetry();
      return;
    }
    if (!actual && this.unconfirmedRemovals.has(action.id)) return;
    let fm = action.frontMatter;
    if (actual) {
      const parsed = parseMarker(actual.url);
      if (!parsed || parsed.instance !== this.instanceId || parsed.actionId !== action.id) {
        // The fetched event no longer confirms this action's previous sync.
        // Leave the foreign event and local action untouched.
        if (this.settled.get(action.id)?.status === 'synced') this.settled.delete(action.id);
        return;
      }
      // Refresh the cached id from the event just read (picks up a reassigned id).
      this.cache.set(action.id, actual.id);
      // An event that became part of a recurring series is off-limits: import
      // nothing, change nothing, surface the condition (see `recurring`). It
      // stays tracked so a later de-recurrence resumes sync.
      if (actual.recurring) {
        this.recurring.add(action.id);
        return;
      }
      this.recurring.delete(action.id);
      if (this.explicitReschedule(action)) {
        this.outbox.set(action.id, { action, reason: 'calendar start definition changed; awaiting explicit reschedule' });
        this.scheduleOutboxRetry();
        return;
      }
      const timing = eventTimingDiagnostic(actual);
      if (timing) {
        this.blockTime(action, timing);
        return;
      }
      this.timeBlocked.delete(action.id);
      this.issues.delete(action.id);
      this.diagnostics.delete(action.id);
      const imported = importFromEvent(action, actual, this.calendars);
      const invalidImport = schedulingIssues(imported.fm);
      if (invalidImport.length) throw new CalError(invalidImport.join(' '), 'invalid-scheduling');
      if (imported.summaries.length > 0) {
        if (!this.freshOnDisk(action)) return;
        this.writeAction(action.id, imported.fm, action.body);
        for (const s of imported.summaries) this.recordChange(action.id, s);
        fm = imported.fm;
      }
    } else {
      // No event. If the action still expects one and is active, the calendar has
      // removed it → deschedule (symmetric: the same at startup and live).
      const d = desiredFromAction({ ...action, frontMatter: fm }, this.instanceId, this.prefixes);
      if (d.have && d.state === 'active') {
        if (deferDeschedule) {
          deferDeschedule(action);
          return;
        }
        if (!this.freshOnDisk(action)) return;
        const next = { ...fm };
        delete next.scheduled;
        this.writeAction(action.id, next, action.body);
        this.recordChange(action.id, 'descheduled (event deleted)');
        fm = next;
      }
      this.recurring.delete(action.id);
      this.cache.delete(action.id);
      const observed = { ...action, frontMatter: fm };
      this.observeSuccess(observed, { id: action.id, status: 'removed' }, this.desiredVersion(observed));
      return;
    }

    // Forward-reconcile the (possibly updated) action against the event we have.
    const d = desiredFromAction({ ...action, frontMatter: fm }, this.instanceId, this.prefixes);
    const observed = { ...action, frontMatter: fm };
    const version = this.desiredVersion(observed, d);
    // A reverse gesture may have saved a local change just before the helper
    // write below. Keep its receipt pending until that write has completed too.
    this.holdInFlight([action.id]);
    try {
      if (!d.have) {
        // backlog / cancelled / calendar cleared → the event should not exist.
        const removed = await this.removeEvent(action);
        if (removed.status === 'error') throw new Error(removed.reason ?? 'event removal failed');
        this.observeSuccess(observed, { id: action.id, status: 'removed' }, version);
        return;
      }
      if (eventsDiffer(d.up, actual)) {
        const result = await this.saveEvent(observed, d, version);
        this.observeSuccess(observed, { id: action.id, status: 'synced', eventId: result.eventId }, this.resultVersions.get(result)!);
        return;
      } else if (this.unobservedFieldsChanged(action.id, d)) {
        this.settled.delete(action.id);
        this.clearResolvedFailures(action.id);
        return;
      }
      this.observeSuccess(observed, { id: action.id, status: 'synced', eventId: this.cache.get(action.id) }, version);
    } catch (e) {
      if (this.confirmations.has(action.id)) {
        this.record(observed, { id: action.id, status: 'error', reason: (e as Error).message, code: errorCode(e), diagnostic: this.cal.diagnosticForError(e) });
      }
      this.settled.set(action.id, { id: action.id, status: 'failed', reason: `reverse sync failed: ${(e as Error).message}` });
      throw e;
    } finally {
      this.releaseInFlight([action.id]);
    }
  }

  // Load the current event for each tracked action. Before the sweep has run:
  // run it (which builds the cache) and return the events it matched — the same
  // query, no second fetch. After: re-fetch the tracked events by cached id.
  // Null = the load failed; skip this pass rather than mistake an unreachable
  // helper for a set of deletions.
  private async loadCurrent(allScheduled: SyncAction[]): Promise<Map<string, CalEvent> | null> {
    if (!this.swept) {
      if (!(await this.ensureCache(allScheduled.filter(a => !a.frontMatter.recurrence && !isNativeOccurrence(this.store, a))))) return null;
      return this.sweptEvents;
    }
    const tracked = [...this.cache];
    if (tracked.length === 0) return new Map();
    let events: CalEvent[];
    try {
      events = (await this.cal.getEvents({ eventIds: tracked.map(([, eventId]) => eventId) })).events;
    } catch (e) {
      this.noteFailure(e);
      return null;
    }
    const byId = new Map(events.map((e) => [e.id, e]));
    const out = new Map<string, CalEvent>();
    for (const [actionId, eventId] of tracked) {
      const ev = byId.get(eventId);
      if (ev) out.set(actionId, ev);
    }
    return out;
  }

  // Re-find events for actions whose cached id no longer resolves, matching by
  // the marker URL over the scheduled window (±1mo, widening to ±1yr). Catches a
  // reassigned id or an event moved away from the action's time; a genuine
  // deletion is simply absent. `conclusive` is false when a query failed, so the
  // caller holds off descheduling rather than act on an unreliable miss.
  private async relocate(actions: SyncAction[]): Promise<{ found: Map<string, CalEvent>; conclusive: boolean }> {
    const found = new Map<string, CalEvent>();
    const syncable = actions.filter((a) => a.frontMatter.scheduled && a.frontMatter.calendar && schedulingIssues(a.frontMatter).length === 0);
    if (syncable.length === 0) return { found, conclusive: true };

    const { min, max, want } = sweepWindow(syncable);
    for (const { start, end } of widenRanges(min, max)) {
      if (want.size === 0) break;
      let events: CalEvent[];
      try {
        events = await this.listMarked(start, end);
      } catch (e) {
        this.noteFailure(e);
        return { found, conclusive: false }; // a failed query can't prove deletion
      }
      for (const ev of events) {
        const actionId = this.ownActionId(ev);
        if (actionId && want.has(actionId)) {
          found.set(actionId, ev);
          want.delete(actionId);
        }
      }
    }
    return { found, conclusive: true };
  }

  // Snapshot-consistency guard, the on-disk analog of the in-process inFlight
  // rule: a tool call or a direct file edit may rewrite an action file at any
  // time (tools write markdown before pushing to the calendar), and this pass's
  // snapshot of the action predates its awaits. Re-read the file from disk —
  // not the store map, whose watcher lags an outside edit by ~100ms+; the
  // guard exists precisely for that staleness — and compare EVERY
  // field the write rewrites: writeAction serializes the whole file, so the
  // compare surface must match the write surface (front matter and body), or
  // a foreign mid-pass edit to an unsynced field would still be clobbered.
  // A mismatch (or an unreadable file) means writing would clobber a change
  // this pass never saw: the caller skips the action, and the next pass
  // reconciles it against current reality. Synchronous, so it sits on
  // reconcileAction's no-await read→write path.
  private freshOnDisk(action: SyncAction): boolean {
    const file = this.store?.getActionFile(action.id);
    if (!file) return false;
    let disk: { frontMatter: ActionFrontMatter; body: string };
    try {
      disk = parseActionFile(readManagedText(this.store!.getDataDir(), file)).value;
    } catch {
      return false;
    }
    const d = disk.frontMatter;
    const fm = action.frontMatter;
    return d.name === fm.name && d.created === fm.created &&
      d.scheduled === fm.scheduled && d.timezone === fm.timezone &&
      d.duration === fm.duration && d.calendar === fm.calendar && d.calendar_account === fm.calendar_account &&
      d.deadline === fm.deadline && d.resolution === fm.resolution &&
      disk.body === action.body;
  }

  // Write an action back through the store (disk + memory). Throws when the action
  // is unknown so the caller (the reconcile pass) records a failure instead of
  // silently claiming success.
  private writeAction(actionId: string, fm: ActionFrontMatter, body: string): void {
    this.requireIdentity();
    const file = this.store?.getActionFile(actionId);
    if (!this.store || !file) throw new Error(`action file not found: ${actionId}`);
    this.store.saveAction(actionId, fm, body === this.store.getAction(actionId)?.body ? undefined : body, file);
  }

  // The action id of an event whose marker belongs to this instance, else null.
  private ownActionId(ev: CalEvent): string | null {
    const parsed = parseMarker(ev.url);
    return parsed && parsed.instance === this.instanceId ? parsed.actionId : null;
  }

  // list-events over a range, split into chunks EventKit can serve:
  // predicateForEvents silently truncates any span over 4 years, and a truncated
  // sweep would read the missing tail as deletions. ≤3.5 years per query, merged.
  private async listMarked(start: string, end: string): Promise<CalEvent[]> {
    const instanceId = this.instanceId;
    this.requireIdentity(instanceId);
    // Range predicates return every event *overlapping* the range, so an event
    // straddling a chunk boundary comes back from both adjacent chunks — dedupe
    // by id, or the second appearance would be pruned as a duplicate.
    const out = new Map<string, CalEvent>();
    for (const r of chunkRange(start, end)) {
      const { events } = await this.cal.listEvents({ start: r.start, end: r.end });
      this.requireIdentity(instanceId);
      for (const ev of events) {
        if (!out.has(ev.id)) out.set(ev.id, ev);
      }
    }
    return [...out.values()];
  }

  // Build the cache once by matching existing marked events to actions; returns
  // whether it is ready. Concurrent callers await the same in-flight sweep, and a
  // failed sweep is retried on the next call rather than poisoning the syncer.
  private ensureCache(allScheduled: SyncAction[]): Promise<boolean> {
    if (this.swept) return Promise.resolve(true);
    if (!this.sweepPromise) {
      const instanceId = this.instanceId;
      this.sweepPromise = this.runSweep(allScheduled).then(
        () => {
          this.requireIdentity(instanceId);
          this.swept = true;
          this.sweepPromise = null;
          return true;
        },
      ).catch((e) => {
          this.noteFailure(e);
          this.sweepPromise = null;
          return false;
        });
    }
    return this.sweepPromise;
  }

  // One query over the scheduled range ±1 month, widening to ±1 year for any
  // action still unmatched. Throws if a query fails, so ensureCache can retry.
  private async runSweep(allScheduled: SyncAction[]): Promise<void> {
    this.sweptEvents = new Map(); // fresh per sweep; the cold reconcile diffs from it
    this.sweepFailures = [];
    // Sweep for events of every scheduled, calendar-pinned action regardless of
    // resolution: done events are kept (and updated), cancelled ones need their
    // id cached so they can be deleted even after a restart.
    const syncable = allScheduled.filter((a) => a.frontMatter.scheduled && a.frontMatter.calendar && schedulingIssues(a.frontMatter).length === 0 && !this.recurrenceSourceIssue(a));
    if (syncable.length === 0) return;

    const { min, max, want } = sweepWindow(syncable);
    // ±1mo first, then only the segments that widen it to ±1yr — the month range
    // is never re-queried.
    for (const { start, end } of widenRanges(min, max)) {
      if (want.size === 0) break;
      await this.sweepRange(start, end, want, new Map(syncable.map(action => [action.id, action])));
    }
  }

  private async sweepRange(start: string, end: string, want: Set<string>, actions: Map<string, SyncAction>): Promise<void> {
    const instanceId = this.instanceId;
    const events = await this.listMarked(start, end);
    // Discover every unsafe time before pruning any duplicates for that action.
    const unsafe = new Set<string>();
    for (const event of events) {
      const id = this.ownActionId(event);
      if (!id || !want.has(id) || event.recurring) continue;
      const action = this.store ? storeAction(this.store, id) : actions.get(id);
      const diagnostic = eventTimingDiagnostic(event);
      if (action && diagnostic) {
        this.blockTime(action, diagnostic);
        unsafe.add(id);
        this.cache.set(id, event.id);
        this.sweptEvents.set(id, event);
      }
    }
    for (const id of unsafe) want.delete(id);
    const matched = new Set<string>(); // actionIds cached from this window
    for (const ev of events) {
      const actionId = this.ownActionId(ev);
      if (!actionId || unsafe.has(actionId)) continue;
      const action = this.store ? storeAction(this.store, actionId) : undefined;
      if (action && (this.recurrenceSourceIssue(action) || calendarRoutingError(this.calendars, action.frontMatter) || schedulingIssues(action.frontMatter).length)) continue;
      if (want.has(actionId)) {
        this.cache.set(actionId, ev.id);
        this.sweptEvents.set(actionId, ev);
        if (ev.recurring) this.recurring.add(actionId); // park it before any forward op touches it
        want.delete(actionId);
        matched.add(actionId);
      } else if (matched.has(actionId)) {
        // A second event for an action already matched in this window: a
        // duplicate — unless it's recurring, which sync never deletes (EventKit
        // reports one entry per occurrence; deleting them would dismantle a
        // user's series). Keep the first, remove the rest — recording the change
        // only when the removal lands, the failure otherwise.
        if (ev.recurring) continue;
        try {
          this.requireIdentity();
          const { deleted } = await this.cal.deleteEvent({ eventId: ev.id, marker: ev.url });
          this.requireIdentity(instanceId);
          if (!deleted) throw new Error('event removal was not confirmed');
          this.recordChange(actionId, 'removed duplicate event');
        } catch (e) {
          this.sweepFailures.push({ id: actionId, reason: `could not remove duplicate event: ${(e as Error).message}`, diagnostic: this.cal.diagnosticForError(e) });
        }
      }
    }
  }
}

// Skipped results for an instance-wide blocker (no id, no helper) — the failure is
// represented once at the instance level (see syncActions / report), so unlike
// defer() this records nothing per action. Never use it for a condition that lacks
// such an instance-level surface, or that change goes unreported.
function skip(actions: SyncAction[], reason: string): SyncResult[] {
  return actions.map((a) => ({ id: a.id, status: 'skipped' as const, reason }));
}

function sourceSnapshot(action: SyncAction): string {
  return JSON.stringify([Object.entries(action.frontMatter).sort(([a], [b]) => a.localeCompare(b)), action.body, action.description ?? null]);
}

// The helper's structured failure class from a caught error, if it sent one.
function errorCode(e: unknown): CalErrorCode | undefined {
  return e instanceof CalError ? e.code : undefined;
}

// The window a sweep/relocate queries: the span of the actions' scheduled dates,
// and the ids to match. Searches span all calendars so a move cannot look like deletion. Callers hold only scheduled,
// calendar-pinned actions.
function sweepWindow(actions: SyncAction[]): { min: string; max: string; want: Set<string> } {
  const dates = actions.map((a) => startFromScheduled(a.frontMatter.scheduled!).start.slice(0, 10));
  return {
    min: dates.reduce((a, b) => (a < b ? a : b)),
    max: dates.reduce((a, b) => (a > b ? a : b)),
    want: new Set(actions.map((a) => a.id)),
  };
}

// The event an action's load-bearing state implies: `have: true` with the upsert
// payload, or `have: false` with why there should be none. Forward sync and the
// reverse forward-reconcile both derive the desired event here — the single source
// of the action → event mapping:
//   - scheduled, calendar-pinned, not cancelled → have (active, or done with ✓)
//   - scheduled but no calendar → none, 'no calendar' (surfaced as an issue)
//   - backlog or cancelled → none
type Desired =
  | { have: true; state: MarkerState; up: UpsertEventArgs }
  | { have: false; reason: 'backlog' | 'cancelled' | 'no calendar' };

export function desiredFromAction(action: SyncAction, instance: string, prefixes: { active: string; done: string }): Desired {
  const fm = action.frontMatter;
  if (!fm.scheduled || fm.resolution === 'cancelled') {
    return { have: false, reason: fm.resolution === 'cancelled' ? 'cancelled' : 'backlog' };
  }
  if (!fm.calendar) return { have: false, reason: 'no calendar' };

  const state: MarkerState = fm.resolution === 'done' ? 'done' : 'active';
  const { start, allDay } = startFromScheduled(fm.scheduled);
  const end = allDay ? start : addMinutesWall(start, durationMinutes(fm.duration));
  const up: UpsertEventArgs = {
    calendar: fm.calendar,
    marker: buildMarker(instance, action.id, state),
    title: (state === 'done' ? prefixes.done : prefixes.active) + fm.name,
    start,
    end,
  };
  if (fm.calendar_account) up.calendar_account = fm.calendar_account;
  if (allDay) up.allDay = true;
  else {
    up.durationMinutes = durationMinutes(fm.duration);
    if (fm.timezone) up.timezone = fm.timezone;
  }
  const notes = buildNotes(action);
  if (notes) up.notes = notes;
  return { have: true, state, up };
}

function sameEventZone(a: string | null | undefined, b: string | null | undefined): boolean {
  if ((a ?? null) === (b ?? null)) return true;
  if (!a || !b) return false; // A named zone is distinct from a floating clock.
  try {
    return new Intl.DateTimeFormat('en', { timeZone: a }).resolvedOptions().timeZone ===
      new Intl.DateTimeFormat('en', { timeZone: b }).resolvedOptions().timeZone;
  } catch { return false; }
}

// Whether an action's desired event differs from the calendar's current event on
// the load-bearing fields — title, marker, target calendar, start, and (for timed
// events) elapsed duration. Notes are intentionally out: they ride along whenever
// a load-bearing field changes, rather than being diffed on their own. All-day starts compare by
// date. Gates the reverse forward-reconcile's update-only-on-change.
function eventsDiffer(up: UpsertEventArgs, ev: CalEvent): boolean {
  if (up.title !== ev.title) return true;
  if (up.marker !== ev.url) return true;
  if (up.calendar !== ev.calendar) return true;
  if (up.calendar_account && up.calendar_account !== ev.calendar_account) return true;
  if (!!up.allDay !== !!ev.allDay) return true;
  if (up.allDay) return up.start.slice(0, 10) !== ev.start.slice(0, 10);
  if (!sameEventZone(up.timezone, ev.timezone)) return true;
  if (up.start !== ev.start) return true;
  return up.durationMinutes !== (ev.endInstant - ev.startInstant) / 60000;
}

// Apply a calendar event's gestures back to its action, returning the resulting
// front matter and a human summary per change (empty when the event already
// agrees). A lifecycle suffix (done / cancelled / backlog) wins over a move/resize;
// a kept event (active or done) imports a calendar re-pin, and an active one also
// its start (→ scheduled) and length (→ duration). Pure: the caller writes the
// result, then re-derives the event from it.
export function importFromEvent(action: SyncAction, ev: CalEvent, calendars: CalCalendar[]): { fm: ActionFrontMatter; summaries: string[] } {
  const fm = { ...action.frontMatter };
  const summaries: string[] = [];
  const parsed = parseMarker(ev.url);
  if (!parsed) return { fm, summaries }; // unparseable — leave untouched

  if (parsed.state === 'cancelled') {
    if (fm.resolution !== 'cancelled') { fm.resolution = 'cancelled'; summaries.push('cancelled'); }
    return { fm, summaries };
  }
  if (parsed.state === 'backlog') {
    if (fm.scheduled) { delete fm.scheduled; summaries.push('descheduled'); }
    return { fm, summaries };
  }
  if (parsed.state === 'done' && fm.resolution !== 'done') {
    fm.resolution = 'done';
    summaries.push('marked done');
  }

  // The event is kept (active or done). An unscheduled action's lingering event is
  // about to be removed, so import nothing onto it. Otherwise import a re-pin (the
  // user dragged the event to another calendar); an active event also imports a
  // move and/or resize, while a done event is a record whose time isn't imported.
  if (!fm.scheduled) return { fm, summaries };
  const accountChanged = fm.calendar_account && ev.calendar_account && fm.calendar_account !== ev.calendar_account;
  if (fm.calendar && ev.calendar && (ev.calendar !== fm.calendar || accountChanged)) {
    const qualifier = fm.calendar_account || matchingCalendars(calendars, { calendar: ev.calendar }).length > 1;
    const destination = { calendar: ev.calendar, calendar_account: qualifier ? ev.calendar_account : undefined };
    const routing = calendarRoutingError(calendars, destination);
    if (routing) throw new CalError(routing.message, routing.code);
    summaries.push(`moved to the ${ev.calendar}${destination.calendar_account ? ` (${destination.calendar_account})` : ''} calendar`);
    fm.calendar = ev.calendar;
    if (destination.calendar_account) fm.calendar_account = destination.calendar_account;
    else delete fm.calendar_account;
  }
  if (parsed.state === 'done') return { fm, summaries };

  if (!ev.allDay && ev.timezone !== null && typeof ev.timezone !== 'string') {
    throw new CalError('timezone: calendar helper did not report a named zone or explicit floating null; rebuild the helper and restart the daemon.', 'invalid-scheduling');
  }
  const newZone = ev.allDay ? undefined : ev.timezone ?? undefined;
  if (!ev.allDay && !sameEventZone(fm.timezone, newZone)) {
    summaries.push(`timezone ${fm.timezone ?? 'floating'} -> ${newZone ?? 'floating'}`);
    if (newZone) fm.timezone = newZone;
    else delete fm.timezone;
  }
  const newScheduled = ev.allDay ? ev.start.slice(0, 10) : ev.start;
  if (normalizeScheduled(fm.scheduled) !== newScheduled) {
    summaries.push(`rescheduled ${normalizeScheduled(fm.scheduled)} -> ${newScheduled}`);
    fm.scheduled = newScheduled;
  }
  if (!ev.allDay) {
    if (ev.durationMinutes !== undefined && (!Number.isSafeInteger(ev.durationMinutes) || ev.durationMinutes <= 0)) {
      throw new CalError('duration: calendar event length must be positive whole elapsed minutes.', 'invalid-scheduling');
    }
    const evMinutes = (ev.endInstant - ev.startInstant) / 60000;
    if (evMinutes > 0 && evMinutes !== durationMinutes(fm.duration)) {
      fm.duration = durationIso(evMinutes);
      summaries.push(`resized to ${fm.duration}`);
    }
  }
  return { fm, summaries };
}

// How long an event's notes may get. The deadline and description are short; the
// body fills whatever room is left and is truncated if it overflows.
const MAX_NOTE_LENGTH = 4000;

// Event notes: the deadline (if set) and the one-line description, each prefixed,
// then the full action body — truncated so the whole note fits MAX_NOTE_LENGTH.
// The marker lives in the event's url field, so it isn't duplicated here.
function buildNotes(action: SyncAction): string {
  const head: string[] = [];
  if (action.frontMatter.deadline) head.push(`Deadline: ${action.frontMatter.deadline}`);
  const description = action.description?.trim();
  if (description) head.push(`Description: ${description}`);

  const body = action.body.trim();
  const prefix = head.join('\n\n');
  if (!body) return prefix;
  if (!prefix) return truncate(body, MAX_NOTE_LENGTH);

  const sep = '\n\n';
  const room = MAX_NOTE_LENGTH - [...prefix].length - sep.length;
  return room > 0 ? prefix + sep + truncate(body, room) : prefix;
}

// Truncate to `max` code points (counted by code point so a cut never splits a
// surrogate pair) and mark the cut with an ellipsis, dropping any whitespace the
// cut left dangling.
function truncate(s: string, max: number): string {
  const cp = [...s];
  if (cp.length <= max) return s;
  return cp.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…';
}

// Ordered scan ranges: the ±1mo window first, then only the two segments that
// widen it to ±1yr (the left and right rings), so the month range is never
// re-queried when escalating.
function widenRanges(minDate: string, maxDate: string): Array<{ start: string; end: string }> {
  const month = expandWindow(minDate, maxDate, 'month');
  const year = expandWindow(minDate, maxDate, 'year');
  return [
    month,
    { start: year.start, end: month.start }, // [-1yr, -1mo)
    { start: month.end, end: year.end }, // (+1mo, +1yr]
  ];
}

// Widen [minDate, maxDate] (both YYYY-MM-DD) by a calendar month or year on each
// side, returned as wall-clock strings for the list-events range.
function expandWindow(minDate: string, maxDate: string, span: 'month' | 'year'): { start: string; end: string } {
  const lo = new Date(`${minDate}T00:00:00Z`);
  const hi = new Date(`${maxDate}T00:00:00Z`);
  if (span === 'month') {
    lo.setUTCMonth(lo.getUTCMonth() - 1);
    hi.setUTCMonth(hi.getUTCMonth() + 1);
  } else {
    lo.setUTCFullYear(lo.getUTCFullYear() - 1);
    hi.setUTCFullYear(hi.getUTCFullYear() + 1);
  }
  return { start: formatUtcTimestamp(lo), end: formatUtcTimestamp(hi) };
}

// Split [start, end) into segments no longer than 3.5 years — safely inside
// EventKit's 4-year predicate cap (see listMarked). Wall-clock strings compare
// and split lexicographically.
const MAX_QUERY_MONTHS = 42;
function chunkRange(start: string, end: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  let cur = start;
  while (cur < end) {
    const d = new Date(`${cur.slice(0, 10)}T${cur.slice(11, 16) || '00:00'}:00Z`);
    d.setUTCMonth(d.getUTCMonth() + MAX_QUERY_MONTHS);
    const next = formatUtcTimestamp(d);
    out.push({ start: cur, end: next < end ? next : end });
    cur = next;
  }
  return out;
}

// The SyncAction for an id, read from the store — which capture/update (and reverse
// sync itself) keep current. The one-line description lives in the action's year
// index, not its file. `frontMatter` is copied so a caller that mutates it (reverse
// sync edits a working copy) can't corrupt the store's record. Null if not loaded.
export function storeAction(store: Store, id: string): SyncAction | null {
  const a = store.getAction(id);
  if (!a) return null;
  const description = store.getIndexDescription('actions', id) || undefined;
  return { id, frontMatter: { ...a.frontMatter }, body: a.body, description };
}
