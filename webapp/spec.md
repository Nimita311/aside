# Web App

A browser application for visualizing the productivity data framework. The daemon serves the app and its instance-scoped records from one localhost backend. Rendering and display derivations run in the browser.

Production and watch builds emit shell scripts, styles, and their assets into `dist/`. `style.css` is an ordinary build entry, served at `/-/assets/style.css`. All public asset URLs resolve under `dist/` according to the [asset boundary](../cli/spec.md#web-server).

## What It Should Be

### Core experience

The entry flow is the primary experience. These abilities work for every instance without an agent preparing a custom view:

- **Catch up:** read recently captured entries in a continuous, reverse-chronological flow.
- **Recall context:** follow project/action pills, search the flow, and navigate by date while keeping a stable reading position.
- **Review work:** inspect schedules, deadlines, overdue items, and undated actions, then follow their supporting context.
- **Read the current understanding:** open instance, project, and action bodies with their metadata, relationships, and supporting records.

The normal loop is reading entries, following a pill, finding relevant history, opening a record, and returning to the flow. Pinning and custom pages support this loop.

Search is available through the active Navigation panel or Control pill. It supports global lookup and quick search within the current entry flow; their interaction follows [Universal search](#universal-search).

### View types

| Type | Source | Presentation |
| --- | --- | --- |
| Entries | A paginated entry query | The primary entry flow |
| Actions | An action query | An action timeline with an explicit date axis |
| Record page | An instance, project, or action handle | Its body, metadata, and related context |
| HTML page | An HTML artifact or attachment handle | Full viewport, with the Control pill and both panels retracted |

Scope is separate from type. Project entries are an entry flow with a project pill filter; the project's body is a record page. Entry and action timelines remain separate.

### Frame and sidebar

The app has four named components:

| Component | Role |
| --- | --- |
| **Reader** | The single active main landmark: entry flow, action view, record body, or HTML page. |
| **Navigation panel** | The left index of instance context, core views, and pinned shortcuts, with search, applied filters, and additional commands. |
| **Context panel** | The right summary of the current flow's selected project or action, or the selected instance when no entity pill filter is active, including metadata and related content. |
| **Control pill** | A complete compact control interface centered at the bottom when Navigation is retracted, and for every full-page HTML view. |

Content fills the Reader. There is no persistent app header or added content-title bar. Entry and action flows identify themselves through their distinctive presentation; record bodies through their own title and metadata; HTML through its authored presentation. Entries remain articles in a continuous flow with the existing date gutter, typography, and whitespace. Native record pages retain the same readable prose measure. The active location remains available in Navigation or the pill's view picker.

The Reader's width and horizontal position depend on the available viewport and content type. Panels occupy spare margins beside it; their appearance, disappearance, or changing summary never shifts or squeezes the reading column. Reading anchors remain stable through responsive transitions. Navigation and Context are plain side panels; the compact pill has a restrained glass treatment with readable contrast and an opaque fallback.

In an unfiltered flow, Context retains the existing instance summary, including its statistics and project/open-work context. A project/action pill filter selects that entity's summary; clearing it restores the instance summary. A query or quick-search phrase alone does not replace the instance summary with an entity summary. Changing the summary preserves the Reader's position.

Each instance has:

- **Browse:** permanent Entries and Overview destinations; the Actions experience is deferred. Entries is the default home. Overview opens the instance body and native project/open-work context.
- **Pinned shortcuts:** explicit, optionally titled sections of timeline states and entity/content pages, including full-page HTML.

Native Browse remains usable with no pins or custom pages. The index lists Aside data and views. Instance selection, pins, and remembered browsing state stay instance scoped. The same destinations and active-state matching are available in both control interfaces.

### Automatic panels and responsive layout

Layout follows the available CSS viewport, including browser resizing and zoom. Panel fit and the maximum workspace width are separate rules; device names and physical display resolution do not determine behavior.

- Both panels expand automatically when their minimum widths fit beside the Reader and stay expanded while that space is available. Their widths shrink with the spare margins, down to the same **280px minimum**. They retract at the same viewport threshold and return automatically when space is restored. A loaded flow always has a Context target: its active project/action focus or the instance by default.
- The fit threshold is the native Reader's layout footprint plus two minimum-width panels. For the current entry/action flow footprint, `960px + 2 × 280px = 1520px`; a record footprint of 910px fits at 1470px. These footprints include gutter and padding. Panel widths grow to 360px as space allows. Both sides use the same fit calculation even when Context is absent.
- Panel placement is fully automatic. There are no manual resize handles, minimize/expand buttons, edge tabs, panel drawers, or remembered open/closed preferences. Entity focus selects the project/action summary, and clearing it returns to the instance summary; neither operation forces a retracted panel open.
- Native views use a centered workspace capped at **1920 CSS px**, independent of the root font size. A 1920px viewport retains the normal desktop layout. Beyond the cap, outer margins grow while the Reader and panels remain together; exposed panel edges have restrained rounded corners, subtle borders, soft shadows, and breathing room. This is a workspace design limit, not an ultra-wide device breakpoint.
- Resizing changes presentation only. It does not change the view, source, filters, sort, pins, URL, or history. Preserve scroll anchors, search drafts, and equivalent keyboard focus when the control interface changes. Retracted panels are inert and excluded from accessibility navigation.
- Full-page HTML bypasses the native workspace cap and panel-fit calculation. It always occupies the full app viewport with both panels retracted and the Control pill visible, at every width.

### Control pill

Navigation and the Control pill are alternative complete interfaces for the same browsing state. Only one is visible at a time. The pill remains visible while scrolling whenever it is the active interface. It stays horizontally centered, sizes to its contents, and fits within viewport gutters and the bottom safe area. Native Reader content has enough bottom scroll clearance to pass above it.

The pill's first level contains a **view picker**, **applied filters**, **Search**, and **More**. Instance and current-page context live in its view picker. Filters retain their independent clear controls, including the quoted literal search phrase. Deeper controls stay in More: pin/unpin, sort, read-only View details, display settings, and miscellaneous information. The Navigation panel keeps the corresponding controls together in its footer below the index.

The pill has its own UI: the view picker opens a compact list of core views and pins above it; Search opens its own search surface; More and View details open compact menus or subviews. When Context is retracted, **More → Summary** opens the current flow's summary and related links in the pill's own details popover: the instance by default, or the active project/action focus. An active entity filter label also opens its summary. The instance default does not add a filter chip. None of these interactions summons a side panel. Full-page HTML retains the pill's navigation controls, including instance switching and returning to native views.

Only one pill popover is open at a time. It fits the remaining viewport height, scrolls its contents when needed, and dismisses on Escape, explicit close, or outside activation. Keyboard focus enters the opened surface and returns to the surviving launcher or its equivalent on dismissal; background content is inactive while the popover is open. Switching between panel and pill interfaces preserves the current state and search draft, transfers focus when necessary, and leaves no hidden popup or duplicate control surface active.

### Entry browsing state

The live entry flow combines independent browsing conditions:

`entries = agent query AND one project/action pill filter AND quick search AND date range`

The agent query is optional; the default source is all entries.

- At most one project **or** action pill filter is active. Clicking another entity pill in content replaces it, including across types. Clicking the active entity pill in content again, or the filter's ×, clears it. The active filter label in the control interface exposes its summary; **Open details** opens the record body.
- Pill clicks within the entry flow preserve its query and search. From another surface, a pill opens the default entry flow focused on that entity.
- Quick search is one case-insensitive literal phrase matched against entry IDs, index descriptions, and bodies across history. Applying another phrase replaces it. A removable `“<term>”` chip in the active control interface's filter group opens the phrase for editing; clearing it preserves the project/action filter. It appears only while its flow is active and returns with that flow after reading a document. Applied filters move between the Navigation footer and Control pill as the layout changes. The entry pane retains its existing scroll geometry without an extra filter row.
- The named query, pill, and search are visible and independently removable. Removing one preserves the other two. Restored search text remains visible.
- Choosing the default Entries destination resets the entry browsing state. Sorting changes order without changing membership.

A single-date target jumps through the matching entries. A date-range target applies an independently removable inclusive period filter. The current flow's date controls and query layers remain available together. Date-reference syntax and display follow [Date references](../design/date-reference.md). A date link from a content page returns to its originating entry-flow state when available, otherwise the default entry flow. Date-only targets land on the latest matching entry that day; timed targets land at or before the clock, with existing boundary and unread-week safeguards. If no matching landing is available, retain the filters and offer explicit navigation to the default flow. Calendar-date endpoints include their whole day; timed endpoints retain their instant. Offset and named-zone endpoints convert to the local entry clock for filtering.

### Explicit sidebar and agent-defined timelines

The sidebar declaration lives in the selected instance's `aside.md` frontmatter at `config.webapp.sidebar`. It is an ordered list of sections with an optional `title` and ordered `items`. Each item has an optional `label` and exactly one target: `timeline` or `entity`. There are no section/item IDs, type discriminators, or renderer keys. Core Entries and Overview destinations remain built in, outside this list; the Actions experience is deferred.

```yaml
config:
  webapp:
    sidebar:
      - title: Focus
        items:
          - label: Recent decisions
            timeline: "#artifact/2026-10-12-recent-decisions/decisions.json"
          - label: Aurora entries
            timeline: "#project/2026-10-12-aurora"
          - label: Aurora brief
            entity: "#project/2026-10-12-aurora"
          - label: Dashboard
            entity: "#artifact/2026-10-12-dashboard/index.html"
```

`timeline` uses the existing smart-element parsers: project/action handles focus related entries; a date jumps; a date range filters the period; a literal string applies quick search; an explicit artifact attachment handle supplies a saved GraphQL query. There is no native artifact-backlink timeline filter. `entity` opens the native entity/content target, preserving entity metadata and normal attachment rendering. HTML content fills the actual viewport using the compact pill at every width. The same project handle can therefore filter its entries under `timeline` or open its body under `entity`. New smart elements extend shared navigation rather than a separate sidebar grammar.

Files never register themselves as views. An ordinary query artifact exists independently and appears only when explicitly declared or pinned. Its supporting JSON attachment may have any valid filename. Its definition contains `query`, optional `variables`, optional `operationName`, and optional `result` when more than one eligible entry-page connection exists. `result` is the response path using aliases, such as `context.feed`. There is no mandatory view type, input mapping, or duplicate default/supported-order declaration.

The read-only operation determines record selection and ordering. Schema types identify the timeline renderer even for empty results and aliases; entry-page results can be at the root or under singular parents. Collections under list ancestors cannot represent one paginated timeline and are rejected. Actions remain deferred. The adapter consumes record identities and page/completeness information, hydrates complete native entries, and renders the usual cards. Selected fields do not configure, omit, or customize native card content; extra selections do not change presentation.

Preserve the original grouped `where` expression and add native project/action, literal search, and date-range conditions as AND siblings before pagination. `EntryWhere.browse` retains explicit and inline references and literal ID/description/body search. The adapter supplies pagination and required identity/page selections without changing unrelated query selections. Honor the query's `CREATED_ASC` or `CREATED_DESC` order, including enum literals, variables and defaults. Sort overrides the selected collection's query argument and restarts pagination; it never sorts only the loaded subset. Query-selected order remains the default. Removing the query also removes its order override; the default weekly entry flow keeps its established newest-first order.

The active query has an independently removable chip; its label opens read-only View details showing the operation, effective request variables, and current ordering. Removing it preserves other browsing conditions. Source state names the exact attachment as `?source=<encoded-artifact-attachment-handle>`; search, range and user order are independent URL state and remain available through content pages and history. Missing records, inconsistent pages, incomplete reads and query errors produce retryable notices without silently broadening results. Retry refreshes the snapshot and starts a fresh query session at the reading anchor.

Agents read `activeInstance { settings { webapp { sidebar { title items { label timeline entity } } } } }` and replace the declaration with `updateInstance(input: { settings: { webapp: { sidebar: [...] } } })`. Omitted sidebar preserves it; `[]` clears it. Validate the entire declaration before writing and preserve unrelated frontmatter, settings, and instance body. Existing artifact APIs manage query files independently. Browser Pin/Unpin persists this same declaration through a narrowly scoped authenticated sidebar endpoint. Each browser replacement includes the declaration it was based on; a conflict refreshes and reapplies the original Pin or Unpin intention without overwriting concurrent sections or toggling the intention. The read-only webpage GraphQL boundary remains unchanged.

### Pins

A pin captures the view type, instance-scoped target/source identity and parameters, active pill, search text, and sort order. It bookmarks that state; it does not create a locked destination or a copy of the query definition.

Restoring a pin leaves every browsing interaction available. Subsequent changes affect only the live state. Selecting the pin again restores its captured state. Match sidebar selection against that state, not merely a source or record ID. Unpinning leaves the current surface open.

The app derives a meaningful shortcut name from the target/state; the agent owns custom view names and definitions. Pinning does not require a query or layout editor. User pins append to an untitled section in the same persisted declaration. Simple states use native handles or literal strings; composed flow state uses a canonical `aside://<instance>/<route>` timeline target without authorization or preview parameters. Entity pins identify their content independently of the preceding flow. There is no separate browser-local pin catalogue.

### Navigation and reading position

- **Project/action pills** browse entries using the single active pill filter.
- **Open details** beside the active pill opens that record's body. Explicit record titles and action-timeline titles also open bodies.
- **Instance/project pages** offer Entries and Actions links; an action page offers Related entries. These open the corresponding native timelines.
- **Entry references** retain the existing cross-pill jump behavior. Keep an agent query and quick search; when either excludes the target, offer explicit navigation to the entry in the default flow.
- **Artifact/file links** open their content pages. HTML occupies the full app viewport with app navigation available through the Control pill.

Filtering preserves the engaged entry's reading anchor when it survives, otherwise the nearest surviving moment. Page navigation retains the preceding flow as return context. Back/Forward restore instance, surface, source/parameters, pill, search, sort, and reading position. Pill/source changes, applied or cleared search, and date jumps create history visits. Draft lookup text does not change the flow or history.

Location context in Navigation and the pill's view picker describes semantic scope rather than the route taken or an invented containment tree. A project/action can have several relationships; actual navigation history remains the route back.

### Actions timeline

Actions provide native work review. The default reviews open work; project-scoped and agent-defined action views reuse the same presentation.

The selected sort states its date axis and direction: scheduled, deadline, or created. Missing dates appear under **Undated** in either direction. Scheduled time, deadline urgency, and lifecycle are separate facts. A deadline does not turn backlog into scheduled work or change an action's resolution.

Action titles open action bodies. Pills open entry context, and related-entry links connect the work to its supporting discussion. This experience requires no custom query or dashboard.

### Ownership and inspection

Agents capture/change records, define advanced queries, and author HTML pages. People browse, follow references, navigate dates, pin/unpin, sort, and quick-search. These operations change browsing state rather than agent-owned content or definitions. Existing display preferences remain available in Settings.

**View details** is read-only: type, scope/target, source identity, GraphQL and variables where applicable, and default/current ordering. Native browsing does not expose record-editing forms, a query editor, or a layout builder.

### HTML pages

An agent-authored HTML artifact supplies a specialized presentation, such as a release dashboard, while using the same underlying context. Opening HTML gives it the full app viewport at every screen width, with both panels automatically retracted and the Control pill always available. It bypasses the native workspace cap and prose-width constraint. The authored page controls its internal layout and links back to native entries, records, and artifacts. Its identity remains stable as the agent maintains its content.

The host adds no title, metadata strip, or document wrapper above full-page HTML. Source identity, attachment information, metadata, and related context remain inspectable through the pill. Its own view picker, search, and commands provide everyday browsing, instance navigation, shortcuts, and return history. Returning to a native view restores that view's automatic layout and preceding browsing state. HTML extends the native experience; it is not required to read recent entries, retrieve project history, review work, or understand the current plan.

File isolation, sandboxing, and read-only instance query access retain the [webpage embedding](#webpage-embeds) and [Iframe GraphQL](#iframe-graphql) contracts.

### Empty views and getting started

A successfully loaded instance with a valid manifest, clean indexes and no notes, projects, actions or artifacts shows `The stage is yours.` Its fine print reads: `Ask your agent to capture a note, organize a project, or plan an action. Your records will appear here.` The view identifies the selected instance and canonical directory. `Copy a starter prompt` includes that identity and directory and asks the agent to call the `selectInstance` mutation explicitly: browser and agent selections are independent. If clipboard copying is unavailable, the prompt remains selectable in the view.

`Getting started` reveals concise agent workflow and browser navigation guidance. The browser reads records; the agent captures and changes them. No tutorial records are inserted automatically. A note-less timeline in an instance containing other record types says `No notes yet.` rather than showing whole-instance onboarding. A fully traversed filter with no entries shows `No entries match this filter.` and independent clear actions for the active query, pill, and search. Loading, read failures and parse diagnostics must resolve before any empty-state claim. The unfiltered bottom marker remains `The End`.

### Timeline margin

With compact timestamp styles, a left margin serves as a timeline indicator. Each entry carries its time in the configured time style and clock format; dates live in markers. Every timestamp uses the standard entry pill's text baseline at a fixed offset from the entry border, even when the entry has no pills or starts with a heading, code, or graphic. The first entry in display order of each day carries a marker on that same metadata line — pinned to the gutter's left edge, the time keeping the right — so a day boundary adds no height to the flow. The marker shows only the units that changed at that boundary: the bare day number within a month (`22`), month and day at a month boundary (`Apr 30`), year, month, and day at a year boundary or at the top of the flow (`Dec 31, 2025` with Medium US English dates) — so scanning the margin reads the time span without reading every timestamp. Date units, separators, padding and names follow the selected date style; Full includes the weekday and ISO uses numeric year-month-day. Year, month, day, and any weekday occupy fixed columns (unchanged units leave theirs blank), so dates align down the gutter; day numbers render lighter than month/year names, keeping boundaries prominent.

Weeks — the files' native Mon–Sun grouping — read as seams: on the first entry in display order of each week, the divider above extends left across the gutter, slicing the timeline into weeks at no height cost. Ordinary dividers span only the content column. Approaching the readout, a seam's gutter extension retracts: a soft transparency edge sweeps across it left to right (scrubbed by scroll, reversible), leaving the content-column line to exit under the pane edge like any divider — the seam is wider than the readout's backdrop, so passing behind it would otherwise bite a visible chunk out of the line.

Wide timestamp styles and narrow screens place a complete date-time label above every entry, keeping the reading column wide. Each label includes its date even within the same day and uses the same muted monospace styling. A sticky calendar button beside the timeline opens the date picker without overlaying timestamps; its accessible name and hover show the viewing date. Hidden day markers track that date.

With the compact gutter, a readout latched to the top of the flow pane shows the current date in the selected style (`May 22, 2026` with Medium US English dates), in the markers' unit columns. A weekday appears in the date pattern when the selected style includes it. The readout itself never moves; its solid backdrop is exactly the text row and spans only the date columns, leaving entry times visible as they scroll past. The swap is scrubbed by the scroll itself: the next day's value rides its own marker's real position into the readout — a single visible instance, the chip's copy continuing it seamlessly as the marker passes behind the backdrop — and within a glyph-height of the latched value it makes contact and pushes it up and out, one connected odometer roll. Each changed date unit rolls individually. The roll completes exactly when the marker reaches the readout row; reversing the scroll rewinds it. A day's value is thus always visible somewhere — as its marker, riding, or latched. (Under `prefers-reduced-motion` there is no riding value; the date swaps instantly when the marker touches the chip.) The readout is present from scroll 0 and never shifts position; its position uses the standard metadata line at the Reader's top edge, independent of the first entry's content. The first day renders only in the readout: its in-flow marker is invisible, holding its place in the margin.

The readout doubles as a jump-to-date control: clicking it opens a popover with three parts always visible at once — a quick period navigator, then a rule, then a date-entry field and an inline calendar (the rule marking the navigator and the date selection as two separate ways to jump). The popover extends left into the outer margin with its right edge flush to the fixed date's, so its top-right step arrows sit directly under the date while the panel clears the entry times and reading content further right. The **navigator** picks a period (week / month / quarter) and steps it with up (newer) and down (older) arrows; each step is relative to the flow's current date — jumping to the entry closest in time to one period away and keeping the popover open, so the user can walk the timeline a period at a time and scrolling (or a manual jump) between steps re-bases the navigator to where the view now sits. A step lands on the entry closest to the target on a date in the arrow’s direction, crossing gaps of any size. If no further date is available, the view stays in place without a message or shake. Month and quarter offsets clamp to the target month's last day, so a month-end date lands on the month end (May 31 − 1 month is April 30). The **date field** is a plain text field, empty by default — no native date control, so nothing competes with the inline calendar. While it is empty the calendar shows the current viewing date's month and follows it as the flow scrolls, so an empty picker mirrors where the flow sits. It takes free-form input parsed leniently (ISO, `5/31/2026`, `5/31/26`, `2023 3 12`, `May 31 2026`, `15th March`, a bare month, year, or `3`, …); a year-less entry infers its year from the date — this year if that day is today or already past, else last year, so it reads as the most recent occurrence (`jul 20` on Jul 7 is last year's). Pressing Enter jumps (flagging the field if the text resolves to no date); editing follows the calendar to the parsed month and highlights the parsed day (shown as an ISO date), and clearing the field returns it to the viewing month. The field commits only on Enter, not on blur, so clicking the **calendar**'s month arrows navigates rather than jumping. The calendar marks three days distinctly: the field's date (filled), today (a ring), and the day the flow is currently showing (a dot) — any of which may coincide. The date field and the calendar are each a one-time jump that dismisses the popover: they scroll to that day, aligning the top border of its latest entry (or the nearest earlier entry) with the Reader’s top edge. Period steps use the same entry-border alignment; the fixed metadata line then meets the latched date readout. Dates before the oldest entry clamp to the oldest card in the current filtered view; dates after the newest clamp to the newest. Empty views stay in place. Exact entry references still require an exact match. Every jump loads the matching timeline as needed and flashes the landing card. The popover also dismisses on Escape or a full click outside — both the press and the release beyond it, so a drag that starts inside (selecting the field) and ends outside doesn't close it.

Month navigation keeps keyboard focus on the corresponding arrow after redraw. Escape and a completed date jump return focus to the current visible latch trigger, its replacement, or the visible instance control when the trigger is unavailable. Outside pointer dismissal preserves the clicked target's focus. An invalid date stays in the field with a visible explanation and example, `aria-invalid`, and an associated error description. Editing the field clears that error.

On narrow screens the margin stacks above the entry content, the marker leading the row, and the readout becomes a full-width strip.

### Two-column layout

The flow uses two columns: timeline (left) and content (center). The content column is centered on the page and is the primary reading experience. The timeline sits in the left margin.

- **Left**: timeline — when (year, month, day, time)
- **Center**: content — what (text, tags, the primary reading experience)

No vertical separators — whitespace provides separation. Content stays centered and takes the most space.

### Entity icons

Entity icons form one notebook family drawn on Lucide's geometry — its 24-unit grid, 2-unit stroke and shapes — so they sit with the app's other icons: the instance is a ring-bound notebook, an entry the pencil writing in it, a project a bookmark ribbon, an action a round checkbox, and artifacts and attachments pages with a folded corner. A page's mark previews what the reader opens — text lines, a PDF label, a picture, a play button, an audio waveform, a pie chart for a webpage, a blank page for a file with no preview, a second page stepping out behind for an artifact of several files — so an artifact whose Markdown body renders as text wears the same page as a Markdown attachment; a PDF label or a media mark is large, and the page opens around it at the lower left as Lucide's own file icons do, the outline stopping just short of the mark. Icons draw in line; fill marks state and gives a media mark its weight. Icons carry state and morph between states: a done action's ring fills and ticks, as does an ended project's ribbon; the instance open in this tab swings its cover half open; a linked worktree's cover carries the git branch. The same drawing serves every size; at pill size (13px and below) settling ticks grow bolder and a worktree shows the branch alone. The record header's status tiles draw the same icons: each tile's glyph is its entity's icon in that tile's state, a deadline tile the plain ring tinted by its urgency; only the no-calendar exception keeps a glyph of its own.

Smart elements are not entities, but their icons draw on the same grid, stroke and rules, so a rule means the same thing on a chip as on a pill. A date is a calendar page whose mark previews its value: a day is the bare page, a range of days carries two spans across the weeks, and anything with a clock time — one time or a timed interval — opens the page at its lower right around a clock face, as Lucide's `calendar-clock` does, rather than drawing a bare clock that would read as a slipped action's ring. A location is a map pin around its point; a postal-only location, its coordinates not yet saved, pends as a backlog action does — the point gone, the edge dashed. Date search rows and a date's identity pill in the side panel draw the same calendar page, keyed the same way.

### Entity tags

Tags appear as a compact row above the entry content, inside the content column. By default, show one tag per type (one project, one action) as clickable pills. If an entry has more tags of a given type, show a colored count bubble (+N) next to the visible tag — blue for projects, green for actions. Clicking the bubble expands to show all tags of that type. Clicking again collapses back to the compact view.

Every project and action pill carries its lifecycle status at a glance — the leading icon and accent color say what kind of thing the pill is; the status rides a second channel. An open action's marks are orthogonal and compose: an action with no time ahead on the calendar — unscheduled, or its scheduled event already over (scheduled plus `duration`, the calendar design's default length when unset; a date-only stamp lapses when its day ends) — keeps its cause in its icon: the ring's edge dashes while a time was never set (backlog — nothing committed yet), and clock hands fill the ring once a set time lapsed (slipped — a real time that ran out); either way waiting to be scheduled, first time or again. A recurrence template's ring opens into a loop arrow. And a deadline rings the pill with a thin inset ring in the due gold — urgency drawn as a circle rather than a glyph, so it rides any pill, and gold rather than red so it also reads against the action green for red-green color vision (an unscheduled action with a deadline carries both; an inline mention, having no field to ring and boxed awkwardly by one across a line wrap, flattens the ring to its bottom stroke — a thin underline in the same due gold). A deadline behind now — a date-only one once its day ends — is breached, and the same signal escalates rather than changing shape: the ring turns the overdue red and bleeds into the field as a soft wash, the name's ink reddening with it while the icon keeps the full type color (a mention reddens its ink and underline). A scheduled action with no deadline is the clean pill, as is an open project — the live state. Closed work — a done or cancelled action, an ended project — settles in its icon (a done ring and an ended ribbon fill and tick, a cancelled ring takes a slash) and mutes: the pill's field greys and the name's ink goes fully grey (the secondary text tone — the entry pills' ink) while the icon keeps the full type color — the vivid icon is the reference the grey name reads muted against, and alone says what it is (an inline mention, having no field, mutes its name the same way); a cancelled action's name additionally strikes through — dropped, not finished. The status reads the same wherever a chip appears — entry tag rows, record rows, inline mentions, the active filter pill. Accessible descriptions expose the type and lifecycle marks without changing the visible or authored link label; an active entity folded behind +N keeps its name and state in the bubble's description. Clock repaint updates these descriptions in place.

In a filtered flow, the filtered entity's own tag fills with a softened solid of its type color on every entry (a +N bubble hiding the tag carries the fill), and its inline mentions get a soft background fill of their type color — background only, no metric change, so the text never shifts. The fill respects the status marks: a closed entity's tag fills with the muted grey solid instead of the type color (its inline mentions with the entry grey) — the highlight never resurrects closed work; an overdue tag fills with the overdue solid, its mentions with the wash — the highlight never downplays a breach; and a due pill keeps its ring at the same weight whether highlighted or not (the fill marks the highlight, the ring only the deadline). On any fill, grey or colored, the whole pill takes the fill's ink, icon included — one uniform highlight.

Entries with no tags show no tag row — the content starts immediately.

### Navigation controls

Feed tags, inline references, record titles, related entity rows, and raw-file rows are native links with complete instance URLs. Tab reaches them and Enter activates them; copy-link, middle-click, and modifier-click retain normal browser behavior. Plain activation follows the entry-focus, record-page, or file destination defined above.

Tag expansion and section reveals use native buttons with meaningful accessible names, `aria-expanded`, and their controlled group/list IDs. Enter and Space activate them. Replacing a tag expansion button retains its focus; revealing a section moves keyboard focus to its first newly revealed link. All navigation links and expansion controls show visible keyboard focus.

Opening a record or file page moves focus to its main heading or main landmark. History navigation restores the saved control or its current equivalent when available, otherwise the main landmark, without scrolling away from the restored reading position.

Departure visuals are inert and hidden from accessibility during the flight. Before replacing a focused entry, focus moves to the visible filter control or instance control, including with reduced motion. Focus already outside outgoing entries stays in place.

### Time as permalink handle

The entry's gutter time doubles as its permalink handle — muted at rest, accented on hover/focus. Its href is the entry's jump route within the current filter (including the selected instance ID), so copy-link, middle-click, and open-in-new-tab all deep-link to the card. A plain click scrolls the entry to the top of the flow and pushes that URL, keeping the query, active project/action pill, search, and ordering.

### Inline entity mentions

Inline mentions (`#project/name`, `#action/name`, `#entry/YYYY-MM-DDTHH:MM`) render as muted tag-style pills that flow with the text — not plain links. Visually softer than the margin tags but still clickable. Entry mentions consume a complete, valid timestamp (minute precision, with existing second-precision routes recognized); partial or malformed timestamps stay literal. Project and action IDs retain their letter, number, combining-mark, underscore, and hyphen grammar. Code and escaped hashes stay literal. Markdown links to complete entity handles keep their authored labels and formatting while using the same instance-scoped native destination and ordinary-click navigation as bare mentions. Unrelated fragments and external links retain their destinations.

Hovering a project, action, or entry reference — a margin tag, an inline mention, or the active filter pill — co-highlights every other reference to that same entity on the page, each showing its own hover treatment, so the eye can trace one entity through the flow. When a reference is folded behind a collapsed group's +N bubble, the bubble itself lights up in its place.

### Inline date smart elements

[Date references](../design/date-reference.md) define the ISO handle syntax,
display, copy, and calendar navigation contract. They render in every Markdown
reading surface alongside entity references. Date routes preserve calendar
targets independently of exact entry IDs.

### Inline location smart elements

[Location references](../design/location-reference.md) define handles with geo,
postal, or both values. They render in every Markdown reading surface as neutral
inline chips. Optional Markdown labels affect display only; unlabeled chips use
postal text, then coordinates. A geo chip opens its saved point in Apple Maps;
a postal-only chip is inert and indicates that coordinates are unavailable.
Rendering performs no geocoding. Complete-chip copying restores the exact handle
and authored Markdown label formatting; partial selections remain plain text.
Malformed values, code, and escaped hashes stay literal.
An action's primary `location` appears in its detail metadata using the same
chip and copy behavior, independently of body mentions. The field accepts a bare
handle; display labels are available only in authored Markdown.

### Entity resolution

Project and action pills and inline mentions use the single active entry filter. Explicit record titles and **Open details** open bodies. Entry references jump within the current entry flow, with explicit recovery when its constraints exclude the target. Artifact handles and relative file links open native content pages. References retain complete instance-scoped native URLs and authored labels.

### Reading anchors

Every flow re-render is grounded at an anchor — an entry held at its viewport offset while the timeline re-renders around it. The anchor degrades gracefully: its own card is pinned at its offset when that entry survives the new filter; otherwise the surviving card closest to the displayed moment is pinned flush with the readout instead. Either way the view stays grounded in a card, which matters most when the timeline expands (a proportional-scroll mapping would amplify small moves into large jumps in time; pinning a card cannot). Which entry anchors follows the user's attention: engaging or clearing a filter from a tag on an entry anchors that card, so the entry acted on never jumps away; clearing from elsewhere (the visible filter clear control) re-anchors the entry the filter was engaged from while it is still on screen — the round trip returns the view the filter came from. Every other case anchors the time cursor: the entry under the latched date readout at the pane's top edge, the moment the readout displays. Engaging from outside the flow (sidebar, global lookup) and display-setting changes anchor it, so the readout's date holds steady while the related cards visible in the flow slide to their places in the new timeline — the timeline always animates around the user's click or, failing that, the readout's moment. Browser back/forward restores each view as it was left: every history entry carries its own anchor (the time cursor and its offset, refreshed as the user scrolls); an entry without one falls back to the current time cursor. When the new flow is too short above the anchor, the scroll clamps and the card slides as little as the content allows. Either way, weeks keep loading until the anchor reaches its offset and the pane below it is filled to the viewport's bottom — so the card holds its place and the entries beneath it are built before the transition plays, rather than popping in after it (which is what a top-clamped anchor, seated with nothing below it, would otherwise do). (Following an entry reference is a different gesture: it jumps to the exact matching entry. If the current flow excludes it, navigation to the default flow requires an explicit choice.)

### Record context

Overview opens the instance body with its projects and open work. Project pages expose their actions, related projects, entries, and supporting artifacts. Action pages expose their timing, project context, and related entries/files. These native readers work independently of custom pages.

Status renders as a row of pills, each a lifecycle state or an exception — never a fact. A pill's text carries time only as the distance to a pending event, that distance being the magnitude of the status (due in 3 hours and due in 2 months are different states): an open action wears `Due in 3d` (`Due today` for date-only deadlines, `Due now` at a timed deadline, escalating to `Overdue 3d` once breached) whenever a deadline exists, and for its calendar one of `Scheduled in 2h` (`Scheduled now` at its start, `Scheduled 2h ago` mid-event) while the event is ahead or running, `Slipped 2mo` once it lapses unresolved, or `Backlog` when a time was never set — deadline and calendar independent pills, never merged, all shown when they apply; a resolution stands alone. A live schedule synced to no calendar adds a `No calendar` exception pill — a dashed outline on no field, an absence rather than a type accent; a slipped one doesn't (rescheduling, not syncing, is its fix), and the synced norm shows nothing. A pill's label carries the distance; a named schedule additionally shows its absolute local time and authored clock/zone annotation visibly on the record page. The calendar fact also reads on hover — every pill whose state has a stamp spells it out absolute ("Deadline 2026 Aug 3, 17:00"): the due pill its deadline, a Scheduled or Slipped pill its scheduled time with the timezone and duration riding it, a resolution its scheduled time (the design's done time, absent when never scheduled), a project's Open/Ended its created/ended stamp. Backlog and the exception pill have no stamp and no hover. Pills wear the entity-pill style: the type accent field carrying the same marks the entity's own chips wear (the due ring and its overdue wash; the closed mute and strike), no type icon — the title above carries it, in the entity's state. The authored description sits below the pills, and one muted facts line closes the header under it — reading as text, it belongs with the prose, not among the title and pills. The line: the stats — the scope's counts as icon-and-count pairs, the entity-type icon in its full type color, the count in the mono face, `open/total` for the lifecycle kinds, a bare count for entries — then, trailing them in the text face, `updated 3d ago`, the one time-since fact each record page states (the time since the latest entry mentioning the entity; for the instance, its newest entry; absent when none does — time since a past event is a fact, not a status, so it never wears a pill). The line shares one line height, its children centered; it wraps at narrow widths, the updated text falling first. The remaining front matter follows in the record body.

The instance counts all projects, all actions, and all entries; a project its explicit related projects, its co-occurring actions, and the entries mentioning it; an action its co-occurring projects and its entries — never itself, its own state being the pills'. Zero is a stat, never hidden. Each pair spells itself out on hover ("4 of 30 actions open"); the facts line navigates nowhere — the sections below do. The record stats include the latest date and the per-state splits.

### Related entities

Relationships derive from the same records as the entry flow. Projects expose their explicit related projects in both directions and co-occurring actions; actions expose co-occurring projects; linked artifacts/files remain available from either. Entry counts include metadata references and inline mentions consistently. Instance pages provide projects, open work, and supporting files; complete censuses retain resolved work in foldable groups.

Record titles open bodies. Project/action pills browse entries; explicit Entries, Actions, and Related entries links open the corresponding native timelines. Artifact/file links open their content pages. Long related lists reveal twenty rows at a time while retaining count and keyboard focus.

### Document reader

Action details show a supplied calendar account beside its readable calendar name, such as `Work (iCloud)`; an omitted account shows only the name.

Project, action, artifact, and instance records and raw files open in the Reader. Native record and Markdown readers use the entry flow's readable prose measure and GitHub-flavored Markdown rendering, with the automatic panel/pill layout. HTML pages use the full viewport with both panels retracted and the Control pill active, regardless of width. Back restores the preceding page, browsing state, and reading position. **Open details**, explicit record titles, artifact/file links, and deep links open the corresponding content.

- A project/action document renders the complete record: the status pills, the authored index description, every front matter field (absent fields omitted, the id leading them as a field, code-like values — ids, versions, config entries — in the mono face, dates using the configured localized date and time styles; `name` is the title, `resolution` the status pills, a project's `related_projects` the hierarchy tree below — each datum appears once), then the derived record — a project's census of its actions grouped Open / Done / Cancelled (index order, with index descriptions; foldable, the resolved groups starting folded) and, on both, stats (the entry count with the latest date) — then the body.
- The instance document renders the manifest (`aside.md`) the same way — `name` is the title, `description` the authored summary line beneath it, the other front matter fields following (the id leading them, config keys under their `config.` path) — followed by the instance's full census in foldable sections, then the free-form body (the user-authored agent instructions). The census: the whole project hierarchy forest (every project — ended ones included — nested by its links, roots in index order, loners as their own roots), all actions grouped Open / Done / Cancelled (index order, with index descriptions), and instance-wide stats (entry count with the latest date; project and action counts by state). Each section folds behind its heading, the count staying readable while folded; the resolved action groups start folded.
- A project document's related projects render as the project hierarchy, an indented tree where position carries the link direction: `related_projects` links are declared on the higher-level project, so a forward link reads as a child and a reverse link as a parent. The tree shows every ancestor path from the top-level projects down to the open project — always present, with only that project highlighted as the current record; it is itself the root when nothing links here — then its full descendant subtree. Each row after a root carries the declared description of the link to its parent row, and rows are the usual clickable tags. The link graph need not be a tree: a project reached twice (several parents, or a cycle) expands its children only the first time and repeats as a plain row. The tree never folds behind "+N more".
- Record and file pages use normal page navigation. View details uses the active control interface's read-only inspection subview. Settings is a native modal dialog: focus moves inside, Tab wraps within visible enabled controls, and the background is inactive. Hidden, disabled, and negative-tab-stop controls are skipped; native media and embedded-document controls retain their internal keyboard traversal. Escape dismisses only the topmost dialog and restores focus to its connected launcher or current equivalent, falling back to the visible instance control. Search, pill, and date popovers follow their own focus/dismissal rules and close before a modal opens. Global shortcuts respect modality. Escape does not clear entry browsing filters.
- Project/action pills inside a content page open their default focused entry flow. Explicit record titles open bodies. Artifact and raw-file links navigate between content pages while retaining the originating flow as return context.
- An artifact document uses the same file reader: its display name and handle lead the content, followed by associated projects/actions and inline backlinks. Backlinks appear as entity pills with resolved names or attachment filenames; their tooltips retain the full handles. An explicit attachment shows its exact filename and parent artifact link. The artifact page lists the attachments indexed in front matter. Content follows the [file content rule](../design/artifact.md#file-content): an empty body with exactly one attachment uses that file's preview; otherwise the body renders as Markdown. When the selected or implicit preview is HTML, the [full-page HTML](#html-pages) presentation replaces this host document wrapper; its source, metadata, attachments, and related context remain available through the pill.
- A non-HTML raw-file document shows the file name, its path, the content, and the entries linking to it ("Linked from", with their index descriptions). Images, PDFs, audio, and video embed by extension. HTML (`.html` / `.htm`, case-insensitive) opens as a full-viewport sandboxed page with no host title/path wrapper and with the Control pill active. Other files are read as text: binary content is offered as a download; Markdown and extensionless text render as Markdown; other text is shown verbatim.
- Failed document reads show the relevant file diagnostic, full failure reason and Retry inside the reader. Attachment failures retry the selected file rather than its parent record. Retry preserves the route, scroll and readable recovered content, keeps focus within the reader, and discards its UI completion when a newer document, filter or Store supersedes it.
- Connection, record and reader operation feedback follows [Operation notices](#operation-notices).
- Media and HTML previews check file metadata before embedding, reuse successful checks until a file change, and expose HTTP failures with Retry. Native image/audio/video load and decode errors replace the failed preview with the diagnostic; embedded PDF errors are shown when the browser exposes them. Retry forces fresh metadata and a fresh preview URL without reading media bytes as text, including from the global diagnostic notice. Browser PDF viewers do not reliably report malformed content to the page. Browsers do not reliably expose iframe load failures; HTML previews report metadata failures, without inferring success from an iframe load event.
- Page navigation preserves the preceding browsing state. Back returns through that history without clearing filters or changing a pin.

### Artifacts and raw files

[Artifacts](../design/artifact.md) open in the existing file reader. Inline handles resolve to display names or exact attachment filenames; labeled links keep their labels, and image references embed their selected file. References work in every Markdown body, including supporting Markdown files, while code stays literal. Artifact front matter and supporting-file front matter do not establish backlinks.

Attachment filenames come from artifact front matter. File contents are fetched only when selected or referenced; the webapp never enumerates attachment directories. User files follow no prescribed directory layout and are read only as needed for a requested preview or reference; see [instance file ownership](../design/instance.md#instance). Relative file links and media sources, including supplied caption tracks, resolve against their containing record and fetch through its instance-scoped daemon file endpoint; prefer artifact handles for stable identity. The daemon serves WebVTT tracks as `text/vtt`.

### Webpage embeds

Markdown bodies accept `<iframe src="https://example.com/page" title="Page" height="600"></iframe>`. Destinations may be explicit HTTP(S) URLs, relative instance file paths, or exact artifact attachment handles (`#artifact/<id>/index.html`). Relative paths resolve against the containing record or supporting Markdown file. Invalid, unresolvable, credential-bearing, protocol-relative, and non-HTTP(S) external destinations are omitted. Code examples remain literal. External pages must allow framing through their own response headers; Aside cannot override that policy.

The renderer rebuilds each Markdown-authored frame with `sandbox="allow-scripts"`, `referrerpolicy="no-referrer"`, lazy loading, an accessible title, full width, and a default height of 70vh. An authored numeric height is clamped to 100–2000px. These inline embeds remain inside their containing Reader and do not change its panel mode. Authored sandbox permissions, device permissions, event handlers, style, and `srcdoc` are not retained. Full-page HTML file previews use the same sandbox and occupy the full viewport rather than the inline embed's default height; sources without an addressable file URL use the file text as an app-owned sandboxed source document, which inherits the [application shell's Content Security Policy](../cli/spec.md#web-server) and therefore runs no inline scripts.

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

Search opens within the active Navigation interface or the pill's own search popover, with explicit **Text**, **Regex**, and **Semantic** modes. Placeholders and query help identify the selected language; queries are never reinterpreted or retried in another mode. Text is the initial mode. When an entry flow is displayed in Text mode, results begin with **Search this flow**, followed by ordinary lookup results. Only selecting that option applies the typed text to the flow; it stays available when global lookup has no matches. An empty option opens editing of the current phrase. Record readers, HTML pages, and the entry-detail route offer global lookup alone. No separate flow-search input appears in the Reader.

Global lookup finds and navigates to records across the instance, independently of entry quick search. Text queries use whitespace-separated terms that must all match (AND), case-insensitively, against IDs, display names, index descriptions, cached entry content, or artifact Markdown bodies. Attachment contents are not searched. `project:` / `action:` / `artifact:` / `entry:` prefixes (plurals and `note:` accepted) restrict types; ISO date ranges (`2025-01..2025-06`, either side omittable) restrict creation dates. A date-like untyped query offers a timeline jump.

Text results group dates, projects, actions, artifacts, then entries. Exact and prefix matches lead; name matches rank above IDs, descriptions, and body-only matches, with recency breaking ties. Each group is capped and expands through a "+N more" row. Body-only matches show a snippet. Arrow keys select rows, Enter or an ordinary click opens, Esc closes, and `/` opens and focuses search in the active control interface; context and auxiliary presses leave the query and current view intact. Artifact results open content pages; project/action results set that pill focus without toggling it off; entry/date results navigate to their timeline destination. Lookup text stays outside the URL and never becomes a filter chip; entry quick search is part of flow URL/history state. A global entry lookup removes any pill or quick-search condition that excludes its target and opens the result in one history visit; matching conditions remain active.

Regex sends a case-insensitive ECMAScript pattern, without delimiters or flags, through all four typed `Query.search.where` groups and orders by `CREATED_DESC`. It returns up to twenty newest matches across types, with source snippets and its limit explained above the results. Text prefixes and date syntax do not apply.

Semantic sends plain language to `Query.search.rankBy.semantic` and displays up to twenty hits in global relevance order, with source snippets, embedding model and indexed chunk count when inference ran. Regex syntax and Text prefixes/date syntax do not apply. Both server modes search saved record Markdown and metadata; attachment contents and unsaved recurrence projections are excluded. Results retain global order without type grouping, and offer global lookup alone. Failures show an inline error and Retry, including first-index timeout guidance for Semantic. Query, mode, instance changes, and dismissal abort outstanding requests; superseded results cannot reopen or replace the popup.

The search input is a combobox controlling a stable, named listbox. Its expanded state follows popup visibility, and its active descendant always identifies a currently rendered option inside that listbox. The keyboard-selected row has an accent background and a solid accent bar at its left edge; pointer hover uses a neutral background. Dismissal clears the active descendant. Result groups are named, while loading/empty status and Retry controls sit outside option semantics. Refresh and expansion retain the selected result when it survives; changing the draft resets selection. Arrow keys reopen at the first/last option. Enter flushes a pending draft and activates the selected option, or the first option when none is selected; it leaves an unchanged, dismissed popup closed. Pointer activation of Search this flow uses the current draft even during its debounce. Escape cancels a pending query or closes the popup without changing the current page or entry filters.

Search results scroll within the remaining viewport height. The pill's search popover fits within viewport side gutters, independently of the trigger's width. Responsive changes preserve the draft and result selection in the equivalent search interface; they do not open a panel to continue searching.

Settings → Keyboard can disable the single-character `/` shortcut; the choice persists. The shortcut does not intercept editable controls, text composition, or Ctrl/Meta/Alt combinations.

### Operation notices

Loading and incomplete-data notices use a compact row: a 16px indicator, a short normal-weight message, optional supporting text, and plain text actions. Loading uses a muted spinner; warnings use amber. Notices sit in the affected surface. Native retry controls share one appearance across loading notices and file diagnostics.

Loading appears only after an operation has remained pending for 200 ms; fast reads never flash a spinner. An instance card shows only a small spinner beside its name, with a screen-reader loading message. The spinner occupies reserved space, keeping the card and surrounding cards stationary. Clicking the same card during loading keeps the current request and spinner unchanged; selecting another card supersedes it. Superseded or closed views cancel their pending indicators. When the first entries are ready, the chooser gives way to the timeline and visible entry cards rise 40 px into place with a short stagger. This entrance respects reduced motion and the animation-speed preference. Ordinary card links still support modifier clicks and opening in another tab. Direct instance URLs keep delayed startup feedback in the reading column until the initial entries are ready. A new selection starts its own note reads immediately; pending reads from the previous selection cannot delay it or replace its content.

Messages name the pending operation: `Loading instance…`, `Loading instances…`, `Loading summary…`, `Loading document…`, or `Loading search text…`. Loading and warnings are polite statuses; actions, details and authored content are not live. Reduced motion freezes the loading indicator.

Connection loss shows a muted offline indicator in the active control interface. Its tooltip distinguishes automatic reconnect from a closed connection, and clicking it starts a new connection attempt. It disappears on recovery while its reserved slot keeps the controls stationary. Existing content remains available throughout reconnect and background refresh.

An ordinary failed user action shows one plain-text toast in the lower corner, above an open reader or settings dialog. It is a polite, atomic status, stays visible for four seconds, then dismisses automatically. A new failure replaces the previous toast and starts a fresh four seconds. It never takes focus or intercepts pointer input. Report failures only for the current operation that the user explicitly initiated, including Retry and manual reconnect. Automatic refresh, search indexing, infinite scrolling, startup, agent-driven navigation and SSE reconnect failures do not produce toasts. Superseded or disposed operations cannot report a late failure into the current view.

An entry reference excluded by quick search offers an explicit Open in all entries action in the toast. This action remains available until selected or dismissed by later navigation. Its button accepts pointer and keyboard input; activation focuses the destination entry.

Recovery remains at the affected control: selecting a failed instance card retries it without expanding the card; record failures leave a Retry control; unavailable direct instance links offer Retry and Choose an instance. Background record and reader refresh failures retain readable content. Record failures keep quiet file diagnostics with their full reason and Retry; a failed retry updates the reason without opening Details automatically. Empty-path validation remains beside its field, while registration and removal failures use the action toast.

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

Each selected tab subscribes to its instance's `/-/api/instances/<id>/control` stream. A pushed route applies as normal pushState navigation, so Back undoes it. Tabs report focus and a chooser subscribes to global control so the daemon tracks the open tabs. `show` opens its fresh authorization handoff in the default browser; `showUrl` leaves opening to the caller. Neither selects a connected tab for navigation. Connection loss uses the active control interface's offline indicator; SSE reconnects automatically.

### Instance selection and settings

The daemon is the sole backend. `/` lists registered instances as cards sharing the entry flow's gutter, dividers, hover highlight, and pre-divider instance summary (name, description, open/total project and action counts, entries, and updated distance). The gutter uses the existing date/time format and shows the latest managed-data edit, following the [instance summary policy](../design/instance.md#workspace). Unreadable manifests stay hidden until they can be verified again; readable instances remain selectable, including worktrees and duplicate IDs. Selection opens `/<address>/` with pushState and no page reload. The instance control in Navigation or the pill's view picker shows **Choose an instance** while inactive, or the active display name and branch/path disambiguation. Its searchable dropdown always keeps the representative's name and description, with compact worktree branch rows beneath it; name and disambiguation share a baseline. A missing primary uses a stable worktree representative, preserving the worktree's own data and disabled calendar sync. **Add instance** replaces itself with an inline path form. **Browse…** chooses a local folder and fills the path without registering it until **Add instance** is submitted. Enter submits, Escape or **Cancel** closes the form, and empty-path validation remains beside the field. Each card has an accessible **Forget** icon. The tooltip explains that files stay on the Mac and, for a primary, includes registered worktrees in the removal. Duplicate-ID groups appear last and show only an amber warning icon plus the monospace ID, inline with card facts or beneath dropdown descriptions, once per group. A crossed-out calendar icon appears before Forget or at the dropdown's right edge whenever calendar sync is disabled or paused. Hover and keyboard focus explain the reason; card indicators open Settings details without selecting the instance. List failures offer **Retry**. Refresh preserves equivalent keyboard focus; forgetting the focused row moves focus to the next row's Forget control or **Add instance** when the list is empty.

An unavailable deep link shows a Retry button and a link to the chooser; a failed explicit retry produces an action toast. Initial network or file failures do not appear as a successful empty timeline. The instance control returns to the chooser and switches instances in place. Long names truncate visually when space is limited, retaining their full accessible text and tooltip so search and More stay reachable in both control interfaces. Browser tabs choose independently of MCP sessions; the daemon syncs eligible primary and independent instances; linked worktrees never sync.

**More → Settings** controls display preferences (date format, time format, clock, animation, tag expansion); it has no data-source or URL-style override. Settings keeps its header and close control visible and scrolls its body within the viewport at short heights. Display preferences are shared across the origin. Record caches, file/media requests, watches, control, and navigation history are instance scoped.

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
- **Markdown rendering** — GitHub's production Markdown is the baseline for content typography and spacing. See [Markdown rendering](#markdown-rendering) for the scope, reference, and intentional deviations.
- **Dark mode** — user-selectable light/dark theme. Default follows system preference. Appearance is available through More in either control interface. Persist choice in localStorage.
- **Animations** — subtle and purposeful. Every flow re-render plays a FLIP pass keyed by entry id, grounded at the anchor's resolved card. The whole rendered flow is snapshotted, and every card is one of three kinds. A **surviving card**, rendered in both layouts, flies from its actual old position to its actual new one, opaque the whole way (it moved, it isn't new); it is the only kind that spans the unseen region, so its flight distance passes through a soft-knee curve (linear to ~1.25 viewport heights, then compressed asymptotically toward ~2.5) — a far origin enters visibly instead of streaking, an on-screen rest is reached exactly, and speed reads as distance traveled so the eye senses how far it came. An **appearing card** exists only in the new layout and is animated only when it lands on-screen; it enters from the seam where its moment fell in the old layout. A **disappearing card** exists only in the old layout and is animated only when it was on-screen; it exits toward the seam where its moment falls in the new layout — every new card, surviving and appearing alike. A **seam** is a cut in the timeline: the gap between two adjacent cards, or, past the ends, the outer edge where a boundary card (the newest or oldest) borders the unseen. An **in-span card**, its moment between two new cards, crosses the gap: its center line, compared with the seam, picks the direction — it ends fully on the far side, edge flush, so it travels at least half its own height and never rests in place; it tucks behind the card there (matching edge) and clips itself against that card's far edge — pinned in pane space by counter-animating a clip inset against its own transform — so a taller card hides instead of poking past. A **card past a boundary** has no gap to cross; it tracks its boundary card, moving the way that card travels from its own start (its old position, or the old-layout seam it appears from) to its final spot. When the boundary moves outward — the newest card up, or the oldest down — the tracker flies the system's full reach (FLY_MAX viewport heights) from its own spot, clean off that timeline edge into the void — farther than any surviving card, whose distance the soft-knee holds strictly under FLY_MAX, so it always reads as the fastest thing on screen and its ease-out tail lands off-screen, never braking at the edge. When the boundary moves inward, or — only a surviving boundary can — holds still, the tracker folds in behind it, tucking into the boundary seam as the timeline concentrates into its edge; an appearing boundary always moves, so a still boundary is only ever a survivor that stayed put. Which edge a tracker exits is set by its side in time, not where it sits on screen. An in-span reveal fans out of the collapsed seam it was hidden in; an in-span tuck collapses back into it; a boundary tracker rides its boundary card clean off the pane edge. Departures and arrivals stay exact mirrors — the boundary travel that flies a ghost off the edge one way flies it back in from off the edge the other — so a disappearance and its reverse reveal retrace each other by construction. Opacity is uniform: every arrival starts transparent and fades in over its first third, every departure fades out to transparent over its last third — whatever their path, on-screen or past the pane edge. Depth is fixed: survivors paint above arrivals, arrivals above departures, so the arriving (newly-focused) content comes forward. The first frame still reads as the old view because the arrivals leading on top are transparent then — the departures beneath show through until the arrivals materialize over them; by the end the departures have faded out. Every card in flight paints an opaque pane-colored surface spanning its timeline gutter too, so covering actually hides — body and date alike. Cards fanning out of or collapsing into one seam stack shortest-flight-on-top, reading as cards pulling out from under one another. One rule, every read: revealed entries unfold out of the seam where they were hidden, removed entries collapse into the seam that absorbs them — or, past a boundary, ride its card off the edge as the timeline shifts — and a lens switch onto a different moment sweeps the whole view toward the new anchor's place in time. All slides share one duration and easing, scaled together by an **animation speed** setting (Off / Fast / Normal / Slow, persisted in localStorage; unsupported persisted values normalize to Normal) that multiplies the base transition durations across the CSS variables, the FLIP slide, and the JS cleanup timers alike; Off collapses every transition to zero, reading the same as `prefers-reduced-motion`. Margin furniture (times, markers, seams) rides its card, and the readout swaps at the start of the transition rather than rolling with it. The readout is held for the whole rebuild and recomputed exactly once, on settled geometry — never against the partial markers a progressive week load appends or the stepped scroll a restore applies, which would flicker the date through wrong values — so a re-render shows one clean swap from the old date to the new. A navigation landing mid-flight snapshots the cards where they visually are — the next transition starts from there — and the previous transition's departures are dropped. Transform, opacity, and clip only — no layout work during the animation. Renders with nothing to snapshot (first load, an emptied view) read from the top with no motion. Under `prefers-reduced-motion` all motion is off — the FLIP pass is skipped and CSS transition durations drop to zero. No gratuitous motion, but transitions should feel polished. The full transition model — principle rules, per-kind start/end geometry, void and compression handling, the animate table, and known issues — is in [animation.md](animation.md).
- **Typography** — system font stack. Monospace for timestamps and entity names. Clear hierarchy with font weight and size, not color. Timeline timestamps, the date readout, and entry pills use 12px text; timestamps/readout keep 20px line boxes, and pills use 16px lines with 2px vertical padding for the same total height. In the desktop gutter, every timestamp uses the standard pill label’s baseline at a fixed offset from the entry border, regardless of the entry’s content. That offset is measured from the pill and timestamp fonts independently of records. Only the visible timestamp and date text gets a backdrop where a wide first line crosses the gutter. Narrow layouts keep timestamps on their own row at the same left edge as content. The date readout uses the same fixed metadata line and stays in place across scrolling, navigation, and flow rebuilds. The UI type scale is font-size/line-height pairs with whole-pixel line boxes (14/20, 12/16, 16/24, …) to keep controls stable across re-renders. Rendered Markdown follows GitHub's typography ratios, including fractional line heights in smaller headings and code.

#### Markdown rendering

The intent is to give ordinary Markdown GitHub's familiar hierarchy and reading rhythm, rather than design a separate prose style for Aside. Match font sizes, weights, line heights, block and inline spacing, and list nesting for supported Markdown elements. This baseline applies to every `.rendered-content` surface: entries, entity and instance bodies, artifacts, and Markdown files. UI controls, metadata, and full-page HTML have their own presentation.

Use the `.markdown-body` rules loaded by an [actual GitHub Markdown page](https://github.com/primer/css/blob/main/README.md) as the reference, checking computed styles when inheritance or overrides matter. Third-party CSS extractions are not the authority. Maintain the adaptation in local CSS; the app does not load GitHub's stylesheets at runtime.

Body text and tables use 16px/24px. H1–H6 use 2em, 1.5em, 1.25em, 1em, .875em, and .85em, with weight 600 and line-height 1.25. Code blocks use 85% size and line-height 1.45; heading code inherits its heading's size. Preserve GitHub's fractional line heights within Markdown rather than applying the UI's whole-pixel type scale.

These layout deviations are intentional and marked beside the relevant CSS rules:

| Element | Aside deviation | Intent |
| --- | --- | --- |
| H1 and H2 | Omit the bottom border and its associated `.3em` padding. | Keep headings clear of the flow's entry dividers. |
| Horizontal rules | Hide authored `hr` elements in the shared renderer. | Let the flow own its separators and keep document rendering consistent with entries. |
| Table cells | Keep a `10em` minimum width. | Keep many-column tables readable. |
| Wide blocks | Top-level tables, code blocks, and Mermaid outputs/source use a viewport extending into both spare margins, stopping 16px before panels or viewport edges. Initially, content that fits the prose column aligns with its left edge; wider content that fits the available space is centered there; content exceeding that space starts at the available space's left border. Fully visible blocks need no horizontal scrolling. Overflowing content remains visible through both margins and can scroll until its right edge reaches the prose's right edge. Preserve user panning across layout and theme updates. Hide horizontal scrollbar chrome while retaining gesture and keyboard scrolling. | Show more of wide content without widening paragraphs, moving the reader, or covering panels. Nested blocks and summary/popover content stay within their local container. |

Aside's system font, theme colors, entity/date references, and Mermaid rendering remain app integrations. They do not change the baseline for ordinary Markdown typography and spacing. Other differences should be reviewed as drift rather than assumed intentional; any additional exception needs an explicit rationale here and a comment beside its CSS rule.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│ Browser                                             │
│                                                     │
│ Native view, when panels fit:                       │
│   [Navigation]  [Reader]  [Context, when relevant]   │
│                                                     │
│ Compact native view, or full-page HTML:              │
│   [Reader]                                          │
│   [Control pill → its own Views / Search / More UI]  │
│                                                     │
│ One active control interface, shared browsing state │
│                                                     │
│ Presentation cache                                  │
│   records │ graph │ diagnostics                     │
└─────────────────────────────────────────────────────┘
```

### Data layer

The browser uses the `StoreView` contract, implemented by `RemoteStore` for the
current daemon app. The portable core and optional static-file adapter are described
in [data core](../design/record-model.md).

- **Startup**: check instance availability, fetch one structured snapshot with manifest/body, indexes, records, graph, week selection and diagnostics, then recheck identity. Record failures remain visible alongside readable records; a failed snapshot request is a connection failure.
- **Scroll and search**: the default entry source renders cached parsed weeks progressively. The daemon's complete corpus is available for search without fetching weekly record files in the browser. Agent-defined sources compose their query, pill, and search predicates before pagination; the browser never filters only a loaded page or rewrites arbitrary GraphQL.
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
- **Apply**: stage the snapshot and file changes, then install them synchronously when the app is quiet. The graph and week lists arrive already derived. Re-render the affected sidebar, active view and lookup while preserving browsing state, reading anchors and focus. An older staged snapshot cannot replace a newer Retry result.

Consistency: eventual, with staleness bounded by the check cadence; reads never wait on a check; each check's findings land atomically. There is no cross-file snapshot — a check can catch the writer mid-update — but every such state renders conservatively (a missing entity shows its id, a missing week is empty) and the next check repairs it.

### Parsing

The data core uses the shared parsers in `cli/src/core/parser.ts` for weekly files, entity records, indexes and manifests. The current browser receives their results and diagnostics over HTTP. Parsers return `ParseResult<T>` — a best-effort value plus a list of issues. The store keeps usable recovered content and retains issues by source file.

A muted, expandable notice names affected files, fields and parser reasons and explains agent validation and repair. Weekly issues appear at their chronological slot alongside recovered entries; record-reader issues appear with that document. Manifest and index problems stay visible even when recovery produces no rows, so partial data cannot count as a verified empty instance or complete search corpus.

Retry asks the daemon to reload records, or rereads a displayed supporting file. Corrected reloads clear its diagnostics; failed retries preserve recovered content. Weekly Retry keeps keyboard focus on its visible summary while loading, then on a replacement Retry or the recovered entry's time link; an empty slot falls back to the visible instance control. Focus intentionally moved elsewhere during loading stays there. Catch-up applies parse diagnostics with the matching staged contents. The End remains the unfiltered history terminator even when earlier slots need attention.

### Entry flow rendering

Each entry in the flow renders as a card:
- **Margin**: the entry's time (and the day marker on a day's first entry) in the timeline margin
- **Header**: project tags as colored pills, action tags as pills
- **Body**: rendered markdown content with inline mentions converted to clickable links and asset links opening content pages
- **Metadata bar**: entry references, if any

Infinite scroll follows the active source's pagination; the default source loads more weekly files as the user scrolls down. The unfiltered timeline closes with a muted "The End" marker once fully loaded; a filtered view is an excerpt, so it just stops.

### Entity tags

Tags are color-coded pills:
- Projects: one color family (e.g., blue tones, each project gets a consistent shade)
- Actions: another color family (e.g., green tones)
- Entry references: neutral/grey
- Project and action pills carry their lifecycle status marks (see Entity tags under What It Should Be)

Project/action pills follow the [entry browsing state](#entry-browsing-state): replace or clear the single focus while preserving the source and search within the flow. Explicit record links open bodies rather than changing the filter.

Entry pill groups stay within the reading column. Expanded groups wrap whole pills; a single pill wider than the column stays one line high and ellipsizes its label while retaining its icon and status marks. Collapsed groups keep the first pill and `+N` together, reserving space for the disclosure. Full names remain in accessible link text and are available on hover alongside the entity ID.

### Sidebar and active view

The Reader, Navigation panel, and Context panel scroll independently with `overscroll-behavior-y: contain`; horizontal gestures remain available for browser Back/Forward. Their geometry and visibility follow [Automatic panels and responsive layout](#automatic-panels-and-responsive-layout). Record and HTML navigation replaces the active reading surface while retaining the preceding flow as return context; full-page HTML always uses the pill interface.

The shortcut index starts with **Entries**, a native link to the selected instance's default flow. Ordinary activation resets entry browsing state; modified clicks retain native new-tab behavior. Entries identifies entry browsing unless the state matches a pinned shortcut. The same index is available in Navigation and in the pill's own view picker after an instance has loaded. The instance control remains available before loading and during recovery.

Both control interfaces share command availability and browsing state, while each owns its UI and popup layout. Responsive transitions transfer applied filters and active control state, including search drafts and selection, without restarting the active source, creating a history visit, or resetting the Reader. No transition opens a panel drawer or restores a manual panel preference.

Browsing state, pins, and source identities are instance scoped. Index selection matches a pin's captured state, and restoring or removing a pin never mutates its agent-owned source. Record summaries and action context derive from shared records rather than independent panel content. When Context is retracted, the pill renders that context in its own details popover.

### Search

- Global lookup uses debounced input with explicit Text, Regex, and Semantic modes. `search.ts` parses and ranks local Text over indexes and cached bodies; `search-remote.ts` selects the server operation; `search-ui.ts` owns results, cancellation, and keyboard interaction. Its syntax and result behavior follow [Universal search](#universal-search).
- Quick search is a separate literal-text predicate composed with the active source and pill. The default source tests complete weekly entries while traversing history. Unread or failed weeks retain their loading/retry state; empty-result claims require complete traversal. Stale completions cannot replace a newer pill, search, navigation, or instance.

### URL state

The URL serializes the active surface and its source/parameters, single pill focus, search and sort. History also retains reading anchors and the preceding flow used to return from a page. Restoring a URL or pin reconstructs live browsing state rather than a locked view.

Native path destinations include:

- `/` — chooser
- `/<instance>/` — unfiltered flow
- `/<instance>/?search=release` — literal entry search, composable with project/action and reader routes
- `/<instance>/<entry-id>` — flow scrolled to that entry (jump)
- `/<instance>/project/2026-05-01-website-redesign` — default entry flow focused on the project
- `/<instance>/project/<id>/detail` — the project's complete record page
- `/<instance>/project/<id>/asset/<path>` — an asset page with the project flow as return context
- `/<instance>/project/<id>/<entry-id>` — …scrolled to an entry within the filtered flow
- `/<instance>/action/<id>`, `/<instance>/action/<id>/detail`, `/<instance>/action/<id>/asset/<path>` — same for actions
- `/<instance>/entry/2026-05-02T14:30` — entry permalink in the default entry flow
- `/<instance>/asset/<path>` — raw-file content page
- `/<instance>/artifact/<id>[/<filename>]` — artifact or attachment page
- `/<instance>/project/<id>/artifact/<artifact-id>[/<filename>]` — artifact page with the project flow as return context; actions use the same shape
- `/<instance>/detail` — instance record page (Overview)

Actions and agent-defined sources have instance-scoped destinations. Query parameters serialize the remaining browsing state, including the exact query attachment identity; saved query variables stay in that attachment and the URL does not alter source definitions. Pin storage holds the captured state independently of the live visit.

The first path segment is the stable, hostname-safe instance ID; global routes live under `/-/` and cannot collide with instance names. Navigation preserves the instance; source/pill changes, applied or cleared search, and date jumps create visits. Draft lookup typing does not change the visit. Browser Back and Forward restore the full state and reading position; cold links use the daemon's shell fallback.

A delayed entry or date jump only applies while its originating Store and navigation request remain current; newer view, history or instance changes discard the old completion before it changes the URL, active surface, filters, scroll or focus. History traversal supersedes pending navigation even when its destination has the same URL with different saved view state; a duplicate location event does not repeat that traversal.

IDs and attachment filenames are percent-encoded as single segments and raw-file paths per segment, with two characters kept raw where the encoding isn't needed: `:` (legal in a path segment, so entry-id timestamps read verbatim) and asset-path slashes (some servers reject `%2F` in a request path; unambiguous because an asset path is always the route's tail). Unrecognized routes fall back to the plain flow.

### Source boundaries

`cli/src/core` owns the portable [data core](../design/record-model.md).
`lib/remote-store.ts` decodes daemon snapshots and stages presentation updates;
`lib/types.ts` supplies record exports and media display helpers. `src/` owns the
Reader, panels, Control pill, browsing state, navigation, rendering, and diagnostics.
Shared record derivations serve native timelines and record pages.

Routing serializes view state independently of rendering. Entry-source adapters
apply declared browsing inputs and pagination; they do not expose a query editor
or write to source definitions. Global lookup and entry quick search remain
separate interactions. HTML pages retain the iframe query boundary.

`index.html` is the single-page shell, `style.css` builds to `dist/style.css`, and
esbuild emits scripts and assets under `dist/`. `dist/static-data.js` is a separate
optional module and is not imported by the daemon app.

## Test Plan

### Library tests (automated, Node)

Run with vitest against self-contained fixtures. No browser needed.

- **Parsers**: weekly files, project files, action files, indexes — correct fields, edge cases (missing optional fields, no projects, inline mentions)
- **Types**: parsed entities conform to schemas, display names remain independent of stable IDs
- **Dates**: local-time Monday derivation; loose date-input parsing (ISO, US, spelled-out, year-less inference); period shifts clamp to the month end
- **Store**: manifest loading, index loading, weekly file caching, query by project/action/date range, weekly filename derivation, action name scanning from entries
- **Catch-up**: revalidation tiers (ETag / Last-Modified / content hash), index diffing for added and removed entries and entities, pushed-path routing (weekly file / entity / asset), deletion handling, derived-state rebuild on change, a failed check never evicts
- **Relations**: co-occurrence, entries per entity, asset links per entity and per entry, explicit related-projects in both directions, the project hierarchy tree (ancestor paths, descendant subtree, diamonds and cycles) and the instance forest (loners as roots, shared children once, cycle sweep), raw asset reads
- **Instance**: the reference status derivation (resolution first, then scheduled, else backlog — a deadline never regroups; a project open until ended), the chip marks (a deadline rings, escalating to overdue once breached — a date-only deadline at its day's end; no time ahead on the calendar waits, the mark keeping its cause — backlog when unscheduled, slipped when a schedule lapsed, the event's end at scheduled plus duration; deadline and waiting compose; a resolution stands alone, as does a recurrence template), the status pills (deadline and calendar independent, each pill its own state; Due escalating to Overdue, Scheduled to Slipped, Backlog when never scheduled; the no-calendar exception only beside a live schedule; a resolution alone; Open/Ended for projects; a stamped pill's hover — the deadline, the scheduled time with timezone and duration riding it, a resolution's scheduled stamp, Open/Ended's created/ended; Backlog and the exception hoverless), open-action grouping (each open action filed under its status, scheduled soonest first, backlog stalest first), the timeline window (the week ahead taken inclusively, the minimum either side of now, edge collapse both ways), activity ordering (entry-less items keep index order at the tail), relative dates (one compact rounded unit of days/weeks/months/years, "in" ahead, month boundaries), backlog last-update stamps (latest entry, else created)
- **Entity icons**: every state of a drawing shares one element structure, so a state change morphs the icon in place; the pill drawing where an icon has one, the same drawing otherwise; a same-state repaint leaves the icon untouched; lifecycle states from chip marks; pages keyed by how the reader renders them (an artifact by its body, its sole attachment, or a stack of several); smart elements keyed by their value (a day, a range of days, or a clock time; a pin with or without saved coordinates)
- **Paths**: relative link resolution against the containing file — `../` traversal, root escapes rejected, schemes/absolute/fragment links ignored
- **Routes and pins**: surfaces, source identity/variables, pill, search and sort round-trip; history restores reading anchors; pin matching uses captured state and live browsing never mutates it; malformed routes parse as the default entry flow
- **Search**: global lookup matches display name, id, description, and cached content; AND-ed terms, type prefixes, date ranges, date jumps, ranking, snippets, and highlighting. Entry quick search is literal text composed with the source and single pill before pagination, preserving grouped OR/NOT predicates.

### Browser tests

Serve a local instance and test the UI.

- **Instance discovery**: chooser includes unloaded registered directories, folder browsing and typed folder/manifest paths, inline validation, silent cancellation, automatic refresh on return, canonical deduplication, card hover/focus, and icon forgetting by path (including duplicate IDs) without deleting files
- **Served by daemon**: instance-scoped data, media, SSE, and navigation; failures have Retry and chooser recovery; a control event applies as pushState navigation (Back undoes it)
- **Entry flow**: reverse chronological, infinite scroll, rendered markdown, native reference links, date markers at day/month/year boundaries with the latched readout tracking scroll
- **Navigation controls**: keyboard focus and activation, native modifier/new-tab links, expansion button names/state, and focus retained across reveals
- **Filtering**: one project/action pill at a time, replacement across types, same-pill toggle, query/pill/search independent removal, source/search preservation on in-flow pill clicks, and stable reading anchors. Empty results retain all active layers.
- **Automatic frame**: no app/content header or manual panel controls; both panels shrink to the same minimum and retract/expand at the same calculated threshold. An unfiltered or query/search-only flow shows the instance summary; a project/action focus replaces it, and clearing that focus restores it without moving the Reader. Resize around the fit threshold and workspace cap, including 1920px desktop and 2560px/3440px wide viewports; the Reader stays anchored and exposed panel edges are finished. Layout changes preserve state/history, and hidden panels cannot receive focus.
- **Control pill**: its own view picker, search, More/inspection, and instance/entity summary popovers work without opening a side panel. The unfiltered instance summary is available through More without adding a filter chip. Only one control interface is active. Check centered, content-sized placement, viewport and safe-area bounds, scrolling persistence, bottom reading clearance, keyboard dismissal/focus restoration, and search-draft/result-selection continuity when Navigation docks or retracts.
- **Navigation and pins**: native Entries/Actions/Overview work through either interface without custom views; pin restoration leaves filters mutable, subsequent browsing does not alter the pin, selection matches captured state, unpin leaves the view open, and instance changes isolate pins and remembered state.
- **Native records and action review**: Overview, project, and action pages render authored bodies, metadata once, relationships, foldable complete censuses, and context links. The separate action timeline shows its date axis/direction, undated items, schedule/deadline facts and lifecycle without requiring a custom query.
- **Entry jump**: entry references retain cross-pill navigation and flash the target, loading pages as needed. Query/search-excluded targets offer explicit default-flow navigation; global entry lookup navigates directly, removing excluding browsing filters in one visit. Back restores the preceding state.
- **Content pages and history**: record, artifact, and file links replace the main surface; deep links restore on cold load. Back/Forward restore instance, source/variables, focus, visible search, sort and reading anchor. Source/pill/date changes and applied or cleared search add visits; draft lookup typing leaves the visit unchanged. Record pages retain their originating flow as return context.
- **Artifacts**: names and handles, indexed attachments, implicit file content, empty bodies, images, generic downloads, inline backlinks, literal code, and live body/attachment/media changes. View details exposes source/query settings read-only.
- **Full-page HTML**: explicit HTML attachments/raw files, implicit single-HTML-attachment previews, and cold links fill the app viewport without a native document wrapper, workspace cap, or side panels. The pill remains visible at 390px, 1920px, and 3440px and provides complete navigation. Inspect retains source/metadata/attachments/context; returning to native views restores their automatic layout and preceding flow state/anchor. Sandboxing and GraphQL boundaries remain intact; inline Markdown iframe embeds retain their authored/default dimensions and containing view's layout.
- **Date smart elements**: ISO date/time/offset, bracketed named zones and interval validation, daylight-saving transitions, bare handles in natural prose, literal code/escapes and ordinary links, browser-zone conversion, live date/time-style and clock updates, copy handles, native date routes, originating-flow restoration, independent query/pill/search preservation, and history navigation
- **Search**: grouped capped results with "+N more" expansion, arrow/Enter keyboard selection, direct lookup navigation, explicit Search this flow activation, a quoted filter chip in Navigation or the Control pill, independent removal, and current-draft activation during debounce. Global lookup text never becomes a filter chip.
- **Dark mode**: Appearance through More in either interface, system preference default, persistence
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

End-to-end against a local instance: load app → verify entry count matches the instance → filter by project → verify count matches validation script → search for a known term → verify matches grep → open the action record page → verify fields match the file → return to the same flow state and position. Scriptable through browser tooling.

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
sidebar labels, calendar labels, week-failure headings/retry labels, and visible
search date/entry result names. Existing readers, folds, focus, media, scroll
position and search selection remain in place. Authored Markdown link labels
and prose, record IDs and routes retain their content. Raw source values remain
verbatim in ID fields, exact-ID search-match fallbacks, handles and their source
hover text, machine attributes, recurrence rules, diagnostic details/file paths,
and date-entry input syntax. Relative ages and countdowns remain relative distances.
