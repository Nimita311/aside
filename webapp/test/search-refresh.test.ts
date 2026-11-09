// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataSnapshot, PendingUpdate, StoreView } from '../../cli/src/core/data-snapshot';
import { RemoteStore, type SnapshotSource } from '../lib/remote-store';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';

interface App {
  state: {store: StoreView | null; instanceId: string | null; filter: null; doc: null; panelCollapsed: boolean};
  setupSearch(): void;
  handleSearch(query: string): void;
  resetSearch(clear: boolean): void;
  applyDataUpdate(update: PendingUpdate): Promise<void>;
  searchUi: {watchSearchCorpus(source: StoreView): () => void};
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear();
});

async function setup(mode: 'text' | 'regex' | 'semantic') {
  document.body.innerHTML = `<div class="search-wrapper">
    <select id="search-mode"><option value="text">Text</option><option value="regex">Regex</option><option value="semantic">Semantic</option></select>
    <input class="search-input"><span id="search-help"></span><div id="search-results" hidden><div id="search-listbox"></div></div>
  </div>`;
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
  let data = snapshotFixture(), version = 1;
  const source: SnapshotSource = {
    snapshot: async prior => prior === String(version) ? 'unchanged' : {value: structuredClone(data), version: String(version)},
    read: vi.fn(), revalidate: vi.fn(), assetUrl: () => null,
  };
  const store = new RemoteStore(source); await store.init();
  const api = await loadApp<App>('state, setupSearch, handleSearch, resetSearch, applyDataUpdate, searchUi');
  api.state.store = store; api.state.instanceId = 'work'; api.state.filter = null; api.state.doc = null; api.state.panelCollapsed = true;
  api.setupSearch();
  cleanups.push(api.searchUi.watchSearchCorpus(store), () => api.resetSearch(true));
  const input = document.querySelector<HTMLInputElement>('.search-input')!;
  const select = document.querySelector<HTMLSelectElement>('#search-mode')!;
  select.value = mode;
  const search = (text: string) => { input.value = text; api.handleSearch(text); };
  const change = (edit: (next: DataSnapshot) => void) => { data = structuredClone(data); edit(data); version++; };
  const flushFrames = () => { while (frames.length) frames.shift()!(performance.now()); };
  return {api, store, source, fetch, frames, input, select, search, change, flushFrames};
}

describe('search refresh ownership', () => {
  it.each(['regex', 'semantic'] as const)('refreshes %s once for an applied source snapshot without cancelling the replacement request', async mode => {
    const {api, store, fetch, search, change, flushFrames} = await setup(mode);
    search('Good');
    expect(fetch).toHaveBeenCalledTimes(1);
    const original = fetch.mock.calls[0][1]!.signal!;
    change(data => { data.projects[0][1].body = 'Updated project text.'; });
    const update = await store.check('full', {weeks: [], entities: [], assets: []});
    expect(update).not.toBeNull();
    await api.applyDataUpdate(update!);
    expect(original.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const replacement = fetch.mock.calls[1][1]!.signal!;
    flushFrames();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(replacement.aborted).toBe(false);
  });

  it.each(['regex', 'semantic'] as const)('does not restart %s for supporting-file diagnostic notifications', async mode => {
    const {store, fetch, search, flushFrames} = await setup(mode);
    search('Good');
    const request = fetch.mock.calls[0][1]!.signal!;
    store.reportAssetFailure('assets/unavailable.pdf', new Error('Offline'));
    flushFrames();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(request.aborted).toBe(false);
  });

  it('still refreshes local Text results after corpus updates without a network search', async () => {
    const {store, fetch, search, change, flushFrames} = await setup('text');
    search('needle');
    expect(document.querySelector('[role="option"]')).toBeNull();
    change(data => { data.weeks[0][1][0].content = 'A newly available needle.'; });
    await store.reloadFile('notes/2026/2026-09-28.md');
    flushFrames();
    expect(document.querySelector('[data-key="entry:2026-10-04T10:00"]')).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not let a queued Text refresh restart a newly selected Semantic request', async () => {
    const {store, fetch, search, change, select, flushFrames, frames} = await setup('text');
    search('needle');
    change(data => { data.weeks[0][1][0].content = 'needle'; });
    await store.reloadFile('notes/2026/2026-09-28.md');
    expect(frames).toHaveLength(1);
    select.value = 'semantic'; select.dispatchEvent(new Event('change'));
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0][1]!.signal!;
    flushFrames();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(request.aborted).toBe(false);
  });
});
