import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/source/store.js';
import { InstanceSemanticLifecycle, type InstanceSemanticLifecycleOptions } from '../src/daemon/semantic-lifecycle.js';
import type {SemanticIndexSnapshot} from '../src/semantic/types.js';
import {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import { searchSourceVersion } from '../src/semantic/source-version.js';

const fixtures: Array<{home: string; store: Store; worker: InstanceSemanticLifecycle}> = [];
const snapshot = (store: Store, model = 'local-model'): SemanticIndexSnapshot => ({
  sourceVersion: searchSourceVersion(store), model, indexedChunks: store.getProjects().size,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function fixture(options: Partial<InstanceSemanticLifecycleOptions> = {}) {
  const home = mkdtempSync('/private/tmp/aside-semantic-worker-');
  mkdirSync(join(home, 'projects', '2026'), {recursive: true});
  writeFileSync(join(home, 'aside.md'), '---\nid: worker-fixture\n---\n');
  writeFileSync(join(home, 'projects', '2026', 'index.yaml'), '- id: 2026-10-28-item\n  description: Worker item\n');
  const write = (body: string) => writeFileSync(join(home, 'projects', '2026', '2026-10-28-item.md'), `---\nname: Item\ncreated: 2026-10-28\n---\n${body}\n`);
  write('Original');
  const store = new Store(home);
  const reconcile = vi.fn<InstanceSemanticLifecycleOptions['reconcile']>(async store => snapshot(store));
  const worker = new InstanceSemanticLifecycle({reconcile, debounceMs: 10, retryMinMs: 100, retryMaxMs: 400, reconciliationIntervalMs: 0, ...options});
  const changed = store.onChange(() => worker.changed(store));
  fixtures.push({home, store, worker});
  return {home, store, worker, reconcile, write, changed};
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.worker.close(); f.store.close(); rmSync(f.home, {recursive: true, force: true});
  }
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe('registered semantic index reconciliation', () => {
  it('keeps common lifecycle flushing pending until actual index work completes', async () => {
    const f = fixture(), held = deferred<SemanticIndexSnapshot>();
    f.reconcile.mockImplementationOnce(() => held.promise);
    vi.spyOn(f.store, 'watch').mockImplementation(() => {});
    const owner = new InstanceLifecycle({debounceMs: 0, reconciliationIntervalMs: 0});
    owner.addFeature('semantic', {
      load: store => f.worker.register(store),
      observe: store => f.worker.changed(store),
      synchronize: (store, delivery) => f.worker.synchronize(store, {check: delivery.reconcile}),
      unload: store => f.worker.unregister(store),
    });
    owner.register(f.store);
    try {
      let drained = false;
      const flush = owner.flush().then(() => {drained = true;});
      await vi.advanceTimersByTimeAsync(0);
      expect(f.reconcile).toHaveBeenCalledOnce(); expect(drained).toBe(false);
      held.resolve(snapshot(f.store));
      await flush;
      expect(drained).toBe(true); expect(owner.issues(f.store)).toEqual([]);
      expect(f.reconcile).toHaveBeenCalledOnce();
    } finally {owner.close();}
  });

  it('reports real maintenance failure to the common owner without bypassing index backoff', async () => {
    const f = fixture();
    f.reconcile.mockRejectedValueOnce(new Error('Model temporarily unavailable'));
    vi.spyOn(f.store, 'watch').mockImplementation(() => {});
    const owner = new InstanceLifecycle({debounceMs: 0, reconciliationIntervalMs: 0, retryMinMs: 10, retryMaxMs: 80});
    owner.addFeature('semantic', {
      load: store => f.worker.register(store),
      observe: store => f.worker.changed(store),
      synchronize: (store, delivery) => f.worker.synchronize(store, {check: delivery.reconcile}),
      unload: store => f.worker.unregister(store),
    });
    owner.register(f.store);
    try {
      await owner.flush();
      expect(owner.issues(f.store)).toEqual([expect.objectContaining({field: 'semantic', message: expect.stringContaining('Model temporarily unavailable')})]);
      await vi.advanceTimersByTimeAsync(99);
      expect(f.reconcile).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.reconcile).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(70);
      // The owner retry is a new integrity request; it observes recovery and
      // checks the current model rather than spending an old completion credit.
      expect(f.reconcile).toHaveBeenCalledTimes(3);
      expect(owner.issues(f.store)).toEqual([]);
    } finally {owner.close();}
  });

  it('backs off while the instance has not published a complete source hash', async () => {
    const f = fixture();
    const hash = vi.spyOn(f.store, 'getSourceVersion').mockImplementation(() => {throw new Error('Instance source update is incomplete');});
    f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    const first = hash.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(99);
    expect(hash).toHaveBeenCalledTimes(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(hash.mock.calls.length).toBeGreaterThan(first);
    expect(f.reconcile).not.toHaveBeenCalled();
    hash.mockRestore();
    await vi.advanceTimersByTimeAsync(200);
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
    expect(f.reconcile).toHaveBeenCalledOnce();
  });
  it('indexes registration without a search and ignores no-op watcher rebuilds', async () => {
    const f = fixture();
    f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.reconcile).toHaveBeenCalledOnce();
    f.store.rebuild(); f.worker.changed(f.store); f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
    expect(f.reconcile).toHaveBeenCalledOnce();
  });

  it('coalesces a burst of observed changes into the latest source revision', async () => {
    const f = fixture(); f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    f.write('First edit'); f.store.rebuild();
    await vi.advanceTimersByTimeAsync(5);
    f.write('Second edit'); f.store.rebuild();
    await vi.advanceTimersByTimeAsync(5);
    expect(f.reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
  });

  it('uses the loaded instance snapshot without reading files during registration or retrieval', async () => {
    const f = fixture(); f.worker.register(f.store);
    const rebuild = vi.spyOn(f.store, 'rebuild');
    await f.worker.ensureCurrent(f.store);
    const original = searchSourceVersion(f.store);
    f.write('Disk edit awaiting instance synchronization');
    expect(searchSourceVersion(f.store)).toBe(original);
    const ready = await f.worker.ensureCurrent(f.store);
    expect(ready.sourceVersion).toBe(original);
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(rebuild).not.toHaveBeenCalled();
    // Only instance loading changes the authoritative snapshot.
    f.store.rebuild(); rebuild.mockClear();
    expect((await f.worker.ensureCurrent(f.store)).sourceVersion).not.toBe(original);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('forces index maintenance without taking ownership of source synchronization', async () => {
    const f = fixture(); f.worker.register(f.store);
    await f.worker.ensureCurrent(f.store);
    const original = searchSourceVersion(f.store);
    const rebuild = vi.spyOn(f.store, 'rebuild');
    f.write('Persisted write not yet loaded by the instance');
    expect(searchSourceVersion(f.store)).toBe(original);
    f.worker.invalidate(f.store);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(searchSourceVersion(f.store)).toBe(original);
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('indexes the newest loaded snapshot when it changes before queued work starts', async () => {
    const f = fixture(); f.worker.register(f.store);
    const ready = f.worker.ensureCurrent(f.store);
    f.write('Changed between memory verification and queued work'); f.store.rebuild();
    const result = await ready;
    expect(f.store.getProject('2026-10-28-item')!.body).toContain('Changed between memory verification');
    expect(result.sourceVersion).toBe(searchSourceVersion(f.store));
  });

  it('keeps an invalidation received during an older attempt until the new disk revision is reconciled', async () => {
    const f = fixture(), held = deferred<SemanticIndexSnapshot>();
    const original = snapshot(f.store);
    let signal!: AbortSignal;
    f.reconcile.mockImplementationOnce((_store, options) => { signal = options.signal; return held.promise; });
    f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    f.write('Persisted newer revision');
    // The notification must work without relying on a changed in-memory hash.
    expect(searchSourceVersion(f.store)).toBe(original.sourceVersion);
    f.worker.invalidate(f.store);
    expect(signal.aborted).toBe(true);
    f.store.rebuild();
    held.resolve(original);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    const ready = await f.worker.ensureCurrent(f.store);
    expect(ready.sourceVersion).not.toBe(original.sourceVersion);
    expect(ready.sourceVersion).toBe(searchSourceVersion(f.store));
  });

  it('periodically checks model/index state while source synchronization stays external', async () => {
    const observed: string[] = [];
    const reconcile = vi.fn<InstanceSemanticLifecycleOptions['reconcile']>(async store => {
      observed.push(store.getProject('2026-10-28-item')!.body.trim());
      return snapshot(store, observed.length === 1 ? 'old-weights' : 'new-weights');
    });
    const f = fixture({reconcile, reconciliationIntervalMs: 500}); f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(491);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect((await f.worker.ensureCurrent(f.store)).model).toBe('new-weights');
    f.write('Missed edit');
    await vi.advanceTimersByTimeAsync(500);
    expect(observed).toEqual(['Original', 'Original', 'Original']);
    f.store.rebuild(); await vi.advanceTimersByTimeAsync(10);
    expect(observed).toEqual(['Original', 'Original', 'Original', 'Missed edit']);
  });

  it('rechecks the loaded hash before certifying completion even without change notifications', async () => {
    const f = fixture(), held = deferred<SemanticIndexSnapshot>();
    const original = snapshot(f.store);
    f.changed();
    f.reconcile.mockImplementationOnce(() => held.promise);
    f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    f.write('Loaded while indexing'); f.store.rebuild();
    expect(searchSourceVersion(f.store)).not.toBe(original.sourceVersion);
    held.resolve(original);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.getProject('2026-10-28-item')!.body).toContain('Loaded while indexing');
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
  });

  it('does not certify a completed build when the instance reports an unreadable snapshot', async () => {
    const f = fixture(), held = deferred<SemanticIndexSnapshot>();
    f.changed();
    f.reconcile.mockImplementationOnce(() => held.promise);
    const original = snapshot(f.store);
    f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    const path = join(f.home, 'projects', '2026', '2026-10-28-item.md');
    unlinkSync(path); mkdirSync(path); f.store.rebuild();
    held.resolve(original);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.getIssues()).toContainEqual(expect.objectContaining({code: 'read_error'}));
    expect(f.reconcile).toHaveBeenCalledOnce();
    rmSync(path, {recursive: true}); f.write('Repaired after indexing'); f.store.rebuild();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
  });

  it('retries failed maintenance with bounded backoff and recovers without a query', async () => {
    const f = fixture();
    f.reconcile.mockRejectedValueOnce(new Error('Ollama unavailable')).mockRejectedValueOnce(new Error('Still unavailable'));
    f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(99);
    expect(f.reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reconcile).toHaveBeenCalledTimes(3);
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
    expect(f.reconcile).toHaveBeenCalledTimes(3);
  });

  it('propagates a current failure to a query instead of certifying an old snapshot', async () => {
    const f = fixture(); f.worker.register(f.store);
    await f.worker.ensureCurrent(f.store);
    f.write('Changed source'); f.store.rebuild();
    const unavailable = new Error('Model is unavailable'); f.reconcile.mockRejectedValueOnce(unavailable);
    await expect(f.worker.ensureCurrent(f.store)).rejects.toBe(unavailable);
    await vi.advanceTimersByTimeAsync(100);
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
  });

  it('backs off even when a rejected provider supplies no error object', async () => {
    const f = fixture(); f.reconcile.mockRejectedValueOnce(undefined); f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(99);
    expect(f.reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('cancels a superseded attempt and immediately reconciles the latest source', async () => {
    const f = fixture(), held = deferred<SemanticIndexSnapshot>();
    let staleSignal!: AbortSignal;
    f.reconcile.mockImplementationOnce((_store, options) => { staleSignal = options.signal; return held.promise; });
    f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    f.write('Latest source'); f.store.rebuild();
    expect(staleSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    const ready = await f.worker.ensureCurrent(f.store);
    expect(ready.sourceVersion).toBe(searchSourceVersion(f.store));
    held.resolve({sourceVersion: 'stale', model: 'old', indexedChunks: 999});
    await vi.advanceTimersByTimeAsync(20);
    expect(await f.worker.ensureCurrent(f.store)).toEqual(ready);
  });

  it('never marks a mismatched completion as ready', async () => {
    const f = fixture();
    f.reconcile.mockResolvedValueOnce({sourceVersion: 'old-revision', model: 'local-model', indexedChunks: 0});
    f.worker.register(f.store);
    const ready = await f.worker.ensureCurrent(f.store);
    expect(ready.sourceVersion).toBe(searchSourceVersion(f.store));
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('shares in-flight work while a caller cancellation only cancels its wait', async () => {
    const f = fixture(), held = deferred<SemanticIndexSnapshot>(), caller = new AbortController();
    let backgroundSignal!: AbortSignal;
    f.reconcile.mockImplementationOnce((_store, options) => { backgroundSignal = options.signal; return held.promise; });
    f.worker.register(f.store);
    const cancelled = f.worker.ensureCurrent(f.store, {signal: caller.signal});
    const joined = f.worker.ensureCurrent(f.store);
    const rejected = expect(cancelled).rejects.toThrow('caller stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.reconcile).toHaveBeenCalledOnce();
    caller.abort(new Error('caller stopped'));
    await rejected;
    expect(backgroundSignal.aborted).toBe(false);
    held.resolve(snapshot(f.store));
    expect(await joined).toEqual(snapshot(f.store));
    expect(f.reconcile).toHaveBeenCalledOnce();
  });

  it('does not invoke indexing when the loaded instance reports a synchronization failure', async () => {
    const f = fixture();
    const issue = {code: 'rebuild_failed', severity: 'error' as const, message: 'Cannot read source'};
    const health = vi.spyOn(f.store, 'getSourceHealth').mockReturnValue({complete: false, issue, issues: [issue]});
    const rebuild = vi.spyOn(f.store, 'rebuild');
    f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    health.mockRestore();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('does not certify retained last-good rows when a source file becomes unreadable', async () => {
    const f = fixture(); f.worker.register(f.store);
    await f.worker.ensureCurrent(f.store);
    const path = join(f.home, 'projects', '2026', '2026-10-28-item.md');
    unlinkSync(path); mkdirSync(path); f.store.rebuild();
    await expect(f.worker.ensureCurrent(f.store)).rejects.toThrow('not fully readable or parseable');
    expect(f.store.getIssues()).toContainEqual(expect.objectContaining({code: 'read_error'}));
    expect(f.store.getProject('2026-10-28-item')!.body).toContain('Original');
    expect(f.reconcile).toHaveBeenCalledOnce();
    rmSync(path, {recursive: true}); f.write('Readable replacement'); f.store.rebuild();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(await f.worker.ensureCurrent(f.store)).toEqual(snapshot(f.store));
  });

  it('does not interpret malformed entry YAML as deletion and automatically recovers after repair', async () => {
    const f = fixture();
    mkdirSync(join(f.home, 'notes', '2026'), {recursive: true});
    const path = join(f.home, 'notes', '2026', '2026-10-26.md');
    const note = (metadata: string) => `---\nweek: 44\nweek_start: 2026-10-26\nweek_end: 2026-11-01\n---\n\n\`\`\`entry\n${metadata}\n\`\`\`\nEntry text\n`;
    const valid = note('created: 2026-10-28T12:00'); writeFileSync(path, valid); f.store.rebuild();
    f.worker.register(f.store); await f.worker.ensureCurrent(f.store);
    expect(f.store.getEntries()).toHaveLength(1);
    writeFileSync(path, note('created: [broken')); f.store.rebuild();
    await expect(f.worker.ensureCurrent(f.store)).rejects.toThrow('invalid_yaml');
    expect(f.store.getEntries()).toHaveLength(0);
    expect(f.reconcile).toHaveBeenCalledOnce();
    writeFileSync(path, valid); f.store.rebuild();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.store.getEntries()).toHaveLength(1);
  });

  it.each(['description: Missing created', 'created: []', 'created: ""'])('rejects a parse that omits an entry with invalid identity: %s', async metadata => {
    const f = fixture();
    mkdirSync(join(f.home, 'notes', '2026'), {recursive: true});
    const path = join(f.home, 'notes', '2026', '2026-10-26.md');
    const note = (fields: string) => `---\nweek: 44\nweek_start: 2026-10-26\nweek_end: 2026-11-01\n---\n\n\`\`\`entry\n${fields}\n\`\`\`\nEntry text\n`;
    const valid = note('created: 2026-10-28T12:00'); writeFileSync(path, valid); f.store.rebuild();
    f.worker.register(f.store); await f.worker.ensureCurrent(f.store);
    writeFileSync(path, note(metadata)); f.store.rebuild();
    await expect(f.worker.ensureCurrent(f.store)).rejects.toThrow('missing_field');
    expect(f.store.getIssues()).toContainEqual(expect.objectContaining({code: 'missing_field', field: 'created'}));
    expect(f.store.getEntries()).toHaveLength(0);
    expect(f.reconcile).toHaveBeenCalledOnce();
    writeFileSync(path, valid); f.store.rebuild();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('keeps unrelated best-effort validation diagnostics usable', async () => {
    const f = fixture();
    writeFileSync(join(f.home, 'projects', '2026', '2026-10-28-item.md'), '---\nname: ""\ncreated: 2026-10-28\n---\nReadable project body\n');
    f.store.rebuild();
    f.worker.register(f.store);
    const ready = await f.worker.ensureCurrent(f.store);
    expect(f.store.getIssues()).toContainEqual(expect.objectContaining({code: 'missing_field', field: 'name'}));
    expect(ready.sourceVersion).toBe(searchSourceVersion(f.store));
    expect(f.reconcile).toHaveBeenCalledOnce();
  });

  it('keeps repeated loaded-source failures pending until the instance reports repair', async () => {
    const f = fixture(); f.worker.register(f.store);
    await f.worker.ensureCurrent(f.store);
    const version = searchSourceVersion(f.store);
    const issue = {severity: 'error' as const, code: 'rebuild_failed', message: 'Source was unreadable'};
    const health = vi.spyOn(f.store, 'getSourceHealth').mockReturnValue({complete: false, issue, issues: [issue]});
    const refresh = vi.spyOn(f.store, 'rebuild');
    // Repeated identical failures can have the same cached semantic fingerprint.
    expect(searchSourceVersion(f.store)).toBe(version);
    f.worker.changed(f.store);
    await vi.advanceTimersByTimeAsync(10);
    expect(refresh).not.toHaveBeenCalled();
    expect(f.reconcile).toHaveBeenCalledOnce();
    health.mockRestore();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
  });

  it('unregisters and closes without pending retries or late Store access', async () => {
    const f = fixture(), held = deferred<SemanticIndexSnapshot>();
    let signal!: AbortSignal;
    f.reconcile.mockImplementationOnce((_store, options) => { signal = options.signal; return held.promise; });
    f.worker.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    const refresh = vi.spyOn(f.store, 'rebuild');
    f.worker.unregister(f.store);
    expect(signal.aborted).toBe(true);
    held.resolve({sourceVersion: 'old', model: 'old', indexedChunks: 1});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(f.reconcile).toHaveBeenCalledOnce();
    await expect(f.worker.ensureCurrent(f.store)).rejects.toThrow('not registered');
    await f.worker.close();
    expect(() => f.worker.register(f.store)).toThrow('closed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
