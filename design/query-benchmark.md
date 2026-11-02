# Canonical query benchmark

Run from `cli/`:

```sh
npm run bench:queries
npm run bench:queries -- --sizes 100,1000,5000 --samples 20 --warmup 3
npm run bench:queries -- --sizes 1000 --page-size 20 --output .cache/bench/pages-20.json
npm run bench:queries -- --sizes 10000 --cache after-write --output .cache/bench/after-write.json
npm run bench:queries -- --sizes 10000 --cache after-record-write --output .cache/bench/after-record-write.json
npm run bench:queries -- --sizes 5000 --fanout 8 --page-size 20 --output .cache/bench/dense.json
npm run bench:queries -- --sizes 5000 --body-bytes 4096 --allow-limits --output .cache/bench/large-bodies.json
npm run bench:queries -- --sizes 10000 --cases action-id-batch,entries-via-open-work --cpu-profile .cache/bench/query-cpu
```

No new dependencies are needed. The runner builds its own source bundle and
regex worker with the existing esbuild dependency. It writes JSON and Markdown
reports under `.cache/bench/` by default. `--help` lists parameters and case IDs.

The default `backend` mode calls the production query handlers, shared argument
validation, GraphQL executor, and actual regex worker pool. It models the same
MCP result shape but excludes session discovery, daemon sockets, and stdio.
For complete MCP transport measurements:

```sh
npm run build
npm run bench:queries -- --transport stdio --sizes 100,1000 --samples 20
```

Stdio mode connects two real MCP clients to the same disposable instance and
isolated daemon: one default GraphQL surface and one opt-in `--legacy` surface. Calendar access
is disabled. It stops its own daemon and removes its own temporary fixture after
each size. Neither mode reads or writes the user's productivity data. Fixture
generation uses Aside's existing Markdown/YAML persistence format.

## Workloads

| Case | Canonical question | Legacy plan |
| --- | --- | --- |
| `project-catch-up` | One project's body, unfinished actions, latest three entries, artifacts, and related projects | Batch independent entity queries; merge metadata-tagged entries with inline-reference search; fetch forward/reverse related-project targets |
| `overdue-open-projects` | Unfinished actions with deadlines through the cutoff, in any open project | Fetch open projects, then filter actions by their IDs; join returned project names |
| `unassigned-actions` | Actions with no associated project | Query actions with `projects: []` |
| `artifacts-for-unfinished-actions` | Artifacts directly associated with unfinished actions | Fetch unfinished action IDs, then filter artifacts by those IDs |
| `artifacts-via-project-work` | Artifacts associated with projects that have unfinished actions | Fetch unfinished actions and their project associations, then query artifacts by project IDs |
| `stalled-projects` | Open projects with unfinished actions and no entry since the cutoff | Batch open projects, unfinished actions, and recent entry content; compute memberships and exclude projects with recent tagged or inline entries |
| `project-action-regex` | Unfinished review/migration actions within one project | One action query with the same association, lifecycle, and regex filters |
| `exact-project` | One project ID/name | One exact-ID metadata query |
| `action-id-batch` | Unfinished actions in an explicit half-dataset ID batch | One exhaustive filtered action query |
| `empty-result` | A nonexistent action ID | One exact-ID query |
| `all-action-index` | Every action ID/description | Exhaustive index query |
| `project-entry-history` | All entries linked to one project, with nested pagination | Batch tagged entries and inline-reference search; deduplicate |
| `recent-entry-regex` | Recent entries with progress numbers ending in zero, full content | One exhaustive date-filtered regex query |
| `entries-via-open-work` | Entries whose tagged action belongs to any open project | Query open projects, their actions, then action-tagged entries |
| `related-open-projects` | Projects with a declared/reverse link to open work | Read project metadata, then compute both link directions |
| `boolean-action-filter` | Unfinished actions that are overdue or unassigned | Batch two filtered action queries and deduplicate |
| `dashboard-counts` | Open projects, unfinished actions, recent entries, artifacts | Four independent one-row queries; take total from each header |

Dates are fixed (`deadline_to: 2026-06-09`, recent since `2026-06-09`). Queries
are stored in `cli/bench/cases.ts` and `cli/bench/extended-cases.ts` and copied into each JSON report. Every workflow
starts without a client-side data cache. Independent legacy requests run in
parallel; dependent joins and cursor/offset continuations remain sequential.
These are concrete batched legacy plans, not a deliberately naive N+1 baseline.
They are not a claim that no alternative plan could perform better.

All required root collections are paginated to completion. Project catch-up
intentionally returns only the latest three entries; its other nested lists
use `first: 100` and fixture fan-out stays below that bound. The project-specific
regex case also has bounded fan-out. Empty join inputs short-circuit before a
legacy relationship filter, because `[]` means unassociated records.

Synthetic sizes refer to entry counts. The fixture has roughly one project per
ten entries, four actions and two artifacts per project, plus unassigned actions.
It includes open/closed projects, backlog/scheduled/done/cancelled actions,
shared metadata associations, recent/old entries, inline-only project references,
forward/reverse related projects, and artifacts associated with completed work
that are still relevant through another unfinished action on the project.
Artifact handles inside code create no artifact associations. Sizes are accepted
from 40 through 100,000 entries; large workloads can hit production query/search
limits. By default these fail the run. `--allow-limits` records recognized work,
response, request-size, document-token, and regex-snapshot capacity errors as LIMIT
with no timing score, and continues other cases/interfaces. Every error in a
response must be a recognized limit. Unknown errors, diagnostics, and
oracle mismatches still fail. An incomplete answer never counts as a fast result.

`--fanout 1–8` tags additional nearby projects on non-orphan entries, increasing
project/action and artifact/project overlap without changing persistence rules.
The bound keeps catch-up's 100-row nested lists exhaustive. `--body-bytes` appends
up to 65,536 ASCII bytes to each body/content, exercising serialization and
regex snapshot capacity. `--page-size` changes exhaustive collection pagination,
including the nested project-entry-history connection.

The fixture constructs an independent expected graph from the authored records.
Both interfaces must match its complete normalized answer on every warmup and
measured successful iteration. Except for explicitly allowed capacity errors, an
error, parse diagnostic, missing row, or wrong relationship fails the run. Legacy records are parsed from returned tool text; plans do not
consult Store's relationships or read record files to perform joins. Small-dataset
correctness and five-row pagination checks also run in the CLI test suite.

## Measurements

- Workflow p50/p95, mean, minimum, maximum, and raw samples, in milliseconds.
- Tool-call count and dependency rounds; pagination adds actual calls and rounds.
- Request bytes, response text bytes, and serialized MCP result bytes.
- Call-duration sum per sample, separate from total workflow time (parallel calls
  can overlap, so their sum may exceed workflow time).
- Fixture generation/store load time, record counts, Node/OS/CPU details, Git
  revision, dirty state, run settings, and query documents.

Timing includes query execution, response handling, and deterministic client
joins. It excludes fixture generation, initial store loading, daemon/server
startup, schema discovery, and LLM inference. The filesystem is warm after
fixture generation; store-load time is not a cold disk measurement. Measured
interface order alternates to reduce systematic JIT/cache/GC bias.

`--cache warm` allows production snapshot and complete-root-match caches to warm
with the configured warmups. `--cache after-write` performs a real description-only
project write before **each interface's workflow**, using its unchanged fixture
description to preserve the oracle. This advances the actual Store revision;
the optimized index-only refresh retains metadata and non-regex matches while
refreshing descriptions. `--cache after-record-write` rewrites the project name
with its unchanged fixture value instead, replacing record metadata, deriving
the graph again, and invalidating all matches. Subsequent pages of that workflow
may reuse the rebuilt snapshot/result. The preparing write is excluded from workflow latency and saved
as `prepareMs` in each raw sample. This models reads after a write, not cold disk
or daemon startup; it does not measure mutation/calendar latency.

`--cpu-profile <base>` saves a V8 CPU profile per size and reports the largest
self-time frames. It requires backend transport, because the stdio runner is a
client process. Profiles include both interfaces, warmups, client normalization,
and preparing writes, and exclude fixture generation/initial Store loading.
Regex worker-thread execution is not in the main-thread profile. Profiling adds
overhead; compare like-for-like runs and verify important findings without it.

Response bytes use UTF-8 and count the application-level MCP result object.
GraphQL currently returns both a JSON text block and `structuredContent`, so
both copies count in that metric; `responseTextBytes` exposes the text-only
view separately. JSON-RPC framing and protocol/session negotiation are excluded.
Byte counts are not token counts, and dependency rounds are not measured model
reasoning turns. This benchmark does not evaluate agent answer accuracy or LLM
reasoning latency.

Quantiles use nearest rank. Ten samples are a quick local comparison; use more
samples on an otherwise quiet machine for latency conclusions. The benchmark
imposes no timing thresholds in CI. GraphQL may reduce calls or payload size
while taking more backend CPU, especially for a query the legacy interface can
already express in one call. Keep those dimensions separate when interpreting
results.

## Snapshot reuse results

On 2026-10-08, the canonical runs below used Node v26.7.0 on an Apple M3 Ultra,
5,000 entries (500 projects, 2,200 actions, 1,000 artifacts), real stdio MCP,
20 measured samples after three warmups, and 100-row pages. All complete answers
matched the oracle in both runs. Times are workflow p50 in milliseconds.

| Case | GraphQL before | GraphQL with snapshot reuse | Legacy in optimized run |
| --- | ---: | ---: | ---: |
| Project catch-up | 18.68 | 2.20 | 12.79 |
| Overdue actions in open projects | 101.55 | 17.35 | 46.59 |
| Unassigned actions | 38.62 | 6.50 | 7.42 |
| Artifacts for unfinished actions | 97.17 | 11.54 | 17.12 |
| Artifacts via project work | 203.32 | 27.03 | 83.79 |
| Stalled projects | 20.13 | 3.31 | 120.16 |
| Project action regex | 17.12 | 0.56 | 0.97 |

Profiling before the change attributed 16.84 ms of a 17.51 ms project-action
regex request to copying records and checking relationships. GraphQL now reuses
one read snapshot per Store revision. This initial optimization still evaluated
filters and regex searches for each request, including each pagination request;
the expanded benchmark below motivated further result reuse. The first read
after a write or external rebuild creates a new snapshot; these warm measurements
do not represent that first-read cost. Active reads retain their older snapshot.
In that initial implementation, descriptions, attachment metadata, and diagnostics
all invalidated the entire snapshot.

The initial 100-entry run showed a small GraphQL overhead for unassigned actions (0.89 ms
versus 0.69 ms). These local measurements describe this fixture and machine;
they are not timing guarantees. Before/after raw reports are generated in
`.cache/bench/stdio-results.json` and `.cache/bench/stdio-optimized-results.json`;
corresponding backend-only reports are `backend-results.json` and
`backend-optimized-results.json`. Reports are local ignored output, not fixtures.

## Expanded benchmark findings

The expanded matrix has 17 goals, with correctness coverage at 40/100/301 entries
(including fanout 8 and 4 KiB padding), timing runs at 1,000/10,000 entries,
5,000-entry dense and padded runs, and a 20,000-entry dense stress run. The runner
also separates warm reads, index-only writes, and record/graph-changing writes.

Profiling identified unconditional date checks and linear ID membership in every
record evaluation, repeated sorting and joins on every page, character traversal
of ID strings during regex detection, and eager relationship-scope construction
for predicates with no regex. The executor now compiles only relevant scalar
checks, uses ID sets/direct lookup, reuses ordering and bounded complete root
matches, treats strings as scalar values, and evaluates pure relationship
predicates lazily. Regex scopes and worker budgets remain intact.

At 10,000 entries, the original expanded backend run versus the optimized run
showed these warm p50 improvements (ms; same machine/fixture/100-row pages,
both CPU-profiled, ten samples after two warmups):

| Goal | Before | After |
| --- | ---: | ---: |
| Large action ID batch | 414.77 | 13.83 |
| All action IDs/descriptions | 111.97 | 9.75 |
| Entries via open project work | 1248.17 | 16.85 |
| Boolean action filter | 207.55 | 4.50 |
| Dashboard counts | 6.14 | 1.79 |

A final targeted profile run (20 samples, three warmups) confirmed 15.12, 9.47,
16.66, 4.83, and 1.83 ms respectively. Raw reports/profile paths are in
`expanded-before.json`, `expanded-final.json`, and `bottlenecks-final.json` under
`.cache/bench/`. Profiles include client normalization and both interfaces.

The unprofiled real MCP run returned complete correct answers for all 17 goals.
At 10,000 entries every GraphQL workflow beat its legacy plan. Selected p50 values:

| Goal | GraphQL | Legacy |
| --- | ---: | ---: |
| Large action ID batch | 27.33 | 75.02 |
| All action IDs/descriptions | 26.31 | 45.70 |
| Entries via open project work | 42.30 | 244.33 |
| Boolean action filter | 10.86 | 65.74 |

Small-data framework overhead remains: at 1,000 entries the exact project,
empty-result, and action-index goals took 0.61/0.50/3.41 ms in GraphQL versus
0.49/0.39/2.35 ms in legacy. The complete transport report is
`expanded-stdio-final.json` (ten samples, two warmups).

The 5,000-entry dense run used eight project tags per associated entry and 20-row
pages. All 17 goals matched the oracle. The 20,000-entry dense artifact/entry
joins initially hit the work limit because of the eager scope prepass; after
removing it they completed at 10.08/40.05 ms versus 503.97/799.48 ms in legacy.
The original and repaired stress reports are `large-dense-before.json` and
`large-dense-final.json`; budgets were not raised.

With 4 KiB padding at 5,000 entries, legacy catch-up and full project history
exceeded the regex snapshot bound, while their scoped GraphQL plans completed.
These are explicit LIMIT results, with no timing score, in `large-bodies-final.json`.

Index-only refreshes now retain metadata and non-regex matches while updating
cached descriptions. Exact-project latency after a description write fell from
41.87 to 0.57 ms (legacy 0.44 ms), in `after-write-before.json` and
`after-write-final.json`. A record rewrite still rebuilds the full snapshot:
at 10,000 entries an exact-project read took 17.43 ms versus legacy 0.65 ms.
This is the remaining cold-read bottleneck, recorded separately in
`after-record-write-final.json`. Preparing write time is excluded from both.

Correctness tests exercise actual record rewrites, dense overlap, large bodies,
five-row pagination, cached ordering/counts/fragments, description refresh,
eviction, cancellation, scoped regex recomputation, depth limits, and failed
work-limit evaluations. They assert semantic and cache behavior without flaky
wall-clock thresholds.
