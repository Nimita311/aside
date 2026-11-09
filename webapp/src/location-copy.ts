import { locationDisplay, parseLocationHandle } from './location-reference';

/** Restore a smart element's authored Markdown without making its label data. */
export function locationCopyText(chip: HTMLElement): string | null {
  const handle = chip.dataset.locationHandle;
  if (!handle) return null;
  const selectedLabel = chip.querySelector('.location-label')?.textContent ?? '';
  const ref = parseLocationHandle(handle);
  const fullLabel = chip.dataset.locationLabel ?? (ref ? locationDisplay(ref) : '');
  // cloneContents can retain the enclosing chip for a partly selected label.
  // Preserve that fragment as text instead of inventing a complete reference.
  if (selectedLabel !== fullLabel) return selectedLabel;
  const markdownLabel = chip.dataset.locationMarkdownLabel;
  if (markdownLabel !== undefined) return `[${markdownLabel}](${handle})`;
  const label = chip.dataset.locationLabel;
  return label === undefined ? handle : `[${label.replace(/[\\[\]]/g, '\\$&')}](${handle})`;
}
