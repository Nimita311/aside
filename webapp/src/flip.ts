// FLIP transition for flow re-renders. The flow is rebuilt from scratch on every
// filter change, but cards carry stable ids (data-entry-id), so the outgoing and
// incoming layouts diff by id into three kinds, grounded at the anchor
// (restoreAnchor pins it before this runs):
//
//   - surviving — in both layouts; flies from its real old position to its new one.
//   - appearing — new layout only; emerges from the seam its moment fell in in the
//     OLD layout — the mirror of a disappearing card's exit.
//   - disappearing — old layout only; a detached "ghost" that flies toward the seam
//     its moment falls in in the NEW layout, then fades.
//
// A seam is a cut in the timeline — the gap between two adjacent cards, or the
// outer edge past the newest/oldest, where a boundary card borders the unseen.
//
// The full model (accuracy, the soft-knee flight curve, depth, fades, the tuck
// clip) lives in animation.md. This file is two halves:
//   - Pure geometry — neighbors / seamPoint / departureTarget / arrivalOrigin fix
//     where a flight starts and ends; ghostFlightDy / arrivalFlightDy fix how far
//     it travels. All exported and unit-tested in flip.test.ts.
//   - snapshotFlow / animateFlow — capture the old layout, then drive the flights.
// Transform, opacity, and clip only — no layout work during the animation.

// A rendered card and its position.
export type FlowCard = { id: string; rect: DOMRect };
// A card with its live element — the shape captured in a snapshot and read back
// from the new layout.
type PlacedCard = FlowCard & { el: HTMLElement };
// The outgoing cards with their pre-render positions.
export type FlowSnapshot = PlacedCard[];
// A flight endpoint: where the card rests, plus the far edge of the
// shelter it slides behind (screen coords) — a card taller than its
// shelter is clipped there, so nothing shows past the opposite side.
// `shelterId` names that shelter card, so the clip can follow its live
// position as it moves rather than pinning to its final resting edge.
// `exit` marks a boundary tracker leaving the pane: it reaches this point
// exactly (no soft-knee cap) so it always fully clears the edge.
export type FlightPoint = { top: number; clipTop?: number; clipBottom?: number; shelterId?: string; exit?: boolean };

// The slide length, kept in lockstep with --duration-normal in style.css so
// the FLIP flight and the CSS transitions it plays alongside stay in sync.
// The animation-speed setting scales both together through setSlideMs.
let slideMs = 200;
export function setSlideMs(ms: number): void { slideMs = ms; }
const SLIDE_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
// Fade windows inside the one shared duration, linear (eased opacity reads
// as stutter). Every arrival fades in over its first third and every
// departure fades out over its last third — so an arrival always starts
// transparent and a departure always ends transparent, whatever their path.
const ARRIVAL_FADE_END = 0.35;
const DEPART_FADE_START = 0.65;

// The tuck clip only cuts one edge; the other three sides get a wide negative
// inset (spill outward) so out-of-box parts — the week-seam gutter line — survive.
const CLIP_SPILL_PX = 999;

// The soft-knee flight curve, in viewport heights: distances up to FLY_LINEAR
// map literally; beyond it they compress asymptotically toward FLY_MAX
// (C1-continuous at the knee), so farther always starts farther — just less per
// pixel — and nothing ever streaks. makeSoftFly binds it to a pane height.
const FLY_LINEAR_VIEWPORTS = 1.25;
const FLY_MAX_VIEWPORTS = 2.5;
function makeSoftFly(paneHeight: number): (dy: number) => number {
  const linear = paneHeight * FLY_LINEAR_VIEWPORTS;
  const max = paneHeight * FLY_MAX_VIEWPORTS;
  return (dy) => {
    const d = Math.abs(dy);
    if (d <= linear) return dy;
    const span = max - linear;
    return Math.sign(dy) * (linear + span * (1 - Math.exp(-(d - linear) / span)));
  };
}

// The cards bracketing a moment in a layout. Ids are ISO timestamps, so
// lexicographic order is time order; cards are latest-first.
function neighbors(cards: FlowCard[], id: string): { newer: FlowCard | null; older: FlowCard | null } {
  let newer: FlowCard | null = null;
  for (const c of cards) {
    if (c.id > id) { newer = c; continue; }
    return { newer, older: c };
  }
  return { newer, older: null };
}

// The plain seam crossing: the card ends fully on the far side of the seam
// its center line faces — tucking behind the card there (edge flush, clipped
// at that card's far edge so a taller card hides), or, past a boundary, out
// past the layout's outer edge with no clip. Always at least half the card's
// height, never resting in place. Drives in-span crossings, and is read (its
// top only) to locate where a boundary card starts its own flight.
function seamPoint(cards: FlowCard[], card: FlowCard): FlightPoint | null {
  if (cards.length === 0) return null;
  const { newer, older } = neighbors(cards, card.id);
  const center = card.rect.top + card.rect.height / 2;
  const seam = newer && older
    ? (newer.rect.bottom + older.rect.top) / 2
    : newer ? newer.rect.bottom : older!.rect.top;
  return seam <= center
    ? newer
      ? { top: newer.rect.bottom - card.rect.height, clipTop: newer.rect.top, shelterId: newer.id }
      : { top: older!.rect.top - card.rect.height }
    : older
      ? { top: older.rect.top, clipBottom: older.rect.bottom, shelterId: older.id }
      : { top: newer!.rect.bottom };
}

// Where a boundary card starts its own flight, read for its travel
// direction: its real position in the other layout if it survives there,
// else the seam it appears from — an appearing card always starts a seam
// away, so it always carries a direction. Falls back to just above the pane
// when that layout is empty.
function boundaryStart(boundary: FlowCard, otherCards: FlowCard[], scrollerRect: DOMRect): number {
  const src = otherCards.find((c) => c.id === boundary.id);
  if (src) return src.rect.top;
  const seam = seamPoint(otherCards, boundary);
  return seam ? seam.top : scrollerRect.top - boundary.rect.height;
}

// A boundary counts as still within this slack, so subpixel drift never
// reads as travel.
const BOUNDARY_STILL_PX = 0.5;

// Where a departing card flies to. An in-span ghost — its moment between two
// new cards — crosses the gap seam (seamPoint). A ghost past a boundary —
// newer than the newest new card, or older than the oldest — has no gap to
// cross; it tracks that boundary card, moving the way it travels from its
// start (boundaryStart over the old cards) to its final spot. Which edge it
// exits is set by its side in time, not where it sits on screen. Outward
// travel (newest up / oldest down) carries the ghost clean off that edge,
// flagged `exit` so it reaches the edge exactly instead of soft-capping.
// Otherwise — inward travel, or a survivor boundary holding still (an
// appearing boundary always moves) — it folds in behind the boundary card,
// tucking into the seam as the timeline concentrates. Null when nothing is
// rendered. Exported for tests.
export function departureTarget(
  newCards: FlowCard[],
  ghost: FlowCard,
  scrollerRect: DOMRect,
  oldCards: FlowCard[],
): FlightPoint | null {
  if (newCards.length === 0) return null;
  const { newer, older } = neighbors(newCards, ghost.id);
  if (newer && older) return seamPoint(newCards, ghost);
  const boundary = (newer ?? older)!;
  const travel = boundary.rect.top - boundaryStart(boundary, oldCards, scrollerRect);
  // A leaving tracker flies the system's full reach — FLY_MAX viewport heights
  // from its own spot — into the void. That is farther than any surviving
  // card, which the soft-knee holds strictly under FLY_MAX, so it always reads
  // as the fastest thing on screen; and it clears the pane whole (the overlay
  // clips the off-screen remainder, ease-out tail and all).
  const far = scrollerRect.height * FLY_MAX_VIEWPORTS;
  if (!newer) {
    // Newer than every new card — tracks the newest, exits the top edge.
    return travel < -BOUNDARY_STILL_PX
      ? { top: ghost.rect.top - far, exit: true }
      : { top: boundary.rect.top, clipBottom: boundary.rect.bottom, shelterId: boundary.id };
  }
  // Older than every new card — tracks the oldest, exits the bottom edge.
  return travel > BOUNDARY_STILL_PX
    ? { top: ghost.rect.top + far, exit: true }
    : { top: boundary.rect.bottom - ghost.rect.height, clipTop: boundary.rect.top, shelterId: boundary.id };
}

// Where an arriving card flies in from: the exact mirror of departure. A card
// appearing at `rect` in the new layout comes from where a card at that spot
// would depart to in the old layout — departureTarget over the old cards,
// with the new layout as the far side — so a disappearance and its reverse
// reveal retrace each other by construction: the boundary travel that flies a
// ghost off the edge one way flies it back in from off the edge the other.
// Falls back to just above the pane when the old layout is empty. Exported
// for tests.
export function arrivalOrigin(
  oldCards: FlowCard[],
  id: string,
  rect: DOMRect,
  scrollerRect: DOMRect,
  newCards: FlowCard[],
): FlightPoint {
  return departureTarget(oldCards, { id, rect }, scrollerRect, newCards)
    ?? { top: scrollerRect.top - rect.height };
}

// Cards are animated one viewport height beyond each edge so entries
// arriving from just off-screen slide into view instead of popping in.
function inRange(rect: DOMRect, scrollerRect: DOMRect): boolean {
  const margin = scrollerRect.height;
  return rect.bottom >= scrollerRect.top - margin && rect.top <= scrollerRect.bottom + margin;
}

// How far a departing ghost travels from its old spot to its target `toTop`.
// A ghost that rests on-screen must reach its seat exactly — like a
// surviving mover, which always ends at its true new position — so its
// distance is uncapped. The soft-knee cap applies only to an off-screen
// exit, where it keeps the flight from streaking past the pane edge and the
// compressed tail is invisible anyway. Without this, an on-screen tuck
// whose old→new distance exceeds the cap (the anchor forced far up or down)
// would strand the card short of its seat — visibly at its old location.
// Arrivals reuse this read backwards: their fixed endpoint is the origin (they
// always land at translateY 0), so an on-screen origin is reached exactly and
// an off-screen one soft-capped — the exact mirror of the ghost, so a
// disappearance and its reverse reveal start and end at the same spot.
// Survivors reuse it too, `toTop` being their old position: an on-screen start
// is reached exactly, an off-screen one soft-capped, so a survivor pushed toward
// the edge by the anchor starts at its true old spot rather than short of it.
// Exported for tests.
export function ghostFlightDy(
  toTop: number,
  ghostRect: DOMRect,
  scrollerRect: DOMRect,
  softFly: (dy: number) => number,
): number {
  const restsOnscreen = toTop < scrollerRect.bottom && toTop + ghostRect.height > scrollerRect.top;
  const raw = toTop - ghostRect.top;
  return restsOnscreen ? raw : softFly(raw);
}

// How far an arriving card flies, from its origin to its on-screen rest — the
// exact mirror of the ghost, since the two retrace one path. The card always
// lands at translateY 0 (its rest is exact by construction), so the endpoint
// that must be reached exactly is the origin: an off-edge exit reaches it
// uncapped (fully off-screen, matching the ghost exit), an on-screen origin is
// reached uncapped too — via ghostFlightDy read backwards, origin as the
// endpoint — so a far anchor-forced tuck starts at its true seat instead of a
// soft-knee-compressed spot short of it, and only an off-screen non-exit origin
// is soft-capped (its compressed tail is off the edge anyway). Exported for tests.
export function arrivalFlightDy(
  origin: FlightPoint,
  rect: DOMRect,
  scrollerRect: DOMRect,
  softFly: (dy: number) => number,
): number {
  return origin.exit ? origin.top - rect.top : ghostFlightDy(origin.top, rect, scrollerRect, softFly);
}

// Every rendered card with its live position — the shape both halves of the
// diff read: the outgoing layout at snapshot time, the incoming one when the
// flights are planned.
function collectCards(scroller: HTMLElement): PlacedCard[] {
  const cards: PlacedCard[] = [];
  for (const el of scroller.querySelectorAll<HTMLElement>('.entry-card')) {
    if (!el.dataset.entryId) continue;
    cards.push({ id: el.dataset.entryId, el, rect: el.getBoundingClientRect() });
  }
  return cards;
}

// The first timeline has no outgoing geometry. Bring visible entries up into
// place, with a short stagger; cards further down remain in their final layout.
export function animateEntryArrival(scroller: HTMLElement): { finished: Promise<void>; cancel: () => void } {
  const animations: Animation[] = [];
  if (slideMs > 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const pane = scroller.getBoundingClientRect();
    const visible = collectCards(scroller).filter(card => card.rect.bottom > pane.top && card.rect.top < pane.bottom);
    visible.forEach((card, index) => animations.push(card.el.animate([
      { transform: 'translateY(40px)', opacity: 0 },
      { transform: 'translateY(0)', opacity: 1 },
    ], { duration: slideMs * 1.5, delay: Math.min(index * 35, 140), easing: SLIDE_EASE, fill: 'backwards' })));
  }
  const finished = Promise.all(animations.map(animation => animation.finished.catch(() => {}))).then(() => {
    animations.forEach(animation => animation.cancel());
  });
  return { finished, cancel: () => animations.forEach(animation => animation.cancel()) };
}

// Capture every rendered card's position before the flow is cleared — the
// whole flow, not just the viewport, so a card that re-enters the view
// after the re-render knows its real prior position and flies from it.
// Returns null when the user prefers reduced motion — the scroll anchor
// still applies, motion doesn't.
export function snapshotFlow(scroller: HTMLElement): FlowSnapshot | null {
  // A navigation landing mid-flight starts its transition from wherever the
  // cards visually are — the rects below read live transforms — and the
  // previous transition's departures are dropped: their old view is two
  // renders gone.
  for (const overlay of document.querySelectorAll('.flow-ghosts')) overlay.remove();
  // The caller replaces these cards immediately. Move focus to a stable view
  // control before detaching a focused record, including with motion disabled.
  if (document.activeElement instanceof HTMLElement && scroller.contains(document.activeElement) && document.activeElement.closest('.entry-card')) {
    const controls = ['.filter-pill-label', '#btn-side-panel-collapse', '.app-title a'].map(selector => document.querySelector<HTMLElement>(selector));
    const target = controls.find(control => control && !control.closest('[hidden], [inert]') && !control.matches(':disabled') && control.getClientRects().length > 0);
    target?.focus({ preventScroll: true });
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const cards = collectCards(scroller);
  return cards.length > 0 ? cards : null;
}

// Same-seam fans stack shortest-flight-on-top: each card slides out from under
// the one resting nearer the seam. Ranked globally — cards from different seams
// rarely overlap, and the rule is harmless when they do. z 1..9 stays under the
// movers (z 11) and, for departures, under the arrivals — see the flow-* rules.
function stackShortestOnTop(items: { el: HTMLElement; dy: number }[]): void {
  [...items].sort((a, b) => Math.abs(a.dy) - Math.abs(b.dy))
    .forEach((it, i) => { it.el.style.zIndex = String(Math.max(9 - i, 1)); });
}

// A fixed overlay pinned to the pane — its overflow clips departures at the pane
// edge — holding an inner track that follows the scroll, so a scroll mid-flight
// carries the ghosts with the content instead of stranding them at their
// frame-one viewport spot. Ghost tops are captured relative to the pane, so the
// track only offsets by how far the scroll has moved since. `stop` detaches the
// scroll listener at teardown.
function createGhostOverlay(scroller: HTMLElement, scrollerRect: DOMRect):
  { overlay: HTMLDivElement; track: HTMLElement; stop: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'flow-ghosts';
  overlay.inert = true;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.top = `${scrollerRect.top}px`;
  overlay.style.left = `${scrollerRect.left}px`;
  overlay.style.width = `${scrollerRect.width}px`;
  overlay.style.height = `${scrollerRect.height}px`;
  document.body.appendChild(overlay);
  const track = document.createElement('div');
  track.style.cssText = 'position:absolute;top:0;left:0';
  overlay.appendChild(track);
  const baseScrollTop = scroller.scrollTop;
  const onScroll = () => { track.style.transform = `translateY(${baseScrollTop - scroller.scrollTop}px)`; };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  return { overlay, track, stop: () => scroller.removeEventListener('scroll', onScroll) };
}

// Play the transition after the new flow has rendered and the scroll anchor
// is applied. The snapshot's elements are detached by then; removed cards are
// re-attached as ghosts in a fixed overlay clipped to the flow pane. Resolves
// when every flight has settled and the transition state is torn down — rects
// read before then reflect the in-flight transforms.
export function animateFlow(scroller: HTMLElement, snapshot: FlowSnapshot): Promise<void> {
  const scrollerRect = scroller.getBoundingClientRect();
  const before = new Map(snapshot.map((c) => [c.id, c]));
  const softFly = makeSoftFly(scrollerRect.height);

  // The whole new layout, positions captured before any animation runs.
  const allNew = collectCards(scroller);
  const newById = new Map(allNew.map((c) => [c.id, c]));
  const incoming = allNew.filter((c) => inRange(c.rect, scrollerRect));

  const anims: Animation[] = [];

  // A card taller than the shelter it slides behind must never show past it. The
  // clip is an inset animated in lockstep with the slide — from the shelter's
  // clip line as the card leaves (`edgeFrom`) to that line as the card lands
  // (`edgeTo`), each minus the card's own top there. Because the shelter and the
  // card share one duration and easing, the interpolated inset equals the
  // shelter's *live* line minus the card's live top at every frame: the clip
  // rides the moving shelter, not just its final spot (a stationary shelter
  // passes edgeFrom === edgeTo and it pins as before). Callers pass the shelter's
  // mid-line, not its far edge — the extra bite is all behind the covering
  // shelter, so it's invisible, but it keeps the boundary a half-shelter clear of
  // any edge, so no sub-pixel seam can leak (the near, flush edge needs no clip:
  // it is only reached at rest, where the card has already faded out). The
  // untouched sides get a wide negative inset so out-of-box parts (the week-seam
  // gutter line) survive. Null when the card never overhangs the mid-line.
  const clipFlight = (
    el: HTMLElement,
    height: number,
    fromTop: number,
    toTop: number,
    clip: FlightPoint,
    edgeFrom: number,
    edgeTo: number,
    fill: FillMode,
  ): Animation | null => {
    const insetFor = (top: number, edge: number) => clip.clipTop !== undefined
      ? edge - top
      : top + height - edge;
    const k0 = insetFor(fromTop, edgeFrom);
    const k1 = insetFor(toTop, edgeTo);
    if (k0 <= 0 && k1 <= 0) return null;
    const s = CLIP_SPILL_PX;
    const shape = (k: number) => clip.clipTop !== undefined
      ? `inset(${k}px -${s}px -${s}px -${s}px)`
      : `inset(-${s}px -${s}px ${k}px -${s}px)`;
    return el.animate(
      [{ clipPath: shape(k0) }, { clipPath: shape(k1) }],
      { duration: slideMs, easing: SLIDE_EASE, fill },
    );
  };

  // Resolve every incoming card's origin and flight distance up front, into a
  // dy-by-id map, so a clip built later — an arrival's here, or a ghost's below
  // — can read the live travel of whatever card it shelters behind, whatever
  // order the cards happen to be built in.
  const incomingPlan = incoming.map(({ id, el, rect }) => {
    const old = before.get(id);
    const origin = old ? null : arrivalOrigin(snapshot, id, rect, scrollerRect, allNew);
    const from = old ? old.rect.top : origin!.top;
    // All three kinds reach an on-screen transient endpoint exactly and soft-knee
    // only an off-screen one: a survivor flies from its old spot (ghostFlightDy,
    // the start read as the endpoint), an arrival from its origin (arrivalFlightDy,
    // the mirror). So a visible start sits at its true seat, never soft-knee
    // short of it.
    const dy = old ? ghostFlightDy(from, rect, scrollerRect, softFly) : arrivalFlightDy(origin!, rect, scrollerRect, softFly);
    return { id, el, rect, old, origin, dy };
  });
  const dyById = new Map(incomingPlan.map((p) => [p.id, p.dy]));

  // The shelter a tucking card hides behind, as a live mid-line: locate it in the
  // reference layer (`rects` — the new layout for a departure, the old for an
  // arrival) and read its own travel, so the clip rides it rather than pin to its
  // final edge. Falls back to the point's stored edge when the shelter is absent.
  const shelterMid = (point: FlightPoint, rects: Map<string, PlacedCard>) => {
    const shelter = point.shelterId ? rects.get(point.shelterId) : undefined;
    const mid = shelter ? (shelter.rect.top + shelter.rect.bottom) / 2 : (point.clipTop ?? point.clipBottom!);
    return { mid, shelterDy: (point.shelterId && dyById.get(point.shelterId)) || 0 };
  };

  const movers: HTMLElement[] = [];
  const arrivals: { el: HTMLElement; dy: number }[] = [];
  for (const { el, rect, old, origin, dy } of incomingPlan) {
    if (dy !== 0) {
      anims.push(el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
        { duration: slideMs, easing: SLIDE_EASE },
      ));
    }
    if (old) {
      // Survivors stay on top — above both the arrivals materializing and the
      // departures dissolving beneath them — even when they don't move.
      el.classList.add('flow-mover');
      movers.push(el);
    } else {
      el.classList.add('flow-arrival');
      arrivals.push({ el, dy });
      // Every arrival starts transparent and fades in over the flight's first
      // third. Arrivals paint above departures, so the fade is what keeps the
      // first frame reading as the old view — the departures beneath show
      // through until the arrivals materialize over them.
      anims.push(el.animate(
        [{ opacity: 0 }, { opacity: 1, offset: ARRIVAL_FADE_END }, { opacity: 1 }],
        { duration: slideMs, easing: 'linear' },
      ));
      if (origin!.clipTop !== undefined || origin!.clipBottom !== undefined) {
        // Mirror of the ghost: the shelter sits at its old-layout mid-line as the
        // arrival emerges (mid) and rides to `mid − its dy` by the time it lands.
        const { mid, shelterDy } = shelterMid(origin!, before);
        const clip = clipFlight(el, rect.height, rect.top + dy, rect.top, origin!, mid, mid - shelterDy, 'none');
        if (clip) anims.push(clip);
      }
    }
  }
  stackShortestOnTop(arrivals);

  // Cards leaving the view, on-screen only. The old elements are detached —
  // every render builds fresh nodes — so they're free to reuse: pin them at
  // their old positions and fly them toward where they went.
  const incomingIds = new Set(incoming.map((c) => c.id));
  const ghosts = snapshot.filter((c) =>
    !incomingIds.has(c.id) &&
    c.rect.bottom > scrollerRect.top && c.rect.top < scrollerRect.bottom);

  let overlay: HTMLElement | null = null;
  let stopTracking: (() => void) | null = null;
  if (ghosts.length > 0) {
    const o = createGhostOverlay(scroller, scrollerRect);
    overlay = o.overlay;
    stopTracking = o.stop;
    const track = o.track;

    const flights = ghosts.map((g) => {
      const live = newById.get(g.id);
      const to: FlightPoint | null = live ? { top: live.rect.top } : departureTarget(allNew, g, scrollerRect, snapshot);
      const dy = to === null ? 0
        : to.exit ? to.top - g.rect.top
        : ghostFlightDy(to.top, g.rect, scrollerRect, softFly);
      return { g, to, dy };
    });
    stackShortestOnTop(flights.map((f) => ({ el: f.g.el, dy: f.dy })));
    for (const { g, to, dy } of flights) {
      g.el.classList.add('flow-ghost');
      // Pin absolutely against the overlay. A week-start card sets
      // position: relative for its seam line — same specificity as the ghost
      // rule but later in the cascade — which would leave the card in the
      // overlay's flow with top read as a relative nudge, stacking it below
      // the prior in-flow ghost instead of at its own old spot. The inline
      // style overrides the class; the seam line's absolute ::before still
      // anchors to the card.
      g.el.style.position = 'absolute';
      g.el.style.top = `${g.rect.top - scrollerRect.top}px`;
      g.el.style.left = `${g.rect.left - scrollerRect.left}px`;
      g.el.style.width = `${g.rect.width}px`;
      track.appendChild(g.el);
      if (dy !== 0) {
        anims.push(g.el.animate(
          [{ transform: 'translateY(0)' }, { transform: `translateY(${dy}px)` }],
          { duration: slideMs, easing: SLIDE_EASE, fill: 'forwards' },
        ));
      }
      if (to && (to.clipTop !== undefined || to.clipBottom !== undefined)) {
        // Ride the shelter's live mid-line: at its old spot (mid + its dy) as the
        // ghost starts, arrived (mid) by the end.
        const { mid, shelterDy } = shelterMid(to, newById);
        const clip = clipFlight(g.el, g.rect.height, g.rect.top, g.rect.top + dy, to, mid + shelterDy, mid, 'forwards');
        if (clip) anims.push(clip);
      }
      // Every departure ends transparent, fading out over the flight's last
      // third. Departures paint beneath the arrivals now, so the fade is what
      // dissolves a leaving card — whether it tucks on-screen or exits past
      // the edge.
      anims.push(g.el.animate(
        [{ opacity: 1 }, { opacity: 1, offset: DEPART_FADE_START }, { opacity: 0 }],
        { duration: slideMs, easing: 'linear', fill: 'forwards' },
      ));
    }
  }

  // Survivors must outrank the departures for as long as any flight is
  // live — a wall-clock timer can lag behind a busy compositor and drop
  // the movers' raised z mid-flight — so the classes, inline z, and the
  // ghost overlay are torn down together once every animation settles.
  // Stale-safe: every render builds fresh nodes, so a teardown firing
  // after the next transition started only touches detached elements.
  return Promise.allSettled(anims.map((a) => a.finished)).then(() => {
    stopTracking?.();
    overlay?.remove();
    for (const el of movers) el.classList.remove('flow-mover');
    for (const a of arrivals) { a.el.classList.remove('flow-arrival'); a.el.style.zIndex = ''; }
  });
}
