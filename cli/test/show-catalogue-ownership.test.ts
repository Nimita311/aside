import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Daemon} from '../src/daemon/daemon.js';
import {InstanceHost} from '../src/daemon/host.js';
import {daemonPaths} from '../src/daemon/paths.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {Store} from '../src/source/store.js';
import {init} from '../src/source/bootstrap.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-show-catalogue-'));
  const known = join(home, 'known'), candidate = join(home, 'candidate');
  init(known, {name: 'Known', description: 'Loaded owner'});
  init(candidate, {name: 'Candidate', description: 'Passive candidate'});
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
  const daemon = new Daemon({host, paths: daemonPaths({ASIDE_DAEMON_HOME: join(home, 'daemon')})});
  (daemon as any).known = [known];
  const {store} = host.load(known);
  const call = (params?: unknown) => (daemon as any).dispatch({}, 'instances', params);
  cleanup.push(async () => {await host.close(); rmSync(home, {recursive: true, force: true});});
  return {home, known, candidate, host, store, daemon, call};
}

describe('show owner catalogue admission', () => {
  it('observes requested candidates without registering or activating them and preserves loaded observations', async () => {
    const f = fixture(), load = vi.spyOn(f.host, 'load');
    const knownId = f.store.getManifest().id;
    writeFileSync(join(f.known, 'aside.md'), '---\nid: unobserved\nname: Unobserved disk name\n---\n');

    const result = await f.call({paths: [f.candidate, f.candidate]});

    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({path: f.candidate, name: 'Candidate'}),
      expect.objectContaining({path: f.known, id: knownId, name: 'Known'}),
    ]));
    expect(load).not.toHaveBeenCalled();
    expect(f.host.loadedPaths()).toEqual([f.known]);
    expect((f.daemon as any).known).toEqual([f.known]);
    expect(await f.call()).toEqual([expect.objectContaining({path: f.known, id: knownId, name: 'Known'})]);
  });

  it.each([{unexpected: true}, {paths: 'not-an-array'}, {paths: [42]}, {paths: ['relative']}, {paths: ['']}])(
    'rejects invalid candidate requests before observing source: %j', async params => {
      const f = fixture(), observe = vi.spyOn(f.host, 'observeInstances');
      await expect(f.call(params)).rejects.toThrow();
      expect(observe).not.toHaveBeenCalled();
    });
});
