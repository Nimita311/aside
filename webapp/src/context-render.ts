import { readerDetails } from './render';

function children(element: HTMLElement): HTMLElement[] {
  return Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
}

function detailRegion(nodes: HTMLElement[]): HTMLElement | undefined {
  if (!nodes.length) return undefined;
  const region = document.createElement('div');
  region.dataset.contextDetail = '';
  region.append(...nodes);
  return region;
}

function retainBody(next: HTMLElement, previous: HTMLElement): HTMLElement {
  const selector = ':scope > [data-context-detail] > .detail-body';
  const bodies = Array.from(next.querySelectorAll<HTMLElement>(selector));
  const retained = Array.from(previous.querySelectorAll<HTMLElement>(selector));
  const region = bodies[0]?.parentElement, previousRegion = retained[0]?.parentElement;
  if (!region || !previousRegion || bodies.length !== retained.length ||
    bodies.some(node => node.parentElement !== region) || retained.some(node => node.parentElement !== previousRegion)) return next;

  // Moving an iframe or one of its ancestors into a detached replacement
  // destroys its browsing context. Keep the existing root and record region
  // mounted, replacing only the surrounding metadata and related sections.
  for (const node of Array.from(previousRegion.childNodes)) {
    if (!retained.includes(node as HTMLElement)) node.remove();
  }
  let index = 0;
  for (const node of Array.from(region.childNodes)) {
    if (node === bodies[index]) index++;
    else previousRegion.insertBefore(node, retained[index] ?? null);
  }
  for (const node of Array.from(previous.childNodes)) {
    if (node !== previousRegion) node.remove();
  }
  let passedRegion = false;
  for (const node of Array.from(next.childNodes)) {
    if (node === region) passedRegion = true;
    else previous.insertBefore(node, passedRegion ? null : previousRegion);
  }
  previous.className = next.className;
  if (next.dataset.contextPresentation) previous.dataset.contextPresentation = next.dataset.contextPresentation;
  else delete previous.dataset.contextPresentation;
  return previous;
}

// Summary and expanded context share their identity, related sections and
// mounted content. Summary keeps the concise context; expanded Content and
// Overview expose the body and complete context separately. Switching only
// conceals renderer-owned regions, never cloning or remounting the content.
// `detail` is the existing complete-record renderer for project/action/instance
// summaries. Assets and artifacts supply that renderer as the sole argument.
export function renderContextContent(
  summary: HTMLElement,
  detail?: HTMLElement,
  retained?: HTMLElement,
  essentials?: HTMLElement,
): HTMLElement {
  const page = detail ?? summary;
  const metadata = readerDetails(page);
  const summaryRoot = readerDetails(summary) ?? summary;
  const detailRoot = metadata ?? page;
  const container = summaryRoot;
  container.classList.add('context-content');

  // Panel expansion belongs to its stable toolbar, rather than a second
  // open-body affordance embedded in the title.
  for (const link of container.querySelectorAll<HTMLElement>('.entity-title > .title-open')) {
    link.querySelector('.title-detail')?.remove();
    link.replaceWith(...Array.from(link.childNodes));
  }

  const bodyNodes = children(detailRoot).filter(node => node.classList.contains('detail-body'));
  // Full-page HTML's renderer stores identity/context separately and mounts
  // its one live iframe on the page. Move that same node into the expansion.
  if (metadata) bodyNodes.push(...children(page));
  const fields = detail && detailRoot !== container
    ? children(detailRoot).filter(node => node.classList.contains('detail-fields')) : [];
  const extraRelated = detail && detailRoot !== container
    ? children(detailRoot).filter(node => node.classList.contains('entity-related')) : [];

  if (essentials) {
    // Only the context panel adopts the shared Essentials design. Native
    // readers keep their own headers, and the existing body/iframe stays
    // mounted below this replacement identity and facts section.
    for (const node of children(container)) {
      if (node.matches('.entity-title, .status-pills, .summary-description, .summary-facts')) node.remove();
      else if (node.matches('.asset-path, .artifact-parent')) {
        if (essentials.dataset.kind === 'file') node.remove(); // The plain path is already in Essentials.
        else fields.push(node); // Handles and parent navigation are detailed context, not key facts.
      }
    }
    container.prepend(essentials);
  }

  if (container.querySelector('.summary-facts')) {
    // The complete record's Stats fold repeats the summary facts. Retain all
    // additional hierarchy and lifecycle sections without repeating counts.
    for (const section of extraRelated.flatMap(node => Array.from(node.querySelectorAll<HTMLDetailsElement>('details.detail-section')))) {
      if (section.querySelector(':scope > summary')?.textContent?.trim() === 'Stats') section.remove();
    }
  }

  for (const node of bodyNodes) node.dataset.contextView = 'content';
  for (const node of [...fields, ...extraRelated]) node.dataset.contextView = 'overview';
  for (const node of children(container)) {
    if (node.matches('.entity-related, .related-section, .detail-fields, .artifact-parent, .asset-path')) {
      node.dataset.contextView = 'overview';
    }
  }

  const related = children(container).find(node => node.classList.contains('entity-related') || node.classList.contains('related-section'));
  const insertionPoint = related ?? null;
  const record = detailRegion([...fields, ...bodyNodes]);
  // Moving a body already mounted in the sole input first detaches it, so
  // both its normal summary fields and related links remain in place.
  if (record) container.insertBefore(record, insertionPoint);
  const additions = detailRegion(extraRelated.filter(node => node.childElementCount));
  if (additions) container.append(additions);
  if (metadata) container.dataset.contextPresentation = 'html';
  // The caller supplies a retained root only when the target and its authored
  // body/attachment are unchanged, and leaves that returned root mounted.
  return retained ? retainBody(container, retained) : container;
}
