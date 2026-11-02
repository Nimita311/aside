// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import type { DataSource } from '../lib/io';
import type { EntityRef } from '../lib/types';
import { loadApp } from './app-harness';

const id = '2026-10-04-review';
const source: DataSource = {
  async read(path) {
    const files: Record<string, string> = {
      'aside.md': '---\nid: work\nname: Work\n---\n',
      'projects/2026/index.yaml': `- id: ${id}\n  description: Project\n`,
      'actions/2026/index.yaml': `- id: ${id}\n  description: Action\n`,
      [`projects/2026/${id}.md`]: '---\nname: Release review\ncreated: 2026-10-04T09:00\n---\n',
      [`actions/2026/${id}.md`]: '---\nname: Publish release\ncreated: 2026-10-04T09:00\n---\n',
    };
    return files[path] === undefined ? null : { text: files[path], version: files[path] };
  },
  async revalidate() { return 'unchanged'; },
  assetUrl() { return null; },
  async listYears() { return ['2026']; },
};

interface App {
  state: { store: Store | null; instanceId: string | null; filter: EntityRef | null; panelCollapsed: boolean; timeFormat: '24h' | '12h' };
  collapsePanel(): void;
  expandPanel(): void;
  updateFilterPill(): void;
  closeSidePanel(): void;
  refreshTimeDisplay(): void;
}

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); localStorage.clear(); });

describe('panel visibility and focus handoff', () => {
  async function setup() {
    localStorage.clear();
    history.replaceState({}, '', '/work/');
    document.body.innerHTML = '<header class="app-title"><a href="/">Aside</a></header><input id="other">' +
      '<aside id="side-panel" class="is-open"><button id="btn-side-panel-collapse">Retract panel</button><div id="side-panel-body"></div></aside>' +
      '<div id="filter-pill" hidden></div>';
    const store = new Store(source);
    await store.init();
    const api = await loadApp<App>('state, collapsePanel, expandPanel, updateFilterPill, closeSidePanel, refreshTimeDisplay');
    api.state.store = store;
    api.state.instanceId = 'work';
    api.state.filter = { type: 'project', id };
    api.state.panelCollapsed = false;
    vi.useFakeTimers();
    const panel = document.getElementById('side-panel')!, pill = document.getElementById('filter-pill')!;
    const retract = document.getElementById('btn-side-panel-collapse')!;
    return { api, panel, pill, retract };
  }

  it('moves focus from retract to expand before the panel becomes inert, then hidden', async () => {
    const { api, panel, pill, retract } = await setup();
    retract.focus();
    api.collapsePanel();
    const expand = pill.querySelector<HTMLButtonElement>('.filter-pill-label')!;
    expect(document.activeElement).toBe(expand);
    expect(expand.getAttribute('aria-label')).toBe('Expand panel: Release review');
    expect(panel.inert).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(pill.inert).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(expand);
  });

  it('moves focus from expand to retract while the old pill exits inert', async () => {
    const { api, panel, pill, retract } = await setup();
    api.collapsePanel();
    pill.querySelector<HTMLElement>('.filter-pill-label')!.focus();
    api.expandPanel();
    expect(document.activeElement).toBe(retract);
    expect(panel.hidden).toBe(false);
    expect(panel.inert).toBe(false);
    expect(pill.inert).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(pill.hidden).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(document.activeElement).toBe(retract);
  });

  it('keeps an intentional focus destination outside the transitioning surfaces', async () => {
    const { api } = await setup();
    const other = document.getElementById('other')!;
    other.focus();
    api.collapsePanel();
    expect(document.activeElement).toBe(other);
    api.expandPanel();
    await vi.advanceTimersByTimeAsync(250);
    expect(document.activeElement).toBe(other);
  });

  it('cancels the outgoing hide timer when the panel is reopened quickly', async () => {
    const { api, panel, pill } = await setup();
    api.collapsePanel();
    await vi.advanceTimersByTimeAsync(100);
    api.expandPanel();
    await vi.advanceTimersByTimeAsync(250);
    expect(panel.hidden).toBe(false);
    expect(panel.inert).toBe(false);
    expect(pill.hidden).toBe(true);
  });

  it('retains the equivalent folded control on repaint and falls back when clear is removed', async () => {
    const { api, pill } = await setup();
    api.collapsePanel();
    pill.querySelector<HTMLElement>('.filter-pill-clear')!.focus();
    api.updateFilterPill();
    expect(document.activeElement).toBe(pill.querySelector('.filter-pill-clear'));
    api.state.filter = null;
    api.updateFilterPill();
    expect(document.activeElement).toBe(pill.querySelector('.filter-pill-label'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Expand panel: Work');
  });

  it('uses the selected type name and updates generated entry names with the visible time format', async () => {
    const { api, pill } = await setup();
    api.state.filter = { type: 'action', id };
    api.collapsePanel();
    expect(pill.querySelector('button')?.getAttribute('aria-label')).toBe('Expand panel: Publish release');
    api.state.timeFormat = '24h';
    api.state.filter = { type: 'entry', id: '2026-10-04T15:30' };
    api.updateFilterPill();
    expect(pill.querySelector('button')?.getAttribute('aria-label')).toBe('Expand panel: Oct 4, 2026, 15:30');
    api.state.timeFormat = '12h';
    api.refreshTimeDisplay();
    expect(pill.querySelector('button')?.getAttribute('aria-label')).toBe('Expand panel: Oct 4, 2026, 3:30 PM');
    expect(pill.querySelector('.tag-text')?.textContent).toBe('Oct 4, 2026, 3:30 PM');
  });

  it('uses a visible header fallback when no replacement panel control exists', async () => {
    const { api, panel, retract } = await setup();
    retract.focus();
    api.closeSidePanel();
    expect(panel.inert).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.app-title a'));
  });
});
