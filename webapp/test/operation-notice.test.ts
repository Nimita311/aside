// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showNotice, showDelayedLoading } from '../src/notice';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';

import { EventStream as Events, stubBrowserFetch } from './auth-fixture';

interface App {
  controlFor(id: string | null): void;
  connectToInstance(id: string): Promise<void>;
  stopControl(): void;
  dismissActionToast(): void;
  showInstanceChooser(): Promise<void>;
  clearInstanceView(): void;
  instanceChooser?: { dispose(): void };
}
let app: App | undefined;

beforeEach(() => { Events.streams = []; stubBrowserFetch(() => new Response('', { status: 404 })); });
afterEach(() => { app?.dismissActionToast(); app?.stopControl(); app?.clearInstanceView?.(); app?.instanceChooser?.dispose(); app = undefined; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

async function pendingEntries(ids: string[]) {
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  const instances = ids.map(id => ({ id, name: id, path: `/fixture/${id}` }));
  const weeks = new Map<string, (response: Response) => void>();
  stubBrowserFetch(vi.fn(async (url: string) => {
    if (url === '/-/api/instances') return Response.json(instances);
    const id = url.split('/')[4];
    if (url === `/-/api/instances/${id}`) return Response.json(instances.find(instance => instance.id === id));
    if (url.endsWith('/data')) return new Promise<Response>(resolve => { weeks.set(id, resolve); });
    return new Response('', { status: 404 });
  }));
  app = await loadApp<App>('controlFor, connectToInstance, stopControl, dismissActionToast, showInstanceChooser, clearInstanceView, instanceChooser');
  const finish = (id: string) => weeks.get(id)!(Response.json(snapshotFixture(id, `${id} note body.`), { headers: { ETag: '"initial"' } }));
  return { weeks, finish };
}

describe('operation feedback', () => {
  it('loads a newly selected instance without waiting for the previous pending snapshot', async () => {
    history.replaceState({}, '', '/');
    const pending = await pendingEntries(['work', 'personal']);
    await app!.showInstanceChooser();
    document.querySelector<HTMLAnchorElement>('a[href="/work/"]')!.click();
    await vi.waitFor(() => expect(pending.weeks.has('work')).toBe(true));
    document.querySelector<HTMLAnchorElement>('a[href="/personal/"]')!.click();
    await vi.waitFor(() => expect(pending.weeks.has('personal')).toBe(true));
    // The old read settles while the new read still owns the loading slot.
    pending.finish('work');
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector<HTMLElement>('#instance-chooser')!.hidden).toBe(false);
    expect(location.pathname).toBe('/');
    pending.finish('personal');
    await vi.waitFor(() => expect(location.pathname).toBe('/personal/'));
    expect(document.querySelector('#flow')?.textContent).toContain('personal note body.');
    expect(document.querySelector('#flow')?.textContent).not.toContain('work note body.');
  });

  it('keeps direct-link loading feedback until the core snapshot finishes', async () => {
    history.replaceState({}, '', '/work/');
    const pending = await pendingEntries(['work']);
    const connecting = app!.connectToInstance('work');
    await vi.waitFor(() => expect(pending.weeks.has('work')).toBe(true));
    await vi.waitFor(() => expect(document.querySelector('#flow-scroll [role="status"]')?.textContent).toBe('Loading instance…'));
    pending.finish('work'); await connecting;
    expect(document.querySelector('#flow-scroll .loading')).toBeNull();
    expect(document.querySelector('#flow')?.textContent).toContain('work note body.');
  });

  it('delays loading and rejects cancelled and superseded operations', () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    const cancel = showDelayedLoading(host, 'Loading document…', () => true);
    vi.advanceTimersByTime(199); expect(host.childElementCount).toBe(0);
    cancel(); vi.advanceTimersByTime(1); expect(host.childElementCount).toBe(0);
    let current = true;
    showDelayedLoading(host, 'Loading summary…', () => current);
    current = false; vi.advanceTimersByTime(200); expect(host.childElementCount).toBe(0);
    showDelayedLoading(host, 'Loading document…', () => true);
    vi.advanceTimersByTime(200); expect(host.textContent).toBe('Loading document…');
  });

  it('waits for entry content before leaving the chooser and writes one history entry', async () => {
    document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    history.replaceState({}, '', '/');
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    const instance = { id: 'work', name: 'Work', path: '/fixture/work' };
    let finishWeek!: (response: Response) => void;
    stubBrowserFetch(vi.fn(async (url: string) => {
      if (url === '/-/api/instances') return Response.json([instance]);
      if (url === '/-/api/instances/work') return Response.json(instance);
      if (url.endsWith('/data')) return new Promise<Response>(resolve => { finishWeek = resolve; });
      return new Response('', { status: 404 });
    }));
    app = await loadApp<App>('controlFor, connectToInstance, stopControl, dismissActionToast, showInstanceChooser, clearInstanceView, instanceChooser');
    await app.showInstanceChooser();
    const push = vi.spyOn(history, 'pushState');
    const open = document.querySelector<HTMLAnchorElement>('.instance-open')!; open.focus(); open.click();
    await vi.waitFor(() => expect(finishWeek).toBeDefined());
    const chooser = document.querySelector<HTMLElement>('#instance-chooser')!;
    const scroller = document.querySelector<HTMLElement>('#flow-scroll')!;
    expect(chooser.hidden).toBe(false); expect(scroller.hidden).toBe(true);
    expect(location.pathname).toBe('/'); expect(push).not.toHaveBeenCalled();
    finishWeek(Response.json(snapshotFixture(), { headers: { ETag: '"initial"' } }));
    await vi.waitFor(() => expect(chooser.hidden).toBe(true));
    expect(scroller.hidden).toBe(false); expect(scroller.textContent).toContain('Good note body.');
    expect(location.pathname).toBe('/work/'); expect(push).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(scroller);
    expect(chooser.querySelector('.instance-row .loading')).toBeNull();
    await app.showInstanceChooser();
    expect(chooser.hidden).toBe(false); expect(scroller.hidden).toBe(true);
  });

  it('keeps the same request and spinner on repeated selection, with a toast and retry by selecting its card', async () => {
    document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    history.replaceState({}, '', '/');
    const instance = { id: 'work', name: 'Work', path: '/fixture/work' };
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([instance]))
      .mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValue(Response.json({ error: 'Instance unavailable.' }, { status: 404 }));
    stubBrowserFetch(fetch);
    app = await loadApp<App>('controlFor, connectToInstance, stopControl, dismissActionToast, showInstanceChooser, clearInstanceView, instanceChooser');
    await app.showInstanceChooser();
    vi.useFakeTimers();
    document.querySelector<HTMLAnchorElement>('.instance-open')!.click();
    const chooser = document.querySelector<HTMLElement>('#instance-chooser')!;
    const flow = document.querySelector<HTMLElement>('#flow-scroll')!;
    expect(chooser.hidden).toBe(false); expect(flow.hidden).toBe(true);
    expect(location.pathname).toBe('/');
    vi.advanceTimersByTime(100);
    document.querySelector<HTMLAnchorElement>('.instance-open')!.click();
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(99); expect(chooser.querySelector('.instance-row [role="status"]')).toBeNull();
    vi.advanceTimersByTime(1);
    const spinner = chooser.querySelector('.instance-row [role="status"]');
    expect(spinner?.textContent).toBe('Loading instance…');
    document.querySelector<HTMLAnchorElement>('.instance-open')!.click();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(chooser.querySelector('.instance-row [role="status"]')).toBe(spinner);
    finish(Response.json({ error: 'Instance unavailable.' }, { status: 404 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(chooser.querySelector('.instance-row [role="alert"]')).toBeNull();
    expect(document.querySelector('#action-toast')?.textContent).toBe('Could not open this instance. Click its card to retry.');
    expect(chooser.hidden).toBe(false); expect(location.pathname).toBe('/');
    expect(chooser.querySelector<HTMLButtonElement>('.instance-remove')?.disabled).toBe(false);
    const retry = chooser.querySelector<HTMLAnchorElement>('.instance-open')!; retry.focus(); retry.click();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(document.activeElement).toBe(retry);
    expect(chooser.querySelector('.instance-row [role="status"]')).toBeNull();
    expect(chooser.querySelector('.instance-row [role="alert"]')).toBeNull();
    expect(document.querySelector('#action-toast')?.textContent).toBe('Could not open this instance. Click its card to retry.');
  });

  it('keeps technical details and actions outside the live message and renders error text safely', () => {
    document.body.innerHTML = '<button id="other">Other</button><div id="notice"></div>';
    const outside = document.querySelector<HTMLButtonElement>('#other')!;
    outside.focus();
    const retry = document.createElement('button');
    retry.textContent = 'Retry'; const action = vi.fn(); retry.addEventListener('click', action);
    const host = document.querySelector<HTMLElement>('#notice')!;
    showNotice(host, { kind: 'error', message: 'Could not open this instance.', details: '<script>unsafe</script>', actions: [retry] });
    const live = host.querySelector('[role="alert"]')!;
    expect(live.textContent).toBe('Could not open this instance.');
    expect(live.getAttribute('aria-atomic')).toBe('true');
    expect(live.contains(retry)).toBe(false);
    expect(host.querySelector('details')?.open).toBe(false);
    expect(host.querySelector('details')?.textContent).toContain('<script>unsafe</script>');
    expect(host.querySelector('script')).toBeNull();
    expect(document.activeElement).toBe(outside);
    retry.click(); expect(action).toHaveBeenCalledOnce();
  });

  it('shows only an offline header icon while reconnecting and retains focus and content', async () => {
    document.body.innerHTML = '<button id="connection-status" hidden><svg></svg></button><main>Current notes</main><button id="other">Other</button>';
    app = await loadApp<App>('controlFor, connectToInstance, stopControl, dismissActionToast');
    const outside = document.querySelector<HTMLButtonElement>('#other')!; outside.focus();
    app.controlFor('work');
    const stream = Events.streams.at(-1)!;
    const host = document.querySelector<HTMLElement>('#connection-status')!;
    await vi.waitFor(() => expect(host.hidden).toBe(true));
    stream.fail();
    await vi.waitFor(() => expect(host.hidden).toBe(false));
    const notice = host.firstElementChild;
    expect(host.hidden).toBe(false);
    expect(host.getAttribute('aria-label')).toBe('Offline, reconnecting');
    expect(host.title).toContain('Reconnecting automatically');
    expect(host.textContent).toBe('');
    expect(document.querySelector('#action-toast')).toBeNull();
    expect(document.querySelector('main')?.textContent).toBe('Current notes');
    expect(document.activeElement).toBe(outside);
    stream.fail(); expect(host.firstElementChild).toBe(notice);
    await vi.waitFor(() => expect(host.hidden).toBe(true), { timeout: 2000 });
    expect(host.firstElementChild).toBe(notice);
  });

  it('ignores a late focus-report failure from the disposed connection', async () => {
    document.body.innerHTML = '<button id="connection-status" hidden><svg></svg></button>';
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let fail!: (error: Error) => void;
    stubBrowserFetch(vi.fn(() => new Promise<Response>((_, reject) => { fail = reject; })));
    app = await loadApp<App>('controlFor, connectToInstance, stopControl, dismissActionToast');
    app.controlFor(null);
    const old = Events.streams.at(-1)!;
    old.send('{"tab":1}');
    await vi.waitFor(() => expect(fail).toBeDefined());
    app.controlFor('work');
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#connection-status')!.hidden).toBe(true));
    fail(new Error('Old request failed')); await Promise.resolve(); await Promise.resolve();
    old.fail();
    expect(old.close).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLElement>('#connection-status')!.hidden).toBe(true);
  });

  it('offers reconnect from the header icon when the stream closes', async () => {
    document.body.innerHTML = '<button id="connection-status" hidden><svg></svg></button>';
    app = await loadApp<App>('controlFor, connectToInstance, stopControl, dismissActionToast');
    app.controlFor('work');
    const stream = Events.streams.at(-1)!;
    stream.fail();
    const host = document.querySelector<HTMLElement>('#connection-status')!;
    await vi.waitFor(() => expect(host.hidden).toBe(false));
    expect(host.getAttribute('aria-label')).toBe('Offline, reconnecting');
    expect(host.title).toContain('Click to retry');
    expect(document.querySelector('#action-toast')).toBeNull();
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
    host.click();
    await vi.waitFor(() => expect(document.querySelector('#action-toast')?.textContent).toBe('Could not reconnect. Try again.'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(document.querySelector<HTMLElement>('#action-toast')?.hidden).toBe(true);
  });

  it('keeps recovery controls on failed startup and toasts only an explicit failed retry', async () => {
    document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    history.replaceState({}, '', '/work/');
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValue(Response.json({ error: 'Instance is not registered.' }, { status: 404 }));
    stubBrowserFetch(fetch);
    app = await loadApp<App>('controlFor, connectToInstance, stopControl, dismissActionToast');
    const connecting = app.connectToInstance('work');
    const flow = document.querySelector<HTMLElement>('#flow')!;
    expect(flow.querySelector('[role="status"]')).toBeNull();
    await vi.waitFor(() => expect(document.querySelector('#flow-scroll [role="status"]')?.textContent).toBe('Loading instance…'));
    finish(Response.json({ error: 'Instance is not registered.' }, { status: 404 }));
    await connecting;
    expect(flow.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('#action-toast')).toBeNull();
    expect(flow.querySelector('a')?.getAttribute('href')).toBe('/');
    flow.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.querySelector('#action-toast')?.textContent).toBe('Could not open this instance. Try again.'));
  });
});
