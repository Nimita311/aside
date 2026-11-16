import { showActionFailure } from './toast';
import { showNotice, delayLoading, LOADING_DELAY_MS } from './notice';
import type { StoreView as Store } from '../../cli/src/core/data-snapshot';
import { activeModal } from './modal';
import { entityIcon, type RenderOptions } from './render';
import { ICON_SIZE, artifactIconState, iconMarkup, refIconState } from './entity-icons';
import { search, highlight, type SearchOutput, type SearchResult, type SearchResultType } from './search';
import { bindDisplay, setDisplayText } from './display';
import { formatDate } from './date-display';
import { appendIdMatch, bindEntrySearchName } from './search-label';
import { remoteSearch, type SearchQuery } from './search-remote';
import { watchActiveSearch } from './search-progress';
import { errorMessage } from '../../cli/src/core/error';

// The search dropdown owns explicit query modes, request lifetime, result
// ordering, keyboard navigation and combobox state. Selection navigates through
// the app's onSelect callback.

export interface SearchUiDeps {
  store(): Store | null;
  renderOpts(): RenderOptions;
  query?: SearchQuery;
  // A chosen row: a date to jump to, or an entity to navigate to.
  onSelect(result: SearchResult): void;
  // Available only while an entry flow is the active reading surface. The
  // applied term is distinct from the draft in the header's lookup box.
  flowSearch?(): { label: string; term: string } | null;
  onFlowSearch?(term: string): void;
  // Explicit retries can replace the store snapshot behind other surfaces.
  onRefresh?(): void;
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

type SearchMode = 'text' | 'regex' | 'semantic';
const SEARCH_LANGUAGE: Record<SearchMode, { placeholder: string; help: string }> = {
  text: { placeholder: 'Search words, types, or dates…', help: 'Text: all words must match. Use project:, action:, artifact:, entry:, or 2026-01..2026-06.' },
  regex: { placeholder: 'Pattern, e.g. deploy|release', help: 'Regex: case-insensitive ECMAScript pattern. No /delimiters/, flags, type prefixes, or date syntax.' },
  semantic: { placeholder: 'Describe what you want to find…', help: 'Semantic: search by meaning in plain language. Results are ranked by relevance; regex and Text syntax do not apply.' },
};

export function createSearchUi({ store, renderOpts, onSelect, query: queryBackend, flowSearch, onFlowSearch, onRefresh }: SearchUiDeps) {
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
  let searchLastMode: SearchMode = 'text';
  let searchDetail = '';
  let searchRequest: AbortController | undefined;
  let requestGeneration = 0;
  const mode = (): SearchMode => {
    const value = $<HTMLSelectElement>('#search-mode')?.value;
    return value === 'regex' || value === 'semantic' ? value : 'text';
  };
  function cancelRemoteSearch(): void {
    ++requestGeneration;
    searchRequest?.abort(); searchRequest = undefined;
  }

  function syncSearchLanguage(): void {
    const language = SEARCH_LANGUAGE[mode()];
    const input = $<HTMLInputElement>('.search-input');
    if (input) { input.placeholder = language.placeholder; input.title = language.help; }
    const help = $('#search-help');
    if (help) help.textContent = language.help;
    const select = $<HTMLSelectElement>('#search-mode');
    if (select) select.title = language.help;
  }

  function syncSearchAccessibility(): void {
    const input = $<HTMLInputElement>('.search-input');
    const listbox = $('#search-listbox');
    const expanded = isSearchVisible();
    input?.setAttribute('aria-expanded', String(expanded));
    const active = searchSelectables[searchActive]?.el;
    if (expanded && active && listbox?.contains(active)) input?.setAttribute('aria-activedescendant', active.id);
    else input?.removeAttribute('aria-activedescendant');
  }

  function setSearchVisible(visible: boolean): void {
    const results = resultsElement();
    if (results) results.hidden = !visible;
    if (!visible) { clearTimeout(searchTimeout); cancelRemoteSearch(); }
    syncSearchAccessibility();
  }

  function setupSearch(): void {
    const input = $<HTMLInputElement>('.search-input');
    const results = resultsElement();
    input?.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      if (mode() !== 'text') resetSearch(false);
      searchTimeout = setTimeout(() => handleSearch(input.value), 200);
    });
    input?.addEventListener('focus', () => {
      if (!input.value.trim() && !(mode() === 'text' && flowSearch?.())) return;
      if (mode() === 'text' || input.value !== searchLastQuery || mode() !== searchLastMode || (!searchLastOutput && !searchRequest)) handleSearch(input.value);
      else if (searchLastOutput) setSearchVisible(true);
    });
    // Focus that leaves the whole search surface closes the dropdown.
    const hideOnLeave = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !document.querySelector('.search-wrapper')?.contains(event.relatedTarget)) setSearchVisible(false);
    };
    input?.addEventListener('blur', hideOnLeave);
    input?.addEventListener('keydown', handleSearchKeydown);
    // Keep presses (including the scrollbar) from blurring the input.
    results?.addEventListener('mousedown', event => event.preventDefault());
    results?.addEventListener('focusout', hideOnLeave);
    const select = $<HTMLSelectElement>('#search-mode');
    select?.addEventListener('change', () => {
      resetSearch(false); syncSearchLanguage();
      if (input?.value.trim()) handleSearch(input.value);
      input?.focus({ preventScroll: true });
    });
    select?.addEventListener('blur', hideOnLeave);
    syncSearchLanguage();
    syncSearchAccessibility();
  }

  function clearSearchResults(results: HTMLElement): HTMLElement {
    const listbox = results.querySelector<HTMLElement>('#search-listbox') ?? document.createElement('div');
    listbox.id = 'search-listbox'; listbox.setAttribute('role', 'listbox'); listbox.setAttribute('aria-label', 'Search results');
    listbox.replaceChildren();
    results.replaceChildren(listbox);
    return listbox;
  }

  function showSearchLanguage(results: HTMLElement): void {
    const help = document.createElement('div'); help.className = 'search-query-help';
    help.textContent = SEARCH_LANGUAGE[searchLastMode].help;
    results.append(help);
  }

  // Clear the dropdown and all its state; `clearInput` also empties the box
  // (result selection, source switch).
  function resetSearch(clearInput: boolean): void {
    cancelRemoteSearch();
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
    searchDetail = '';
    setSearchActive(-1);
  }

  function handleSearch(query: string): void {
    const resultsEl = resultsElement();
    if (!resultsEl) return;

    const current = store();
    if (!current || (!query.trim() && !(mode() === 'text' && flowSearch?.()))) {
      resetSearch(false);
      return;
    }

    const currentMode = mode();
    if (currentMode !== 'text') {
      void handleRemoteSearch(query, currentMode, current, resultsEl);
      return;
    }
    cancelRemoteSearch();
    searchLastMode = currentMode;
    searchDetail = '';

    if (query !== searchLastQuery) {
      searchExpanded = new Set();
      searchActive = -1;
      searchLastQuery = query;
    }

    searchLastOutput = query.trim() ? search(
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
    ) : { results: [], terms: [] };
    renderSearchResults(resultsEl);
  }

  async function handleRemoteSearch(text: string, currentMode: 'regex' | 'semantic', currentStore: Store, resultsEl: HTMLElement): Promise<void> {
    cancelRemoteSearch(); cancelSearchLoading?.();
    const generation = requestGeneration;
    const request = searchRequest = new AbortController();
    searchLastMode = currentMode; searchLastQuery = text;
    searchLastOutput = null; searchExpanded = new Set(); searchSelectables = [];
    clearSearchResults(resultsEl); setSearchActive(-1); setSearchVisible(true);
    showSearchLanguage(resultsEl);
    const status = document.createElement('div'); status.className = 'search-index-progress'; resultsEl.append(status);
    const isCurrent = () => generation === requestGeneration && store() === currentStore && mode() === currentMode;
    cancelSearchLoading = delayLoading(() => showNotice(status, {
      kind: 'loading', message: currentMode === 'semantic' ? 'Searching by meaning…' : 'Searching by pattern…',
    }), isCurrent);
    try {
      if (!queryBackend) throw new Error(`${currentMode === 'semantic' ? 'Semantic' : 'Regex'} search requires a connected Aside daemon.`);
      const output = await remoteSearch(currentMode, text, queryBackend, request.signal);
      if (!isCurrent()) return;
      searchRequest = undefined;
      searchLastOutput = output; searchDetail = output.detail;
      renderSearchResults(resultsEl);
    } catch (error) {
      if (!isCurrent() || request.signal.aborted) return;
      searchRequest = undefined; cancelSearchLoading?.();
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry';
      retry.addEventListener('click', () => handleSearch(text));
      const message = errorMessage(error);
      showNotice(status, {
        kind: 'error', message: `${currentMode === 'semantic' ? 'Semantic' : 'Regex'} search failed.`,
        description: message,
        ...(currentMode === 'semantic' && /timed?\s*out|timeout/i.test(message) ? { details: 'The first search may need time to build its local index. Retry to continue indexing.' } : {}),
        actions: [retry],
      });
    }
  }

  // Draw the dropdown from searchLastOutput. A re-render (expansion, catch-up
  // re-search) keeps the keyboard highlight on the same row when it survives,
  // found again by its type:id key.
  function renderSearchResults(resultsEl: HTMLElement): void {
    cancelSearchLoading?.();
    const activeKey = searchSelectables[searchActive]?.el.dataset.key;
    const listbox = clearSearchResults(resultsEl);
    showSearchLanguage(resultsEl);
    searchSelectables = [];
    setSearchVisible(true);

    const { results, terms } = searchLastOutput!;
    const context = searchLastMode === 'text' && onFlowSearch ? flowSearch?.() : null;
    // Every exit places the listbox and restores the keyboard highlight.
    const finish = () => {
      if (!context) resultsEl.append(listbox);
      setSearchActive(activeKey ? searchSelectables.findIndex(s => s.el.dataset.key === activeKey) : -1);
    };
    if (context) listbox.append(flowSearchRow(context));
    if (searchDetail) {
      const detail = document.createElement('div'); detail.className = 'search-result-detail';
      detail.textContent = searchDetail; resultsEl.append(detail);
    }
    const progress = searchLastMode === 'text' ? store()!.getSearchProgress() : { complete: true, loaded: 0, total: 0, pending: 0, failures: [] };
    if (searchLastQuery.trim() && !progress.complete) {
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
            if (store() !== currentStore) return;
            onRefresh?.();
            if (!resultsEl.hidden && !currentStore.getSearchProgress().complete) showActionFailure('Could not load all search text. Try again.');
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
      if (searchLastQuery.trim()) {
        const empty = document.createElement('div'); empty.className = 'search-result-item';
        empty.setAttribute('role', 'status');
        empty.textContent = progress.complete ? 'No results' : 'No matches in available records yet'; resultsEl.append(empty);
      }
      finish(); return;
    }

    const resolveName = renderOpts().resolveName;
    if (searchLastMode !== 'text') {
      for (const result of results) listbox.append(searchResultRow(result, terms, resolveName));
      finish(); return;
    }
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
    finish();
  }

  function flowSearchRow(context: { label: string; term: string }): HTMLElement {
    const item = document.createElement('div');
    item.className = 'search-result-item search-flow-option';
    item.dataset.key = 'flow:search';
    const text = document.createElement('div'); text.className = 'search-result-text';
    const name = document.createElement('div'); name.className = 'search-result-name';
    const term = searchLastQuery.trim();
    name.textContent = term ? `Search this flow for “${term}”` : 'Search this flow';
    const scope = document.createElement('div'); scope.className = 'search-result-description'; scope.textContent = context.label;
    text.append(name, scope); item.append(text);
    searchSelectableRow(item, () => {
      // Eligibility may have changed while a debounced lookup was visible.
      const current = flowSearch?.();
      if (!current || !onFlowSearch) { resetSearch(true); return; }
      const draft = $<HTMLInputElement>('.search-input')?.value.trim() ?? term;
      if (!draft) { editFlowSearch(current.term); return; }
      resetSearch(true);
      onFlowSearch(draft);
    });
    return item;
  }

  function editFlowSearch(term: string): void {
    const input = $<HTMLInputElement>('.search-input');
    if (!input || input.disabled || !store() || !flowSearch?.()) return;
    clearTimeout(searchTimeout);
    const select = $<HTMLSelectElement>('#search-mode');
    if (select) select.value = 'text';
    syncSearchLanguage();
    input.value = term;
    input.focus({ preventScroll: true });
    input.select();
    handleSearch(term);
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
    typeLabel.className = `search-result-type icon-${result.type}`;
    // The type icon in the entity's state; a date row
    // jumps to a day. Constant geometry only — never user data.
    typeLabel.innerHTML = result.type === 'date' ? iconMarkup('date', 'day', ICON_SIZE.row)
      : result.type === 'artifact' ? entityIcon('artifact', artifactIconState(store()?.getCachedArtifact(result.id)), ICON_SIZE.row)
      : entityIcon(result.type, refIconState(result.type, renderOpts().refMarks(result.type, result.id)), ICON_SIZE.row);

    const textCol = document.createElement('div');
    textCol.className = 'search-result-text';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'search-result-name';
    const nameHtml = result.type === 'date' ? ''
      : highlight(result.name ?? (result.type === 'artifact' ? store()!.getArtifactDisplayName(result.id) : resolveName(result.type, result.id)), terms);
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
    } else if (!otherMarked && !nameHtml.includes('<mark>')) appendIdMatch(textCol, result.id, terms);

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
    const input = e.target as HTMLInputElement;
    if (e.key === 'Enter' && (!popup || popup.hidden) && input.value === searchLastQuery) return;
    if (input.value !== searchLastQuery) {
      clearTimeout(searchTimeout);
      handleSearch(input.value);
    }
    const results = resultsElement();
    if (!results || searchSelectables.length === 0) return;
    const reopening = results.hidden;
    if (reopening) setSearchVisible(true);
    e.preventDefault();
    const n = searchSelectables.length;
    if (e.key === 'ArrowDown') {
      setSearchActive(reopening || searchActive < 0 ? 0 : (searchActive + 1) % n);
    } else if (e.key === 'ArrowUp') {
      setSearchActive(reopening || searchActive < 0 ? n - 1 : (searchActive + n - 1) % n);
    } else {
      searchSelectables[Math.max(searchActive, 0)]?.activate();
    }
  }

  return {
    setupSearch, handleSearch, setSearchVisible, resetSearch, isSearchVisible, editFlowSearch,
    // Corpus warming and supporting-file diagnostics only affect local Text
    // results. Remote searches refresh once through applyDataUpdate, after its
    // snapshot is installed, rather than aborting/restarting again on this event.
    watchSearchCorpus: (source: Store) => watchActiveSearch(source, {
      query: () => $<HTMLInputElement>('.search-input')?.value ?? '',
      activeQuery: () => searchLastQuery,
      visible: () => store() === source && mode() === 'text' && isSearchVisible(),
      refresh: handleSearch,
    }),
    cancelPendingSearch: () => { clearTimeout(searchTimeout); cancelRemoteSearch(); },
    // An open dropdown re-runs its query — after the records it searched changed.
    rerunOpenSearch: () => {
      const input = $<HTMLInputElement>('.search-input');
      if (input?.value.trim() && isSearchVisible()) handleSearch(input.value);
    },
    // The box takes input only while an instance is connected.
    setSearchEnabled: (enabled: boolean) => {
      const input = $<HTMLInputElement>('.search-input');
      if (input) input.disabled = !enabled;
      const select = $<HTMLSelectElement>('#search-mode');
      if (select) select.disabled = !enabled;
      if (!enabled) resetSearch(false);
    },
  };
}
