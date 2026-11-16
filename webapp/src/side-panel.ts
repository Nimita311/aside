import type { EntityRef } from '../lib/types';
import { activeModal, usable } from './modal';

// The summary's availability and retained reading state. Its body lives in the
// Context panel; what the summary shows is app.ts's showSidePanel.

// The side panel's last-seen state: its body scroll offset and the related
// sections the user expanded past their fold, so back/forward restores the
// panel as it was left rather than scrolled to the top and collapsed. A
// dated timeline section folds at both ends, so its entries carry the
// direction ("Scheduled::future"); a plain section reveals in batches, so
// its bare title repeats once per reveal.
export interface PanelView {
  scrollTop: number;
  expanded: string[];
  contextView?: 'content' | 'overview';
}

// The current summary scope; availability never changes the browsing state.
export interface SidePanelState {
  filter: EntityRef | null;
}

export interface SidePanelDeps {
  state: SidePanelState;
  setAvailable(available: boolean): void;
  focusFallback(): HTMLElement | null;
}

export function createSidePanel({ state, setAvailable, focusFallback }: SidePanelDeps) {
  const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);

  // True while restorePanelView replays a panel state, through to the frame
  // after — the synthetic expand clicks (synchronous) and the scroll it sets
  // (whose event is async) would otherwise stamp over the state being restored.
  let panelRestoring = false;

  function showPanelElement(): void {
    $('#side-panel')?.classList.toggle('is-instance', !state.filter);
    setAvailable(true);
  }

  function closeSidePanel(): void {
    setAvailable(false);
  }

  // Read the mounted body whether or not the panel is currently shown.
  // Responsive retraction is not navigation.
  function panelSnapshot(): PanelView | null {
    const body = $('#side-panel-body');
    if (!body) return null;
    const rememberedScroll = body.dataset.panelScroll === undefined ? NaN : Number(body.dataset.panelScroll);
    const scrollTop = usable(body) || !Number.isFinite(rememberedScroll) ? body.scrollTop : rememberedScroll;
    body.dataset.panelScroll = String(scrollTop);
    const expanded = Array.from(body.querySelectorAll<HTMLElement>('.related-heading[data-section]'))
      .flatMap((h) => {
        const reveals = h.dataset.expanded;
        if (!reveals) return [];
        const title = h.dataset.section!;
        if (/^\d+$/.test(reveals)) return Array<string>(Number(reveals)).fill(title);
        return reveals.split(' ').map((dir) => `${title}::${dir}`);
      });
    const contextView = $('#side-panel')?.dataset.view;
    return { scrollTop, expanded, ...(contextView === 'content' || contextView === 'overview' ? { contextView } : {}) };
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
      // A retracted body can report zero until it is mounted in a visible
      // Summary surface. Keep the requested logical position for that move.
      body.dataset.panelScroll = String(view?.scrollTop ?? 0);
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
    const target = equivalent && usable(equivalent) ? equivalent : body.querySelector<HTMLElement>('.entity-title, .notice-action') ?? focusFallback();
    if (target && usable(target)) {
      if (target !== equivalent && body.contains(target)) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }

  return {
    showPanelElement, closeSidePanel,
    panelSnapshot, stampPanel, restorePanelView, holdPanelFocus, restorePanelFocus,
    isPanelRestoring: () => panelRestoring,
  };
}
