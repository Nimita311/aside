import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { context } from 'esbuild';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { grantUrl } from '../../src/file-grants.ts';
import { entryOutputPaths } from '../../build-config.mjs';
import { browserBuildOptions, createMockServer, readJson } from '../server.mjs';

let server;
const request = (path, init = {}, session) => fetch(new URL(path, server.url), {
  ...init,
  headers: { ...(session ? { Authorization: `Bearer mock:${session.id}` } : {}), ...init.headers },
  signal: init.signal ?? AbortSignal.timeout(10_000),
});
async function json(path, init = {}, session) {
  const response = await request(path, init, session);
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value;
}
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const sessionFor = (scenario = 'timeline', theme = 'light') => json('/__mock/session', post({ scenario, theme }));
const instancePath = '/-/api/instances/showcase';
const mediaPath = 'artifacts/2026/2026-10-12-media/notes.md';

beforeAll(async () => { server = await createMockServer({ port: 0, build: false }); }, 30_000);
afterAll(async () => { await server?.close(); });

describe('mock HTTP server', () => {
  it('decodes request UTF-8 after collecting chunks, including boundaries inside a character', async () => {
    const expected = { query: 'query { projects(where: { name: "東京 🌅" }) { totalCount } }' };
    const bytes = Buffer.from(JSON.stringify(expected));
    const split = bytes.indexOf(Buffer.from('東')) + 1;
    const chunks = { async *[Symbol.asyncIterator]() { yield bytes.subarray(0, split); yield bytes.subarray(split); } };
    expect(await readJson(chunks)).toEqual(expected);
    const oversized = { async *[Symbol.asyncIterator]() { yield Buffer.alloc(65_537); } };
    await expect(readJson(oversized)).rejects.toMatchObject({ status: 413 });
  });

  it('keeps original lazy modules available when a running preview outlives a browser rebuild', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aside-mock-build-'));
    let builder;
    try {
      await writeFile(path.join(root, 'elements.js'), 'export const open = () => import("./diagram.js");');
      await writeFile(path.join(root, 'diagram.js'), 'export const label = "first diagram";');
      const outdir = path.join(root, 'assets');
      const options = {
        ...browserBuildOptions, entryPoints: { elements: path.join(root, 'elements.js') }, outdir,
        format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]',
      };
      builder = await context(options);
      const result = await builder.rebuild();
      expect(await entryOutputPaths(options, result.metafile)).toEqual(new Set([path.join(outdir, 'elements.js')]));
      expect(Object.values(result.metafile.outputs).filter(output => output.entryPoint)).toHaveLength(2);
      const first = await readdir(path.join(outdir, 'chunks'));
      const original = new Map(await Promise.all(first.map(async file => [file, await readFile(path.join(outdir, 'chunks', file))])));
      await writeFile(path.join(root, 'diagram.js'), 'export const label = "updated diagram";');
      await builder.rebuild();
      const rebuilt = await readdir(path.join(outdir, 'chunks'));
      expect(rebuilt.some(file => !first.includes(file))).toBe(true);
      for (const [file, bytes] of original) expect(await readFile(path.join(outdir, 'chunks', file))).toEqual(bytes);
      const current = await readFile(path.join(outdir, 'elements.js'), 'utf8');
      expect(current).toContain(rebuilt.find(file => file.endsWith('.js') && !first.includes(file)));
    } finally {
      await builder?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves a discoverable catalogue and an explicit isolated preview session', async () => {
    const catalogue = await json('/__mock/scenarios');
    expect(catalogue.some(item => item.id === 'typography')).toBe(true);
    expect(catalogue.some(item => item.id === 'dashboard')).toBe(true);
    const session = await sessionFor('project-detail', 'dark');
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.theme).toBe('dark');
    expect(session.scenario.id).toBe('project-detail');
    const url = new URL(session.url, server.url);
    expect(url.pathname).toBe(session.scenario.route);
    expect(url.searchParams.get('mockSession')).toBe(session.id);
    expect(await json(`/__mock/session/${session.id}`)).toMatchObject({ id: session.id, theme: 'dark', scenario: { id: 'project-detail' } });
    const shell = await request(session.url);
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain('/-/assets/app.js');
    expect(html).toContain('/__mock/environment.js');
    expect(html).toContain('AsideMock.bootstrap(');
    const invalid = await request('/__mock/session', post({ scenario: 'absent' }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.any(String) });
  });

  it('requires a known session and rejects credentials from a different preview', async () => {
    expect((await request('/-/api/instances')).status).toBe(401);
    expect((await request('/-/api/instances', {}, { id: 'unknown' })).status).toBe(401);
    const first = await sessionFor(), second = await sessionFor();
    expect((await request('/-/api/instances', { headers: { 'X-Aside-Mock-Session': second.id } }, first)).status).toBe(401);
    const response = await request('/-/api/instances', { headers: { 'X-Aside-Mock-Session': first.id } });
    expect(response.status).toBe(200);
  });

  it('serves the dedicated elements page through the existing preview session and theme contract', async () => {
    const session = await sessionFor('elements', 'dark');
    expect(session.scenario).toMatchObject({ id: 'elements', kind: 'elements', ready: '#element-gallery[data-ready]' });
    expect(new URL(session.url, server.url).pathname).toBe('/__mock/elements/');
    const response = await request(session.url);
    expect(response.status).toBe(200);
    const shell = await response.text();
    expect(shell).toContain('/-/assets/style.css');
    expect(shell).toContain('/__mock/elements/style.css');
    expect(shell).toContain('/__mock/environment.js');
    expect(shell).toContain('/-/assets/elements.js');
    expect(shell).toContain('AsideMock.bootstrap(');
    expect(shell).toContain('"theme":"dark"');
    expect(shell).not.toContain('<!-- mock-config -->');
    expect(shell).not.toContain('/-/assets/app.js');
    const stylesheet = await request('/__mock/elements/style.css');
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get('Content-Type')).toContain('text/css');
    const missing = await request('/__mock/elements/', { redirect: 'manual' });
    expect(missing.status).toBe(302);
    expect(missing.headers.get('Location')).toBe('/__mock/');
    const appSession = await sessionFor('timeline');
    expect((await request(`/__mock/elements/?mockSession=${appSession.id}`)).status).toBe(404);
  });

  it('exposes daemon-compatible catalogue, auth, access, and parsed snapshot shapes', async () => {
    const session = await sessionFor();
    const auth = await json('/-/api/auth', {}, session);
    expect(auth.expiresAt).toBeGreaterThan(Date.parse(session.scenario.now));
    const instances = await json('/-/api/instances', {}, session);
    expect(instances.map(item => item.id)).toEqual(expect.arrayContaining(['showcase', 'empty', 'malformed']));
    const instance = await json(instancePath, {}, session);
    expect(instance).toMatchObject({ id: 'showcase', name: expect.any(String), path: expect.any(String), address: 'showcase' });
    const snapshot = await json(`${instancePath}/data`, {}, session);
    expect(snapshot.instance.manifest.id).toBe('showcase');
    expect(snapshot.projects.length).toBeGreaterThan(0);
    expect(snapshot.actions.length).toBeGreaterThan(0);
    expect(instance.summary.actions.open).toBe(snapshot.actions.filter(([, record]) => !record.frontMatter.resolution).length);
    expect(snapshot.artifacts.length).toBeGreaterThan(0);
    expect(snapshot.searchProgress.complete).toBe(true);
    expect(instance.summary.entries).toBe(snapshot.weeks.reduce((count, [, entries]) => count + entries.length, 0));
    const access = await json(`${instancePath}/access`, {}, session);
    expect(access).toMatchObject({ fileBase: `/-/files/${session.id}/showcase`, fileKey: expect.any(String) });
    expect(await json(`${instancePath}/years`, {}, session)).toContain('2026');
  });

  it('uses the selected data world for empty onboarding and malformed-record diagnostics', async () => {
    for (const [scenario, expectedFixture] of [['empty-instance', 'empty'], ['diagnostics', 'malformed']]) {
      const session = await sessionFor(scenario);
      const address = new URL(session.url, server.url).pathname.split('/')[1];
      const endpoint = `/-/api/instances/${address}`;
      const snapshot = await json(`${endpoint}/data`, {}, session);
      const instance = await json(endpoint, {}, session);
      expect(snapshot.instance.manifest.id).toBe(expectedFixture);
      expect(instance.summary.projects.total).toBe(snapshot.indexes.projects.length);
      expect(instance.summary.actions.total).toBe(snapshot.indexes.actions.length);
      expect(instance.summary.entries).toBe(snapshot.indexes.notes.length);
      if (expectedFixture === 'empty') {
        expect(snapshot.weeks).toEqual([]);
        expect(snapshot.projects).toEqual([]);
        const query = await json(`${endpoint}/graphql`, post({ query: '{ projects { totalCount } actions { totalCount } }' }), session);
        expect(query.data).toMatchObject({ projects: { totalCount: 0 }, actions: { totalCount: 0 } });
      } else {
        expect(snapshot.diagnostics.length).toBeGreaterThan(0);
      }
      const manifest = await request(`${endpoint}/files/aside.md`, {}, session);
      expect(await manifest.text()).toContain(`id: ${expectedFixture}`);
    }
  });

  it('isolates faults and destructive-looking demo interactions, and recovers real retries', async () => {
    const healthy = await sessionFor(), broken = await sessionFor('chooser-error');
    expect((await request('/-/api/instances', {}, broken)).status).toBe(503);
    expect((await request('/-/api/instances', {}, healthy)).status).toBe(200);
    await json(`/__mock/session/${broken.id}/recover`, post({}));
    expect((await json(`/__mock/session/${broken.id}`)).scenario.faults).toEqual({});
    expect((await request('/-/api/instances', {}, broken)).status).toBe(200);

    const before = await json('/-/api/instances', {}, broken);
    await json('/-/api/instances/remove', post({ path: before[0].path }), broken);
    expect((await json('/-/api/instances', {}, broken)).some(item => item.path === before[0].path)).toBe(false);
    expect((await json('/-/api/instances', {}, healthy)).some(item => item.path === before[0].path)).toBe(true);

    const badFile = await sessionFor('file-error');
    expect((await request(`${instancePath}/files/${mediaPath}`, {}, badFile)).status).toBe(503);
    expect((await request(`${instancePath}/files/${mediaPath}`, {}, healthy)).status).toBe(200);
    await json(`/__mock/session/${badFile.id}/recover`, post({}));
    expect((await request(`${instancePath}/files/${mediaPath}`, {}, badFile)).status).toBe(200);
  });

  it('registers the requested fixture and restores a forgotten instance within its own session', async () => {
    const session = await sessionFor();
    const before = await json('/-/api/instances', {}, session);
    const empty = before.find(item => item.id === 'empty');
    const picked = await json('/-/api/instances/pick', post({ kind: 'directory' }), session);
    const showcase = before.find(item => item.path === picked.path);
    expect(showcase.id).toBe('showcase');
    for (const instance of [empty, showcase]) {
      await json('/-/api/instances/remove', post({ path: instance.path }), session);
      expect((await json('/-/api/instances', {}, session)).some(item => item.path === instance.path)).toBe(false);
      const registered = await json('/-/api/instances/register', post({ path: instance.path }), session);
      expect(registered.instance).toMatchObject({ id: instance.id, path: instance.path });
      expect((await json('/-/api/instances', {}, session)).some(item => item.path === instance.path)).toBe(true);
    }
    const invalid = await request('/-/api/instances/register', post({ path: '/outside/fixture' }), session);
    expect(invalid.status).toBe(400);
  });

  it('preserves recovered authentication state in the config used by a same-session reload', async () => {
    const session = await sessionFor('auth-required');
    expect((await request('/-/api/auth', {}, session)).status).toBe(401);
    await json(`/__mock/session/${session.id}/recover`, post({}));
    expect((await json(`/__mock/session/${session.id}`)).scenario.faults).toEqual({});
    expect((await request('/-/api/auth', {}, session)).status).toBe(200);
  });

  it('releases held requests when Recover changes the environment', async () => {
    const session = await sessionFor('chooser-loading');
    const loading = request('/-/api/instances', {}, session);
    expect(await Promise.race([loading.then(() => 'finished'), new Promise(resolve => setTimeout(() => resolve('held'), 25))])).toBe('held');
    await json(`/__mock/session/${session.id}/recover`, post({}));
    const response = await loading;
    expect(response.status).toBe(200);
    expect((await response.json()).length).toBeGreaterThan(0);
  });

  it('lets a recovered connection establish the normal event stream', async () => {
    const session = await sessionFor('reconnecting');
    const endpoint = `${instancePath}/watch`;
    expect((await request(endpoint, {}, session)).status).toBe(503);
    await json(`/__mock/session/${session.id}/recover`, post({}));
    const controller = new AbortController();
    const response = await request(endpoint, { signal: controller.signal }, session);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: auth');
    } finally { await reader.cancel(); controller.abort(); }
  });

  it('runs actual read-only GraphQL with aliases, variables, filtering and pagination for dashboards', async () => {
    const session = await sessionFor('dashboard');
    const result = await json(`${instancePath}/graphql`, post({
      query: `query Showcase($where: ActionWhere!, $offset: Int!, $limit: Int!) {
        completed: actions(where: $where, offset: $offset, limit: $limit, orderBy: CREATED_DESC) {
          offset count totalCount nodes { id name status }
        }
        projects(limit: 2) { totalCount nodes { id name } }
        artifacts(limit: 1) { totalCount }
      }`,
      variables: { where: { status: ['DONE'] }, offset: 0, limit: 1 }, operationName: 'Showcase',
    }), session);
    expect(result.errors).toBeUndefined();
    expect(result.data.completed).toMatchObject({ offset: 0, count: 1, totalCount: expect.any(Number) });
    expect(result.data.completed.nodes).toHaveLength(1);
    expect(result.data.completed.nodes[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), status: 'DONE' });
    expect(result.data.projects.nodes).toHaveLength(2);
    expect(result.data.projects.totalCount).toBeGreaterThan(2);
    expect(result.data.artifacts.totalCount).toBeGreaterThanOrEqual(4);
    expect(result.extensions.complete).toBe(true);
    const mutation = await json(`${instancePath}/graphql`, post({ query: 'mutation { __typename }' }), session);
    expect(mutation.errors.some(error => /only query operations|mutations.*unavailable/.test(error.message))).toBe(true);
    const discovery = await json(`${instancePath}/graphql`, post({ query: '{ activeInstance { id } }' }), session);
    expect(discovery.errors.some(error => error.message === 'Query.activeInstance is unavailable to webpages.')).toBe(true);
  });

  it('serves byte-identical files with HEAD, validators, ranges, and signed grants', async () => {
    const session = await sessionFor();
    const path = `${instancePath}/files/${mediaPath}`;
    const response = await request(path, {}, session);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(bytes.length).toBeGreaterThan(32);
    expect(response.headers.get('Content-Type')).toMatch(/^text\/plain/);
    const etag = response.headers.get('ETag');
    expect(etag).toBeTruthy();
    const head = await request(path, { method: 'HEAD' }, session);
    expect(head.status).toBe(200);
    expect(head.headers.get('ETag')).toBe(etag);
    expect(Number(head.headers.get('Content-Length'))).toBe(bytes.length);
    expect(await head.text()).toBe('');
    const unchanged = await request(path, { headers: { 'If-None-Match': etag } }, session);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    const partial = await request(path, { headers: { Range: 'bytes=2-7' } }, session);
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe(`bytes 2-7/${bytes.length}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.slice(2, 8));
    const suffix = await request(path, { headers: { Range: 'bytes=-5' } }, session);
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(-5));
    const invalid = await request(path, { headers: { Range: 'bytes=999999-' } }, session);
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('Content-Range')).toBe(`bytes */${bytes.length}`);

    const { fileBase, fileKey } = await json(`${instancePath}/access`, {}, session);
    const signed = grantUrl(fileBase, fileKey, mediaPath);
    const publicFile = await request(signed);
    expect(publicFile.status).toBe(200);
    expect(new Uint8Array(await publicFile.arrayBuffer())).toEqual(bytes);
    expect((await request(signed.replace(/notes\.md$/, 'other.md'))).status).toBe(401);
    expect((await request(signed.replace('/files/', '/files/missing-'))).status).toBe(401);
  });

  it('confines files to their fixture root and preserves an opaque origin for HTML and SVG', async () => {
    const session = await sessionFor();
    for (const path of [
      '%2e%2e%2fserver.mjs', '%2e%2e%2f%2e%2e%2fserver.mjs',
      '%2fetc%2fpasswd', 'artifacts%5c..%5c..%5cserver.mjs',
    ]) {
      const response = await request(`${instancePath}/files/${path}`, {}, session);
      expect([400, 403, 404]).toContain(response.status);
    }
    for (const file of [
      'artifacts/2026/2026-10-12-media/aurora.svg',
      'artifacts/2026/2026-10-12-dashboard/index.html',
    ]) {
      const response = await request(`${instancePath}/files/${file}`, {}, session);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts');
    }
  });
});
