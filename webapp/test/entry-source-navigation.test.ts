// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, getOperationAST, graphqlSync, Kind, parse, valueFromASTUntyped } from 'graphql';
import { entryReferences, getMondayOfWeek, type Entry, type EntityRef } from '../lib/types';
import { matchesFlowSearch } from '../src/flow-search';
import type { DocRef, ViewState } from '../src/route';
import type { SourceDefinition } from '../src/entry-source';
import type { WebQueryRequest } from '../../cli/src/core/web-query';
import type { PendingUpdate } from '../../cli/src/core/data-snapshot';
import { buildRoute } from '../src/route';
import type { RemoteStore } from '../lib/remote-store';
import { rangeBoundary, type TimestampRange } from '../../cli/src/core/timestamp-range';
import { preserveSessionNavigation } from '../mock/session-navigation';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';
import { stubBrowserFetch } from './auth-fixture';

interface App {
  state: { store: RemoteStore | null; filter: EntityRef | null; search: string; source?: string; range?: TimestampRange; order?: 'CREATED_ASC' | 'CREATED_DESC'; doc: DocRef | null };
  setupNavigationSidebar(): void;
  setupModals(): void;
  setupSearch(): void;
  handleSearch(query: string): void;
  applyAnimSpeed(): void;
  connectToInstance(id: string): Promise<void>;
  applyView(view: ViewState): Promise<void>;
  applyDataUpdate(update: PendingUpdate): Promise<void>;
  loadMoreWeeks(count: number): Promise<void>;
  jumpToEntry(id: string, push?: boolean, anchor?: null, block?: ScrollLogicalPosition,
    userInitiated?: boolean, duration?: number, origin?: 'reference' | 'lookup'): Promise<void>;
  jumpToDate(date: string): Promise<void>;
  handleLocationChange(event?: Event): Promise<void>;
  openDetail(): void;
  closeDoc(): void;
  clearInstanceView(): void;
  navigationSidebar?: { dispose(): void; closePopover(): void };
  stopControl?: () => void;
}

const project = '2026-10-04-program', otherProject = '2026-10-04-other';
const sourceId = '2026-10-04-decisions', otherSourceId = '2026-10-04-reviews';
const source = `#artifact/${sourceId}/decisions.json`, otherSource = `#artifact/${otherSourceId}/decisions.json`;
const encodedSource = encodeURIComponent(source);
const newest = '2026-10-04T11:00', middle = '2026-10-04T10:00', older = '2026-10-04T09:00', oldest = '2026-10-04T08:00';
const scopedUrl = `/work/project/${project}?source=${encodedSource}&search=calmer`;
let app: App | undefined;
let restoreSession: (() => void) | undefined;

afterEach(() => {
  app?.stopControl?.(); app?.clearInstanceView(); app?.navigationSidebar?.dispose(); app = undefined;
  restoreSession?.(); restoreSession = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

function definition(name: string): SourceDefinition {
  return {
    operationName: name,
    query: `query ${name}($predicate: EntryWhere, $direction: RecordOrder = CREATED_DESC) { stream: entries(where: $predicate, orderBy: $direction) { records: nodes { stamp: id content } } }`,
    variables: { predicate: name === 'Reviews' ? { search: 'review' }
      : { or: [{ search: 'decision' }, { search: 'review' }], not: { search: 'routine' } } },
  };
}

const fixtureSchema = buildSchema(`
  enum RecordOrder { CREATED_ASC CREATED_DESC }
  input EntryBrowseWhere { project: ID, action: ID, search: String, createdFrom: String, createdTo: String }
  input EntryWhere { ids: [ID!], search: String, createdFrom: String, createdTo: String, browse: EntryBrowseWhere, and: [EntryWhere!], or: [EntryWhere!], not: EntryWhere }
  type Entry { id: ID!, content: String! }
  type EntryPage { nodes: [Entry!]!, offset: Int!, count: Int!, totalCount: Int! }
  type Query { entries(where: EntryWhere, offset: Int = 0, limit: Int = 20, orderBy: RecordOrder = CREATED_DESC): EntryPage! }
`);
function entryArguments(request: WebQueryRequest): { where?: Record<string, any>; offset: number; limit: number; orderBy?: string } {
  const operation = getOperationAST(parse(request.query), request.operationName)!;
  const field = operation.selectionSet.selections.find(node => node.kind === Kind.FIELD && node.name.value === 'entries');
  if (!field || field.kind !== Kind.FIELD) throw new Error('Fixture query must select entries.');
  return Object.fromEntries((field.arguments ?? []).map(argument => [argument.name.value, valueFromASTUntyped(argument.value, request.variables)])) as ReturnType<typeof entryArguments>;
}

function matchesWhere(entry: Entry, where: Record<string, any> = {}): boolean {
  const browse = where.browse ?? {};
  return (!where.ids || where.ids.includes(entry.meta.created))
    && (!where.search || new RegExp(where.search, 'i').test(entry.content))
    && (!where.createdFrom || entry.meta.created.slice(0, 10) >= where.createdFrom)
    && (!where.createdTo || entry.meta.created.slice(0, 10) <= where.createdTo)
    && (!browse.project || entryReferences(entry, { type: 'project', id: browse.project }))
    && (!browse.action || entryReferences(entry, { type: 'action', id: browse.action }))
    && matchesFlowSearch(entry, browse.search ?? '')
    && (!browse.createdFrom || rangeBoundary(entry.meta.created) >= rangeBoundary(browse.createdFrom))
    && (!browse.createdTo || rangeBoundary(entry.meta.created) <= rangeBoundary(browse.createdTo, true))
    && (!where.and || where.and.every((part: Record<string, any>) => matchesWhere(entry, part)))
    && (!where.or || where.or.some((part: Record<string, any>) => matchesWhere(entry, part)))
    && (!where.not || !matchesWhere(entry, where.not));
}

async function setup(route = scopedUrl, preview = false, large = false, authoredAscending = false) {
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  history.replaceState(null, '', route);
  if (preview) restoreSession = preserveSessionNavigation('source-preview');
  localStorage.setItem('animSpeed', '0');
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  const data = snapshotFixture('work');
  data.instance!.body = 'An instance overview with the existing context. #date/2026-10-04T09:30';
  data.instance!.manifest.config = { webapp: { sidebar: [{ title: 'Agent views', items: [
    { timeline: source, label: 'Recent decisions' }, { timeline: otherSource, label: 'Recent reviews' },
  ] }] } };
  data.projects[0][1].body = `The full project body. [Related entry](#entry/${newest})`;
  data.projects.push([otherProject, { frontMatter: { name: 'Other program', created: oldest }, body: '' }]);
  data.indexes.projects.push({ id: otherProject, description: 'Other program' });
  const entries: Entry[] = large ? Array.from({ length: 60 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 9, 4 - index, 12)).toISOString().slice(0, 10);
    return { meta: { created: `${date}T12:00`, projects: [project] }, content: `A calmer decision ${index}.`,
      weekFile: getMondayOfWeek(new Date(`${date}T00:00:00`)) };
  }) : [
    { meta: { created: newest, projects: [project], actions: ['2026-10-04-task'] },
      content: `A calmer release decision. #project/${project} #action/2026-10-04-task [Source notes](../../assets/notes.md)`, weekFile: '2026-09-28' },
    { meta: { created: middle, projects: [project] }, content: 'A calmer routine note.', weekFile: '2026-09-28' },
    { meta: { created: older, projects: [otherProject] }, content: 'A calmer release review.', weekFile: '2026-09-28' },
    { meta: { created: oldest, projects: [project] }, content: 'A release decision without the phrase.', weekFile: '2026-09-28' },
  ];
  const weeks = new Map<string, Entry[]>();
  for (const entry of entries) weeks.set(entry.weekFile, [...weeks.get(entry.weekFile) ?? [], entry]);
  data.weeks = [...weeks]; data.weeklyDates = [...weeks.keys()].sort().reverse();
  data.indexes.notes = entries.map(entry => ({ id: entry.meta.created, description: 'A release note' }));
  data.weeksByEntity = [[`#project/${project}`, data.weeklyDates], [`#project/${otherProject}`, large ? [] : ['2026-09-28']]];
  data.relations.entriesByEntity = [[`#project/${project}`, large ? entries.map(entry => entry.meta.created) : [newest, middle, oldest]], [`#project/${otherProject}`, large ? [] : [older]]];
  for (const [id, name] of [[sourceId, 'Recent decisions'], [otherSourceId, 'Recent reviews'], ['2026-10-04-not-listed', 'An undeclared query artifact']]) {
    data.indexes.artifacts.push({ id, description: name });
    data.artifacts.push([id, { frontMatter: { name, created: oldest, attachments: ['decisions.json'] }, body: 'An agent-owned entry view.' }]);
  }
  const requests: { request: WebQueryRequest; signal?: AbortSignal | null }[] = [];
  const fileRequests: string[] = [];
  let mode: 'normal' | 'error' | 'incomplete' = 'normal';
  const sidebarWrites: unknown[] = [];
  const sidebarAttempts: unknown[] = [];
  let beforeSidebarWrite: (() => void) | undefined;
  const excluded = new Set<string>();
  let hold: { resolve(response: Response): void; promise: Promise<Response> } | undefined;
  let holdSnapshot: { resolve(response: Response): void; promise: Promise<Response>; captured?: typeof data } | undefined;
  function response(request: WebQueryRequest): Response {
    if (mode === 'error') return Response.json({ errors: [{ message: 'The query service is temporarily unavailable.' }], extensions: { complete: false } });
    const result = graphqlSync({ schema: fixtureSchema, source: request.query, variableValues: request.variables,
      operationName: request.operationName, rootValue: {
        entries: ({ where, offset = 0, limit = 20, orderBy = 'CREATED_DESC' }: ReturnType<typeof entryArguments>) => {
          const matches = entries.filter(entry => !excluded.has(entry.meta.created) && matchesWhere(entry, where))
            .sort((left, right) => orderBy === 'CREATED_ASC' ? left.meta.created.localeCompare(right.meta.created) : right.meta.created.localeCompare(left.meta.created));
          const nodes = matches.slice(offset, offset + limit).map(entry => ({ id: entry.meta.created, content: entry.content }));
          return { nodes, offset, count: nodes.length, totalCount: matches.length };
        },
      } });
    return Response.json({ ...result, extensions: { complete: mode !== 'incomplete' } });
  }
  stubBrowserFetch((url, init) => {
    if (url === '/-/api/instances/work') return Response.json({ id: 'work', name: 'Work', path: '/fixture/work' });
    if (url.startsWith('/-/api/instances/work/data')) {
      if (holdSnapshot) {
        const pending = holdSnapshot; holdSnapshot = undefined; pending.captured = structuredClone(data);
        return pending.promise;
      }
      return Response.json(data);
    }
    if (url.endsWith('/files/aside.md')) return new Response(`---\nid: work\nconfig: ${JSON.stringify(data.instance!.manifest.config)}\n---\n`);
    if (url.endsWith('/sidebar') && init?.method === 'POST') {
      const { sidebar, expectedSidebar } = JSON.parse(String(init.body));
      sidebarAttempts.push(structuredClone({ sidebar, expectedSidebar }));
      const before = beforeSidebarWrite; beforeSidebarWrite = undefined; before?.();
      if (JSON.stringify(expectedSidebar) !== JSON.stringify(data.instance!.manifest.config!.webapp!.sidebar ?? [])) {
        return Response.json({ error: 'Sidebar changed. Refresh and try again.' }, { status: 409 });
      }
      sidebarWrites.push(structuredClone(sidebar)); data.instance!.manifest.config!.webapp = { sidebar };
      return Response.json({ sidebar });
    }
    if (url.endsWith('/graphql')) {
      const request = JSON.parse(String(init?.body)) as WebQueryRequest;
      requests.push({ request, signal: init?.signal });
      if (hold) { const pending = hold; hold = undefined; return pending.promise; }
      return response(request);
    }
    const match = /\/files\/artifacts\/2026\/([^/]+)\/decisions\.json$/.exec(url);
    if (match && [sourceId, otherSourceId].includes(match[1])) {
      fileRequests.push(url);
      const declaration = definition(match[1] === sourceId ? 'Decisions' : 'Reviews');
      if (authoredAscending && match[1] === sourceId) declaration.variables!.direction = 'CREATED_ASC';
      return new Response(JSON.stringify(declaration));
    }
    return new Response('', { status: 404 });
  });
  app = await loadApp<App>('state, setupNavigationSidebar, setupModals, setupSearch, handleSearch, applyAnimSpeed, connectToInstance, applyView, applyDataUpdate, loadMoreWeeks, jumpToEntry, jumpToDate, handleLocationChange, openDetail, closeDoc, clearInstanceView, navigationSidebar, stopControl');
  app.applyAnimSpeed(); app.setupModals(); app.setupNavigationSidebar(); app.setupSearch();
  await app.connectToInstance('work');
  return {
    api: app, requests, records: entries, data, sidebarWrites, sidebarAttempts, fileRequests,
    beforeNextSidebarWrite(run: () => void) { beforeSidebarWrite = run; },
    ids: () => Array.from(document.querySelectorAll<HTMLElement>('#flow [data-entry-id]')).map(card => card.dataset.entryId),
    mode(value: typeof mode) { mode = value; },
    excludeFromSource(id: string) { excluded.add(id); },
    holdNextSnapshot() {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>(done => { resolve = done; });
      const pending = { resolve, promise, captured: undefined as typeof data | undefined };
      holdSnapshot = pending;
      return { get entered() { return !!pending.captured; }, finish() { resolve(Response.json(pending.captured)); } };
    },
    holdNextQuery() {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>(done => { resolve = done; });
      hold = { resolve, promise };
      return { finish: (request: WebQueryRequest) => resolve(response(request)) };
    },
  };
}

describe('agent entry views in the native application', () => {
  it('opens the displayed sidebar target while an agent reorder is installed during a held query refresh', async () => {
    const { api, data, requests, holdNextQuery, ids } = await setup();
    const store = api.state.store!;
    document.getElementById('btn-workspace-views')!.click();
    const displayed = document.querySelector<HTMLAnchorElement>('#workspace-sections a')!;
    expect(displayed.textContent).toBe('Recent decisions');
    let finishDefinition!: (value: string) => void;
    const definitionRead = vi.spyOn(store, 'getAsset').mockImplementationOnce(() => new Promise(resolve => { finishDefinition = resolve; }));
    data.instance!.manifest.config!.webapp!.sidebar![0].items.reverse();
    data.weeks[0][1][0].content += ' An agent update.';
    const update = await store.check('full', { weeks: [], entities: [], assets: [] });
    const refreshing = api.applyDataUpdate(update!);
    await vi.waitFor(() => expect(definitionRead).toHaveBeenCalled());
    expect(store.getInstance()!.manifest.config!.webapp!.sidebar![0].items[0].label).toBe('Recent reviews');
    expect(document.querySelector('#workspace-sections a')).toBe(displayed);
    const before = requests.length, held = holdNextQuery();
    displayed.click();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(before));
    expect(api.state.source).toBe(source);
    expect(requests.at(-1)!.request.operationName).toBe('Decisions');
    finishDefinition(JSON.stringify(definition('Decisions')));
    held.finish(requests.at(-1)!.request);
    await refreshing;
    await vi.waitFor(() => expect(ids()).toEqual([newest, older, oldest]));
    expect(api.state.source).toBe(source);
  });

  it('uses only the explicitly ordered sidebar and loads a query when its declared item is selected', async () => {
    const { api, ids, fileRequests } = await setup('/work/');
    expect(Array.from(document.querySelectorAll('#workspace-sections a')).map(link => link.textContent))
      .toEqual(['Recent decisions', 'Recent reviews']);
    expect(document.getElementById('workspace-sections')!.textContent).not.toContain('An undeclared query artifact');
    expect(fileRequests).toEqual([]);
    document.querySelector<HTMLAnchorElement>('#workspace-sections [data-section-index="0"][data-item-index="1"]')!.click();
    await vi.waitFor(() => expect(api.state.source).toBe(otherSource));
    await vi.waitFor(() => expect(ids()).toEqual([older]));
    expect(fileRequests).toHaveLength(1);
    expect(fileRequests[0]).toContain(otherSourceId);
  });

  it('pages an authored ascending query and preserves that order through date, exact-entry and history navigation', async () => {
    const { api, ids, records, requests } = await setup(scopedUrl, false, true, true);
    const ordered = [...records].reverse().map(entry => entry.meta.created);
    expect(ids()).toEqual(ordered.slice(0, 50));
    expect(entryArguments(requests[0].request).orderBy).toBe('CREATED_ASC');
    const visit = structuredClone(history.state), url = location.pathname + location.search;
    const target = records[3].meta.created;
    await api.jumpToDate(target.slice(0, 10));
    expect(ids()).toEqual(ordered);
    expect(document.querySelector(`[data-entry-id="${target}"]`)?.classList.contains('is-target')).toBe(true);

    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'calmer', order: 'CREATED_DESC', doc: null });
    expect(ids()).toEqual(records.slice(0, 50).map(entry => entry.meta.created));
    history.replaceState(visit, '', url);
    await api.handleLocationChange(new PopStateEvent('popstate', { state: visit }));
    expect(ids()).toEqual(ordered.slice(0, 50));
    expect(api.state.order).toBeUndefined();
    await api.jumpToEntry(target);
    expect(ids()).toEqual(ordered);
    expect(document.querySelector(`[data-entry-id="${target}"]`)?.classList.contains('is-target')).toBe(true);
    expect(api.state).toMatchObject({ source, search: 'calmer', filter: { type: 'project', id: project } });
  });

  it('shows and removes a date range independently of the query, pill and literal search', async () => {
    const { api, ids, requests } = await setup();
    const range = { start: '2026-10-04T09:00', end: '2026-10-04T12:00' };
    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'release', range, doc: null });
    expect(ids()).toEqual([newest]); expect(api.state.range).toEqual(range);
    expect(document.querySelector('[aria-label="Clear date range"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Clear entry source"]')).not.toBeNull();
    expect(entryArguments(requests.at(-1)!.request).where).toEqual({ and: [definition('Decisions').variables!.predicate,
      { browse: { project, search: 'release', createdFrom: range.start, createdTo: range.end } }] });
    document.querySelector<HTMLButtonElement>('[aria-label="Clear date range"]')!.click();
    await vi.waitFor(() => expect(api.state.range).toBeUndefined());
    await vi.waitFor(() => expect(ids()).toEqual([newest, oldest]));
    expect(api.state).toMatchObject({ source, search: 'release', filter: { type: 'project', id: project } });
    expect(new URLSearchParams(location.search).has('range')).toBe(false);
    expect(document.querySelector('[aria-label="Clear date range"]')).toBeNull();
    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'release',
      range: { start: '2026-10-04', end: '2026-10-04' }, doc: null });
    expect(ids()).toEqual([newest, oldest]);
  });

  it('clears query-specific ascending order when removing the source and keeps native browsing filters', async () => {
    const { api, ids, records } = await setup(scopedUrl, false, true, true);
    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'calmer', order: 'CREATED_ASC', doc: null });
    expect(ids()[0]).toBe(records.at(-1)!.meta.created);
    document.querySelector<HTMLButtonElement>('[aria-label="Clear entry source"]')!.click();
    await vi.waitFor(() => expect(api.state.source).toBeUndefined());
    await vi.waitFor(() => expect(ids()[0]).toBe(records[0].meta.created));
    await vi.waitFor(() => expect(document.getElementById('scroll-sentinel')).not.toBeNull());
    await api.loadMoreWeeks(20);
    expect(api.state.order).toBeUndefined();
    expect(api.state.filter).toEqual({ type: 'project', id: project }); expect(api.state.search).toBe('calmer');
    expect(ids()).toEqual(records.map(entry => entry.meta.created));
    expect(new URLSearchParams(location.search).has('order')).toBe(false);
  });

  it('clears an empty range-only filter through its empty-state recovery action', async () => {
    const { api, ids } = await setup('/work/');
    await api.applyView({ filter: null, range: { start: '2030-01-01', end: '2030-01-02' }, doc: null });
    expect(ids()).toEqual([]);
    const recovery = Array.from(document.querySelectorAll<HTMLButtonElement>('.flow-empty button'));
    expect(recovery.map(button => button.textContent)).toEqual(['Clear filter']);
    recovery[0].click();
    await vi.waitFor(() => expect(api.state.range).toBeUndefined());
    await vi.waitFor(() => expect(ids()).toEqual([newest, middle, older, oldest]));
    expect(document.querySelector('.flow-empty')).toBeNull();
    expect(document.querySelector('[aria-label="Clear date range"]')).toBeNull();
    expect(new URLSearchParams(location.search).has('range')).toBe(false);
  });

  it('keeps source, range and ordering in native content links and uses the originating flow for Overview date links', async () => {
    const { api } = await setup();
    const range = { start: '2026-10-04', end: '2026-10-04' };
    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'release', range, order: 'CREATED_ASC', doc: null });
    const card = document.querySelector<HTMLElement>(`#flow [data-entry-id="${newest}"]`)!;
    for (const selector of ['a.em-time', 'a.tag-project', 'a.tag-action', 'a[href*="assets/notes.md"]']) {
      const link = card.querySelector<HTMLAnchorElement>(selector);
      expect(link, selector).not.toBeNull();
      const url = new URL(link!.href);
      expect(url.searchParams.get('source'), selector).toBe(source);
      expect(url.searchParams.get('order'), selector).toBe('CREATED_ASC');
      expect(url.searchParams.get('range'), selector).toBe('#date/2026-10-04/2026-10-04');
      expect(url.searchParams.get('search'), selector).toBe('release');
    }
    await api.applyView({ source, filter: null, search: 'release', range, order: 'CREATED_ASC', doc: { kind: 'detail' } });
    const date = document.querySelector<HTMLAnchorElement>('#doc-body a[data-date-handle]')!;
    expect(date).not.toBeNull();
    const url = new URL(date.href);
    expect(url.pathname).toBe(`/work/project/${project}/date/2026-10-04T09:30`);
    expect(url.searchParams.get('source')).toBe(source); expect(url.searchParams.get('order')).toBe('CREATED_ASC');
    expect(url.searchParams.get('range')).toBe('#date/2026-10-04/2026-10-04');
    date.click();
    await vi.waitFor(() => expect(api.state.doc).toBeNull());
    await vi.waitFor(() => expect(api.state.filter).toEqual({ type: 'project', id: project }));
    expect(api.state.range).toEqual(range); expect(api.state.order).toBe('CREATED_ASC');
  });

  it('preserves a matching search when global lookup leaves an excluding date range', async () => {
    const { api, ids } = await setup();
    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'calmer', order: 'CREATED_ASC',
      range: { start: '2026-10-04T08:00', end: '2026-10-04T09:30' }, doc: null });
    expect(ids()).toEqual([]);
    await api.jumpToEntry(newest, true, null, 'center', true, 0, 'lookup');
    expect(api.state).toMatchObject({ source, filter: { type: 'project', id: project }, search: 'calmer', order: 'CREATED_ASC' });
    expect(api.state.range).toBeUndefined(); expect(ids()).toEqual([newest]);
    expect(new URLSearchParams(location.search).get('search')).toBe('calmer');
  });

  it('preserves a matching date range when global lookup leaves an excluding search', async () => {
    const { api, ids } = await setup();
    const range = { start: '2026-10-04', end: '2026-10-04' };
    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'without the phrase', range, order: 'CREATED_ASC', doc: null });
    expect(ids()).toEqual([oldest]);
    await api.jumpToEntry(newest, true, null, 'center', true, 0, 'lookup');
    expect(api.state).toMatchObject({ source, filter: { type: 'project', id: project }, range, order: 'CREATED_ASC' });
    expect(api.state.search).toBe(''); expect(ids()).toEqual([oldest, newest]);
    expect(new URLSearchParams(location.search).get('range')).toBe('#date/2026-10-04/2026-10-04');
  });

  it('pages the native cards and reaches older exact entries and dates through the source', async () => {
    const { api, ids, records, requests } = await setup(scopedUrl, false, true);
    expect(ids()).toEqual(records.slice(0, 50).map(entry => entry.meta.created));
    await api.loadMoreWeeks(1);
    expect(ids()).toEqual(records.map(entry => entry.meta.created));
    const last = document.querySelector<HTMLElement>(`[data-entry-id="${records[59].meta.created}"]`)!;
    expect(last.textContent).toContain('A calmer decision 59.');
    expect(last.querySelector(`[data-ref-id="${project}"]`)).not.toBeNull();
    expect(requests.slice(0, 2).map(item => entryArguments(item.request).offset)).toEqual([0, 50]);

    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'CALMER', doc: null });
    expect(ids()).toHaveLength(50);
    const target = records[55].meta.created;
    await api.jumpToEntry(target);
    expect(ids()).toHaveLength(60);
    expect(document.querySelector(`[data-entry-id="${target}"]`)?.classList.contains('is-target')).toBe(true);
    expect(api.state.source).toBe(source);
    expect(api.state.filter).toEqual({ type: 'project', id: project });

    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'calmer', doc: null });
    expect(ids()).toHaveLength(50);
    await api.jumpToDate(target.slice(0, 10));
    expect(ids()).toHaveLength(60);
    expect(document.querySelector(`[data-entry-id="${target}"]`)?.classList.contains('is-target')).toBe(true);
    expect(api.state.search).toBe('calmer'); expect(api.state.source).toBe(source);
    for (const { request } of requests) {
      const where = entryArguments(request).where as { and: unknown[] };
      expect(where.and[0]).toEqual(definition('Decisions').variables!.predicate);
    }
  });

  it('composes a source, pill and search and removes only the selected layer', async () => {
    const { api, ids, requests } = await setup();
    expect(ids()).toEqual([newest]);
    expect(entryArguments(requests[0].request).where).toEqual({ and: [
      definition('Decisions').variables!.predicate, { browse: { project, search: 'calmer' } },
    ] });
    expect(document.getElementById('source-filter')!.hidden).toBe(false);
    expect(document.getElementById('filter-pill')!.hidden).toBe(false);
    expect(document.getElementById('btn-edit-flow-search')!.textContent).toBe('“calmer”');
    document.querySelector<HTMLButtonElement>('#source-filter .filter-pill-label')!.click();
    expect(document.getElementById('workspace-inspection')!.textContent).toContain('decisions.json');
    expect(document.getElementById('workspace-inspection')!.textContent).toContain('Decisions');
    expect(document.querySelector('#workspace-inspection textarea, #workspace-inspection [contenteditable="true"]')).toBeNull();
    api.navigationSidebar!.closePopover();
    document.querySelector<HTMLButtonElement>('[aria-label="Clear entry source"]')!.click();
    await vi.waitFor(() => expect(api.state.source).toBeUndefined());
    await vi.waitFor(() => expect(ids()).toEqual([newest, middle]));
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(api.state.search).toBe('calmer');
    expect(document.getElementById('source-filter')!.hidden).toBe(true);
    expect(document.getElementById('flow-search')!.hidden).toBe(false);
  });

  it('restores a pinned source state while leaving its filters mutable', async () => {
    const { api, ids, data, sidebarWrites } = await setup();
    const originalSections = structuredClone(data.instance!.manifest.config!.webapp!.sidebar!);
    document.getElementById('btn-workspace-pin')!.click();
    await vi.waitFor(() => expect(sidebarWrites).toHaveLength(1));
    const pinned = `aside://work/${buildRoute({ source, filter: { type: 'project', id: project }, search: 'calmer', doc: null })}`;
    await vi.waitFor(() => expect(data.instance!.manifest.config!.webapp!.sidebar!.flatMap(section => section.items)).toContainEqual(expect.objectContaining({ timeline: pinned })));
    expect(data.instance!.manifest.config!.webapp!.sidebar![0]).toEqual(originalSections[0]);
    document.getElementById('nav-entries')!.click();
    await vi.waitFor(() => expect(ids()).toEqual([newest, middle, older, oldest]));
    expect(api.state.source).toBeUndefined(); expect(api.state.filter).toBeNull(); expect(api.state.search).toBe('');
    await vi.waitFor(() => expect(document.querySelector('#workspace-sections [data-section-index="1"][data-item-index="0"]')).not.toBeNull());
    document.querySelector<HTMLAnchorElement>('#workspace-sections [data-section-index="1"][data-item-index="0"]')!.click();
    await vi.waitFor(() => expect(ids()).toEqual([newest]));
    expect(api.state).toMatchObject({ source, filter: { type: 'project', id: project }, search: 'calmer' });
    document.querySelector<HTMLButtonElement>('[aria-label="Clear filter"]')!.click();
    await vi.waitFor(() => expect(ids()).toEqual([newest, older]));
    expect(api.state.source).toBe(source); expect(api.state.search).toBe('calmer');
    expect(sidebarWrites).toHaveLength(1);
    expect(data.instance!.manifest.config!.webapp!.sidebar!.flatMap(section => section.items)).toContainEqual(expect.objectContaining({ timeline: pinned }));
  });

  it('retries a Pin against a newer declaration without losing concurrent agent sections', async () => {
    const { api, data, sidebarWrites, sidebarAttempts, beforeNextSidebarWrite } = await setup();
    const added = { title: 'New agent section', items: [{ entity: `#project/${otherProject}` }] };
    beforeNextSidebarWrite(() => { data.instance!.manifest.config!.webapp!.sidebar!.push(added); });
    document.getElementById('btn-workspace-pin')!.click();
    await vi.waitFor(() => expect(sidebarWrites).toHaveLength(1));
    expect(sidebarAttempts).toHaveLength(2);
    expect(data.instance!.manifest.config!.webapp!.sidebar).toContainEqual(added);
    await vi.waitFor(() => expect(document.getElementById('btn-workspace-pin')!.textContent).toBe('Unpin this view'));
    expect(api.state.search).toBe('calmer');
  });

  it('does not unpin a view that another browser pinned during a conflicting Pin request', async () => {
    const { data, sidebarWrites, sidebarAttempts, beforeNextSidebarWrite } = await setup();
    const target = `aside://work/${buildRoute({ source, filter: { type: 'project', id: project }, search: 'calmer', doc: null })}`;
    beforeNextSidebarWrite(() => { data.instance!.manifest.config!.webapp!.sidebar!.push({ items: [{ label: 'Another browser', timeline: target }] }); });
    document.getElementById('btn-workspace-pin')!.click();
    await vi.waitFor(() => expect(document.getElementById('btn-workspace-pin')!.textContent).toBe('Unpin this view'));
    expect(sidebarAttempts).toHaveLength(1);
    expect(sidebarWrites).toEqual([]);
    expect(data.instance!.manifest.config!.webapp!.sidebar!.flatMap(section => section.items)).toContainEqual({ label: 'Another browser', timeline: target });
  });

  it('does not re-add a view another browser already unpinned during a conflicting Unpin request', async () => {
    const { data, sidebarWrites, sidebarAttempts, beforeNextSidebarWrite } = await setup();
    document.getElementById('btn-workspace-pin')!.click();
    await vi.waitFor(() => expect(document.getElementById('btn-workspace-pin')!.textContent).toBe('Unpin this view'));
    const added = { title: 'Concurrent addition', items: [{ timeline: 'Another focus' }] };
    beforeNextSidebarWrite(() => {
      data.instance!.manifest.config!.webapp!.sidebar = [data.instance!.manifest.config!.webapp!.sidebar![0], added];
    });
    document.getElementById('btn-workspace-pin')!.click();
    await vi.waitFor(() => expect(document.getElementById('btn-workspace-pin')!.textContent).toBe('Pin this view'));
    expect(sidebarAttempts).toHaveLength(2);
    expect(sidebarWrites).toHaveLength(1);
    expect(data.instance!.manifest.config!.webapp!.sidebar).toEqual([expect.objectContaining({ title: 'Agent views' }), added]);
  });

  it('starts at the beginning of a newly selected order instead of restoring the old reading anchor', async () => {
    const { ids, records } = await setup(`/work/?source=${encodedSource}`, false, true);
    const scroller = document.getElementById('flow-scroll')!;
    const cards = Array.from(document.querySelectorAll<HTMLElement>('#flow [data-entry-id]'));
    scroller.scrollTop = 240;
    const rect = (top: number) => ({ top, bottom: top + 80, left: 0, right: 800, width: 800, height: 80, x: 0, y: top, toJSON() {} });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0));
    vi.spyOn(cards[0], 'getBoundingClientRect').mockReturnValue(rect(-200));
    vi.spyOn(cards[1], 'getBoundingClientRect').mockReturnValue(rect(0));
    document.getElementById('btn-sort-oldest')!.click();
    await vi.waitFor(() => expect(ids()[0]).toBe(records.at(-1)!.meta.created));
    expect(scroller.scrollTop).toBe(0);
  });

  it('retains newly agent-added sections when Pin overlaps a background snapshot check', async () => {
    const { api, data, sidebarWrites, holdNextSnapshot } = await setup();
    const store = api.state.store!;
    // A previously inspected raw manifest must not make reloadFile refresh
    // only that text asset while its parsed instance settings stay stale.
    await store.getAsset('aside.md');
    const agentSection = { title: 'Agent addition', items: [{ timeline: 'a newer focus', label: 'New focus' }] };
    data.instance!.manifest.config!.webapp!.sidebar!.push(agentSection);
    const held = holdNextSnapshot();
    const background = store.check('full', { weeks: [], entities: [], assets: [] });
    await vi.waitFor(() => expect(held.entered).toBe(true));
    document.getElementById('btn-workspace-pin')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(sidebarWrites).toEqual([]);
    held.finish();
    const earlier = await background;
    await vi.waitFor(() => expect(sidebarWrites).toHaveLength(1));
    expect(sidebarWrites[0]).toEqual(expect.arrayContaining([agentSection]));
    await vi.waitFor(() => expect(store.getInstance()!.manifest.config!.webapp!.sidebar!.flatMap(section => section.items))
      .toContainEqual(expect.objectContaining({ timeline: expect.stringContaining('aside://work/') })));
    const pinned = structuredClone(store.getInstance()!.manifest.config!.webapp!.sidebar);
    earlier?.apply();
    expect(store.getInstance()!.manifest.config!.webapp!.sidebar).toEqual(pinned);
  });

  it('repaints concurrent record edits during pin refresh while preserving the Reader position', async () => {
    const { api, data, requests, sidebarWrites } = await setup();
    api.openDetail();
    await vi.waitFor(() => expect(document.getElementById('doc-body')!.textContent).toContain('The full project body.'));
    const reader = document.getElementById('doc-body')!;
    reader.scrollTop = 180;
    data.projects[0][1].body = 'The agent revised the project body.';
    data.weeks[0][1][0].content = 'A calmer release decision revised by the agent.';
    const before = requests.length;
    document.getElementById('btn-workspace-pin')!.click();
    await vi.waitFor(() => expect(sidebarWrites).toHaveLength(1));
    await vi.waitFor(() => expect(reader.textContent).toContain('The agent revised the project body.'));
    await vi.waitFor(() => expect(document.getElementById('flow')!.textContent).toContain('revised by the agent'));
    expect(reader.scrollTop).toBe(180);
    expect(api.state.doc).toEqual({ kind: 'detail' });
    expect(requests).toHaveLength(before + 1);
  });

  it('persists a pin without restarting an otherwise unchanged query', async () => {
    const { requests, sidebarWrites, data } = await setup();
    const before = requests.length;
    document.getElementById('btn-workspace-pin')!.click();
    await vi.waitFor(() => expect(sidebarWrites).toHaveLength(1));
    await vi.waitFor(() => expect(data.instance!.manifest.config!.webapp!.sidebar).toHaveLength(2));
    expect(requests).toHaveLength(before);
  });

  it('refreshes a concurrently edited instance Overview during Pin without resetting its reading position', async () => {
    const { api, data, sidebarWrites } = await setup('/work/');
    await api.applyView({ filter: null, doc: { kind: 'detail' } });
    const reader = document.getElementById('doc-body')!;
    expect(reader.textContent).toContain('An instance overview'); reader.scrollTop = 220;
    data.instance!.body = 'The agent updated the instance understanding.';
    document.getElementById('btn-workspace-pin')!.click();
    await vi.waitFor(() => expect(sidebarWrites).toHaveLength(1));
    await vi.waitFor(() => expect(reader.textContent).toContain('updated the instance understanding'));
    expect(api.state.doc).toEqual({ kind: 'detail' }); expect(reader.scrollTop).toBe(220);
  });

  it('restores a source visit through history and retains it as a record’s return flow', async () => {
    const { api, ids } = await setup();
    const visit = structuredClone(history.state), url = location.pathname + location.search;
    await api.applyView({ filter: null, source: otherSource, doc: null });
    expect(ids()).toEqual([older]);
    history.replaceState(visit, '', url);
    await api.handleLocationChange(new PopStateEvent('popstate', { state: visit }));
    expect(ids()).toEqual([newest]);
    expect(api.state).toMatchObject({ source, filter: { type: 'project', id: project }, search: 'calmer' });
    api.openDetail();
    await vi.waitFor(() => expect(document.getElementById('doc-body')!.textContent).toContain('The full project body.'));
    expect(history.state.returnFlow.view).toMatchObject({ source, filter: { type: 'project', id: project }, search: 'calmer' });
    expect(document.getElementById('source-filter')!.hidden).toBe(false);
    api.closeDoc();
    await vi.waitFor(() => expect(api.state.doc).toBeNull());
    expect(api.state.source).toBe(source); expect(ids()).toEqual([newest]);
    expect(document.getElementById('source-filter')!.hidden).toBe(false);
  });

  it('keeps the retained source chip visible while a Reader entry link returns to its flow', async () => {
    const { api, ids } = await setup();
    api.openDetail();
    const link = await vi.waitFor(() => {
      const candidate = document.querySelector<HTMLAnchorElement>(`#doc-body [data-ref-type="entry"][data-ref-id="${newest}"]`);
      expect(candidate).not.toBeNull(); return candidate!;
    });
    expect(document.getElementById('source-filter')!.hidden).toBe(false);
    link.click();
    await vi.waitFor(() => expect(document.querySelector(`[data-entry-id="${newest}"]`)?.classList.contains('is-target')).toBe(true));
    expect(api.state).toMatchObject({ source, filter: { type: 'project', id: project }, search: 'calmer', doc: null });
    expect(ids()).toEqual([newest]);
    expect(document.getElementById('source-filter')!.hidden).toBe(false);
    expect(document.getElementById('filter-pill')!.hidden).toBe(false);
    expect(document.getElementById('flow-search')!.hidden).toBe(false);
  });

  it('waits for the originating source to load before landing a date lookup from Overview', async () => {
    const { api, ids, records, requests, holdNextQuery } = await setup(scopedUrl, false, true);
    await api.applyView({ source, filter: null, search: 'calmer', doc: { kind: 'detail' } });
    expect(document.getElementById('doc-body')!.textContent).toContain('An instance overview');
    const target = records[55].meta.created, held = holdNextQuery(), before = requests.length;
    const input = document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = target.slice(0, 10); api.handleSearch(input.value);
    const dateResult = document.querySelector<HTMLElement>(`[data-key="date:${input.value}"]`);
    expect(dateResult).not.toBeNull(); dateResult!.click();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(before));
    expect(ids()).toEqual([]);
    expect(api.state).toMatchObject({ source, filter: { type: 'project', id: project }, search: 'calmer', doc: null });

    held.finish(requests[before].request);
    await vi.waitFor(() => expect(document.querySelector(`[data-entry-id="${target}"]`)?.classList.contains('is-target')).toBe(true));
    expect(ids()).toEqual(records.map(entry => entry.meta.created));
    expect(document.getElementById('source-filter')!.hidden).toBe(false);
    expect(new URLSearchParams(location.search).get('source')).toBe(source);
    expect(api.state.search).toBe('calmer');
  });

  it('rebuilds the source on Retry when its result count changes between pages', async () => {
    const { api, ids, records, requests, excludeFromSource } = await setup(scopedUrl, false, true);
    expect(ids()).toHaveLength(50);
    excludeFromSource(records[59].meta.created);
    await api.loadMoreWeeks(1);
    expect(ids()).toHaveLength(50);
    expect(document.getElementById('query-flow-notice')!.textContent).toContain('changed while loading');
    const before = requests.length;
    document.querySelector<HTMLButtonElement>('#query-flow-notice .history-retry')!.click();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(document.getElementById('query-flow-notice')).toBeNull());
    expect(entryArguments(requests[before].request).offset).toBe(0);
    await api.loadMoreWeeks(1);
    expect(ids()).toEqual(records.slice(0, 59).map(entry => entry.meta.created));
    expect(document.getElementById('query-flow-notice')).toBeNull();
    expect(api.state).toMatchObject({ source, filter: { type: 'project', id: project }, search: 'calmer' });
  });

  it('recounts the same calendar grid after an explicit source recovery', async () => {
    const { api, records, excludeFromSource } = await setup(scopedUrl, false, true);
    const date = records[2].meta.created.slice(0, 10);
    const openCalendar = () => document.getElementById('btn-workspace-calendar')!.click();
    const count = () => document.querySelector<HTMLElement>(`.cal-day[data-date="${date}"]`)?.dataset.count;
    openCalendar();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('.cal-day')?.dataset.count).toBeDefined());
    const input = document.querySelector<HTMLInputElement>('.date-jump-input')!;
    input.value = 'Oct 2026'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(count()).toBe('1'));
    document.getElementById('btn-workspace-popover-close')!.click();

    excludeFromSource(records[2].meta.created);
    await api.loadMoreWeeks(1);
    expect(document.getElementById('query-flow-notice')!.textContent).toContain('changed while loading');
    document.querySelector<HTMLButtonElement>('#query-flow-notice .history-retry')!.click();
    await vi.waitFor(() => expect(document.getElementById('query-flow-notice')).toBeNull());
    openCalendar();
    await vi.waitFor(() => expect(count()).toBe('0'));
    expect(api.state).toMatchObject({ source, filter: { type: 'project', id: project }, search: 'calmer' });
  });

  it('keeps an oversized browsing request recoverable through read-only inspection', async () => {
    const { api, ids } = await setup();
    const search = 'x'.repeat(65_536);
    await api.applyView({ source, filter: { type: 'project', id: project }, search, doc: null });
    expect(ids()).toEqual([]);
    expect(api.state.search).toBe(search);
    expect(document.getElementById('query-flow-notice')!.textContent).toContain('64 KiB');
    document.querySelector<HTMLButtonElement>('#source-filter .filter-pill-label')!.click();
    expect(document.getElementById('workspace-inspection')!.textContent).toContain('64 KiB');
    expect(document.querySelector('.flow-empty')).toBeNull();
  });

  it('canonicalizes a cold source link and preserves its preview session when switching sources', async () => {
    const { api, ids } = await setup(`/work/?mockSession=source-preview&search=%20calmer%20&source=${encodedSource}`, true);
    const initial = new URLSearchParams(location.search);
    expect(initial.getAll('source')).toEqual([source]); expect(initial.getAll('search')).toEqual(['calmer']);
    expect(initial.getAll('mockSession')).toEqual(['source-preview']);
    expect(api.state.source).toBe(source); expect(ids()).toEqual([newest, older]);
    await api.applyView({ source: otherSource, filter: null, search: 'calmer', doc: null });
    expect(ids()).toEqual([older]);
    const changed = new URLSearchParams(location.search);
    expect(changed.getAll('source')).toEqual([otherSource]);
    expect(changed.getAll('mockSession')).toEqual(['source-preview']);
    expect(changed.get('search')).toBe('calmer');
  });

  it('keeps an unavailable source explicit instead of rendering the default flow or an empty result', async () => {
    const missing = '#artifact/2026-10-04-unavailable/decisions.json';
    const { api, ids, requests } = await setup(`/work/?source=${encodeURIComponent(missing)}`);
    expect(api.state.source).toBe(missing); expect(ids()).toEqual([]); expect(requests).toEqual([]);
    expect(document.getElementById('query-flow-notice')!.textContent).toContain('Retry');
    expect(document.getElementById('source-filter')!.hidden).toBe(false);
    expect(document.querySelector('.flow-empty')).toBeNull();
    expect(document.getElementById('scroll-sentinel')!.textContent).not.toBe('The End');
    expect(new URLSearchParams(location.search).get('source')).toBe(missing);
  });

  it.each(['error', 'incomplete'] as const)('keeps %s results recoverable without broadening the source', async mode => {
    const { api, ids, mode: changeMode } = await setup('/work/');
    changeMode(mode);
    await api.applyView({ source, filter: { type: 'project', id: project }, search: 'calmer', doc: null });
    expect(ids()).toEqual([]); expect(api.state.source).toBe(source);
    expect(api.state.search).toBe('calmer'); expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(document.querySelector('.flow-empty')).toBeNull();
    const notice = document.getElementById('query-flow-notice')!;
    expect(notice.textContent).toContain(mode === 'incomplete' ? 'could not be verified' : 'temporarily unavailable');
    const retry = notice.querySelector<HTMLButtonElement>('.history-retry')!;
    retry.focus(); changeMode('normal'); retry.click();
    await vi.waitFor(() => expect(ids()).toEqual([newest]));
    expect(document.getElementById('query-flow-notice')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('[hidden], [inert]')).toBeNull();
  });

  it.each(['source', 'filter'] as const)('cancels a pending query when its %s changes and discards a late response', async change => {
    const { api, ids, requests, holdNextQuery } = await setup(`/work/?source=${encodedSource}`);
    const held = holdNextQuery(), before = requests.length;
    const departing = api.applyView({ source, filter: null, search: 'calmer', doc: null });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(before));
    const stale = requests[before];
    await api.applyView({ source: change === 'source' ? otherSource : source,
      filter: change === 'filter' ? { type: 'project', id: project } : null, search: 'calmer', doc: null });
    await departing;
    expect(stale.signal?.aborted).toBe(true);
    const expected = change === 'source' ? [older] : [newest];
    expect(ids()).toEqual(expected);
    held.finish(stale.request); await Promise.resolve(); await Promise.resolve();
    expect(ids()).toEqual(expected);
    expect(api.state.source).toBe(change === 'source' ? otherSource : source);
    expect(document.getElementById('query-flow-notice')).toBeNull();
  });
});
