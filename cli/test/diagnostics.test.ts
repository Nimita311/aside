import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStorage, type RunRecord } from '../src/automation/storage.js';
import { runDiagnostics } from '../src/commands/diagnostics.js';
import { parseCli } from '../src/commands/options.js';
import { DIAGNOSTIC_CLEANUP_INTERVAL_MS } from '../src/core/system-config.js';
import { Daemon } from '../src/daemon/daemon.js';
import { FileLock, isLocked } from '../src/daemon/filelock.js';
import { InstanceHost } from '../src/daemon/host.js';
import { daemonPaths, type DaemonPaths } from '../src/daemon/paths.js';
import { usageDirectory } from '../src/graphql/usage.js';
import { CalClient } from '../src/mcp/calendar/client.js';

let home: string, paths: DaemonPaths, daemons: Daemon[];
beforeEach(() => {
  home = realpathSync(mkdtempSync('/tmp/aside-diagnostics-'));
  vi.stubEnv('ASIDE_DAEMON_HOME', home);
  paths = daemonPaths();
  daemons = [];
});
afterEach(async () => {
  for (const daemon of daemons) await daemon.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, {recursive: true, force: true});
});

function seed(root: string, expired = false) {
  const usage = usageDirectory(root, paths.logs);
  mkdirSync(usage, {recursive: true});
  writeFileSync(join(usage, 'instance.json'), JSON.stringify({schemaVersion: 1, path: root, id: 'same-id'}));
  const date = expired ? '2000-01-01' : new Date().toISOString().slice(0, 10);
  const segment = join(usage, `${date}-001.jsonl`);
  writeFileSync(segment, '{"synthetic":"diagnostic"}\n');
  const storage = new RunStorage(join(paths.state, 'automation'));
  const key = JSON.stringify([root, 'instance same-id', 'removed-job']);
  expect(storage.claim(key, 123)).toBe(true);
  const timestamp = expired ? '2000-01-01T12:00:00.000Z' : new Date().toISOString();
  const run: RunRecord = {id: randomUUID(), key, root, definedIn: 'instance same-id',
    occurrence: timestamp, started: timestamp, finished: timestamp, status: 'succeeded', session: storage.session,
    definition: {schedule: {at: timestamp}, run: {script: 'echo'}}, latenessMs: 0};
  const directory = storage.start(run);
  writeFileSync(join(directory, 'stdout.log'), 'Synthetic retained output.\n');
  return {usage, segment, storage, key, directory};
}
async function start() {
  const host = new InstanceHost(new CalClient(null));
  const daemon = new Daemon({paths, host, webPort: 0});
  daemons.push(daemon);
  expect(await daemon.listen()).toBe(true);
  return {daemon, host};
}
async function purge(args: string[]) {
  const output: string[] = [];
  await runDiagnostics(['purge', ...args, '--json'], home, text => output.push(text));
  expect(output).toHaveLength(1);
  const report = JSON.parse(output[0]);
  expect(report).toMatchObject({command: 'diagnostics purge', ok: true});
  return report.data;
}
async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Diagnostic cleanup did not complete.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('diagnostic retention and purge integration', () => {
  it('ships a purge command that removes retained diagnostics without starting the daemon', () => {
    const retained = seed(join(home, 'missing'));
    const output = execFileSync(process.execPath, [join(__dirname, '../dist/main.js'), 'diagnostics', 'purge', '--all', '--json'], {
      cwd: home, encoding: 'utf8', env: {...process.env, ASIDE_DAEMON_HOME: home},
    });
    expect(JSON.parse(output)).toMatchObject({command: 'diagnostics purge', ok: true,
      data: {usage: {files: 1, collections: 1}, automation: {runs: 1}}});
    expect(existsSync(retained.usage)).toBe(false);
    expect(existsSync(retained.directory)).toBe(false);
    expect(existsSync(paths.socket)).toBe(false);
    expect(new RunStorage(join(paths.state, 'automation')).lastClaim(retained.key)).toBe(123);
  });

  it('requires exactly one explicit purge scope, including in direct command calls', async () => {
    for (const args of [[], ['--dir', 'one', '--all']]) {
      expect(() => parseCli(['diagnostics', 'purge', ...args])).toThrow();
      await expect(runDiagnostics(['purge', ...args], home)).rejects.toThrow();
    }
    expect(parseCli(['diagnostics', 'purge', '--dir', 'missing'])).toMatchObject({command: 'diagnostics', operation: 'purge'});
    expect(parseCli(['diagnostics', 'purge', '--all']).has('--all')).toBe(true);
    expect(parseCli(['diagnostics', 'purge', '--help']).helpText).toContain('--all');
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.logs)).toBe(false);
  });

  it('purges a missing instance offline, isolates same-ID collections, and retains claims', async () => {
    const one = seed(join(home, 'removed-one'));
    const two = seed(join(home, 'removed-two'));
    const listen = vi.spyOn(Daemon.prototype, 'listen');
    expect(await purge(['--dir', 'removed-one'])).toMatchObject({usage: {files: 1, collections: 1}, automation: {runs: 1}});
    expect(existsSync(one.usage)).toBe(false);
    expect(existsSync(one.directory)).toBe(false);
    expect(existsSync(two.segment)).toBe(true);
    expect(readFileSync(join(two.directory, 'stdout.log'), 'utf8')).toContain('Synthetic');
    expect(new RunStorage(join(paths.state, 'automation')).lastClaim(one.key)).toBe(123);
    expect(one.storage.claim(one.key, 123)).toBe(false);
    expect(listen).not.toHaveBeenCalled();
    expect(existsSync(paths.socket)).toBe(false);
    expect(isLocked(paths.startLock)).toBe(false);
    expect(isLocked(paths.lifetimeLock)).toBe(false);
    expect(await purge(['--all'])).toMatchObject({usage: {files: 1, collections: 1}, automation: {runs: 1}});
    expect(existsSync(two.usage)).toBe(false);
    expect(existsSync(two.directory)).toBe(false);
    expect(new RunStorage(join(paths.state, 'automation')).lastClaim(two.key)).toBe(123);
  });

  it('refuses offline deletion while a daemon owns the lifetime lock without a reachable socket', async () => {
    const retained = seed(join(home, 'removed'));
    const lifetime = new FileLock(paths.lifetimeLock);
    expect(lifetime.tryAcquire()).toBe(true);
    try {
      await expect(purge(['--all'])).rejects.toThrow(/lock|unavailable|reachable|No changes/i);
      expect(existsSync(retained.segment)).toBe(true);
      expect(existsSync(retained.directory)).toBe(true);
      expect(isLocked(paths.lifetimeLock)).toBe(true);
      expect(isLocked(paths.startLock)).toBe(false);
    } finally { lifetime.release(); }
  });

  it('cleans inactive usage and removed-job runs at startup without registering their missing instances', async () => {
    const expired = seed(join(home, 'missing-expired'), true);
    const recent = seed(join(home, 'missing-recent'));
    const {host} = await start();
    expect(existsSync(expired.usage)).toBe(false);
    expect(existsSync(expired.directory)).toBe(false);
    expect(existsSync(recent.segment)).toBe(true);
    expect(existsSync(recent.directory)).toBe(true);
    expect(host.loadedPaths()).toEqual([]);
    expect(new RunStorage(join(paths.state, 'automation')).lastClaim(expired.key)).toBe(123);
  });

  it('sweeps daily without new activity and stops the scheduled sweep during shutdown', async () => {
    const realSetInterval = globalThis.setInterval;
    const callbacks: Array<() => void> = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === DIAGNOSTIC_CLEANUP_INTERVAL_MS && typeof handler === 'function') callbacks.push(() => handler(...args));
      return realSetInterval(handler, delay, ...args);
    }) as typeof setInterval);
    const {daemon, host} = await start();
    expect(callbacks).toHaveLength(1);
    const retained = seed(join(home, 'inactive-after-startup'), true);
    callbacks[0]();
    await until(() => !existsSync(retained.usage) && !existsSync(retained.directory));
    const cleanup = vi.spyOn(host, 'cleanupDiagnostics');
    await daemon.shutdown();
    callbacks[0]();
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('awaits an in-flight daily sweep before stopping the automation worker', async () => {
    const realSetInterval = globalThis.setInterval;
    let callback: (() => void) | undefined;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === DIAGNOSTIC_CLEANUP_INTERVAL_MS && typeof handler === 'function') callback = () => handler(...args);
      return realSetInterval(handler, delay, ...args);
    }) as typeof setInterval);
    const {daemon, host} = await start();
    let finish!: (value: {usage: {files: number; collections: number}; automation: {runs: number}}) => void;
    vi.spyOn(host, 'cleanupDiagnostics').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const stopAutomation = vi.spyOn(host, 'stopAutomation');
    callback!();
    const stopping = daemon.shutdown();
    await Promise.resolve();
    expect(stopAutomation).not.toHaveBeenCalled();
    finish({usage: {files: 0, collections: 0}, automation: {runs: 0}});
    await stopping;
    expect(stopAutomation).toHaveBeenCalled();
  });

  it('routes one-instance and all-instance purge through the live daemon', async () => {
    const one = seed(join(home, 'one'));
    const two = seed(join(home, 'two'));
    const {host} = await start();
    const livePurge = vi.spyOn(host, 'purgeDiagnostics');
    expect(await purge(['--dir', 'one'])).toMatchObject({usage: {files: 1, collections: 1}, automation: {runs: 1}});
    expect(livePurge).toHaveBeenCalledWith(join(home, 'one'));
    expect(existsSync(one.usage)).toBe(false);
    expect(existsSync(one.directory)).toBe(false);
    expect(existsSync(two.segment)).toBe(true);
    expect(await purge(['--all'])).toMatchObject({usage: {files: 1, collections: 1}, automation: {runs: 1}});
    expect(livePurge).toHaveBeenLastCalledWith(undefined);
    expect(existsSync(two.usage)).toBe(false);
    expect(existsSync(two.directory)).toBe(false);
    expect(host.loadedPaths()).toEqual([]);
    expect(existsSync(paths.socket)).toBe(true);
  });
});
