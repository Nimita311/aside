import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {lifecycleOperationsFixture} from './lifecycle-operations-fixture.js';
import {daemonSession} from './support/graphql-host.js';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Daemon} from '../src/daemon/daemon.js';
import {InstanceHost} from '../src/daemon/host.js';
import {daemonPaths} from '../src/daemon/paths.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession} from '../src/mcp/instance-session.js';
import * as managed from '../src/core/managed-path.js';
import * as sourceMetadata from '../src/core/source-metadata.js';
import * as bootstrap from '../src/source/bootstrap.js';

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function fixture(debounceMs = 60_000) {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-registry-owner-'));
  const path = join(home, 'data'); mkdirSync(path);
  writeFileSync(join(path, 'aside.md'), '---\nid: published\nname: Published name\n---\nLoaded body.\n');
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs, reconciliationIntervalMs: 0});
  const daemon = new Daemon({host, paths: daemonPaths({ASIDE_DAEMON_HOME: join(home, 'daemon')})});
  (daemon as any).known = [path];
  const {store} = host.load(path);
  const call = (method: string, params?: unknown) => (daemon as any).dispatch({}, method, params);
  cleanups.push(async () => {
    await (host as any).usageLog.flush(); await host.close();
    rmSync(home, {recursive: true, force: true});
  });
  return {home, path, host, store, daemon, call};
}

describe('published registry and browser source ownership', () => {
  it('does not admit or read unloaded content for static schema and system-only inspection', async () => {
    const f = fixture(), unloaded = join(f.home, 'unloaded'); mkdirSync(unloaded);
    writeFileSync(join(unloaded, 'aside.md'), '---\nid: unloaded\n---\n');
    const state = {workspace: [unloaded], encountered: [unloaded], active: unloaded,
      configIssues: [], discovery: false, cwd: f.home};
    const admit = vi.spyOn(f.host, 'observeInstances');
    const read = vi.spyOn(managed, 'readManagedText').mockImplementation(() => {throw new Error('Static inspection must not read source');});
    const inspect = vi.spyOn(sourceMetadata, 'readSourceMetadata').mockImplementation(() => {throw new Error('Static inspection must not scan source');});

    const schema = await f.call('graphql.schema', {session: state});
    const response = await f.call('graphql', {mode: 'query', session: state,
      args: {document: '{systemInfo{build{version}} __type(name:"Query"){name}}'}});

    expect(schema.result.sdl).toContain('type Query');
    expect(response.result.errors).toBeUndefined();
    expect(response.result.data.__type).toEqual({name: 'Query'});
    expect(response.session.active).toBe(unloaded);
    expect(f.host.isLoaded(unloaded)).toBe(false);
    expect(admit).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
  });

  it('does not schedule unrelated catalogue scans for malformed requests', async () => {
    const f = fixture();
    await (f.host as any).sources.flush();
    const read = vi.spyOn(managed, 'readManagedText').mockImplementation(() => {throw new Error('Validation failure must not read source');});
    const inspect = vi.spyOn(sourceMetadata, 'readSourceMetadata').mockImplementation(() => {throw new Error('Validation failure must not scan source');});
    const refresh = vi.spyOn(f.host, 'refreshIdentities');
    // Drive the outer error path, not only the dispatcher's validation.
    const daemon = f.daemon as any;
    await expect(daemon.handle({}, 'tool', {instance: f.path, name: 'create_artifact', args: {unexpected: true}})).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });

  it('does not inspect manifests or clear selection while serializing and executing loaded GraphQL sessions', async () => {
    const f = fixture(), registry = new InstanceRegistry([f.path]); registry.activate(f.path);
    const session = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [f.path], issues: async () => []}), [], false);
    const state = session.state();
    rmSync(join(f.path, 'aside.md')); mkdirSync(join(f.path, 'aside.md'));
    const read = vi.spyOn(managed, 'readManagedText').mockImplementation(() => {throw new Error('Loaded source must not be reread');});

    const response = await f.call('graphql', {mode: 'query', session: state,
      args: {document: '{activeInstance{id name body} instances{id name}}'}});

    expect(response.result.errors).toBeUndefined();
    expect(response.result.data).toEqual({activeInstance: {id: 'published', name: 'Published name', body: 'Loaded body.'},
      instances: [{id: 'published', name: 'Published name'}]});
    expect(response.session.active).toBe(f.path);
    const restored = new InstanceRegistry(); restored.restore(response.session);
    expect(restored.selection().active).toBe(f.path);
    expect(read).not.toHaveBeenCalled();
  });

  it('uses published catalogue, summary, and year observations until the source owner refreshes', async () => {
    const f = fixture(), before = f.host.summary(f.path);
    writeFileSync(join(f.path, 'aside.md'), '---\nid: newer\nname: Newer disk name\n---\n');
    mkdirSync(join(f.path, 'projects', '2099'), {recursive: true});
    const read = vi.spyOn(managed, 'readManagedText').mockImplementation(() => {throw new Error('Loaded source must not be reread');});
    const inspect = vi.spyOn(sourceMetadata, 'readSourceMetadata').mockImplementation(() => {throw new Error('Only lifecycle reads filesystem metadata');});

    expect(await f.call('instances')).toEqual([expect.objectContaining({path: f.path, id: 'published', name: 'Published name'})]);
    expect(f.host.years(f.path)).not.toContain('2099');
    expect(f.host.summary(f.path)).toBe(before);
    expect(read).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
    read.mockRestore(); inspect.mockRestore();
    (f.host as any).sources.refresh(f.store);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.host.years(f.path)).toContain('2099');
    expect(f.host.availableInstances([f.path])[0]).toMatchObject({id: 'newer', name: 'Newer disk name'});
  });

  it('retains selection when lifecycle observes a transient manifest read error', async () => {
    const f = fixture(5), registry = new InstanceRegistry([f.path]); registry.activate(f.path);
    const state = {...registry.selection(), configIssues: [], discovery: false, cwd: f.home};
    rmSync(join(f.path, 'aside.md')); mkdirSync(join(f.path, 'aside.md'));
    (f.host as any).sources.refresh(f.store);
    await vi.advanceTimersByTimeAsync(5);
    expect(f.store.getIssues()).toContainEqual(expect.objectContaining({code: 'read_error', file: 'aside.md'}));
    expect(f.host.availableInstances([f.path])).toEqual([]);

    const response = await f.call('graphql', {mode: 'query', session: state, args: {document: '{instances{path}}'}});

    expect(response.result.errors).toBeUndefined();
    expect(response.result.data).toEqual({instances: []});
    expect(response.session.active).toBe(f.path);
    expect(response.session.encountered).toContain(f.path);
  });

  it('reports instance labels from daemon metadata without reopening loaded manifests', async () => {
    const f = fixture();
    writeFileSync(join(f.path, 'aside.md'), '---\nid: newer\nname: Newer disk name\n---\n');
    const read = vi.spyOn(managed, 'readManagedText').mockImplementation(() => {throw new Error('Loaded labels must not reopen manifests');});

    const {result} = await f.call('graphql', {mode: 'query', session: daemonSession(f.path), args: {document: '{activeInstance{name} instances{name}}'}});

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({activeInstance: {name: 'Published name'}, instances: [{name: 'Published name'}]});
    expect(JSON.stringify(result)).not.toContain('Newer disk name');
    expect(read).not.toHaveBeenCalled();
  });

  it('refreshes an existing owner after explicit creation reuses its directory', async () => {
    const f = fixture();
    rmSync(f.path, {recursive: true}); mkdirSync(f.path);
    const rebuild = vi.spyOn(f.store, 'rebuild');

    const {result} = await f.call('graphql', {mode: 'mutation', session: daemonSession(f.path), args: {
      document: 'mutation($input:CreateInstanceInput!){createInstance(input:$input){error instance{name}}}',
      variables: {input: {path: f.path, name: 'Recreated', description: 'A new explicit bootstrap'}},
    }});

    expect(result.errors).toBeUndefined();
    expect(result.data.createInstance).toEqual({error: null, instance: {name: 'Recreated'}});
    expect(f.store.getManifest().name).toBe('Recreated');
    expect(rebuild).toHaveBeenCalledOnce();
  });

  it.each([true, false])('notifies an already owned partial bootstrap without activating new roots (owned: %s)', async owned => {
    const f = fixture(), path = owned ? f.path : join(f.home, 'partial');
    if (owned) rmSync(path, {recursive: true});
    mkdirSync(path);
    vi.spyOn(bootstrap, 'init').mockImplementationOnce((directory, _options, created) => {
      writeFileSync(join(directory, 'aside.md'), '---\nid: partial-bootstrap\nname: Partial bootstrap\n---\n');
      created?.('aside.md'); throw new Error('Interrupted after manifest persistence');
    });
    const notify = vi.spyOn(f.host, 'created');
    const instanceRecord = vi.spyOn(f.host, 'metadata');

    const {result, session} = await f.call('graphql', {mode: 'mutation', session: daemonSession(f.path), args: {
      document: 'mutation($input:CreateInstanceInput!){createInstance(input:$input){error}}',
      variables: {input: {path, name: 'Partial bootstrap', description: 'Incomplete'}},
    }});

    expect(result.data.createInstance.error).toContain('Interrupted after manifest persistence');
    expect(notify).toHaveBeenCalledExactlyOnceWith(path, {partial: true});
    expect(instanceRecord).not.toHaveBeenCalled();
    expect(session.active).toBe(f.path);
    expect(f.host.loadedPaths()).toEqual([f.path]);
    if (owned) expect(f.store.getManifest().id).toBe('partial-bootstrap');
    else expect((await f.call('instances')).some((row: {path: string}) => row.path === path)).toBe(false);
  });
});
