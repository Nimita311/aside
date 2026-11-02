// FLIP flight validation — a browser harness, not a vitest spec.
//
// The unit tests in flip.test.ts pin the pure geometry (departureTarget /
// arrivalOrigin / ghostFlightDy): given rects, where should a card start and
// land. They run in jsdom and cannot see the other half of the transition —
// how animateFlow actually pins each card into the DOM and drives it. That
// half needs a real browser: live layout, the CSS cascade, and the Web
// Animations timeline. The bugs that live there are invisible to the geometry
// tests:
//   - a week-start ghost kept position:relative by the cascade, so its pin
//     top read as a relative nudge and it stacked below the prior ghost
//     (rendered 171px off its old spot — right geometry, wrong location);
//   - an appearing card handed an origin equal to its final spot (dy 0), so
//     it never moved — a fix-in-place the rule forbids.
//
// Both reduce to two frame-level invariants that hold for EVERY transition,
// with no reference to the internal target math:
//
//   A. START (the FLIP "First" is honored). At the first frame every
//      surviving and disappearing card must render within 1px of where it sat
//      before the re-render. A card that starts anywhere else flies from and
//      to the wrong place — it cannot obey the seam rule no matter how correct
//      the geometry. This is the check that catches a bad pin.
//
//   B. MOVE (no fix-in-place). Every disappearing and appearing card must
//      actually travel (start ≠ end). The rule is that these cards always
//      cross a seam; a branch that leaves one in place is always wrong.
//      (Surviving cards are exempt — one can legitimately hold still.)
//
// Appearing cards have no "before" position, so A covers survivors + ghosts
// and B covers ghosts + arrivals; together the three kinds are all pinned.
//
// HOW TO RUN. Serve the app (npm run dev), open it, and either paste this file
// into the console or run it through chrome-devtools. It defines
// window.validateFlight(trigger): record the flow, run your trigger (the click
// that re-renders), and it pauses the flight at both ends and reports any card
// that breaks A or B. Example with an entry tagged to a project and an action:
//
//   await validateFlight(async () => {
//     const card = [...document.querySelectorAll('#flow .entry-card')]
//       .find(card => card.querySelector('.tag-project') && card.querySelector('.tag-action'));
//     card.querySelector('.tag-project').click();          // -> project flow
//     await new Promise(r => setTimeout(r, 1200));
//     document.querySelector('#flow .entry-card .tag-action').click(); // -> action flow
//   });
//
// A clean run prints "FLIP OK"; a regression prints the offending cards with
// how far off they were. For CI this would want a headless-browser runner
// (Playwright) driving the same two assertions — deliberately not a dependency
// yet; this harness is the manual equivalent.

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

async function validateFlight(trigger, { tol = 1 } = {}) {
  const scroller = document.querySelector('#flow-scroll');
  if (!scroller) throw new Error('no #flow-scroll — is the app loaded?');

  // Record every card's pre-render top (the FLIP "First").
  const before = new Map();
  for (const el of scroller.querySelectorAll('.entry-card[data-entry-id]')) {
    before.set(el.dataset.entryId, Math.round(el.getBoundingClientRect().top));
  }

  await trigger();

  // Wait for the flight to be built, then freeze its timeline so we can read
  // both ends without racing the compositor.
  for (let i = 0; i < 200 && document.getAnimations().length === 0; i++) await SLEEP(4);
  await SLEEP(8);
  const anims = document.getAnimations();
  const seek = (t) => {
    for (const a of anims) {
      a.pause();
      try { a.currentTime = a.effect.getTiming().duration * t; } catch { /* not time-based */ }
    }
  };
  const kindOf = (el) =>
    el.classList.contains('flow-ghost') ? 'ghost'
      : el.classList.contains('flow-arrival') ? 'arrival'
        : el.classList.contains('flow-mover') ? 'survivor' : 'static';
  const animating = () => [...document.querySelectorAll('#flow .entry-card, .flow-ghost')]
    .filter((el) => ['ghost', 'arrival', 'survivor'].includes(kindOf(el)));

  // Frame 0: survivors and ghosts must sit at their old positions.
  seek(0.0001);
  const startPos = new Map();
  const startErrors = [];
  for (const el of animating()) {
    const id = el.dataset.entryId;
    const kind = kindOf(el);
    const top = Math.round(el.getBoundingClientRect().top);
    startPos.set(el, top);
    if ((kind === 'survivor' || kind === 'ghost') && before.has(id)) {
      const want = before.get(id);
      if (Math.abs(top - want) > tol) startErrors.push({ id, kind, want, got: top, off: top - want });
    }
  }

  // Frame 1: ghosts and arrivals must have travelled (no fix-in-place).
  seek(0.9999);
  const stillErrors = [];
  for (const el of animating()) {
    const kind = kindOf(el);
    if (kind !== 'ghost' && kind !== 'arrival') continue;
    const end = Math.round(el.getBoundingClientRect().top);
    if (Math.abs(end - (startPos.get(el) ?? end)) <= tol) {
      stillErrors.push({ id: el.dataset.entryId, kind, at: end });
    }
  }

  // Release the timeline so the view settles as normal.
  for (const a of anims) { try { a.play(); } catch { /* ignore */ } }

  const ok = startErrors.length === 0 && stillErrors.length === 0;
  const report = { ok, startErrors, stillErrors };
  if (ok) console.log('%cFLIP OK', 'color:green', `(${anims.length} flights)`);
  else {
    if (startErrors.length) console.error('A. cards not pinned at their old position:', startErrors);
    if (stillErrors.length) console.error('B. appearing/disappearing cards that never moved:', stillErrors);
  }
  return report;
}

if (typeof window !== 'undefined') window.validateFlight = validateFlight;
export { validateFlight };
