import { handleUpdateOccurrence, handlePlanningActions } from '../mcp/tools/recurrence.js';
import { handleQueryInstance, handleUpdateInstance } from '../mcp/tools/instance.js';
import { AutomationController } from '../automation/controller.js';
import { catalogFor } from '../automation/models.js';
import type { AutomationSource } from '../automation/scheduler.js';
import { delegationSource } from '../automation/delegation.js';
import type { DelegationRequest, PreparedDelegation } from '../automation/delegation-protocol.js';
import type { RunRecord } from '../automation/storage.js';
import { assertDelegation } from '../core/delegation.js';
import { projectionId, resolveProjection } from '../core/recurrence.js';
import { scheduleInstant } from '../core/scheduling.js';
import { automationRuntimeSnapshot, readAutomationLog, type AutomationLogStream } from '../graphql/automation-runtime.js';
import { INSTANCE_IDENTITY_POLL_MS, CALENDAR_RECONCILE_DEBOUNCE_MS, CALENDAR_FLUSH_TIMEOUT_MS } from '../core/system-config.js';
import { RegexWorkerPool } from '../mcp/search.js';
// The daemon's instance host: every loaded instance's record cache, calendar
// syncer, and web server, plus the operations clients run against them (see
// design/daemon.md, Roles). It owns no sockets — the daemon wraps it — so the
// same host runs in-process under tests.
import { realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { validateToolArgs } from '../mcp/schemas.js';
import { Store } from '../mcp/store.js';
import { handleQueryEntries, handleQueryActions, handleQueryProjects, handleQueryArtifacts } from '../mcp/tools/query.js';
import { createArtifact, handleUpdateArtifact } from '../mcp/tools/artifact.js';
import { executeGraphQL, readGraphQLSchema, type MutationOutcome, type GraphQLArgs } from '../graphql/schema.js';
import { GraphQLUsageLog } from '../graphql/usage.js';
import type { InstanceSession } from '../mcp/instance-session.js';
import { handleCapture } from '../mcp/tools/capture.js';
import { handleUpdateAction, handleUpdateProject, handleUpdateEntry } from '../mcp/tools/update.js';
import { trackMutation } from '../mcp/tools/mutation-result.js';
import { buildShowRoute, finishShow, type ShowArgs } from '../mcp/tools/show.js';
import { startWeb, resolveAppDir, openBrowser } from '../web/locate.js';
import { availableInstances } from '../web/catalogue.js';
import { instanceCardSummary } from '../web/summary.js';
import type { WebBackend } from '../web/server.js';
import type { AsideWebServer } from '../web/server.js';
import { WEB_QUERY_MAX_RESPONSE_BYTES } from '../core/web-query.js';
import { CalClient } from '../mcp/calendar/client.js';
import { CalSync, storeAction, type SyncAction, type CalendarSyncStatus } from '../mcp/calendar/sync.js';
import { handleCalendarInfo, collectCalendarInfo, formatSyncStatusLines } from '../mcp/calendar/info.js';
import { formatScalar } from '../mcp/format.js';
import { isAsideDir, readManifest, readManifestResult, shouldRetainKnownInstance } from '../core/instance.js';
import { isInstanceId } from '../core/identity.js';
import { checkoutInfo, instanceFamily, worktreeCalendarReason } from '../core/worktree.js';
import type { ParseIssue } from '../core/types.js';
import { daemonPaths } from './paths.js';
import { WebAuth } from '../web/auth.js';

export interface ToolResult {
  text: string;
  // The instance's parse issues after the operation, when the caller asked.
  issues?: ParseIssue[];
}

export interface ShowResult {
  route: string;
  port: number;
  // Handoffs leave connected tabs untouched.
  tab: boolean;
  url?: string;
  // Private local handoff file; showUrl returns this for caller-managed opening.
  launchUrl?: string;
}

interface Loaded {
  // The identity it was loaded under; kept, since the path may stop resolving.
  key: string;
  path: string;
  store: Store;
  sync: CalSync;
  unwatchAutomation?: () => void;
}

// Operations that only read; a client may repeat them after a lost connection.
export const READ_TOOLS = new Set(['planning_actions', 'query_models', 'query_instance', 'query_entries', 'query_actions', 'query_projects', 'query_artifacts', 'query', 'calendar_info']);

// One key per instance however its path is spelled.
export function instanceKey(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export class InstanceHost {
  private usageLog = new GraphQLUsageLog();
  configureUsage(logs: string): void { this.usageLog = new GraphQLUsageLog({logs}); }
  usageStatus() { return this.usageLog.status(); }
  async cleanupDiagnostics() {
    const [usage, automation] = await Promise.allSettled([
      this.usageLog.cleanup(), this.automation?.cleanup() ?? {runs: 0},
    ]);
    if (usage.status === 'rejected') throw usage.reason;
    if (automation.status === 'rejected') throw automation.reason;
    return {usage: usage.value, automation: automation.value};
  }
  async purgeDiagnostics(root?: string) {
    const [usage, automation] = await Promise.allSettled([
      this.usageLog.purge(root), this.automation?.purge(root) ?? {runs: 0},
    ]);
    if (usage.status === 'rejected') throw usage.reason;
    if (automation.status === 'rejected') throw automation.reason;
    return {usage: usage.value, automation: automation.value};
  }
  readonly cal: CalClient;
  private automation?: AutomationController;
  private automationStorage?: string;
  configureAutomation(storage: string): void {
    this.automationStorage = storage;
    this.automation = new AutomationController(storage, {prepare: request => this.prepareDelegation(request), complete: (source, run) => this.completeDelegation(source, run)});
    for (const loaded of this.instances.values()) this.observeAutomation(loaded);
  }
  automationStatus() { return this.automation?.inspect() ?? Promise.resolve({ jobs: [], runs: [] }); }
  private async automationRuntime(root: string) {
    const inspection = this.automation ? await this.automation.inspect(instanceKey(root))
      : { available: false, jobs: [], runs: [], warning: 'Automation runtime is unavailable because this host has no automation controller.' };
    return automationRuntimeSnapshot(instanceKey(root), inspection);
  }
  private async automationLog(root: string, runId: string, stream: AutomationLogStream, offset: number, limit: number) {
    return this.automationStorage ? readAutomationLog(this.automationStorage, instanceKey(root), runId, stream, offset, limit) : null;
  }
  stopAutomation(): Promise<void> { return this.automation?.close() ?? Promise.resolve(); }
  private observeAutomation(loaded: Loaded): void {
    loaded.unwatchAutomation = loaded.store.onChange(() => {
      this.refreshIdentities(); this.refreshAutomation(loaded);
    });
    this.refreshAutomation(loaded);
  }
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
      issues.some(issue => issue.code === 'rebuild_failed') ? 'Automation is paused because the instance could not be reloaded.' : undefined;
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
    this.automation.replace(path, sources);
  }
  private delegationBlock(loaded: Loaded, id: string): string | undefined {
    const topology = checkoutInfo(loaded.path);
    if (!isInstanceId(loaded.store.getManifest().id)) return 'Delegation requires a valid instance id.';
    if (topology.error) return `Cannot verify delegation checkout: ${topology.error}`;
    if (topology.worktree?.linked) return `Delegation is paused in this Git worktree. Use the primary checkout: ${topology.worktree.primaryPath}`;
    const identity = this.identityIssue(loaded.path);
    if (identity) return identity.message.replace(/Calendar sync/g, 'Delegation');
    const file = loaded.store.getActionFile(id);
    return loaded.store.getIssues().find(issue => issue.severity === 'error' && (issue.code === 'rebuild_failed' ||
      file && (issue.file === file || issue.file === relative(loaded.path, file))))?.message;
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
    const blocked = this.delegationBlock(loaded, loaded.store.getAction(target.id) ? target.id : target.action.frontMatter.occurrence?.template ?? target.id);
    if (blocked) throw new Error(blocked);
    return this.automation.dispatch(delegationSource(loaded.path, loaded.store.getManifest().id, target.id, target.action));
  }
  private prepareDelegation(request: DelegationRequest): PreparedDelegation {
    const loaded = this.instances.get(request.source.root);
    if (!loaded) throw new Error('Delegation instance is no longer loaded.');
    const target = this.delegationAction(loaded, request.target.id);
    const fm = target.action.frontMatter;
    const blocked = this.delegationBlock(loaded, loaded.store.getAction(target.id) ? target.id : fm.occurrence?.template ?? target.id);
    if (blocked) throw new Error(blocked);
    if (loaded.store.getManifest().id !== request.source.instance) throw new Error('Delegation instance identity changed before dispatch.');
    const definition = assertDelegation(fm.delegation);
    if (fm.recurrence !== undefined) throw new Error('Run a projected occurrence, not the recurrence template.');
    if (request.automatic && (fm.resolution || !fm.scheduled || scheduleInstant(fm.scheduled, fm.timezone) !== request.target.at)) throw new Error('Action is resolved or its delegation schedule changed before dispatch.');
    const expected = request.target.action.frontMatter;
    if (JSON.stringify(definition) !== JSON.stringify(assertDelegation(expected.delegation)) || fm.scheduled !== expected.scheduled || fm.timezone !== expected.timezone) throw new Error('Action delegation changed before dispatch.');
    return {source: delegationSource(loaded.path, request.source.instance, target.id, target.action)};
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
  private webState = daemonPaths().state;
  private webStarting?: Promise<AsideWebServer>;
  private webBackend: WebBackend = {
    instances: () => availableInstances(this.loadedPaths()),
    summary: path => this.summary(path),
    register: async () => { throw new Error('Instance registration requires the daemon.'); },
    remove: () => { throw new Error('Instance removal requires the daemon.'); },
    load: path => { this.load(path); },
    data: (path, refresh) => this.data(path, refresh),
    query: (path, args, signal) => this.webQuery(path, args, signal),
  };

  async data(path: string, refresh = false) {
    const store = this.load(path).store;
    if (refresh) store.rebuild();
    return store.snapshot();
  }

  webQuery(path: string, args: GraphQLArgs, signal: AbortSignal) {
    return executeGraphQL(() => this.load(path).store, 'query', args, {
      matcher: this.searches, signal, maxFields: 10_000, maxResponseBytes: WEB_QUERY_MAX_RESPONSE_BYTES,
      maxSerializedResponseBytes: WEB_QUERY_MAX_RESPONSE_BYTES,
    });
  }

  summary(path: string) {
    const loaded = this.instances.get(instanceKey(path));
    return loaded ? instanceCardSummary(loaded.store) : undefined;
  }

  configureWeb(backend: WebBackend, port?: number, stateDirectory = daemonPaths().state): void {
    this.webBackend = backend; this.webPort = port; this.webState = stateDirectory;
  }
  // Forward syncs still running, awaited by flush() before the daemon exits.
  private inFlight = new Set<Promise<unknown>>();
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private knownPaths: () => string[] = () => [];
  private identityTimer: ReturnType<typeof setInterval> | undefined;
  private identityStates = new Map<string, string>();
  private observedIdentities = new Map<string, string>();
  // Called when a webapp tab connects or disconnects.
  onTabsChanged: (() => void) | undefined;

  constructor(cal: CalClient = new CalClient(), private searches = new RegexWorkerPool()) {
    this.cal = cal;
    // The helper's `changed` signal is coarse and can fire in bursts (incl. our
    // own writes), so debounce, then reverse-reconcile every loaded instance.
    cal.onChanged(() => this.scheduleReconcile());
  }

  isLoaded(path: string): boolean {
    return this.instances.has(instanceKey(path));
  }

  loadedPaths(): string[] {
    return [...this.instances.values()].map((i) => i.path);
  }

  setKnownPaths(paths: () => string[]): void {
    this.knownPaths = paths;
    this.refreshIdentities();
  }

  private readIdentities(extraPath?: string) {
    const paths = new Set([...this.knownPaths(), ...this.loadedPaths()].map(instanceKey));
    if (extraPath) paths.add(instanceKey(extraPath));
    // Forgetting an unloaded registration or verifying its removal can clear
    // an observation. A failed read cannot prove that its identity changed.
    for (const observed of this.observedIdentities.keys()) if (!paths.has(observed)) this.observedIdentities.delete(observed);
    return [...paths].sort().map(path => {
      const result = readManifestResult(path), readError = result.issues.find(issue => issue.code === 'read_error');
      if (!readError) {
        if (isInstanceId(result.value.id)) this.observedIdentities.set(path, result.value.id);
        else this.observedIdentities.delete(path);
      }
      return { path, id: readError ? this.observedIdentities.get(path) ?? '' : result.value.id, readError };
    });
  }

  private identityIssue(path: string): ParseIssue | null {
    const key = instanceKey(path), observations = this.readIdentities(path);
    const id = observations.find(observation => observation.path === key)?.id;
    if (!id || !isInstanceId(id)) return null; // the manifest parser reports invalid IDs
    const family = instanceFamily(key);
    const conflicts = observations.filter(observation => observation.id === id && instanceFamily(observation.path) !== family).map(observation => observation.path);
    if (conflicts.length) conflicts.unshift(key);
    // On cold startup the catalogue carries paths only. An unknown registered
    // identity cannot certify uniqueness; a verified distinct identity can.
    const unreadable = observations.filter(observation => observation.readError && (!observation.id || observation.id === id) && instanceFamily(observation.path) !== family);
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
    this.readIdentities();
    for (const { key, path, store, sync } of this.instances.values()) {
      const state = `${readManifest(path).id}\n${this.calendarBlock(path) ?? ''}`;
      if (this.identityStates.get(key) === state) continue;
      this.identityStates.set(key, state);
      this.refreshAutomation(this.instances.get(key)!);
      this.track(sync.syncActions([], this.scheduledActions(store)).then(() => sync.reconcile(this.scheduledActions(store))));
    }
  }

  // Every loaded instance by the key it was loaded under, with its open tabs.
  loaded(): Array<{ key: string; path: string; tabs: number }> {
    return [...this.instances.values()].map((i) => ({ key: i.key, path: i.path, tabs: this.webServer?.tabsForPath(i.key) ?? 0 }));
  }

  // Load an instance — cache, watcher, calendar syncer — or return it loaded.
  load(path: string): Loaded {
    const key = instanceKey(path);
    if (!isAsideDir(key)) {
      const error = readManifestResult(key).issues.find(issue => issue.code === 'read_error');
      if (!shouldRetainKnownInstance(key)) this.unloadKey(key);
      throw new Error(error?.message ?? `Not an aside instance (no aside.md manifest): ${key}`);
    }
    const existing = this.instances.get(key);
    if (existing) return existing;
    const abs = key;
    const store = new Store(abs);
    store.watch();
    // The syncer reads the instance id and config from the store's manifest at
    // use time, so a later aside.md edit (e.g. adding the missing `id`) takes
    // effect without a reload; no fallback values are injected here.
    const loaded: Loaded = { key, path: abs, store, sync: new CalSync(this.cal, '', store, undefined, () => this.calendarBlock(abs)) };
    this.instances.set(key, loaded);
    if (this.automation) this.observeAutomation(loaded);
    this.refreshIdentities();
    this.identityTimer ??= setInterval(() => this.refreshIdentities(), INSTANCE_IDENTITY_POLL_MS);
    this.identityTimer.unref?.();
    this.scheduleReconcile(); // catch up on calendar edits made while it was not loaded
    return loaded;
  }

  private calendarBlock(path: string): string | null {
    return worktreeCalendarReason(path) ?? this.identityIssue(path)?.message ?? null;
  }

  // Catalogue metadata must reflect loaded-but-forgotten identity guards too,
  // without opening their stores or presenting expected worktree info as a warning.
  calendarWarning(path: string): string | undefined {
    return this.identityIssue(path)?.message ?? checkoutInfo(path).error;
  }

  unload(path: string): void {
    this.unloadKey(instanceKey(path));
  }

  unloadKey(key: string): void {
    const loaded = this.instances.get(key);
    if (!loaded) return;
    this.instances.delete(key);
    this.identityStates.delete(key);
    this.automation?.replace(loaded.path, []);
    loaded.unwatchAutomation?.();
    loaded.store.close();
    loaded.sync.dispose();
  }

  issues(path: string): ParseIssue[] {
    const issues = [...this.load(path).store.getIssues()];
    const conflict = this.identityIssue(path);
    if (conflict) issues.push(conflict);
    for (const message of this.automation?.issues(instanceKey(path)) ?? []) issues.push({ severity: 'error', code: 'automation_error', message });
    return issues;
  }

  tabCount(): number {
    return this.webServer?.tabCount ?? 0;
  }

  // Run one tool against an instance. `calendar_info` also runs with no
  // instance: auth and calendars are machine-level.
  async tool(path: string | null, name: string, args: unknown, withIssues = false, signal?: AbortSignal): Promise<ToolResult> {
    args = validateToolArgs(name, args);
    if (name === 'calendar_info') {
      return { text: await handleCalendarInfo(this.cal, path ? this.load(path).sync : undefined) };
    }
    if (!path) throw new Error('No instance named for this operation.');
    const loaded = this.load(path);
    // A caller reporting issues is a one-shot command: it expects the files as
    // they are on disk now, ahead of the watcher's debounce.
    if (withIssues) loaded.store.rebuild();
    const snapshotIssues = withIssues && READ_TOOLS.has(name) ? this.issues(path) : undefined;
    const text = await this.run(loaded, name, args ?? {}, signal);
    if (!withIssues) return { text };
    if (!READ_TOOLS.has(name)) loaded.store.rebuild();
    return { text, issues: snapshotIssues ?? this.issues(path) };
  }

  async graphqlSchema(session: InstanceSession, signal?: AbortSignal) {
    const result = await readGraphQLSchema(session.registry.activeInstance, {signal});
    return {...result, diagnostics: [...session.diagnostics, ...result.diagnostics]};
  }

  // A GraphQL MCP request includes session selection explicitly. Store access
  // is lazy so discovery, introspection, and instance creation need no default.
  graphql(session: InstanceSession, mode: 'query' | 'mutation', args: GraphQLArgs, signal?: AbortSignal, use: (path: string) => string = path => path) {
    return executeGraphQL(() => this.load(use(session.requireInstance())).store, mode, args, {
      usageLog: this.usageLog,
      instances: session, matcher: this.searches, signal,
      mutate: (operation, input) => this.mutate(this.load(session.requireInstance()), operation, validateToolArgs(operation, input)),
      calendarInfo: () => collectCalendarInfo(this.cal, session.registry.activeInstance ? this.load(use(session.requireInstance())).sync : undefined),
      runDelegation: (root, id) => this.runDelegation(root, id),
      automationRuntime: root => this.automationRuntime(root),
      automationLog: (root, runId, stream, offset, limit) => this.automationLog(root, runId, stream, offset, limit),
      show: async input => finishShow(await this.show(use(session.requireInstance()), input), openBrowser),
      showUrl: async input => {
        const {launchUrl} = await this.show(use(session.requireInstance()), input);
        if (!launchUrl) throw new Error('Could not prepare browser authorization. Request showUrl again.');
        return launchUrl;
      },
    });
  }

  private run(loaded: Loaded, name: string, args: any, signal?: AbortSignal): string | Promise<string> {
    const { store } = loaded;
    switch (name) {
      case 'query_models': return catalogFor(store.getDataDir(), {refresh: args.refresh ?? false, signal}).then(({models, diagnostics}) => JSON.stringify({models, diagnostics}));
      case 'query_instance': return handleQueryInstance(store);
      case 'update_instance': return this.mutate(loaded, name, args).text;
      case 'query_entries': return handleQueryEntries(store, args, { matcher: this.searches, signal });
      case 'planning_actions': return handlePlanningActions(store, args);
      case 'query_actions': return handleQueryActions(store, args, { matcher: this.searches, signal });
      case 'query_projects': return handleQueryProjects(store, args, { matcher: this.searches, signal });
      case 'query_artifacts': return handleQueryArtifacts(store, args, { matcher: this.searches, signal });
      case 'query':
      case 'mutate':
        return executeGraphQL(store, name === 'query' ? 'query' : 'mutation', args, {
          usageLog: this.usageLog,
          matcher: this.searches, signal,
          mutate: (operation, input) => this.mutate(loaded, operation, validateToolArgs(operation, input)),
          runDelegation: (root, id) => this.runDelegation(root, id),
          automationRuntime: root => this.automationRuntime(root),
          automationLog: (root, runId, stream, offset, limit) => this.automationLog(root, runId, stream, offset, limit),
        }).then(result => JSON.stringify(result));
      default: return this.mutate(loaded, name, args).text;
    }
  }

  private mutate(loaded: Loaded, name: string, args: any): MutationOutcome {
    const {value, result} = trackMutation(loaded.store, () => this.performMutation(loaded, name, args));
    return {...value, mutationResult: result};
  }

  private performMutation(loaded: Loaded, name: string, args: any): MutationOutcome {
    const { store } = loaded;
    switch (name) {
      case 'create_artifact': return createArtifact(store, args);
      case 'update_artifact': return { id: args.id, text: handleUpdateArtifact(store, args) };
      case 'update_instance': {
        const before = store.getManifest().config;
        let text = handleUpdateInstance(store, args);
        const after = store.getManifest().config;
        let warnings: string[] | undefined;
        if ((before?.scheduledEventTitlePrefix ?? '▢ ') !== (after?.scheduledEventTitlePrefix ?? '▢ ') ||
          (before?.doneEventTitlePrefix ?? '✓ ') !== (after?.doneEventTitlePrefix ?? '✓ ')) {
          const actions = this.scheduledActions(store);
          this.track(loaded.sync.syncActions(actions, actions));
          text += this.noInstanceIdNote(store, actions.some(action => !!action.frontMatter.calendar))
            + this.calendarSyncNote(loaded, actions);
          warnings = this.calendarWarnings(loaded, actions.filter(action => !!action.frontMatter.calendar));
        }
        return {text, ...(warnings?.length ? {warnings} : {})};
      }
      case 'update_project': return { id: args.id, text: handleUpdateProject(store, args) };
      case 'capture': {
        const result = handleCapture(store, args);
        const text = result.text + this.syncCreatedActions(loaded, result.createdActionIds);
        const warnings = this.createdCalendarWarnings(loaded, result.createdActionIds);
        return { ...result, text, ...(warnings.length ? {warnings} : {}) };
      }
      case 'update_entry': {
        const result = handleUpdateEntry(store, args);
        const text = result.text + this.syncCreatedActions(loaded, result.createdActionIds);
        const warnings = this.createdCalendarWarnings(loaded, result.createdActionIds);
        return { ...result, entryId: args.id, text, ...(warnings.length ? {warnings} : {}) };
      }
      case 'update_occurrence': {
        const result = handleUpdateOccurrence(store, args);
        const a = storeAction(store, result.id)!;
        this.track(loaded.sync.syncActions([a], this.scheduledActions(store)));
        const warnings = a.frontMatter.calendar ? this.calendarWarnings(loaded, [a]) : [];
        return {...result, ...(warnings.length ? {warnings} : {})};
      }
      case 'update_action': {
        const text = this.updateAction(loaded, args);
        const action = storeAction(store, args.id);
        const warnings = action && (action.frontMatter.calendar || args.calendar === null) ? this.calendarWarnings(loaded, [action]) : [];
        return {id: args.id, text, ...(warnings.length ? {warnings} : {})};
      }
      default: throw new Error(`Unknown operation: ${name}`);
    }
  }

  private updateAction(loaded: Loaded, args: any): string {
    const { store, sync } = loaded;
    const before = storeAction(store, args.id);
    if (args.recurrence?.append != null && before && before.frontMatter.recurrence == null && !before.frontMatter.occurrence &&
      before.frontMatter.scheduled && before.frontMatter.calendar) {
      sync.prepareTemplateConversion(before);
    }
    const text = handleUpdateAction(store, args);
    // Forward-sync the action's new lifecycle state (reschedule/complete/cancel/
    // deschedule). Sync when the action has a calendar, or when this update just
    // removed it (calendar: null → stop syncing, which removes the event).
    // Fire-and-forget, best-effort.
    const a = storeAction(store, args.id);
    if (a && (a.frontMatter.calendar || args.calendar === null)) {
      this.track(sync.syncActions([a], this.scheduledActions(store)));
    }
    // Remind when this update set a scheduled time but left no calendar to sync to
    // (descheduling — args.scheduled null — is not a gap, so skip it).
    let note = '';
    if (a && args.scheduled != null && a.frontMatter.scheduled && !a.frontMatter.calendar) {
      note = this.unsyncedNote([a.id]);
    }
    // Flag a sync that can't happen because the instance has no `id`.
    note += this.noInstanceIdNote(store, !!(a && (a.frontMatter.scheduled || a.frontMatter.recurrence) && a.frontMatter.calendar));
    if (a && (a.frontMatter.scheduled || a.frontMatter.calendar || args.calendar === null)) {
      note += this.calendarSyncNote(loaded, [a]);
    }
    return text + note;
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

  // Forward-sync newly created actions that are scheduled and pinned to a
  // calendar, reading them from the store the creating tool just updated (no
  // re-parsing the text). Fire-and-forget so a slow/hung helper never delays the
  // tool response. Receipts distinguish the saved record from calendar work.
  // Shared by capture and update_entry — the two tools that create actions.
  private syncCreatedActions(loaded: Loaded, createdActionIds: string[]): string {
    const { store, sync } = loaded;
    const created = createdActionIds
      .map((id) => storeAction(store, id))
      .filter((a): a is SyncAction => a !== null);
    const toSync = created.filter((a) => (a.frontMatter.scheduled || a.frontMatter.recurrence) && a.frontMatter.calendar);
    if (toSync.length > 0) {
      this.track(sync.syncActions(toSync, this.scheduledActions(store)));
    }
    return this.unsyncedNote(created.filter((a) => a.frontMatter.scheduled && !a.frontMatter.calendar).map((a) => a.id))
      + this.noInstanceIdNote(store, toSync.length > 0)
      + this.calendarSyncNote(loaded, created.filter((a) => a.frontMatter.scheduled));
  }

  private calendarSyncNote(loaded: Loaded, actions: SyncAction[]): string {
    if (actions.length === 0) return '';
    const states: CalendarSyncStatus[] = actions.map((a) => {
      const observed = loaded.sync.status(a.id);
      if (observed) return observed;
      if (a.frontMatter.scheduled && !a.frontMatter.calendar) {
        return { id: a.id, status: 'disabled', reason: 'no calendar' };
      }
      return { id: a.id, status: 'pending' };
    });
    return '\n\n' + formatSyncStatusLines(states).join('\n');
  }

  // Warning metadata is generated from observed states, never parsed from a
  // receipt that can also contain user-authored names and Markdown.
  private calendarWarnings(loaded: Loaded, actions: SyncAction[]): string[] {
    return [...new Set(actions.flatMap(action => {
      const state = loaded.sync.status(action.id);
      if (!state || state.status === 'synced' || state.status === 'removed') return [];
      if (state.status === 'disabled' && state.reason === 'no calendar') return [];
      if (state.status === 'pending' && !state.retry && (!state.diagnostic || state.diagnostic.category === 'sync-pending')) return [];
      const reason = state.diagnostic?.reason ?? state.reason ?? 'Calendar work has not completed.';
      return [`Calendar sync for ${JSON.stringify(action.id)} is ${state.status}: ${reason} Inspect calendarInfo through mutate for recovery guidance.`];
    }))];
  }

  private createdCalendarWarnings(loaded: Loaded, ids: string[]): string[] {
    const actions = ids.map(id => storeAction(loaded.store, id)).filter((action): action is SyncAction =>
      !!action && !!action.frontMatter.calendar && !!(action.frontMatter.scheduled || action.frontMatter.recurrence));
    return this.calendarWarnings(loaded, actions);
  }

  // A note appended to capture/update output when an action is scheduled but has
  // no calendar, so the unsynced gap is visible at the moment of the change rather
  // than only via a later reconcile. Gated on the helper being present — without
  // it, calendar sync isn't set up on this machine and the reminder is just noise.
  private unsyncedNote(ids: string[]): string {
    if (!this.cal.available() || ids.length === 0) return '';
    return `\n\nScheduled without a calendar (not synced): ${ids.map(formatScalar).join(', ')}. Set the action's \`calendar\` to sync it to a calendar, or leave it as-is for no calendar sync.`;
  }

  // A note appended when an action would sync (scheduled + calendar) but the
  // instance's readable aside.md has no `id` — the marker anchor — so sync is disabled.
  // Surfaced at the moment of the change so the failure isn't silent.
  private noInstanceIdNote(store: Store, wouldSync: boolean): string {
    if (!this.cal.available() || !wouldSync) return '';
    const manifest = readManifestResult(store.getDataDir());
    if (manifest.value.id || manifest.issues.some(issue => issue.code === 'read_error')) return '';
    return `\n\nCalendar sync is disabled: this instance's aside.md has no \`id\`. Add an \`id\` to aside.md to sync scheduled actions to the calendar.`;
  }

  private scheduleReconcile(): void {
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      for (const { store, sync } of this.instances.values()) {
        void sync.reconcile(this.scheduledActions(store)).catch(() => {});
      }
    }, CALENDAR_RECONCILE_DEBOUNCE_MS);
    this.reconcileTimer.unref?.();
  }

  // One server belongs to the host, independently of any loaded instance.
  async web(appDir?: string): Promise<AsideWebServer> {
    if (this.webServer) {
      if (appDir) this.webServer.setAppDir(resolveAppDir(appDir));
      return this.webServer;
    }
    this.webStarting ??= startWeb(resolveAppDir(appDir), this.webBackend, this.webPort, {
      auth: new WebAuth(this.webState), stateDirectory: this.webState,
    }).then(server => {
      server.onTabsChanged = () => this.onTabsChanged?.();
      this.webServer = server;
      return server;
    }).finally(() => { this.webStarting = undefined; });
    return this.webStarting;
  }

  async show(path: string, args: ShowArgs, appDir?: string, navigate = true): Promise<ShowResult> {
    const validated = validateToolArgs('show', args);
    const viewRoute = buildShowRoute(this.load(path).store, validated);
    const server = await this.web(appDir);
    const key = instanceKey(path);
    const route = server.routeFor(key, viewRoute);
    return { route, port: server.port, ...await server.show(key, route, navigate) };
  }

  async serve(appDir?: string, navigate = true): Promise<ShowResult> {
    const server = await this.web(appDir);
    return { route: '', port: server.port, ...await server.show(null, '', navigate) };
  }

  // Settle calendar work before exit: wait for forward syncs in flight, then
  // give every instance's retry queue one attempt.
  async flush(timeoutMs = CALENDAR_FLUSH_TIMEOUT_MS): Promise<void> {
    const work = (async () => {
      await Promise.all([...this.inFlight]);
      await Promise.all([...this.instances.values()].map(({ store, sync }) =>
        sync.statuses().some((s) => s.status === 'pending')
          ? sync.syncActions([], this.scheduledActions(store)).catch(() => {})
          : undefined));
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
  }

  stopQueries(): void { this.searches.close(); }

  close(): Promise<void> {
    this.stopQueries();
    void this.stopAutomation();
    clearTimeout(this.reconcileTimer);
    clearInterval(this.identityTimer);
    for (const { key } of this.loaded()) {
      try { this.unloadKey(key); } catch {}
    }
    this.webServer?.close();
    void this.webStarting?.then(server => server.close()).catch(() => {});
    this.cal.close();
    return this.usageLog.flush(2_000);
  }
}
