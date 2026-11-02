// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import type { DataSource } from '../lib/io';
import type { EntityRef } from '../lib/types';
import type { ModalController } from '../src/modal';
import { loadApp } from './app-harness';

const ids = Array.from({ length: 12 }, (_, index) => `2026-10-04-project-${index}`);
const source: DataSource = {
  async read(path) {
    const files: Record<string, string> = {
      'aside.md': '---\nid: work\nname: Work\n---\n',
      'projects/2026/index.yaml': ids.map((id, index) => `- id: ${id}\n  description: Project ${index}\n`).join(''),
      ...Object.fromEntries(ids.map((id, index) => [`projects/2026/${id}.md`, `---\nname: Project ${index}\ncreated: 2026-10-04T09:00\n---\n`])),
    };
    return files[path] === undefined ? null : { text: files[path], version: files[path] };
  },
  async revalidate() { return 'unchanged'; },
  async listYears() { return ['2026']; },
  assetUrl() { return null; },
};

interface PanelView { scrollTop: number; expanded: string[] }
interface App {
  state: { store: Store | null; instanceId: string | null; filter: EntityRef | null; panelCollapsed: boolean };
  showSidePanel(view?: PanelView | null, userInitiated?: boolean): Promise<void>;
  panelSnapshot(): PanelView | null;
  collapsePanel(): void;
  setupModals(): void;
  dismissActionToast(): void;
  settingsModal: ModalController;
  readerModal: ModalController;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const modals: ModalController[] = [];
const dismissToasts: (() => void)[] = [];
afterEach(() => { for (const dismiss of dismissToasts.splice(0)) dismiss(); for (const modal of modals.splice(0)) modal.close(0); vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear(); });

describe('panel content focus', () => {
  async function setup() {
    localStorage.clear();
    history.replaceState({}, '', '/work/');
    document.body.innerHTML = '<h1 class="app-title"><a href="/">Aside</a></h1><input id="other">' +
      '<aside id="side-panel"><button id="btn-side-panel-collapse">Retract panel</button><div id="side-panel-body"></div></aside><div id="filter-pill" hidden></div>' +
      '<dialog id="doc-backdrop" hidden><button>Close document</button><div id="doc-body"></div></dialog>' +
      '<dialog id="modal-backdrop" hidden><button>Close settings</button></dialog>';
    const store = new Store(source); await store.init();
    const api = await loadApp<App>('state, showSidePanel, panelSnapshot, collapsePanel, setupModals, dismissActionToast, settingsModal, readerModal');
    api.state.store = store; api.state.instanceId = 'work'; api.state.panelCollapsed = false;
    dismissToasts.push(api.dismissActionToast); api.setupModals(); modals.push(api.settingsModal, api.readerModal);
    await api.showSidePanel();
    const body = document.getElementById('side-panel-body')!;
    const projectLink = () => body.querySelector<HTMLAnchorElement>('.tag-project')!;
    async function delayRelations() {
      const relations = await store.getRelations();
      const pending = deferred<typeof relations>();
      vi.spyOn(store, 'getRelations').mockReturnValueOnce(pending.promise);
      return { finish: () => pending.resolve(relations), fail: () => pending.reject(new Error('Offline')) };
    }
    return { api, store, body, projectLink, delayRelations };
  }

  it('keeps keyboard focus inside the loading panel, then moves to the new scope heading', async () => {
    const { body, projectLink, delayRelations } = await setup();
    const pending = await delayRelations();
    const link = projectLink(), name = link.querySelector('.tag-text')!.textContent;
    link.focus(); link.click();
    expect(document.activeElement).toBe(body);
    expect(body.querySelector('.loading')).toBeNull();
    await vi.waitFor(() => expect(body.textContent).toContain('Loading'));
    pending.finish();
    await vi.waitFor(() => expect(document.activeElement).toBe(body.querySelector('.entity-title')));
    expect(document.activeElement?.textContent).toContain(name);
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
  });

  it('keeps a focused link available during refresh and restores its replacement', async () => {
    const { api, body, projectLink, delayRelations } = await setup();
    const pending = await delayRelations();
    const link = projectLink(), href = link.getAttribute('href');
    link.focus();
    const refreshing = api.showSidePanel(api.panelSnapshot());
    expect(document.activeElement).toBe(link);
    expect(link.isConnected).toBe(true);
    pending.finish(); await refreshing;
    expect(document.activeElement).not.toBe(link);
    expect(document.activeElement?.getAttribute('href')).toBe(href);
    expect(body.contains(document.activeElement)).toBe(true);
  });

  it('restores expanded content before finding the equivalent focused link', async () => {
    const { api, body } = await setup();
    body.querySelector<HTMLButtonElement>('.related-more')!.click();
    const link = [...body.querySelectorAll<HTMLAnchorElement>('.tag-project')].at(-1)!;
    link.focus();
    await api.showSidePanel(api.panelSnapshot());
    expect(document.activeElement?.getAttribute('href')).toBe(link.getAttribute('href'));
    expect(document.activeElement).not.toBe(link);
    expect(body.querySelectorAll('.tag-project')).toHaveLength(12);
  });

  it('restores the section expansion button by its section identity', async () => {
    const { api, body } = await setup();
    const more = body.querySelector<HTMLButtonElement>('.related-more')!;
    more.focus();
    await api.showSidePanel(api.panelSnapshot());
    expect(document.activeElement).toBe(body.querySelector('.related-more'));
    expect(document.activeElement).not.toBe(more);
  });

  it('preserves expansion, scrolling and focus changes made while a refresh loads', async () => {
    const { api, body, projectLink, delayRelations } = await setup();
    const pending = await delayRelations();
    projectLink().focus();
    const refreshing = api.showSidePanel(api.panelSnapshot());
    body.querySelector<HTMLButtonElement>('.related-more')!.click();
    const link = [...body.querySelectorAll<HTMLAnchorElement>('.tag-project')].at(-1)!;
    link.focus(); body.scrollTop = 90;
    pending.finish(); await refreshing;
    expect(document.activeElement?.getAttribute('href')).toBe(link.getAttribute('href'));
    expect(body.querySelectorAll('.tag-project')).toHaveLength(12);
    expect(body.scrollTop).toBe(90);
  });

  it('keeps a new focus destination chosen while a navigation loads', async () => {
    const { api, projectLink, delayRelations } = await setup();
    const pending = await delayRelations();
    projectLink().focus();
    api.state.filter = { type: 'project', id: ids[0] };
    const loading = api.showSidePanel();
    const other = document.getElementById('other')!; other.focus();
    pending.finish(); await loading;
    expect(document.activeElement).toBe(other);
  });

  it('preserves the current control when focus moves within the panel during refresh', async () => {
    const { api, body, projectLink, delayRelations } = await setup();
    const pending = await delayRelations();
    projectLink().focus();
    const refreshing = api.showSidePanel(api.panelSnapshot());
    const title = body.querySelector<HTMLAnchorElement>('.title-open')!; title.focus();
    pending.finish(); await refreshing;
    expect(document.activeElement).toBe(body.querySelector('.title-open'));
  });

  it('does not let an older same-scope refresh replace a newer focused summary', async () => {
    const { api, body, projectLink, delayRelations } = await setup();
    const first = await delayRelations();
    projectLink().focus();
    const older = api.showSidePanel(api.panelSnapshot());
    await api.showSidePanel(api.panelSnapshot());
    const currentTitle = body.querySelector('.entity-title'), currentFocus = document.activeElement;
    first.finish(); await older;
    expect(body.querySelector('.entity-title')).toBe(currentTitle);
    expect(document.activeElement).toBe(currentFocus);
  });

  it('focuses recovery when keyboard navigation fails and announces only a toast', async () => {
    const { api, body, projectLink, delayRelations } = await setup();
    const pending = await delayRelations();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    projectLink().focus();
    api.state.filter = { type: 'project', id: ids[0] };
    const loading = api.showSidePanel(undefined, true);
    pending.fail(); await loading;
    expect(document.activeElement).toBe(body.querySelector('.notice-action'));
    expect(document.querySelector('#action-toast')?.textContent).toBe('Could not load this project. Try again.');
    expect(body.querySelector('[role="alert"]')).toBeNull();
    body.querySelector<HTMLButtonElement>('.notice-action')!.click();
    await vi.waitFor(() => expect(body.querySelector('.entity-title')).not.toBeNull());
  });

  it('retains the summary and focus without a toast when a background refresh fails', async () => {
    const { api, body, projectLink, delayRelations } = await setup();
    const title = body.querySelector('.entity-title');
    projectLink().focus(); const focused = document.activeElement;
    const pending = await delayRelations();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refreshing = api.showSidePanel(api.panelSnapshot());
    pending.fail(); await refreshing;
    expect(body.querySelector('.entity-title')).toBe(title);
    expect(document.activeElement).toBe(focused);
    expect(document.querySelector('#action-toast')).toBeNull();
  });

  it('leaves focus in a modal opened while the summary loads', async () => {
    const { api, projectLink, delayRelations } = await setup();
    const pending = await delayRelations();
    projectLink().focus();
    api.state.filter = { type: 'project', id: ids[0] };
    const loading = api.showSidePanel();
    api.settingsModal.open();
    const modalFocus = document.activeElement;
    pending.finish(); await loading;
    expect(document.activeElement).toBe(modalFocus);
    expect(document.getElementById('modal-backdrop')?.contains(document.activeElement)).toBe(true);
  });

  it('leaves focus on the collapsed panel control if loading finishes after retraction', async () => {
    const { api, projectLink, delayRelations } = await setup();
    const pending = await delayRelations();
    projectLink().focus();
    api.state.filter = { type: 'project', id: ids[0] };
    const loading = api.showSidePanel();
    api.collapsePanel();
    const expand = document.querySelector('.filter-pill-label');
    expect(document.activeElement).toBe(expand);
    pending.finish(); await loading;
    expect(document.activeElement).toBe(expand);
  });
});
