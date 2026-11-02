# Webapp Gallery

Run every page of the real Aside webapp against repeatable local demo data:

```sh
npm ci --prefix cli
npm ci --prefix webapp
cd webapp
npm run mock
```

Run the install commands from the repository root. The server uses both the webapp build dependencies and the CLI's data core and GraphQL dependencies.

Open the `/__mock/` URL printed by the server. The sidebar groups scenarios by page, with each page's states nested beneath it. Expand a page to choose a state, or search by page or state name. The selected state's page opens automatically, and your expanded sections stay open as you browse.

Choose **Elements → All elements** to compare icons, status pills, references, buttons, form controls and notices in compact rows. Hover icons and color swatches for their names. This dedicated development page uses the application's CSS and renderers and follows the gallery's theme and viewport controls.

The compact toolbar controls the preview theme and viewport: **Fill** uses the available space, **Tablet** is 768 pixels wide, and **Mobile** is 390 pixels wide. Previews use the full available height at native size. Collapse the sidebar to give the app more room.

The gallery URL records the selection so it can be bookmarked or shared with someone running this checkout. Reset recreates the scenario; Recover removes its simulated faults so the app's retry controls can be exercised.

The default URL is `http://127.0.0.1:24801/__mock/`. Pass `npm run mock -- --port 24802` to use another port, or add `--no-watch` to build once. Application and gallery source changes rebuild while watch mode is active; fixture file edits take effect on Reset.

The mock server runs independently of the Aside daemon and uses fixture files under this directory. It does not register or edit a real instance. Each preview uses its own mock session for data requests and simulated faults.

## Staging boundaries

| Layer | Location | Responsibility |
| --- | --- | --- |
| Page | `scenarios.ts`, `gallery/` | Select a real route and describe real UI actions such as opening settings or typing a search. |
| Data | `fixtures/`, `fixture-store.ts` | Supply ordinary Aside Markdown, YAML indexes, records, relationships, and attachment bytes. The existing data core parses the files and derives snapshots. |
| Environment | `environment.ts`, `server.mjs` | Fix the clock and control authentication, connection state, latency, failures, and recovery per preview session. |

The `environment.ts` bootstrap initializes frame-local preferences and performs the declared page actions before reporting readiness to the gallery. Setup waits for startup, diagrams, visible media, fonts, finite animations, and scroll geometry to settle. The previous preview stays visible until its replacement is ready, so intermediate setup does not flash on screen. Startup autofocus waits until the frame is visible; a focus-dependent state reveals its settled base page before taking focus. Normal app interactions retain their animation setting, and intentional loading states remain visible.

The production app continues to calculate status marks, counts, empty states, search results, and rendering. Scenarios do not replace component output or inject demonstration markup into the app. The gallery and its bootstrap are development entry points; production app and SDK bundles do not import mock modules or fixtures.

The Elements page is a separate `kind: 'elements'` scenario at `/__mock/elements/`, with its own shell and browser entry under `elements/`. It shares the session bootstrap and production stylesheet; the icon catalogue is collected from production sources at build time through `icon-catalogue.mjs`. It does not add a production app route or manufacture an instance page.

`server.mjs` serves the app's ordinary `/-/api/` endpoints and signed file URLs. Its Node-only `runtime.mjs` entry uses the existing data core and read-only GraphQL implementation through an immutable fixture adapter, without constructing a writable store or accessing daemon state. The `node-clock.mjs` module uses `AsyncLocalStorage` to give concurrent GraphQL queries their session's fixed clock; the browser bootstrap fixes time independently inside each preview. Preview session IDs isolate fixture selection, mutable catalogue changes, held requests, failures, and recovery. The server listens on loopback and confines file reads to fixture directories.

## What to inspect

The scenario catalogue covers the instance chooser and registration flow, unfiltered and filtered timelines, instance/project/action/entry details, date navigation, search, settings, onboarding, diagnostics, and reader formats. It includes loading, empty, unavailable, authentication, reconnecting, and retry states. Every scenario includes a short description of the state it stages.

The showcase instance tells one connected Aurora launch story, with nested projects, cross references, a spread of action statuses, deadlines, schedules, recurrence, notes, and artifact backlinks. Its specimen documents include:

- Typography: heading levels 1–6, paragraphs, emphasis, strong and struck text, nested and task lists, blockquotes, rules, inline code, fenced code, tables, Unicode, emoji, and long content.
- References: project/action/entry/artifact links, dates and date ranges, labels, and long names.
- Diagrams: Mermaid flowchart, sequence, state, class, entity relationship, mindmap, Gantt, pie, journey, timeline, Git graph, quadrant, XY chart, Sankey, requirements, and block diagrams, plus mathematical labels and wide layouts. A separate recovery specimen contains an intentionally invalid diagram with readable source and Retry, followed by a valid diagram.
- Readers: Markdown, images, PDF, audio, captioned video, text/source, downloads, and an interactive HTML dashboard using the real read-only GraphQL implementation.

The separate empty and malformed fixtures provide genuinely different data worlds. Fault scenarios reuse the showcase data and vary the transport conditions instead of manufacturing different application output.

## Adding a scenario

1. Reuse the showcase fixture unless a different underlying dataset is essential.
2. Add a uniquely named entry to `scenarios.ts` with a label, group, description, route, fixture, and fixed `now`, and add its page/state to `gallery/catalogue.ts`.
3. Add `actions` only for UI state that cannot be represented by a route. Use existing control selectors and wait for real controls to become available.
4. Put content changes in the fixture files and runtime failures in `faults`.
5. Check the scenario in both themes and a narrow viewport. Use Reset to confirm it starts consistently and Recover to verify retry behavior.

Keep attachment dependencies local so the gallery works without external services. Use the existing production renderer and read-only query boundary for new content types.

## Verification

```sh
cd webapp
npm run test:mock
npm run build
```

The mock tests exercise the HTTP catalogue and session contract, parsed fixture snapshots, GraphQL filtering and pagination, session isolation and recovery, file validators/ranges and path confinement, and the production bundle boundary. Review Mermaid layout, PDF/media playback, iframe isolation, responsive layout, and visual appearance in a browser.
