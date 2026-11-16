import {
  Kind, buildSchema, getNamedType, getVariableValues, isCompositeType, isListType,
  isNonNullType, isObjectType, isInterfaceType, parse, print, validate, valueFromASTUntyped, visit,
  type DocumentNode, type FieldNode, type GraphQLCompositeType, type GraphQLField,
  type OperationDefinitionNode, type SelectionNode, type SelectionSetNode, type ValueNode, type VariableNode,
} from 'graphql';
import { graphQLSDL } from '../../cli/src/graphql/sdl';
import type { EntityRef } from '../lib/types';
import { isEntryTimestamp } from './entity-reference';
import { WEB_QUERY_MAX_BYTES, webQueryBytes, type WebQueryRequest } from '../../cli/src/core/web-query';

export type SourceOrder = 'CREATED_ASC' | 'CREATED_DESC';
export interface SourceDefinition {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  // A response path (including aliases), required only for ambiguous queries.
  result?: string;
}
export interface SourcePage { ids: string[]; offset: number; count: number; totalCount: number }
export interface SourceQueryRequest extends WebQueryRequest { variables: Record<string, unknown> }
export interface SourcePageRequest {
  offset: number;
  limit: number;
  previousId?: string;
  order?: SourceOrder;
  variables?: Record<string, unknown>;
}
export interface SourceRequestOptions extends SourcePageRequest {
  filter?: EntityRef | null;
  search?: string;
  range?: { start: string; end: string };
  additionalWhere?: Record<string, unknown>;
}
export class SourceIncompleteError extends Error {
  constructor(message = 'The entry query could not confirm complete results. Retry after resolving the instance diagnostics.') {
    super(message); this.name = 'SourceIncompleteError';
  }
}

type Candidate = {
  path: string[];
  fields: FieldNode[];
  definition: GraphQLField<unknown, unknown>;
  listAncestor: boolean;
  nullableParents: Set<number>;
  conditional: boolean;
};
type Compiled = {
  operation: OperationDefinitionNode;
  selected: Candidate;
  keys: { nodes: string; id: string; offset: string; count: string; totalCount: string };
  additions: FieldNode[];
  variableNames: Set<string>;
};
const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const compiled = new WeakMap<SourceDefinition, Compiled>();
let schema: ReturnType<typeof buildSchema> | undefined;
const querySchema = () => schema ??= buildSchema(graphQLSDL());
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(message: string): never { throw new Error(`Invalid entry query: ${message}`); }
function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !NAME.test(value)) fail(`${label} must be a GraphQL name.`);
  return value as string;
}
const responseKey = (field: FieldNode) => field.alias?.value ?? field.name.value;
const field = (name: string, alias?: string, selectionSet?: SelectionSetNode): FieldNode => ({
  kind: Kind.FIELD, name: { kind: Kind.NAME, value: name },
  ...(alias && alias !== name ? { alias: { kind: Kind.NAME, value: alias } } : {}),
  ...(selectionSet ? { selectionSet } : {}),
});
function references(node: unknown): Set<string> {
  const names = new Set<string>();
  if (node) visit(node as ValueNode, { VariableDefinition: () => false, Variable: node => { names.add(node.name.value); } });
  return names;
}
function flatten(set: SelectionSetNode, includeConditional = false): FieldNode[] {
  return set.selections.flatMap(selection => selection.kind === Kind.FIELD ? [selection]
    : selection.kind === Kind.INLINE_FRAGMENT && (includeConditional || !selection.directives?.length)
      ? flatten(selection.selectionSet, includeConditional) : []);
}
function compile(def: SourceDefinition): Compiled {
  const cached = compiled.get(def); if (cached) return cached;
  let document: DocumentNode;
  try { document = parse(def.query, { maxTokens: 10_000 }); }
  catch (error) { return fail(error instanceof Error ? error.message : 'GraphQL could not be parsed.'); }
  const operations = document.definitions.filter(node => node.kind === Kind.OPERATION_DEFINITION);
  const choices = def.operationName ? operations.filter(operation => operation.name?.value === def.operationName) : operations;
  if (choices.length !== 1) fail('Select one operation with operationName when the document contains multiple operations.');
  if (choices[0].operation !== 'query') fail('Only read-only query operations are supported.');
  const fragmentDefinitions = document.definitions.filter(node => node.kind === Kind.FRAGMENT_DEFINITION);
  if (fragmentDefinitions.some(fragment => fragment.directives?.length)) fail('Fragment definitions cannot have directives.');
  const fragments = new Map(fragmentDefinitions.map(node => [node.name.value, node]));
  if (fragments.size !== fragmentDefinitions.length) fail('Fragment names must be unique.');
  let selections = 0;
  function expand(set: SelectionSetNode, stack = new Set<string>()): SelectionSetNode {
    return { ...set, selections: set.selections.map((selection): SelectionNode => {
      if (++selections > 1_000) fail('The query contains too many expanded selections.');
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const id = selection.name.value, fragment = fragments.get(id);
        if (!fragment || stack.has(id)) fail(`Missing or cyclic fragment "${id}".`);
        return { kind: Kind.INLINE_FRAGMENT, typeCondition: fragment.typeCondition, directives: selection.directives,
          selectionSet: expand(fragment.selectionSet, new Set([...stack, id])) };
      }
      return { ...selection, ...(selection.selectionSet ? { selectionSet: expand(selection.selectionSet, stack) } : {}) };
    }) };
  }
  const operation = { ...choices[0], selectionSet: expand(choices[0].selectionSet) };
  const selectedDocument: DocumentNode = { kind: Kind.DOCUMENT, definitions: [operation] };
  const errors = validate(querySchema(), selectedDocument);
  if (errors.length) fail(errors.map(error => error.message).join('; '));
  const variableNames = new Set(operation.variableDefinitions?.map(variable => variable.variable.name.value));
  for (const key of Object.keys(def.variables ?? {})) if (!variableNames.has(key)) fail(`Unknown operation variable "${key}".`);
  const candidates = new Map<string, Candidate>();
  let hasActions = false;
  function walk(set: SelectionSetNode, parent: GraphQLCompositeType, path: string[], listAncestor: boolean,
    nullableParents: Set<number>, conditional = false): void {
    for (const node of set.selections) {
      if (node.kind === Kind.INLINE_FRAGMENT) {
        const type = node.typeCondition ? querySchema().getType(node.typeCondition.name.value) : parent;
        if (type && isCompositeType(type)) walk(node.selectionSet, type, path, listAncestor, nullableParents, conditional || !!node.directives?.length);
        continue;
      }
      if (node.kind !== Kind.FIELD || (!isObjectType(parent) && !isInterfaceType(parent))) continue;
      const definition = parent.getFields()[node.name.value]; if (!definition) continue;
      const type = getNamedType(definition.type), nextPath = [...path, responseKey(node)];
      const nextConditional = conditional || !!node.directives?.length;
      if (type.name === 'ActionPage') hasActions = true;
      if (type.name === 'EntryPage') {
        const key = nextPath.join('.'), existing = candidates.get(key);
        if (existing) { existing.fields.push(node); existing.conditional ||= nextConditional; }
        else candidates.set(key, { path: nextPath, fields: [node], definition, listAncestor, nullableParents, conditional: nextConditional });
      }
      const unwrapped = isNonNullType(definition.type) ? definition.type.ofType : definition.type;
      const nextNullable = new Set(nullableParents);
      if (!isNonNullType(definition.type)) nextNullable.add(nextPath.length);
      if (node.selectionSet && isCompositeType(type)) walk(node.selectionSet, type, nextPath,
        listAncestor || isListType(unwrapped), nextNullable, nextConditional);
    }
  }
  walk(operation.selectionSet, querySchema().getQueryType()!, [], false, new Set());
  const eligible = [...candidates.values()].filter(candidate => !candidate.listAncestor);
  let selected: Candidate | undefined;
  if (def.result !== undefined) selected = candidates.get(def.result);
  else if (eligible.length === 1) selected = eligible[0];
  if (!selected) {
    if (def.result) fail(`No entry collection exists at response path "${def.result}".`);
    if (eligible.length > 1) fail(`Several entry collections exist; select result: ${eligible.map(candidate => candidate.path.join('.')).join(', ')}.`);
    if (candidates.size) fail('An entry collection inside a list contains multiple timelines; select entries through a singular parent.');
    if (hasActions) fail('Action collections are not supported in the entry flow.');
    fail('The query must select a paginated entry collection.');
  }
  if (selected.listAncestor) fail('An entry collection inside a list contains multiple timelines; select entries through a singular parent.');
  if (selected.conditional) fail('The selected entry collection and its parents cannot have conditional directives.');
  const pageFields = selected.fields.flatMap(node => node.selectionSet ? flatten(node.selectionSet) : []);
  // Conditional fields cannot supply required page metadata, but their aliases
  // still participate in GraphQL's response-key conflict validation.
  const reservedFields = selected.fields.flatMap(node => node.selectionSet ? flatten(node.selectionSet, true) : []);
  const additions: FieldNode[] = [];
  const uniqueKey = (preferred: string) => {
    let key = preferred; while (reservedFields.some(node => responseKey(node) === key) || additions.some(node => responseKey(node) === key)) key = `_${key}`;
    return key;
  };
  const scalarKey = (name: string) => {
    const existing = pageFields.find(node => node.name.value === name && !node.directives?.length);
    if (existing) return responseKey(existing);
    const key = uniqueKey(name); additions.push(field(name, key)); return key;
  };
  const nodes = pageFields.find(node => node.name.value === 'nodes' && !node.directives?.length && node.selectionSet
    && flatten(node.selectionSet).some(child => child.name.value === 'id' && !child.directives?.length));
  let nodesKey: string, idKey: string;
  if (nodes?.selectionSet) {
    nodesKey = responseKey(nodes);
    idKey = responseKey(flatten(nodes.selectionSet).find(node => node.name.value === 'id' && !node.directives?.length)!);
  } else {
    nodesKey = uniqueKey('nodes'); idKey = 'id';
    additions.push(field('nodes', nodesKey, { kind: Kind.SELECTION_SET, selections: [field('id')] }));
  }
  const value: Compiled = { operation, selected, variableNames, additions,
    keys: { nodes: nodesKey, id: idKey, offset: scalarKey('offset'), count: scalarKey('count'), totalCount: scalarKey('totalCount') } };
  compiled.set(def, value); return value;
}

function values(def: SourceDefinition, names: Set<string>, overrides?: Record<string, unknown>): Record<string, unknown> {
  const operation = compile(def);
  for (const key of Object.keys(overrides ?? {})) if (!operation.variableNames.has(key)) throw new Error(`Unknown entry query parameter "${key}".`);
  const result = getVariableValues(querySchema(), (operation.operation.variableDefinitions ?? []).filter(node => names.has(node.variable.name.value)),
    { ...def.variables, ...overrides });
  if (result.errors) throw new Error(result.errors.map(error => error.message).join('; '));
  return Object.assign(Object.create(null), result.variableValues.coerced);
}
export function effectiveSourceOrder(def: SourceDefinition, override?: SourceOrder, variables?: Record<string, unknown>): SourceOrder {
  let value: unknown = override;
  if (value === undefined) {
    const source = compile(def), node = source.selected.fields[0];
    const argument = node.arguments?.find(argument => argument.name.value === 'orderBy');
    const defaultValue = source.selected.definition.args.find(argument => argument.name === 'orderBy')?.astNode?.defaultValue;
    value = (argument ? valueFromASTUntyped(argument.value, values(def, references(argument.value), variables))
      : defaultValue ? valueFromASTUntyped(defaultValue) : undefined) ?? 'CREATED_DESC';
  }
  if (value !== 'CREATED_ASC' && value !== 'CREATED_DESC') throw new Error('Unsupported entry ordering.');
  return value;
}
export function parseEntrySource(text: string): SourceDefinition {
  if (new TextEncoder().encode(text).byteLength > WEB_QUERY_MAX_BYTES) fail('The definition exceeds 64 KiB.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail('The definition must be valid JSON.'); }
  if (!record(value)) fail('The definition must be an object.');
  for (const key of Object.keys(value)) if (!['query', 'variables', 'operationName', 'result'].includes(key)) fail(`Unknown definition field "${key}".`);
  if (typeof value.query !== 'string' || !value.query.trim()) fail('query must be a nonblank GraphQL operation.');
  if (value.variables !== undefined && !record(value.variables)) fail('variables must be an object.');
  if (value.result !== undefined && (typeof value.result !== 'string' || !value.result.split('.').every(part => NAME.test(part)))) fail('result must be a dotted response path.');
  const def: SourceDefinition = { query: value.query, variables: value.variables ?? {},
    ...(value.operationName !== undefined ? { operationName: name(value.operationName, 'operationName') } : {}),
    ...(value.result !== undefined ? { result: value.result as string } : {}) };
  compile(def);
  try { sourceRequest(def, { offset: 0, limit: 50 }); }
  catch (error) { fail(error instanceof Error ? error.message : 'The query inputs are invalid.'); }
  return def;
}
function pageRequest(request: SourcePageRequest): void {
  if (!Number.isSafeInteger(request.offset) || request.offset < 0) throw new Error('Entry query offset must be a nonnegative integer.');
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new Error('Entry query limit must be from 1 to 100.');
}
export function sourceRequest(def: SourceDefinition, options: SourceRequestOptions): SourceQueryRequest {
  pageRequest(options);
  const source = compile(def), selected = source.selected.fields[0];
  const where = selected.arguments?.find(argument => argument.name.value === 'where');
  const whereNames = references(where?.value);
  const targetFields = new Set(source.selected.fields);
  // The app owns the selected collection's predicate, page and overridden order.
  const retainedArgument = (argument: { readonly name: { readonly value: string } }) =>
    !['where', 'limit', 'offset'].includes(argument.name.value) && !(options.order !== undefined && argument.name.value === 'orderBy');
  const retained = visit(source.operation.selectionSet, { Field(node) {
    if (targetFields.has(node)) return { ...node, arguments: node.arguments?.filter(retainedArgument) };
  } });
  const retainedNames = references(retained);
  // Resolve the authored predicate without changing its grouped conditions.
  // Pagination variables used only by the selected collection are app-owned.
  for (const key of whereNames) retainedNames.add(key);
  const order = effectiveSourceOrder(def, options.order, options.variables);
  const authored = values(def, retainedNames, options.variables);
  const base = where ? valueFromASTUntyped(where.value, authored) : undefined;
  if (base != null && !record(base)) throw new Error('The entry query where argument must contain an EntryWhere object.');
  const predicates: Record<string, unknown>[] = base == null ? [] : [base];
  const browse: Record<string, unknown> = {};
  if (options.filter?.type === 'project' || options.filter?.type === 'action') browse[options.filter.type] = options.filter.id;
  else if (options.filter?.type === 'entry') predicates.push({ ids: [options.filter.id] });
  if (options.search?.trim()) browse.search = options.search.trim();
  if (options.range) { browse.createdFrom = options.range.start; browse.createdTo = options.range.end; }
  if (Object.keys(browse).length) predicates.push({ browse });
  if (options.additionalWhere) predicates.push(options.additionalWhere);
  let whereVariable = '_asideWhere'; while (source.variableNames.has(whereVariable)) whereVariable = `_${whereVariable}`;
  const variable: VariableNode = { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: whereVariable } };
  const operation = visit(source.operation, { Field(node) {
    if (!targetFields.has(node)) return;
    const arguments_ = (node.arguments ?? []).filter(retainedArgument);
    arguments_.push({ kind: Kind.ARGUMENT, name: { kind: Kind.NAME, value: 'where' }, value: variable },
      { kind: Kind.ARGUMENT, name: { kind: Kind.NAME, value: 'offset' }, value: { kind: Kind.INT, value: String(options.offset) } },
      { kind: Kind.ARGUMENT, name: { kind: Kind.NAME, value: 'limit' }, value: { kind: Kind.INT, value: String(options.limit) } });
    if (options.order !== undefined) arguments_.push({ kind: Kind.ARGUMENT, name: { kind: Kind.NAME, value: 'orderBy' }, value: { kind: Kind.ENUM, value: order } });
    return { ...node, arguments: arguments_, selectionSet: { kind: Kind.SELECTION_SET,
      selections: [...node.selectionSet!.selections, ...(node === selected ? source.additions : [])] } };
  } });
  const used = references(operation.selectionSet);
  const definitions = operation.variableDefinitions?.filter(node => used.has(node.variable.name.value)) ?? [];
  const requestOperation: OperationDefinitionNode = { ...operation, variableDefinitions: [...definitions, { kind: Kind.VARIABLE_DEFINITION, variable,
    type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: 'EntryWhere' } } }] };
  const variables: Record<string, unknown> = Object.create(null);
  for (const key of used) if (key !== whereVariable && Object.hasOwn(authored, key)) variables[key] = authored[key];
  variables[whereVariable] = predicates.length === 1 ? predicates[0] : { and: predicates };
  const request: SourceQueryRequest = { query: print({ kind: Kind.DOCUMENT, definitions: [requestOperation] }), variables,
    ...(def.operationName ? { operationName: def.operationName } : {}) };
  if (webQueryBytes(request) > WEB_QUERY_MAX_BYTES) throw new Error('The entry query request exceeds 64 KiB.');
  return request;
}
export function parseSourcePage(def: SourceDefinition, response: unknown, request: SourcePageRequest): SourcePage {
  pageRequest(request);
  if (!record(response)) throw new Error('The entry query returned an invalid GraphQL response.');
  if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) {
    throw new Error(Array.isArray(response.errors) ? response.errors.map(error => record(error) && typeof error.message === 'string' ? error.message : 'Query failed').join('; ') : 'Invalid GraphQL errors');
  }
  if (!record(response.extensions) || response.extensions.complete !== true) throw new SourceIncompleteError();
  const source = compile(def);
  let page: unknown = response.data;
  for (const [index, key] of source.selected.path.entries()) {
    if (!record(page) || !Object.hasOwn(page, key)) throw new Error('The entry query did not return its selected collection.');
    page = page[key];
    if (page === null && source.selected.nullableParents.has(index + 1)) return { ids: [], offset: request.offset, count: 0, totalCount: 0 };
  }
  const keys = source.keys;
  if (!record(page)) throw new Error('The entry query returned an invalid entry page.');
  const nodes = page[keys.nodes], offset = page[keys.offset], count = page[keys.count], totalCount = page[keys.totalCount];
  if (!Array.isArray(nodes) || offset !== request.offset || !Number.isSafeInteger(count) || !Number.isSafeInteger(totalCount)
    || (count as number) < 0 || (totalCount as number) < 0 || count !== nodes.length
    || count !== Math.min(request.limit, Math.max(0, (totalCount as number) - request.offset))) throw new Error('The entry query returned an inconsistent entry page.');
  const order = effectiveSourceOrder(def, request.order, request.variables);
  let previous = request.previousId;
  const ids = nodes.map(node => {
    const id = record(node) ? node[keys.id] : undefined;
    if (typeof id !== 'string' || !isEntryTimestamp(id) || previous !== undefined && (order === 'CREATED_ASC' ? id <= previous : id >= previous)) {
      throw new Error(`The entry query must return unique entry IDs in ${order === 'CREATED_ASC' ? 'ascending' : 'descending'} order.`);
    }
    previous = id; return id;
  });
  return { ids, offset: offset as number, count: count as number, totalCount: totalCount as number };
}
