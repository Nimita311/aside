import type { DateTimePreferences } from './preferences';
import { formatDate } from './date-display';
import { entityIcon, scrubLatchDate } from './render';
import { toDateStr } from '../lib/types';

// A zero-height sticky row at the top of the flow: the date readout in the
// gutter, a calendar button beside complete stacked timestamps, plus the
// scroll-scrubbed retraction of the week seams approaching it. app.ts mounts
// it on every flow render, registers markers as entries append, and drives
// updates from the scroll/resize handlers; the odometer roll itself is
// scrubLatchDate in render.ts.

// Live media query, evaluated per frame via .matches — never re-created on
// the scroll path. Shared with app.ts (duration scaling, jump scrolling).
export const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

// Keep the readout showing the date at the pane's top edge: the day whose
// marker most recently reached the readout row. The chip itself never moves
// — its sticky position is compositor-stable, while a scroll-driven
// transform would lag it by a frame and jitter. The next day's value rides
// its marker's real position into the chip (continuing it seamlessly as the
// marker passes behind the solid backdrop) and pushes the latched value out
// on contact — the odometer roll.
// True from the start of a flow rebuild until its transition settles. The
// readout is derived from live marker positions and the scroll, both of
// which are inconsistent mid-rebuild — markers are appended progressively
// and the scroll is restored in steps — so recomputing then makes the date
// flicker through wrong values. While suppressed the readout is left
// untouched; renderFlow refreshes it once, on settled geometry, via
// updateLatchNow.
let latchSuppressed = false;

// The readout's offset from the flow top, measured once and pinned so a re-render
// that swaps in a first entry with a differently-shaped first line doesn't hop
// the readout a few pixels. Reset on resize, where the layout genuinely reflows.
let readoutPad: number | null = null;

// The flow's markers in document order, collected as they render — the
// per-scroll-frame latch update reads this instead of re-querying the whole
// flow subtree every frame.
let flowMarkers: HTMLElement[] = [];
const latchPreferences = new WeakMap<HTMLElement, () => DateTimePreferences>();

export function suppressLatch(on: boolean): void {
  latchSuppressed = on;
}

export function resetReadoutPad(): void {
  readoutPad = null;
}

export function resetLatchMarkers(): void {
  flowMarkers = [];
}

export function addLatchMarker(el: HTMLElement): void {
  flowMarkers.push(el);
}

// The date the latch currently reads — where the flow sits. Falls back to
// today before the first latch update.
export function currentFlowDate(): string {
  return document.getElementById('date-latch')?.dataset.date ?? toDateStr(new Date());
}

// Mount the latched date readout: a zero-height sticky row at the top of the
// flow column, so it overlays the gutter without occupying flow space and
// tracks the column across layouts. Recreated on every flow render (the flow
// is cleared wholesale). `onChipActivate` handles a click or keyboard
// activation of the chip — it doubles as the jump-to-date trigger.
export function mountLatch(flow: HTMLElement, onChipActivate: () => void, preferences: () => DateTimePreferences = () => ({ timeFormat: 'locale' })): void {
  const latch = document.createElement('div');
  latch.className = 'date-latch';
  latch.id = 'date-latch';
  latchPreferences.set(latch, preferences);
  latch.hidden = true;
  const chip = latch.appendChild(document.createElement('div'));
  chip.className = 'date-latch-chip';
  chip.setAttribute('role', 'button');
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('aria-label', 'Jump to date');
  chip.setAttribute('aria-expanded', 'false');
  chip.title = 'Jump to date';
  chip.addEventListener('click', onChipActivate);
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChipActivate(); }
  });
  const icon = chip.appendChild(document.createElement('span'));
  icon.className = 'latch-calendar-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = entityIcon('action');
  chip.appendChild(document.createElement('div')).className = 'latch-date-row';
  flow.appendChild(latch);
}

export function updateLatch(): void {
  if (latchSuppressed) return;
  updateLatchNow();
}

export function updateLatchNow(): void {
  const scroller = document.getElementById('flow-scroll');
  const latch = document.getElementById('date-latch');
  const chip = latch?.firstElementChild as HTMLElement | null;
  if (!scroller || scroller.hidden || !latch || !chip) return;

  const dateRow = chip.querySelector<HTMLElement>('.latch-date-row');
  if (!dateRow) return;

  const markers = flowMarkers;
  if (markers.length === 0) {
    latch.hidden = true;
    delete latch.dataset.date;
    chip.setAttribute('aria-label', 'Jump to date');
    chip.title = 'Jump to date';
    chip.querySelectorAll<HTMLElement>('.latch-date-row')
      .forEach((row) => { row.innerHTML = ''; });
    return;
  }
  // The readout row rests on the flow's first margin line — the first marker's
  // offset from the flow top (scroll-independent, since they move together). It's
  // measured once and pinned (readoutPad), not re-measured each render: a
  // re-render can swap in a first entry whose first line sits at a slightly
  // different baseline (a plain-text first line vs a tag row), and re-measuring
  // would hop the readout a pixel or two. Reset only on resize. The padding
  // doubles as backdrop up to the pane edge.
  const flow = document.getElementById('flow');
  if (!flow) return;
  if (readoutPad === null) readoutPad = markers[0].getBoundingClientRect().top - flow.getBoundingClientRect().top;
  const pad = readoutPad;
  if (dateRow.style.paddingTop !== `${pad}px`) dateRow.style.paddingTop = `${pad}px`;
  const readoutTop = dateRow.getBoundingClientRect().top + pad;
  // The latched date flips when its marker reaches the readout row itself —
  // by then its riding value has fully arrived, so the swap is continuous.
  // Under reduced motion there is no riding value; the date swaps the moment
  // the marker touches the chip's box instead, so it is
  // still never covered while the readout shows an older day. The last
  // qualifying marker wins; markers are in document order, so their
  // positions are monotonic and binary search applies.
  const reduced = REDUCED_MOTION.matches;
  const threshold = reduced && document.documentElement.dataset.timelineLayout !== 'stacked'
    ? chip.getBoundingClientRect().bottom : readoutTop;
  let lo = 0, hi = markers.length - 1, current = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (markers[mid].getBoundingClientRect().top <= threshold) { current = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  // Above the first boundary the flow's first day is still current: its
  // in-flow marker is invisible and the readout — pinned at the readout row
  // from scroll 0, so the date never shifts position — is its rendering.
  if (current < 0) current = 0;

  const date = markers[current].dataset.date!;
  const prefs = latchPreferences.get(latch)?.() ?? { timeFormat: 'locale' as const };
  const label = `Jump to date: ${formatDate(date, prefs.dateFormat)}`;
  if (chip.getAttribute('aria-label') !== label) chip.setAttribute('aria-label', label);
  if (chip.title !== label) chip.title = label;
  latch.dataset.date = date;
  const next = markers[current + 1];
  let ghostY = Infinity;
  if (next && !reduced) ghostY = next.getBoundingClientRect().top - readoutTop;
  scrubLatchDate(chip, date, next?.dataset.date ?? null, ghostY, prefs);
  latch.hidden = false;

  updateSeams(chip, Array.from({ length: 5 }, (_, i) => markers[current + i]));
}

// The scroll distance over which an approaching week seam dissolves back
// into the ordinary divider beneath it, before the readout's backdrop could
// occlude the seam's gutter extension partially (the seam is wider than the
// chip, so passing behind it would bite a chunk out of the line).
const SEAM_FADE_PX = 80;
// Seams dimmed last frame — restored when they leave the fade zone, however
// they leave it (a jump can skip the zone entirely).
let dimmedSeams = new Set<HTMLElement>();

// Scrub the gutter extension of the week seams near the readout. Only the
// cards of the few markers below the current day can be in the fade zone —
// seams coincide with day markers, and markers are at least an entry apart,
// so five markers cover the zone even in a dense filtered flow.
function updateSeams(chip: HTMLElement, markers: (HTMLElement | undefined)[]): void {
  const chipBottom = chip.getBoundingClientRect().bottom;
  const active = new Set<HTMLElement>();
  for (const marker of markers) {
    const card = marker?.closest<HTMLElement>('.entry-card');
    if (!card?.classList.contains('week-start')) continue;
    const gap = card.getBoundingClientRect().top - chipBottom;
    const dissolve = 1 - Math.min(Math.max(gap / SEAM_FADE_PX, 0), 1);
    if (dissolve > 0) {
      card.style.setProperty('--seam-dissolve', dissolve.toFixed(3));
      active.add(card);
    }
  }
  // Never restore a FLIP ghost: a re-render can hand a half-dissolved card
  // to the ghost overlay, and its seam must hold while it fades out.
  for (const card of dimmedSeams) {
    if (!active.has(card) && !card.classList.contains('flow-ghost')) {
      card.style.removeProperty('--seam-dissolve');
    }
  }
  dimmedSeams = active;
}
