// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import type { DataSource } from '../lib/io';
import { createSearchUi } from '../src/search-ui';
import type { RenderOptions } from '../src/render';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });

async function setup() {
  const markup = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const shell = new DOMParser().parseFromString(markup, 'text/html');
  document.body.innerHTML = shell.querySelector('.search-wrapper')!.outerHTML + '<button id="outside">Outside</button>';
  const files: Record<string, string> = {
    'aside.md': '---\nid: work\nname: Work\n---\n',
    'actions/2026/index.yaml': '- id: 2026-10-04-release\n  description: Release checklist',
    'actions/2026/2026-10-04-release.md': '---\nname: Release checklist\ncreated: 2026-10-04T09:00\n---\n',
  };
  const source: DataSource = {
    async read(path) { return files[path] === undefined ? null : { text: files[path], version: files[path] }; },
    async revalidate() { return 'unchanged'; }, assetUrl() { return null; }, async listYears() { return ['2026']; },
  };
  const store = new Store(source); await store.init();
  vi.spyOn(store, 'getSearchProgress').mockReturnValue({ complete: true, loaded: 1, total: 1, pending: 0, failures: [] });
  let context: { label: string; term: string } | null = { label: 'Entries · Aurora', term: 'rollback' };
  const onSelect = vi.fn(), onFlowSearch = vi.fn();
  const opts: RenderOptions = {
    now: '2026-10-04T10:00', nowDate: new Date('2026-10-04T10:00'), timeFormat: '24h',
    expandProjects: false, expandActions: false, activeFilter: null,
    resolveName: (_type, id) => id === '2026-10-04-release' ? 'Release checklist' : id,
    onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(), routeHref: route => route, refMarks: () => [],
  };
  const ui = createSearchUi({ store: () => store, renderOpts: () => opts, onSelect, flowSearch: () => context, onFlowSearch });
  ui.setupSearch();
  const input = document.querySelector<HTMLInputElement>('.search-input')!;
  const popup = document.getElementById('search-results')!, listbox = document.getElementById('search-listbox')!;
  const key = (value: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const query = (value: string) => { input.value = value; ui.handleSearch(value); };
  return { ui, store, input, popup, listbox, key, query, onSelect, onFlowSearch, setContext: (value: typeof context) => { context = value; } };
}

describe('flow search from the header', () => {
  it('offers the current flow before global matches without applying a draft', async () => {
    const { input, listbox, query, key, onSelect, onFlowSearch } = await setup();
    query('release');
    const options = listbox.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options).toHaveLength(2);
    expect(options[0].dataset.key).toBe('flow:search');
    expect(options[0].textContent).toBe('Search this flow for “release”Entries · Aurora');
    expect(options[1].dataset.key).toBe('action:2026-10-04-release');
    expect(onSelect).not.toHaveBeenCalled(); expect(onFlowSearch).not.toHaveBeenCalled();
    key('Enter');
    expect(onFlowSearch).toHaveBeenCalledExactlyOnceWith('release');
    expect(onSelect).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the flow option available with no global match and an incomplete index', async () => {
    const { store, listbox, popup, query, key, onFlowSearch } = await setup();
    vi.mocked(store.getSearchProgress).mockReturnValue({ complete: false, loaded: 1, total: 2, pending: 0, failures: ['notes/2026/missing.md'] });
    query('  action:no-such-record  ');
    const option = listbox.querySelector<HTMLElement>('[role="option"]')!;
    expect(option.dataset.key).toBe('flow:search');
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(popup.querySelector('button.history-retry')?.closest('[role="listbox"]')).toBeNull();
    key('Enter');
    expect(onFlowSearch).toHaveBeenCalledExactlyOnceWith('action:no-such-record');
  });

  it('allows keyboard navigation past the flow option to an ordinary result', async () => {
    const { input, listbox, query, key, onSelect, onFlowSearch } = await setup();
    query('release'); key('ArrowDown');
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.dataset.key).toBe('flow:search');
    key('ArrowDown');
    const active = document.getElementById(input.getAttribute('aria-activedescendant')!)!;
    expect(listbox.contains(active)).toBe(true);
    expect(active.dataset.key).toBe('action:2026-10-04-release');
    expect(active.getAttribute('aria-selected')).toBe('true');
    key('Enter');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'action', id: '2026-10-04-release' }));
    expect(onFlowSearch).not.toHaveBeenCalled();
  });

  it('dismisses only the lookup on Escape and reopens at the first option', async () => {
    const { input, popup, query, key, onFlowSearch } = await setup();
    query('release'); key('ArrowDown'); key('ArrowDown');
    expect(key('Escape')).toBe(false);
    expect(popup.hidden).toBe(true); expect(input.value).toBe('release');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    key('Enter'); expect(popup.hidden).toBe(true); expect(onFlowSearch).not.toHaveBeenCalled();
    key('ArrowDown');
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.dataset.key).toBe('flow:search');
  });

  it('does not expose flow search while another reading surface is active', async () => {
    const { setContext, listbox, query, key, onSelect, onFlowSearch } = await setup();
    setContext(null); query('release');
    expect(listbox.querySelector('[data-key="flow:search"]')).toBeNull();
    key('Enter');
    expect(onSelect).toHaveBeenCalledOnce(); expect(onFlowSearch).not.toHaveBeenCalled();
  });

  it('prefills the header for editing without changing the applied filter', async () => {
    const { ui, input, popup, listbox, onFlowSearch } = await setup();
    ui.editFlowSearch('rollback');
    expect(document.activeElement).toBe(input); expect(input.value).toBe('rollback');
    expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe('rollback'.length);
    expect(popup.hidden).toBe(false);
    expect(listbox.querySelector('[data-key="flow:search"]')?.textContent).toContain('“rollback”');
    expect(onFlowSearch).not.toHaveBeenCalled();
  });

  it('offers an empty-draft entry point that edits the applied term without clearing it', async () => {
    const { input, listbox, key, onFlowSearch } = await setup();
    input.focus();
    expect(listbox.querySelector('[role="option"]')?.textContent).toBe('Search this flowEntries · Aurora');
    key('Enter');
    expect(input.value).toBe('rollback'); expect(document.activeElement).toBe(input);
    expect(onFlowSearch).not.toHaveBeenCalled();
  });

  it('flushes the draft before applying Enter and never interprets it as global search syntax', async () => {
    const { input, key, onFlowSearch } = await setup();
    vi.useFakeTimers(); input.focus();
    input.value = 'action:release'; input.dispatchEvent(new Event('input', { bubbles: true }));
    key('Enter');
    expect(onFlowSearch).toHaveBeenCalledExactlyOnceWith('action:release');
    await vi.advanceTimersByTimeAsync(250);
    expect(onFlowSearch).toHaveBeenCalledOnce();
  });

  it('resets an old global selection when a changed draft is applied', async () => {
    const { input, query, key, onSelect, onFlowSearch } = await setup();
    vi.useFakeTimers(); query('release'); key('ArrowDown'); key('ArrowDown');
    input.value = 'release checklist'; input.dispatchEvent(new Event('input', { bubbles: true }));
    key('Enter');
    expect(onFlowSearch).toHaveBeenCalledExactlyOnceWith('release checklist');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('applies the latest draft when the flow option is clicked before debounce completes', async () => {
    const { input, listbox, query, onFlowSearch } = await setup();
    vi.useFakeTimers(); query('release');
    input.value = '  rollback plan  '; input.dispatchEvent(new Event('input', { bubbles: true }));
    listbox.querySelector<HTMLElement>('[data-key="flow:search"]')!.click();
    expect(onFlowSearch).toHaveBeenCalledExactlyOnceWith('rollback plan');
    await vi.advanceTimersByTimeAsync(250);
    expect(onFlowSearch).toHaveBeenCalledOnce();
    expect(input.value).toBe('');
  });

  it('edits the applied term when a pending draft is cleared before clicking the flow option', async () => {
    const { input, listbox, query, onFlowSearch } = await setup();
    vi.useFakeTimers(); query('release');
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    listbox.querySelector<HTMLElement>('[data-key="flow:search"]')!.click();
    expect(onFlowSearch).not.toHaveBeenCalled();
    expect(input.value).toBe('rollback');
    expect(document.activeElement).toBe(input);
  });
});
