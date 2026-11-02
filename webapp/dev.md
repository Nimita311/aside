# Web App Development Log

For an isolated gallery of pages, UI states, typography, diagrams and media,
run `npm run mock` from `webapp/`. See [the mock gallery guide](mock/README.md)
for fixtures and preview controls.

## 2026-05-03

### Phase 1: Core Flow — Complete

- Three-column layout: date+time (left gutter), content (center), tags (right gutter)
- Full ISO date on every entry, time in 24h format (configurable)
- Tags: projects (blue) and actions (green) in separate rows, clipped within pills, max 180px gutter
- Content bounded to center column regardless of tag presence
- Inline entity mentions as muted tag-style pills
- Infinite scroll loading weekly files on demand
- Data source configuration modal (URL input)
- Settings: tag date code display format, time format
- Entry dividers bounded to content column

### Phase 2: Entity Resolution — Complete

- Click any tag → flow filters to that entity's entries
- Side panel opens with entity detail (project: name, dates, related projects, markdown body; action: status, deadline, body)
- Filter chip at top with × to clear
- URL hash state: `#project/name`, `#action/name`, `#flow`
- Related projects clickable in side panel
- Inline mentions clickable in content

### Phase 3: Search — Complete

- Debounced search bar in header
- Results grouped by type: projects, actions, entries
- Searches project/action names (from indexes) and entry summaries
- Click result → navigates to entity (filter + side panel)
- Escape closes search results

### Phase 4: Polish — Complete

- Dark mode toggle with system preference default
- Full dark theme with GitHub-style dark palette
- Keyboard shortcuts: `/` to focus search, `Esc` to close panels
- Lucide-style icons (gear, sun)
- Settings panel with display preferences

## 2026-07-03

### Fixed flow, summary panel, document overlay, assets

- Flow position is now fully independent of panel/reader state — nothing ever pushes it (first iteration used an expanding panel that shifted the flow; user feedback: the flow must never move)
- Side panel is a summary/navigator: lifecycle stage pill (project: open/ended; action: the four states, presenting as Due when a deadline is set), authored index description, "Open details" button, related entities — no dates or document bodies. No header stripe; the title carries a type-colored icon, close button floats in the corner
- The detail view renders the complete record: id, stage, every front matter field verbatim, then the body
- Fixed 14 CSS rules referencing nonexistent `--color-fg`/`--color-fg-muted` variables (now `--color-text`/`--color-text-muted`)
- Filter chip bar removed — the side panel is the filter indicator; closing it clears the filter
- Documents (project/action bodies, assets) open in an overlay reader: constant-size centered window (never content-sized), flow dimmed around it; click-outside/×/Esc/back close it
- Entry references jump to the entry's position in the flow (scroll + flash, loading older weeks as needed) via the `#flow/<entry-id>` URL; project/action filters persist when they contain the target. The `#entry/<id>` URL remains the entry detail page (single-entry flow + full content in the panel)
- Markdown CSS moved from `.entry-body` scope to `.rendered-content`, so panel and reader content get the same GitHub-style rendering as the flow

### Retractable, resizable side panel

- Panel resizes by dragging its left edge (`--side-panel-width`, clamped 280px–min(720px, 90vw), persisted)
- Retract button collapses the panel to a docked pill at the right edge — the filtered entity as a colored tag, so the filtered state stays visible while the flow gets full width; click expands, × clears, Esc clears; collapsed state persists and holds across filter changes
- Adopted the standard app-frame layout: `html/body` fixed at viewport height with `overflow: hidden`, the flow scrolling in its own pane (`.flow-scroll`), the panel body in its own — bounces happen inside a pane and show that pane's background, so page chrome can never desync. This replaced the whole overscroll-workaround lineage (sticky anchor, `::after` tail with phantom scroll, box-shadow tail with misaligned border, disabling the bounce, a viewport-fixed twin)
- Both panes use `overscroll-behavior-y: contain`: the panel scrolls in isolation, and the flow pane rubber-bands consistently — with the default `auto`, gestures starting at the pane's edge chained to the unscrollable page and never bounced. Y-axis only: containing x would swallow the browser's horizontal swipe back/forward gesture
- Engaging a filter scrolls to the top — a new filter is a new timeline; the flow clears immediately on re-render so stale content never lingers behind a slow load
- In a filtered flow, the filtered entity's tag pill fills with a softened solid of its type color — `color-mix` toward the page background (a +N bubble hiding it carries the fill); inline mentions render bold with no color change

### Review pass (pre-commit)

- Jump URLs carry the kept filter (`#project/<id>/flow/<entry>`), so every URL restores its exact view; hash-echo suppression stops jumps from executing twice
- Stale-async guards: panel/reader loads that lose a race to a newer navigation no longer overwrite it; panel re-opened within the close animation no longer vanishes
- Panel is left untouched when only the document changes (no reload flicker, scroll preserved); panel/reader/flow updates run concurrently instead of serially
- `extractAssetLinks` ignores image embeds and links quoted in code, matching what the renderer turns into links; jump prefetches its weeks in parallel
- Partial weekly-file failures no longer freeze an incomplete relation map for the session
- Consolidated: `entityFilePath`/`safeDecode` helpers, shared summary shell and related-row/list renderers; dropped the dead top-bar ResizeObserver
- Related entities on every summary (from a store-built relation map over all entries): projects (explicit links both directions), actions (co-occurrence), assets, entry counts; long lists collapse behind "+N more"
- Assets: relative markdown links in content are resolved against the containing file, rendered with a file icon, and opened in-app; asset document shows content + "Linked from" entries
- Instance URLs carry the full view state — back/forward walks the whole trail, and cold load restores the selected instance, filter, and open document
- Esc steps back one level (overlay → summary → flow)
- Store: in-flight weekly fetches dedupe; relation map warmed in the background after first render
- Fixed side panel top edge hiding under the filter chip bar (ResizeObserver tracks top-bar height into a CSS variable)
- Fixed side panel inner layout (was flex-row, now column)

### Instance URLs

- Paths carry the stable instance ID followed by view state: `/<instance>/project/<id>/detail`; the root is the instance chooser and `/<instance>/` is its timeline.
- `src/route.ts` maps view state; `pushState` and the location handler restore navigation.
- Development watches the shell build and uses `aside show --url --app-dir` with the same daemon backend as release.

## 2026-07-04

### Timeline date markers

- Per-entry gutter shows only the time; dates moved to markers on the first (latest) entry of each day — sharing the margin's first line (marker at the gutter's left edge, time at the right), so a day boundary adds no height — showing only the units that changed at the boundary (`22` / `Apr 30` / `2025 Dec 31`)
- Marker units sit in fixed-width columns (4ch/3ch/2ch, exact in the mono font) shared with the latch; unchanged units render empty but hold their column, so dates align down the gutter and the latch takeover doesn't move the visible text
- A latched readout at the pane's top edge always shows the full current date; the chip never moves — its solid backdrop is exactly the text row, markers pass behind it. A scroll-driven push-off transform on the chip was tried first and jittered: the sticky chip is compositor-positioned but the handler runs a frame behind
- The chip spans only the date columns, so entry times scroll past uncovered
- The current weekday is a muted second latched line below the date, handled as a fourth scrub unit so it rides and rolls in exact sync; placed at the gutter's left edge so day/month markers riding into the readout never cross it (only a year-boundary marker does, once a year)
- Week seams: the first entry of each Mon–Sun week extends its top divider across the gutter (`::before`, gutter-wide) — zero height; on narrow screens it spans the content width
- Seams retract over the last 80px before the readout: a gradient-mask edge sweeps left to right across the gutter extension (`--seam-dissolve` scrubbed in updateLatch; only the cards of the markers around the current day can be in the zone), leaving the content-column line to exit under the pane edge like any divider — the seam is wider than the chip's backdrop, so letting it pass behind bit a visible chunk out of the line. A uniform opacity fade came first; then a %-based sweep across the full line width, which cleared the gutter (the only visually distinct part) in the first third of the zone and read as early-and-sharp — the sweep is sized in px to the gutter extension instead
- The readout shows from scroll 0 at its pinned spot — the flow's first margin line's rest position, measured from the (scroll-independent) first-marker offset so baseline shifts from tag rows are included, and applied as the chip's top padding, which doubles as backdrop up to the pane edge. The first marker is `visibility: hidden` — it holds its margin place and anchors geometry, the readout is its rendering (an earlier take showed the first marker in place and swapped the readout in when it reached the top, but the date visibly drifted before pinning)
- The date swap is scrubbed by scroll, not timed: the incoming value rides its marker's real position into the chip (pixel-superimposed — one visible instance, so no duplicate; the chip's copy continues it as the marker passes behind the backdrop) and pushes the latched value out on contact, completing when the marker reaches the readout row. Reversible, timer-free, instant under fast flicks; under `prefers-reduced-motion` it hard-swaps when the marker touches the chip. Iterations: timed WAAPI slides → crossfaded scrub → flush-box roll (glyph leading still read as a gap, and the pre-rolled value duplicated the visible marker) → the riding roll; a gradient fade below the chip came along the way and was dropped once the riding copy made it redundant — solid backdrop, crisp odometer window
- The unit cells clip to the glyphs at the top and flush with the backdrop at the bottom (`clip-path`, tuned to the mono font's metrics), so contact distance is one glyph height and glyphs passing behind the backdrop reappear in the window with no seam
- The readout is a zero-height sticky row inside the flow column (so it tracks the gutter across layouts, occupying no flow space); a rAF scroll handler binary-searches the markers for the day at the top edge
- Markers are emitted in the week-append loop by comparing consecutive rendered entries' dates — weekly files are Mon–Sun, so a day never splits across appended chunks, and filtered flows get correct markers for free

## 2026-07-05

### FLIP flight validation

- Fixed a disappearing card landing 171px off its old spot and its seam target: a `week-start` ghost kept `position: relative` (the class the seam line needs, same cascade specificity as `.flow-ghost` but later), so its overlay `top` read as a relative nudge and it stacked below the prior in-flow ghost instead of pinning to its own prior position. The ghost is now forced `position: absolute` inline; the seam line's absolute `::before` still anchors to it
- The geometry unit tests (`flip.test.ts`) couldn't catch it — they pin `departureTarget`/`arrivalOrigin` output, but this defect was in how `animateFlow` pins a card into the DOM, which needs a real browser (layout + CSS cascade + Web Animations). `test/flip-flight.validate.mjs` is the browser harness for that half: `validateFlight(trigger)` freezes any transition at both ends and asserts two frame-level invariants — (A) every surviving/disappearing card renders at its pre-render position at the first frame (a bad pin shows here), and (B) every appearing/disappearing card actually travels (no fix-in-place). A CI version would drive the same two assertions from a headless browser (Playwright), not yet a dependency
- Fixed an arrival starting *too close* to its landing spot: the arrival flight distance ran the whole origin→rest span through the soft knee, so a far anchor-forced origin that still rests on-screen got compressed and the card began short of its true seat — the exact mirror of the ghost bug `ghostFlightDy` already guarded against, but not applied to the arrival branch. The applied distance is now `arrivalFlightDy`, the mirror of `ghostFlightDy`: an arrival always lands at `translateY 0` (its rest is exact by construction), so the endpoint that must be reached exactly is the *origin* — an off-edge exit and an on-screen origin are both reached uncapped, only an off-screen non-exit origin is soft-capped (its tail is off the edge anyway). `flip.test.ts` gained an `arrivalFlightDy` block covering the three branches. Neither existing test caught it: the geometry tests pin `arrivalOrigin` but not the distance `animateFlow` applies, and the harness's invariant A skips arrivals (they have no pre-render position — it only checks survivors + ghosts), while B only checks that an arrival *moved*, not from where

### Boundary trackers follow their boundary card

- A ghost whose moment lies past the new layout's ends (newer than the newest new card, or older than the oldest) no longer picks its direction by its own center against the outer seam — which could send a ghost below the last card *up* while the last card slid *down*, contradicting the timeline's drift. It now tracks its boundary card, moving the way that card travels from its start (its old position, or the old-layout seam it appears from) to its final spot. Outward travel (newest up / oldest down) flies the ghost the system's full reach — FLY_MAX viewport heights from its own spot — clean off that timeline edge into the void, flagged `exit`; that is farther than any surviving card (the soft-knee holds their distance strictly under FLY_MAX), so a void-flyer is always the fastest thing on screen, clears the pane whole, and its ease-out tail lands off-screen rather than braking at the edge; inward travel, or a *surviving* boundary that holds still, folds it in behind the boundary card, the timeline concentrating into its edge. A non-surviving boundary always moves (it flew in from a seam), so the fold-in-when-still branch is only ever a survivor that stayed put
- `departureTarget` now takes the pane rect and the old layout (to read the boundary card's travel); `arrivalOrigin` passes the *new* layout as that far side, so the exact-mirror property holds by the identical call — an out-of-range exit one way is an off-edge fly-in the other. In-span crossings are unchanged (extracted to `seamPoint`, still center-line vs. gap). `flip.test.ts` covers the geometry both ways; the browser harness's travel invariant still holds (every tracker moves at least half its height or leaves)

### Time as permalink handle

- The gutter time is the entry's permalink handle (an `<a>`, muted at rest, accented on hover/focus). Its href is the entry's jump route within the current filter, so copy-link/middle-click/new-tab deep-link to the card; a plain click scrolls the entry to the top of the flow (`jumpToEntry` gained a `block` arg — `'start'` here, `'center'` for entry references) and pushes that URL
- Jump scrolling now honors the animation-speed setting: replaced the native `scrollIntoView({behavior:'smooth'})` (fixed browser duration, ignored the setting and the "Off (no motion)" option) with `scrollFlowToCard`, a rAF scroll scaled by `animSpeed` over `slow` base and instant under Off / reduced motion — in lockstep with the FLIP and CSS durations

### Arrivals come forward; every fade is unconditional

- Flipped the flight depth: was survivors > departures > arrivals (the old view stayed intact and dissolved into the new), now **survivors > arrivals > departures**. Rationale: the layering was tuned for filter-morphs, but for a reference-jump the departing cards covered the just-navigated-to target for the first ~⅔ of the flight (departures only fade in the last third). Arriving content is what the user's attention is on, so it now leads. Implemented by dropping `.flow-ghosts` (the departure overlay) from `z-index: 10` to `0`; movers stay `11`, arrivals keep their inline `1–9`, all still under the readout latch (`z 20`)
- With arrivals on top, an opaque arrival would cover the old view on frame 1 — so **every arrival now starts transparent** (fades in over its first third), unconditionally. Symmetrically **every departure ends transparent** (fades out over its last third). Removed the old on-screen/off-screen gate that let cards from/to past the pane edge skip the fade (opacity used to signal "revealed-in-place vs traveled"); distance is still carried by the slide's soft-knee speed, so nothing is lost. Survivors still never fade
- Pure geometry (`departureTarget`/`arrivalOrigin`/`ghostFlightDy`) untouched; `flip.test.ts` still green. This does **not** fix the tall-card issue below — an oversized departure now fades beneath the arrivals rather than over them, but it still can't leave the pane in one flight

### Co-hover across an entity's references

- Hovering any reference to an entity co-highlights every other reference to it on the page — margin tags, inline mentions, and the docked filter pill, each showing its own hover treatment (tags dim, mentions underline). A single delegated `mouseover`/`mouseout` listener on `document.body` keys off the `data-ref-type`/`data-ref-id` pair under the pointer and toggles `.is-cohovered` on every element that matches; `mouseout` clears only when the pointer leaves for somewhere outside any reference, so sliding between two references hands off cleanly
- Every reference carries `data-ref-type`/`data-ref-id`: inline mentions already did; margin tags (`renderTag`) and the filter-pill label gained them
- A collapsed tag group's +N bubble hides several entities behind it, so it can't carry a single id — it carries a `data-ref-hidden` token list (`type:id` entries, whitespace-joined) and lights up when the hovered entity is among the folded ones, matched with a `[data-ref-hidden~="type:id"]` selector. This mirrors how the bubble already carries the active filter's fill when the filtered entity is folded behind it

## 2026-07-06

### Asset reader renders by media kind

- The asset reader picks a rendering from the file extension (`assetMediaKind`): markdown and extensionless files render as markdown; images, PDFs, audio, and video embed inline; everything else is fetched raw and shown verbatim, or offered as a download when `looksBinary` finds the bytes aren't text (NUL or a scatter of U+FFFD)
- Media embed by URL rather than reading bytes as text: `DataSource.assetUrl(path)` gives an addressable `<img>`/`<video>`/`<iframe>` src (null when a source can't address one, e.g. the in-memory test source, which falls back to reading + the binary path). `app.ts` resolves the payload in `loadAssetContent`; `renderAssetDetail` takes a discriminated `AssetContent` and switches on kind

### Document reader reads at the flow's width

- The reader's content column is now exactly the flow's readable measure: a `--flow-content-width` var (`--flow-max-width − --flow-gutter − --flow-pad-x`) drives both `.flow`'s geometry and `.doc-body .entity-view`, and `.doc-window` is that measure plus its padding, the always-reserved scrollbar track (`.doc-body` is `overflow-y: scroll`, like the flow), and its borders — so the column lands at exactly the flow's width, replacing the old `min(880px, 92vw)` window and 72ch column. `--scrollbar-width` also feeds the `::-webkit-scrollbar` rule so the reservation stays in sync
- Below 960px (where the floating window can't keep a margin) the reader goes full-screen: `100vw`/`100dvh`, no border, radius, or shadow; mobile also tightens `.doc-body` padding

### Flow transition animation

The full transition design — principle rules, per-kind start/end geometry, void
and compression handling, the animate table, and its known issues — lives in its
own doc: [animation.md](animation.md).

### Known Issues

- Flow transition animation — **overspeed**, the **off-screen poke**, and the
  **tall-card brake** (all resolved by the deferred *settle-vs-leave* timing) are
  documented in [animation.md](animation.md#known-issues).
- Mobile responsive layout needs work

## 2026-07-11

### Modularized app.ts

- `app.ts` shed three self-contained modules, each named in the spec's file
  structure: `dates.ts` (loose date parsing + calendar arithmetic, DOM-free,
  covered by `dates.test.ts`), `latch.ts` (the latched readout, its marker
  registry and suppression, and the week-seam scrub), and `datepicker.ts` (the
  jump-to-date popover, reaching the flow only through a two-function deps
  interface: `jumpToDate` for the one-time jumps, `jumpNear` for the quick
  navigator's landing). `app.ts` keeps state, navigation/history, the
  flow/anchor machinery, panel, reader, and search wiring
- Deduplicated: the five settings listeners share `bindSelect`/`bindCheckbox`;
  the loading/error paragraphs share `setNotice`; `resolveName` reuses
  render.ts's `formatTime`; `toDateStr` lives in `lib/types` and
  `getMondayOfWeek` formats through it; flip.ts reads both layouts through one
  `collectCards`; `store.init` reads the three index kinds through one helper
  and dropped its write-only `years` field
- Removed the dead theme-toggle `.icon-sun`/`.icon-moon` rules (the toggle is a
  single inline SVG); a programmatic sweep of class names, id selectors, and
  custom properties against the sources found nothing else unused, closing the
  stale-CSS known issue

## 2026-07-12

### Project hierarchy in the project detail

- A project detail's related projects render as an indented tree instead of
  the verbatim `related_projects` list — links are declared on the higher-level
  project, so position carries the direction: ancestor paths from the top-level
  projects down to the open project (always shown; the root itself when nothing
  links here), then its full descendant subtree, each row the usual clickable
  tag with the link's declared description
- New `src/hierarchy.ts` (DOM-free, `hierarchy.test.ts`) builds the tree from
  the store's relation map; the link graph need not be a tree, so a project
  reached twice — several parents, or a cycle — expands only the first time and
  repeats as a plain row
- The summary panel keeps its flat lists — it's a 360px navigator, and the
  deep ancestor paths wrap badly there; the tree lives at reading width. It
  first shipped in the panel and moved on user feedback

### Daemon backend and agent navigation

- One daemon origin serves the chooser and all instance views. Browser discovery reads registered manifests without loading record stores. Native selection registers existing directories or `aside.md` in place.
- `src/backend.ts` scopes core snapshots, supporting files, media and watch streams to the selected instance; settings cover display preferences.
- `src/control.ts` registers chooser or selected tabs, reports focus, and reconnects. `show` opens a fresh authorization handoff in the default browser; `showUrl` returns it for a chosen browser. See [browser authorization](../design/daemon.md#browser-authorization).
- Pushed routes use `applyView`/`jumpToEntry`, with pushState and the usual anchored transition. A route racing initial load waits for its store.

### Instance summary panel on the unfiltered flow

- The side panel now always summarizes the flow's scope: the unfiltered flow
  gets an instance summary — the `aside.md` manifest's name and description,
  "Open details", open projects (index descriptions) and open actions, and the
  total entry count. Clearing a filter lands back on it; a source without a
  manifest keeps the old no-panel behavior
- The instance is not a filter, so its panel has no close button and its
  docked pill no × — retract is the only way to put it away, and the collapsed
  preference holds across scopes as before
- `/detail` (a new route head, added to both servers' SPA fallbacks) opens the
  manifest record in the reader: name as title, id, the other front matter
  fields verbatim (config keys under `config.`), then the free-form body
- The store reads `aside.md` untracked at init — the manifest takes no part in
  catch-up; the panel itself re-renders on data updates like the entity
  summaries (a project closing drops out of the open list live)

### Open details moved into the title

- The in-body "Open details" button burned a content row in every summary; it
  is now a muted open-arrow (↗) trailing the title text, so the summaries
  carry content only. The title placement won over the panel's floating
  corner group: the affordance acts on the record the title names
  (retract/close act on the panel), and it stays away from the adjacent ×
  misclick. Inline, so it rides the last word of a wrapped title; absent on
  the entry detail page (an entry reads in full right there)
- The glyph is an arrow, not a document, and rides superscript: a second boxy
  icon on the text line read as a badge bracketing the title symmetrically
  with the type icon (a document glyph, then an arrow at cap-center, were
  tried first). 12px, raised 6px off the baseline (inline-flex box, so the
  raise is exact against the browser-measured glyph box) — it sits at the
  name's top-right shoulder like an external-link marker

### Instance summary focused, instance detail complete

- The split (summary = what needs attention now; detail = everything there
  is): the summary panel's open projects reorder by last activity — a stale
  open project sinks — and its open actions partition by date kind: "Due"
  (any deadline), "Scheduled" (a scheduled time, no deadline), "Backlog"
  (undated), each section heading carrying its count. The panel's
  entry-count line moved into the detail's stats
- Grouping, windowing, and ordering are pure functions in new
  `src/instance.ts` (`instance.test.ts`); date math runs on local-time
  parts, never Date-parsing an ISO date string (that reads as UTC)
- Every summary section reads reverse chronologically (latest first, like
  the flow — one direction everywhere) and hangs on a timeline
  (`.timeline-list`): a vertical rail with a node wherever the date changes
  — an unlabeled row lets the rail pass through unmarked (`:has` on the
  gutter cell), so a same-dated run reads as one stretch — the date
  (`relativeDate`: one compact rounded unit — "3d", "2w", "4mo", "in 3d"
  ahead — a year-overdue deadline as "349 days ago" is noise where "11mo"
  reads at a glance, and the clock time of a stamp is more than the glance
  needs) in a fixed right-aligned gutter at the node. Due/scheduled rows
  date by their deadline or scheduled time; project and backlog rows by
  their last update (the latest entry, a backlog action without one its
  creation). Rows are bare pills — the panel is a work list, descriptions
  live on the detail. The rail and node draw on the `<li>`'s pseudo-elements
  so the line spans row padding unbroken, starting and ending at the
  outermost nodes; the flex row keeps wrapping content clear of the rail
- The due/scheduled timelines run unbounded both ways, defaulting to the
  week ahead and at least a few rows either side of now (`timelineWindow`);
  the folded ends expand with "+N later" / "+N earlier" buttons and a
  `--color-accent` tick on the rail marks now between the future and the
  past — placed against the visible window, so it never hides in a fold; the
  future rows' rail, nodes, and gutter labels carry the same accent. The
  window edge always prints its date even mid-run, since the row that would
  have carried it may be folded away
- The instance detail gains the full census between the fields and the body:
  the whole project forest (`buildProjectForest` beside the per-project tree
  in hierarchy.ts — every project nested by its links, loners as roots, the
  same expand-once rule), all actions grouped Open / Done / Cancelled with
  index descriptions, and instance-wide stats
- Detail front matter reads as text, not a code dump: values in the UI face
  — only genuinely code-like ones (ids, versions, config entries;
  `.field-mono`) keep the mono face — and stamps in the flow marker's date
  form plus the configured clock time ('2025 Dec 4, 09:00' — `formatStamp`,
  also the census stats' latest-entry date). Every detail shows its authored
  description as the panel's summary line under the title, never a field
  row: project/action details the index description, the instance its
  manifest's
- Census sections fold behind their headings (native `<details>`, count in
  the summary row so a folded section still informs); resolved action groups
  start folded. The panel's list folding shares one section builder
  (`appendSection`), so panel-state replay keys off the same `data-section`
  machinery; a dated section folds at both ends, so its buttons also carry
  `data-dir` and the replay records direction-qualified entries
  ("Due::future"). Fold labels are directional everywhere: "+N earlier" on
  every list (the store's relation lists are all reverse chronological, so a
  folded tail is always the older rows), "+N later" on a dated timeline's
  future end. Timeline fold buttons offset into the pill column
  (`.timeline-more`)

### Pills carry their lifecycle status

- Every project/action chip now reads its status at a glance without giving
  up the type channel: the icon and accent color still say what kind of
  thing the pill is; status rides second channels. An open action's marks
  are orthogonal and compose (`actionMarks`): a deadline rings the pill (a
  thin inset ring in the due red) and a missing scheduled time trails a
  small grey waiting clock — both together on an unscheduled deadline'd
  action; scheduled work and open projects are the clean pill. Iterated from
  glyph-per-status (due alert / scheduled clock / backlog dashed circle /
  done check / cancelled ✕) on user feedback: the clock's meaning flipped
  from "has a time" to "awaiting a time", urgency became a circle so it
  composes instead of competing for the glyph slot
- Closed work (done/cancelled/ended) mutes: field to the entry grey, name
  to the secondary text tone (AA on the grey field), the icon keeping full
  type color — the vivid icon is the reference the grey name reads muted
  against, and alone carries the type; a cancelled name adds a soft
  hairline strike (half-ink, 1px). The active filter's solid fill — grey
  for closed work — takes every ink including the icon, as on any
  highlighted pill (a colored icon on the grey fill was tried; it read as
  a different kind of highlight, not the same highlight in grey).
  Landed here through dim+strike, then mute-with-hinted-name (45% → 25%
  type color), then fully grey — each step on user feedback
- One derivation feeds everything: `actionMarks`/`projectMarks` in
  instance.ts are the primitives, the single grouping status is their
  leading mark (so the panel's Due/Scheduled/Backlog groups and the chips
  agree by construction — a deadline'd open action presents as Due, layered
  over design/action.md's four stored states), and chips resolve marks
  synchronously through the store's eager caches (`refMarks` in
  RenderOptions). `applyMarks` dresses every surface the same: entry tag
  rows, panel rows, inline mentions (the due ring flattened to a thin red
  underline — a box breaks across line wraps — and the mute on the ink),
  the docked filter pill (refreshed on catch-up), the +N bubble when
  it stands in for the hidden active tag, and the summary/detail stage pill,
  which now wears the entity-pill style with the stage word as its text
  (project stage renamed Active → Open). Closed statuses share a
  `tag-status-closed` class so the CSS styles the family, not each member

## Native navigation controls

- Feed references, panel titles, and related file rows use instance-scoped anchors; plain activation preserves app transitions and modified clicks use the browser.
- Tag folds and section reveals are labeled buttons with expanded state and controlled-list IDs; toggling or removing a control preserves the keyboard's position.
- Rendering regressions run in Happy DOM; visual and keyboard behavior is checked in the browser as specified in [spec.md](spec.md#visual-verification).
