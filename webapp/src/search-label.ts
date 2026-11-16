import { bindDisplay, setDisplayHtml } from './display';
import { highlight } from './search';
import type { RenderOptions } from './render';

// The row for a hit that lives only in the id; none when the id carries no mark.
export function appendIdMatch(container: HTMLElement, id: string, terms: string[]): HTMLElement | undefined {
  const idHtml = highlight(id, terms);
  if (!idHtml.includes('<mark>')) return undefined;
  const row = document.createElement('div');
  row.className = 'search-result-description search-result-id';
  row.innerHTML = idHtml;
  container.appendChild(row);
  return row;
}

// Keep the ID match available when a generated entry name changes format.
// The fallback and its highlighted nodes survive each display paint.
export function bindEntrySearchName(label: HTMLElement, container: HTMLElement, id: string, terms: string[], opts: RenderOptions, otherMarked: boolean): void {
  const fallback = appendIdMatch(container, id, terms);
  bindDisplay(label, opts, (node, current) => {
    const html = highlight(current.resolveName('entry', id), terms);
    setDisplayHtml(node, html);
    if (fallback) {
      fallback.hidden = otherMarked || html.includes('<mark>');
      // The description's author CSS sets display, overriding native hidden.
      fallback.style.display = fallback.hidden ? 'none' : '';
    }
  });
}
