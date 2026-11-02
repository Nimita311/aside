// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';
import { stubBrowserFetch } from './auth-fixture';

interface App {
  connectToInstance(id: string): Promise<void>;
  jumpToEntry(id: string): Promise<void>;
  clearInstanceView(): void;
  stopControl?: () => void;
}
let app: App | undefined;
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

afterEach(() => {
  app?.stopControl?.(); app?.clearInstanceView(); app = undefined;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).animate;
  document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

describe('cold deep-link positioning', () => {
  it.each([
    ['an exact entry', '/work/2026-10-04T10:00', 850],
    ['a calendar date', '/work/date/2026-10-04', 1000],
  ] as const)('positions %s under loading feedback before the single entrance', async (_name, route, destination) => {
    document.body.innerHTML = readFileSync('index.html', 'utf8')
      .replace(/<link[^>]*>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    const style = document.createElement('style'); style.textContent = readFileSync('style.css', 'utf8'); document.body.prepend(style);
    history.replaceState({}, '', route);
    localStorage.setItem('animSpeed', '1');
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    const scroller = document.querySelector<HTMLElement>('#flow-scroll')!;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 2200 },
    });
    const measuredWithLoader: boolean[] = [];
    const visibleLoaderBeforeLanding: boolean[] = [];
    const entrancePositions: number[] = [];
    const loadingVisible = () => {
      const host = document.querySelector<HTMLElement>('.instance-startup-notice');
      return !!host && !host.hidden && getComputedStyle(host).display !== 'none' && !!host.textContent;
    };
    const loadingOccupiesSpace = () => {
      const host = document.querySelector<HTMLElement>('.instance-startup-notice');
      return loadingVisible() && !['absolute', 'fixed'].includes(getComputedStyle(host!).position);
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === scroller) return new DOMRect(0, 0, 500, 400);
      if (this.classList.contains('entry-card')) {
        const loading = loadingOccupiesSpace(); measuredWithLoader.push(loading);
        if (!this.classList.contains('is-target')) visibleLoaderBeforeLanding.push(loadingVisible());
        return new DOMRect(0, 1000 + (loading ? 160 : 0) - scroller.scrollTop, 500, 100);
      }
      if (this.classList.contains('entry-margin')) return this.closest<HTMLElement>('.entry-card')!.getBoundingClientRect();
      return new DOMRect(0, 0, 500, 20);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('entry-card') ? 100 : 20;
    });
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement) {
      if (this.classList.contains('entry-card')) entrancePositions.push(scroller.scrollTop);
      return { finished: Promise.resolve(), cancel() {} };
    } });

    let finishSnapshot!: (response: Response) => void;
    const instance = { id: 'work', name: 'Work', path: '/fixture/work' };
    stubBrowserFetch(url => {
      if (url === '/-/api/instances/work') return Response.json(instance);
      if (url.endsWith('/data')) return new Promise<Response>(resolve => { finishSnapshot = resolve; });
      return new Response('', { status: 404 });
    });
    app = await loadApp<App>('connectToInstance, jumpToEntry, clearInstanceView, stopControl');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const connecting = app.connectToInstance('work');
    await vi.waitFor(() => expect(finishSnapshot).toBeDefined());
    vi.advanceTimersByTime(200);
    expect(loadingVisible()).toBe(true);
    expect(getComputedStyle(document.querySelector('.instance-startup-notice')!).position).toBe('absolute');
    finishSnapshot(Response.json(snapshotFixture()));
    await connecting;

    expect(measuredWithLoader.length).toBeGreaterThan(0);
    expect(measuredWithLoader).not.toContain(true);
    expect(visibleLoaderBeforeLanding.length).toBeGreaterThan(0);
    expect(visibleLoaderBeforeLanding).not.toContain(false);
    expect(scroller.scrollTop).toBe(destination);
    expect(entrancePositions).toEqual([destination]);
    expect(document.querySelector('.instance-startup-notice')).toBeNull();
    for (const callback of frames.splice(0)) callback(performance.now() + 1000);
    expect(scroller.scrollTop).toBe(destination);

    // Once the app is open, an ordinary entry jump retains its smooth scroll.
    scroller.scrollTop = 0;
    await app.jumpToEntry('2026-10-04T10:00');
    expect(scroller.scrollTop).toBe(0);
    for (const callback of frames.splice(0)) callback(performance.now() + 1000);
    expect(scroller.scrollTop).toBe(850);
  });
});
