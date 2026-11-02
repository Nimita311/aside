# Record Model

`DataCore` in `cli/src/core/data-core.ts` owns parsed records, indexes, diagnostics,
completeness, relationship derivation and query caches. It has no Node or DOM
dependency. Markdown and YAML files remain authoritative.

The current app runs one core per instance in the CLI daemon, shared by MCP and
HTTP. Browser tabs use `RemoteStore`: a presentation cache of JSON snapshots from
`/-/api/instances/<id>/data`, including the graph and filtered week lists. Tabs do
not parse record files or derive the graph. The daemon caches the captured snapshot
and its serialized response until a record, index or diagnostic changes; unchanged
polls return 304 without copying or serializing the corpus. Raw file transport
supplies displayed supporting text and media.

| Module | Owns |
|---|---|
| `data-core.ts` | Parsed state, loading, diagnostics, refresh staging, completeness, and queries. |
| `data-source.ts` | Pluggable asynchronous file reads and static URL adapter. |
| `data-snapshot.ts` | Browser view contract and JSON snapshot shape. |
| `types.ts`, `parser.ts` | Record and collection types, tolerant parsing, and parse issues. |
| `record-reference.ts` | Record handles, root-relative record paths, entry references, and relative asset links. |
| `record-model.ts` | The loaded record collection, artifact source context, and relationship graph. |
| `artifact-reference.ts`, `artifact-traversal.ts` | Artifact handles, record reference extraction, implicit file content, and attachment target validation. |

Entries retain the extension-free weekly file ID in both disk and browser loads.
Entry navigation includes metadata tags and inline mentions. Project/action
co-occurrence and entry asset associations come from metadata tags only. Explicit
project links retain both declared and reverse directions. Referenced artifact
attachments associate their parent artifact with context. Artifact and attachment
backlinks remain specific to the exact target. Files never originate references;
relationship derivation never reads attachment contents. Self-references,
invalid handles, and handles inside Markdown code create no artifact relationships.

Relationship ID lists use reverse lexical order. Explicit project links use that
order with declared links before reverse links to the same project. Duplicate asset
paths retain the newest entry's link text before entity-body links. Results are
independent of discovery and fetch completion order.

Artifact traversal requests exact attachment paths from its caller. The disk
adapter in `artifact.ts` validates containment, exact ordinary files, and prospective
imports without reading file contents. Browser relationships use indexed record
metadata; explicit file reads remain separate addressable assets. Filesystem discovery, attachment inventory reconciliation,
writes and watching belong to the daemon adapter in `mcp/store.ts`. It hydrates and updates the core
synchronously, so reads immediately after an MCP write see the new state.
Atomic file replacements preserve the existing file's POSIX permission bits;
temporary replacements are owner-only while content is written. New files use
the process umask.

For a static host, `webapp/lib/static-store.ts` exports `loadStaticStore(baseUrl,
years?)`. The separately built `dist/static-data.js` module runs the same core in
the browser over `UrlDataSource`, without daemon endpoints. Explicit years support
archives outside the default five-year probe window. The core discovers indexed
records, loads weeks on demand, and revalidates selected records and displayed files
using ETag, Last-Modified or a content hash. `snapshot()` can also supply a static
build's JSON. This optional module is absent from the current app's runtime imports;
a static webpage entry point can use its store through the same `StoreView` contract.

Rendering, display-time calculations, search UI, MCP formatting, calendar operations
and transport protocols remain consumer concerns.

Materialized recurrence actions inherit the live project associations of their
[template](recurrence.md#materialization); their own entries can add associations.
Projections remain outside the stored graph.
