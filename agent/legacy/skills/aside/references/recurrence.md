# Recurring actions

Create a dedicated generic action template through `capture` or `update_entry`.
Set `recurrence` to an ordered list of `{dtstart, rrule, timezone?}` schedules.
RRULE is the only form. All-day starts are dates without timezone; timed starts
are minute wall times with optional IANA timezone (omitted means floating).
The template has no scheduled time, resolution, or occurrence provenance.

```yaml
recurrence:
  - dtstart: "2026-10-09T09:00"
    timezone: America/Los_Angeles
    rrule: "FREQ=WEEKLY;BYDAY=FR"
```

Use `planning_actions` for projected work. Page with
`after: next`; ordinary action queries/counts describe saved records only. Reads
and passage of time never create or complete an action.

For an authorized edit, use `update_occurrence` with
the exact returned `template` and `original`, plus ordinary action edits. This
creates or reuses a saved action, with an ID based on today's creation date and
edited name. No entry is needed. Keep its provenance unchanged, even when moving
or renaming it. Saved actions inherit the template's live project associations.

Read the template's metadata before changing schedules. Use `update_action` with exactly one command in `recurrence`:

- `append: {dtstart, rrule, timezone?}` for a new schedule on or after now and
  after the final stored start. The server closes an overlapping final rule;
  earlier schedules stay unchanged.
- `set_end: {schedule: {dtstart, timezone?}, at?}` to end or extend a rule. Copy
  its exact start and zone from metadata. `at` is an explicit-offset ISO timestamp,
  default now, strictly after that rule's start; occurrences at or after it stop
  projecting. The server computes `UNTIL`.
- `remove: {dtstart, timezone?}` to remove the selected schedule.

Omit selector `timezone` only for floating or all-day rules; supply the stored
zone for zoned rules.

Do not patch retained patterns, starts, or zones. Shortening and removal may
remove past projections; extensions cannot introduce new unsaved past
occurrences. Invalid commands fail before writing. To stop the entire recurrence,
end the active rule and remove queued rules. Saved actions and provenance remain;
an empty recurrence list is a dormant template. Retain the template, and use a
new one when replacing the work itself. Do not combine COUNT and UNTIL.

Change Aside's definition or occurrence rather than editing a derived Calendar
series. Aside remains authoritative; Calendar cannot represent every RRULE.
Configure lookahead with `update_instance.recurrenceLookaheadDays` (default 7).
