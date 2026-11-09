import { isAsideDir } from '../core/instance.js';
import type { Status } from '../daemon/protocol.js';
import type { Job } from '../daemon/launchd.js';
import type { DaemonPaths } from '../daemon/paths.js';
import {availableInstances} from '../source/instance-admission.js';
import {type AvailableInstance} from '../core/catalogue.js';
import { renderReport, type Report } from './output.js';
import { instanceIdClashChecks } from './instance-checks.js';

interface Snapshot {
  paths: DaemonPaths;
  running?: Status;
  instances: AvailableInstance[];
  unavailable: boolean;
  known: string[];
  job: Job | null;
  jobFileExists: boolean;
}

export function formatDaemonStatus(snapshot: Snapshot, json = false): { output: string; errors: boolean } {
  const { paths, unavailable, job, jobFileExists } = snapshot;
  if (!snapshot.instances) throw new Error('Daemon instance catalogue is unavailable.');
  const published = snapshot.instances;
  const eligible = new Set(published.map(instance => instance.path));
  const known = (snapshot.running?.known ?? snapshot.known).filter(path => eligible.has(path));
  const running = snapshot.running ? { pid: snapshot.running.pid, build: snapshot.running.build,
    connections: snapshot.running.connections, tabs: snapshot.running.tabs,
    known, loaded: snapshot.running.loaded.filter(path => eligible.has(path)),
    sessions: snapshot.running.sessions ? Object.fromEntries(Object.entries(snapshot.running.sessions).filter(([path]) => eligible.has(path))) : undefined,
    graphqlLogging: snapshot.running.graphqlLogging,
  } : undefined;
  const loaded = new Set(running?.loaded ?? []);
  const listed = [...new Set([...known, ...loaded])];
  const catalogue = new Map(published.map(instance => [instance.path, instance]));
  const instances = listed.map(path => {
    const instance = catalogue.get(path);
    return { path, id: instance?.id ?? '', name: instance?.name ?? instance?.id ?? 'Instance',
      loaded: running ? loaded.has(path) : null,
      sessions: running?.sessions?.[path] ?? (running?.sessions ? 0 : null) };
  });
  const information: Record<string, unknown> = {
    ...(running ? { PID: running.pid, Version: running.build.version,
      Build: running.build.builtAt ? new Date(running.build.builtAt).toISOString() : 'from source',
      'Connected clients': Math.max(0, running.connections - 1), 'Browser tabs': running.tabs } : {}),
    'Login job': jobFileExists ? paths.job : null,
    Log: paths.log,
    ...(running?.graphqlLogging ? {'GraphQL logging': running.graphqlLogging} : {}),
  };
  const report: Report = { title: 'Aside daemon',
    data: { daemon: running ?? null, unavailable, startup: job, instances },
    sections: [{ name: 'Information', fields: information },
      { name: unavailable ? 'Instances (saved registry)' : 'Instances', entries: instances.map(instance => ({
        name: instance.name.replace(/\s+/g, ' ').trim(), path: instance.path,
        annotations: [...(instance.loaded ? ['loaded'] : []),
          ...(instance.sessions ? [`${instance.sessions} active session${instance.sessions === 1 ? '' : 's'}`] : [])],
      })) }], checks: [] };
  report.checks.push({ code: 'daemon_connection', label: running ? 'Daemon connection' : unavailable ? 'Daemon connection' : 'Daemon stopped (starts when needed)',
    passed: !unavailable, ...(unavailable ? { problems: ['Lifetime lock held, but the daemon does not answer.'], fixes: ['Inspect the log and retry aside daemon status.'] } : {}) });
  if (jobFileExists) report.checks.push({ code: 'login_job', label: 'Login job file', passed: !!job,
    ...(!job ? { problems: ['The saved job could not be read or recognized.'], fixes: ['aside daemon install'] } : {}) });
  report.checks.push(...instanceIdClashChecks([...catalogue.values()]));
  return { output: renderReport(report, 'daemon status', json), errors: report.checks.some(check => !check.passed) };
}

/** Explicit stopped/unreachable-daemon diagnostics have no live owner. */
export function readOfflineDaemonInstances(known: string[]): AvailableInstance[] {
  return availableInstances(known.filter(isAsideDir));
}
