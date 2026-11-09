import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsideWebServer, type WebBackend } from '../src/web/server.js';
import { WebAuth } from '../src/web/auth.js';
import { Store } from '../src/source/store.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import type { WebappSidebarSection } from '../src/core/types.js';

let directory: string | undefined, store: Store | undefined, server: AsideWebServer | undefined;
let host: InstanceHost | undefined;
afterEach(async () => { server?.close(); server = undefined; await host?.close(); host = undefined; store = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; vi.restoreAllMocks(); });

async function setup() {
  directory = mkdtempSync('/private/tmp/aside-web-sidebar-');
  const file = join(directory, 'aside.md');
  writeFileSync(file, '---\nid: sidebar-http\nconfig:\n  doneEventTitlePrefix: "Done "\n  webapp:\n    appearance: {accent: teal}\n---\n\nInstructions.  \n');
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  host = new InstanceHost(new CalClient(null)); store = host.load(directory).store;
  const updateSidebar = vi.fn(async (path: string, sidebar: WebappSidebarSection[], expectedSidebar: WebappSidebarSection[]) => {
    expect(path).toBe(directory); host!.updateSidebar(path, sidebar, expectedSidebar);
  });
  const query = vi.fn(async () => ({ data: {} }));
  const backend: WebBackend = {
    instances: () => [{ id: 'sidebar-http', path: directory! }], register: async () => null,
    remove() {}, load() {}, data: async () => store!.snapshot(), updateSidebar, query,
  };
  const auth = new WebAuth(join(directory, 'auth'));
  server = (await AsideWebServer.start(fileURLToPath(new URL('../../webapp/', import.meta.url)), backend, 0,
    { auth, stateDirectory: join(directory, 'auth') }))!;
  const origin = `http://127.0.0.1:${server.port}`, token = auth.issue().token;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Aside-Control': '1', Origin: origin };
  const url = `${origin}/-/api/instances/sidebar-http/sidebar`;
  const post = (body: unknown) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return { file, origin, url, headers, post, updateSidebar, query };
}

describe('authenticated browser sidebar writes', () => {
  it('persists only the sidebar through the same instance writer and makes it available in snapshots', async () => {
    const { file, origin, headers, post, updateSidebar } = await setup();
    const sidebar = [{ title: 'Focus', items: [{ timeline: '#artifact/2026-10-12-decisions/focus.json' }, { entity: '#project/2026-10-12-launch', label: 'Launch' }] }];
    const response = await post({ sidebar, expectedSidebar: [] });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ sidebar });
    expect(updateSidebar).toHaveBeenCalledOnce();
    const snapshot = await fetch(`${origin}/-/api/instances/sidebar-http/data`, { headers });
    expect((await snapshot.json()).instance.manifest.config.webapp.sidebar).toEqual(sidebar);
    expect(readFileSync(file, 'utf8')).toContain('appearance: { accent: teal }');
    expect(readFileSync(file, 'utf8')).toContain('doneEventTitlePrefix: "Done "');
    expect(readFileSync(file, 'utf8').endsWith('Instructions.  \n')).toBe(true);
    const clear = await post({ sidebar: [], expectedSidebar: sidebar });
    expect(clear.status).toBe(200); expect(store!.getManifest().config?.webapp?.sidebar).toEqual([]);
  });

  it('rejects malformed replacement declarations atomically before invoking the writer', async () => {
    const { file, post, updateSidebar } = await setup();
    const before = readFileSync(file, 'utf8');
    for (const body of [
      {}, { sidebar: [] }, { sidebar: null, expectedSidebar: [] }, { sidebar: [], expectedSidebar: [], body: 'Must not save' },
      { sidebar: [], expectedSidebar: null },
      { sidebar: [{ items: [{ timeline: 'entries' }, { timeline: 'entries', entity: 'both' }] }], expectedSidebar: [] },
      { sidebar: [{ items: [{ entity: '#project/example', id: 'unsupported' }] }], expectedSidebar: [] },
    ]) {
      expect((await post(body)).status).toBe(400);
      expect(readFileSync(file, 'utf8')).toBe(before);
    }
    expect(updateSidebar).not.toHaveBeenCalled();
  });

  it('requires browser authorization and control headers while GraphQL remains read-only', async () => {
    const { origin, url, headers, updateSidebar, query } = await setup();
    const body = JSON.stringify({ sidebar: [], expectedSidebar: [] });
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status).toBe(401);
    const noControl = { ...headers }; delete noControl['X-Aside-Control'];
    expect((await fetch(url, { method: 'POST', headers: noControl, body })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://other.invalid' }, body })).status).toBe(403);
    expect((await fetch(url, { headers })).status).toBe(405);
    const mutation = await fetch(`${origin}/-/api/instances/sidebar-http/graphql`, { method: 'POST', headers,
      body: JSON.stringify({ query: 'mutation { updateInstance(input: {settings: {webapp: {sidebar: []}}}) { error } }' }) });
    expect((await mutation.json()).errors).toBeDefined();
    expect(updateSidebar).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });

  it('rejects a stale second browser declaration and accepts a refreshed merged intention', async () => {
    const { post } = await setup();
    const first = [{ items: [{ timeline: 'first pin' }] }];
    const second = [{ items: [{ timeline: 'second pin' }] }];
    const replies = await Promise.all([post({ sidebar: first, expectedSidebar: [] }), post({ sidebar: second, expectedSidebar: [] })]);
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 409]);
    const saved = store!.getManifest().config!.webapp!.sidebar!;
    expect(saved).toEqual(replies[0].status === 200 ? first : second);
    const merged = [{ items: [...saved[0].items, ...(replies[0].status === 200 ? second : first)[0].items] }];
    expect((await post({ sidebar: merged, expectedSidebar: saved })).status).toBe(200);
    expect(store!.getManifest().config?.webapp?.sidebar).toEqual(merged);
  });

  it('checks the current disk declaration instead of a cached store before saving a pin', async () => {
    const { file, post } = await setup();
    const current = '---\nid: sidebar-http\nconfig:\n  webapp:\n    sidebar: [{title: "Agent section", items: [{timeline: "agent focus"}]}]\n---\n\nNew instructions.  \n';
    writeFileSync(file, current);
    expect(store!.getManifest().config?.webapp?.sidebar).toBeUndefined();
    const response = await post({ sidebar: [{ items: [{ timeline: 'browser pin' }] }], expectedSidebar: [] });
    expect(response.status).toBe(409);
    expect(readFileSync(file, 'utf8')).toBe(current);
  });

  it('preserves a malformed current sidebar rather than treating it as an empty declaration', async () => {
    const { file, post } = await setup();
    const current = '---\nid: sidebar-http\nconfig:\n  webapp:\n    sidebar: [{items: [{timeline: "one", entity: "two"}]}]\n---\n\nRetain these instructions.  \n';
    writeFileSync(file, current);
    const response = await post({ sidebar: [], expectedSidebar: [] });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('cannot be verified');
    expect(readFileSync(file, 'utf8')).toBe(current);
  });
});
