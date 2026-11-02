import { getMondayOfWeek } from '../lib/types';
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
// cards render latest-first.
function resolveAnchorCard(flow: HTMLElement, entryId: string): HTMLElement | null {
  const exact = flow.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
  if (exact) return exact;
  const t = new Date(entryId).getTime();
  let above: HTMLElement | null = null;
  for (const card of flow.querySelectorAll<HTMLElement>('[data-entry-id]')) {
    if (card.dataset.entryId! > entryId) { above = card; continue; }
    // First card at-or-before the moment — closer than the one above it?
    if (!above) return card;
    const dAbove = new Date(above.dataset.entryId!).getTime() - t;
    const dBelow = t - new Date(card.dataset.entryId!).getTime();
    return dBelow <= dAbove ? card : above;
  }
  return above;
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

// The latest-first cards already belong to the current filtered view. A
// calendar-date jump stays chronological; exact-ID and quick-near jumps use
// their separate matching rules.
export function dateJumpCard(flow: HTMLElement, target: string, allowOldestClamp = true): HTMLElement | null {
  const cards = Array.from(flow.querySelectorAll<HTMLElement>('[data-entry-id]'));
  return cards.find(card => card.dataset.entryId! <= target)
    ?? (allowOldestClamp ? cards.at(-1) ?? null : null);
}

// A period step must advance to another date in the arrow's direction even
// when the current day would be closest to the target in a sparse timeline.
export function quickJumpCard(flow: HTMLElement, target: string, baseDate: string, dir: number): HTMLElement | null {
  const time = new Date(target).getTime();
  let best: HTMLElement | null = null;
  let bestGap = Infinity;
  for (const card of flow.querySelectorAll<HTMLElement>('[data-entry-id]')) {
    const id = card.dataset.entryId!;
    const date = id.slice(0, 10);
    if (dir > 0 ? date <= baseDate : date >= baseDate) continue;
    const gap = Math.abs(new Date(id).getTime() - time);
    if (gap < bestGap) { bestGap = gap; best = card; }
    // Cards are latest-first; everything after this is further from target.
    if (id <= target) break;
  }
  return best;
}

// The weekly file an entry id (a creation timestamp) falls in.
export function entryWeek(entryId: string): string {
  return getMondayOfWeek(new Date(entryId.slice(0, 10) + 'T00:00:00'));
}

// How long a jumped-to card keeps its highlight after landing.
const TARGET_FLASH_MS = 2000;

// Smooth-scroll the flow to a card over `duration` ms — instant at 0, which the
// app passes when animation is Off or under reduced motion; the native
// `scrollIntoView({ behavior: 'smooth' })` runs a fixed browser duration that
// honors neither, gliding even when the user asked for no motion. `block`
// 'center' vertically centers the card; otherwise its margin line aligns with
// the date readout so that differing first-line baselines complete the handoff.
function scrollFlowToCard(card: HTMLElement, block: ScrollLogicalPosition, duration: number): void {
  const scroller = flowScroller();
  if (!scroller) return;
  const cardTop = cardTopInScroller(scroller, card);
  let raw = cardTop;
  const margin = card.querySelector<HTMLElement>('.entry-margin');
  const dateRow = document.querySelector<HTMLElement>('#date-latch .latch-date-row');
  if (block === 'center') raw -= (scroller.clientHeight - card.offsetHeight) / 2;
  else if (margin && dateRow) {
    const readoutTop = dateRow.getBoundingClientRect().top + parseFloat(getComputedStyle(dateRow).paddingTop);
    // Round toward the handoff: browser scroll rounding must not leave the
    // target's marker fractionally below the readout showing the previous day.
    raw = Math.ceil(margin.getBoundingClientRect().top - readoutTop + scroller.scrollTop);
  }
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
