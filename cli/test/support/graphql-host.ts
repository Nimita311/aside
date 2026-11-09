import type {InstanceHost} from '../../src/daemon/host.js';
import type {GraphQLArgs} from '../../src/graphql/schema.js';
import {InstanceRegistry} from '../../src/mcp/instance-registry.js';
import {InstanceSession} from '../../src/mcp/instance-session.js';
import {lifecycleOperationsFixture} from '../lifecycle-operations-fixture.js';

/** One GraphQL request through the host, in a session with `dir` active. */
export async function hostGraphQL(host: InstanceHost, dir: string, tool: string, args: GraphQLArgs): Promise<{text: string}> {
  const registry = new InstanceRegistry([dir]);
  registry.activate(dir);
  const session = new InstanceSession(registry, lifecycleOperationsFixture({
    knownInstances: async () => [dir], issues: async () => host.issues(dir), instanceRecord: async path => host.metadata(path),
  }));
  return {text: JSON.stringify(await host.graphql(session, tool === 'query' ? 'query' : 'mutation', args))};
}

/** The GraphQL session a daemon client sends over the `graphql` RPC. */
export const daemonSession = (dir: string) => ({workspace: [dir], encountered: [dir], active: dir, configIssues: [], discovery: false, cwd: dir});
