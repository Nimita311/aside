import type { Store } from '../source/store.js';
import { assertSearchSourceReadable, searchSourceVersion } from '../semantic/source-version.js';
import type {SemanticIndexSnapshot} from '../semantic/types.js';

export interface InstanceSemanticLifecycleOptions {
  reconcile: (store: Store, options: {signal: AbortSignal}) => Promise<SemanticIndexSnapshot>;
  debounceMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Recheck the model/index against loaded content; this never refreshes source files. */
  reconciliationIntervalMs?: number;
}

interface Registered {
  store: Store;
  controller: AbortController;
  targetVersion?: string;
  epoch: number;
  result?: SemanticIndexSnapshot;
  force: boolean;
  failures: number;
  error?: unknown;
  timer?: ReturnType<typeof setTimeout>;
  work?: Promise<SemanticIndexSnapshot>;
  attempt?: AbortController;
  attemptVersion?: string;
  attemptEpoch?: number;
}

function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}

/** Instance-lifecycle index worker. It consumes loaded snapshots and never reads source files. */
export class InstanceSemanticLifecycle {
  private readonly states = new Map<Store, Registered>();
  private readonly paths = new Map<string, Store>();
  private readonly debounceMs: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private interval?: ReturnType<typeof setInterval>;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: InstanceSemanticLifecycleOptions) {
    this.debounceMs = options.debounceMs ?? 100;
    this.retryMinMs = options.retryMinMs ?? 1_000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
    const interval = options.reconciliationIntervalMs ?? 60_000;
    if (![this.debounceMs, interval].every(value => Number.isSafeInteger(value) && value >= 0)
      || ![this.retryMinMs, this.retryMaxMs].every(value => Number.isSafeInteger(value) && value > 0)
      || this.retryMaxMs < this.retryMinMs) throw new Error('Invalid semantic reconciliation intervals.');
    if (interval) {
      this.interval = setInterval(() => {
        for (const state of this.states.values()) {
          // Active reconciliation already verifies the loaded snapshot and model.
          // Do not perpetually invalidate a large build on every timer tick.
          if (state.work) continue;
          state.force = true;
          this.schedule(state, 0);
        }
      }, interval);
      this.interval.unref?.();
    }
  }

  register(store: Store): void {
    if (this.closed) throw new Error('Semantic reconciliation is closed.');
    const prior = this.paths.get(store.getDataDir());
    if (prior && prior !== store) this.unregister(prior);
    if (this.states.has(store)) { this.changed(store); return; }
    const state: Registered = {store, controller: new AbortController(), epoch: 0, force: true, failures: 0};
    this.states.set(store, state);
    this.paths.set(store.getDataDir(), store);
    this.schedule(state, this.debounceMs);
  }

  /** Loaded instance changes converge on the same indexed snapshot. */
  changed(store: Store): void {
    const state = this.states.get(store);
    if (!state) return;
    try {
      const version = searchSourceVersion(store);
      if (version === state.targetVersion) {
        if (!store.getSourceHealth().complete) this.invalidate(store);
        return;
      }
      this.observeVersion(state, version);
      this.schedule(state, this.debounceMs, true);
    } catch (error) {
      this.failed(state, error);
      this.schedule(state, this.retryDelay(state), true);
    }
  }

  /** Retry index maintenance even when the loaded content hash is unchanged. */
  invalidate(store: Store): void {
    const state = this.states.get(store);
    if (!state) return;
    state.epoch++;
    state.force = true;
    state.failures = 0;
    state.error = undefined;
    if (state.attemptVersion !== undefined) state.attempt?.abort(new Error('Index invalidated during semantic reconciliation.'));
    this.schedule(state, this.debounceMs, true);
  }

  /** The common lifecycle awaits actual index work, including its failures.
   * A retained failed attempt keeps its own backoff: an owner retry must not
   * start another build before that worker's scheduled retry. */
  async synchronize(store: Store, options: {check?: boolean} = {}): Promise<void> {
    const state = this.states.get(store);
    if (!state || !this.active(state)) return;
    if (!options.check) this.changed(store);
    if (state.failures && !state.work) {
      throw state.error ?? new Error('Semantic index maintenance failed.');
    }
    // A combined change/integrity delivery reaches this method once. Every
    // later periodic or explicit check inspects the current model even when
    // an earlier source build already certified a different generation.
    if (options.check && !state.work) state.force = true;
    try {await this.ensureCurrent(store);}
    catch (error) {throw error ?? new Error('Semantic index maintenance failed.');}
  }

  /** Wait for the current loaded snapshot. Source and model discovery belong to
   * lifecycle reconciliation; warm waits only inspect its published state. */
  async ensureCurrent(store: Store, options: {signal?: AbortSignal} = {}): Promise<SemanticIndexSnapshot> {
    options.signal?.throwIfAborted();
    const state = this.states.get(store);
    if (!state || !this.active(state)) throw new Error('Instance is not registered for semantic reconciliation.');
    for (;;) {
      options.signal?.throwIfAborted();
      this.assertActive(state);
      let version: string;
      try {version = searchSourceVersion(store); this.observeVersion(state, version);}
      catch (error) {
        this.failed(state, error);
        this.schedule(state, this.retryDelay(state), true);
        throw error;
      }
      if (!state.force && !state.work && state.result?.sourceVersion === version) return state.result;
      try { await waitFor(this.start(state), options.signal); }
      catch (error) {
        options.signal?.throwIfAborted();
        this.assertActive(state);
        // A newer observed revision supersedes the failed/cancelled attempt.
        let current: string;
        try { current = searchSourceVersion(store); }
        catch { throw error; }
        if (current !== version || (state.force && state.failures === 0)) continue;
        throw error;
      }
      options.signal?.throwIfAborted();
      this.assertActive(state);
      // Completion certifies only the loaded snapshot. Instance updates while
      // work was pending leave it dirty, so this wait follows the newer hash.
      if (!state.force && !state.work && state.result?.sourceVersion === searchSourceVersion(store)) return state.result;
    }
  }

  unregister(store: Store): void {
    const state = this.states.get(store);
    if (!state) return;
    this.states.delete(store);
    if (this.paths.get(store.getDataDir()) === store) this.paths.delete(store.getDataDir());
    clearTimeout(state.timer);
    state.timer = undefined;
    state.controller.abort(new Error('Instance is no longer registered for semantic reconciliation.'));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.interval);
    this.interval = undefined;
    const work = [...this.states.values()].flatMap(state => state.work ? [state.work] : []);
    for (const store of [...this.states.keys()]) this.unregister(store);
    return this.closing = Promise.allSettled(work).then(() => {});
  }

  private active(state: Registered): boolean { return !this.closed && this.states.get(state.store) === state && !state.controller.signal.aborted; }
  private assertActive(state: Registered): void {
    state.controller.signal.throwIfAborted();
    if (!this.active(state)) throw new Error('Semantic reconciliation is closed.');
  }
  private observeVersion(state: Registered, version: string): void {
    if (state.targetVersion === version) return;
    state.targetVersion = version;
    state.epoch++;
    state.force = true;
    state.failures = 0;
    state.error = undefined;
    if (state.attemptVersion && state.attemptVersion !== version) {
      state.attempt?.abort(new Error('Source changed during semantic reconciliation.'));
    }
  }
  private loadedVersion(state: Registered): string {
    this.assertActive(state);
    assertSearchSourceReadable(state.store);
    const version = searchSourceVersion(state.store);
    this.observeVersion(state, version);
    return version;
  }
  private failed(state: Registered, error: unknown): void {
    if (!this.active(state)) return;
    state.force = true;
    state.error = error;
    state.failures++;
    state.attempt?.abort(error);
  }
  private retryDelay(state: Registered): number {
    return Math.min(this.retryMaxMs, this.retryMinMs * 2 ** Math.min(Math.max(0, state.failures - 1), 30));
  }
  private schedule(state: Registered, delay: number, replace = false): void {
    if (!this.active(state) || state.work || (state.timer && !replace)) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.start(state).catch(() => {});
    }, delay);
    state.timer.unref?.();
  }
  private start(state: Registered): Promise<SemanticIndexSnapshot> {
    this.assertActive(state);
    if (state.work) return state.work;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.attempt = new AbortController();
    state.attemptVersion = undefined;
    const signal = AbortSignal.any([state.controller.signal, state.attempt.signal]);
    let completionReadFailed = false;
    const work = Promise.resolve().then(async () => {
      const version = this.loadedVersion(state);
      state.attemptVersion = version;
      state.attemptEpoch = state.epoch;
      if (!state.force && state.result?.sourceVersion === version) return state.result;
      const result = await waitFor(this.options.reconcile(state.store, {signal}), signal);
      this.assertActive(state);
      // Loading/watching can publish a new snapshot during a long index build.
      // Never certify the previous snapshot after the loaded hash has changed.
      let current: string;
      try { current = this.loadedVersion(state); }
      catch (error) { completionReadFailed = true; throw error; }
      if (version === current && result.sourceVersion === current && state.attemptEpoch === state.epoch) {
        state.result = result;
        state.force = false;
        state.error = undefined;
        state.failures = 0;
      } else state.force = true;
      return result;
    }).catch(error => {
      if (this.active(state)) {
        let current: string;
        try { current = searchSourceVersion(state.store); }
        catch {
          this.failed(state, error);
          throw error;
        }
        this.observeVersion(state, current);
        if (!completionReadFailed && state.attemptVersion && (current !== state.attemptVersion || state.attemptEpoch !== state.epoch)) {
          state.force = true;
          state.error = undefined;
          state.failures = 0;
        } else this.failed(state, error);
      }
      throw error;
    }).finally(() => {
      if (state.work === work) state.work = undefined;
      state.attempt = undefined;
      state.attemptVersion = undefined;
      state.attemptEpoch = undefined;
      if (this.active(state) && state.force) this.schedule(state, state.failures ? this.retryDelay(state) : 0);
    });
    state.work = work;
    // Detached background attempts always have a rejection observer.
    void work.catch(() => {});
    return work;
  }
}
