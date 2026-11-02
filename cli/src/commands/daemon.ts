import type { AutomationInspection } from '../automation/controller.js';
import { DAEMON_COMMAND_LOCK_TIMEOUT_MS, DAEMON_INSTALL_START_TIMEOUT_MS, DAEMON_INSTALL_POLL_INTERVAL_MS } from '../core/system-config.js';
// aside daemon — manage the background daemon and its login job (see
// design/daemon.md, Lifecycle).
import { parseCommand, type CommandInput } from './options.js';
import { jsonResult, writeOutput } from './output.js';
import { formatDaemonStatus } from './daemon-status.js';
import { existsSync } from 'node:fs';
import { Daemon, collectKnownFile } from '../daemon/daemon.js';
import { DaemonClient, ownProgram, shutdownDaemon, tryConnect, type DaemonStartup } from '../daemon/client.js';
import { daemonPaths, ensureDirs, type DaemonPaths } from '../daemon/paths.js';
import { FileLock, isLocked } from '../daemon/filelock.js';
import { loadJob, readJob, removeJob, writeJob } from '../daemon/launchd.js';
import { ownHello, type Status, type StopResult } from '../daemon/protocol.js';

interface Parsed {
  flags: Set<string>;
}

function reportStart(parsed: Parsed, status: Status, startup: DaemonStartup): void {
  const outcome = startup.action === 'started' ? `Started new daemon (pid ${status.pid}).`
    : startup.action === 'replaced' ? `Replaced daemon (pid ${startup.previousPid}) with newer build (pid ${status.pid}).`
    : `Reused running daemon (pid ${status.pid}); no replacement.`;
  const json = parsed.flags.has('--json');
  const { build, pid, connections, tabs, known, loaded, sessions } = status;
  writeOutput(json ? jsonResult('daemon start', { build, pid, connections, tabs, known, loaded, sessions, ...startup })
    : outcome, json);
}

// Run the daemon in this process until it exits. Returns false at once when
// another daemon holds the lifetime lock; otherwise never returns.
async function serveHere(paths: DaemonPaths, onStarted?: () => Promise<void>): Promise<false> {
  // The shared process outlives the launching workspace, which may be removed.
  ensureDirs(paths);
  // Later diagnostics resolve paths again from the daemon's environment.
  if (paths.homeOverride) process.env.ASIDE_DAEMON_HOME = paths.homeOverride;
  process.chdir(paths.state);
  let exited: () => void = () => {};
  const done = new Promise<void>((r) => { exited = r; });
  const daemon = new Daemon({ paths, onExit: exited });
  if (!(await daemon.listen())) return false;
  const stop = () => void daemon.shutdown();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // One failed operation must not take every session's daemon down with it.
  const report = (kind: string) => (e: unknown) => {
    process.stderr.write(`${new Date().toISOString()} ${kind}: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  };
  process.on('uncaughtException', report('uncaught exception'));
  process.on('unhandledRejection', report('unhandled rejection'));
  await onStarted?.();
  await done;
  process.exit(0);
}

// The daemon process itself, as clients spawn it. Exits quietly when another
// daemon already holds the lifetime lock.
async function run(): Promise<void> {
  await serveHere(daemonPaths());
}

async function start(parsed: Parsed): Promise<void> {
  const paths = daemonPaths();
  // In the foreground this command is the daemon — unless another process
  // already is, in which case that daemon is reused below.
  if (parsed.flags.has('--foreground')) {
    const reportReady = (startup: DaemonStartup) => async () => {
      const running = await tryConnect(paths);
      if (!running) throw new Error(`The aside daemon is not responding. See its log: ${paths.log}`);
      try { reportStart(parsed, await running.peer.request<Status>('status'), startup); }
      finally { running.peer.close(); }
    };
    await serveHere(paths, reportReady({ action: 'started' }));
    // An older build holds the daemon: take over from it here, in the
    // foreground, rather than through a detached replacement.
    const running = await tryConnect(paths);
    if (running && ownHello().build.builtAt > running.hello.build.builtAt) {
      if ((await shutdownDaemon(paths, running)).exited) {
        await serveHere(paths, reportReady({ action: 'replaced', previousPid: running.hello.pid }));
      }
    } else {
      running?.peer.close();
    }
  }
  const client = new DaemonClient({ paths });
  try {
    const status = await client.request<Status>('status', undefined, { read: true });
    reportStart(parsed, status, client.startup!);
  } finally {
    client.close();
  }
}

async function install(parsed: Parsed): Promise<void> {
  const paths = daemonPaths();
  if (!paths.job) throw new Error('The login job needs launchd, which is only available on macOS.');
  ensureDirs(paths);
  const lock = new FileLock(paths.startLock);
  if (!(await lock.acquireWait(DAEMON_COMMAND_LOCK_TIMEOUT_MS))) throw new Error('Cannot install the login job: another process holds the start lock.');
  try {
    const { node, script } = ownProgram();
    writeJob(paths, node, script, ownHello().build.builtAt);
    // Restart the daemon under the job, so launchd supervises it from now on.
    const running = await tryConnect(paths);
    if (running) {
      const { exited } = await shutdownDaemon(paths, running);
      if (!exited) throw new Error('The running aside daemon did not shut down; the login job is installed and takes effect once it exits.');
    }
    await loadJob(paths);
  } finally {
    lock.release();
  }
  // launchd starts the job as it loads; wait for its daemon to answer.
  const deadline = Date.now() + DAEMON_INSTALL_START_TIMEOUT_MS;
  let running = await tryConnect(paths);
  while (!running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DAEMON_INSTALL_POLL_INTERVAL_MS));
    running = await tryConnect(paths);
  }
  if (!running) throw new Error(`The login job did not start the daemon. See its log: ${paths.log}`);
  running.peer.close();
  writeOutput(parsed.flags.has('--json') ? jsonResult('daemon install', { job: paths.job, daemon: { build: running.hello.build, pid: running.hello.pid } })
    : `Installed the login job: ${paths.job}\nDaemon is running (pid ${running.hello.pid}).`, parsed.flags.has('--json'));
}

function uninstall(parsed: Parsed): void {
  const paths = daemonPaths();
  const removed = removeJob(paths);
  const text = [removed ? `Removed the saved login job for future logins: ${paths.job}` : 'No saved login job is installed.',
    'The running shared daemon is unchanged. Use aside daemon stop, or aside daemon stop --force to disconnect active clients and tabs.',
    ...(paths.job ? ['Any job already loaded in launchd remains until logout and may restart the daemon after a crash.'] : [])].join('\n');
  writeOutput(parsed.flags.has('--json') ? jsonResult('daemon uninstall', { removed, job: paths.job }) : text, parsed.flags.has('--json'));
}

async function status(parsed: Parsed): Promise<void> {
  const paths = daemonPaths();
  const running = await tryConnect(paths);
  const job = readJob(paths);
  const unavailable = !running && unavailableDaemon(paths, 'inspect');
  let known: string[];
  let snapshot: Status | undefined;
  if (running) {
    let s: Status;
    try {
      s = await running.peer.request<Status>('status');
    } finally {
      running.peer.close();
    }
    snapshot = s;
    known = s.known;
  } else {
    known = collectKnownFile(paths);
  }
  const report = formatDaemonStatus({ paths, running: snapshot, unavailable: !!unavailable, known, job,
    jobFileExists: !!paths.job && existsSync(paths.job) }, parsed.flags.has('--json'));
  writeOutput(report.output, parsed.flags.has('--json'));
  if (unavailable) throw unavailable;
  if (report.errors) throw new Error('Daemon status found errors. See the [ERROR] items above.');
}

// A failed socket handshake does not prove the daemon has exited. Probe only
// an existing lock file, so a fresh installation stays a read-only inspection.
function unavailableDaemon(paths: DaemonPaths, operation: 'inspect' | 'stop'): Error | undefined {
  if (!existsSync(paths.lifetimeLock) || !isLocked(paths.lifetimeLock)) return;
  return new Error(`Cannot ${operation} the shared daemon: its lifetime lock is held but its socket did not answer. It may be starting, stopping, or unavailable.\nSee its log: ${paths.log}\nRetry aside daemon ${operation === 'inspect' ? 'status' : 'stop'} when it is reachable or has exited.`);
}

async function stop(parsed: Parsed): Promise<void> {
  const paths = daemonPaths();
  const running = await tryConnect(paths);
  if (!running) {
    const unavailable = unavailableDaemon(paths, 'stop');
    if (unavailable) throw unavailable;
    writeOutput(parsed.flags.has('--json') ? jsonResult('daemon stop', { stopped: true, was_running: false }) : 'The daemon is not running.', parsed.flags.has('--json'));
    return;
  }
  let result: StopResult;
  try {
    result = await running.peer.request('stop');
  } catch (e) {
    running.peer.close();
    throw e;
  }
  if (!result.stopped && !parsed.flags.has('--force')) {
    running.peer.close();
    const users = [
      result.connections > 0 ? `${result.connections} connection${result.connections === 1 ? '' : 's'}` : '',
      result.tabs > 0 ? `${result.tabs} open tab${result.tabs === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ');
    const instances = result.instances?.length ? `\nInstances in use:\n${result.instances.map(path => `  ${path}`).join('\n')}` : '';
    throw new Error(`Cannot stop the shared daemon: it is in use by ${users}.${instances}\nClose the other clients and tabs, then retry aside daemon stop, or use aside daemon stop --force (-f) to stop anyway and disconnect them.`);
  }
  // After an accepted stop, shutdown waits it out. Force uses this fixed-core
  // request to bypass a busy refusal, including from an older daemon build.
  const { exited } = await shutdownDaemon(paths, running);
  if (!exited) throw new Error('The daemon did not exit in time.');
  result = { ...result, stopped: true };
  writeOutput(parsed.flags.has('--json') ? jsonResult('daemon stop', { ...result, was_running: true }) : 'Daemon stopped.\n' + (readJob(paths)
    ? 'The login job is still installed. A new Aside client or the next login can restart the shared daemon.'
    : 'A new Aside client can start the shared daemon again.'), parsed.flags.has('--json'));
}

export async function runDaemon(args: CommandInput): Promise<void> {
  const options = parseCommand('daemon', args);
  if (options.helpText) { console.log(options.helpText); return; }
  const operation = options.operation!;
  const parsed: Parsed = {
    flags: new Set(['--foreground', '--json', '--force'].filter(name => options.has(name))),
  };
  switch (operation) {
    case 'run': return run();
    case 'start': return start(parsed);
    case 'install': return install(parsed);
    case 'uninstall': return uninstall(parsed);
    case 'status': return status(parsed);
    case 'automations': return automations(parsed);
    case 'stop': return stop(parsed);
    default: options.fail(`unknown daemon operation ${operation}`);
  }
}

async function automations(parsed: Parsed): Promise<void> {
  const running = await tryConnect(daemonPaths());
  if (!running) throw new Error('The daemon is not running. Start it with aside daemon start to observe future schedules.');
  let inspection: AutomationInspection;
  try { inspection = await running.peer.request('automation.status'); }
  finally { running.peer.close(); }
  const json = parsed.flags.has('--json');
  const text = [
    ...(inspection.warning ? [inspection.warning] : []),
    ...inspection.jobs.map(job => [
      `${job.key}\n  ${job.error ? `error: ${job.error}` : `next: ${job.next ?? 'none'}${job.running ? '; running' : ''}${job.pending ? `; queued: ${job.pending}` : ''}`}`,
      ...(inspection.modelWarnings ?? []).filter(warning => warning.key === job.key).map(warning => `  warning: ${warning.message}`),
    ].join('\n')),
    `${inspection.jobs.length} automation(s).`,
    ...inspection.runs.slice(0, 10).map(run => `${run.occurrence} ${run.status} ${run.definedIn}\n  ${run.directory}${run.error ? `\n  ${run.error}` : ''}`),
  ].join('\n');
  writeOutput(json ? jsonResult('daemon automations', inspection) : text, json);
}
