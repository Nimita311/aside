# Local semantic search benchmark

Measured on October 28, 2026. This benchmark exercises the production semantic search service against real, synthetic Aside Markdown files. It compares the selected dense retrieval path, an internal hybrid comparator, and the existing regex worker. It does not generate LLM answers.

These measurements precede the unified GraphQL `search` filter/ranking adapter.
The raw files retain the exact measured source hashes. The adapter now reuses
entity predicates to preselect source handles and delegates ranking to the same
service; its filter parity, global pagination, and counts are verified separately
by API and native retrieval tests. These timings do not include the new adapter
or the additional source/model checks added during critical review. Rerun the
current harness for current end-to-end latency measurements.

The selected configuration is local Qwen3 Embedding 0.6B, 1,024-dimensional vectors, dense cosine retrieval, and an explicit 8,192-token inference context. On the 300-record fixture it retrieved a relevant record first for all 24 queries and achieved 91.7% Recall@10 on paraphrases. Warm service latency was 69.6 ms p50 / 71.7 ms p95 on this M3 Ultra. These are measured smoke-test results, subject to the corpus and hardware limits below.

## Selected 8K configuration

Raw measurements: [300 records](../cli/bench/semantic-selected-results.json) and [3,000 records](../cli/bench/semantic-selected-scale-results.json).

| Query group, 300 records | Queries | Recall@5 | Recall@10 | MRR@10 | nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Natural-language paraphrases | 12 | 0.889 | 0.917 | 1.000 | 0.869 |
| Exact project names | 12 | 1.000 | 1.000 | 1.000 | 0.710 |
| All queries | 24 | 0.944 | 0.958 | 1.000 | 0.789 |

The initial 300-chunk build plus one query took 4.29 seconds, or 69.9 chunks/second. Reopening the persisted index with a new service object took 69.2 ms and embedded only the new query, with zero document embeddings. A one-action edit and query took 86.6 ms and embedded exactly two texts: the changed passage and the query. The edited action appeared in the top ten. Node RSS peaked at 180.5 MiB, separately from Ollama’s reported 1.62 GiB loaded-model allocation.

| Selected Qwen 8K configuration | 300 records / chunks | 3,000 records / chunks |
| --- | ---: | ---: |
| First build plus one query | 4.29 s | 42.64 s |
| Initial chunks/second | 69.9 | 70.4 |
| Warm p50 / p95, all 24 queries | 69.6 / 71.7 ms | 100.2 / 108.3 ms |
| Node peak RSS | 180.5 MiB | 296.8 MiB |
| Reopen persisted index, including query | 69.2 ms | 108.6 ms |
| Changed action plus query | 86.6 ms | 179.9 ms |
| Document texts re-embedded on reopen | 0 | 0 |
| Document texts embedded after one edit | 1 | 1 |

The 3,000-record run still put a relevant record first for all 24 queries. Paraphrase Recall@10 fell to 0.833 as more template distractors competed with lower-ranked associated records; exact-name Recall@10 remained 1.000. The increasing warm latency reflects corpus reconstruction, hashing, stored chunk-ID reads, and exact vector scans. This workload supports an initial local personal corpus; it does not establish acceptable performance for hundreds of thousands of chunks. Larger deployments need separate profiling, revision-aware corpus caching, and a decision about native approximate indexes.

## Exploratory model and retrieval comparison

[Original three-model results](../cli/bench/semantic-results.json) used the same 300-record fixture. Qwen initially inherited Ollama’s 32K context; BGE-M3 and MiniLM used their own defaults. The final 8K Qwen run reproduced the same relevance metrics. Older raw files retain the precise source hashes from their measurement; later error-message and cancellation-guard changes do not change this successful retrieval path.

| Paraphrase retrieval | Recall@5 | Recall@10 | MRR@10 | nDCG@10 |
| --- | ---: | ---: | ---: | ---: |
| Hand-authored regex | 0.167 | 0.167 | 0.417 | 0.281 |
| Qwen3 Embedding 0.6B, dense | 0.889 | 0.917 | 1.000 | 0.869 |
| BGE-M3, dense | 0.694 | 0.806 | 0.929 | 0.776 |
| all-MiniLM, dense | 0.750 | 0.833 | 1.000 | 0.762 |

Regex, Qwen, and MiniLM each achieved 1.000 Recall@10 on exact names; BGE-M3 achieved 0.972. Dense semantic retrieval helps with the authored paraphrases; regex remains much cheaper for exact matching.

| Original run, 300 chunks | Dimensions | First build + query | Initial chunks/s | Warm p50 / p95, all queries | Node peak RSS | Ollama reported allocation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Regex | — | — | — | 0.18 / 0.25 ms | not isolated | — |
| Qwen3 Embedding 0.6B, 32K | 1,024 | 4.36 s | 68.9 | 65.9 / 77.8 ms | 183.2 MiB | 4.44 GiB |
| BGE-M3 | 1,024 | 4.65 s | 64.5 | 61.9 / 66.6 ms | 186.1 MiB | 0.64 GiB |
| all-MiniLM | 384 | 1.56 s | 192.8 | 56.2 / 60.2 ms | 167.4 MiB | 0.024 GiB |

The equal-weight BM25+dense hybrid comparator reduced paraphrase Recall@10 to 0.528 for Qwen, 0.389 for BGE-M3, and 0.306 for MiniLM. Common words and lexical matches can displace useful semantic results. Dense retrieval therefore remains the production default. Fusion weights and stopword rules were not tuned to these twelve questions. A future hybrid path needs held-out evaluation before adoption.

MiniLM is a useful lightweight baseline on this small English fixture. These results do not establish its quality on longer, multilingual, or domain-specific corpora, and do not establish a universal model ranking.

## Context allocation probe

The [reproducible probe](../cli/bench/semantic-context.mjs) and [raw measurements](../cli/bench/semantic-context-results.json) explain Qwen’s initial memory footprint. Ollama reported context length 32,768 and allocation 4,763,083,079 bytes. Sending `options.num_ctx: 8192` reduced its reported allocation to 1,743,089,827 bytes, with identical vectors for the probe’s one short sentence (maximum absolute difference 0). The first request after the context change included a model reload and took 568 ms; this is not steady-state query latency.

The production adapter now bounds Qwen’s context to 8K and keeps `truncate: false`, so overlong model inputs fail explicitly. The final judged benchmark verifies the actual bounded adapter, rather than extrapolating from this one-sentence probe. Reported allocation is separate from independently measured process memory.

## Reproduce

Install the CLI dependencies, run a local Ollama service, and explicitly download the models:

```sh
ollama pull qwen3-embedding:0.6b
ollama pull bge-m3
ollama pull all-minilm
cd cli
npm run bench:semantic -- --models qwen3-embedding:0.6b,bge-m3,all-minilm --size 300 --repeats 3 --output bench/semantic-results.json
npm run bench:semantic -- --models qwen3-embedding:0.6b --size 300 --repeats 3 --output bench/semantic-selected-results.json
npm run bench:semantic -- --models qwen3-embedding:0.6b --size 3000 --repeats 3 --output bench/semantic-selected-scale-results.json
node bench/semantic-context.mjs --output bench/semantic-context-results.json
```

The harness does not download models or start Ollama. It creates a disposable directory under the OS temporary directory, loads its Markdown through `Store`, writes separate derived indexes per model, and removes its own fixture/index directory afterward. `--keep` retains that directory for inspection. `--url` selects a different Ollama endpoint. Only synthetic text is embedded. Existing personal Aside instances are never opened.

Sources: `cli/bench/semantic-fixture.ts`, `cli/bench/semantic.ts`, and `cli/bench/semantic-run.mjs`. Raw result JSON records query text, authored regex patterns, returned handles, per-query latency samples, model weight digest, dimensions, source hashes, and runtime versions.

## Method

The judged fixture contains 300 records, each short enough to produce one chunk. Twelve authored topics each have an answer-bearing note entry, a follow-up action, and a broader project overview. The remaining 264 records are unrelated projects, actions, and artifacts. The scale fixture increases the distractors to 2,964 using the same deterministic templates; it measures corpus-size overhead rather than new retrieval domains.

There are twelve natural-language paraphrase questions and twelve exact project-name queries. Relevance is authored before retrieval: matching entry grade 3, action grade 2, project grade 1, everything else grade 0. Recall@5 and Recall@10 count relevant records; MRR@10 measures the first relevant record; nDCG@10 uses the graded judgments. The metrics are averaged equally over queries. Quality is measured once per query; latency runs each query three times.

The regex baseline uses explicit, hand-authored case-insensitive patterns made from the question’s words, or the exact project name. It searches name, description, and body through the production `RegexWorkerPool`. Boolean matches are ordered by newest creation timestamp and then handle. This gives regex a usable query rather than treating a whole natural-language question as a literal pattern. It is a Boolean-search baseline and has no relevance ranking.

The dense path uses `SemanticSearchService` with `retrievalMode: 'semantic'`. Query embeddings preserve the production model-specific instruction hook. The internal `hybrid` mode uses the same stored vectors plus BM25 and reciprocal rank fusion with equal dense/lexical weight. The comparator is not exposed as an additional public search mode. No reranker, query expansion, answer model, or network model provider is involved.

Latency is sequential, single-client, warm-model, end-to-end service time. Every repeated semantic query still performs local embedding inference. Percentiles use nearest rank. Before timing the first search, a separate embedding call loads/warms the model. The first measured search includes embedding all missing chunks, committing LanceDB batches, and retrieving one query. Chunks/second is therefore conservative initial-build throughput, not query throughput or an ANN benchmark.

The implementation currently performs exact LanceDB vector scans. It also reconstructs and hashes the corpus and reads stored chunk IDs on every request; hybrid adds a JavaScript lexical scan. No HNSW/IVF approximate index is built. Scaling numbers include these costs and should not be extrapolated as constant-latency approximate search.

RSS is sampled every 20 ms in the Node process. The same Node process benchmarks successive models, so later RSS includes retained native/runtime allocations. Ollama’s reported loaded-model and GPU allocations are recorded separately; they are not independently measured total service RSS or total machine peak memory. The restart check opens a new service object/connection in the same process against its persisted index. It is not an OS process or machine restart. The edit check appends one sentence to one short action and verifies the changed record appears in the resulting top ten.

## Hardware and limitations

The host has an Apple M3 Ultra, 32 CPU cores, 256 GiB unified memory, macOS 27.0.1, Node.js 26.12.1, Ollama 0.40.12, and LanceDB 0.40.0. This is a high-end desktop. Its latency and memory headroom do not represent an entry-level laptop, CPU-only Linux server, or constrained container. The raw JSON includes runtime versions and model digests.

The corpus is authored, English-only, small, and synthetic. Distractors repeat a limited set of templates. The judgments assume the associated action and project remain useful for every topic query. This is a functional retrieval smoke test with a reproducible timing workload, not an independent public benchmark or evidence that one model universally outperforms another. Long documents, multilingual text, obscure identifiers, adversarial phrasing, query concurrency, filtered search, network deployment, crash recovery, and large-scale ANN behavior are not assessed here. Production decisions should add a larger held-out set of real, permissioned or anonymized queries.

`all-minilm` is a lightweight Ollama baseline. It is not BGE-small. A BGE-small-compatible local inference runner was not configured during this comparison, so no BGE-small measurements are claimed.
