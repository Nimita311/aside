// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityRef } from '../lib/types';
import type { DocRef, ViewState } from '../src/route';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';
import { stubBrowserFetch } from './auth-fixture';

interface App {
  state: { filter: EntityRef | null; search: string; doc: DocRef | null };
  setupNavigationSidebar(): void;
  setupModals(): void;
  applyAnimSpeed(): void;
  connectToInstance(id: string): Promise<void>;
  applyView(view: ViewState): Promise<void>;
  handleLocationChange(event?: Event): Promise<void>;
  closeDoc(): void;
  panelSnapshot(): { scrollTop: number; expanded: string[] } | null;
  clearInstanceView(): void;
  navigationSidebar?: { dispose(): void };
  stopControl?: () => void;
}

const project = '2026-10-04-program', action = '2026-10-04-task';
const newest = '2026-10-04T11:00', middle = '2026-10-04T10:00', older = '2026-10-04T09:00';
const filteredUrl = `/work/project/${project}?search=calmer`;
let app: App | undefined;

afterEach(() => {
  app?.stopControl?.(); app?.clearInstanceView(); app?.navigationSidebar?.dispose(); app = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

async function setup() {
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  history.replaceState(null, '', filteredUrl);
  localStorage.setItem('animSpeed', '0');
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  const scroller = document.getElementById('flow-scroll')!, flow = document.getElementById('flow')!;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1200 },
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return new DOMRect(0, 100, 960, 400);
    if (this.classList.contains('entry-card')) {
      const cards = Array.from(flow.querySelectorAll('.entry-card'));
      const index = Math.max(0, cards.indexOf(this));
      return new DOMRect(0, 120 + index * 200 - scroller.scrollTop, 960, 200);
    }
    if (this.classList.contains('entry-margin')) return this.closest<HTMLElement>('.entry-card')!.getBoundingClientRect();
    return new DOMRect(0, 0, 960, 20);
  });
  const data = snapshotFixture('work');
  data.instance!.body = 'Instance context for the current understanding.';
  for (let index = 0; index < 11; index++) {
    const id = `2026-10-04-project-${index}`;
    data.indexes.projects.push({ id, description: `Project ${index}` });
    data.projects.push([id, { frontMatter: { name: `Project ${index}`, created: '2026-10-04T09:00' }, body: '' }]);
  }
  data.weeks = [['2026-09-28', [newest, middle, older].map((created, index) => ({
    meta: { created, projects: index === 0 ? [] : [project], actions: [action] },
    content: `A calmer note at ${created}.`, weekFile: '2026-09-28',
  }))]];
  data.indexes.notes = [newest, middle, older].map(id => ({ id, description: 'A calmer note' }));
  data.weeksByEntity.push([`#project/${project}`, ['2026-09-28']], [`#action/${action}`, ['2026-09-28']]);
  data.relations.entriesByEntity = [[`#project/${project}`, [middle, older]], [`#action/${action}`, [newest, middle, older]]];
  stubBrowserFetch(url => {
    if (url === '/-/api/instances/work') return Response.json({ id: 'work', name: 'Work', path: '/fixture/work' });
    if (url === '/-/api/instances/work/data') return Response.json(data);
    return new Response('', { status: 404 });
  });
  app = await loadApp<App>('state, setupNavigationSidebar, setupModals, applyAnimSpeed, connectToInstance, applyView, handleLocationChange, closeDoc, panelSnapshot, clearInstanceView, navigationSidebar, stopControl');
  app.applyAnimSpeed(); app.setupModals(); app.setupNavigationSidebar();
  await app.connectToInstance('work');
  const ids = () => Array.from(flow.querySelectorAll<HTMLElement>('[data-entry-id]')).map(card => card.dataset.entryId);
  return { api: app, flow, scroller, ids };
}

describe('Reader return context', () => {
  async function openSummary() {
    document.getElementById('btn-pill-more')!.click();
    document.getElementById('btn-workspace-summary')!.click();
    const body = document.getElementById('side-panel-body')!;
    await vi.waitFor(() => expect(body.querySelector('.related-more')).not.toBeNull());
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return body;
  }

  it('restores the originating flow summary after interacting with the same summary in Overview', async () => {
    const { api } = await setup();
    await api.applyView({ filter: null, search: '', doc: null });
    let summary = await openSummary();
    summary.scrollTop = 100;
    const origin = api.panelSnapshot();
    expect(origin).toEqual({ scrollTop: 100, expanded: [] });

    await api.applyView({ filter: null, search: '', doc: { kind: 'detail' } });
    expect(history.state.returnFlow.panel).toEqual(origin);
    summary = await openSummary();
    summary.querySelector<HTMLButtonElement>('.related-more')!.click();
    summary.scrollTop = 200;
    expect(api.panelSnapshot()).toEqual({ scrollTop: 200, expanded: ['Open projects'] });

    api.closeDoc();
    await vi.waitFor(() => expect(api.state.doc).toBeNull());
    await vi.waitFor(() => expect(api.panelSnapshot()).toEqual(origin));
  });

  it('restores the destination summary when popstate selects another visit to the same view', async () => {
    const { api } = await setup();
    await api.applyView({ filter: null, search: '', doc: null });
    const summary = await openSummary();
    summary.scrollTop = 100;
    const panel = api.panelSnapshot();
    const destination = { ...history.state, panel };
    const url = location.pathname + location.search;
    summary.querySelector<HTMLButtonElement>('.related-more')!.click();
    summary.scrollTop = 200;
    expect(api.panelSnapshot()).toEqual({ scrollTop: 200, expanded: ['Open projects'] });

    history.replaceState(destination, '', url);
    await api.handleLocationChange(new PopStateEvent('popstate', { state: destination }));
    expect(api.panelSnapshot()).toEqual(panel);
  });

  it('restores the departing document position when another document opens before the scroll debounce', async () => {
    const { api } = await setup();
    await api.applyView({ filter: null, search: 'calmer', doc: { kind: 'detail' } });
    const body = document.getElementById('doc-body')!;
    const firstUrl = location.pathname + location.search;
    body.scrollTop = 600;

    // Capture the browser's previous entry at the instant the next visit is
    // pushed. A pending scroll listener cannot supply this position in time.
    const pushState = history.pushState.bind(history);
    let firstVisit: typeof history.state;
    vi.spyOn(history, 'pushState').mockImplementation((data, unused, url) => {
      firstVisit = structuredClone(history.state);
      pushState(data, unused, url);
    });
    await api.applyView({ filter: { type: 'action', id: action }, search: '', doc: { kind: 'detail' } });
    expect(firstVisit.readerScroll).toBe(600);
    expect(body.textContent).toContain('Good task');
    body.scrollTop = 120;

    // Popstate runs after the browser has selected the destination entry. It
    // must not stamp the departing document's position over that stored state.
    history.replaceState(firstVisit, '', firstUrl);
    await api.handleLocationChange(new PopStateEvent('popstate', { state: firstVisit }));
    expect(body.textContent).toContain('Instance context');
    expect(history.state.readerScroll).toBe(600);
    expect(body.scrollTop).toBe(600);
  });

  it.each([false, true])('returns from instance Overview to the originating filtered flow (another body=%s)', async anotherBody => {
    const { api, flow, scroller, ids } = await setup();
    expect(ids()).toEqual([middle, older]);
    scroller.scrollTop = 260;
    const cardOffset = () => flow.querySelector<HTMLElement>(`[data-entry-id="${older}"]`)!.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top;
    expect(cardOffset()).toBe(-40);

    // Use the actual Overview control: it opens the instance body and drops
    // the project focus while retaining the flow's search in the visit.
    document.getElementById('btn-workspace-views')!.click();
    document.getElementById('nav-overview')!.click();
    await vi.waitFor(() => expect(document.getElementById('doc-body')?.textContent).toContain('Instance context'));
    await vi.waitFor(() => expect(ids()).toEqual([newest, middle, older]));
    expect(api.state.filter).toBeNull(); expect(api.state.search).toBe('calmer');
    expect(api.state.doc).toEqual({ kind: 'detail' });
    expect(location.pathname + location.search).toBe('/work/detail?search=calmer');
    const origin = structuredClone(history.state.returnFlow);
    expect(origin.view).toEqual({ filter: { type: 'project', id: project }, search: 'calmer', doc: null });
    expect(origin.anchor).toEqual({ entryId: older, offset: -40 });

    if (anotherBody) {
      // A document-to-document visit changes the underlying scope/search yet
      // must retain the original flow, rather than treating Overview as it.
      await api.applyView({ filter: { type: 'action', id: action }, search: '', doc: { kind: 'detail' } });
      expect(api.state.search).toBe('');
      expect(document.getElementById('doc-body')?.textContent).toContain('Good task');
      expect(history.state.returnFlow).toEqual(origin);
    }

    api.closeDoc();
    await vi.waitFor(() => expect(ids()).toEqual([middle, older]));
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(260));
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(api.state.search).toBe('calmer'); expect(api.state.doc).toBeNull();
    expect(location.pathname + location.search).toBe(filteredUrl);
    expect(cardOffset()).toBe(-40);
    expect(document.getElementById('doc-backdrop')!.hidden).toBe(true);
    expect(scroller.hidden).toBe(false);
  });
});
