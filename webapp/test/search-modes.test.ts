// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreView } from '../../cli/src/core/data-snapshot';
import type { WebQueryResult } from '../../cli/src/core/web-query';
import { createSearchUi } from '../src/search-ui';
import { remoteSearch, type SearchQuery } from '../src/search-remote';
import type { RenderOptions } from '../src/render';

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

const semantic = (hits: object[]): WebQueryResult => ({ data: { search: { model: 'local-test', indexedChunks: 3, hits, totalCount: hits.length, count: hits.length, offset: 0 } } });
const hit = (kind: string, id: string) => ({ kind, id, name: `Name ${id}`, snippet: 'Evidence <script>unsafe()</script>' });
const ordered = (hits: object[]): WebQueryResult => ({ data: { search: { model: null, indexedChunks: 0, hits, totalCount: hits.length, count: hits.length, offset: 0 } } });
const emptyRegex = (): WebQueryResult => ordered([]);

function setup(query: SearchQuery) {
  document.body.innerHTML = `<div class="search-wrapper">
    <select id="search-mode"><option value="text">Text</option><option value="regex">Regex</option><option value="semantic">Semantic</option></select>
    <input class="search-input"><span id="search-help"></span><div id="search-results" hidden><div id="search-listbox"></div></div>
  </div><button id="outside">Outside</button>`;
  const source = {
    getNoteIndex: () => [], getProjectIndex: () => [], getActionIndex: () => [], getArtifactIndex: () => [],
    getCachedEntryContents: () => new Map(), getCachedArtifactContents: () => new Map(),
    getSearchProgress: () => ({ complete: true }), getCachedArtifact: () => undefined,
  } as unknown as StoreView;
  let current = source;
  const onSelect = vi.fn();
  const ui = createSearchUi({ store: () => current, query, onSelect, renderOpts: () => ({ resolveName: (_type: string, id: string) => id, refMarks: () => [] }) as unknown as RenderOptions });
  ui.setupSearch();
  const input = document.querySelector<HTMLInputElement>('.search-input')!;
  const select = document.querySelector<HTMLSelectElement>('#search-mode')!;
  const popup = document.querySelector<HTMLElement>('#search-results')!;
  const choose = (mode: string) => { select.value = mode; select.dispatchEvent(new Event('change')); };
  const search = (text: string) => { input.value = text; ui.handleSearch(text); };
  return { ui, input, select, popup, choose, search, onSelect, switchSource: () => { current = { ...source }; ui.resetSearch(true); } };
}

describe('explicit search modes', () => {
  it('keeps Text local and sends semantic language verbatim without regex interpretation', async () => {
    const query = vi.fn<SearchQuery>().mockResolvedValue(semantic([hit('PROJECT', 'p1')]));
    const { choose, search, input, popup } = setup(query);
    search('project:release 2026-01..2026-02');
    expect(query).not.toHaveBeenCalled();
    choose('semantic');
    await vi.waitFor(() => expect(popup.querySelector('[data-key="project:p1"]')).not.toBeNull());
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].variables).toEqual({ query: 'project:release 2026-01..2026-02' });
    expect(query.mock.calls[0][0].query).toContain('search(rankBy: {semantic: $query}, limit: 20)');
    expect(query.mock.calls[0][0].query).not.toContain('semanticSearch');
    expect(input.placeholder).toContain('Describe');
    expect(popup.textContent).toContain('regex and Text syntax do not apply');
  });

  it('preserves global semantic rank, renders evidence safely, and navigates by source identity', async () => {
    const query = vi.fn<SearchQuery>().mockResolvedValue(semantic([hit('ACTION', 'a1'), hit('PROJECT', 'p1'), hit('ARTIFACT', 'd1')]));
    const { choose, search, popup, input, onSelect } = setup(query);
    choose('semantic'); search('release preparation');
    await vi.waitFor(() => expect(popup.querySelectorAll('[role="option"]')).toHaveLength(3));
    expect([...popup.querySelectorAll<HTMLElement>('[role="option"]')].map(row => row.dataset.key)).toEqual(['action:a1', 'project:p1', 'artifact:d1']);
    expect(popup.querySelector('[role="group"]')).toBeNull();
    expect(popup.querySelector('script')).toBeNull();
    expect(popup.textContent).toContain('Evidence <script>unsafe()</script>');
    expect(popup.textContent).toContain('local-test');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onSelect.mock.calls[0][0]).toMatchObject({ type: 'action', id: 'a1' });
    expect(input.value).toBe(''); expect(popup.hidden).toBe(true);
  });

  it('uses the regex operation without Text parsing and reports invalid patterns without fallback', async () => {
    const query = vi.fn<SearchQuery>().mockResolvedValue({ errors: [{ message: 'Invalid regex: [' }] });
    const { choose, search, popup } = setup(query);
    choose('regex'); search('[');
    await vi.waitFor(() => expect(popup.querySelector('[role="alert"]')?.textContent).toBe('Regex search failed.'));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].variables).toEqual({ pattern: '[' });
    for (const group of ['entries', 'projects', 'actions', 'artifacts']) expect(query.mock.calls[0][0].query).toContain(`${group}: {regex: $pattern}`);
    expect(query.mock.calls[0][0].query).toContain('rankBy: {order: CREATED_DESC}, limit: 20');
    expect(popup.textContent).toContain('Invalid regex: [');
    expect(popup.querySelector('[role="option"]')).toBeNull();
  });

  it('preserves global regex ordering across types instead of regrouping by type', async () => {
    const query = vi.fn<SearchQuery>().mockResolvedValue(ordered([hit('ACTION', 'new-action'), hit('ENTRY', '2026-10-28T11:00'), hit('PROJECT', 'older-project')]));
    const { choose, search, popup } = setup(query);
    choose('regex'); search('release|deploy');
    await vi.waitFor(() => expect(popup.querySelectorAll('[role="option"]')).toHaveLength(3));
    expect([...popup.querySelectorAll<HTMLElement>('[role="option"]')].map(row => row.dataset.key)).toEqual(['action:new-action', 'entry:2026-10-28T11:00', 'project:older-project']);
    expect(popup.querySelector('[role="group"]')).toBeNull();
    expect(popup.textContent).toContain('Newest matches across all types');
    expect(popup.textContent).not.toContain('per type');
  });

  it('renders an empty semantic page without a null model label', async () => {
    const query = vi.fn<SearchQuery>().mockResolvedValue(ordered([]));
    const { choose, search, popup } = setup(query);
    choose('semantic'); search('release plan');
    await vi.waitFor(() => expect(popup.textContent).toContain('No results'));
    expect(popup.textContent).toContain('Ranked by meaning');
    expect(popup.textContent).not.toMatch(/null|undefined|indexed chunks/);
  });

  it('aborts and discards old responses after a mode change, even when the transport ignores cancellation', async () => {
    let finish!: (value: WebQueryResult) => void;
    const query = vi.fn<SearchQuery>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(emptyRegex());
    const { choose, search, popup } = setup(query);
    choose('semantic'); search('release');
    const signal = query.mock.calls[0][1];
    choose('regex');
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(popup.textContent).toContain('No results'));
    finish(semantic([hit('PROJECT', 'stale')]));
    await Promise.resolve(); await Promise.resolve();
    expect(popup.querySelector('[data-key="project:stale"]')).toBeNull();
    expect(popup.textContent).toContain('Regex:');
  });

  it.each(['dismiss', 'source', 'typing'] as const)('prevents a pending response from reopening results after %s', async action => {
    let finish!: (value: WebQueryResult) => void;
    const query = vi.fn<SearchQuery>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { choose, search, popup, input, ui, switchSource } = setup(query);
    choose('semantic'); search('release');
    const signal = query.mock.calls[0][1];
    if (action === 'dismiss') ui.setSearchVisible(false);
    else if (action === 'source') switchSource();
    else { input.value = 'changed'; input.dispatchEvent(new Event('input')); }
    expect(signal.aborted).toBe(true);
    finish(semantic([hit('PROJECT', 'stale')]));
    await Promise.resolve(); await Promise.resolve();
    expect(popup.hidden).toBe(true);
    expect(popup.querySelector('[role="option"]')).toBeNull();
    ui.resetSearch(true);
  });

  it('shows an explicit semantic error with Retry and keeps both controls disabled without an instance', async () => {
    const query = vi.fn<SearchQuery>().mockRejectedValue(new Error('Semantic search is disabled.'));
    const { choose, search, popup, ui, input, select } = setup(query);
    choose('semantic'); search('release');
    await vi.waitFor(() => expect(popup.textContent).toContain('Semantic search is disabled.'));
    expect(popup.querySelector('button')?.textContent).toBe('Retry');
    expect(query).toHaveBeenCalledTimes(1);
    ui.setSearchEnabled(false);
    expect(input.disabled).toBe(true); expect(select.disabled).toBe(true); expect(popup.hidden).toBe(true);
  });
});

describe('remote search response boundaries', () => {
  it('rejects partial GraphQL errors without presenting a successful empty result', async () => {
    const query: SearchQuery = async () => ({ ...emptyRegex(), errors: [{ message: 'Search budget exceeded' }] });
    await expect(remoteSearch('regex', 'test', query, new AbortController().signal)).rejects.toThrow('Search budget exceeded');
  });
});
