# Semantic freshness benchmark

This benchmark compares lifecycle source-refresh cost and the warmed native search
path across source revisions. It uses synthetic Aside records, a completed
LanceDB index, and the running configured Ollama service's real `/api/tags`
responses. It never starts a service, downloads a model, or performs model
inference.

Run from `cli/` with Ollama already running and the configured embedding model
installed. Set `BASELINE_REF` to the source version to compare:

```sh
npm run bench:semantic:freshness -- --ref "$BASELINE_REF" --label before --output bench/semantic-freshness-before.json
npm run bench:semantic:freshness -- --label after --compare bench/semantic-freshness-before.json --output bench/semantic-freshness-after.json
```

`--ref` exports the selected revision into a temporary directory and bundles its
implementation. The benchmark harness stays current, so the two runs execute the
same workload. Timed runs always build the selected source. `--module` is only
accepted with `--refresh-provenance`, which verifies the preserved timed bundle
against both the result and a fresh build before updating source metadata. Output records
the module's SHA256 and a content-hashed manifest of every `cli/src` file, including
untracked additions. It also records hardware, Node version, file count and byte
count. The runner builds under the ignored `.cache/bench` directory and removes
temporary source exports and fixtures.

By default, each size receives five warmups followed by thirty measurements of
`Store.rebuild()` plus source-version access. In the optimized implementation,
this measures background instance maintenance: loading publishes the source hash,
and retrieval reads the already loaded hash. It is not a per-query source refresh.
Ranked queries use thirty samples at 100 and 1,000 records, and ten at 10,000
records. Percentiles use nearest rank.
The operating system's filesystem cache remains warm; no cache flushing or disk
eviction is attempted. Most records occupy separate Markdown files; twelve
entries share one weekly note.

The ranked path calls `SemanticReconciler.ensureCurrent(store)` and then
`SemanticSearchService.search(store, ...)`. The initial lifecycle reconciliation
finishes before measurement. During unchanged optimized queries, the readiness
barrier checks memory and retrieval compares the loaded source hash with the
durable index certificate; neither refreshes source files nor synchronizes the
index. Periodic reconciliation and filesystem watchers are disabled to isolate
retrieval from background work. Query and document vectors are
deterministic SHA256-seeded vectors with 1,024 dimensions. Actual Ollama identity
requests are timed and counted during warmed queries. Index creation is excluded;
its model identity is captured once to avoid hundreds of irrelevant HTTP checks
for synthetic embedding batches.

The harness counts source rebuilds per query and requires zero for implementations
with a loaded source version. It also requires unchanged source hashes within a
run, zero document embeddings during warmed searches, unchanged native table
versions/checkpoints and source/index file metadata, stable ranked handles for
repeated queries, and exactly matching handles between revisions. File metadata
comparisons occur outside the timed queries and include modification/change times
to catch same-content rewrites. The frozen baseline predates the rebuild-count
and file-metadata fields. The vectors measure retrieval mechanics and freshness
overhead, not semantic quality.

Results exclude real query embedding inference, initial indexing, daemon socket
transport, GraphQL filtering and serialization, and cold filesystem behavior.
Component percentiles must not be added together to derive a total percentile;
use the directly measured ranked total. Run the two conditions sequentially on an
otherwise idle machine, with the same model metadata and service configuration.

## Results

Measured on an Apple M3 Ultra (32 cores, 256 GiB), macOS arm64,
Node v26.12.1. The configured model was `qwen3-embedding:0.6b` on the existing
local service at `http://127.0.0.1:11434`. The optimized source manifest is
recorded in the [after results](../cli/bench/semantic-freshness-after.json). The
[before results](../cli/bench/semantic-freshness-before.json) contain the frozen
baseline module hash. The final after run built the measured implementation and
recorded its complete source manifest directly before timing.

Source refresh is measured separately; in the optimized system it belongs to
instance maintenance, outside retrieval. It is not added to ranked query timings.

| Saved records | Source files | Separate source refresh median, before → after | Warm ranked path median, before → after | Ranked latency reduction |
|---:|---:|---:|---:|---:|
| 100 | 94 | 8.04 → 4.53 ms | 184.72 → 126.66 ms | 31.4% |
| 1,000 | 994 | 80.80 → 48.07 ms | 266.28 → 129.46 ms | 51.4% |
| 10,000 | 9,994 | 840.52 → 511.55 ms | 1,172.65 → 133.80 ms | 88.6% |

| Saved records | Warm ranked path p95, before → after | Measured ranked samples per condition |
|---:|---:|---:|
| 100 | 193.02 → 132.18 ms | 30 |
| 1,000 | 275.89 → 133.08 ms | 30 |
| 10,000 | 1,230.54 → 144.30 ms | 10 |

Each warm query made four real identity requests before and three afterward.
All compared queries returned exactly the same ranked handles; no warm query
embedded a document or changed its native table version/checkpoint. Every
optimized query rebuilt zero source files, and source/index file metadata stayed
unchanged across the warmed queries. The loaded-snapshot readiness check took
0.01–0.02 ms at the median for all three sizes. Retrieval compares the loaded
source hash with the index certificate instead of rereading source files or
performing synchronization. Instance lifecycle maintenance owns those operations.

These figures do not include real query embedding inference and are not claims
about whole-request production latency. The three identity requests have a
combined median of about 121–122 ms; real model inference would add to this cost.
The ten-sample large-instance p95 is the largest observed sample, not
a strong estimate of a long-run tail distribution.
