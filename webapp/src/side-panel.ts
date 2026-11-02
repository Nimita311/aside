import type { StoreView as Store } from '../../cli/src/core/data-snapshot';
import type { EntityRef } from '../lib/types';
import { activeModal } from './modal';
import { applyRefStatus, entityIcon, type RenderOptions } from './render';
import { bindDisplay, setDisplayText } from './display';
import { applyStoredPanelWidth } from './panel-resize';

// The side panel's chrome: showing and hiding the panel element, retracting
// it to the docked filter pill and back, the state back/forward restores (its
// scroll offset and expanded sections), and the focus bookkeeping a re-render
// needs. What the panel shows is app.ts's showSidePanel.

// The side panel's last-seen state: its body scroll offset and the related
// sections the user expanded past their fold, so back/forward restores the
// panel as it was left rather than scrolled to the top and collapsed. A
// dated timeline section folds at both ends, so its entries carry the
// direction ("Scheduled::future"); a plain section reveals in batches, so
// its bare title repeats once per reveal.
export interface PanelView {
  scrollTop: number;
  expanded: string[];
}

// The app state the chrome reads — and, for the collapsed preference, writes.
export interface SidePanelState {
  panelCollapsed: boolean;
  filter: EntityRef | null;
  store: Store | null;
}

export interface SidePanelDeps {
  state: SidePanelState;
  transitionMs(): number;
  renderOpts(): RenderOptions;
  // Render the current scope into the panel body; expanding the panel runs it.
  showSidePanel(): Promise<void>;
  clearFilter(): void;
}

export function createSidePanel({ state, transitionMs, renderOpts, showSidePanel, clearFilter }: SidePanelDeps) {
  const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);

  // The pending display:none that follows the panel's slide-out; a re-show
  // cancels it (the is-open re-add lags a frame behind, so it can't be the guard).
  let panelHideTimer: ReturnType<typeof setTimeout> | undefined;
  // The docked pill's own pending hide, likewise cancelled by a re-show.
  let pillHideTimer: ReturnType<typeof setTimeout> | undefined;
  // True while restorePanelView replays a panel state, through to the frame
  // after — the synthetic expand clicks (synchronous) and the scroll it sets
  // (whose event is async) would otherwise stamp over the state being restored.
  let panelRestoring = false;

  function movePanelFocus(outgoing: HTMLElement, target: HTMLElement | null): void {
    if (!outgoing.contains(document.activeElement) || activeModal()) return;
    const destination = target && !target.closest('[hidden], [inert]') ? target : $('.app-title a');
    destination?.focus({ preventScroll: true });
  }

  function hidePanelElement(): void {
    const sidePanel = $('#side-panel');
    if (sidePanel) {
      movePanelFocus(sidePanel, $('#filter-pill .filter-pill-label'));
      sidePanel.inert = true;
      sidePanel.classList.remove('is-open');
      clearTimeout(panelHideTimer);
      panelHideTimer = setTimeout(() => { sidePanel.hidden = true; }, transitionMs());
    }
  }

  function showPanelElement(): void {
    const panel = $('#side-panel');
    if (!panel) return;
    clearTimeout(panelHideTimer);
    panel.hidden = false;
    panel.inert = false;
    panel.classList.toggle('is-instance', !state.filter);
    requestAnimationFrame(() => { if (!panel.hidden && !panel.inert) panel.classList.add('is-open'); });
  }

  function closeSidePanel(): void {
    hidePanelElement();
    updateFilterPill();
  }

  // Retract the panel to the docked pill / bring it back. The pill keeps the
  // active filter visible while the flow gets the full width.
  function collapsePanel(): void {
    state.panelCollapsed = true;
    localStorage.setItem('panelCollapsed', 'true');
    updateFilterPill();
    hidePanelElement();
  }

  function expandPanel(): void {
    state.panelCollapsed = false;
    localStorage.setItem('panelCollapsed', 'false');
    applyStoredPanelWidth();
    void showSidePanel();
  }

  // The docked pill shown while the panel is retracted: the filtered entity as
  // a colored tag (click to expand) plus a clear button.
  function updateFilterPill(): void {
    $('#btn-side-panel-collapse')?.setAttribute('aria-expanded', String(!state.panelCollapsed));
    const pill = $('#filter-pill');
    if (!pill) return;
    clearTimeout(pillHideTimer);
    const instance = state.store?.getInstance();
    const show = state.panelCollapsed && (state.filter !== null || instance != null);
    if (!show) {
      movePanelFocus(pill, $('#btn-side-panel-collapse'));
      pill.inert = true;
      pill.classList.remove('is-visible');
      // Keep it displayed until the slide-out finishes; a re-show cancels this.
      pillHideTimer = setTimeout(() => { pill.hidden = true; }, transitionMs());
      return;
    }
    pill.hidden = false;
    pill.inert = false;
    requestAnimationFrame(() => { if (!pill.hidden && !pill.inert) pill.classList.add('is-visible'); });

    const ref = state.filter;
    const focusedClear = document.activeElement?.matches('.filter-pill-clear') && pill.contains(document.activeElement);
    const restoreFocus = pill.contains(document.activeElement) && !activeModal();
    pill.innerHTML = '';

    const opts = renderOpts();
    const label = document.createElement('button');
    label.className = `filter-pill-label tag tag-${ref?.type ?? 'instance'}`;
    if (ref) {
      label.dataset.refType = ref.type;
      label.dataset.refId = ref.id;
    }
    label.title = 'Expand panel';
    label.setAttribute('aria-expanded', 'false');
    label.setAttribute('aria-controls', 'side-panel-body');
    label.innerHTML = entityIcon(ref?.type ?? 'instance'); // hardcoded SVG only — never user data
    const text = document.createElement('span');
    text.className = 'tag-text';
    text.textContent = ref ? opts.resolveName(ref.type, ref.id) : instance!.manifest.name ?? instance!.manifest.id;
    label.setAttribute('aria-label', `Expand panel: ${text.textContent}`);
    if (ref?.type === 'entry') {
      bindDisplay(text, opts, (node, current) => {
        const name = current.resolveName(ref.type, ref.id);
        setDisplayText(node, name);
        node.parentElement?.setAttribute('aria-label', `Expand panel: ${name}`);
      });
    }
    label.appendChild(text);
    if (ref) applyRefStatus(label, ref.type, ref.id, opts);
    label.addEventListener('click', () => expandPanel());
    pill.append(label);

    // The instance is not a filter — its pill has nothing to clear.
    if (ref) {
      const clear = document.createElement('button');
      clear.className = 'filter-pill-clear';
      clear.textContent = '×';
      clear.setAttribute('aria-label', 'Clear filter');
      clear.addEventListener('click', (e) => { e.stopPropagation(); clearFilter(); });
      pill.append(clear);
    }
    if (restoreFocus) (focusedClear ? pill.querySelector<HTMLElement>('.filter-pill-clear') ?? label : label).focus({ preventScroll: true });
  }

  // The side panel's current state, or null when nothing is on display
  // (retracted to the pill). Read from the live DOM at stamp time.
  function panelSnapshot(): PanelView | null {
    const body = $('#side-panel-body');
    if (!body || state.panelCollapsed) return null;
    const expanded = Array.from(body.querySelectorAll<HTMLElement>('.related-heading[data-section]'))
      .flatMap((h) => {
        const reveals = h.dataset.expanded;
        if (!reveals) return [];
        const title = h.dataset.section!;
        if (/^\d+$/.test(reveals)) return Array<string>(Number(reveals)).fill(title);
        return reveals.split(' ').map((dir) => `${title}::${dir}`);
      });
    return { scrollTop: body.scrollTop, expanded };
  }

  // Refresh the current history entry's panel state, so leaving the view (even
  // via back/forward, which has no before-leave hook) preserves where the panel
  // was scrolled and which sections were open.
  function stampPanel(): void {
    if (panelRestoring) return;
    const nav = (history.state ?? {}) as Record<string, unknown>;
    history.replaceState({ ...nav, panel: panelSnapshot() }, '');
  }

  // Replay a remembered panel state into a freshly rendered panel body: expand
  // the recorded sections (their fold buttons carry the section title), then
  // restore the scroll offset once the expanded content sets the final height.
  function restorePanelView(body: HTMLElement, view: PanelView | null | undefined): void {
    panelRestoring = true;
    try {
      if (view) {
        for (const entry of view.expanded) {
          const [title, dir] = entry.split('::');
          const selector = `.related-more[data-section="${CSS.escape(title)}"]` + (dir ? `[data-dir="${dir}"]` : '');
          body.querySelector<HTMLButtonElement>(selector)?.click();
        }
        body.scrollTop = view.scrollTop;
      } else {
        body.scrollTop = 0;
      }
    } finally {
      // Hold the guard past this frame's scroll dispatch: the scrollTop set above
      // fires its scroll event before the next rAF, so clearing here (not
      // synchronously) lets the scroll listener see the guard and skip it.
      requestAnimationFrame(() => { panelRestoring = false; });
    }
  }

  // Keep a keyboard position inside the panel while its children are replaced.
  // Moving to this stable host first also gives a later render an explicit focus
  // owner: if the user leaves it during the load, that choice takes precedence.
  function holdPanelFocus(body: HTMLElement): HTMLElement | null {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !body.contains(focused) || activeModal() || body.closest('[hidden], [inert]')) return null;
    body.tabIndex = -1;
    body.focus({ preventScroll: true });
    return focused;
  }

  function restorePanelFocus(body: HTMLElement, previous: HTMLElement | null): void {
    if (!previous || document.activeElement !== body || activeModal() || body.closest('[hidden], [inert]')) return;
    let equivalent: HTMLElement | undefined;
    const href = previous.getAttribute('href');
    if (href) equivalent = Array.from(body.querySelectorAll<HTMLElement>('a[href]')).find(node => node.getAttribute('href') === href);
    else if (previous.matches('.related-more')) {
      equivalent = Array.from(body.querySelectorAll<HTMLElement>('.related-more')).find(node =>
        node.dataset.section === previous.dataset.section && node.dataset.dir === previous.dataset.dir);
    } else if (previous.hasAttribute('aria-label')) {
      equivalent = Array.from(body.querySelectorAll<HTMLElement>('button[aria-label]')).find(node =>
        node.getAttribute('aria-label') === previous.getAttribute('aria-label'));
    }
    const target = equivalent && !equivalent.closest('[hidden], [inert]') ? equivalent : body.querySelector<HTMLElement>('.entity-title, .notice-action');
    if (target) {
      if (target !== equivalent) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }

  return {
    hidePanelElement, showPanelElement, closeSidePanel, collapsePanel, expandPanel, updateFilterPill,
    panelSnapshot, stampPanel, restorePanelView, holdPanelFocus, restorePanelFocus,
    isPanelRestoring: () => panelRestoring,
  };
}
