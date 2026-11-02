# Calendar

A scheduled action syncs to the user's calendar when it's routed to one. The
action file is authoritative and the event is derived from it — not a second
source of truth.

## Scope

- **Sync, not a calendar tool.** No querying, free/busy, or availability — for
  those the user brings their own calendar MCP.
- **Mostly one-directional.** Actions drive the calendar; the calendar drives
  actions through the accepted normalization and sanctioned signals below.
- **Coexistence.** Aside events sit alongside the user's own events; a
  marker keeps them apart, so sync never touches hand-made events.
- **Recurrence.** Template series follow the [action recurrence design](recurrence.md).
  Ordinary actions map to single events; if an ordinary action's event is made recurring, Aside stops syncing it —
  never editing, deleting, or importing from the series — and surfaces the
  action in `calendar_info`; removing the recurrence resumes sync.

## What syncs (action → event)

| Action | Event |
|---|---|
| `name` | title |
| `scheduled` | start time (minute precision), or an all-day event for a date-only value |
| `timezone` | named event time zone for a timed `scheduled` (IANA, e.g. `Asia/Tokyo`); floating if unset; ignored for all-day dates |
| `duration` | event length — positive fixed ISO duration in whole minutes, e.g. `PT1H`, `P1D` = 24 elapsed hours even across clock changes; default `PT30M` if unset; all-day events span by date |
| `deadline` + `description` + `body` | notes |
| ID + state | `url` marker (see Linking) |

Only **scheduled** actions produce events. A named-zone wall time resolves to
its first occurrence during a repeated hour; a nonexistent named-zone clock is
invalid. Floating schedules use the current local zone. Records and MCP retain
the wall time and optional zone. Entry/project/artifact timestamps and
deadlines remain floating; the schedule's zone never qualifies them.

**Accepted floating-time normalization.** A valid floating clock can fall in a
local daylight-saving gap. When the local zone is `America/Los_Angeles`, floating
`2026-03-08T02:30` is first saved in Aside, then normalized by the local Calendar
bridge and saved to Calendar as `03:30`. After a successful save, sync immediately
reads the event back and updates Aside's `scheduled` to `2026-03-08T03:30`. This
round trip is accepted canonicalization; the input is not rejected.

Every successful floating timed save is immediately confirmed by reading its
saved event ID, including saves of scheduled done actions. A normalized start
is written back only while the source record is still the saved snapshot, and
the sync receipt certifies that canonical record. An unsuccessful confirmation
retains the event ID and retries the read; it neither creates a duplicate nor
treats a missing readback as a deletion. A newer local edit supersedes the old
snapshot and is synced through the same retained ID. A failed Calendar save
leaves the authored schedule intact.

The browser presents timed schedules in its local zone and calculates schedule
status, distances, chronological order, and timeline windows against actual
instants. A named schedule always visibly includes its authored clock and zone,
even when that zone matches the browser; crossing a date adds the authored date.
Floating schedules and all-day dates display their recorded time or date.

The event title can take a customizable prefix, set per instance and per lifecycle
stage — so synced events stay distinguishable by which aside instance they belong to
and whether the action is still scheduled or done.
Instance prefix edits enqueue forward synchronization of existing scheduled,
completed, and recurring events. The setting is saved before Calendar work;
receipts report the observed synchronization state.

## Linking

The event ↔ action link is a single **marker URL** in the event's `url` field. Only marked events are ever touched:

```
aside://<instance-id>/action/<action-id>            # active / scheduled
aside://<instance-id>/action/<action-id>/done       # completed
aside://<instance-id>/action/<action-id>/cancelled  # cancelled (event then removed)
aside://<instance-id>/action/<action-id>/backlog    # descheduled (event then removed)
```

A user may write a common spelling for the suffix — `done`/`complete`,
`cancel`/`cancelled`, `backlog`/`deschedule` — that aside normalizes to the canonical
form above.

The instance ID is a lowercase ASCII hostname label (see [Instances](instance.md)); action IDs are percent-encoded path segments. Calendar work is blocked while the instance identity is invalid or shared by distinct independent instance groups, including queued retries and reverse writes. Linked Git worktrees never sync; their related primary checkout remains eligible. Browser address suffixes never enter calendar markers (see [Instances](instance.md#git-worktrees-and-browser-addresses)).

## Calendar selection

The target calendar is chosen **per action**: each action carries its own `calendar`
field and optional readable `calendar_account` qualifier. Routing instructions can live in the `aside.md` manifest. Names, or name/account pairs when qualified, must match exactly one calendar; missing, ambiguous, and read-only targets block sync without descheduling the action. Rename a matching calendar or supply a unique account qualifier to resolve ambiguity. Omitted qualifiers remain omitted for uniquely named calendars; no hidden calendar identifier is persisted.

**Any** calendar the user owns is a valid target — work, personal, shared, whatever
exists in their account. Aside never creates one.

A calendar **must be named for an action to sync**: an action with no `calendar`, or
one naming a calendar that doesn't exist, is not synced.

## Sync model

One reconcile keeps an action and its event in agreement; forward and reverse are
its two directions. The action file drives the event, subject to the accepted
floating-time normalization above.

**Forward** — run whenever an aside tool creates or changes an action (`capture` / `update`);
a direct file edit is picked up at the next reconcile when it moves the event's
derived time, title, or calendar (a notes-only edit rides along with the next
such push) — derives the event the action implies and pushes it:

- active, scheduled, calendar set → event at `scheduled`, title `name`
- done → event kept, `✓ ` title, url `/done`
- backlog, cancelled, or calendar cleared → event removed
- scheduled with no calendar → not synced (surfaced as an issue)

Hand edits to a synced event (title, notes) are not preserved — the next sync
overwrites them.

Tool writes save the local record before starting calendar work. Their receipts report per-action calendar state; `calendar_info` exposes pending work, retries, successful sync or removal, and disabled or failed sync. A saved record or an absence of issues does not establish that its event is synced. These observations are shared by every session, last while the [daemon](daemon.md) has the instance loaded, and remain available when the calendar helper is unreachable. Failure reports give observed categories and recovery steps; a helper crash, command failure, or undecided permission response does not establish its cause.

**Reverse** reads Aside-marked events and imports the gesture into the action; the
event is then re-derived from the result, so a removal or the `✓` resync falls out
of forward sync rather than being a separate reverse step:

| Calendar gesture | Effect on action | Event after |
|---|---|---|
| Move the event | update `scheduled` | unchanged |
| Resize the event | update `duration` from elapsed time | unchanged |
| Change its time zone | update `timezone` and `scheduled`; removing the zone makes it floating | unchanged |
| Move it to another calendar or account | update `calendar` and preserve or add `calendar_account` when needed for unique routing | unchanged |
| Append `/done` to the url | `resolution: done` | re-derived with `✓ ` / `/done` |
| Append `/cancelled` to the url | `resolution: cancelled` | removed |
| Append `/backlog` to the url | clear `scheduled` → backlog | removed |
| Delete the event | clear `scheduled` → backlog | (already gone) |

Gestures combine: one pass applies every change on an event at once (e.g. a move
and resize update `scheduled` and `duration` together). A done (`✓`) event is a
record of when the work happened: its time is not imported, so moving or resizing
one snaps it back at the next reconcile; lifecycle and calendar gestures still
apply.

Equivalent named-zone aliases (such as `UTC` and `GMT`) retain the record's
authored zone name. A floating clock remains distinct from every named zone;
zones sharing today's offset can still have different rules.

**Why reverse trusts the calendar.** Forward sync has already applied every local
change and reconciled accepted normalization, so a later discrepancy a reconcile
finds is a change made *on the calendar* —
reverse imports it. A vanished event is the deletion case: the action is descheduled,
when the instance loads and live alike.

**One syncer.** The [daemon](daemon.md) is the only process that touches the
calendar, so sessions never coordinate: each writes through it and sees the same
sync state. Sync covers an instance while the daemon has it loaded; calendar
changes made while it is not are imported when it next loads.

**Instance load.** A load pass wanting to deschedule many actions at once (their
events all missing) is capped and surfaced rather than imported as deletions.

## Unrepresentable calendar times

A timed calendar event must round-trip through the record's first-occurrence
wall time and named or floating zone, with a positive whole-minute elapsed
length. Reads include its actual start/end instants and explicit zone. A start
in the second occurrence of a repeated hour, sub-minute start/length, unsupported zone, or
missing/inconsistent timing metadata blocks that action in both directions;
its event and record are preserved, including lifecycle suffix gestures.
`calendar_info` reports the action and an actionable diagnostic. Other actions
continue normally, and an unsafe duplicate is preserved rather than pruned. An
end in the second occurrence remains representable by elapsed duration.

The block remembers the `scheduled` and qualifying `timezone` definition while
the instance is loaded. Name, notes, duration-only, unchanged-start, and
still-ambiguous edits cannot clear it. Correcting the Calendar time resumes
reverse sync. An explicit record start edit to an unambiguous time resumes
forward sync, either re-expressing the same instant in UTC or choosing a new
start. Missing or contradictory helper metadata requires fixing the helper,
not changing a record. The native helper also checks at mutation time, so an
edit preceding its changed notification cannot be silently overwritten.

## Open Questions

Recurrence mapping follows [Action recurrence](recurrence.md) and adds no reverse
gestures.
