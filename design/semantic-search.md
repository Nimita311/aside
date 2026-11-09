# Semantic search

`Query.search` combines saved entity types in one ordered result. Its `where`
groups reuse the existing `EntryWhere`, `ProjectWhere`, `ActionWhere`, and
`ArtifactWhere` inputs, including regex, relationships, dates, status, and Boolean
composition. Regex remains a case-insensitive ECMAScript filter within each
entity group. The deprecated entity `search` filter remains an alias for `regex`;
supplying both in one entity filter is an error.

Top-level `rankBy` chooses exactly one strategy: `semantic` takes a natural-language
information need and ranks eligible records by dense embedding similarity;
`order` selects creation, schedule, or deadline ordering. The default is
`{order: CREATED_DESC}`. Semantic ranking never interprets input as regex or falls
back to it. Existing typed collection query APIs retain their behavior.

The web app preserves its existing Text search and offers separate Regex and
Semantic choices. Changing mode does not rewrite the query. Async responses
belong to the instance, mode, and query that started them; obsolete responses
cannot replace the user's current results.

## Local setup

Install Ollama 0.40 or newer, start it locally, and explicitly download the default model:

```sh
ollama pull qwen3-embedding:0.6b
```

With Ollama running, use the web app's Semantic mode or ask an agent to query:

```graphql
query {
  search(
    where: { entries: {createdFrom: "2026-10-01"}, projects: {} }
    rankBy: {semantic: "What did we decide about ending the sketch without dialogue?"}
    limit: 10
  ) {
    totalCount count offset model indexedChunks
    hits {
      kind handle snippet score
      record { filePath ... on Entry { content created } ... on Project { name body } }
    }
  }
}
```

The CLI accepts the same query with
`aside graphql query --dir /path/to/instance --document '...'`.
Omit `where` or use `{}` to include all saved kinds. Supplying non-null entity
groups selects only those kinds and unions their filtered records; `{}` within
a group selects all saved records of that kind. Null groups are omitted. Use
the existing per-entity filters to express dates, association predicates,
status, regex, or their Boolean combinations. Their semantics match the typed
collection APIs. Unsaved recurrence projections and attachment bytes are outside
search results; action collections still expose their usual projections.

`limit` and `offset` apply once, after global ordering and record deduplication.
`totalCount` always counts saved records satisfying the filters before ranking
and pagination. Semantic ranking does not impose a hidden match threshold.
Counts-only selections skip ranking inference. Empty semantic pages still
wait for lifecycle index readiness, while skipping query embeddings.
Field-order pages use null scores, a source excerpt, null model, and zero indexed chunks.

Default inference is `http://127.0.0.1:11434` using
`qwen3-embedding:0.6b`. Set `ASIDE_EMBEDDING_URL` and
`ASIDE_EMBEDDING_MODEL` in the daemon's environment to select another Ollama
endpoint or embedding model. Restart an existing daemon after changing those
variables. The runtime never starts Ollama or downloads models automatically.
Unavailable services or models produce actionable errors; regex remains usable.

Qwen uses an 8,192-token inference context for Aside's bounded passages and
queries, reducing memory compared with Ollama's 32K default. Truncation is
disabled; an input that exceeds the configured context fails explicitly.

The packaged native search engine currently supports Apple Silicon on macOS.
LanceDB 0.40 does not publish an Intel Mac binary; the rest of Aside, including
regex search, still builds and runs on Intel Macs.

The daemon schedules indexing when an instance is registered. A semantic query
can still wait for initial indexing or pending changes to finish. The webpage
query timeout remains bounded. Completed batches survive interrupted work and
reconciliation resumes them without repeating unchanged document inference.

## Derived storage and relevance

The shared daemon owns semantic indexing and retrieval. Native LanceDB stores indexes
under the daemon state directory's `search` child, namespaced by canonical
instance path. `ASIDE_DAEMON_HOME` relocates this state together with the rest of
the daemon. These files are private runtime data and can be rebuilt from the
Markdown. No semantic metadata is written into authored files.

Entries are indexed individually rather than as weekly files. Names,
descriptions, and Markdown passages contribute to retrieval. Headings retain
section context; bounded passages keep long records searchable. Model identity,
chunking version, and content hashes govern reuse and invalidation. Registered
instances schedule synchronization through the common instance lifecycle at
startup, after daemon mutation journals (including partially saved operations),
and after direct filesystem edits are loaded. Updates include descriptions, associations,
and deletions, including an entirely empty corpus. Bursts coalesce, failed
updates remain pending, and reconciliation retries without waiting for a search.
The common instance lifecycle owns file watching, startup loading, periodic disk
reconciliation, and retry after failed reads, independently of semantic search.
It publishes a content hash with each completed in-memory snapshot. The index
worker consumes that snapshot and certifies completion only while its loaded
hash remains unchanged. Registered
instances that cannot initially load are retried after repair without a client
request or restart. Load and indexing failures use bounded retry backoff.
No process is started and no model is downloaded automatically.

Reconciliation also reclaims obsolete storage. After removing or replacing
chunks, it atomically overwrites the table with its live rows and existing
vectors, then prunes LanceDB history. This runs before model inference, so
deleted text is reclaimed even during an Ollama outage. Empty sources remove
their index generations. A verified completed model/chunker generation replaces
superseded generation directories. A native-version checkpoint avoids rewriting
unchanged tables and makes interrupted cleanup retry on the next reconciliation.
Maintenance and search share the daemon's serialized native-access queue;
removal closes cached table handles across services before deleting files.
Generations are retired before unlinking, so interrupted deletion is recovered
before opening live tables again.

Forgetting an instance stops its background indexing. The chooser offers
“Clear semantic search cache”; the CLI equivalent is
`aside instance forget --dir <path> --clear-cache`. Explicit removal is persisted
and waits for active clients/tabs to release the instance. Re-registering an
instance with a pending clear completes that removal before indexing resumes.
Otherwise retained caches expire after 30 days unregistered and are removed
lazily on daemon startup, catalogue/status checks, registration changes, or the
last user's release. Offline `instance list` and registry edits also check under
the daemon's startup/lifetime locks. There is no retention cleanup timer.
Registration cancels ordinary expiration and reconciles before semantic reuse.
Legacy unregistered caches start their 30-day clock when first observed; missing
or automatically pruned instances use the same retention policy. Retention
metadata stays in daemon state, outside authored instance files.
Collection failures are isolated per cache and retried on later checks. Once a
registration change and its retention choice are saved, a subsequent reclamation
failure leaves cleanup pending and preserves the successful operation receipt.

A semantic query uses the lifecycle's completed source and model generation. If
background indexing has not caught up, the query waits for synchronization or
returns an explicit failure. It never treats an interrupted index build as
complete. Empty result pages still wait for the lifecycle's loaded-snapshot
readiness without embedding query text; counts-only queries do not require a
ranked result.

Retrieval never reads source files, hashes the corpus, updates vectors, or cleans
index storage. It checks the instance's published in-memory hash against the
completed index binding. Durable certificate, native-version, and cleanup checks
belong to lifecycle reconciliation. Missing or evicted bindings are reported to
the owner for repair. Typed and semantic queries consume the same loaded instance
snapshot; adding diagnostics does not force a source scan.

Source lifecycle refreshes still enumerate and read actual bytes. Identical
bytes reuse isolated parsed values; timestamps do not substitute for reading
content. Attachment inventory, references, diagnostics, and relationships remain
part of loading. Missed watcher events are repaired by this common owner, not by
individual query features.

A completed in-memory index snapshot binds its chunks to an embedding generation.
The lifecycle resolves the configured model name to a full SHA256 manifest digest
at registration and during periodic reconciliation, and verifies digest access
through metadata-only `/api/show`. Multi-manifest models bind the selected child
manifest rather than a runner-dependent parent list. Every document and query embedding addresses
that digest directly. Ollama's native digest resolver is required; requests never
fall back to the configured mutable name. No model copies or extra tags are made.
The index generation namespace also versions this pinning policy. Legacy vectors
created through mutable model names are rebuilt once through digest-bound inference;
their old generations are removed after the replacement completes.

Reconciliation validates the persisted certificate, bound generation, native table
version, and cleanup checkpoint before publishing an index binding. Warm retrieval
checks only loaded memory and performs no model discovery or identity requests.
Handle eviction discards the completed binding; lifecycle reconciliation
restores it before reuse. A model name changing during a build or query cannot
mix weights: the captured digest remains fixed. If that digest has been removed,
retrieval fails explicitly and schedules lifecycle repair. Periodic model discovery
publishes a replacement generation only after its index completes.

Search pins the actual source content and metadata, rather than the watcher's
invalidation counter. A rebuild with identical source data can finish during
inference without aborting the request; real source changes require a retry.
Model generation changes follow the same ownership rule: lifecycle work discovers
them, and retrieval uses the generation already bound to its completed index.
External edits to source or cache storage can remain unnoticed until watcher or
periodic maintenance runs. This exceptional lag is accepted to keep nominal reads
off repeated source and durable-cache freshness checks. Known daemon writes still
notify the lifecycle, and actual persistence/inference operations retain their
write guards and digest validation.
See the [model-generation benchmark](semantic-model-generation-benchmark.md) for
retrieval timings after removing query-time model discovery.

Each saved record appears once with its best passage, preserving global ranking
across record kinds. Scores are cosine similarities, not probabilities or calibrated
confidence thresholds across queries. Use original content through `record`
before drawing conclusions, and cite the canonical handles or file paths.

Semantic similarity alone does not establish that a passage answers the question;
inspect the original content. The connected agent can use retrieved passages for
RAG answers; Aside does not require a separate generative model for search.

## Validation and benchmarking

Deterministic tests cover retrieval/index lifecycle behavior without requiring
Ollama. The reproducible real-model benchmark uses synthetic Aside-shaped
Markdown, authored relevance judgments, and explicit regex queries. It reports
quality separately from latency, initial indexing, cache reuse, incremental
updates, and memory. See [benchmark methodology and results](semantic-search-benchmark.md).
