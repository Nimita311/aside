import { locationCopyText } from './location-copy';

// Copying rendered references restores their authored handles: a whole
// location or date label, or any selection that crosses inline chips.
export function setupRefCopy(): void {
  document.addEventListener('copy', (e) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (range.collapsed) return;
    // Selecting only the visible label omits its enclosing anchor from
    // cloneContents(). Restore complete smart elements to their authored form;
    // partial label selections keep the browser's ordinary copy behavior.
    const ancestor = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const locationChip = ancestor?.closest<HTMLElement>('.inline-tag-location[data-location-handle]');
    const locationLabel = locationChip?.querySelector('.location-label');
    if (locationLabel && locationLabel.contains(range.startContainer) && locationLabel.contains(range.endContainer)
        && range.toString() === locationLabel.textContent) {
      e.clipboardData!.setData('text/plain', locationCopyText(locationChip!)!);
      e.preventDefault();
      return;
    }
    const dateChip = ancestor?.closest<HTMLElement>('.inline-tag-date[data-date-handle]');
    const dateLabel = dateChip?.querySelector('time');
    if (dateLabel && dateLabel.contains(range.startContainer) && dateLabel.contains(range.endContainer)
        && range.toString() === dateLabel.textContent) {
      e.clipboardData!.setData('text/plain', dateChip!.dataset.dateHandle!);
      e.preventDefault();
      return;
    }
    const fragment = range.cloneContents();
    const inlineTags = fragment.querySelectorAll('.inline-tag');
    if (inlineTags.length === 0) return;

    for (const tag of inlineTags) {
      const location = locationCopyText(tag as HTMLElement);
      if (location !== null) {
        tag.replaceWith(location);
        continue;
      }
      const date = (tag as HTMLElement).dataset.dateHandle;
      if (date) {
        tag.replaceWith(date);
        continue;
      }
      const type = (tag as HTMLElement).dataset.refType;
      const id = (tag as HTMLElement).dataset.refId;
      if (type && id) {
        tag.replaceWith(`#${type}/${id}`);
      }
    }

    const tempDiv = document.createElement('div');
    tempDiv.appendChild(fragment);
    e.clipboardData!.setData('text/plain', tempDiv.textContent || '');
    e.preventDefault();
  });
}
