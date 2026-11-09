import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as clientModule from '../src/daemon/client.js';
import {DaemonClient} from '../src/daemon/client.js';
import {Daemon, writeKnown} from '../src/daemon/daemon.js';
import {InstanceHost} from '../src/daemon/host.js';
import {daemonPaths, ensureDirs} from '../src/daemon/paths.js';
import {ownHello} from '../src/daemon/protocol.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {Store} from '../src/source/store.js';
import {runArtifact} from '../src/commands/artifact.js';
import {collectAfterFailedUse} from '../src/commands/instance-gc.js';
import {InstancePathError} from '../src/core/instance.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  access.reset();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-failed-use-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const root = join(home, 'source'); mkdirSync(root);
  writeFileSync(join(root, 'aside.md'), '---\nid: failed-use\nname: Published\n---\n');
  const paths = daemonPaths({ASIDE_DAEMON_HOME: join(home, 'state')}); ensureDirs(paths);
  writeKnown(paths, [root]);
  vi.stubEnv('ASIDE_DAEMON_HOME', paths.state);
  return {home, root, paths};
}

describe('failed CLI admission lifecycle notification', () => {
  it('requests explicit owner reconciliation without using status or reading source', async () => {
    const f = fixture(), request = vi.fn(async () => ({})), close = vi.fn();
    vi.spyOn(clientModule, 'tryConnect').mockResolvedValue({peer: {request, close, onClose: vi.fn()}, hello: {...ownHello(), pid: process.pid}} as unknown as clientModule.Connection);
    access.protect([f.root]);

    await collectAfterFailedUse();

    expect(request).toHaveBeenCalledExactlyOnceWith('registry.reconcile', undefined);
    expect(close).toHaveBeenCalledOnce(); expect(access.violations).toEqual([]);
  });

  it('notifies a running owner even when its saved registry file has disappeared', async () => {
    const f = fixture(), request = vi.fn(async () => ({})), close = vi.fn();
    rmSync(f.paths.known);
    vi.spyOn(clientModule, 'tryConnect').mockResolvedValue({peer: {request, close, onClose: vi.fn()}, hello: {...ownHello(), pid: process.pid}} as unknown as clientModule.Connection);
    access.protect([f.root]);

    await collectAfterFailedUse();

    expect(request).toHaveBeenCalledExactlyOnceWith('registry.reconcile', undefined);
    expect(close).toHaveBeenCalledOnce(); expect(access.violations).toEqual([]);
  });

  it('delivers a local admission failure to the live owner while status remains a published read', async () => {
    const f = fixture(); vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    const host = new InstanceHost(new CalClient(null));
    host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
    const daemon = new Daemon({paths: f.paths, host, webPort: 0});
    cleanup.push(() => daemon.shutdown());
    expect(await daemon.listen()).toBe(true);
    const client = new DaemonClient({paths: f.paths, launcher: async () => {throw new Error('The test owner must already be running.');}});
    cleanup.push(() => client.close());
    const reconcile = vi.spyOn(daemon as any, 'reconcileKnown');
    const execute = vi.fn(async () => ({text: 'must not execute'}));
    rmSync(join(f.root, 'aside.md'));
    access.protect([f.root]);
    expect(await client.request('status', undefined, {read: true})).toMatchObject({known: [f.root], loaded: [f.root]});
    expect(reconcile).not.toHaveBeenCalled(); expect(access.violations).toEqual([]);

    access.reset();
    await expect(runArtifact(['query', '--dir', f.root], f.home, execute)).rejects.toBeInstanceOf(InstancePathError);
    await collectAfterFailedUse();

    expect(execute).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([]);
    access.protect([f.root]);
    expect(await client.request('status', undefined, {read: true})).toMatchObject({known: [], loaded: []});
    expect(reconcile).toHaveBeenCalledOnce(); expect(access.violations).toEqual([]);
  });
});
