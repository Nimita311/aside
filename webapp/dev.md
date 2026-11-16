# Web app development

Run commands from `webapp/`.

- `npm run dev -- --dir /path/to/instance` rebuilds the shell on edits and prints
  its URL through the shared daemon. Build `cli/` first with `npm run build`.
- `npm run mock` serves the isolated gallery of pages, UI states, typography,
  diagrams, and media. See the [mock gallery guide](mock/README.md) for fixtures
  and preview controls.
- `npm run build` builds the app and iframe client.
- `npm test` runs typechecking and the rendering and interaction tests.

The [entity styles specimen](mock/entity-forms.html) is the finalized visual
reference for metadata, prose, list, and title forms.

The [interface design](../design/interfaces.md) defines browsing, presentation,
and browser isolation. [URL shapes](../reference/urls.md) and
[configuration](../reference/configuration.md) describe implemented interfaces.

## Visual verification

Verify every UI change in a browser before calling it complete:

1. Build `cli/`, then run the development server against a local test instance.
2. Run `aside show` or open the reported local HTTP URL.
3. Capture screenshots before and after, exercise affected interactions, and
   check the relevant viewport sizes and UI states.
4. Confirm behavior and visible layout, including focus and reading position.

Use isolated test data for writes. Unit tests complement screenshots; they do
not establish visual correctness. The mock gallery provides isolated display
fixtures. Animation geometry tests and the browser flight harness live under
`test/`; run instructions are in `test/flip-flight.validate.mjs`.
