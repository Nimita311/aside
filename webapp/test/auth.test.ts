// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch, initializeAuth, connectAuthenticatedEvents, AuthenticationRequiredError, RECONNECT_GUIDANCE, WEB_TOKEN_KEY, type AuthState } from '../src/auth';
import { connectControl } from '../src/control';
import { EventStream } from './auth-fixture';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';

const stops: (() => void)[] = [];
beforeEach(() => { localStorage.clear(); EventStream.streams = []; });
afterEach(() => {
  stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); localStorage.clear();
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function authorize(deadline = Date.now() + 60_000) {
  localStorage.setItem(WEB_TOKEN_KEY, 'first-token');
  const states: AuthState[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/-/api/auth') return Response.json({ expiresAt: deadline });
    return new EventStream(url, init?.signal).response;
  });
  vi.stubGlobal('fetch', request);
  stops.push(initializeAuth(state => states.push(state)));
  return { request, states };
}

describe('browser session access', () => {
  it('requires a local handoff before sending any request', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const states: AuthState[] = [];
    stops.push(initializeAuth(state => states.push(state)));
    expect(states).toEqual(['required']);
    await expect(authFetch('/-/api/instances')).rejects.toThrow(RECONNECT_GUIDANCE);
    expect(request).not.toHaveBeenCalled();
  });

  it('adds bearer headers while preserving validators and keeps credentials off other origins', async () => {
    localStorage.setItem(WEB_TOKEN_KEY, 'secret');
    const request = vi.fn().mockResolvedValue(new Response('', { status: 304 })); vi.stubGlobal('fetch', request);
    expect((await authFetch('/-/api/instances/work/data', { headers: { 'If-None-Match': 'v1' } })).status).toBe(304);
    const headers = new Headers(request.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer secret'); expect(headers.get('If-None-Match')).toBe('v1');
    await expect(authFetch('https://attacker.example/')).rejects.toThrow('another origin');
    expect(request).toHaveBeenCalledOnce();
  });

  it('expires at the server deadline, closes streams and never renews over HTTP', async () => {
    vi.useFakeTimers();
    const { request, states } = authorize(Date.now() + 1000); await flush();
    stops.push(connectAuthenticatedEvents('/-/api/control', { message: vi.fn() })); await flush();
    const stream = EventStream.streams[0];
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.at(-1)).toBe('required'); expect(localStorage.getItem(WEB_TOKEN_KEY)).toBeNull();
    expect(stream.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/-/api/auth', '/-/api/control', '/-/api/auth']);
  });

  it('rechecks a missed renewal before a stale tab can remove the shared token', async () => {
    vi.useFakeTimers();
    const { request, states } = authorize(Date.now() + 1000); await flush();
    stops.push(connectAuthenticatedEvents('/-/api/control', { message: vi.fn() })); await flush();
    const stream = EventStream.streams[0];
    // Another tab's trusted show renewed this session while this stream missed
    // its broadcast. The daemon's deadline is newer than this tab's timer.
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.at(-1)).toBe('checking'); expect(stream.close).toHaveBeenCalledOnce();
    expect(localStorage.getItem(WEB_TOKEN_KEY)).toBe('first-token');
    finish(Response.json({ expiresAt: Date.now() + 5000 })); await flush();
    expect(states.at(-1)).toBe('authorized');
    expect(localStorage.getItem(WEB_TOKEN_KEY)).toBe('first-token');
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/-/api/auth', '/-/api/control', '/-/api/auth']);
  });

  it('hides expired content offline without erasing a potentially renewed token', async () => {
    vi.useFakeTimers();
    const { request, states } = authorize(Date.now() + 1000); await flush();
    stops.push(connectAuthenticatedEvents('/-/api/control', { message: vi.fn() })); await flush();
    request.mockRejectedValueOnce(new TypeError('Network unavailable'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.slice(-2)).toEqual(['checking', 'offline']);
    expect(localStorage.getItem(WEB_TOKEN_KEY)).toBe('first-token');
    expect(EventStream.streams[0].close).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce(Response.json({ expiresAt: Date.now() + 5000 }));
    window.dispatchEvent(new Event('focus')); await flush();
    expect(states.at(-1)).toBe('authorized');
    expect(localStorage.getItem(WEB_TOKEN_KEY)).toBe('first-token');
  });

  it('checks suspended timers on focus and blocks reads until the deadline is verified', async () => {
    vi.useFakeTimers();
    const { request, states } = authorize(Date.now() + 1000); await flush();
    vi.setSystemTime(Date.now() + 1000);
    request.mockResolvedValueOnce(Response.json({ expiresAt: Date.now() + 5000 }));
    await expect(authFetch('/-/api/instances')).rejects.toBeInstanceOf(AuthenticationRequiredError);
    await flush();
    expect(states.slice(-2)).toEqual(['checking', 'authorized']);
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/-/api/auth', '/-/api/auth']);
    vi.setSystemTime(Date.now() + 5000);
    request.mockResolvedValueOnce(Response.json({ expiresAt: Date.now() + 5000 }));
    window.dispatchEvent(new Event('focus')); await flush();
    expect(states.slice(-2)).toEqual(['checking', 'authorized']);
    expect(localStorage.getItem(WEB_TOKEN_KEY)).toBe('first-token');
  });

  it('rearms a long session deadline without overflowing the browser timer', async () => {
    vi.useFakeTimers();
    const { states } = authorize(Date.now() + 30 * 24 * 60 * 60 * 1000); await flush();
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(states.at(-1)).toBe('authorized');
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1000 - 2_147_483_647);
    expect(states.at(-1)).toBe('required');
  });

  it('accepts auth heartbeat renewal and closes on an explicit expiry event', async () => {
    vi.useFakeTimers();
    const { states } = authorize(Date.now() + 1000); await flush();
    const message = vi.fn(); stops.push(connectAuthenticatedEvents('/-/api/control', { message })); await flush();
    const stream = EventStream.streams[0];
    stream.send(JSON.stringify({ expiresAt: Date.now() + 5000 }), 'auth'); await flush();
    await vi.advanceTimersByTimeAsync(1500); expect(states.at(-1)).toBe('authorized');
    stream.send('{"navigate":"/work/"}'); await flush(); expect(message).toHaveBeenCalledWith('{"navigate":"/work/"}');
    stream.send('{}', 'auth-expired'); await flush(); expect(states.at(-1)).toBe('required');
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it('treats a 401 as expired access and stops pending requests and streams', async () => {
    const { states } = authorize(); await flush();
    stops.push(connectAuthenticatedEvents('/-/api/control', { message: vi.fn() })); await flush();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: 'AUTH_REQUIRED', error: 'Expired' }, { status: 401 })));
    await expect(authFetch('/-/api/instances')).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(states.at(-1)).toBe('required'); expect(EventStream.streams[0].close).toHaveBeenCalledOnce();
  });

  it('restores another tab’s handoff and ignores a late 401 from the previous token', async () => {
    const { request, states } = authorize(); await flush();
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const pending = authFetch('/-/api/instances');
    localStorage.setItem(WEB_TOKEN_KEY, 'second-token');
    window.dispatchEvent(new StorageEvent('storage', { key: WEB_TOKEN_KEY, newValue: 'second-token' })); await flush();
    expect(states.slice(-2)).toEqual(['checking', 'authorized']);
    finish(Response.json({ error: 'Old session' }, { status: 401 }));
    await expect(pending).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(localStorage.getItem(WEB_TOKEN_KEY)).toBe('second-token'); expect(states.at(-1)).toBe('authorized');
    expect(new Headers(request.mock.calls.at(-1)?.[1]?.headers).get('Authorization')).toBe('Bearer second-token');
  });

  it('sends authenticated focus reports and handles navigation over fetch SSE', async () => {
    const { request } = authorize(); await flush();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const navigate = vi.fn(), connection = vi.fn();
    stops.push(connectControl('work', navigate, connection)); await flush();
    EventStream.streams[0].send('{"tab":7}'); await flush();
    const post = request.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ focus: 7 });
    expect(new Headers(post[1]!.headers).get('Authorization')).toBe('Bearer first-token');
    EventStream.streams[0].send('{"navigate":"artifact/report"}'); await flush();
    expect(navigate).toHaveBeenCalledWith('artifact/report'); expect(connection).toHaveBeenCalledWith(true, undefined);
  });

  it('clears protected content and iframe grants, preserves the route, and restores after a handoff', async () => {
    document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    history.replaceState({}, '', '/work/?keep=1#anchor');
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    interface App {
      initializeAuth(callback: (state: AuthState) => void): () => void;
      authenticationChanged(state: AuthState): void;
      setupModals(): void;
      showConfigModal(): void;
      clearInstanceView(): void;
      stopControl?: () => void;
      iframeQueries: { clear(): void };
    }
    const app = await loadApp<App>('initializeAuth, authenticationChanged, setupModals, showConfigModal, clearInstanceView, stopControl, iframeQueries');
    app.setupModals();
    const clear = vi.spyOn(app.iframeQueries, 'clear');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/-/api/auth') return Response.json({ expiresAt: Date.now() + 60_000 });
      if (url.endsWith('/control') || url.endsWith('/watch')) return new EventStream(url, init?.signal).response;
      if (url.endsWith('/access')) return Response.json({ fileBase: '/-/files/00000000-0000-4000-8000-000000000002/work', fileKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
      if (url.endsWith('/data')) return Response.json(snapshotFixture(), { headers: { ETag: 'v1' } });
      return Response.json({ id: 'work', name: 'Work', path: '/fixture/work' });
    }));
    stops.push(app.initializeAuth(app.authenticationChanged));
    expect(document.querySelector('#flow')?.textContent).toBe(RECONNECT_GUIDANCE);
    expect(location.pathname + location.search + location.hash).toBe('/work/?keep=1#anchor');
    localStorage.setItem(WEB_TOKEN_KEY, 'renewed-token');
    window.dispatchEvent(new StorageEvent('storage', { key: WEB_TOKEN_KEY, newValue: 'renewed-token' }));
    await vi.waitFor(() => expect(document.querySelector('#flow')?.textContent).toContain('Good note body.'));
    document.querySelector('#doc-body')!.innerHTML = '<iframe src="about:blank"></iframe>Private document';
    app.showConfigModal();
    expect(document.querySelector<HTMLDialogElement>('#modal-backdrop')!.open).toBe(true);
    app.authenticationChanged('required');
    expect(document.querySelector<HTMLDialogElement>('#modal-backdrop')!.open).toBe(false);
    expect(document.querySelector('#doc-body')?.childElementCount).toBe(0);
    expect(document.querySelector('#flow')?.textContent).toBe(RECONNECT_GUIDANCE);
    expect(clear).toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe('/work/?keep=1#anchor');
    app.stopControl?.(); app.clearInstanceView();
  });
});
