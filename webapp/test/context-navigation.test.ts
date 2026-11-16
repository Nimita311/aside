// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityRef } from '../lib/types';
import type { RemoteStore } from '../lib/remote-store';
import type { ViewState } from '../src/route';
import type { DateReference } from '../src/date-reference';
import type { createContextPanel } from '../src/context-panel';
import type { RenderOptions } from '../src/render';
import type { HotSet, PendingUpdate } from '../../cli/src/core/data-snapshot';
import { usable } from '../src/modal';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';
import { stubBrowserFetch } from './connection-fixture';

interface App {
  state: { filter: EntityRef | null; search: string; source?: string; doc: ViewState['doc']; store: RemoteStore | null };
  setupContextPanel(): void;
  setupNavigationSidebar(): void;
  setupModals(): void;
  applyAnimSpeed(): void;
  connectToInstance(id: string): Promise<void>;
  clearInstanceView(): void;
  currentHotSet(): HotSet;
  applyDataUpdate(update: PendingUpdate): Promise<void>;
  showConfigModal(): void;
  hideConfigModal(): void;
  getRenderOpts(): RenderOptions;
  refreshDisplay(root: ParentNode, opts: RenderOptions): void;
  inspectContext(target: { ref: EntityRef | null; doc: ViewState['doc']; date?: DateReference }): Promise<void>;
  contextPanel?: ReturnType<typeof createContextPanel>;
  navigationSidebar?: { dispose(): void; layout(): void; openSearch(): void; closePopover(): void };
  stopControl?: () => void;
  datePicker: { dispose?(): void };
}

const project = '2026-10-04-program', action = '2026-10-04-task', otherProject = '2026-10-03-other';
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let app: App | undefined;
afterEach(() => {
  app?.stopControl?.(); app?.hideConfigModal(); app?.clearInstanceView();
  app?.navigationSidebar?.dispose(); app?.contextPanel?.destroy(); app?.datePicker.dispose?.(); app = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

async function setup(initialWidth = 1600) {
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  history.replaceState(null, '', '/work/'); localStorage.setItem('animSpeed', '0');
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let width = initialWidth, renamed = false;
  const frame = element('workspace-frame'), flow = element('flow');
  vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
  vi.spyOn(frame, 'clientWidth', 'get').mockImplementation(() => frame.dataset.reader === 'html' ? width : Math.min(1920, width));
  vi.spyOn(frame, 'clientHeight', 'get').mockReturnValue(900);
  vi.spyOn(document.body, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(frame, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, frame.clientWidth, 900));
  vi.spyOn(flow, 'getBoundingClientRect').mockImplementation(() => {
    const flowWidth = Math.min(960, frame.clientWidth);
    return new DOMRect((frame.clientWidth - flowWidth) / 2, 0, flowWidth, 900);
  });
  for (const id of ['flow-scroll', 'doc-body']) vi.spyOn(element(id), 'clientWidth', 'get').mockImplementation(() => frame.clientWidth);
  stubBrowserFetch(url => {
    const match = /^\/-\/api\/instances\/(work|personal)(\/data)?(?:\?refresh=1)?$/.exec(url);
    if (!match) return new Response('', { status: 404 });
    const id = match[1];
    if (!match[2]) return Response.json({ id, name: id, path: `/fixture/${id}` });
    const data = snapshotFixture(id, `Review #action/${action} before launch.`);
    if (renamed) data.projects[0][1].frontMatter.name = 'Renamed program';
    data.weeks[0][1][0].meta.projects = [project];
    data.projects[0][1].body = `The project body links to #action/${action}.\n\nA second paragraph preserves the reader's place.`;
    data.actions[0][1].body = `The action depends on #project/${otherProject}.`;
    data.indexes.projects.push({ id: otherProject, description: 'Related program' });
    data.projects.push([otherProject, { frontMatter: { name: 'Other program', created: '2026-10-03T09:00' }, body: 'Other project body.' }]);
    data.relations.entriesByEntity.push([`#project/${project}`, ['2026-10-04T10:00']], [`#action/${action}`, ['2026-10-04T10:00']]);
    data.relations.actionsByProject.push([project, [action]]);
    data.relations.projectsByAction.push([action, [project]]);
    data.weeksByEntity.push([`#project/${project}`, ['2026-09-28']], [`#action/${action}`, ['2026-09-28']]);
    return Response.json(data);
  });
  app = await loadApp<App>('state, setupContextPanel, setupNavigationSidebar, setupModals, applyAnimSpeed, connectToInstance, clearInstanceView, currentHotSet, applyDataUpdate, showConfigModal, hideConfigModal, getRenderOpts, refreshDisplay, inspectContext, contextPanel, navigationSidebar, stopControl, datePicker');
  app.applyAnimSpeed(); app.setupContextPanel(); app.setupModals(); app.setupNavigationSidebar();
  await app.connectToInstance('work');
  await vi.waitFor(() => expect(document.querySelector('#flow .tag-project')).not.toBeNull());
  return { api: app, rename() { renamed = true; }, resize(next: number) { width = next; app!.navigationSidebar!.layout(); } };
}

function timelineProject(): HTMLElement { return document.querySelector<HTMLElement>(`#flow .tag-project[data-ref-id="${project}"]`)!; }
function title(): string | null { return document.querySelector('#side-panel-body .entity-title')?.textContent ?? null; }

describe('context panel application navigation', () => {
  it('keeps Context open when its compact Summary launcher is parked during the click', async () => {
    const { api } = await setup(1120);
    await vi.waitFor(() => expect(element('btn-workspace-summary').hidden).toBe(false));
    api.contextPanel!.close({ animate: false });
    element<HTMLButtonElement>('btn-pill-more').click();
    expect(element('workspace-popover').hidden).toBe(false);
    const launcher = element<HTMLButtonElement>('btn-workspace-summary');
    launcher.click();
    expect(element('workspace-parking').contains(launcher)).toBe(true);
    expect(element('workspace-popover').hidden).toBe(true);
    expect(api.contextPanel!.getState().open).toBe(true);
    expect(element('side-panel').hidden).toBe(false);
  });

  it('formats inspected named-zone dates locally and counts their local calendar day', async () => {
    const previousZone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      localStorage.setItem('timeFormat', '24h');
      const { api } = await setup(1120);
      const start = '2026-10-05T02:00[Asia/Tokyo]';
      await api.inspectContext({ ref: null, doc: null, date: { start } });
      const header = document.querySelector<HTMLElement>('.context-essentials')!;
      expect(header.querySelector('.entity-title')?.textContent).toBe('Oct 4, 2026, 10:00');
      expect(header.textContent).not.toContain('[Asia/Tokyo]');
      await vi.waitFor(() => expect(header.querySelector('[data-count-kind="entries"] .stat-count')?.textContent).toBe('1'));
      api.refreshDisplay(header, { ...api.getRenderOpts(), timeFormat: '12h', dateFormat: 'iso' });
      expect(header.querySelector('.entity-title')?.textContent).toBe('2026-10-04 10:00 AM');

      await api.inspectContext({ ref: null, doc: null, date: { start, end: '2026-10-05T02:30[Asia/Tokyo]' } });
      expect(document.querySelector('.context-essentials .entity-title')?.textContent).toBe('Oct 4, 2026, 10:00 – Oct 4, 2026, 10:30');
      await vi.waitFor(() => expect(document.querySelector('.context-essentials [data-count-kind="entries"] .stat-count')?.textContent).toBe('1'));
    } finally {
      if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
    }
  });

  it('cancels deferred date counting on target changes and dismissal without stale counts or warnings', async () => {
    const { api } = await setup(1120);
    const store = api.state.store!;
    const weeks = vi.spyOn(store, 'getWeekEntries');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let complete!: (value: boolean) => void;
    const coverage = vi.spyOn(store, 'loadAllWeeks').mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await api.inspectContext({ ref: null, doc: null, date: { start: '2026-10-04' } });
    const oldHeader = document.querySelector('.context-essentials')!;
    await api.inspectContext({ ref: { type: 'project', id: project }, doc: null });
    const reads = weeks.mock.calls.length;
    complete(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(weeks).toHaveBeenCalledTimes(reads);
    expect(oldHeader.querySelector('.summary-facts')).toBeNull();
    expect(document.querySelector('.context-essentials')?.getAttribute('data-kind')).toBe('project');

    coverage.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await api.inspectContext({ ref: null, doc: null, date: { start: '2026-10-05' } });
    const dismissedHeader = document.querySelector('.context-essentials')!;
    api.contextPanel!.close({ animate: false });
    complete(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dismissedHeader.querySelector('.summary-facts')).toBeNull();
    expect(warning).not.toHaveBeenCalled();
    api.contextPanel!.open();
    await vi.waitFor(() => expect(dismissedHeader.querySelector('[data-count-kind="entries"] .stat-count')?.textContent).toBe('0'));
    expect(document.querySelector('.context-essentials')).toBe(dismissedHeader);
  });

  it('does not start a query collector after a pending source read is cancelled', async () => {
    const { api } = await setup(1120);
    const store = api.state.store!;
    api.state.source = '#artifact/2026-10-04-query/source.json';
    vi.spyOn(store, 'getArtifact').mockResolvedValue({ frontMatter: { name: 'Query', created: '2026-10-04', attachments: ['source.json'] }, body: '' });
    let complete!: (value: string) => void;
    const read = vi.spyOn(store, 'getAsset').mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const fetch = vi.spyOn(globalThis, 'fetch');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await api.inspectContext({ ref: null, doc: null, date: { start: '2026-10-04' } });
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const header = document.querySelector('.context-essentials')!;
    api.contextPanel!.close({ animate: false });
    complete(JSON.stringify({ query: '{ entries { nodes { id } totalCount offset count } }' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/graphql'))).toEqual([]);
    expect(header.querySelector('.summary-facts')).toBeNull();
    expect(warning).not.toHaveBeenCalled();
  });

  it('adds complete date counts without blocking identity or losing the retained timeline selection', async () => {
    const { api } = await setup(1120);
    api.state.filter = { type: 'project', id: project };
    api.state.search = 'Review';
    let complete!: (value: boolean) => void;
    const coverage = vi.spyOn(api.state.store!, 'loadAllWeeks').mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await api.inspectContext({ ref: null, doc: null, date: { start: '2026-10-04' } });
    const header = document.querySelector<HTMLElement>('.context-essentials')!;
    const heading = header.querySelector('.entity-title');
    expect(header.dataset.kind).toBe('date');
    expect(header.querySelector('.summary-facts')).toBeNull();
    complete(true);
    await vi.waitFor(() => expect(header.querySelector('[data-count-kind="entries"] .stat-count')?.textContent).toBe('1'));
    expect(header.querySelector('.entity-title')).toBe(heading);

    await api.inspectContext({ ref: null, doc: null, date: { start: '2026-10-04T09:00', end: '2026-10-04T09:59' } });
    await vi.waitFor(() => expect(document.querySelector('.context-essentials [data-count-kind="entries"] .stat-count')?.textContent).toBe('0'));
    expect(document.querySelector('.context-essentials')?.getAttribute('data-kind')).toBe('date-range');

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    coverage.mockResolvedValueOnce(false);
    await api.inspectContext({ ref: null, doc: null, date: { start: '2026-10-05' } });
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(document.querySelector('.context-essentials .entity-title')?.textContent).toContain('Oct 5');
    expect(document.querySelector('.context-essentials .summary-facts')).toBeNull();
  });

  it('inspects a timeline pill first, then toggles its entry filter on subsequent clicks', async () => {
    const { api } = await setup(1120);
    expect(api.contextPanel!.getState().open).toBe(false);
    timelineProject().click();
    await vi.waitFor(() => expect(title()).toBe('Good program'));
    expect(api.contextPanel!.getState()).toMatchObject({ open: true, mode: 'summary' });
    expect(api.state.filter).toBeNull(); expect(location.pathname).toBe('/work/');
    const previous = element('side-panel-body').firstElementChild;
    timelineProject().click();
    await vi.waitFor(() => expect(api.state.filter).toEqual({ type: 'project', id: project }));
    await vi.waitFor(() => expect(document.querySelector('#scroll-sentinel')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector('.context-timeline-toggle')?.getAttribute('aria-pressed')).toBe('true'));
    expect(element('side-panel-body').firstElementChild).toBe(previous);
    expect(api.contextPanel!.getState().open).toBe(true);
    const filtered = element('side-panel-body').firstElementChild;
    timelineProject().click();
    await vi.waitFor(() => expect(api.state.filter).toBeNull());
    await vi.waitFor(() => expect(document.querySelector('.context-timeline-toggle')?.getAttribute('aria-pressed')).toBe('false'));
    expect(element('side-panel-body').firstElementChild).toBe(filtered);
    expect(api.contextPanel!.getState().mode).toBe('summary');
  });

  it('filters from one stable top control without putting commands in Essentials or the scrolling content', async () => {
    const { api } = await setup(1120);
    timelineProject().click();
    await vi.waitFor(() => expect(title()).toBe('Good program'));
    const command = element('btn-context-timeline');
    expect(command.parentElement).toBe(element('side-panel'));
    expect(element('side-panel-body').contains(command)).toBe(false);
    expect(element('side-panel-body').querySelector('.context-timeline-toggle')).toBeNull();
    expect(command.getAttribute('aria-label')).toBe('Filter timeline');
    expect(command.getAttribute('aria-pressed')).toBe('false');

    command.click();
    await vi.waitFor(() => expect(api.state.filter).toEqual({ type: 'project', id: project }));
    await vi.waitFor(() => expect(command.getAttribute('aria-pressed')).toBe('true'));
    expect(element('btn-context-timeline')).toBe(command);
    command.click();
    await vi.waitFor(() => expect(api.state.filter).toBeNull());
    await vi.waitFor(() => expect(command.getAttribute('aria-pressed')).toBe('false'));
  });

  it('retains expanded mode and scroll through body references and panel Back/Forward', async () => {
    const { api } = await setup(1120);
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    element('btn-context-expand').click();
    element('btn-context-content').click();
    const body = element('side-panel-body'); body.scrollTop = 117;
    const reference = body.querySelector<HTMLElement>(`.inline-tag-action[data-ref-id="${action}"]`)!;
    expect(reference).not.toBeNull(); reference.click();
    await vi.waitFor(() => expect(title()).toBe('Good task'));
    expect(api.contextPanel!.getState().mode).toBe('expanded'); expect(api.state.filter).toBeNull();
    element('btn-context-overview').click();
    body.scrollTop = 83;
    element('btn-context-back').click();
    await vi.waitFor(() => expect(title()).toBe('Good program'));
    expect(body.scrollTop).toBe(117); expect(api.contextPanel!.getState().mode).toBe('expanded');
    expect(api.contextPanel!.getState().view).toBe('content');
    expect(element('btn-context-content').getAttribute('aria-selected')).toBe('true');
    element('btn-context-forward').click();
    await vi.waitFor(() => expect(title()).toBe('Good task'));
    expect(body.scrollTop).toBe(83);
    expect(api.contextPanel!.getState().view).toBe('overview');
    expect(element('btn-context-overview').getAttribute('aria-selected')).toBe('true');
    expect(element<HTMLButtonElement>('btn-context-forward').disabled).toBe(true);
  });

  it('retracts automatically on narrow layouts while explicit inspection remains available', async () => {
    const { api, resize } = await setup();
    await vi.waitFor(() => expect(api.contextPanel!.getState().open).toBe(true));
    resize(1120); expect(api.contextPanel!.getState().open).toBe(false);
    expect(element('control-pill').hidden).toBe(false);
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    expect(api.contextPanel!.getState().open).toBe(true);
    element('flow-scroll').click(); expect(api.contextPanel!.getState().open).toBe(false);
    resize(1600); expect(api.contextPanel!.getState().open).toBe(false);
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    expect(element('navigation-sidebar-host').hidden).toBe(false);
  });

  it('keeps fullscreen background inaccessible and restores interaction after controls and settings', async () => {
    const { api } = await setup();
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    element('btn-context-expand').click(); element('btn-context-fullscreen').click();
    expect(api.contextPanel!.getState().fullscreen).toBe(true);
    expect(element('navigation-sidebar-host').hidden).toBe(true);
    expect(element('flow-scroll').inert).toBe(true);
    expect(usable(timelineProject())).toBe(false);
    api.navigationSidebar!.openSearch();
    expect(element('side-panel').inert).toBe(true);
    api.navigationSidebar!.closePopover();
    expect(element('side-panel').inert).toBe(false);
    expect(element('flow-scroll').inert).toBe(true);
    api.showConfigModal(); expect(element<HTMLDialogElement>('modal-backdrop').open).toBe(true);
    api.hideConfigModal(); expect(element<HTMLDialogElement>('modal-backdrop').open).toBe(false);
    element('btn-context-fullscreen').click();
    expect(api.contextPanel!.getState().fullscreen).toBe(false);
    expect(element('flow-scroll').inert).toBe(false);
  });

  it('resets inspected context and its navigation history when switching instances', async () => {
    const { api } = await setup();
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    element('btn-context-expand').click();
    element('btn-context-content').click();
    element('side-panel-body').querySelector<HTMLElement>(`.inline-tag-action[data-ref-id="${action}"]`)!.click();
    await vi.waitFor(() => expect(title()).toBe('Good task'));
    expect(element<HTMLButtonElement>('btn-context-back').disabled).toBe(false);
    await api.connectToInstance('personal');
    await vi.waitFor(() => expect(title()).toBe('personal'));
    expect(element<HTMLButtonElement>('btn-context-back').disabled).toBe(true);
    expect(element<HTMLButtonElement>('btn-context-forward').disabled).toBe(true);
    expect(api.state.filter).toBeNull();
    expect(element('workspace-pill-label').textContent).toBe('personal');
  });

  it('refreshes an inspected record through the real store while retaining expanded mode and scroll', async () => {
    const { api, rename } = await setup();
    timelineProject().click(); await vi.waitFor(() => expect(title()).toBe('Good program'));
    element('btn-context-expand').click(); element('side-panel-body').scrollTop = 74;
    const hot = api.currentHotSet();
    expect(hot.entities).toContainEqual({ kind: 'project', id: project });
    rename();
    const update = await api.state.store!.check('light', hot);
    expect(update?.summary.entities.has(`#project/${project}`)).toBe(true);
    await api.applyDataUpdate(update!);
    expect(title()).toBe('Renamed program');
    expect(api.contextPanel!.getState()).toMatchObject({ open: true, mode: 'expanded' });
    expect(element('side-panel-body').scrollTop).toBe(74);
    expect(api.state.filter).toBeNull();
  });
});
