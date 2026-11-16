// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteStore } from '../lib/remote-store';
import type { EntityRef } from '../lib/types';
import type { ViewState } from '../src/route';
import type { createContextPanel } from '../src/context-panel';
import type { HotSet, PendingUpdate } from '../../cli/src/core/data-snapshot';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';
import { stubBrowserFetch } from './connection-fixture';

const project = '2026-10-04-program', action = '2026-10-04-task';
const sourceId = '2026-10-04-review', source = `#artifact/${sourceId}/flow.json`;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
interface App {
  state: { filter: EntityRef | null; doc: ViewState['doc']; store: RemoteStore };
  setupContextPanel(): void; setupNavigationSidebar(): void; setupModals(): void; applyAnimSpeed(): void;
  connectToInstance(id: string): Promise<void>; clearInstanceView(): void;
  applyView(view: ViewState): Promise<void>;
  navigateDate(date: { start: string }): Promise<void>;
  toggleContextFilter(ref: EntityRef): Promise<void>;
  applyDataUpdate(update: PendingUpdate): Promise<void>;
  currentHotSet(): HotSet;
  workspaceView(): ViewState;
  setupSearch(): void;
  handleSearch(query: string): Promise<void>;
  currentContext(): {ref: EntityRef | null; doc: ViewState['doc']};
  contextPanel?: ReturnType<typeof createContextPanel>;
  navigationSidebar?: { dispose(): void };
  stopControl?: () => void;
  datePicker: { dispose?(): void };
}
let app: App | undefined;
let authoredProjectBody: string;
afterEach(() => {
  app?.stopControl?.(); app?.clearInstanceView();
  app?.navigationSidebar?.dispose(); app?.contextPanel?.destroy(); app?.datePicker.dispose?.(); app = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

async function setup() {
  authoredProjectBody = `The project body links to #action/${action}.`;
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  history.replaceState(null, '', '/work/'); localStorage.setItem('animSpeed', '0');
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const frame = element('workspace-frame'), flow = element('flow');
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1600);
  vi.spyOn(frame, 'clientWidth', 'get').mockReturnValue(1600);
  vi.spyOn(frame, 'clientHeight', 'get').mockReturnValue(900);
  vi.spyOn(document.body, 'clientWidth', 'get').mockReturnValue(1600);
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1600, 900));
  vi.spyOn(flow, 'getBoundingClientRect').mockReturnValue(new DOMRect(320, 0, 960, 900));
  for (const id of ['flow-scroll', 'doc-body']) vi.spyOn(element(id), 'clientWidth', 'get').mockReturnValue(1600);
  stubBrowserFetch(url => {
    if (url === '/-/api/instances/work') return Response.json({ id: 'work', name: 'Work', path: '/fixture/work' });
    if (url === `/-/api/instances/work/files/artifacts/2026/${sourceId}/flow.json`) return Response.json({ query: '{ entries { nodes { id } offset count totalCount } }' });
    if (url === '/-/api/instances/work/graphql') return Response.json({ data: { entries: {
      nodes: [{ id: '2026-10-04T10:00' }], offset: 0, count: 1, totalCount: 1,
    } }, extensions: { complete: true } });
    if (url !== '/-/api/instances/work/data' && url !== '/-/api/instances/work/data?refresh=1') return new Response('', { status: 404 });
    const data = snapshotFixture('work', `Review #action/${action}.`);
    data.instance!.manifest.config = { webapp: { sidebar: [{ items: [{ label: 'Project body', entity: `#project/${project}` }] }] } };
    data.weeks[0][1][0].meta.projects = [project];
    data.projects[0][1].body = authoredProjectBody;
    data.actions[0][1].body = 'The action body.';
    data.indexes.artifacts.push({ id: sourceId, description: 'An agent-owned flow' });
    data.artifacts.push([sourceId, { frontMatter: { name: 'Review flow', created: '2026-10-04T09:00', attachments: ['flow.json'] }, body: '' }]);
    data.relations.entriesByEntity.push([`#project/${project}`, ['2026-10-04T10:00']], [`#action/${action}`, ['2026-10-04T10:00']]);
    data.relations.actionsByProject.push([project, [action]]);
    data.relations.projectsByAction.push([action, [project]]);
    data.weeksByEntity.push([`#project/${project}`, ['2026-09-28']], [`#action/${action}`, ['2026-09-28']]);
    return Response.json(data);
  });
  app = await loadApp<App>('state, setupContextPanel, setupNavigationSidebar, setupModals, applyAnimSpeed, connectToInstance, clearInstanceView, applyView, navigateDate, toggleContextFilter, applyDataUpdate, currentHotSet, workspaceView, setupSearch, handleSearch, currentContext, contextPanel, navigationSidebar, stopControl, datePicker');
  app.applyAnimSpeed(); app.setupContextPanel(); app.setupModals(); app.setupNavigationSidebar();
  await app.connectToInstance('work');
  await vi.waitFor(() => expect(document.querySelector('#flow .tag-project')).not.toBeNull());
  return app;
}
const title = () => document.querySelector('#side-panel-body .entity-title')?.textContent;
const timelineProject = () => document.querySelector<HTMLElement>(`#flow .tag-project[data-ref-id="${project}"]`)!;

describe('context navigation review regressions', () => {
  it('returns from inspected expanded content when Entries is selected', async () => {
    const api = await setup();
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    element('btn-context-expand').click();
    element('btn-context-content').click();
    element('nav-entries').click();
    await vi.waitFor(() => expect(api.contextPanel!.getState().open).toBe(false));
  });

  it('marks the entity shortcut active when that entity is opened from the sidebar', async () => {
    const api = await setup();
    document.querySelector<HTMLElement>('#workspace-sections a')!.click();
    await vi.waitFor(() => expect(title()).toBe('Good program'));
    element('btn-context-expand').click();
    expect(api.state.filter).toBeNull();
    expect(document.querySelector('#workspace-sections a')!.getAttribute('aria-current')).toBe('page');
    expect(element('btn-workspace-pin').textContent).toBe('Unpin this view');
    expect(api.workspaceView()).toEqual({ filter: { type: 'project', id: project }, doc: { kind: 'detail' } });
  });

  it('keeps a newly inspected action when the old direct-route project refreshes', async () => {
    const api = await setup();
    await api.applyView({ filter: { type: 'project', id: project }, doc: { kind: 'detail' } });
    await vi.waitFor(() => expect(title()).toBe('Good program'));
    element('btn-context-expand').click();
    element('btn-context-content').click();
    element('side-panel-body').querySelector<HTMLElement>(`.inline-tag-action[data-ref-id="${action}"]`)!.click();
    await vi.waitFor(() => expect(title()).toBe('Good task'));
    await api.applyDataUpdate({
      apply() {},
      summary: { weeks: new Set(), entities: new Set([`#project/${project}`]), assets: new Set(), indexesChanged: false },
    } as PendingUpdate);
    expect(title()).toBe('Good task');
    expect(api.currentContext().ref).toEqual({ type: 'action', id: action });
  });

  it('does not dismiss a newer inspection when an earlier date jump finishes', async () => {
    const api = await setup();
    const jumping = api.navigateDate({ start: '2026-10-04' });
    timelineProject().click();
    await jumping;
    await vi.waitFor(() => expect(title()).toBe('Good program'));
    expect(api.contextPanel!.getState().open).toBe(true);
  });

  it('does not reopen a panel the user dismissed while a filter navigation was pending', async () => {
    const api = await setup();
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    const filtering = api.toggleContextFilter({ type: 'project', id: project });
    element('flow-scroll').click();
    expect(api.contextPanel!.getState().open).toBe(false);
    await filtering;
    expect(api.contextPanel!.getState().open).toBe(false);
  });

  it.each(['range', 'source', 'order'] as const)('keeps the rendered context in sync when only the %s changes', async change => {
    const api = await setup();
    if (change === 'order') await api.applyView({ filter: null, doc: null, source });
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    element('btn-context-expand').click();
    await api.applyView({ filter: null, doc: null,
      ...(change === 'range' ? { range: { start: '2026-10-01', end: '2026-10-05' } } : { source }),
      ...(change === 'order' ? { order: 'CREATED_ASC' } : {}),
    });
    expect(api.currentContext()).toEqual({ ref: null, doc: null });
    expect(title()).toBe('work');
  });

  it('hands a direct body route to the panel and enables flow search after dismissal', async () => {
    const api = await setup();
    await api.applyView({ filter: { type: 'project', id: project }, doc: { kind: 'detail' } });
    expect(title()).toBe('Good program');
    expect(api.state.doc).toBeNull();
    expect(location.pathname).toBe(`/work/project/${project}/detail`);
    element('btn-side-panel-close').click();
    expect(api.contextPanel!.getState().open).toBe(false);
    expect(location.pathname).toBe(`/work/project/${project}`);
    api.setupSearch();
    await api.handleSearch('review');
    expect(document.querySelector('.search-flow-option')?.textContent).toContain('Search this flow');
  });

  it('retains the expanded body on unrelated updates and replaces it when its authored record changes', async () => {
    const api = await setup();
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    element('btn-context-expand').click();
    element('btn-context-content').click();
    const body = document.querySelector('#side-panel-body .detail-body');
    expect(body).not.toBeNull();
    await api.applyDataUpdate({
      apply() {},
      summary: { weeks: new Set(), entities: new Set([`#action/${action}`]), assets: new Set(), indexesChanged: false },
    } as PendingUpdate);
    expect(document.querySelector('#side-panel-body .detail-body')).toBe(body);
    authoredProjectBody = 'The authored project body changed while reading.';
    const update = await api.state.store.check('light', api.currentHotSet());
    expect(update?.summary.entities.has(`#project/${project}`)).toBe(true);
    await api.applyDataUpdate(update!);
    const replacement = document.querySelector('#side-panel-body .detail-body');
    expect(replacement).not.toBe(body);
    expect(replacement?.textContent).toContain('The authored project body changed');
    expect(api.contextPanel!.getState()).toMatchObject({ open: true, mode: 'expanded' });
    expect(api.contextPanel!.getState().view).toBe('content');
  });
});
