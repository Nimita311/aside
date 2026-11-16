# Runtime

## Data ownership

Markdown and YAML remain authoritative. The portable data core supplies the same
record model, relationships, diagnostics, and completeness to agents and browser
views. Browser presentation must not invent a second interpretation of records.
Parsed caches, snapshots, and search indexes are derived and recoverable; yearly
indexes also retain authored descriptions.

One daemon per user owns loaded instances, serializes managed writes, watches
external edits, and coordinates integrations. Sessions own their selections;
browser tabs and agent sessions select independently. A known instance remains
maintained without an attached client. Forgetting preserves its files.

Loaded reads use published memory. Known writes update that memory and notify
the instance lifecycle; watching and periodic reconciliation repair external
changes. An integration failure must not prevent other integrations from running.
Reads may lag unseen external changes, but writes must guard against stale
content, changed identity, and unsafe destinations.

## Record identity

Named records derive identity from creation date and name; entries use their
creation timestamp. Renaming never changes an existing ID, filename, or reference.
Names retain their authored spelling. Slugs normalize presentation variants and
support Unicode while remaining safe on case- and normalization-insensitive
filesystems. Entity type is part of identity.

Relationship meaning comes from the [record designs](system.md#data-structure).
Derivation is deterministic and independent of file discovery order. Attachment
contents do not originate relationships. Unknown metadata and authored content
must survive ordinary edits.

## Instances

An instance is a directory with an `aside.md` manifest. Its durable ID survives
renaming and moving; its canonical directory identifies the local registration.
Independent directories remain distinct even when their IDs collide. User
instructions belong only to their selected instance. Prefer one instance unless
the user wants a lasting separation of context.

Managed records, indexes, and attachments require ordinary contained files and
directories; symlinks in managed paths are rejected. Supporting user files have
no prescribed layout and are read only for explicit requests. Import sources may
be outside the instance; saved references identify managed copies.

Git worktrees keep separate records and selections. Only the primary checkout
performs Calendar synchronization and automatic execution. Conflicting or
unverifiable identities pause these effects without hiding readable instances.
Browser aliases disambiguate directories without changing durable IDs.

## Reads and writes

Malformed input yields usable recovered content and explicit diagnostics, never
a silent claim of completeness. Absence and counts require complete observations.
Validate mutations before persistence and preserve authored extensions. A later
failure can leave earlier writes saved; receipts must expose confirmed effects.
An uncertain mutation must be read back before retrying, rather than repeated
automatically.

## Search

Eligibility and ranking are separate. Semantic ranking uses a disposable index
of saved record content and an explicitly selected embedding model. It never
changes filter membership or silently falls back to another search language.
Retrieval binds a consistent content snapshot to one immutable model generation;
unready or incompatible indexes wait or fail explicitly. Maintenance owns model
discovery and indexing; ordinary warm reads do not rescan source files.

Model services are configured explicitly; Aside does not start them or download
models. Search scores rank candidates, not confidence in an answer. Original
records remain the evidence.

## Process lifetime

HTTP serving follows the [hosting design](hosting.md).

Clients reuse compatible daemons and replace older builds through an orderly
shutdown. Identification and shutdown remain usable across build changes. A busy
stop requires explicit force; successful shutdown drains accepted work and
attempts pending Calendar work. Failures report observed causes and recovery
without inferring permission or process state from missing responses.
