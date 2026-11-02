# Calendar — Implementation

How the sync in [calendar.md](../design/calendar.md) is built. macOS only; that
doc owns the model, this one the mechanics.

## Architecture

Node can't call EventKit, so calendar access goes through a **native Swift helper**
the CLI ships. The helper is **long-lived**: it serves commands over JSON/stdio
and observes the store, pushing a change signal when the calendar changes. The
[daemon](../design/daemon.md) owns the one helper and one syncer per loaded
instance; each catches up when its instance loads and reconciles on each signal.

```
daemon (Node) <──JSON/stdio──> aside-cal (Swift, EventKit) ──> Calendar.app
```

## The helper (`aside-cal`)

A Swift binary bundled with the CLI; one JSON object per line each way. A
request is `{ id, cmd, ...args }`, answered by one response with the same `id` —
`{ id, ok: true, result }` or `{ id, ok: false, error, code? }`. `code` is a
machine-readable failure class — `calendar-not-found`, `calendar-ambiguous`, `calendar-read-only`,
`invalid-scheduling`, `event-recurring`, or `event-time-unrepresentable` — so the daemon classifies failures without parsing the English
`error` (which stays for display); an uncoded error is transient and retried.
The process is long-lived and exits when its stdin closes — the daemon shuts it
down by closing stdin, never by signaling the stub (whose SIGTERM handler
nonetheless forwards the signal to the disclaimed child, so a kill can't orphan
it with its pipes still open).

| Command | Purpose |
|---|---|
| `auth-status` | current TCC access level |
| `request-access` | prompt for full calendar access |
| `list-calendars` | id, name, account, writable, type, color |
| `upsert-event` | create or update an event by marker; returns event id |
| `delete-event` | remove an event by marker / id |
| `list-events` | marker-tagged events in a date range |
| `get-events` | re-fetch tracked events by id (still existing, still marked) |

Plus an async **`changed`** signal (from `EKEventStoreChanged`) that triggers a
reconcile. EventKit delivers that notification through the **main CFRunLoop**, so
the helper runs `RunLoop.main` (not `dispatchMain()`, which doesn't service the
run loop and so never receives it) while commands are handled on a background
thread. EventKit caches the objects it returns, so on a change the helper marks
its store stale and resets it before the next command — otherwise a read after an
edit would return the pre-edit snapshot and the reverse reconcile would see no
diff. The reset runs on the command thread (the observer only flags it), keeping
all EventKit access single-threaded. Setting `ASIDE_CAL_DEBUG` traces the helper's
lifecycle and each `EKEventStoreChanged` to stderr (which the daemon forwards to its log) — the
one way to confirm live change notifications actually arrive, since that path
is invisible to Node and to the test fake.

The helper stays **in-domain**: it only ever reads or writes `aside://`-marked
events. `list-events` returns only marked events; `upsert-event` adopts an
existing event only when it already carries this action's marker — by the given
event id, or failing that by a marker search in a window around the requested
time (the **upsert-by-marker safety net**: a create whose reply was lost gets
retried without an id, and the search adopts the event it already made instead
of duplicating it). Otherwise it creates a new event, never overwriting a
hand-made or other-action one. `delete-event` removes only by marker. An event
that joined a **recurring series** is refused with `event-recurring` rather than
edited or deleted, and event payloads carry `recurring: true` so the daemon keeps
its hands off too. Hand-made events are invisible to it.

- Embedded Info.plist carries `NSCalendarsFullAccessUsageDescription` (the key
  macOS 14+ consults) — a request without it aborts.
- **Its own TCC responsible process.** A child inherits its launcher's TCC
  responsibility, so without intervention the prompt is attributed to Terminal /
  VS Code / the agent host — none of which declare a calendar usage string, so TCC
  denies (or won't even prompt) before reaching EventKit. On launch the helper
  re-execs itself with the disclaim spawn attribute
  (`responsibility_spawnattrs_setdisclaim`) to stand as its **own** responsible
  process; TCC then consults *its* identity and embedded usage string, so one grant
  binds to aside-cal whoever launches it. The stub supervises the disclaimed child
  over the inherited stdio, so the protocol is unchanged.
- Code-signed with a fixed identifier (`sh.117.aside.cal`) so the grant binds to
  a stable identity. `native/build.sh` (run by the repo-root `build.sh` on macOS)
  builds a universal binary (arm64 + x86_64) to `dist/aside-cal` and ad-hoc signs
  it — changing the ad-hoc binary can require regranting calendar access. `dist/aside-cal` is gitignored; until it's built, calendar sync
  reports `unavailable`.
- Requests **full access** (macOS 14+) — write-only can't read back.
- Starts cross as wall-clock strings (`YYYY-MM-DDTHH:MM`). Node passes
  positive whole `durationMinutes` for timed events (default 30); the helper
  interprets the start in the action's `timezone` or current zone when floating,
  then adds elapsed minutes. `P1D` is always 24 hours across clock changes. Events
  return explicit `timezone` (IANA or `null` for floating), `startInstant` and
  `endInstant` (epoch milliseconds), and actual elapsed `durationMinutes`. Reverse
  resize and comparison use the instants, and an active event's zone change is
  imported with its wall time; missing or unsupported zone metadata is diagnosed. A date-only `scheduled` becomes
  an all-day event and keeps date-based span semantics.

## Auth

An OS permission, no credentials. `calendar_info` reports the status
(`notDetermined / denied / restricted / writeOnly / fullAccess`) and, when access
hasn't been decided or is write-only, requests full access — surfacing the OS prompt or an upgrade request. Denied access directs the user to System Settings → Privacy & Security → Calendars; restricted access directs them to device policy or an administrator. A returned undecided state gives no evidence about why the prompt did not complete. Authorization-command failures are distinct from helper communication failures. The sync caches a positive access check
but drops it whenever the helper process dies. Helper death reports its
observed process failure and does not establish a permission change; the next
attempt rechecks authorization.

## Data model

The sync reads these fields:

- **Action** — optional `calendar` and `calendar_account` (readable names), `duration` (positive fixed ISO duration in whole minutes), `timezone` (IANA). Forward routing requires a unique name or name/account match. Reverse sweeps search all calendars to recover cross-account moves; routing failures leave action schedules intact.
- **`aside.md`** — the required `id` (slug of `name`, immutable), which is the
  marker's `<instance>`. Without it sync is disabled (surfaced, not silent). Optional
  `config.scheduledEventTitlePrefix` / `config.doneEventTitlePrefix` are prepended to
  the event title (defaults: `▢ ` / `✓ `; an explicit empty string removes the prefix).
  Both are read from the manifest at use time, so an edit — like adding a missing
  `id` — takes effect at the next sync, no restart.

## Forward sync (inside `capture` / `update`)

**Any** change to a synced action re-syncs its event in full (current title,
time, notes), not just the changed field. A successful floating timed save is
immediately read back by its saved event ID to confirm the effective wall clock,
including for scheduled done actions. As described in the design's accepted
floating normalization, Foundation may turn a local gap clock such as `02:30`
into `03:30`; guarded confirmation writes that canonical start back to Aside.
The desired event is `desiredFromAction` (shared with reverse); the op follows the
action's state (`E` = a cached event id for it):

| Action state | Event op |
|---|---|
| scheduled, `calendar` set, not cancelled | **upsert** — create when no `E`, else update `E`; `✓` title + `/done` marker when done |
| backlog (no `scheduled`) or cancelled | **delete** `E` (no-op if none) |
| scheduled, `calendar` cleared (`calendar: null`) | **delete** `E` — stop syncing |
| scheduled, no `calendar` | **skip** — not synced (see below) |

A timed event ends `duration` elapsed time after `scheduled`. A transient helper
error or no access enqueues the op to the **outbox**, retried (against the action's then-current
state, re-read from the store) on the next syncActions; a coded error is a
standing issue (invalid scheduling, missing / ambiguous / read-only calendar, or
unrepresentable event time) or parks the action (recurring —
see below) instead. Every forward op registers its actions as **in-flight**
before its first await and until it settles — refcounted, so overlapping ops on
the same action each hold their own registration and the first to settle does
not strip the guard from the rest. A reconcile overlapping any of them leaves
the action alone — neither importing the pre-op calendar state over the fresh
local change nor reading the not-yet-created event as a deletion.

A scheduled action with **no `calendar`** isn't routed to forward sync at all;
`capture` / `update` report a disabled calendar state in their receipt so the
agent can route it, and reconcile records it as a `calendar_info` issue.

Forward operations retain a per-action observation: pending while in flight or
queued for retry, synced after a successful upsert and any required floating
confirmation, removed after confirmed
removal, disabled when no helper/instance identity/routing is available, or failed
for a standing error. Mutation receipts and `calendar_info` expose these states;
neither treats a local save or an empty issue list as event completion. States are
observations since the instance loaded and are superseded by the next operation for that action.
Positive observations are invalidated when the action's desired event changes.
Floating confirmation certifies the canonical desired version, retaining the
other fields actually sent to Calendar. A failed readback retains the saved
event ID and snapshot in a confirmation queue; outbox retries read that event
again without another upsert or a missing-event deletion. A newer source edit
supersedes the snapshot and saves its current state using the retained ID.

## In-memory state

Nothing persists; all of it is rebuilt when the daemon loads the instance:

- **event cache** — action-id ↔ event identifier, the fast path for updates.
- **sync observations** — latest per-action pending, success, removal, disabled,
  or failed state, with in-flight work and retries overriding previous success.
- **outbox** — forward ops awaiting retry after a transient helper error or a
  pre-access op, drained on the next sync.
- **confirmations** — successful floating saves awaiting guarded readback,
  retaining their event IDs and sent snapshots until confirmed or superseded.
- **recurring** — actions whose event joined a recurring series, parked until it
  isn't one anymore (see Recurring events).
- **changes** — reverse edits applied since the instance loaded, for `calendar_info`.
- **failures** — calendar errors `calendar_info` surfaces beyond the per-action
  issues/outbox: reverse-reconcile failures (rebuilt each pass) and sweep failures.

## Concurrency

The daemon is the only process that reads or mutates the calendar, and it runs
one syncer per loaded instance, so no coordination crosses processes. Two
invariants hold inside it: **tools write the markdown file before pushing to
the calendar** — the file is the truth a racing pass can check — and neither
mechanism below writes any file.

- **Mutation lock.** Every calendar-mutating phase — a forward batch and a
  reverse-reconcile pass (each of which can also prune duplicates via the
  sweep) — holds the instance's in-process lock, so two phases never interleave
  on one instance. A forward batch waits up to 15s and on timeout defers to the
  outbox (`calendar busy (another sync in progress), will retry`); a reconcile
  try-acquires and, when held, skips, leaving a single pending retry timer
  (~2s, re-armed until the lock is free) that covers the coarse `changed`
  signal once the holder is done. File writes never take the lock.
- **Snapshot-consistency guard.** Immediately before any sync write of an
  action file, the pass re-reads the file **from disk** — not the store map,
  whose watcher lags a direct file edit by ~100ms+ — and compares every field
  the write rewrites: the full front matter and the body (the reverse write
  serializes the whole file, so the compare surface must match the write
  surface). A mismatch means a tool call or an outside edit rewrote the action
  mid-pass: no stale write or change is recorded. Reverse import skips the
  snapshot; own-save normalization queues a retry against the current source.

Before the daemon exits it waits for forward syncs in flight and gives each
retry queue one attempt, so a clean shutdown leaves no push behind. Accepted
residue: after a crash between saving an action and pushing its event, the
action reads as "scheduled, no event" to the next load pass and is descheduled
— surfaced in `changes` and restorable by re-scheduling. Two machines syncing
one instance is unsupported.

## Reverse reconcile

One engine — `reconcileAction` — keeps an action and its event in agreement, run
per action when the instance loads and on each `changed` signal (~2s debounce). It imports the
event's gesture into the action, then re-derives the event from the result (the
same `desiredFromAction` forward sync uses), so "delete on cancel", "resync ✓ on
done", and "deschedule when the event is gone" all reduce to forward sync on the
mutated action. Every write is diff-gated both ways, so reverse → action → forward
converges and self-writes fall out; the action drives the event subject to
accepted floating normalization. Only events whose
marker resolves to a **loaded instance + action** are touched.

| Calendar observation | Condition | Action edit | Event after |
|---|---|---|---|
| event moved | active marker, start ≠ `scheduled` | set `scheduled` | unchanged |
| event resized | active marker, timed, elapsed length ≠ `duration` | set `duration` | unchanged |
| event time zone changed | active marker, explicit named zone or floating `null` | set or clear `timezone` with the wall start | unchanged |
| event re-pinned | kept event, calendar/account changed | set `calendar`, preserve or add the readable `calendar_account` qualifier when needed | unchanged |
| url gains `/done` | `resolution` ≠ done | set `resolution: done` | re-derived `✓` / `/done` |
| url gains `/cancelled` | `resolution` ≠ cancelled | set `resolution: cancelled` | deleted |
| url gains `/backlog` | still `scheduled` | clear `scheduled` | deleted |
| event gone | active, scheduled, no event | clear `scheduled` (backlog) | (already gone) |
| unrepresentable time | start cannot round-trip to the first wall occurrence, unsupported zone, invalid elapsed length, or incomplete/inconsistent timing metadata | — | preserve and block this action in both directions |
| duplicate marker | ≥2 events share it, every time is representable | — | keep one, delete the rest |

A suffix gesture wins over a move/resize; aliases match case-insensitively
(`complete`→done, `cancel`→cancelled, `deschedule`→backlog) and normalize to
canonical. One pass feeds all loaded instances, routing each event by its marker's
instance id; reverse edits and any failures (a read that failed, an edit that
couldn't be written back, an event that couldn't be removed) are recorded for
`calendar_info`. The event re-derivation that follows an import is a forward effect,
logged only as the reverse edit that triggered it.

**Why a missing event deschedules.** Forward sync applies local changes and
confirms accepted floating normalization, so the action reflects local intent
and its saved Calendar clock; a reconcile only surfaces calendar
changes aside didn't witness. A scheduled action whose event is gone is therefore a
deletion to import — descheduled, identically at load and live. An event
that was never created (sync enabled after the action was scheduled, or its calendar
absent on this machine) is indistinguishable from a deleted one and is descheduled
too; with no persisted action↔event record the two can't be told apart, and the
opposite choice — recreate — would instead ignore real deletions, so we keep the one
rule. The two cases differ only in how "no event" is established:

- **Load** — empty cache, so a windowed sweep builds it *and* supplies the
  events to diff (no second fetch): `list-events` over the scheduled-action range
  **±1 month**, widening to **±1 year** for any still unmatched — the widening
  scans only the two added segments, never re-querying the month window. Every
  range is queried in **≤3.5-year chunks**, merged deduplicated by event id
  (range predicates return every event *overlapping* the range, so an event
  straddling a chunk boundary comes back from both sides): EventKit's
  `predicateForEvents` silently truncates spans over 4 years, and a truncated
  sweep would read the missing tail as deletions. The sweep sees every *live* event, so every
  scheduled, calendar-pinned action is a candidate: matched → diffed;
  **unmatched → descheduled** (its event was deleted while the instance was not loaded).
  Events are created only by forward sync, never here. When a capture's forward
  sync completes the sweep before the first reconcile, that reconcile still runs
  this load pass — "cache built" and "deletions imported" are tracked apart.
  The deletion-import counts as done only after a pass with no failures; a
  failed per-action write keeps the next reconcile running the load pass
  (writes are diff-gated, so re-running is safe), and a load re-run
  re-checks each unmatched candidate **by marker** before concluding absence —
  the original sweep is stale by then.
  **Load deschedules are capped**: the pass collects them and executes only
  after seeing the whole calendar, and wanting more than **3** AND more than
  **25%** of the scheduled, calendar-pinned actions is treated as a bulk
  disappearance (offline account, truncated query), not a set of user
  gestures — none executes, the cache and all tracking stay untouched, and one
  pass failure records the action ids with a recovery hint (surfaced via
  `calendar_info`), keeping the load pass retrying until the events return
  or the user deschedules deliberately. Live deschedules are uncapped:
  the warm cache vouches for each event having existed since the load.
- **Live** — warm cache, so a `changed` signal runs **incrementally**:
  re-fetch the tracked events by cached id and diff, instead of re-sweeping (the
  signal is coarse — *something* changed, not what). Only tracked actions are
  candidates; a freshly scheduled action with no event yet is left to forward sync
  / the outbox. A cached id that no longer resolves is **re-matched by marker** over
  the scheduled window (±1mo → ±1yr) before concluding deletion — so a reassigned id
  (CalDAV re-sync / cross-calendar move) or a far-moved event is relocated, not
  descheduled; the cache is re-pointed to its current id. A failed re-match is
  inconclusive: leave it tracked and retry rather than deschedule on it.

Only **active** actions are descheduled on a missing event (a done action's event is
just a record), and never one with a forward op **in flight** or awaiting retry in
the **outbox** — such an action's calendar state trails a local change not yet
applied, so the reconcile imports nothing from it (absence included).

**Recurring events.** EventKit reports a recurring series as one event per
occurrence sharing the identifier, so none of the sync's single-event operations
apply. If a synced event joins a series (the user added a recurrence rule), the
action is parked: forward sync skips it, the reconcile imports nothing from it and
never deletes it (duplicate pruning skips recurring events too), and `calendar_info`
carries a per-action issue saying the event became recurring and is no longer
synced. The event stays tracked, so removing the recurrence resumes sync.

## `calendar_info` (MCP tool)

Metadata, never events (it requests full access when undecided or write-only — see Auth — but never
reads or writes calendar events):

- `authStatus` (+ whether full access is held)
- `calendars[]`: `{ id, name, account, writable, type, color }`
- `calendar_sync[]`: per-action `{ id, status, reason?, event_id?, retry?, category?, recovery?, auth?, helper_path?, log_path?, stderr?, command?, exit_code?, signal? }`;
  pending and positive outcomes as well as disabled/failed states. Instance
  observations, issues, and changes are appended even when auth/helper calls fail.
- `issues[]`: every known sync failure — the instance missing its `id` (sync
  disabled), scheduled actions left unsynced (no `calendar`, or a missing /
  read-only one), actions parked because their event became recurring, forward
  errors, transient failures awaiting retry, and reverse-reconcile / sweep
  failures (the calendar read failed, an edit couldn't be written back, a
  duplicate couldn't be pruned, a bulk load deschedule was deferred). Forward
  issues clear when the action next syncs; reverse failures are rebuilt each
  reconcile pass, so a clean pass clears them.
- `changesSinceStart[]`: reverse edits applied (rescheduled / done / cancelled /
  descheduled, and any duplicate events pruned)

## Source helper diagnostics

The source helper is ad-hoc signed. Building or replacing it can require regranting calendar access; changing only TypeScript or webapp code uses the package build and preserves the helper. Missing helpers report the expected path, source build command, daemon restart (resolution is cached at daemon startup), and a final `calendar_info` check. Non-macOS or pre-macOS-14 systems report `platform-unsupported` separately.

Failures use observed categories: `authorization-<status>`, `authorization-request-failed`, `helper-start-failed`, `helper-communication-failed`, `helper-command-failed`, `helper-exited`, `helper-timeout`, and `operation-failed` for other observed operation errors. Process failures retain the last 4096 characters of helper stderr, helper and daemon-log paths, and command/exit/signal when observed; they do not infer a TCC or GUI cause. Per-action receipts retain diagnostics with queued retries and clear them after confirmed sync. Failed duplicate removals retain their own diagnostics even after the primary event succeeds; relocated-event failures retain the same evidence as ordinary reverse failures. Identity changes discard observations from the previous identity.

### Calendar timing blocks

`event-time-unrepresentable` is a standing per-action failure, surfaced with
recovery through `calendar_info` and mutation receipts. Reverse preflight checks
actual finite `startInstant`/`endInstant`, explicit `timezone` or floating `null`,
wall/instant agreement, and positive whole-minute elapsed length before changing
any fields. An event ending in the second repeated hour is representable by
elapsed duration; an event starting there is not. Sweeps detect unsafe times
before duplicate pruning for that action.

The syncer remembers the blocked scheduled/zone definition. An unchanged or
unrelated edit remains blocked. A changed unambiguous start may be forwarded
with internal `allowTimeReplacement: true`; a named UTC clock can preserve a
second-occurrence instant, or the user may explicitly choose a new start. The
current event is reread and the action snapshot checked before this exception.
Missing or contradictory helper metadata cannot use the exception. Calendar
corrections are rechecked by normal reconcile; a direct record start edit queues
forward work before reverse import can undo it. Successful observation clears
the block. No extra record field or durable event mapping is stored.

Native upsert and delete recheck the live event before mutation. Upsert accepts
the timing replacement exception only for the daemon's explicit start edit;
delete preserves an unsafe event. Numeric-offset EventKit zones are diagnosed
rather than imported as named IANA identifiers.

## Template recurrence

The separate `RecurrenceCalSync` adapter runs inside the existing authorization,
instance identity and sync-lock gates. `recurrence-rule.ts` translates supported
RRULEs to explicit EventKit fields and reports ignored/unsupported combinations.
It handles daily, weekly, monthly, and yearly rules within EventKit's field
constraints, plus exact time-of-day decomposition without COUNT or time-dependent
BYSETPOS. Each stored schedule translates independently. A floating first anchor
in a daylight-saving gap is rejected because normalization would shift the whole
pattern; later gap occurrences retain literal provenance, with normalized starts
confirmed back into saved actions after exception writes.
Series markers use `aside://<instance>/series/<template>/<anchor-key>[/state]`,
separate from ordinary action markers. Anchor keys exclude rule endings so
closing a schedule updates its existing series.

`get-series` reads stored family items using provider identifiers and exact
lookups for authored or observed occurrences. A persisted daemon mirror keeps
superseded family keys, lookup hints, witnesses, pending native/ordinary handoffs,
and ordinary event IDs across restarts. Verify owned cleanup before publishing
the alternate representation, including re-fetching by original identity when
provider IDs change. Event IDs are hints, never mutation authority.
`upsert-series` saves a native rule with the series span. `upsert-occurrence`
re-fetches the marker and original date before an individual save/removal and
checks the freshly selected event's timing. It refuses a missing occurrence
rather than creating a duplicate. Helper responses
include original time, detachment and native rule fields. Reverse sync accepts
only existing per-occurrence gestures and witnessed individual deletions; source
changes and Calendar rule changes never become new action identities. See
[recurrence](../design/recurrence.md) for authoring and sync semantics. EventKit
does not guarantee complete detached-item enumeration or expose an exclusion
list; an unwitnessed deletion cannot be inferred.
