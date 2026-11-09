import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { init } from '../src/source/bootstrap.js';
import { collectKnownFile, writeKnown } from '../src/daemon/daemon.js';
import { daemonPaths, ensureDirs, type DaemonPaths } from '../src/daemon/paths.js';
import { FileLock } from '../src/daemon/filelock.js';
import { formatDaemonStatus } from '../src/commands/daemon-status.js';

describe('instance garbage collection', () => {
  let root: string, valid: string, removed: string, repurposed: string, paths: DaemonPaths;
  beforeEach(() => {
    root = realpathSync(mkdtempSync('/tmp/aside-gc-'));
    [valid, removed, repurposed] = ['valid', 'removed', 'repurposed'].map(name => {
      const path = join(root, name); init(path, { name, description: name }); return path;
    });
    paths = daemonPaths({ ASIDE_DAEMON_HOME: join(root, 'state') }); ensureDirs(paths);
    writeKnown(paths, [valid, removed, repurposed]);
    rmSync(removed, { recursive: true }); writeFileSync(join(repurposed, 'aside.md'), 'Repurposed directory');
  });
  afterEach(() => {access.reset(); rmSync(root, { recursive: true, force: true });});
  const saved = (paths: DaemonPaths) => JSON.parse(readFileSync(paths.known, 'utf8'));

  it('persists offline cleanup before returning valid instances', () => {
    expect(collectKnownFile(paths)).toEqual([valid]);
    expect(saved(paths)).toEqual([valid]);
    expect(existsSync(paths.socket)).toBe(false);
  });
  it.each(['startLock', 'lifetimeLock'] as const)('filters but does not overwrite a registry protected by %s', key => {
    const owner = new FileLock(paths[key]); expect(owner.tryAcquire()).toBe(true);
    try {
      expect(collectKnownFile(paths)).toEqual([valid]);
      expect(saved(paths)).toEqual([valid, removed, repurposed]);
    } finally { owner.release(); }
    expect(collectKnownFile(paths)).toEqual([valid]); expect(saved(paths)).toEqual([valid]);
  });
  it.each([
    ['artifact', 'query', '--dir'], ['show', '#action/2026-10-05-review', '--dir'], ['show', '--url', '--dir'],
    ['mcp', '--dir'], ['instance', 'add', '--dir'],
  ].map(args => ({ args })))('cleans up after a CLI use fails locally: $args', ({ args }) => {
    const result = spawnSync(process.execPath, [join(__dirname, '../dist/main.js'), ...args, removed, ...(args[0] === 'mcp' ? [] : ['--json'])], {
      cwd: root, env: { ...process.env, ASIDE_DAEMON_HOME: paths.state, ASIDE_CAL_BIN: '/nonexistent' }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    if (args[0] !== 'mcp') expect(JSON.parse(result.stdout).ok).toBe(false);
    expect(saved(paths)).toEqual([valid]); expect(existsSync(paths.socket)).toBe(false);
  });
  it('formats live status using only the daemon-published catalogue even when disk has changed', () => {
    const snapshot = { paths, unavailable: false, known: [valid, removed, repurposed], job: null, jobFileExists: false,
      instances: [{path: valid, id: 'valid', name: 'Published valid'}, {path: removed, id: 'removed', name: 'Published removed'}],
      running: { pid: 123, build: { version: '0.1.0', builtAt: 0 }, longRunning: true,
        selection: { all: false, paths: [valid, removed] }, connections: 2, tabs: 0,
        known: [valid, removed], loaded: [valid, removed], sessions: { [valid]: 1, [removed]: 1 } } };
    access.protect([valid, removed, repurposed]);
    const human = formatDaemonStatus(snapshot).output;
    expect(human).toContain('Published removed'); expect(human).not.toContain(repurposed);
    const json = JSON.parse(formatDaemonStatus(snapshot, true).output);
    expect(json.data.instances.map((instance: { path: string }) => instance.path)).toEqual([valid, removed]);
    expect(json.data.daemon.known).toEqual([valid, removed]); expect(json.data.daemon.loaded).toEqual([valid, removed]);
    expect(json.data.daemon).not.toHaveProperty('selection'); expect(json.data.daemon).not.toHaveProperty('longRunning'); expect(json.data.daemon.sessions).toEqual({ [valid]: 1, [removed]: 1 });
    expect(access.violations).toEqual([]);
  });
  it('does not mutate the registry for a syntax error that never tried to use an instance', () => {
    const result = spawnSync(process.execPath, [join(__dirname, '../dist/main.js'), 'artifact', 'query', '--wat', '--json'], {
      cwd: root, env: { ...process.env, ASIDE_DAEMON_HOME: paths.state }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(saved(paths)).toEqual([valid, removed, repurposed]);
  });
});
