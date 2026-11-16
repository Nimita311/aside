import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceHost} from '../src/daemon/host.js';
import type {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {Store} from '../src/source/store.js';
import {handleUpdateInstance} from '../src/mcp/tools/instance.js';
import {beforeMutationWrite} from '../src/source/mutation-result.js';

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 30, 10));
  // Prove explicit mutation delivery without watcher or publication callbacks.
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(Store.prototype, 'onChange').mockImplementation(() => () => {});
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-partial-publication-'));
  const root = join(home, 'data'); mkdirSync(root);
  writeFileSync(join(root, 'aside.md'), '---\nid: partial-publication\n---\n');
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 5, retryMinMs: 10, retryMaxMs: 40, reconciliationIntervalMs: 0});
  const {store} = host.load(root);
  await vi.advanceTimersByTimeAsync(15);
  cleanups.push(async () => {await host.close(); rmSync(home, {recursive: true, force: true});});
  return {home, root, host, store, lifecycle: (host as any).sources as InstanceLifecycle};
}

describe('lifecycle repair after confirmed partial writes', () => {
  it('repairs a later unreflected effect even after an earlier effect published a different hash', async () => {
    const {home, root, host, store, lifecycle} = await fixture();
    await host.tool(root, 'create_artifact', {name: 'Files', description: 'Files'});
    await vi.advanceTimersByTimeAsync(5);
    const id = [...store.getArtifacts().keys()][0], source = join(home, 'incoming.txt');
    writeFileSync(source, 'Durably saved attachment');
    const previousHash = store.getSourceVersion(), previousRevision = store.getRevision();
    const perform = (host as any).performMutation.bind(host);
    vi.spyOn(host as any, 'performMutation').mockImplementationOnce((...args: any[]) => {
      // Deferred linked writes use this same journal. Publish one effect before
      // the attachment import, then fail the attachment's record readback.
      const release = beforeMutationWrite(store, () => handleUpdateInstance(store, {body: 'Earlier published effect'}));
      try {return perform(...args);} finally {release();}
    });
    vi.spyOn(store, 'saveArtifact').mockImplementationOnce(() => {throw new Error('Attachment record readback failed');});
    const invalidated = vi.spyOn(lifecycle, 'invalidate'), rebuild = vi.spyOn(store, 'rebuild');

    await expect(host.tool(root, 'update_artifact', {id, files: [{source, filename: 'saved.txt'}], body: 'Not saved'})).rejects.toMatchObject({
      name: 'MutationWriteError', partialResult: {status: 'PARTIAL', changes: [
        expect.objectContaining({kind: 'instance', effect: 'UPDATED'}),
        expect.objectContaining({kind: 'attachment', effect: 'CREATED'}),
      ]},
    });

    expect(store.getInstance()?.body).toBe('Earlier published effect');
    expect(store.getSourceVersion()).not.toBe(previousHash);
    expect(store.getRevision()).toBeGreaterThan(previousRevision);
    expect(store.getArtifact(id)?.frontMatter.attachments).toBeUndefined();
    expect(existsSync(join(root, 'artifacts', '2026', id, 'saved.txt'))).toBe(true);
    expect(invalidated).toHaveBeenCalledExactlyOnceWith(store);
    expect(rebuild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(rebuild).toHaveBeenCalledOnce();
    expect(store.getArtifact(id)?.frontMatter.attachments).toEqual(['saved.txt']);
    expect(readFileSync(store.getArtifactFile(id)!, 'utf8')).toContain('saved.txt');
  });

  it('also queues source repair for partial outcomes returned as warnings', async () => {
    const {root, host, store, lifecycle} = await fixture();
    await host.tool(root, 'create_artifact', {name: 'Files', description: 'Files'});
    await vi.advanceTimersByTimeAsync(5);
    const id = [...store.getArtifacts().keys()][0];
    // A missing index row reports a partial outcome without throwing, after
    // the record edit itself has already published its new loaded state.
    writeFileSync(join(root, 'artifacts', '2026', 'index.yaml'), '');
    lifecycle.refresh(store);
    await vi.advanceTimersByTimeAsync(5);
    const invalidated = vi.spyOn(lifecycle, 'invalidate'), rebuild = vi.spyOn(store, 'rebuild');

    const result = await host.tool(root, 'update_artifact', {id, body: 'Published record', description: 'Missing index row'});

    expect(result.text).toContain('description not saved');
    expect(store.getArtifact(id)?.body).toBe('Published record');
    expect(invalidated).toHaveBeenCalledExactlyOnceWith(store);
    expect(rebuild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(rebuild).toHaveBeenCalledOnce();
    expect(store.getArtifactIndex()).toEqual([]);
  });
});
