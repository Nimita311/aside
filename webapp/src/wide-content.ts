interface Position {
  applied?: number;
  fits?: boolean;
  panned: boolean;
}
const positions = new WeakMap<HTMLElement, Position>();

// A padded scroll viewport exposes both reader margins without changing the
// prose measure. Its trailing padding lets overflowing content's final edge
// scroll all the way back to the prose edge.
export function wrapWideBlock(content: HTMLElement): HTMLDivElement {
  const viewport = document.createElement('div');
  viewport.className = 'wide-block';
  viewport.tabIndex = 0; // Keep keyboard scrolling reachable with hidden scrollbars.
  positions.set(viewport, { panned: false });
  content.replaceWith(viewport);
  viewport.append(content);
  return viewport;
}

// Called by the existing mount, diagram, disclosure, and frame layout paths.
// No observers retain old views, and a user's horizontal pan stays theirs.
export function alignWideBlocks(root: HTMLElement): void {
  if (!root.isConnected) return;
  for (const viewport of root.querySelectorAll<HTMLElement>('.wide-block')) {
    const state = positions.get(viewport);
    const content = viewport.firstElementChild;
    if (!state || !(content instanceof HTMLElement) || content.hidden || viewport.closest('details:not([open])')) continue;
    const style = getComputedStyle(viewport);
    const width = viewport.clientWidth;
    const natural = content.getBoundingClientRect().width;
    if (!width || !natural || style.visibility === 'hidden') continue;
    if (state.applied !== undefined && !state.fits) {
      // Resizing may clamp the previous position without any user movement.
      const expected = Math.min(state.applied, Math.max(0, viewport.scrollWidth - width));
      if (Math.abs(viewport.scrollLeft - expected) > 1) state.panned = true;
    }
    if (state.panned) continue;
    const left = parseFloat(style.paddingLeft) || 0;
    const right = parseFloat(style.paddingRight) || 0;
    const prose = width - left - right;
    const fits = natural <= width + 0.5;
    // Fully visible blocks do not need a horizontal scroll range. An inner
    // offset centers them even when the available margins are asymmetric.
    const offset = fits && natural > prose + 0.5 ? (width - natural) / 2 - left : 0;
    viewport.style.setProperty('--wide-offset', `${offset}px`);
    viewport.classList.toggle('is-fit', fits);
    viewport.scrollLeft = fits ? 0 : left;
    state.applied = viewport.scrollLeft;
    state.fits = fits;
  }
}

export function prepareWideBlocks(root: HTMLElement): void {
  for (const child of Array.from(root.children)) {
    if (child instanceof HTMLElement && (child.tagName === 'TABLE' || child.tagName === 'PRE')) wrapWideBlock(child);
  }
}
