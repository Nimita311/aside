// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../lib/store';
import type { EntityRef, Entry } from '../lib/types';
import type { DocRef } from '../src/route';

type DiagramOptions = { current?: () => boolean; commit?: (paint: () => void) => void };
type DiagramRenderer = (root: HTMLElement, options?: DiagramOptions) => Promise<void>;
interface App {
  state: { store: Store | null; instanceId: string | null; filter: EntityRef | null; doc: DocRef | null; panelCollapsed: boolean; loadedWeeks: number };
  renderFlow(): Promise<void>;
  updateDoc(preserveScroll?: boolean): Promise<void>;
  showSidePanel(view?: { scrollTop: number; expanded: string[] }): Promise<void>;
  refreshDiagramTheme(): Promise<void>;
}

// Control only the asynchronous renderer boundary; exercise the application's
// actual mounting, generation guards, and scroll restoration around it.
async function loadApp(renderer: DiagramRenderer): Promise<App> {
  const path = resolve('src/app.ts');
  const source = readFileSync(path, 'utf8')
    .replace("document.addEventListener('DOMContentLoaded', init);", '')
    .replace("import { renderDiagrams } from './diagrams';", '');
  const bundled = await build({
    stdin: { contents: `${source}\nexport { state, renderFlow, updateDoc, showSidePanel, refreshDiagramTheme };`, resolveDir: dirname(path), loader: 'ts' },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'TestApp', write: false,
    external: ['mermaid'],
  });
  return new Function('renderDiagrams', `${bundled.outputFiles[0].text}\nreturn TestApp;`)(renderer);
}

function deferred() {
  let finish!: () => void;
  const promise = new Promise<void>(resolve => { finish = resolve; });
  return { promise, finish };
}

function diagramReflow(container: HTMLElement, root: HTMLElement): () => void {
  root.innerHTML = '<div class="detail-body"><div class="mermaid-diagram">Source</div><p>Reading below the diagram</p></div>';
  const detail = root.firstElementChild!, paragraph = root.querySelector('p')!;
  let top = 20;
  const rect = (y: number, height = 20) => ({ top: y, bottom: y + height, height, left: 0, right: 100, width: 100, x: 0, y, toJSON() {} });
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(0, 100));
  vi.spyOn(detail, 'getBoundingClientRect').mockReturnValue(rect(-200, 1000));
  vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => rect(top));
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function(this: Range) {
    return this.startContainer.parentElement === paragraph ? [rect(top)] as unknown as DOMRectList : [] as unknown as DOMRectList;
  });
  return () => { top += 30; };
}

const entry: Entry = { meta: { created: '2026-10-04T12:00' }, weekFile: '2026-09-28', content: 'Entry content' };
async function setup(renderer: DiagramRenderer) {
  document.body.innerHTML = '<div id="flow-scroll"><div id="flow"></div></div>' +
    '<aside id="side-panel"><div id="side-panel-body"></div></aside>' +
    '<dialog id="doc-backdrop"><div id="doc-body"></div></dialog><button id="outside">Outside</button>';
  const api = await loadApp(renderer);
  api.state.store = {
    getWeeklyDates: () => [entry.weekFile], getWeekEntries: async () => [entry],
    getAsset: async (path: string) => `Document ${path}`,
    getRelations: async () => ({ entriesByAsset: new Map() }),
    getNoteIndex: () => [], getInstance: () => null, diagnosticsFor: () => undefined,
  } as unknown as Store;
  api.state.instanceId = 'work'; api.state.filter = null; api.state.doc = null;
  api.state.panelCollapsed = false;
  return { api, body: document.getElementById('doc-body')!, panel: document.getElementById('side-panel-body')! };
}

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear(); });

describe('mounted diagram lifecycle', () => {
  it('waits for diagrams before finishing a week and defers theme changes through the flow rebuild', async () => {
    const delayed = deferred();
    const renderer = vi.fn<DiagramRenderer>(async root => {
      expect(root.isConnected).toBe(true);
      if (root.classList.contains('week-view')) await delayed.promise;
    });
    const { api } = await setup(renderer);
    const loading = api.renderFlow();
    await vi.waitFor(() => expect(renderer).toHaveBeenCalledOnce());
    expect(api.state.loadedWeeks).toBe(0);
    expect(document.querySelector('.week-view')?.getAttribute('data-week-status')).toBe('loading');
    const themed = api.refreshDiagramTheme();
    await Promise.resolve();
    expect(renderer).toHaveBeenCalledOnce();
    delayed.finish(); await loading; await themed;
    expect(api.state.loadedWeeks).toBe(1);
    expect(document.querySelector('.week-view')?.getAttribute('data-week-status')).toBe('loaded');
    expect(renderer.mock.calls.some(([root]) => root.id === 'flow')).toBe(true);
  });

  it('does not restore an old reader scroll position after delayed diagrams lose a navigation race', async () => {
    const delayed = deferred();
    const renderer = vi.fn<DiagramRenderer>(async (root, options) => {
      if (!root.textContent?.includes('first.md')) return;
      expect(root.isConnected).toBe(true);
      await delayed.promise;
      expect(options?.current?.()).toBe(false);
    });
    const { api, body } = await setup(renderer);
    api.state.doc = { kind: 'asset', path: 'first.md' }; body.scrollTop = 120;
    const first = api.updateDoc(true);
    await vi.waitFor(() => expect(renderer).toHaveBeenCalledOnce());
    api.state.doc = { kind: 'asset', path: 'second.md' };
    await api.updateDoc(); body.scrollTop = 35;
    const outside = document.getElementById('outside')!; outside.focus();
    delayed.finish(); await first;
    expect(body.textContent).toContain('second.md'); expect(body.textContent).not.toContain('first.md');
    expect(body.scrollTop).toBe(35); expect(document.activeElement).toBe(outside);
  });

  it('waits for panel diagrams before restoring its stored scroll position', async () => {
    const delayed = deferred();
    const renderer = vi.fn<DiagramRenderer>(async root => { expect(root.isConnected).toBe(true); await delayed.promise; });
    const { api, panel } = await setup(renderer);
    api.state.filter = { type: 'entry', id: entry.meta.created };
    const showing = api.showSidePanel({ scrollTop: 90, expanded: [] });
    await vi.waitFor(() => expect(renderer).toHaveBeenCalledOnce());
    expect(panel.scrollTop).toBe(0);
    delayed.finish(); await showing;
    expect(panel.scrollTop).toBe(90);
  });

  it('keeps reading and focus changes made while a current document is rendering', async () => {
    const delayed = deferred();
    const renderer = vi.fn<DiagramRenderer>(() => delayed.promise);
    const { api, body } = await setup(renderer);
    api.state.doc = { kind: 'asset', path: 'first.md' }; body.scrollTop = 120;
    const loading = api.updateDoc(true);
    await vi.waitFor(() => expect(renderer).toHaveBeenCalledOnce());
    body.scrollTop = 250;
    const outside = document.getElementById('outside')!; outside.focus();
    delayed.finish(); await loading;
    expect(body.scrollTop).toBe(250); expect(document.activeElement).toBe(outside);
  });

  it('restores stored reader scroll despite renderer-owned scroll corrections', async () => {
    const renderer = vi.fn<DiagramRenderer>(async (root, options) => {
      options?.commit?.(diagramReflow(document.getElementById('doc-body')!, root));
    });
    const { api, body } = await setup(renderer);
    api.state.doc = { kind: 'asset', path: 'first.md' }; body.scrollTop = 120;
    await api.updateDoc(true);
    expect(body.scrollTop).toBe(120);
  });

  it('restores stored panel scroll despite renderer-owned scroll corrections', async () => {
    const renderer = vi.fn<DiagramRenderer>(async (root, options) => {
      options?.commit?.(diagramReflow(document.getElementById('side-panel-body')!, root));
    });
    const { api, panel } = await setup(renderer);
    api.state.filter = { type: 'entry', id: entry.meta.created };
    await api.showSidePanel({ scrollTop: 90, expanded: [] });
    expect(panel.scrollTop).toBe(90);
  });

  it('retains user reading movement followed by diagram scroll corrections', async () => {
    const delayed = deferred();
    const renderer = vi.fn<DiagramRenderer>(async (root, options) => {
      const paint = diagramReflow(document.getElementById('doc-body')!, root);
      await delayed.promise;
      options?.commit?.(paint);
    });
    const { api, body } = await setup(renderer);
    api.state.doc = { kind: 'asset', path: 'first.md' }; body.scrollTop = 120;
    const loading = api.updateDoc(true);
    await vi.waitFor(() => expect(renderer).toHaveBeenCalledOnce());
    body.scrollTop = 250;
    delayed.finish(); await loading;
    expect(body.scrollTop).toBe(280);
  });

  it('preserves the reading anchor when a themed diagram changes height', async () => {
    const renderer = vi.fn<DiagramRenderer>(async (root, options) => {
      if (root.id === 'doc-body') {
        const detail = document.createElement('article'); root.append(detail);
        options?.commit?.(diagramReflow(root, detail));
      }
    });
    const { api, body } = await setup(renderer);
    body.scrollTop = 60;
    await api.refreshDiagramTheme();
    expect(body.scrollTop).toBe(90);
  });
});
