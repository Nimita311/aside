import { describe, it, expect } from 'vitest';
import { arrivalOrigin, departureTarget, ghostFlightDy, arrivalFlightDy } from '../src/flip';

// The flight rules for appearing/disappearing cards. An in-span card — its
// moment between two new cards — crosses the gap seam: its center line picks
// the side, it ends fully across, edge flush, tucking behind the card there
// (clipped at that card's far edge so a taller card hides), always at least
// half its height. A card past a boundary has no gap to cross; it tracks its
// boundary card instead, moving the way that card travels from its start (its
// old position, or the old-layout seam it appears from) to its final spot:
// outward travel (newest up / oldest down) carries it off that timeline edge,
// flagged `exit` to reach the edge exactly; inward travel or a survivor
// holding still folds it in behind the boundary. Departures and arrivals
// mirror exactly — the same call, read either direction.

const rect = (top: number, height = 100) =>
  ({ top, bottom: top + height, height } as DOMRect);

const card = (id: string, top: number, height = 100) => ({ id, rect: rect(top, height) });

const pane = { top: 0, bottom: 800, height: 800 } as DOMRect;

describe('departureTarget — in-span', () => {
  const newLayout = [
    card('2025-12-10T12:00:00', 0, 100),
    card('2025-12-06T12:00:00', 700, 100),
  ];
  // The seam between the neighbors sits at 400 (midway between 12-10's bottom
  // at 100 and 12-06's top at 700). oldCards is irrelevant here — an in-span
  // ghost never tracks a boundary — so it's passed but unused.
  it('tucks an in-span ghost through the seam its center line faces', () => {
    // Centered above the seam (top 250, center 300) → down, tucking top-to-top
    // under the older 12-06 card, clipped at its bottom.
    expect(departureTarget(newLayout, card('2025-12-08T12:00:00', 250), pane, newLayout))
      .toEqual({ top: 700, clipBottom: 800, shelterId: '2025-12-06T12:00:00' });
    // Centered below it (top 500, center 550) → up, tucking bottom-to-bottom
    // under the newer 12-10 card, clipped at its top.
    expect(departureTarget(newLayout, card('2025-12-08T12:00:00', 500), pane, newLayout))
      .toEqual({ top: 0, clipTop: 0, shelterId: '2025-12-10T12:00:00' });
    // Straddling the seam (top 340, center 390 — above): still down, still
    // fully through — at least half its height, never in place.
    expect(departureTarget(newLayout, card('2025-12-08T12:00:00', 340), pane, newLayout)!.top).toBe(700);
  });

  it('returns null with nothing rendered', () => {
    expect(departureTarget([], card('2025-12-08T12:00:00', 250), pane, [])).toBeNull();
  });
});

describe('departureTarget — past a boundary', () => {
  // Newest 12-10 at the top, oldest 12-08 the bottom boundary (bottom 400).
  const newLayout = [
    card('2025-12-10T12:00:00', 0, 100),
    card('2025-12-08T12:00:00', 300, 100),
  ];
  const olderGhost = card('2025-12-04T12:00:00', 500, 100);

  it('flies a ghost off the bottom when the oldest card drifts down', () => {
    // Oldest was at 200, now 300 — moved down (outward). The ghost tracks it,
    // flying the full reach (FLY_MAX 2.5 × pane 800 = 2000) from its own top
    // (500 → 2500) — the fastest thing on screen, deep into the void.
    const oldCards = [
      card('2025-12-10T12:00:00', 0, 100),
      card('2025-12-08T12:00:00', 200, 100),
    ];
    expect(departureTarget(newLayout, olderGhost, pane, oldCards))
      .toEqual({ top: 2500, exit: true });
  });

  it('folds the ghost in behind the oldest card when it drifts inward', () => {
    // Oldest was at 400, now 300 — moved up (inward). No exit; the ghost tucks
    // up behind the oldest card, bottom flush (400), clipped at its top (300).
    const oldCards = [
      card('2025-12-10T12:00:00', 0, 100),
      card('2025-12-08T12:00:00', 400, 100),
    ];
    expect(departureTarget(newLayout, olderGhost, pane, oldCards))
      .toEqual({ top: 300, clipTop: 300, shelterId: '2025-12-08T12:00:00' });
  });

  it('folds in behind a surviving oldest card that holds still', () => {
    const oldCards = [
      card('2025-12-10T12:00:00', 0, 100),
      card('2025-12-08T12:00:00', 300, 100),
    ];
    expect(departureTarget(newLayout, olderGhost, pane, oldCards))
      .toEqual({ top: 300, clipTop: 300, shelterId: '2025-12-08T12:00:00' });
  });

  // Newest 12-10 at 100, oldest 12-08 below it — for the top-boundary cases.
  const raised = [
    card('2025-12-10T12:00:00', 100, 100),
    card('2025-12-08T12:00:00', 300, 100),
  ];
  const newerGhost = card('2025-12-12T12:00:00', 50, 120);

  it('flies a ghost off the top when the newest card drifts up', () => {
    // Newest was at 250, now 100 — moved up (outward). A ghost newer than it
    // exits the top edge, flying the full reach up from its top (50 − 2000).
    const oldCards = [
      card('2025-12-10T12:00:00', 250, 100),
      card('2025-12-08T12:00:00', 450, 100),
    ];
    expect(departureTarget(raised, newerGhost, pane, oldCards))
      .toEqual({ top: -1950, exit: true });
  });

  it('folds a newer-than-all ghost behind the newest card when it drifts inward', () => {
    // Newest was at 50, now 100 — moved down (inward). The ghost tucks down
    // behind it: top flush (100), clipped at its bottom (200).
    const oldCards = [
      card('2025-12-10T12:00:00', 50, 100),
      card('2025-12-08T12:00:00', 250, 100),
    ];
    expect(departureTarget(raised, newerGhost, pane, oldCards))
      .toEqual({ top: 100, clipBottom: 200, shelterId: '2025-12-10T12:00:00' });
  });

  it('gives an appearing boundary card its own direction (it always moves)', () => {
    // The sole new card is appearing — absent from the old layout, which held
    // one newer card. Its seam-start in the old layout (tucked behind that
    // card, top 0) sits above its final spot (300), so it travelled down:
    // outward for the bottom edge. A ghost older than it is carried off.
    const newLayout = [card('2025-12-08T12:00:00', 300, 100)];
    const oldCards = [card('2025-12-10T12:00:00', 0, 100)];
    expect(departureTarget(newLayout, card('2025-12-01T12:00:00', 600, 100), pane, oldCards))
      .toEqual({ top: 2600, exit: true });
  });
});

describe('arrivalOrigin — in-span', () => {
  const oldLayout = [
    card('2025-12-10T12:00:00', -1200),
    card('2025-12-08T12:00:00', -400),
    card('2025-12-06T12:00:00', 400),
    card('2025-12-04T12:00:00', 1200),
  ];
  // Mirror of the in-span departure — the new layout is unused for these.
  it('reveals an in-span arrival from behind its neighbor', () => {
    // Moment 12-05 falls in the seam (850) between 12-06 and 12-04. Final at
    // 300 → center above → up, top-aligned behind 12-04, clipped at its bottom.
    expect(arrivalOrigin(oldLayout, '2025-12-05T12:00:00', rect(300), pane, oldLayout))
      .toEqual({ top: 1200, clipBottom: 1300, shelterId: '2025-12-04T12:00:00' });
    // Final at 1500 → center below → down, from 12-06's bottom, clipped at top.
    expect(arrivalOrigin(oldLayout, '2025-12-05T12:00:00', rect(1500), pane, oldLayout))
      .toEqual({ top: 400, clipTop: 400, shelterId: '2025-12-06T12:00:00' });
  });
});

describe('ghostFlightDy', () => {
  // A soft-knee stand-in that hard-caps distance at 300, so a capped flight
  // is unmistakable in the assertions. Note: an `exit` boundary tracker skips
  // this path entirely (it reaches its edge exactly) — that is covered where
  // departureTarget flags the endpoint, and by the browser flight harness.
  const cap300 = (dy: number) => Math.sign(dy) * Math.min(Math.abs(dy), 300);

  it('reaches an on-screen tuck exactly, uncapped, even past the cap', () => {
    // Ghost at old top 100, tucking to on-screen toTop 700 — a 600px flight
    // that exceeds the 300 cap. It must still reach 700 (dy 600), or it would
    // strand at 400, its old region — the forced-move bug.
    expect(ghostFlightDy(700, rect(100), pane, cap300)).toBe(600);
    // A short on-screen tuck is exact too (the cap never applied).
    expect(ghostFlightDy(300, rect(100), pane, cap300)).toBe(200);
  });

  it('caps a flight to an off-screen exit', () => {
    // toTop 1200 rests below the pane (1200 ≥ 800) — off-screen, so the cap
    // applies and the compressed tail is invisible past the edge.
    expect(ghostFlightDy(1200, rect(100), pane, cap300)).toBe(300);
    // An exit above the pane (toTop −500, bottom −400 < 0) is capped too.
    expect(ghostFlightDy(-500, rect(100), pane, cap300)).toBe(-300);
  });
});

describe('arrivalFlightDy', () => {
  // Same hard-cap-at-300 stand-in for the soft knee, so a capped flight is
  // unmistakable. An arrival always lands at translateY 0, so the endpoint that
  // must be reached exactly is the ORIGIN — the mirror of the ghost's on-screen
  // tuck. Bare softFly on the whole distance was the "too close" bug: a far
  // anchor-forced origin got compressed, so the card started short of its seat.
  const cap300 = (dy: number) => Math.sign(dy) * Math.min(Math.abs(dy), 300);

  it('reaches an on-screen origin exactly, uncapped, even past the cap', () => {
    // Origin top 700 rests on-screen (700 < 800), landing at 100 — a 600px
    // flight over the 300 cap. It must start at 700 (dy 600), not the capped
    // 300 that would strand it too close to its seat.
    expect(arrivalFlightDy({ top: 700 }, rect(100), pane, cap300)).toBe(600);
  });

  it('reaches an off-edge exit origin exactly, uncapped', () => {
    // A boundary fly-in from off the top: origin −500 (off-screen), exit flag.
    // It must start fully off-screen (dy −600), mirroring the ghost exit it
    // retraces — the cap would leave it partway on-screen.
    expect(arrivalFlightDy({ top: -500, exit: true }, rect(100), pane, cap300)).toBe(-600);
  });

  it('soft-caps a non-exit origin that sits off-screen', () => {
    // Origin 1200 rests below the pane (1200 ≥ 800), no exit — the compressed
    // tail is invisible past the edge, so the cap applies (dy 300).
    expect(arrivalFlightDy({ top: 1200 }, rect(100), pane, cap300)).toBe(300);
  });
});

describe('round-trip symmetry', () => {
  it('rests an in-span disappearance and its reverse reveal at one spot', () => {
    // The toggled card (h209) straddles the seam at 345 with its center
    // (240.5) above it — it exits DOWN through the seam, tucking top-to-top
    // under the card below.
    const filtered = [
      card('2026-04-10T09:00', 112, 233), // shelter — bottom 345
      card('2026-04-03T11:15', 345, 273), // anchor
    ];
    const toggled = card('2026-04-06T13:45', 136, 209);
    expect(departureTarget(filtered, toggled, pane, filtered))
      .toEqual({ top: 345, clipBottom: 618, shelterId: '2026-04-03T11:15' });
    // Reappearing: emerges from the same resting spot, flying back up.
    expect(arrivalOrigin(filtered, '2026-04-06T13:45', rect(136, 209), pane, filtered))
      .toEqual({ top: 345, clipBottom: 618, shelterId: '2026-04-03T11:15' });
  });

  it('retraces a boundary exit — off the edge one way, in from it the other', () => {
    // New layout: newest 12-10, oldest 12-08 the bottom boundary; it drifted
    // down from 200 to 300, so a ghost below it exits the bottom.
    const N = [
      card('2025-12-10T12:00:00', 0, 100),
      card('2025-12-08T12:00:00', 300, 100),
    ];
    const O = [
      card('2025-12-10T12:00:00', 0, 100),
      card('2025-12-08T12:00:00', 200, 100),
    ];
    const G = card('2025-12-04T12:00:00', 500, 100);
    const exit = { top: 2500, exit: true };
    expect(departureTarget(N, G, pane, O)).toEqual(exit);
    // Reverse navigation (old layout N, new layout O): the same card reappears,
    // flying in from off the bottom — the departure target read back as an
    // arrival origin, the identical call.
    expect(arrivalOrigin(N, G.id, G.rect, pane, O)).toEqual(exit);
  });
});
