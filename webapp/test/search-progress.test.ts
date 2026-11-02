// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import { search } from '../src/search';
import { watchActiveSearch } from '../src/search-progress';
import type { DataSource, FileRead } from '../lib/io';
const WEEK = 'notes/2026/2026-05-18.md';
const body = '---\nweek: 21\nweek_start: 2026-05-18\nweek_end: 2026-05-24\n---\n\n---\n```entry\ncreated: 2026-05-22T15:30\n```\nneedle hidden in this note body';
class Source implements DataSource {
  failing = false;
  constructor(public files: Record<string, string> = { 'aside.md': '---\nid: work\nname: Work\n---', 'notes/2026/index.yaml': '- id: 2026-05-22T15:30\n  description: A note', [WEEK]: body }) {}
  async read(path: string): Promise<FileRead | null> { if (this.failing && path === WEEK) throw new Error('Offline'); const text = this.files[path]; return text === undefined ? null : { text, version: text }; }
  async revalidate(path: string, version: string) { const read = await this.read(path); return read?.version === version ? 'unchanged' as const : read; }
  async listYears() { return ['2026']; }
  assetUrl() { return null; }
}
afterEach(() => vi.useRealTimers());
describe('body search warming', () => {
  it('publishes newly searchable contents and completion without another keystroke', async () => {
    vi.useFakeTimers();
    const store = new Store(new Source()); await store.init();
    let matches: string[] = [];
    const refresh = vi.fn(query => { matches = search(query, store.getNoteIndex(), [], [], { entryContents: store.getCachedEntryContents() }).results.map(result => result.id); });
    const stop = watchActiveSearch(store, { query: () => 'needle', activeQuery: () => 'needle', visible: () => true, refresh });
    expect(store.getSearchProgress().complete).toBe(false);
    await store.warmSearch(); await vi.advanceTimersByTimeAsync(30);
    expect(matches).toEqual(['2026-05-22T15:30']); expect(refresh).toHaveBeenCalled(); expect(store.getSearchProgress()).toMatchObject({ loaded: 1, total: 1, pending: 0, complete: true }); stop();
  });
  it('does not reopen dismissed results or refresh an obsolete query or instance subscription', async () => {
    vi.useFakeTimers();
    const store = new Store(new Source()); await store.init();
    let query = 'needle', visible = true;
    const refresh = vi.fn(); const stop = watchActiveSearch(store, { query: () => query, activeQuery: () => 'needle', visible: () => visible, refresh });
    await store.warmSearch(); visible = false; await vi.advanceTimersByTimeAsync(30); expect(refresh).not.toHaveBeenCalled();
    visible = true; query = 'other'; await store.reloadFile(WEEK); await vi.advanceTimersByTimeAsync(30); expect(refresh).not.toHaveBeenCalled();
    query = 'needle'; await store.reloadFile(WEEK); stop(); await vi.advanceTimersByTimeAsync(30); expect(refresh).not.toHaveBeenCalled();
  });
  it('keeps read and parse failures incomplete and repairs them through explicit retry', async () => {
    const source = new Source(); const store = new Store(source); await store.init(); source.failing = true;
    await store.warmSearch(); expect(store.getSearchProgress()).toMatchObject({ loaded: 0, total: 1, pending: 0, complete: false });
    expect(store.getSearchProgress().failures).toContain(WEEK);
    source.failing = false; await store.warmSearch(true); expect(store.getSearchProgress().complete).toBe(true);
    source.files[WEEK] = body + '\n\n---\n```entry\ncreated: 2026-05-19T10:00'; await store.reloadFile(WEEK);
    expect(store.getSearchProgress()).toMatchObject({ loaded: 1, complete: false });
    source.files[WEEK] = body; await store.warmSearch(true); expect(store.getSearchProgress().complete).toBe(true);
  });
  it('keeps supporting attachment reads and failures outside search completeness and Retry', async () => {
    const source = new Source(), store = new Store(source); await store.init(); await store.warmSearch();
    const original = source.read.bind(source); let fail!: (error: Error) => void;
    const reads = vi.spyOn(source, 'read').mockImplementation(path => path === 'assets/missing.md'
      ? new Promise<FileRead>((_, reject) => { fail = reject; }) : original(path));
    const attachment = store.getAsset('assets/missing.md');
    expect(store.getSearchProgress()).toMatchObject({ complete: true, pending: 0, failures: [] });
    fail(new Error('Attachment unavailable')); await expect(attachment).rejects.toThrow('Attachment unavailable');
    expect(store.diagnosticsFor('assets/missing.md')?.error).toBe('Attachment unavailable');
    expect(store.getSearchProgress()).toMatchObject({ complete: true, pending: 0, failures: [] });
    reads.mockClear(); await store.warmSearch(true);
    expect(reads).not.toHaveBeenCalledWith('assets/missing.md');
    expect(store.diagnosticsFor('assets/missing.md')).toBeDefined();
    expect(store.getSearchProgress().complete).toBe(true);
  });
  it('still treats manifest and discovery-index diagnostics as incomplete when no rows recover', async () => {
    const source = new Source({ 'aside.md': '---\nname: [\n---', 'notes/2026/index.yaml': 'not: [valid' });
    const store = new Store(source); await store.init(); await store.warmSearch();
    expect(store.getSearchProgress()).toMatchObject({ loaded: 0, total: 0, complete: false });
    expect(store.getSearchProgress().failures).toEqual(expect.arrayContaining(['aside.md', 'notes/2026/index.yaml']));
  });
});
