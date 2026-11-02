import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildSchema, isInputObjectType, isObjectType, isInterfaceType, parse, printSchema, validate } from 'graphql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPHQL_GUIDES, GRAPHQL_SERVER_INSTRUCTIONS, registerGraphQLResources } from '../src/mcp/resources.js';
import { buildGraphQLSchema, type GraphQLSchemaResult } from '../src/graphql/schema.js';

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

async function connect(readSchema: () => Promise<GraphQLSchemaResult>) {
  const server = new McpServer({ name: 'resource-test', version: '1' });
  registerGraphQLResources(server, readSchema);
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('GraphQL MCP resources', () => {
  it('discovers and reads every guide without contacting the daemon', async () => {
    const offline = vi.fn(async () => { throw new Error('Daemon unavailable'); });
    const client = await connect(offline);
    const listed = (await client.listResources()).resources;
    expect(listed).toHaveLength(GRAPHQL_GUIDES.length + 1);
    const uris = new Set(listed.map(resource => resource.uri));
    const schema = buildGraphQLSchema();
    const authoringGuides = new Set(['records', 'planning', 'automate', 'setup']);
    const texts = [
      GRAPHQL_SERVER_INSTRUCTIONS,
      readFileSync(join(__dirname, '../../agent/graphql/skills/aside/SKILL.md'), 'utf8'),
    ];
    for (const resource of listed.filter(resource => resource.mimeType === 'text/markdown')) {
      expect(resource.description).toBeTruthy();
      const result = await client.readResource({ uri: resource.uri });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]).toMatchObject({ uri: resource.uri, mimeType: 'text/markdown' });
      const text = (result.contents[0] as { text: string }).text;
      // One read supplies the complete write guide, including shared rules.
      expect(text.includes('## Writing and references')).toBe(authoringGuides.has(resource.name));
      texts.push(text);
    }
    expect(offline).not.toHaveBeenCalled();
    for (const text of texts) {
      // Skill, server instructions, and guide routes must resolve to listed resources.
      for (const match of text.matchAll(/aside:\/\/(?:docs\/[a-z-]+|graphql\/schema)/g)) expect(uris.has(match[0]), match[0]).toBe(true);
      // Operation/type pointers are the guides' discovery contract, even when
      // a guide has no complete executable GraphQL example.
      for (const span of text.matchAll(/`([^`\n]+)`/g)) {
        for (const match of span[1].matchAll(/\b([A-Z][A-Za-z0-9]*)(?:\.([a-z][A-Za-z0-9_]*))?\b/g)) {
          const [, name, field] = match;
          if (name === 'Type') continue; // The documented Type / Type.field notation.
          const type = schema.getType(name);
          if (!field && !type && !/(?:Input|Where|Payload|Connection|Filter|Identity|Metadata|FrontMatter|Config|Option)$/.test(name)) continue;
          expect(type, match[0]).toBeDefined();
          if (field) {
            expect(isObjectType(type) || isInputObjectType(type) || isInterfaceType(type), match[0]).toBe(true);
            if (isObjectType(type) || isInputObjectType(type) || isInterfaceType(type)) expect(type.getFields()[field], match[0]).toBeDefined();
          }
        }
      }
      // Executable examples must remain compatible with the actual schema.
      for (const match of text.matchAll(/```graphql\s+([\s\S]*?)```/g)) {
        expect(validate(buildGraphQLSchema(), parse(match[1])).map(error => error.message), match[1]).toEqual([]);
      }
    }
  });

  it('keeps projection, configuration, and maintenance boundaries discoverable in their guides', () => {
    const guide = (name: string) => GRAPHQL_GUIDES.find(item => item.name === name)!.text;
    expect(guide('planning')).toContain('Query.actions');
    expect(guide('planning')).toContain('Action.occurrence');
    expect(guide('planning')).toContain('ActionWhere.occurrence');
    expect(guide('planning')).toContain('All action filters apply before pagination');
    expect(guide('planning')).toContain('make `extensions.complete`');
    expect(guide('planning')).toContain('materializes that occurrence automatically');
    expect(guide('planning')).not.toContain('planningActions');
    expect(guide('planning')).not.toContain('FrontMatter');
    expect(guide('planning')).toContain('saved action handle for durable links');
    expect(guide('planning')).toContain('PT30M');
    expect(guide('planning')).toContain('/backlog');
    expect(guide('planning')).toContain('without clearing completion or cancellation');
    expect(guide('setup')).toContain('MCP launch working directory');
    expect(guide('setup')).toContain('not searched for in ancestor directories');
    expect(guide('setup')).toContain('owning instance root');
    expect(guide('setup')).toContain('primary checkout root');
    expect(guide('setup')).toContain('duplicate-ID checks remain active');
    expect(guide('setup')).toContain('authorize direct record or manifest edits');
    expect(guide('setup')).toContain('UpdateInstanceInput.body');
    expect(guide('setup')).toContain('UpdateInstanceInput.settings.doneEventTitlePrefix');
    for (const field of ['automations.upsert', 'automations.remove', 'Instance.execution', 'Automation.log', 'AutomationRun.output']) {
      expect(guide('automate')).toContain(field);
    }
    for (const operation of ['status --json', 'start', 'install', 'stop', 'uninstall']) {
      expect(guide('setup')).toContain(`aside daemon ${operation}`);
    }
    for (const operation of ['add --dir', 'list --json', 'forget --dir']) {
      expect(guide('setup')).toContain(`aside instance ${operation}`);
    }
    expect(guide('setup')).toContain('without stopping the daemon');
    expect(guide('setup')).toContain('Forgetting removes the registration immediately');
    expect(guide('setup')).toContain('stays loaded until remaining clients and browser tabs release');
    expect(guide('automate')).toContain('UNOBSERVED');
    expect(guide('automate')).toContain('aside daemon automations --json');
    expect(guide('automate')).toContain('aside://docs/setup');
    expect(GRAPHQL_SERVER_INSTRUCTIONS).toContain('updateAction');
    expect(GRAPHQL_SERVER_INSTRUCTIONS).toContain('Mutation payloads expose nullable `error`');
    expect(GRAPHQL_SERVER_INSTRUCTIONS).toContain('`operation`, `error`, and `changes`');
    expect(GRAPHQL_SERVER_INSTRUCTIONS).toContain('GraphQL mutation field name');
    expect(GRAPHQL_SERVER_INSTRUCTIONS).toContain('a `limit` from 1 through 100');
    expect(GRAPHQL_SERVER_INSTRUCTIONS).toContain('when the user explicitly requests them');
    expect(GRAPHQL_SERVER_INSTRUCTIONS).toContain('Entry tags or mentions in entry content.');
    expect(guide('planning')).toContain('scheduling determines unresolved status');
  });

  it('returns the static schema reader result directly, preserving documentation, OneOf, and stable model inputs', async () => {
    const sdl = printSchema(buildGraphQLSchema());
    const reader = vi.fn(async () => ({sdl, diagnostics: []}));
    const client = await connect(reader);
    const read = async () => {
      const result = await client.readResource({ uri: 'aside://graphql/schema' });
      expect(result.contents[0]).toMatchObject({ mimeType: 'application/graphql' });
      const text = (result.contents[0] as { text: string }).text;
      expect(text).toBe(sdl);
      const restored = buildSchema(text);
      expect((restored.getType('ActionLinkInput') as any).isOneOf).toBe(true);
      expect(restored.getQueryType()!.getFields().actions.description).toBeTruthy();
      return restored;
    };
    const schema = await read();
    expect(schema.getType('Model')).toBeUndefined();
    expect((schema.getType('AutomationRunInput') as any).getFields().model.type.toString()).toBe('String');
    expect((schema.getType('Execution') as any).getFields().models).toBeDefined();
    expect(printSchema(await read())).toBe(sdl);
    expect(reader.mock.calls).toEqual([[], []]);
  });

  it('reports read errors without a stale fallback or a sticky failed resource', async () => {
    const sdl = printSchema(buildGraphQLSchema());
    const reader = vi.fn(async () => ({sdl, diagnostics: []})).mockRejectedValueOnce(new Error('Instance unavailable'));
    const client = await connect(reader);
    await expect(client.readResource({ uri: 'aside://graphql/schema' })).rejects.toThrow('Instance unavailable');
    const recovered = await client.readResource({uri: 'aside://graphql/schema'});
    expect((recovered.contents[0] as {text: string}).text).toBe(sdl);
    reader.mockRejectedValueOnce(new Error('Instance unavailable again'));
    await expect(client.readResource({ uri: 'aside://graphql/schema' })).rejects.toThrow('Instance unavailable again');
    await expect(client.readResource({ uri: 'aside://docs/missing' })).rejects.toThrow();
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it('preserves resource diagnostics separately from static SDL', async () => {
    const sdl = printSchema(buildGraphQLSchema());
    let snapshot: GraphQLSchemaResult = {
      sdl, diagnostics: [{severity: 'warning', code: 'config_read_error', message: 'Configuration unavailable\nTry again after repair.'}],
    };
    const client = await connect(async () => snapshot);
    const result = await client.readResource({uri: 'aside://graphql/schema'});
    const text = (result.contents[0] as {text: string}).text;
    expect(text).toContain('config_read_error');
    expect(text).toContain('Configuration unavailable');
    expect(printSchema(buildSchema(text))).toEqual(sdl);
    snapshot = {sdl, diagnostics: []};
    const recovered = await client.readResource({uri: 'aside://graphql/schema'});
    expect((recovered.contents[0] as {text: string}).text).toBe(sdl);
  });
});
