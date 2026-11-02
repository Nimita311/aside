import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDaemon } from '../src/commands/daemon.js';
import { runInstance } from '../src/commands/instance.js';
import { init } from '../src/commands/init.js';
import { Daemon, writeKnown } from '../src/daemon/daemon.js';
import { FileLock, isLocked } from '../src/daemon/filelock.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import type { HelloResult, Status } from '../src/daemon/protocol.js';
import * as client from '../src/daemon/client.js';
import * as pathFunctions from '../src/daemon/paths.js';
import * as login from '../src/daemon/launchd.js';

describe('shared daemon commands', () => {
  let home: string;
  let daemons: Daemon[];
  beforeEach(() => {
    home = realpathSync(mkdtempSync('/tmp/aside-command-'));
    daemons = [];
    vi.stubEnv('ASIDE_DAEMON_HOME', home);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const daemon of daemons) await daemon.shutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function instance(name: string): string {
    const dir = join(home, name);
    init(dir, { name, description: `${name} instance` });
    return dir;
  }

  it('start reuses the daemon that syncs all known instances and keeps later additions loaded', async () => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one'), two = instance('two');
    writeKnown(paths, [one]);
    const host = new InstanceHost(new CalClient(null));
    const daemon = new Daemon({ paths, webPort: 0, host });
    daemons.push(daemon);
    expect(await daemon.listen()).toBe(true);
    expect(host.isLoaded(one)).toBe(true);
    await runDaemon(['start']);
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('Reused running daemon'));
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('no replacement'));
    expect(host.isLoaded(one)).toBe(true);
    await runInstance(['add', `--dir=${two}`]);
    expect(host.isLoaded(two)).toBe(true);
    await runDaemon(['status']);
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('two (loaded)'));
  });

  it.each([false, true])('reports reuse in JSON without obsolete lifecycle fields (legacy status: %s)', async legacy => {
    const paths = pathFunctions.daemonPaths();
    const daemon = new Daemon({ paths, webPort: 0, host: new InstanceHost(new CalClient(null)) });
    daemons.push(daemon);
    expect(await daemon.listen()).toBe(true);
    if (legacy) {
      const source = daemon as unknown as { status(): Status };
      const status = source.status.bind(source);
      vi.spyOn(source, 'status').mockImplementation(() => ({ ...status(), longRunning: false, selection: { all: false, paths: [] } }));
    }
    await runDaemon(['start', '--json']);
    const output = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
    expect(output).toMatchObject({ command: 'daemon start', ok: true, data: {
      action: 'reused', pid: process.pid,
    } });
    expect(output.data).not.toHaveProperty('previousPid');
    expect(output.data).not.toHaveProperty('longRunning');
    expect(output.data).not.toHaveProperty('selection');
    expect(output.data).toMatchObject({ connections: 1, tabs: 0, known: [], loaded: [], sessions: {} });
  });

  it('shows model discovery warnings under their automation without adding them to script siblings', async () => {
    vi.spyOn(client, 'tryConnect').mockResolvedValue({ peer: {
      request: vi.fn(async () => ({ jobs: [
        { key: 'agent-job', root: '/instance', definedIn: 'instance work', running: false, next: '2099-01-01T00:00Z' },
        { key: 'script-job', root: '/instance', definedIn: 'instance work', running: false, next: '2099-01-01T00:00Z' },
      ], runs: [], modelWarnings: [{ key: 'agent-job', root: '/instance', definedIn: 'instance work', message: 'Selected model is unavailable' }] })),
      close: vi.fn(),
    } } as any);
    await runDaemon(['automations']);
    const output = vi.mocked(console.log).mock.calls.at(-1)![0] as string;
    expect(output).toContain('agent-job\n  next: 2099-01-01T00:00Z\n  warning: Selected model is unavailable');
    expect(output).toContain('script-job\n  next: 2099-01-01T00:00Z\n2 automation(s).');
  });

  it.runIf(process.platform === 'darwin').each([false, true])('install saves the shared login job without instance arguments (json: %s)', async json => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one'), two = instance('two');
    writeKnown(paths, [one, two]);
    const host = new InstanceHost(new CalClient(null));
    vi.spyOn(login, 'loadJob').mockImplementation(async target => {
      const daemon = new Daemon({ paths: target, webPort: 0, host });
      daemons.push(daemon);
      expect(await daemon.listen()).toBe(true);
      const source = daemon as unknown as { hello(): HelloResult };
      const hello = source.hello.bind(source);
      vi.spyOn(source, 'hello').mockImplementation(() => ({ ...hello(), longRunning: true, selection: { all: true, paths: [] } }));
    });
    await runDaemon(['install', ...(json ? ['--json'] : [])]);
    expect(login.readJob(paths)!.program.slice(2)).toEqual(['daemon', 'start', '--foreground']);
    expect(host.loadedPaths().sort()).toEqual([one, two].sort());
    if (json) {
      const output = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0]);
      expect(output.data.daemon).toMatchObject({ pid: process.pid });
      expect(output.data.daemon).not.toHaveProperty('longRunning');
      expect(output.data.daemon).not.toHaveProperty('selection');
    } else expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('Daemon is running'));
  });

  it.each(['add', 'forget'])('%s reaches a daemon that started while waiting for the startup gate', async operation => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one'), two = instance('two'), three = instance('three');
    writeKnown(paths, operation === 'add' ? [one] : [one, two]);
    const gate = new FileLock(paths.startLock);
    expect(gate.tryAcquire()).toBe(true);
    // Observe the first failed connection before starting the competing
    // daemon; the command is then blocked by that launcher's real start lock.
    let checked!: () => void;
    const firstCheck = new Promise<void>(resolve => { checked = resolve; });
    const realConnect = client.tryConnect;
    vi.spyOn(client, 'tryConnect').mockImplementationOnce(async target => {
      const result = await realConnect(target);
      expect(result).toBeNull();
      checked();
      return result;
    });
    const edit = runInstance([operation, '--dir', two]);
    let running: Awaited<ReturnType<typeof client.tryConnect>>;
    try {
      await firstCheck;
      const daemon = new Daemon({ paths, webPort: 0, host: new InstanceHost(new CalClient(null)) });
      daemons.push(daemon);
      expect(await daemon.listen()).toBe(true);
      gate.release();
      await edit;
      running = await client.tryConnect(paths);
      expect(running).not.toBeNull();
      const expected = operation === 'add' ? [one, two] : [one];
      expect((await running!.peer.request<Status>('status')).known).toEqual(expected);
      expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual(expected);
      // The next daemon-owned write must neither lose an addition nor
      // resurrect a forgotten instance from its stale in-memory catalogue.
      await running!.peer.request('known.add', { paths: [three] });
      expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([...expected, three]);
    } finally {
      gate.release();
      running?.peer.close();
      await edit.catch(() => {});
    }
  });

  it.each(['add', 'forget'])('%s leaves the registry untouched when the lifetime lock is held without a reachable daemon', async operation => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one'), two = instance('two');
    writeKnown(paths, [one, two]);
    const before = readFileSync(paths.known, 'utf8');
    const lifetime = new FileLock(paths.lifetimeLock);
    expect(lifetime.tryAcquire()).toBe(true);
    try {
      await expect(runInstance([operation, '--dir', two])).rejects.toThrow(/No changes were made.*Retry/);
      expect(readFileSync(paths.known, 'utf8')).toBe(before);
      expect(isLocked(paths.startLock)).toBe(false);
      expect(isLocked(paths.lifetimeLock)).toBe(true);
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Known instances:'));
    } finally {
      lifetime.release();
    }
  });

  it('edits the offline registry and releases both locks before a daemon starts', async () => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one'), two = instance('two');
    await runInstance(['add', '--dir', one, '--dir', two]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one, two]);
    await runInstance(['forget', '--dir', two]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one]);
    expect(isLocked(paths.startLock)).toBe(false);
    expect(isLocked(paths.lifetimeLock)).toBe(false);
    const daemon = new Daemon({ paths, webPort: 0, host: new InstanceHost(new CalClient(null)) });
    daemons.push(daemon);
    expect(await daemon.listen()).toBe(true);
    const running = await client.tryConnect(paths);
    try {
      expect((await running!.peer.request<Status>('status')).known).toEqual([one]);
    } finally {
      running?.peer.close();
    }
  });

  it('rejects a whole live add batch before registration or loading', async () => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one'), two = instance('two'), missing = join(home, 'missing');
    writeKnown(paths, [one]);
    const host = new InstanceHost(new CalClient(null));
    const daemon = new Daemon({ paths, webPort: 0, host });
    daemons.push(daemon);
    expect(await daemon.listen()).toBe(true);
    const before = readFileSync(paths.known, 'utf8');
    const loaded = host.loadedPaths();
    await expect(runInstance(['add', '--dir', two, '--dir', missing])).rejects.toThrow(/Not an aside instance/);
    expect(readFileSync(paths.known, 'utf8')).toBe(before);
    expect(host.loadedPaths()).toEqual(loaded);
    expect(host.isLoaded(two)).toBe(false);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Known instances:'));
    // A valid retry applies the entire batch and loads all registrations.
    await runInstance(['add', '--dir', two]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one, two]);
    expect(host.isLoaded(two)).toBe(true);
  });

  it.each([false, true])('persists canonical add paths across alias removal (live: %s)', async live => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one'), alias = join(home, 'alias');
    symlinkSync(one, alias);
    const host = new InstanceHost(new CalClient(null));
    if (live) {
      const daemon = new Daemon({ paths, webPort: 0, host });
      daemons.push(daemon);
      expect(await daemon.listen()).toBe(true);
    }
    await runInstance(['add', '--dir', alias, '--dir', one]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one]);
    unlinkSync(alias);
    await runDaemon(['status']);
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining(one));
    if (live) expect(host.loadedPaths()).toEqual([one]);
    await runInstance(['forget', '--dir', one]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([]);
    if (!live) host.close();
  });

  it.each(['status', 'stop', 'uninstall'])('%s rejects every positional argument before connecting or removing a job', async operation => {
    const connect = vi.spyOn(client, 'tryConnect');
    const remove = vi.spyOn(login, 'removeJob');
    // An overlong socket location would fail if daemon paths were resolved.
    vi.stubEnv('ASIDE_DAEMON_HOME', '/tmp/' + 'x'.repeat(110));
    for (const argument of ['/a/specific/instance', 'relative', '']) {
      await expect(runDaemon([operation, argument])).rejects.toThrow(`Usage: aside daemon ${operation}`);
      await expect(runDaemon([operation, argument])).rejects.toThrow(/shared by all Aside instances/);
    }
    expect(connect).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.skipIf(!existsSync(join(__dirname, '../dist/main.js'))).each(['status', 'stop', 'uninstall'])('CLI %s returns nonzero for an instance path and preserves the saved job', operation => {
    const paths = pathFunctions.daemonPaths();
    if (paths.job) login.writeJob(paths, '/test/node', '/test/main.js', 1234);
    const result = spawnSync(process.execPath, [join(__dirname, '../dist/main.js'), 'daemon', operation, '/a/specific/instance'], {
      env: { ...process.env, ASIDE_DAEMON_HOME: home, ASIDE_CAL_BIN: '/nonexistent/aside-cal' }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Usage: aside daemon ${operation}`);
    expect(result.stderr).toContain('shared by all Aside instances');
    expect(result.stdout).toBe('');
    expect(existsSync(paths.socket)).toBe(false);
    if (paths.job) expect(login.readJob(paths)?.program.slice(2)).toEqual(['daemon', 'start', '--foreground']);
  });

  it('uninstall removes only the isolated saved job and explains loaded supervision', async () => {
    const paths = { ...pathFunctions.daemonPaths(), job: join(home, 'LaunchAgents/aside.plist') };
    vi.spyOn(pathFunctions, 'daemonPaths').mockReturnValue(paths);
    const connect = vi.spyOn(client, 'tryConnect');
    const load = vi.spyOn(login, 'loadJob');
    login.writeJob(paths, '/test/node', '/test/main.js', 1234);
    await expect(runDaemon(['uninstall', '/a/particular/instance'])).rejects.toThrow(/accepts no instance paths/);
    expect(readFileSync(paths.job, 'utf8')).toContain('/test/node');
    await runDaemon(['uninstall']);
    expect(existsSync(paths.job)).toBe(false);
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(output).toContain('Removed the saved login job for future logins');
    expect(output).toContain('running shared daemon is unchanged');
    expect(output).toContain('loaded in launchd remains until logout');
    expect(output).toContain('may restart the daemon after a crash');
    expect(connect).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('reports stopped status as normal without starting a daemon', async () => {
    await runDaemon(['stop']);
    expect(console.log).toHaveBeenCalledWith('The daemon is not running.');
    await runDaemon(['status']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Aside daemon'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Daemon stopped (starts when needed)'));
    expect(existsSync(pathFunctions.daemonPaths().socket)).toBe(false);
    expect(existsSync(pathFunctions.daemonPaths().lifetimeLock)).toBe(false);
  });

  it('force stop reports an absent daemon without starting one', async () => {
    await runDaemon(['stop', '-f', '--json']);
    expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0])).toMatchObject({
      command: 'daemon stop', ok: true, data: { stopped: true, was_running: false },
    });
    expect(existsSync(pathFunctions.daemonPaths().socket)).toBe(false);
  });

  it('force stop refuses an unreachable daemon without assuming it exited', async () => {
    const paths = pathFunctions.daemonPaths();
    const lifetime = new FileLock(paths.lifetimeLock);
    expect(lifetime.tryAcquire()).toBe(true);
    try {
      await expect(runDaemon(['stop', '--force'])).rejects.toThrow(/lifetime lock is held but its socket did not answer/);
      expect(isLocked(paths.lifetimeLock)).toBe(true);
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Daemon stopped.'));
    } finally { lifetime.release(); }
  });

  it('leaves individual manifest validation to instance validate', async () => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one');
    writeKnown(paths, [one]);
    writeFileSync(join(one, 'aside.md'), '---\nid: INVALID\nname: Broken\n---\n');
    const before = readFileSync(paths.known, 'utf8');
    await runDaemon(['status']);
    const output = vi.mocked(console.log).mock.calls.at(-1)![0];
    expect(output).toContain('Broken');
    expect(output).not.toContain('[ERROR]');
    expect(output).not.toContain('Broken manifest');
    expect(readFileSync(paths.known, 'utf8')).toBe(before);
    expect(existsSync(paths.socket)).toBe(false);
    expect(isLocked(paths.lifetimeLock)).toBe(false);
  });

  it('reports a malformed saved login job nonzero without replacing it or starting a daemon', async () => {
    const paths = { ...pathFunctions.daemonPaths(), job: join(home, 'job.plist') };
    vi.spyOn(pathFunctions, 'daemonPaths').mockReturnValue(paths);
    writeFileSync(paths.job, 'malformed');
    await expect(runDaemon(['status'])).rejects.toThrow('See the [ERROR] items above');
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('[ERROR] Login job file'));
    expect(readFileSync(paths.job, 'utf8')).toBe('malformed');
    expect(existsSync(paths.socket)).toBe(false);
  });

  it.each(['status', 'stop'])('%s fails truthfully when a daemon holds the lifetime lock without an answering socket', async operation => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one');
    writeKnown(paths, [one]);
    const before = readFileSync(paths.known, 'utf8');
    const lifetime = new FileLock(paths.lifetimeLock);
    expect(lifetime.tryAcquire()).toBe(true);
    try {
      await expect(runDaemon([operation])).rejects.toThrow(/lifetime lock is held but its socket did not answer/);
      await expect(runDaemon([operation])).rejects.toThrow(paths.log);
      await expect(runDaemon([operation])).rejects.toThrow(`Retry aside daemon ${operation}`);
      expect(readFileSync(paths.known, 'utf8')).toBe(before);
      expect(isLocked(paths.lifetimeLock)).toBe(true);
      expect(console.log).not.toHaveBeenCalledWith('The daemon is not running.');
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Daemon stopped (starts when needed)'));
      if (operation === 'status') {
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[ERROR] Daemon connection'));
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Instances (saved registry)'));
      }
    } finally { lifetime.release(); }
    // A stale unlocked file left by an exited macOS daemon is not a blocker.
    await runDaemon([operation]);
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/not running|Daemon stopped/));
  });

  it.skipIf(!existsSync(join(__dirname, '../dist/main.js'))).each(['status', 'stop'])('CLI %s reports held-lock unavailability on stderr and exits nonzero', operation => {
    const paths = pathFunctions.daemonPaths();
    const one = instance('one');
    writeKnown(paths, [one]);
    const before = readFileSync(paths.known, 'utf8');
    const lifetime = new FileLock(paths.lifetimeLock);
    expect(lifetime.tryAcquire()).toBe(true);
    try {
      const result = spawnSync(process.execPath, [join(__dirname, '../dist/main.js'), 'daemon', operation], {
        env: { ...process.env, ASIDE_DAEMON_HOME: home, ASIDE_CAL_BIN: '/nonexistent/aside-cal' }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('lifetime lock is held but its socket did not answer');
      expect(result.stderr).toContain(paths.log);
      expect(result.stderr).toContain(`Retry aside daemon ${operation}`);
      expect(result.stdout).not.toContain('not running');
      expect(readFileSync(paths.known, 'utf8')).toBe(before);
      expect(isLocked(paths.lifetimeLock)).toBe(true);
      expect(existsSync(paths.socket)).toBe(false);
    } finally { lifetime.release(); }
  });
});
