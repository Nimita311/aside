import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {InstanceLifecycle, type InstanceLifecycleOptions} from '../src/daemon/instance-lifecycle.js';
import {InstanceHost} from '../src/daemon/host.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {artifactAttachmentPath, artifactFilePath} from '../src/core/artifact.js';
import {MutationWriteError} from '../src/source/mutation-result.js';
import * as atomicFile from '../src/storage/atomic-file.js';
import {hostGraphQL} from './support/graphql-host.js';

const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  // These tests isolate owner-driven reconciliation from native watcher events.
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function fixture(options: InstanceLifecycleOptions = {}) {
  const root = mkdtempSync('/private/tmp/aside-source-owner-');
  mkdirSync(join(root, 'projects', '2026'), {recursive: true});
  writeFileSync(join(root, 'aside.md'), '---\nid: source-owner\nname: Source owner\n---\n');
  const id = '2026-10-28-item', file = join(root, 'projects', '2026', `${id}.md`);
  const write = (body: string) => writeFileSync(file, `---\nname: Item\ncreated: 2026-10-28\n---\n${body}\n`);
  write('Original loaded content');
  const store = new Store(root);
  const refreshed = vi.fn();
  const lifecycle = new InstanceLifecycle({debounceMs: 5, retryMinMs: 10, retryMaxMs: 40,
    reconciliationIntervalMs: 100, onRefreshed: refreshed, ...options});
  cleanups.push(() => {lifecycle.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  return {root, file, id, store, lifecycle, write, refreshed};
}

describe('loaded instance source ownership', () => {
  it('owns global catalogue retry and cancels it with the source lifecycle', async () => {
    const f = fixture({reconciliationIntervalMs: 0}); f.lifecycle.register(f.store);
    await f.lifecycle.flush();
    let failed = true;
    const observe = vi.fn(() => {if (failed) throw new Error('Catalogue unavailable');});
    f.lifecycle.addMaintenance('catalogue', observe, 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(observe).toHaveBeenCalledOnce();
    expect(f.lifecycle.issues(f.store)).toContainEqual(expect.objectContaining({code: 'instance_feature_failed', field: 'catalogue'}));
    await vi.advanceTimersByTimeAsync(10); expect(observe).toHaveBeenCalledTimes(2);
    failed = false;
    await vi.advanceTimersByTimeAsync(20); expect(observe).toHaveBeenCalledTimes(3);
    expect(f.lifecycle.issues(f.store)).toEqual([]);
    f.lifecycle.close(); await vi.advanceTimersByTimeAsync(100);
    expect(observe).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  });

  it('reconciles missed edits without any semantic feature or query', async () => {
    const f = fixture(); f.lifecycle.register(f.store);
    await vi.advanceTimersByTimeAsync(5);
    const version = f.store.getSourceVersion();
    f.write('Missed watcher edit');
    expect(f.store.getSourceVersion()).toBe(version);
    await vi.advanceTimersByTimeAsync(95);
    expect(f.store.getProject(f.id)!.body).toContain('Missed watcher edit');
    expect(f.store.getSourceVersion()).not.toBe(version);
  });

  it('refreshes confirmed disk writes whose immediate readback did not update memory', async () => {
    const f = fixture({reconciliationIntervalMs: 0}); f.lifecycle.register(f.store);
    await vi.advanceTimersByTimeAsync(5);
    f.write('Persisted before failed readback');
    f.lifecycle.invalidate(f.store);
    await vi.advanceTimersByTimeAsync(4);
    expect(f.store.getProject(f.id)!.body).toContain('Original loaded content');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.getProject(f.id)!.body).toContain('Persisted before failed readback');
  });

  it.each([1, 2])('repairs an incomplete mutation after %i failed writes without watcher or periodic recovery', async failures => {
    const f = fixture({reconciliationIntervalMs: 0});
    const id = '2026-10-28-material', file = artifactFilePath(f.root, id);
    f.store.saveArtifact(id, {name: 'Material', created: '2026-10-28T10:00'}, 'Artifact body', file);
    f.lifecycle.register(f.store); await f.lifecycle.flush();
    const previousVersion = f.store.getSourceVersion();
    const attachment = artifactAttachmentPath(f.root, id, 'extra.txt');
    mkdirSync(dirname(attachment), {recursive: true}); writeFileSync(attachment, 'Additional material');
    const originalWrite = atomicFile.writeFileCrashSafe;
    let remainingFailures = failures;
    const write = vi.spyOn(atomicFile, 'writeFileCrashSafe').mockImplementation((...args) => {
      if (remainingFailures-- > 0) throw new Error('Reconciliation write failed');
      originalWrite(...args);
    });
    let failure: unknown;
    try {f.lifecycle.mutation(f.store, () => f.store.refreshArtifactAttachments(id));}
    catch (error) {failure = error;}
    expect(failure).toBeInstanceOf(MutationWriteError);
    expect((failure as MutationWriteError).partialResult).toMatchObject({status: 'FAILED', changes: []});
    expect(readFileSync(file, 'utf8')).not.toContain('extra.txt');
    expect(() => f.store.getSourceVersion()).toThrow('Instance source update is incomplete');
    await vi.advanceTimersByTimeAsync(5);
    expect(write).toHaveBeenCalledTimes(2);
    if (failures === 2) {
      expect(readFileSync(file, 'utf8')).not.toContain('extra.txt');
      expect(f.store.getIssues()).toContainEqual(expect.objectContaining({code: 'artifact_attachment_index_error'}));
      await vi.advanceTimersByTimeAsync(9); expect(write).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1); expect(write).toHaveBeenCalledTimes(3);
    }
    expect(readFileSync(file, 'utf8')).toContain('extra.txt');
    expect(f.store.getArtifact(id)!.frontMatter.attachments).toEqual(['extra.txt']);
    expect(f.store.getSourceVersion()).not.toBe(previousVersion);
    expect(f.store.getIssues().some(issue => issue.code === 'artifact_attachment_index_error')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('repairs index drift observed by a rejected update without watcher or periodic recovery', async () => {
    const f = fixture({reconciliationIntervalMs: 0});
    f.store.addIndexEntry('projects', f.file, f.id, 'Original description');
    f.lifecycle.register(f.store); await f.lifecycle.flush();
    const previousVersion = f.store.getSourceVersion(), indexFile = join(dirname(f.file), 'index.yaml');
    writeFileSync(indexFile, '[]\n');
    const receipt = f.lifecycle.mutation(f.store, () => f.store.setIndexEntry('projects', f.id, 'Rejected description'));
    expect(receipt.value).toBe(false);
    expect(receipt.result).toMatchObject({status: 'FAILED', changes: [], failures: [{kind: 'index', id: f.id}]});
    expect(() => f.store.getSourceVersion()).toThrow('Instance source update is incomplete');
    await vi.advanceTimersByTimeAsync(4);
    expect(f.store.getIndexDescription('projects', f.id)).toBe('Original description');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.getIndexDescription('projects', f.id)).toBeUndefined();
    expect(readFileSync(indexFile, 'utf8')).toBe('[]\n');
    expect(f.store.getSourceVersion()).not.toBe(previousVersion);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps unreadable content unknown and retries after repair without a query', async () => {
    const f = fixture({reconciliationIntervalMs: 0}); f.lifecycle.register(f.store);
    await vi.advanceTimersByTimeAsync(5);
    unlinkSync(f.file); mkdirSync(f.file);
    f.lifecycle.refresh(f.store);
    expect(f.store.getIssues()).toContainEqual(expect.objectContaining({code: 'read_error'}));
    expect(f.store.getProject(f.id)!.body).toContain('Original loaded content');
    rmSync(f.file, {recursive: true}); f.write('Readable replacement');
    await vi.advanceTimersByTimeAsync(10);
    expect(f.store.getIssues().some(issue => issue.code === 'read_error')).toBe(false);
    expect(f.store.getProject(f.id)!.body).toContain('Readable replacement');
  });

  it('publishes a rebuild failure and retries with bounded backoff independently of indexing', async () => {
    const f = fixture({reconciliationIntervalMs: 0}); f.lifecycle.register(f.store);
    await vi.advanceTimersByTimeAsync(5);
    const original = f.store.rebuild.bind(f.store);
    const rebuild = vi.spyOn(f.store, 'rebuild').mockImplementation(() => {throw new Error('Filesystem temporarily unavailable');});
    expect(() => f.lifecycle.refresh(f.store)).toThrow('Filesystem temporarily unavailable');
    expect(f.store.getIssues()).toContainEqual(expect.objectContaining({code: 'rebuild_failed'}));
    await vi.advanceTimersByTimeAsync(9); expect(rebuild).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(rebuild).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19); expect(rebuild).toHaveBeenCalledTimes(2);
    rebuild.mockImplementation(original); f.write('Repaired source');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.getProject(f.id)!.body).toContain('Repaired source');
    expect(f.store.getIssues().some(issue => issue.code === 'rebuild_failed')).toBe(false);
  });

  it('cancels pending retries, polling, and watchers when the instance unloads', async () => {
    const f = fixture(); f.lifecycle.register(f.store);
    const close = vi.spyOn(f.store, 'close'), rebuild = vi.spyOn(f.store, 'rebuild');
    f.lifecycle.invalidate(f.store); f.lifecycle.unregister(f.store);
    f.write('Changed after unload'); await vi.advanceTimersByTimeAsync(1_000);
    expect(close).toHaveBeenCalledOnce(); expect(rebuild).not.toHaveBeenCalled();
    expect(f.refreshed).not.toHaveBeenCalled();
  });

  it('keeps the host source current with semantic indexing unconfigured', async () => {
    const f = fixture(), host = new InstanceHost(new CalClient(null));
    host.configureSources({debounceMs: 0, reconciliationIntervalMs: 20});
    const loaded = host.load(f.root);
    cleanups.push(() => host.close());
    await vi.advanceTimersByTimeAsync(1);
    f.write('Observed by source lifecycle only');
    const rebuild = vi.spyOn(loaded.store, 'rebuild');
    await vi.advanceTimersByTimeAsync(20);
    expect(loaded.store.getProject(f.id)!.body).toContain('Observed by source lifecycle only');
    expect(rebuild).toHaveBeenCalled();
    rebuild.mockClear();
    const query = JSON.parse((await hostGraphQL(host, f.root, 'query', {document: '{activeInstance {id}}'})).text);
    expect(query.data.activeInstance.id).toBe('source-owner');
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('isolates a failed feature from source publication and healthy features, then retries it', async () => {
    const f = fixture({reconciliationIntervalMs: 0});
    let fail = false;
    const broken = vi.fn(() => {if (fail) throw new Error('Feature temporarily unavailable');});
    const healthy = vi.fn((store: Store) => store.getSourceVersion());
    f.lifecycle.addFeature('broken', {changed: broken});
    f.lifecycle.addFeature('healthy', {changed: store => {healthy(store);}});
    f.lifecycle.register(f.store); await vi.advanceTimersByTimeAsync(10);
    broken.mockClear(); healthy.mockClear(); fail = true;
    f.write('Published despite feature failure');
    expect(() => f.lifecycle.refresh(f.store)).not.toThrow();
    const published = f.store.getSourceVersion();
    expect(f.store.getProject(f.id)!.body).toContain('Published despite feature failure');
    await vi.advanceTimersByTimeAsync(5);
    expect(broken).toHaveBeenCalledOnce(); expect(healthy).toHaveBeenCalledOnce();
    expect(healthy.mock.results[0].value).toBe(published);
    expect(f.store.getIssues().some(issue => issue.code === 'rebuild_failed')).toBe(false);
    expect(f.lifecycle.issues(f.store)).toEqual([expect.objectContaining({code: 'instance_feature_failed', field: 'broken'})]);
    fail = false; await vi.advanceTimersByTimeAsync(10);
    expect(broken).toHaveBeenCalledTimes(2); expect(healthy).toHaveBeenCalledOnce();
    expect(f.lifecycle.issues(f.store)).toEqual([]);
  });

  it('isolates synchronous observation failures and retries the observation before delivery', async () => {
    const f = fixture({reconciliationIntervalMs: 0});
    let fail = false;
    const observe = vi.fn(() => {if (fail) throw new Error('Source observation unavailable');});
    const broken = vi.fn(), healthy = vi.fn(), healthyObserve = vi.fn();
    f.lifecycle.addFeature('broken', {observe, changed: broken});
    f.lifecycle.addFeature('healthy', {observe: healthyObserve, changed: healthy});
    f.lifecycle.register(f.store); await f.lifecycle.flush();
    observe.mockClear(); broken.mockClear(); healthy.mockClear(); healthyObserve.mockClear(); fail = true;
    f.write('Published despite observation failure');

    expect(() => f.lifecycle.refresh(f.store)).not.toThrow();
    expect(observe).toHaveBeenCalledOnce(); expect(healthyObserve).toHaveBeenCalledOnce();
    expect(f.store.getProject(f.id)!.body).toContain('Published despite observation failure');
    await vi.advanceTimersByTimeAsync(5);
    expect(observe).toHaveBeenCalledTimes(2); expect(broken).not.toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledOnce();
    expect(f.lifecycle.issues(f.store)).toEqual([expect.objectContaining({field: 'broken', message: expect.stringContaining('Source observation unavailable')})]);

    fail = false; await vi.advanceTimersByTimeAsync(10);
    expect(observe).toHaveBeenCalledTimes(3); expect(broken).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce(); expect(f.lifecycle.issues(f.store)).toEqual([]);
  });

  it('bounds feature retry backoff and finishes teardown even when one feature unload fails', async () => {
    const f = fixture({reconciliationIntervalMs: 0}); f.lifecycle.register(f.store);
    await vi.advanceTimersByTimeAsync(10);
    const load = vi.fn(() => {throw new Error('Feature load unavailable');});
    const brokenUnload = vi.fn(() => {throw new Error('Unload failed');}), healthyUnload = vi.fn();
    f.lifecycle.addFeature('broken', {load, unload: brokenUnload});
    f.lifecycle.addFeature('healthy', {unload: healthyUnload});
    expect(load).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9); expect(load).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19); expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(39); expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(40); expect(load).toHaveBeenCalledTimes(5);
    expect(f.lifecycle.issues(f.store)).toHaveLength(1);
    expect(() => f.lifecycle.unregister(f.store)).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(5);
    expect(brokenUnload).toHaveBeenCalledOnce(); expect(healthyUnload).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes queued source repair and feature delivery without advancing debounce timers', async () => {
    const f = fixture({reconciliationIntervalMs: 0}), changed = vi.fn(), reconcile = vi.fn();
    f.lifecycle.addFeature('delivery', {changed, reconcile});
    f.lifecycle.register(f.store);
    const rebuild = vi.spyOn(f.store, 'rebuild');
    f.write('Queued disk change'); f.lifecycle.invalidate(f.store);
    await f.lifecycle.flush();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(f.store.getProject(f.id)!.body).toContain('Queued disk change');
    expect(changed).toHaveBeenCalledExactlyOnceWith(f.store);
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(f.store);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes accepted loaded writes without rescanning their source', async () => {
    const f = fixture({reconciliationIntervalMs: 0}), changed = vi.fn();
    f.lifecycle.addFeature('delivery', {changed}); f.lifecycle.register(f.store);
    await f.lifecycle.flush(); changed.mockClear();
    const rebuild = vi.spyOn(f.store, 'rebuild'), previous = f.store.getSourceVersion();
    f.store.saveProject(f.id, {...f.store.getProject(f.id)!.frontMatter}, 'Published loaded write', f.file);
    f.lifecycle.mutated(f.store, previous);
    await f.lifecycle.flush();
    expect(changed).toHaveBeenCalledExactlyOnceWith(f.store);
    expect(rebuild).not.toHaveBeenCalled();
    expect(f.store.getProject(f.id)!.body).toBe('Published loaded write');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not spin or retry failed adapters during flush and cancels their retry on close', async () => {
    const f = fixture({reconciliationIntervalMs: 0});
    const changed = vi.fn(() => {throw new Error('Adapter unavailable');}), unload = vi.fn();
    f.lifecycle.addFeature('broken', {changed, unload}); f.lifecycle.register(f.store);
    await f.lifecycle.flush();
    expect(changed).toHaveBeenCalledOnce();
    const issues = f.lifecycle.issues(f.store);
    expect(issues).toEqual([expect.objectContaining({code: 'instance_feature_failed', field: 'broken'})]);
    await f.lifecycle.flush();
    expect(changed).toHaveBeenCalledOnce();
    expect(f.lifecycle.issues(f.store)).toEqual(issues);
    expect(vi.getTimerCount()).toBe(1);
    f.lifecycle.close(); await vi.advanceTimersByTimeAsync(1_000);
    expect(unload).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
