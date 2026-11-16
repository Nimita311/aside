import { handleUpdateOccurrence } from '../mcp/tools/recurrence.js';
import { handleUpdateInstance } from '../mcp/tools/instance.js';
import { AutomationController } from '../automation/controller.js';
import type { AutomationSource } from '../automation/scheduler.js';
import { delegationSource } from '../automation/delegation.js';
import type { DelegationRequest, PreparedDelegation } from '../automation/delegation-protocol.js';
import type { RunRecord } from '../automation/storage.js';
import { assertDelegation } from '../core/delegation.js';
import { projectionId, resolveProjection } from '../core/recurrence.js';
import { scheduleInstant } from '../core/scheduling.js';
import { automationRuntimeSnapshot, readAutomationLog, type AutomationLogStream } from '../graphql/automation-runtime.js';
import { INSTANCE_IDENTITY_POLL_MS, CALENDAR_FLUSH_TIMEOUT_MS } from '../core/system-config.js';
import { RegexWorkerPool } from '../mcp/search.js';
import { SemanticIndexNotCurrentError, SemanticSearchService } from '../semantic/search.js';
import { InstanceSemanticLifecycle, type InstanceSemanticLifecycleOptions } from './semantic-lifecycle.js';
import { searchSourceVersion } from '../semantic/source-version.js';
import { semanticSearchAvailability } from '../semantic/availability.js';
import { SemanticGenerationUnavailableError } from '../semantic/embedding.js';
import { collectSystemInstallation } from '../graphql/system-installation.js';
import type { SystemDaemonSnapshot } from '../graphql/system-daemon.js';
// The daemon's instance host: every loaded instance's record cache, calendar
// syncer, and web server, plus the operations clients run against them (see
// design/runtime.md, Data ownership). It owns no sockets — the daemon wraps it — so the
// same host runs in-process under tests.
import { resolve, relative } from 'node:path';
import { validateToolArgs } from '../mcp/schemas.js';
import { Store } from '../source/store.js';
import { handleQueryArtifacts } from '../mcp/tools/query.js';
import { createArtifact, handleUpdateArtifact } from '../mcp/tools/artifact.js';
import { executeGraphQL, readGraphQLSchema, type MutationOutcome, type MutationPlan, type GraphQLArgs } from '../graphql/schema.js';
import { GraphQLUsageLog } from '../graphql/usage.js';
import type { InstanceSession } from '../mcp/instance-session.js';
import { handleCapture } from '../mcp/tools/capture.js';
import { handleUpdateAction, handleUpdateProject, handleUpdateEntry } from '../mcp/tools/update.js';
import { buildShowRoute, finishShow, type ShowArgs } from '../mcp/tools/show.js';
import { startWeb, resolveAppDir, openBrowser } from '../web/locate.js';
import {cataloguedInstances, instanceFamilyKey, instanceIdError, observedInstance, type AvailableInstance} from '../core/catalogue.js';
import { instanceCardSummary } from '../web/summary.js';
import type { WebBackend } from '../web/server.js';
import type { AsideWebServer } from '../web/server.js';
import { WEB_QUERY_MAX_RESPONSE_BYTES } from '../core/web-query.js';
import { CalClient } from '../mcp/calendar/client.js';
import { geocodeAddress } from '../mcp/geocoding.js';
import { CalSync, storeAction, type SyncAction } from '../mcp/calendar/sync.js';
import { collectCalendarInfo, collectCalendarStatus, collectCalendarSyncInfo } from '../mcp/calendar/info.js';
import { isAsideDir, readManifestResult, readInstanceRecordResult, shouldRetainKnownInstance, instancePathError, InstancePathError } from '../core/instance.js';
import { isInstanceId } from '../core/identity.js';
import {canonicalPath, checkoutInfo, type CheckoutInfo} from '../core/worktree.js';
import {eventTitlePrefixes, type ParseIssue, type ParseResult, type InstanceRecord, type WebappSidebarSection} from '../core/types.js';
import {assertSidebarUnchanged, assertWebappSidebar, SidebarConflictError} from '../core/webapp-config.js';
import { InstanceLifecycle, type InstanceLifecycleOptions } from './instance-lifecycle.js';
import { InstanceCalendarLifecycle } from './calendar-lifecycle.js';
import {readExecutionContextSnapshot} from '../source/execution-context.js';
import {type ExecutionContextSnapshot} from '../core/execution-context.js';
import {bootstrapInstanceSource, createInstanceSource, type InstanceAdmissionResult} from './instance-operations.js';
import type {InitOptions} from '../source/bootstrap.js';
import {InstanceOperationError} from '../core/instance-operation-error.js';
import type {MutationResult} from '../source/mutation-result.js';

export interface ToolResult {
  text: string;
  // The instance's parse issues: as read, or after a write.
  issues: ParseIssue[];
}

export interface ShowResult {
  route: string;
  port: number;
  // Opening a new view leaves existing tabs untouched.
  tab: boolean;
  url?: string;
}

interface Loaded {
  // The identity it was loaded under; kept, since the path may stop resolving.
  key: string;
  path: string;
  store: Store;
  sync: CalSync;
}

// Operations that only read; a client may repeat them after a lost connection.
export const READ_TOOLS = new Set(['query_artifacts']);

function outcomeWarnings(warning: string | undefined, others: string[] = []): {warnings?: string[]} {
  const warnings = [...(warning ? [warning] : []), ...others];
  return warnings.length ? {warnings} : {};
}

// A loaded instance's manifest issues, under either spelling of its file.
function manifestIssues(store: Store, path: string): ParseIssue[] {
  return store.getIssues().filter(issue => issue.file === 'aside.md' || issue.file === resolve(path, 'aside.md'));
}

// Usage and automation diagnostics are both attempted before either failure
// surfaces. Thunks keep a synchronous throw inside the returned promise.
async function bothSettled<U, A>(usage: () => Promise<U>, automation: () => Promise<A> | A) {
  const [usageWork, automationWork] = await Promise.allSettled([usage(), automation()]);
  if (usageWork.status === 'rejected') throw usageWork.reason;
  if (automationWork.status === 'rejected') throw automationWork.reason;
  return {usage: usageWork.value, automation: automationWork.value};
}

// One key per instance however its path is spelled.
export function instanceKey(path: string): string {
  return canonicalPath(path);
}

export class InstanceHost {
  private key(path: string): string {
    const absolute = resolve(path);
    return this.instances.has(absolute) || this.catalogueRecords.has(absolute) || this.passiveRecords.has(absolute)
      ? absolute : this.admittedKeys.get(absolute) ?? instanceKey(absolute);
  }
  private systemDaemon?: () => SystemDaemonSnapshot;
  configureSystemDaemon(read: () => SystemDaemonSnapshot): void { this.systemDaemon = read; }
  private semanticSearches?: SemanticSearchService;
  private semanticClosing?: Promise<void>;
  private semanticLifecycle?: InstanceSemanticLifecycle;
  private semanticStopped = false;
  private semanticRegistered?: () => readonly string[];
  private prepareSemantic?: (store: Store) => Promise<void>;
  private calendars = new InstanceCalendarLifecycle((store, delayMs) =>
    this.sources.requestFeatureReconcile('calendar', store, delayMs));
  private sources = this.sourceLifecycle();
  private sourceLifecycle(options: InstanceLifecycleOptions = {}): InstanceLifecycle {
    const lifecycle = new InstanceLifecycle(options);
    const identity = () => this.refreshIdentities();
    lifecycle.addFeature('identity', {changed: identity, reconcile: identity});
    lifecycle.addMaintenance('catalogue', identity, INSTANCE_IDENTITY_POLL_MS);
    lifecycle.addFeature('semantic', {
      load: store => {const loaded = this.instances.get(store.getDataDir()); if (loaded) this.observeSemantic(loaded);},
      observe: store => this.semanticLifecycle?.changed(store),
      synchronize: (store, delivery) => this.semanticLifecycle?.synchronize(store, {check: delivery.reconcile}),
      unload: store => this.semanticLifecycle?.unregister(store),
    });
    const automation = (store: Store) => {const loaded = this.instances.get(store.getDataDir()); if (loaded) this.refreshAutomation(loaded);};
    lifecycle.addFeature('automation', {changed: automation, reconcile: automation,
      unload: store => this.automation?.replace(store.getDataDir(), [])});
    const calendar = (store: Store) => {
      const work = this.calendars.reconcile(store);
      this.track(work); return work;
    };
    lifecycle.addFeature('calendar', {
      load: store => {const loaded = this.instances.get(store.getDataDir()); if (loaded) this.calendars.register(store, loaded.sync);},
      changed: calendar, reconcile: calendar,
      unload: store => this.calendars.unregister(store),
    });
    return lifecycle;
  }
  configureSources(options: InstanceLifecycleOptions = {}): void {
    this.sources.close();
    this.sources = this.sourceLifecycle(options);
    for (const loaded of this.instances.values()) this.sources.register(loaded.store);
  }
  private semanticFactory = () => new SemanticSearchService();
  private semanticService(): SemanticSearchService {
    if (this.semanticStopped) throw new Error('Semantic search service is closed.');
    return this.semanticSearches ??= this.semanticFactory();
  }
  configureSemantic(options: {indexRoot?: string; service?: () => SemanticSearchService;
    reconciliation?: Omit<InstanceSemanticLifecycleOptions, 'reconcile'>} = {}): void {
    if (this.semanticLifecycle || this.semanticStopped) return;
    this.semanticFactory = options.service ?? (() => new SemanticSearchService({indexRoot: options.indexRoot}));
    this.semanticLifecycle = new InstanceSemanticLifecycle({reconciliationIntervalMs: 0, ...options.reconciliation,
      reconcile: async (store, request) => {
        request.signal.throwIfAborted();
        this.assertSemanticRegistered(store);
        await this.prepareSemantic?.(store);
        request.signal.throwIfAborted();
        this.assertSemanticRegistered(store);
        return this.semanticService().reconcile(store, request);
      }});
    for (const loaded of this.instances.values()) this.observeSemantic(loaded);
    this.sources.reconcileFeature('semantic');
  }
  configureSemanticLifecycle(registered: () => readonly string[], prepare: (store: Store) => Promise<void>): void {
    this.semanticRegistered = registered;
    this.prepareSemantic = prepare;
    this.refreshSemanticRegistrations();
  }
  refreshSemanticRegistrations(): void {
    for (const loaded of this.instances.values()) {
      if (this.semanticRegistered && !this.semanticRegistered().includes(loaded.key)) {
        this.semanticLifecycle?.unregister(loaded.store);
      } else this.observeSemantic(loaded);
    }
    this.sources.reconcileFeature('semantic');
  }
  private assertSemanticRegistered(store: Store): void {
    if (this.semanticRegistered && !this.semanticRegistered().includes(store.getDataDir())) {
      throw new Error('Instance is no longer registered for semantic search. Register it again before searching.');
    }
  }
  private observeSemantic(loaded: Loaded): void {
    if (!this.semanticLifecycle) return;
    if (this.semanticRegistered && !this.semanticRegistered().includes(loaded.key)) return;
    this.semanticLifecycle.register(loaded.store);
  }
  private instanceMutations = (roots: readonly string[]): void => {
    for (const root of roots) {
      const loaded = this.instances.get(this.key(root));
      if (loaded) {
        this.sources.mutated(loaded.store);
      }
    }
  };
  private reconcileSemantic = (store: Store, options: {signal?: AbortSignal} = {}) => {
    this.assertSemanticRegistered(store);
    if (!this.semanticLifecycle) this.configureSemantic();
    return this.semanticLifecycle!.ensureCurrent(store, options);
  };
  private searchSemantic: SemanticSearchService['search'] = async (store, input, options = {}) => {
    this.assertSemanticRegistered(store);
    const version = searchSourceVersion(store);
    await this.reconcileSemantic(store, options);
    this.assertSemanticRegistered(store);
    if (searchSourceVersion(store) !== version) throw new Error('Aside changed before semantic search. Retry to search the latest source revision.');
    try { return await this.semanticService().search(store, input, options); }
    catch (error) {
      // Retrieval reports drift; the registered instance's indexing worker owns
      // repair. The current request never writes or rebuilds an index itself.
      if (error instanceof SemanticIndexNotCurrentError || error instanceof SemanticGenerationUnavailableError) {
        this.semanticLifecycle?.invalidate(store);
        this.sources.reconcileFeature('semantic');
      }
      throw error;
    }
  };
  private usageLog = new GraphQLUsageLog();
  configureUsage(logs: string): void { this.usageLog = new GraphQLUsageLog({logs}); }
  usageStatus() { return this.usageLog.status(); }
  cleanupDiagnostics() { return bothSettled(() => this.usageLog.cleanup(), () => this.automation?.cleanup() ?? {runs: 0}); }
  purgeDiagnostics(root?: string) { return bothSettled(() => this.usageLog.purge(root), () => this.automation?.purge(root) ?? {runs: 0}); }
  readonly cal: CalClient;
  private automation?: AutomationController;
  private automationStorage?: string;
  configureAutomation(storage: string): void {
    this.automationStorage = storage;
    this.automation = new AutomationController(storage, {prepare: request => this.prepareDelegation(request), complete: (source, run) => this.completeDelegation(source, run)});
    this.sources.reconcileFeature('automation');
  }
  automationStatus() { return this.automation?.inspect() ?? Promise.resolve({ jobs: [], runs: [] }); }
  private async automationRuntime(root: string) {
    const inspection = this.automation ? await this.automation.inspect(this.key(root))
      : { available: false, jobs: [], runs: [], warning: 'Automation runtime is unavailable because this host has no automation controller.' };
    return automationRuntimeSnapshot(this.key(root), inspection);
  }
  private async automationLog(root: string, runId: string, stream: AutomationLogStream, offset: number, limit: number) {
    return this.automationStorage ? readAutomationLog(this.automationStorage, this.key(root), runId, stream, offset, limit) : null;
  }
  stopAutomation(): Promise<void> { return this.automation?.close() ?? Promise.resolve(); }
  private refreshAutomation(loaded: Loaded): void {
    if (!this.automation) return;
    const { store, path } = loaded;
    const manifest = store.getManifest();
    const issues = store.getIssues();
    const sources: AutomationSource[] = [];
    const topology = checkoutInfo(path);
    const identity = this.identityIssue(path);
    const blocked = !isInstanceId(manifest.id) ? 'Automation requires a valid instance id in aside.md.' :
      topology.error ? `Cannot verify automation checkout: ${topology.error}` :
      topology.worktree?.linked ? `Automation execution is paused in this Git worktree. Use the primary checkout: ${topology.worktree.primaryPath}` :
      identity ? identity.message.replace(/Calendar sync/g, 'Automation execution') :
      issues.some(issue => issue.code === 'rebuild_failed') ? 'Automation is paused because the instance could not be reloaded.' :
      store.getExecutionContext().error;
    const add = (definedIn: string, declarations: Record<string, unknown> | undefined, file: string) => {
      const fileError = issues.find(issue => issue.file === file && issue.severity === 'error' && issue.code !== 'invalid_automation');
      for (const [name, declaration] of Object.entries(declarations ?? {})) {
        sources.push({ key: JSON.stringify([path, definedIn, name]), root: path, instance: manifest.id, definedIn, declaration,
          ...(blocked || fileError ? { blocked: blocked ?? fileError!.message } : {}) });
      }
    };
    add(`instance ${manifest.id}`, manifest.automations, 'aside.md');
    for (const [id, project] of store.getProjects()) if (!project.frontMatter.ended) {
      add(`#project/${id}`, project.frontMatter.automations, relative(path, store.getProjectFile(id) ?? ''));
    }
    for (const [id, action] of store.getActions()) if (action.frontMatter.delegation !== undefined) {
      const excluded = action.frontMatter.recurrence === undefined ? undefined : [...store.getOccurrenceOriginals(id)];
      sources.push(delegationSource(path, manifest.id, id, action, excluded, blocked ?? this.delegationBlock(loaded, id)));
    }
    for (const source of sources) source.executionContext = store.getExecutionContext();
    try {this.automation.replace(path, sources);}
    catch (error) {
      // A known declaration edit must not leave obsolete jobs scheduled when
      // its replacement cannot be serialized or accepted by the worker.
      this.automation.replace(path, []);
      throw error;
    }
  }
  private delegationBlock(loaded: Loaded, id: string): string | undefined {
    const topology = checkoutInfo(loaded.path);
    if (!isInstanceId(loaded.store.getManifest().id)) return 'Delegation requires a valid instance id.';
    if (topology.error) return `Cannot verify delegation checkout: ${topology.error}`;
    if (topology.worktree?.linked) return `Delegation is paused in this Git worktree. Use the primary checkout: ${topology.worktree.primaryPath}`;
    if (loaded.store.getExecutionContext().error) return loaded.store.getExecutionContext().error;
    const identity = this.identityIssue(loaded.path);
    if (identity) return identity.message.replace(/Calendar sync/g, 'Delegation');
    const file = loaded.store.getActionFile(id);
    return loaded.store.getIssues().find(issue => issue.severity === 'error' && (issue.code === 'rebuild_failed' ||
      file && (issue.file === file || issue.file === relative(loaded.path, file))))?.message;
  }
  // A saved action is blocked through its own file; a projected occurrence
  // through its template's.
  private delegationTargetBlock(loaded: Loaded, target: ReturnType<InstanceHost['delegationAction']>): string | undefined {
    return this.delegationBlock(loaded, loaded.store.getAction(target.id) ? target.id : target.action.frontMatter.occurrence?.template ?? target.id);
  }
  private delegationAction(loaded: Loaded, id: string) {
    const actions = loaded.store.getActions();
    const saved = actions.get(id);
    if (saved) return {id, action: saved};
    for (const [savedId, action] of actions) if (action.frontMatter.occurrence && projectionId(action.frontMatter.occurrence) === id) return {id: savedId, action};
    const projection = resolveProjection(actions, id);
    if (!projection) throw new Error('Action not found. Query actions for an exact saved or projected ID.');
    return {id, action: projection};
  }
  async runDelegation(root: string, id: string) {
    if (!this.automation) throw new Error('Delegation execution requires the daemon automation worker.');
    const loaded = this.load(root);
    const target = this.delegationAction(loaded, id);
    if (target.action.frontMatter.recurrence !== undefined) throw new Error('Run a projected occurrence, not the recurrence template.');
    assertDelegation(target.action.frontMatter.delegation);
    const blocked = this.delegationTargetBlock(loaded, target);
    if (blocked) throw new Error(blocked);
    return this.automation.dispatch({...delegationSource(loaded.path, loaded.store.getManifest().id, target.id, target.action), executionContext: loaded.store.getExecutionContext()});
  }
  private prepareDelegation(request: DelegationRequest): PreparedDelegation {
    const loaded = this.instances.get(request.source.root);
    if (!loaded) throw new Error('Delegation instance is no longer loaded.');
    const target = this.delegationAction(loaded, request.target.id);
    const fm = target.action.frontMatter;
    const blocked = this.delegationTargetBlock(loaded, target);
    if (blocked) throw new Error(blocked);
    if (loaded.store.getManifest().id !== request.source.instance) throw new Error('Delegation instance identity changed before dispatch.');
    const definition = assertDelegation(fm.delegation);
    if (fm.recurrence !== undefined) throw new Error('Run a projected occurrence, not the recurrence template.');
    if (request.automatic && (fm.resolution || !fm.scheduled || scheduleInstant(fm.scheduled, fm.timezone) !== request.target.at)) throw new Error('Action is resolved or its delegation schedule changed before dispatch.');
    const expected = request.target.action.frontMatter;
    if (JSON.stringify(definition) !== JSON.stringify(assertDelegation(expected.delegation)) || fm.scheduled !== expected.scheduled || fm.timezone !== expected.timezone) throw new Error('Action delegation changed before dispatch.');
    return {source: {...delegationSource(loaded.path, request.source.instance, target.id, target.action), executionContext: loaded.store.getExecutionContext()}};
  }
  private completeDelegation(source: AutomationSource, run: RunRecord): string {
    const loaded = this.instances.get(source.root);
    if (!loaded) throw new Error('Delegation succeeded, but its instance is no longer loaded; completion was not saved.');
    const {id, action} = this.delegationAction(loaded, run.actionId!);
    const saved = loaded.store.getAction(id);
    if (action.frontMatter.resolution === 'done') return id;
    if (saved) {
      this.mutate(loaded, 'update_action', {id, resolution: 'done'});
      return id;
    }
    return this.mutate(loaded, 'update_occurrence', {...action.frontMatter.occurrence!, resolution: 'done'}).id!;
  }
  private instances = new Map<string, Loaded>();
  private webServer?: AsideWebServer;
  private webPort: number | undefined;
  private webStarting?: Promise<AsideWebServer>;
  private webBackend: WebBackend = {
    instances: () => this.availableInstances(this.loadedPaths()),
    summary: path => this.summary(path),
    register: async () => { throw new Error('Instance registration requires the daemon.'); },
    remove: () => { throw new Error('Instance removal requires the daemon.'); },
    load: path => { this.load(path); },
    data: (path, refresh) => this.data(path, refresh),
    query: (path, args, signal) => this.webQuery(path, args, signal),
    updateSidebar: async (path, sidebar, expectedSidebar) => { this.updateSidebar(path, sidebar, expectedSidebar); },
    years: path => this.years(path), subscribe: (path, changed) => this.subscribe(path, changed),
  };

  updateSidebar(path: string, sidebar: WebappSidebarSection[], expectedSidebar: WebappSidebarSection[]): void {
    const desired = assertWebappSidebar(sidebar);
    const fresh = readManifestResult(instanceKey(path));
    if (fresh.issues.some(issue => ['invalid_yaml', 'read_error', 'not_a_mapping', 'invalid_webapp_config', 'invalid_webapp_sidebar'].includes(issue.code))) {
      throw new SidebarConflictError('The current sidebar declaration cannot be verified. Ask the agent to repair the instance settings before pinning content.');
    }
    assertSidebarUnchanged(fresh.value.config?.webapp?.sidebar ?? [], expectedSidebar);
    // No await between the fresh comparison and durable mutation: HTTP and
    // GraphQL writers in this daemon cannot interleave a stale replacement.
    this.mutate(this.load(path), 'update_instance', { webapp: { sidebar: desired } });
  }

  async data(path: string, refresh = false) {
    const store = this.load(path).store;
    if (refresh) this.sources.refresh(store);
    return store.snapshot();
  }

  webQuery(path: string, args: GraphQLArgs, signal: AbortSignal) {
    return executeGraphQL(() => this.load(path).store, 'query', args, {
      resolveStore: this.resolveStore, loadedInstance: this.loadedInstance, executionContext: this.executionContext,
      matcher: this.searches, semanticSearch: this.searchSemantic, semanticReconcile: this.reconcileSemantic,
      semanticAvailability: semanticSearchAvailability, signal, maxFields: 10_000, maxResponseBytes: WEB_QUERY_MAX_RESPONSE_BYTES,
      maxSerializedResponseBytes: WEB_QUERY_MAX_RESPONSE_BYTES,
    });
  }

  summary(path: string) {
    const loaded = this.instances.get(this.key(path));
    return loaded ? instanceCardSummary(loaded.store) : undefined;
  }

  years(path: string): readonly string[] {return this.instances.get(this.key(path))?.store.getSourceMetadata().years ?? [];}
  subscribe(path: string, changed: () => void): () => void {return this.load(path).store.onChange(changed);}

  availableInstances(paths: readonly string[] = this.knownPaths()): AvailableInstance[] {
    const wanted = new Set(paths.map(path => this.instances.has(path) || this.catalogueRecords.has(path) ? path : this.key(path)));
    const managed = this.catalogue.flatMap(instance => {
      const loaded = this.instances.get(instance.path);
      if (!loaded) return [instance];
      if (manifestIssues(loaded.store, instance.path).some(issue => issue.code === 'read_error')) return [];
      const {id, name, description} = loaded.store.getManifest();
      const {error: _error, address: _address, alias: _alias, duplicatePaths: _duplicates, ...previous} = instance;
      return [{...previous, id, name, description, ...instanceIdError(id)}];
    });
    return cataloguedInstances([...managed,
      ...[...this.passiveCatalogue.values()].filter(instance => wanted.has(instance.path) && !this.catalogueRecords.has(instance.path))])
      .filter(instance => wanted.has(instance.path));
  }

  /** Passive admission belongs to the owner and never starts instance features. */
  observeInstances(paths: readonly string[]): void {
    for (const path of paths) {
      const key = this.key(path);
      if (this.instances.has(key) || this.catalogueRecords.has(key)) continue;
      const record = readInstanceRecordResult(key);
      this.passiveRecords.set(key, record);
      this.observedExecutionContexts.set(key, readExecutionContextSnapshot(key));
      this.passiveCatalogue.delete(key);
      if (record.issues.some(issue => issue.code === 'read_error') || !isAsideDir(key)) continue;
      const topology = checkoutInfo(key);
      this.passiveCatalogue.set(key, observedInstance(key, record.value.manifest, topology.worktree, topology.error));
    }
  }

  created(path: string, options: {partial?: boolean} = {}): ParseIssue[] {
    const existing = this.instances.get(this.key(path));
    if (options.partial && !existing) return [];
    if (existing) this.sources.refresh(existing.store); else this.load(path);
    return this.issues(path);
  }

  admitInstance(path: string): InstanceAdmissionResult {
    try {
      const loaded = this.load(path);
      return {path: loaded.path, record: this.metadata(loaded.path), issues: this.issues(loaded.path)};
    } catch (error) {
      if (error instanceof InstancePathError) throw new InstanceOperationError('NOT_INSTANCE', error.message);
      throw error;
    }
  }

  createInstance(input: InitOptions & {path: string}, created = async (path: string, options?: {partial?: boolean}) => this.created(path, options)) {
    return createInstanceSource(input, {created, instanceRecord: async path => this.metadata(path)});
  }

  bootstrapInstance(input: InitOptions & {path: string}) {
    return bootstrapInstanceSource(input, path => {
      const key = this.key(path), existing = this.instances.get(key);
      if (existing) this.sources.refresh(existing.store);
      else if (this.knownPaths().some(known => this.key(known) === key)) this.load(key);
      else {
        // A formerly loaded root may still have a catalogue observation. A
        // confirmed bootstrap supersedes it before passive admission.
        this.refreshIdentities();
        this.observeInstances([key]);
      }
    });
  }

  configureWeb(backend: WebBackend, port?: number): void {
    this.webBackend = backend; this.webPort = port;
  }
  // Forward syncs still running, awaited by flush() before the daemon exits.
  private inFlight = new Set<Promise<unknown>>();
  private knownPaths: () => string[] = () => [];
  private catalogueRecords = new Map<string, ParseResult<InstanceRecord>>();
  private admittedKeys = new Map<string, string>();
  private passiveRecords = new Map<string, ParseResult<InstanceRecord>>();
  private observedExecutionContexts = new Map<string, ExecutionContextSnapshot>();
  private passiveCatalogue = new Map<string, AvailableInstance>();
  private catalogue: AvailableInstance[] = [];
  private topologies = new Map<string, CheckoutInfo>();
  private identityStates = new Map<string, string>();
  private observedIdentities = new Map<string, string>();
  private identityIssues = new Map<string, ParseIssue | null>();
  private calendarBlocks = new Map<string, string | null>();
  private topologyWarnings = new Map<string, string | undefined>();
  // Called when a webapp tab connects or disconnects.
  onTabsChanged: (() => void) | undefined;

  constructor(cal: CalClient = new CalClient(), private searches = new RegexWorkerPool()) {
    this.cal = cal;
    // The helper's `changed` signal is coarse and can fire in bursts (incl. our
    // own writes), so debounce, then reverse-reconcile every loaded instance.
    cal.onChanged(() => this.sources.reconcileFeature('calendar'));
  }

  isLoaded(path: string): boolean {
    return this.instances.has(this.key(path));
  }

  loadedPaths(): string[] {
    return [...this.instances.values()].map((i) => i.path);
  }

  setKnownPaths(paths: () => string[]): void {
    this.knownPaths = paths;
    this.refreshIdentities();
  }

  private readIdentities(extraPath?: string) {
    const paths = new Set([...this.knownPaths().map(path => {
      const key = this.key(path); this.admittedKeys.set(resolve(path), key); return key;
    }), ...this.loadedPaths()]);
    if (extraPath) paths.add(this.key(extraPath));
    for (const [alias, key] of this.admittedKeys) if (!paths.has(key)) this.admittedKeys.delete(alias);
    // Forgetting an unloaded registration or verifying its removal can clear
    // an observation. A failed read cannot prove that its identity changed.
    for (const observed of this.observedIdentities.keys()) if (!paths.has(observed)) this.observedIdentities.delete(observed);
    return [...paths].sort().map(path => {
      const loaded = this.instances.get(path);
      const record = loaded ? {value: loaded.store.getInstance()!, issues: manifestIssues(loaded.store, path)} : readInstanceRecordResult(path);
      if (!loaded) this.observedExecutionContexts.set(path, readExecutionContextSnapshot(path));
      this.catalogueRecords.set(path, record);
      this.topologies.set(path, checkoutInfo(path));
      const result = {value: record.value.manifest, issues: record.issues}, readError = result.issues.find(issue => issue.code === 'read_error');
      if (!readError) {
        if (isInstanceId(result.value.id)) this.observedIdentities.set(path, result.value.id);
        else this.observedIdentities.delete(path);
      }
      return { path, id: readError ? this.observedIdentities.get(path) ?? '' : result.value.id, readError };
    });
  }

  private identityFamily(path: string): string {
    return instanceFamilyKey(this.topologies.get(path)?.worktree, path);
  }

  private identityIssue(path: string): ParseIssue | null {return this.identityIssues.get(this.key(path)) ?? null;}

  private observedIdentityIssue(path: string, observations: ReturnType<InstanceHost['readIdentities']>): ParseIssue | null {
    const key = this.key(path);
    const id = observations.find(observation => observation.path === key)?.id;
    if (!id || !isInstanceId(id)) return null; // the manifest parser reports invalid IDs
    const family = this.identityFamily(key);
    const conflicts = observations.filter(observation => observation.id === id && this.identityFamily(observation.path) !== family).map(observation => observation.path);
    if (conflicts.length) conflicts.unshift(key);
    // On cold startup the catalogue carries paths only. An unknown registered
    // identity cannot certify uniqueness; a verified distinct identity can.
    const unreadable = observations.filter(observation => observation.readError && (!observation.id || observation.id === id) && this.identityFamily(observation.path) !== family);
    if (unreadable.length) return {
      severity: 'error', code: conflicts.length > 1 ? 'instance_id_conflict' : 'instance_identity_unavailable', file: 'aside.md', field: 'id',
      message: `Calendar sync is disabled while instance identity cannot be verified for ${unreadable.map(observation => JSON.stringify(observation.path)).join(', ')}.${conflicts.length > 1 ? ` Last observed id ${JSON.stringify(id)} is shared by ${conflicts.map(path => JSON.stringify(path)).join(', ')}.` : ''} ${unreadable.map(observation => observation.readError!.message).join(' ')}`,
    };
    if (conflicts.length < 2) return null;
    return {
      severity: 'error', code: 'instance_id_conflict', file: 'aside.md', field: 'id',
      message: `Instance id ${JSON.stringify(id)} is shared by ${conflicts.map((p) => JSON.stringify(p)).join(', ')}. Calendar sync is disabled for all affected instances. Give each distinct instance a different hostname-safe id.`,
    };
  }

  // Metadata checks never load the other instances. Polling includes manifests
  // in the known catalog that have no active record watcher.
  refreshIdentities(): void {
    // Register metadata observations even when no record store is loaded yet.
    const observations = this.readIdentities();
    this.identityIssues.clear();
    this.topologyWarnings.clear();
    for (const observation of observations) {
      this.identityIssues.set(observation.path, this.observedIdentityIssue(observation.path, observations));
      this.topologyWarnings.set(observation.path, this.topologies.get(observation.path)?.error);
    }
    let changed = false;
    for (const { key, path, store } of this.instances.values()) {
      const observed = observations.find(item => item.path === key);
      const pending = observed && (observed.readError || observed.id !== store.getManifest().id);
      const topology = this.topologies.get(path);
      const block = (topology?.error ?? (topology?.worktree?.linked ? `Calendar sync is disabled in this Git worktree. Move changes into the primary checkout for calendar sync: ${topology.worktree.primaryPath}` : null)) ?? this.identityIssue(path)?.message
        ?? (pending ? observed.readError?.message ?? 'Instance identity is awaiting source reconciliation.' : null);
      this.calendarBlocks.set(key, block);
      const state = `${observed?.id ?? ''}\n${block ?? ''}`;
      if (this.identityStates.get(key) === state) continue;
      this.identityStates.set(key, state);
      // A repeated observation of the same unreadable manifest must not reset
      // source backoff or create a source-refresh/identity-refresh feedback loop.
      if (pending || store.getIssues().some(issue => issue.code === 'read_error' && issue.file === 'aside.md')) this.sources.invalidate(store);
      changed = true;
    }
    this.catalogue = cataloguedInstances(observations.filter(observation => !observation.readError).map(observation => {
      const manifest = this.catalogueRecords.get(observation.path)!.value.manifest, topology = this.topologies.get(observation.path);
      return observedInstance(observation.path, manifest, topology?.worktree, this.calendarWarning(observation.path));
    }));
    const observedPaths = new Set(observations.map(observation => observation.path));
    for (const path of this.catalogueRecords.keys()) if (!observedPaths.has(path)) {
      this.catalogueRecords.delete(path); this.topologies.delete(path);
      if (!this.passiveRecords.has(path)) this.observedExecutionContexts.delete(path);
    }
    if (changed) {this.sources.reconcileFeature('calendar'); this.sources.reconcileFeature('automation');}
  }

  // Every loaded instance by the key it was loaded under, with its open tabs.
  loaded(): Array<{ key: string; path: string; tabs: number }> {
    return [...this.instances.values()].map((i) => ({ key: i.key, path: i.path, tabs: this.webServer?.tabsForPath(i.key) ?? 0 }));
  }

  // Load an instance — cache, watcher, calendar syncer — or return it loaded.
  load(path: string): Loaded {
    const key = this.key(path);
    const existing = this.instances.get(key);
    if (existing) return existing;
    if (!isAsideDir(key)) {
      const error = instancePathError(key);
      if (!shouldRetainKnownInstance(key)) this.unloadKey(key);
      throw error;
    }
    const store = new Store(key);
    this.admittedKeys.set(resolve(path), key);
    // The syncer reads the instance id and config from the store's manifest at
    // use time, so a later aside.md edit (e.g. adding the missing `id`) takes
    // effect without a reload; no fallback values are injected here.
    const loaded: Loaded = {key, path: key, store, sync: new CalSync(this.cal, '', store, undefined, () => this.calendarBlock(key), write => {this.sources.mutation(store, write);})};
    this.instances.set(key, loaded);
    try {this.sources.register(store);}
    catch (error) {this.instances.delete(key); store.close(); loaded.sync.dispose(); throw error;}
    this.refreshIdentities();
    this.sources.reconcileFeature('calendar'); // catch up on calendar edits made while it was not loaded
    return loaded;
  }

  private calendarBlock(path: string): string | null {
    return this.calendarBlocks.get(this.key(path)) ?? null;
  }

  private resolveStore = (path: string): Store | undefined => {
    const key = this.key(path), loaded = this.instances.get(key);
    return loaded?.store ?? (this.knownPaths().some(path => this.key(path) === key) ? this.load(key).store : undefined);
  };

  private loadedInstance = (path: string) => {
    const key = this.key(path), loaded = this.instances.get(key);
    if (!loaded) return this.catalogueRecords.get(key) ?? this.passiveRecords.get(key);
    const value = loaded.store.getInstance();
    if (!value) throw new Error('Loaded instance metadata is unavailable. Wait for lifecycle reconciliation.');
    return {value, issues: manifestIssues(loaded.store, loaded.path)};
  };

  metadata(path: string): ParseResult<InstanceRecord> {
    const key = this.key(path);
    const record = this.loadedInstance(key);
    if (!record) throw new Error(`Lifecycle-provided instance metadata is unavailable for ${JSON.stringify(key)}.`);
    return record;
  }
  private executionContext = (path: string) => {
    const key = this.key(path);
    return this.instances.get(key)?.store.getExecutionContext() ?? this.observedExecutionContexts.get(key);
  };

  // Catalogue metadata must reflect loaded-but-forgotten identity guards too,
  // without opening their stores or presenting expected worktree info as a warning.
  calendarWarning(path: string): string | undefined {
    return this.identityIssue(path)?.message ?? this.topologyWarnings.get(this.key(path));
  }

  unloadKey(key: string): void {
    const loaded = this.instances.get(key);
    if (!loaded) return;
    this.instances.delete(key);
    this.identityStates.delete(key);
    this.identityIssues.delete(key); this.calendarBlocks.delete(key);
    this.sources.unregister(loaded.store);
    loaded.store.close();
    loaded.sync.dispose();
  }

  issues(path: string): ParseIssue[] {
    const store = this.load(path).store;
    const issues = [...store.getIssues(), ...this.sources.issues(store)];
    if (store.getExecutionContext().error) issues.push({severity: 'error', code: 'execution_config', file: '.aside', message: store.getExecutionContext().error!});
    const conflict = this.identityIssue(path);
    if (conflict) issues.push(conflict);
    for (const message of this.automation?.issues(this.key(path)) ?? []) issues.push({ severity: 'error', code: 'automation_error', message });
    return issues;
  }

  tabCount(): number {
    return this.webServer?.tabCount ?? 0;
  }

  // Run one `aside artifact` operation against an instance.
  async tool(path: string, name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    args = validateToolArgs(name, args);
    const loaded = this.load(path);
    const snapshotIssues = READ_TOOLS.has(name) ? this.issues(path) : undefined;
    const text = await this.run(loaded, name, args ?? {}, signal);
    return { text, issues: snapshotIssues ?? this.issues(path) };
  }

  async graphqlSchema(session: InstanceSession, signal?: AbortSignal) {
    const result = await readGraphQLSchema(session.registry.activeInstance, {signal});
    return {...result, diagnostics: [...session.diagnostics, ...result.diagnostics]};
  }

  // A GraphQL MCP request includes session selection explicitly. Store access
  // is lazy so discovery, introspection, and instance creation need no default.
  graphql(session: InstanceSession, mode: 'query' | 'mutation', args: GraphQLArgs, signal?: AbortSignal, use: (path: string) => string = path => path, onInstancePathError?: () => void, navigationOrigin?: string) {
    return executeGraphQL(() => this.load(use(session.requireInstance())).store, mode, args, {
      resolveStore: this.resolveStore, loadedInstance: this.loadedInstance, executionContext: this.executionContext,
      observeInstance: path => {this.observeInstances([path]); return this.availableInstances([path]).length > 0;},
      usageLog: this.usageLog, onInstancePathError,
      instances: session, matcher: this.searches, semanticSearch: this.searchSemantic, semanticAvailability: semanticSearchAvailability, signal,
      semanticReconcile: this.reconcileSemantic, onMutation: this.instanceMutations,
      geocodeAddress,
      mutate: prepare => this.mutate(this.load(session.requireInstance()), prepare),
      systemDaemon: this.systemDaemon,
      systemInstallation: options => collectSystemInstallation({...options, cwd: session.workingDirectory}),
      calendarStatus: () => collectCalendarStatus(this.cal),
      requestCalendarAccess: () => collectCalendarInfo(this.cal),
      calendarSync: root => collectCalendarSyncInfo(this.load(use(root)).sync),
      runDelegation: (root, id) => this.runDelegation(root, id),
      automationRuntime: root => this.automationRuntime(root),
      automationLog: (root, runId, stream, offset, limit) => this.automationLog(root, runId, stream, offset, limit),
      show: async input => {
        const result = await this.show(use(session.requireInstance()), input);
        if (navigationOrigin) return { route: `/${result.route}`, url: `${navigationOrigin}/${result.route}`, outcome: 'RETURNED' as const };
        return finishShow(result, openBrowser);
      },
      showUrl: async input => {
        const result = await this.show(use(session.requireInstance()), input);
        return navigationOrigin ? `${navigationOrigin}/${result.route}` : result.url ?? `http://localhost:${result.port}/${result.route}`;
      },
    });
  }

  private run(loaded: Loaded, name: string, args: any, signal?: AbortSignal): string | Promise<string> {
    switch (name) {
      case 'query_artifacts': return handleQueryArtifacts(loaded.store, args, { matcher: this.searches, signal });
      case 'create_artifact':
      case 'update_artifact': return this.mutate(loaded, name, args).text!;
      default: throw new Error(`Unknown operation: ${name}`);
    }
  }

  private mutate(loaded: Loaded, operation: string | (() => MutationPlan), args?: any): MutationOutcome & {mutationResult: MutationResult} {
    let previousId = loaded.store.getManifest().id;
    let plan: MutationPlan;
    let identityRefreshAttempted = false;
    const refreshAdoptedIdentity = () => {
      if (!identityRefreshAttempted && previousId !== loaded.store.getManifest().id) {
        identityRefreshAttempted = true;
        this.sources.refresh(loaded.store);
      }
    };
    try {
      const {value, result, readbackError} = this.sources.mutation(loaded.store, () => {
        const outcome = this.performMutation(loaded, plan.operation, plan.input);
        refreshAdoptedIdentity();
        return outcome;
      }, {prepare: () => {
        previousId = loaded.store.getManifest().id;
        plan = typeof operation === 'function' ? operation() : {operation, input: args};
        plan.input = validateToolArgs(plan.operation, plan.input);
        return plan.beforeWrite;
      }, readback: typeof operation === 'function'});
      return {...value, mutationResult: result, ...(readbackError ? {readbackError} : {})};
    } catch (error) {
      try {refreshAdoptedIdentity();} catch { /* The owner retains readback diagnostics and retries. */ }
      throw error;
    }
  }

  private performMutation(loaded: Loaded, name: string, args: any): MutationOutcome {
    const { store } = loaded;
    switch (name) {
      case 'create_artifact': return createArtifact(store, args);
      case 'update_artifact': return { id: args.id, text: handleUpdateArtifact(store, args) };
      case 'update_instance': {
        const before = store.getManifest().config;
        handleUpdateInstance(store, args);
        const after = store.getManifest().config;
        const was = eventTitlePrefixes(before), now = eventTitlePrefixes(after);
        if (was.active === now.active && was.done === now.done) return {};
        const warnings = this.calendarWarnings(loaded, this.scheduledActions(store).filter(action => !!action.frontMatter.calendar));
        return warnings.length ? {warnings} : {};
      }
      case 'update_project': return { id: args.id, ...outcomeWarnings(handleUpdateProject(store, args)) };
      case 'capture': {
        const result = handleCapture(store, args);
        return { ...result, ...outcomeWarnings(undefined, this.createdCalendarWarnings(loaded, result.createdActionIds)) };
      }
      case 'update_entry': {
        const {warning, ...result} = handleUpdateEntry(store, args);
        return { ...result, entryId: args.id, ...outcomeWarnings(warning, this.createdCalendarWarnings(loaded, result.createdActionIds)) };
      }
      case 'update_occurrence': {
        const {warning, ...result} = handleUpdateOccurrence(store, args);
        const a = storeAction(store, result.id)!;
        return {...result, ...outcomeWarnings(warning, a.frontMatter.calendar ? this.calendarWarnings(loaded, [a]) : [])};
      }
      case 'update_action': {
        const before = storeAction(store, args.id);
        if (args.recurrence?.append != null && before && before.frontMatter.recurrence == null && !before.frontMatter.occurrence &&
          before.frontMatter.scheduled && before.frontMatter.calendar) {
          loaded.sync.prepareTemplateConversion(before);
        }
        const warning = handleUpdateAction(store, args);
        const action = storeAction(store, args.id);
        return {id: args.id, ...outcomeWarnings(warning, action && (action.frontMatter.calendar || args.calendar === null) ? this.calendarWarnings(loaded, [action]) : [])};
      }
      default: throw new Error(`Unknown operation: ${name}`);
    }
  }

  // All scheduled actions an instance currently knows, to seed the cache sweep.
  // Through storeAction, so callers get the same defensive copy every other
  // SyncAction consumer gets — never the store's live frontMatter reference.
  private scheduledActions(store: Store): SyncAction[] {
    return store.getActionIds()
      .map((id) => storeAction(store, id)!)
      .filter((a) => a.frontMatter.scheduled || a.frontMatter.recurrence || a.frontMatter.occurrence);
  }

  private track(work: Promise<unknown>): void {
    const settled = work.catch(() => {}).finally(() => this.inFlight.delete(settled));
    this.inFlight.add(settled);
  }

  // Warning metadata is generated from observed states.
  private calendarWarnings(loaded: Loaded, actions: SyncAction[]): string[] {
    return [...new Set(actions.flatMap(action => {
      const state = loaded.sync.status(action.id);
      if (!state || state.status === 'synced' || state.status === 'removed') return [];
      if (state.status === 'disabled' && state.reason === 'no calendar') return [];
      if (state.status === 'pending' && !state.retry && (!state.diagnostic || state.diagnostic.category === 'sync-pending')) return [];
      const reason = state.diagnostic?.reason ?? state.reason ?? 'Calendar work has not completed.';
      return [`Calendar sync for ${JSON.stringify(action.id)} is ${state.status}: ${reason} Inspect activeInstance.calendarSync through query for recovery guidance.`];
    }))];
  }

  private createdCalendarWarnings(loaded: Loaded, ids: string[]): string[] {
    const actions = ids.map(id => storeAction(loaded.store, id)).filter((action): action is SyncAction =>
      !!action && !!action.frontMatter.calendar && !!(action.frontMatter.scheduled || action.frontMatter.recurrence));
    return this.calendarWarnings(loaded, actions);
  }

  // One server belongs to the host, independently of any loaded instance.
  async web(appDir?: string): Promise<AsideWebServer> {
    if (this.webServer) {
      if (appDir) this.webServer.setAppDir(resolveAppDir(appDir));
      return this.webServer;
    }
    this.webStarting ??= startWeb(resolveAppDir(appDir), this.webBackend, this.webPort).then(server => {
      server.onTabsChanged = () => this.onTabsChanged?.();
      this.webServer = server;
      return server;
    }).finally(() => { this.webStarting = undefined; });
    return this.webStarting;
  }

  async show(path: string, args: ShowArgs, appDir?: string): Promise<ShowResult> {
    const validated = validateToolArgs('show', args);
    const viewRoute = buildShowRoute(this.load(path).store, validated);
    const server = await this.web(appDir);
    const route = server.routeFor(this.key(path), viewRoute);
    return { route, port: server.port, url: `${server.origin}/${route}`, tab: false };
  }

  async serve(appDir?: string): Promise<ShowResult> {
    const server = await this.web(appDir);
    return { route: '', port: server.port, url: `${server.origin}/`, tab: false };
  }

  // Settle calendar work before exit: wait for forward syncs in flight, then
  // give every instance's retry queue one attempt.
  async flush(timeoutMs = CALENDAR_FLUSH_TIMEOUT_MS): Promise<void> {
    const work = (async () => {
      await this.sources.flush();
      await Promise.all([...this.inFlight]);
      await Promise.all([...this.instances.values()].map(({ store, sync }) =>
        sync.statuses().some((s) => s.status === 'pending')
          ? this.calendars.reconcile(store).catch(() => {})
          : undefined));
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
  }

  stopQueries(): void {
    this.searches.close();
    this.semanticStopped = true;
    this.semanticClosing ??= Promise.all([this.semanticLifecycle?.close(), this.semanticSearches?.close()]).then(() => {});
  }

  close(): Promise<void> {
    this.stopQueries();
    this.sources.close();
    void this.stopAutomation();
    for (const { key } of this.loaded()) {
      try { this.unloadKey(key); } catch {}
    }
    this.webServer?.close();
    void this.webStarting?.then(server => server.close()).catch(() => {});
    this.cal.close();
    return Promise.all([this.usageLog.flush(2_000), this.semanticClosing]).then(() => {});
  }
}
