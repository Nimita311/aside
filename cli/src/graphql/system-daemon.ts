import { existsSync } from 'node:fs';
import type { HealthCheck } from '../commands/output.js';
import { readJob } from '../daemon/launchd.js';
import type { DaemonPaths } from '../daemon/paths.js';

export interface SystemDaemonRuntime {
  pid: number;
  connections: number;
  tabs: number;
  graphqlLogging: {queuedBytes: number; dropped: number; errors: number};
}

export interface SystemDaemonSnapshot extends SystemDaemonRuntime {
  logPath: string;
  startup: {
    path: string | null;
    present: boolean;
    program: string[] | null;
    builtAt: number | null;
  };
  checks: HealthCheck[];
}

/** The system-only portion of daemon status. Never inspect the instance registry. */
export function collectSystemDaemon(paths: DaemonPaths, runtime: SystemDaemonRuntime): SystemDaemonSnapshot {
  const present = paths.job !== null && existsSync(paths.job);
  const job = present ? readJob(paths) : null;
  const checks: HealthCheck[] = [{code: 'daemon_connection', label: 'Daemon connection', passed: true}];
  if (present) checks.push({code: 'login_job', label: 'Login job file', passed: job !== null,
    ...(!job ? {problems: ['The saved job could not be read or recognized.'], fixes: ['aside daemon install']} : {})});
  return {
    ...runtime,
    graphqlLogging: {...runtime.graphqlLogging},
    logPath: paths.log,
    startup: {path: present ? paths.job : null, present, program: job?.program ?? null, builtAt: job?.builtAt ?? null},
    checks,
  };
}
