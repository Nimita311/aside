import { DAEMON_REQUEST_DRAIN_TIMEOUT_MS, DAEMON_DRAIN_POLL_INTERVAL_MS, DIAGNOSTIC_CLEANUP_INTERVAL_MS, MINUTE_MS } from '../core/system-config.js';
// The daemon process: one per user, serving every agent session and CLI
// command over a Unix socket (see design/runtime.md).
import { z } from 'zod';
import { daemonBackend } from '../mcp/server.js';
import { DaemonClient } from './client.js';
import { validateToolArgs } from '../mcp/schemas.js';
import net from 'node:net';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import {pickInstance} from '../web/picker.js';
import {registrationPath} from '../source/instance-admission.js';
import {InstancePathError, isAsideDir, shouldRetainKnownInstance} from '../core/instance.js';
import { withPrimaryInstances, withoutInstanceFamilies } from '../core/worktree.js';
import { instanceFamilyKey } from '../core/catalogue.js';
import { daemonPaths, ensureDirs, type DaemonPaths } from './paths.js';
import { FileLock } from './filelock.js';
import { Peer, RpcFailure, ERR_METHOD_NOT_FOUND, ERR_SHUTTING_DOWN } from './jsonrpc.js';
import { InstanceHost, instanceKey } from './host.js';
import { InstanceRegistry } from '../mcp/instance-registry.js';
import { InstanceSession } from '../mcp/instance-session.js';
import { ownHello, type HelloResult, type Status, type StopResult, type KnownEditResult } from './protocol.js';
import { collectSystemDaemon } from '../graphql/system-daemon.js';
import { SemanticCacheRetention } from '../semantic/cache-retention.js';
import {InstanceOperationError} from '../core/instance-operation-error.js';
import { errorMessage } from '../core/error.js';

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
  private cacheRegistryReadable = true;
  // Each connection and the instances it has used.
  private connections = new Map<Peer, Set<string>>();
  private querySignals = new WeakMap<Peer, AbortController>();
  private active = 0;
  private stopping: Promise<void> | null = null;
  private onExit: (() => void) | undefined;
  private diagnosticTimer?: ReturnType<typeof setInterval>;
  private registryTimer?: ReturnType<typeof setInterval>;
  private registryCheck?: ReturnType<typeof setTimeout>;
  private diagnosticWork?: Promise<void>;
  private knownLoadRetry?: ReturnType<typeof setTimeout>;
  private knownLoadFailures = 0;
  private readonly semanticCaches: SemanticCacheRetention;
  private cacheWork: Promise<void> = Promise.resolve();
  private cacheCollection?: Promise<void>;
  private cacheCollectionAgain = false;

  constructor(options: DaemonOptions = {}) {
    this.paths = options.paths ?? daemonPaths();
    this.host = options.host ?? new InstanceHost();
    this.semanticCaches = new SemanticCacheRetention({indexRoot: join(this.paths.state, 'search')});
    this.host.configureSemanticLifecycle(() => this.known, async store => {
      // Registration may follow a forget whose asynchronous deletion is still
      // queued. Drain it before any new index work can reuse the directory.
      await this.cacheWork.catch(() => {});
      if (!this.known.includes(store.getDataDir())) throw new Error('Instance is no longer registered for semantic search.');
      await this.semanticCaches.register([store.getDataDir()]);
    });
    this.host.configureUsage(this.paths.logs);
    this.host.configureSystemDaemon(() => collectSystemDaemon(this.paths, {
      pid: process.pid, connections: this.connections.size, tabs: this.host.tabCount(), graphqlLogging: this.host.usageStatus(),
    }));
    this.onExit = options.onExit;
    this.lock = new FileLock(this.paths.lifetimeLock);
    this.host.onTabsChanged = () => this.reconsider();
    this.host.setKnownPaths(() => this.known);
    this.host.configureWeb({
      mcp: () => daemonBackend(new DaemonClient({ paths: this.paths, startIfMissing: false })),
      pick: kind => (options.picker ?? pickInstance)(kind),
      summary: path => this.host.summary(path),
      years: path => this.host.years(path),
      subscribe: (path, changed) => this.host.subscribe(path, changed),
      instances: () => this.host.availableInstances(this.known),
      register: async selection => {
        const selected = 'path' in selection
          ? selection.path === '~' ? homedir() : selection.path.startsWith('~/') ? resolve(homedir(), selection.path.slice(2)) : selection.path
          : await (options.picker ?? pickInstance)(selection.kind);
        if (selected === null) return null;
        const path = registrationPath(selected);
        this.note(path);
        this.reconsider();
        return this.host.availableInstances(this.known).find(instance => instance.path === path)!;
      },
      remove: async (path, clearCache) => { await this.editKnown([path], false, clearCache); },
      query: (path, args, signal) => this.host.webQuery(path, args, signal),
      updateSidebar: async (path, sidebar, expectedSidebar) => { this.host.updateSidebar(path, sidebar, expectedSidebar); },
      data: async (path, refresh) => {
        try { const data = await this.host.data(path, refresh); this.reconsider(); return data; }
        catch (error) { if (error instanceof InstancePathError) this.requestRegistryCheck(); throw error; }
      },
      load: path => {
        try { this.host.load(path); this.reconsider(); }
        catch (error) { if (error instanceof InstancePathError) this.requestRegistryCheck(); throw error; }
      },
    }, options.webPort);
  }

  // Take the lifetime lock and start serving. False when another daemon holds
  // the lock — two daemons never serve the same user.
  async listen(): Promise<boolean> {
    ensureDirs(this.paths);
    if (!this.lock.tryAcquire()) return false;
    try { unlinkSync(this.paths.socket); } catch {}
    this.host.configureSemantic({indexRoot: join(this.paths.state, 'search')});
    this.host.configureAutomation(join(this.paths.state, 'automation'));
    await this.cleanupDiagnostics();
    this.known = this.readKnown();
    await this.cacheOperation(async () => {
      await this.semanticCaches.register(this.known);
      if (this.cacheRegistryReadable) await this.semanticCaches.collect(() => this.known);
    }).catch(() => {});
    this.refreshRegistrations();
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
      // Registration/source drift is background lifecycle work, not a check
      // repeated before each normal content query. Cache collection stays lazy.
      this.registryTimer = setInterval(() => this.reconcileKnown(), MINUTE_MS);
      this.registryTimer.unref?.();
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

  private cacheOperation(operation: () => Promise<void>): Promise<void> {
    const work = this.cacheWork.catch(() => {}).then(operation);
    this.cacheWork = work;
    void work.catch(error => log(`semantic cache cleanup error: ${(error as Error).message}`));
    return work;
  }

  private collectSemanticCaches(): Promise<void> {
    if (this.stopping || !this.cacheRegistryReadable) return Promise.resolve();
    if (this.cacheCollection) {
      this.cacheCollectionAgain = true;
      return this.cacheCollection;
    }
    const work = this.cacheOperation(() => this.semanticCaches.collect(
      () => this.known, () => this.host.loadedPaths()));
    this.cacheCollection = work;
    const finished = () => {
      if (this.cacheCollection !== work) return;
      this.cacheCollection = undefined;
      if (this.cacheCollectionAgain) {
        this.cacheCollectionAgain = false;
        void this.collectSemanticCaches();
      }
    };
    void work.then(finished, finished);
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
      if (error instanceof InstancePathError) this.requestRegistryCheck();
      throw error;
    } finally {
      this.active--;
    }
  }

  private async dispatch(peer: Peer, method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'status': return this.status();
      case 'registry.reconcile': {
        z.object({}).strict().optional().parse(params);
        this.reconcileKnown();
        return {};
      }
      case 'instances': {
        const options = z.object({paths: z.array(z.string().min(1).refine(isAbsolute, 'Instance path must be absolute')).optional(), manifests: z.boolean().optional()})
          .strict().optional().parse(params);
        const requested = options?.paths ?? [];
        const candidates = [...new Set(requested.map(path => this.canonical(path)))];
        if (candidates.length) this.host.observeInstances(candidates);
        const instances = this.host.availableInstances([...new Set([...this.known, ...candidates])]);
        if (!options?.manifests) return instances;
        return instances.map(instance => ({...instance,
          manifest: JSON.parse(JSON.stringify(this.host.metadata(instance.path).value.manifest)),
        }));
      }
      case 'automation.status': return this.host.automationStatus();
      case 'diagnostics.purge': {
        params = z.object({root: z.string().refine(isAbsolute, 'Instance path must be absolute').optional()}).strict().parse(params);
        return this.host.purgeDiagnostics(params.root === undefined ? undefined : instanceKey(params.root));
      }
      case 'stop': return this.stop(peer);
      case 'known.add': return this.editKnown(params.paths, true);
      case 'known.forget': {
        if (params.clearCache !== undefined && typeof params.clearCache !== 'boolean') throw new Error('clearCache must be a boolean');
        return this.editKnown(params.paths, false, params.clearCache === true);
      }
      case 'instance.info': {
        const path = this.use(peer, params.instance);
        return { issues: this.host.issues(path) };
      }
      case 'instance.bootstrap': {
        const {input} = z.object({input: z.unknown()}).strict().parse(params);
        const values = validateToolArgs('create_instance', input) as import('../source/bootstrap.js').InitOptions & {path: string};
        if (!isAbsolute(values.path)) throw new Error('Instance path must be absolute');
        return this.host.bootstrapInstance(values);
      }
      case 'tool': {
        params = z.object({ instance: z.string(), name: z.string(), args: z.unknown().optional() }).strict().parse(params);
        params.args = validateToolArgs(params.name, params.args);
        return this.host.tool(this.use(peer, params.instance), params.name, params.args, this.querySignals.get(peer)?.signal);
      }
      case 'graphql':
      case 'graphql.schema': {
        const schemaRead = method === 'graphql.schema';
        params = (schemaRead ? z.object({session: graphqlSessionSchema}).strict() : z.object({
          mode: z.enum(['query', 'mutation']), args: z.unknown(),
          session: graphqlSessionSchema, navigationOrigin: z.string().url().optional(),
        }).strict()).parse(params);
        if (!schemaRead) params.args = validateToolArgs(params.mode === 'query' ? 'query' : 'mutate', params.args);
        const registry = new InstanceRegistry();
        registry.restore({...params.session,
          workspace: params.session.workspace.map((path: string) => this.canonical(path)),
          encountered: params.session.encountered.map((path: string) => this.canonical(path)),
          active: params.session.active === null ? null : this.canonical(params.session.active)});
        let reconciled = false;
        const session = new InstanceSession(registry, {
          knownInstances: async () => this.host.availableInstances(this.known).map(instance => instance.path),
          admitInstance: async path => this.admitInstance(peer, path),
          createInstance: async input => this.host.createInstance(input, async (path, options) => this.created(peer, path, options)),
          reconcile: () => {
            if (reconciled) return;
            reconciled = true;
            this.host.observeInstances(registry.all());
            registry.reconcile([...this.known, ...this.host.loadedPaths(),
              ...this.host.availableInstances(registry.all()).map(instance => instance.path),
              ...registry.all().filter(path => this.host.metadata(path).issues.some(issue => issue.code === 'read_error'))]);
          },
          family: path => instanceFamilyKey(this.host.availableInstances([path])[0]?.worktree, path),
        }, params.session.configIssues, params.session.discovery, params.session.cwd);
        const result = schemaRead
          ? await this.host.graphqlSchema(session, this.querySignals.get(peer)?.signal)
          : await this.host.graphql(session, params.mode, params.args, this.querySignals.get(peer)?.signal, path => this.use(peer, path), () => this.requestRegistryCheck(), params.navigationOrigin);
        return { result, session: session.state() };
      }
      case 'show': {
        params = z.object({ instance: z.string(), args: z.unknown().optional(), appDir: z.string().optional() }).strict().parse(params);
        params.args = validateToolArgs('show', params.args);
        const path = this.use(peer, params.instance);
        return this.host.show(path, params.args ?? {}, params.appDir);
      }
      case 'serve': {
        params = z.object({ instance: z.string().optional(), appDir: z.string().optional() }).strict().parse(params);
        return params.instance
          ? this.host.show(this.use(peer, params.instance), {}, params.appDir)
          : this.host.serve(params.appDir);
      }
      default: throw new RpcFailure(`unknown method ${method}`, ERR_METHOD_NOT_FOUND);
    }
  }

  private hello(): HelloResult {
    return { ...ownHello(), pid: process.pid };
  }

  private status(): Status {
    const loaded = this.host.loadedPaths();
    const visible = new Set(this.host.availableInstances([...this.known, ...loaded]).map(instance => instance.path));
    const known = this.known.filter(path => visible.has(path));
    const availableLoaded = loaded.filter(path => visible.has(path));
    return {
      ...this.hello(),
      connections: this.connections.size,
      tabs: this.host.tabCount(),
      known,
      loaded: availableLoaded,
      graphqlLogging: this.host.usageStatus(),
      sessions: Object.fromEntries(availableLoaded.map(path => [path,
        [...this.connections.values()].filter(used => used.has(path)).length])),
    };
  }

  // Record that a connection uses an instance and register it for ongoing sync.
  private claim(peer: Peer, path: string): void {
    this.note(path);
    this.connections.get(peer)?.add(path);
  }

  private admitInstance(peer: Peer, path: string) {
    try {
      const result = this.host.admitInstance(this.canonical(path));
      this.claim(peer, result.path);
      return result;
    } catch (error) {
      if (error instanceof InstanceOperationError && error.reason === 'NOT_INSTANCE') this.requestRegistryCheck();
      throw error;
    }
  }

  private use(peer: Peer, instance: unknown): string {
    if (typeof instance !== 'string' || instance === '') throw new Error('No instance named for this operation.');
    const path = this.canonical(instance);
    this.host.load(path);
    this.claim(peer, path);
    return path;
  }

  private created(peer: Peer, path: string, options: {partial?: boolean} = {}) {
    const key = this.canonical(path), issues = this.host.created(key, options);
    if (!options.partial) this.claim(peer, key);
    return issues;
  }

  private canonical(path: string): string {
    const absolute = resolve(path);
    return this.known.includes(absolute) || this.host.loadedPaths().includes(absolute) ? absolute : instanceKey(absolute);
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
    if (this.stopping) return;
    for (const path of [...this.known]) {
      try {
        const canonical = instanceKey(path);
        if (!isAsideDir(canonical)) throw new Error(`Not an aside instance (no aside.md manifest): ${canonical}`);
        if (this.host.isLoaded(canonical)) continue;
        this.host.load(path);
        this.note(canonical, false);
      } catch (e) {
        this.pruneKnown();
        log(`cannot load ${path}: ${(e as Error).message}`);
      }
    }
    this.retryKnownLoads();
  }

  private reconcileKnown(): void {
    if (this.stopping) return;
    try {this.pruneKnown(false); this.loadKnown();}
    catch (error) {
      log(`registration reconciliation error: ${errorMessage(error)}`);
      this.retryKnownLoads();
    }
  }

  private requestRegistryCheck(): void {
    if (this.stopping || this.registryCheck) return;
    this.registryCheck = setTimeout(() => {
      this.registryCheck = undefined;
      this.reconcileKnown();
    }, 0);
    this.registryCheck.unref?.();
  }

  // A retained registration may not have a Store/watcher yet. Retry its load
  // independently so repair can resume indexing without a client request.
  private retryKnownLoads(): void {
    if (this.stopping || !this.known.some(path => !this.host.isLoaded(path))) {
      clearTimeout(this.knownLoadRetry);
      this.knownLoadRetry = undefined;
      this.knownLoadFailures = 0;
      return;
    }
    if (this.knownLoadRetry) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.knownLoadFailures++, 5));
    this.knownLoadRetry = setTimeout(() => {
      this.knownLoadRetry = undefined;
      this.reconcileKnown();
    }, delay);
    this.knownLoadRetry.unref?.();
  }

  // --- known instances ---

  private readKnown(): string[] {
    let stored: unknown;
    try { stored = JSON.parse(readFileSync(this.paths.known, 'utf8')); }
    catch (error) {
      this.cacheRegistryReadable = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return [];
    }
    if (!Array.isArray(stored) || stored.some(path => typeof path !== 'string')) {
      this.cacheRegistryReadable = false;
      return [];
    }
    const known = [...new Set(stored.filter((path): path is string => typeof path === 'string' && shouldRetainKnownInstance(path)).map(instanceKey))];
    if (JSON.stringify(stored) !== JSON.stringify(known)) writeKnown(this.paths, known);
    return known;
  }

  // Identity and semantic registration both follow the known list.
  private refreshRegistrations(): void {
    this.host.refreshIdentities();
    this.host.refreshSemanticRegistrations();
  }

  private saveKnown(known = this.known): void {
    writeKnown(this.paths, known);
    this.cacheRegistryReadable = true;
  }

  // Drop verified non-instances, preserving unreadable registrations and their
  // identity blockers until repair or an explicit forget.
  private pruneKnown(collectCaches = true): void {
    const valid = this.known.filter(shouldRetainKnownInstance);
    if (valid.length !== this.known.length) {
      // Publish only after persistence succeeds, so a failed background write
      // leaves the same prune pending for the next check.
      this.saveKnown(valid);
      this.known = valid;
    }
    for (const { key, path } of this.host.loaded()) {
      if (shouldRetainKnownInstance(path)) continue;
      this.host.unloadKey(key);
    }
    for (const used of this.connections.values()) {
      for (const path of used) if (!shouldRetainKnownInstance(path)) used.delete(path);
    }
    this.refreshRegistrations();
    if (collectCaches) void this.collectSemanticCaches();
  }

  private note(path: string, includePrimary = true): void {
    if (this.known.includes(path)) return;
    const added = (includePrimary ? withPrimaryInstances([path]) : [instanceKey(path)]).filter(key => !this.known.some(p => instanceKey(p) === key));
    if (!added.length) return;
    this.known.push(...added);
    this.saveKnown();
    void this.cacheOperation(() => this.semanticCaches.register(added));
    this.refreshRegistrations();
    this.loadKnown();
  }

  private editKnown(paths: unknown, add: boolean, clearCache = false): Promise<KnownEditResult> {
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
    let result: KnownEditResult;
    return this.cacheOperation(async () => {
      const prepared = new Set<string>();
      const preparedAutomatic = new Set<string>();
      // Persist retention intent before removing registration. Other requests
      // may register instances during filesystem awaits: recompute from the
      // latest catalogue, preparing any newly affected worktrees before commit.
      for (;;) {
        const previous = new Set(this.known.map(instanceKey));
        let known = add ? [...this.known] : withoutInstanceFamilies(this.known, resolved);
        for (const path of add ? withPrimaryInstances(resolved) : resolved) {
          const key = instanceKey(path);
          if (add) {
            if (!known.includes(key)) known.push(key);
          } else known = known.filter(path => path !== key);
        }
        const explicitlyRetained = new Set(known);
        const affected = add ? withPrimaryInstances(resolved) : [...new Set([
          ...resolved, ...previous].filter(path => !explicitlyRetained.has(path)))];
        const automaticallyRemoved = known.filter(path => !shouldRetainKnownInstance(path));
        known = known.filter(path => !automaticallyRemoved.includes(path));
        const pending = affected.filter(path => !prepared.has(path));
        const automatic = automaticallyRemoved.filter(path => !preparedAutomatic.has(path) && !affected.includes(path));
        if (pending.length || automatic.length) {
          if (pending.length) {
            if (add) await this.semanticCaches.register(pending);
            else await this.semanticCaches.forget(pending, clearCache);
          }
          if (automatic.length) await this.semanticCaches.forget(automatic, false);
          for (const path of pending) prepared.add(path);
          for (const path of automatic) preparedAutomatic.add(path);
          continue;
        }
        this.saveKnown(known);
        this.known = known;
        this.refreshRegistrations();
        this.loadKnown();
        this.reconsider();
        this.pruneKnown();
        const current = new Set(this.known);
        result = {known: this.known.filter(isAsideDir), requested: resolved,
          changed: [...new Set(resolved)].filter(path => previous.has(path) !== current.has(path)),
          ...(clearCache ? {cache: {clearRequested: affected}} : {})};
        break;
      }
      await this.semanticCaches.collect(() => this.known, () => this.host.loadedPaths()).catch(error => {
        // The registration and its cache policy are already committed. Actual
        // reclamation can retry lazily without discarding that receipt.
        log(`semantic cache cleanup pending: ${(error as Error).message}`);
      });
    }).then(() => result!);
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
    void this.collectSemanticCaches();
  }

  // Stop serving new work, flush pending calendar work, finish in-flight
  // requests, and exit.
  shutdown(): Promise<void> {
    this.stopping ??= (async () => {
      log('daemon shutting down');
      clearInterval(this.diagnosticTimer);
      clearInterval(this.registryTimer);
      clearTimeout(this.registryCheck);
      clearTimeout(this.knownLoadRetry);
      this.knownLoadRetry = undefined;
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
        await this.cacheWork.catch(() => {});
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
