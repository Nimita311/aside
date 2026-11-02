import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { startServer, type Backend } from '../src/mcp/server.js';
import { buildGraphQLSchema } from '../src/graphql/schema.js';
import { printSchema } from 'graphql';
import type { InstanceSessionState } from '../src/mcp/instance-session.js';

const handlers = vi.hoisted(() => new Map<string, (args: any) => Promise<any>>());
const resources = vi.hoisted(() => new Map<string, (uri: URL) => Promise<any>>());
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {
  registerTool(name: string, _config: unknown, handler: any) { handlers.set(name, handler); }
  registerResource(_name: string, uri: string, _config: unknown, handler: any) { resources.set(uri, handler); }
  async connect() {}
} }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
const dirs: string[] = [];
const listeners: (() => void)[] = [];
afterEach(() => {
  handlers.clear();
  resources.clear();
  for (const listener of listeners.splice(0)) process.stdin.removeListener('end', listener);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GraphQL session selection concurrency', () => {
  it.each(['query', 'schema'])('does not let an older %s read restore the selection made by a later mutation', async kind => {
    const root = realpathSync(mkdtempSync('/tmp/aside-gql-race-')); dirs.push(root);
    const a = join(root, 'a'), b = join(root, 'b');
    init(a, { name: 'A', description: 'First' }); init(b, { name: 'B', description: 'Second' });
    let finishRead!: () => void;
    let started!: () => void;
    let reads = 0;
    const schemaResult = { sdl: printSchema(buildGraphQLSchema()), diagnostics: [] };
    const readStarted = new Promise<void>(resolve => { started = resolve; });
    const readBackend = async <T>(session: InstanceSessionState, result: T): Promise<{result: T; session: InstanceSessionState}> => {
      if (reads++ === 0) {
        started();
        return new Promise(resolve => { finishRead = () => resolve({ result, session }); });
      }
      expect(session.active).toBe(b);
      return { result, session };
    };
    const backend: Backend = {
      knownInstances: async () => [a, b], issues: async () => [], show: vi.fn(), close() {},
      tool: vi.fn(async path => String(path)),
      graphql: async (session, mode) => mode === 'query'
        ? readBackend(session, { data: {} })
        : { result: { data: {} }, session: { ...session, active: b, encountered: [a, b] } },
      graphqlSchema: async session => readBackend(session, schemaResult),
    };
    const before = new Set(process.stdin.listeners('end'));
    await startServer(a, [a], [], true, backend);
    for (const listener of process.stdin.listeners('end')) if (!before.has(listener)) listeners.push(listener as () => void);
    expect([...handlers.keys()]).toEqual(['query', 'mutate']);
    const read = kind === 'query' ? handlers.get('query')!({ document: '{ activeInstance { path } }' })
      : resources.get('aside://graphql/schema')!(new URL('aside://graphql/schema'));
    await readStarted;
    await handlers.get('mutate')!({ document: `mutation { selectInstance(path: "${b}") { error } }` });
    finishRead();
    await read;
    await handlers.get('query')!({ document: '{ activeInstance { path } }' });
    expect(reads).toBe(2);
  });

  it('waits for an earlier selection mutation before reading the schema', async () => {
    const root = realpathSync(mkdtempSync('/tmp/aside-gql-schema-order-')); dirs.push(root);
    const a = join(root, 'a'), b = join(root, 'b');
    init(a, { name: 'A', description: 'First' }); init(b, { name: 'B', description: 'Second' });
    let finishMutation!: () => void;
    let started!: () => void;
    const mutationStarted = new Promise<void>(resolve => { started = resolve; });
    const reads: string[] = [];
    const backend: Backend = {
      knownInstances: async () => [a, b], issues: async () => [], show: vi.fn(), close() {}, tool: vi.fn(),
      graphql: async (session, mode) => {
        expect(mode).toBe('mutation');
        started();
        await new Promise<void>(resolve => { finishMutation = resolve; });
        return {result: {data: {}}, session: {...session, active: b, encountered: [a, b]}};
      },
      graphqlSchema: async session => {
        reads.push(session.active!);
        const schema = buildGraphQLSchema();
        return {result: {sdl: printSchema(schema), diagnostics: []}, session};
      },
    };
    const before = new Set(process.stdin.listeners('end'));
    await startServer(a, [a], [], true, backend);
    for (const listener of process.stdin.listeners('end')) if (!before.has(listener)) listeners.push(listener as () => void);
    const mutation = handlers.get('mutate')!({document: `mutation { selectInstance(path: "${b}") { error } }`});
    await mutationStarted;
    const schema = resources.get('aside://graphql/schema')!(new URL('aside://graphql/schema'));
    await Promise.resolve();
    expect(reads).toEqual([]);
    finishMutation();
    await mutation;
    const result = await schema;
    expect(reads).toEqual([b]);
    expect(result.contents[0].text).toBe(printSchema(buildGraphQLSchema()));
  });

  it('resolves cached schema text against the current selection on every read', async () => {
    const root = realpathSync(mkdtempSync('/tmp/aside-gql-schema-cache-')); dirs.push(root);
    const a = join(root, 'a'), b = join(root, 'b');
    init(a, { name: 'A', description: 'First' }); init(b, { name: 'B', description: 'Second' });
    const schemas = new Map<string | null, string>([
      [null, printSchema(buildGraphQLSchema())],
      ...[a, b].map((path): [string, string] => [path, printSchema(buildGraphQLSchema())]),
    ]);
    const reads: Array<string | null> = [];
    const backend: Backend = {
      knownInstances: async () => [a, b], issues: async () => [], show: vi.fn(), close() {}, tool: vi.fn(),
      graphql: async (session, mode, args) => ({result: {data: {}}, session: mode === 'mutation'
        ? {...session, active: args.variables!.path as string, encountered: [a, b]} : session}),
      graphqlSchema: async session => {
        reads.push(session.active);
        return {result: {sdl: schemas.get(session.active)!, diagnostics: []}, session};
      },
    };
    const before = new Set(process.stdin.listeners('end'));
    await startServer(null, [a, b], [], true, backend);
    for (const listener of process.stdin.listeners('end')) if (!before.has(listener)) listeners.push(listener as () => void);
    const schema = async () => (await resources.get('aside://graphql/schema')!(new URL('aside://graphql/schema'))).contents[0].text;
    const select = (path: string) => handlers.get('mutate')!({document: 'mutation($path: String!) { selectInstance(path: $path) { error } }', variables: {path}});
    expect(await schema()).toBe(schemas.get(null));
    await select(a);
    expect(await schema()).toBe(schemas.get(a));
    expect(await schema()).toBe(schemas.get(a));
    await select(b);
    expect(await schema()).toBe(schemas.get(b));
    await select(a);
    expect(await schema()).toBe(schemas.get(a));
    expect(reads).toEqual([null, a, a, b, a]);
  });

});
