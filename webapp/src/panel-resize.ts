// The side panel's width: bounds that honor the viewport, the persisted width,
// and the resize handle driven by pointer or keys. The width lives in the
// --side-panel-width CSS variable and persists across sessions.

const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 720;

// Panel width bounds — drag, keys and persisted widths honor the viewport.
function panelWidthBounds(): { min: number; max: number } {
  const max = Math.round(Math.min(PANEL_MAX_WIDTH, window.innerWidth * 0.9));
  return { min: Math.min(PANEL_MIN_WIDTH, max), max };
}

function clampPanelWidth(width: number): number {
  const { min, max } = panelWidthBounds();
  return Math.round(Math.min(Math.max(width, min), max));
}

function setPanelWidth(width: number): number {
  width = clampPanelWidth(width);
  document.documentElement.style.setProperty('--side-panel-width', `${width}px`);
  const { min, max } = panelWidthBounds();
  const handle = document.getElementById('side-panel-resize');
  handle?.setAttribute('aria-valuemin', String(min));
  handle?.setAttribute('aria-valuemax', String(max));
  handle?.setAttribute('aria-valuenow', String(width));
  handle?.setAttribute('aria-valuetext', `${width} pixels wide`);
  return width;
}

// The panel's home width: parked in the flow's right margin, flush with the
// column so it covers nothing (the column's own right padding keeps the text
// clear). Clamping takes over when the margin is too tight.
function defaultPanelWidth(): number {
  const flow = document.querySelector<HTMLElement>('.flow');
  if (!flow) return PANEL_MIN_WIDTH;
  return clampPanelWidth(window.innerWidth - flow.getBoundingClientRect().right);
}

// Apply the persisted panel width (falling back to the home width) to the
// CSS var — at startup, and when re-expanding (after a drag-to-fold the var
// still holds the dragged width the slide-out animated from).
export function applyStoredPanelWidth(): void {
  const saved = Number(localStorage.getItem('panelWidth'));
  // Clamped against the current window — it may have shrunk since the save.
  setPanelWidth(saved && Number.isFinite(saved) ? saved : defaultPanelWidth());
}

export interface PanelResizeDeps {
  // Retract the panel to the docked pill, and bring it back.
  collapse(): void;
  expand(): void;
  // The current transition length, for the animated snap home.
  transitionMs(): number;
}

// Resize from the panel's left edge with a pointer or keys: arrows step the
// width, Home/End set the bounds, Enter retracts, Shift+Enter or a
// double-click snaps back to the home width.
export function bindPanelResize({ collapse, expand, transitionMs }: PanelResizeDeps): void {
  const handle = document.getElementById('side-panel-resize');
  if (!handle) return;
  window.addEventListener('resize', applyStoredPanelWidth);
  const panel = () => document.getElementById('side-panel');

  const resetWidth = () => {
    const el = panel();
    el?.classList.add('is-snapping');
    localStorage.setItem('panelWidth', String(setPanelWidth(defaultPanelWidth())));
    setTimeout(() => el?.classList.remove('is-snapping'), transitionMs());
  };
  handle.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) resetWidth();
      else collapse();
      return;
    }
    const current = Number(handle.getAttribute('aria-valuenow'));
    const step = event.shiftKey ? 50 : 10;
    const { min, max } = panelWidthBounds();
    const width = event.key === 'ArrowLeft' ? current + step
      : event.key === 'ArrowRight' ? current - step
      : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
    if (width === undefined) return;
    event.preventDefault();
    panel()?.classList.remove('is-snapping');
    localStorage.setItem('panelWidth', String(setPanelWidth(width)));
  });

  // Dragging one hysteresis step past the minimum reads as "close" — fold to
  // the pill; dragging back past the minimum unfolds. The step is just wide
  // enough that the boundary can't thrash.
  const HYSTERESIS = 20;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(e.pointerId);
    // A drag right after a double-click must track instantly, not animate.
    panel()?.classList.remove('is-snapping');
    document.body.classList.add('is-panel-resizing');
    const startWidth = panel()?.offsetWidth ?? PANEL_MIN_WIDTH;
    let width = 0;
    let folded = false;

    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      // Only one of the two {once} registrations below fired — drop the other,
      // or stale onUp closures pile up and replay on a later pointercancel.
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('is-panel-resizing');
      // A fold keeps the pre-drag width for the next expand; a resize keeps
      // the released width.
      if (folded) localStorage.setItem('panelWidth', String(startWidth));
      else if (width) localStorage.setItem('panelWidth', String(width));
    };
    const onMove = (ev: PointerEvent) => {
      const raw = window.innerWidth - ev.clientX;
      const { min } = panelWidthBounds();
      if (!folded && raw < min - HYSTERESIS) {
        // Fold, but keep the gesture alive: the CSS var holds the dragged
        // width so the slide-out starts from it, and dragging back out
        // before releasing reopens the panel (the escape hatch below).
        folded = true;
        collapse();
        return;
      }
      if (folded) {
        if (raw < min) return;
        folded = false;
        expand();
      }
      width = setPanelWidth(raw);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });

  // Double-click snaps back to the home width, animated.
  handle.addEventListener('dblclick', resetWidth);
}
