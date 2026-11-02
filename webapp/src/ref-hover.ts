// Hovering any reference to an entity — a tag, an inline mention, or the
// docked filter pill — co-highlights every other reference to that same
// entity on the page. Each reference carries data-ref-type / data-ref-id;
// a single delegated listener keys off the pair the pointer is over.
let coHoveredRefKey: string | null = null;

function refKeyOf(el: HTMLElement): string | null {
  const { refType, refId } = el.dataset;
  return refType && refId ? `${refType}\0${refId}` : null;
}

function applyRefCoHover(key: string | null): void {
  if (key === coHoveredRefKey) return;
  for (const el of document.querySelectorAll('.is-cohovered')) {
    el.classList.remove('is-cohovered');
  }
  coHoveredRefKey = key;
  if (!key) return;
  const [type, id] = key.split('\0');
  const sel = `[data-ref-type="${CSS.escape(type)}"][data-ref-id="${CSS.escape(id)}"]`;
  for (const el of document.querySelectorAll(sel)) el.classList.add('is-cohovered');
  // A +N bubble folds several entities behind it; it lights up when the hovered
  // one is among them (its token list is `type:id` entries, whitespace-joined).
  const token = `${type}:${id}`.replace(/["\\]/g, '\\$&');
  for (const el of document.querySelectorAll(`[data-ref-hidden~="${token}"]`)) {
    el.classList.add('is-cohovered');
  }
}

export function setupRefCoHover(): void {
  document.body.addEventListener('mouseover', (e) => {
    const ref = (e.target as HTMLElement).closest<HTMLElement>('[data-ref-id]');
    applyRefCoHover(ref ? refKeyOf(ref) : null);
  });
  document.body.addEventListener('mouseout', (e) => {
    // Clear only when the pointer leaves for somewhere outside any reference;
    // a move onto another reference is handled by the mouseover above.
    const to = (e.relatedTarget as HTMLElement | null)?.closest('[data-ref-id]');
    if (!to) applyRefCoHover(null);
  });
}
