# Action recurrence

A dedicated template action holds reusable content and schedule history. It is
unscheduled and unresolved. Content edits affect projections; saved occurrences
retain their own content.

## Declaration

`recurrence` is an ordered list of nonoverlapping RRULE schedules:

```yaml
recurrence:
  - dtstart: "2026-10-02T09:00"
    timezone: America/Los_Angeles
    rrule: "FREQ=WEEKLY;BYDAY=FR;UNTIL=20261030T160000Z"
  - dtstart: "2026-11-02T09:00"
    timezone: America/Los_Angeles
    rrule: "FREQ=MONTHLY;BYDAY=1MO"
```

`dtstart` anchors the pattern, interval, and count. Timed wall clocks use minute
precision; reject finer starts without rounding. Optional IANA `timezone`
qualifies wall time; omission means floating time. All-day starts are dates without a timezone.
End with native inclusive `UNTIL` or `COUNT`, never both; omit both for indefinite
recurrence. There are no separate `from` or `to` fields.

`recurrence: []` retains a dormant template. Removing the key would make it an
ordinary action and is prohibited.

## Schedule changes

`update_action.recurrence` accepts exactly one command:

| Command | Input | Effect |
|---|---|---|
| `append` | `{dtstart, rrule, timezone?}` | Start on or after now and after the final stored start; automatically close an overlapping final rule at its last occurrence before the new start with `UNTIL`. |
| `set_end` | `{schedule: {dtstart, timezone?}, at?}` | Exclusive occurrence-start cutoff at `at` (default now); derive inclusive `UNTIL`. |
| `remove` | `{dtstart, timezone?}` | Remove the selected rule, including past rules. The last removal leaves `[]`. |

Copy selectors from action metadata: exact authored start and zone; omitted zone
selects floating or all-day rules. `at` is an explicit-offset ISO instant strictly
after the selected start. Retained patterns, anchors, and zones cannot be patched;
append leaves earlier and already-ended rules unchanged.

Validate the full result before writing. Shortening and removal may drop past
projections; extensions may add past occurrences only when every added identity
already has a saved action. Never introduce unsaved past projections.
First observation establishes accepted history, retained across restarts.
Malformed source blocks that template's recurrence mutations and Calendar sync;
unreadable history blocks schedule changes.

Saved actions and provenance survive every command. Retain the template;
dangling references are malformed. Stop recurrence by ending the active rule
and removing queued rules. Use a new template when replacing the work itself.
Past occurrences remain editable.

## Projection

Project all past occurrences and a configurable future window, defaulting to
seven days and extending to at least one future occurrence if any remain.
Planning prioritizes upcoming work, backlog, then recent history. History has no
cutoff; cursors fix the page boundary in time.
Configure the window with `update_instance.recurrenceLookaheadDays`, stored in
instance `config`.

Only edits materialize occurrences, including completion or cancellation by a
user, agent, automation, or Calendar gesture. Reading or reaching the scheduled
time or starting delegation leaves an occurrence projected and unresolved.
Exact GraphQL action lookup and edits resolve projection handles independently of
query lookahead; after saving, the same handle resolves the saved occurrence.

Backlog and timeline combine labeled projections with saved actions. Ordinary
queries, indexes, counts, and relationship graphs contain saved records only.
Saved occurrences follow ordinary dates, states, and filters, including outside
the lookahead. Projection handles are planning references, never ordinary IDs.

## Identity

Identity is **(template action ID, original occurrence value)**, independent of
rule revision. Save `occurrence: {template, original, timezone?}` as provenance;
the action's actual `scheduled` and `timezone` remain independent.

| Schedule | Original value |
|---|---|
| All-day | Literal date, e.g. `2026-10-16`; no timezone or UTC conversion. |
| Floating | Literal wall time, e.g. `2026-10-16T09:00`. |
| Zoned | Exact UTC instant, e.g. `2026-10-16T16:00:00Z`, plus the original IANA zone as context. Preserve historical offset seconds. |

A saved action suppresses only its exact projection. Rule changes, renaming,
rescheduling, resolution, and reordering never reassign its identity or ID.
Never match occurrences by current timing or sequence position.

## Materialization

`update_occurrence` reuses an existing action for the identity. Otherwise allocate
an ordinary ID from the current local creation date and name after the edit:
`YYYY-MM-DD-{slug}`, then `-2`, `-3`, etc. for collisions. This applies to Calendar
imports too; the occurrence date does not determine creation time or ID.
Save the action and index with its provenance.

Creating a template requires entry context once. Occurrences inherit its live
entry-derived project associations; their own entries may add associations.
Materialization creates no entry and leaves the template's entry intact.

## Calendar

Aside is authoritative. Prefer native recurring series and exceptions, with a
visible rule and previous/next navigation, independently of Aside's lookahead.
Materialization reuses the native occurrence.

Translate schedules independently; decompose RRULEs into exact native series
when practical. Calendar limits never restrict Aside rules. Report unsupported
details or approximations; they must not invent Aside occurrences or import
derived changes as user edits.

Saved exceptions outside supported native rules use ordinary events. When
switching representations, confirm removal of the old owned event or series
before publishing its replacement. Unconfirmed cleanup defers the handoff and
reverse imports, preserving saved state.

Only [existing individual Calendar gestures](calendar.md#sync-model) sync back;
a projected gesture materializes its action. Series and rule edits never rewrite
the template. Import identifiable individual deletions, never infer unwitnessed
ones. Restore a missing whole series from Aside. Own cleanup is never a gesture.
Native limits and reconciliation mechanics live in the
[Calendar implementation](../cli/calendar-impl.md#template-recurrence).

See the [API spec](../cli/spec.md#recurrence-planning-and-edits) for template
creation, planning, occurrence edits, and GraphQL.
[Automations](automation.md) independently create ordinary actions.

Templates can declare [delegation](delegation.md), inherited by every unsaved projection. Materialization saves its own declaration; subsequent template edits leave saved occurrences intact.
