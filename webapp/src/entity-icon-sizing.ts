import { setEntityIcon, type IconKind } from './entity-icon-drawings';

// Live lifecycle paints reuse the last measured size without reading layout.
const renderedSizes = new WeakMap<Element, number>();
export function setReferenceIcon(host: Element, kind: IconKind, state: string, fallbackSize: number): void {
  setEntityIcon(host, kind, state, renderedSizes.get(host) ?? fallbackSize);
}

// References inherit typography. Choose their small/full artwork from the
// resulting SVG size, including newly mounted content and font-size changes.
export function setupEntityIconSizing(root: HTMLElement = document.body): () => void {
  const tracked = new Set<SVGSVGElement>();
  const pending = new Set<SVGSVGElement>();
  let frame: number | undefined;
  const flush = () => {
    frame = undefined;
    // Batch layout reads before any SVG replacement or attribute update.
    const updates = Array.from(pending).flatMap(icon => {
      if (!root.contains(icon)) return [];
      const size = Number.parseFloat(getComputedStyle(icon).width);
      const host = icon.parentElement;
      return host && Number.isFinite(size) && size > 0 ? [{ icon, host, size }] : [];
    });
    pending.clear();
    for (const { icon, host, size } of updates) {
      renderedSizes.set(host, size);
      if (Number(icon.getAttribute('width')) !== size) {
        setEntityIcon(host, icon.dataset.icon as IconKind, icon.dataset.state!, size);
      }
    }
  };
  const schedule = (icon: SVGSVGElement) => {
    pending.add(icon);
    frame ??= requestAnimationFrame(flush);
  };
  const resize = new ResizeObserver(entries => {
    for (const entry of entries) schedule(entry.target as SVGSVGElement);
  });
  const visit = (node: Node, callback: (icon: SVGSVGElement) => void) => {
    if (!(node instanceof Element)) return;
    const selector = 'svg.entity-icon[data-icon][data-state]';
    if (node.matches(selector)) callback(node as SVGSVGElement);
    for (const icon of node.querySelectorAll<SVGSVGElement>(selector)) callback(icon);
  };
  const observe = (icon: SVGSVGElement) => {
    if (tracked.has(icon) || !root.contains(icon)) return;
    tracked.add(icon);
    resize.observe(icon);
    schedule(icon);
  };
  const forget = (icon: SVGSVGElement) => {
    if (root.contains(icon)) return;
    tracked.delete(icon);
    pending.delete(icon);
    resize.unobserve(icon);
  };
  const mutations = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) visit(node, forget);
      for (const node of record.addedNodes) visit(node, observe);
    }
  });
  mutations.observe(root, { childList: true, subtree: true });
  visit(root, observe);
  return () => {
    mutations.disconnect();
    resize.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
    tracked.clear();
    pending.clear();
  };
}
