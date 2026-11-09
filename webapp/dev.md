# Web app development

Run commands from `webapp/`.

- `npm run dev -- --dir /path/to/instance` rebuilds the shell on edits and prints
  its URL through the shared daemon. Build `cli/` first with `npm run build`.
- `npm run mock` serves the isolated gallery of pages, UI states, typography,
  diagrams, and media. See the [mock gallery guide](mock/README.md) for fixtures
  and preview controls.
- `npm run build` builds the app and iframe client.
- `npm test` runs typechecking and the rendering and interaction tests.

The [webapp specification](spec.md) defines layout, navigation, data access, and
[visual verification](spec.md#visual-verification). Transition geometry and timing
live in [animation.md](animation.md). The daemon's
[browser authorization](../design/daemon.md#browser-authorization) contract covers
local browser access.
