# Action

An action is a deliberate work item created through the system.

## Properties

- **Named.** Each action has a human-readable display name and a derived unique ID: `YYYY-MM-DD-{slug-of-name}`. The date is the creation date. The ID is also the filename (without `.md`).
- **Entry-bound.** Actions are created linked to an entry that captures the context they emerged from — why it exists, what prompted it. The entry is the action's origin record.
- **Derived relationships.** Project association and origin context are not stored on the action — they are derived from entries where the action appears.
- **Calendar-synced.** A scheduled action syncs 1:1 to a calendar event when a target `calendar` is set, and syncs back a limited set of edits. See `calendar.md`.

## Storage

Directory: `actions/`

```
actions/
  2026/
    index.yaml
    2026-05-02-deploy-db.md
    2026-05-10-review-schema.md
    2026-04-28-setup-monitoring.md
```

Each action has a markdown file with YAML front matter. The filename encodes the creation date and descriptive name, forming the action ID.

File name: `YYYY-MM-DD-{slug-of-name}.md` — derived from `created` date + slug of `name`. Filenames never change — scheduling and rescheduling only update front matter.

### Action File

```markdown
---
name: Deploy DB
created: 2026-05-02T14:30
scheduled: 2026-05-15T10:00
duration: PT1H
calendar: Work
deadline: 2026-05-20T17:00
---

Migrate the production database to the new schema. Coordinate with
the infra team on downtime window. See #entry/2026-05-02T14:30 for
original discussion.
```

Front matter fields:
- `delegation`: optional agent configuration, using `run.model`, a direct artifact handle in `run.prompt`, and optional `timeout`. See [Delegation](delegation.md) for scheduling, execution, completion, and GraphQL authoring.
- `name`: human-readable display name for the action
- `created`: ISO 8601 with minute precision (`YYYY-MM-DDTHH:MM`) — when the action was created
- `scheduled`: ISO 8601 with minute precision, or date-only for all-day work — the calendar time the work is planned for. When the action is marked done or cancelled, it can be considered the done time. Omit for backlog; optional even once resolved.
- `deadline`: ISO 8601 with minute precision, or date-only when no time was specified — optional hard deadline for urgency
- `resolution`: `done` or `cancelled` — how the action was resolved. Omit while active.
- `calendar`: nonblank readable name of the calendar to sync the event to. Omit on creation to leave the action unsynced; use `null` on update to clear routing and remove its event.
- `calendar_account`: optional readable account name qualifying `calendar`; omit for uniquely named calendars. See [calendar selection](calendar.md#calendar-selection).
- `duration`: positive fixed ISO duration in whole minutes (e.g. `PT1H`, `P1D` = 24 elapsed hours even across clock changes) — the timed event's length. Omit for the default.
- `timezone`: IANA time zone (e.g. `Asia/Tokyo`) for `scheduled`. Omit for a floating time.

Scheduling dates must be real Gregorian dates and times, and time zones must be recognized IANA names. Durations support days, hours, minutes, and seconds totaling positive whole minutes; years, months, weeks, and fractional/sub-minute results are unsupported. Invalid scheduling fields reject the entire capture/update before any write; direct edits are reported by `aside instance validate` and block calendar mutations.

The Markdown body appears in the calendar event's notes and contains references useful when performing the action. Inline mentions can be used for cross-references (e.g., `#project/2026-04-15-infra`, `#entry/2026-05-02T14:30`).

### Index

File: `actions/<year>/index.yaml`

A YAML list of all actions for that year, ordered reverse chronologically (latest first). Each item contains the action ID and a short description.

```yaml
- id: 2026-05-10-review-schema
  description: Review schema changes with the team
- id: 2026-05-02-deploy-db
  description: Migrate production database to new schema
```

MCP maintains the index when actions are created or updated, using the agent's authored description.

## States

Exactly one state, derived from which fields are present — no clock, so it never changes on its own:

| State | Condition | Meaning |
|---|---|---|
| **backlog** | no `scheduled`, no `resolution` | intend to do it; no committed time |
| **scheduled** | `scheduled` set, no `resolution` | committed to a calendar time |
| **done** | `resolution: done` | completed |
| **cancelled** | `resolution: cancelled` | abandoned; won't do |

### Common queries

Examples, each a state plus a date bound:

- **upcoming** — scheduled, `scheduled` today or later
- **slipped** — scheduled, `scheduled` before today (still unresolved — never auto-done)
- **overdue** — backlog or scheduled, `deadline` before today

## Naming

Each action is created with two human-readable fields: a `description` — the one-line summary of the work (e.g., "Migrate the production database to the new schema") — and a `name`, the short display label the agent shortens it to (e.g., "Deploy DB"). The description is stored in the index; the name drives the ID and is shown in UIs.

The action ID is derived: `{YYYY-MM-DD from created}-{slug of name}`. The ID is used in all references (entry metadata, inline mentions, filename).

`update_action` can change the nonblank display name; omission preserves it. The ID, filename, creation timestamp, and references remain unchanged. A linked calendar event receives the updated title through forward sync.

## Lifecycle

The agent creates actions through `capture` or `update_entry`, linked to their context entry, and changes lifecycle fields through `update_action`.

- **Creating**: the action file uses the `created` date prefix. If a committed date or time was given, set `scheduled`; otherwise the action starts in backlog.
- **Scheduling / rescheduling**: set or update `scheduled` — no file rename.
- **Returning to backlog**: clear `scheduled`.
- **Completing**: set `resolution: done`. Successful delegation execution also completes the action; manually completing it never starts an agent. The done time is the `scheduled` time, if one is set.
- **Cancelling**: set `resolution: cancelled`. The action file is kept on the record.

The [recurrence design](recurrence.md) defines projected occurrences and saved
exceptions, their authoring interfaces, and Calendar mapping.
