import { bindDisplay, setDisplayHtml } from './display';
import { highlight } from './search';
import type { RenderOptions } from './render';

// Keep the ID match available when a generated entry name changes format.
// The fallback and its highlighted nodes survive each display paint.
export function bindEntrySearchName(label: HTMLElement, container: HTMLElement, id: string, terms: string[], opts: RenderOptions, otherMarked: boolean): void {
  const idHtml = highlight(id, terms);
  let fallback: HTMLElement | undefined;
  if (idHtml.includes('<mark>')) {
    fallback = document.createElement('div');
    fallback.className = 'search-result-description search-result-id';
    fallback.innerHTML = idHtml;
    container.appendChild(fallback);
  }
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
