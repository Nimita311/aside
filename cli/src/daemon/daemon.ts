import { DAEMON_REQUEST_DRAIN_TIMEOUT_MS, DAEMON_DRAIN_POLL_INTERVAL_MS, DIAGNOSTIC_CLEANUP_INTERVAL_MS } from '../core/system-config.js';
// The daemon process: one per user, serving every agent session and CLI
// command over a Unix socket (see design/daemon.md).
import { z } from 'zod';
import { validateToolArgs } from '../mcp/schemas.js';
import net from 'node:net';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { availableInstances, pickInstance, registrationPath } from '../web/catalogue.js';
import { isAsideDir, shouldRetainKnownInstance } from '../core/instance.js';
import { withPrimaryInstances, withoutInstanceFamilies } from '../core/worktree.js';
import { daemonPaths, ensureDirs, type DaemonPaths } from './paths.js';
import { FileLock } from './filelock.js';
import { Peer, RpcFailure, ERR_METHOD_NOT_FOUND, ERR_SHUTTING_DOWN } from './jsonrpc.js';
import { InstanceHost, instanceKey } from './host.js';
import { InstanceRegistry } from '../mcp/instance-registry.js';
import { InstanceSession } from '../mcp/instance-session.js';
import { ownHello, type HelloResult, type Status, type StopResult, type KnownEditResult } from './protocol.js';

const graphqlSessionSchema = z.object({
  workspace: z.array(z.string()), encountered: z.array(z.string()), active: z.string().nullable(), discovery: z.boolean(), cwd: z.string(),
  configIssues: z.array(z.object({
    severity: z.enum(['error', 'warning']), code: z.string(), message: z.string(), field: z.string().optional(), file: z.string().optional(),
  }).strict()),
}).strict();

export interface DaemonOptions {
  paths?: DaemonPaths;
  host?: InstanceHost;
  // Isolated in-process tests may bind an ephemeral port.
  webPort?: number;
  picker?: typeof pickInstance;
  // Called once the daemon has shut down; the process entry point exits here.
  onExit?: () => void;
}

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

export class Daemon {
  readonly paths: DaemonPaths;
  private host: InstanceHost;
  private lock: FileLock;
  private server: net.Server | null = null;
  private known: string[] = [];
  // Each connection and the instances it has used.
  private connections = new Map<Peer, Set<string>>();
  private querySignals = new WeakMap<Peer, AbortController>();
  private active = 0;
  private stopping: Promise<void> | null = null;
  private onExit: (() => void) | undefined;
  private diagnosticTimer?: ReturnType<typeof setInterval>;
  private diagnosticWork?: Promise<void>;

  constructor(options: DaemonOptions = {}) {
    this.paths = options.paths ?? daemonPaths();
    this.host = options.host ?? new InstanceHost();
    this.host.configureUsage(this.paths.logs);
    this.onExit = options.onExit;
    this.lock = new FileLock(this.paths.lifetimeLock);
    this.host.onTabsChanged = () => this.reconsider();
    this.host.setKnownPaths(() => this.known);
    this.host.configureWeb({
      pick: kind => (options.picker ?? pickInstance)(kind),
      summary: path => this.host.summary(path),
      instances: () => {
        this.pruneKnown();
        return availableInstances(this.known).map(instance => {
          const warning = this.host.calendarWarning(instance.path);
          return warning ? { ...instance, calendarWarning: warning } : instance;
        });
      },
      register: async selection => {
        const selected = 'path' in selection
          ? selection.path === '~' ? homedir() : selection.path.startsWith('~/') ? resolve(homedir(), selection.path.slice(2)) : selection.path
          : await (options.picker ?? pickInstance)(selection.kind);
        if (selected === null) return null;
        const path = registrationPath(selected);
        this.note(path);
        this.reconsider();
        return availableInstances(this.known).find(instance => instance.path === path)!;
      },
      remove: path => { this.editKnown([path], false); },
      query: (path, args, signal) => this.host.webQuery(path, args, signal),
      data: async (path, refresh) => {
        try { const data = await this.host.data(path, refresh); this.reconsider(); return data; }
        catch (error) { this.pruneKnown(); throw error; }
      },
      load: path => {
        try { this.host.load(path); this.reconsider(); }
        catch (error) { this.pruneKnown(); throw error; }
      },
    }, options.webPort, this.paths.state);
  }

  // Take the lifetime lock and start serving. False when another daemon holds
  // the lock — two daemons never serve the same user.
  async listen(): Promise<boolean> {
    ensureDirs(this.paths);
    if (!this.lock.tryAcquire()) return false;
    try { unlinkSync(this.paths.socket); } catch {}
    this.host.configureAutomation(join(this.paths.state, 'automation'));
    await this.cleanupDiagnostics();
    this.known = this.readKnown();
    this.host.refreshIdentities();
    this.loadKnown();
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(this.paths.socket, () => done());
    });
    try { chmodSync(this.paths.socket, 0o600); } catch {}
    log(`daemon listening (pid ${process.pid})`);
    // A daemon replacement restores the same origin so existing tabs can
    // reconnect without another show/serve call. Missing bundles and occupied
    // ports leave other daemon operations available; show reports them.
    await this.host.web().catch(error => log(`web server unavailable: ${(error as Error).message}`));
    if (!this.stopping) {
      this.diagnosticTimer = setInterval(() => void this.cleanupDiagnostics(), DIAGNOSTIC_CLEANUP_INTERVAL_MS);
      this.diagnosticTimer.unref?.();
    }
    this.reconsider();
    return true;
  }

  private cleanupDiagnostics(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.diagnosticWork) return this.diagnosticWork;
    const work = this.host.cleanupDiagnostics().then(() => {}, error => log(`diagnostic cleanup error: ${(error as Error).message}`));
    this.diagnosticWork = work;
    void work.finally(() => { if (this.diagnosticWork === work) this.diagnosticWork = undefined; });
    return work;
  }

  private accept(socket: net.Socket): void {
    const peer: Peer = new Peer(socket, (method, params) => this.handle(peer, method, params));
    this.connections.set(peer, new Set());
    this.querySignals.set(peer, new AbortController());
    peer.onClose(() => {
      this.querySignals.get(peer)?.abort();
      this.connections.delete(peer);
      this.reconsider();
    });
  }

  private async handle(peer: Peer, method: string, params: any): Promise<unknown> {
    // The fixed core answers even while shutting down.
    if (method === 'hello') return this.hello();
    if (this.stopping) throw new RpcFailure('The aside daemon is shutting down.', ERR_SHUTTING_DOWN);
    if (method === 'shutdown') {
      setImmediate(() => void this.shutdown());
      return {};
    }
    this.active++;
    try {
      return await this.dispatch(peer, method, params);
    } catch (error) {
      this.pruneKnown();
      throw error;
    } finally {
      this.active--;
    }
  }

  private async dispatch(peer: Peer, method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'status': return this.status();
      case 'automation.status': return this.host.automationStatus();
      case 'diagnostics.purge': {
        params = z.object({root: z.string().refine(isAbsolute, 'Instance path must be absolute').optional()}).strict().parse(params);
        return this.host.purgeDiagnostics(params.root === undefined ? undefined : instanceKey(params.root));
      }
      case 'stop': return this.stop(peer);
      case 'known.add': return this.editKnown(params.paths, true);
      case 'known.forget': return this.editKnown(params.paths, false);
      case 'instance.info': {
        const path = this.use(peer, params.instance);
        return { issues: this.host.issues(path) };
      }
      case 'tool': {
        params = z.object({ instance: z.string().nullable().optional(), name: z.string(), args: z.unknown().optional(), issues: z.boolean().optional() }).strict().parse(params);
        params.args = validateToolArgs(params.name, params.args);
        const path = params.instance == null ? null : this.use(peer, params.instance);
        return this.host.tool(path, params.name, params.args, params.issues === true, this.querySignals.get(peer)?.signal);
      }
      case 'graphql':
      case 'graphql.schema': {
        const schemaRead = method === 'graphql.schema';
        params = (schemaRead ? z.object({session: graphqlSessionSchema}).strict() : z.object({
          mode: z.enum(['query', 'mutation']), args: z.unknown(),
          session: graphqlSessionSchema,
        }).strict()).parse(params);
        if (!schemaRead) params.args = validateToolArgs(params.mode === 'query' ? 'query' : 'mutate', params.args);
        this.pruneKnown();
        const registry = new InstanceRegistry();
        registry.restore(params.session);
        const session = new InstanceSession(registry, {
          knownInstances: async () => this.status().known,
          issues: async path => this.host.issues(this.use(peer, path)),
        }, params.session.configIssues, params.session.discovery, true, params.session.cwd);
        const result = schemaRead
          ? await this.host.graphqlSchema(session, this.querySignals.get(peer)?.signal)
          : await this.host.graphql(session, params.mode, params.args, this.querySignals.get(peer)?.signal, path => this.use(peer, path));
        return { result, session: session.state() };
      }
      case 'show': {
        params = z.object({ instance: z.string(), args: z.unknown().optional(), appDir: z.string().optional(), navigate: z.boolean().optional() }).strict().parse(params);
        params.args = validateToolArgs('show', params.args);
        const path = this.use(peer, params.instance);
        return this.host.show(path, params.args ?? {}, params.appDir, params.navigate !== false);
      }
      case 'serve': {
        params = z.object({ instance: z.string().optional(), appDir: z.string().optional(), navigate: z.boolean().optional() }).strict().parse(params);
        return params.instance
          ? this.host.show(this.use(peer, params.instance), {}, params.appDir, params.navigate !== false)
          : this.host.serve(params.appDir, params.navigate !== false);
      }
      default: throw new RpcFailure(`unknown method ${method}`, ERR_METHOD_NOT_FOUND);
    }
  }

  private hello(): HelloResult {
    return { ...ownHello(), pid: process.pid };
  }

  private status(): Status {
    this.pruneKnown();
    return {
      ...this.hello(),
      connections: this.connections.size,
      tabs: this.host.tabCount(),
      known: this.known.filter(isAsideDir),
      loaded: this.host.loadedPaths().filter(isAsideDir),
      graphqlLogging: this.host.usageStatus(),
      sessions: Object.fromEntries(this.host.loadedPaths().filter(isAsideDir).map(path => [path,
        [...this.connections.values()].filter(used => used.has(instanceKey(path))).length])),
    };
  }

  // Record that a connection uses an instance and register it for ongoing sync.
  private use(peer: Peer, instance: unknown): string {
    if (typeof instance !== 'string' || instance === '') throw new Error('No instance named for this operation.');
    const path = instanceKey(instance);
    this.host.load(path);
    this.note(path);
    const key = instanceKey(path);
    this.connections.get(peer)?.add(key);
    return path;
  }

  // A busy stop is a refusal, with no deferred exit.
  private stop(peer: Peer): StopResult {
    this.pruneKnown();
    const others = [...this.connections].filter(([connection]) => connection !== peer);
    const connections = others.length;
    const tabs = this.host.tabCount();
    if (connections === 0 && tabs === 0) {
      setImmediate(() => void this.shutdown());
      return { stopped: true, connections, tabs, instances: [] };
    }
    const used = new Set(others.flatMap(([, instances]) => [...instances]));
    const instances = this.host.loaded()
      .filter(instance => instance.tabs > 0 || used.has(instance.key))
      .map(instance => instance.path).filter(isAsideDir);
    return { stopped: false, connections, tabs, instances };
  }

  private loadKnown(): void {
    for (const path of [...this.known]) {
      try {
        const canonical = instanceKey(path);
        if (!isAsideDir(canonical)) throw new Error(`Not an aside instance (no aside.md manifest): ${canonical}`);
        this.host.load(path);
        this.note(canonical, false);
      } catch (e) {
        this.pruneKnown();
        log(`cannot load ${path}: ${(e as Error).message}`);
      }
    }
  }

  // --- known instances ---

  private readKnown(): string[] {
    let stored: unknown;
    try { stored = JSON.parse(readFileSync(this.paths.known, 'utf8')); }
    catch { return []; }
    if (!Array.isArray(stored)) return [];
    const known = [...new Set(stored.filter((path): path is string => typeof path === 'string' && shouldRetainKnownInstance(path)).map(instanceKey))];
    if (JSON.stringify(stored) !== JSON.stringify(known)) writeKnown(this.paths, known);
    return known;
  }

  private saveKnown(): void {
    writeKnown(this.paths, this.known);
  }

  // Drop verified non-instances, preserving unreadable registrations and their
  // identity blockers until repair or an explicit forget.
  private pruneKnown(): void {
    const valid = this.known.filter(shouldRetainKnownInstance);
    if (valid.length !== this.known.length) {
      this.known = valid;
      this.saveKnown();
    }
    for (const { key, path } of this.host.loaded()) {
      if (shouldRetainKnownInstance(path)) continue;
      this.host.unloadKey(key);
    }
    for (const used of this.connections.values()) {
      for (const path of used) if (!shouldRetainKnownInstance(path)) used.delete(path);
    }
    this.host.refreshIdentities();
  }

  private note(path: string, includePrimary = true): void {
    const added = (includePrimary ? withPrimaryInstances([path]) : [instanceKey(path)]).filter(key => !this.known.some(p => instanceKey(p) === key));
    if (!added.length) return;
    this.known.push(...added);
    this.saveKnown();
    this.host.refreshIdentities();
    this.loadKnown();
  }

  private editKnown(paths: unknown, add: boolean): KnownEditResult {
    if (!Array.isArray(paths)) throw new Error('paths must be a list');
    // Validate the whole batch before recording or loading any instance.
    // Otherwise an invalid later path can start syncing earlier additions
    // despite the command reporting failure.
    const resolved = paths.map(raw => {
      if (typeof raw !== 'string' || !raw) throw new Error('paths must contain nonempty path strings');
      const path = resolve(raw);
      if (add && !isAsideDir(path)) throw new Error(`Not an aside instance (no aside.md manifest): ${path}`);
      return instanceKey(path);
    });
    const previous = new Set(this.known.map(instanceKey));
    let known = add ? [...this.known] : withoutInstanceFamilies(this.known, resolved);
    for (const path of add ? withPrimaryInstances(resolved) : resolved) {
      const key = instanceKey(path);
      if (add) {
        if (!known.some(p => instanceKey(p) === key)) known.push(path);
      } else {
        known = known.filter(p => instanceKey(p) !== key);
      }
    }
    known = known.filter(shouldRetainKnownInstance);
    writeKnown(this.paths, known);
    this.known = known;
    this.host.refreshIdentities();
    this.loadKnown();
    this.reconsider();
    this.pruneKnown();
    const current = new Set(this.known.map(instanceKey));
    return { known: this.known.filter(isAsideDir),
      changed: [...new Set(resolved)].filter(path => previous.has(path) !== current.has(path)) };
  }

  // Unload forgotten instances after their last client or tab disconnects.
  // Every known instance stays loaded even when no clients are connected.
  private reconsider(): void {
    if (this.stopping) return;
    const inUse = new Set(this.known.map(instanceKey));
    for (const used of this.connections.values()) for (const key of used) inUse.add(key);
    for (const { key, tabs } of this.host.loaded()) {
      if (!inUse.has(key) && tabs === 0) this.host.unloadKey(key);
    }
  }

  // Stop serving new work, flush pending calendar work, finish in-flight
  // requests, and exit.
  shutdown(): Promise<void> {
    this.stopping ??= (async () => {
      log('daemon shutting down');
      clearInterval(this.diagnosticTimer);
      // Whatever fails on the way out, the socket and the lock are released.
      try {
        for (const peer of this.connections.keys()) peer.notify('shutting-down');
        this.host.stopQueries();
        await this.diagnosticWork;
        await this.host.stopAutomation();
        const deadline = Date.now() + DAEMON_REQUEST_DRAIN_TIMEOUT_MS;
        while (this.active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, DAEMON_DRAIN_POLL_INTERVAL_MS));
        await this.host.flush();
        await this.host.close();
      } catch (e) {
        log(`shutdown error: ${(e as Error).message}`);
      } finally {
        for (const peer of this.connections.keys()) peer.close();
        const server = this.server;
        if (server) await new Promise<void>((done) => server.close(() => done()));
        try { unlinkSync(this.paths.socket); } catch {}
        this.lock.release();
        this.onExit?.();
      }
    })();
    return this.stopping;
  }
}

// The known-instances list, as stored. The daemon owns it while running; the
// CLI edits it directly only when no daemon is.
export function readKnownFile(paths: DaemonPaths): string[] {
  try {
    const value = JSON.parse(readFileSync(paths.known, 'utf8'));
    return Array.isArray(value) ? [...new Set(value.filter((p): p is string => typeof p === 'string').map(instanceKey))] : [];
  } catch {
    return [];
  }
}

// No daemon owns the registry here. Re-read under both locks before pruning,
// and never overwrite a foreground daemon or a competing CLI registry edit.
export function collectKnownFile(paths: DaemonPaths): string[] {
  if (!existsSync(paths.known)) return [];
  const start = new FileLock(paths.startLock), lifetime = new FileLock(paths.lifetimeLock);
  try {
    if (start.tryAcquire() && lifetime.tryAcquire()) {
      const known = readKnownFile(paths);
      const retained = known.filter(shouldRetainKnownInstance);
      if (retained.length !== known.length) writeKnown(paths, retained);
    }
  } finally { lifetime.release(); start.release(); }
  return readKnownFile(paths).filter(isAsideDir);
}

export function writeKnown(paths: DaemonPaths, known: string[]): void {
  const tmp = `${paths.known}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...new Set(known.map(instanceKey))], null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, paths.known);
}
