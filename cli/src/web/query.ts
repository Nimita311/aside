import {
  GraphQLError, Kind, getArgumentValues, getNamedType, getOperationAST, getVariableValues,
  isCompositeType, isEnumType, isListType, isNonNullType, isScalarType,
  type GraphQLCompositeType, type SelectionSetNode,
} from 'graphql';
import { GRAPHQL_SCHEMA, prepareGraphQL, type GraphQLArgs } from '../graphql/schema.js';
import { validWebQueryRequest, webQueryBytes, WEB_QUERY_MAX_BYTES, type WebQueryResult } from '../core/web-query.js';

const roots = new Set(['entry', 'entries', 'project', 'projects', 'action', 'actions', 'artifact', 'artifacts']);
// Fail closed when the agent schema adds another object type or runtime surface.
const objects = new Set(['Entry', 'EntryPage', 'Project', 'ProjectPage', 'Action', 'ActionPage',
  'Artifact', 'ArtifactPage', 'LinkTarget', 'LinkPage', 'Attachment', 'AttachmentPage',
  'ArtifactContent', 'MarkdownContent', 'ProjectRelation', 'ProjectRelationPage', 'Occurrence', 'RecurrenceSchedule']);
const failed = (errors: readonly unknown[]): { result: WebQueryResult } => ({ result: {
  errors, extensions: { complete: false, diagnostics: [], mutations: [] },
} });

export function prepareWebQuery(input: unknown): { args: GraphQLArgs } | { result: WebQueryResult } {
  try {
    if (!validWebQueryRequest(input) || webQueryBytes(input) > WEB_QUERY_MAX_BYTES) {
      throw new GraphQLError('Provide query, optional variables and operationName within the 64 KiB request limit.');
    }
    const args: GraphQLArgs = { document: input.query, variables: input.variables, operationName: input.operationName };
    const prepared = prepareGraphQL('query', args);
    if (!prepared.document) return failed(prepared.errors ?? []);
    const document = prepared.document;
    const operations = document.definitions.filter(def => def.kind === Kind.OPERATION_DEFINITION);
    if (operations.length !== 1 || operations[0].operation !== 'query') {
      throw new GraphQLError('Webpage queries accept exactly one query operation; mutations and subscriptions are unavailable.');
    }
    const operation = getOperationAST(document, input.operationName)!;
    const variables = getVariableValues(GRAPHQL_SCHEMA, operation.variableDefinitions ?? [], input.variables ?? {});
    if (variables.errors) return failed(variables.errors.map(error => error.toJSON()));
    const fragments = new Map(document.definitions.filter(def => def.kind === Kind.FRAGMENT_DEFINITION).map(def => [def.name.value, def]));
    let fields = 0, cost = 0, rootCount = 0;
    const walk = (set: SelectionSetNode, parent: GraphQLCompositeType, depth: number, weight: number, pageSize = 100): void => {
      for (const node of set.selections) {
        if (node.kind === Kind.FRAGMENT_SPREAD) {
          const fragment = fragments.get(node.name.value)!;
          walk(fragment.selectionSet, GRAPHQL_SCHEMA.getType(fragment.typeCondition.name.value) as GraphQLCompositeType, depth, weight, pageSize);
          continue;
        }
        if (node.kind === Kind.INLINE_FRAGMENT) {
          walk(node.selectionSet, node.typeCondition ? GRAPHQL_SCHEMA.getType(node.typeCondition.name.value) as GraphQLCompositeType : parent, depth, weight, pageSize);
          continue;
        }
        if (depth > 8 || ++fields > 200 || (cost += weight) > 10_000 || (depth === 1 && ++rootCount > 10)) {
          throw new GraphQLError('Webpage query budget exceeded. Reduce depth, selections, roots or page sizes.');
        }
        const name = node.name.value;
        if (name === '__typename') continue;
        if (depth === 1 && !roots.has(name)) throw new GraphQLError(`Query.${name} is unavailable to webpages.`);
        if (!('getFields' in parent)) throw new GraphQLError('Unsupported webpage selection.');
        const field = parent.getFields()[name];
        const type = getNamedType(field.type);
        if (!isScalarType(type) && !isEnumType(type) && !objects.has(type.name)) {
          throw new GraphQLError(`${parent.name}.${name} is unavailable to webpages.`);
        }
        const arguments_ = getArgumentValues(field, node, variables.variableValues);
        const limit = arguments_.limit;
        if (field.args.some(arg => arg.name === 'limit') && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)) {
          throw new GraphQLError('Page limits must be integers from 1 to 100.');
        }
        let childWeight = weight;
        const unwrapped = isNonNullType(field.type) ? field.type.ofType : field.type;
        if (isListType(unwrapped)) childWeight *= name === 'nodes' && parent.name.endsWith('Page') ? pageSize : 100;
        if (node.selectionSet && isCompositeType(type)) walk(node.selectionSet, type, depth + 1, childWeight, typeof limit === 'number' ? limit : 100);
      }
    };
    // Directives never reduce the budget or bypass access checks.
    walk(operation.selectionSet, GRAPHQL_SCHEMA.getQueryType()!, 1, 1);
    return { args };
  } catch (error) {
    return failed([error instanceof GraphQLError ? error.toJSON() : { message: error instanceof Error ? error.message : String(error) }]);
  }
}
