import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInit} from '../src/commands/init.js';
import * as bootstrap from '../src/source/bootstrap.js';
import * as client from '../src/daemon/client.js';
import {Daemon} from '../src/daemon/daemon.js';
import {InstanceHost} from '../src/daemon/host.js';
import {FileLock} from '../src/daemon/filelock.js';
import {daemonPaths, ensureDirs} from '../src/daemon/paths.js';
import {ownHello} from '../src/daemon/protocol.js';
import {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import {bootstrapInstanceSource} from '../src/daemon/instance-operations.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';

const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(Store.prototype, 'onChange').mockImplementation(() => () => {});
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-cli-bootstrap-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const paths = daemonPaths({ASIDE_DAEMON_HOME: join(home, 'daemon')});
  vi.stubEnv('ASIDE_DAEMON_HOME', paths.state);
  return {home, paths, path: join(home, 'source')};
}
function args(path: string) {return ['--dir', path, '--name', 'Recreated', '--description', 'Bootstrap test', '--json'];}

async function ownerFixture() {
  const f = fixture(); bootstrap.init(f.path, {name: 'Previous', description: 'Old instance'});
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
  const daemon = new Daemon({paths: f.paths, host});
  (daemon as any).known = [f.path];
  const {store} = host.load(f.path), lifecycle: InstanceLifecycle = (host as any).sources;
  cleanup.push(() => host.close());
  await lifecycle.flush();
  const observed = vi.fn(); lifecycle.addFeature('bootstrap-test', {changed: observed, reconcile: observed});
  const rebuild = vi.spyOn(store, 'rebuild');
  const request = vi.fn(async (method: string, params?: unknown) => (daemon as any).dispatch({}, method, params));
  const close = vi.fn();
  vi.spyOn(client, 'tryConnect').mockResolvedValue({peer: {request, close, onClose: vi.fn()}, hello: {...ownHello(), pid: process.pid}} as unknown as client.Connection);
  return {...f, host, daemon, store, lifecycle, observed, rebuild, request, close};
}

describe('CLI bootstrap source ownership', () => {
  it('bootstraps offline without starting a daemon or registering the new instance', async () => {
    const f = fixture(); vi.spyOn(client, 'tryConnect').mockResolvedValue(null);
    await runInit(args(f.path));
    expect(readFileSync(join(f.path, 'aside.md'), 'utf8')).toContain('name: Recreated');
    expect(existsSync(f.paths.known)).toBe(false); expect(existsSync(f.paths.socket)).toBe(false);
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({
      command: 'instance init', ok: true, data: {dataDir: f.path, created: ['aside.md']},
    });
  });

  it('sends bootstrap to an existing owner without locally reading or writing source', async () => {
    const f = fixture(), close = vi.fn();
    const request = vi.fn(async () => ({dataDir: f.path, created: ['aside.md']}));
    vi.spyOn(client, 'tryConnect').mockResolvedValue({peer: {request, close, onClose: vi.fn()}, hello: {...ownHello(), pid: process.pid}} as unknown as client.Connection);
    const init = vi.spyOn(bootstrap, 'init').mockImplementation(() => {throw new Error('CLI must not initialize files beside its owner');});
    await runInit(args(f.path));
    expect(request).toHaveBeenCalledExactlyOnceWith('instance.bootstrap', {input: {
      path: f.path, name: 'Recreated', description: 'Bootstrap test', body: undefined, tutorial: false,
    }});
    expect(init).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce(); expect(existsSync(f.path)).toBe(false);
  });

  it('releases its admission lock before settling an owner found during startup', async () => {
    const f = fixture(), close = vi.fn();
    const request = vi.fn(async () => ({dataDir: f.path, created: ['aside.md']}));
    const connection = {peer: {request, close, onClose: vi.fn()}, hello: {...ownHello(), pid: process.pid}} as unknown as client.Connection;
    vi.spyOn(client, 'tryConnect').mockResolvedValueOnce(null).mockResolvedValueOnce(connection);
    const prototype = client.DaemonClient.prototype as unknown as {settle(connection: client.Connection): Promise<client.Connection>};
    const settle = prototype.settle;
    const settled = vi.spyOn(prototype, 'settle').mockImplementation(function(this: client.DaemonClient, connection) {
      const lock = new FileLock(f.paths.startLock);
      expect(lock.tryAcquire()).toBe(true); lock.release();
      return settle.call(this, connection);
    });
    await runInit(args(f.path));
    expect(settled).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });

  it('publishes reinitialization through lifecycle without watcher events or registration changes', async () => {
    const f = await ownerFixture();
    rmSync(f.path, {recursive: true}); mkdirSync(f.path);
    await runInit(args(f.path));
    expect(f.store.getManifest().name).toBe('Recreated'); expect(f.rebuild).toHaveBeenCalledOnce();
    await f.lifecycle.flush();
    expect(f.observed).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
    expect((f.daemon as any).known).toEqual([f.path]); expect((f.daemon as any).connections.size).toBe(0);
  });

  it('publishes durable partial initialization before returning its original error', async () => {
    const f = await ownerFixture();
    rmSync(f.path, {recursive: true}); mkdirSync(f.path);
    vi.spyOn(bootstrap, 'init').mockImplementationOnce((path, _options, created) => {
      writeFileSync(join(path, 'aside.md'), '---\nid: partial\nname: Partial\n---\n');
      created?.('aside.md'); throw new Error('Tutorial interrupted after saving the manifest');
    });
    await expect(runInit(args(f.path))).rejects.toThrow('Tutorial interrupted after saving the manifest');
    expect(f.store.getManifest().id).toBe('partial'); expect(f.rebuild).toHaveBeenCalledOnce();
    await f.lifecycle.flush();
    expect(f.observed).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
    expect((f.daemon as any).known).toEqual([f.path]);
  });

  it('leaves new paths unloaded and unregistered when the owner performs bootstrap', async () => {
    const f = await ownerFixture(), path = join(f.home, 'new');
    await runInit(args(path));
    expect(f.host.isLoaded(path)).toBe(false); expect((f.daemon as any).known).toEqual([f.path]);
    expect(f.host.metadata(path).value.manifest.name).toBe('Recreated');
    expect(f.host.availableInstances([path])).toEqual([expect.objectContaining({path, name: 'Recreated'})]);
  });

  it('refuses offline writes while an unreachable daemon owns its lifetime lock', async () => {
    const f = fixture(); ensureDirs(f.paths);
    const lock = new FileLock(f.paths.lifetimeLock); expect(lock.tryAcquire()).toBe(true); cleanup.push(() => lock.release());
    vi.spyOn(client, 'tryConnect').mockResolvedValue(null);
    await expect(runInit(args(f.path))).rejects.toThrow('daemon is starting, stopping, or unavailable');
    expect(existsSync(f.path)).toBe(false);
  });

  it('validates bootstrap RPC inputs before writing source', async () => {
    const f = await ownerFixture(), dispatch = (params: unknown) => (f.daemon as any).dispatch({}, 'instance.bootstrap', params);
    await expect(dispatch({input: {path: 'relative', name: 'New', description: 'New'}})).rejects.toThrow('absolute');
    await expect(dispatch({input: {path: join(f.home, 'bad'), name: 'New', description: 'New', extra: true}})).rejects.toThrow();
    expect(f.rebuild).not.toHaveBeenCalled(); expect(existsSync(join(f.home, 'bad'))).toBe(false);
  });

  it('reports saved files clearly when their lifecycle publication fails', () => {
    const f = fixture();
    expect(() => bootstrapInstanceSource({path: f.path, name: 'Saved', description: 'Saved instance'}, () => {
      throw new Error('Source readback temporarily unavailable');
    })).toThrow('Instance files created; loaded source repair is pending: Source readback temporarily unavailable');
    expect(readFileSync(join(f.path, 'aside.md'), 'utf8')).toContain('name: Saved');
  });
});
