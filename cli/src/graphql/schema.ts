import { graphQLSDL } from './sdl.js';
import { ExecutionBudget, GraphQLBudgetError, executeWithBudget, type ExecutionLimits } from './execution-budget.js';
import { automationRunRuntime } from './automation-runtime.js';
import { DelegationView } from './delegations.js';
import type { DelegationDispatchResult } from '../automation/delegation-protocol.js';
import { catalogFor, type ModelCatalogSnapshot } from '../automation/models.js';
import { AutomationView, executionView, type AutomationOwner } from './automations.js';
import { buildReferenceGraph, type ReferenceGraph } from './references.js';
import {
  buildSchema, printSchema, getOperationAST, getArgumentValues, getVariableValues, valueFromASTUntyped, GraphQLError, GraphQLScalarType, AbortedGraphQLExecutionError,
  Kind as ASTKind, parse, validate, type DocumentNode, type GraphQLEnumType, type SelectionNode, type GraphQLResolveInfo, type GraphQLSchema, type FieldNode,
} from 'graphql';
import { Store } from '../mcp/store.js';
import { attachmentFiles } from '../mcp/attachments.js';
import { artifactContentFilename } from '../core/artifact.js';
import { isAsideDir, readInstanceRecordResult } from '../core/instance.js';
import { isAbsolute, resolve } from 'node:path';
import { isCalendarDate } from '../core/scheduling.js';
import { assertRecurrence } from '../core/recurrence.js';
import { parseArtifactHandle } from '../core/artifact-reference.js';
import { prepareAutomationPrompts } from './automation-prompts.js';
import { QueryView, status, type Kind, type RecordNode } from './query.js';
import type { SearchMatcher } from '../mcp/search.js';
import type { InstanceSession } from '../mcp/instance-session.js';
import { validate as validateInstance } from '../core/validator.js';
import type { CalendarInfo } from '../mcp/calendar/info.js';
import type { ShowArgs, ShowPayload } from '../mcp/tools/show.js';
import type { InstanceRecord, ParseIssue } from '../core/types.js';
import type { AutomationRuntimeSnapshot, AutomationLogPage, AutomationLogStream } from './automation-runtime.js';
import { normalizeMutationArguments, normalizeActionStatus, authoredAutomationModels } from './inputs.js';
import { summarizeMutationError, deriveMutationPayloadIds, isFullMutationFailure } from './results.js';
import { MutationWriteError, trackMutation, beforeMutationWrite, type MutationResult } from '../mcp/tools/mutation-result.js';
import type { GraphQLUsageLog, UsageRequest } from './usage.js';

export interface GraphQLArgs { document: string; variables?: Record<string, unknown>; operationName?: string }
export interface MutationOutcome {
  text: string;
  warnings?: string[];
  id?: string;
  entryId?: string;
  createdProjectIds?: string[];
  createdActionIds?: string[];
  mutationResult?: MutationResult;
}
export type MutationRunner = (name: string, args: Record<string, unknown>) => MutationOutcome;
export interface GraphQLResult {
  [key: string]: unknown;
  data?: Record<string, unknown> | null;
  errors?: readonly unknown[];
  extensions?: Record<string, unknown>;
}

const calendarGuidance = (text: string) => text
  .replaceAll('calendar_info', 'calendarInfo via mutate')
  .replaceAll('update_action', 'updateAction via mutate');
// Receipts can contain authored names. Translate only generated recovery lines.
const receiptGuidance = (text: string) => text.replace(/^[ \t]*recovery: .*$/gm, calendarGuidance);

// Shared handlers also serve legacy MCP. Translate their generated guidance at
// this boundary, preserving quoted IDs, authored names, and GraphQL error data.
const errorHints = new Map([
  ...(['project', 'action', 'entry', 'artifact'] as const).map<[string, string]>(kind => {
    const plural = kind === 'entry' ? 'entries' : `${kind}s`;
    const suffix = kind === 'entry' ? " (the entry's created timestamp)." : '.';
    return [`\nHint: use query_${plural} to find the correct ID${suffix}`, `\nHint: query ${plural} to find the correct ID${suffix}`];
  }),
  ...(['project', 'action'] as const).flatMap<[string, string]>(kind => [
    [`\nHint: use query_${kind}s to verify the ID; create new ${kind}s with capture or update_entry.`,
      `\nHint: query ${kind}s to verify the ID; create new ${kind}s with capture or updateEntry through mutate.`],
    [`\nHint: pass an object with {name, description} to create a new ${kind}, or use query_${kind}s to find the correct ID.`,
      `\nHint: use {create: {name, description}} to create a new ${kind}, or query ${kind}s for the correct ID and link it with existingId.`],
  ]),
  ['\nHint: use query_entries to verify the ID, or capture to create a new entry.',
    '\nHint: query entries to verify the ID, or use capture through mutate to create a new entry.'],
  ['\nHint: use query_artifacts to verify the ID.', '\nHint: query artifacts to verify the ID.'],
]);
const errorOperations: Record<string, string> = {
  query_entries: 'entries', query_projects: 'projects', query_actions: 'actions', query_artifacts: 'artifacts',
  update_entry: 'updateEntry', update_project: 'updateProject', update_action: 'updateAction', update_occurrence: 'updateOccurrence',
  create_artifact: 'createArtifact', update_artifact: 'updateArtifact', update_instance: 'updateInstance', create_instance: 'createInstance',
};
function errorGuidance(message: string): string {
  for (const [legacy, graphql] of errorHints) if (message.endsWith(legacy)) {
    return message.slice(0, -legacy.length) + graphql;
  }
  if (message === 'An occurrence edit is required; use planning_actions to read projections.') {
    return 'An occurrence edit is required; use actions through query to read projections.';
  }
  if (message === 'Original occurrence does not exist in this template schedule. Query planning_actions for its exact identity.') {
    return 'Original occurrence does not exist in this template schedule. Query actions for its exact occurrence identity.';
  }
  if (message.startsWith('Artifact ID "') && message.endsWith(' already exists. Choose another name or use update_artifact.')) {
    return message.slice(0, -'update_artifact.'.length) + 'updateArtifact through mutate.';
  }
  return message.replace(/^Invalid ([a-z_]+) arguments:/, (prefix, operation: string) =>
    errorOperations[operation] ? `Invalid ${errorOperations[operation]} arguments:` : prefix);
}

// These are API views and typed inputs over the existing records, not new stored
// entities or relationships. All persistence stays in the original handlers.
export function buildGraphQLSchema(): GraphQLSchema {
  const schema = buildSchema(graphQLSDL());

  // Reuse domain values while exposing familiar GraphQL enum spellings.
  for (const type of ['ActionStatus', 'ProjectStatus', 'ProjectRelationDirection', 'AutomationOverlap', 'AutomationRunStatus', 'AutomationLogStream']) {
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

// CLI and daemon share document validation. The CLI can reject invalid source
// and operation modes before starting or connecting to the daemon.
export function prepareGraphQL(mode: 'query' | 'mutation', args: GraphQLArgs): { document?: DocumentNode; errors?: readonly unknown[] } {
  try {
    if (args.document.length > 64_000 || JSON.stringify(args.variables ?? {}).length > 256_000) throw new GraphQLError('GraphQL request is too large.');
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

export interface GraphQLExecutionOptions extends ExecutionLimits {
  mutate?: MutationRunner; matcher?: SearchMatcher; signal?: AbortSignal; instances?: InstanceSession;
  usageLog?: GraphQLUsageLog;
  show?: (input: ShowArgs) => Promise<ShowPayload>;
  showUrl?: (input: ShowArgs) => Promise<string>;
  calendarInfo?: () => Promise<CalendarInfo>;
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
  let result: GraphQLResult | undefined;
  try {
    result = await executeGraphQLImpl(source, mode, args, { ...options, signal: budget.signal }, budget, usage);
    // Include validation failures and diagnostics in the query response ceiling.
    // Aborted requests already return a compact error without partial data.
    if (mode === 'query' && !budget.signal.aborted) budget.checkResponse(result);
    return result;
  } catch (error) {
    if (!(error instanceof GraphQLBudgetError)) throw error;
    result = { errors: [{ message: error.message }], extensions: { diagnostics: [], complete: false, mutations: [] } };
    return result;
  } finally {
    usage?.finish(result, fallback, options.signal?.aborted ?? false);
  }
}

async function executeGraphQLImpl(
  source: Store | (() => Store), mode: 'query' | 'mutation', args: GraphQLArgs,
  options: GraphQLExecutionOptions, budget: ExecutionBudget, usage?: UsageRequest,
): Promise<GraphQLResult> {
  const results: {operation: string; error: string | null; changes: MutationResult['changes']}[] = [];
  let activationFailure: string | undefined;
  const effectAllowed = () => {
    if (activationFailure) throw new GraphQLError(`Later mutation fields were skipped because instance activation failed: ${activationFailure}`);
    if (options.signal?.aborted) throw new GraphQLError('GraphQL request cancelled.');
  };
  let store: Store | undefined;
  let view: QueryView | undefined;
  const rebuildRequired = new Set<string>();
  let instanceRecord: InstanceRecord | null = null;
  const scopedViews = new Map<string, QueryView>();
  const nodePaths = new WeakMap<RecordNode, string>();
  const referenceGraphs = new WeakMap<QueryView, ReferenceGraph>();
  const referenceIssues: ParseIssue[] = [];
  const rememberView = (path: string, snapshot: QueryView) => {
    usage?.touch(path);
    scopedViews.set(path, snapshot);
    for (const collection of Object.values(snapshot.records)) for (const node of collection.values()) nodePaths.set(node, path);
    return snapshot;
  };
  const validations = new Map<string, ReturnType<typeof validateInstance>>();
  const runtimeSnapshots = new Map<string, Promise<AutomationRuntimeSnapshot>>();
  const runtimeIssues: ParseIssue[] = [];
  const refreshView = () => {
    view = rememberView(store!.getDataDir(), new QueryView(store!, options.matcher, options.signal, budget.exceed));
    instanceRecord = structuredClone(store!.getInstance());
    return view;
  };
  const records = () => {
    if (!view) {
      store = typeof source === 'function' ? source() : source;
      if (rebuildRequired.has(store.getDataDir())) { store.rebuild(); rebuildRequired.delete(store.getDataDir()); }
      return refreshView();
    }
    return view;
  };
  const scopedRecords = (path: string) => {
    if (path === options.instances?.registry.activeInstance || path === store?.getDataDir()) return records();
    let snapshot = scopedViews.get(path);
    if (!snapshot) {
      const passive = new Store(path);
      try { snapshot = rememberView(path, new QueryView(passive, options.matcher, options.signal, budget.exceed)); }
      finally { passive.close(); }
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
  const extension = () => {
    const diagnostics = [...new Map([...(options.instances?.diagnostics ?? []), ...[...scopedViews].flatMap(([path, value]) => value.issues.map(issue =>
      issue.file && !isAbsolute(issue.file) && !issue.file.startsWith('#') ? {...issue, file: resolve(path, issue.file)} : issue)),
      ...referenceIssues, ...runtimeIssues, ...[...catalogs].flatMap(([path, value]) => value.diagnostics.map<ParseIssue>(message => ({severity: 'warning', code: 'model_discovery', file: resolve(path, '.aside'), message})))]
      .map(issue => [JSON.stringify([issue.severity, issue.code, issue.file, issue.field, issue.message]), issue])).values()];
    return { diagnostics, complete: diagnostics.length === 0, mutations: results };
  };
  try {
    budget.check();
    if (typeof source !== 'function') records();
    if (args.document.length > 64_000 || JSON.stringify(args.variables ?? {}).length > 256_000) throw new GraphQLError('GraphQL request is too large.');
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
    if (mode === 'query' && rootFields.some(field => ['entry', 'entries', 'project', 'projects', 'action', 'actions', 'artifact', 'artifacts'].includes(field.name.value))) records();
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
          if (names.length && scope && isAsideDir(scope) && !choices) {
            choices = await catalogFor(scope, {signal: options.signal});
            catalogs.set(scope, choices);
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
    const session = () => {
      if (!options.instances) throw new Error('Instance operations require an MCP session.');
      return options.instances;
    };
    roots.instances = () => session().instances(false);
    roots.activeInstance = async () => {
      if (!options.instances) return snapshotInstance();
      const info = await session().activeInstance(false);
      budget.check();
      if (!info) return null;
      usage?.touch(info.path);
      if (view && store?.getDataDir() === info.path) return snapshotInstance();
      // Metadata, model discovery and retained logs do not load Store or arm jobs.
      const parsed = readInstanceRecordResult(info.path);
      runtimeIssues.push(...parsed.issues);
      return {...info, ...parsed.value};
    };
    roots.show = async ({ input }: { input: ShowArgs }) => {
      effectAllowed();
      if (options.instances?.registry.activeInstance) usage?.touch(options.instances.registry.activeInstance);
      if (!options.show) throw new Error('Show operations require an MCP session.');
      const result = await options.show(input);
      const error = result.outcome === 'UNAVAILABLE'
        ? 'Could not open the default browser. Call showUrl with the same input and open its file:// URL in another local browser; authorization and redirection are automatic.'
        : null;
      results.push({operation: 'show', error, changes: []});
      return {...result, error};
    };
    roots.showUrl = async ({ input }: { input: ShowArgs }) => {
      effectAllowed();
      if (options.instances?.registry.activeInstance) usage?.touch(options.instances.registry.activeInstance);
      if (!options.showUrl) throw new Error('Show URL operations require an MCP session.');
      const url = await options.showUrl(input);
      results.push({operation: 'showUrl', error: null, changes: []});
      return url;
    };
    roots.calendarInfo = async () => {
      effectAllowed();
      if (options.instances?.registry.activeInstance) usage?.touch(options.instances.registry.activeInstance);
      if (!options.calendarInfo) throw new Error('Calendar information requires an MCP session.');
      const result = await options.calendarInfo();
      // Recovery guidance must name the operations exposed in this mode.
      const diagnostic = (value: CalendarInfo['diagnostics'][number]) => ({ ...value, recovery: calendarGuidance(value.recovery) });
      const payload = {
        ...result, receipt: receiptGuidance(result.receipt), diagnostics: result.diagnostics.map(diagnostic),
        syncStates: result.syncStates.map(state => ({ ...state, diagnostic: state.diagnostic ? diagnostic(state.diagnostic) : undefined })),
        failures: result.failures.map(failure => ({ ...failure, diagnostic: diagnostic(failure.diagnostic) })),
      };
      const diagnosticMessage = (value: CalendarInfo['diagnostics'][number]) => `${value.reason} Recovery: ${value.recovery}`;
      const problems = [...payload.failures, ...payload.syncStates.flatMap(state =>
        state.diagnostic && state.diagnostic.category !== 'sync-pending'
          // Inactive actions can retain a diagnostic from an earlier retry.
          && !(state.status === 'disabled' && ['no calendar', 'action no longer exists'].includes(state.reason ?? ''))
          ? [{id: state.id, diagnostic: state.diagnostic}] : [])];
      const messages = [...payload.diagnostics.map(diagnosticMessage),
        ...problems.map(value => `${value.id}: ${diagnosticMessage(value.diagnostic)}`)];
      for (const state of payload.syncStates) {
        if (state.status === 'failed' && (!state.diagnostic || state.diagnostic.category === 'sync-pending')) {
          messages.push(`${state.id}: ${state.reason ?? 'Calendar sync failed.'}`);
        }
      }
      for (const issue of payload.issues) {
        // A scheduled action without a Calendar intentionally does not sync.
        if (issue.reason === 'no calendar') continue;
        if (payload.syncStates.some(state => state.id === issue.id && state.status === 'pending'
          && state.diagnostic?.category === 'sync-pending' && state.reason === issue.reason)) continue;
        if (!problems.some(value => value.id === issue.id && value.diagnostic.reason === issue.reason)
          && !payload.syncStates.some(state => state.id === issue.id && state.status === 'failed' && state.reason === issue.reason)) {
          messages.push(`${issue.id}: ${issue.reason}`);
        }
      }
      const error = messages.length ? [...new Set(messages)].join('\n') : null;
      results.push({operation: 'calendarInfo', error, changes: []});
      return {...payload, error};
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
          ...(result.error ? {recovery: result.receipt} : {})};
        const error = summarizeMutationError(mutationResult);
        usage?.changes(result.instance.path, mutationResult.changes);
        results.push({operation: field, error, changes: mutationResult.changes});
        // Following mutation fields must use the newly active store.
        view = undefined; store = undefined; instanceRecord = null; validations.clear();
        instanceOwners.clear(); automationViews.clear(); runtimeSnapshots.clear(); scopedViews.clear();
        if (result.error) activationFailure = result.error;
        return {...result, error};
      };
    }
    const automationViews = new Map<string, AutomationView>();
    const instanceOwners = new Map<string, AutomationOwner>();
    const instanceOwner = (path: string): AutomationOwner => {
      let owner = instanceOwners.get(path);
      if (!owner) {
        const parsed = view && store?.getDataDir() === path && instanceRecord
          ? {value: instanceRecord, issues: []} : readInstanceRecordResult(path);
        runtimeIssues.push(...parsed.issues);
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
      roots[plural] = (input: any, info: GraphQLResolveInfo) => records().list(kind, input, undefined, undefined, needsRecordNodes(info));
    }
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
        records();
        if (!options.mutate) throw new Error('GraphQL mutations are unavailable.');
        if (options.signal?.aborted) throw new Error('GraphQL request cancelled.');
        const names = authoredAutomationModels(preparedInput);
        if (names.length) {
          const path = store!.getDataDir();
          const choices = catalogs.get(path) ?? await catalogFor(path, {signal: options.signal});
          catalogs.set(path, choices);
          for (const name of names) if (!choices.models.some(model => model.name === name)) {
            throw new GraphQLError(`Model ${name} is not selectable in the execution's instance.`);
          }
        }
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
        const commitPrompts = prepareAutomationPrompts(store!, preparedInput);
        let result: MutationOutcome;
        let mutationResult: MutationResult;
        let failureMessage: string | undefined;
        try {
          const tracked = trackMutation(store!, () => {
            const release = commitPrompts ? beforeMutationWrite(store!, commitPrompts) : undefined;
            try {
              const outcome = options.mutate!(operation, values);
              // A valid edit can preserve an already-saved reference while
              // creating its missing artifact. Commit after successful no-op
              // validation too; the deferred callback is idempotent.
              commitPrompts?.();
              return outcome;
            } finally {release?.();}
          });
          result = tracked.value;
          // The outer journal covers the whole operation, including effects
          // after a nested handler returns its own intermediate snapshot.
          mutationResult = tracked.result;
        } catch (error) {
          if (error instanceof MutationWriteError) {
            mutationResult = error.partialResult;
            failureMessage = errorGuidance(error.originalMessage);
            result = {text: ''};
          } else throw error;
        }
        mutationResult = {...mutationResult, failures: mutationResult.failures.map(failure => ({...failure, message: errorGuidance(failure.message)}))};
        usage?.changes(store!.getDataDir(), mutationResult.changes);
        if (isFullMutationFailure(mutationResult)) throw new GraphQLError(errorGuidance(summarizeMutationError(mutationResult, {message: failureMessage})!));
        validations.clear();
        instanceOwners.clear();
        automationViews.clear();
        runtimeSnapshots.clear();
        let updatedView: QueryView | undefined;
        try {
          if (failureMessage || rebuildRequired.has(store!.getDataDir())) { store!.rebuild(); rebuildRequired.delete(store!.getDataDir()); }
          updatedView = refreshView();
        } catch (error) {
          view = undefined; instanceRecord = null; rebuildRequired.add(store!.getDataDir()); scopedViews.delete(store!.getDataDir());
          const problem = `Saved changes could not be read back: ${error instanceof Error ? error.message : String(error)}`;
          failureMessage = failureMessage ? `${failureMessage}\n${problem}` : problem;
          if (!mutationResult.changes.length) throw new GraphQLError(problem);
        }
        const error = summarizeMutationError(mutationResult, {message: failureMessage, warnings: result.warnings});
        results.push({operation: field, error, changes: mutationResult.changes});
        const ids = deriveMutationPayloadIds(kind, id, mutationResult, result);
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
        if (info.parentType.name === 'Instance' && ['body', 'settings', 'automations', 'automationLog', 'execution', 'validation'].includes(field)) usage?.touch(source.path);
        if (field === 'links' || field === 'backlinks' || field === 'attachmentLinks') {
          const path = nodePaths.get(source) ?? store?.getDataDir();
          if (!path) throw new GraphQLError('Cannot resolve the link source instance.');
          const snapshot = scopedRecords(path);
          let graph = referenceGraphs.get(snapshot);
          if (!graph) {
            graph = buildReferenceGraph(path, snapshot.records, options.signal);
            referenceGraphs.set(snapshot, graph);
            referenceIssues.push(...graph.issues);
          }
          const page = graph.page(source.handle ?? '', field, input.offset ?? 0, input.limit ?? 20);
          for (const node of page.nodes) nodePaths.set(node as RecordNode, path);
          return page;
        }
        if (info.parentType.name === 'Instance' && ['body', 'settings'].includes(field)) {
          const record = source.manifest ? source : readInstanceRecordResult(source.path).value;
          if (field === 'body') return record.body;
          const config = record.manifest.config;
          return {recurrenceLookaheadDays: config?.recurrenceLookaheadDays ?? 7,
            scheduledEventTitlePrefix: config?.scheduledEventTitlePrefix ?? '▢ ',
            doneEventTitlePrefix: config?.doneEventTitlePrefix ?? '✓ '};
        }
        if (info.parentType.name === 'Instance') {
          if (field === 'automations') return automationView(source.path).list(instanceOwner(source.path), input);
          if (field === 'automationLog') return automationView(source.path).log({}, input);
          if (field === 'execution') return executionView(source.path, {diagnostics: runtimeIssues, signal: options.signal,
            catalog: async refresh => {
              const snapshot = refresh || !catalogs.has(source.path) ? await catalogFor(source.path, {refresh, signal: options.signal}) : catalogs.get(source.path)!;
              budget.check();
              catalogs.set(source.path, snapshot);
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
          if (field === 'relatedProjects') {
            const relations = new Map(nodeView.relatedProjectRelations(node).map(link => [link.project.id, link]));
            const filtered = input.direction == null ? input : {...input, where: {and: [input.where ?? {},
              {ids: [...relations.values()].filter(link => input.direction.includes(link.direction)).map(link => link.project.id)}]}};
            return nodeView.list('project', filtered, node, field, needsRecordNodes(info)).then(page =>
              ({...page, nodes: page.nodes.map(project => relations.get(project.id)!)}));
          }
          if (['entries', 'projects', 'actions', 'artifacts'].includes(field)) {
            const target = field === 'relatedProjects' ? 'project' : field === 'entries' ? 'entry' : field.slice(0, -1) as Kind;
            return nodeView.list(target, input, node, field, needsRecordNodes(info));
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
            const content = {__typename: 'Attachment', ...attachmentFiles(path, node.id, [filename])[0]};
            nodePaths.set(content as unknown as RecordNode, path);
            return content;
          }
          if (field === 'attachments') return attachmentFiles(path, node.id, node.record.frontMatter.attachments ?? []).map(file => {
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
    return { errors: [{ message }], extensions: budget.signal.aborted
      ? { diagnostics: [], complete: false, mutations: results } : extension() };
  }
}
