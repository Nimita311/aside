import { expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { init } from '../src/source/bootstrap.js';
import { Daemon } from '../src/daemon/daemon.js';
import { DaemonClient } from '../src/daemon/client.js';
import { InstanceHost } from '../src/daemon/host.js';
import { daemonPaths } from '../src/daemon/paths.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import type { InstanceSessionState } from '../src/mcp/instance-session.js';
import type { GraphQLResult } from '../src/graphql/schema.js';
import { openBrowser } from '../src/web/locate.js';

vi.mock('../src/web/locate.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/web/locate.js')>(), openBrowser: vi.fn(async () => true),
}));

it('serves local and remote MCP independently and returns public navigation without opening the host browser', async () => {
  const root = realpathSync(mkdtempSync('/tmp/aside-show-url-'));
  const instance = join(root, 'work'), other = join(root, 'other');
  init(instance, {name: 'Work', description: 'Chosen browser'});
  init(other, {name: 'Other', description: 'Independent selection'});
  const paths = daemonPaths({ASIDE_DAEMON_HOME: join(root, 'state')});
  const host = new InstanceHost(new CalClient(null));
  const daemon = new Daemon({paths, host, webPort: 0});
  const client = new DaemonClient({paths});
  const session: InstanceSessionState = {workspace: [instance], encountered: [], active: instance,
    discovery: false, cwd: root, configIssues: []};
  const remotes: Array<{client: Client; transport: StreamableHTTPClientTransport}> = [];
  try {
    expect(await daemon.listen()).toBe(true);
    const {port} = await client.request<{port: number}>('serve', {});
    const local = await client.request<{result: GraphQLResult}>('graphql', {session, mode: 'mutation', args: {document: 'mutation { first: showUrl second: showUrl }'}});
    const url = `http://localhost:${port}/work/`;
    expect(local.result.data).toEqual({first: url, second: url});
    expect((await fetch(url)).status).toBe(200);
    expect(openBrowser).not.toHaveBeenCalled();

    for (const path of [instance, other]) {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {requestInit: {headers: {
        'X-Forwarded-Host': 'aside.example.com:8443', 'X-Forwarded-Proto': 'https',
      }}});
      const remote = new Client({name: 'hosting-test', version: '1'});
      await remote.connect(transport);
      remotes.push({client: remote, transport});
      const selected = await remote.callTool({name: 'mutate', arguments: {
        document: 'mutation($path:String!){selectInstance(path:$path){instance{path}}}', variables: {path},
      }});
      expect(selected.isError).toBe(false);
    }
    for (const [i, remote] of remotes.entries()) {
      const result = await remote.client.callTool({name: 'mutate', arguments: {document: 'mutation { link: showUrl show { url outcome error } }'}});
      expect(result.isError).toBe(false);
      const expected = `https://aside.example.com:8443/${i ? 'other' : 'work'}/`;
      expect(result.structuredContent).toMatchObject({data: {link: expected, show: {url: expected, outcome: 'RETURNED', error: null}}});
    }
    const origins = ['first.example.com','second.example.com'];
    const links = await Promise.all(origins.map(async (origin,index) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {method:'POST',headers:{
        'Content-Type':'application/json',Accept:'application/json, text/event-stream',
        'Mcp-Session-Id':remotes[0].transport.sessionId!, 'Mcp-Protocol-Version':'2025-11-25',
        'X-Forwarded-Host':origin,'X-Forwarded-Proto':'https',
      },body:JSON.stringify({jsonrpc:'2.0',id:1000+index,method:'tools/call',params:{name:'mutate',arguments:{document:'mutation { showUrl }'}}})});
      expect(response.status).toBe(200);
      return (await response.json()).result.structuredContent.data.showUrl;
    }));
    expect(links).toEqual(origins.map(origin=>`https://${origin}/work/`));
    const unsupported = await fetch(`http://127.0.0.1:${port}/mcp`,{method:'PUT'});
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get('Allow')).toBe('GET, POST, DELETE');
    expect(openBrowser).not.toHaveBeenCalled();
    const opened = await client.request<{result: GraphQLResult}>('graphql', {session, mode: 'mutation', args: {document: 'mutation { show { url outcome error } }'}});
    expect(opened.result.data!.show).toMatchObject({url, outcome: 'OPENED', error: null});
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith(url);

    const expiredId = remotes[0].transport.sessionId;
    await remotes[0].transport.terminateSession();
    expect((await fetch(`http://127.0.0.1:${port}/mcp`, {headers: {'mcp-session-id': expiredId!}})).status).toBe(404);
  } finally {
    await Promise.all(remotes.map(remote => remote.client.close()));
    client.close(); await daemon.shutdown(); vi.mocked(openBrowser).mockClear();
    rmSync(root, {recursive: true, force: true});
  }
});
