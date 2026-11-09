// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityRef } from '../lib/types';
import { RemoteStore } from '../lib/remote-store';
import type { DocRef, ViewState } from '../src/route';
import { matchesFlowSearch } from '../src/flow-search';
import { snapshotFixture } from './snapshot-fixture';
import { loadApp } from './app-harness';

interface App {
  state: { store: RemoteStore | null; instanceId: string | null; instance: unknown; filter: EntityRef | null; search: string; doc: DocRef | null };
  applyView(view: ViewState, options?: { forceFlow?: boolean; push?: boolean }): Promise<void>;
  applyFlowSearch(term: string): Promise<void>;
  loadMoreWeeks(count: number): Promise<void>;
  setupSearch(): void;
  handleSearch(term: string): void;
  handleTagClick(ref: EntityRef, source?: HTMLElement): void;
  handleLocationChange(event?: Event): Promise<void>;
  openDetail(): void;
  closeDoc(): void;
  clearFilter(): void;
  jumpToEntry(id: string): Promise<void>;
  clearInstanceView(): void;
}
let app: App | undefined;
afterEach(() => {
  app?.clearInstanceView(); app = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

const project = '2026-10-04-program';
const otherProject = '2026-10-04-other';
const action = '2026-10-04-task';

async function setup() {
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  history.replaceState(null, '', '/work/'); localStorage.setItem('animSpeed', '0');
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  const data = snapshotFixture();
  const dates = ['2026-10-12', '2026-10-05', '2026-09-28', '2026-09-21', '2026-09-14', '2026-09-07', '2026-08-31'];
  data.weeklyDates = dates;
  data.weeks = dates.map((date, i) => [date, [{
    meta: { created: `${date}T10:00`, projects: [i === 1 ? otherProject : project], actions: [action] },
    content: i === 6 ? 'An older body-only match: action: retry + rollback.' : i === 0 ? 'A fresh retry + rollback plan.' : 'Ordinary note.',
    weekFile: date,
  }]]);
  data.indexes.notes = dates.map(date => ({ id: `${date}T10:00`, description: date === '2026-09-28' ? 'Index-only evidence' : 'A note' }));
  data.projects.push([otherProject, { frontMatter: { name: 'Other program', created: '2026-10-04T09:00' }, body: '' }]);
  data.indexes.projects.push({ id: otherProject, description: 'Other program' });
  data.weeksByEntity = [
    [`#project/${project}`, dates.filter((_, i) => i !== 1)],
    [`#project/${otherProject}`, [dates[1]]],
    [`#action/${action}`, dates],
  ];
  const store = new RemoteStore({
    snapshot: async () => ({ value: data, version: 'v1' }),
    read: async () => null, revalidate: async () => 'unchanged', assetUrl: () => null,
  });
  await store.init();
  app = await loadApp<App>('state, applyView, applyFlowSearch, loadMoreWeeks, setupSearch, handleSearch, handleTagClick, handleLocationChange, openDetail, closeDoc, clearFilter, jumpToEntry, clearInstanceView');
  app.state.store = store; app.state.instanceId = 'work';
  app.state.instance = { id: 'work', name: 'Work', path: '/fixture/work' };
  app.setupSearch();
  await app.applyView({ filter: null, doc: null }, { forceFlow: true });
  const ids = () => [...document.querySelectorAll<HTMLElement>('#flow [data-entry-id]')].map(card => card.dataset.entryId);
  return { api: app, store, ids };
}

describe('literal entry-flow search', () => {
  it('treats spaces, prefixes, date ranges and symbols as literal text', () => {
    const entry = { meta: { created: '2026-10-12T10:00' }, weekFile: '2026-10-12', content: 'Review ACTION: retry + rollback and 2026..2027.' };
    expect(matchesFlowSearch(entry, 'action: retry + rollback')).toBe(true);
    expect(matchesFlowSearch(entry, 'retry rollback')).toBe(false);
    expect(matchesFlowSearch(entry, '2026..2027')).toBe(true);
    expect(matchesFlowSearch(entry, 'evidence', 'Index-only evidence')).toBe(true);
  });

  it('keeps lookup typing separate until the contextual first option is selected', async () => {
    const { api, ids } = await setup();
    const before = ids(), input = document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'retry + rollback'; api.handleSearch(input.value);
    expect(document.querySelector('[role="option"]')?.textContent).toContain('Search this flow');
    expect(api.state.search).toBe(''); expect(ids()).toEqual(before);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(api.state.search).toBe('retry + rollback'));
    await vi.waitFor(() => expect(document.querySelector('#scroll-sentinel')).not.toBeNull());
    await api.loadMoreWeeks(20);
    await vi.waitFor(() => expect(ids()).toEqual(['2026-10-12T10:00', '2026-08-31T10:00']));
    const chip = document.querySelector<HTMLElement>('#flow-search')!;
    expect(chip.closest('#workspace-filter-group')).not.toBeNull();
    expect(document.querySelector('#flow-scroll')?.contains(chip)).toBe(false);
    expect(document.querySelector('#btn-edit-flow-search')?.textContent).toBe('“retry + rollback”');
    expect(input.value).toBe('');
    expect(location.search).toBe('?search=retry+%2B+rollback');
    const filtered = ids();
    input.value = 'Ordinary'; api.handleSearch(input.value);
    expect(api.state.search).toBe('retry + rollback');
    expect(document.querySelector('#btn-edit-flow-search')?.textContent).toBe('“retry + rollback”');
    expect(ids()).toEqual(filtered);
  });

  it('finds an older body-only match beyond the initial rendered weeks', async () => {
    const { api, ids } = await setup();
    expect(ids()).not.toContain('2026-08-31T10:00');
    await api.applyFlowSearch('action: retry'); await api.loadMoreWeeks(20);
    expect(ids()).toEqual(['2026-08-31T10:00']);
    expect(document.querySelector('#scroll-sentinel')?.textContent).not.toBe('The End');
    await api.applyFlowSearch('index-only evidence'); await api.loadMoreWeeks(20);
    expect(ids()).toEqual(['2026-09-28T10:00']);
  });

  it('opens a global entry result directly in one visit and restores the prior search on Back', async () => {
    const { api } = await setup();
    await api.applyView({ filter: { type: 'project', id: project }, search: 'retry', doc: null });
    const priorUrl = location.pathname + location.search, priorState = history.state;
    const visits = history.length;
    const input = document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'entry:Ordinary'; api.handleSearch(input.value);
    document.querySelector<HTMLElement>('[data-key="entry:2026-10-05T10:00"]')!.click();
    await vi.waitFor(() => expect(location.pathname).toBe('/work/2026-10-05T10:00'));
    expect(location.search).toBe(''); expect(history.length).toBe(visits + 1);
    expect(api.state.search).toBe(''); expect(api.state.filter).toBeNull();
    expect(document.querySelector('#action-toast button')).toBeNull();
    history.replaceState(priorState, '', priorUrl);
    await api.handleLocationChange(new PopStateEvent('popstate'));
    expect(api.state.search).toBe('retry');
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(document.querySelector('#btn-edit-flow-search')?.textContent).toBe('“retry”');
  });

  it('keeps a matching search when global lookup leaves an excluding pill', async () => {
    const { api } = await setup();
    await api.applyView({ filter: { type: 'project', id: otherProject }, search: 'retry', doc: null });
    const input = document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'entry:rollback'; api.handleSearch(input.value);
    document.querySelector<HTMLElement>('[data-key="entry:2026-08-31T10:00"]')!.click();
    await vi.waitFor(() => expect(location.pathname).toBe('/work/2026-08-31T10:00'));
    expect(api.state.filter).toBeNull(); expect(api.state.search).toBe('retry');
    expect(document.getElementById('filter-pill')!.hidden).toBe(true);
    expect(location.search).toBe('?search=retry');
  });

  it('preserves search across pill replace/toggle and clears each layer independently', async () => {
    const { api, ids } = await setup();
    await api.applyFlowSearch('retry + rollback');
    await api.applyView({ filter: { type: 'project', id: otherProject }, search: api.state.search, doc: null });
    expect(ids()).toEqual([]); expect(api.state.search).toBe('retry + rollback');
    api.handleTagClick({ type: 'action', id: action });
    await vi.waitFor(() => expect(document.querySelector('#scroll-sentinel')).not.toBeNull());
    await api.loadMoreWeeks(20);
    expect(ids()).toContain('2026-08-31T10:00');
    expect(api.state.filter).toEqual({ type: 'action', id: action });
    api.handleTagClick({ type: 'action', id: action }, document.createElement('a'));
    await vi.waitFor(() => expect(api.state.filter).toBeNull());
    expect(api.state.search).toBe('retry + rollback');
    await api.applyView({ filter: { type: 'project', id: project }, search: api.state.search, doc: null });
    document.querySelector<HTMLButtonElement>('#btn-clear-flow-search')!.focus();
    await api.applyFlowSearch('');
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(document.querySelector<HTMLElement>('#flow-search')!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('#search-results')!.hidden).toBe(true);
  });

  it('retains the search chip and independent recovery actions for a verified empty intersection', async () => {
    const { api, ids } = await setup();
    await api.applyView({ filter: { type: 'project', id: project }, search: 'not present', doc: null });
    await api.loadMoreWeeks(20);
    expect(ids()).toEqual([]);
    expect(document.querySelector('.flow-empty')?.textContent).toContain('No entries match this filter.');
    expect([...document.querySelectorAll('.flow-empty button')].map(button => button.textContent)).toEqual(['Clear filter', 'Clear search']);
    api.clearFilter();
    await vi.waitFor(() => expect(api.state.filter).toBeNull()); await api.loadMoreWeeks(20);
    expect(api.state.search).toBe('not present');
    expect(document.querySelector<HTMLElement>('#flow-search')!.hidden).toBe(false);
  });

  it('keeps summary links in sync when the quoted search filter changes', async () => {
    const { api } = await setup();
    await api.applyView({ filter: { type: 'project', id: project }, search: 'retry', doc: null });
    const detailLink = () => document.querySelector<HTMLAnchorElement>('#side-panel-body a[href*="/detail"]');
    expect(detailLink()?.search).toBe('?search=retry');
    await api.applyFlowSearch('');
    expect(detailLink()?.search).toBe('');
    expect(document.querySelector('#side-panel-body')!.textContent).toContain('Good program');
  });

  it('restores term and pill from Back/Forward and preserves search in reader links', async () => {
    const { api, ids } = await setup();
    await api.applyView({ filter: { type: 'project', id: project }, search: 'retry', doc: null });
    const chip = document.querySelector<HTMLElement>('#flow-search')!;
    expect(chip.hidden).toBe(false);
    expect(document.querySelector<HTMLAnchorElement>('#flow .tag-action')?.search).toBe('?search=retry');
    api.openDetail(); await vi.waitFor(() => expect(api.state.doc).toEqual({ kind: 'detail' }));
    expect(location.search).toBe('?search=retry');
    expect(api.state.search).toBe('retry'); expect(chip.hidden).toBe(false);
    api.closeDoc(); await vi.waitFor(() => expect(api.state.doc).toBeNull());
    expect(api.state.search).toBe('retry');
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toContain('“retry”');
    api.openDetail(); await vi.waitFor(() => expect(api.state.doc).toEqual({ kind: 'detail' }));
    expect(chip.hidden).toBe(false);
    await api.jumpToEntry('2026-10-12T10:00');
    expect(api.state.doc).toBeNull(); expect(api.state.search).toBe('retry');
    expect(chip.hidden).toBe(false);
    history.replaceState(null, '', `/work/project/${otherProject}?search=Ordinary`);
    await api.handleLocationChange(new PopStateEvent('popstate'));
    expect(api.state.search).toBe('Ordinary'); expect(ids()).toEqual(['2026-10-05T10:00']);
    history.replaceState(null, '', `/work/project/${project}?search=retry`);
    await api.handleLocationChange(new PopStateEvent('popstate'));
    expect(api.state.search).toBe('retry'); expect(api.state.filter?.id).toBe(project);
    await api.loadMoreWeeks(20);
    expect(ids()).toEqual(['2026-10-12T10:00', '2026-08-31T10:00']);
    api.clearInstanceView(); expect(api.state.search).toBe('');
    expect(document.querySelector<HTMLElement>('#flow-search')!.hidden).toBe(true);
  });

  it('retains search when an entry is excluded and opens the explicit fallback in one history visit', async () => {
    const { api } = await setup();
    await api.applyFlowSearch('retry');
    const route = location.pathname + location.search;
    await api.jumpToEntry('2026-10-05T10:00');
    expect(location.pathname + location.search).toBe(route); expect(api.state.search).toBe('retry');
    const count = history.length;
    const fallback = document.querySelector<HTMLButtonElement>('#action-toast button')!;
    fallback.focus(); fallback.click();
    await vi.waitFor(() => expect(location.pathname).toBe('/work/2026-10-05T10:00'));
    expect(location.search).toBe(''); expect(history.length).toBe(count + 1);
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector('#flow [data-entry-id="2026-10-05T10:00"] a.em-time')));
  });

  it('keeps an unread week recoverable instead of claiming no search matches', async () => {
    const { api, store } = await setup();
    const read = store.getWeekEntries.bind(store); let fail = true;
    vi.spyOn(store, 'getWeekEntries').mockImplementation(async week => {
      if (week === '2026-08-31' && fail) throw new Error('Offline');
      return read(week);
    });
    await api.applyFlowSearch('not present'); await api.loadMoreWeeks(20);
    expect(document.querySelector('.flow-empty')).toBeNull();
    expect(document.querySelector('.history-notice')?.textContent).toContain('Offline');
    fail = false; document.querySelector<HTMLButtonElement>('.history-notice button')!.click();
    await vi.waitFor(() => expect(document.querySelector('.flow-empty')?.textContent).toContain('No entries match'));
  });
});
