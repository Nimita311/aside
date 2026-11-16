import type {Store} from '../source/store.js';
import type {ParseIssue} from '../core/types.js';
import {isAsideDir, instancePathError} from '../core/instance.js';
import {MutationWriteError, assertMutationOwnership, trackOwnedMutation, beforeMutationWrite, type MutationResult} from '../source/mutation-result.js';
import {errorMessage} from '../core/error.js';
import {retryTiming} from '../core/async.js';

export interface InstanceLifecycleOptions {
  reconciliationIntervalMs?: number;
  debounceMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  onRefreshed?: (store: Store) => void;
}

export interface InstanceLifecycleDelivery {
  readonly changed: boolean;
  readonly reconcile: boolean;
}

export interface InstanceLifecycleFeature {
  /** Synchronous initialization observes the instance before its first writes. */
  load?: (store: Store) => void;
  /** Observe a published source generation immediately, even while the prior
   * asynchronous delivery is running. Scheduling remains with lifecycle. */
  observe?: (store: Store) => void;
  /** Receive one coalesced delivery when change and integrity work share the
   * same operation. Other features may retain the separate callbacks below. */
  synchronize?: (store: Store, delivery: InstanceLifecycleDelivery) => void | Promise<void>;
  changed?: (store: Store) => void | Promise<void>;
  reconcile?: (store: Store) => void | Promise<void>;
  unload?: (store: Store) => void;
}

interface FeatureWork {
  name: string;
  feature: InstanceLifecycleFeature;
  loaded: boolean;
  observationPending?: boolean;
  changed: boolean;
  reconcile: boolean;
  failures: number;
  error?: unknown;
  timer?: ReturnType<typeof setTimeout>;
  timerAt?: number;
  requestedReconcileAt?: number;
  work?: Promise<void>;
}
interface LoadedSource {
  store: Store;
  unwatch: () => void;
  timer?: ReturnType<typeof setTimeout>;
  refreshing: boolean;
  failures: number;
  features: Map<string, FeatureWork>;
}

const failedRead = (store: Store) => store.getIssues().some(issue => issue.severity === 'error'
  && ['read_error', 'rebuild_failed', 'artifact_attachment_index_error'].includes(issue.code));
const needsRepair = (store: Store) => {
  if (failedRead(store)) return true;
  try {store.getSourceVersion(); return false;} catch {return true;}
};

/** One owner for source repair and delivery to the loaded instance's features.
 * Reads consume published state; event bursts and exceptional drift settle here. */
export class InstanceLifecycle {
  private readonly sources = new Map<Store, LoadedSource>();
  private readonly features = new Map<string, InstanceLifecycleFeature>();
  private readonly interval?: ReturnType<typeof setInterval>;
  private readonly debounceMs: number;
  private readonly retryDelay: (failures: number) => number;
  private closed = false;
  private readonly maintenance = new Map<string, {run: () => void; interval: number; failures: number; error?: unknown; timer?: ReturnType<typeof setTimeout>}>();

  constructor(private readonly options: InstanceLifecycleOptions = {}) {
    const timing = retryTiming(options, 'Invalid instance lifecycle intervals.');
    this.debounceMs = timing.debounceMs; this.retryDelay = timing.retryDelay;
    if (timing.intervalMs) {
      this.interval = setInterval(() => {
        for (const source of this.sources.values()) this.attempt(source);
      }, timing.intervalMs);
      this.interval.unref?.();
    }
  }

  addFeature(name: string, feature: InstanceLifecycleFeature): void {
    if (this.closed || this.features.has(name)) throw new Error(`Instance lifecycle feature cannot be registered: ${name}`);
    this.features.set(name, feature);
    for (const source of this.sources.values()) this.loadFeature(source, name, feature);
  }

  /** Global catalogue observations share the same lifetime and retry owner. */
  addMaintenance(name: string, run: () => void, interval: number): void {
    if (this.closed || this.maintenance.has(name) || !Number.isSafeInteger(interval) || interval <= 0) throw new Error(`Invalid lifecycle maintenance: ${name}`);
    const state = {run, interval, failures: 0, error: undefined as unknown, timer: undefined as ReturnType<typeof setTimeout> | undefined};
    const schedule = (delay: number) => {
      if (this.closed) return;
      state.timer = setTimeout(() => {
        try {state.run(); state.failures = 0; state.error = undefined;} catch (error) {state.failures++; state.error = error;}
        schedule(state.failures ? this.retryDelay(state.failures) : state.interval);
      }, delay);
      state.timer.unref?.();
    };
    this.maintenance.set(name, state); schedule(interval);
  }

  /** All synchronous authored writes share durable-effect delivery and repair. */
  mutation<T>(store: Store, write: () => T, options: {prepare?: () => (() => void) | undefined; beforeWrite?: () => void; readback?: boolean} = {}): {value: T; result: MutationResult; readbackError?: string} {
    assertMutationOwnership(store);
    this.assertWritable(store);
    // A later serial mutation must not prepare against a failed publication.
    if (options.readback && needsRepair(store)) this.refresh(store);
    let previousVersion: string | undefined;
    try {previousVersion = store.getSourceVersion();} catch { /* Existing repair remains pending. */ }
    try {
      const tracked = trackOwnedMutation(store, () => {
        let pending = options.prepare ? options.prepare() : options.beforeWrite;
        const commit = () => {const linked = pending; pending = undefined; linked?.();};
        const release = pending ? beforeMutationWrite(store, commit) : undefined;
        try {
          const value = write();
          // Valid no-op parent edits can still have linked durable effects.
          commit();
          return value;
        } finally {release?.();}
      });
      if (tracked.result.changes.length) {
        store.notePersistedChanges(tracked.result.changes);
        if (tracked.result.status === 'PARTIAL') this.invalidate(store);
        this.mutated(store, previousVersion);
      } else if (needsRepair(store)) this.invalidate(store);
      const readbackError = options.readback && (tracked.result.status === 'PARTIAL' || needsRepair(store))
        ? this.repairMutationReadback(store) : undefined;
      return {...tracked, ...(readbackError ? {readbackError} : {})};
    } catch (error) {
      if (error instanceof MutationWriteError && error.partialResult.changes.length) {
        store.notePersistedChanges(error.partialResult.changes);
        this.invalidate(store); this.mutated(store, previousVersion);
        if (options.readback) error.readbackError = this.repairMutationReadback(store);
      } else if (needsRepair(store)) this.invalidate(store);
      throw error;
    }
  }

  private repairMutationReadback(store: Store): string | undefined {
    try {this.refresh(store);}
    catch (error) {
      // Preserve the saved receipt, fence uncertain readback, and retain repair
      // with lifecycle even if refresh failed before publishing its fence.
      store.recordRebuildFailure(error);
      this.invalidate(store);
      return errorMessage(error);
    }
  }

  register(store: Store): void {
    if (this.closed) throw new Error('Instance lifecycle is closed.');
    if (this.sources.has(store)) return;
    const source: LoadedSource = {store, unwatch: () => {}, refreshing: false, failures: 0, features: new Map()};
    this.sources.set(store, source);
    source.unwatch = store.onChange(() => {
      if (!this.active(source)) return;
      for (const feature of source.features.values()) this.notifyFeature(source, feature, true, false);
      if (!source.refreshing) {
        if (failedRead(store)) this.retry(source);
        else source.failures = 0;
      }
    });
    try { store.watch(() => this.invalidate(store)); }
    catch (error) {this.sources.delete(store); source.unwatch(); throw error;}
    for (const [name, feature] of this.features) this.loadFeature(source, name, feature);
    // Repair the initial-read / watcher-readiness window even if no event arrives.
    this.schedule(source, this.debounceMs);
  }

  /** Confirmed daemon writes normally already published their loaded state. */
  mutated(store: Store, previousVersion?: string): void {
    const source = this.sources.get(store);
    if (!source || !this.active(source)) return;
    try {
      if (store.getSourceVersion() === previousVersion) this.invalidate(store);
      if (failedRead(store)) this.invalidate(store);
    } catch (error) {
      store.recordRebuildFailure(error);
      this.invalidate(store);
    }
    for (const feature of source.features.values()) this.notifyFeature(source, feature, true, false);
  }

  /** Persistence preflight protects a directory removed or repurposed externally.
   * This is a write guard; ordinary reads stay on the loaded snapshot. */
  assertWritable(store: Store): void {
    const source = this.sources.get(store);
    if (!source || !this.active(source)) throw new Error('Instance lifecycle is closed.');
    const path = store.getDataDir();
    if (!isAsideDir(path)) {
      const error = instancePathError(path);
      this.invalidate(store);
      throw error;
    }
  }

  /** File events and uncertain readback request one coalesced source refresh. */
  invalidate(store: Store): void {
    const source = this.sources.get(store);
    if (!source || !this.active(source)) return;
    source.failures = 0;
    this.schedule(source, this.debounceMs);
  }

  /** External integration signals do not require a source-file scan. */
  reconcileFeature(name: string): void {
    for (const source of this.sources.values()) {
      const feature = source.features.get(name);
      if (feature) this.notifyFeature(source, feature, false, true);
    }
  }

  /** A feature reports deferred work; lifecycle owns the deadline and selects
   * a fresh instance snapshot when the retry runs. */
  requestFeatureReconcile(name: string, store: Store, delayMs: number): void {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new Error('Invalid lifecycle reconciliation delay.');
    const source = this.sources.get(store);
    if (!source || !this.active(source)) return;
    const feature = source.features.get(name);
    if (!feature) throw new Error(`Instance lifecycle feature is unavailable: ${name}`);
    feature.reconcile = true;
    const requested = Date.now() + delayMs;
    feature.requestedReconcileAt = Math.min(feature.requestedReconcileAt ?? requested, requested);
    this.scheduleFeature(source, feature, Math.max(0, feature.requestedReconcileAt - Date.now()), false);
  }

  issues(store: Store): ParseIssue[] {
    const work = [...this.sources.get(store)?.features.values() ?? [], ...[...this.maintenance].map(([name, state]) => ({name, error: state.error}))];
    return work.flatMap(feature => feature.error === undefined ? [] : [{
      severity: 'warning' as const, code: 'instance_feature_failed', field: feature.name,
      message: `${feature.name} maintenance is pending: ${errorMessage(feature.error)}`,
    }]);
  }

  /** Drain accepted notifications before daemon shutdown. Failed adapters keep
   * their bounded retry policy; flushing never spins on unavailable services. */
  async flush(): Promise<void> {
    const refreshed = new Set<Store>();
    while (!this.closed) {
      for (const source of this.sources.values()) {
        if (source.timer && !source.failures && !refreshed.has(source.store)) {
          refreshed.add(source.store); clearTimeout(source.timer); source.timer = undefined; this.attempt(source);
        }
        for (const state of source.features.values()) {
          const futureRetry = state.requestedReconcileAt !== undefined && !state.changed
            && (state.timerAt ?? state.requestedReconcileAt) >= state.requestedReconcileAt && state.requestedReconcileAt > Date.now();
          if (state.timer && !state.failures && !futureRetry) {
            clearTimeout(state.timer); state.timer = undefined; this.runFeature(source, state);
          }
        }
      }
      const work = [...this.sources.values()].flatMap(source => [...source.features.values()].flatMap(state => state.work ? [state.work] : []));
      if (!work.length) return;
      await Promise.allSettled(work);
    }
  }

  /** Explicit refresh requests use the same owner as watcher and periodic work. */
  refresh(store: Store): void {
    const source = this.sources.get(store);
    if (!source || !this.active(source)) throw new Error('Instance is not loaded for lifecycle reconciliation.');
    if (source.refreshing) return;
    clearTimeout(source.timer); source.timer = undefined; source.refreshing = true;
    try {
      store.rebuild();
      if (failedRead(store)) this.retry(source);
      else source.failures = 0;
    } catch (error) {
      store.recordRebuildFailure(error);
      this.retry(source);
      throw error;
    } finally {
      source.refreshing = false;
      if (this.active(source)) {
        for (const feature of source.features.values()) this.notifyFeature(source, feature, false, true);
        this.options.onRefreshed?.(store);
      }
    }
  }

  unregister(store: Store): void {
    const source = this.sources.get(store);
    if (!source) return;
    this.sources.delete(store); clearTimeout(source.timer); source.unwatch();
    for (const state of source.features.values()) {
      clearTimeout(state.timer);
      try {state.feature.unload?.(store);} catch { /* Instance teardown continues for every feature. */ }
    }
    store.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.interval);
    for (const state of this.maintenance.values()) clearTimeout(state.timer);
    this.maintenance.clear();
    for (const store of this.sources.keys()) this.unregister(store);
  }

  private loadFeature(source: LoadedSource, name: string, feature: InstanceLifecycleFeature): void {
    const state: FeatureWork = {name, feature, loaded: false, changed: false, reconcile: true, failures: 0};
    source.features.set(name, state);
    try {feature.load?.(source.store); state.loaded = true;}
    catch (error) {state.error = error; state.failures++;}
    this.scheduleFeature(source, state, state.failures ? this.retryDelay(state.failures) : 0);
  }
  private notifyFeature(source: LoadedSource, feature: FeatureWork, changed: boolean, reconcile: boolean): void {
    feature.changed ||= changed; feature.reconcile ||= reconcile;
    feature.requestedReconcileAt = undefined;
    if (changed) {
      feature.failures = 0;
      if (feature.feature.observe) {
        feature.observationPending = true;
        try {feature.feature.observe(source.store); feature.observationPending = false;}
        catch (error) {feature.error = error ?? new Error('Feature source observation failed.');}
      }
    }
    this.scheduleFeature(source, feature, this.debounceMs);
  }
  private scheduleFeature(source: LoadedSource, state: FeatureWork, delay: number, replace = true): void {
    if (!this.active(source) || state.work) return;
    const at = Date.now() + delay;
    if (!replace && state.timer && state.timerAt !== undefined && state.timerAt <= at) return;
    clearTimeout(state.timer);
    state.timerAt = at;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.runFeature(source, state);
    }, delay);
    state.timer.unref?.();
  }
  private runFeature(source: LoadedSource, state: FeatureWork): void {
      if (!this.active(source) || state.work) return;
      state.timerAt = undefined;
      state.requestedReconcileAt = undefined;
      const changed = state.changed, reconcile = state.reconcile;
      const delivery: InstanceLifecycleDelivery = {changed, reconcile};
      state.changed = false; state.reconcile = false;
      const work = Promise.resolve().then(async () => {
        if (!this.active(source)) return;
        if (!state.loaded) {state.feature.load?.(source.store); state.loaded = true;}
        if (state.observationPending) {
          try {state.feature.observe?.(source.store); state.observationPending = false;}
          catch (error) {throw error ?? new Error('Feature source observation failed.');}
        }
        if (state.feature.synchronize) await state.feature.synchronize(source.store, delivery);
        else {
          if (changed) await state.feature.changed?.(source.store);
          if (reconcile && this.active(source) && !(changed && state.feature.changed && state.feature.changed === state.feature.reconcile)) await state.feature.reconcile?.(source.store);
        }
        state.error = undefined; state.failures = 0;
      }).catch(error => {
        state.error = error; state.failures++;
        state.changed ||= changed; state.reconcile ||= reconcile;
      }).finally(() => {
        state.work = undefined;
        if (state.changed || state.reconcile) this.scheduleFeature(source, state, state.failures ? this.retryDelay(state.failures)
          : state.changed || state.requestedReconcileAt === undefined ? this.debounceMs : Math.max(0, state.requestedReconcileAt - Date.now()));
      });
      state.work = work;
  }
  private active(source: LoadedSource): boolean {return !this.closed && this.sources.get(source.store) === source;}
  private retry(source: LoadedSource): void {if (this.active(source)) this.schedule(source, this.retryDelay(++source.failures));}
  private schedule(source: LoadedSource, delay: number): void {
    if (!this.active(source)) return;
    clearTimeout(source.timer);
    source.timer = setTimeout(() => {source.timer = undefined; this.attempt(source);}, delay);
    source.timer.unref?.();
  }
  private attempt(source: LoadedSource): void {
    if (!this.active(source) || source.refreshing) return;
    try {this.refresh(source.store);} catch { /* Source diagnostics and retry retain the failure. */ }
  }
}
