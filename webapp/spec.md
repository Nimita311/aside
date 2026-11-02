# Web App

A browser application for visualizing the productivity data framework. The daemon serves the app and its instance-scoped records from one localhost backend. Rendering and display derivations run in the browser.

Production and watch builds emit shell scripts, styles, and their assets into `dist/`. `style.css` is an ordinary build entry, served at `/-/assets/style.css`. All public asset URLs resolve under `dist/` according to the [asset boundary](../cli/spec.md#web-server).

## What It Should Be

### Primary view: content flow

The primary view is a reverse-chronological flow of entries in the main landmark, each entry an article. Content is centered and is the focus — the main column is pure text.

### Empty views and getting started

A successfully loaded instance with a valid manifest, clean indexes and no notes, projects, actions or artifacts shows `The stage is yours.` Its fine print reads: `Ask your agent to capture a note, organize a project, or plan an action. Your records will appear here.` The view identifies the selected instance and canonical directory. `Copy a starter prompt` includes that identity and directory and asks the agent to call `select_instance` explicitly: browser and agent selections are independent. If clipboard copying is unavailable, the prompt remains selectable in the view.

`Getting started` reveals concise agent workflow and browser navigation guidance. The browser reads records; the agent captures and changes them. No tutorial records are inserted automatically. A note-less timeline in an instance containing other record types says `No notes yet.` rather than showing whole-instance onboarding. A fully traversed filter with no entries shows `No entries match this filter.` and `Clear filter`. Loading, read failures and parse diagnostics must resolve before any empty-state claim. The unfiltered bottom marker remains `The End`.

### Timeline margin

With compact timestamp styles, a left margin serves as a timeline indicator. Each entry carries its time in the configured time style and clock format; dates live in markers. The first (latest) entry of each day carries a marker on its first margin line — pinned to the gutter's left edge, the time keeping the right — so a day boundary adds no height to the flow. The marker shows only the units that changed at that boundary: the bare day number within a month (`22`), month and day at a month boundary (`Apr 30`), year, month, and day at a year boundary or at the top of the flow (`Dec 31, 2025` with Medium US English dates) — so scanning the margin reads the time span without reading every timestamp. Date units, separators, padding and names follow the selected date style; Full includes the weekday and ISO uses numeric year-month-day. Year, month, day, and any weekday occupy fixed columns (unchanged units leave theirs blank), so dates align down the gutter; day numbers render lighter than month/year names, keeping boundaries prominent.

Weeks — the files' native Mon–Sun grouping — read as seams: on the first (latest) entry of each week, the divider above extends left across the gutter, slicing the timeline into weeks at no height cost. Ordinary dividers span only the content column. Approaching the readout, a seam's gutter extension retracts: a soft transparency edge sweeps across it left to right (scrubbed by scroll, reversible), leaving the content-column line to exit under the pane edge like any divider — the seam is wider than the readout's backdrop, so passing behind it would otherwise bite a visible chunk out of the line.

Wide timestamp styles and narrow screens place a complete date-time label above every entry, keeping the reading column wide. Each label includes its date even within the same day and uses the same muted monospace styling. A sticky calendar button beside the timeline opens the date picker without overlaying timestamps; its accessible name and hover show the viewing date. Hidden day markers track that date.

With the compact gutter, a readout latched to the top of the flow pane shows the current date in the selected style (`May 22, 2026` with Medium US English dates), in the markers' unit columns. A weekday appears in the date pattern when the selected style includes it. The readout itself never moves; its solid backdrop is exactly the text row and spans only the date columns, leaving entry times visible as they scroll past. The swap is scrubbed by the scroll itself: the next day's value rides its own marker's real position into the readout — a single visible instance, the chip's copy continuing it seamlessly as the marker passes behind the backdrop — and within a glyph-height of the latched value it makes contact and pushes it up and out, one connected odometer roll. Each changed date unit rolls individually. The roll completes exactly when the marker reaches the readout row; reversing the scroll rewinds it. A day's value is thus always visible somewhere — as its marker, riding, or latched. (Under `prefers-reduced-motion` there is no riding value; the date swaps instantly when the marker touches the chip.) The readout is present from scroll 0 and never shifts position; it is pinned where the flow's first margin line rests at the top — flush with the first entry, clear of the header. The first day renders only in the readout: its in-flow marker is invisible, holding its place in the margin.

The readout doubles as a jump-to-date control: clicking it opens a popover with three parts always visible at once — a quick period navigator, then a rule, then a date-entry field and an inline calendar (the rule marking the navigator and the date selection as two separate ways to jump). The popover extends left into the outer margin with its right edge flush to the fixed date's, so its top-right step arrows sit directly under the date while the panel clears the entry times and reading content further right. The **navigator** picks a period (week / month / quarter) and steps it with up (newer) and down (older) arrows; each step is relative to the flow's current date — jumping to the entry closest in time to one period away and keeping the popover open, so the user can walk the timeline a period at a time and scrolling (or a manual jump) between steps re-bases the navigator to where the view now sits. A step lands on the entry closest to the target on a date in the arrow’s direction, crossing gaps of any size. If no further date is available, the view stays in place without a message or shake. Month and quarter offsets clamp to the target month's last day, so a month-end date lands on the month end (May 31 − 1 month is April 30). The **date field** is a plain text field, empty by default — no native date control, so nothing competes with the inline calendar. While it is empty the calendar shows the current viewing date's month and follows it as the flow scrolls, so an empty picker mirrors where the flow sits. It takes free-form input parsed leniently (ISO, `5/31/2026`, `5/31/26`, `2023 3 12`, `May 31 2026`, `15th March`, a bare month, year, or `3`, …); a year-less entry infers its year from the date — this year if that day is today or already past, else last year, so it reads as the most recent occurrence (`jul 20` on Jul 7 is last year's). Pressing Enter jumps (flagging the field if the text resolves to no date); editing follows the calendar to the parsed month and highlights the parsed day (shown as an ISO date), and clearing the field returns it to the viewing month. The field commits only on Enter, not on blur, so clicking the **calendar**'s month arrows navigates rather than jumping. The calendar marks three days distinctly: the field's date (filled), today (a ring), and the day the flow is currently showing (a dot) — any of which may coincide. The date field and the calendar are each a one-time jump that dismisses the popover: they scroll to that day, aligning the margin line of its latest entry (or the nearest earlier entry) with the latched date readout. Dates before the oldest entry clamp to the oldest card in the current filtered view; dates after the newest clamp to the newest. Empty views stay in place. Exact entry references still require an exact match. Every jump loads older weeks as needed and flashes the landing card. The popover also dismisses on Escape or a full click outside — both the press and the release beyond it, so a drag that starts inside (selecting the field) and ends outside doesn't close it.

Month navigation keeps keyboard focus on the corresponding arrow after redraw. Escape and a completed date jump return focus to the current visible latch trigger, its replacement, or the Aside chooser link when the trigger is unavailable. Outside pointer dismissal preserves the clicked target's focus. An invalid date stays in the field with a visible explanation and example, `aria-invalid`, and an associated error description. Editing the field clears that error.

On narrow screens the margin stacks above the entry content, the marker leading the row, and the readout becomes a full-width strip.

### Two-column layout

The flow uses two columns: timeline (left) and content (center). The content column is centered on the page and is the primary reading experience. The timeline sits in the left margin.

- **Left**: timeline — when (year, month, day, time)
- **Center**: content — what (text, tags, the primary reading experience)

No vertical separators — whitespace provides separation. Content stays centered and takes the most space.

### Entity tags

Tags appear as a compact row above the entry content, inside the content column. By default, show one tag per type (one project, one action) as clickable pills. If an entry has more tags of a given type, show a colored count bubble (+N) next to the visible tag — blue for projects, green for actions. Clicking the bubble expands to show all tags of that type. Clicking again collapses back to the compact view.

Every project and action pill carries its lifecycle status at a glance — the leading icon and accent color say what kind of thing the pill is; the status rides a second channel. An open action's marks are orthogonal and compose: an action with no time ahead on the calendar — unscheduled, or its scheduled event already over (scheduled plus `duration`, the calendar design's default length when unset; a date-only stamp lapses when its day ends) — trails a small grey mark of its calendar slot, which keeps its cause: a dashed empty circle while a time was never set (backlog — the slot never filled), a clock face with hands once a set time lapsed (slipped — a real time that ran out); either way waiting to be scheduled, first time or again. And a deadline rings the pill with a thin inset ring in the due gold — urgency drawn as a circle rather than a glyph, so it rides any pill, and gold rather than red so it also reads against the action green for red-green color vision (an unscheduled action with a deadline carries both; an inline mention, having no field to ring and boxed awkwardly by one across a line wrap, flattens the ring to its bottom stroke — a thin underline in the same due gold). A deadline behind now — a date-only one once its day ends — is breached, and the same signal escalates rather than changing shape: the ring turns the overdue red and bleeds into the field as a soft wash, the name's ink reddening with it while the icon keeps the full type color (a mention reddens its ink and underline). A scheduled action with no deadline is the clean pill, as is an open project — the live state. Closed work — a done or cancelled action, an ended project — mutes instead: the pill's field greys and the name's ink goes fully grey (the secondary text tone — the entry pills' ink) while the icon keeps the full type color — the vivid icon is the reference the grey name reads muted against, and alone says what it is (an inline mention, having no field, mutes its name the same way); a cancelled action's name additionally strikes through — dropped, not finished. The status reads the same wherever a chip appears — entry tag rows, panel rows, inline mentions, the docked filter pill. Accessible descriptions expose the type and lifecycle marks without changing the visible or authored link label; an active entity folded behind +N keeps its name and state in the bubble's description. Clock repaint updates these descriptions in place.

In a filtered flow, the filtered entity's own tag fills with a softened solid of its type color on every entry (a +N bubble hiding the tag carries the fill), and its inline mentions get a soft background fill of their type color — background only, no metric change, so the text never shifts. The fill respects the status marks: a closed entity's tag fills with the muted grey solid instead of the type color (its inline mentions with the entry grey) — the highlight never resurrects closed work; an overdue tag fills with the overdue solid, its mentions with the wash — the highlight never downplays a breach; and a due pill keeps its ring at the same weight whether highlighted or not (the fill marks the highlight, the ring only the deadline). On any fill, grey or colored, the whole pill takes the fill's ink, icon included — one uniform highlight.

Entries with no tags show no tag row — the content starts immediately.

### Navigation controls

Feed tags, inline references, panel titles, related entity rows, and raw-file rows are native links with complete instance URLs. Tab reaches them and Enter activates them; copy-link, middle-click, and modifier-click retain normal browser behavior. Plain activation keeps the app's existing filter, jump, and reader transitions.

Tag expansion and section reveals use native buttons with meaningful accessible names, `aria-expanded`, and their controlled group/list IDs. Enter and Space activate them. Replacing a tag expansion button retains its focus; revealing a section moves keyboard focus to its first newly revealed link. All navigation links and expansion controls show visible keyboard focus.

Panel retract/expand hands focus between the outgoing and incoming control when focus is inside the departing surface. Its controls become inert immediately during the exit animation, and hidden afterward; reopening cancels a pending hide. Focus elsewhere remains in place. The folded expand button's accessible name includes its visible scope name, and repainting the folded controls retains equivalent focus.

Departure visuals are inert and hidden from accessibility during the flight. Before replacing a focused entry, focus moves to the visible scope control or Aside chooser, including with reduced motion. Focus already outside outgoing entries stays in place.

### Time as permalink handle

The entry's gutter time doubles as its permalink handle — muted at rest, accented on hover/focus. Its href is the entry's jump route within the current filter (including the selected instance ID), so copy-link, middle-click, and open-in-new-tab all deep-link to the card. A plain click scrolls the entry to the top of the flow and pushes that URL, keeping any active project/action filter.

### Inline entity mentions

Inline mentions (`#project/name`, `#action/name`, `#entry/YYYY-MM-DDTHH:MM`) render as muted tag-style pills that flow with the text — not plain links. Visually softer than the margin tags but still clickable. Entry mentions consume a complete, valid timestamp (minute precision, with existing second-precision routes recognized); partial or malformed timestamps stay literal. Project and action IDs retain their letter, number, combining-mark, underscore, and hyphen grammar. Code and escaped hashes stay literal. Markdown links to complete entity handles keep their authored labels and formatting while using the same instance-scoped native destination and ordinary-click navigation as bare mentions. Unrelated fragments and external links retain their destinations.

Hovering a project, action, or entry reference — a margin tag, an inline mention, or the docked filter pill — co-highlights every other reference to that same entity on the page, each showing its own hover treatment, so the eye can trace one entity through the flow. When a reference is folded behind a collapsed group's +N bubble, the bubble itself lights up in its place.

### Inline date smart elements

[Date references](../design/date-reference.md) define the ISO handle syntax,
display, copy, and calendar navigation contract. They render in every Markdown
reading surface alongside entity references. Date routes preserve calendar
targets independently of exact entry IDs.

### Entity resolution

Project, action, and entry references render as clickable tags. Artifact and file references open documents in the reader.

- Project tags → project detail + filtered entry flow
- Action tags → action detail + related entries
- Entry references → jump to that entry's position in the flow (scroll + highlight; keeps a project/action filter when the target is inside it, clears it otherwise)
- Inline mentions (`#project/`, `#action/`, `#entry/`) → same as metadata tags
- Artifact handles → artifact or attachment in the reader
- Asset links (relative markdown links in content) → raw-file document in the reader

### Drill-down

Clicking a project or action navigates to it — the flow filters to related entries, and the side panel shows its detail. Each click replaces the current filter with the new entity; clicking the active entity's own tag (highlighted in the flow) toggles the filter off. Selecting the active entity from search is a "go to", not a toggle — it just closes any open document.

Every flow re-render is grounded at an anchor — an entry held at its viewport offset while the timeline re-renders around it. The anchor degrades gracefully: its own card is pinned at its offset when that entry survives the new filter; otherwise the surviving card closest to the displayed moment is pinned flush with the readout instead. Either way the view stays grounded in a card, which matters most when the timeline expands (a proportional-scroll mapping would amplify small moves into large jumps in time; pinning a card cannot). Which entry anchors follows the user's attention: engaging or clearing a filter from a tag on an entry anchors that card, so the entry acted on never jumps away; clearing from elsewhere (panel close, Esc) re-anchors the entry the filter was engaged from while it is still on screen — the round trip returns the view the filter came from. Every other case anchors the time cursor: the entry under the latched date readout at the pane's top edge, the moment the readout displays. Engaging from outside the flow (side panel, search) and display-setting changes anchor it, so the readout's date holds steady while the related cards visible in the flow slide to their places in the new timeline — the timeline always animates around the user's click or, failing that, the readout's moment. Browser back/forward restores each view as it was left: every history entry carries its own anchor (the time cursor and its offset, refreshed as the user scrolls); an entry without one falls back to the current time cursor. When the new flow is too short above the anchor, the scroll clamps and the card slides as little as the content allows. Either way, weeks keep loading until the anchor reaches its offset and the pane below it is filled to the viewport's bottom — so the card holds its place and the entries beneath it are built before the transition plays, rather than popping in after it (which is what a top-clamped anchor, seated with nothing below it, would otherwise do). (Following an entry reference is a different gesture — it jumps to the entry's position in the flow; when the jump leaves a filtered flow, the clicked card anchors the expand before the scroll moves to the target.)

The side panel is the indicator of the active filter — closing it (× or Esc) clears the filter and returns to the full flow. Navigation history is handled by the browser back/forward buttons via URL state.

### Advanced filtering

Compound queries live in the search bar, not the click-to-navigate UX: terms, type prefixes, and date ranges compose there (`action:deploy 2025-01..2025-06` — the syntax and selection behavior live in "Universal search"). The flow filter itself stays single-entity.

### App frame

The page itself never scrolls — the app frame (header, panel, pill) is fixed layout, and each pane is its own scroll container: the flow scrolls in its pane, the panel body in its own. Rubber-band bounces happen inside a pane and reveal that pane's own background, so the chrome can never desync or reveal an edge — the standard app-layout treatment.

The flow's position never depends on any other UI state. The side panel and the document reader float above it — opening, closing, or switching either never reflows the flow by a pixel. The reading position is sacred.

### Side panel: scope summary

The side panel is a summary and navigator, never a reading surface. It always summarizes the flow's current scope — the filtered entity, or the instance itself on the unfiltered flow:

- **Project**: name, status pill (Open/Ended), the authored one-line description (from the index), the facts line, related entities
- **Action**: name, status pills, description, facts line, related entities
- **Instance**: the manifest's name, description, facts line, and the instance's current state — its open work

Status renders as a row of pills, each a lifecycle state or an exception — never a fact. A pill's text carries time only as the distance to a pending event, that distance being the magnitude of the status (due in 3 hours and due in 2 months are different states): an open action wears `Due in 3d` (`Due today` for date-only deadlines, `Due now` at a timed deadline, escalating to `Overdue 3d` once breached) whenever a deadline exists, and for its calendar one of `Scheduled in 2h` (`Scheduled now` at its start, `Scheduled 2h ago` mid-event) while the event is ahead or running, `Slipped 2mo` once it lapses unresolved, or `Backlog` when a time was never set — deadline and calendar independent pills, never merged, all shown when they apply; a resolution stands alone. A live schedule synced to no calendar adds a `No calendar` exception pill — a dashed outline on no field, an absence rather than a type accent; a slipped one doesn't (rescheduling, not syncing, is its fix), and the synced norm shows nothing. A pill's label carries the distance; a named schedule additionally shows its absolute local time and authored clock/zone annotation visibly in the summary and detail. The calendar fact also reads on hover — every pill whose state has a stamp spells it out absolute ("Deadline 2026 Aug 3, 17:00"): the due pill its deadline, a Scheduled or Slipped pill its scheduled time with the timezone and duration riding it, a resolution its scheduled time (the design's done time, absent when never scheduled), a project's Open/Ended its created/ended stamp. Backlog and the exception pill have no stamp and no hover. Pills wear the entity-pill style: the type accent field carrying the same marks the entity's own chips wear (the due ring and its overdue wash; the calendar-slot glyph — the slipped clock on the Slipped pill, the dashed empty slot on the Backlog; the closed mute and strike), no type icon — the title above carries it. The authored description sits below the pills, and one muted facts line closes the header under it — reading as text, it belongs with the prose, not among the title and pills. The line: the stats — the scope's counts as icon-and-count pairs, the entity-type icon in its full type color, the count in the mono face, `open/total` for the lifecycle kinds, a bare count for entries — then, trailing them in the text face, `updated 3d ago`, the one time-since fact every summary states (the time since the latest entry mentioning the entity; for the instance, its newest entry; absent when none does — time since a past event is a fact, not a status, so it never wears a pill). The line shares one line height, its children centered; it wraps on a narrow panel, the updated text falling first. The rest of the front matter lives in the detail view.

The instance counts all projects, all actions, and all entries; a project its explicit related projects, its co-occurring actions, and the entries mentioning it; an action its co-occurring projects and its entries — never itself, its own state being the pills'. Zero is a stat, never hidden. Each pair spells itself out on hover ("4 of 30 actions open"); the facts line navigates nowhere — the sections below do. The detail's stats add the latest date and the per-state splits.

The title carries the entity-type icon in front of the name, colored by type (project blue, action green, entry grey, instance neutral), so the kind reads at a glance — there is no labeled header stripe, just floating retract and close buttons. The whole title — icon and name — is one native link opening the scope's record in the reader, a muted open-arrow (↗) trailing the title text as the affordance, like a superscript — small, raised to the name's top-right shoulder the way an external-link marker sits ("Open details"); hovering anywhere on the title lifts its opacity — the pill's hover, the title being the entity's own identity — and lights the arrow. The control is the identity it opens: it costs no content row and stays clear of the panel-chrome buttons. An arrow, raised and small, rather than a second badge-like glyph on the text line, so the title doesn't read as bracketed by a symmetric pair. The entry detail page has no detail icon (the entry already reads in full there), and the instance summary no close button: it is not a filter, there is nothing to clear — it retracts to the pill instead. Each selected instance has an `aside.md` manifest; unavailable instances show a recoverable connection error.

The panel's default width parks it in the flow's right margin, flush with the column so it covers nothing; double-clicking the resize handle returns to that width. The focusable vertical separator exposes the panel's current/minimum/maximum width in pixels and its key instructions: Left/Right adjust by 10 pixels (Shift: 50), Home/End select the bounds, Enter retracts, and Shift+Enter fits the margin. Resizing keeps focus on the handle; retracting transfers focus to the expand pill. The panel is resizable (drag its left edge; the width persists and clamps to the viewport) and retractable: retracted, it becomes a docked pill that slides in from the right viewport edge, showing the scope as a colored tag (a filtered entity in its type color and with a ×, the instance neutral without one) — the scope stays clearly visible while the flow gets the full width. Dragging the panel a step below its minimum width also retracts it (the pre-drag width is kept for the next expand); dragging back out before releasing reopens it — an escape hatch for overshooting. Clicking the pill expands the panel; a filter pill's × (or Esc) clears the filter. The retracted state persists as a user preference and holds across scope changes.

In-app entry references never open the panel — they jump to the entry in the flow, where it already reads in full. The entry detail page still exists as a deep link (`/entry/<id>`): a single-entry flow with the panel showing the entry's full content and its projects/actions/assets.

The panel floats over the flow's right edge with a shadow and updates as the user navigates.

### Related entities

Every summary ends with the scope's relationships — its live state, ordered by what needs attention. Closed and resolved work never appears in a panel: the panel is current state; history reads in the filtered flow behind it, the census in the detail.

- **Project**: its open actions in the same "Scheduled" and "Backlog" sections the instance shows, scoped by co-occurrence; then "Related projects" — the explicit `related_projects`, both directions (the link's description and direction read in the detail's hierarchy tree, not the panel rows); then "Assets", the files linked from its entries or body
- **Action**: "Projects" (co-occurrence); then "Assets"
- **Instance**: "Open projects", then the open actions, then "Assets", every asset linked from any entry

Open actions file by date kind — "Scheduled" (every open action with a scheduled time) and "Backlog" (the undated rest); a deadline never regroups an action — due is orthogonal to both kinds, and the chip's due ring carries it.

A filtered scope's project rows — a project's related projects, an action's projects — are plain rows, most recently active first: a short, near-static list has no temporal story to draw. Every other section hangs on a timeline and leads with its most relevant row — the instance's project rows and every Assets section read reverse chronologically, latest first like the flow, while the action sections read chronologically: Scheduled the plan ahead, soonest first; Backlog longest-quiet first — no action is ever written off as stale, so one going quiet rises to attract attention (revive it, schedule it, or resolve it), and its fold hides the freshest rows ("+N later"), the ones already in hand. The timeline is a vertical rail with a node wherever the date changes, the date printed at the node in a fixed right-aligned gutter as one compact rounded unit — minutes while a timed stamp is less than one hour from now (remaining minutes rounded up, completed elapsed minutes rounded down, `in <1m` / `<1m` below a minute, `now` exactly at the instant), then hours within a day ("3h"), then days, weeks, months, years ("3d", "2w", "4mo"; time ahead "in 3h", "in 3d"; a date-only stamp on the day itself "today"), past/future direction follows the actual time comparison rather than the formatted label; farther handovers round the true distance the same way (41 hours reads as 2 days just as 15 days reads as 2 weeks; a date-only stamp counts calendar days) — so a run of same-labeled rows passes unmarked, reading as one stretch of time, and the pills align into a column after the rail; fold buttons sit in the pill column. Scheduled rows date by their scheduled time, a tick on the rail marks now between the past and the still-ahead — the split compares full stamps, so today's later times sit below it, a date-only stamp counting from its day's start — the future stretch beneath it dotted in the tick's color from the tick down — not yet happened; by default the section shows the week ahead — today through seven days out — and at least a few rows either side of now, the rest expanding from either end ("+N earlier" above / "+N later" below). Project, Backlog, and Asset rows date by their last update — the latest entry mentioning (for an asset, linking) the item, a backlog action without one its creation. Each section heading carries its count, muted and spaced after the title.

Co-occurrence, related-projects, and asset links read from entry metadata — the design's source of truth for how entities relate. An entry count — the stats row's and the detail's — matches the filtered flow, so it counts every entry that references the entity in metadata **or** inline (the same rule everywhere: an inline mention resolves as a metadata tag would).

The related lists double as navigation: entities re-filter the flow, assets open in the document reader. Latest-first lists fold older rows behind "+N earlier"; Backlog, reading stalest first, folds fresher rows behind "+N later". Ordinary folded lists reveal twenty rows per click, their counts ticking down. Scheduled follows its dated window and expands from either end.

### Document reader

Action details show a supplied calendar account beside its readable calendar name, such as `Work (iCloud)`; an omitted account shows only the name.

Project, action, artifact, and instance records and raw files are documents — they need reading width, not a 360px strip. They open in an overlay reading surface: a centered window sized so its content column is exactly as wide as the flow's, near-full height — never sized to its content, the flow dimmed around it, styled with the same GitHub-flavored markdown rendering as the flow. On viewports too narrow to leave a margin the window fills the screen. Opened via the panel title's open-arrow ("Open details"), an artifact or file link, or a deep link.

- A project/action document renders the complete record: the status pills, the authored index description (the same summary line the panel shows), every front matter field (absent fields omitted, the id leading them as a field, code-like values — ids, versions, config entries — in the mono face, dates using the configured localized date and time styles; `name` is the title, `resolution` the status pills, a project's `related_projects` the hierarchy tree below — each datum appears once), then the derived record — a project's census of its actions grouped Open / Done / Cancelled (index order, with index descriptions; foldable, the resolved groups starting folded) and, on both, stats (the entry count with the latest date) — then the body.
- The instance document renders the manifest (`aside.md`) the same way — `name` is the title, `description` the same summary line the panel shows beneath it, the other front matter fields following (the id leading them, config keys under their `config.` path) — followed by the instance's full census in foldable sections, then the free-form body (the user-authored agent instructions). The census: the whole project hierarchy forest (every project — ended ones included — nested by its links, roots in index order, loners as their own roots), all actions grouped Open / Done / Cancelled (index order, with index descriptions), and instance-wide stats (entry count with the latest date; project and action counts by state). Each section folds behind its heading, the count staying readable while folded; the resolved action groups start folded.
- A project document's related projects render as the project hierarchy, an indented tree where position carries the link direction: `related_projects` links are declared on the higher-level project, so a forward link reads as a child and a reverse link as a parent. The tree shows every ancestor path from the top-level projects down to the open project — always present, carrying the active-filter fill; it is itself the root when nothing links here — then its full descendant subtree. Each row after a root carries the declared description of the link to its parent row, and rows are the usual clickable tags. The link graph need not be a tree: a project reached twice (several parents, or a cycle) expands its children only the first time and repeats as a plain row. The tree never folds behind "+N more".
- Clicking outside the window, ×, Esc, or browser back closes it; the flow and panel underneath are untouched. Settings and the reader are native modal dialogs: focus moves inside, Tab stays inside, and the background is inactive. Topmost modal dialogs wrap Tab from the last visible enabled tab stop to the first, and Shift+Tab from the first to the last. Hidden content, closed disclosure bodies, disabled controls and negative tab stops are skipped; native summaries and media controls participate when keyboard focusable. Media and embedded-document controls use the browser's internal keyboard traversal, then focus guards wrap at the actual boundaries. Escape dismisses only the topmost dialog; Settings never changes reader history. Closing content becomes inert and hidden from accessibility immediately, then truly hidden after the exit transition. Focus returns to the connected launcher or its current equivalent; without one, it returns to the underlying reader or the visible Aside chooser link. Search and date-picker popovers close before a modal opens, and global shortcuts respect modality.
- Project/action links inside the document navigate the filter (closing the reader); artifact and raw-file links swap the reader content while preserving the timeline scope.
- An artifact document uses the same file reader: its display name and handle lead the content, followed by associated projects/actions and inline backlinks. Backlinks appear as entity pills with resolved names or attachment filenames; their tooltips retain the full handles. An explicit attachment shows its exact filename and parent artifact link. The artifact page lists the attachments indexed in front matter. Content follows the [file content rule](../design/artifact.md#file-content): an empty body with exactly one attachment uses that file's preview; otherwise the body renders as Markdown.
- A raw-file document shows the file name, its path, the content, and the entries linking to it ("Linked from", with their index descriptions). Images, PDFs, audio, video, and HTML (`.html` / `.htm`, case-insensitive) embed by extension. HTML previews use sandboxed iframes and expand the reader to dashboard width (up to 1200px); narrow viewports retain the full-screen reader. Other files are read as text: binary content is offered as a download; Markdown and extensionless text render as Markdown; other text is shown verbatim.
- Failed document reads show the relevant file diagnostic, full failure reason and Retry inside the reader. Attachment failures retry the selected file rather than its parent record. Retry preserves the route, scroll and readable recovered content, keeps focus within the reader, and discards its UI completion when a newer document, filter or Store supersedes it.
- Connection, panel and reader operation feedback follows [Operation notices](#operation-notices).
- Media and HTML previews check file metadata before embedding, reuse successful checks until a file change, and expose HTTP failures with Retry. Native image/audio/video load and decode errors replace the failed preview with the diagnostic; embedded PDF errors are shown when the browser exposes them. Retry forces fresh metadata and a fresh preview URL without reading media bytes as text, including from the global diagnostic notice. Browser PDF viewers do not reliably report malformed content to the page. Browsers do not reliably expose iframe load failures; HTML previews report metadata failures, without inferring success from an iframe load event.
- Esc steps back one level: reader → summary → unfiltered flow, whose instance summary is the floor — not a filter, nothing left to clear.

### Artifacts and raw files

[Artifacts](../design/artifact.md) open in the existing file reader. Inline handles resolve to display names or exact attachment filenames; labeled links keep their labels, and image references embed their selected file. References work in every Markdown body, including supporting Markdown files, while code stays literal. Artifact front matter and supporting-file front matter do not establish backlinks.

Attachment filenames come from artifact front matter. File contents are fetched only when selected or referenced; the webapp never enumerates attachment directories. User files follow no prescribed directory layout and are read only as needed for a requested preview or reference; see [instance file ownership](../design/instance.md#instance). Relative file links and media sources, including supplied caption tracks, resolve against their containing record and fetch through its instance-scoped daemon file endpoint; prefer artifact handles for stable identity. The daemon serves WebVTT tracks as `text/vtt`.

### Webpage embeds

Markdown bodies accept `<iframe src="https://example.com/page" title="Page" height="600"></iframe>`. Destinations may be explicit HTTP(S) URLs, relative instance file paths, or exact artifact attachment handles (`#artifact/<id>/index.html`). Relative paths resolve against the containing record or supporting Markdown file. Invalid, unresolvable, credential-bearing, protocol-relative, and non-HTTP(S) external destinations are omitted. Code examples remain literal. External pages must allow framing through their own response headers; Aside cannot override that policy.

The renderer rebuilds each frame with `sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, lazy loading, an accessible title, full width, and a default height of 70vh. An authored numeric height is clamped to 100–2000px. Authored sandbox permissions, device permissions, event handlers, style, and `srcdoc` are not retained. HTML file previews use the same sandbox; sources without an addressable file URL use the file text as an app-owned sandboxed source document, which inherits the [application shell's Content Security Policy](../cli/spec.md#web-server) and therefore runs no inline scripts.

Local webpage files participate in catch-up checks. For pages stored in an artifact folder, indexed sibling attachments are checked by metadata too; changing the HTML or a supporting resource refreshes the affected preview while preserving the reader's route and scroll position.

Scripts can render and interact inside their page. Frames have opaque origins and receive no Aside DOM or storage access. Indexed local HTML artifact previews can use the [GraphQL SDK](#iframe-graphql); external pages and other raw files have no query capability. Same-origin-dependent APIs and module loading still follow browser CORS rules. The daemon also sends `Content-Security-Policy: sandbox allow-scripts` for instance HTML and SVG file responses, preserving isolation when a raw file URL is opened directly. Sandboxing does not impose CPU limits or block all outbound network traffic.

### Iframe GraphQL

Importing or replacing an HTML attachment through CLI/MCP trusts the page and its scripts. When previewed, they can read records across the selected instance and send that data externally. No extra trust setting or prompt is required. Use external iframe embeds for untrusted pages; embedding an indexed HTML artifact retains its query access.

Local HTML artifact pages load the standalone classic script `/-/assets/iframe-client.js`:

```html
<script src="/-/assets/iframe-client.js"></script>
<script>
async function load() {
  const result = await aside.query(
    'query Dashboard($limit: Int!) { actions(limit: $limit) { nodes { id name status } totalCount } }',
    { limit: 25 },
    { operationName: 'Dashboard' }
  );
  // Render result.data; inspect result.errors and extensions.complete.
}
load();
</script>
```

`aside.query(query, variables?, {operationName}?)` returns a Promise of the standard GraphQL response, including partial data, errors and extensions. Execution-budget failures abort the query and return errors without partial data. GraphQL errors resolve with the response; transport, connection, input and timeout errors reject. The SDK supports four pending queries and cancels requests after twelve seconds. It requires an Aside preview: opening a raw HTML URL directly supplies no bridge.

The parent grants access only to renderer-registered, indexed HTML attachments served through its selected instance's exact file endpoint. A random one-use fragment token binds the handshake to the frame. The child transfers a private MessagePort to the parent, which verifies its WindowProxy, opaque origin, token and protocol before acknowledging over that port. No capability is transferred back through the frame's WindowProxy. The parent captures the pinned instance address; messages cannot choose another instance or endpoint. Removal, hiding, navigation/reload, sandbox/source changes and instance switching revoke the connection and cancel pending requests. Reopen the preview to reconnect after navigation. The bridge has four pending queries per frame and eight per parent page; external frames, unindexed files and authored source documents receive no connection.

The existing daemon HTTP server accepts `POST /-/api/instances/<id>/graphql` with `{query, variables?, operationName?}`. Bearer authorization, localhost Host, exact-origin and `X-Aside-Control: 1` checks apply; there are no CORS headers. Direct requests from an opaque iframe are rejected. A query uses the exact instance resolved from the route, without an MCP session, mutations, instance discovery, introspection (except `__typename`), automation/runtime access or model discovery. Allowed roots are `entry`, `entries`, `project`, `projects`, `action`, `actions`, `artifact`, and `artifacts`; nested selections are limited to record, reference, attachment and recurrence object types. Validation expands fragments, checks actual fields rather than aliases, and budgets all selections regardless of directives.

Requests are bounded to 64 KiB, one query operation, ten root fields, 200 expanded selections, depth eight, and an estimated cost of 10,000 field visits. Page limits are 1–100, with coerced variables and defaults included in the budget; unpaginated lists are estimated at 100 items. Execution also limits resolved fields to 10,000 and text/serialized responses to 1 MiB. The server allows four active requests per instance, eight globally, and sixty requests per instance per minute. A ten-second deadline and client disconnect abort execution cooperatively; synchronous JavaScript cannot be forcibly interrupted by a timer. HTTP transport errors use status codes; GraphQL validation/execution failures retain their GraphQL response shape.

### Entity display names

Project and action identity includes the entity type and stable ID; the same ID can independently name a project and an action. Name lookup, search, relationships, activity, statistics and change notifications use that complete identity. References display the selected type's current authored `name`, falling back to its ID when the record is unavailable. A rename changes the display label while preserving the creation-derived ID, filename, and references. Hover and details retain the full ID; filtering and URL state use that stable ID.

### Universal search

A search bar at the top. Whitespace-separated terms must all match (AND), case-insensitively, against IDs, display names, index descriptions, cached entry content, or artifact Markdown bodies. Attachment contents are not searched. `project:` / `action:` / `artifact:` / `entry:` prefixes (plurals and `note:` accepted) restrict types; ISO date ranges (`2025-01..2025-06`, either side omittable) restrict creation dates. A date-like untyped query offers a timeline jump.

Results group dates, projects, actions, artifacts, then entries. Exact and prefix matches lead; name matches rank above IDs, descriptions, and body-only matches, with recency breaking ties. Each group is capped and expands through a "+N more" row. Body-only matches show a snippet. Arrow keys select rows, Enter or an ordinary click opens, Esc closes, and `/` focuses search; context and auxiliary presses leave the query and current view intact. Artifact results open the reader; other results filter or jump the timeline. Search state stays outside the URL.

The search input is a combobox controlling a stable, named listbox. Its expanded state follows popup visibility, and its active descendant always identifies a currently rendered option inside that listbox. The keyboard-selected row has an accent background and a solid accent bar at its left edge; pointer hover uses a neutral background. Dismissal clears the active descendant; reopening restores an existing selection. Result groups are named, while loading/empty status and Retry controls sit outside option semantics. Refresh and expansion retain the selected result when it survives. Arrow keys may reopen cached results; Enter activates only a visible popup. Escape cancels a pending query without consuming the existing reader/filter dismissal level when no search popup is visible.

The popup scrolls within the remaining viewport height. On narrow screens it uses the viewport width with side gutters, independently of the search input's width.

### Operation notices

Loading and incomplete-data notices use a compact row: a 16px indicator, a short normal-weight message, optional supporting text, and plain text actions. Loading uses a muted spinner; warnings use amber. Notices sit in the affected surface. Native retry controls share one appearance across loading notices and file diagnostics.

Loading appears only after an operation has remained pending for 200 ms; fast reads never flash a spinner. An instance card shows only a small spinner beside its name, with a screen-reader loading message. The spinner occupies reserved space, keeping the card and surrounding cards stationary. Clicking the same card during loading keeps the current request and spinner unchanged; selecting another card supersedes it. Superseded or closed views cancel their pending indicators. When the first entries are ready, the chooser gives way to the timeline and visible entry cards rise 40 px into place with a short stagger. This entrance respects reduced motion and the animation-speed preference. Ordinary card links still support modifier clicks and opening in another tab. Direct instance URLs keep delayed startup feedback in the reading column until the initial entries are ready. A new selection starts its own note reads immediately; pending reads from the previous selection cannot delay it or replace its content.

Messages name the pending operation: `Loading instance…`, `Loading instances…`, `Loading summary…`, `Loading document…`, or `Loading search text…`. Loading and warnings are polite statuses; actions, details and authored content are not live. Reduced motion freezes the loading indicator.

Connection loss shows a muted offline icon in the header. Its tooltip distinguishes automatic reconnect from a closed connection, and clicking the icon starts a new connection attempt. It disappears on recovery while its reserved slot keeps the header stationary. Existing content remains available throughout reconnect and background refresh.

A failed user action shows one plain-text toast in the lower corner, above an open reader or settings dialog. It is a polite, atomic status, stays visible for four seconds, then dismisses automatically. A new failure replaces the previous toast and starts a fresh four seconds. It never takes focus or intercepts pointer input. Report failures only for the current operation that the user explicitly initiated, including Retry and manual reconnect. Automatic refresh, search indexing, infinite scrolling, startup, agent-driven navigation and SSE reconnect failures do not produce toasts. Superseded or disposed operations cannot report a late failure into the current view.

Recovery remains at the affected control: selecting a failed instance card retries it without expanding the card; summary failures leave a Retry control; unavailable direct instance links offer Retry and Choose an instance. Background summary and reader refresh failures retain readable content. Record failures keep quiet file diagnostics with their full reason and Retry; a failed retry updates the reason without opening Details automatically. Empty-path validation remains beside its field, while registration and removal failures use the action toast.

### Browser authorization

The app follows the daemon's [authorization contract](../design/daemon.md#browser-authorization).
Before loading any private data it verifies the token saved by the automatic
`show` or `showUrl` handoff. Each call prepares a fresh private file; opening it
authorizes the browser and redirects to the requested view, even for a missing or
expired session. API calls and fetch-based SSE carry the bearer token only to this origin.
Media and HTML previews use scoped signed URLs; authored frames never receive the
general token or file-signing key. The existing iframe query bridge remains scoped
to the selected instance.

Missing or expired authorization replaces private content with: **To reconnect,
run aside show or ask your agent to show this in Aside.** It closes streams,
disposes stores and iframe grants, and clears search and catalogue content while
preserving the current URL. A token storage event restores the route after another
show handoff. Network outages retain the separate reconnect/offline behavior.
Bookmarks and normal navigation never refresh the session deadline.

### Agent-driven navigation

Each selected tab subscribes to its instance's `/-/api/instances/<id>/control` stream. A pushed route applies as normal pushState navigation, so Back undoes it. Tabs report focus and a chooser subscribes to global control so the daemon tracks the open tabs. `show` opens its fresh authorization handoff in the default browser; `showUrl` leaves opening to the caller. Neither selects a connected tab for navigation. Connection loss uses the header offline icon; SSE reconnects automatically.

### Instance selection and settings

The daemon is the sole backend. `/` lists registered instances as cards sharing the entry flow's gutter, dividers, hover highlight, and pre-divider side-panel summary (name, description, open/total project and action counts, entries, and updated distance). The gutter uses the existing date/time format and shows the latest managed-data edit, following the [instance summary policy](../design/instance.md#workspace). Unreadable manifests stay hidden until they can be verified again; readable instances remain selectable, including worktrees and duplicate IDs. Selection opens `/<address>/` with pushState and no page reload. The top-left header switcher shows **Choose an instance** while inactive, or the active display name and branch/path disambiguation. Its searchable dropdown always keeps the representative's name and description, with compact worktree branch rows beneath it; name and disambiguation share a baseline. A missing primary uses a stable worktree representative, preserving the worktree's own data and disabled calendar sync. **Add instance** replaces itself with an inline path form. **Browse…** chooses a local folder and fills the path without registering it until **Add instance** is submitted. Enter submits, Escape or **Cancel** closes the form, and empty-path validation remains beside the field. Each card has an accessible **Forget** icon. The tooltip explains that files stay on the Mac and, for a primary, includes registered worktrees in the removal. Duplicate-ID groups appear last and show only an amber warning icon plus the monospace ID, inline with card facts or beneath dropdown descriptions, once per group. A crossed-out calendar icon appears before Forget or at the dropdown's right edge whenever calendar sync is disabled or paused. Hover and keyboard focus explain the reason; card indicators open Settings details without selecting the instance. List failures offer **Retry**. Refresh preserves equivalent keyboard focus; forgetting the focused row moves focus to the next row's Forget control or **Add instance** when the list is empty.

An unavailable deep link shows a Retry button and a link to the chooser; a failed explicit retry produces an action toast. Initial network or file failures do not appear as a successful empty timeline. The header returns to the chooser and switches instances in place. Long names truncate visually when space is limited, retaining their full accessible text and tooltip so Search, Settings and theme controls stay reachable. Browser tabs choose independently of MCP sessions; the daemon syncs eligible primary and independent instances; linked worktrees never sync.

The settings gear controls display preferences (date format, time format, clock, animation, tag expansion); it has no data-source or URL-style override. Settings keeps its header and close control visible and scrolls its body within the viewport at short heights. Display preferences are shared across the origin. Record caches, file/media requests, watches, control, and navigation history are instance scoped.

- Startup loads the instance metadata, manifest, complete year catalogue, indexes, and project/action/artifact files; weekly files load on demand.
- Files are cached in memory and background checks pick up external changes (see Catch-up).
- The app reads records; agents and CLI tools create and edit them through the daemon.

## How To Do It

### Technology

- **TypeScript** — strict types, proper data schemas for all entities
- **Portable core** — `cli/src/core/data-core.ts` owns records and their derived state. The current app uses the daemon core through a structured API; an optional browser module runs that same core against static files. See [data core](../design/record-model.md).
- **Markdown rendering**: marked, sanitized with DOMPurify before insertion into the DOM. Authored `style` elements and attributes are removed. Fenced `mermaid` blocks render as diagrams everywhere Markdown appears (flow, entity/instance details, artifacts, and Markdown assets/attachments). Diagram source remains available in a disclosure; syntax or loading errors leave the source expanded with an inline error and Retry. Diagrams follow the app's light/dark theme and wide diagrams scroll horizontally to keep labels readable. Mermaid and its diagram modules are bundled locally and loaded only when a diagram is mounted. Rendering uses strict security, sanitized SVG/HTML/MathML, distinct SVG IDs for concurrent views, and protected configuration with bounded source/edge counts. Mounted diagrams settle before navigation measurements; stale renders cannot repaint a newer view.
- **File access**: Fetch API against a file server
- **Build**: esbuild bundles TypeScript as ESM with shared production/development options. `app.js` imports local hashed chunks under `/-/assets/`; rebuilds retain prior chunks so open tabs can finish lazy imports.

### Visual design

- **Minimalist and functional** — inspired by Bootstrap/GitHub Primer design language. Clean lines, generous whitespace, readable typography. No decoration for decoration's sake.
- **Markdown rendering** — follows GitHub's markdown CSS (`github-markdown-css`) for all content elements: paragraphs, headings, lists, tables, code blocks, blockquotes, inline code. Three intentional deviations: no `border-bottom` on headings (since `---` rules divide entries), `hr` is hidden, and table columns have a minimum width — a many-column table scrolls horizontally instead of squeezing every column into a wrapped sliver.
- **Dark mode** — user-selectable light/dark theme. Default follows system preference. Toggle in the header. Persist choice in localStorage.
- **Animations** — subtle and purposeful. Every flow re-render plays a FLIP pass keyed by entry id, grounded at the anchor's resolved card. The whole rendered flow is snapshotted, and every card is one of three kinds. A **surviving card**, rendered in both layouts, flies from its actual old position to its actual new one, opaque the whole way (it moved, it isn't new); it is the only kind that spans the unseen region, so its flight distance passes through a soft-knee curve (linear to ~1.25 viewport heights, then compressed asymptotically toward ~2.5) — a far origin enters visibly instead of streaking, an on-screen rest is reached exactly, and speed reads as distance traveled so the eye senses how far it came. An **appearing card** exists only in the new layout and is animated only when it lands on-screen; it enters from the seam where its moment fell in the old layout. A **disappearing card** exists only in the old layout and is animated only when it was on-screen; it exits toward the seam where its moment falls in the new layout — every new card, surviving and appearing alike. A **seam** is a cut in the timeline: the gap between two adjacent cards, or, past the ends, the outer edge where a boundary card (the newest or oldest) borders the unseen. An **in-span card**, its moment between two new cards, crosses the gap: its center line, compared with the seam, picks the direction — it ends fully on the far side, edge flush, so it travels at least half its own height and never rests in place; it tucks behind the card there (matching edge) and clips itself against that card's far edge — pinned in pane space by counter-animating a clip inset against its own transform — so a taller card hides instead of poking past. A **card past a boundary** has no gap to cross; it tracks its boundary card, moving the way that card travels from its own start (its old position, or the old-layout seam it appears from) to its final spot. When the boundary moves outward — the newest card up, or the oldest down — the tracker flies the system's full reach (FLY_MAX viewport heights) from its own spot, clean off that timeline edge into the void — farther than any surviving card, whose distance the soft-knee holds strictly under FLY_MAX, so it always reads as the fastest thing on screen and its ease-out tail lands off-screen, never braking at the edge. When the boundary moves inward, or — only a surviving boundary can — holds still, the tracker folds in behind it, tucking into the boundary seam as the timeline concentrates into its edge; an appearing boundary always moves, so a still boundary is only ever a survivor that stayed put. Which edge a tracker exits is set by its side in time, not where it sits on screen. An in-span reveal fans out of the collapsed seam it was hidden in; an in-span tuck collapses back into it; a boundary tracker rides its boundary card clean off the pane edge. Departures and arrivals stay exact mirrors — the boundary travel that flies a ghost off the edge one way flies it back in from off the edge the other — so a disappearance and its reverse reveal retrace each other by construction. Opacity is uniform: every arrival starts transparent and fades in over its first third, every departure fades out to transparent over its last third — whatever their path, on-screen or past the pane edge. Depth is fixed: survivors paint above arrivals, arrivals above departures, so the arriving (newly-focused) content comes forward. The first frame still reads as the old view because the arrivals leading on top are transparent then — the departures beneath show through until the arrivals materialize over them; by the end the departures have faded out. Every card in flight paints an opaque pane-colored surface spanning its timeline gutter too, so covering actually hides — body and date alike. Cards fanning out of or collapsing into one seam stack shortest-flight-on-top, reading as cards pulling out from under one another. One rule, every read: revealed entries unfold out of the seam where they were hidden, removed entries collapse into the seam that absorbs them — or, past a boundary, ride its card off the edge as the timeline shifts — and a lens switch onto a different moment sweeps the whole view toward the new anchor's place in time. All slides share one duration and easing, scaled together by an **animation speed** setting (Off / Fast / Normal / Slow, persisted in localStorage; unsupported persisted values normalize to Normal) that multiplies the base transition durations across the CSS variables, the FLIP slide, and the JS cleanup timers alike; Off collapses every transition to zero, reading the same as `prefers-reduced-motion`. Margin furniture (times, markers, seams) rides its card, and the readout swaps at the start of the transition rather than rolling with it. The readout is held for the whole rebuild and recomputed exactly once, on settled geometry — never against the partial markers a progressive week load appends or the stepped scroll a restore applies, which would flicker the date through wrong values — so a re-render shows one clean swap from the old date to the new. A navigation landing mid-flight snapshots the cards where they visually are — the next transition starts from there — and the previous transition's departures are dropped. Transform, opacity, and clip only — no layout work during the animation. Renders with nothing to snapshot (first load, an emptied view) read from the top with no motion. Side panel slides in. Under `prefers-reduced-motion` all motion is off — the FLIP pass is skipped and CSS transition durations drop to zero. No gratuitous motion, but transitions should feel polished. The full transition model — principle rules, per-kind start/end geometry, void and compression handling, the animate table, and known issues — is in [animation.md](animation.md).
- **Typography** — system font stack. Monospace for timestamps and entity names. Clear hierarchy with font weight and size, not color. The type scale is font-size/line-height pairs with whole-pixel line boxes (14/20, 12/16, 16/24, …): fractional line strides would make text lines rasterize differently when a re-render shifts a card by a sub-pixel offset, so every stride stays integral.

### Architecture

```
┌─────────────────────────────────────────────────┐
│                    Browser                       │
│                                                  │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  Search   │  │  Entry Flow  │  │ Side Panel│  │
│  └──────────┘  │  (scrollable) │  │ (entity   │  │
│                │               │  │  detail)  │  │
│                │  ┌─────────┐  │  │           │  │
│                │  │ Entry   │  │  │           │  │
│                │  │ [tags]  │  │  │           │  │
│                │  │ content │  │  │           │  │
│                │  └─────────┘  │  │           │  │
│                │  ┌─────────┐  │  │           │  │
│                │  │ Entry   │  │  │           │  │
│                │  │ ...     │  │  │           │  │
│                │  └─────────┘  │  │           │  │
│                └──────────────┘  └───────────┘  │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │            Presentation cache             │    │
│  │  records │ graph │ diagnostics             │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### Data layer

The browser uses the `StoreView` contract, implemented by `RemoteStore` for the
current daemon app. The portable core and optional static-file adapter are described
in [data core](../design/record-model.md).

- **Startup**: check instance availability, fetch one structured snapshot with manifest/body, indexes, records, graph, week selection and diagnostics, then recheck identity. Record failures remain visible alongside readable records; a failed snapshot request is a connection failure.
- **Scroll and search**: render cached parsed weeks progressively. The daemon's complete corpus is available for search without fetching weekly record files in the browser.
- **Relations**: decode the daemon's graph and filtered week lists. Record parsing and graph derivation run in the daemon core.
- **Files**: background checks use bounded concurrency. Embedded media URLs participate in checks alongside open files. Core diagnostics remain separate from client transport failures, which clear after successful reads or checks. Artifact records resolve by handle; displayed supporting files resolve by root-relative path. Media embed by URL; other files are fetched as text or offered for download. HEAD validators and revised URLs refresh media without reading binary contents as text.

### Clock-driven presentation

Time-derived labels, status marks, timeline distances/future styling/windows and
the now indicator repaint from cached records at minute boundaries, independently
of file changes. Returning to a visible/focused tab paints the latest state once;
local-day and browser-zone changes refresh dates and scheduling annotations.
Presentation patches retain surviving controls, selection, reading anchors,
expanded sections and media. Newly revealed folded rows use current options.
When a clock repaint exhausts a focused earlier/later fold, focus moves to its
first newly revealed action before the fold hides; focus elsewhere stays put.
Changed labels/marks crossfade with the shared animation durations and speed;
the now tick moves briefly between nearby visible positions. Unchanged values
stay still. Off/reduced motion applies immediately; transient copies are inert
and accessibility-hidden, and clock ticks are not live-region announcements.

### Catch-up

The data root can change at any time — entries edited, moved, or deleted; entities added, renamed, or removed — and the app converges on the new truth without a reload. Checks never block viewing: every read is served from the cache as it stands, and a check applies its findings between renders.

- **Versioned reads**: the structured snapshot has a content-derived ETag. A conditional request returns 304 when unchanged. A failed request preserves the displayed snapshot. Supporting files retain their own ETag, Last-Modified or content-hash validators.
- **Checks**: a light check asks for the latest core snapshot and revalidates displayed supporting files. A full check also rebuilds the daemon core from disk and revalidates all cached supporting files. Pushed paths request a rebuild to avoid racing the daemon watcher's debounce. One check runs at a time.
- **Triggers**: a light check on focus and every 60s while visible; every tenth check is full. Instance-scoped SSE coalesces changed paths into immediate checks. Polling remains the fallback. The optional static-file core retains per-file light/full checks and a slower full cadence for servers without validators.
- **Apply**: stage the snapshot and file changes, then install them synchronously when the app is quiet. The graph and week lists arrive already derived. Re-render affected flow, panel, reader and search surfaces while preserving reading anchors and focus. An older staged snapshot cannot replace a newer Retry result.

Consistency: eventual, with staleness bounded by the check cadence; reads never wait on a check; each check's findings land atomically. There is no cross-file snapshot — a check can catch the writer mid-update — but every such state renders conservatively (a missing entity shows its id, a missing week is empty) and the next check repairs it.

### Parsing

The data core uses the shared parsers in `cli/src/core/parser.ts` for weekly files, entity records, indexes and manifests. The current browser receives their results and diagnostics over HTTP. Parsers return `ParseResult<T>` — a best-effort value plus a list of issues. The store keeps usable recovered content and retains issues by source file.

A muted, expandable notice names affected files, fields and parser reasons and explains agent validation and repair. Weekly issues appear at their chronological slot alongside recovered entries; record-reader issues appear with that document. Manifest and index problems stay visible even when recovery produces no rows, so partial data cannot count as a verified empty instance or complete search corpus.

Retry asks the daemon to reload records, or rereads a displayed supporting file. Corrected reloads clear its diagnostics; failed retries preserve recovered content. Weekly Retry keeps keyboard focus on its visible summary while loading, then on a replacement Retry or the recovered entry's time link; an empty slot falls back to the Aside chooser link. Focus intentionally moved elsewhere during loading stays there. Catch-up applies parse diagnostics with the matching staged contents. The End remains the unfiltered history terminator even when earlier slots need attention.

### Entry flow rendering

Each entry in the flow renders as a card:
- **Margin**: the entry's time (and the day marker on a day's first entry) in the timeline margin
- **Header**: project tags as colored pills, action tags as pills
- **Body**: rendered markdown content with inline mentions converted to clickable links and asset links opening in the reader
- **Metadata bar**: entry references, if any

Infinite scroll — load more weekly files as the user scrolls down. The unfiltered timeline closes with a muted "The End" marker once fully loaded; a filtered view is an excerpt, so it just stops.

### Entity tags

Tags are color-coded pills:
- Projects: one color family (e.g., blue tones, each project gets a consistent shade)
- Actions: another color family (e.g., green tones)
- Entry references: neutral/grey
- Project and action pills carry their lifecycle status marks (see Entity tags under What It Should Be)

Clicking a tag:
1. Opens the entity in the side panel
2. Filters the entry flow to show only entries referencing that entity
3. Opens the side panel with the entity summary

### Side panel

- An absolutely positioned overlay at the layout's right edge — it never reserves layout space, so the flow never reflows
- Both panes use `overscroll-behavior-y: contain`: the panel body scrolls in isolation (reaching its end never scrolls the flow behind it), and the flow pane keeps edge-started vertical gestures latched to itself so it rubber-bands consistently — the horizontal axis stays `auto` so the browser's swipe back/forward navigation works anywhere on the page
- Shows the scope summary: status pills, index description, updated line, related entities
- Width lives in the `--side-panel-width` CSS variable, set by the drag handle and saved to localStorage
- The title opens the scope's record in the reader, its trailing open-arrow the affordance
- Retract button swaps the panel for the docked filter pill; the pill re-renders on every filter change
- Close button returns to the unfiltered flow

### Search

- Debounced input over the year indexes, the display-name caches, cached entry bodies, and artifact bodies; `search.ts` parses the query and ranks, `search-ui.ts` renders the dropdown
- Query syntax and result behavior per "Universal search": AND-ed terms, type prefixes, `A..B` date ranges, loose date detection, grouped capped ranked results, keyboard navigation

### URL state

The URL carries the complete view state — filter plus open document — so browser back/forward walks the user's whole navigation trail and any view is shareable and restorable on cold load:

- `/` — chooser
- `/<instance>/` — unfiltered flow
- `/<instance>/<entry-id>` — flow scrolled to that entry (jump)
- `/<instance>/project/2026-05-01-website-redesign` — project summary + filtered flow
- `/<instance>/project/<id>/detail` — …with its detail (the complete record) open in the reader
- `/<instance>/project/<id>/asset/<path>` — …with an asset open in the reader
- `/<instance>/project/<id>/<entry-id>` — …scrolled to an entry within the filtered flow
- `/<instance>/action/<id>`, `/<instance>/action/<id>/detail`, `/<instance>/action/<id>/asset/<path>` — same for actions
- `/<instance>/entry/2026-05-02T14:30` — entry detail page (single-entry flow + full content in the panel)
- `/<instance>/asset/<path>` — raw-file reader over the unfiltered flow
- `/<instance>/artifact/<id>[/<filename>]` — artifact or attachment in the reader
- `/<instance>/project/<id>/artifact/<artifact-id>[/<filename>]` — artifact reader preserving project scope; actions and entry detail pages use the same shape
- `/<instance>/detail` — instance detail (the manifest record) over the unfiltered flow

The first path segment is the stable, hostname-safe instance ID; global routes live under `/-/` and cannot collide with instance names. Every navigation writes a path URL and preserves its instance. Browser Back and Forward restore both instance choice and view state; cold links use the daemon's shell fallback.

A delayed entry or date jump only applies while its originating Store and navigation request remain current; newer view, history or instance changes discard the old completion before it changes the URL, reader, filter, scroll or focus. History traversal supersedes pending navigation even when its destination has the same URL with different saved view state; a duplicate location event does not repeat that traversal.

IDs and attachment filenames are percent-encoded as single segments and raw-file paths per segment, with two characters kept raw where the encoding isn't needed: `:` (legal in a path segment, so entry-id timestamps read verbatim) and asset-path slashes (some servers reject `%2F` in a request path; unambiguous because an asset path is always the route's tail). Unrecognized routes fall back to the plain flow.

### File structure

```
webapp/
  spec.md              # this file
  dev.md               # development log
  index.html           # single page
  dev-server.mjs       # esbuild watch + daemon-backed serve for this shell
  style.css            # stylesheet source, built to dist/style.css
  src/
    app.ts             # application entry point: state, instance connection, navigation, flow rebuild, panel + reader content
    route.ts           # URL route <-> view-state mapping (DOM-free)
    dates.ts           # date parsing + calendar arithmetic for the jump control (DOM-free)
    hierarchy.ts       # related_projects graph -> hierarchy tree / instance forest (DOM-free)
    entity-reference.ts # entity handles and inline mentions in text (DOM-free)
    entity-relations.ts # typed entity assets and entry statistics
    instance.ts        # instance summary derivations: action grouping, timeline window, activity order (DOM-free)
    panel-data.ts      # the side panel's and reader's derived records: scope summaries, details, action census
    latch.ts           # latched date readout, marker registry, week-seam scrub
    datepicker.ts      # jump-to-date popover (quick navigator, date field, calendar)
    flow-navigation.ts # flow anchors, time cursor, card lookup by moment, jump landing
    week-view.ts       # one week's flow slot: load, retry, failure state
    flip.ts            # flow-transition FLIP pass (see animation.md)
    display.ts         # live display refresh (names, times, status marks) preserving the reading position
    clock.ts           # minute clock driving the live display refresh
    diagrams.ts        # Mermaid rendering and theme refresh
    diagnostics.ts     # file diagnostic notice with retry
    document-path.ts   # the record file behind a reader document
    onboarding.ts      # empty-flow states and starter prompt
    side-panel.ts      # side panel chrome: show/hide, docked filter pill, history restores, focus
    panel-resize.ts    # side panel width: bounds, persistence, resize handle
    ref-hover.ts       # co-highlighting every reference to the hovered entity
    modal.ts           # dialogs: focus trap, open/close transitions, usable-focus test
    preferences.ts     # persisted preference parsing (animation speed)
    refresh.ts         # catch-up scheduling: focus/periodic checks, quiet apply
    control.ts         # instance-scoped tab control (agent navigation)
    backend.ts         # daemon catalogue and instance data source
    instance-chooser.ts # catalogue UI, registration, removal, and focus refresh
    notice.ts          # delayed loading and incomplete-data notices
    toast.ts           # auto-dismissed user-action failures
    render.ts          # DOM rendering
    search.ts          # query parsing, matching, ranking, highlighting (DOM-free)
    search-ui.ts       # search dropdown: debounce, grouped + capped results, keyboard navigation
    search-label.ts    # entry result names that keep the id match visible
    search-progress.ts # re-running an open search as searchable contents arrive
  lib/
    types.ts           # webapp-side types and date helpers; re-exports cli/src/core schemas
    remote-store.ts    # structured snapshot presentation cache
    static-store.ts    # optional browser core over a static file host
    store.ts           # portable core compatibility export
    io.ts              # static URL adapter compatibility export
```

`cli/src/core` owns the portable [data core](../design/record-model.md). `lib/remote-store.ts` decodes daemon snapshots and stages presentation updates; `lib/types.ts` supplies record exports and media display helpers. `src/` owns browser rendering and UI. `dist/static-data.js` is a separate optional module and is not imported by the daemon app.

## Test Plan

### Library tests (automated, Node)

Run with vitest against self-contained fixtures. No browser needed.

- **Parsers**: weekly files, project files, action files, indexes — correct fields, edge cases (missing optional fields, no projects, inline mentions)
- **Types**: parsed entities conform to schemas, display names remain independent of stable IDs
- **Dates**: local-time Monday derivation; loose date-input parsing (ISO, US, spelled-out, year-less inference); period shifts clamp to the month end
- **Store**: manifest loading, index loading, weekly file caching, query by project/action/date range, weekly filename derivation, action name scanning from entries
- **Catch-up**: revalidation tiers (ETag / Last-Modified / content hash), index diffing for added and removed entries and entities, pushed-path routing (weekly file / entity / asset), deletion handling, derived-state rebuild on change, a failed check never evicts
- **Relations**: co-occurrence, entries per entity, asset links per entity and per entry, explicit related-projects in both directions, the project hierarchy tree (ancestor paths, descendant subtree, diamonds and cycles) and the instance forest (loners as roots, shared children once, cycle sweep), raw asset reads
- **Instance**: the reference status derivation (resolution first, then scheduled, else backlog — a deadline never regroups; a project open until ended), the chip marks (a deadline rings, escalating to overdue once breached — a date-only deadline at its day's end; no time ahead on the calendar waits, the mark keeping its cause — backlog when unscheduled, slipped when a schedule lapsed, the event's end at scheduled plus duration; deadline and waiting compose; a resolution stands alone), the status pills (deadline and calendar independent, each pill its own state; Due escalating to Overdue, Scheduled to Slipped, Backlog when never scheduled; the slipped clock on the Slipped pill, the empty slot on the Backlog; the no-calendar exception only beside a live schedule; a resolution alone; Open/Ended for projects; a stamped pill's hover — the deadline, the scheduled time with timezone and duration riding it, a resolution's scheduled stamp, Open/Ended's created/ended; Backlog and the exception hoverless), open-action grouping (each open action filed under its status, scheduled soonest first, backlog stalest first), the timeline window (the week ahead taken inclusively, the minimum either side of now, edge collapse both ways), activity ordering (entry-less items keep index order at the tail), relative dates (one compact rounded unit of days/weeks/months/years, "in" ahead, month boundaries), backlog last-update stamps (latest entry, else created)
- **Paths**: relative link resolution against the containing file — `../` traversal, root escapes rejected, schemes/absolute/fragment links ignored
- **Routes**: every view-state shape round-trips; the route is read from path or fragment; malformed routes parse as the plain flow
- **Search**: matching across display name, id, description, and cached content; AND-ed terms; type prefixes; date ranges (open-ended included); date-jump detection; ranking (exact and prefix boosts, field weights, reverse-chron ties); content snippets; highlight term marking

### Browser tests

Serve a local instance and test the UI.

- **Instance discovery**: chooser includes unloaded registered directories, folder browsing and typed folder/manifest paths, inline validation, silent cancellation, automatic refresh on return, canonical deduplication, card hover/focus, and icon forgetting by path (including duplicate IDs) without deleting files
- **Served by daemon**: instance-scoped data, media, SSE, and navigation; failures have Retry and chooser recovery; a control event applies as pushState navigation (Back undoes it)
- **Entry flow**: reverse chronological, infinite scroll, rendered markdown, native reference links, date markers at day/month/year boundaries with the latched readout tracking scroll
- **Navigation controls**: keyboard focus and activation, native modifier/new-tab links, expansion button names/state, and focus retained across reveals
- **Filtering**: tag click filters flow and scrolls to top, panel × clears, back button restores state
- **Side panel**: project/action summary rendering (status pills with their hover stamps, description, the facts line closing the header — stats with zero counts shown, updated trailing — the scope's related sections — a project's scoped Scheduled/Backlog and plain related-project rows, an action's plain project rows, assets on the rail on both), typed title icon, close button, drag resize (width persists), retract to the filter pill (pill shows the entity, updates on filter change, expands on click, clears on ×)
- **Instance panel**: the unfiltered flow summarizes the instance (manifest name, description, facts line, open projects by recent activity, open actions grouped scheduled / backlog, the linked assets by recency, projects and assets reverse-chron and the action sections chronological (backlog stalest first) on a timeline rail with dates marked where they change, the now tick, the dated section expanding from both ends, plain folds revealing in batches) with no close button; clearing a filter returns to it; `/detail` opens the manifest record with the foldable census (project forest, actions by state, stats); retracted, the pill shows the instance name without a ×
- **Entry jump**: entry references push `/<id>` and scroll the flow to the entry with a highlight flash, loading older weeks as needed; project/action filters persist when they contain the target, entry detail pages always exit to the timeline
- **Entry detail page**: `/entry/<id>` deep link renders the single-entry flow + panel content
- **Document reader**: the title's open-arrow, artifact handles, and raw-file links open it (the arrow absent on the entry detail page), ×/Esc/back close it, deep-linked detail/file/artifact routes restore on cold load, the flow never moves while it opens or closes, a project detail shows the hierarchy tree with clickable rows, its action census, and stats; an action detail its stats
- **Artifacts**: names and handles, indexed attachments, implicit file content, empty bodies, images, sandboxed HTML pages and Markdown iframe embeds, generic downloads, inline backlinks, literal code, and live body/attachment/media changes
- **Date smart elements**: ISO date/time/offset, bracketed named zones and interval validation, daylight-saving transitions, bare handles in natural prose, literal code/escapes and ordinary links, browser-zone conversion, live date/time-style and clock updates, copy handles, native date routes, reader dismissal, and history navigation
- **Search**: grouped capped results with "+N more" expansion, arrow/Enter keyboard selection, navigation to project/action/artifact/date/entry
- **Dark mode**: toggle, system preference default, persistence
- **Display names**: authored names, renames preserving reference IDs and URLs, unavailable-record ID fallback, hover retaining the full ID

### UI change validation (required)

All UI changes must be verified visually using browser tooling before being considered complete. The workflow:

1. Build `cli/` with `npm run build`, then run `npm run dev -- --dir <instance-directory>` in `webapp/` (shell watch build with the daemon backend).
2. Run `aside show` to authorize the browser, then open the instance URL printed by `aside show --url`, or `http://localhost:24800/` for the chooser. Tests may use isolated daemon state and a browser profile.
3. Take screenshots before and after the change
4. Exercise the affected feature — click, scroll, resize — and screenshot each state
5. Confirm the change works as intended and does not regress other visible features

Do not claim a UI change is complete without browser screenshots showing the result.

### Integration test

End-to-end against a local instance: load app → verify entry count matches the instance → filter by project → verify count matches validation script → search for a known term → verify matches grep → open action in side panel → verify fields match file. Scriptable through browser tooling.

### Phase 1: Core flow
- Set up HTML shell with three-column layout (search, flow, side panel)
- Implement data view: load a structured daemon snapshot and render cached weeks progressively
- Render entry flow with week grouping and infinite scroll
- Parse and render entry metadata as plain text tags

### Phase 2: Entity resolution
- Make all tags clickable
- Implement side panel with entity detail rendering
- Read cached entity records on click
- Filter entry flow when a tag is selected

### Phase 3: Search
- Implement search over indexes (project names, action names, entry summaries)
- Add date matching
- Add full-text search over cached entries
- Render search results grouped by type

### Phase 4: Polish
- Color-coded tag pills
- URL state management
- Responsive layout
- Keyboard shortcuts (/ for search, Esc to close side panel). Settings → Keyboard can disable the single-character search shortcut; the choice persists. The shortcut does not intercept editable controls, text composition, or Ctrl/Meta/Alt combinations.
- Service worker for offline support

### Action schedule clocks

Timed action schedules with a named `timezone` resolve to an actual instant;
omitting the zone keeps their clocks floating. All-day schedules remain local
dates. Schedule distances, elapsed ends, slipped marks, chronological order,
windows, future rail color, and the now tick compare actual instants against one
render-time `Date`. Supported fixed durations share the calendar contract,
including whole-minute seconds forms and 24 elapsed hours for `P1D` across DST.

The browser displays scheduling times in its local zone. A named schedule always
also shows the authored clock and named zone, even when it matches the browser;
a cross-day conversion includes the original date, using the configured clock
format. Summaries, timeline rows, and detail fields keep this annotation visible.
Floating clocks show their authored value without a zone annotation. Other
record timestamps and deadline clocks keep their existing floating semantics.

Malformed schedules and unresolved named-zone clocks display an unavailable-time
label, retaining the authored clock without a numeric countdown. Valid floating
clocks use the browser-local resolved instant for calculations, including DST
gaps, while retaining the recorded display value until Calendar readback
reconciles any [accepted normalization](../design/calendar.md).


### Retryable history gaps

Weekly traversal and successful core reads are separate. A file read failure leaves a
compact, muted notice at that week's chronological position, with the week,
expandable error details and Retry. Older weeks continue loading; the unfiltered
bottom still reads “The End”. A genuinely absent week is normal empty history.
Retry coalesces repeated requests, repairs only its slot and preserves the reading
anchor and existing card content. Source/navigation generations discard stale
results. Date navigation does not substitute an unrelated card across a failed
gap or claim an unknown oldest bound; exact entry references require their ID.



### Search completeness

Daemon snapshots include the readable search corpus. A static-file core warms
record bodies lazily; search keeps current matches available and shows muted
progress while that corpus warms. It reruns the same active query as searchable content
arrives and warming finishes, preserving the selected result by identity and
expanded groups. Progress never reopens dismissed results or steals focus.
“No results” is final only for a complete corpus. Load or parse failures leave
an incomplete-search explanation and Retry; successful caches stay available
while failed or corrected files are reread. Corpus events and pending refreshes
are scoped to the current instance and unchanged query.
Completeness and search Retry cover searchable records, their indexes and the
manifest. Supporting attachment reads and diagnostics remain in their reader
and the global notice, without marking the search corpus incomplete.

### Date and time display preferences

Date and time formatting uses the browser's preferred locale automatically and
keeps the Gregorian calendar. Settings offers Date format (Short, Medium, Long,
Full, ISO), Time format (Short, Medium, Long, Full), and Clock (12-hour,
24-hour). Defaults are Medium date, Short time, and the locale's preferred
clock, selected directly in the control; persisted 12/24-hour choices remain
selected. ISO fixes only the date portion to `YYYY-MM-DD`, independently of
the time style and clock choice.
Options show only their names; a combined localized date-time preview updates
with the controls. Preferences persist across reloads and instances on the origin.

Detailed timestamps and date smart elements use the chosen styles. Time styles
control seconds and zone-name detail; a date-only value never gains a clock.
Timeline clocks use the selected time style. Compact markers show changed
date units; the latched readout shows the complete date. When the date and clock
need more than 220 pixels, or on narrow screens,
every entry shows a complete date-time label above its content with consistent
styling; a separate calendar button opens the date picker. Otherwise, the gutter
grows from its base width to fit the labels. Calendar labels use the browser
locale. Instance chooser dates, clocks and hover timestamps use the
configured styles, retaining file-edit seconds. Long timestamp styles use a row
above the instance name; other styles use the timeline gutter. Rows grow to fit
longer labels. Floating clocks and date-only values retain their calendar fields;
resolved instants display in the browser timezone. Authored offsets, zones and
fractional precision remain available in smart-element hover and copied handles.
Malformed calendar values remain verbatim rather than overflowing into another
date.

Changing date format, time style, or clock repaints existing interface
timestamps immediately, including entry handles and generated reference names,
markers and the readout, reader titles and date fields, recurrence starts and
original occurrences, action schedule annotations and status tooltips, the
collapsed scope, calendar labels, week-failure headings/retry labels, and visible
search date/entry result names. Existing readers, folds, focus, media, scroll
position and search selection remain in place. Authored Markdown link labels
and prose, record IDs and routes retain their content. Raw source values remain
verbatim in ID fields, exact-ID search-match fallbacks, handles and their source
hover text, machine attributes, recurrence rules, diagnostic details/file paths,
and date-entry input syntax. Relative ages and countdowns remain relative distances.
