// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataSnapshot } from '../../cli/src/core/data-snapshot';
import type { ViewState } from '../src/route';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';
import { stubBrowserFetch } from './auth-fixture';

interface App {
  setupNavigationSidebar(): void;
  applyAnimSpeed(): void;
  connectToInstance(id: string): Promise<void>;
  applyView(view: ViewState, options?: { resetPosition?: boolean }): Promise<void>;
  restoreFlowScroll(anchor: { entryId: string; offset: number }): void;
  loadMoreWeeks(count: number): Promise<void>;
  clearInstanceView(): void;
  navigationSidebar?: { dispose(): void };
  datePicker: { dispose(): void };
  stopControl?: () => void;
}

const project = '2026-10-04-program';
let app: App | undefined;
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

afterEach(() => {
  app?.stopControl?.(); app?.clearInstanceView(); app?.navigationSidebar?.dispose(); app?.datePicker.dispose(); app = undefined;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).animate;
  document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

function records(dates = ['2026-10-04', '2026-10-03', '2026-10-02']): DataSnapshot {
  const data = snapshotFixture();
  data.weeks[0][1] = dates.map((date, index) => ({
    meta: { created: `${date}T10:00`, projects: index === dates.length - 1 ? [project] : [] },
    content: `Note on ${date}.`, weekFile: '2026-09-28',
  }));
  data.indexes.notes = dates.map(date => ({ id: `${date}T10:00`, description: `Note on ${date}` }));
  data.weeksByEntity.push([`#project/${project}`, ['2026-09-28']]);
  data.relations.entriesByEntity.push([`#project/${project}`, [`${dates.at(-1)}T10:00`]]);
  return data;
}

async function setup(data = records(), options: { holdArrival?: boolean; height?: number } = {}) {
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  history.replaceState(null, '', '/work/');
  localStorage.setItem('animSpeed', '1');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-31T12:00:00'));
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  let held = !!options.holdArrival;
  let finish!: () => void;
  let pending = new Promise<void>(resolve => { finish = resolve; });
  let heldAnimations = 0;
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value() {
    if (held) heldAnimations++;
    return { finished: held ? pending : Promise.resolve(), cancel() {} };
  } });
  const scroller = document.getElementById('flow-scroll')!, flow = document.getElementById('flow')!;
  const height = options.height ?? 100;
  Object.defineProperties(scroller, { clientWidth: { configurable: true, value: 1920 }, clientHeight: { configurable: true, value: height }, scrollHeight: { configurable: true, value: 2000 } });
  vi.spyOn(document.getElementById('workspace-frame')!, 'clientWidth', 'get').mockReturnValue(1920);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return new DOMRect(0, 0, 960, height);
    if (this === flow) return new DOMRect(0, -scroller.scrollTop, 960, 2000);
    if (this.classList.contains('entry-card')) {
      const cards = Array.from(flow.querySelectorAll('.entry-card:not(.flow-ghost)'));
      return new DOMRect(0, Math.max(0, cards.indexOf(this)) * 120 - scroller.scrollTop, 960, 100);
    }
    if (this.classList.contains('date-marker') || this.classList.contains('entry-margin')) return this.closest<HTMLElement>('.entry-card')!.getBoundingClientRect();
    return new DOMRect(0, 0, 960, 20);
  });
  stubBrowserFetch(url => {
    if (url === '/-/api/instances/work') return Response.json({ id: 'work', name: 'Work', path: '/fixture/work' });
    if (url === '/-/api/instances/work/data') return Response.json(data);
    return new Response('', { status: 404 });
  });
  app = await loadApp<App>('setupNavigationSidebar, applyAnimSpeed, connectToInstance, applyView, restoreFlowScroll, loadMoreWeeks, clearInstanceView, navigationSidebar, datePicker, stopControl');
  app.applyAnimSpeed(); app.setupNavigationSidebar();
  await app.connectToInstance('work');
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const frame = async () => { for (const callback of frames.splice(0)) callback(performance.now()); await flush(); };
  await flush(); await frame();
  return {
    api: app, scroller, frame, flush,
    hold() { held = true; pending = new Promise<void>(resolve => { finish = resolve; }); },
    async finish() { held = false; finish(); await flush(); },
    heldAnimations: () => heldAnimations,
  };
}

const visibleDays = () => Array.from(document.querySelectorAll<HTMLElement>('#timeline-calendar-inline .cal-day.is-in-range')).map(button => button.dataset.date);
const month = () => document.querySelector<HTMLElement>('#timeline-calendar-inline .date-jump-cal')!.dataset.month!.slice(0, 7);

describe('calendar follows settled timeline geometry', () => {
  it('refreshes the visible range after a filter flight completes without another scroll', async () => {
    const { api, hold, finish, frame, heldAnimations } = await setup();
    expect(visibleDays()).toEqual(['2026-10-04']);
    hold();
    await api.applyView({ filter: { type: 'project', id: project }, doc: null }, { resetPosition: true });
    await frame();
    expect(heldAnimations()).toBeGreaterThan(0);
    expect(visibleDays()).toEqual(['2026-10-04']);
    await finish();
    expect(visibleDays()).toEqual(['2026-10-02']);
  });

  it('updates the month after the initial arrival releases its suppressed date readout', async () => {
    const { finish, heldAnimations } = await setup(records(['2026-09-30']), { holdArrival: true });
    expect(heldAnimations()).toBeGreaterThan(0);
    expect(month()).toBe('2026-10');
    await finish();
    expect(month()).toBe('2026-09');
    expect(visibleDays()).toEqual(['2026-09-30']);
  });

  it('refreshes the range after a same-flow history anchor restore', async () => {
    const { api, scroller, frame } = await setup();
    expect(visibleDays()).toEqual(['2026-10-04']);
    api.restoreFlowScroll({ entryId: '2026-10-02T10:00', offset: 0 });
    expect(scroller.scrollTop).toBe(240);
    await frame();
    expect(visibleDays()).toEqual(['2026-10-02']);
  });

  it('releases the restore guard when a same-flow document opens before the restore frame', async () => {
    const { api, frame } = await setup();
    expect(visibleDays()).toEqual(['2026-10-04']);
    api.restoreFlowScroll({ entryId: '2026-10-02T10:00', offset: 0 });
    await api.applyView({ filter: null, doc: { kind: 'detail' } });
    await frame();
    await api.applyView({ filter: null, doc: null });
    expect(visibleDays()).toEqual(['2026-10-02']);
  });

  it('extends the visible range when a stationary observer appends another native week', async () => {
    const dates = ['2026-11-08', '2026-11-01', '2026-10-25', '2026-10-18', '2026-10-11', '2026-10-04'];
    const weeks = ['2026-11-02', '2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05', '2026-09-28'];
    const data = records(dates);
    data.weeklyDates = weeks;
    data.weeks = dates.map((date, index) => [weeks[index], [{ meta: { created: `${date}T10:00` }, content: `Note on ${date}.`, weekFile: weeks[index] }]]);
    const { api } = await setup(data, { height: 700 });
    document.querySelector<HTMLButtonElement>('#timeline-calendar-inline .cal-nav[aria-label="Previous month"]')!.click();
    expect(month()).toBe('2026-10');
    expect(visibleDays().at(0)).toBe('2026-10-11');
    await api.loadMoreWeeks(1);
    expect(visibleDays().at(0)).toBe('2026-10-04');
  });
});
