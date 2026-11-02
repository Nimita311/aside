import { showActionFailure } from './toast';
import { showNotice, delayLoading, LOADING_DELAY_MS } from './notice';
import type { StoreView as Store } from '../../cli/src/core/data-snapshot';
import { activeModal } from './modal';
import { entityIcon, type RenderOptions } from './render';
import { search, highlight, type SearchOutput, type SearchResult, type SearchResultType } from './search';
import { bindDisplay, setDisplayText } from './display';
import { formatDate } from './date-display';
import { bindEntrySearchName } from './search-label';

// The search dropdown: the debounced query, results grouped and capped per
// type, keyboard navigation, and the combobox accessibility state. Where a
// chosen row leads is the app's decision (`onSelect`).

export interface SearchUiDeps {
  store(): Store | null;
  renderOpts(): RenderOptions;
  // A chosen row: a date to jump to, or an entity to navigate to.
  onSelect(result: SearchResult): void;
}

// Results render grouped in this order, each group capped until its "+N more"
// row expands it — a broad query can't flood the dropdown.
const SEARCH_GROUPS: { type: SearchResultType; label: string; cap: number }[] = [
  { type: 'date', label: 'Dates', cap: 3 },
  { type: 'project', label: 'Projects', cap: 8 },
  { type: 'action', label: 'Actions', cap: 8 },
  { type: 'artifact', label: 'Artifacts', cap: 8 },
  { type: 'entry', label: 'Entries', cap: 20 },
];

export function createSearchUi({ store, renderOpts, onSelect }: SearchUiDeps) {
  const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
  const resultsElement = () => document.getElementById('search-results');
  const isSearchVisible = (): boolean => { const results = resultsElement(); return !!results && !results.hidden; };

  // Dropdown state: the rendered selectable rows (results plus "+N more"
  // expanders) with their activations for keyboard navigation, the last search
  // output (so expanding a group re-renders without re-searching), the groups
  // expanded past their cap, and the query those belong to.
  let searchSelectables: { el: HTMLElement; activate: () => void }[] = [];
  let searchActive = -1;
  let searchLastOutput: SearchOutput | null = null;
  let searchExpanded = new Set<SearchResultType>();
  let searchLastQuery = '';
  let searchLoadingSince: number | null = null;
  let cancelSearchLoading: (() => void) | undefined;
  let searchTimeout: ReturnType<typeof setTimeout>;

  function syncSearchAccessibility(): void {
    const input = $<HTMLInputElement>('.search-input');
    const results = resultsElement();
    const listbox = $('#search-listbox');
    const expanded = !!results && !results.hidden;
    input?.setAttribute('aria-expanded', String(expanded));
    const active = searchSelectables[searchActive]?.el;
    if (expanded && active && listbox?.contains(active)) input?.setAttribute('aria-activedescendant', active.id);
    else input?.removeAttribute('aria-activedescendant');
  }

  function setSearchVisible(visible: boolean): void {
    const results = resultsElement();
    if (results) results.hidden = !visible;
    if (!visible) clearTimeout(searchTimeout);
    syncSearchAccessibility();
  }

  function setupSearch(): void {
    const input = $<HTMLInputElement>('.search-input');
    const results = resultsElement();
    input?.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => handleSearch(input.value), 200);
    });
    input?.addEventListener('focus', () => {
      if (!input.value.trim()) return;
      if (input.value !== searchLastQuery) handleSearch(input.value);
      else if (searchLastOutput) setSearchVisible(true);
    });
    input?.addEventListener('blur', event => {
      if (!results?.contains(event.relatedTarget as Node | null)) setSearchVisible(false);
    });
    input?.addEventListener('keydown', handleSearchKeydown);
    // Keep presses (including the scrollbar) from blurring the input.
    results?.addEventListener('mousedown', event => event.preventDefault());
    results?.addEventListener('focusout', event => {
      if (!(event.relatedTarget instanceof Node) || !document.querySelector('.search-wrapper')?.contains(event.relatedTarget)) setSearchVisible(false);
    });
    syncSearchAccessibility();
  }

  function clearSearchResults(results: HTMLElement): HTMLElement {
    const listbox = results.querySelector<HTMLElement>('#search-listbox') ?? document.createElement('div');
    listbox.id = 'search-listbox'; listbox.setAttribute('role', 'listbox'); listbox.setAttribute('aria-label', 'Search results');
    listbox.replaceChildren();
    results.replaceChildren(listbox);
    return listbox;
  }

  // Clear the dropdown and all its state; `clearInput` also empties the box
  // (result selection, source switch).
  function resetSearch(clearInput: boolean): void {
    cancelSearchLoading?.(); searchLoadingSince = null;
    const results = resultsElement();
    if (results) clearSearchResults(results);
    setSearchVisible(false);
    if (clearInput) {
      const input = $<HTMLInputElement>('.search-input');
      if (input) input.value = '';
    }
    searchSelectables = [];
    searchLastOutput = null;
    searchExpanded = new Set();
    searchLastQuery = '';
    setSearchActive(-1);
  }

  function handleSearch(query: string): void {
    const resultsEl = resultsElement();
    if (!resultsEl) return;

    const current = store();
    if (!query.trim() || !current) {
      resetSearch(false);
      return;
    }

    if (query !== searchLastQuery) {
      searchExpanded = new Set();
      searchLastQuery = query;
    }

    searchLastOutput = search(
      query,
      current.getNoteIndex(),
      current.getProjectIndex(),
      current.getActionIndex(),
      {
        resolveName: renderOpts().resolveName,
        entryContents: current.getCachedEntryContents(),
        artifactIndex: current.getArtifactIndex(),
        artifactContents: current.getCachedArtifactContents(),
        resolveArtifactName: id => current.getArtifactDisplayName(id),
      }
    );
    renderSearchResults(resultsEl);
  }

  // Draw the dropdown from searchLastOutput. A re-render (expansion, catch-up
  // re-search) keeps the keyboard highlight on the same row when it survives,
  // found again by its type:id key.
  function renderSearchResults(resultsEl: HTMLElement): void {
    cancelSearchLoading?.();
    const activeKey = searchSelectables[searchActive]?.el.dataset.key;
    const listbox = clearSearchResults(resultsEl);
    searchSelectables = [];
    setSearchVisible(true);

    const { results, terms } = searchLastOutput!;
    const progress = store()!.getSearchProgress();
    if (!progress.complete) {
      const status = document.createElement('div'); status.className = 'search-index-progress';
      const actions: HTMLElement[] = [];
      if (progress.pending === 0) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'history-retry'; retry.textContent = 'Retry';
        retry.setAttribute('aria-label', 'Retry loading search text'); retry.title = progress.failures.join('\n');
        retry.addEventListener('click', () => {
          $<HTMLInputElement>('.search-input')?.focus({ preventScroll: true });
          const currentStore = store();
          if (!currentStore) return;
          void currentStore.warmSearch(true).then(() => {
            if (store() === currentStore && !resultsEl.hidden && !currentStore.getSearchProgress().complete) showActionFailure('Could not load all search text. Try again.');
          });
        }); actions.push(retry);
      }
      resultsEl.append(status);
      const showProgress = () => showNotice(status, {
        kind: progress.pending > 0 ? 'loading' : 'warning',
        message: progress.pending > 0 ? 'Loading search text…' : 'Search is incomplete.',
        description: progress.pending > 0 ? `${progress.loaded} of ${progress.total} files` : 'Some records need attention.',
        actions,
      });
      if (progress.pending > 0) {
        searchLoadingSince ??= performance.now();
        cancelSearchLoading = delayLoading(showProgress, () => status.isConnected && !resultsEl.hidden,
          Math.max(0, LOADING_DELAY_MS - (performance.now() - searchLoadingSince)));
      } else { searchLoadingSince = null; showProgress(); }
    } else searchLoadingSince = null;
    if (results.length === 0) {
      const empty = document.createElement('div'); empty.className = 'search-result-item';
      empty.setAttribute('role', 'status');
      empty.textContent = progress.complete ? 'No results' : 'No matches in available records yet'; resultsEl.append(empty);
      resultsEl.append(listbox);
      setSearchActive(-1);
      return;
    }

    const resolveName = renderOpts().resolveName;
    for (const group of SEARCH_GROUPS) {
      const items = results.filter((r) => r.type === group.type);
      if (items.length === 0) continue;

      const header = document.createElement('div');
      header.className = 'search-result-group';
      header.textContent = group.label;
      header.setAttribute('aria-hidden', 'true');
      const section = document.createElement('div');
      section.setAttribute('role', 'group'); section.setAttribute('aria-label', group.label);
      section.append(header); listbox.append(section);

      const shown = searchExpanded.has(group.type) ? items : items.slice(0, group.cap);
      for (const result of shown) section.appendChild(searchResultRow(result, terms, resolveName));
      if (shown.length < items.length) {
        const more = document.createElement('div');
        more.className = 'search-result-item search-result-more';
        more.textContent = `+ ${items.length - shown.length} more`;
        more.dataset.key = `more:${group.type}`;
        more.setAttribute('aria-label', `Show ${items.length - shown.length} more ${group.label}`);
        // Expanding redraws from the output in hand — no re-search, the
        // dropdown stays open, input intact.
        searchSelectableRow(more, () => {
          searchExpanded.add(group.type);
          renderSearchResults(resultsEl);
        });
        section.appendChild(more);
      }
    }
    resultsEl.append(listbox);
    setSearchActive(activeKey ? searchSelectables.findIndex((s) => s.el.dataset.key === activeKey) : -1);
  }

  function searchResultRow(
    result: SearchResult,
    terms: string[],
    resolveName: RenderOptions['resolveName'],
  ): HTMLElement {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.dataset.key = `${result.type}:${result.id}`;

    const typeLabel = document.createElement('span');
    typeLabel.className = `tag tag-${result.type} tag-sm`;
    typeLabel.innerHTML = entityIcon(result.type); // hardcoded SVG only — never user data

    const textCol = document.createElement('div');
    textCol.className = 'search-result-text';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'search-result-name';
    const nameHtml = result.type === 'date' ? ''
      : highlight(result.type === 'artifact' ? store()!.getArtifactDisplayName(result.id) : resolveName(result.type, result.id), terms);
    nameLabel.innerHTML = nameHtml;
    textCol.appendChild(nameLabel);

    let otherMarked = false;
    if (result.description) {
      const descLabel = document.createElement('div');
      descLabel.className = 'search-result-description';
      const descHtml = highlight(result.description, terms);
      descLabel.innerHTML = descHtml;
      otherMarked ||= descHtml.includes('<mark>');
      textCol.appendChild(descLabel);
    }
    if (result.snippet) {
      const snipLabel = document.createElement('div');
      snipLabel.className = 'search-result-description search-result-snippet';
      snipLabel.innerHTML = highlight(result.snippet, terms);
      otherMarked = true;
      textCol.appendChild(snipLabel);
    }
    // A hit living only in the id (say, its date code, which the display name
    // strips) would otherwise show no mark at all — surface the id so the match
    // is visible.
    if (result.type === 'date') {
      bindDisplay(nameLabel, renderOpts(), (node, current) => setDisplayText(node, `Jump to ${formatDate(result.id, current.dateFormat)}`));
    } else if (result.type === 'entry') {
      bindEntrySearchName(nameLabel, textCol, result.id, terms, renderOpts(), otherMarked);
    } else if (!otherMarked && !nameHtml.includes('<mark>')) {
      const idHtml = highlight(result.id, terms);
      if (idHtml.includes('<mark>')) {
        const idLabel = document.createElement('div');
        idLabel.className = 'search-result-description search-result-id';
        idLabel.innerHTML = idHtml;
        textCol.appendChild(idLabel);
      }
    }

    item.appendChild(typeLabel);
    item.appendChild(textCol);

    searchSelectableRow(item, () => {
      resetSearch(true);
      onSelect(result);
    });
    return item;
  }

  // Register a dropdown row for both click and keyboard activation. The
  // container's mousedown listener keeps the input focused, and the row
  // joins the arrow-key order.
  function searchSelectableRow(el: HTMLElement, activate: () => void): void {
    el.setAttribute('role', 'option');
    el.id = `search-option-${searchSelectables.length}`;
    searchSelectables.push({ el, activate });
    el.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey) return;
      activate();
    });
  }

  function setSearchActive(index: number): void {
    searchActive = index;
    searchSelectables.forEach((s, i) => {
      s.el.classList.toggle('is-active', i === index);
      s.el.setAttribute('aria-selected', String(i === index));
    });
    const active = searchSelectables[index];
    if (active) {
      if (!resultsElement()?.hidden) active.el.scrollIntoView({ block: 'nearest' });
    }
    syncSearchAccessibility();
  }

  // Arrow keys walk the dropdown (wrapping), Enter activates the highlighted row
  // or, with none highlighted, the first result. Esc is global (hides results).
  // A pending debounced search is flushed first so the keys act on the query as
  // typed, never on a stale render.
  function handleSearchKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || activeModal()) return;
    if (e.isComposing) return;
    const popup = resultsElement();
    if (e.key === 'Escape') {
      clearTimeout(searchTimeout);
      if (popup && !popup.hidden) { e.preventDefault(); setSearchVisible(false); }
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    if (e.key === 'Enter' && (!popup || popup.hidden)) return;
    const input = e.target as HTMLInputElement;
    if (input.value !== searchLastQuery) {
      clearTimeout(searchTimeout);
      handleSearch(input.value);
    }
    const results = resultsElement();
    if (!results || searchSelectables.length === 0) return;
    if (results.hidden) setSearchVisible(true);
    e.preventDefault();
    const n = searchSelectables.length;
    if (e.key === 'ArrowDown') {
      setSearchActive(searchActive < 0 ? 0 : (searchActive + 1) % n);
    } else if (e.key === 'ArrowUp') {
      setSearchActive(searchActive < 0 ? n - 1 : (searchActive + n - 1) % n);
    } else {
      searchSelectables[Math.max(searchActive, 0)]?.activate();
    }
  }

  return {
    setupSearch, handleSearch, setSearchVisible, resetSearch, isSearchVisible,
    // The query the open dropdown answers.
    searchLastQuery: () => searchLastQuery,
    cancelPendingSearch: () => clearTimeout(searchTimeout),
    // An open dropdown re-runs its query — after the records it searched changed.
    rerunOpenSearch: () => {
      const input = $<HTMLInputElement>('.search-input');
      if (input?.value.trim() && isSearchVisible()) handleSearch(input.value);
    },
    // The box takes input only while an instance is connected.
    setSearchEnabled: (enabled: boolean) => {
      const input = $<HTMLInputElement>('.search-input');
      if (input) input.disabled = !enabled;
    },
  };
}
