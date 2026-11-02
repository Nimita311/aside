import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, delimiter, join } from 'node:path';
import { init } from '../src/commands/init.js';
import { runShow, type ShowContext } from '../src/commands/show.js';
import { parseShowTarget } from '../src/commands/show-target.js';
import { Daemon, writeKnown } from '../src/daemon/daemon.js';
import { DaemonClient } from '../src/daemon/client.js';
import { InstanceHost, type ToolResult } from '../src/daemon/host.js';
import { ownHello, type HelloResult } from '../src/daemon/protocol.js';
import { daemonPaths, ensureDirs } from '../src/daemon/paths.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { availableInstances } from '../src/web/catalogue.js';

describe('show targets', () => {
  it.each([
    ['#project/2026-10-05-launch', { project: '2026-10-05-launch', detail: true }],
    ['#action/2026-10-05-review', { action: '2026-10-05-review', detail: true }],
    ['#entry/2026-10-05T12:30', { entry: '2026-10-05T12:30' }],
    ['#artifact/2026-10-05-brief/diagram%20%231.svg', { artifact: '2026-10-05-brief', filename: 'diagram #1.svg' }],
    ['aside://work', {}], ['aside://work/', {}],
    ['aside://work/project/2026-10-05-launch/detail', { project: '2026-10-05-launch', detail: true }],
    ['aside://work/action/2026-10-05-review/done', { action: '2026-10-05-review', detail: true }],
    ['aside://work/action/2026-10-05-review/cancelled', { action: '2026-10-05-review', detail: true }],
    ['aside://work/action/2026-10-05-review/backlog', { action: '2026-10-05-review', detail: true }],
    ['aside://work/action/2026-10-05-%E4%BF%AE%E8%AE%A2', { action: '2026-10-05-修订', detail: true }],
    ['aside://work/entry/2026-10-05T12%3A30%3A15', { entry: '2026-10-05T12:30:15' }],
    ['aside://work/2026-10-05T12:30', { entry: '2026-10-05T12:30' }],
  ])('resolves %s to a show target', (target, args) => {
    expect(parseShowTarget(target)).toEqual({ ...(target.startsWith('aside://') ? { instanceId: 'work' } : {}), args });
  });

  it.each([
    '', 'https://example.com/action/a', 'aside://WORK/action/a', 'aside://user@work/action/a',
    'aside://work:24800/action/a', 'aside://work/action/a?change=done', 'aside://work/action/a#fragment',
    'aside://work/action/%2Foutside', 'aside://work/action/%ZZ', 'aside://work/action/a/unknown',
    '#action/../outside', '#entry/2026-02-30T12:00', '#entry/2026-10-05T25:00',
    '#artifact/not-an-id', '#artifact/2026-10-05-brief/%2Foutside', '#artifact/2026-10-05-brief/..',
  ])('rejects malformed targets %j', target => {
    expect(() => parseShowTarget(target)).toThrow();
  });
});

describe('show command', () => {
  let root: string, work: string;
  let request: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>;
  let context: ShowContext;
  beforeEach(() => {
    root = realpathSync(mkdtempSync('/tmp/aside-show-'));
    work = join(root, 'work');
    init(work, { name: 'Work', description: 'Show targets' });
    request = vi.fn(async method => method === 'status' ? { known: [work] } : { port: 24800, route: method === 'show' ? 'work/action/2026-10-05-review/detail' : '' });
    close = vi.fn();
    context = { cwd: work, client: vi.fn(() => ({ request, close })), open: vi.fn(async () => true), out: vi.fn() };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('opens the selector, even when the current directory is an instance, then releases the connection', async () => {
    await runShow([], context);
    expect(request).toHaveBeenCalledExactlyOnceWith('serve', {});
    expect(context.open).toHaveBeenCalledWith('http://localhost:24800/');
    expect(close).toHaveBeenCalledOnce();
  });

  it('opens a private handoff while printing only the bookmark URL', async () => {
    request.mockResolvedValueOnce({ port: 24800, route: '', url: 'http://localhost:24800/', launchUrl: 'file:///private/handoff.html' });
    await runShow([], context);
    expect(context.open).toHaveBeenCalledWith('file:///private/handoff.html');
    expect(context.out).toHaveBeenCalledWith('Opened browser: http://localhost:24800/');
  });

  it('opens a handle in the workspace instance', async () => {
    await runShow(['#action/2026-10-05-review'], context);
    expect(request).toHaveBeenCalledExactlyOnceWith('show', { instance: work, args: { action: '2026-10-05-review', detail: true } });
    expect(context.open).toHaveBeenCalledWith('http://localhost:24800/work/action/2026-10-05-review/detail');
  });

  it.each([false, true])('prints the selector URL without opening a browser and closes the connection (json: %s)', async json => {
    await runShow(['--url', ...(json ? ['--json'] : [])], context);
    expect(request).toHaveBeenCalledExactlyOnceWith('serve', { navigate: false });
    expect(context.open).not.toHaveBeenCalled();
    if (json) expect(JSON.parse(vi.mocked(context.out!).mock.calls[0][0])).toMatchObject({ command: 'show', data: { url: 'http://localhost:24800/', reused_tab: false } });
    else expect(context.out).toHaveBeenCalledWith('http://localhost:24800/');
    expect(close).toHaveBeenCalledOnce();
  });

  it('requests a validated object URL without navigating an open tab', async () => {
    await runShow(['#action/2026-10-05-review', '--url'], context);
    expect(request).toHaveBeenCalledExactlyOnceWith('show', {
      instance: work, args: { action: '2026-10-05-review', detail: true }, navigate: false,
    }, { read: true });
    expect(context.open).not.toHaveBeenCalled();
    expect(context.out).toHaveBeenCalledWith('http://localhost:24800/work/action/2026-10-05-review/detail');
    expect(close).toHaveBeenCalledOnce();
  });

  it('accepts an explicit directory for a timeline URL and passes the webapp override', async () => {
    await runShow(['--url', '--dir', work, '--app-dir=../webapp'], context);
    expect(request).toHaveBeenCalledExactlyOnceWith('show', {
      instance: work, args: {}, appDir: join(root, 'webapp'), navigate: false,
    }, { read: true });
    expect(context.open).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('resolves a URL from the known catalogue outside its workspace', async () => {
    await runShow(['aside://work/action/2026-10-05-review'], { ...context, cwd: '/nonexistent/aside-workspace' });
    expect(request).toHaveBeenLastCalledWith('show', { instance: work, args: { action: '2026-10-05-review', detail: true } });
  });

  it('uses the sole known instance for a handle outside its workspace', async () => {
    await runShow(['#action/2026-10-05-review'], { ...context, cwd: '/nonexistent/aside-workspace' });
    expect(request).toHaveBeenLastCalledWith('show', { instance: work, args: { action: '2026-10-05-review', detail: true } });
  });

  it('reports ambiguity and lets --dir select a handle explicitly', async () => {
    const personal = join(root, 'personal');
    init(personal, { name: 'Personal', description: 'Other records' });
    request.mockResolvedValueOnce({ known: [work, personal] });
    await expect(runShow(['#action/2026-10-05-review'], { ...context, cwd: root })).rejects.toThrow(/Pass --dir/);
    expect(context.open).not.toHaveBeenCalled();
    await runShow(['#action/2026-10-05-review', `--dir=${personal}`], context);
    expect(request).toHaveBeenLastCalledWith('show', { instance: personal, args: { action: '2026-10-05-review', detail: true } });
  });

  it('rejects a mismatched URL directory and duplicate instance identity', async () => {
    await expect(runShow(['aside://personal/action/a', '--dir', work], context)).rejects.toThrow(/URL names instance/);
    expect(request).not.toHaveBeenCalled();
    const duplicate = join(root, 'duplicate');
    init(duplicate, { name: 'Work', description: 'Duplicate identity' });
    request.mockResolvedValueOnce({ known: [work, duplicate] });
    await expect(runShow(['aside://work/action/a'], context)).rejects.toThrow(/Instance "work" is unavailable/);
    expect(context.open).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({ known: [work, duplicate] });
    const alias = availableInstances([work, duplicate]).find(instance => instance.path === duplicate)!.alias;
    await runShow([`aside://${alias}/action/a`], context);
    expect(request).toHaveBeenLastCalledWith('show', { instance: duplicate, args: { action: 'a', detail: true } });
  });

  it('reports an unknown URL instance without opening a browser', async () => {
    await expect(runShow(['aside://missing/action/a'], context)).rejects.toThrow(/Instance "missing" is unavailable/);
    expect(context.open).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports a useful URL when browser launch fails', async () => {
    context.open = vi.fn(async () => false);
    await expect(runShow([], context)).rejects.toThrow(/Could not open the browser.*http:\/\/localhost:24800\//);
    expect(close).toHaveBeenCalledOnce();
  });

  it('prints help before filesystem checks and never constructs a client', async () => {
    await runShow(['#action/a', '--dir=/missing', '--help'], context);
    expect(context.out).toHaveBeenCalledWith(expect.stringContaining('Usage: aside show'));
    expect(context.client).not.toHaveBeenCalled();
    expect(context.open).not.toHaveBeenCalled();
  });

  it.each([
    ['#action/a', '#action/b'], ['--target'], [''],
    ['https://example.com'], ['--dir', 'work'], ['--unknown'], ['#action/a', 'extra'],
  ])('rejects invalid syntax %j before daemon startup', async (...args) => {
    await expect(runShow(args, context)).rejects.toThrow();
    expect(context.client).not.toHaveBeenCalled();
    expect(context.open).not.toHaveBeenCalled();
  });
});

it('opens an artifact through the real daemon and validates missing objects before browser launch', async () => {
  const root = realpathSync(mkdtempSync('/tmp/aside-show-daemon-'));
  const paths = daemonPaths({ ASIDE_DAEMON_HOME: join(root, 'state') });
  const work = join(root, 'work');
  init(work, { name: 'Work', description: 'Daemon show' });
  const host = new InstanceHost(new CalClient(null));
  ensureDirs(paths);
  writeKnown(paths, [work]);
  const daemon = new Daemon({ paths, webPort: 0, host });
  const owner = new DaemonClient({ paths });
  const open = vi.fn(async () => true), out = vi.fn();
  try {
    expect(await daemon.listen()).toBe(true);
    const created = await owner.request<ToolResult>('tool', { instance: work, name: 'create_artifact', args: { name: 'Brief', description: 'Browser content', body: '# Brief' } });
    const id = created.text.match(/#artifact\/([^\s]+)/)![1];
    const context = { cwd: root, client: () => new DaemonClient({ paths }), open, out };
    await runShow([`aside://work/artifact/${id}`], context);
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0][0]).toMatch(/^file:\/\//);
    expect(readFileSync(new URL(open.mock.calls[0][0]), 'utf8')).toContain('/-/auth/complete');
    const url = out.mock.calls[0][0].replace('Opened browser: ', '');
    expect(url).toMatch(new RegExp(`/work/artifact/${id}$`));
    const response = await fetch(url);
    expect(response.status).toBe(200);
    open.mockClear();
    out.mockClear();
    const server = await host.web();
    const navigate = vi.spyOn(server, 'navigate');
    try {
      await runShow([`aside://work/artifact/${id}`, '--url'], context);
      expect(out).toHaveBeenCalledWith(url);
      expect(navigate).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      await expect(runShow(['#artifact/2026-10-05-missing', '--dir', work, '--url'], context)).rejects.toThrow(/not found/);
      expect(navigate).not.toHaveBeenCalled();
    } finally { navigate.mockRestore(); }
    await expect(runShow(['#artifact/2026-10-05-missing', '--dir', work], context)).rejects.toThrow(/not found/);
    expect(open).not.toHaveBeenCalled();
  } finally {
    owner.close();
    await daemon.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

const bundle = join(__dirname, '..', 'dist', 'main.js');
it.skipIf(!existsSync(bundle) || process.platform === 'win32')('the shipped show command opens the selector and an object, then exits', async () => {
  const root = realpathSync(mkdtempSync('/tmp/aside-show-bundle-'));
  const work = join(root, 'work'), bin = join(root, 'bin'), receipt = join(root, 'opened-url');
  const paths = daemonPaths({ ASIDE_DAEMON_HOME: join(root, 'state') });
  const host = new InstanceHost(new CalClient(null));
  const daemon = new Daemon({ paths, webPort: 0, host });
  // Keep the bundled client on this isolated daemon rather than replacing it.
  const hello = ownHello();
  const handshake = vi.spyOn(daemon as unknown as { hello(): HelloResult }, 'hello').mockReturnValue({
    ...hello, build: { ...hello.build, builtAt: Number.MAX_SAFE_INTEGER }, pid: process.pid,
  });
  init(work, { name: `Show ${basename(root)}`, description: 'Bundled browser command' });
  mkdirSync(bin);
  // Capture the browser URL instead of opening a real application.
  writeFileSync(join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ASIDE_TEST_SHOW_URL, process.argv.at(-1));\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ASIDE_TEST_SHOW_URL: receipt, ASIDE_DAEMON_HOME: paths.state };
  const execute = promisify(execFile);
  const run = (...args: string[]) => execute(process.execPath, [bundle, ...args], { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
  try {
    expect(await daemon.listen()).toBe(true);
    const port = (await host.web()).port;
    const selector = await run('show');
    expect(selector.stderr).toBe('');
    expect(readFileSync(receipt, 'utf8')).toMatch(/^file:\/\//);
    expect(selector.stdout).toContain(`http://localhost:${port}/`);
    const created = await run('artifact', 'create', '--dir', work, '--name', 'Brief', '--description', 'Show the brief');
    const handle = created.stdout.match(/#artifact\/[^\s]+/)![0];
    const object = await run('show', handle, '--dir', work);
    expect(object.stderr).toBe('');
    expect(object.stdout).toContain('Opened browser:');
    expect(readFileSync(receipt, 'utf8')).toMatch(/^file:\/\//);
    const objectUrl = object.stdout.trim().replace('Opened browser: ', '');
    expect(objectUrl).toContain(`/artifact/${handle.slice('#artifact/'.length)}`);
    rmSync(receipt);
    const printed = await run('show', handle, '--dir', work, '--url');
    expect(printed.stdout.trim()).toBe(objectUrl);
    expect(printed.stderr).toBe('');
    const chooserUrl = await run('show', '--url');
    expect(chooserUrl.stdout.trim()).toBe(`http://localhost:${port}/`);
    const timelineUrl = await run('show', '--url', '--dir', work, '--json');
    expect(JSON.parse(timelineUrl.stdout).data).toMatchObject({ url: objectUrl.slice(0, objectUrl.indexOf('/artifact/') + 1), reused_tab: false });
    expect(existsSync(receipt)).toBe(false);
  } finally {
    handshake.mockRestore();
    await daemon.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}, 75_000);
