import type { RenderOptions } from './render';
type Paint = (node: HTMLElement, opts: RenderOptions) => void;
const paints = new WeakMap<HTMLElement, Paint>();
interface Motion { node: HTMLElement; animations: Animation[]; copy?: HTMLElement }
const motions = new WeakMap<HTMLElement, Motion>();
const activeMotions = new Set<Motion>();
function clearMotion(motion: Motion, cancel = false): void {
  if (!activeMotions.delete(motion)) return;
  if (motions.get(motion.node) === motion) motions.delete(motion.node);
  motion.copy?.remove();
  if (cancel) for (const animation of motion.animations) animation.cancel();
}
function cancelNodeMotion(node: HTMLElement): void {
  const motion = motions.get(node);
  if (motion) clearMotion(motion, true);
}
export function cancelDisplayMotion(): void {
  for (const motion of activeMotions) clearMotion(motion, true);
}
function trackMotion(node: HTMLElement, animations: Animation[], copy?: HTMLElement): void {
  const motion = { node, animations, copy };
  motions.set(node, motion);
  activeMotions.add(motion);
  void Promise.all(animations.map(animation => animation.finished))
    .then(() => clearMotion(motion), () => clearMotion(motion, true));
}
let context: (() => RenderOptions) | undefined;
let selectionRevision = 0;

// Folded rows revealed later use current display options. Weak keys retain
// no removed views. Sanitized authored Markdown cannot register a paint.
export function setDisplayContext(provider: (() => RenderOptions) | undefined): void { context = provider; }
export function bindDisplay<T extends HTMLElement>(node: T, opts: RenderOptions, paint: Paint): T {
  node.dataset.liveDisplay = '';
  paints.set(node, paint);
  paint(node, context?.() ?? opts);
  return node;
}
export function setDisplayText(node: HTMLElement, text: string): void {
  if (node.textContent === text) return;
  if (node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE) node.firstChild.nodeValue = text;
  else node.textContent = text;
}
// Only renderer-produced escaped markup belongs here. Retain matching text
// and mark nodes; changed highlighting maps selections by label text offset.
export function setDisplayHtml(node: HTMLElement, html: string): void {
  if (node.innerHTML === html) return;
  const template = document.createElement('template'); template.innerHTML = html;
  const sameShape = (left: Node, right: Node): boolean => {
    if (left.nodeType !== right.nodeType) return false;
    if (left instanceof Element && right instanceof Element && (left.tagName !== right.tagName ||
        left.attributes.length !== right.attributes.length || Array.from(left.attributes).some(attr => right.getAttribute(attr.name) !== attr.value))) return false;
    return left.childNodes.length === right.childNodes.length && Array.from(left.childNodes).every((child, index) => sameShape(child, right.childNodes[index]));
  };
  const retained = node.childNodes.length === template.content.childNodes.length &&
    Array.from(node.childNodes).every((child, index) => sameShape(child, template.content.childNodes[index]));
  const selection = window.getSelection();
  const point = (target: Node | null, offset: number) => {
    if (!target) return undefined;
    if (!node.contains(target)) return { target, offset };
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(target, offset);
    return { target, offset, textOffset: range.toString().length };
  };
  const anchor = selection && point(selection.anchorNode, selection.anchorOffset), focus = selection && point(selection.focusNode, selection.focusOffset);
  const patchText = (left: Node, right: Node): void => {
    if (left.nodeType === Node.TEXT_NODE && left.nodeValue !== right.nodeValue) left.nodeValue = right.nodeValue;
    else Array.from(left.childNodes).forEach((child, index) => patchText(child, right.childNodes[index]));
  };
  if (retained) Array.from(node.childNodes).forEach((child, index) => patchText(child, template.content.childNodes[index]));
  else node.replaceChildren(...Array.from(template.content.childNodes));
  const locate = (saved: NonNullable<typeof anchor>) => {
    if (retained || saved.textOffset === undefined) return { target: saved.target, offset: Math.min(saved.offset,
      saved.target.nodeType === Node.TEXT_NODE ? saved.target.textContent?.length ?? 0 : saved.target.childNodes.length) };
    let remaining = saved.textOffset, last: Text | undefined;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode() as Text | null; current; current = walker.nextNode() as Text | null) {
      if (remaining <= current.length) return { target: current, offset: remaining };
      remaining -= current.length; last = current;
    }
    return { target: last ?? node, offset: last?.length ?? node.childNodes.length };
  };
  if (selection && anchor && focus && (anchor.textOffset !== undefined || focus.textOffset !== undefined)) {
    const start = locate(anchor), end = locate(focus);
    if (start.target.isConnected && end.target.isConnected) {
      selection.setBaseAndExtent(start.target, start.offset, end.target, end.offset);
      selectionRevision++;
    }
  }
}
function visualValue(node: HTMLElement): string { return `${node.className}\0${node.innerHTML}\0${node.title}\0${node.hidden}`; }
function crossfade(node: HTMLElement, copy: HTMLElement, rect: DOMRect, duration: number): void {
  if (!duration || !node.animate || !rect.width || !rect.height || node.hidden) return;
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    for (const attr of Array.from(el.attributes)) if (attr.name === 'id' || attr.name.startsWith('data-')) el.removeAttribute(attr.name);
    el.removeAttribute('autofocus');
  }
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  Object.assign(copy.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', pointerEvents: 'none', zIndex: '1000', boxSizing: 'border-box' });
  cancelNodeMotion(node);
  (node.closest('dialog[open]') ?? document.body).appendChild(copy);
  const incoming = node.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease-out' });
  const outgoing = copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'ease-out' });
  trackMotion(node, [incoming, outgoing], copy);
}
// Patch only interface presentation, retaining surrounding controls/media.
export function refreshDisplay(root: ParentNode, opts: RenderOptions, duration = 0): void {
  for (const motion of activeMotions) if (!motion.node.isConnected || (!duration && (root as Node).contains(motion.node))) clearMotion(motion, true);
  const selection = window.getSelection();
  let saved = selection?.rangeCount ? { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset } : undefined;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-live-display]'));
  if (root instanceof HTMLElement && root.hasAttribute('data-live-display')) nodes.unshift(root);
  // Read every node's outgoing presentation before painting any of them: a
  // paint dirties layout, and a rect or computed style read after one forces
  // the browser to lay the document out again — once per node, every minute.
  const pending = nodes.flatMap(node => {
    const paint = paints.get(node);
    if (!paint || !node.isConnected) return [];
    const before = visualValue(node);
    const animate = duration && typeof node.animate === 'function' && !node.hasAttribute('data-live-container') && !node.querySelector('audio, video');
    const old = animate ? { html: node.innerHTML, className: node.className, title: node.title, hidden: node.hidden,
      rect: node.getBoundingClientRect(), style: getComputedStyle(node) } : null;
    // Snapshot the old computed style before paint: getComputedStyle is live.
    const style = old ? { font: old.style.font, lineHeight: old.style.lineHeight, color: old.style.color,
      letterSpacing: old.style.letterSpacing, textAlign: old.style.textAlign, visibility: old.style.visibility } : undefined;
    return [{ node, paint, before, old, style }];
  });
  for (const { node, paint, before, old, style } of pending) {
    if (!node.isConnected) continue;
    const revision = selectionRevision;
    paint(node, opts);
    // A markup paint may remap an element boundary to a text offset. Preserve
    // that deliberate selection through later paints and the outer restoration.
    if (revision !== selectionRevision && selection?.rangeCount) saved = { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset };
    const changed = before !== visualValue(node);
    if (changed) cancelNodeMotion(node);
    if (old && changed && old.rect.width && old.rect.height && !node.hidden && style?.visibility !== 'hidden' && style?.visibility !== 'collapse') {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.innerHTML = old.html;
      copy.className = old.className;
      copy.title = old.title;
      copy.hidden = old.hidden;
      Object.assign(copy.style, style);
      crossfade(node, copy, old.rect, duration);
    }
  }
  if (saved?.anchor?.isConnected && saved.focus?.isConnected && selection &&
      (selection.anchorNode !== saved.anchor || selection.anchorOffset !== saved.anchorOffset || selection.focusNode !== saved.focus || selection.focusOffset !== saved.focusOffset)) {
    const limit = (node: Node, offset: number) => Math.min(offset, node.nodeType === Node.TEXT_NODE ? node.textContent?.length ?? 0 : node.childNodes.length);
    selection.setBaseAndExtent(saved.anchor, limit(saved.anchor, saved.anchorOffset), saved.focus, limit(saved.focus, saved.focusOffset));
  }
}
export function refreshRevealed(root: ParentNode, fallback?: RenderOptions): void {
  const opts = context?.() ?? fallback;
  if (opts) refreshDisplay(root, opts);
}
export function moveDisplayNode(node: HTMLElement, before: HTMLElement | null, parent: HTMLElement, duration = 0): void {
  if (node.parentElement === parent && node.nextElementSibling === before) return;
  const old = node.getBoundingClientRect();
  cancelNodeMotion(node);
  parent.insertBefore(node, before);
  const current = node.getBoundingClientRect();
  const delta = old.top - current.top;
  if (duration && node.animate && delta && old.height && Math.abs(delta) < window.innerHeight && old.bottom > 0 && old.top < window.innerHeight && current.bottom > 0 && current.top < window.innerHeight) {
    const motion = node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration, easing: 'ease-out' });
    trackMotion(node, [motion]);
  }
}
export function preserveDisplayPosition(containers: HTMLElement[], paint: () => void): void {
  const anchors = containers.map(container => {
    const bounds = container.getBoundingClientRect();
    const anchor = Array.from(container.querySelectorAll<HTMLElement>('[data-entry-id], a, button, .detail-body, .related-item'))
      .find(node => { const r = node.getBoundingClientRect(); return r.height > 0 && r.bottom > bounds.top && r.top < bounds.bottom; });
    return { container, anchor, top: anchor?.getBoundingClientRect().top };
  });
  paint();
  for (const { container, anchor, top } of anchors) if (anchor?.isConnected && top !== undefined) container.scrollTop += anchor.getBoundingClientRect().top - top;
}

// A diagram can resize inside the very card/body being read. Anchoring that
// ancestor's top cannot retain the text below it, so capture a visible text
// line instead. Mermaid's output and source may be replaced or folded by the
// paint; only surrounding content makes a stable anchor.
export function preserveReadingPosition(containers: HTMLElement[], paint: () => void): void {
  const anchors = containers.map(container => {
    const bounds = container.getBoundingClientRect();
    const excluded = '.mermaid-diagram, [hidden], .flow-ghosts, .date-latch';
    const visible = (rect: DOMRect) => rect.height > 0 && rect.width > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
      && rect.right > bounds.left && rect.left < bounds.right;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !(node.parentElement instanceof HTMLElement)
          || node.parentElement.closest(excluded)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects());
      const line = rects.findIndex(visible);
      if (line >= 0) return { container, node, top: rects[line].top, readTop: () => range.getClientRects()[line]?.top };
    }
    // Media-only content still needs an anchor. Prefer a visible descendant
    // over its containing card so changes inside that card are reflected.
    const candidates = Array.from(container.querySelectorAll<HTMLElement>(
      '[data-entry-id], a, button, summary, .detail-body, .related-item, p, pre, li, img, video, audio, table, h1, h2, h3, h4, h5, h6',
    )).filter(node => !node.closest(excluded) && visible(node.getBoundingClientRect()));
    const node = candidates.find(candidate => !candidates.some(other => other !== candidate && candidate.contains(other)));
    return { container, node, top: node?.getBoundingClientRect().top, readTop: () => node?.getBoundingClientRect().top };
  });
  paint();
  for (const { container, node, top, readTop } of anchors) {
    if (!node?.isConnected || !container.contains(node) || top === undefined) continue;
    const currentTop = readTop();
    if (currentTop !== undefined) container.scrollTop += currentTop - top;
  }
}
