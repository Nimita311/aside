import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { init } from '../src/commands/init.js';
import { Daemon } from '../src/daemon/daemon.js';
import { DaemonClient, tryConnect, type Launcher } from '../src/daemon/client.js';
import { InstanceHost, type ToolResult } from '../src/daemon/host.js';
import { daemonPaths, JOB_LABEL, type DaemonPaths } from '../src/daemon/paths.js';
import { FileLock, isLocked } from '../src/daemon/filelock.js';
import { readJob, renderJob, writeJob } from '../src/daemon/launchd.js';
import { ownHello, type HelloResult, type Status, type StopResult } from '../src/daemon/protocol.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { WebAuth } from '../src/web/auth.js';
import { buildSchema } from 'graphql';
import type { GraphQLSchemaResult } from '../src/graphql/schema.js';
import type { InstanceSessionState } from '../src/mcp/instance-session.js';

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await sleep(20);
  }
}

// Each test gets its own daemon directory and runs the daemon in-process: the
// real socket, locks, and client, with no calendar helper and no child process.
describe('daemon', () => {
  let home: string;
  let paths: DaemonPaths;
  let root: string;
  let daemons: Daemon[];
  let clients: DaemonClient[];
  let webToken: string | undefined;

  function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
    webToken ??= new WebAuth(paths.state).issue().token;
    const headers = new Headers(options.headers);
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${webToken}`);
    return globalThis.fetch(url, {...options, headers});
  }

  beforeEach(() => {
    home = mkdtempSync('/tmp/aside-test-d-');
    paths = daemonPaths({ ASIDE_DAEMON_HOME: home });
    root = realpathSync(mkdtempSync('/tmp/aside-test-i-'));
    daemons = [];
    clients = [];
    webToken = undefined;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    for (const daemon of daemons) await daemon.shutdown();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function instance(name: string): string {
    const dir = join(root, name);
    init(dir, { name, description: `${name} instance` });
    return dir;
  }

  async function startDaemon(options: { known?: string[]; host?: InstanceHost } = {}): Promise<Daemon> {
    if (options.known) writeFileSync(paths.known, JSON.stringify(options.known));
    const daemon = new Daemon({ webPort: 0, paths, host: options.host ?? new InstanceHost(new CalClient(null)) });
    expect(await daemon.listen()).toBe(true);
    daemons.push(daemon);
    return daemon;
  }

  function client(launches: { count: number } = { count: 0 }): DaemonClient {
    const launcher: Launcher = async () => { launches.count++; await startDaemon(); };
    const c = new DaemonClient({ paths, launcher });
    clients.push(c);
    return c;
  }

  const capture = (c: DaemonClient, dir: string, content: string) =>
    c.request<ToolResult>('tool', { instance: dir, name: 'capture', args: { content, description: content } });

  it('validates schema-read requests strictly and recovers from a failed cold read without loading an instance', async () => {
    const host = new InstanceHost(new CalClient(null));
    const schemaRead = vi.spyOn(host, 'graphqlSchema').mockRejectedValueOnce(new Error('Temporary schema failure'));
    await startDaemon({host});
    const c = client();
    const session: InstanceSessionState = {workspace: [], encountered: [], active: null, discovery: false, cwd: root, configIssues: []};
    for (const params of [
      {session, mode: 'query'},
      {session, args: {}},
      {session: {...session, unexpected: true}},
      {session: {...session, active: 42}},
    ]) await expect(c.request('graphql.schema', params, {read: true})).rejects.toThrow();
    expect(schemaRead).not.toHaveBeenCalled();
    await expect(c.request('graphql.schema', {session}, {read: true})).rejects.toThrow('Temporary schema failure');
    const reply = await c.request<{result: GraphQLSchemaResult; session: InstanceSessionState}>('graphql.schema', {session}, {read: true});
    expect(reply.session).toEqual(session);
    expect(reply.result.diagnostics).toEqual([]);
    const schema = buildSchema(reply.result.sdl);
    expect(schema.getQueryType()?.name).toBe('Query');
    expect(schema.getMutationType()?.name).toBe('Mutation');
    expect(schema.getType('Model')).toBeUndefined();
    expect((await c.request<Status>('status', undefined, {read: true})).loaded).toEqual([]);
    expect(await c.request('graphql.schema', {session}, {read: true})).toEqual(reply);
  });

  it('rejects unsupported daemon tool envelopes and nested arguments before writes', async () => {
    const dir = instance('strict');
    const c = client();
    await expect(c.request('tool', { instance: dir, name: 'capture', args: { content: 'Rejected', description: 'Rejected' }, extra: true })).rejects.toThrow(/extra/);
    await expect(c.request('tool', { instance: dir, name: 'capture', args: { content: 'Rejected', description: 'Rejected', actions: [{ name: 'Orphan', description: 'Orphan', created: '2026-10-04T12:00' }] } })).rejects.toThrow(/actions.0.*created/);
    await expect(c.request('tool', { instance: dir, name: 'calendar_info', args: { request: true } })).rejects.toThrow(/request/);
    const result = await c.request<ToolResult>('tool', { instance: dir, name: 'query_entries', args: {} }, { read: true });
    expect(result.text).toMatch(/^0 of 0/);
    expect(existsSync(join(dir, 'actions'))).toBe(false);
    expect(existsSync(join(dir, 'notes'))).toBe(false);
  });

  it.each(['known.add', 'known.forget'])('%s rejects malformed path batches before catalogue changes', async method => {
    const one = instance('one'), two = instance('two');
    writeFileSync(paths.known, JSON.stringify([one]));
    const c = client();
    await c.request('status');
    const before = readFileSync(paths.known, 'utf8');
    for (const bad of [null, 123, '']) {
      await expect(c.request(method, { paths: [method === 'known.add' ? two : one, bad] })).rejects.toThrow(/nonempty path strings/);
      expect(readFileSync(paths.known, 'utf8')).toBe(before);
      const status = await c.request<Status>('status');
      expect(status.known).toEqual([one]);
      expect(status.loaded).toEqual([one]);
    }
  });

  it('registers a worktree primary and cascades forgetting it across refresh and restart', async () => {
    const primary = instance('primary'), linked = join(root, 'linked');
    const git = (...args: string[]) => execFileSync('git', ['-C', primary, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'pipe' });
    git('init', '-b', 'main'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--no-gpg-sign', '-m', 'fixture');
    git('worktree', 'add', '--detach', linked);
    const daemon = await startDaemon(), c = client();
    await c.request('known.add', { paths: [linked] });
    expect((await c.request<Status>('status')).known.sort()).toEqual([primary, linked].sort());
    const { port } = await c.request<{ port: number }>('serve', {navigate: false});
    const listing = async () => (await authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances`)).json();
    expect(await listing()).toHaveLength(2);
    await c.request('known.forget', { paths: [primary] });
    expect(await listing()).toEqual([]);
    expect((await c.request<Status>('status')).known).toEqual([]);
    c.close(); await daemon.shutdown();
    await startDaemon();
    const restarted = await client().request<Status>('status');
    expect(restarted.known).toEqual([]); expect(restarted.loaded).toEqual([]);
  });

  it('keeps every known instance loaded after clients and browser tabs disconnect', async () => {
    const one = instance('one'), two = instance('two');
    const host = new InstanceHost(new CalClient(null));
    await startDaemon({ known: [one, two], host });
    const c = client();
    const { port } = await c.request<{ port: number }>('serve', {navigate: false});
    const base = `http://127.0.0.1:${port}`;
    const chooser = await authenticatedFetch(`${base}/-/api/control`);
    const chooserReader = chooser.body!.getReader();
    await chooserReader.read();
    const selected = await authenticatedFetch(`${base}/-/api/instances/one/control`);
    const selectedReader = selected.body!.getReader();
    await selectedReader.read();
    c.close();
    await selectedReader.cancel();
    await chooserReader.cancel();
    await until(() => host.tabCount() === 0);
    expect(host.loadedPaths().sort()).toEqual([one, two].sort());
    expect(isLocked(paths.lifetimeLock)).toBe(true);
  });

  it('loads saved known instances canonically at startup and after restart', async () => {
    const one = instance('one'), canonical = realpathSync(one), alias = join(root, 'alias');
    symlinkSync(one, alias);
    const host = new InstanceHost(new CalClient(null));
    const daemon = await startDaemon({ known: [alias, one], host });
    const { port } = await host.web();
    const catalogue = await (await authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances`)).json();
    expect(catalogue).toEqual([expect.objectContaining({ id: 'one', path: canonical })]);
    expect(host.loadedPaths()).toEqual([canonical]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([canonical]);
    await daemon.shutdown();
    const restarted = new InstanceHost(new CalClient(null));
    await startDaemon({ host: restarted });
    const { port: nextPort } = await restarted.web();
    expect(await (await authenticatedFetch(`http://127.0.0.1:${nextPort}/-/api/instances`)).json())
      .toEqual([expect.objectContaining({ id: 'one', path: canonical })]);
    expect(restarted.loadedPaths()).toEqual([canonical]);
  });

  it('pins alias registrations and loaded stores to the original real directory', async () => {
    const one = instance('one'), two = instance('two'), alias = join(root, 'alias');
    symlinkSync(one, alias);
    // A preexisting alias entry is normalized while the daemon owns the file.
    writeFileSync(paths.known, JSON.stringify([alias, one]));
    const host = new InstanceHost(new CalClient(null));
    await startDaemon({ host, known: [alias, one] });
    const c = client();
    expect((await c.request<Status>('status')).known).toEqual([one]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one]);
    expect(host.loadedPaths()).toEqual([one]);
    const result = await capture(c, alias, 'Original target');
    expect(result.text).toContain(`file: ${one}/notes/`);
    unlinkSync(alias); symlinkSync(two, alias);
    // Removing/retargeting a launch alias must not redirect the store, unload
    // the registered directory or register the new target without a new request.
    await sleep(80);
    const status = await c.request<Status>('status');
    expect(status.known).toEqual([one]);
    expect(status.loaded).toEqual([one]);
    const query = await c.request<ToolResult>('tool', { instance: one, name: 'query_entries', args: { detail: 'full' } }, { read: true });
    expect(query.text).toContain('Original target');
    expect(existsSync(join(two, 'notes'))).toBe(false);
    unlinkSync(alias);
    expect((await c.request<Status>('status')).known).toEqual([one]);
    rmSync(join(one, 'aside.md'));
    expect((await c.request<Status>('status')).known).toEqual([]);
  });

  it('prunes missing or invalid saved registrations at startup', async () => {
    const one = instance('one'), file = join(root, 'other.txt'); writeFileSync(file, 'ordinary file');
    const host = new InstanceHost(new CalClient(null));
    await startDaemon({ known: [join(root, 'missing'), root, file, one], host });
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([file, realpathSync(one)]);
    expect((await client().request<Status>('status')).known).toEqual([one]);
    expect(host.loadedPaths()).toEqual([one]);
  });

  it('retains a valid saved registration when loading fails', async () => {
    const one = instance('one'), host = new InstanceHost(new CalClient(null));
    const loading = vi.spyOn(host, 'load').mockImplementation(() => { throw new Error('cannot read instance'); });
    try {
      await startDaemon({ known: [one], host });
      expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one]); expect(host.loadedPaths()).toEqual([]);
      const { port } = await host.web();
      expect(await (await authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances`)).json()).toEqual([expect.objectContaining({ path: one })]);
    } finally { loading.mockRestore(); }
  });

  it('registers native selections canonically and leaves known paths untouched on cancellation', async () => {
    const one = instance('one');
    const picker = vi.fn().mockResolvedValue(join(one, 'aside.md'));
    const host = new InstanceHost(new CalClient(null));
    const daemon = new Daemon({ paths, host, webPort: 0, picker });
    expect(await daemon.listen()).toBe(true);
    daemons.push(daemon);
    const c = client();
    const { port } = await c.request<{ port: number }>('serve', {navigate: false});
    const register = () => authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances/register`, {
      method: 'POST', headers: { 'X-Aside-Control': '1' }, body: JSON.stringify({ kind: 'manifest' }),
    });
    const first = await register();
    expect(first.status).toBe(200);
    const registered = (await first.json()).instance;
    expect(registered.id).toBe('one');
    expect(registered.path).toContain('/private/tmp/');
    expect(host.loadedPaths()).toEqual([one]);
    const before = readFileSync(paths.known, 'utf8');
    picker.mockResolvedValue(null);
    expect(await (await register()).json()).toEqual({ instance: null });
    expect(readFileSync(paths.known, 'utf8')).toBe(before);
    picker.mockResolvedValue(join(one, 'aside.md'));
    await register();
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toHaveLength(1);
    expect(host.loadedPaths()).toEqual([one]);
  });

  it('browses for a folder without registering until Add is submitted, and cancels silently', async () => {
    const one = instance('picked folder'), picker = vi.fn().mockResolvedValue(one);
    const host = new InstanceHost(new CalClient(null));
    const daemon = new Daemon({ paths, host, webPort: 0, picker });
    expect(await daemon.listen()).toBe(true); daemons.push(daemon);
    const { port } = await host.web();
    const pick = () => authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances/pick`, { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Aside-Control': '1' }, body: JSON.stringify({ kind: 'directory' }) });
    expect(await (await pick()).json()).toEqual({ path: one });
    expect(picker).toHaveBeenCalledWith('directory'); expect(host.loadedPaths()).toEqual([]);
    expect((await (await authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances`)).json())).toEqual([]);
    picker.mockResolvedValue(null); expect(await (await pick()).json()).toEqual({ path: null });
    expect(host.loadedPaths()).toEqual([]);
  });

  it('reads card summaries only for discovery, not data, metadata, or file requests', async () => {
    const one = instance('one'), host = new InstanceHost(new CalClient(null));
    await startDaemon({ known: [one], host });
    const summary = vi.spyOn(host, 'summary'), { port } = await host.web();
    const request = (suffix: string) => authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances${suffix}`);
    const listing = await (await request('')).json();
    expect(listing[0].summary).toMatchObject({ projects: { open: 0, total: 0 }, actions: { open: 0, total: 0 }, entries: 0 });
    expect(summary).toHaveBeenCalledWith(one); summary.mockClear();
    for (const suffix of ['/one', '/one/data', '/one/files/aside.md']) expect((await request(suffix)).status).toBe(200);
    expect(summary).not.toHaveBeenCalled();
  });

  it('registers entered directories, manifests, home paths, and aliases without a picker', async () => {
    const one = instance('work space'), alias = join(root, 'alias');
    symlinkSync(one, alias);
    const picker = vi.fn().mockRejectedValue(new Error('Picker must not open'));
    const host = new InstanceHost(new CalClient(null));
    const daemon = new Daemon({ paths, host, webPort: 0, picker });
    expect(await daemon.listen()).toBe(true); daemons.push(daemon);
    const { port } = await host.web();
    for (const entered of [one, join(one, 'aside.md'), alias, `~/${relative(homedir(), one)}`]) {
      const response = await authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances/register`, {
        method: 'POST', headers: { 'X-Aside-Control': '1' }, body: JSON.stringify({ path: `  ${entered}  ` }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).instance.path).toBe(one);
    }
    expect(picker).not.toHaveBeenCalled();
    expect(host.loadedPaths()).toEqual([one]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one]);
  });

  it('rejects invalid entered paths and mixed registration methods without changing the catalogue', async () => {
    const one = instance('one'), picker = vi.fn();
    const host = new InstanceHost(new CalClient(null));
    const daemon = new Daemon({ paths, host, webPort: 0, picker });
    expect(await daemon.listen()).toBe(true); daemons.push(daemon);
    const { port } = await host.web();
    const register = (body: unknown) => authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances/register`, {
      method: 'POST', headers: { 'X-Aside-Control': '1' }, body: JSON.stringify(body),
    });
    for (const body of [{ path: '' }, { path: ' ' }, { path: 3 }, { path: null }, { path: 'relative' }, { path: one, kind: 'manifest' }]) {
      expect((await register(body)).status).toBe(400);
    }
    for (const entered of [join(root, 'missing'), root]) expect((await register({ path: entered })).status).toBe(500);
    expect(picker).not.toHaveBeenCalled();
    expect(existsSync(paths.known)).toBe(false);
    expect(host.loadedPaths()).toEqual([]);
  });

  it('removes a conflicting browser registration by path, persists it, and preserves its files', async () => {
    const one = instance('one'), copy = instance('copy');
    const manifest = readFileSync(join(one, 'aside.md'), 'utf8');
    writeFileSync(join(copy, 'aside.md'), manifest);
    const daemon = await startDaemon();
    const c = client();
    await c.request('known.add', { paths: [one, copy] });
    const { port } = await c.request<{ port: number }>('serve', {navigate: false});
    const base = `http://127.0.0.1:${port}/-/api/instances`;
    expect((await authenticatedFetch(`${base}/one`)).status).toBe(404);
    const response = await authenticatedFetch(`${base}/remove`, {
      method: 'POST', headers: { 'X-Aside-Control': '1' }, body: JSON.stringify({ path: copy }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).instances).toEqual([expect.objectContaining({ id: 'one', path: one })]);
    expect((await authenticatedFetch(`${base}/one`)).status).toBe(200);
    expect(readFileSync(join(copy, 'aside.md'), 'utf8')).toBe(manifest);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one]);
    await daemon.shutdown();
    const host = new InstanceHost(new CalClient(null));
    await startDaemon({ host });
    const restarted = await host.web();
    expect((await (await authenticatedFetch(`http://127.0.0.1:${restarted.port}/-/api/instances`)).json()).map((row: { path: string }) => row.path)).toEqual([one]);
  });

  it('validates browser removal requests before touching the catalogue', async () => {
    const one = instance('one');
    const c = client();
    await c.request('known.add', { paths: [one] });
    const { port } = await c.request<{ port: number }>('serve', {navigate: false});
    const endpoint = `http://127.0.0.1:${port}/-/api/instances/remove`;
    const post = (body: unknown, headers: Record<string, string> = { 'X-Aside-Control': '1' }) => authenticatedFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await authenticatedFetch(endpoint)).status).toBe(405);
    expect((await post({ path: one }, {})).status).toBe(403);
    expect((await post({ path: one }, { 'X-Aside-Control': '1', Origin: 'http://evil.example' })).status).toBe(403);
    for (const body of [{}, { path: 3 }, { path: '' }, { path: 'one' }]) expect((await post(body)).status).toBe(400);
    expect((await post({ path: join(root, 'unknown') })).status).toBe(404);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one]);
  });

  it('removes a browser listing while retaining an active agent instance', async () => {
    const one = instance('one'), host = new InstanceHost(new CalClient(null));
    await startDaemon({ host });
    const c = client();
    await c.request('instance.info', { instance: one });
    const { port } = await c.request<{ port: number }>('serve', {navigate: false});
    const response = await authenticatedFetch(`http://127.0.0.1:${port}/-/api/instances/remove`, {
      method: 'POST', headers: { 'X-Aside-Control': '1' }, body: JSON.stringify({ path: one }),
    });
    expect((await response.json()).instances).toEqual([]);
    expect(host.loadedPaths()).toEqual([one]);
    await capture(c, one, 'Still active after browser removal');
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([one]);
  });

  it('starts a daemon only when none answers, and simultaneous clients share one', async () => {
    const launches = { count: 0 };
    const a = client(launches);
    const b = client(launches);
    const [ha, hb] = await Promise.all([a.hello(), b.hello()]);
    expect(launches.count).toBe(1);
    expect(ha.pid).toBe(hb.pid);
    expect([a.startup?.action, b.startup?.action].sort()).toEqual(['reused', 'started']);
    const c = client(launches);
    await c.hello();
    expect(launches.count).toBe(1);
    expect(c.startup).toEqual({ action: 'reused' });
  });

  it('refuses a second daemon while one holds the lifetime lock', async () => {
    await startDaemon();
    expect(isLocked(paths.lifetimeLock)).toBe(true);
    const second = new Daemon({ webPort: 0, paths, host: new InstanceHost(new CalClient(null)) });
    expect(await second.listen()).toBe(false);
  });

  it('serializes writes from two sessions and shares one cache', async () => {
    await startDaemon();
    const dir = instance('shared');
    const a = client();
    const b = client();
    const create = (c: DaemonClient, i: number) =>
      c.request<ToolResult>('tool', { instance: dir, name: 'create_artifact', args: { name: `Doc ${i}`, description: `Document ${i}` } });
    await Promise.all(Array.from({ length: 8 }, (_, i) => create(i % 2 ? a : b, i)));
    // Every write landed in the shared index, and a third session sees them all.
    const index = readFileSync(join(dir, 'artifacts', String(new Date().getFullYear()), 'index.yaml'), 'utf8');
    for (let i = 0; i < 8; i++) expect(index).toContain(`Document ${i}`);
    const seen = await client().request<ToolResult>('tool', { instance: dir, name: 'query_artifacts', args: {} }, { read: true });
    expect(seen.text).toMatch(/^8 of 8/);
  });

  it('shares implicit attachment replacement and external file changes across socket clients', async () => {
    await startDaemon();
    const dir = instance('artifacts');
    const a = client();
    const b = client();
    const source = join(root, 'old.pdf');
    const bytes = Buffer.from([0, 255, 1, 2]);
    writeFileSync(source, bytes);
    const created = await a.request<ToolResult>('tool', {
      instance: dir, name: 'create_artifact',
      args: { name: 'Brief', description: 'Current brief', files: [{ source }] },
    });
    const id = created.text.match(/^artifact: #artifact\/(.+)$/m)![1];
    const folder = join(dir, 'artifacts', id.slice(0, 4), id);
    const metadata = async () => (await b.request<ToolResult>('tool', {
      instance: dir, name: 'query_artifacts', args: { ids: [id], detail: 'metadata' },
    }, { read: true })).text;
    expect(await metadata()).toContain(`target: #artifact/${id}/old.pdf`);
    const replaced = await a.request<ToolResult>('tool', {
      instance: dir, name: 'update_artifact',
      args: { id, files: [{ source: join(folder, 'old.pdf'), filename: 'new.pdf' }], remove_files: ['old.pdf'] },
    });
    expect(replaced.text).toContain('files_removed:');
    expect(existsSync(join(folder, 'old.pdf'))).toBe(false);
    expect(readFileSync(join(folder, 'new.pdf'))).toEqual(bytes);
    expect(await metadata()).toContain('attachments: [new.pdf]');
    expect(await metadata()).toContain(`target: #artifact/${id}/new.pdf`);

    // These queries do not ask the host to rebuild, so the attachment watcher
    // must reconcile files added and removed outside the tool handlers.
    writeFileSync(join(folder, 'extra.pdf'), 'extra content');
    await until(async () => (await metadata()).includes('attachments: [extra.pdf, new.pdf]'));
    expect(await metadata()).not.toContain('target:');
    rmSync(join(folder, 'extra.pdf'));
    await until(async () => (await metadata()).includes(`target: #artifact/${id}/new.pdf`));
    expect(await metadata()).toContain('attachments: [new.pdf]');
    await a.request<ToolResult>('tool', {
      instance: dir, name: 'update_artifact', args: { id, remove_files: ['new.pdf'] },
    });
    const empty = await metadata();
    expect(empty).not.toContain('attachments:');
    expect(empty).not.toContain('target:');
    expect(readFileSync(source)).toEqual(bytes);
  });

  it.each(['equal', 'later'])('rejects a mismatched version with an %s daemon build time before writing', async (buildTime) => {
    const daemon = await startDaemon();
    const mine = ownHello();
    const version = `${mine.build.version}-different`;
    const builtAt = mine.build.builtAt + (buildTime === 'later' ? 1 : 0);
    const hello = vi.spyOn(daemon as unknown as { hello(): HelloResult }, 'hello').mockReturnValue({
      ...mine, build: { version, builtAt }, pid: process.pid,
    });
    try {
      const dir = instance('incompatible');
      const launches = { count: 0 };
      const c = client(launches);
      await expect(c.request<ToolResult>('tool', {
        instance: dir, name: 'create_artifact', args: { name: 'Brief', description: 'Current brief' },
      })).rejects.toThrow(`The aside daemon runs version ${version}, but this session runs ${mine.build.version}.`);
      expect(launches.count).toBe(0);
      expect(existsSync(join(dir, 'artifacts'))).toBe(false);
    } finally { hello.mockRestore(); }
  });

  it('replaces an older software version before writing and reloads known instances', async () => {
    const dir = instance('updated');
    const daemon = await startDaemon({ known: [dir] });
    const mine = ownHello();
    const hello = vi.spyOn(daemon as unknown as { hello(): HelloResult }, 'hello').mockReturnValue({
      ...mine, build: { version: `${mine.build.version}-old`, builtAt: mine.build.builtAt - 1 }, pid: process.pid,
    });
    try {
      const launches = { count: 0 };
      const c = client(launches);
      expect((await capture(c, dir, 'After updating')).text).toMatch(/^entry: /);
      expect(launches.count).toBe(1);
      const current = await c.hello();
      expect(current.build.version).toBe(mine.build.version);
      expect((await c.request<Status>('status')).loaded).toEqual([dir]);
    } finally { hello.mockRestore(); }
  });

  it('keeps known instances loaded and unloads forgotten ones after their connections close', async () => {
    await startDaemon();
    const dir = instance('alpha');
    const user = client();
    const watcher = client();
    await user.request('instance.info', { instance: dir }, { read: true });
    let status = await watcher.request<Status>('status');
    expect(status.loaded).toEqual([dir]);
    expect(status.sessions).toEqual({ [dir]: 1 });
    expect(status.known).toEqual([dir]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([dir]);
    await watcher.request('known.forget', { paths: [dir] });
    expect((await watcher.request<Status>('status')).loaded).toEqual([dir]);
    user.close();
    await until(async () => (await watcher.request<Status>('status')).loaded.length === 0);
    status = await watcher.request<Status>('status');
    expect(status.known).toEqual([]);
  });

  it('drops a known instance whose manifest is gone, and edits the list by hand', async () => {
    await startDaemon();
    const alpha = instance('alpha');
    const beta = instance('beta');
    const c = client();
    expect((await c.request<{ known: string[] }>('known.add', { paths: [alpha, beta] })).known).toEqual([alpha, beta]);
    expect((await c.request<{ known: string[] }>('known.forget', { paths: [alpha] })).known).toEqual([beta]);
    rmSync(join(beta, 'aside.md'));
    expect((await c.request<Status>('status')).known).toEqual([]);
    await expect(c.request('known.add', { paths: [join(root, 'missing')] })).rejects.toThrow(/Not an aside instance/);
  });

  it('collects deleted and repurposed instances when cached use fails, before any status call', async () => {
    const host = new InstanceHost(new CalClient(null));
    await startDaemon({ host });
    const removed = instance('removed'), repurposed = instance('repurposed'), valid = instance('valid');
    const c = client();
    await c.request('known.add', { paths: [removed, repurposed, valid] });
    await c.request('instance.info', { instance: removed });
    expect(host.loadedPaths()).toHaveLength(3);
    rmSync(removed, { recursive: true });
    writeFileSync(join(repurposed, 'aside.md'), 'This directory has another purpose.');
    await expect(capture(c, removed, 'Must not recreate a removed directory')).rejects.toThrow(/Not an aside instance/);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([valid]);
    expect(host.loadedPaths()).toEqual([valid]);
    expect(existsSync(removed)).toBe(false);
    await expect(capture(c, repurposed, 'Must not write here')).rejects.toThrow(/Not an aside instance/);
    expect(existsSync(join(repurposed, 'notes'))).toBe(false);
    const status = await c.request<Status>('status');
    expect(status.known).toEqual([valid]);
    expect(status.loaded).toEqual([valid]);
    expect(status.sessions).toEqual({ [valid]: 0 });
  });

  it('keeps a valid instance registered when its operation fails for another reason', async () => {
    await startDaemon();
    const dir = instance('valid');
    const c = client();
    await c.request('known.add', { paths: [dir] });
    await expect(c.request('tool', { instance: dir, name: 'update_artifact', args: { id: '2026-10-05-missing', name: 'Missing' } })).rejects.toThrow();
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([dir]);
    expect((await c.request<Status>('status')).known).toEqual([dir]);
  });

  it('garbage-collects before browser discovery without a preceding status request', async () => {
    const host = new InstanceHost(new CalClient(null));
    await startDaemon({ host });
    const valid = instance('valid'), removed = instance('removed');
    const c = client();
    await c.request('known.add', { paths: [valid, removed] });
    rmSync(removed, { recursive: true });
    const web = await host.web();
    const listing = await (await authenticatedFetch(`http://127.0.0.1:${web.port}/-/api/instances`)).json();
    expect(listing.map((instance: { path: string }) => instance.path)).toEqual([valid]);
    expect(JSON.parse(readFileSync(paths.known, 'utf8'))).toEqual([valid]);
    expect(host.loadedPaths()).toEqual([valid]);
  });

  it('stays running without clients even after the former idle deadline', async () => {
    const one = instance('one'), host = new InstanceHost(new CalClient(null));
    await startDaemon({ known: [one], host });
    const c = client();
    await c.hello();
    c.close();
    await sleep(30);
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(isLocked(paths.lifetimeLock)).toBe(true);
      expect(existsSync(paths.socket)).toBe(true);
      expect(host.loadedPaths()).toEqual([one]);
    } finally { vi.useRealTimers(); }
  });

  it('loads later registrations and keeps syncing them after clients disconnect', async () => {
    const alpha = instance('alpha'), beta = instance('beta');
    const host = new InstanceHost(new CalClient(null));
    await startDaemon({ known: [alpha], host });
    const c = client();
    await c.request('known.add', { paths: [beta] });
    expect((await c.request<Status>('status')).loaded.sort()).toEqual([alpha, beta].sort());
    const captured = await capture(c, beta, 'Before disconnect');
    const file = captured.text.match(/file: (.+)/)![1];
    // Capture creates the notes tree after watch startup. Wait for Chokidar
    // to discover this file before testing edits made without a client.
    const watcher = host.load(beta).store['watcher']!;
    await until(() => watcher.getWatched()[dirname(file)]?.includes(basename(file)) === true);
    c.close();
    writeFileSync(file, readFileSync(file, 'utf8').replace('Before disconnect', 'After disconnect'));
    await until(async () => (await host.tool(beta, 'query_entries', { detail: 'full' })).text.includes('After disconnect'));
    expect(host.loadedPaths().sort()).toEqual([alpha, beta].sort());
    expect(isLocked(paths.lifetimeLock)).toBe(true);
  }, 15_000);

  it('busy stop keeps every known instance loaded, with no deferred exit', async () => {
    const alpha = instance('alpha');
    await startDaemon({ known: [alpha] });
    const user = client();
    await user.request('instance.info', { instance: alpha }, { read: true });
    const stopper = (await tryConnect(paths))!;
    expect(await stopper.peer.request<StopResult>('stop')).toEqual({ stopped: false, connections: 1, tabs: 0, instances: [alpha] });
    stopper.peer.close();
    const status = await user.request<Status>('status');
    expect(status.loaded).toEqual([alpha]);
    user.close();
    await sleep(150);
    expect(isLocked(paths.lifetimeLock)).toBe(true); // stays running after all users leave

    // With only the requester connected, stop exits and releases the lock.
    const again = (await tryConnect(paths))!;
    expect(await again.peer.request('stop')).toEqual({ stopped: true, connections: 0, tabs: 0, instances: [] });
    await until(() => !isLocked(paths.lifetimeLock));
  });

  it.skipIf(!existsSync(join(__dirname, '../dist/main.js')))('CLI stop fails while clients and tabs are open, then confirms exit and retained login job', async () => {
    const alpha = instance('alpha');
    const host = new InstanceHost(new CalClient(null));
    await startDaemon({ known: [alpha], host });
    const user = client();
    await user.request('instance.info', { instance: alpha }, { read: true });
    const web = await host.web(join(__dirname, '../../webapp'));
    const abort = new AbortController();
    const tab = await authenticatedFetch(`http://127.0.0.1:${web.port}/-/api/instances/alpha/control`, { signal: abort.signal });
    expect(tab.status).toBe(200);
    await until(() => host.tabCount() === 1);
    const env = { ...process.env, ASIDE_DAEMON_HOME: home, ASIDE_CAL_BIN: '/nonexistent/aside-cal' };
    const run = () => execFileAsync(process.execPath, [join(__dirname, '../dist/main.js'), 'daemon', 'stop'], { env, encoding: 'utf8', timeout: 20_000 });
    try {
      await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('1 connection and 1 open tab') });
      await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('aside daemon stop --force (-f)') });
      const before = await user.request<Status>('status');
      expect(before.loaded).toEqual([alpha]);
      user.close();
      // A browser tab alone also prevents stop, and its instance is identified.
      await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(`Instances in use:\n  ${alpha}`) });
      abort.abort();
      await until(() => host.tabCount() === 0);
      await sleep(150);
      expect(isLocked(paths.lifetimeLock)).toBe(true);
      // Write an isolated saved job without ever loading it into launchd.
      if (paths.job) writeJob(paths, process.execPath, join(__dirname, '../dist/main.js'), 1234);
      const stopped = await run();
      expect(stopped.stdout).toContain('Daemon stopped.');
      expect(isLocked(paths.lifetimeLock)).toBe(false);
      if (paths.job) {
        expect(stopped.stdout).toContain('login job is still installed');
        expect(readJob(paths)?.program).toEqual([process.execPath, BUNDLE, 'daemon', 'start', '--foreground']);
      }
    } finally { abort.abort(); }
  }, 100_000);

  it.skipIf(!existsSync(join(__dirname, '../dist/main.js'))).each(['-f', '--force'])('CLI stop %s gracefully disconnects busy clients and tabs', async option => {
    const alpha = instance('alpha');
    const host = new InstanceHost(new CalClient(null));
    await startDaemon({ known: [alpha], host });
    const user = client();
    await user.request('instance.info', { instance: alpha }, { read: true });
    const disconnected = vi.fn();
    user.onDisconnect(disconnected);
    const web = await host.web(join(__dirname, '../../webapp'));
    const abort = new AbortController();
    const flush = vi.spyOn(host, 'flush');
    try {
      const tab = await authenticatedFetch(`http://127.0.0.1:${web.port}/-/api/instances/alpha/control`, { signal: abort.signal });
      expect(tab.status).toBe(200);
      await until(() => host.tabCount() === 1);
      if (paths.job) writeJob(paths, process.execPath, BUNDLE, 1234);
      const env = { ...process.env, ASIDE_DAEMON_HOME: home, ASIDE_CAL_BIN: '/nonexistent/aside-cal' };
      const { stdout } = await execFileAsync(process.execPath, [BUNDLE, 'daemon', 'stop', option, ...(option === '--force' ? ['--json'] : [])], { env, timeout: 20_000 });
      if (option === '--force') {
        expect(JSON.parse(stdout)).toMatchObject({ command: 'daemon stop', ok: true, data: {
          stopped: true, was_running: true, connections: 1, tabs: 1, instances: [alpha],
        } });
      } else {
        expect(stdout).toContain('Daemon stopped.');
        if (paths.job) expect(stdout).toContain('login job is still installed');
      }
      expect(flush).toHaveBeenCalledTimes(1);
      expect(isLocked(paths.lifetimeLock)).toBe(false);
      expect(await tryConnect(paths)).toBeNull();
      await until(() => disconnected.mock.calls.length === 1);
      expect(host.tabCount()).toBe(0);
      if (paths.job) expect(readJob(paths)?.program).toEqual([process.execPath, BUNDLE, 'daemon', 'start', '--foreground']);
    } finally {
      abort.abort();
      flush.mockRestore();
    }
  });

  it('acknowledges shutdown and releases the socket and lock', async () => {
    const alpha = instance('alpha');
    const daemon = await startDaemon({ known: [alpha] });
    const conn = (await tryConnect(paths))!;
    expect(await conn.peer.request('shutdown')).toEqual({});
    await until(() => !isLocked(paths.lifetimeLock));
    expect(existsSync(paths.socket)).toBe(false);
    expect(await tryConnect(paths)).toBeNull();
    daemons.splice(daemons.indexOf(daemon), 1);
  });

  it('retries a read after the daemon is replaced, and reports a write whose connection dropped', async () => {
    const launches = { count: 0 };
    const first = await startDaemon();
    const dir = instance('alpha');
    const c = client(launches);
    await capture(c, dir, 'Before the restart');
    await first.shutdown();
    daemons.splice(daemons.indexOf(first), 1);
    const read = await c.request<ToolResult>('tool', { instance: dir, name: 'query_entries', args: {} }, { read: true });
    expect(read.text).toContain('Before the restart');
    expect(launches.count).toBe(1);

    // A connection that dies mid-write leaves the outcome unknown.
    const conn = (await tryConnect(paths))!;
    const pending = conn.peer.request('tool', { instance: dir, name: 'capture', args: { content: 'x', description: 'x' } });
    conn.peer.close();
    await expect(pending).rejects.toThrow(/connection closed/);
  });

  it('unloads an instance whose directory vanished while loaded', async () => {
    await startDaemon();
    const dir = instance('gone');
    const user = client();
    const watcher = client();
    await user.request('instance.info', { instance: dir }, { read: true });
    rmSync(dir, { recursive: true, force: true });
    user.close();
    await until(async () => (await watcher.request<Status>('status')).loaded.length === 0);
  });

  it('answers requests in flight on a connection another request retired', async () => {
    const launches = { count: 0 };
    const first = await startDaemon();
    const dir = instance('alpha');
    const c = client(launches);
    await capture(c, dir, 'Before');
    // Shut down mid-stream: requests sent after it are refused and resent to
    // the successor, while none is reported as lost.
    const stopping = first.shutdown();
    const reads = Array.from({ length: 4 }, () =>
      c.request<ToolResult>('tool', { instance: dir, name: 'query_entries', args: {} }, { read: true }));
    const results = await Promise.all(reads);
    await stopping;
    daemons.splice(daemons.indexOf(first), 1);
    for (const r of results) expect(r.text).toContain('Before');
    expect(launches.count).toBe(1);
  });

  it('rejects an unknown method and a request naming no instance', async () => {
    await startDaemon();
    const c = client();
    await expect(c.request('nope')).rejects.toThrow(/unknown method nope/);
    await expect(c.request('tool', { name: 'capture', args: { content: 'Note', description: 'Note' } })).rejects.toThrow(/No instance named/);
    await expect(c.request('instance.info', { instance: join(root, 'missing') })).rejects.toThrow(/Not an aside instance/);
  });
});

describe('FileLock', () => {
  it('is exclusive until released', () => {
    const dir = mkdtempSync('/tmp/aside-test-l-');
    try {
      const path = join(dir, 'x.lock');
      const a = new FileLock(path);
      const b = new FileLock(path);
      expect(a.tryAcquire()).toBe(true);
      expect(b.tryAcquire()).toBe(false);
      expect(isLocked(path)).toBe(true);
      a.release();
      expect(isLocked(path)).toBe(false);
      expect(b.tryAcquire()).toBe(true);
      b.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('daemon paths', () => {
  it('relocates everything under ASIDE_DAEMON_HOME and rejects an over-long socket path', () => {
    const p = daemonPaths({ ASIDE_DAEMON_HOME: '/tmp/x' });
    expect(p.homeOverride).toBe('/tmp/x');
    expect(p.socket).toBe('/tmp/x/daemon.sock');
    expect(p.log).toBe('/tmp/x/logs/daemon.log');
    expect(() => daemonPaths({ ASIDE_DAEMON_HOME: `/tmp/${'x'.repeat(120)}` })).toThrow(/too long/);
  });

  it('resolves a relative daemon home before the daemon changes working directory', () => {
    const p = daemonPaths({ ASIDE_DAEMON_HOME: 'state' });
    expect(p.homeOverride).toBe(resolve('state'));
    expect(p.state).toBe(resolve('state'));
    expect(p.socket).toBe(join(resolve('state'), 'daemon.sock'));
  });

  it.runIf(process.platform === 'darwin')('uses Application Support and Logs on macOS', () => {
    const p = daemonPaths({});
    expect(p.homeOverride).toBeNull();
    expect(p.state).toMatch(/Library\/Application Support\/sh\.117\.aside$/);
    expect(p.logs).toMatch(/Library\/Logs\/sh\.117\.aside$/);
    expect(p.job).toMatch(/Library\/LaunchAgents\/sh\.117\.aside\.daemon\.plist$/);
  });
});

describe.runIf(process.platform === 'darwin')('login job', () => {
  function environment(plist: string): NodeJS.ProcessEnv {
    const dict = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)![1];
    return Object.fromEntries([...dict.matchAll(/<key>(.*?)<\/key>\s*<string>(.*?)<\/string>/g)].map(m => [
      m[1], m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    ]));
  }

  it('carries a resolved relocated home to the login child using the shared job label', () => {
    const home = realpathSync(mkdtempSync('/tmp/aside-test-j-'));
    try {
      const target = join(home, 'state&files');
      const paths = daemonPaths({ ASIDE_DAEMON_HOME: relative(process.cwd(), target) });
      writeJob(paths, '/test/node', '/test/main.js', 1234);
      const plist = readFileSync(paths.job!, 'utf8');
      const env = environment(plist);
      expect(env.ASIDE_DAEMON_HOME).toBe(target);
      const child = daemonPaths(env);
      expect(child.socket).toBe(paths.socket);
      expect(child.log).toBe(paths.log);
      expect(child.job).toBe(paths.job);
      expect(plist).toContain(`<string>${JOB_LABEL}</string>`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('retains the default macOS log location in a job without a relocation', () => {
    const paths = daemonPaths({});
    const env = environment(renderJob('node', 'main.js', 1, paths.log, paths.homeOverride));
    expect(env.ASIDE_DAEMON_HOME).toBeUndefined();
    const child = daemonPaths(env);
    expect(child.socket).toBe(paths.socket);
    expect(child.log).toBe(paths.log);
  });

  it('renders a foreground start without instance arguments and reads it back', () => {
    const home = mkdtempSync('/tmp/aside-test-j-');
    try {
      const paths = daemonPaths({ ASIDE_DAEMON_HOME: home });
      expect(readJob(paths)).toBeNull();
      writeJob(paths, '/usr/local/bin/node', '/opt/a&b/main.js', 1234);
      const job = readJob(paths)!;
      expect(job.program).toEqual(['/usr/local/bin/node', '/opt/a&b/main.js', 'daemon', 'start', '--foreground']);
      expect(job.builtAt).toBe(1234);
      expect(job).not.toHaveProperty('selection');
      writeFileSync(paths.job!, 'not a plist');
      expect(readJob(paths)).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each(['<string>--dir</string><string>/data/work</string>', '<string>/data/work</string>', '<string>--all</string>'])('recognizes old login jobs and rewrites their obsolete arguments: %s', extra => {
    const home = mkdtempSync('/tmp/aside-test-j-');
    try {
      const paths = daemonPaths({ ASIDE_DAEMON_HOME: home });
      writeJob(paths, 'node', 'main.js', 1);
      const modern = readFileSync(paths.job!, 'utf8');
      writeFileSync(paths.job!, modern.replace('<string>--foreground</string>', `<string>--foreground</string>${extra}`));
      expect(readJob(paths)).not.toBeNull();
      writeJob(paths, 'node', 'new.js', 2);
      expect(readJob(paths)!.program).toEqual(['node', 'new.js', 'daemon', 'start', '--foreground']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('restarts after a crash only, and labels the job', () => {
    const plist = renderJob('node', 'main.js', 1, '/tmp/daemon.log');
    expect(plist).toContain('<string>sh.117.aside.daemon</string>');
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain('<key>RunAtLoad</key>');
  });
});

// The shipped bundle end to end: a command spawns the daemon, later commands
// find it, and `start` reuses it.
const BUNDLE = join(__dirname, '..', 'dist', 'main.js');
describe.skipIf(!existsSync(BUNDLE))('daemon (bundle)', () => {
  it.each([false, true])('reports foreground readiness before exit (replacement: %s)', async replacement => {
    const root = realpathSync(mkdtempSync('/tmp/aside-start-'));
    const home = join(root, 'state');
    const env = { ...process.env, ASIDE_DAEMON_HOME: home, ASIDE_CAL_BIN: '/nonexistent/aside-cal' };
    let previousPid: number | undefined;
    if (replacement) {
      const source = readFileSync(join(__dirname, '..', 'dist', 'runtime.js'), 'utf8');
      const stamp = source.match(/builtAt:(\d{13})/)![1];
      const older = join(root, 'main.js');
      writeFileSync(older, readFileSync(BUNDLE, 'utf8'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(join(root, 'runtime.js'), source.replaceAll(stamp, String(Number(stamp) - 1000)));
      const { stdout } = await execFileAsync(process.execPath, [older, 'daemon', 'start', '--json'], { env });
      previousPid = JSON.parse(stdout).data.pid;
    }
    const child = spawn(process.execPath, [BUNDLE, 'daemon', 'start', '--foreground', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    try {
      await until(() => { try { return JSON.parse(stdout).ok === true; } catch { return false; } });
      const { data } = JSON.parse(stdout);
      expect(data).toMatchObject({ action: replacement ? 'replaced' : 'started', pid: child.pid });
      if (replacement) expect(data.previousPid).toBe(previousPid);
      else expect(data).not.toHaveProperty('previousPid');
      expect(child.exitCode).toBeNull();
      const reused = await execFileAsync(process.execPath, [BUNDLE, 'daemon', 'start', '--foreground'], { env });
      expect(reused.stdout).toContain(`Reused running daemon (pid ${child.pid}); no replacement.`);
    } finally {
      child.kill('SIGTERM');
      try { await until(() => child.exitCode !== null || child.signalCode !== null); }
      finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        try { await execFileAsync(process.execPath, [BUNDLE, 'daemon', 'stop'], { env }); } catch {}
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it.runIf(process.platform === 'darwin')('keeps foreground helper recovery paths at the resolved relative daemon home', async () => {
    const root = realpathSync(mkdtempSync('/tmp/aside-home-'));
    const home = join(root, 'state');
    const helper = join(root, 'fake-helper');
    // This executable only exits on input; it never loads EventKit or Calendar.
    writeFileSync(helper, `#!${process.execPath}\nprocess.stdin.once('data', () => process.stderr.write('isolated-helper-failure\\n', () => process.exit(7)));\n`, { mode: 0o755 });
    const env = { ...process.env, ASIDE_DAEMON_HOME: 'state', ASIDE_CAL_BIN: helper };
    const child = spawn(process.execPath, [BUNDLE, 'daemon', 'start', '--foreground'], { cwd: root, env, stdio: 'ignore' });
    const paths = daemonPaths({ ASIDE_DAEMON_HOME: home });
    let conn: Awaited<ReturnType<typeof tryConnect>> = null;
    try {
      await until(async () => { conn = await tryConnect(paths); return conn !== null; });
      const result = await conn!.peer.request<{ text: string }>('tool', { instance: null, name: 'calendar_info', args: {} });
      expect(result.text).toContain('category: "helper-exited"');
      expect(result.text).toContain('exit_code: 7');
      expect(result.text).toContain(`log_path: ${JSON.stringify(paths.log)}`);
    } finally {
      conn?.peer.close();
      child.kill('SIGTERM');
      try { await until(() => child.exitCode !== null || child.signalCode !== null); }
      finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('starts from legacy loaded login-job arguments after a rebuild', async () => {
    const root = realpathSync(mkdtempSync('/tmp/aside-legacy-job-'));
    const home = join(root, 'state'), dir = join(root, 'instance');
    init(dir, { name: 'Legacy', description: 'Saved launch arguments' });
    const registry = daemonPaths({ ASIDE_DAEMON_HOME: home });
    mkdirSync(home);
    writeFileSync(registry.known, JSON.stringify([dir]));
    const env = { ...process.env, ASIDE_DAEMON_HOME: home, ASIDE_CAL_BIN: '/nonexistent/aside-cal', ASIDE_JOB_BUILT_AT: '1234' };
    const child = spawn(process.execPath, [BUNDLE, 'daemon', 'start', '--foreground', dir], { cwd: root, env, stdio: 'ignore' });
    const paths = daemonPaths({ ASIDE_DAEMON_HOME: home });
    let conn: Awaited<ReturnType<typeof tryConnect>> = null;
    try {
      await until(async () => { conn = await tryConnect(paths); return conn !== null; });
      const status = await conn!.peer.request<Status>('status');
      expect(status.loaded).toContain(dir);
    } finally {
      conn?.peer.close();
      child.kill('SIGTERM');
      try { await until(() => child.exitCode !== null || child.signalCode !== null); }
      finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('starts and reconnects at a relative daemon home without relocating twice', () => {
    const root = realpathSync(mkdtempSync('/tmp/aside-home-'));
    const home = join(root, 'state');
    const env = { ...process.env, ASIDE_DAEMON_HOME: 'state', ASIDE_CAL_BIN: '/nonexistent/aside-cal' };
    const aside = (...args: string[]) => execFileSync(process.execPath, [BUNDLE, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
    try {
      const started = JSON.parse(aside('daemon', 'start', '--json'));
      expect(started.data).toMatchObject({ action: 'started' });
      expect(started.data).not.toHaveProperty('longRunning');
      expect(started.data).not.toHaveProperty('selection');
      expect(started.data).not.toHaveProperty('previousPid');
      expect(aside('daemon', 'start')).toContain('Reused running daemon');
      expect(aside('daemon', 'status')).toContain('[OK] Daemon connection');
      expect(existsSync(join(home, 'daemon.sock'))).toBe(true);
      expect(existsSync(join(home, 'logs', 'daemon.log'))).toBe(true);
      expect(existsSync(join(home, 'state'))).toBe(false);
      expect(aside('daemon', 'stop')).toContain('Daemon stopped.');
      expect(aside('daemon', 'status')).toContain('[OK] Daemon stopped');
    } finally {
      try { aside('daemon', 'stop'); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('starts on demand, stays running, is reused by start, and stops', () => {
    const home = mkdtempSync('/tmp/aside-test-b-');
    const root = realpathSync(mkdtempSync('/tmp/aside-test-i-'));
    const env = { ...process.env, ASIDE_DAEMON_HOME: home };
    const aside = (...args: string[]) => execFileSync('node', [BUNDLE, ...args], { env, encoding: 'utf8', timeout: 30_000 });
    try {
      const dir = join(root, 'inst');
      init(dir, { name: 'Bundle', description: 'Bundle instance' });
      expect(aside('daemon', 'status')).toContain('[OK] Daemon stopped');
      expect(aside('artifact', 'create', '--dir', dir, '--name', 'Plan', '--description', 'A plan')).toContain('#artifact/');
      const spawned = aside('daemon', 'status');
      expect(spawned).toContain('[OK] Daemon connection');
      expect(spawned).not.toContain('Background selection');
      expect(spawned).toContain(dir);
      const pid = spawned.match(/PID\s+(\d+)/)![1];
      const reused = aside('daemon', 'start');
      expect(reused).toContain(`Reused running daemon (pid ${pid}); no replacement.`);
      expect(aside('daemon', 'status')).toContain('(loaded');
      // A foreground start returns once another process owns the daemon.
      expect(aside('daemon', 'start', '--foreground')).toContain(`pid ${pid}`);
      expect(aside('instance', 'forget', '--dir', dir)).toContain(`Forgotten\n  ${dir}`);
      expect(aside('daemon', 'stop')).toContain('Daemon stopped.');
      expect(aside('daemon', 'status')).toContain('[OK] Daemon stopped');
    } finally {
      try { aside('daemon', 'stop'); } catch {}
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.each([false, true])('a newer build replaces the daemon and reloads known instances; an older one uses it (json: %s)', json => {
    const home = mkdtempSync('/tmp/aside-test-b-');
    const root = realpathSync(mkdtempSync('/tmp/aside-test-i-'));
    const env = { ...process.env, ASIDE_DAEMON_HOME: home };
    const run = (bundle: string, ...args: string[]) => execFileSync('node', [bundle, ...args], { env, encoding: 'utf8', timeout: 30_000 });
    try {
      // The same bundle with a later build stamp stands in for a newer build.
      const source = readFileSync(join(__dirname, '..', 'dist', 'runtime.js'), 'utf8');
      const stamp = source.match(/builtAt:(\d{13})/)![1];
      const newer = join(root, 'main.js');
      writeFileSync(newer, readFileSync(BUNDLE, 'utf8'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(join(root, 'runtime.js'), source.replaceAll(stamp, String(Number(stamp) + 1000)));
      const dir = join(root, 'inst');
      init(dir, { name: 'Versions', description: 'Version rules' });

      run(BUNDLE, 'instance', 'add', '--dir', dir);
      const started = run(BUNDLE, 'daemon', 'start');
      expect(started).toContain('Started new daemon');
      const old = started.match(/pid (\d+)/)![1];
      const replacement = run(newer, 'daemon', 'start', ...(json ? ['--json'] : []));
      if (json) {
        expect(JSON.parse(replacement).data).toMatchObject({ action: 'replaced', previousPid: Number(old) });
        expect(JSON.parse(replacement).data.pid).not.toBe(Number(old));
      } else {
        expect(replacement).toContain(`Replaced daemon (pid ${old}) with newer build (pid `);
      }
      expect(run(newer, 'artifact', 'query', '--dir', dir)).toContain('0 of 0');
      const replaced = run(newer, 'daemon', 'status');
      expect(replaced).not.toContain(`pid ${old})`);
      expect(replaced).toContain('(loaded');
      const pid = replaced.match(/PID\s+(\d+)/)![1];
      if (json) expect(String(JSON.parse(replacement).data.pid)).toBe(pid);
      expect(run(BUNDLE, 'daemon', 'start')).toContain(`Reused running daemon (pid ${pid}); no replacement.`);
      // The older build never displaces the newer daemon.
      expect(run(BUNDLE, 'artifact', 'query', '--dir', dir)).toContain('0 of 0');
      expect(run(BUNDLE, 'daemon', 'status')).toMatch(new RegExp(`PID\\s+${pid}`));
    } finally {
      try { run(BUNDLE, 'daemon', 'stop'); } catch {}
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
