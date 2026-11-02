# Delegation

Delegation is automation defined on an action. The user-facing name is
`delegation`, and its execution accepts agent prompts only. It uses the same
model catalog, validation, scheduler, runner, and retained run model as other
automations:

```yaml
delegation:
  run:
    model: CLAUDE_SONNET
    prompt: "#artifact/2026-10-12-instructions"
  timeout: PT30M
```

`run` requires a model and a direct primary artifact handle. The agent reads
the referenced artifact through Aside. Scripts are unsupported. `timeout`
defaults to `PT30M`. Scheduling comes from the action, so the declaration has no schedule, enabled, or overlap fields.

## Authoring

Delegation is an automation owned by an action. GraphQL `Action.delegation`
returns `Automation`, named `delegation`, with `run`, effective `timeout`, and
passive `next`, `running`, and retained `log` observations. Its schedule is
derived from the action (`schedule: null`), `enabled` reflects its unresolved
lifecycle, and `overlap` is `SKIP`. `run.prompt` resolves an `Artifact` only when selected. Missing artifacts produce diagnostics. Invalid
saved declarations return null with diagnostics and remain preserved for repair.

`CreateActionInput`, `UpdateActionInput`, and `UpdateOccurrenceInput` accept
`DelegationInput` with `AgentRunInput`. `run.prompt` uses `ArtifactLinkInput` to
link an existing artifact or create instructions inline. Validation precedes
writes; linked artifacts share the owner's mutation journal. New model selections
must be selectable in the action's instance. Ordinary edits preserve saved
unavailable selections without querying vendors.

Creation omits delegation when absent. Updates omit to preserve, supply a complete
declaration to replace, or use null to clear. Legacy action authoring accepts the
same frontmatter declaration with a direct prompt handle.

## Dispatch

The daemon arms delegation at the action's `scheduled` time. Named zones use the
action's scheduling semantics; floating times use local time, and date-only work
starts at local midnight. Backlog actions have no automatic deadline. Done and
cancelled actions never dispatch automatically; marking an action done disarms
pending work and cannot launch a delegation.

Templates supply delegation to every unsaved projected occurrence. The worker
seeks recurrence rules directly, independently of `recurrenceLookaheadDays`,
respecting COUNT, UNTIL, gaps, and folds. Launch leaves the occurrence projected;
its first edit materializes it. Saved occurrences use their own schedule and
declaration; clearing delegation on a saved occurrence suppresses it. Template
edits apply to unsaved projections; materialized occurrences retain their saved configuration.

Claims persist before dispatch. Each recurrence occurrence has an immutable
template/original identity shared by its projection, saved action, and manual
dispatch. It gets at most one automatic attempt, even after rescheduling, clock
rollback, or restart. Ordinary actions can acquire another automatic attempt
when explicitly rescheduled to a later time. Different occurrences can execute
concurrently, with one active execution per action or occurrence.

Startup, wake, and clock changes arm future deadlines only. Missed times are not
caught up. There are no automatic retries or execution resumption. Delegation
uses automation's primary-checkout and instance-identity guards, native clock
notifications, model warmup, and shutdown cancellation.

GraphQL explicitly starts work through a mutation:

```graphql
mutation {
  runDelegation(id: "ACTION_ID") {
    id
    status
    action { id status }
    automation { name }
  }
}
```

This bypasses scheduled timing and permits backlog or resolved actions. A template
requires a projected occurrence ID. It returns the retained `AutomationRun`
directly, with `action` resolving its saved or projected owner without editing
it. Already-running work rejects another launch.
Forced execution consumes a pending automatic attempt for the same occurrence;
failures can be retried explicitly. It returns promptly with a retained run.
Inspect retained runs before retrying after an uncertain transport result.
Dispatch failures emit GraphQL errors and return a null mutation field;
`AutomationRun.error` describes the retained execution outcome.

## Completion and inspection

A successful process exit marks the action done through ordinary
action handling and Calendar sync. This completion edit materializes a projection
if the agent has not edited it already. Failed, timed-out, or cancelled processes
do not change its lifecycle. The harness supplies only delegation context, the owning
instance ID, an `Action` handle, and a pointer to the user's instruction artifact.
The context says the user delegated an action to complete, a successful exit marks
it done, and the agent should follow the user's instructions autonomously.
The agent discovers the action's other metadata and content through Aside.

Completion sets `resolution: done` on the current action, preserving its other
fields. Edits to its body, schedule, delegation, or lifecycle during execution
do not prevent completion, including cancellation or clearing delegation.
If the action no longer exists or a completion write fails, the process result
remains successful and `AutomationRun.completionError` explains the failure.
Review has no separate lifecycle state.

`Action.delegation.log` and `Action.delegationLog` scope retained history to the action
or, for a template, all its occurrence runs, including unsaved projections.
Filters apply before offset/limit pagination, ordered by newest start and ID.
All run inspection uses `AutomationRun`, `AutomationRunPage`, and
`AutomationRunWhere` (including name, ID, and status filters): process status,
timestamps, dispatch lateness,
model, launched prompt, cwd, command/args, PID, exit code/signal, metadata and log
paths, and bounded UTF-8 `output` paging. Counts exclude pruned history.
`AutomationRun.action` resolves the current saved action
or projected occurrence by immutable identity, independently of query lookahead.
`AutomationRun.automation` resolves the current declaration, which may differ
from the launch configuration or be null after clearing delegation.
Output, launched prompts, and process outcomes use automation's retained storage
limits; `Action.delegationLog` remains available after clearing a declaration.
Instance/project automation logs exclude delegation runs. Inspection never dispatches work.
