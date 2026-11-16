import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOL_SCHEMAS } from './schemas.js';
import { InstanceRegistry } from './instance-registry.js';
import type { InstanceSessionState } from './instance-session.js';
import type { GraphQLArgs, GraphQLResult, GraphQLSchemaResult } from '../graphql/schema.js';
import { hasGraphQLProblems } from '../graphql/results.js';
import { VERSION } from '../version.js';
import { GRAPHQL_SERVER_INSTRUCTIONS, registerGraphQLResources } from './resources.js';
import type { ParseIssue } from '../core/types.js';
import { DaemonClient } from '../daemon/client.js';

// The requests a session makes of the daemon. The default reaches the shared
// daemon over its socket; tests inject an in-process host.
export interface Backend {
  issues(instance: string): Promise<ParseIssue[]>;
  graphql(session: InstanceSessionState, mode: 'query' | 'mutation', args: GraphQLArgs, context?: { origin?: string }): Promise<{ result: GraphQLResult; session: InstanceSessionState }>;
  graphqlSchema(session: InstanceSessionState): Promise<{ result: GraphQLSchemaResult; session: InstanceSessionState }>;
  close(): void;
}

export function daemonBackend(client: DaemonClient = new DaemonClient()): Backend {
  return {
    issues: async (instance) => (await client.request<{ issues: ParseIssue[] }>('instance.info', { instance }, { read: true })).issues,
    graphql: (session, mode, args, context) => client.request('graphql', { session, mode, args, navigationOrigin: context?.origin }, { read: mode === 'query' }),
    graphqlSchema: session => client.request('graphql.schema', { session }, { read: true }),
    close: () => client.close(),
  };
}

// The MCP server is a daemon client (design/runtime.md): it owns this session's
// workspace — discovery and the active instance — and sends that selection with
// every request.
export function createMcpServer(dataDir: string | null, candidates: string[], configIssues: ParseIssue[] = [], discovery = true, backend: Backend = daemonBackend(), origin?: () => string | undefined): McpServer {
  // The active instance + every instance encountered this session (the startup
  // candidates and any later selectInstance). instances reports these so the
  // agent can switch between them.
  const instances = new InstanceRegistry(dataDir ? [...candidates, dataDir] : candidates);
  const cwd = process.cwd();
  const state = (): InstanceSessionState => ({ ...instances.selection(), configIssues, discovery, cwd });

  if (dataDir) {
    instances.activate(dataDir);
    // Load it in the daemon now, so calendar edits made while it was not loaded
    // are caught up before the first tool call. A daemon that cannot be reached
    // is reported by that call.
    void backend.issues(dataDir).catch(() => {});
  }

  const server = new McpServer({ name: 'aside', version: VERSION }, { instructions: GRAPHQL_SERVER_INSTRUCTIONS });
  let mutationTail: Promise<unknown> = Promise.resolve();
  let selectionRevision = 0;

  async function sessionRequest<T>(mode: 'query' | 'mutation', call: (state: InstanceSessionState) => Promise<{result: T; session: InstanceSessionState}>) {
    const previous = mutationTail;
    const execute = async () => {
      await previous;
      const revision = selectionRevision;
      const response = await call(state());
      // A read that began before a selection mutation must not restore its
      // older default after the mutation has committed.
      if (mode === 'mutation' || revision === selectionRevision) instances.restore(response.session);
      if (mode === 'mutation') selectionRevision++;
      return response.result;
    };
    const request = execute();
    if (mode === 'mutation') mutationTail = request.catch(() => {});
    return request;
  }

  registerGraphQLResources(server, () => sessionRequest('query', session => backend.graphqlSchema(session)));
  for (const name of ['query', 'mutate'] as const) {
    server.registerTool(name, {
      description: name === 'query'
        ? 'Execute a read-only GraphQL query. Schema: targeted introspection or aside://graphql/schema. Task guides: resources/list.'
        : 'Execute a GraphQL mutation. Schema: targeted introspection or aside://graphql/schema. Task guides: resources/list. Inspect error and confirmed effects in extensions.mutations, including partial results.',
      inputSchema: TOOL_SCHEMAS[name],
      annotations: { readOnlyHint: name === 'query' },
    }, async args => {
      const mode = name === 'query' ? 'query' : 'mutation';
      const result = await sessionRequest(mode, session => backend.graphql(session, mode, args, { origin: origin?.() }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result, isError: hasGraphQLProblems(result) };
    });
  }

  return server;
}

export async function startServer(dataDir: string | null, candidates: string[], configIssues: ParseIssue[] = [], discovery = true, backend: Backend = daemonBackend()): Promise<void> {
  const server = createMcpServer(dataDir, candidates, configIssues, discovery, backend);
  const transport = new StdioServerTransport();
  // The daemon connection would keep this process alive after its host is gone.
  transport.onclose = () => {
    backend.close();
    process.exit(0);
  };
  process.stdin.on('end', () => transport.onclose?.());
  await server.connect(transport);
}
