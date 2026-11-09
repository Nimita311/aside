// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityRef } from '../lib/types';
import type { DocRef } from '../src/route';
import type { RemoteStore } from '../lib/remote-store';
import { snapshotFlow } from '../src/flip';
import type { WebappSidebarSection } from '../../cli/src/core/types';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';
import { stubBrowserFetch } from './auth-fixture';

interface App {
  state: { filter: EntityRef | null; search: string; doc: DocRef | null; store: RemoteStore | null };
  setupNavigationSidebar(): void;
  setupModals(): void;
  applyAnimSpeed(): void;
  connectToInstance(id: string): Promise<void>;
  clearInstanceView(): void;
  handleLocationChange(event?: Event): Promise<void>;
  openDetail(): void;
  closeDoc(): void;
  setupSearch(): void;
  handleSearch(term: string): void;
  updateDiagnostics(): void;
  syncNavigationSidebar(): void;
  navigationSidebar?: { dispose(): void; openSearch(): void; isSearchOpen(): boolean };
  stopControl?: () => void;
}

let app: App | undefined;
afterEach(() => {
  app?.stopControl?.(); app?.clearInstanceView(); app?.navigationSidebar?.dispose(); app = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

const project = '2026-10-04-program';
const filtered = `/work/project/${project}?search=calmer`;

async function setup(route = filtered, holdSnapshot = false, initialSidebar: WebappSidebarSection[] = []) {
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  history.replaceState(null, '', route);
  localStorage.setItem('animSpeed', '0');
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  let finishSnapshot: (() => void) | undefined;
  const sidebars = new Map<string, WebappSidebarSection[]>([['work', structuredClone(initialSidebar)]]);
  const sidebarWrites = vi.fn();
  stubBrowserFetch((url, init) => {
    const match = /^\/-\/api\/instances\/(work|personal)(?:\/(data|sidebar))?(?:\?refresh=1)?$/.exec(url);
    if (!match) return new Response('', { status: 404 });
    const id = match[1];
    if (!match[2]) return Response.json({ id, name: id, path: `/fixture/${id}` });
    if (match[2] === 'sidebar') {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('X-Aside-Control')).toBe('1');
      const { sidebar, expectedSidebar } = JSON.parse(init?.body as string);
      expect(expectedSidebar).toEqual(sidebars.get(id) ?? []);
      sidebars.set(id, sidebar); sidebarWrites(id, sidebar);
      return Response.json({ sidebar });
    }
    const data = snapshotFixture(id, 'A calmer release note.');
    data.instance!.manifest.config = { webapp: { sidebar: structuredClone(sidebars.get(id) ?? []) } };
    data.weeks[0][1][0].meta.projects = [project];
    data.weeksByEntity.push([`#project/${project}`, ['2026-09-28']]);
    if (holdSnapshot) return new Promise<Response>(resolve => { finishSnapshot = () => resolve(Response.json(data)); });
    return Response.json(data);
  });
  app = await loadApp<App>('state, setupNavigationSidebar, setupModals, applyAnimSpeed, connectToInstance, clearInstanceView, handleLocationChange, openDetail, closeDoc, setupSearch, handleSearch, updateDiagnostics, syncNavigationSidebar, stopControl, navigationSidebar');
  app.applyAnimSpeed(); app.setupModals(); app.setupNavigationSidebar();
  const connecting = app.connectToInstance('work');
  const entries = document.getElementById('nav-entries') as HTMLAnchorElement;
  const search = document.getElementById('btn-pill-search') as HTMLButtonElement;
  return { api: app, connecting, entries, search, sidebars, sidebarWrites, releaseSnapshot: async () => {
    await vi.waitFor(() => expect(finishSnapshot).toBeDefined());
    finishSnapshot!();
    holdSnapshot = false;
  } };
}

describe('sidebar application navigation', () => {
  it('opens the default Entries flow and restores the prior filters through Back', async () => {
    const { api, connecting, entries } = await setup(); await connecting;
    expect(entries.getAttribute('href')).toBe('/work/');
    expect(entries.getAttribute('aria-current')).toBe('page');
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(api.state.search).toBe('calmer');
    const previousVisit = history.state;
    entries.click();
    await vi.waitFor(() => expect(location.pathname + location.search).toBe('/work/'));
    await vi.waitFor(() => expect(document.querySelector('#scroll-sentinel')).not.toBeNull());
    expect(api.state.filter).toBeNull(); expect(api.state.search).toBe(''); expect(api.state.doc).toBeNull();
    history.replaceState(previousVisit, '', filtered);
    await api.handleLocationChange(new PopStateEvent('popstate', { state: previousVisit }));
    expect(api.state.filter).toEqual({ type: 'project', id: project }); expect(api.state.search).toBe('calmer');
    expect(entries.getAttribute('aria-current')).toBe('page');
  });

  it('marks Entries active for a filtered flow and restores it after reading a body', async () => {
    const { api, connecting, entries } = await setup(); await connecting;
    expect(entries.getAttribute('aria-current')).toBe('page');
    api.openDetail();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#doc-backdrop')!.hidden).toBe(false));
    expect(document.querySelector('#doc-backdrop')!.tagName).toBe('SECTION');
    expect(entries.hasAttribute('aria-current')).toBe(false);
    api.closeDoc();
    await vi.waitFor(() => expect(api.state.doc).toBeNull());
    expect(entries.getAttribute('aria-current')).toBe('page');
    expect(api.state.search).toBe('calmer');
  });

  it('waits for a connected instance, updates its root link, and hides navigation on reset', async () => {
    const { api, connecting, entries, search, releaseSnapshot } = await setup('/work/', true);
    expect(search.disabled).toBe(true); expect(entries.hasAttribute('href')).toBe(false);
    await releaseSnapshot(); await connecting;
    expect(search.disabled).toBe(false); expect(entries.getAttribute('href')).toBe('/work/');
    history.replaceState(null, '', '/personal/');
    await api.connectToInstance('personal');
    expect(entries.getAttribute('href')).toBe('/personal/');
    api.clearInstanceView();
    expect(search.disabled).toBe(true); expect(entries.hasAttribute('href')).toBe(false);
  });

  it('clears applied chips when leaving an instance', async () => {
    const { api, connecting } = await setup(); await connecting;
    expect(document.getElementById('filter-pill')!.hidden).toBe(false);
    expect(document.getElementById('flow-search')!.hidden).toBe(false);
    api.clearInstanceView();
    expect(document.getElementById('filter-pill')!.hidden).toBe(true);
    expect(document.getElementById('flow-search')!.hidden).toBe(true);
    expect(document.getElementById('side-panel')!.hidden).toBe(true);
  });

  it('distinguishes attachments of one artifact in the active label and pinned shortcuts', async () => {
    const { api, connecting, sidebars, sidebarWrites } = await setup(); await connecting;
    vi.spyOn(api.state.store!, 'getArtifactDisplayName').mockReturnValue('Launch dashboard');
    for (const filename of ['daily.html', 'weekly.html']) {
      api.state.doc = { kind: 'artifact', id: '2026-10-04-report', filename };
      api.syncNavigationSidebar();
      expect(document.getElementById('workspace-pill-label')!.textContent).toBe(`${filename} · Launch dashboard`);
      document.getElementById('btn-workspace-pin')!.click();
      await vi.waitFor(() => expect(sidebarWrites).toHaveBeenCalledTimes(filename === 'daily.html' ? 1 : 2));
      await vi.waitFor(() => expect(document.querySelectorAll('#workspace-sections a')).toHaveLength(filename === 'daily.html' ? 1 : 2));
    }
    expect(sidebars.get('work')?.flatMap(section => section.items.map(item => item.label))).toEqual(['daily.html · Launch dashboard', 'weekly.html · Launch dashboard']);
    expect(sidebars.get('work')?.flatMap(section => section.items.map(item => item.entity))).toEqual([
      '#artifact/2026-10-04-report/daily.html', '#artifact/2026-10-04-report/weekly.html',
    ]);
    api.state.doc = { kind: 'artifact', id: '2026-10-04-report' }; api.syncNavigationSidebar();
    expect(document.getElementById('workspace-pill-label')!.textContent).toBe('Launch dashboard');
  });

  it('renders explicit ordered sections and distinguishes timeline navigation from an entity body', async () => {
    const sections: WebappSidebarSection[] = [
      { items: [{ label: 'Project body', entity: `#project/${project}` }] },
      { title: 'Focus', items: [{ label: 'Project entries', timeline: `#project/${project}` }] },
    ];
    const { api, connecting } = await setup('/work/', false, sections); await connecting;
    expect([...document.querySelectorAll('#workspace-sections h2')].map(node => node.textContent)).toEqual(['Focus']);
    expect([...document.querySelectorAll('#workspace-sections a')].map(node => node.textContent)).toEqual(['Project body', 'Project entries']);
    document.getElementById('btn-workspace-views')!.click();
    document.querySelector<HTMLAnchorElement>('#workspace-sections a')!.click();
    await vi.waitFor(() => expect(api.state.doc).toEqual({ kind: 'detail' }));
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    document.getElementById('btn-workspace-views')!.click();
    document.querySelectorAll<HTMLAnchorElement>('#workspace-sections a')[1].click();
    await vi.waitFor(() => expect(api.state.doc).toBeNull());
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(document.querySelectorAll('#workspace-sections [aria-current="page"]')).toHaveLength(1);
  });

  it('keeps focus on visible controls after a warning disappears or a focused card is rebuilt', async () => {
    const { api, connecting } = await setup('/work/'); await connecting;
    const diagnostics = vi.spyOn(api.state.store!, 'getDiagnostics').mockReturnValue([{ path: 'aside.md', issues: [], error: 'Unreadable manifest' }]);
    api.updateDiagnostics();
    (document.getElementById('data-diagnostics') as HTMLDetailsElement).open = true;
    document.querySelector<HTMLButtonElement>('#data-diagnostics-files button')!.focus();
    diagnostics.mockReturnValue([]); api.updateDiagnostics();
    const control = document.getElementById('btn-workspace-views');
    expect(document.activeElement).toBe(control);

    document.querySelector<HTMLElement>('#flow .entry-card a')!.focus();
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
    snapshotFlow(document.getElementById('flow-scroll')!);
    expect(document.activeElement).toBe(control);
    expect(control!.closest('[hidden], [inert]')).toBeNull();
  });

  it.each([false, true])('dismisses Search when a lookup jumps within the existing flow (from body=%s)', async fromBody => {
    const { api, connecting } = await setup(); await connecting;
    if (fromBody) {
      api.openDetail();
      await vi.waitFor(() => expect(document.getElementById('doc-backdrop')!.hidden).toBe(false));
    }
    api.setupSearch(); api.navigationSidebar!.openSearch();
    api.handleSearch('entry:calmer');
    const result = document.querySelector<HTMLElement>('[data-key="entry:2026-10-04T10:00"]');
    expect(result).not.toBeNull();
    expect(api.navigationSidebar!.isSearchOpen()).toBe(true);
    result!.click();
    await vi.waitFor(() => expect(location.pathname).toBe(`/work/project/${project}/2026-10-04T10:00`));
    expect(api.state.filter).toEqual({ type: 'project', id: project });
    expect(api.state.search).toBe('calmer');
    expect(api.state.doc).toBeNull();
    expect(document.getElementById('filter-pill')!.hidden).toBe(false);
    expect(api.navigationSidebar!.isSearchOpen()).toBe(false);
    expect(document.getElementById('flow-scroll')!.inert).toBe(false);
    expect(document.activeElement?.closest('[hidden], [inert]')).toBeNull();
  });
});
