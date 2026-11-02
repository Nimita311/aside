import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCommand, type CommandInput } from './options.js';
import { resolveDataDir } from './mcp.js';
import { InstancePathError } from '../core/instance.js';
import { InstanceRegistry } from '../mcp/instance-registry.js';
import type { InstanceSessionState } from '../mcp/instance-session.js';
import { validateToolArgs } from '../mcp/schemas.js';
import { prepareGraphQL, type GraphQLArgs, type GraphQLResult } from '../graphql/schema.js';
import { DaemonClient } from '../daemon/client.js';

export type GraphQLExecutor = (
  session: InstanceSessionState, mode: 'query' | 'mutation', args: GraphQLArgs,
) => Promise<{ result: GraphQLResult; session: InstanceSessionState }>;

const viaDaemon: GraphQLExecutor = async (session, mode, args) => {
  const client = new DaemonClient();
  try {
    return await client.request('graphql', { session, mode, args }, { read: mode === 'query' });
  } finally { client.close(); }
};

// One invocation carries its own workspace/default through the same protocol
// as MCP. Selection mutations affect later fields in this document only.
export async function runGraphQL(
  input: CommandInput, cwd = process.cwd(), execute: GraphQLExecutor = viaDaemon,
  stdin: () => string = () => readFileSync(0, 'utf8'),
): Promise<GraphQLResult> {
  const options = parseCommand('graphql', input);
  const mode = options.operation === 'query' ? 'query' : 'mutation';
  const read = (path: string) => readFileSync(resolve(cwd, path), 'utf8');
  const documentPath = options.get('--document-file');
  const document = options.get('--document') ?? (documentPath === '-' ? stdin() : read(documentPath!));
  const variablesPath = options.get('--variables-file');
  const variablesText = options.get('--variables') ?? (variablesPath === undefined ? undefined : read(variablesPath));
  let variables: Record<string, unknown> | undefined;
  if (variablesText !== undefined) {
    const parsed: unknown = JSON.parse(variablesText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('GraphQL variables must be a JSON object.');
    variables = parsed as Record<string, unknown>;
  }
  const args = validateToolArgs(mode === 'query' ? 'query' : 'mutate', {
    document, ...(variables === undefined ? {} : { variables }),
    ...(options.has('--operation-name') ? { operationName: options.get('--operation-name') } : {}),
  }) as GraphQLArgs;
  const prepared = prepareGraphQL(mode, args);
  if (!prepared.document) return { errors: prepared.errors };
  const { dataDir, candidates, configIssues, invalidDir, discovery } = resolveDataDir(cwd, options);
  if (invalidDir) throw new InstancePathError(`Not an aside directory (no aside.md manifest): ${invalidDir}`);
  const registry = new InstanceRegistry(candidates);
  if (dataDir) registry.activate(dataDir);
  const session: InstanceSessionState = { ...registry.selection(), cwd: resolve(cwd), configIssues, discovery };
  return (await execute(session, mode, args)).result;
}
