// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityRef } from '../lib/types';
import type { RemoteStore } from '../lib/remote-store';
import type { ViewState } from '../src/route';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';
import { stubBrowserFetch } from './auth-fixture';

interface App {
  state: { filter: EntityRef | null; search: string; doc: ViewState['doc']; store: RemoteStore | null; weekStartsOn: number };
  setupNavigationSidebar(): void;
  setupModals(): void;
  setupDateTimeSettings(): void;
  applyAnimSpeed(): void;
  connectToInstance(id: string): Promise<void>;
  applyView(view: ViewState): Promise<void>;
  clearInstanceView(): void;
  navigationSidebar?: { dispose(): void; layout(): void; closePopover(): void; openSearch(): void };
  datePicker: { close(): void; refresh(options?: { invalidateCounts?: boolean }): void; dispose?(): void };
  stopControl?: () => void;
}

const project = '2026-10-04-program';
const otherProject = '2026-10-02-other';
const initialRoute = `/work/project/${project}?search=calmer`;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let app: App | undefined;
let restoreFrameNavigation: (() => void) | undefined;

afterEach(() => {
  app?.stopControl?.(); app?.datePicker.close(); app?.clearInstanceView(); app?.navigationSidebar?.dispose(); app?.datePicker.dispose?.();
  app = undefined;
  restoreFrameNavigation?.(); restoreFrameNavigation = undefined;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

async function setup(initialWidth = 1920) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T12:00:00'));
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  history.replaceState(null, '', initialRoute);
  localStorage.setItem('animSpeed', '0');
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const navigation = (window as unknown as { happyDOM: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM.settings.navigation;
  const previousNavigation = navigation.disableChildFrameNavigation;
  navigation.disableChildFrameNavigation = true;
  restoreFrameNavigation = () => { navigation.disableChildFrameNavigation = previousNavigation; };

  let width = initialWidth;
  const frame = element('workspace-frame');
  vi.spyOn(frame, 'clientWidth', 'get').mockImplementation(() => frame.dataset.reader === 'html' ? width : Math.min(1920, width));
  vi.spyOn(frame, 'clientHeight', 'get').mockReturnValue(900);
  vi.spyOn(document.body, 'clientWidth', 'get').mockImplementation(() => width);
  for (const id of ['flow-scroll', 'doc-body']) vi.spyOn(element(id), 'clientWidth', 'get').mockImplementation(() => frame.clientWidth);

  stubBrowserFetch(url => {
    if (url === '/-/api/instances/work') return Response.json({ id: 'work', name: 'Work', path: '/fixture/work' });
    if (url === '/-/api/instances/work/files/assets/dashboard.html') return new Response('<h1>Release dashboard</h1>', { headers: { 'Content-Type': 'text/html', ETag: 'dashboard-v1' } });
    if (url !== '/-/api/instances/work/data') return new Response('', { status: 404 });
    const data = snapshotFixture('work', 'A calmer release note.');
    data.weeks[0][1][0].meta.projects = [project];
    data.indexes.notes.push({ id: '2026-10-03T09:00', description: 'Earlier calmer note' }, { id: '2026-10-02T08:00', description: 'Another project' });
    data.weeks[0][1].push(
      { meta: { created: '2026-10-03T09:00', projects: [project] }, content: 'A calmer earlier note.', weekFile: '2026-09-28' },
      { meta: { created: '2026-10-02T08:00', projects: [otherProject] }, content: 'A calmer note in another project.', weekFile: '2026-09-28' },
    );
    data.indexes.projects.push({ id: otherProject, description: 'Other project' });
    data.projects.push([otherProject, { frontMatter: { name: 'Other program', created: '2026-10-02T08:00' }, body: 'A different project body.' }]);
    data.relations.entriesByEntity.push([`#project/${project}`, ['2026-10-04T10:00', '2026-10-03T09:00']], [`#project/${otherProject}`, ['2026-10-02T08:00']]);
    data.weeksByEntity.push([`#project/${project}`, ['2026-09-28']], [`#project/${otherProject}`, ['2026-09-28']]);
    return Response.json(data);
  });

  app = await loadApp<App>('state, setupNavigationSidebar, setupModals, setupDateTimeSettings, applyAnimSpeed, connectToInstance, applyView, clearInstanceView, stopControl, navigationSidebar, datePicker');
  app.applyAnimSpeed(); app.setupModals(); app.setupNavigationSidebar(); app.setupDateTimeSettings();
  await app.connectToInstance('work');
  await vi.waitFor(() => expect(document.querySelector('#timeline-calendar-inline .cal-day')).not.toBeNull());
  return { api: app, resize(next: number) { width = next; app!.navigationSidebar!.layout(); } };
}

function selectWeekStart(value: string): void {
  const select = element<HTMLSelectElement>('setting-week-start');
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

function expectRetainedFilters(): void {
  expect(element('filter-pill').hidden).toBe(false);
  expect(element('filter-pill').querySelector<HTMLElement>('[data-ref-id]')?.dataset.refId).toBe(project);
  expect(element('flow-search').hidden).toBe(false);
  expect(element('btn-edit-flow-search').textContent).toBe('“calmer”');
}

describe('calendar application navigation', () => {
  it('persists week-start changes and rearranges the live calendar without changing the flow', async () => {
    const { api } = await setup();
    expect(api.state.weekStartsOn).toBe(1);
    for (const day of [0, 6, 3]) {
      selectWeekStart(String(day));
      expect(api.state.weekStartsOn).toBe(day);
      expect(localStorage.getItem('weekStartsOn')).toBe(String(day));
      const first = document.querySelector<HTMLElement>('#timeline-calendar-inline .cal-day')!.dataset.date!;
      expect(new Date(`${first}T12:00:00`).getDay()).toBe(day);
      expect(api.state.filter).toEqual({ type: 'project', id: project });
      expect(api.state.search).toBe('calmer');
    }
    const reloaded = await loadApp<Pick<App, 'state' | 'setupDateTimeSettings'>>('state, setupDateTimeSettings');
    reloaded.setupDateTimeSettings();
    expect(reloaded.state.weekStartsOn).toBe(3);
    expect(element<HTMLSelectElement>('setting-week-start').value).toBe('3');
  });

  it('moves the same calendar and filters between the expanded sidebar and the pill controls', async () => {
    const { resize } = await setup();
    const controls = element('workspace-timeline-controls'), calendar = element('timeline-calendar-inline');
    expect(element('navigation-sidebar-host').hidden).toBe(false);
    expect(element('navigation-sidebar-host').contains(controls)).toBe(true);
    expect(controls.contains(element('workspace-filter-group'))).toBe(true);
    expectRetainedFilters();
    resize(1120);
    expect(element('control-pill').hidden).toBe(false);
    element('btn-workspace-calendar').click();
    expect(element('workspace-popover').dataset.page).toBe('calendar');
    expect(element('workspace-popover-body').contains(controls)).toBe(true);
    expect(controls.contains(calendar)).toBe(true);
    expectRetainedFilters();
    app!.navigationSidebar!.closePopover(); resize(1920);
    expect(element('navigation-sidebar-host').contains(controls)).toBe(true);
    expect(element('timeline-calendar-inline')).toBe(calendar);
    expect(document.querySelectorAll('#timeline-calendar-inline')).toHaveLength(1);
  });

  it('resumes calendar activity after a refresh while the sidebar is inert behind search', async () => {
    const { api } = await setup();
    const day = () => document.querySelector<HTMLElement>('#timeline-calendar-inline .cal-day[data-date="2026-10-03"]')!;
    await vi.waitFor(() => expect(day().dataset.count).toBe('1'));
    api.navigationSidebar!.openSearch();
    expect(element('navigation-sidebar-host').inert).toBe(true);
    api.datePicker.refresh({ invalidateCounts: true });
    expect(day().hasAttribute('data-count')).toBe(false);
    api.navigationSidebar!.closePopover();
    expect(element('navigation-sidebar-host').inert).toBe(false);
    await vi.waitFor(() => expect(day().dataset.count).toBe('1'));
  });

  it('retains the previous timeline while reading another project and restores it on a calendar day jump', async () => {
    const { api } = await setup();
    await api.applyView({ filter: { type: 'project', id: otherProject }, search: '', doc: { kind: 'detail' } });
    expect(api.state.filter).toEqual({ type: 'project', id: otherProject });
    expect(element('doc-backdrop').hidden).toBe(false);
    expectRetainedFilters();
    const next = document.querySelector<HTMLButtonElement>('#timeline-calendar-inline .cal-nav[aria-label="Next month"]')!;
    next.click();
    expect(api.state.doc).toEqual({ kind: 'detail' });
    expect(api.state.filter).toEqual({ type: 'project', id: otherProject });
    document.querySelector<HTMLButtonElement>('#timeline-calendar-inline .cal-nav[aria-label="Previous month"]')!.click();
    document.querySelector<HTMLButtonElement>('#timeline-calendar-inline .cal-day[data-date="2026-10-03"]')!.click();
    await vi.waitFor(() => expect(api.state.doc).toBeNull());
    await vi.waitFor(() => expect(document.querySelector('.is-target')?.getAttribute('data-entry-id')).toBe('2026-10-03T09:00'));
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(api.state.search).toBe('calmer');
    expect(element('doc-backdrop').hidden).toBe(true);
  });

  it('retains timeline controls in the pill over full-page HTML and returns to that flow with Today', async () => {
    const { api } = await setup();
    await api.applyView({ filter: null, search: '', doc: { kind: 'asset', path: 'assets/dashboard.html' } });
    expect(element('workspace-frame').dataset.reader).toBe('html');
    expect(element('navigation-sidebar-host').hidden).toBe(true);
    expect(element('control-pill').hidden).toBe(false);
    element('btn-workspace-calendar').click();
    expect(element('workspace-popover').dataset.page).toBe('calendar');
    expect(element('workspace-popover-body').contains(element('workspace-timeline-controls'))).toBe(true);
    expectRetainedFilters();
    document.querySelector<HTMLButtonElement>('#timeline-calendar-inline .cal-today')!.click();
    await vi.waitFor(() => expect(api.state.doc).toBeNull());
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(api.state.search).toBe('calmer');
    expect(element('workspace-popover').hidden).toBe(true);
    expect(element('workspace-frame').dataset.reader).toBe('flow');
  });
});
