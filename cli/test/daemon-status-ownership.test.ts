import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Daemon} from '../src/daemon/daemon.js';
import {InstanceHost} from '../src/daemon/host.js';
import {daemonPaths, ensureDirs} from '../src/daemon/paths.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
});
afterEach(async () => {
  access.reset();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-status-owner-')), root = join(home, 'source');
  mkdirSync(root); writeFileSync(join(root, 'aside.md'), '---\nid: published\nname: Published\n---\n');
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
  const paths = daemonPaths({ASIDE_DAEMON_HOME: join(home, 'daemon')}); ensureDirs(paths);
  const daemon = new Daemon({host, paths}); (daemon as any).known = [root];
  const {store} = host.load(root);
  (daemon as any).connections.set({}, new Set([root]));
  const status = () => (daemon as any).dispatch({}, 'status', undefined);
  const prune = vi.spyOn(daemon as any, 'pruneKnown'), identities = vi.spyOn(host, 'refreshIdentities');
  const rebuild = vi.spyOn(store, 'rebuild'), refresh = vi.spyOn((host as any).sources, 'refresh');
  const collect = vi.spyOn(daemon as any, 'collectSemanticCaches');
  cleanup.push(async () => {
    await (daemon as any).cacheWork; await host.close(); rmSync(home, {recursive: true, force: true});
  });
  return {root, daemon, status, prune, identities, rebuild, refresh, collect};
}

describe('daemon status lifecycle ownership', () => {
  it('reports published instances and session counts without probing or maintaining source', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'aside.md'), 'Repurposed by an unobserved edit.');
    access.protect([f.root]);

    expect(await f.status()).toMatchObject({known: [f.root], loaded: [f.root], sessions: {[f.root]: 1}, connections: 1});

    expect(f.prune).not.toHaveBeenCalled(); expect(f.identities).not.toHaveBeenCalled();
    expect(f.rebuild).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
    expect(f.collect).not.toHaveBeenCalled(); expect(access.violations).toEqual([]);
  });

  it('publishes removals only after owner reconciliation and keeps status source-free afterward', async () => {
    const f = fixture(); rmSync(f.root, {recursive: true}); access.protect([f.root]);
    expect(await f.status()).toMatchObject({known: [f.root], loaded: [f.root], sessions: {[f.root]: 1}});
    expect(f.prune).not.toHaveBeenCalled(); expect(access.violations).toEqual([]);

    access.reset(); (f.daemon as any).reconcileKnown(); access.protect([f.root]);
    expect(await f.status()).toMatchObject({known: [], loaded: [], sessions: {}});
    expect(f.prune).toHaveBeenCalledOnce(); expect(access.violations).toEqual([]);
  });
});
