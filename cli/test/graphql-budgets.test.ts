import {afterEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {buildSchema, getIntrospectionQuery, parse, type GraphQLObjectType} from 'graphql';
import {init} from '../src/commands/init.js';
import {formatUtcTimestamp} from '../src/core/date.js';
import {executeGraphQL, type GraphQLResult} from '../src/graphql/schema.js';
import {ExecutionBudget, executeWithBudget} from '../src/graphql/execution-budget.js';
import {Store} from '../src/mcp/store.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession} from '../src/mcp/instance-session.js';
import {handleCapture} from '../src/mcp/tools/capture.js';
import type {SearchOptions} from '../src/mcp/search.js';

describe('GraphQL execution budgets', () => {
  const fixtures: {root: string; store: Store}[] = [];
  const passive = () => { throw new Error('Introspection must not load instance records'); };
  const fixture = (content = 'Context') => {
    const root = mkdtempSync('/tmp/aside-graphql-budgets-');
    init(root, {name: '☃', description: 'Execution budget fixture'});
    const store = new Store(root);
    fixtures.push({root, store});
    const captured = handleCapture(store, {
      content, description: 'Context',
      projects: [{name: 'Project', description: 'Project description'}],
      actions: [{name: 'Review', description: 'Review description'}],
    }, new Date(2026, 5, 1, 10));
    return {store, entry: captured.entryId, action: captured.createdActionIds[0]};
  };
  const expectBudgetFailure = (result: GraphQLResult, message: RegExp) => {
    expect(JSON.stringify(result.errors)).toMatch(message);
    expect(result.data == null).toBe(true);
  };

  afterEach(() => {
    vi.restoreAllMocks();
    for (const {root, store} of fixtures.splice(0)) {
      store.close();
      rmSync(root, {recursive: true, force: true});
    }
  });

  it('allows standard schema discovery without loading records', async () => {
    const source = vi.fn(passive);
    const result = await executeGraphQL(source, 'query', {document: getIntrospectionQuery({oneOf: true})});
    expect(result.errors).toBeUndefined();
    expect(result.data?.__schema).toMatchObject({queryType: {name: 'Query'}, mutationType: {name: 'Mutation'}});
    expect(source).not.toHaveBeenCalled();
  });

  it('bounds repeated schema expansion under the default execution limits', async () => {
    const source = vi.fn(passive);
    const document = `query {
      ${Array.from({length: 100}, (_, i) => `s${i}: __schema { ...SchemaProbe }`).join('\n')}
    }
    fragment SchemaProbe on __Schema {
      types { name description fields { name description args { name description type { name } } } }
    }`;
    const result = await executeGraphQL(source, 'query', {document});
    expectBudgetFailure(result, /response (?:field|text)|serialized response limit/);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(1_000);
    expect(source).not.toHaveBeenCalled();
  });

  it('rejects excess document tokens before loading records or executing resolvers', async () => {
    const source = vi.fn(passive);
    const document = `{ ${'__typename '.repeat(5_000)} activeInstance { name } }`;
    expect(document.length).toBeLessThan(64_000);
    const result = await executeGraphQL(source, 'query', {document});
    expectBudgetFailure(result, /tokens.*Parsing aborted/);
    expect(source).not.toHaveBeenCalled();
  });

  it.each([
    ['{ __typename }', 1],
    ['{ __type(name: "Query") { name } }', 2],
    ['{ __schema { queryType { name } } }', 3],
  ])('counts all fields in %s', async (document, fields) => {
    const allowed = await executeGraphQL(passive, 'query', {document}, {maxFields: fields});
    expect(allowed.errors).toBeUndefined();
    const rejected = await executeGraphQL(passive, 'query', {document}, {maxFields: fields - 1});
    expectBudgetFailure(rejected, /response field limit/);
  });

  it.each([
    ['{ __typename }', 5],
    ['{ __type(name: "Query") { name } }', 5],
    ['{ __schema { queryType { name } } }', 5],
    ['{ __type(name: "Query") { kind } }', 6],
  ])('counts introspection text in %s', async (document, bytes) => {
    const allowed = await executeGraphQL(passive, 'query', {document}, {maxResponseBytes: bytes});
    expect(allowed.errors).toBeUndefined();
    const rejected = await executeGraphQL(passive, 'query', {document}, {maxResponseBytes: bytes - 1});
    expectBudgetFailure(rejected, /response text limit/);
  });

  it('shares field and UTF-8 text budgets across instance data and introspection', async () => {
    const {store} = fixture();
    const args = {document: '{ __typename activeInstance { name } }'};
    const allowed = await executeGraphQL(store, 'query', args, {maxFields: 3, maxResponseBytes: 8});
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data).toEqual({__typename: 'Query', activeInstance: {name: '☃'}});
    expectBudgetFailure(await executeGraphQL(store, 'query', args, {maxFields: 2}), /response field limit/);
    expectBudgetFailure(await executeGraphQL(store, 'query', args, {maxResponseBytes: 7}), /response text limit/);
  });

  it.each([
    {maxFields: 1},
    {maxResponseBytes: 4},
  ])('stops later root resolvers when introspection exceeds %o', async options => {
    const source = vi.fn(passive);
    const result = await executeGraphQL(source, 'query', {
      document: '{ __type(name: "Query") { name } activeInstance { name } }',
    }, options);
    expectBudgetFailure(result, /response (?:field|text) limit/);
    expect(source).not.toHaveBeenCalled();
  });

  it('propagates a budget failure through nullable fields inside a list', async () => {
    const {store} = fixture();
    const result = await executeGraphQL(store, 'query', {
      document: '{ projects { nodes { description } } __type(name: "Query") { name } }',
    }, {maxResponseBytes: 8});
    expectBudgetFailure(result, /response text limit/);
  });

  it('stops list traversal and explicit sibling resolvers at a nullable leaf failure', async () => {
    const schema = buildSchema('type Query { items: [Item] later: String } type Item { large: String later: String }');
    const large = vi.fn(() => 'over the text budget');
    const later = vi.fn(() => 'must not run');
    const fields = (schema.getType('Item') as GraphQLObjectType).getFields();
    fields.large.resolve = large;
    fields.later.resolve = later;
    schema.getQueryType()!.getFields().later.resolve = later;
    const budget = new ExecutionBudget({maxResponseBytes: 1});
    await expect(Promise.resolve().then(() => executeWithBudget({
      schema, document: parse('{ items { large later } later }'), rootValue: {items: [{}, {}]},
    }, budget))).rejects.toThrow();
    expect(String(budget.signal.reason)).toMatch(/response text limit/);
    expect(large).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
  });

  it('bounds the complete serialized response including aliases, escaping and UTF-8', async () => {
    const content = 'First line\n"quoted" \\path ☃';
    const {store, entry} = fixture(content);
    const args = {document: `{ unusually_long_response_key: entry(id: "${entry}") { content } }`};
    const expected = await executeGraphQL(store, 'query', args);
    expect(expected.errors).toBeUndefined();
    expect(expected.data?.unusually_long_response_key).toEqual({content});
    const bytes = Buffer.byteLength(JSON.stringify(expected), 'utf8');
    const allowed = await executeGraphQL(store, 'query', args, {maxSerializedResponseBytes: bytes});
    expect(allowed).toEqual(expected);
    const rejected = await executeGraphQL(store, 'query', args, {maxSerializedResponseBytes: bytes - 1});
    expectBudgetFailure(rejected, /serialized response limit/);
  });

  it.each(['{ missingField }', '{'])('bounds diagnostics on early errors for %s', async document => {
    const {store} = fixture();
    vi.spyOn(store, 'getIssues').mockReturnValue([
      {severity: 'warning', code: 'fixture', message: 'Large diagnostic '.repeat(1_000)},
    ]);
    const result = await executeGraphQL(store, 'query', {document}, {maxSerializedResponseBytes: 1_024});
    expectBudgetFailure(result, /serialized response limit/);
    expect(result.extensions?.diagnostics).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1_024);
  });

  it('returns a compact cancellation error even when instance diagnostics are oversized', async () => {
    const {store} = fixture();
    vi.spyOn(store, 'getIssues').mockReturnValue([
      {severity: 'warning', code: 'fixture', message: 'Large diagnostic '.repeat(1_000)},
    ]);
    const controller = new AbortController();
    controller.abort();
    const result = await executeGraphQL(store, 'query', {document: '{ __typename }'}, {
      signal: controller.signal, maxSerializedResponseBytes: 1_024,
    });
    expectBudgetFailure(result, /cancelled/);
    expect(result.extensions?.diagnostics).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1_024);
  });

  it('cancels introspection with an external signal and does not abort the caller on budget failure', async () => {
    const caller = new AbortController();
    const args = {document: '{ __type(name: "Query") { name } }'};
    const exceeded = await executeGraphQL(passive, 'query', args, {signal: caller.signal, maxFields: 1});
    expectBudgetFailure(exceeded, /response field limit/);
    expect(caller.signal.aborted).toBe(false);
    const allowed = await executeGraphQL(passive, 'query', args, {signal: caller.signal});
    expect(allowed.errors).toBeUndefined();
    caller.abort();
    const cancelled = await executeGraphQL(passive, 'query', args, {signal: caller.signal});
    expectBudgetFailure(cancelled, /cancelled/);
  });

  it('waits for an already-started async mutation receipt when cancelled', async () => {
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const show = vi.fn(async () => {
      started();
      await paused;
      return {url: 'http://localhost:24800', outcome: 'OPENED' as const, receipt: 'Opened'};
    });
    let settled = false;
    let serializedAtReturn: string | undefined;
    const pending = executeGraphQL(passive, 'mutation', {
      document: 'mutation { first: show { outcome } later: show { outcome } }',
    }, {signal: controller.signal, show}).then(result => {
      settled = true;
      serializedAtReturn = JSON.stringify(result);
      return result;
    });
    await running;
    try {
      controller.abort();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    const result = await pending;
    expectBudgetFailure(result, /cancelled/);
    expect(show).toHaveBeenCalledOnce();
    expect(JSON.parse(serializedAtReturn!).extensions.mutations).toEqual([
      {operation: 'show', error: null, changes: []},
    ]);
    expect(JSON.stringify(result)).toBe(serializedAtReturn);
  });

  it('settles instance creation and selection before reporting cancellation', async () => {
    const {store} = fixture();
    const path = join(store.getDataDir(), 'created');
    let started!: () => void;
    const registering = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const instances = new InstanceSession(new InstanceRegistry(), {
      knownInstances: async () => [],
      issues: async () => { started(); await paused; return []; },
    });
    const controller = new AbortController();
    const show = vi.fn();
    let settled = false;
    let serializedAtReturn: string | undefined;
    const pending = executeGraphQL(passive, 'mutation', {
      document: `mutation($path: String!) {
        createInstance(input: {path: $path, name: "Created", description: "Destination"}) { instance { path } }
        show { outcome }
      }`, variables: {path},
    }, {instances, signal: controller.signal, show}).then(result => {
      settled = true;
      serializedAtReturn = JSON.stringify(result);
      return result;
    });
    await registering;
    try {
      expect(existsSync(join(path, 'aside.md'))).toBe(true);
      controller.abort();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    const result = await pending;
    expectBudgetFailure(result, /cancelled/);
    expect(show).not.toHaveBeenCalled();
    expect(instances.registry.activeInstance).toBe(realpathSync(path));
    expect(JSON.parse(serializedAtReturn!).extensions.mutations).toEqual([
      {operation: 'createInstance', error: null, changes: expect.arrayContaining([
        expect.objectContaining({kind: 'instance', effect: 'CREATED', path: join(path, 'aside.md')}),
      ])},
    ]);
    expect(JSON.stringify(result)).toBe(serializedAtReturn);
  });

  it('keeps budget failures local while another request is awaiting search', async () => {
    const {store, action} = fixture();
    let started!: () => void;
    const searching = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined;
    const pending = executeGraphQL(store, 'query', {
      document: '{ actions(where: {search: "Review"}) { nodes { id } } }',
    }, {matcher: {match: async (_pattern, _texts, options) => {
      signal = options?.signal;
      started();
      await paused;
      return [0];
    }}});
    await searching;
    try {
      const rejected = await executeGraphQL(passive, 'query', {
        document: '{ __schema { types { name } } }',
      }, {maxFields: 3});
      expectBudgetFailure(rejected, /response field limit/);
      expect(signal?.aborted).toBe(false);
      const schema = await executeGraphQL(passive, 'query', {document: '{ __type(name: "Query") { name } }'});
      expect(schema.errors).toBeUndefined();
      expect(schema.data).toEqual({__type: {name: 'Query'}});
    } finally {
      release();
    }
    const result = await pending;
    expect(result.errors).toBeUndefined();
    expect(result.data?.actions).toEqual({nodes: [{id: action}]});
  });

  it('aborts an in-flight sibling search when the filtering work budget is exhausted', async () => {
    const {store} = fixture();
    vi.spyOn(store, 'getEntries').mockReturnValue(Array.from({length: 50_001}, (_, i) => ({
      meta: {created: formatUtcTimestamp(new Date(Date.UTC(2026, 0, 1, 0, i)))},
      content: 'Synthetic capacity probe', weekFile: '2026-01-05',
    })));
    store.rebuild();
    let searchSignal: AbortSignal | undefined;
    const match = vi.fn((_pattern: string, _texts: string[][], options?: SearchOptions) => {
      searchSignal = options?.signal;
      return new Promise<number[]>((_resolve, reject) => {
        if (searchSignal?.aborted) reject(new Error('Search cancelled'));
        else searchSignal?.addEventListener('abort', () => reject(new Error('Search cancelled')), {once: true});
      });
    });
    const result = await executeGraphQL(store, 'query', {
      document: '{ actions(where: {search: "Review"}) { nodes { id } } entries { nodes { id } } }',
    }, {matcher: {match}});
    expectBudgetFailure(result, /work limit/);
    expect(match).toHaveBeenCalledOnce();
    expect(searchSignal?.aborted).toBe(true);
  });

  it('aborts the operation when filter nesting exceeds its execution budget', async () => {
    const {store} = fixture();
    let where: Record<string, unknown> = {};
    for (let i = 0; i < 13; i++) where = {not: where};
    const result = await executeGraphQL(store, 'query', {
      document: 'query($where: ActionWhere) { actions(where: $where) { nodes { id } } __typename }',
      variables: {where},
    });
    expectBudgetFailure(result, /filter nesting/);
  });
});
