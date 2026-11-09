// Manage the shared known-instance registry without starting the daemon.
import { DAEMON_COMMAND_LOCK_TIMEOUT_MS } from '../core/system-config.js';
import { parseCommand, type CommandInput } from './options.js';
import { errorLine, publishReport } from './output.js';
import { instanceIdClashChecks } from './instance-checks.js';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { isAsideDir, readManifestResult, shouldRetainKnownInstance, InstancePathError } from '../core/instance.js';
import { collectKnownFile, readKnownFile, writeKnown } from '../daemon/daemon.js';
import { tryConnect } from '../daemon/client.js';
import { daemonPaths, ensureDirs, type DaemonPaths } from '../daemon/paths.js';
import { FileLock, isLocked } from '../daemon/filelock.js';
import { instanceKey } from '../daemon/host.js';
import type { KnownEditResult, Status } from '../daemon/protocol.js';
import { runValidate } from './validate.js';
import { runInit } from './init.js';
import { withPrimaryInstances, withoutInstanceFamilies } from '../core/worktree.js';
import { SemanticCacheRetention } from '../semantic/cache-retention.js';
import {availableInstances} from '../source/instance-admission.js';
import {type AvailableInstance} from '../core/catalogue.js';
import type {Manifest} from '../core/types.js';

type InstanceCatalogueEntry = AvailableInstance & {manifest: Manifest};

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
  let requested: string[];
  let instances: InstanceCatalogueEntry[] | undefined;
  const clearCache = !add && parsed.flags.has('--clear-cache');
  let cache: KnownEditResult['cache'];
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
      ({ known, changed, cache, requested } = await running.peer.request<KnownEditResult>(add ? 'known.add' : 'known.forget', {
        paths: parsed.paths, ...(clearCache ? {clearCache: true} : {}),
      }));
      if (!Array.isArray(requested) || requested.some(path => typeof path !== 'string' || !isAbsolute(path))) {
        throw new Error('The daemon did not return canonical instance paths for the registration receipt. Restart the daemon with the current CLI.');
      }
      if (clearCache && (!Array.isArray(cache?.clearRequested)
        || requested.some(path => !cache!.clearRequested.includes(path)))) {
        throw new Error('The instance registration was updated, but the daemon did not confirm the semantic cache clear request. Restart the daemon with the current CLI, then repeat instance forget --clear-cache for these paths.');
      }
      instances = await running.peer.request<InstanceCatalogueEntry[]>('instances', {manifests: true});
      if (!Array.isArray(instances)) throw new Error('Daemon instance catalogue is unavailable.');
      instances = orderedInstances(instances, known);
    } else {
      requested = [...new Set(parsed.paths.map(instanceKey))];
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
      const explicitlyRetained = new Set(known.map(instanceKey));
      const explicitlyForgotten = add ? [] : [...new Set([
        ...[...previous].filter(path => !explicitlyRetained.has(path)), ...parsed.paths.map(instanceKey),
      ])];
      known = known.filter(shouldRetainKnownInstance);
      const current = new Set(known.map(instanceKey));
      const autoPruned = [...explicitlyRetained].filter(path => !current.has(path));
      const retention = new SemanticCacheRetention({indexRoot: join(paths.state, 'search')});
      await retention.forget(autoPruned, false);
      if (add) await retention.register(known);
      else {
        await retention.forget(explicitlyForgotten, clearCache);
        if (clearCache) cache = {clearRequested: explicitlyForgotten};
      }
      writeKnown(paths, known);
      await retention.collect(known).catch(error => {
        console.error(errorLine(new Error(`Semantic cache cleanup is pending: ${error instanceof Error ? error.message : String(error)}`)));
      });
      changed = [...new Set(parsed.paths.map(instanceKey))].filter(path => previous.has(path) !== current.has(path));
    }
  } finally {
    running?.peer.close();
    lifetimeLock?.release();
    startLock?.release();
  }
  const results = [...new Set(requested)].map(path => ({ path, registered: add,
    ...(changed ? { changed: changed.includes(path) } : {}) }));
  const operation = add ? 'add' : 'forget';
  publishReport({ title: `Aside instance ${operation} result`, data: { results, instances: instanceMetadata(instances ?? readOfflineInstanceCatalogue(known)), ...(clearCache ? {cache} : {}) },
    sections: [{ name: 'Results', entries: results.map(result => ({ path: result.path,
      name: add ? result.changed === false ? 'Already registered' : 'Registered'
        : result.changed === false ? 'Not registered' : 'Forgotten',
      ...(clearCache ? {fields: {'Semantic cache': 'Clear requested; removal waits for active use to finish'}} : {}) })) }], checks: [] }, `instance ${operation}`, parsed.flags.has('--json'));
}

function instanceMetadata(instances: readonly InstanceCatalogueEntry[]) {
  return instances.map(({path, manifest}) => {
    if (!manifest) throw new Error('Daemon-published instance manifest is unavailable.');
    return {path, ...manifest};
  });
}

function orderedInstances(instances: InstanceCatalogueEntry[], known: string[]): InstanceCatalogueEntry[] {
  const byPath = new Map(instances.map(instance => [instance.path, instance]));
  return [...new Set(known)].flatMap(path => byPath.has(path) ? [byPath.get(path)!] : []);
}

function readOfflineInstanceCatalogue(known: string[]): InstanceCatalogueEntry[] {
  return availableInstances(known).map(instance => ({...instance, manifest: readManifestResult(instance.path).value}));
}

function reportKnown(catalogue: InstanceCatalogueEntry[], operation: string, json: boolean, unavailable?: Error): void {
  const instances = instanceMetadata(catalogue);
  publishReport({ title: 'Aside instances', data: { instances }, sections: [{ name: unavailable ? 'Instances (saved registry)' : 'Instances',
    ...(instances.length ? { entries: instances.map(instance => ({ name: instance.name || instance.id || 'Instance', path: instance.path })) }
      : { fields: { Instances: 'none' } }) }], checks: [...(unavailable ? [{ code: 'daemon_connection', label: 'Daemon connection', passed: false, problems: [unavailable.message] }] : []),
      ...instanceIdClashChecks(catalogue)] }, `instance ${operation}`, json);
}

async function collectOfflineCaches(paths: DaemonPaths): Promise<void> {
  if (!existsSync(join(paths.state, 'search'))) return;
  const start = new FileLock(paths.startLock), lifetime = new FileLock(paths.lifetimeLock);
  try {
    // A daemon can start after the registry collector releases its locks.
    // Never reclaim native storage without independently owning both gates.
    if (!start.tryAcquire() || !lifetime.tryAcquire()) return;
    let registered: unknown;
    try { registered = JSON.parse(readFileSync(paths.known, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      registered = [];
    }
    // A broken registry cannot establish that a cache is unregistered.
    if (!Array.isArray(registered) || registered.some(path => typeof path !== 'string')) return;
    await new SemanticCacheRetention({indexRoot: join(paths.state, 'search')}).collect(registered.map(instanceKey));
  } finally { lifetime.release(); start.release(); }
}

async function list(parsed: Parsed): Promise<void> {
  const paths = daemonPaths();
  const running = await tryConnect(paths);
  let instances: InstanceCatalogueEntry[];
  let unavailable: Error | undefined;
  if (running) {
    try {
      const [status, catalogue] = await Promise.all([
        running.peer.request<Status>('status'), running.peer.request<InstanceCatalogueEntry[]>('instances', {manifests: true}),
      ]);
      if (!Array.isArray(catalogue)) throw new Error('Daemon instance catalogue is unavailable.');
      instances = orderedInstances(catalogue, status.known);
    }
    finally { running.peer.close(); }
  } else {
    if (existsSync(paths.lifetimeLock) && isLocked(paths.lifetimeLock)) {
      unavailable = new Error(`Cannot inspect the shared daemon: its lifetime lock is held but its socket did not answer. It may be starting, stopping, or unavailable.\nSee its log: ${paths.log}\nRetry aside instance list when it is reachable or has exited.`);
    }
    instances = readOfflineInstanceCatalogue(collectKnownFile(paths));
    if (!unavailable) await collectOfflineCaches(paths);
  }
  reportKnown(instances, 'list', parsed.flags.has('--json'), unavailable);
  if (unavailable) throw unavailable;
}

export async function runInstance(args: CommandInput): Promise<number | void> {
  const options = parseCommand('instance', args);
  if (options.helpText) { console.log(options.helpText); return; }
  const parsed: Parsed = {
    flags: new Set(['--json', '--clear-cache'].filter(flag => options.has(flag))),
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
