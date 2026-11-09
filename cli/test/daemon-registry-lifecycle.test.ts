import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Daemon} from '../src/daemon/daemon.js';
import {InstanceHost} from '../src/daemon/host.js';
import {daemonPaths} from '../src/daemon/paths.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';

let daemon: Daemon | undefined;
let home: string;
beforeEach(() => {
  // Keep socket/filesystem I/O real while advancing background polling alone.
  vi.useFakeTimers({toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']});
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  home = realpathSync(mkdtempSync('/private/tmp/aside-registry-lifecycle-'));
});
afterEach(async () => {
  await daemon?.shutdown(); daemon = undefined;
  vi.restoreAllMocks(); vi.useRealTimers();
  rmSync(home, {recursive: true, force: true});
});

describe('daemon registration reconciliation', () => {
  it('isolates a failed registry write and retries pruning on the next background check', async () => {
    const paths = daemonPaths({ASIDE_DAEMON_HOME: join(home, 'daemon')});
    mkdirSync(paths.state, {recursive: true});
    const root = join(home, 'data'); mkdirSync(root);
    writeFileSync(join(root, 'aside.md'), '---\nid: registry-retry\nname: Registry retry\n---\n');
    writeFileSync(paths.known, JSON.stringify([root]));
    const host = new InstanceHost(new CalClient(null));
    vi.spyOn(host, 'configureSemantic').mockImplementation(() => {});
    daemon = new Daemon({paths, host, webPort: 0});
    expect(await daemon.listen()).toBe(true);
    expect(host.loadedPaths()).toEqual([root]);

    rmSync(root, {recursive: true});
    const temporary = `${paths.known}.${process.pid}.tmp`;
    mkdirSync(temporary); // Registry persistence now fails deterministically.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([root]);

    rmSync(temporary, {recursive: true});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([]);
    expect(host.loadedPaths()).toEqual([]);
  });

  it('keeps failed-load retries bounded when pruning cannot persist and recovers after repair', async () => {
    const paths = daemonPaths({ASIDE_DAEMON_HOME: join(home, 'daemon')});
    mkdirSync(paths.state, {recursive: true});
    const root = join(home, 'data'); mkdirSync(root);
    writeFileSync(join(root, 'aside.md'), '---\nid: registry-retry\nname: Registry retry\n---\n');
    writeFileSync(paths.known, JSON.stringify([root]));
    const host = new InstanceHost(new CalClient(null));
    vi.spyOn(host, 'configureSemantic').mockImplementation(() => {});
    const load = vi.spyOn(host, 'load').mockImplementation(() => {throw new Error('Instance temporarily unavailable');});
    daemon = new Daemon({paths, host, webPort: 0});
    expect(await daemon.listen()).toBe(true);
    expect(load).toHaveBeenCalledOnce();

    rmSync(root, {recursive: true});
    const temporary = `${paths.known}.${process.pid}.tmp`;
    mkdirSync(temporary);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([root]);
    expect(load).toHaveBeenCalledOnce();

    rmSync(temporary, {recursive: true});
    await vi.advanceTimersByTimeAsync(1_999);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([root]);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([]);
    expect(load).toHaveBeenCalledOnce();
  });
});
