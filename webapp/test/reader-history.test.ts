// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityRef } from '../lib/types';
import type { DocRef, ViewState } from '../src/route';
import type { createContextPanel } from '../src/context-panel';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';
import { stubBrowserFetch } from './connection-fixture';

interface App {
  state: { filter: EntityRef | null; search: string; doc: DocRef | null };
  setupContextPanel(): void;
  setupNavigationSidebar(): void;
  setupModals(): void;
  applyAnimSpeed(): void;
  connectToInstance(id: string): Promise<void>;
  applyView(view: ViewState): Promise<void>;
  handleLocationChange(event?: Event): Promise<void>;
  closeDoc(): void;
  panelSnapshot(): { scrollTop: number; expanded: string[] } | null;
  clearInstanceView(): void;
  contextPanel?: ReturnType<typeof createContextPanel>;
  navigationSidebar?: { dispose(): void };
  stopControl?: () => void;
}

const project = '2026-10-04-program', action = '2026-10-04-task';
const newest = '2026-10-04T11:00', middle = '2026-10-04T10:00', older = '2026-10-04T09:00';
const filteredUrl = `/work/project/${project}?search=calmer`;
const slowDocument = 'assets/slow.md';
let app: App | undefined;

afterEach(() => {
  app?.stopControl?.(); app?.clearInstanceView(); app?.navigationSidebar?.dispose(); app?.contextPanel?.destroy(); app = undefined;
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
  // The slow document's read stays pending until the test finishes it.
  const slowRead: { finish?: () => void } = {};
  stubBrowserFetch(url => {
    if (url === '/-/api/instances/work') return Response.json({ id: 'work', name: 'Work', path: '/fixture/work' });
    if (url === '/-/api/instances/work/data') return Response.json(data);
    if (url === `/-/api/instances/work/files/${slowDocument}`) return new Promise<Response>(resolve => { slowRead.finish = () => resolve(new Response('A slow document.')); });
    return new Response('', { status: 404 });
  });
  app = await loadApp<App>('state, setupContextPanel, setupNavigationSidebar, setupModals, applyAnimSpeed, connectToInstance, applyView, handleLocationChange, closeDoc, panelSnapshot, clearInstanceView, contextPanel, navigationSidebar, stopControl');
  app.applyAnimSpeed(); app.setupContextPanel(); app.setupModals(); app.setupNavigationSidebar();
  await app.connectToInstance('work');
  const ids = () => Array.from(flow.querySelectorAll<HTMLElement>('[data-entry-id]')).map(card => card.dataset.entryId);
  return { api: app, flow, scroller, ids, slowRead };
}

describe('summary and Overview across history', () => {
  async function summaryBody() {
    const body = document.getElementById('side-panel-body')!;
    await vi.waitFor(() => expect(body.querySelector('.related-more')).not.toBeNull());
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    return body;
  }

  it('opens the summary from More → Summary', async () => {
    const { api } = await setup();
    await api.applyView({ filter: null, search: '', doc: null });
    document.getElementById('btn-pill-more')!.click();
    document.getElementById('btn-workspace-summary')!.click();
    await summaryBody();
    expect(api.contextPanel!.getState().open).toBe(true);
  });

  it('keeps the summary open when its last fold is revealed', async () => {
    const { api } = await setup();
    await api.applyView({ filter: null, search: '', doc: null });
    api.contextPanel!.open();
    const more = (await summaryBody()).querySelector<HTMLButtonElement>('.related-more')!;
    more.click();
    expect(more.isConnected).toBe(false);
    expect(api.contextPanel!.getState().open).toBe(true);
  });

  it('restores the destination summary when popstate selects another visit to the same view', async () => {
    const { api } = await setup();
    await api.applyView({ filter: null, search: '', doc: null });
    api.contextPanel!.open();
    const summary = await summaryBody();
    summary.scrollTop = 100;
    const panel = api.panelSnapshot();
    const destination = { ...history.state, panel };
    const url = location.pathname + location.search;
    summary.querySelector<HTMLButtonElement>('.related-more')!.click();
    summary.scrollTop = 200;
    expect(api.panelSnapshot()).toEqual({ scrollTop: 200, expanded: ['Open projects'], contextView: 'overview' });

    history.replaceState(destination, '', url);
    await api.handleLocationChange(new PopStateEvent('popstate', { state: destination }));
    expect(api.panelSnapshot()).toEqual(panel);
  });

  it('inspects Overview without leaving the originating filtered flow', async () => {
    const { api, flow, scroller, ids } = await setup();
    expect(ids()).toEqual([middle, older]);
    scroller.scrollTop = 260;
    const cardOffset = () => flow.querySelector<HTMLElement>(`[data-entry-id="${older}"]`)!.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top;
    expect(cardOffset()).toBe(-40);

    // Use the actual Overview control: it opens the instance record in the
    // context panel while the flow keeps its project focus and search.
    document.getElementById('btn-workspace-views')!.click();
    document.getElementById('nav-overview')!.click();
    await vi.waitFor(() => expect(document.getElementById('side-panel-body')?.textContent).toContain('Instance context'));
    expect(api.contextPanel!.getState().open).toBe(true);
    expect(ids()).toEqual([middle, older]);
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(api.state.search).toBe('calmer'); expect(api.state.doc).toBeNull();
    expect(location.pathname + location.search).toBe(filteredUrl);

    api.closeDoc();
    expect(api.contextPanel!.getState().open).toBe(false);
    expect(ids()).toEqual([middle, older]);
    expect(scroller.scrollTop).toBe(260);
    expect(location.pathname + location.search).toBe(filteredUrl);
    expect(cardOffset()).toBe(-40);
    expect(scroller.hidden).toBe(false);
  });

  it('returns to the originating filtered flow when a routed document is closed while it loads', async () => {
    const { api, flow, scroller, ids, slowRead } = await setup();
    expect(ids()).toEqual([middle, older]);
    scroller.scrollTop = 260;
    const cardOffset = () => flow.querySelector<HTMLElement>(`[data-entry-id="${older}"]`)!.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top;
    expect(cardOffset()).toBe(-40);

    // The document's route carries no project or search, so the flow beneath
    // it changes while the read is pending.
    const opening = api.applyView({ filter: null, search: '', doc: { kind: 'asset', path: slowDocument } });
    await vi.waitFor(() => expect(slowRead.finish).toBeDefined());
    await vi.waitFor(() => expect(ids()).toEqual([newest, middle, older]));
    expect(api.state.doc).toEqual({ kind: 'asset', path: slowDocument });
    expect(location.pathname + location.search).toBe(`/work/asset/${slowDocument}`);
    // Scrolling that flow does not move the place Escape returns to.
    scroller.scrollTop = 0;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(ids()).toEqual([middle, older]));
    await vi.waitFor(() => expect(scroller.scrollTop).toBe(260));
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(api.state.search).toBe('calmer'); expect(api.state.doc).toBeNull();
    expect(location.pathname + location.search).toBe(filteredUrl);
    expect(cardOffset()).toBe(-40);

    // The abandoned read cannot bring its document back.
    slowRead.finish!(); await opening;
    expect(location.pathname + location.search).toBe(filteredUrl);
    expect(document.getElementById('side-panel-body')!.textContent).not.toContain('A slow document.');
    expect(ids()).toEqual([middle, older]);
  });
});
