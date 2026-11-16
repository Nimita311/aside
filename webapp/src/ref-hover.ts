// References share hover feedback by complete entity identity or by a smart
// element/file's canonical handle. Hover-only keys do not change copy syntax.
const REFERENCE = '[data-ref-id], [data-ref-hover]';

function refKeyOf(el: HTMLElement): string | null {
  const { refType, refId, refHover } = el.dataset;
  if (refHover) return `hover\0${refHover}`;
  return refType && refId ? `${refType}\0${refId}` : null;
}

function applyRefCoHover(key: string | null): void {
  for (const el of document.querySelectorAll('.is-cohovered')) {
    el.classList.remove('is-cohovered');
  }
  if (!key) return;
  const [type, id] = key.split('\0');
  const sel = type === 'hover' ? `[data-ref-hover="${CSS.escape(id)}"]`
    : `[data-ref-type="${CSS.escape(type)}"][data-ref-id="${CSS.escape(id)}"]`;
  for (const el of document.querySelectorAll(sel)) el.classList.add('is-cohovered');
  if (type === 'hover') return;
  // A +N bubble folds several entities behind it; it lights up when the hovered
  // one is among them (its token list is `type:id` entries, whitespace-joined).
  const token = `${type}:${id}`.replace(/["\\]/g, '\\$&');
  for (const el of document.querySelectorAll(`[data-ref-hidden~="${token}"]`)) {
    el.classList.add('is-cohovered');
  }
}

export function setupRefCoHover(): () => void {
  let hoveredKey: string | null = null;
  const clear = () => { hoveredKey = null; applyRefCoHover(null); };
  const over = (e: PointerEvent) => {
    if (e.pointerType === 'touch') { clear(); return; }
    const ref = e.target instanceof Element ? e.target.closest<HTMLElement>(REFERENCE) : null;
    const previous = e.relatedTarget instanceof Element ? e.relatedTarget.closest(REFERENCE) : null;
    if (ref && ref === previous) return;
    hoveredKey = ref ? refKeyOf(ref) : null;
    applyRefCoHover(hoveredKey);
  };
  const out = (e: PointerEvent) => {
    // Clear only when the pointer leaves for somewhere outside any reference;
    // a move onto another reference is handled by pointerover above.
    const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest(REFERENCE) : null;
    if (!to) clear();
  };
  // Loading more history and live metadata repaint can replace references
  // while the pointer stays still. Newly mounted matches share that hover.
  const mutations = new MutationObserver(() => {
    if (hoveredKey) applyRefCoHover(hoveredKey);
  });
  mutations.observe(document.body, { childList: true, subtree: true });
  document.body.addEventListener('pointerover', over);
  document.body.addEventListener('pointerout', out);
  document.body.addEventListener('pointercancel', clear);
  window.addEventListener('blur', clear);
  return () => {
    mutations.disconnect();
    document.body.removeEventListener('pointerover', over);
    document.body.removeEventListener('pointerout', out);
    document.body.removeEventListener('pointercancel', clear);
    window.removeEventListener('blur', clear);
    clear();
  };
}
