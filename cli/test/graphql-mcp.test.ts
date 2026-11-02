import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { init } from '../src/commands/init.js';
import { buildClientSchema, buildSchema, getIntrospectionQuery, printSchema } from 'graphql';
import { GRAPHQL_SERVER_INSTRUCTIONS } from '../src/mcp/resources.js';

const bundle = join(__dirname, '..', 'dist', 'main.js');
describe.skipIf(!existsSync(bundle))('bundled MCP GraphQL mode', () => {
  let dir: string;
  let legacy: Client;
  let graph: Client;
  let cold: Client;
  let workspace: string;
  let daemonDirectory: string;
  let env: Record<string, string>;
  const read = async (name: string, document: string, variables?: Record<string, unknown>) => {
    const reply = await graph.callTool({ name, arguments: { document, variables } });
    const block = (reply.content as any[]).find(item => item.type === 'text');
    const result = JSON.parse(block.text);
    expect(reply.structuredContent).toEqual(result);
    return { ...result, isError: reply.isError };
  };

  beforeAll(async () => {
    // A private daemon and empty executable path keep schema discovery stable
    // and prevent this transport test from probing installed vendor runtimes.
    daemonDirectory = mkdtempSync('/tmp/aside-gql-daemon-');
    const emptyBin = join(daemonDirectory, 'bin');
    mkdirSync(emptyBin);
    env = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      PATH: emptyBin,
      ASIDE_DAEMON_HOME: daemonDirectory,
      ASIDE_CAL_BIN: '/nonexistent/aside-cal',
    };
    dir = mkdtempSync('/tmp/aside-graphql-mcp-');
    init(dir, { name: 'MCP GraphQL', description: 'Transport integration' });
    workspace = mkdtempSync('/tmp/aside-graphql-workspace-');
    writeFileSync(join(workspace, '.aside'), 'discovery: false\n');
    legacy = new Client({ name: 'legacy-test', version: '1' });
    graph = new Client({ name: 'graphql-test', version: '1' });
    await legacy.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, 'mcp', '--legacy', '--dir', dir], cwd: workspace, env }));
    await graph.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, 'mcp', '--dir', dir], cwd: workspace, env }));
    cold = new Client({ name: 'cold-graphql-test', version: '1' });
    await cold.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, 'mcp'], cwd: workspace, env }));
  }, 20_000);

  afterAll(async () => {
    try {
      await Promise.all([legacy?.close(), graph?.close(), cold?.close()]);
    } finally {
      try {
        if (env) execFileSync(process.execPath, [bundle, 'daemon', 'stop', '--force'], { env, stdio: 'pipe', timeout: 20_000 });
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
        if (workspace) rmSync(workspace, { recursive: true, force: true });
        if (daemonDirectory) rmSync(daemonDirectory, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it('defaults to only GraphQL tools and exposes the legacy surface only on request', async () => {
    const legacyTools = (await legacy.listTools()).tools.map(tool => tool.name);
    expect(legacyTools).toEqual([
      'select_instance', 'create_instance', 'list_instances',
      'query_models', 'query_instance', 'update_instance',
      'query_entries', 'planning_actions', 'update_occurrence', 'query_actions', 'query_projects', 'query_artifacts',
      'create_artifact', 'update_artifact', 'capture', 'update_action', 'update_project', 'update_entry',
      'validate', 'show', 'calendar_info',
    ]);
    expect((await graph.listTools()).tools.map(tool => tool.name)).toEqual([
      'query', 'mutate',
    ]);
    expect((await graph.listTools()).tools.find(tool => tool.name === 'query')!.annotations?.readOnlyHint).toBe(true);
    for (const tool of (await graph.listTools()).tools) {
      expect(tool.description).toContain('aside://graphql/schema');
      expect(tool.inputSchema.properties).toHaveProperty('document');
    }
  });

  it('discovers guides without selection and serves the same live schema as query introspection', async () => {
    expect(graph.getInstructions()).toBe(GRAPHQL_SERVER_INSTRUCTIONS);
    expect(legacy.getInstructions()).toBeUndefined();
    expect(legacy.getServerCapabilities()?.resources).toBeUndefined();
    const resources = (await cold.listResources()).resources;
    expect(resources.map(resource => resource.uri)).toEqual([
      'aside://docs/records', 'aside://docs/planning', 'aside://docs/automate',
      'aside://docs/setup', 'aside://docs/about', 'aside://graphql/schema',
    ]);
    for (const resource of resources.filter(resource => resource.mimeType === 'text/markdown')) {
      const reply = await cold.readResource({uri: resource.uri});
      expect(reply.contents[0]).toMatchObject({uri: resource.uri, mimeType: 'text/markdown'});
      expect((reply.contents[0] as any).text.length).toBeGreaterThan(0);
      if (resource.uri === 'aside://docs/records') {
        const text = (reply.contents[0] as any).text;
        for (const guidance of ['showUrl(input:', 'default browser', 'file://', 'owner-only Unix permissions',
          'automatically installs valid browser authorization', 'redirects to the requested view']) expect(text).toContain(guidance);
      }
    }
    for (const client of [cold, graph]) {
      const reply = await client.readResource({uri: 'aside://graphql/schema'});
      const schema = buildSchema((reply.contents[0] as any).text);
      const query = await client.callTool({name: 'query', arguments: {
        document: getIntrospectionQuery({schemaDescription: true, specifiedByUrl: true, directiveIsRepeatable: true, inputValueDeprecation: true, oneOf: true}),
      }});
      expect(query.isError).toBe(false);
      const live = buildClientSchema((query.structuredContent as any).data);
      expect(printSchema(schema)).toBe(printSchema(live));
    }
  });

  it('keeps schema resources static while the owning instance model catalog changes', async () => {
    const config = join(dir, '.aside');
    const original = existsSync(config) ? readFileSync(config, 'utf8') : undefined;
    const executable = join(env.PATH, 'fixture-model');
    // Discovery checks the executable but never launches this named model.
    writeFileSync(executable, `#!${process.execPath}\nprocess.exit(0);\n`, {mode: 0o755});
    const readSchema = async () => {
      const result = await graph.readResource({uri: 'aside://graphql/schema'});
      return (result.contents[0] as {text: string}).text;
    };
    try {
      const originalSchema = await readSchema();
      expect(buildSchema(originalSchema).getType('Model')).toBeUndefined();
      for (const name of ['first_fixture_model', 'changed_fixture_model']) {
        writeFileSync(config, JSON.stringify({execution: {models: {[name]: {command: executable}}}}));
        const sdl = await readSchema();
        expect(sdl).toBe(originalSchema);
        const introspection = await read('query', '{ __type(name: "AutomationRunInput") { inputFields { name type { name } } } activeInstance { execution { models { name } } } }');
        expect(introspection.isError).toBe(false);
        expect(introspection.data.__type.inputFields).toContainEqual({name: 'model', type: {name: 'String'}});
        expect(introspection.data.activeInstance.execution.models).toEqual([{name}]);
      }
    } finally {
      if (original === undefined) rmSync(config, {force: true});
      else writeFileSync(config, original);
      rmSync(executable, {force: true});
    }
    expect(buildSchema(await readSchema()).getType('Model')).toBeUndefined();
  });

  it('executes GraphQL through the daemon and exposes the same writes to a legacy client', async () => {
    const result = await read('mutate', `mutation {
      capture(input: {content: "Connected context", description: "Kickoff",
        projects: [{create: {name: "GraphQL project", description: "Project"}}],
        actions: [{create: {name: "GraphQL action", description: "Action"}}]
      }) { entry { id } createdProjects { id } createdActions { id } }
    }`);
    expect(result.isError).toBe(false);
    const action = result.data.capture.createdActions[0].id;
    const project = result.data.capture.createdProjects[0].id;
    const context = await read('query', `query($id: ID!) {
      project(id: $id) { id actions { nodes { id entries { nodes { content } } } } }
    }`, { id: project });
    expect(context.data.project.actions.nodes[0]).toEqual({ id: action, entries: { nodes: [{ content: 'Connected context' }] } });
    const oldQuery = await legacy.callTool({ name: 'query_actions', arguments: { ids: [action], detail: 'metadata' } });
    expect(JSON.stringify(oldQuery.content)).toContain(action);
    expect(readFileSync(join(dir, 'actions', action.slice(0, 4), `${action}.md`), 'utf8')).toContain('name: GraphQL action');
    const rejected = await read('query', `mutation { updateAction(id: "${action}", input: {status: DONE}) { action { id } } }`);
    expect(rejected.isError).toBe(true);
    expect(readFileSync(join(dir, 'actions', action.slice(0, 4), `${action}.md`), 'utf8')).not.toContain('resolution:');
  });

  it('returns schema discovery and GraphQL validation errors as structured MCP results', async () => {
    const schema = await read('query', '{ __type(name: "ProjectWhere") { inputFields { name } } }');
    expect(schema.isError).toBe(false);
    expect(schema.data.__type.inputFields.map((field: any) => field.name)).toContain('actions');
    const invalid = await read('query', '{ nonexistent }');
    expect(invalid.isError).toBe(true);
    expect(invalid.errors[0].message).toContain('Cannot query field');
  });

  it('exposes reciprocal project relations and typed direct links over MCP', async () => {
    const created = await read('mutate', `mutation {
      capture(input: {content: "Relationship context", description: "Relationships",
        projects: [{create: {name: "Link overview", description: "Overview"}}, {create: {name: "Link detail", description: "Detail"}}]
      }) { entry { id } createdProjects { id } }
    }`);
    expect(created.isError).toBe(false);
    const [overview, detail] = created.data.capture.createdProjects.map((project: {id: string}) => project.id);
    const entry = created.data.capture.entry.id;
    const updated = await read('mutate', `mutation {
      outgoing: updateProject(id: "${overview}", input: {relatedProjects: {upsert: [{project: "${detail}", description: "Discover detail"}]}}) { project { id } }
      incoming: updateProject(id: "${detail}", input: {relatedProjects: {upsert: [{project: "${overview}", description: "Discover overview"}]}}) { project { id } }
      updateEntry(id: "${entry}", input: {content: "#project/${overview}"}) { entry { id } }
    }`);
    expect(updated.isError).toBe(false);
    const linked = await read('query', `{
      project(id: "${overview}") {
        relatedProjects { count totalCount nodes { project { id } direction outgoingDescription incomingDescription } }
        backlinks { count nodes { __typename ... on Entry { id } } }
      }
      entry(id: "${entry}") { links { count totalCount nodes { __typename ... on Project { id } } } }
    }`);
    expect(linked.isError).toBe(false);
    expect(linked.data.project.relatedProjects).toEqual({count: 1, totalCount: 1, nodes: [{project: {id: detail}, direction: 'BIDIRECTIONAL', outgoingDescription: 'Discover detail', incomingDescription: 'Discover overview'}]});
    expect(linked.data.project.backlinks).toEqual({count: 1, nodes: [{__typename: 'Entry', id: entry}]});
    expect(linked.data.entry.links).toEqual({count: 1, totalCount: 1, nodes: [{__typename: 'Project', id: overview}]});
  });

  it('exposes validation, calendar information, and navigation through GraphQL over MCP', async () => {
    const validation = await read('query', '{ activeInstance { path validation { passed dataChecksRun checks { name passed details } } } }');
    expect(validation.isError).toBe(false);
    expect(validation.data.activeInstance.validation).toMatchObject({ passed: true, dataChecksRun: true });
    expect(validation.data.activeInstance.validation.checks.length).toBeGreaterThan(1);
    const reply = await cold.callTool({ name: 'mutate', arguments: { document: 'mutation { calendarInfo { error authorization calendars { name } diagnostics { category recovery } syncStates { id status } } }' } });
    const calendar = reply.structuredContent as any;
    expect(reply.isError).toBe(true);
    expect(calendar.data.calendarInfo).toMatchObject({ authorization: 'UNAVAILABLE', calendars: null, syncStates: [] });
    expect(calendar.data.calendarInfo.error).toMatch(/helper/i);
    expect(calendar.extensions.mutations[0].operation).toBe('calendarInfo');
    const invalidShow = await read('mutate', 'mutation { show(input: {detail: true}) { url outcome } }');
    expect(invalidShow.isError).toBe(true);
    expect(invalidShow.errors[0].message).toContain('pass project or action');
    const mutationType = await read('query', '{ __type(name: "Mutation") { fields { name } } }');
    expect(mutationType.data.__type.fields.map((field: any) => field.name)).toEqual(expect.arrayContaining(['show', 'showUrl', 'calendarInfo']));
  });

  it('discovers and manages instances with no selection, preserving independent sessions and mutation order', async () => {
    const call = async (name: string, document: string, variables?: Record<string, unknown>) => {
      const reply = await cold.callTool({ name, arguments: { document, variables } });
      const result = JSON.parse((reply.content as any[]).find(item => item.type === 'text').text);
      expect(reply.structuredContent).toEqual(result);
      return { ...result, isError: reply.isError };
    };
    const schema = await call('query', '{ __schema { queryType { fields { name } } mutationType { fields { name } } } activeInstance { path } instances { id name path active workspace } }');
    expect(schema.isError).toBe(false);
    expect(schema.data.activeInstance).toBeNull();
    expect(schema.data.instances).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'MCP GraphQL', active: false, workspace: false })]));
    expect(schema.data.__schema.queryType.fields.map((field: any) => field.name)).toEqual(expect.arrayContaining(['instances', 'activeInstance']));
    expect(schema.data.__schema.mutationType.fields.map((field: any) => field.name)).toEqual(expect.arrayContaining(['selectInstance', 'createInstance']));
    const noSelection = await call('query', '{ projects { totalCount } }');
    expect(noSelection.isError).toBe(true);
    expect(noSelection.errors[0].message).toContain('selectInstance');
    const path = join(workspace, 'created');
    const rejected = await call('query', 'mutation($path: String!) { createInstance(input: {path: $path, name: "Rejected", description: "Rejected"}) { error } }', { path });
    expect(rejected.isError).toBe(true);
    expect(existsSync(path)).toBe(false);
    const created = await call('mutate', `mutation($path: String!) {
      createInstance(input: {path: $path, name: "Created", description: "New instance", body: "Use brief summaries.", tutorial: true}) {
        instance { id path name active workspace } tutorialProjectId error
      }
      capture(input: {content: "Created then captured", description: "Ordered write"}) { entry { id content } }
    }`, { path: 'created' });
    expect(created.isError).toBe(false);
    expect(created.data.createInstance).toMatchObject({ instance: { name: 'Created', active: true, workspace: false } });
    expect(created.data.createInstance.instance.path).toBe(realpathSync(path));
    expect(created.data.createInstance.tutorialProjectId).toContain('meet-aside');
    expect(created.data.capture.entry.content).toBe('Created then captured');
    expect(created.extensions.mutations.map((item: any) => item.operation)).toEqual(['createInstance', 'capture']);
    expect(readFileSync(join(path, 'aside.md'), 'utf8')).toContain('Use brief summaries.');
    expect((await call('query', '{ activeInstance { name } projects { totalCount } }')).data).toEqual({ activeInstance: { name: 'Created' }, projects: { totalCount: 1 } });
    expect((await read('query', '{ activeInstance { name workspace } }')).data.activeInstance).toEqual({ name: 'MCP GraphQL', workspace: true });
    const countBefore = (await call('query', '{ entries { totalCount } }')).data.entries.totalCount;
    const failed = await call('mutate', `mutation {
      selectInstance(path: "missing") { instance { path } }
      capture(input: {content: "Must not write to previous instance", description: "Rejected selection"}) { entry { id } }
    }`);
    expect(failed.isError).toBe(true);
    expect(failed.errors).toHaveLength(2);
    expect(failed.errors[0].message).toContain(join(realpathSync(workspace), 'missing'));
    expect(failed.errors[1].message).toContain('Later mutation fields were skipped');
    expect(failed.data).toEqual({selectInstance: null, capture: null});
    expect(failed.extensions.mutations).toEqual([]);
    expect((await call('query', '{ entries { totalCount } }')).data.entries.totalCount).toBe(countBefore);
    const relative = await call('mutate', 'mutation { selectInstance(path: "created") { instance { path } } }');
    expect(relative.isError).toBe(false);
    expect(relative.data.selectInstance.instance.path).toBe(realpathSync(path));
    expect((await call('query', '{ activeInstance { name } }')).data.activeInstance.name).toBe('Created');
    const selected = await call('mutate', `mutation($path: String!) {
      selectInstance(path: $path) { instance { name active workspace } error }
      capture(input: {content: "Selected then captured", description: "Selection write"}) { entry { content } }
    }`, { path: dir });
    expect(selected.isError).toBe(false);
    expect(selected.data.selectInstance.instance).toEqual({ name: 'MCP GraphQL', active: true, workspace: false });
    expect(selected.data.capture.entry.content).toBe('Selected then captured');
    expect(selected.extensions.mutations.map((item: any) => item.operation)).toEqual(['selectInstance', 'capture']);
    expect(readFileSync(join(workspace, '.aside'), 'utf8')).toBe('discovery: false\n');
  });

  it('authors instance automation through either interface and reads the same configuration', async () => {
    const automations = { digest: { schedule: { cron: '0 8 * * *', timezone: 'UTC' }, run: { model: 'digest', prompt: '#artifact/2026-10-08-instructions' } } };
    const created = await legacy.callTool({ name: 'update_instance', arguments: { automations } });
    expect(created.isError).not.toBe(true);
    const queried = await read('query', '{ activeInstance { path automations { nodes { name schedule { cron timezone } run { model } } } } }');
    expect(queried.data.activeInstance.automations.nodes).toEqual([{name: 'digest', schedule: automations.digest.schedule, run: {model: 'digest'}}]);
    const changed = await read('mutate', 'mutation { updateInstance(input: {automations: {set: []}}) { instance { automations { totalCount nodes { name } } } } }');
    expect(changed.isError).toBe(false);
    expect(changed.data.updateInstance.instance.automations).toEqual({totalCount: 0, nodes: []});
    const cleared = await legacy.callTool({ name: 'query_instance', arguments: {} });
    const block = (cleared.content as any[]).find(item => item.type === 'text');
    expect(JSON.parse(block.text).manifest.automations).toBeUndefined();
    const rejected = await legacy.callTool({ name: 'update_instance', arguments: { automations: { wrong: { ...automations.digest, schedule: { cron: 'bad' } } } } });
    expect(rejected.isError).toBe(true);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).not.toContain('automations:');
  });

  it('mutates recurrence through action commands without expanding the tool surface', async () => {
    const created = await read('mutate', `mutation {
      capture(input: {content: "Reusable recurring work", description: "Routine", actions: [{create: {
        name: "Recurring MCP work", description: "Routine", recurrence: [{dtstart: "2099-01-01", rrule: "FREQ=DAILY"}]
      }}]}) { createdActions { id } }
    }`);
    expect(created.isError).toBe(false);
    const id = created.data.capture.createdActions[0].id;
    const appended = await legacy.callTool({ name: 'update_action', arguments: { id, recurrence: { append: { dtstart: '2100-01-01', rrule: 'FREQ=WEEKLY' } } } });
    expect(appended.isError).not.toBe(true);
    const ended = await read('mutate', `mutation {
      updateAction(id: "${id}", input: {recurrence: {setEnd: {
        schedule: {dtstart: "2099-01-01"}, at: "2099-01-03T09:00:00Z"
      }}}) { action { recurrence { dtstart rrule } } }
    }`);
    expect(ended.isError).toBe(false);
    expect(ended.data.updateAction.action.recurrence).toHaveLength(2);
    expect(ended.data.updateAction.action.recurrence[0].rrule).toContain('UNTIL=');
    const removed = await legacy.callTool({ name: 'update_action', arguments: { id, recurrence: { remove: { dtstart: '2099-01-01' } } } });
    expect(removed.isError).not.toBe(true);
    const dormant = await read('mutate', `mutation {
      updateAction(id: "${id}", input: {recurrence: {remove: {dtstart: "2100-01-01"}}}) {
        action { recurrence { dtstart } }
      }
    }`);
    expect(dormant.isError).toBe(false);
    expect(dormant.data.updateAction.action.recurrence).toEqual([]);
    const replacement = await legacy.callTool({ name: 'update_action', arguments: { id, recurrence: [] } });
    expect(replacement.isError).toBe(true);
  });
});
