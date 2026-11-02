import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/mcp/store.js';
import { buildShowRoute } from '../src/mcp/tools/show.js';
import { startWeb as startAuthenticatedWeb } from '../src/web/locate.js';
import { WebAuth, WEB_AUTH_LEASE_MS, type WebCredential } from '../src/web/auth.js';
import { availableInstances, registrationPath } from '../src/web/catalogue.js';
import { APP_SHELL_CSP, type AsideWebServer, type WebBackend } from '../src/web/server.js';

const APP_DIR = fileURLToPath(new URL('../../webapp', import.meta.url));

const webAuth = new Map<number, {auth: WebAuth; directory: string; credential: WebCredential}>();
const authDirectories: string[] = [];
afterAll(() => { for (const directory of authDirectories) rmSync(directory, {recursive: true, force: true}); });

async function startWeb(app: string, backend: WebBackend, port: number, clock: () => number = Date.now): Promise<AsideWebServer> {
  const directory = mkdtempSync(join(tmpdir(), 'aside-web-test-auth-'));
  authDirectories.push(directory);
  const auth = new WebAuth(directory, clock);
  const server = await startAuthenticatedWeb(app, backend, port, {auth, stateDirectory: directory});
  webAuth.set(server.port, {auth, directory, credential: auth.issue()});
  return server;
}

function authHeaders(port: number, supplied: Record<string, string> = {}): Record<string, string> {
  return {Authorization: `Bearer ${webAuth.get(port)!.credential.token}`, ...supplied};
}

function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${webAuth.get(Number(new URL(url).port))!.credential.token}`);
  return globalThis.fetch(url, {...options, headers});
}


// A minimal instance: one project, one action, two entries, one asset.
function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'notes', '2026'), { recursive: true });
  mkdirSync(join(dir, 'projects', '2026'), { recursive: true });
  mkdirSync(join(dir, 'actions', '2026'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'aside.md'), `---\nid: web-test\nname: "Web Test"\ndescription: "web server test instance"\nversion: 1\n---\n`);
  writeFileSync(
    join(dir, 'notes', '2026', 'index.yaml'),
    `- id: "2026-04-28T10:00"\n  description: "Alpha work"\n- id: "2026-04-29T14:00"\n  description: "More work"\n`
  );
  writeFileSync(
    join(dir, 'notes', '2026', '2026-04-27.md'),
    `---\nweek: 18\nweek_start: "2026-04-27"\nweek_end: "2026-05-03"\n---\n\n\`\`\`entry\ncreated: "2026-04-28T10:00"\nprojects:\n  - 2026-01-15-alpha\nactions:\n  - 2026-01-20-ship-it\n\`\`\`\n\nWorked on alpha. See [notes](../../assets/notes.md).\n\n---\n\n\`\`\`entry\ncreated: "2026-04-29T14:00"\n\`\`\`\n\nUntagged entry.\n`
  );
  writeFileSync(join(dir, 'projects', '2026', 'index.yaml'), `- id: 2026-01-15-alpha\n  description: "Alpha project"\n`);
  writeFileSync(join(dir, 'projects', '2026', '2026-01-15-alpha.md'), `---\nname: "Alpha"\ncreated: "2026-01-15T09:00"\n---\n\nAlpha body.\n`);
  writeFileSync(join(dir, 'actions', '2026', 'index.yaml'), `- id: 2026-01-20-ship-it\n  description: "Ship it"\n`);
  writeFileSync(join(dir, 'actions', '2026', '2026-01-20-ship-it.md'), `---\nname: "Ship it"\ncreated: "2026-01-20T09:00"\n---\n\nShip body.\n`);
  writeFileSync(join(dir, 'assets', 'notes.md'), `# Notes\n`);
  mkdirSync(join(dir, 'artifacts', '2026', '2026-10-02-report'), { recursive: true });
  writeFileSync(join(dir, 'artifacts', '2026', 'index.yaml'), '- id: 2026-10-02-report\n  description: Current report\n');
  writeFileSync(join(dir, 'artifacts', '2026', '2026-10-02-report.md'), '---\nname: Current report\ncreated: "2026-10-02T09:00"\n---\n\nReport body.\n');
  for (const filename of ['100% done #1.png', 'summary.PDF', 'clip.mp4', 'voice.m4a', 'voice.aac', 'voice.opus', 'voice.weba', 'clip.ogv', 'captions.VTT', 'index.HTML', 'index.htm', 'unknown.bin']) {
    writeFileSync(join(dir, 'artifacts', '2026', '2026-10-02-report', filename), 'file bytes');
  }
  for (const filename of ['script.svg', 'script.SvG']) {
    writeFileSync(join(dir, 'artifacts', '2026', '2026-10-02-report', filename), '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title = "Aside SVG fixture";</script></svg>');
  }
  symlinkSync(join(dir, 'assets', 'notes.md'), join(dir, 'artifacts', '2026', '2026-10-02-report', 'linked.md'));
  for (const relative of ['projects/reference/logo.svg', 'projects/2026/support/file.pdf',
    'projects/2026/diagram.svg', 'artifacts/2026/2026-10-02-report/images/chart.svg']) {
    mkdirSync(join(dir, relative, '..'), { recursive: true });
    symlinkSync(join(dir, 'assets', 'notes.md'), join(dir, relative));
  }
}

describe('buildShowRoute', () => {
  let dir: string;
  let store: Store;

  beforeAll(() => {
    dir = join(tmpdir(), `aside-web-route-${Date.now()}`);
    writeFixture(dir);
    store = new Store(dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds every route shape', () => {
    expect(buildShowRoute(store, {})).toBe('');
    expect(buildShowRoute(store, { project: '2026-01-15-alpha' })).toBe('project/2026-01-15-alpha');
    expect(buildShowRoute(store, { project: '2026-01-15-alpha', detail: true })).toBe('project/2026-01-15-alpha/detail');
    expect(buildShowRoute(store, { action: '2026-01-20-ship-it' })).toBe('action/2026-01-20-ship-it');
    expect(buildShowRoute(store, { entry: '2026-04-28T10:00' })).toBe('2026-04-28T10:00');
    expect(buildShowRoute(store, { project: '2026-01-15-alpha', entry: '2026-04-28T10:00' })).toBe('project/2026-01-15-alpha/2026-04-28T10:00');
    expect(buildShowRoute(store, { asset: 'assets/notes.md' })).toBe('asset/assets/notes.md');
    expect(buildShowRoute(store, { project: '2026-01-15-alpha', asset: 'assets/notes.md' })).toBe('project/2026-01-15-alpha/asset/assets/notes.md');
  });

  it('opens artifacts and exact attachments while preserving project/action scope', () => {
    expect(buildShowRoute(store, { artifact: '2026-10-02-report' })).toBe('artifact/2026-10-02-report');
    expect(buildShowRoute(store, { project: '2026-01-15-alpha', artifact: '2026-10-02-report' })).toBe('project/2026-01-15-alpha/artifact/2026-10-02-report');
    expect(buildShowRoute(store, { action: '2026-01-20-ship-it', artifact: '2026-10-02-report', filename: '100% done #1.png' })).toBe('action/2026-01-20-ship-it/artifact/2026-10-02-report/100%25%20done%20%231.png');
  });

  it('rejects malformed or missing artifact targets and conflicting documents', () => {
    expect(() => buildShowRoute(store, { filename: 'summary.PDF' })).toThrow(/pass artifact/);
    expect(() => buildShowRoute(store, { artifact: '2026-10-02-report', entry: '2026-04-28T10:00' })).toThrow(/mutually exclusive/);
    expect(() => buildShowRoute(store, { artifact: '2026-10-02-report', asset: 'assets/notes.md' })).toThrow(/mutually exclusive/);
    expect(() => buildShowRoute(store, { artifact: '2026-10-02-missing' })).toThrow(/query_artifacts/);
    expect(() => buildShowRoute(store, { artifact: 'not-an-id' })).toThrow(/Invalid artifact id/);
    for (const filename of ['../notes.md', 'folder/notes.md', 'missing.md', 'linked.md']) {
      expect(() => buildShowRoute(store, { artifact: '2026-10-02-report', filename })).toThrow();
    }
  });

  it('rejects invalid combinations', () => {
    expect(() => buildShowRoute(store, { project: '2026-01-15-alpha', action: '2026-01-20-ship-it' })).toThrow(/not both/);
    expect(() => buildShowRoute(store, { detail: true })).toThrow(/pass project or action/);
    expect(() => buildShowRoute(store, { project: '2026-01-15-alpha', detail: true, entry: '2026-04-28T10:00' })).toThrow(/mutually exclusive/);
  });

  it('rejects unknown targets with hints', () => {
    expect(() => buildShowRoute(store, { project: 'nope' })).toThrow(/query_projects/);
    expect(() => buildShowRoute(store, { action: 'nope' })).toThrow(/query_actions/);
    expect(() => buildShowRoute(store, { entry: '2020-01-01T00:00' })).toThrow(/query_entries/);
    expect(() => buildShowRoute(store, { asset: 'assets/missing.md' })).toThrow(/not found/);
    expect(() => buildShowRoute(store, { asset: '../outside.md' })).toThrow(/not found/);
  });

  it('rejects directories and escaping symlinks before opening a reader', () => {
    const outside = `${dir}-outside.md`, linked = join(dir, 'assets', 'outside.md');
    writeFileSync(outside, 'Outside the instance.');
    symlinkSync(outside, linked);
    try {
      expect(() => buildShowRoute(store, { asset: 'assets' })).toThrow(/file inside this instance/);
      expect(() => buildShowRoute(store, { asset: 'assets/outside.md' })).toThrow(/file inside this instance/);
    } finally { rmSync(linked); rmSync(outside); }
  });

  it('allows asset symlinks whose target remains inside the instance', () => {
    const linked = join(dir, 'assets', 'linked-notes.md');
    symlinkSync(join(dir, 'assets', 'notes.md'), linked);
    try { expect(buildShowRoute(store, { asset: 'assets/linked-notes.md' })).toBe('asset/assets/linked-notes.md'); }
    finally { rmSync(linked); }
  });

  it('keeps user-reference symlinks available outside the managed layout', () => {
    for (const asset of ['projects/reference/logo.svg', 'projects/2026/support/file.pdf',
      'projects/2026/diagram.svg', 'artifacts/2026/2026-10-02-report/images/chart.svg']) {
      expect(buildShowRoute(store, { asset })).toBe(`asset/${asset}`);
    }
  });

  it('rejects a symlinked managed manifest even when its target is inside the instance', () => {
    const outside = join(dir, 'manifest-source.md'), manifest = join(dir, 'aside.md');
    writeFileSync(outside, '---\nid: web-test\n---\n');
    rmSync(manifest); symlinkSync(outside, manifest);
    try { expect(() => buildShowRoute(store, { asset: 'aside.md' })).toThrow(/not found or unavailable/); }
    finally { rmSync(manifest); writeFileSync(manifest, '---\nid: web-test\n---\n'); rmSync(outside); }
  });

  it('rejects show attachment and raw managed paths through an in-instance directory symlink', () => {
    const directory = join(dir, 'artifacts', '2026', '2026-10-02-report');
    const saved = join(dir, 'saved-report');
    renameSync(directory, saved); symlinkSync(saved, directory);
    try {
      expect(() => buildShowRoute(store, { artifact: '2026-10-02-report', filename: 'summary.PDF' })).toThrow(/not found/);
      expect(() => buildShowRoute(store, { asset: 'artifacts/2026/2026-10-02-report/summary.PDF' })).toThrow(/not found/);
    } finally { rmSync(directory); renameSync(saved, directory); }
  });

  it('rejects managed symlinks through filesystem case aliases in show routes', ({ skip }) => {
    if (!existsSync(join(dir, 'ARTIFACTS'))) skip();
    expect(() => buildShowRoute(store, { asset: 'ARTIFACTS/2026/2026-10-02-report/linked.md' })).toThrow(/not found/);
    const manifest = join(dir, 'aside.md'), saved = join(dir, 'saved-manifest.md');
    renameSync(manifest, saved); symlinkSync(saved, manifest);
    try { expect(() => buildShowRoute(store, { asset: 'ASIDE.MD' })).toThrow(/not found/); }
    finally { rmSync(manifest); renameSync(saved, manifest); }
  });
});

// Raw request helper — unlike fetch it lets us set the Host header and read
// SSE streams incrementally.
function rawGet(port: number, path: string, headers: Record<string, string> = {}, authenticated = true): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: authenticated ? authHeaders(port, headers) : headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

// Open an SSE stream; `next()` resolves with the following data event.
function openSse(port: number, path: string): Promise<{ next: () => Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: authHeaders(port) }, (res) => {
      let buffer = '';
      const queue: string[] = [];
      const waiters: ((v: string) => void)[] = [];
      res.on('data', (c: Buffer) => {
        buffer += c.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (/^event:/m.test(block)) continue; // Named authentication lifecycle events.
          const m = block.match(/^data: (.*)$/m);
          if (!m) continue; // retry:/ping blocks
          const waiter = waiters.shift();
          if (waiter) waiter(m[1]);
          else queue.push(m[1]);
        }
      });
      resolve({
        next: () => {
          const queued = queue.shift();
          if (queued !== undefined) return Promise.resolve(queued);
          return new Promise<string>((resolveNext, rejectNext) => {
            waiters.push(resolveNext);
            setTimeout(() => rejectNext(new Error('SSE timeout')), 5000).unref();
          });
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

// Push a route the way a local process does: POST /-/api/instances/web-test/control with the header.
async function postNavigate(port: number, route: string): Promise<boolean> {
  const res = await authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances/web-test/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Aside-Control': '1' },
    body: JSON.stringify({ navigate: route }),
  });
  return !!((await res.json()) as { tab?: boolean }).tab;
}

describe('public app assets', () => {
  let directory: string;
  let app: string;
  let server: AsideWebServer;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aside-web-public-assets-'));
    app = join(directory, 'app');
    mkdirSync(join(app, 'dist', 'chunks', 'deep'), { recursive: true });
    mkdirSync(join(app, 'dist', '.cache'), { recursive: true });
    writeFileSync(join(app, 'style.css'), 'source stylesheet');
    writeFileSync(join(app, 'package.json'), 'app source metadata');
    writeFileSync(join(directory, 'outside.txt'), 'outside app');
    for (const [relative, body] of [
      ['style.css', 'body { color: navy; }'],
      ['chunks/deep/diagram-ABCD1234.js', 'export const diagram = "local module";'],
      ['chunks/deep/資料 100%.future', 'arbitrary build output'],
      ['.secret', 'hidden build file'],
      ['.cache/data.bin', 'hidden build directory'],
      ['chunks/deep/.style.css.123.tmp', 'hidden staged build output'],
    ]) writeFileSync(join(app, 'dist', relative), body);
    symlinkSync(join(app, 'dist', 'style.css'), join(app, 'dist', 'linked-inside.css'));
    symlinkSync(join(directory, 'outside.txt'), join(app, 'dist', 'linked-outside.txt'));
    symlinkSync(join(app, 'dist', 'chunks'), join(app, 'dist', 'linked-chunks'));
    symlinkSync(directory, join(app, 'dist', 'linked-outside-directory'));
    server = await startWeb(app, { instances: () => [], register: async () => null, remove: () => {}, load: () => {},
      data: async () => { throw new Error('No data fixture'); } }, 0);
  });

  afterAll(() => {
    server?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('serves ordinary build files without authorization or a filename/extension allowlist', async () => {
    for (const [relative, body, type] of [
      ['style.css', 'body { color: navy; }', 'text/css; charset=utf-8'],
      ['chunks/deep/diagram-ABCD1234.js', 'export const diagram = "local module";', 'text/javascript; charset=utf-8'],
      ['chunks/deep/資料 100%.future', 'arbitrary build output', 'application/octet-stream'],
    ]) {
      const path = '/-/assets/' + relative.split('/').map(encodeURIComponent).join('/');
      const response = await rawGet(server.port, path, {}, false);
      expect(response.status, path).toBe(200);
      expect(response.body).toBe(body);
      expect(response.headers['content-type']).toBe(type);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('preserves HEAD and conditional caching for public build files', async () => {
    const path = '/-/assets/chunks/deep/diagram-ABCD1234.js';
    const response = await rawGet(server.port, path, {}, false);
    expect(response.headers.etag).toBeDefined();
    const head = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(response.headers.etag);
    expect(head.headers.get('content-type')).toBe(response.headers['content-type']);
    expect(await head.text()).toBe('');
    for (const method of ['GET', 'HEAD']) {
      const cached = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method, headers: { 'If-None-Match': response.headers.etag! },
      });
      expect(cached.status, method).toBe(304);
      expect(cached.headers.get('etag')).toBe(response.headers.etag);
      expect(await cached.text()).toBe('');
    }
  });

  it('rejects traversal, hidden paths, malformed components, directories and missing files', async () => {
    for (const relative of [
      '%2e%2e%2fpackage.json', '%2e%2e%2fstyle.css', '%2e%2e%2f%2e%2e%2foutside.txt',
      'chunks%2f%2e%2e%2fstyle.css', '%2fstyle.css',
      './style.css', '%2e/style.css', 'chunks/../style.css', 'chunks/%2e%2e/style.css',
      'chunks\\..\\style.css',
      '.secret', '%2esecret', '.cache/data.bin', 'chunks/%2e%2ecache/data.bin',
      'chunks/deep/.style.css.123.tmp', 'chunks//deep/diagram-ABCD1234.js',
      'chunks%5cdeep%5cdiagram-ABCD1234.js', 'style.css%00',
      '', 'chunks', 'chunks/deep/', 'missing.js',
    ]) {
      const response = await rawGet(server.port, '/-/assets/' + relative, {}, false);
      expect(response.status, relative).toBe(404);
      expect(response.body).not.toContain('app source metadata');
      expect(response.body).not.toContain('outside app');
      expect(response.body).not.toContain('hidden build');
    }
  });

  it('rejects file and directory symlinks even when their targets are within dist', async () => {
    for (const relative of ['linked-inside.css', 'linked-outside.txt',
      'linked-chunks/deep/diagram-ABCD1234.js', 'linked-outside-directory/outside.txt']) {
      expect((await rawGet(server.port, '/-/assets/' + relative, {}, false)).status, relative).toBe(404);
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', async () => {
    const pipe = join(app, 'dist', 'pipe.bin');
    execFileSync('mkfifo', [pipe]);
    try {
      expect((await rawGet(server.port, '/-/assets/pipe.bin', {}, false)).status).toBe(404);
    } finally { rmSync(pipe); }
  });

  it('rejects a symlinked dist root', async () => {
    const dist = join(app, 'dist'), saved = join(app, 'saved-dist');
    renameSync(dist, saved);
    symlinkSync(saved, dist);
    try {
      expect((await rawGet(server.port, '/-/assets/style.css', {}, false)).status).toBe(404);
      expect((await rawGet(server.port, '/-/assets/chunks/deep/diagram-ABCD1234.js', {}, false)).status).toBe(404);
    } finally { rmSync(dist); renameSync(saved, dist); }
  });
});

describe('web server', () => {
  let dir: string;
  let owner: AsideWebServer;

  beforeAll(async () => {
    dir = join(tmpdir(), `aside-web-serve-${Date.now()}`);
    writeFixture(dir);
    owner = await startWeb(APP_DIR, { instances: () => availableInstances([dir]), register: async () => null, remove: () => {}, load: () => {}, data: async () => { throw new Error('No data fixture'); } }, 0);
  });

  afterAll(() => {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds the HTTP listener only to loopback', () => {
    expect(owner.origin).toBe(`http://localhost:${owner.port}`);
    expect((owner as unknown as { server: http.Server }).server.address()).toMatchObject({ address: '127.0.0.1', port: owner.port });
  });

  it('lists registered instance metadata without loading data stores', async () => {
    const instances = JSON.parse((await rawGet(owner.port, '/-/api/instances')).body);
    expect(instances).toEqual([expect.objectContaining({ id: 'web-test', address: 'web-test', alias: expect.stringMatching(/^web-test~[a-f0-9]{16}$/), name: 'Web Test', description: 'web server test instance', path: realpathSync(dir) })]);
    expect(owner.tabCount).toBe(0);
    expect((await rawGet(owner.port, '/-/api/instances/web-test')).status).toBe(200);
  });

  it('requires a valid browser credential before exposing any API metadata, files, or control stream', async () => {
    const context = webAuth.get(owner.port)!;
    const expired = new WebAuth(context.directory, () => Date.now() - WEB_AUTH_LEASE_MS - 1000).issue();
    const paths = ['/-/api', '/-/api/auth', '/-/api/instances', '/-/api/control',
      '/-/api/instances/web-test', '/-/api/instances/web-test/data', '/-/api/instances/web-test/years',
      '/-/api/instances/web-test/watch', '/-/api/instances/web-test/control', '/-/api/instances/web-test/files/aside.md'];
    for (const path of paths) {
      for (const headers of [{}, {Authorization: 'Bearer invalid'}, {Authorization: `Bearer ${expired.token}`}]) {
        const response = await rawGet(owner.port, path, headers, false);
        expect(response.status).toBe(401);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['www-authenticate']).toBe('Bearer');
        expect(JSON.parse(response.body)).toMatchObject({code: 'AUTH_REQUIRED', error: expect.stringContaining('aside show')});
        expect(response.body).not.toContain('Web Test');
      }
    }
    expect((await rawGet(owner.port, '/', {}, false)).status).toBe(200);
    expect((await rawGet(owner.port, '/-/api/instances', {Host: 'evil.example'}, false)).status).toBe(403);
    expect((await rawGet(owner.port, '/-/api/instances')).status).toBe(200);
  });

  it('does not extend authorization through ordinary API requests or conditional file reads', async () => {
    const context = webAuth.get(owner.port)!, before = context.auth.session(context.credential.id);
    const response = await rawGet(owner.port, '/-/api/instances/web-test/files/aside.md');
    expect((await rawGet(owner.port, '/-/api/instances/web-test/files/aside.md', {'If-None-Match': response.headers.etag!})).status).toBe(304);
    expect((await rawGet(owner.port, '/-/api/auth')).status).toBe(200);
    expect(context.auth.session(context.credential.id)).toEqual(before);
    expect((await rawGet(owner.port, '/-/api/instances/web-test/files/aside.md', {'If-None-Match': response.headers.etag!}, false)).status).toBe(401);
  });

  it('closes an already open control stream when its credential reaches its persisted deadline', async () => {
    let now = Date.now();
    const server = await startWeb(APP_DIR, {instances: () => [], register: async () => null, remove: () => {}, load: () => {},
      data: async () => { throw new Error('No data fixture'); }}, 0, () => now);
    try {
      const response = await authenticatedFetch(`http://127.0.0.1:${server.port}/-/api/control`, {signal: AbortSignal.timeout(3000)});
      expect(response.status).toBe(200);
      expect(server.tabCount).toBe(1);
      now += WEB_AUTH_LEASE_MS;
      expect(await response.text()).toContain('event: auth-expired');
      expect((await authenticatedFetch(`http://127.0.0.1:${server.port}/-/api/instances`)).status).toBe(401);
    } finally { server.close(); }
  });

  it.each(['expiry', 'revocation'])('rejects delayed POST bodies after %s before performing their side effects', async invalidation => {
    let now = Date.now();
    const backend: WebBackend = {
      instances: () => [{ id: 'web-test', path: realpathSync(dir) }],
      pick: vi.fn(async () => null), register: vi.fn(async () => null), remove: vi.fn(), load: () => {},
      data: async () => { throw new Error('No data fixture'); },
    };
    const server = await startWeb(APP_DIR, backend, 0, () => now);
    const context = webAuth.get(server.port)!;
    const navigate = vi.spyOn(server, 'navigate');
    try {
      for (const [endpoint, message] of [
        ['instances/pick', { kind: 'directory' }],
        ['instances/register', { path: realpathSync(dir) }],
        ['instances/remove', { path: realpathSync(dir) }],
        ['instances/web-test/control', { navigate: 'project/2026-01-15-alpha' }],
        ['control', { focus: 1 }],
      ] as const) {
        context.credential = context.auth.issue();
        let receivedHeaders!: () => void;
        const authorized = new Promise<void>(resolve => { receivedHeaders = resolve; });
        const authorize = context.auth.authorize.bind(context.auth);
        const authorization = vi.spyOn(context.auth, 'authorize').mockImplementation(token => {
          const result = authorize(token);
          receivedHeaders();
          return result;
        });
        const body = JSON.stringify(message);
        let request!: http.ClientRequest;
        const completed = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
          request = http.request({ host: '127.0.0.1', port: server.port, path: `/-/api/${endpoint}`, method: 'POST',
            signal: AbortSignal.timeout(3000), headers: authHeaders(server.port, {
              'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'X-Aside-Control': '1',
            }),
          }, response => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
          });
          request.on('error', reject);
          request.write(body.slice(0, 1));
        });
        try {
          await Promise.race([authorized, completed.then(() => { throw new Error('Request finished before its body was sent'); })]);
          if (invalidation === 'expiry') now += WEB_AUTH_LEASE_MS;
          else context.auth.revoke(context.credential.id);
          request.end(body.slice(1));
          const response = await completed;
          expect(response.status, endpoint).toBe(401);
          expect(response.headers['www-authenticate']).toBe('Bearer');
          expect(JSON.parse(response.body)).toMatchObject({ code: 'AUTH_REQUIRED' });
          expect(backend.pick).not.toHaveBeenCalled();
          expect(backend.register).not.toHaveBeenCalled();
          expect(backend.remove).not.toHaveBeenCalled();
          expect(navigate).not.toHaveBeenCalled();
        } finally { request.destroy(); authorization.mockRestore(); }
      }
    } finally { navigate.mockRestore(); server.close(); }
  });

  it('serves the app shell, SPA fallback, and nothing else from the webapp', async () => {
    expect((await rawGet(owner.port, '/')).body).toContain('<title>Aside</title>');
    expect((await rawGet(owner.port, '/web-test/project/2026-01-15-alpha/detail')).body)
      .toContain('<script type="module" src="/-/assets/app.js"></script>');
    expect((await rawGet(owner.port, '/web-test/artifact/2026-10-02-report')).body).toContain('<title>Aside</title>');
    expect((await rawGet(owner.port, '/web-test/artifact/2026-10-02-report/summary.PDF')).body).toContain('<title>Aside</title>');
    expect((await rawGet(owner.port, '/web-test/2026-04-28T10:00')).body).toContain('<title>Aside</title>');
    expect((await rawGet(owner.port, '/-/assets/app.js')).status).toBe(200);
    expect((await rawGet(owner.port, '/spec.md')).status).toBe(404);
    expect((await rawGet(owner.port, '/-/assets/src/app.ts')).status).toBe(404);
  });

  it('serves suffixed bookmark routes without exposing registration metadata before API authorization', async () => {
    const instance = availableInstances([dir])[0];
    const alias = instance.alias!;
    const response = await rawGet(owner.port, `/${alias}/artifact/2026-10-02-report/100%25%20done%20%231.png?view=detail`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('<title>Aside</title>');
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await rawGet(owner.port, `/-/api/instances/${alias}/files/aside.md`)).status).toBe(200);
    // Missing aliases use the SPA's instance recovery flow, just like bare IDs.
    expect((await rawGet(owner.port, '/web-test~0000000000000000/')).body).toContain('<title>Aside</title>');
    expect((await rawGet(owner.port, '/-/api/instances/web-test~0000000000000000/files/aside.md')).status).toBe(404);
  });

  it('serves nested module chunks with JavaScript MIME and conditional caching', async () => {
    const app = mkdtempSync(join(tmpdir(), 'aside-web-modules-'));
    mkdirSync(join(app, 'dist', 'chunks'), { recursive: true });
    const source = 'export const diagram = "local module";';
    writeFileSync(join(app, 'dist', 'chunks', 'diagram-ABCD1234.js'), source);
    const server = await startWeb(app, { instances: () => [], register: async () => null, remove: () => {}, load: () => {}, data: async () => { throw new Error('No data fixture'); } }, 0);
    try {
      const url = '/-/assets/chunks/diagram-ABCD1234.js';
      const response = await rawGet(server.port, url);
      expect(response.status).toBe(200);
      expect(response.body).toBe(source);
      expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(response.headers.etag).toBeDefined();
      expect((await rawGet(server.port, url, { 'If-None-Match': response.headers.etag! })).status).toBe(304);
      expect((await rawGet(server.port, '/-/assets/chunks/missing.js')).status).toBe(404);
    } finally {
      server.close();
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('serves instance data with ETags and no CORS', async () => {
    const res = await rawGet(owner.port, '/-/api/instances/web-test/files/projects/2026/2026-01-15-alpha.md');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Alpha body');
    expect(res.headers.etag).toBeDefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const revalidated = await rawGet(owner.port, '/-/api/instances/web-test/files/projects/2026/2026-01-15-alpha.md', { 'If-None-Match': res.headers.etag! });
    expect(revalidated.status).toBe(304);
    expect((await rawGet(owner.port, '/-/api/instances/web-test/files/notes/2026/missing.md')).status).toBe(404);
    expect((await rawGet(owner.port, '/-/api/instances/web-test/files/../aside.md')).status).toBe(404);
  });

  it('serves exact supporting files with preview MIME types and binary fallback', async () => {
    for (const [filename, mime] of [['100% done #1.png', 'image/png'], ['summary.PDF', 'application/pdf'], ['clip.mp4', 'video/mp4'], ['voice.m4a', 'audio/mp4'], ['voice.aac', 'audio/aac'], ['voice.opus', 'audio/ogg'], ['voice.weba', 'audio/webm'], ['clip.ogv', 'video/ogg'], ['captions.VTT', 'text/vtt; charset=utf-8'], ['unknown.bin', 'application/octet-stream']]) {
      const res = await rawGet(owner.port, `/-/api/instances/web-test/files/artifacts/2026/2026-10-02-report/${encodeURIComponent(filename)}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe(mime);
      expect(res.body).toBe('file bytes');
    }
    expect((await rawGet(owner.port, '/-/api/instances/web-test/files/artifacts/2026/2026-10-02-report')).status).toBe(404);
  });

  it('rejects managed file and directory symlinks but preserves ordinary asset references', async () => {
    expect((await rawGet(owner.port, '/-/api/instances/web-test/files/artifacts/2026/2026-10-02-report/linked.md')).status).toBe(404);
    const project = join(dir, 'projects', '2026', '2026-01-15-alpha.md');
    const saved = join(dir, 'saved-project.md');
    const alias = join(dir, 'assets', 'linked.md');
    symlinkSync(join(dir, 'assets', 'notes.md'), alias);
    renameSync(project, saved); symlinkSync(saved, project);
    try {
      expect((await rawGet(owner.port, '/-/api/instances/web-test/files/projects/2026/2026-01-15-alpha.md')).status).toBe(404);
      expect((await rawGet(owner.port, '/-/api/instances/web-test/files/assets/linked.md')).status).toBe(200);
    } finally { rmSync(alias); rmSync(project); renameSync(saved, project); }
    const directory = join(dir, 'artifacts', '2026');
    const savedDirectory = join(dir, 'saved-artifacts');
    renameSync(directory, savedDirectory); symlinkSync(savedDirectory, directory);
    try {
      expect((await rawGet(owner.port, '/-/api/instances/web-test/files/artifacts/2026/2026-10-02-report/summary.PDF')).status).toBe(404);
    } finally { rmSync(directory); renameSync(savedDirectory, directory); }
  });

  it('serves user-reference symlinks outside the managed layout without treating them as records', async () => {
    for (const relative of ['projects/reference/logo.svg', 'projects/2026/support/file.pdf',
      'projects/2026/diagram.svg', 'artifacts/2026/2026-10-02-report/images/chart.svg']) {
      const response = await rawGet(owner.port, `/-/api/instances/web-test/files/${relative}`);
      expect(response.status, relative).toBe(200);
      expect(response.body).toBe('# Notes\n');
    }
  });

  it('does not enumerate years through a managed directory symlink', async () => {
    const directory = join(dir, 'projects');
    const saved = join(dir, 'saved-projects');
    renameSync(directory, saved);
    mkdirSync(join(saved, '2099'));
    symlinkSync(saved, directory);
    try {
      const response = await rawGet(owner.port, '/-/api/instances/web-test/years');
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).not.toContain('2099');
    } finally { rmSync(directory); rmSync(join(saved, '2099'), { recursive: true }); renameSync(saved, directory); }
  });

  it('rejects managed symlinks through filesystem case aliases in HTTP reads', async ({ skip }) => {
    if (!existsSync(join(dir, 'ARTIFACTS'))) skip();
    expect((await rawGet(owner.port, '/-/api/instances/web-test/files/ARTIFACTS/2026/2026-10-02-report/linked.md')).status).toBe(404);
    const directory = join(dir, 'projects'), saved = join(dir, 'saved-case-projects');
    renameSync(directory, saved); symlinkSync(saved, directory);
    try {
      expect((await rawGet(owner.port, '/-/api/instances/web-test/files/PROJECTS/2026/2026-01-15-alpha.md')).status).toBe(404);
    } finally { rmSync(directory); renameSync(saved, directory); }
  });

  it('rejects non-local Host headers', async () => {
    expect((await rawGet(owner.port, '/-/api/instances/web-test/files/aside.md', { Host: 'evil.example' })).status).toBe(403);
    expect((await rawGet(owner.port, '/-/api/instances/web-test/files/aside.md', { Host: 'localhost:9' })).status).toBe(200);
  });

  it('sandboxes HTML attachments even when opened directly or revalidated', async () => {
    for (const filename of ['index.HTML', 'index.htm']) {
      const url = `/-/api/instances/web-test/files/artifacts/2026/2026-10-02-report/${filename}`;
      const res = await rawGet(owner.port, url);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['content-security-policy']).toBe('sandbox allow-scripts');
      const cached = await rawGet(owner.port, url, { 'If-None-Match': res.headers.etag! });
      expect(cached.status).toBe(304);
      expect(cached.headers['content-security-policy']).toBe('sandbox allow-scripts');
    }
    for (const route of ['/', '/web-test/project/2026-10-02-report']) {
      const shell = await rawGet(owner.port, route);
      expect(shell.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(shell.headers['content-security-policy']).toBe(APP_SHELL_CSP);
    }
    // Pin the exact policy: loosening a directive is a deliberate security change.
    expect(APP_SHELL_CSP).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: https: http:; media-src 'self' https: http:; frame-src 'self' https: http:; "
      + "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  });

  it('isolates script-bearing SVG documents on GET, HEAD and revalidation', async () => {
    for (const filename of ['script.svg', 'script.SvG']) {
      const path = `/-/api/instances/web-test/files/artifacts/2026/2026-10-02-report/${filename}`;
      const res = await rawGet(owner.port, path);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/svg+xml');
      expect(res.headers['content-security-policy']).toBe('sandbox allow-scripts');
      expect(res.body).toContain('<script>');
      const url = `http://127.0.0.1:${owner.port}${path}`;
      const head = await authenticatedFetch(url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe('image/svg+xml');
      expect(head.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
      expect(head.headers.get('etag')).toBe(res.headers.etag);
      expect(await head.text()).toBe('');
      for (const method of ['GET', 'HEAD']) {
        const cached = await authenticatedFetch(url, { method, headers: { 'If-None-Match': res.headers.etag! } });
        expect(cached.status).toBe(304);
        expect(cached.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
        expect(await cached.text()).toBe('');
      }
    }
  });

  it('guards the control POST and reports no tab when none is connected', async () => {
    const bare = await authenticatedFetch(`http://127.0.0.1:${owner.port}/-/api/instances/web-test/control`, {
      method: 'POST',
      body: JSON.stringify({ navigate: 'project/2026-01-15-alpha' }),
    });
    expect(bare.status).toBe(403);
    expect(await postNavigate(owner.port, 'project/2026-01-15-alpha')).toBe(false);
  });

  it('pushes a navigate to a connected tab, directly and over the control POST, and counts the tab', async () => {
    let changes = 0;
    owner.onTabsChanged = () => { changes++; };
    expect(owner.tabCount).toBe(0);
    const tab = await openSse(owner.port, '/-/api/instances/web-test/control');
    expect(JSON.parse(await tab.next()).tab).toBeTypeOf('number');
    expect(owner.tabCount).toBe(1);
    expect(changes).toBe(1);
    expect(owner.navigate(realpathSync(dir), 'project/2026-01-15-alpha')).toBe(true);
    expect(JSON.parse(await tab.next())).toEqual({ navigate: 'project/2026-01-15-alpha' });
    expect(await postNavigate(owner.port, 'action/2026-01-20-ship-it/detail')).toBe(true);
    expect(JSON.parse(await tab.next())).toEqual({ navigate: 'action/2026-01-20-ship-it/detail' });
    tab.close();
  });

  it('reports an occupied stable port instead of moving the origin', async () => {
    const foreign = http.createServer((_, res) => res.end('nope'));
    await new Promise<void>(r => foreign.listen(0, '127.0.0.1', r));
    const port = (foreign.address() as { port: number }).port;
    try {
      await expect(startWeb(APP_DIR, { instances: () => [], register: async () => null, remove: () => {}, load: () => {}, data: async () => { throw new Error('No data fixture'); } }, port)).rejects.toThrow(/already in use/);
    } finally { foreign.close(); }
  });

  it('discovers every stored year, including old and future years', async () => {
    mkdirSync(join(dir, 'notes', '2010'), { recursive: true });
    mkdirSync(join(dir, 'actions', '2037'), { recursive: true });
    expect(JSON.parse((await rawGet(owner.port, '/-/api/instances/web-test/years')).body)).toEqual(['2010', '2026', '2037']);
    expect((await rawGet(owner.port, '/-/api/instances/missing/years')).status).toBe(404);
  });

  it('requires exact origin and the control header for write requests', async () => {
    const endpoint = `http://127.0.0.1:${owner.port}/-/api/instances/register`;
    for (const origin of ['http://evil.example', 'null', 'http://127.0.0.1:9']) {
      expect((await authenticatedFetch(endpoint, { method: 'POST', headers: { Origin: origin, 'X-Aside-Control': '1' }, body: '{"kind":"directory"}' })).status).toBe(403);
    }
    const res = await authenticatedFetch(endpoint, { method: 'POST', headers: { Origin: `http://127.0.0.1:${owner.port}`, 'X-Aside-Control': '1' }, body: '{"kind":"directory"}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instance: null });
    expect((await rawGet(owner.port, '/-/api/control', { Origin: 'http://127.0.0.1:9' })).status).toBe(403);
  });

  it('streams data changes over /-/api/instances/web-test/watch', async () => {
    const stream = await openSse(owner.port, '/-/api/instances/web-test/watch');
    // Give the watcher a beat to attach before touching the file.
    await new Promise((r) => setTimeout(r, 150));
    writeFileSync(join(dir, 'assets', 'notes.md'), `# Notes v2\n`);
    expect(JSON.parse(await stream.next())).toContain('assets/notes.md');
    stream.close();
  });
});


describe('browser instance isolation', () => {
  it('keeps chooser tabs separate and only navigates tabs displaying the target instance', async () => {
    const a = join(tmpdir(), `aside-web-a-${Date.now()}`);
    const b = join(tmpdir(), `aside-web-b-${Date.now()}`);
    writeFixture(a); writeFixture(b);
    writeFileSync(join(b, 'aside.md'), '---\nid: other\nname: Other\n---\n');
    const loaded: string[] = [];
    const server = await startWeb(APP_DIR, { instances: () => availableInstances([a, b]), register: async () => null, remove: () => {}, load: path => { loaded.push(path); }, data: async () => { throw new Error('No data fixture'); } }, 0);
    const chooser = await openSse(server.port, '/-/api/control');
    const aTab = await openSse(server.port, '/-/api/instances/web-test/control');
    const bTab = await openSse(server.port, '/-/api/instances/other/control');
    try {
      await chooser.next(); await aTab.next(); await bTab.next();
      expect(loaded).toEqual([realpathSync(a), realpathSync(b)]);
      expect(server.tabCount).toBe(3);
      expect(server.tabsForPath(realpathSync(a))).toBe(1);
      expect(server.navigate(realpathSync(a), 'detail')).toBe(true);
      expect(JSON.parse(await aTab.next())).toEqual({ navigate: 'detail' });
      expect(server.routeFor(realpathSync(b), 'detail')).toBe('other/detail');
      const other = await rawGet(server.port, '/-/api/instances/other/files/aside.md');
      expect(other.body).toContain('name: Other');
      expect((await rawGet(server.port, '/-/api/instances/web-test/files/aside.md')).body).toContain('Web Test');
      writeFileSync(join(b, 'aside.md'), '---\nid: web-test\nname: Duplicate\n---\n');
      const conflict = await rawGet(server.port, '/-/api/instances/web-test/files/aside.md');
      expect(conflict.status).toBe(404);
      const rows = availableInstances([a, b]);
      for (const row of rows) {
        expect(server.routeFor(row.path, '')).toBe(`${row.address}/`);
        expect((await rawGet(server.port, `/-/api/instances/${row.address}/files/aside.md`)).status).toBe(200);
      }
    } finally {
      chooser.close(); aTab.close(); bTab.close(); server.close();
      rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true });
    }
  });

  it('rejects a replaced symlinked manifest and keeps every raw file inside the instance', async () => {
    const one = join(tmpdir(), `aside-web-manifest-one-${Date.now()}`);
    const two = join(tmpdir(), `aside-web-manifest-two-${Date.now()}`);
    writeFixture(one); writeFixture(two);
    const instances = availableInstances([one]);
    rmSync(join(one, 'aside.md')); symlinkSync(join(two, 'aside.md'), join(one, 'aside.md'));
    symlinkSync(join(two, 'aside.md'), join(one, 'manifest.md'));
    rmSync(join(one, 'assets'), { recursive: true }); symlinkSync(join(two, 'assets'), join(one, 'assets'));
    let server: AsideWebServer | undefined;
    try {
      expect(() => registrationPath(one)).toThrow(/existing aside directory/);
      expect(() => registrationPath(join(one, 'aside.md'))).toThrow(/existing aside directory/);
      server = await startWeb(APP_DIR, { instances: () => instances, register: async () => null, remove: () => {}, load: () => {}, data: async () => { throw new Error('No data fixture'); } }, 0);
      const manifest = await rawGet(server.port, '/-/api/instances/web-test/files/aside.md');
      expect(manifest.status).toBe(404);
      expect((await rawGet(server.port, '/-/api/instances/web-test/files/manifest.md')).status).toBe(404);
      expect((await rawGet(server.port, '/-/api/instances/web-test/files/assets/notes.md')).status).toBe(404);
    } finally {
      server?.close();
      rmSync(one, { recursive: true, force: true }); rmSync(two, { recursive: true, force: true });
    }
  });

  it('canonicalizes existing directories and manifests without loading or copying them', () => {
    const dir = join(tmpdir(), `aside-web-register-${Date.now()}`);
    writeFixture(dir);
    const alias = `${dir}-alias`;
    symlinkSync(dir, alias);
    try {
      expect(registrationPath(alias)).toBe(realpathSync(dir));
      expect(registrationPath(join(alias, 'aside.md'))).toBe(realpathSync(dir));
      expect(availableInstances([alias, dir])).toHaveLength(1);
      expect(() => registrationPath(join(dir, 'assets', 'notes.md'))).toThrow(/existing aside directory/);
    } finally { rmSync(alias); rmSync(dir, { recursive: true, force: true }); }
  });
});
