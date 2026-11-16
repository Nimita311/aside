import { activeModal, setConcealed, usable } from './modal';

export type ContextPanelMode = 'summary' | 'expanded';
export type ContextPanelTab = 'content' | 'overview';
export interface ContextPanelState {
  open: boolean;
  mode: ContextPanelMode;
  view: ContextPanelTab;
  fullscreen: boolean;
  width: number;
}
export interface ContextPanelView {
  available: boolean;
  canBack?: boolean;
  canForward?: boolean;
  timelineAction?: ContextTimelineAction;
}
export interface ContextTimelineAction {
  label: string;
  // Filters expose a persistent pressed state; Go to commands navigate once.
  active?: boolean;
  onClick(): void;
}
export interface ContextPanelOptions {
  fallback(): HTMLElement | null;
  gutterWidth(): number;
  viewportWidth?(): number;
  beforeOpen?(): void;
  changed(state: Readonly<ContextPanelState>): void;
  onDismiss?(reason: 'close' | 'outside' | 'resize' | 'escape'): void;
  onBack?(): void;
  onForward?(): void;
  shouldDismiss?(event: MouseEvent): boolean;
  duration?(): number;
}

const MIN_WIDTH = 280;
const SNAP_CAPTURE = 12;
const SNAP_RELEASE = 24;
type Snap = 'min' | 'gutter' | null;
interface BoundaryState {
  raw: number;
  gutter: number;
  minimum: number;
  folded: boolean;
  snap: Snap;
  mode: ContextPanelMode;
  keyboard: boolean;
}
export interface ResizeBoundary {
  raw: number;
  width: number;
  folded: boolean;
  snap: Snap;
  mode: ContextPanelMode;
}

// A small magnetic band makes each boundary perceptible without letting tiny
// pointer reversals repeatedly flip between summary and expanded content.
export function resolveContextResize(previous: BoundaryState, raw: number): ResizeBoundary {
  const { gutter, minimum, keyboard } = previous;
  const gutterAvailable = gutter >= minimum + 2 * SNAP_RELEASE;
  let mode = previous.mode;
  if (raw > previous.raw && raw > gutter + SNAP_RELEASE) mode = 'expanded';
  else if (gutterAvailable && raw < previous.raw && raw < gutter - SNAP_RELEASE) mode = 'summary';
  const folded = keyboard || previous.folded ? raw < minimum : raw < minimum - SNAP_RELEASE;
  if (folded) return { raw, width: 0, folded: true, snap: null, mode };
  let snap = keyboard ? null : previous.snap;
  if (snap === 'gutter' && !gutterAvailable) snap = null;
  const boundary = (name: Exclude<Snap, null>) => name === 'min' ? minimum : gutter;
  if (snap && Math.abs(raw - boundary(snap)) > SNAP_RELEASE) snap = null;
  if (!keyboard && !snap) {
    const candidates: Exclude<Snap, null>[] = ['min', ...(gutterAvailable ? ['gutter' as const] : [])];
    const closest = candidates.filter(name => Math.abs(raw - boundary(name)) <= SNAP_CAPTURE)
      .sort((a, b) => Math.abs(raw - boundary(a)) - Math.abs(raw - boundary(b)))[0];
    snap = raw < minimum ? 'min' : closest ?? null;
  }
  return { raw, width: snap ? boundary(snap) : Math.max(minimum, raw), folded: false, snap, mode };
}

interface ResizeSession extends BoundaryState {
  pointerId: number | null;
  startWidth: number;
  startMode: ContextPanelMode;
  startView: ContextPanelTab;
  startScroll: number;
  startScrolls: Record<ContextPanelTab, number>;
  startOpen: boolean;
  gripOffset: number;
  width: number;
  moved: boolean;
}

// The app owns the inspected entity and its navigation history. This component
// owns only the single panel's presentation, keeping its body mounted as the
// panel slides, resizes, or changes configuration.
export function createContextPanel(host: HTMLElement, body: HTMLElement, options: ContextPanelOptions) {
  const control = (id: string) => host.querySelector<HTMLButtonElement>(`#${id}`);
  const back = control('btn-context-back');
  const forward = control('btn-context-forward');
  const timeline = control('btn-context-timeline');
  const fullscreen = control('btn-context-fullscreen');
  const extent = control('btn-context-expand');
  const closeButton = control('btn-side-panel-close');
  const resizer = control('side-panel-resize');
  const selector = host.querySelector<HTMLElement>('#context-panel-view');
  const contentTab = control('btn-context-content');
  const overviewTab = control('btn-context-overview');
  let view: ContextPanelView = { available: false };
  let launcher: HTMLElement | null = null;
  let session: ResizeSession | null = null;
  let started = false;
  let revision = 0;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;
  let scrollOwner: Element | null = null;
  let scrolls: Record<ContextPanelTab, number> = { content: 0, overview: 0 };
  let restoreScroll: number | undefined;
  const cleanup: (() => void)[] = [];
  const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
  const storedWidth = (key: string, initial: number) => {
    const width = Number(read(key));
    return Number.isFinite(width) && width >= MIN_WIDTH && width <= 10000 ? width : initial;
  };
  const widths = { summary: storedWidth('contextPanelSummaryWidth', 304), expanded: storedWidth('contextPanelExpandedWidth', 880) };
  const state: ContextPanelState = {
    open: false, mode: read('contextPanelMode') === 'expanded' ? 'expanded' : 'summary', fullscreen: false, width: 304,
    view: read('contextPanelView') === 'content' && read('contextPanelMode') === 'expanded' ? 'content' : 'overview',
  };
  const viewport = () => Math.max(1, (options.viewportWidth?.() ?? host.parentElement?.clientWidth) || window.innerWidth);
  const minimum = () => Math.min(MIN_WIDTH, viewport());
  const duration = () => Math.max(0, options.duration?.() ?? 300);

  function remember(): void {
    try {
      localStorage.setItem('contextPanelMode', state.mode);
      localStorage.setItem('contextPanelView', state.view);
      localStorage.setItem('contextPanelSummaryWidth', String(widths.summary));
      localStorage.setItem('contextPanelExpandedWidth', String(widths.expanded));
    } catch { /* A private browsing policy can disable preferences. */ }
  }

  function regions(): HTMLElement[] {
    const root = body.firstElementChild;
    if (root instanceof HTMLElement && root.classList.contains('context-content')) {
      return Array.from(root.querySelectorAll<HTMLElement>(':scope > [data-context-view], :scope > [data-context-detail] > [data-context-view]'));
    }
    // Isolated legacy readers do not have the composed context root.
    return Array.from(body.querySelectorAll<HTMLElement>(':scope > .detail-body, :scope > [data-context-detail] > .detail-body'));
  }

  function hasContent(): boolean {
    const media = 'iframe, img, picture, audio, video, canvas, svg, math, object, embed, hr';
    return regions().filter(node => node.dataset.contextView === 'content' || node.classList.contains('detail-body')).some(node =>
      !!node.textContent?.replace(/[\s\u200b]/g, '') || node.matches(media) || !!node.querySelector(media));
  }

  function htmlContent(): boolean {
    return body.firstElementChild instanceof HTMLElement && body.firstElementChild.dataset.contextPresentation === 'html';
  }

  function syncScrollOwner(): void {
    if (scrollOwner === body.firstElementChild) return;
    scrollOwner = body.firstElementChild;
    scrolls = { content: 0, overview: 0 };
    restoreScroll = 0;
  }

  function chooseView(next: ContextPanelTab): void {
    if (state.view === next) return;
    syncScrollOwner();
    scrolls[state.view] = body.scrollTop;
    state.view = next;
    restoreScroll = scrolls[next];
  }

  function paint(): void {
    syncScrollOwner();
    const available = viewport();
    const gutter = Math.max(0, options.gutterWidth());
    const summaryLimit = state.mode === 'summary' && gutter >= minimum() ? gutter : available;
    const width = session ? session.width : state.fullscreen ? Math.max(1, window.innerWidth) : Math.min(available, summaryLimit, widths[state.mode]);
    state.width = width;
    host.dataset.extent = state.fullscreen ? 'fullscreen' : state.mode;
    host.dataset.detail = state.mode;
    host.dataset.toolbar = width >= 560 ? 'wide' : 'compact';
    host.dataset.resizing = String(!!session);
    host.dataset.folded = String(!!session?.folded);
    if (session?.snap) host.dataset.snap = session.snap; else delete host.dataset.snap;
    // The outer width can animate; the inner width immediately assumes its
    // destination so Markdown never rewraps at intermediate animation widths.
    host.style.setProperty('--context-panel-width', `${width}px`);
    host.style.setProperty('--context-content-width', `${Math.max(0, width - (state.fullscreen ? 0 : 1))}px`);
    let concealedFocus = false;
    const contentAvailable = hasContent();
    const committed = body.firstElementChild?.classList.contains('context-content');
    if (state.mode === 'summary' || committed && !contentAvailable) chooseView('overview');
    // Keep the preference while a new record is loading. A committed empty
    // record chooses Overview; a temporary spinner must not erase Content.
    const displayedView = !contentAvailable ? 'overview' : state.view;
    host.dataset.view = displayedView;
    if (selector) {
      concealedFocus ||= state.mode === 'summary' && selector.contains(document.activeElement);
      selector.hidden = state.mode === 'summary';
    }
    for (const [tab, name] of [[contentTab, 'content'], [overviewTab, 'overview']] as const) {
      if (!tab) continue;
      tab.disabled = state.mode !== 'expanded' || name === 'content' && !contentAvailable;
      concealedFocus ||= tab.disabled && document.activeElement === tab;
      tab.setAttribute('aria-selected', String(displayedView === name));
      tab.tabIndex = state.mode === 'expanded' && displayedView === name && !tab.disabled ? 0 : -1;
    }
    if (state.mode === 'expanded' && selector) {
      body.setAttribute('role', 'tabpanel');
      const selected = displayedView === 'content' ? contentTab : overviewTab;
      if (selected) body.setAttribute('aria-labelledby', selected.id);
    } else { body.removeAttribute('role'); body.removeAttribute('aria-labelledby'); }
    const action = view.available ? view.timelineAction : undefined;
    host.dataset.timelineAction = String(!!action);
    if (timeline) {
      concealedFocus ||= !action && document.activeElement === timeline;
      timeline.hidden = !action;
      if (action) {
        timeline.dataset.command = action.active === undefined ? 'jump' : 'filter';
        timeline.setAttribute('aria-label', action.label);
        timeline.title = action.active ? 'Clear timeline filter' : action.label;
      } else delete timeline.dataset.command;
      if (action?.active !== undefined) timeline.setAttribute('aria-pressed', String(action.active));
      else timeline.removeAttribute('aria-pressed');
    }
    for (const detail of body.querySelectorAll<HTMLElement>('[data-context-detail]')) {
      const concealed = state.mode === 'summary';
      concealedFocus ||= concealed && detail.contains(document.activeElement);
      if (detail.inert !== concealed) detail.inert = concealed;
    }
    for (const region of regions()) {
      const content = region.dataset.contextView === 'content' || region.classList.contains('detail-body');
      const concealed = content ? state.mode !== 'expanded' || displayedView !== 'content' : state.mode === 'expanded' && displayedView === 'content';
      concealedFocus ||= concealed && region.contains(document.activeElement);
      if (region.inert !== concealed) region.inert = concealed;
    }
    if (back) back.disabled = !view.canBack;
    if (forward) forward.disabled = !view.canForward;
    if (fullscreen) {
      fullscreen.disabled = state.mode !== 'expanded';
      fullscreen.setAttribute('aria-label', state.fullscreen ? 'Exit full screen' : 'Full screen');
      fullscreen.title = state.fullscreen ? 'Exit full screen' : 'Full screen';
      fullscreen.setAttribute('aria-pressed', String(state.fullscreen));
    }
    if (extent) {
      extent.setAttribute('aria-label', state.mode === 'expanded' ? 'Contract to summary' : 'Expand details');
      extent.title = state.mode === 'expanded' ? 'Contract to summary' : 'Expand details';
      extent.setAttribute('aria-expanded', String(state.mode === 'expanded'));
    }
    if (resizer) {
      resizer.disabled = state.fullscreen;
      resizer.setAttribute('aria-valuemin', String(minimum()));
      resizer.setAttribute('aria-valuemax', String(available));
      resizer.setAttribute('aria-valuenow', String(Math.round(width)));
      resizer.setAttribute('aria-valuetext', session?.folded ? 'Dismissed' : `${Math.round(width)} pixels, ${state.mode}`);
    }
    if (concealedFocus && state.open && !activeModal()) {
      const selected = state.mode === 'expanded' ? displayedView === 'content' ? contentTab : overviewTab : null;
      if (usable(selected)) selected?.focus({ preventScroll: true });
      else if (usable(extent)) extent?.focus({ preventScroll: true });
      else focusPanel();
    }
    if (restoreScroll !== undefined) {
      body.scrollTop = restoreScroll;
      body.dataset.panelScroll = String(restoreScroll);
      restoreScroll = undefined;
    }
  }

  function changed(): void { paint(); options.changed({ ...state }); }

  function focusPanel(): void {
    if (!state.open || host.hidden || host.inert || activeModal()) return;
    const target = Array.from(body.querySelectorAll<HTMLElement>('.entity-title, h1, h2, h3, iframe.asset-webpage'))
      .find(usable) ?? body;
    if (!target.hasAttribute('tabindex') && target.tagName !== 'IFRAME') target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }

  function ensureFocus(): void {
    if (!state.open || activeModal()) return;
    if (!usable(document.activeElement as HTMLElement | null)) focusPanel();
  }

  function open({ focus = false }: { focus?: boolean } = {}): void {
    if (!view.available || activeModal()) return;
    if (!state.open) {
      options.beforeOpen?.();
      launcher = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      clearTimeout(hideTimer);
      const generation = ++revision;
      state.open = true;
      setConcealed(host, false);
      changed();
      requestAnimationFrame(() => {
        if (generation === revision && state.open) host.classList.add('is-open');
      });
    } else paint();
    if (focus) focusPanel();
  }

  function close({ restoreFocus = true, animate = true }: { restoreFocus?: boolean; animate?: boolean } = {}): void {
    if (!state.open && !session) return;
    finishResize(true);
    state.open = false;
    state.fullscreen = false;
    const active = document.activeElement as HTMLElement | null;
    const ownsFocus = !!active && host.contains(active);
    const generation = ++revision;
    clearTimeout(hideTimer);
    host.classList.remove('is-open');
    host.inert = true;
    host.setAttribute('aria-hidden', 'true');
    changed();
    const wait = animate ? duration() : 0;
    if (wait === 0) host.hidden = true;
    else hideTimer = setTimeout(() => { if (generation === revision && !state.open) host.hidden = true; }, wait);
    if (restoreFocus && (ownsFocus || !usable(active)) && !activeModal()) {
      const target = usable(launcher) ? launcher : options.fallback();
      if (usable(target)) target?.focus({ preventScroll: true });
    }
    launcher = null;
  }

  function dismiss(reason: 'close' | 'outside' | 'resize' | 'escape', restoreFocus = true): void {
    options.onDismiss?.(reason);
    close({ restoreFocus, animate: reason !== 'resize' });
  }

  function setMode(mode: ContextPanelMode): void {
    if (state.mode === mode && !state.fullscreen) return;
    finishResize(true);
    if (state.mode !== mode) chooseView('overview');
    state.mode = mode;
    state.fullscreen = false;
    remember(); changed();
  }

  function setView(next: ContextPanelTab): void {
    if (state.mode !== 'expanded' || next === 'content' && !hasContent() || next === state.view) return;
    chooseView(next);
    remember(); changed();
  }

  function toggleFullscreen(): void {
    if (!state.open || state.mode !== 'expanded') return;
    finishResize(true);
    state.fullscreen = !state.fullscreen;
    if (state.fullscreen && htmlContent()) chooseView('content');
    remember();
    changed();
  }

  function startResize(pointerId: number | null, clientX?: number): void {
    if (!state.open || state.fullscreen) return;
    const width = host.getBoundingClientRect().width || state.width;
    const right = host.parentElement?.getBoundingClientRect().right || viewport();
    session = {
      pointerId, keyboard: pointerId === null, startWidth: width, raw: width, width,
      gutter: Math.max(0, options.gutterWidth()), minimum: minimum(), snap: null, folded: false,
      mode: state.mode, startMode: state.mode, startView: state.view, startScroll: body.scrollTop,
      startScrolls: { ...scrolls }, startOpen: state.open,
      gripOffset: clientX === undefined ? 0 : right - clientX - width, moved: false,
    };
    paint();
  }

  function moveResize(raw: number): void {
    if (!session) return;
    const resolved = resolveContextResize(session, Math.max(0, Math.min(viewport(), raw)));
    Object.assign(session, resolved);
    session.moved ||= Math.abs(resolved.raw - session.startWidth) > 2;
    const modeChanged = state.mode !== resolved.mode;
    if (modeChanged) chooseView('overview');
    state.mode = resolved.mode;
    paint();
    if (modeChanged) options.changed({ ...state });
  }

  function finishResize(cancelled: boolean): void {
    if (!session) return;
    const finished = session;
    session = null;
    if (finished.pointerId !== null && resizer?.hasPointerCapture?.(finished.pointerId)) resizer.releasePointerCapture(finished.pointerId);
    if (cancelled) {
      state.mode = finished.startMode; state.view = finished.startView; state.open = finished.startOpen;
      scrolls = finished.startScrolls; restoreScroll = finished.startScroll;
    } else if (!finished.folded && finished.moved) widths[state.mode] = Math.round(finished.width);
    if (finished.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    if (!cancelled) remember();
    if (!cancelled && finished.folded) {
      // Drop the session first so closing does not roll its mode back.
      dismiss('resize');
      return;
    }
    changed();
  }

  function update(next: ContextPanelView): void {
    view = next;
    if (!next.available) close({ restoreFocus: false, animate: false });
    paint();
  }

  function listen<K extends keyof HTMLElementEventMap>(node: HTMLElement, event: K, handler: (event: HTMLElementEventMap[K]) => void): void {
    node.addEventListener(event, handler);
    cleanup.push(() => node.removeEventListener(event, handler));
  }

  function setup(): void {
    if (started) return;
    started = true;
    setConcealed(host, true);
    if (back) listen(back, 'click', () => { if (view.canBack) options.onBack?.(); });
    if (forward) listen(forward, 'click', () => { if (view.canForward) options.onForward?.(); });
    if (timeline) listen(timeline, 'click', () => { if (state.open && view.available) view.timelineAction?.onClick(); });
    if (closeButton) listen(closeButton, 'click', () => dismiss('close'));
    if (extent) listen(extent, 'click', () => setMode(state.mode === 'summary' ? 'expanded' : 'summary'));
    if (fullscreen) listen(fullscreen, 'click', toggleFullscreen);
    if (contentTab) listen(contentTab, 'click', () => setView('content'));
    if (overviewTab) listen(overviewTab, 'click', () => setView('overview'));
    if (selector) listen(selector, 'keydown', event => {
      if (state.mode !== 'expanded' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [contentTab, overviewTab].filter((tab): tab is HTMLButtonElement => !!tab && !tab.disabled);
      if (!tabs.length) return;
      event.preventDefault(); event.stopPropagation();
      const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (Math.max(0, current) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      const target = tabs[index];
      setView(target === contentTab ? 'content' : 'overview');
      target.focus({ preventScroll: true });
    });
    if (resizer) {
      listen(resizer, 'pointerdown', event => {
        if (event.button !== 0 || state.fullscreen || !state.open) return;
        event.preventDefault(); event.stopPropagation();
        resizer.focus({ preventScroll: true }); startResize(event.pointerId, event.clientX);
        resizer.setPointerCapture?.(event.pointerId);
      });
      listen(resizer, 'pointermove', event => {
        if (!session || session.pointerId !== event.pointerId) return;
        const right = host.parentElement?.getBoundingClientRect().right || viewport();
        moveResize(right - event.clientX - session.gripOffset);
      });
      listen(resizer, 'pointerup', event => { if (session?.pointerId === event.pointerId) finishResize(false); });
      listen(resizer, 'pointercancel', () => finishResize(true));
      listen(resizer, 'lostpointercapture', () => finishResize(true));
      listen(resizer, 'keydown', event => {
        if (!state.open || state.fullscreen) return;
        if (event.key === 'Enter') { event.preventDefault(); dismiss('resize'); return; }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const width = state.width, delta = event.shiftKey ? 50 : 10;
        startResize(null);
        moveResize(event.key === 'Home' ? minimum() : event.key === 'End' ? viewport() : width + (event.key === 'ArrowLeft' ? delta : -delta));
        finishResize(false);
      });
    }
    // A click's own handlers can detach or re-park its target, or open this
    // panel, before the click reaches the document. Judge it at capture, by
    // its target then, and only against a panel that was already open.
    let began: { event: MouseEvent; outside: boolean } | null = null;
    const clickStart = (event: MouseEvent) => {
      const target = event.target;
      began = { event, outside: state.open && target instanceof Node && !host.contains(target) && (options.shouldDismiss?.(event) ?? true) };
    };
    const clickAway = (event: MouseEvent) => {
      const outside = began?.event === event && began.outside;
      began = null;
      if (!outside || !state.open || session || suppressClick || activeModal() || event.defaultPrevented) return;
      dismiss('outside', false);
    };
    const resizeClick = (event: MouseEvent) => {
      if (!suppressClick) return;
      event.preventDefault(); event.stopImmediatePropagation();
      suppressClick = false;
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !state.open || activeModal() || event.defaultPrevented) return;
      event.preventDefault(); dismiss('escape');
    };
    document.addEventListener('click', resizeClick, true);
    document.addEventListener('click', clickStart, true);
    document.addEventListener('click', clickAway);
    document.addEventListener('keydown', keydown);
    cleanup.push(() => document.removeEventListener('click', resizeClick, true), () => document.removeEventListener('click', clickStart, true), () => document.removeEventListener('click', clickAway), () => document.removeEventListener('keydown', keydown));
    // The frame can stay in its compact configuration across many widths.
    // Track its actual geometry independently of frame state notifications.
    window.addEventListener('resize', paint);
    cleanup.push(() => window.removeEventListener('resize', paint));
    if (typeof ResizeObserver !== 'undefined' && host.parentElement) {
      const observer = new ResizeObserver(() => paint());
      observer.observe(host.parentElement);
      cleanup.push(() => observer.disconnect());
    }
    paint();
  }

  return {
    setup, update, open, close, setMode, setView, toggleFullscreen, ensureFocus,
    layout: paint,
    getState: (): Readonly<ContextPanelState> => ({ ...state }),
    destroy(): void {
      finishResize(true); clearTimeout(hideTimer); revision++;
      for (const remove of cleanup.splice(0)) remove();
      started = false;
    },
  };
}
