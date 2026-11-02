import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { Daemon } from '../src/daemon/daemon.js';
import { DaemonClient } from '../src/daemon/client.js';
import { InstanceHost } from '../src/daemon/host.js';
import { daemonPaths } from '../src/daemon/paths.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import type { InstanceSessionState } from '../src/mcp/instance-session.js';
import type { GraphQLResult } from '../src/graphql/schema.js';
import { openBrowser } from '../src/web/locate.js';
import { openHandoffBridge } from './helpers/browser-handoff.js';

vi.mock('../src/web/locate.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/web/locate.js')>(), openBrowser: vi.fn(async () => true),
}));

it('returns fresh authorization URLs through the daemon socket and opens only when show is called', async () => {
  const root = realpathSync(mkdtempSync('/tmp/aside-show-url-'));
  const instance = join(root, 'work');
  init(instance, {name: 'Work', description: 'Chosen browser'});
  const paths = daemonPaths({ASIDE_DAEMON_HOME: join(root, 'state')});
  const host = new InstanceHost(new CalClient(null));
  const daemon = new Daemon({paths, host, webPort: 0});
  const client = new DaemonClient({paths});
  const session: InstanceSessionState = {workspace: [instance], encountered: [], active: instance,
    discovery: false, cwd: root, configIssues: []};
  const mutate = async (document: string) => (await client.request<{result: GraphQLResult}>('graphql', {
    session, mode: 'mutation', args: {document},
  })).result;
  try {
    expect(await daemon.listen()).toBe(true);
    const result = await mutate('mutation { first: showUrl second: showUrl }');
    expect(result.errors).toBeUndefined();
    const {first, second} = result.data as {first: string; second: string};
    expect(first).toMatch(/^file:\/\//);
    expect(second).toMatch(/^file:\/\//);
    expect(first).not.toBe(second);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(statSync(new URL(first)).mode & 0o777).toBe(0o600);
    const html = readFileSync(new URL(first), 'utf8');
    const action = html.match(/action="([^"]+)"/)![1];
    const code = html.match(/name="code" value="([A-Za-z0-9_-]+)"/)![1];
    const complete = () => fetch(action, {method: 'POST', body: new URLSearchParams({code})});
    const response = await complete();
    expect(response.status).toBe(200);
    const completion = await openHandoffBridge(new URL(action).origin, await response.text());
    expect(completion.destination).toBe('/work/');
    const token = completion.token!;
    expect((await fetch(new URL('/-/api/instances', action), {headers: {Authorization: `Bearer ${token}`}})).status).toBe(200);
    expect((await complete()).status).toBe(401);
    expect(() => statSync(new URL(first))).toThrow();

    const opened = await mutate('mutation { show { url outcome error } }');
    expect(opened.errors).toBeUndefined();
    expect(opened.data!.show).toMatchObject({outcome: 'OPENED', error: null});
    expect(openBrowser).toHaveBeenCalledOnce();
    const launch = vi.mocked(openBrowser).mock.calls[0][0];
    expect(launch).toMatch(/^file:\/\//);
    expect(launch).not.toBe(first);
    expect(launch).not.toBe(second);
    expect(readFileSync(new URL(launch), 'utf8')).toContain('/-/auth/complete');
  } finally {
    client.close();
    await daemon.shutdown();
    vi.mocked(openBrowser).mockClear();
    rmSync(root, {recursive: true, force: true});
  }
});
