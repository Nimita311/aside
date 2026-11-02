# Flow Transition Animation

The full model for the flow re-render transition. Code in [src/flip.ts](src/flip.ts),
driven from `renderFlow` in [src/app.ts](src/app.ts); validated by
[test/flip-flight.validate.mjs](test/flip-flight.validate.mjs) (frame-level) and
[test/flip.test.ts](test/flip.test.ts) (geometry). The spec's *Animations*
paragraph is the summary.

## Model

Every re-render plays a FLIP pass keyed by entry id (ISO timestamps, so
lexicographic order is time order): snapshot old positions, rebuild, diff by id.
Each card is **surviving** (both layouts), **appearing** (new only), or
**disappearing** (old only, re-attached as a ghost in a fixed overlay clipped to
the pane). The pass is grounded at the **anchor** — one card pinned at its
viewport offset (see spec). Only `transform`, `opacity`, `clip` animate.

All slides share one duration, scaled together by an **animation-speed** setting
(Off / Fast / Normal / Slow) — Off zeroes it, reading like `prefers-reduced-motion`,
under which the pass is skipped entirely. A navigation landing **mid-flight**
snapshots the cards where they visually are (reading their live transforms) and
drops the previous flight's departures.

## Design intent

The transition should read as **one continuous movement of the timeline**, not a
cut to a new view — grounded at the anchor, which holds still while everything
else slides to its new place in time.

**Speed reflects distance:** how fast and far a card flies encodes how far in time
its moment sits from the new view. The soft-knee keeps a far origin visible rather
than a streak, so distance reads as speed; the void-flyer is the fastest by
design. The rules below protect this reading.

## Principle rules

Two are inviolable:

1. **Accuracy** — a visible endpoint (start or end in the viewport) renders at
   its exact true location; never compressed.
2. **Continuity** — nothing visible teleports: a card seen at its start or end
   must move continuously to where it is next seen — never vanishing from or
   appearing at a visible spot (on ↔ off), nor jumping between two visible spots
   (on → on at a new location).

The rest follow:

3. **Travel** — a card visible at one end only must cross the edge. Appear and
   disappear carry a *fabricated* seam endpoint, guarded against collapse (≥ half
   the card's height). A survivor's travel is `new − old`, forced by accuracy —
   zero only for the anchor.
4. **Compression** — a *far, off-screen* mobile endpoint may be soft-kneed to
   avoid streaking; allowed only because it's invisible, so accuracy doesn't bind.
5. **Clean-screen** — compression shortens only the wholly-off-screen tail and
   must keep the card fully off-screen, never exposing a false sliver.
6. **Max-distance** — flights cap at `FLY_MAX`, but the cap is enforced *only* by
   compression, so an uncompressible flight can exceed it (issue ①).
7. **Animate on-screen content only** — a card animates iff visible at start or
   end; off-at-both-ends (incl. opposite-side pass-through) is placed, not animated.

**Meta:** rules are judged by the **screen** (visibility), not the **DOM**
(survival) — a survivor leaving the pane is a departure to the eye, one entering
is an arrival.

## Start and end per card

Pure geometry — it fixes where each flight begins and ends, independent of
whether those points are on-screen or of any later compression:

- **Surviving** — start and end are the card's actual **old and new layout
  positions**.
- **Appearing** — end is its actual **new-layout home**; start is a **computed
  origin**, the seam it emerges from.
- **Disappearing** — start is its actual **old-layout position**; end is a
  **computed target**, the seam it collapses into.

So a survivor has two real endpoints and no seam; an appearing card's start and a
disappearing card's end are the only computed points. `arrivalOrigin` mirrors
`departureTarget` over the opposite layout, so a disappearance and its reverse
reveal retrace one path.

A computed seam endpoint resolves by:

- **In-span** (moment between two layout cards) — crosses the gap seam: its center
  line vs the seam picks the direction; it ends fully across, edge-flush, tucked
  behind the far card and clipped at that card's far edge (a taller card hides).
  Travels ≥ half its height.
- **Past a boundary** (newer than the newest / older than the oldest) — no gap; it
  tracks its boundary card's travel. Outward (newest up / oldest down) sends it
  clean off that timeline edge; inward, or a still surviving boundary, folds it
  into the boundary seam. The edge is set by its side in *time*.

## Flight and fades

These transform the resolved locations; they don't move them.

**Compression** — shortens the flown distance of the endpoint that is a transient
transform offset (a survivor/arrival's **start**, a ghost's **target**); the
node's real rest (a live card's `translateY 0`, a ghost's overlay-pinned old spot)
is always reached exactly. When on-screen the transient endpoint is exact too;
only far off-screen is it soft-kneed (`softFly`: linear to `FLY_LINEAR`,
asymptotic toward `FLY_MAX`). Clean-screen (rule 5) wants the compressed endpoint
floored fully off-screen; it isn't, which is the poke (②). The **void exit** is
the exception — a boundary tracker leaving outward flies the full `FLY_MAX` reach
*uncapped* off the edge, the streak its signal.

**Opacity & depth** — arrivals fade in over their first third, departures fade out
over their last third, survivors never fade. Depth: survivors > arrivals >
departures. Same-seam fans stack shortest-flight-on-top. Every card in flight
paints an opaque pane-colored surface across its gutter.

## What to animate

Animate iff visible at start or end; the gate reads *both* endpoints, so a leaving
survivor (`In → Off`) is included though it lands off-window.

`In`/`Off` throughout are measured against a **window**, not the raw viewport —
the viewport optionally extended by a margin, so a card just past an edge still
slides in rather than popping. **`In` = any part of the card's box overlaps the
window** (a box-overlap test, not a top-in-window test), so a tall card is `In`
even with its top far outside — the root of overspeed case ①. The window is
**per-type and independently tunable**. Current values:

- Appearing — viewport + one viewport height on each side
- Surviving — viewport + one viewport height on each side
- Disappearing — plain viewport (no margin)

| Kind | Start | End | Note |
|---|---|---|---|
| Survive | In | In | ① long card |
| Survive | In | Off | ① uncappable off-screen rest |
| Survive | Off | In | ② compressed start; no fade |
| Appear | Off | In | ② compressed start; fade-in partial (+ void ⇒ streak) |
| Appear | In | In | ① long card |
| Disappear | In | In | ① long card |
| Disappear | In | Off | ② compressed end; fade-out hides it (+ void ⇒ streak) |

Omitted rows are non-events: `Appear · → Off` (home off-screen ⇒ not appearing)
and `Off → Off` (never visible).

## Known issues

- **① Overspeed — distance can't be capped.** The soft-knee only shortens an
  off-screen, disposable endpoint; when both endpoints are pinned exact, the full
  distance is flown and the slide plays too fast. Two cases:
  - **`In → In`, long card** — both endpoints on-screen ⇒ both exact, and
    "visible" doesn't bound a long card's top.
  - **Survive `In → Off`** — visible start (pinned by accuracy) + the survivor's
    real off-screen rest; neither compresses.
- **② Off-screen poke — a compressed endpoint reappears.** Compression ignores
  the pane edge, so a long card's compressed off-screen endpoint reaches back
  across it and shows a false sliver. Hidden by the fade for ghosts, partly for
  arrivals, not for survivors. Two sites:
  - `Survive / Appear · Off → In` — the compressed **start**.
  - `Disappear · In → Off` — the compressed **end**.

## Constants

`FLY_LINEAR` ~1.25 vp · `FLY_MAX` ~2.5 vp · fades at 0.35 / 0.65 · slide 200 ms
(in lockstep with `--duration-normal`). All in [src/flip.ts](src/flip.ts).

### Initial instance entrance

After opening an instance, visible entry cards rise 40 px into their resting positions while fading in. The entrance lasts 300 ms at normal speed, with a 35 ms stagger capped at 140 ms; entries outside the viewport keep their final layout. It runs after the chooser is hidden, so the pane has its real dimensions. Cold entry and date links position the timeline at their destination before this entrance; jumps within an open timeline scroll smoothly. Reduced motion and animation speed zero disable it. Switching instances cancels an entrance still in flight. Loading feedback waits 200 ms independently of animation speed and overlays the flow until initialization finishes, keeping scroll geometry stable.
