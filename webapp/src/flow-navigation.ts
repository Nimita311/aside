import { updateLatch } from './latch';

// Reading and moving the rendered flow: the anchors that hold an entry card at
// a viewport offset across a re-render, the time cursor under the latched
// readout, card lookups by moment, and the smooth scroll every jump lands
// with. app.ts owns the rebuild itself; these read and move what it rendered.

function flowScroller(): HTMLElement | null {
  return document.getElementById('flow-scroll');
}

// A flow anchor: the entry card to hold at a fixed viewport offset across a
// re-render, so the entry the user acted on stays put while the flow changes
// around it. `offset` is the card's top relative to the scroll pane's top.
export interface FlowAnchor {
  entryId: string;
  offset: number;
}

export interface VisibleTimelineDates { start: string; end: string }

// Calendar marks describe the records actually intersecting the reader,
// independently of chronological ordering or how many pages are loaded.
export function visibleTimelineDates(scroller: HTMLElement): VisibleTimelineDates | undefined {
  const bounds = scroller.getBoundingClientRect();
  if (bounds.bottom <= bounds.top) return undefined;
  const cards = scroller.querySelectorAll<HTMLElement>('.entry-card[data-entry-id]:not(.flow-ghost)');
  const measured = new Map<number, DOMRect | null>();
  const rectAt = (index: number): DOMRect | null => {
    if (!measured.has(index)) {
      const rect = cards[index].getBoundingClientRect();
      measured.set(index, rect.bottom > rect.top ? rect : null);
    }
    return measured.get(index)!;
  };
  // Cards follow physical vertical DOM order, regardless of query date order.
  // Find the first intersecting bottom without measuring every loaded page.
  // Hidden/zero-height cards have no ordered rectangle; probe around those
  // holes, retaining each measurement for the visible-card pass below.
  let low = 0, high = cards.length, first = cards.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    let index = middle, rect = rectAt(index);
    for (let distance = 1; !rect && (middle + distance < high || middle - distance >= low); distance++) {
      if (middle + distance < high) { index = middle + distance; rect = rectAt(index); }
      if (!rect && middle - distance >= low) { index = middle - distance; rect = rectAt(index); }
    }
    if (!rect) break;
    if (rect.bottom > bounds.top) { first = index; high = index; }
    else low = index + 1;
  }
  let start: string | undefined, end: string | undefined;
  for (let index = first; index < cards.length; index++) {
    const rect = rectAt(index);
    if (!rect) continue;
    if (rect.top >= bounds.bottom) break;
    if (rect.bottom <= bounds.top) continue;
    const day = cards[index].dataset.entryId!.slice(0, 10);
    if (!start || day < start) start = day;
    if (!end || day > end) end = day;
  }
  return start && end ? { start, end } : undefined;
}

// The anchor for a tag click: the enclosing entry card, if the click came
// from one. Clicks from the side panel or search have no card — no anchor.
export function anchorFromSource(source?: HTMLElement): FlowAnchor | null {
  const card = source?.closest<HTMLElement>('.entry-card');
  const scroller = flowScroller();
  if (!card?.dataset.entryId || !scroller) return null;
  return {
    entryId: card.dataset.entryId,
    offset: card.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
  };
}

// The time cursor: the entry under the latched date readout at the pane's
// top edge — the moment the readout displays. The anchor for everything
// the user didn't click (panel and search navigations, history entries,
// settings re-renders): anchoring it keeps the readout's time steady
// across a re-render, and when the entry doesn't survive the new filter,
// the moment's own location in the new timeline is pinned instead.
export function timeCursorAnchor(): FlowAnchor | null {
  const scroller = flowScroller();
  if (!scroller) return null;
  const srectTop = scroller.getBoundingClientRect().top;
  for (const card of scroller.querySelectorAll<HTMLElement>('.entry-card')) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= srectTop || !card.dataset.entryId) continue;
    return { entryId: card.dataset.entryId, offset: rect.top - srectTop };
  }
  return null;
}

// An anchor holding the given entry where it currently is — null when its
// card isn't on screen.
export function anchorForEntry(entryId: string): FlowAnchor | null {
  const scroller = flowScroller();
  const card = scroller?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
  if (!scroller || !card) return null;
  const rect = card.getBoundingClientRect();
  const srect = scroller.getBoundingClientRect();
  if (rect.bottom <= srect.top || rect.top >= srect.bottom) return null;
  return { entryId, offset: rect.top - srect.top };
}

// Resolve an anchor to a card in the rendered flow: the anchor's own card
// when it survives the current filter, otherwise the card nearest in time.
// Entry ids are ISO timestamps, so lexicographic order is time order, and
// cards can render in either creation order.
function resolveAnchorCard(flow: HTMLElement, entryId: string): HTMLElement | null {
  const exact = flow.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
  if (exact) return exact;
  const t = new Date(entryId).getTime();
  let best: HTMLElement | null = null, gap = Infinity;
  for (const card of flow.querySelectorAll<HTMLElement>('[data-entry-id]')) {
    const next = Math.abs(new Date(card.dataset.entryId!).getTime() - t);
    if (!best || next < gap || next === gap && card.dataset.entryId! < best.dataset.entryId!) { best = card; gap = next; }
  }
  return best;
}

// A card's top in the scroller's content coordinates — independent of the
// current scroll position, so it survives being scrolled to.
function cardTopInScroller(scroller: HTMLElement, card: HTMLElement): number {
  return card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

// Scroll so the anchor's resolved card sits at the remembered viewport
// offset; returns the resolved anchor (null when the flow is empty). A
// substitute — the surviving card nearest the displayed moment — is pinned
// flush with the readout (no higher than the pane top: the remembered
// offset can sit far above it, a long entry scrolled mostly past). The
// browser clamps at both ends: when the new flow is too short above the
// card, it moves as little as the content allows (the FLIP pass makes that
// residual shift a slide instead of a jump); a shortfall below is resolved
// by the caller loading more weeks — see anchorShortfall.
export function restoreAnchor(scroller: HTMLElement, flow: HTMLElement, anchor: FlowAnchor): FlowAnchor | null {
  const card = resolveAnchorCard(flow, anchor.entryId);
  if (!card) {
    scroller.scrollTo(0, 0);
    return null;
  }
  const entryId = card.dataset.entryId!;
  const offset = entryId === anchor.entryId ? anchor.offset : Math.max(anchor.offset, 0);
  scroller.scrollTop = cardTopInScroller(scroller, card) - offset;
  return { entryId, offset };
}

// How far below its offset the resolved anchor card sits after a restore —
// positive when the scroll clamped because too little of the timeline is
// loaded beneath it.
export function anchorShortfall(scroller: HTMLElement, anchor: FlowAnchor): number {
  const card = scroller.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(anchor.entryId)}"]`);
  if (!card) return 0;
  return card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
}

// Blank space between the bottom of the last built card and the bottom of the
// viewport after a restore — real content still to be built below.
// anchorShortfall only reacts to the anchor sinking; a top-clamped anchor (the
// newest match) sits fine yet leaves a full pane of this beneath it, which
// nothing else fills before the flight, so renderFlow checks it directly.
// scrollHeight can't stand in for this: the flow min-heights to the viewport,
// so it reports "full" even with a single card.
export function viewportGapBelow(scroller: HTMLElement): number {
  const cards = scroller.querySelectorAll<HTMLElement>('[data-entry-id]');
  const last = cards[cards.length - 1];
  if (!last) return 0;
  return scroller.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
}

// The cards already belong to the current filtered view. A
// calendar-date jump stays chronological; an exact-ID jump uses its own
// matching rule.
export function dateJumpCard(flow: HTMLElement, target: string, allowOldestClamp = true): HTMLElement | null {
  let before: HTMLElement | null = null, oldest: HTMLElement | null = null;
  for (const card of flow.querySelectorAll<HTMLElement>('[data-entry-id]')) {
    const id = card.dataset.entryId!;
    if (id <= target && (!before || id > before.dataset.entryId!)) before = card;
    if (!oldest || id < oldest.dataset.entryId!) oldest = card;
  }
  return before ?? (allowOldestClamp ? oldest : null);
}

// How long a jumped-to card keeps its highlight after landing.
const TARGET_FLASH_MS = 2000;

// Smooth-scroll the flow to a card over `duration` ms — instant at 0, which the
// app passes when animation is Off or under reduced motion; the native
// `scrollIntoView({ behavior: 'smooth' })` runs a fixed browser duration that
// honors neither, gliding even when the user asked for no motion. `block`
// 'center' vertically centers the card; otherwise its border lands at the pane
// top. Every entry uses the same metadata line, so its date and timestamp align
// with the fixed readout independently of its content.
function scrollFlowToCard(card: HTMLElement, block: ScrollLogicalPosition, duration: number): void {
  const scroller = flowScroller();
  if (!scroller) return;
  const cardTop = cardTopInScroller(scroller, card);
  let raw = cardTop;
  if (block === 'center') raw -= (scroller.clientHeight - card.offsetHeight) / 2;
  // Round toward the pane edge so fractional card heights cannot leave the
  // landed marker just below the readout, still showing the previous day.
  else raw = Math.ceil(raw);
  const dest = Math.max(0, Math.min(raw, scroller.scrollHeight - scroller.clientHeight));
  const from = scroller.scrollTop;
  if (duration <= 0 || Math.abs(dest - from) < 1) {
    scroller.scrollTop = dest;
    updateLatch();
    return;
  }
  const startTime = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    const t = Math.min(1, (now - startTime) / duration);
    scroller.scrollTop = from + (dest - from) * ease(t);
    if (t < 1) requestAnimationFrame(step);
    else updateLatch();
  };
  requestAnimationFrame(step);
}

// Scroll a card into view and flash it — the shared landing for a jump.
export function flashJump(card: HTMLElement, block: ScrollLogicalPosition, duration: number): void {
  scrollFlowToCard(card, block, duration);
  card.classList.add('is-target');
  setTimeout(() => card.classList.remove('is-target'), TARGET_FLASH_MS);
}
