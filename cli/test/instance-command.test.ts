import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInstance } from '../src/commands/instance.js';
import { init } from '../src/commands/init.js';
import { Daemon, writeKnown } from '../src/daemon/daemon.js';
import { DaemonClient } from '../src/daemon/client.js';
import * as daemonClient from '../src/daemon/client.js';
import { FileLock, isLocked } from '../src/daemon/filelock.js';
import { InstanceHost } from '../src/daemon/host.js';
import { daemonPaths } from '../src/daemon/paths.js';
import { CalClient } from '../src/mcp/calendar/client.js';

describe('instance registry commands', () => {
  let home: string;
  let daemon: Daemon | undefined;
  let client: DaemonClient | undefined;
  beforeEach(() => {
    home = realpathSync(mkdtempSync('/tmp/aside-instances-'));
    vi.stubEnv('ASIDE_DAEMON_HOME', home);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    client?.close(); client = undefined;
    await daemon?.shutdown(); daemon = undefined;
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });
  function instance(name: string): string {
    const dir = join(home, name);
    init(dir, { name, description: `${name} instance` });
    return dir;
  }
  function output(): string { return vi.mocked(console.log).mock.calls.at(-1)![0]; }

  it('lists an empty fresh registry without creating daemon state', async () => {
    await runInstance(['list', '--json']);
    expect(JSON.parse(output())).toMatchObject({ command: 'instance list', ok: true, data: { instances: [] } });
    expect(readdirSync(home)).toEqual([]);
  });

  it('validates instance files without registering them or starting a daemon', async () => {
    const one = instance('one'), paths = daemonPaths();
    expect(await runInstance(['validate', '--dir', one, '--json'])).toBe(0);
    expect(JSON.parse(output())).toMatchObject({ command: 'instance validate', ok: true, data: { directory: one } });
    expect(existsSync(paths.known)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
    expect(await runInstance(['validate', '--dir', home, '--json'])).toBe(1);
    expect(JSON.parse(output()).ok).toBe(false);
  });

  it('creates instance files without registering them or starting a daemon', async () => {
    const dir = join(home, 'new'), paths = daemonPaths();
    await runInstance(['init', '--dir', dir, '--name', 'New', '--description', 'New instance', '--json']);
    expect(JSON.parse(output())).toMatchObject({ command: 'instance init', ok: true, data: { dataDir: dir, created: ['aside.md'] } });
    expect(existsSync(join(dir, 'aside.md'))).toBe(true);
    expect(existsSync(paths.known)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
  });

  it.each([false, true])('reports changed and unchanged paths for add and forget (running: %s)', async running => {
    const one = instance('one'), two = instance('two'), missing = join(home, 'missing'), paths = daemonPaths();
    const alias = join(home, 'alias');
    symlinkSync(two, alias);
    writeKnown(paths, [one]);
    if (running) {
      daemon = new Daemon({ paths, host: new InstanceHost(new CalClient(null)), webPort: 0 });
      expect(await daemon.listen()).toBe(true);
    }

    await runInstance(['add', '--dir', one, '--dir', two, '--dir', alias, '--json']);
    expect(JSON.parse(output())).toMatchObject({ command: 'instance add', ok: true, data: {
      results: [{ path: one, registered: true, changed: false }, { path: two, registered: true, changed: true }],
      instances: [{ path: one }, { path: two }],
    } });
    await runInstance(['add', '--dir', alias]);
    expect(output()).toContain(`Already registered\n  ${two}`);
    expect(output()).not.toContain(one);

    await runInstance(['forget', '--dir', alias, '--dir', two, '--dir', missing, '--json']);
    expect(JSON.parse(output())).toMatchObject({ command: 'instance forget', ok: true, data: {
      results: [{ path: two, registered: false, changed: true }, { path: missing, registered: false, changed: false }],
      instances: [{ path: one }],
    } });
    await runInstance(['forget', '--dir', two]);
    expect(output()).toContain(`Not registered\n  ${two}`);
    await runInstance(['forget', '--dir', one]);
    expect(output()).toContain(`Forgotten\n  ${one}`);
    expect(output()).not.toContain('Instances  ');
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([]);
    expect(existsSync(join(one, 'aside.md'))).toBe(true);
    expect(existsSync(join(two, 'aside.md'))).toBe(true);
    expect(existsSync(paths.socket)).toBe(running);
  });

  it('reports forgetting a saved path even after its directory has been removed', async () => {
    const one = instance('one'), paths = daemonPaths();
    writeKnown(paths, [one]);
    rmSync(one, { recursive: true });
    await runInstance(['forget', '--dir', one, '--json']);
    expect(JSON.parse(output())).toMatchObject({ ok: true, data: {
      results: [{ path: one, registered: false, changed: true }], instances: [],
    } });
  });

  it.each(['add', 'forget'])('confirms %s results with an older daemon without inventing change information', async operation => {
    const one = instance('one');
    const peer = { request: vi.fn().mockResolvedValue({ known: operation === 'add' ? [one] : [] }), close: vi.fn() };
    vi.spyOn(daemonClient, 'tryConnect').mockResolvedValue({ peer } as unknown as daemonClient.Connection);
    await runInstance([operation, '--dir', one, '--json']);
    const report = JSON.parse(output());
    expect(report).toMatchObject({ ok: true, data: { results: [{ path: one, registered: operation === 'add' }] } });
    expect(report.data.results[0]).not.toHaveProperty('changed');
    expect(peer.request).toHaveBeenCalledWith(`known.${operation}`, { paths: [one] });
    expect(peer.close).toHaveBeenCalled();
    await runInstance([operation, '--dir', one]);
    expect(output()).toContain(`${operation === 'add' ? 'Registered' : 'Forgotten'}\n  ${one}`);
  });

  it('reports a successful edit independently of unrelated manifest problems', () => {
    const one = instance('one'), two = instance('two'), paths = daemonPaths();
    writeKnown(paths, [one, two]);
    writeFileSync(join(two, 'aside.md'), '---\nid: INVALID\nname: Two\n---\n');
    const result = spawnSync(process.execPath, [join(__dirname, '../dist/main.js'), 'instance', 'forget', '--dir', one, '--json'], {
      env: { ...process.env, ASIDE_CAL_BIN: '/nonexistent/aside-cal' }, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ command: 'instance forget', ok: true, checks: [], data: {
      results: [{ path: one, registered: false, changed: true }], instances: [{ path: two }],
    } });
  });

  it('lists and collects the saved registry while stopped without starting a daemon', async () => {
    const one = instance('one'), repurposed = instance('repurposed'), missing = join(home, 'missing');
    writeFileSync(join(repurposed, 'aside.md'), 'Other data');
    const paths = daemonPaths();
    writeKnown(paths, [one, missing, repurposed]);
    await runInstance(['list']);
    expect(output()).toContain(`one\n  ${one}`);
    expect(output()).not.toContain(missing);
    expect(output()).not.toContain(repurposed);
    expect(output()).not.toContain('Health');
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one]);
    expect(existsSync(paths.socket)).toBe(false);
    expect(isLocked(paths.lifetimeLock)).toBe(false);
  });

  it.each([false, true])('reports catalogue ID clashes without checking individual manifests (running: %s)', async running => {
    const one = instance('one'), two = instance('two'), three = instance('three'), paths = daemonPaths();
    writeFileSync(join(two, 'aside.md'), '---\nid: one\nname: Two\n---\n');
    writeFileSync(join(three, 'aside.md'), '---\nid: INVALID\nname: Three\n---\n');
    const alias = join(home, 'alias');
    symlinkSync(one, alias);
    writeKnown(paths, [one, two, three, alias]);
    if (running) {
      daemon = new Daemon({ paths, host: new InstanceHost(new CalClient(null)), webPort: 0 });
      expect(await daemon.listen()).toBe(true);
    }
    // Each member of the clash is valid on its own.
    expect(await runInstance(['validate', '--dir', one, '--json'])).toBe(0);
    expect(await runInstance(['validate', '--dir', two, '--json'])).toBe(0);
    await runInstance(['list', '--json']);
    const report = JSON.parse(output());
    expect(report).toMatchObject({ command: 'instance list', ok: false });
    expect(report.data.instances.map((entry: { path: string }) => entry.path)).toEqual([one, two, three]);
    expect(report.checks).toEqual([expect.objectContaining({ code: 'instance_id_conflict', passed: false })]);
    expect(report.checks[0].problems[0]).toContain(one);
    expect(report.checks[0].problems[0]).toContain(two);
    expect(report.checks[0].problems[0]).not.toContain(three);
    await runInstance(['list']);
    expect(output()).toContain('[ERROR] Instance ID clash: one');
    expect(output()).not.toContain(' manifest');
    expect(output()).not.toContain('[OK]');
    expect(output()).not.toContain('INVALID');
  });

  it('lists the daemon’s known instances, excluding forgotten instances still in use', async () => {
    const one = instance('one'), two = instance('two'), paths = daemonPaths();
    writeKnown(paths, [one]);
    const host = new InstanceHost(new CalClient(null));
    daemon = new Daemon({ paths, host, webPort: 0 });
    expect(await daemon.listen()).toBe(true);
    client = new DaemonClient({ paths });
    await client.request('instance.info', { instance: one });
    await runInstance(['add', '--dir', two]);
    await runInstance(['forget', '--dir', one]);
    expect(host.isLoaded(one)).toBe(true);
    await runInstance(['list', '--json']);
    const data = JSON.parse(output());
    expect(data.command).toBe('instance list');
    expect(data.data.instances.map((entry: { path: string }) => entry.path)).toEqual([two]);
    expect(existsSync(join(one, 'aside.md'))).toBe(true);
    expect(isLocked(paths.lifetimeLock)).toBe(true);
  });

  it.each([false, true])('reports the saved list without changing it when the daemon is unreachable (json: %s)', async json => {
    const one = instance('one'), missing = join(home, 'missing'), paths = daemonPaths();
    writeKnown(paths, [one, missing]);
    const before = readFileSync(paths.known, 'utf8');
    const lifetime = new FileLock(paths.lifetimeLock);
    expect(lifetime.tryAcquire()).toBe(true);
    try {
      await expect(runInstance(['list', ...(json ? ['--json'] : [])])).rejects.toThrow('Retry aside instance list');
      expect(readFileSync(paths.known, 'utf8')).toBe(before);
      if (json) {
        const result = JSON.parse(output());
        expect(result.ok).toBe(false);
        expect(result.data.instances.map((entry: { path: string }) => entry.path)).toEqual([one]);
        expect(result.checks).toContainEqual(expect.objectContaining({ code: 'daemon_connection', passed: false }));
      } else {
        expect(output()).toContain('Instances (saved registry)');
        expect(output()).toContain(paths.log);
      }
    } finally { lifetime.release(); }
  });

  it('rejects invalid list arguments before touching the registry', async () => {
    const paths = daemonPaths(), before = readdirSync(home);
    await expect(runInstance(['list', '--dir', '/one'])).rejects.toThrow('unknown option');
    await expect(runInstance(['list', '/one'])).rejects.toThrow('Usage: aside instance list');
    expect(readdirSync(home)).toEqual(before);
    expect(existsSync(paths.known)).toBe(false);
  });

  it('lists manifest metadata without duplicating instance validation', () => {
    const one = instance('one'), paths = daemonPaths();
    writeKnown(paths, [one]);
    writeFileSync(join(one, 'aside.md'), '---\nid: INVALID\nname: One\n---\n');
    const result = spawnSync(process.execPath, [join(__dirname, '../dist/main.js'), 'instance', 'list', '--json'], {
      env: { ...process.env, ASIDE_CAL_BIN: '/nonexistent/aside-cal' }, encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ command: 'instance list', ok: true, checks: [] });
    expect(report.data.instances[0]).toMatchObject({ name: 'One', path: one });
    expect(report.data.instances[0]).not.toHaveProperty('issues');
    expect(existsSync(paths.socket)).toBe(false);
  });
});
