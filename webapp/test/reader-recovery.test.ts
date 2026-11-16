// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import type { DataSource, FileRead } from '../lib/io';
import type { DocRef, ViewState } from '../src/route';
import type { EntityRef } from '../lib/types';
import type { ModalController } from '../src/modal';
import type { PanelView } from '../src/side-panel';
import type { createContextPanel } from '../src/context-panel';
import type { HotSet, PendingUpdate } from '../../cli/src/core/data-snapshot';
import { loadApp } from './app-harness';

const artifact = '2026-10-04-report', project = '2026-10-04-review';
const attachment = `artifacts/2026/${artifact}/report.md`;

function expectPanelFocus(body: HTMLElement): void {
  const active = document.activeElement as HTMLElement;
  expect(body.contains(active)).toBe(true);
  expect(active.closest('[hidden], [inert]')).toBeNull();
}

class Source implements DataSource {
  files: Record<string, string> = {
    'aside.md': '---\nid: work\nname: Work\n---\n',
    'artifacts/2026/index.yaml': `- id: ${artifact}\n  description: Report\n`,
    [`artifacts/2026/${artifact}.md`]: '---\nname: Report\ncreated: 2026-10-04T09:00\nattachments: [report.md]\n---\n',
    [attachment]: 'Repaired report attachment.',
    'assets/failed.md': 'Repaired readable document.',
    'assets/later.md': 'Newer document wins.',
  };
  failures = new Set<string>();
  reads: string[] = [];
  deferred = new Map<string, Promise<FileRead>>();
  async read(path: string): Promise<FileRead | null> {
    this.reads.push(path);
    if (this.deferred.has(path)) return this.deferred.get(path)!;
    if (this.failures.has(path)) throw new Error(`Failed to fetch /-/api/instances/work/files/${path}: 500 Internal Server Error`);
    const text = this.files[path]; return text === undefined ? null : { text, version: text };
  }
  async revalidate(path: string, version: string) { const file = await this.read(path); return file?.version === version ? 'unchanged' as const : file; }
  async listYears() { return ['2026']; }
  assetUrl(_path: string): string | null { return null; }
}

class MediaSource extends Source {
  metadata = new Map<string, string>();
  checks: string[] = [];
  metadataFailures = new Set<string>();
  metadataDeferred = new Map<string, Promise<string | null>>();
  assetUrl(path: string) { return `http://localhost/-/api/instances/work/files/${path}`; }
  async assetVersion(path: string): Promise<string | null> {
    this.checks.push(path);
    if (this.metadataDeferred.has(path)) return this.metadataDeferred.get(path)!;
    if (this.metadataFailures.has(path)) throw new Error(`Failed to check ${this.assetUrl(path)}: 500 Internal Server Error`);
    return this.metadata.get(path) ?? null;
  }
}

interface App {
  state: { store: Store | null; instanceId: string | null; filter: EntityRef | null; doc: DocRef | null };
  setupContextPanel(): void;
  setupModals(): void;
  dismissActionToast(): void;
  applyView(view: ViewState): Promise<void>;
  showSidePanel(view?: PanelView | null): Promise<void>;
  panelSnapshot(): PanelView | null;
  retryReadableFile(store: Store, path: string): Promise<void>;
  currentHotSet(): HotSet;
  applyDataUpdate(update: PendingUpdate): Promise<void>;
  contextPanel?: ReturnType<typeof createContextPanel>;
  settingsModal: ModalController;
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear(); });

describe('document failure recovery in the context panel', () => {
  async function setup(source = new Source()) {
    // Keep the embedded PDF fixture local; its production src and metadata
    // still exercise the panel, while native decoding belongs to browser QA.
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
      const node = create(tag, options);
      if (tag === 'iframe') node.setAttribute('srcdoc', '');
      return node;
    });
    history.replaceState({}, '', '/work/');
    document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const store = new Store(source); await store.init();
    const api = await loadApp<App>('state, setupContextPanel, setupModals, dismissActionToast, applyView, showSidePanel, panelSnapshot, retryReadableFile, contextPanel, settingsModal, currentHotSet, applyDataUpdate');
    api.state.store = store; api.state.instanceId = 'work';
    api.setupContextPanel(); api.setupModals();
    cleanups.push(api.dismissActionToast, () => api.settingsModal.close(0), () => api.contextPanel?.destroy());
    const body = document.getElementById('side-panel-body')!, panel = document.getElementById('side-panel')!;
    const control = document.getElementById('btn-workspace-views')!;
    // What a catch-up refresh of the still-inspected document does.
    const refresh = () => api.showSidePanel(api.panelSnapshot());
    return { source, store, api, body, panel, control, refresh };
  }

  it('exposes the failed URL/reason and recovers the current asset without changing route or panel focus', async () => {
    const { source, store, api, body, panel } = await setup();
    source.failures.add('assets/failed.md');
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/failed.md' } });
    const route = location.pathname;
    expect(body.textContent).toContain('/-/api/instances/work/files/assets/failed.md: 500 Internal Server Error');
    expect(body.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('#action-toast')?.getAttribute('role')).toBe('status');
    const retry = body.querySelector<HTMLButtonElement>('.history-retry')!;
    expect(retry.getAttribute('aria-label')).toBe('Retry assets/failed.md');
    retry.focus(); source.failures.clear(); retry.click();
    await vi.waitFor(() => expect(body.textContent).toContain('Repaired readable document.'));
    expect(store.diagnosticsFor('assets/failed.md')).toBeUndefined();
    expect(body.querySelector('.data-file-notice')).toBeNull();
    expect(location.pathname).toBe(route);
    expectPanelFocus(body);
    expect(panel.hidden).toBe(false);
    expect(body.hasAttribute('aria-live')).toBe(false);
    expect(body.querySelector('.detail-body')?.hasAttribute('aria-live')).toBe(false);
    expect(body.querySelector('[role="alert"], [role="status"]')).toBeNull();
  });

  it('retains readable content without a toast when a background refresh fails', async () => {
    const { api, store, body, refresh } = await setup();
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/later.md' } });
    vi.spyOn(store, 'getAsset').mockRejectedValueOnce(new Error('Offline'));
    const content = body.firstElementChild;
    await refresh();
    expect(body.firstElementChild).toBe(content);
    expect(body.textContent).toContain('Newer document wins.');
    expect(document.querySelector('#action-toast')).toBeNull();
  });

  // The panel reloads a failed document on refresh, so its notice and Retry
  // are rendered again rather than retained in place.
  it('keeps a usable Retry without a toast after a failed background refresh', async () => {
    const { api, source, body, refresh } = await setup();
    source.failures.add('assets/failed.md');
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/failed.md' } });
    api.dismissActionToast();
    await refresh();
    const retry = body.querySelector<HTMLButtonElement>('.history-retry')!;
    expect(retry.disabled).toBe(false);
    expect(document.getElementById('action-toast')?.hidden).toBe(true);
    source.failures.clear(); retry.click();
    await vi.waitFor(() => expect(body.textContent).toContain('Repaired readable document.'));
  });

  it('exposes a delayed load as a status without making the recovered document live', async () => {
    const source = new Source(), path = 'assets/delayed.md';
    let finish!: (file: FileRead) => void;
    source.deferred.set(path, new Promise(resolve => { finish = resolve; }));
    const { api, body } = await setup(source);
    const opening = api.applyView({ filter: null, doc: { kind: 'asset', path } });
    await vi.waitFor(() => expect(body.querySelector('.loading')).not.toBeNull());
    const line = body.querySelector('.loading')!;
    expect(line.getAttribute('role')).toBe('status'); expect(line.getAttribute('aria-atomic')).toBe('true');
    expect(document.activeElement).toBe(body);
    finish({ text: 'Authored content remains an ordinary document.', version: 'ready' }); await opening;
    expect(body.textContent).toContain('Authored content remains an ordinary document.');
    expect(body.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    expectPanelFocus(body);
  });

  it('keeps a failed retry usable with the current reason and another Retry', async () => {
    const { source, api, body } = await setup(); source.failures.add('assets/failed.md');
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/failed.md' } });
    const failed = body.querySelector<HTMLButtonElement>('.history-retry')!;
    failed.focus(); failed.click();
    // A browser drops focus from the Retry it just disabled; the panel takes
    // it first, then hands it to the replacement.
    expect(failed.disabled).toBe(true); expect(document.activeElement).toBe(body);
    await vi.waitFor(() => expect(body.querySelector('.history-retry')).not.toBe(failed));
    const retry = body.querySelector<HTMLButtonElement>('.history-retry')!;
    expect(retry.disabled).toBe(false);
    expect(body.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    expect(body.textContent).toContain('500 Internal Server Error');
    expect(document.activeElement).toBe(retry);
  });

  it.each([undefined, 'report.md'])('retries the selected artifact attachment rather than the parent record (explicit=%s)', async filename => {
    const { source, api, body } = await setup(); source.failures.add(attachment);
    await api.applyView({ filter: null, doc: { kind: 'artifact', id: artifact, filename } });
    expect(body.querySelector('.data-file-notice')?.getAttribute('data-path')).toBe(attachment);
    source.failures.clear(); source.reads = [];
    body.querySelector<HTMLButtonElement>('.history-retry')!.click();
    await vi.waitFor(() => expect(body.textContent).toContain('Repaired report attachment.'));
    expect(source.reads).toEqual([attachment]);
  });

  it('discards a delayed retry after a newer document navigation', async () => {
    const { source, store, api, body } = await setup(); source.failures.add('assets/failed.md');
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/failed.md' } });
    let finish!: (read: FileRead) => void;
    source.deferred.set('assets/failed.md', new Promise(resolve => { finish = resolve; }));
    body.querySelector<HTMLButtonElement>('.history-retry')!.click();
    const reloading = store.reloadFile('assets/failed.md');
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/later.md' } });
    finish({ text: 'Obsolete recovered document.', version: 'old' });
    await reloading;
    expect(source.reads.filter(path => path === 'assets/failed.md')).toHaveLength(2);
    expect(body.textContent).toContain('Newer document wins.');
    expect(body.textContent).not.toContain('Obsolete recovered document.');
    expect(location.pathname).toBe('/work/asset/assets/later.md');
    expectPanelFocus(body);
  });

  it('retains recovered record content when a diagnostic retry cannot read the file', async () => {
    const source = new Source();
    const path = `projects/2026/${project}.md`;
    source.files['projects/2026/index.yaml'] = `- id: ${project}\n  description: Review\n`;
    // Retain a real parser issue on a readable record for the retry control.
    source.files[path] = '---\nname: Review\ncreated: 2026-10-04T09:00\nended: nonsense\n---\nUseful recovered project.';
    const { api, body } = await setup(source);
    await api.applyView({ filter: { type: 'project', id: project }, doc: { kind: 'detail' } });
    const retry = body.querySelector<HTMLButtonElement>('.history-retry')!;
    expect(retry).not.toBeNull();
    source.failures.add(path); retry.focus(); retry.click();
    await vi.waitFor(() => expect(retry.disabled).toBe(false));
    expect(document.activeElement).toBe(retry);
    expect(body.textContent).toContain('Useful recovered project.');
    expect(body.textContent).toContain('500 Internal Server Error');
  });

  it('can retry a missing supporting file after it is created', async () => {
    const { source, api, body } = await setup();
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/new.md' } });
    expect(body.textContent).toContain('Asset file not found: assets/new.md');
    source.files['assets/new.md'] = 'Newly created supporting document.';
    body.querySelector<HTMLButtonElement>('.history-retry')!.click();
    await vi.waitFor(() => expect(body.textContent).toContain('Newly created supporting document.'));
  });

  it.each([
    { extension: 'png', tag: 'img' }, { extension: 'wav', tag: 'audio' },
    { extension: 'mp4', tag: 'video' }, { extension: 'pdf', tag: 'iframe' },
    { extension: 'html', tag: 'iframe' }, { extension: 'htm', tag: 'iframe' },
  ])('recovers missing $extension media through metadata without reading binary bytes as text', async ({ extension, tag }) => {
    const source = new MediaSource(), path = `assets/missing.${extension}`;
    const { api, body, store, refresh } = await setup(source);
    await api.applyView({ filter: null, doc: { kind: 'asset', path } });
    const route = location.pathname;
    expect(body.textContent).toContain(`${source.assetUrl(path)}: 404 Not Found`);
    const retry = body.querySelector<HTMLButtonElement>('.history-retry')!;
    expect(retry.getAttribute('aria-label')).toBe(`Retry ${path}`);
    retry.focus(); source.metadata.set(path, 'etag:repaired'); retry.click();
    await vi.waitFor(() => expect(body.querySelector(tag)).not.toBeNull());
    expect(body.querySelector(tag)?.getAttribute('src')).toContain('aside_revision=1');
    expect(store.diagnosticsFor(path)).toBeUndefined(); expect(source.reads).not.toContain(path);
    expect(source.checks).toEqual([path, path]);
    expect(location.pathname).toBe(route);
    expectPanelFocus(body);
    await refresh(); expect(source.checks).toEqual([path, path]);
  });

  it('retains failed media metadata reason and retries the exact selected artifact attachment', async () => {
    const source = new MediaSource(), filename = 'report.png', path = `artifacts/2026/${artifact}/${filename}`;
    source.files[`artifacts/2026/${artifact}.md`] = '---\nname: Report\ncreated: 2026-10-04T09:00\nattachments: [report.png]\n---';
    source.metadataFailures.add(path);
    const { api, body } = await setup(source);
    await api.applyView({ filter: null, doc: { kind: 'artifact', id: artifact, filename } });
    expect(body.textContent).toContain(`${source.assetUrl(path)}: 500 Internal Server Error`);
    const failed = body.querySelector<HTMLButtonElement>('.history-retry')!; failed.click();
    await vi.waitFor(() => expect(body.querySelector('.history-retry')).not.toBe(failed));
    const retry = body.querySelector<HTMLButtonElement>('.history-retry')!;
    expect(retry.disabled).toBe(false); expect(body.querySelector('details')?.open).toBe(false);
    expect(body.textContent).toContain(`${source.assetUrl(path)}: 500 Internal Server Error`);
    source.metadataFailures.clear(); source.metadata.set(path, 'etag:repaired'); retry.click();
    await vi.waitFor(() => expect(body.querySelector('img')).not.toBeNull());
    expect(source.checks.every(file => file === path)).toBe(true); expect(source.reads).not.toContain(path);
  });

  it.each(['artifact', 'attachment', 'relative'])('refreshes an embedded webpage and sibling resources (%s)', async mode => {
    const source = new MediaSource();
    const page = `artifacts/2026/${artifact}/index.html`, css = `artifacts/2026/${artifact}/styles.css`;
    source.files[`artifacts/2026/${artifact}.md`] = '---\nname: Dashboard\ncreated: 2026-10-04T09:00\nattachments: [index.html, styles.css]\n---\n'
      + `Dashboard.\n\n<iframe src="#artifact/${artifact}/index.html" title="Dashboard"></iframe>`;
    source.files['assets/embed.md'] = `Page.\n\n<iframe src="../${page}" title="Dashboard"></iframe>`;
    source.metadata.set(page, 'etag:html'); source.metadata.set(css, 'etag:css-1');
    const { api, store, body, control } = await setup(source);
    const doc: DocRef = mode === 'relative' ? { kind: 'asset', path: 'assets/embed.md' }
      : { kind: 'artifact', id: artifact, ...(mode === 'attachment' ? { filename: 'index.html' } : {}) };
    await api.applyView({ filter: null, doc });
    const hot = api.currentHotSet();
    expect(hot.assets).toContain(page); expect(hot.assets).toContain(css);
    expect(hot.entities).toContainEqual({ kind: 'artifact', id: artifact });
    const baseline = await store.check('light', hot);
    if (baseline) await api.applyDataUpdate(baseline);
    for (const [path, version] of [[css, 'etag:css-2'], [page, 'etag:html-2']]) {
      const frame = body.querySelector('iframe')!, route = location.pathname;
      expect(frame).not.toBeNull();
      body.scrollTop = 55; control.focus(); source.metadata.set(path, version);
      const update = await store.check('light', api.currentHotSet(), [path]);
      expect(update?.summary.assets.has(path)).toBe(true);
      await api.applyDataUpdate(update!);
      expect(body.querySelector('iframe')).not.toBe(frame);
      expect(body.querySelector('iframe')?.getAttribute('src')).toContain('index.html');
      expect(body.scrollTop).toBe(55); expect(location.pathname).toBe(route);
      expect(document.activeElement).toBe(control);
    }
    expect(source.reads).not.toContain(page); expect(source.reads).not.toContain(css);
  });

  it.each(['png', 'wav', 'mp4'])('surfaces native %s preview errors after successful metadata and recovers with a fresh URL', async extension => {
    const source = new MediaSource(), path = `assets/unreadable.${extension}`; source.metadata.set(path, 'etag:bytes');
    const { api, body, store } = await setup(source);
    await api.applyView({ filter: null, doc: { kind: 'asset', path } });
    const media = body.querySelector<HTMLElement>('.asset-media')!;
    if (extension !== 'png') { Object.defineProperty(media, 'error', { value: { code: 3 } }); media.focus(); }
    const oldUrl = media.getAttribute('src'); media.dispatchEvent(new Event('error'));
    expect(media.isConnected).toBe(false); expect(body.textContent).toContain(path);
    expect(body.textContent).toContain('decoded'); expect(body.querySelector('.data-file-notice')?.getAttribute('role')).toBeNull();
    const retry = body.querySelector<HTMLButtonElement>('.history-retry')!; retry.focus(); retry.click();
    await vi.waitFor(() => expect(body.querySelector('.asset-media')).not.toBeNull());
    expect(body.querySelector('.asset-media')?.getAttribute('src')).not.toBe(oldUrl);
    expect(store.diagnosticsFor(path)).toBeUndefined(); expect(document.activeElement).toBe(body.querySelector('.entity-title'));
    expect(source.reads).not.toContain(path);
  });

  it('discards native errors and delayed media Retry after a newer document navigation', async () => {
    const source = new MediaSource(), path = 'assets/previous.png'; source.metadata.set(path, 'etag:old');
    const { api, body, store } = await setup(source);
    await api.applyView({ filter: null, doc: { kind: 'asset', path } });
    const old = body.querySelector('img')!; old.dispatchEvent(new Event('error'));
    let finish!: (version: string) => void; source.metadataDeferred.set(path, new Promise(resolve => { finish = resolve; }));
    body.querySelector<HTMLButtonElement>('.history-retry')!.click();
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/later.md' } });
    old.dispatchEvent(new Event('error')); finish('etag:repaired');
    await vi.waitFor(() => expect(store.diagnosticsFor(path)).toBeUndefined());
    expect(body.textContent).toContain('Newer document wins.'); expect(body.querySelector('img')).toBeNull();
    expect(location.pathname).toBe('/work/asset/assets/later.md');
  });

  it('names the document in its failure toast', async () => {
    const { source, api } = await setup(); source.failures.add('assets/failed.md');
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/failed.md' } });
    expect(document.querySelector('#action-toast')?.textContent).toBe('Could not load this document. Try again.');
  });

  it('names the document in its delayed loading status', async () => {
    const source = new Source(), path = 'assets/delayed.md';
    let finish!: (file: FileRead) => void;
    source.deferred.set(path, new Promise(resolve => { finish = resolve; }));
    const { api, body } = await setup(source);
    const opening = api.applyView({ filter: null, doc: { kind: 'asset', path } });
    await vi.waitFor(() => expect(body.querySelector('.loading')).not.toBeNull());
    const status = body.querySelector('.loading')!.textContent;
    finish({ text: 'Loaded.', version: 'ready' }); await opening;
    expect(status).toBe('Loading document…');
  });

  it('uses metadata for global diagnostic Retry and ignores an older metadata failure after repair', async () => {
    const source = new MediaSource(), path = 'assets/report.pdf', { api, store } = await setup(source);
    let fail!: (error: Error) => void; source.metadataDeferred.set(path, new Promise((_, reject) => { fail = reject; }));
    const old = store.prepareAssetUrl(path); source.metadataDeferred.delete(path); source.metadata.set(path, 'etag:new');
    await api.retryReadableFile(store, path); fail(new Error('Obsolete failure')); await expect(old).rejects.toThrow('Obsolete failure');
    expect(store.diagnosticsFor(path)).toBeUndefined(); expect(source.reads).not.toContain(path);
    expect(store.assetUrl(path)).toContain('aside_revision=1');
  });
});
