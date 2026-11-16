# Planning and execution

## Commitments and time

Schedules commit time; deadlines express urgency; resolution records a decision.
Elapsed time never completes or cancels work. Date-only work retains calendar-day
meaning, floating clocks retain local-clock meaning, and named-zone schedules
identify instants. Durations express elapsed time across clock changes. Ambiguous
repeated clocks use their first occurrence; unrepresentable times must not be
silently rounded or reinterpreted.

## Recurrence

A template defines a repeating commitment and its schedule history. It remains
unscheduled and unresolved, including when dormant. Future occurrences are
projections; reading, reaching their time, or starting delegation does not save
them. Editing an occurrence materializes it without creating another context
entry. It inherits its template's live project associations.

Occurrence identity is the template and original occurrence value, independent
of current timing, rule revision, and sequence position. Saved exceptions retain
their own content and configuration and suppress only their exact projection.
Schedule edits preserve saved actions and provenance. They must not invent
unsaved historical commitments. A dormant template retains its identity.

## Calendar synchronization

Aside owns schedules and recurrence definitions. A routed ordinary action maps
to its owned Calendar event; recurrence uses native series where representable,
with saved exceptions preserved. Native limitations must not restrict Aside's
recurrence model or invent occurrences. Changing representation requires
confirmed cleanup before publishing its replacement.

Local records save before Calendar work. Local save and confirmed synchronization
are separate outcomes. The daemon is the sole sync owner and maintains explicit
pending, successful, disabled, and failed observations. Routing uses readable
calendar/account names; ambiguous or unavailable destinations block sync without
discarding the user's schedule. Aside never creates calendars.

Supported individual Calendar gestures update timing, routing, or resolution;
deleting a known ordinary event returns its active action to backlog. Whole-series
changes never rewrite templates, and unwitnessed recurring deletions cannot be
inferred. Bulk disappearance at startup is treated conservatively. Deleting a
record file alone does not authorize deleting its event.

Owned title, notes, and primary location derive from the action; Calendar location
edits do not update records. Reconciliation preserves concurrent authored edits.
Times that cannot round-trip safely block both directions for that action while
preserving its record and event. A successful floating-time normalization is
confirmed back into the record. Failures must not overwrite unrelated events or
infer user gestures from Aside's own cleanup.

## Automation

Instance and project automations schedule execution independently of commitments.
Declarations live with their owner; closed projects pause future dispatch. Agent
instructions are maintained as artifacts, referenced rather than copied into
declarations. Reading status or discovering schema never launches work.

Dispatch considers future times only. Startup, wake, and clock changes do not
catch up missed runs; there are no automatic retries or execution resumption.
Persisted claims prevent duplicate automatic attempts after restart or clock
rollback. Overlap policy bounds queued follow-up work. Changing declarations does
not rewrite already-running executions; daemon shutdown cancels them. Execution
history is separate from the productivity record and describes process outcomes.

## Delegation

Delegation is an action-owned automation accepting agent prompts. Its deadline
comes from the action or recurring occurrence. Backlog and resolved work do not
dispatch automatically. Each occurrence gets at most one automatic attempt;
explicit dispatch can bypass timing and retry failures. Recurring delegation
does not depend on a browsing projection window.

A successful process exit completes the current action through normal mutation
handling, materializing a projection if needed and preserving other fields.
Concurrent edits, including cancellation or clearing delegation, do not suppress
that completion. A failed completion save is reported separately from successful
execution. Failed, timed-out, and cancelled processes do not resolve the action.
