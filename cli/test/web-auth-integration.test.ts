import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsideWebServer, type WebBackend } from '../src/web/server.js';
import { WebAuth, WEB_AUTH_LEASE_MS } from '../src/web/auth.js';
import { grantUrl } from '../../webapp/src/file-grants.js';
import { openHandoffBridge } from './helpers/browser-handoff.js';
import { WEB_HANDOFF_LIFETIME_MS } from '../src/web/handoff.js';

let directory: string, state: string, instance: string, app: string;
let server: AsideWebServer;
let now = Date.now();

function request(target: string, options: { method?: string; body?: string; token?: string; origin?: string; control?: boolean; omitOrigin?: boolean } = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.port, path: target,
      method: options.method ?? 'GET', agent: false,
      headers: { Host: `localhost:${server.port}`, ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.control ? { 'X-Aside-Control': '1' } : {}),
        ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(options.body),
          ...(!options.omitOrigin ? {Origin: options.origin ?? 'null'} : {}) } : {}) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function backend(): WebBackend {
  return {
    instances: () => [{ id: 'audit-fixture', path: instance }], register: async () => null,
    remove: () => {}, load: () => {}, data: async () => { throw new Error('Unexpected record read.'); },
  };
}

function controlStream(token: string) {
  return new Promise<{ text(): string; close(): void }>((resolve, reject) => {
    let text = '';
    const req = http.get({ hostname: '127.0.0.1', port: server.port, path: '/-/api/instances/audit-fixture/control',
      agent: false,
      headers: { Host: `localhost:${server.port}`, Authorization: `Bearer ${token}` },
    }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error('Control stream rejected.')); return; }
      response.on('data', chunk => {
        text += chunk.toString();
        if (text.includes('event: auth\n')) { clearTimeout(timeout); resolve({ text: () => text, close: () => { response.destroy(); req.destroy(); } }); }
      });
      response.on('error', reject);
    });
    const timeout = setTimeout(() => { req.destroy(); reject(new Error('Control stream did not initialize.')); }, 2000);
    req.on('error', error => { clearTimeout(timeout); reject(error); });
  });
}

async function handoff(launchUrl: string | undefined) {
  expect(launchUrl).toMatch(/^file:\/\//);
  const file = fileURLToPath(launchUrl!);
  const html = await fs.readFile(file, 'utf8');
  const code = html.match(/name="code" value="([A-Za-z0-9_-]+)"/)![1];
  return { file, body: new URLSearchParams({ code }).toString() };
}

async function openBrowser(body: string, savedToken: string | null = null) {
  const response = await request('/-/auth/complete', {method: 'POST', body});
  expect(response.status).toBe(200);
  expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
  return openHandoffBridge(server.origin, response.body, savedToken);
}

async function start(port = 0): Promise<AsideWebServer> {
  const value = await AsideWebServer.start(app, backend(), port, { stateDirectory: state, auth: new WebAuth(state, () => now) });
  if (!value) throw new Error('Test HTTP listener is unavailable.');
  return value;
}

beforeAll(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'aside-web-auth-integration-')));
  state = path.join(directory, 'state'); instance = path.join(directory, 'instance'); app = path.join(directory, 'app');
  await Promise.all([state, instance, app].map(dir => fs.mkdir(dir, { mode: 0o700 })));
  await fs.mkdir(path.join(instance, 'artifacts/2026/2026-10-02-report/images'), { recursive: true });
  await fs.mkdir(path.join(instance, 'assets'));
  await Promise.all([
    fs.writeFile(path.join(app, 'index.html'), '<!doctype html><title>Aside test</title>'),
    fs.writeFile(path.join(instance, 'aside.md'), 'SYNTHETIC_PRIVATE_MANIFEST'),
    fs.writeFile(path.join(instance, 'artifacts/2026/private.md'), 'SYNTHETIC_PRIVATE_SIBLING'),
    fs.writeFile(path.join(instance, 'artifacts/2026/2026-10-02-report/index.html'), '<img src="images/chart.svg">'),
    fs.writeFile(path.join(instance, 'artifacts/2026/2026-10-02-report/images/chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    fs.writeFile(path.join(directory, 'outside.svg'), '<svg xmlns="http://www.w3.org/2000/svg">outside</svg>'),
    fs.symlink(path.join(instance, 'artifacts/2026/2026-10-02-report/images/chart.svg'), path.join(instance, 'artifacts/2026/2026-10-02-report/chart-alias.svg')),
    fs.symlink(path.join(instance, 'artifacts/2026/2026-10-02-report/images/chart.svg'), path.join(instance, 'assets/chart-alias.svg')),
    fs.symlink(path.join(directory, 'outside.svg'), path.join(instance, 'artifacts/2026/2026-10-02-report/outside.svg')),
    fs.symlink(path.join(instance, 'artifacts/2026/private.md'), path.join(instance, 'artifacts/2026/2026-10-02-report/linked.md')),
  ]);
  server = await start();
});
afterAll(async () => {
  server?.close();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

describe('HTTP show authorization integration', () => {
  it('gates reads before an automatic, one-use handoff', async () => {
    expect(server.origin).toBe(`http://localhost:${server.port}`);
    expect((await request('/-/api/instances')).status).toBe(401);
    expect((await request('/-/api/instances/audit-fixture/files/aside.md')).status).toBe(401);
    const shell = await request('/audit-fixture/project/private');
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    const shown = await server.show(instance, 'audit-fixture/project/private');
    expect(shown.url).toBe(`${server.origin}/audit-fixture/project/private`);
    expect(new URL(shown.url).search).toBe('');
    const handoffFile = fileURLToPath(shown.launchUrl!);
    expect((await fs.stat(handoffFile)).mode & 0o777).toBe(0o600);
    const html = await fs.readFile(handoffFile, 'utf8');
    const code = html.match(/name="code" value="([A-Za-z0-9_-]+)"/)![1];
    expect(path.basename(handoffFile)).not.toContain(code);
    expect(shown.url).not.toContain(code);
    const body = new URLSearchParams({ code }).toString();
    await expect(fs.access(path.join(state, 'web-auth.json'))).rejects.toMatchObject({code: 'ENOENT'});
    const completion = await openBrowser(body);
    expect(completion.destination).toBe('/audit-fixture/project/private');
    expect(completion.writes).toBe(1);
    const token = completion.token!;
    expect(shown.launchUrl).not.toContain(token);
    expect((await request('/-/auth/complete', { method: 'POST', body })).status).toBe(401);
    await expect(fs.access(handoffFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).not.toContain(token);

    const accessResponse = await request('/-/api/instances/audit-fixture/access', { token });
    expect(accessResponse.status).toBe(200);
    const access = JSON.parse(accessResponse.body) as { fileBase: string; fileKey: string };
    const htmlUrl = grantUrl(access.fileBase, access.fileKey, 'artifacts/2026/2026-10-02-report/index.html');
    const svgUrl = grantUrl(access.fileBase, access.fileKey, 'artifacts/2026/2026-10-02-report/images/chart.svg');
    expect((await request(htmlUrl)).status).toBe(200);
    const aliasUrl = grantUrl(access.fileBase, access.fileKey, 'artifacts/2026/2026-10-02-report/chart-alias.svg');
    expect((await request(aliasUrl)).status).toBe(404);
    expect((await request(aliasUrl, { method: 'HEAD' })).status).toBe(404);
    const assetAliasUrl = grantUrl(access.fileBase, access.fileKey, 'assets/chart-alias.svg');
    const aliasResponse = await request(assetAliasUrl);
    expect(aliasResponse.status).toBe(200);
    expect(aliasResponse.body).toBe((await request(svgUrl)).body);
    expect((await request(assetAliasUrl, { method: 'HEAD' })).status).toBe(200);
    const outsideUrl = grantUrl(access.fileBase, access.fileKey, 'artifacts/2026/2026-10-02-report/outside.svg');
    expect((await request(outsideUrl)).status).toBe(404);
    const relative = (file: string) => new URL(file, `${server.origin}${htmlUrl}`).pathname;
    expect((await request(relative('images/chart.svg'))).status).toBe(200);
    expect((await request(relative('../private.md'))).status).toBe(401);
    expect((await request(relative('linked.md'))).status).toBe(401);
    expect((await request(new URL('../../../../../aside.md', `${server.origin}${svgUrl}`).pathname)).status).toBe(401);

    // A restart preserves the same origin, browser token, and file URLs.
    const port = server.port;
    server.close();
    await new Promise<void>(resolve => setImmediate(resolve));
    server = await start(port);
    expect((await request('/-/api/instances', { token })).status).toBe(200);
    expect((await request(htmlUrl)).status).toBe(200);
    expect((await request(svgUrl)).status).toBe(200);
    expect(JSON.parse((await request('/-/api/instances/audit-fixture/access', { token })).body)).toEqual(access);

    now += WEB_AUTH_LEASE_MS;
    expect((await request('/-/api/instances', { token })).status).toBe(401);
    expect((await request(htmlUrl)).status).toBe(401);
    expect((await request(svgUrl)).status).toBe(401);
  });

  it('prepares independent handoffs without navigating or renewing a connected browser', async () => {
    const auth = new WebAuth(state, () => now);
    const credential = auth.issue();
    const stream = await controlStream(credential.token);
    try {
      now += 24 * 60 * 60 * 1000;
      expect((await request('/-/api/instances', { token: credential.token })).status).toBe(200);
      expect((await request('/-/api/auth', { token: credential.token })).status).toBe(200);
      expect(auth.authorize(credential.token)?.expiresAt).toBe(credential.expiresAt);
      const initialStream = stream.text();
      const savedBefore = await fs.readFile(path.join(state, 'web-auth.json'), 'utf8');

      const bookmark = await server.show(instance, 'audit-fixture/project/bookmark', false);
      expect(bookmark).toEqual({ url: `${server.origin}/audit-fixture/project/bookmark`, tab: false });
      expect(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).toBe(savedBefore);
      expect(await fs.readdir(path.join(state, 'web/handoffs'))).toEqual([]);

      const shown = await server.show(instance, 'audit-fixture/project/renewed');
      const second = await server.show(instance, 'audit-fixture/action/another-browser');
      expect(shown.tab).toBe(false);
      expect(second.tab).toBe(false);
      expect(second.launchUrl).not.toBe(shown.launchUrl);
      expect(shown.url).toBe(`${server.origin}/audit-fixture/project/renewed`);
      expect(auth.authorize(credential.token)).toEqual({ id: credential.id, expiresAt: credential.expiresAt });
      expect(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).toBe(savedBefore);

      const firstHandoff = await handoff(shown.launchUrl);
      const secondHandoff = await handoff(second.launchUrl);
      const firstCompletion = await openBrowser(firstHandoff.body);
      const secondCompletion = await openBrowser(secondHandoff.body);
      expect(firstCompletion.destination).toBe('/audit-fixture/project/renewed');
      expect(secondCompletion.destination).toBe('/audit-fixture/action/another-browser');
      const firstToken = firstCompletion.token!;
      const secondToken = secondCompletion.token!;
      expect(new Set([credential.token, firstToken, secondToken]).size).toBe(3);
      expect((await request('/-/api/instances', { token: firstToken })).status).toBe(200);
      expect((await request('/-/api/instances', { token: secondToken })).status).toBe(200);
      expect(auth.authorize(credential.token)?.expiresAt).toBe(credential.expiresAt);
      expect(stream.text()).toBe(initialStream);
      expect((await request('/-/auth/complete', { method: 'POST', body: firstHandoff.body })).status).toBe(401);
      expect((await request('/-/auth/complete', { method: 'POST', body: secondHandoff.body })).status).toBe(401);
      expect(await fs.readdir(path.join(state, 'web/handoffs'))).toEqual([]);
    } finally { stream.close(); }
  });

  it('reauthorizes an expired browser through a fresh handoff to the requested destination', async () => {
    const auth = new WebAuth(state, () => now);
    const expired = auth.issue();
    now += WEB_AUTH_LEASE_MS;
    expect((await request('/-/api/instances', { token: expired.token })).status).toBe(401);

    const shown = await server.show(instance, 'audit-fixture/project/reauthorized?entry=private');
    const prepared = await handoff(shown.launchUrl);
    const completion = await openBrowser(prepared.body, expired.token);
    expect(completion.destination).toBe('/audit-fixture/project/reauthorized?entry=private');
    const token = completion.token!;
    expect(token).not.toBe(expired.token);
    expect(auth.authorize(token)?.expiresAt).toBe(now + WEB_AUTH_LEASE_MS);
    expect((await request('/-/api/instances', { token })).status).toBe(200);
    expect((await request('/-/api/instances', { token: expired.token })).status).toBe(401);
    expect((await request('/-/auth/complete', { method: 'POST', body: prepared.body })).status).toBe(401);
    await expect(fs.access(prepared.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renews only the opening browser without rotating its token or adding session records', async () => {
    const auth = new WebAuth(state, () => now), current = auth.issue(), other = auth.issue();
    const key = auth.fileKey(current.id, instance);
    const count = JSON.parse(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).sessions.length;
    const stream = await controlStream(current.token);
    try {
      now += 24 * 60 * 60 * 1000;
      for (let opening = 0; opening < 3; opening++) {
        const shown = await server.show(instance, `audit-fixture/project/repeated-${opening}`);
        const prepared = await handoff(shown.launchUrl);
        const browser = await openBrowser(prepared.body, current.token);
        expect(browser.token).toBe(current.token);
        expect(browser.writes).toBe(0);
        expect(browser.destination).toBe(`/audit-fixture/project/repeated-${opening}`);
      }
      expect(JSON.parse(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).sessions).toHaveLength(count);
      expect(auth.authorize(current.token)).toEqual({id: current.id, expiresAt: now + WEB_AUTH_LEASE_MS});
      expect(auth.authorize(other.token)).toEqual({id: other.id, expiresAt: other.expiresAt});
      expect(auth.fileKey(current.id, instance)).toBe(key);
      await vi.waitFor(() => expect(stream.text()).toContain(`"expiresAt":${now + WEB_AUTH_LEASE_MS}`));
      expect(stream.text()).not.toContain('"navigate"');
    } finally { stream.close(); }
  });

  it('keeps unopened and expired handoffs out of the persistent session registry', async () => {
    const before = await fs.readFile(path.join(state, 'web-auth.json'), 'utf8');
    const prepared = await Promise.all(Array.from({length: 8}, async () =>
      handoff((await server.show(instance, 'audit-fixture/project/unopened')).launchUrl)));
    expect(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).toBe(before);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + WEB_HANDOFF_LIFETIME_MS + 1);
    try {
      for (const pending of prepared) {
        expect((await request('/-/auth/complete', {method: 'POST', body: pending.body})).status).toBe(401);
        await expect(fs.access(pending.file)).rejects.toMatchObject({code: 'ENOENT'});
      }
    } finally { clock.mockRestore(); }
    expect(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).toBe(before);
  });

  it('requires a live private code and same-origin control before consuming a redemption', async () => {
    const auth = new WebAuth(state, () => now), current = auth.issue();
    now += 24 * 60 * 60 * 1000;
    const prepared = await handoff((await server.show(instance, 'audit-fixture/project/guarded')).launchUrl);
    const before = await fs.readFile(path.join(state, 'web-auth.json'), 'utf8');
    expect((await request('/-/auth/redeem')).status).toBe(405);
    for (const headers of [{origin: 'null', control: true}, {origin: 'https://other.example', control: true},
      {omitOrigin: true, control: true}, {origin: server.origin}]) {
      const rejected = await request('/-/auth/redeem', {method: 'POST', body: prepared.body, token: current.token, ...headers});
      expect(rejected.status).toBe(403);
      expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).toBe(before);
    expect(auth.authorize(current.token)?.expiresAt).toBe(current.expiresAt);
    expect((await request('/-/auth/redeem', {method: 'POST', body: 'code=' + 'x'.repeat(2048),
      token: current.token, origin: server.origin, control: true})).status).toBe(413);

    const redeem = (body = prepared.body) => request('/-/auth/redeem', {method: 'POST', body,
      token: current.token, origin: server.origin, control: true});
    const responses = await Promise.all([redeem(), redeem()]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
    const success = JSON.parse(responses.find(response => response.status === 200)!.body);
    expect(success).toMatchObject({token: current.token, route: '/audit-fixture/project/guarded'});
    expect((await redeem('code=unknown')).status).toBe(401);
    expect(auth.authorize(current.token)?.expiresAt).toBe(now + WEB_AUTH_LEASE_MS);
    expect(JSON.parse(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).sessions).toHaveLength(JSON.parse(before).sessions.length);
  });

  it('keeps expired completion pages from installing or renewing browser access', async () => {
    const auth = new WebAuth(state, () => now), current = auth.issue();
    const prepared = await handoff((await server.show(instance, 'audit-fixture/project/stale-bridge')).launchUrl);
    const bridge = await request('/-/auth/complete', {method: 'POST', body: prepared.body});
    expect(bridge.status).toBe(200);
    const before = await fs.readFile(path.join(state, 'web-auth.json'), 'utf8');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + WEB_HANDOFF_LIFETIME_MS + 1);
    try {
      const browser = await openHandoffBridge(server.origin, bridge.body, current.token);
      expect(browser.writes).toBe(0);
      expect(browser.destination).toBeUndefined();
      expect(browser.error).toContain('request a new showUrl');
      expect(await fs.readFile(path.join(state, 'web-auth.json'), 'utf8')).toBe(before);
      await expect(fs.access(prepared.file)).rejects.toMatchObject({code: 'ENOENT'});
    } finally { clock.mockRestore(); }
  });
});
