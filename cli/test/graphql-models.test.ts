import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildSchema, getIntrospectionQuery, printSchema } from 'graphql';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { executeGraphQL, readGraphQLSchema } from '../src/graphql/schema.js';
import { catalogFor, type ModelOption } from '../src/automation/models.js';
import { InstanceHost, READ_TOOLS } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';
import { registerGraphQLResources } from '../src/mcp/resources.js';
import { parseManifest } from '../src/core/parser.js';
import { createArtifact } from '../src/mcp/tools/artifact.js';

vi.mock('../src/automation/models.js', async importOriginal => ({...await importOriginal<typeof import('../src/automation/models.js')>(), catalogFor: vi.fn()}));
vi.mock('graphql', async importOriginal => {
  const actual = await importOriginal<typeof import('graphql')>();
  return {...actual, printSchema: vi.fn(actual.printSchema)};
});

describe('instance model catalog in GraphQL', () => {
  let root: string;
  let store: Store;
  let revision: number;
  let models: ModelOption[];
  let diagnostics: string[];
  let promptArtifactId: string;
  const mutate = vi.fn((_name: string, _args: Record<string, unknown>) => ({text: 'Updated'}));
  const graph = (document: string, variables?: Record<string, unknown>, mode: 'query' | 'mutation' = 'query') => executeGraphQL(store, mode, {document, variables}, {mutate});
  const builtin = {name: 'CLAUDE_SONNET', label: 'Claude Sonnet', builtin: true, engine: 'claude', model: 'sonnet', availability: 'AVAILABLE'} as const;
  const external = {name: 'digest', label: 'digest', builtin: false, availability: 'AVAILABLE'} as const;
  const jobs = (model: string) => [{name: 'digest', schedule: {cron: '0 8 * * *'}, run: {model, prompt: {existingId: promptArtifactId}}}];

  function seedPrompt(targetStore: Store): string {
    return createArtifact(targetStore, {name: 'Instructions', description: 'Instructions', body: 'Prepare this project digest.'}, new Date(2026, 9, 8, 12)).id;
  }

  function cachedCatalog() {
    let fingerprint = revision;
    let cached = {models: structuredClone(models), diagnostics: [...diagnostics], revision: JSON.stringify(models)};
    vi.mocked(catalogFor).mockImplementation(async (_root, options) => {
      if (options?.refresh || fingerprint !== revision) {
        fingerprint = revision;
        cached = {models: structuredClone(models), diagnostics: [...diagnostics], revision: JSON.stringify(models)};
      }
      return structuredClone(cached);
    });
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync('/tmp/aside-graphql-models-'));
    init(root, {name: 'Catalog fixture', description: 'Model options'});
    store = new Store(root);
    promptArtifactId = seedPrompt(store);
    revision = 0; models = [builtin, external]; diagnostics = [];
    mutate.mockClear(); vi.mocked(printSchema).mockClear();
    vi.mocked(catalogFor).mockReset().mockImplementation(async () => ({models, diagnostics, revision: String(revision)}));
  });
  afterEach(() => { store.close(); vi.restoreAllMocks(); rmSync(root, {recursive: true, force: true}); });

  it('keeps the full schema and model input types static without discovering vendors', async () => {
    const first = await graph(getIntrospectionQuery({oneOf: true}));
    expect(first.errors).toBeUndefined();
    expect((first.data?.__schema as any).types.some((type: any) => type.name === 'Model')).toBe(false);
    const input = await graph('{ __type(name: "AutomationRunInput") { inputFields { name type { name } } } }');
    expect(input.errors).toBeUndefined();
    expect((input.data?.__type as any).inputFields).toContainEqual({name: 'model', type: {name: 'String'}});
    models = []; revision++;
    expect((await graph(getIntrospectionQuery({oneOf: true}))).data).toEqual(first.data);
    expect(catalogFor).not.toHaveBeenCalled();
  });

  it('exposes built-in and named choices under the owning instance execution scope', async () => {
    const result = await graph('{ activeInstance { execution { models { name label builtin engine model availability reason } } } }');
    expect(result.errors).toBeUndefined();
    expect((result.data?.activeInstance as any).execution.models).toEqual([
      {...builtin, reason: null}, {...external, engine: null, model: null, reason: null},
    ]);
    expect(catalogFor).toHaveBeenCalledWith(root, {refresh: false, signal: expect.any(AbortSignal)});
  });

  it('uses cached choices until explicit refresh or local execution revision changes', async () => {
    cachedCatalog();
    const choices = async (refresh = false) => {
      const result = await graph('query($refresh: Boolean!) { activeInstance { execution { models(refresh: $refresh) { name } } } }', {refresh});
      expect(result.errors).toBeUndefined();
      return (result.data?.activeInstance as any).execution.models.map((model: any) => model.name);
    };
    expect(await choices()).toEqual([builtin.name, external.name]);
    models = [{...external, name: 'remote_new_choice'}];
    expect(await choices()).toEqual([builtin.name, external.name]);
    expect(await choices(true)).toEqual(['remote_new_choice']);
    models = []; revision++;
    expect(await choices()).toEqual([]);
  });

  it('serves one static resource SDL across instances and model catalog changes without discovery', async () => {
    const server = new McpServer({name: 'live-schema-test', version: '1'});
    registerGraphQLResources(server, () => readGraphQLSchema(root));
    const client = new Client({name: 'live-schema-client', version: '1'});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const read = async () => (await client.readResource({uri: 'aside://graphql/schema'})).contents[0] as {text: string};
      const first = (await read()).text;
      expect(buildSchema(first).getType('Model')).toBeUndefined();
      models = []; revision++;
      expect((await read()).text).toBe(first);
      expect((await readGraphQLSchema(null)).sdl).toBe(first);
      expect((await readGraphQLSchema(join(root, 'other'))).sdl).toBe(first);
      expect(catalogFor).not.toHaveBeenCalled();
      expect(vi.mocked(printSchema).mock.calls.length).toBeLessThanOrEqual(1);
    } finally {await client.close(); await server.close();}
  });

  it('keeps schema discovery available while model discovery fails and forwards cancellation only to model reads', async () => {
    vi.mocked(catalogFor).mockRejectedValue(new Error('Execution config unavailable'));
    const resource = await readGraphQLSchema(root);
    expect(buildSchema(resource.sdl).getType('Execution')).toBeDefined();
    expect(catalogFor).not.toHaveBeenCalled();
    const controller = new AbortController();
    const result = await executeGraphQL(store, 'query', {document: '{ activeInstance { execution { models { name } } } }'}, {signal: controller.signal});
    expect(result.errors?.[0]).toMatchObject({message: expect.stringContaining('Execution config unavailable')});
    expect(catalogFor).toHaveBeenCalledWith(root, {refresh: false, signal: expect.any(AbortSignal)});
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let downstream: AbortSignal | undefined;
    vi.mocked(catalogFor).mockImplementation(async (_path, options) => {
      downstream = options?.signal;
      started();
      await paused;
      return {models, diagnostics, revision: String(revision)};
    });
    const pending = executeGraphQL(store, 'query', {document: '{ activeInstance { execution { models { name } } } }'}, {signal: controller.signal});
    await reading;
    try {
      expect(downstream).toBeInstanceOf(AbortSignal);
      expect(downstream?.aborted).toBe(false);
      controller.abort();
      expect(downstream?.aborted).toBe(true);
    } finally {
      release();
    }
    const cancelled = await pending;
    expect(cancelled.errors?.[0]).toMatchObject({message: expect.stringContaining('cancelled')});
    expect(cancelled.data).toBeUndefined();
  });

  it('keeps introspection valid without an active instance or vendor discovery', async () => {
    const source = vi.fn(() => {throw new Error('No instance selected');});
    const result = await executeGraphQL(source, 'query', {document: '{ __schema { queryType { name } mutationType { name } } }'});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({__schema: {queryType: {name: 'Query'}, mutationType: {name: 'Mutation'}}});
    expect(source).not.toHaveBeenCalled(); expect(catalogFor).not.toHaveBeenCalled();
  });

  it.each(['target_digest', 'source_only'])('validates automation model %s against a preceding selection target', async choice => {
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    const target = join(root, 'target');
    init(target, {name: 'Target', description: 'Different model configuration'});
    const targetStore = new Store(target);
    let targetPrompt: string;
    try {targetPrompt = seedPrompt(targetStore);} finally {targetStore.close();}
    const before = readFileSync(join(target, 'aside.md'), 'utf8');
    const sourceModel: ModelOption = {...external, name: 'source_only'};
    const targetModel: ModelOption = {...external, name: 'target_digest'};
    vi.mocked(catalogFor).mockImplementation(async path => ({
      models: path === target ? [targetModel] : [sourceModel], diagnostics: [], revision: path,
    }));
    const host = new InstanceHost(new CalClient(null));
    const registry = new InstanceRegistry([root, target]); registry.activate(root);
    const session = new InstanceSession(registry, {
      knownInstances: async () => [root, target], issues: async path => host.issues(path),
    }, [], false, true);
    try {
      const result = await host.graphql(session, 'mutation', {
        document: `mutation($target: String!, $choice: String!, $prompt: ID!) {
          selectInstance(path: $target) { instance { path } }
          updateInstance(input: {automations: {set: [{name: "digest", schedule: {cron: "0 8 * * *"}, run: {model: $choice, prompt: {existingId: $prompt}}}]}}) {
            instance { path }
          }
        }`, variables: {target, choice, prompt: targetPrompt!},
      });
      if (choice === targetModel.name) {
        expect(result.errors).toBeUndefined();
        expect(result.data?.updateInstance).toEqual({instance: {path: target}});
        expect(parseManifest(readFileSync(join(target, 'aside.md'), 'utf8')).value.automations).toEqual({
          digest: {schedule: {cron: '0 8 * * *'}, run: {model: choice, prompt: `#artifact/${targetPrompt!}`}},
        });
        expect(readFileSync(join(target, 'aside.md'), 'utf8')).toContain('model: target_digest');
      } else {
        expect(result.errors).toBeDefined();
        expect(readFileSync(join(target, 'aside.md'), 'utf8')).toBe(before);
      }
      expect(catalogFor).toHaveBeenCalledWith(target, {signal: expect.any(AbortSignal)});
      expect(readFileSync(join(root, 'aside.md'), 'utf8')).not.toContain('automations:');
    } finally { await host.close(); }
  });

  it('uses GraphQL merged root-field order when a fragment repeats an earlier instance selection', async () => {
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    const b = join(root, 'b'), c = join(root, 'c');
    init(b, {name: 'B', description: 'First destination'});
    init(c, {name: 'C', description: 'Final destination'});
    const targetStore = new Store(c);
    let targetPrompt: string;
    try {targetPrompt = seedPrompt(targetStore);} finally {targetStore.close();}
    const beforeB = readFileSync(join(b, 'aside.md'), 'utf8');
    vi.mocked(catalogFor).mockImplementation(async path => ({
      models: [{...external, name: path === c ? 'model_c' : 'model_b'}], diagnostics: [], revision: path,
    }));
    const host = new InstanceHost(new CalClient(null));
    const registry = new InstanceRegistry([root, b, c]); registry.activate(root);
    const session = new InstanceSession(registry, {
      knownInstances: async () => [root, b, c], issues: async path => host.issues(path),
    }, [], false, true);
    try {
      const result = await host.graphql(session, 'mutation', {
        document: `mutation($b: String!, $c: String!, $prompt: ID!) {
          first: selectInstance(path: $b) { instance { path } }
          second: selectInstance(path: $c) { instance { path } }
          ...RepeatedSelection
        }
        fragment RepeatedSelection on Mutation {
          first: selectInstance(path: $b) { error }
          updateInstance(input: {automations: {set: [{name: "digest", schedule: {cron: "0 8 * * *"}, run: {model: "model_c", prompt: {existingId: $prompt}}}]}}) {
            instance { path }
          }
        }`, variables: {b, c, prompt: targetPrompt!},
      });
      expect(result.errors).toBeUndefined();
      expect(result.data?.updateInstance).toMatchObject({instance: {path: c}});
      expect(parseManifest(readFileSync(join(c, 'aside.md'), 'utf8')).value.automations)
        .toMatchObject({digest: {run: {model: 'model_c'}}});
      expect((result.extensions?.mutations as any[]).map(value => value.operation)).toEqual(['selectInstance', 'selectInstance', 'updateInstance']);
      expect(registry.activeInstance).toBe(c);
      expect(readFileSync(join(b, 'aside.md'), 'utf8')).toBe(beforeB);
      expect(readFileSync(join(c, 'aside.md'), 'utf8')).toContain('model: model_c');
    } finally { await host.close(); }
  });

  it('exposes the same discovery choices to default entity-tool clients', async () => {
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    diagnostics = ['Named model unavailable'];
    const host = new InstanceHost(new CalClient(null));
    try {
      const result = await host.tool(root, 'query_models', {refresh: true});
      expect(JSON.parse(result.text)).toEqual({models, diagnostics});
      expect(catalogFor).toHaveBeenCalledWith(root, {refresh: true, signal: undefined});
      expect(READ_TOOLS.has('query_models')).toBe(true);
      await expect(host.tool(root, 'query_models', {refresh: 'yes'})).rejects.toThrow();
    } finally { await host.close(); }
  });

  it('validates string model selections in variable and literal authoring inputs', async () => {
    const document = 'mutation($jobs: [CreateAutomationInput!]!) { updateInstance(input: {automations: {set: $jobs}}) { error } }';
    const result = await graph(document, {jobs: jobs(builtin.name)}, 'mutation');
    expect(result.errors).toBeUndefined();
    expect(mutate).toHaveBeenCalledWith('update_instance', {automations: {digest: {schedule: {cron: '0 8 * * *'}, run: {model: builtin.name, prompt: `#artifact/${promptArtifactId}`}}}});
    mutate.mockClear();
    const inline = await graph(`mutation { updateInstance(input: {automations: {set: [{name: "digest", schedule: {at: "2099-01-01T08:00:00Z"}, run: {model: "digest", prompt: {existingId: "${promptArtifactId}"}}, overlap: SKIP}]}}) { error } }`, undefined, 'mutation');
    expect(inline.errors).toBeUndefined();
    expect(mutate.mock.calls[0][1]).toMatchObject({automations: {digest: {run: {model: 'digest', prompt: `#artifact/${promptArtifactId}`}, overlap: 'skip'}}});
  });

  it('accepts a nested artifact variable and validates its value before any write', async () => {
    const document = `mutation($artifactId: ID!) {
      first: updateInstance(input: {settings: {recurrenceLookaheadDays: 10}}) { error }
      second: updateInstance(input: {automations: {set: [{name: "digest", schedule: {cron: "0 8 * * *"}, run: {model: "CLAUDE_SONNET", prompt: {existingId: $artifactId}}}]}}) { error }
    }`;
    const result = await graph(document, {artifactId: promptArtifactId}, 'mutation');
    expect(result.errors).toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenLastCalledWith('update_instance', {automations: {digest: {schedule: {cron: '0 8 * * *'}, run: {model: builtin.name, prompt: `#artifact/${promptArtifactId}`}}}});
    for (const artifactId of ['', '   ', '\0']) {
      mutate.mockClear();
      const invalid = await graph(document, {artifactId}, 'mutation');
      expect(invalid.errors?.[0]).toMatchObject({message: expect.stringContaining('Invalid artifact id')});
      expect(mutate).not.toHaveBeenCalled();
    }
  });

  it('keeps unavailable saved model selections readable as strings', async () => {
    store.getInstance()!.manifest.automations = {old: {schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: builtin.name, prompt: '#artifact/2026-10-08-missing-instructions'}}};
    models = [external]; revision++;
    const read = await graph('{ activeInstance { automations { nodes { name run { model } } } } }');
    expect(read.errors).toBeUndefined();
    expect((read.data?.activeInstance as any).automations.nodes).toEqual([{name: 'old', run: {model: builtin.name}}]);
    expect(read.extensions).toMatchObject({complete: true, diagnostics: []});
    expect(catalogFor).not.toHaveBeenCalled();
    const withPrompt = await graph('{ activeInstance { automations { nodes { name run { model prompt { id } } } } } }');
    expect(withPrompt.errors).toBeUndefined();
    expect((withPrompt.data?.activeInstance as any).automations.nodes).toEqual([{name: 'old', run: {model: builtin.name, prompt: null}}]);
    expect(withPrompt.extensions).toMatchObject({complete: false, diagnostics: expect.arrayContaining([expect.objectContaining({code: 'automation_prompt'})])});
    expect(store.getInstance()!.manifest.automations).toEqual({old: {schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: builtin.name, prompt: '#artifact/2026-10-08-missing-instructions'}}});
    expect(catalogFor).not.toHaveBeenCalled();
    const rejected = await graph('mutation($jobs: [CreateAutomationInput!]!) { updateInstance(input: {automations: {set: $jobs}}) { error } }', {jobs: jobs(builtin.name)}, 'mutation');
    expect(rejected.errors?.[0]).toMatchObject({message: expect.stringContaining('not selectable')});
    expect(mutate).not.toHaveBeenCalled();
  });

  it('supports script authoring with no available model choices and preserves malformed declarations for repair', async () => {
    models = [];
    store.getInstance()!.manifest.automations = {bad: {run: {model: 'missing'}}};
    const result = await graph('{ activeInstance { execution { models { name } } automations { nodes { name schedule { at } run { model } } } } }');
    expect(result.errors).toBeUndefined();
    expect((result.data?.activeInstance as any).execution.models).toEqual([]);
    expect((result.data?.activeInstance as any).automations.nodes).toEqual([{name: 'bad', schedule: null, run: null}]);
    expect(result.extensions).toMatchObject({complete: false, diagnostics: expect.arrayContaining([expect.objectContaining({code: 'invalid_automation'})])});
    const script = await graph('mutation { updateInstance(input: {automations: {set: [{name: "script", schedule: {cron: "0 8 * * *"}, run: {script: "echo", args: ["hello"]}}]}}) { error } }', undefined, 'mutation');
    expect(script.errors).toBeUndefined();
    const rejected = await graph(`mutation { updateInstance(input: {automations: {set: [{name: "model", schedule: {cron: "0 8 * * *"}, run: {model: "missing", prompt: {existingId: "${promptArtifactId}"}}}]}}) { error } }`, undefined, 'mutation');
    expect(rejected.errors?.[0]).toMatchObject({message: expect.stringContaining('not selectable')});
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('does not discover vendors for ordinary queries or script-only automation writes', async () => {
    await graph('{ activeInstance { id } }');
    await graph('mutation { updateInstance(input: {settings: {recurrenceLookaheadDays: 10}}) { error } }', undefined, 'mutation');
    await graph('mutation { updateInstance(input: {automations: {set: [{name: "script", schedule: {at: "2099-01-01T00:00:00Z"}, run: {script: "echo"}}]}}) { error } }', undefined, 'mutation');
    const unselected = await executeGraphQL(store, 'query', {
      document: 'query Records { activeInstance { id } } query Choices { activeInstance { execution { models { name } } } __schema { types { name } } __type(name: "Mutation") { name } }',
      operationName: 'Records', variables: {ignored: {model: 'unused'}},
    });
    expect(unselected.errors).toBeUndefined();
    expect(catalogFor).not.toHaveBeenCalled();
  });

  it('does not discover or refresh for skipped catalog fields or their ancestors', async () => {
    const result = await graph(`query($skip: Boolean = true, $include: Boolean = false) {
      activeInstance { id }
      activeInstance @skip(if: $skip) { execution { models(refresh: true) { name } } }
      ...Catalog @include(if: $include)
      ... @skip(if: true) { __schema { types { name } } }
    }
    fragment Catalog on Query {
      activeInstance { execution { models(refresh: true) { name } } }
    }`);
    expect(result.errors).toBeUndefined();
    expect(catalogFor).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rejects a selected operation with the wrong tool mode before discovery', async () => {
    const query = await graph('{ activeInstance { execution { models(refresh: true) { name } } } }', undefined, 'mutation');
    expect(query.errors?.[0]).toMatchObject({message: 'This tool accepts only mutation operations.'});
    const mutation = await graph(`mutation { updateInstance(input: {automations: {set: [{name: "digest", schedule: {cron: "0 8 * * *"}, run: {model: "CLAUDE_SONNET", prompt: {existingId: "${promptArtifactId}"}}}]}}) { error } }`);
    expect(mutation.errors?.[0]).toMatchObject({message: 'This tool accepts only query operations.'});
    expect(catalogFor).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('does not discover models for unselected operations, even when they author model names', async () => {
    const result = await executeGraphQL(store, 'query', {
      document: `query Records { activeInstance { id } }
        mutation Work($choice: String!) { updateInstance(input: {automations: {set: [{name: "digest", schedule: {cron: "0 8 * * *"}, run: {model: $choice, prompt: {existingId: "${promptArtifactId}"}}}]}}) { error } }
        query Choices { activeInstance { execution { models(refresh: true) { name } } } }`,
      operationName: 'Records',
    }, {mutate});
    expect(result.errors).toBeUndefined();
    expect(catalogFor).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('refreshes on explicit request and reports discovery diagnostics independently of data', async () => {
    diagnostics = ['Codex discovery failed; using the previous catalog.'];
    models = [{...builtin, availability: 'UNKNOWN', reason: diagnostics[0]}];
    const result = await graph('query($refresh: Boolean!) { activeInstance { execution { models(refresh: $refresh) { name availability reason } } } }', {refresh: true});
    expect(result.errors).toBeUndefined();
    expect(catalogFor).toHaveBeenCalledWith(root, {refresh: true, signal: expect.any(AbortSignal)});
    expect(result.extensions).toMatchObject({complete: false, diagnostics: expect.arrayContaining([
      expect.objectContaining({code: 'model_discovery', message: diagnostics[0]}),
    ])});
    expect((result.extensions?.diagnostics as any[]).filter(issue => issue.code === 'model_discovery' && issue.message === diagnostics[0])).toHaveLength(1);
    vi.mocked(catalogFor).mockClear();
    await graph('query($refresh: Boolean = true) { activeInstance { execution { models(refresh: $refresh) { name } } } }');
    expect(catalogFor).toHaveBeenCalledWith(root, {refresh: true, signal: expect.any(AbortSignal)});
  });

  it('validates all schedules and duplicate names before any mutation executes', async () => {
    const document = 'mutation($jobs: [CreateAutomationInput!]!) { first: updateInstance(input: {settings: {recurrenceLookaheadDays: 10}}) { error } second: updateInstance(input: {automations: {set: $jobs}}) { error } }';
    const invalid = await graph(document, {jobs: [{name: 'bad', schedule: {cron: 'bad'}, run: {script: 'echo'}}]}, 'mutation');
    expect(invalid.errors?.[0]).toMatchObject({message: expect.stringContaining('automations.bad')});
    expect(mutate).not.toHaveBeenCalled();
    const duplicate = await graph(document, {jobs: [jobs(external.name)[0], jobs(external.name)[0]]}, 'mutation');
    expect(duplicate.errors?.[0]).toMatchObject({message: expect.stringContaining('Duplicate automation name')});
    expect(mutate).not.toHaveBeenCalled();
  });

  it('preflights declarations nested in new projects and preserves omit/null/empty semantics', async () => {
    const bad = await graph('mutation { first: updateInstance(input: {}) { error } second: capture(input: {content: "Setup", description: "Setup", projects: [{create: {name: "New", description: "New", automations: [{name: "bad", schedule: {at: "invalid"}, run: {script: "echo"}}]}}]}) { error } }', undefined, 'mutation');
    expect(bad.errors?.[0]).toMatchObject({message: expect.stringContaining('automations.bad')});
    expect(mutate).not.toHaveBeenCalled();
    for (const [input, expected] of [['{}', {}], ['{automations: null}', {}], ['{automations: {set: []}}', {automations: {}}]] as const) {
      const result = await graph(`mutation { updateInstance(input: ${input}) { error } }`, undefined, 'mutation');
      expect(result.errors).toBeUndefined();
      expect(mutate).toHaveBeenLastCalledWith('update_instance', expected);
    }
  });

  it('preflights only roots selected by skip/include directives, including fragments', async () => {
    const result = await graph(`mutation($skip: Boolean!, $include: Boolean!) {
      updateInstance(input: {settings: {recurrenceLookaheadDays: 10}}) { error }
      skipped: updateInstance(input: {automations: {set: [{name: "bad", schedule: {cron: "bad"}, run: {script: "echo"}}]}}) @skip(if: $skip) { error }
      ...Conditional @include(if: $include)
    }
    fragment Conditional on Mutation {
      conditional: updateInstance(input: {automations: {set: [{name: "bad", schedule: {at: "invalid"}, run: {script: "echo"}}]}}) { error }
    }`, {skip: true, include: false}, 'mutation');
    expect(result.errors).toBeUndefined();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith('update_instance', {recurrenceLookaheadDays: 10});
  });
});
