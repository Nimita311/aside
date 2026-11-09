import { graphQLSDL } from './sdl.js';
import { ExecutionBudget, GraphQLBudgetError, executeWithBudget, type ExecutionLimits } from './execution-budget.js';
import { automationRunRuntime } from './automation-runtime.js';
import { DelegationView } from './delegations.js';
import type { DelegationDispatchResult } from '../automation/delegation-protocol.js';
import { catalogFor, type ModelCatalogSnapshot } from '../automation/models.js';
import { AutomationView, executionView, type AutomationOwner } from './automations.js';
import { buildReferenceGraph, type ReferenceGraph } from './references.js';
import {
  buildSchema, printSchema, getOperationAST, getArgumentValues, getVariableValues, getDirectiveValues, GraphQLSkipDirective, GraphQLIncludeDirective, valueFromASTUntyped, GraphQLError, GraphQLScalarType, AbortedGraphQLExecutionError,
  Kind as ASTKind, parse, validate, type DocumentNode, type GraphQLEnumType, type SelectionNode, type GraphQLResolveInfo, type GraphQLSchema, type FieldNode,
} from 'graphql';
import type { Store } from '../source/store.js';
import { attachmentFiles } from '../mcp/attachments.js';
import { artifactContentFilename } from '../core/artifact.js';
import { isAbsolute, resolve } from 'node:path';
import { isCalendarDate } from '../core/scheduling.js';
import { assertRecurrence } from '../core/recurrence.js';
import { parseArtifactHandle } from '../core/artifact-reference.js';
import { prepareAutomationPrompts } from './automation-prompts.js';
import { QueryView, status, type DefaultProjectionRange, type Kind, type RecordNode } from './query.js';
import type { SearchMatcher } from '../mcp/search.js';
import type { SemanticSearchService } from '../semantic/search.js';
import { searchSourceVersion } from '../semantic/source-version.js';
import { SemanticSetupError } from '../semantic/embedding.js';
import { unifiedSearch, type UnifiedSearchInput } from './search.js';
import type { InstanceSession } from '../mcp/instance-session.js';
import { InstancePathError } from '../core/instance.js';
import { validate as validateInstance } from '../core/validator.js';
import type { CalendarSystemInfo, CalendarSyncInfo } from '../mcp/calendar/info.js';
import { systemInfoView, calendarSystemPayload, calendarSyncPayload, type SystemInfoOptions } from './system-info.js';
import type { ShowArgs, ShowPayload } from '../mcp/tools/show.js';
import type { InstanceRecord, ParseIssue, ParseResult } from '../core/types.js';
import type { AutomationRuntimeSnapshot, AutomationLogPage, AutomationLogStream } from './automation-runtime.js';
import { normalizeMutationArguments, normalizeActionStatus, authoredAutomationModels } from './inputs.js';
import { summarizeMutationError, deriveMutationPayloadIds, isFullMutationFailure } from './results.js';
import { MutationWriteError, type MutationResult } from '../source/mutation-result.js';
import type { GraphQLUsageLog, UsageRequest } from './usage.js';
import { normalizeGeocodeAddressInput, type GeocodeAddressInput, type GeocodeAddressResult } from '../mcp/geocoding.js';
import { missingLocationGeoNotices, type LocationWriteNotice } from './location-notices.js';
import type {ExecutionContextSnapshot} from '../core/execution-context.js';

export interface GraphQLArgs { document: string; variables?: Record<string, unknown>; operationName?: string }
export interface MutationOutcome {
  // The `aside artifact` receipt; GraphQL reads the structured fields.
  text?: string;
  warnings?: string[];
  id?: string;
  entryId?: string;
  createdProjectIds?: string[];
  createdActionIds?: string[];
  mutationResult?: MutationResult;
  readbackError?: string;
}
/** The owner executes the primary operation and any prepared linked writes in
 * one transaction, then publishes its final receipt and readback status. */
export interface MutationPlan {operation: string; input: Record<string, unknown>; beforeWrite?: () => void}
export type MutationRunner = (prepare: () => MutationPlan) => MutationOutcome & {mutationResult: MutationResult};
export interface GraphQLResult {
  [key: string]: unknown;
  data?: Record<string, unknown> | null;
  errors?: readonly unknown[];
  extensions?: Record<string, unknown>;
}

// Internal operation names are not API. Typed inputs preflight under their public
// field names; instance creation validates in the session.
const errorGuidance = (message: string) => message.replace(/^Invalid create_instance arguments:/, 'Invalid createInstance arguments:');

// These are API views and typed inputs over the existing records, not new stored
// entities or relationships. All persistence stays in the original handlers.
export function buildGraphQLSchema(): GraphQLSchema {
  const schema = buildSchema(graphQLSDL());

  // Reuse domain values while exposing familiar GraphQL enum spellings.
  for (const type of ['ActionStatus', 'ProjectStatus', 'ProjectRelationDirection', 'AutomationOverlap', 'AutomationRunStatus', 'AutomationLogStream', 'SearchRecordKind']) {
    for (const value of (schema.getType(type) as GraphQLEnumType).getValues()) value.value = value.name.toLowerCase();
  }
  for (const value of (schema.getType('CalendarSyncState') as GraphQLEnumType).getValues()) value.value = value.name.toLowerCase();
  const calendarAuthorization = { NOT_DETERMINED: 'notDetermined', WRITE_ONLY: 'writeOnly', FULL_ACCESS: 'fullAccess' };
  for (const value of (schema.getType('CalendarAuthorization') as GraphQLEnumType).getValues()) {
    value.value = calendarAuthorization[value.name as keyof typeof calendarAuthorization] ?? value.name.toLowerCase();
  }
  const dateScalar = schema.getType('Date') as GraphQLScalarType;
  function parseDate(value: unknown): string {
    if (typeof value !== 'string' || !isCalendarDate(value)) throw new GraphQLError('Date must be a valid YYYY-MM-DD calendar date.');
    return value;
  }
  dateScalar.parseValue = dateScalar.coerceInputValue = parseDate;
  dateScalar.coerceInputLiteral = dateScalar.parseLiteral = value => {
    if (value.kind !== ASTKind.STRING) throw new GraphQLError('Date must be a YYYY-MM-DD string.');
    return parseDate(value.value);
  };

  return schema;
}

export const GRAPHQL_SCHEMA = buildGraphQLSchema();
export interface GraphQLSchemaResult { sdl: string; diagnostics: ParseIssue[] }
const schemaText = printSchema(GRAPHQL_SCHEMA);

/** Schema discovery is static and never discovers vendors or starts jobs. */
export async function readGraphQLSchema(_path: string | null, options: {signal?: AbortSignal} = {}): Promise<GraphQLSchemaResult> {
  options.signal?.throwIfAborted();
  return {sdl: schemaText, diagnostics: []};
}

function checkVariables(value: unknown, depth = 0, count = { nodes: 0 }): void {
  if (depth > 24 || ++count.nodes > 5_000) throw new GraphQLError('GraphQL variables are too deeply nested or too large.');
  if (value && typeof value === 'object') for (const child of Object.values(value)) checkVariables(child, depth + 1, count);
}

// Bound expansion before schema validation, which also traverses fragments.
// Check every definition: validation inspects unselected operations and unused
// fragments too. Track active spreads so cycles cannot bypass this guard.
function checkSelections(document: DocumentNode): void {
  const fragments = new Map(document.definitions.filter(d => d.kind === ASTKind.FRAGMENT_DEFINITION).map(d => [d.name.value, d]));
  let count = 0;
  let roots = 0;
  let rootLimit: number | undefined;
  const active = new Set<string>();
  function walk(selection: SelectionNode, depth: number): void {
    if (depth > 16 || ++count > 2_000) throw new GraphQLError('GraphQL selection limit exceeded. Reduce depth or repeated selections.');
    if (selection.kind === ASTKind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      const fragment = fragments.get(name);
      if (!fragment) throw new GraphQLError(`Unknown fragment "${name}".`, { nodes: selection });
      if (active.has(name)) throw new GraphQLError(`Fragment cycle involving "${name}".`, { nodes: selection });
      active.add(name);
      for (const child of fragment.selectionSet.selections) walk(child, depth);
      active.delete(name);
      return;
    }
    if (selection.kind === ASTKind.FIELD && depth === 1 && rootLimit !== undefined && ++roots > rootLimit) {
      throw new GraphQLError('Too many root fields in one GraphQL operation.');
    }
    if (selection.selectionSet) for (const child of selection.selectionSet.selections) {
      walk(child, depth + (selection.kind === ASTKind.FIELD ? 1 : 0));
    }
  }
  for (const definition of document.definitions) {
    if (definition.kind !== ASTKind.OPERATION_DEFINITION && definition.kind !== ASTKind.FRAGMENT_DEFINITION) continue;
    roots = 0;
    rootLimit = definition.kind === ASTKind.OPERATION_DEFINITION ? (definition.operation === 'mutation' ? 20 : 100) : undefined;
    for (const selection of definition.selectionSet.selections) walk(selection, 1);
  }
}

const mutations: Record<string, { operation: string; kind: Kind | 'instance' }> = {
  updateInstance: { operation: 'update_instance', kind: 'instance' },
  capture: { operation: 'capture', kind: 'entry' },
  updateEntry: { operation: 'update_entry', kind: 'entry' },
  updateProject: { operation: 'update_project', kind: 'project' },
  updateOccurrence: { operation: 'update_occurrence', kind: 'action' },
  updateAction: { operation: 'update_action', kind: 'action' },
  createArtifact: { operation: 'create_artifact', kind: 'artifact' },
  updateArtifact: { operation: 'update_artifact', kind: 'artifact' },
};

function needsRecordNodes(info: GraphQLResolveInfo): boolean {
  // Fragments may select nodes; keep their normal execution path.
  return info.fieldNodes.some(node => node.selectionSet?.selections.some(selection =>
    selection.kind !== ASTKind.FIELD || selection.name.value === 'nodes'));
}

function projectionPath(info: GraphQLResolveInfo): string {
  const parts: string[] = [];
  for (let path: GraphQLResolveInfo['path'] | undefined = info.path; path; path = path.prev) {
    parts.push(typeof path.key === 'number' ? '*' : path.key);
  }
  return parts.reverse().join('.');
}

function needsSearchRanking(info: GraphQLResolveInfo): boolean {
  const visited = new Set<string>();
  const selected = (selection: SelectionNode): boolean => {
    if (getDirectiveValues(GraphQLSkipDirective, selection, info.variableValues)?.if === true
      || getDirectiveValues(GraphQLIncludeDirective, selection, info.variableValues)?.if === false) return false;
    if (selection.kind === ASTKind.FIELD) return ['hits', 'model', 'indexedChunks'].includes(selection.name.value);
    if (selection.kind === ASTKind.FRAGMENT_SPREAD) {
      if (visited.has(selection.name.value)) return false;
      visited.add(selection.name.value);
      return info.fragments[selection.name.value]?.selectionSet.selections.some(selected) ?? false;
    }
    return selection.selectionSet.selections.some(selected);
  };
  return info.fieldNodes.some(node => node.selectionSet?.selections.some(selected));
}

// CLI and daemon share document validation. The CLI can reject invalid source
// and operation modes before starting or connecting to the daemon.
export function prepareGraphQL(mode: 'query' | 'mutation', args: GraphQLArgs): { document?: DocumentNode; errors?: readonly unknown[] } {
  try {
    if (args.document.length > 64_000 || JSON.stringify(args.variables ?? {}).length > 256_000) throw new GraphQLError('GraphQL request is too large. Supply long content through contentFile or bodyFile.');
    checkVariables(args.variables);
    const document = parse(args.document, { maxTokens: 5_000 });
    checkSelections(document);
    const operation = getOperationAST(document, args.operationName);
    if (!operation) throw new GraphQLError('Specify operationName for a document with multiple operations, or select an existing operation.');
    if (operation.operation !== mode) throw new GraphQLError(`This tool accepts only ${mode} operations.`);
    const errors = validate(GRAPHQL_SCHEMA, document);
    if (errors.length) return { errors: errors.map(error => error.toJSON()) };
    return { document };
  } catch (error) {
    return { errors: [error instanceof GraphQLError ? error.toJSON() : { message: error instanceof Error ? error.message : String(error) }] };
  }
}

export interface GraphQLExecutionOptions extends ExecutionLimits, SystemInfoOptions {
  mutate?: MutationRunner; matcher?: SearchMatcher; signal?: AbortSignal; instances?: InstanceSession;
  semanticSearch?: SemanticSearchService['search'];
  semanticReconcile?: (store: Store, options: {signal?: AbortSignal}) => Promise<unknown>;
  /** Schedule derived-data maintenance for roots with confirmed persisted changes. */
  onMutation?: (roots: readonly string[]) => void;
  // A field reached an instance whose directory is gone. Its error is returned as
  // data, so the owner hears about it here rather than from a rejected request.
  onInstancePathError?: () => void;
  /** Resolve requested cross-instance content through its lifecycle owner. */
  resolveStore?: (path: string) => Store | undefined;
  /** Read already loaded metadata without activating an instance or its features. */
  loadedInstance?: (path: string) => ParseResult<InstanceRecord> | undefined;
  executionContext?: (path: string) => ExecutionContextSnapshot | undefined;
  /** Explicit passive admission for a target selected by this mutation. */
  observeInstance?: (path: string) => boolean;
  usageLog?: GraphQLUsageLog;
  show?: (input: ShowArgs) => Promise<ShowPayload>;
  showUrl?: (input: ShowArgs) => Promise<string>;
  geocodeAddress?: (input: GeocodeAddressInput, options: {signal?: AbortSignal}) => Promise<GeocodeAddressResult>;
  requestCalendarAccess?: () => Promise<CalendarSystemInfo>;
  calendarSync?: (root: string) => CalendarSyncInfo;
  runDelegation?: (root: string, id: string) => Promise<DelegationDispatchResult>;
  automationRuntime?: (root: string) => Promise<AutomationRuntimeSnapshot>;
  automationLog?: (root: string, runId: string, stream: AutomationLogStream, offset: number, limit: number) => Promise<AutomationLogPage | null>;
}

export async function executeGraphQL(
  source: Store | (() => Store), mode: 'query' | 'mutation', args: GraphQLArgs,
  options: GraphQLExecutionOptions = {},
): Promise<GraphQLResult> {
  const budget = new ExecutionBudget(options, options.signal);
  const usage = options.usageLog?.start(mode);
  const fallback = options.instances?.registry.activeInstance ?? (typeof source === 'function' ? null : source.getDataDir());
  let fallbackIdentity: string | undefined;
  if (usage) try {fallbackIdentity = typeof source === 'function' ? fallback ? options.loadedInstance?.(fallback)?.value.manifest.id : undefined : source.getInstance()?.manifest.id;} catch { /* Logging cannot change execution availability. */ }
  const changedRoots = new Set<string>();
  let result: GraphQLResult | undefined;
  try {
    result = await executeGraphQLImpl(source, mode, args, { ...options, signal: budget.signal }, budget, usage, changedRoots);
    // Include validation failures and diagnostics in the query response ceiling.
    // Aborted requests already return a compact error without partial data.
    if (mode === 'query' && !budget.signal.aborted) budget.checkResponse(result);
    return result;
  } catch (error) {
    if (!(error instanceof GraphQLBudgetError)) throw error;
    result = { errors: [{ message: error.message }], extensions: { diagnostics: [], complete: false, mutations: [], defaultProjectionRanges: [] } };
    return result;
  } finally {
    if (mode === 'mutation' && changedRoots.size && options.onMutation) {
      // Saved writes remain authoritative even if maintenance cannot be queued.
      // The host owns reconciliation failures and retries; this hook never
      // converts a successful/partial write into a failed GraphQL mutation.
      try { options.onMutation([...changedRoots]); } catch {}
    }
    usage?.finish(result, fallbackIdentity === undefined ? null : fallback, options.signal?.aborted ?? false, fallbackIdentity);
  }
}

async function executeGraphQLImpl(
  source: Store | (() => Store), mode: 'query' | 'mutation', args: GraphQLArgs,
  options: GraphQLExecutionOptions, budget: ExecutionBudget, usage: UsageRequest | undefined, changedRoots: Set<string>,
): Promise<GraphQLResult> {
  const recordChanges = (root: string, changes: MutationResult['changes'], identity?: string) => {
    if (changes.length) changedRoots.add(root);
    usage?.changes(root, changes, identity ?? (store?.getDataDir() === root ? store.getManifest().id : metadata(root).value.manifest.id));
  };
  const results: {operation: string; error: string | null; changes: MutationResult['changes']; notices?: LocationWriteNotice[]}[] = [];
  const calendarSyncSnapshots = new Map<string, ReturnType<typeof calendarSyncPayload>>();
  const metadataSnapshots = new Map<string, ParseResult<InstanceRecord>>();
  const executionSnapshots = new Map<string, ExecutionContextSnapshot | undefined>();
  let activationFailure: string | undefined;
  const effectAllowed = () => {
    if (activationFailure) throw new GraphQLError(`Later mutation fields were skipped because instance activation failed: ${activationFailure}`);
    if (options.signal?.aborted) throw new GraphQLError('GraphQL request cancelled.');
    // A serial mutation root can change sync observations even when it returns
    // the same instance. Share snapshots within its payload, not across roots.
    calendarSyncSnapshots.clear();
    metadataSnapshots.clear();
    executionSnapshots.clear();
  };
  let store: Store | undefined = typeof source === 'function' ? undefined : source;
  let view: QueryView | undefined;
  let viewSourceVersion: string | undefined;
  let instanceRecord: InstanceRecord | null = null;
  const scopedViews = new Map<string, QueryView>();
  const nodePaths = new WeakMap<RecordNode, string>();
  const referenceGraphs = new WeakMap<QueryView, {actions: number; graph: ReferenceGraph}>();
  const referenceIssues: ParseIssue[] = [];
  const rememberView = (path: string, snapshot: QueryView, identity: string) => {
    usage?.touch(path, identity);
    scopedViews.set(path, snapshot);
    for (const collection of Object.values(snapshot.records)) for (const node of collection.values()) nodePaths.set(node, path);
    return snapshot;
  };
  const validations = new Map<string, ReturnType<typeof validateInstance>>();
  const runtimeSnapshots = new Map<string, Promise<AutomationRuntimeSnapshot>>();
  const runtimeIssues: ParseIssue[] = [];
  const unavailable = (state: string, path: string) => new GraphQLError(
    `Lifecycle-provided ${state} is unavailable for ${JSON.stringify(path)}. Select or register the instance before querying its content.`,
    {extensions: {code: 'LIFECYCLE_STATE_UNAVAILABLE', state}},
  );
  const executionContext = (path: string) => {
    if (!executionSnapshots.has(path)) {
      const captured = options.executionContext?.(path)
        ?? (store?.getDataDir() === path ? store.getExecutionContext?.() : undefined);
      if (captured) executionSnapshots.set(path, structuredClone(captured));
    }
    const captured = executionSnapshots.get(path);
    if (!captured) throw unavailable('execution context', path);
    return captured;
  };
  const metadata = (path: string): ParseResult<InstanceRecord> => {
    let snapshot = metadataSnapshots.get(path);
    if (!snapshot) {
      // A record query has already captured the active instance. Otherwise peek
      // at its owner; passive inspection must never load a Store or arm jobs.
      const parsed = view && store?.getDataDir() === path && instanceRecord
        ? {value: instanceRecord, issues: []} : options.loadedInstance?.(path);
      if (!parsed) throw unavailable('instance metadata', path);
      snapshot = {value: structuredClone(parsed.value), issues: parsed.issues.map(issue => ({...issue}))};
      metadataSnapshots.set(path, snapshot);
      runtimeIssues.push(...snapshot.issues);
    }
    return snapshot;
  };
  const metadataInstance = <T extends {path: string}>(info: T) => {
    const record = metadata(info.path).value;
    return {...info, ...record, id: record.manifest.id, name: record.manifest.name, description: record.manifest.description};
  };
  const refreshView = () => {
    // Portable read-only adapters expose records without execution settings.
    // A managed owner supplies the additional configuration capability.
    const context = options.executionContext?.(store!.getDataDir()) ?? store!.getExecutionContext?.();
    if (context) executionSnapshots.set(store!.getDataDir(), structuredClone(context));
    view = rememberView(store!.getDataDir(), new QueryView(store!, options.matcher, options.signal, budget.exceed), store!.getInstance()?.manifest.id ?? '');
    viewSourceVersion = undefined;
    instanceRecord = structuredClone(store!.getInstance());
    return view;
  };
  const records = () => {
    if (!view) {
      store = typeof source === 'function' ? source() : source;
      return refreshView();
    }
    return view;
  };
  const scopedRecords = (path: string) => {
    if (path === options.instances?.registry.activeInstance || path === store?.getDataDir()) return records();
    let snapshot = scopedViews.get(path);
    if (!snapshot) {
      const managed = options.resolveStore?.(path);
      if (!managed) throw unavailable('records', path);
      const context = options.executionContext?.(path) ?? managed.getExecutionContext?.();
      if (context) executionSnapshots.set(path, structuredClone(context));
      snapshot = rememberView(path, new QueryView(managed, options.matcher, options.signal, budget.exceed), managed.getInstance()?.manifest.id ?? '');
    }
    return snapshot;
  };
  const snapshotInstance = () => {
    records();
    const record = instanceRecord;
    if (!record) return null;
    return { path: store!.getDataDir(), ...record, id: record.manifest.id,
      name: record.manifest.name, description: record.manifest.description, active: true,
      workspace: options.instances?.registry.selection().workspace.includes(store!.getDataDir()) ?? false };
  };
  const catalogs = new Map<string, ModelCatalogSnapshot>();
  const catalogContexts = new Map<string, string>();
  const catalogForContext = async (path: string, refresh = false) => {
    const context = executionContext(path), cached = catalogs.get(path);
    if (!refresh && cached && catalogContexts.get(path) === context.revision) return cached;
    const snapshot = await catalogFor(path, {refresh, signal: options.signal, executionContext: context});
    catalogs.set(path, snapshot); catalogContexts.set(path, context.revision);
    return snapshot;
  };
  const extension = () => {
    const diagnostics = [...new Map([...(options.instances?.diagnostics ?? []), ...[...scopedViews].flatMap(([path, value]) => value.issues.map(issue =>
      issue.file && !isAbsolute(issue.file) && !issue.file.startsWith('#') ? {...issue, file: resolve(path, issue.file)} : issue)),
      ...referenceIssues, ...runtimeIssues, ...[...catalogs].flatMap(([path, value]) => value.diagnostics.map<ParseIssue>(message => ({severity: 'warning', code: 'model_discovery', file: resolve(path, '.aside'), message})))]
      .map(issue => [JSON.stringify([issue.severity, issue.code, issue.file, issue.field, issue.message]), issue])).values()];
    const ranges = new Map<string, DefaultProjectionRange>();
    for (const snapshot of scopedViews.values()) for (const range of snapshot.defaultProjectionRanges) {
      const previous = ranges.get(range.path);
      ranges.set(range.path, {...range, templates: [...new Set([...(previous?.templates ?? []), ...range.templates])].sort()});
    }
    return { diagnostics, complete: diagnostics.length === 0, mutations: results,
      defaultProjectionRanges: [...ranges.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  };
  try {
    budget.check();
    if (mode === 'query' && typeof source !== 'function') records();
    if (args.document.length > 64_000 || JSON.stringify(args.variables ?? {}).length > 256_000) throw new GraphQLError('GraphQL request is too large. Supply long content through contentFile or bodyFile.');
    checkVariables(args.variables);
    const document = parse(args.document, { maxTokens: 5_000 });
    checkSelections(document);
    const operation = getOperationAST(document, args.operationName);
    if (!operation) throw new GraphQLError('Specify operationName for a document with multiple operations, or select an existing operation.');
    if (operation.operation !== mode) throw new GraphQLError(`This tool accepts only ${mode} operations.`);
    usage?.describe(document, args.operationName);
    const root = options.instances?.registry.activeInstance ?? store?.getDataDir();
    const rawVariables = { ...Object.fromEntries((operation.variableDefinitions ?? []).filter(value => value.defaultValue)
      .map(value => [value.variable.name.value, valueFromASTUntyped(value.defaultValue!)])), ...args.variables };
    const fragments = new Map(document.definitions.filter(d => d.kind === ASTKind.FRAGMENT_DEFINITION).map(d => [d.name.value, d]));
    const rootFields: FieldNode[] = [];
    const responseKeys = new Set<string>();
    const collectRoots = (selection: SelectionNode): void => {
      for (const directive of selection.directives ?? []) {
        const condition = directive.arguments?.find(argument => argument.name.value === 'if');
        const value = condition && valueFromASTUntyped(condition.value, rawVariables);
        if ((directive.name.value === 'skip' && value === true) || (directive.name.value === 'include' && value === false)) return;
      }
      if (selection.kind === ASTKind.FIELD) {
        const key = selection.alias?.value ?? selection.name.value;
        if (!responseKeys.has(key)) rootFields.push(selection);
        responseKeys.add(key);
      }
      else for (const child of (selection.kind === ASTKind.FRAGMENT_SPREAD
        ? fragments.get(selection.name.value)!.selectionSet : selection.selectionSet).selections) collectRoots(child);
    };
    for (const selection of operation.selectionSet.selections) collectRoots(selection);
    if (rootFields.filter(field => field.name.value === 'geocodeAddress').length > 5) {
      throw new GraphQLError('At most five location lookups are allowed per operation. Refine the query in separate requests.');
    }
    const selectedPath = (field: FieldNode, variables: Record<string, unknown>): string | undefined => {
      if (!options.instances) return;
      const input: Record<string, any> = Object.fromEntries((field.arguments ?? []).map(arg => [arg.name.value, valueFromASTUntyped(arg.value, variables)]));
      const path = field.name.value === 'selectInstance' ? input.path : field.name.value === 'createInstance' ? input.input?.path : undefined;
      if (typeof path === 'string') return resolve(options.instances.state().cwd, path);
    };
    const schema = GRAPHQL_SCHEMA;
    const errors = validate(schema, document);
    if (errors.length) return { errors: errors.map(error => error.toJSON()), extensions: extension() };
    if (mode === 'query') usage?.executing();
    // Record roots share one loaded snapshot with instance metadata regardless
    // of sibling field order; metadata-only inspections remain passive.
    if (mode === 'query' && rootFields.some(field => ['entry', 'entries', 'project', 'projects', 'action', 'actions', 'artifact', 'artifacts', 'search'].includes(field.name.value))) records();
    // No asynchronous work separates the shared record snapshot from this
    // capture. Typed-only queries need no source hashing; search pins its
    // source before any root can await regex workers or model inference.
    if (mode === 'query' && rootFields.some(field => field.name.value === 'search')) viewSourceVersion = searchSourceVersion(store!);
    const prepared = new WeakMap<FieldNode, Record<string, unknown>>();
    if (mode === 'mutation') {
      const variableResult = getVariableValues(schema, operation.variableDefinitions ?? [], args.variables ?? {});
      if (variableResult.errors) return {errors: variableResult.errors.map(error => error.toJSON()), extensions: extension()};
      let scope = root;
      for (const selection of rootFields) {
        scope = selectedPath(selection, variableResult.variableValues.coerced) ?? scope;
        if (mutations[selection.name.value]) {
          const field = schema.getMutationType()!.getFields()[selection.name.value];
          const input = normalizeMutationArguments(selection.name.value, getArgumentValues(field, selection, variableResult.variableValues));
          const names = authoredAutomationModels(input);
          let choices = scope && catalogs.get(scope);
          if (names.length && scope && !choices) {
            const admitted = options.observeInstance ? options.observeInstance(scope)
              : scope === store?.getDataDir() || options.loadedInstance?.(scope) !== undefined;
            if (admitted) choices = await catalogForContext(scope);
          }
          for (const name of names) if (choices && !choices.models.some(model => model.name === name)) {
            throw new GraphQLError(`Model ${name} is not selectable in the execution's instance.`);
          }
          prepared.set(selection, input);
        }
      }
    }
    usage?.executing();
    const roots: Record<string, unknown> = {};
    const systemInfo = systemInfoView(options);
    roots.systemInfo = () => systemInfo;
    const session = () => {
      if (!options.instances) throw new Error('Instance operations require an MCP session.');
      return options.instances;
    };
    roots.geocodeAddress = async ({input}: {input: GeocodeAddressInput}) => {
      budget.check();
      const normalized = normalizeGeocodeAddressInput(input);
      const result: GeocodeAddressResult = options.geocodeAddress
        ? await options.geocodeAddress(normalized, {signal: options.signal})
        : {status: 'UNAVAILABLE', provider: 'APPLE', candidates: [], error: 'Native geocoding requires the local agent API on macOS.'};
      budget.check();
      if (result.status === 'FAILED' || result.status === 'UNAVAILABLE') {
        runtimeIssues.push({severity: 'warning', code: `geocoding_${result.status.toLowerCase()}`, file: '#geocoding',
          message: result.error ?? 'Native geocoding could not complete.'});
      }
      return result;
    };
    roots.instances = async () => (await session().instances(metadata))
      .map(metadataInstance);
    roots.activeInstance = async () => {
      if (!options.instances) return snapshotInstance();
      const info = await session().activeInstance(metadata);
      budget.check();
      if (!info) return null;
      usage?.touch(info.path, metadata(info.path).value.manifest.id);
      if (view && store?.getDataDir() === info.path) return snapshotInstance();
      return metadataInstance(info);
    };
    roots.show = async ({ input }: { input: ShowArgs }) => {
      effectAllowed();
      if (!options.show) throw new Error('Show operations require an MCP session.');
      const result = await options.show(input);
      if (options.instances?.registry.activeInstance) usage?.touch(options.instances.registry.activeInstance, metadata(options.instances.registry.activeInstance).value.manifest.id);
      const error = result.outcome === 'UNAVAILABLE'
        ? 'Could not open the default browser. Call showUrl with the same input and open its file:// URL in another local browser; authorization and redirection are automatic.'
        : null;
      results.push({operation: 'show', error, changes: []});
      return {...result, error};
    };
    roots.showUrl = async ({ input }: { input: ShowArgs }) => {
      effectAllowed();
      if (!options.showUrl) throw new Error('Show URL operations require an MCP session.');
      const url = await options.showUrl(input);
      if (options.instances?.registry.activeInstance) usage?.touch(options.instances.registry.activeInstance, metadata(options.instances.registry.activeInstance).value.manifest.id);
      results.push({operation: 'showUrl', error: null, changes: []});
      return url;
    };
    roots.requestCalendarAccess = async () => {
      effectAllowed();
      if (!options.requestCalendarAccess) throw new Error('Calendar authorization requires an MCP session.');
      const payload = calendarSystemPayload(await options.requestCalendarAccess());
      results.push({operation: 'requestCalendarAccess', error: payload.error, changes: []});
      return payload;
    };
    for (const field of ['selectInstance', 'createInstance'] as const) {
      roots[field] = async ({ path, input }: any) => {
        effectAllowed();
        let result;
        try {
          result = field === 'selectInstance' ? await session().selectInstance(path) : await session().createInstance(input);
        } catch (error) {
          activationFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
        const mutationResult: MutationResult = {status: result.error ? 'PARTIAL' : 'SUCCEEDED',
          changes: result.changes ?? (result.created ? [{kind: 'instance', id: result.instance.id, effect: 'CREATED', path: result.instance.path}] : []),
          failures: result.error ? [{kind: 'instance', id: result.instance.id, path: result.instance.path, message: result.error}] : [],
          ...(result.error ? {recovery: result.error} : {})};
        const error = summarizeMutationError(mutationResult);
        recordChanges(result.instance.path, mutationResult.changes, result.instance.id);
        results.push({operation: field, error, changes: mutationResult.changes});
        // Following mutation fields must use the newly active store.
        view = undefined; store = undefined; instanceRecord = null; validations.clear();
        instanceOwners.clear(); automationViews.clear(); runtimeSnapshots.clear(); scopedViews.clear();
        if (result.error) activationFailure = result.error;
        // A partial bootstrap has explicit durable identity but no confirmed
        // owner state yet. Preserve its receipt; deeper fields require the owner.
        const instance = result.created && !result.activated && result.error ? result.instance : metadataInstance(result.instance);
        return {...result, instance, error};
      };
    }
    const automationViews = new Map<string, AutomationView>();
    const instanceOwners = new Map<string, AutomationOwner>();
    const instanceOwner = (path: string): AutomationOwner => {
      let owner = instanceOwners.get(path);
      if (!owner) {
        const parsed = metadata(path);
        owner = {declarations: parsed.value.manifest.automations, filePath: resolve(path, 'aside.md')};
        instanceOwners.set(path, owner);
      }
      return owner;
    };
    const projectOwner = (node: RecordNode): AutomationOwner => ({projectId: node.id,
      declarations: node.record.frontMatter.automations, filePath: node.filePath ?? undefined});
    const executionRuntime = (path: string) => {
      if (!runtimeSnapshots.has(path)) runtimeSnapshots.set(path, (async () => {
        options.signal?.throwIfAborted();
        const snapshot = options.automationRuntime ? await options.automationRuntime(path)
          : {available: false, warning: 'Execution inspection requires a daemon session.', jobs: [], runs: []};
        budget.check();
        if (snapshot.warning || !snapshot.available) runtimeIssues.push({severity: 'warning', code: 'automation_runtime', file: resolve(path, 'aside.md'),
          message: snapshot.warning ?? 'Execution inspection is unavailable.'});
        for (const job of snapshot.jobs) {
          const delegation = job.scope === 'action';
          const file = delegation && job.actionId ? resolve(path, 'actions', job.actionId.slice(0, 4), `${job.actionId}.md`)
            : job.projectId ? resolve(path, 'projects', job.projectId.slice(0, 4), `${job.projectId}.md`) : resolve(path, 'aside.md');
          const field = delegation ? 'delegation' : `automations.${job.name}`;
          if (job.error) runtimeIssues.push({severity: 'error', code: delegation ? 'delegation_error' : 'automation_error', file, field, message: job.error});
          for (const message of job.warnings) runtimeIssues.push({severity: 'warning', code: delegation ? 'delegation_warning' : 'automation_warning', file, field, message});
        }
        return structuredClone(snapshot);
      })());
      return runtimeSnapshots.get(path)!;
    };
    const automationView = (path: string): AutomationView => {
      let value = automationViews.get(path);
      if (!value) {
        value = new AutomationView(path, {
          diagnostics: runtimeIssues, signal: options.signal,
          runtime: () => executionRuntime(path),
          ...(options.automationLog ? {output: (id, stream, offset, limit) => options.automationLog!(path, id, stream, offset, limit)} : {}),
          resolveArtifactPrompt: (prompt, owner, name) => {
            const ref = parseArtifactHandle(prompt)!;
            const artifact = scopedRecords(path).records.artifact.get(ref.id);
            if (artifact) return artifact;
            runtimeIssues.push({severity: 'error', code: 'automation_prompt', file: owner.filePath, field: `automations.${name}.run.prompt`,
              message: `Prompt artifact ${ref.id} is missing. Query artifacts or create a prompt artifact and update the automation.`});
            return null;
          },
          instanceOwner: () => instanceOwner(path),
          action: id => actionNode(path, id),
          actionAutomation: node => delegationView(path).node(node.id, node.record, node.filePath ?? undefined),
          projectOwner: id => {
            const node = scopedRecords(path).records.project.get(id);
            return node ? projectOwner(node) : null;
          },
        });
        automationViews.set(path, value);
      }
      return value;
    };
    const actionNode = (path: string, id: string) => {
      const node = scopedRecords(path).action(id);
      if (node) nodePaths.set(node, path);
      return node;
    };
    for (const [kind, plural] of Object.entries({ entry: 'entries', project: 'projects', action: 'actions', artifact: 'artifacts' }) as [Kind, string][]) {
      roots[kind] = ({ id }: { id: string }) => kind === 'action' ? actionNode(store!.getDataDir(), id) ?? null : records().records[kind].get(id) ?? null;
      roots[plural] = (input: any, info: GraphQLResolveInfo) => records().list(kind, input, undefined, undefined, needsRecordNodes(info), projectionPath(info));
    }
    roots.search = async (input: UnifiedSearchInput, info: GraphQLResolveInfo) => {
      const snapshot = records();
      const version = viewSourceVersion!;
      const current = () => {
        budget.check();
        if (searchSourceVersion(store!) !== version) throw new GraphQLError('Aside changed during search. Retry to retrieve passages and source records from the same revision.');
      };
      current();
      try {
        return await unifiedSearch(snapshot, store!, input, {semanticSearch: options.semanticSearch, semanticReconcile: options.semanticReconcile,
          signal: options.signal, check: current, needsRanking: needsSearchRanking(info)});
      } catch (error) {
        if (error instanceof SemanticSetupError) throw new GraphQLError(error.message, {extensions: {
          code: error.reason === 'OLLAMA_ERROR' ? 'SEMANTIC_SEARCH_FAILED' : 'SEMANTIC_SEARCH_UNAVAILABLE',
          reason: error.reason, recovery: error.recovery, model: error.model,
        }});
        throw error;
      }
    };
    const delegationView = (path: string): DelegationView => new DelegationView(path, {
      diagnostics: runtimeIssues, signal: options.signal,
      runtime: () => executionRuntime(path),
      artifact: id => scopedRecords(path).records.artifact.get(id),
      automations: automationView(path),
    });
    roots.runDelegation = async ({id}: {id: string}) => {
      effectAllowed(); records();
      if (!options.runDelegation) throw new GraphQLError('Delegation execution requires a daemon session.');
      const path = store!.getDataDir();
      const dispatch = await options.runDelegation(path, id);
      results.push({operation: 'runDelegation', error: null, changes: []});
      runtimeSnapshots.delete(path);
      refreshView();
      return automationView(path).runNode(automationRunRuntime(dispatch.run));
    };
    for (const [field, { operation: name, kind }] of Object.entries(mutations)) {
      roots[field] = async (inputArgs: any, info: GraphQLResolveInfo) => {
        effectAllowed();
        const preparedInput = prepared.get(info.fieldNodes[0]) ?? normalizeMutationArguments(field, inputArgs);
        const {id, input} = preparedInput;
        store = typeof source === 'function' ? source() : source;
        if (!options.mutate) throw new Error('GraphQL mutations are unavailable.');
        if (options.signal?.aborted) throw new Error('GraphQL request cancelled.');
        const names = authoredAutomationModels(preparedInput);
        if (names.length) {
          const path = store!.getDataDir();
          const choices = await catalogForContext(path);
          for (const name of names) if (!choices.models.some(model => model.name === name)) {
            throw new GraphQLError(`Model ${name} is not selectable in the execution's instance.`);
          }
        }
        let result: MutationOutcome;
        let mutationResult: MutationResult;
        let failureMessage: string | undefined;
        let readbackError: string | undefined;
        try {
          if (options.signal?.aborted) throw new Error('GraphQL request cancelled.');
          result = options.mutate(() => {
            // Lifecycle has admitted/repaired the source before preparing any
            // record-dependent plan. Discard an earlier request projection.
            view = undefined; instanceRecord = null;
            records();
            let operation = name;
            let values = { ...input, ...(id === undefined ? {} : { id }) };
            if (name === 'update_action') {
              const action = actionNode(store!.getDataDir(), id);
              if (action && !action.projected) values.id = action.id;
              if (action?.projected) {
                if (input.recurrence !== undefined) throw new GraphQLError('Recurrence commands apply to the template action, not an occurrence.');
                const { template, original } = action.record.frontMatter.occurrence;
                operation = 'update_occurrence';
                values = { ...input, template, original };
              }
            }
            if (kind === 'action') {
              let current = id === undefined ? undefined : actionNode(store!.getDataDir(), id)?.record.frontMatter;
              if (operation === 'update_occurrence') {
                const matching = [...records().records.action.values()].find(node =>
                  node.record.frontMatter.occurrence?.template === values.template
                  && node.record.frontMatter.occurrence?.original === values.original);
                current = matching?.record.frontMatter ?? current ?? {occurrence: {template: values.template, original: values.original}, scheduled: values.original};
              }
              values = normalizeActionStatus(values, current ?? {});
            }
            const beforeWrite = prepareAutomationPrompts(store!, preparedInput);
            return {operation, input: values, beforeWrite};
          });
          if (!result.mutationResult) throw new Error('Lifecycle-provided mutation receipt is unavailable. Retry through the Aside daemon.');
          mutationResult = result.mutationResult;
          readbackError = result.readbackError;
        } catch (error) {
          if (error instanceof MutationWriteError) {
            mutationResult = error.partialResult;
            failureMessage = errorGuidance(error.originalMessage);
            readbackError = error.readbackError;
            result = {};
          } else throw error;
        }
        mutationResult = {...mutationResult, failures: mutationResult.failures.map(failure => ({...failure, message: errorGuidance(failure.message)}))};
        recordChanges(store!.getDataDir(), mutationResult.changes);
        if (isFullMutationFailure(mutationResult)) throw new GraphQLError(errorGuidance(summarizeMutationError(mutationResult, {message: failureMessage})!));
        validations.clear();
        instanceOwners.clear();
        automationViews.clear();
        runtimeSnapshots.clear();
        let updatedView: QueryView | undefined;
        try {
          if (readbackError) throw new Error(readbackError);
          updatedView = refreshView();
        } catch (error) {
          view = undefined; instanceRecord = null; scopedViews.delete(store!.getDataDir());
          const problem = `Saved changes could not be read back: ${error instanceof Error ? error.message : String(error)}`;
          failureMessage = failureMessage ? `${failureMessage}\n${problem}` : problem;
          if (!mutationResult.changes.length) throw new GraphQLError(problem);
        }
        const error = summarizeMutationError(mutationResult, {message: failureMessage, warnings: result.warnings});
        const ids = deriveMutationPayloadIds(kind, id, mutationResult, result);
        const written = new Map<string, RecordNode>();
        if (updatedView) {
          for (const change of mutationResult.changes) {
            if (change.effect === 'REMOVED' || !['entry', 'project', 'action', 'artifact'].includes(change.kind)) continue;
            const node = updatedView.records[change.kind as Kind].get(change.id);
            if (node) written.set(node.handle, node);
          }
          // A successful no-op still offers the agent an opportunity to enrich
          // the existing mention, without reporting an error or a stored issue.
          if (kind !== 'instance' && ids.id) {
            const node = updatedView.records[kind].get(ids.id);
            if (node) written.set(node.handle, node);
          }
        }
        const notices = missingLocationGeoNotices(written.values());
        results.push({operation: field, error, changes: mutationResult.changes, ...(notices.length ? {notices} : {})});
        const payload: Record<string, unknown> = {error};
        payload[kind] = !updatedView ? null : kind === 'instance' ? snapshotInstance() : updatedView.records[kind].get(ids.id!) ?? null;
        if (kind === 'entry') {
          payload.createdProjects = ids.createdProjectIds.flatMap(id => updatedView?.records.project.get(id) ?? []);
          payload.createdActions = ids.createdActionIds.flatMap(id => updatedView?.records.action.get(id) ?? []);
        }
        return payload;
      };
    }
    const result = await executeWithBudget({
      schema, document, rootValue: roots, variableValues: args.variables, operationName: args.operationName,
      typeResolver: source => source.__typename ?? ({entry: 'Entry', project: 'Project', action: 'Action', artifact: 'Artifact'} as const)[(source as RecordNode).kind],
      fieldResolver: (source: any, input, _context, info) => {
        const field = info.fieldName;
        if (info.parentType.name === 'SearchHit' && field === 'record') return records().records[source.kind as Kind].get(source.id) ?? null;
        if (info.parentType.name === 'Instance' && ['body', 'settings', 'automations', 'automationLog', 'execution', 'validation', 'calendarSync'].includes(field)) usage?.touch(source.path, source.manifest?.id ?? metadata(source.path).value.manifest.id);
        if (field === 'links' || field === 'backlinks' || field === 'attachmentLinks') {
          const path = nodePaths.get(source) ?? store?.getDataDir();
          if (!path) throw new GraphQLError('Cannot resolve the link source instance.');
          const snapshot = scopedRecords(path);
          let cached = referenceGraphs.get(snapshot);
          if (!cached || cached.actions !== snapshot.records.action.size) {
            const graph = buildReferenceGraph(path, snapshot.records, {attachments: snapshot.attachments, roots: snapshot.referenceRoots, signal: options.signal});
            cached = {actions: snapshot.records.action.size, graph};
            referenceGraphs.set(snapshot, cached);
            referenceIssues.push(...graph.issues);
          }
          const page = cached.graph.page(source.handle ?? '', field, input.offset ?? 0, input.limit ?? 20);
          for (const node of page.nodes) nodePaths.set(node as RecordNode, path);
          return page;
        }
        if (info.parentType.name === 'Instance' && ['body', 'settings'].includes(field)) {
          const record = source.manifest ? source : metadata(source.path).value;
          if (field === 'body') return record.body;
          const config = record.manifest.config;
          return {webapp: {sidebar: config?.webapp?.sidebar ?? []},
            scheduledEventTitlePrefix: config?.scheduledEventTitlePrefix ?? '▢ ',
            doneEventTitlePrefix: config?.doneEventTitlePrefix ?? '✓ '};
        }
        if (info.parentType.name === 'SystemCheck' && ['problems', 'fixes'].includes(field)) return source[field] ?? [];
        if (info.parentType.name === 'SystemClaudeInstallation' && field === 'mcpServers') {
          return source.mcpServers ? Object.entries(source.mcpServers).map(([name, value]) => ({name, ...(value as object)})) : null;
        }
        if (info.parentType.name === 'Instance') {
          if (field === 'calendarSync') {
            if (!options.calendarSync) return null;
            if (!calendarSyncSnapshots.has(source.path)) calendarSyncSnapshots.set(source.path, calendarSyncPayload(options.calendarSync(source.path)));
            return calendarSyncSnapshots.get(source.path);
          }
          if (field === 'automations') return automationView(source.path).list(instanceOwner(source.path), input);
          if (field === 'automationLog') return automationView(source.path).log({}, input);
          if (field === 'execution') return executionView(source.path, {diagnostics: runtimeIssues, signal: options.signal, executionContext: executionContext(source.path),
            catalog: async refresh => {
              const snapshot = await catalogForContext(source.path, refresh);
              budget.check();
              return snapshot;
            }});
        }
        if (info.parentType.name === 'Instance' && field === 'validation') {
          if (options.signal?.aborted) throw new Error('GraphQL request cancelled.');
          if (!validations.has(source.path)) validations.set(source.path, validateInstance(source.path));
          return validations.get(source.path);
        }
        if (info.parentType.name === 'ValidationCheck' && field === 'details') return source.details ?? [];
        if (source?.kind && source?.record) {
          const node = source as RecordNode;
          const path = nodePaths.get(node) ?? store!.getDataDir();
          const nodeView = scopedRecords(path);
          if (field === 'created' && node.projected) return null;
          if (field === 'relatedProjects') {
            const relations = new Map(nodeView.relatedProjectRelations(node).map(link => [link.project.id, link]));
            const filtered = input.direction == null ? input : {...input, where: {and: [input.where ?? {},
              {ids: [...relations.values()].filter(link => input.direction.includes(link.direction)).map(link => link.project.id)}]}};
            return nodeView.list('project', filtered, node, field, needsRecordNodes(info), projectionPath(info)).then(page =>
              ({...page, nodes: page.nodes.map(project => relations.get(project.id)!)}));
          }
          if (['entries', 'projects', 'actions', 'artifacts'].includes(field)) {
            const target = field === 'relatedProjects' ? 'project' : field === 'entries' ? 'entry' : field.slice(0, -1) as Kind;
            return nodeView.list(target, input, node, field, needsRecordNodes(info), projectionPath(info));
          }
          if (node.kind === 'action' && field === 'delegationLog') return delegationView(path).log(node.id, node.record, input);
          if (node.kind === 'action' && field === 'delegation') return delegationView(path).node(node.id, node.record, node.filePath ?? undefined);
          if (node.kind === 'project' && field === 'automations') return automationView(path).list(projectOwner(node), input);
          if (node.kind === 'project' && field === 'automationLog') return automationView(path).log({projectId: node.id}, input);
          if (field === 'status') return status(node);
          if (node.kind === 'artifact' && field === 'content') {
            if (node.record.body.trim()) return {__typename: 'MarkdownContent', text: node.record.body};
            const filename = artifactContentFilename(node.record);
            if (filename === undefined) return null;
            const content = {__typename: 'Attachment', ...attachmentFiles(nodeView.attachments.get(node.id), node.id, [filename])[0]};
            nodePaths.set(content as unknown as RecordNode, path);
            return content;
          }
          if (field === 'attachments') return attachmentFiles(nodeView.attachments.get(node.id), node.id, node.record.frontMatter.attachments ?? []).map(file => {
            nodePaths.set(file as unknown as RecordNode, path);
            return file;
          });
          const metadata = node.record.meta ?? node.record.frontMatter;
          if (node.kind === 'action' && field === 'occurrence') {
            if (!metadata.occurrence) return null;
            const template = nodeView.records.action.get(metadata.occurrence.template);
            let valid = false;
            try {
              if (template && Array.isArray(template.record.frontMatter.recurrence)
                && !template.record.frontMatter.occurrence && !template.record.frontMatter.scheduled && !template.record.frontMatter.resolution) {
                assertRecurrence(template.record.frontMatter.recurrence);
                valid = true;
              }
            } catch { /* Invalid targets are omitted and diagnosed below. */ }
            if (!valid) referenceIssues.push({severity: 'error', code: 'occurrence_template', file: node.filePath ?? undefined,
              message: `Action ${node.id} references a missing or invalid recurrence template ${metadata.occurrence.template}.`});
            return {...metadata.occurrence, template: valid ? template : null, projected: node.projected === true};
          }
          const storedField = field === 'calendarAccount' ? 'calendar_account' : field;
          if (node.kind === 'action' && field === 'location' && typeof metadata.location !== 'string') return null;
          const value = field in node ? (node as any)[field] : field in node.record ? node.record[field] : metadata[storedField];
          return value ?? (field === 'related_projects' ? [] : value);
        }
        if (info.parentType.name === 'Attachment' && field === 'filePath') return source.filePath ?? source.path ?? null;
        const storedField = {helperPath: 'helper_path', logPath: 'log_path', exitCode: 'exit_code'}[field as 'helperPath' | 'logPath' | 'exitCode'];
        const value = source?.[field] === undefined && storedField ? source?.[storedField] : source?.[field];
        if (value === undefined && ['projects', 'actions', 'related_projects'].includes(field)) return [];
        return typeof value === 'function' ? value.call(source, input, info) : value;
      },
    }, budget);
    // GraphQL.js can reject variable coercion before invoking any resolver.
    // These results have errors and no data property, unlike execution errors.
    if (result.errors?.length && !('data' in result)) usage?.validationFailed();
    if (result.errors?.some(error => error.originalError instanceof InstancePathError)) options.onInstancePathError?.();
    const response = { ...result, errors: result.errors?.map(error => ({ ...error.toJSON(), message: errorGuidance(error.message) })), extensions: extension() };
    return response;
  } catch (error) {
    // Started mutation effects may be awaiting an external service when the
    // executor aborts. Keep their receipts and session state authoritative
    // before returning; the aborted executor will not start another field.
    if (mode === 'mutation' && error instanceof AbortedGraphQLExecutionError) await error.abortedResult;
    const reason = budget.signal.aborted ? budget.signal.reason : error;
    const message = budget.signal.aborted && !(reason instanceof GraphQLBudgetError) ? 'GraphQL request cancelled.'
      : errorGuidance(reason instanceof Error ? reason.message : String(reason));
    // A budget failure returns a bounded error, never a partial query result.
    // Completed mutation effects remain authoritative and must not be discarded.
    const detail = !budget.signal.aborted && error instanceof GraphQLError ? error.toJSON() : {};
    return { errors: [{ ...detail, message }], extensions: budget.signal.aborted
      ? { diagnostics: [], complete: false, mutations: results, defaultProjectionRanges: [] } : extension() };
  }
}
