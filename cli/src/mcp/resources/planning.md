# Plan, schedule, and repeat work

## Review commitments

Review backlog, deadlines, and slipped work. Propose priorities, rescheduling,
or resolution.

A recurring action is a template. An unedited occurrence is computed from that
template's recurrence and appears as an action within the instance lookahead.
Use `Query.actions` or a project's `Project.actions` for all work, including
future projections within the instance lookahead. Templates are also included
in unfiltered lists. A template has `Action.recurrence` set to a schedule list,
including `[]` for a dormant template, and `Action.status: null`. It defines
repetition rather than unfinished work to resolve.

| Action shape | Recurrence | Occurrence | Lifecycle |
| --- | --- | --- | --- |
| Ordinary action | null | null | `Action.status` describes its state. |
| Recurrence template | Schedule list; `[]` is dormant | null | `Action.status` is null. |
| Saved or projected occurrence | null | Immutable identity and projected flag | `Action.status` describes its state. |

| Occurrence metadata | Meaning |
| --- | --- |
| `Action.occurrence.template` | The existing recurrence template `Action`; select `id` for occurrence edits. Missing or invalid templates return null and consistency diagnostics. |
| `Action.occurrence: null` | Ordinary action or recurrence template; no individual occurrence identity. |
| `Action.occurrence.projected: true` | An unsaved occurrence computed from its template. Reading it creates no saved action or entry. |
| `Action.occurrence.projected: false` | An occurrence already saved as an action, regardless of scheduled time or lifecycle state. |

The flag reports whether an occurrence is saved. Use `Action.status` for
completion or cancellation. The flag is computed and cannot be
set through an input.

For example, a template saying “Review finances every Friday” can produce next
Friday's action with `projected: true`. Editing that action saves only that
occurrence and returns `projected: false`, leaving the template unchanged.
The saved occurrence retains the same template ID and `original` identity, even
if its current scheduled time changes. Reading alone never performs that
conversion. Projections follow the current
template's values, schedule, and context and can disappear when its recurrence
or the lookahead changes; a saved occurrence keeps its own edits.

| View | Schema reference |
| --- | --- |
| Backlog and deadlines | `Query.actions`, `ActionWhere.status`, `ActionWhere.deadlineTo` |
| Earliest scheduled work or deadlines | `ActionOrder.SCHEDULED_ASC`, `ActionOrder.DEADLINE_ASC` |
| Unresolved past schedules | `ActionWhere.scheduledTo` with `ActionWhere.status: [SCHEDULED]` |
| Counts and pagination | `ActionPage.offset`, `ActionPage.count`, `ActionPage.totalCount`; includes matching projections |
| Templates, including dormant ones | `ActionWhere.recurrenceExists: true` |
| Work excluding templates | `ActionWhere.recurrenceExists: false` |
| Occurrences by saved/projected state or exact template/original identity | `ActionWhere.occurrence` |
| One project's work | `Project.actions` or `ActionWhere.projects` |

All action filters apply before pagination, including project, status, search,
and recurrence/occurrence predicates. `recurrenceExists: true` matches any
template, including an empty schedule list or a nonempty history whose schedules
have ended or produce no future occurrences; false matches ordinary actions and
occurrences. Omission or null leaves that filter unrestricted.

Action ordering uses `ActionOrder` for root and nested collections. Scheduled and
deadline values can sort ascending or descending, before pagination; missing
values are always last. Timed schedules compare instants in their action zone,
while floating schedules, all-day midnight, and deadlines use the server's local
zone. Equal dates sort by creation time then ID ascending.
A direct status predicate matches lifecycle-bearing actions and excludes templates;
`status: [BACKLOG]` therefore returns ordinary backlog work and saved occurrences
returned to backlog. A template's null status is not an enum value to pass in
the status list. Boolean negation follows normal predicate logic:
`not: {status: [DONE]}` includes null-status templates. For work without
templates, combine `recurrenceExists: false` with `not: {status: [DONE]}`.

For example, discover all templates through the same action collection, then use
each returned ID to edit its recurrence:

```graphql
query Templates {
  actions(where: {recurrenceExists: true}) {
    nodes { id name status recurrence { dtstart rrule timezone } }
    offset count totalCount
  }
}
```

`occurrence: {}` matches any occurrence;
`occurrence: {projected: true}` matches only unsaved projections,
and `occurrence: {projected: false}` matches saved occurrences. Use `not` with
the projected predicate to exclude projections while keeping ordinary actions
and templates. `template` narrows occurrences to one saved template ID.
Projection failures appear in response diagnostics and make `extensions.complete`
false; check it before claiming full coverage or absence.

## Create or change work

- For a scheduled action with a target calendar, its body becomes event notes; include references useful when performing the work.
- Create new actions or templates in entry context. Find a fitting open project; clarify uncertain fit or leave the entry untagged.
- Routine edits need no entry. Offer to capture a meaningful check-in or decision separately.

| Task | Operation and input |
| --- | --- |
| Read a saved action, template, or in-window projection | `Query.action` |
| Create work with context, or add it to the current entry | `Mutation.capture`, `CaptureInput`, `Mutation.updateEntry`, `ActionLinkInput` |
| Edit, schedule, reschedule, return to backlog, or resolve work | `Mutation.updateAction`, `UpdateActionInput` |
| Complete, cancel, or reactivate work | `UpdateActionInput.status`, `UpdateOccurrenceInput.status` |
| Display a timeline or project view | `Mutation.show` |

Use `status: DONE` or `CANCELLED` to finish work while retaining its schedule.
`BACKLOG` clears the schedule and completion/cancellation; `SCHEDULED` clears
completion/cancellation and requires a resulting scheduled time. Omitting
`status` preserves completion/cancellation; scheduling determines unresolved status.
`status: null` is accepted only when the resulting action is a recurrence
template; it clears lifecycle fields.

## Repeat a commitment

Use a dedicated, generically named action template for each repeating commitment.
Create it through the entry operations above with `CreateActionInput.recurrence`.
`RecurrenceScheduleInput` defines ordering, RRULE, start,
and timezone rules. A recurrence list creates a template; an empty list creates
a dormant template. Omit `scheduled` and other irrelevant optional creation
fields rather than using null as an update-style clear.

This creates a weekly template. Supply an all-day Friday date for `$start`; the
returned status is null, and occurrences appear separately within the lookahead.
Use `recurrence: []` instead to create a dormant template.

```graphql
mutation CreateTemplate($start: String!) {
  capture(input: {
    content: "Review finances every Friday."
    description: "Weekly finances review"
    actions: [{create: {
      name: "Review finances"
      description: "Weekly finances review"
      recurrence: [{dtstart: $start, rrule: "FREQ=WEEKLY;BYDAY=FR"}]
    }}]
  }) {
    createdActions { id status recurrence { dtstart rrule timezone } }
  }
}
```

An existing ordinary action can become a template through
`UpdateActionInput.recurrence.append`, preserving its ID and context. It must
have no scheduled time or completion afterward. Use `status: null` in the same
update to clear its lifecycle when appropriate. An occurrence's
provenance is immutable, so an occurrence cannot become a template.

Read the template before editing. Send one `RecurrenceMutationInput`
command through `Mutation.updateAction`:

| Change | Command and contract |
| --- | --- |
| Add the next schedule | `RecurrenceMutationInput.append` |
| End or extend a schedule | `RecurrenceMutationInput.setEnd`, `RecurrenceEndInput` |
| Remove a schedule | `RecurrenceMutationInput.remove` |

Removing the last schedule leaves `Action.recurrence: []`: the action remains a
dormant template with null status. Recurrence commands edit schedules rather
than convert the template back into an ordinary action.

- Copy selectors from stored metadata using `RecurrenceScheduleSelectorInput`.
- Retained starts, patterns, and zones cannot be patched in place. Schedule changes can remove future projections; already saved occurrences remain.
- To stop repetition, end the active rule and remove queued future rules. Retain the template for saved occurrences; use a new template when the work changes meaning.
- Preview with `Query.actions`. Set lookahead through `Mutation.updateInstance` and `UpdateInstanceInput.settings.recurrenceLookaheadDays`; the default is documented at `InstanceSettings.recurrenceLookaheadDays`.

All-day projections include today through the horizon date; timed projections
are strictly after the current minute through the horizon. There are no unsaved
past projections, and schedules outside the horizon do not add an extra
occurrence. Date filters narrow that finite set without expanding it.

## Change one occurrence

Use the returned `Action.occurrence` identity;
do not reconstruct it from a displayed date.

| Target | Operation |
| --- | --- |
| Any action returned by a query, including a projection | `Mutation.updateAction` |
| Projected or already saved occurrence identified by template/original | `Mutation.updateOccurrence`, `UpdateOccurrenceInput` |
| Repeating pattern | `Mutation.updateAction` with the template's `UpdateActionInput.recurrence` |

Occurrences materialize only on edit. Updating a listed projection ID through
`Mutation.updateAction` materializes that occurrence automatically.
Use the saved action ID and handle returned by that edit for subsequent action
operations and durable links; the earlier projected ID no longer names that row.
`Mutation.updateOccurrence` also accepts the exact returned `template.id` and
`original`; `Occurrence` describes immutable provenance and current projected
state. Occurrences inherit their template's live project associations:
`Action.projects`. Projections also inherit the template's artifact context
without creating persistent entry tags or artifact backlinks.

Projected IDs resolve only within the current lookahead and their handles are
transient. Copy the returned occurrence identity for an explicit occurrence edit;
use the resulting saved action handle for durable links.

## Calendar behavior and status

To display a plan, use `Mutation.show` for the default browser or
`Mutation.showUrl` for a browser chosen by the agent. See
[Records](aside://docs/records), “Open a browsing view,” for the automatic
authorization handoff and examples.

Edit Aside actions; their Calendar-bound writes start synchronization without a
separate sync call.
Call `Mutation.calendarInfo` for permission handling and status:

| Check | Schema field |
| --- | --- |
| Permission and calendars | `CalendarInfoPayload.authorization`, `CalendarInfoPayload.calendars` |
| Instance sync state | `CalendarInfoPayload.syncStates` |
| Problems and recovery | `CalendarInfoPayload.diagnostics`, `CalendarDiagnostic.recovery` |
| Outstanding action failures | `CalendarInfoPayload.failures` |

- By default, linked Git worktrees do not perform Calendar writes. The primary checkout's `.aside` can set `worktreeDetection: false` to restore independent-instance behavior; duplicate or unverifiable identities can still pause synchronization.
- Moving, resizing, or changing the timezone of an unresolved action's event updates its schedule, duration, or timezone. Changing the destination updates calendar routing. Deleting an unresolved action's event clears its schedule and returns it to backlog.
- A marked event's URL suffix `/done` completes the action; `/cancelled` cancels it. `/backlog` clears its schedule without clearing completion or cancellation. Completed event times are retained: moving or resizing a completed event snaps it back at reconciliation.
- Aside owns recurrence definitions. Calendar may approximate unsupported patterns; series edits there do not rewrite Aside's rules.
- Converting a Calendar-bound ordinary action to a template removes its previous single event before publishing the recurring series. Check sync status while that handoff is pending.
- Omitted duration means `PT30M` for timed events; all-day events span dates. Title prefixes come from `Instance.settings`, defaulting to `▢ ` and `✓ `. Set the corresponding `UpdateInstanceInput.settings` fields to change them; omission preserves, an empty string removes the prefix, and null restores the default.
