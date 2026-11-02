// Renderer-owned description text is hidden and separate from the link name.
export function referenceLabel(node: HTMLElement): string {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.querySelector(':scope > .ref-description')?.remove();
  return copy.textContent ?? '';
}
