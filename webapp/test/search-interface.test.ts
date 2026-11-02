// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import type { DataSource } from '../lib/io';
import type { EntityRef } from '../lib/types';
import { loadApp } from './app-harness';

interface App {
  state: { store: Store | null; instanceId: string | null; filter: EntityRef | null; panelCollapsed: boolean };
  setupSearch(): void;
  handleSearch(query: string): void;
  setSearchVisible(visible: boolean): void;
  resetSearch(clearInput: boolean): void;
  dismissActionToast(): void;
}

const dismissToasts: (() => void)[] = [];
afterEach(() => { for (const dismiss of dismissToasts.splice(0)) dismiss(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear(); });

describe('search combobox state', () => {
  async function setup() {
    const markup = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const shell = new DOMParser().parseFromString(markup, 'text/html');
    document.body.innerHTML = shell.querySelector('.search-wrapper')!.outerHTML + '<button id="outside">Outside</button>';
    const files: Record<string, string> = { 'aside.md': '---\nid: work\nname: Work\n---\n' };
    files['projects/2026/index.yaml'] = Array.from({ length: 10 }, (_, i) => `- id: 2026-10-04-program-${i}\n  description: Program ${i}`).join('\n');
    for (let i = 0; i < 10; i++) files[`projects/2026/2026-10-04-program-${i}.md`] = `---\nname: Release program ${i}\ncreated: 2026-10-04T09:00\n---\n`;
    const source: DataSource = {
      async read(path) { return files[path] === undefined ? null : { text: files[path], version: files[path] }; },
      async revalidate() { return 'unchanged'; }, assetUrl() { return null; }, async listYears() { return ['2026']; },
    };
    const store = new Store(source); await store.init();
    const api = await loadApp<App>('state, setupSearch, handleSearch, setSearchVisible, resetSearch, dismissActionToast');
    api.state.store = store; api.state.instanceId = 'work'; api.state.panelCollapsed = true;
    dismissToasts.push(api.dismissActionToast); api.setupSearch();
    const input = document.querySelector<HTMLInputElement>('.search-input')!;
    const popup = document.getElementById('search-results')!, listbox = document.getElementById('search-listbox')!;
    input.focus();
    const query = (value: string) => { input.value = value; api.handleSearch(value); };
    const key = (value: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
    return { api, store, input, popup, listbox, query, key };
  }

  it('uses a stable controlled listbox and keeps arrow-selected options owned and named', async () => {
    const { input, popup, listbox, query, key } = await setup();
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    query('program'); key('ArrowDown');
    expect(popup.hidden).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const active = document.getElementById(input.getAttribute('aria-activedescendant')!)!;
    expect(listbox.contains(active)).toBe(true);
    expect(active.getAttribute('role')).toBe('option');
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Projects');
    expect(listbox.querySelectorAll('[aria-selected="false"]')).toHaveLength(8);
    query('program');
    expect(document.getElementById('search-listbox')).toBe(listbox);
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.dataset.key).toBe(active.dataset.key);
  });

  it('clears hidden active state on Escape and reopens with valid owned selection by arrow key', async () => {
    const { api, input, popup, listbox, query, key } = await setup();
    query('program'); key('ArrowDown');
    expect(key('Escape')).toBe(false);
    expect(input.value).toBe('program');
    expect(popup.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    const filter = api.state.filter, route = location.pathname;
    key('Enter');
    expect(api.state.filter).toBe(filter);
    expect(location.pathname).toBe(route);
    expect(popup.hidden).toBe(true);
    key('ArrowDown');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(listbox.contains(document.getElementById(input.getAttribute('aria-activedescendant')!))).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it('keeps +N expansion and result activation coherent with popup state', async () => {
    const { api, input, listbox, query, key } = await setup();
    query('program'); key('ArrowUp');
    const more = document.getElementById(input.getAttribute('aria-activedescendant')!)!;
    expect(more.dataset.key).toBe('more:project');
    key('Enter');
    expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(10);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    key('ArrowDown'); key('Enter');
    expect(api.state.filter?.type).toBe('project');
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(document.getElementById('search-listbox')).toBe(listbox);
  });

  it('keeps Retry outside the listbox and synchronizes blur, reopening and empty state', async () => {
    const { store, input, popup, listbox, query, key } = await setup();
    vi.spyOn(store, 'getSearchProgress').mockReturnValue({ loaded: 9, total: 10, pending: 0, complete: false, failures: ['projects/2026/missing.md'] });
    query('program'); key('ArrowDown');
    const retry = popup.querySelector<HTMLButtonElement>('button')!;
    expect(retry.closest('[role="listbox"]')).toBeNull();
    retry.focus();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    document.getElementById('outside')!.focus();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    input.focus();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    query('no-such-record');
    expect(listbox.querySelector('[role="option"]')).toBeNull();
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(popup.querySelector('[role="status"]')).not.toBeNull();
  });

  it('toasts failed manual search retries while background indexing stays quiet', async () => {
    const { store, input, popup, query } = await setup();
    vi.spyOn(store, 'getSearchProgress').mockReturnValue({ loaded: 9, total: 10, pending: 0, complete: false, failures: ['projects/2026/missing.md'] });
    vi.spyOn(store, 'warmSearch').mockResolvedValue(undefined);
    query('program');
    expect(document.querySelector('#action-toast')).toBeNull();
    popup.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(document.querySelector('#action-toast')?.textContent).toBe('Could not load all search text. Try again.'));
    expect(document.activeElement).toBe(input);
  });

  it('does not reopen a dismissed popup from a pending debounced query and reruns that query on focus', async () => {
    const { input, popup, query, key } = await setup();
    vi.useFakeTimers();
    query('program'); key('ArrowDown');
    input.value = 'program 7'; input.dispatchEvent(new Event('input', { bubbles: true }));
    key('Escape');
    await vi.advanceTimersByTimeAsync(250);
    expect(popup.hidden).toBe(true);
    document.getElementById('outside')!.focus(); input.focus();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(popup.querySelectorAll('[role="option"]')).toHaveLength(1);
  });

  it('cancels an initial debounce on Escape without consuming the existing global Escape levels', async () => {
    const { input, popup, key } = await setup();
    vi.useFakeTimers();
    input.value = 'program'; input.dispatchEvent(new Event('input', { bubbles: true }));
    // Observe the input handler before the document handles its existing
    // reader/filter Escape levels.
    let prevented: boolean | undefined;
    input.addEventListener('keydown', event => { prevented = event.defaultPrevented; event.stopPropagation(); }, { once: true });
    key('Escape');
    expect(prevented).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(popup.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });
  it('leaves context/auxiliary presses alone and activates on an ordinary click rather than mouse-down', async () => {
    const { api, input, popup, listbox, query, key } = await setup();
    query('program'); key('ArrowDown');
    const option = listbox.querySelector<HTMLElement>('[role="option"]')!;
    const filter = api.state.filter, route = location.pathname, active = input.getAttribute('aria-activedescendant');
    for (const init of [{ button: 2 }, { button: 1 }, { button: 0, ctrlKey: true }]) {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, ...init }));
      option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
      expect(api.state.filter).toBe(filter); expect(location.pathname).toBe(route);
      expect(input.value).toBe('program'); expect(popup.hidden).toBe(false);
      expect(input.getAttribute('aria-activedescendant')).toBe(active);
    }
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(api.state.filter).toBe(filter);
    option.click();
    expect(api.state.filter?.type).toBe('project');
    expect(input.value).toBe(''); expect(popup.hidden).toBe(true);
  });
});
