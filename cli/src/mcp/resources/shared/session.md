## Access and intent

- Use MCP by default for record reads, writes, counts, and aggregates. Use
  `filePath` for file-based operations when the user explicitly requests them.
  Report MCP failures; do not automatically fall back to CLI commands or direct
  record-file access.
- Create records only with explicit approval; a direct creation request counts.
- New projects and actions require entry context. Editing one occurrence of a repeating action can save it without an entry.
- Use closed projects only when instructed.
- Resolve actions rather than delete them, only on the user's decision;
  elapsed time never resolves work.
- Honor specified time zones; clarify ambiguity that affects scheduling.

## Results

| Response field | Meaning |
| --- | --- |
| `extensions.diagnostics` | Issues identified by code and scope. |
| `extensions.complete` | False whenever diagnostics exist, including model warnings. Check before concluding counts or absence. |
| `extensions.mutations` | Mutation outcomes and confirmed effects, including writes before a later failure. Inspect even when payload errors are unselected. |

Mutation payloads expose nullable `error`:

- Success returns `error: null`.
- Partial failure returns available saved records and an agent-readable error
  explaining confirmed effects, incomplete work, and recovery.
- Full failure returns a GraphQL error without a mutation payload or durable
  changes. A handler that reports a failed write without throwing follows the
  same rule.

Each `extensions.mutations` item has `operation`, `error`, and `changes`.
`operation` is the GraphQL mutation field name regardless of aliases; editing a
projection through `updateAction` still reports `updateAction`. `changes` lists
confirmed created, updated, or removed records, files, and index entries. These
facts remain available when payload fields are unselected or readback fails.
Unavailable entity readbacks are null; they do not hide saved IDs or paths.

Collections return `nodes`, `offset`, `count`, and `totalCount`. Request a
nonnegative `offset` and a `limit` from 1 through 100 (default 20); to retrieve all matches,
continue at `offset + count` while below `totalCount`, including for nested pages.
Action collections include saved actions and
future projections within the instance lookahead. Unfiltered collections include
templates. Direct status predicates exclude them; for task-only queries with a
negated lifecycle predicate, also set `recurrenceExists: false`. For counts or
absence, use `totalCount` with the completeness check above; fetching every
record is unnecessary.

Inspect errors and diagnostics before claiming completion. Known Calendar
issues appear in mutation errors; normal pending work is not a failure. A saved
record does not confirm Calendar synchronization.

For partial or uncertain writes, read back affected records using confirmed IDs and paths;
for occurrences, use `Query.actions(where: {occurrence: {template: ..., original: ...}})`
with copied occurrence identity. Retry only requested changes that remain unapplied.
Confirmed partial results help when a response arrives; a completely lost response
still requires readback. Creates do not have an idempotency key.
`Mutation` defines failure semantics. If instance creation saved files but
activation failed, later mutations stop; select the saved path rather than
recreate it or write to the previously selected instance.

## Schema

Schema references use `Type` or `Type.field`. The schema is stable across
instances and execution settings. Discover model choices through
`Instance.execution.models`; introspection does not probe vendors or load records.
