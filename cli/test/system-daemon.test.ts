import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSystemDaemon, type SystemDaemonRuntime } from '../src/graphql/system-daemon.js';
import { daemonPaths, type DaemonPaths } from '../src/daemon/paths.js';
import { renderJob } from '../src/daemon/launchd.js';

describe('GraphQL daemon system snapshot', () => {
  let root: string;
  let paths: DaemonPaths;
  const runtime = (): SystemDaemonRuntime => ({pid: 123, connections: 4, tabs: 2,
    graphqlLogging: {queuedBytes: 2048, dropped: 3, errors: 1}});

  beforeEach(() => {
    root = mkdtempSync('/private/tmp/aside-system-daemon-');
    paths = {...daemonPaths({ASIDE_DAEMON_HOME: root}), job: join(root, 'LaunchAgents', 'aside.plist')};
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  it('reports current runtime and actual log location without creating state or reading instance paths', () => {
    Object.defineProperty(paths, 'known', {get: () => { throw new Error('Do not inspect the instance registry.'); }});
    const result = collectSystemDaemon(paths, runtime());
    expect(result).toEqual({...runtime(), logPath: paths.log,
      startup: {path: null, present: false, program: null, builtAt: null},
      checks: [{code: 'daemon_connection', label: 'Daemon connection', passed: true}]});
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(paths.logs)).toBe(false);
  });

  it('reports the existing startup job without loading or installing it', () => {
    mkdirSync(join(root, 'LaunchAgents'));
    const program = ['/usr/bin/node', '/custom/aside/cli/dist/main.js', 'daemon', 'start', '--foreground'];
    writeFileSync(paths.job!, renderJob(program[0], program[1], 123456789, paths.log));
    const result = collectSystemDaemon(paths, runtime());
    expect(result.startup).toEqual({path: paths.job, present: true, program, builtAt: 123456789});
    expect(result.checks).toContainEqual({code: 'login_job', label: 'Login job file', passed: true});
    expect(readdirSync(root)).toEqual(['LaunchAgents']);
    expect(existsSync(paths.logs)).toBe(false);
  });

  it('retains the CLI diagnostic when an existing job is malformed', () => {
    mkdirSync(join(root, 'LaunchAgents'));
    writeFileSync(paths.job!, '<plist>unrecognized</plist>');
    const result = collectSystemDaemon(paths, runtime());
    expect(result.startup).toEqual({path: paths.job, present: true, program: null, builtAt: null});
    expect(result.checks).toContainEqual({code: 'login_job', label: 'Login job file', passed: false,
      problems: ['The saved job could not be read or recognized.'], fixes: ['aside daemon install']});
  });

  it('handles platforms without a startup job and snapshots mutable counters', () => {
    const state = runtime();
    const result = collectSystemDaemon({...paths, job: null}, state);
    state.graphqlLogging.queuedBytes = 0;
    expect(result.graphqlLogging.queuedBytes).toBe(2048);
    expect(result.startup).toEqual({path: null, present: false, program: null, builtAt: null});
    expect(result.checks.map(check => check.code)).toEqual(['daemon_connection']);
  });
});
