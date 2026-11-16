# Semantic model-generation benchmark

This benchmark measures warm semantic retrieval before and after moving model
discovery into lifecycle reconciliation and binding query embeddings to the
index's model generation. Source snapshots are identified by content hashes in
the result artifacts.

Run from `cli/` with the configured Ollama service already running and the model
already installed. Set `BASELINE_REF` to the source version to compare:

```sh
npm run bench:semantic:freshness -- --ref "$BASELINE_REF" --label model-before --output bench/semantic-model-generation-before.json
npm run bench:semantic:freshness -- --label model-after --compare bench/semantic-model-generation-before.json --output bench/semantic-model-generation-after.json
```

The runner builds the selected source and records its bundle SHA256, source
manifest, environment, and workload. The frozen
[baseline artifact](semantic-model-generation-before.json) was
captured before implementation changes. The
[after artifact](semantic-model-generation-after.json) records the
optimized source directly before timing.

After lifecycle setup, the harness requires exactly one completed generation
directory rather than assuming the generation-key formula. Comparisons require
the same model generation and endpoint origin/base path; URL query parameters
and fragments are not recorded.

The workload and source-refresh measurements follow the
[freshness benchmark methodology](semantic-search-freshness-benchmark.md):
100, 1,000, and 10,000 synthetic saved records; completed LanceDB tables;
deterministic SHA256-seeded vectors with 1,024 dimensions; five warmups; thirty
ranked samples at the smaller sizes and ten at 10,000 records. Each query waits
for lifecycle index readiness and then calls the production search service.
Periodic reconciliation and filesystem watchers are disabled to isolate warmed
retrieval from background work. The filesystem cache remains warm.

Document and query embedding requests, including their transport and inference,
are replaced by in-process deterministic vectors in both conditions. The
baseline performs real Ollama `/api/tags` requests during retrieval. The new
implementation resolves and verifies a real native Ollama model generation
before synthetic indexing; the synthetic generation captures that identity and
supplies deterministic vectors. Model discovery, generation capability checks,
initial indexing, and source refresh are outside the timed retrieval phase.
Nothing is downloaded and no service is started by the benchmark.

Indexes created before generation pinning are rebuilt once in the new generation
namespace; their vectors are not reused across that boundary. This initial
rebuild is excluded from warm retrieval timings.

Warm queries must preserve source/index file metadata and native versions,
perform no document inference or source rebuilds, and return identical ranked
handles within each run and across revisions. The new implementation must also
perform zero model identity requests and zero generation resolutions during
retrieval, with document and query calls using the same captured generation.

Results exclude real embedding requests, GraphQL filtering/serialization,
daemon transport, contention, initial loading, and cold disk behavior. They
measure retrieval mechanics and validation overhead, not whole-request
production latency or semantic quality. Percentiles use nearest rank; component
percentiles must not be added. The 10,000-record p95 is the largest of ten samples.

## Results

Measured on an Apple M3 Ultra (32 cores, 256 GiB), macOS arm64, Node v26.12.1.
The existing local Ollama service was version 0.40.12. Both conditions used `qwen3-embedding:0.6b` at
`http://127.0.0.1:11434` with the same model digest and query instructions.

| Saved records | Warm retrieval median, before → after | Latency reduction | Warm retrieval p95, before → after | Ranked samples per condition |
|---:|---:|---:|---:|---:|
| 100 | 125.18 → 1.09 ms | 99.1% | 131.15 → 1.54 ms | 30 |
| 1,000 | 125.16 → 1.95 ms | 98.4% | 131.08 → 2.26 ms | 30 |
| 10,000 | 128.43 → 5.30 ms | 95.9% | 134.04 → 5.74 ms | 10 |

The baseline made three real model identity requests per warm query. The new
implementation made zero identity requests and zero generation resolutions.
Its lifecycle readiness barrier took 0.003–0.005 ms at the median. All warm
queries returned the same ranked handles as the baseline, embedded no documents,
performed zero source rebuilds, and left source/index file metadata and native
table versions/checkpoints unchanged. The captured document and query generation
identities matched in every optimized fixture.

The remaining 5.30 ms at 10,000 records covers in-process synthetic query-vector
generation, certificate/native index validation, candidate filtering, native
vector ranking, and record deduplication. These stages were not individually
profiled. Real query embedding transport and inference add to this cost.
