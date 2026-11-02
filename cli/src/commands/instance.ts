// Manage the shared known-instance registry without starting the daemon.
import { DAEMON_COMMAND_LOCK_TIMEOUT_MS } from '../core/system-config.js';
import { parseCommand, type CommandInput } from './options.js';
import { publishReport } from './output.js';
import { instanceIdClashChecks } from './instance-checks.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { isAsideDir, readManifestResult, shouldRetainKnownInstance, InstancePathError } from '../core/instance.js';
import { collectKnownFile, readKnownFile, writeKnown } from '../daemon/daemon.js';
import { tryConnect } from '../daemon/client.js';
import { daemonPaths, ensureDirs } from '../daemon/paths.js';
import { FileLock, isLocked } from '../daemon/filelock.js';
import { instanceKey } from '../daemon/host.js';
import type { KnownEditResult, Status } from '../daemon/protocol.js';
import { runValidate } from './validate.js';
import { runInit } from './init.js';
import { withPrimaryInstances, withoutInstanceFamilies } from '../core/worktree.js';

interface Parsed {
  flags: Set<string>;
  paths: string[];
}

// Edit the known list through the daemon when one is running, else directly.
async function editKnown(parsed: Parsed, add: boolean): Promise<void> {
  const paths = daemonPaths();
  ensureDirs(paths);
  let running = await tryConnect(paths);
  let known: string[];
  let changed: string[] | undefined;
  let startLock: FileLock | undefined;
  let lifetimeLock: FileLock | undefined;
  try {
    if (!running) {
      startLock = new FileLock(paths.startLock);
      if (!(await startLock.acquireWait(DAEMON_COMMAND_LOCK_TIMEOUT_MS))) throw new Error('Cannot edit the known list: another process holds the start lock.');
      // A client may have started the daemon while this command waited.
      running = await tryConnect(paths);
      if (!running) {
        // Foreground/supervised daemons can start without the start lock.
        // Hold their lifetime lock through the direct edit, or leave their
        // authoritative registry untouched when they cannot be reached.
        lifetimeLock = new FileLock(paths.lifetimeLock);
        if (!lifetimeLock.tryAcquire()) throw new Error('Cannot edit the known list: the daemon is starting, stopping, or unavailable. No changes were made. Retry the command when the daemon is reachable or has exited.');
      }
    }
    if (running) {
      ({ known, changed } = await running.peer.request<KnownEditResult>(add ? 'known.add' : 'known.forget', { paths: parsed.paths }));
    } else {
      known = readKnownFile(paths);
      const previous = new Set(known.map(instanceKey));
      for (const path of parsed.paths) {
        const key = instanceKey(path);
        if (add) {
          if (!isAsideDir(path)) throw new InstancePathError(`Not an aside instance (no aside.md manifest): ${path}`);
          for (const candidate of withPrimaryInstances([key])) {
            if (!known.some(path => instanceKey(path) === candidate)) known.push(candidate);
          }
        } else {
          known = withoutInstanceFamilies(known, [key]);
        }
      }
      known = known.filter(shouldRetainKnownInstance);
      writeKnown(paths, known);
      const current = new Set(known.map(instanceKey));
      changed = [...new Set(parsed.paths.map(instanceKey))].filter(path => previous.has(path) !== current.has(path));
    }
  } finally {
    running?.peer.close();
    lifetimeLock?.release();
    startLock?.release();
  }
  const results = [...new Set(parsed.paths.map(instanceKey))].map(path => ({ path, registered: add,
    ...(changed ? { changed: changed.includes(path) } : {}) }));
  const operation = add ? 'add' : 'forget';
  publishReport({ title: `Aside instance ${operation} result`, data: { results, instances: knownInstances(known) },
    sections: [{ name: 'Results', entries: results.map(result => ({ path: result.path,
      name: add ? result.changed === false ? 'Already registered' : 'Registered'
        : result.changed === false ? 'Not registered' : 'Forgotten' })) }], checks: [] }, `instance ${operation}`, parsed.flags.has('--json'));
}

function knownInstances(known: string[]) {
  return known.filter(isAsideDir).map(path => ({ path, ...readManifestResult(path).value }));
}

function reportKnown(known: string[], operation: string, json: boolean, unavailable?: Error): void {
  const instances = knownInstances(known);
  publishReport({ title: 'Aside instances', data: { instances }, sections: [{ name: unavailable ? 'Instances (saved registry)' : 'Instances',
    ...(instances.length ? { entries: instances.map(instance => ({ name: instance.name || instance.id || 'Instance', path: instance.path })) }
      : { fields: { Instances: 'none' } }) }], checks: [...(unavailable ? [{ code: 'daemon_connection', label: 'Daemon connection', passed: false, problems: [unavailable.message] }] : []),
      ...instanceIdClashChecks(instances)] }, `instance ${operation}`, json);
}

async function list(parsed: Parsed): Promise<void> {
  const paths = daemonPaths();
  const running = await tryConnect(paths);
  let known: string[];
  let unavailable: Error | undefined;
  if (running) {
    try { known = (await running.peer.request<Status>('status')).known; }
    finally { running.peer.close(); }
  } else {
    if (existsSync(paths.lifetimeLock) && isLocked(paths.lifetimeLock)) {
      unavailable = new Error(`Cannot inspect the shared daemon: its lifetime lock is held but its socket did not answer. It may be starting, stopping, or unavailable.\nSee its log: ${paths.log}\nRetry aside instance list when it is reachable or has exited.`);
    }
    known = collectKnownFile(paths);
  }
  reportKnown(known, 'list', parsed.flags.has('--json'), unavailable);
  if (unavailable) throw unavailable;
}

export async function runInstance(args: CommandInput): Promise<number | void> {
  const options = parseCommand('instance', args);
  if (options.helpText) { console.log(options.helpText); return; }
  const parsed: Parsed = {
    flags: new Set(options.has('--json') ? ['--json'] : []),
    paths: (options.all('--dir') ?? []).map(path => resolve(path)),
  };
  switch (options.operation) {
    case 'init': return runInit(options);
    case 'add': return editKnown(parsed, true);
    case 'forget': return editKnown(parsed, false);
    case 'list': return list(parsed);
    case 'validate': return runValidate(options);
    default: options.fail(`unknown instance operation ${options.operation}`);
  }
}
