import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceHost} from '../src/daemon/host.js';
import {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession} from '../src/mcp/instance-session.js';
import {runArtifact} from '../src/commands/artifact.js';
import {hostGraphQL} from './support/graphql-host.js';

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 30, 10));
  // These tests prove explicit daemon event delivery without filesystem or
  // Store publication notifications rescuing an omitted interface hook.
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(Store.prototype, 'onChange').mockImplementation(() => () => {});
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-daemon-lifecycle-events-'));
  const root = join(home, 'data'); mkdirSync(root);
  writeFileSync(join(root, 'aside.md'), '---\nid: daemon-events\nname: Daemon events\n---\n');
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 5, retryMinMs: 10, retryMaxMs: 40, reconciliationIntervalMs: 0});
  const loaded = host.load(root);
  const lifecycle: InstanceLifecycle = (host as any).sources;
  const observed = vi.fn((store: Store) => store.getSourceVersion());
  lifecycle.addFeature('event-test', {changed: observed});
  await vi.advanceTimersByTimeAsync(15); observed.mockClear();
  const mutated = vi.spyOn(lifecycle, 'mutated'), rebuild = vi.spyOn(loaded.store, 'rebuild');
  cleanups.push(async () => {await host.close(); rmSync(home, {recursive: true, force: true});});
  return {home, root, host, store: loaded.store, lifecycle, observed, mutated, rebuild};
}

describe('shared daemon mutation event delivery', () => {
  it('notifies lifecycle features for artifact tool writes without watcher or Store events', async () => {
    const f = await fixture(), version = f.store.getSourceVersion();
    await f.host.tool(f.root, 'create_artifact', {name: 'Tool save', description: 'Saved', body: 'Tool content'});
    expect(f.mutated).toHaveBeenCalledExactlyOnceWith(f.store, version);
    expect(f.rebuild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(f.observed).toHaveBeenCalledOnce();
    expect(f.store.getArtifact([...f.store.getArtifacts().keys()][0])!.body).toBe('Tool content');
  });

  it('notifies lifecycle features through GraphQL execution while leaving successful source writes loaded', async () => {
    const f = await fixture(), version = f.store.getSourceVersion();
    const registry = new InstanceRegistry([f.root]); registry.activate(f.root);
    const session = new InstanceSession(registry, {knownInstances: async () => [f.root], issues: async () => []}, [], false, f.root);
    const result = await f.host.graphql(session, 'mutation', {
      document: 'mutation{capture(input:{content:"GraphQL save",description:"Saved"}){entry{content} error}}',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data!.capture).toEqual({entry: {content: 'GraphQL save'}, error: null});
    expect(f.mutated).toHaveBeenCalledWith(f.store, version);
    expect(f.mutated.mock.calls.every(([store]) => store === f.store)).toBe(true);
    expect(f.rebuild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(f.observed).toHaveBeenCalledOnce();
    expect(f.store.getEntries()[0].content).toBe('GraphQL save');
  });

  it('rebases adopted manifest identity through the owner even when the requested write is a no-op', async () => {
    const f = await fixture(), oldHistoryFile = (f.store as any).recurrenceHistoryFile;
    const file = join(f.root, 'aside.md');
    const external = '---\nid: adopted-events\nname: Daemon events\n---\n\n';
    writeFileSync(file, external);

    const result = JSON.parse((await hostGraphQL(f.host, f.root, 'mutate', {document: 'mutation{updateInstance(input:{body:""}){error}}'})).text);
    expect(result.errors).toBeUndefined();

    expect(readFileSync(file, 'utf8')).toBe(external);
    expect(f.mutated).not.toHaveBeenCalled();
    expect(f.rebuild).toHaveBeenCalledOnce();
    expect(f.store.getManifest().id).toBe('adopted-events');
    expect((f.store as any).recurrenceHistoryFile).not.toBe(oldHistoryFile);
    expect(() => f.store.assertRecurrenceChange('future-template', [])).not.toThrow();
    expect(f.store.getIssues().some(issue => issue.code === 'rebuild_failed')).toBe(false);
  });

  it('shares lifecycle delivery with CLI artifact writes without making diagnostic queries scan source', async () => {
    const f = await fixture();
    const execute = (instance: string, name: string, args: unknown) => f.host.tool(instance, name, args);
    await runArtifact(['create', '--dir', f.root, '--name', 'CLI artifact', '--description', 'Saved', '--body', 'CLI content'], f.root, execute);
    expect(f.mutated).toHaveBeenCalledOnce();
    expect(f.rebuild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(f.observed).toHaveBeenCalledOnce();
    const artifact = [...f.store.getArtifacts().keys()][0], path = f.store.getArtifactFile(artifact)!;
    writeFileSync(path, readFileSync(path, 'utf8').replace('CLI content', 'Unobserved external content'));
    await runArtifact(['query', '--dir', f.root, '--json'], f.root, execute);
    await hostGraphQL(f.host, f.root, 'query', {document: '{activeInstance{id body}}'});
    expect(f.store.getArtifact(artifact)!.body).toBe('CLI content');
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.mutated).toHaveBeenCalledOnce();
  });

  it.each(['unpublished', 'unchanged'] as const)('repairs a durable attachment write with an %s loaded hash after failure', async state => {
    const f = await fixture();
    await f.host.tool(f.root, 'create_artifact', {name: 'Files', description: 'Files'});
    await vi.advanceTimersByTimeAsync(5);
    f.mutated.mockClear(); f.observed.mockClear(); f.rebuild.mockClear();
    const id = [...f.store.getArtifacts().keys()][0], source = join(f.home, 'incoming.txt');
    writeFileSync(source, 'Durable attachment');
    if (state === 'unpublished') {
      vi.spyOn(f.store, 'refreshArtifactAttachments').mockImplementationOnce(() => {
        (f.store as any).invalidateSnapshots();
        throw new Error('Attachment readback unavailable');
      });
    } else {
      // The file import persists before the record write starts. A failure
      // there leaves the old published hash valid but requires owner repair.
      vi.spyOn(f.store, 'saveArtifact').mockImplementationOnce(() => {throw new Error('Record write unavailable');});
    }
    await expect(f.host.tool(f.root, 'update_artifact', {id, files: [{source, filename: 'saved.txt'}],
      ...(state === 'unchanged' ? {body: 'Never saved'} : {})}, true)).rejects.toMatchObject({
      name: 'MutationWriteError', partialResult: {status: 'PARTIAL', changes: [expect.objectContaining({kind: 'attachment', effect: 'CREATED'})]},
    });
    expect(existsSync(join(f.root, 'artifacts', '2026', id, 'saved.txt'))).toBe(true);
    expect(f.mutated).toHaveBeenCalledOnce();
    expect(f.rebuild).not.toHaveBeenCalled();
    if (state === 'unpublished') expect(f.store.getIssues().some(issue => issue.code === 'rebuild_failed')).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.rebuild).toHaveBeenCalledOnce();
    expect(f.store.getArtifact(id)!.frontMatter.attachments).toEqual(['saved.txt']);
    expect(f.store.getIssues().some(issue => issue.code === 'rebuild_failed')).toBe(false);
    expect(f.observed).toHaveBeenCalledOnce();
  });
});
