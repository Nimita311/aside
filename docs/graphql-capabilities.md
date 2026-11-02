# GraphQL schema map

MCP `query` → `Query`; MCP `mutate` → `Mutation`. Selected fields below;
[full contracts](../design/graphql.md) · schema resource: `aside://graphql/schema`.

## Basic entities

| Type | Purpose | Selected fields |
| --- | --- | --- |
| `Instance` | Record collection | `id`, `path`, `active`, `settings`, `body`, `automations`, `automationLog`, `execution`, `validation` |
| `Entry` | Captured context | `id`, `filePath`, `content`, `description`, `created`, `projects`, `actions`, `artifacts` |
| `Project` | Ongoing effort | `id`, `filePath`, `name`, `body`, `status`, `ended`, `relatedProjects`, `actions`, `entries`, `artifacts`, `automations` |
| `Action` | Work / recurrence template / occurrence | `id`, `filePath`, `name`, `body`, `status`, `scheduled`, `deadline`, `calendar`, `recurrence`, `occurrence`, `delegation`, `delegationLog`, `projects`, `entries`, `artifacts` |
| `Artifact` | Maintained content | `id`, `filePath`, `name`, `content`, `attachments`, `backlinks`, `projects`, `actions`, `entries` |
| `ArtifactContent` | Primary content union | `MarkdownContent` / `Attachment` |
| `MarkdownContent` | Markdown content | `text` |
| `Attachment` | File content / attachment | `filename`, `handle`, `filePath`, `backlinks`, `error` |
| `ProjectRelation` | Directional project relationship | `project`, `direction`, `outgoingDescription`, `incomingDescription` |
| `ProjectRelationDirection` | Declaration direction | `OUTGOING`, `INCOMING`, `BIDIRECTIONAL` |
| `LinkTarget` | Shared record interface | `id`, `handle`, `created`, `description`, `filePath`, `links`, `backlinks`, `attachmentLinks` |

| Enum | Values |
| --- | --- |
| `ProjectStatus` | `OPEN`, `CLOSED` |
| `ActionStatus` | `BACKLOG`, `SCHEDULED`, `DONE`, `CANCELLED` |

## Record queries

| Single record | Collection | Result types |
| --- | --- | --- |
| `Query.entry(id)` | `Query.entries` | `Entry`, `EntryPage` |
| `Query.project(id)` | `Query.projects` | `Project`, `ProjectPage` |
| `Query.action(id)` | `Query.actions` | `Action`, `ActionPage` |
| `Query.artifact(id)` | `Query.artifacts` | `Artifact`, `ArtifactPage` |

Collection arguments: `where`, `offset`, `limit`, `orderBy`.

| Schema names | Fields / granularity |
| --- | --- |
| `EntryWhere`, `ProjectWhere`, `ActionWhere`, `ArtifactWhere` | IDs, search, dates, relationships; `and`, `or`, `not` |
| `EntryRelationFilter`, `ProjectRelationFilter`, `ActionRelationFilter`, `ArtifactRelationFilter` | `some`, `none` |
| `ActionWhere` → `OccurrenceWhere` | `recurrenceExists`; `occurrence { template, original, projected }` |
| `EntryPage`, `ProjectPage`, `ActionPage`, `ArtifactPage` | `nodes`, `offset`, `count`, `totalCount` |
| `Project.relatedProjects` → `ProjectRelationPage` | Target `where`, relation `direction` list, `orderBy`, `offset`, `limit`; resolved relation nodes |
| `LinkTarget.links`, `.backlinks`; `Attachment.backlinks` → `LinkPage` | Exact record references, `offset`, `limit`; resolved record nodes |
| `LinkTarget.attachmentLinks` → `AttachmentPage` | Referenced attachments; `nodes`, `offset`, `count`, `totalCount` |
| `RecordOrder` | `CREATED_ASC`, `CREATED_DESC` |
| `ActionOrder` | Creation, schedule, deadline: `CREATED_*`, `SCHEDULED_*`, `DEADLINE_*` (`ASC` / `DESC`) |
| `Date` | `YYYY-MM-DD`; inclusive date bounds |

## Create and update

| Mutation | Input | Result |
| --- | --- | --- |
| `Mutation.capture(input)` | `CaptureInput` | `CapturePayload`: `entry`, `createdProjects`, `createdActions`, `error` |
| `Mutation.updateEntry(id, input)` | `UpdateEntryInput` | `EntryPayload`: `entry`, `createdProjects`, `createdActions`, `error` |
| `Mutation.updateProject(id, input)` | `UpdateProjectInput` | `ProjectPayload`: `project`, `error` |
| `Mutation.updateAction(id, input)` | `UpdateActionInput` | `ActionPayload`: `action`, `error` |
| `Mutation.createArtifact(input)` | `CreateArtifactInput` | `ArtifactPayload`: `artifact`, `error` |
| `Mutation.updateArtifact(id, input)` | `UpdateArtifactInput` | `ArtifactPayload`: `artifact`, `error` |

Projects/actions are created in entry context through `capture` or `updateEntry`.
Omitted update fields are preserved; bodies accept replacement text.

### Link, patch, and upsert inputs

| Input | Operations |
| --- | --- |
| `ProjectLinkInput`, `ActionLinkInput` | `existingId` **or** `create` → `CreateProjectInput` / `CreateActionInput` |
| `ProjectTagEditsInput`, `ActionTagEditsInput` | `set`, `add`, `remove` through `UpdateEntryInput.projects` / `actions` |
| `RelatedProjectEditsInput` | `set`, `upsert`, `remove` through `UpdateProjectInput.relatedProjects` |
| `RelatedProjectInput` | `project`, `description` |
| `ArtifactAttachmentInput` | `source`, `filename`; artifact inputs: `attachments`; `UpdateArtifactInput.removeAttachments` |
| `UpdateActionInput.status`, `UpdateOccurrenceInput.status` | `DONE` / `CANCELLED`; `BACKLOG` clears schedule and completion; `SCHEDULED` requires schedule; null clears a template's lifecycle |

## Recurrence and occurrences

| Schema name | Fields / operation |
| --- | --- |
| `Action.recurrence` → `RecurrenceSchedule` | `dtstart`, `rrule`, `timezone` |
| `Action.occurrence` → `Occurrence` | `template: Action`, `original`, `timezone`, `projected` |
| `CreateActionInput.recurrence` → `RecurrenceScheduleInput` | Create a template; `[]` creates a dormant template |
| `UpdateActionInput.recurrence` → `RecurrenceMutationInput` | `append`, `setEnd`, `remove` (one operation) |
| `RecurrenceEndInput`, `RecurrenceScheduleSelectorInput` | End at `at`; select by `dtstart`, `timezone` |
| `Mutation.updateOccurrence(input)` → `ActionPayload` | `UpdateOccurrenceInput`: `template`, `original`, individual action edits |

Template: `recurrence != null`, `status = null`; find with `recurrenceExists: true`.
`Query.actions` includes projections within `recurrenceLookaheadDays`.
`Occurrence.projected = true` means computed, unsaved future work; editing saves it and
returns `projected = false`. Templates define commitments; automations execute work.

## Delegation

Delegation is an automation owned by an action, named `delegation`.

| Schema name | Fields / operation |
| --- | --- |
| `Action.delegation` → `Automation` | Common automation declaration and observations; schedule derives from the action, overlap is `SKIP` |
| `DelegationInput` → `AgentRunInput` | Action creation and edits; complete `run { model, prompt }`, optional `timeout` |
| `Mutation.runDelegation(id)` → `AutomationRun` | Force immediate execution of a saved action or projected occurrence; returns the execution directly; dispatch failures emit GraphQL errors |
| `Action.delegationLog`, `Action.delegation.log` → `AutomationRunPage` | Retained action history; templates include all occurrence runs; shared `AutomationRunWhere`, `offset`, `limit` |
| `AutomationRun.action` | Current saved or projected action owner; null for instance/project jobs |
| `AutomationRun.completionError` | Successful execution whose action completion could not be saved |

[Delegation](../design/delegation.md) follows action scheduling and marks the
action done on successful execution, including after edits during the run.
Done/cancelled actions never run from lifecycle edits. Explicit dispatch bypasses timing; queries remain passive.

## Automations

| Query | Result | Selected fields |
| --- | --- | --- |
| `Instance.execution` | `Execution` | `filePath`, `cwd`, `models(refresh)` |
| `Execution.models(refresh)` | `ModelOption` list | `name`, `label`, `availability`, `reason` |
| `Instance.automations`, `Project.automations` | `AutomationPage` | Declarations owned by that instance or project |
| `Automation.log`, `Project.automationLog` | `AutomationRunPage` | Retained runs for that job / project |
| `Instance.automationLog` | `AutomationRunPage` | Retained runs of instance-owned jobs, including removed declarations |
| `AutomationRun.output(stream, offset, limit)` | `AutomationLogPage` | `text`, `offset`, `nextOffset`, `totalBytes` |

| Schema name | Fields / operations |
| --- | --- |
| `Automation` | `name`, `schedule`, `run`, `enabled`, `timeout`, `overlap`, `next`, `running`, `log` |
| `AutomationSchedule`, `AutomationRunDefinition` | Persisted schedule / script or model invocation |
| `UpdateInstanceInput.automations`, `UpdateProjectInput.automations` → `AutomationEditsInput` | `set`, `patch`, `upsert`, `remove` |
| `CreateAutomationInput`, `UpdateAutomationInput` | `name`, `schedule`, `run`, `enabled`, `timeout`, `overlap` |
| `AutomationScheduleInput`, `AutomationSchedulePatchInput` | `cron` / `rrule` + `dtstart` / `at`; `timezone` |
| `AutomationRunInput`, `AutomationRunPatchInput` | `script` + `args` / `model` + `prompt` |
| `ArtifactLinkInput` | `existingId` **or** `create: CreateArtifactInput`; `AutomationRunDefinition.prompt` → `Artifact` |
| `ModelAvailability` | `AVAILABLE`, `UNKNOWN`; `run.model` is a catalog-validated string |
| `AutomationOverlap` | `LATEST`, `SKIP` |
| `AutomationPage`, `AutomationRunPage` | `nodes`, `offset`, `count`, `totalCount` |
| `AutomationRun` | `id`, `status`, `started`, `finished`, `error`, `model`, `command`, `exitCode`, `filePath`, `output` |
| `AutomationRunWhere` | `id`, `name`, `status: [AutomationRunStatus!]` |
| `AutomationRunStatus` | `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `UNOBSERVED` |
| `AutomationLogStream` | `STDOUT`, `STDERR` |

Schema discovery and metadata-only instance reads are passive; the schema is static.

## Instance settings and navigation

| Operation | Input | Result |
| --- | --- | --- |
| `Query.instances` | — | `Instance` list |
| `Query.activeInstance` | — | `Instance` |
| `Mutation.selectInstance(path)` | Directory path | `SelectInstancePayload` |
| `Mutation.createInstance(input)` | `CreateInstanceInput`: `path`, `name`, `description`, `body`, `tutorial` | `CreateInstancePayload` |
| `Mutation.updateInstance(input)` | `UpdateInstanceInput`: `body`, `settings`, `automations` | `InstancePayload` |
| `Mutation.show(input)` | `ShowInput`: `project`, `action`, `detail`, `entry`, `artifact`, `filename`, `asset` | `ShowPayload`: `url`, `outcome`, `error` |
| `Mutation.showUrl(input)` | `ShowInput` | `String`: private handoff file URL for opening in a chosen local browser |

| Type | Selected fields / values |
| --- | --- |
| `Instance.settings` → `InstanceSettings` | Effective `recurrenceLookaheadDays`, `scheduledEventTitlePrefix`, `doneEventTitlePrefix`, including defaults |
| `UpdateInstanceInput.settings` → `InstanceSettingsInput` | Patch selected settings; omission preserves, null title prefixes restore defaults |
| `ShowOutcome` | `OPENED`, `UNAVAILABLE` |

Record queries use the session's selected instance.
`show` opens the default browser; `showUrl` leaves opening to the caller. Both
prepare fresh automatic authorization and redirect to the requested view. See
[navigation and authorization](../design/graphql.md#validation-navigation-and-calendar-information).

## Diagnostics and partial results

| Schema name | Selected fields |
| --- | --- |
| `Instance.validation` → `InstanceValidation` | `passed`, `dataChecksRun`, `checks` |
| `ValidationCheck` | `name`, `passed`, `details` |
| `Mutation.calendarInfo` → `CalendarInfoPayload` | `authorization`, `calendars`, `syncStates`, `diagnostics`, `failures`, `issues`, `changes`, `error` |
| `Calendar` | `name`, `account`, `writable` |
| `CalendarActionState` | `id`, `status`, `diagnostic` |
| `CalendarDiagnostic` | `category`, `reason`, `recovery` |
| `CalendarAuthorization`, `CalendarSyncState` | Permission / synchronization enums |
| `CalendarFailure`, `CalendarIssue`, `CalendarChange` | Per-action failures, consistency issues, observed changes |

Response metadata (outside the type schema):

| Path | Meaning |
| --- | --- |
| `extensions.diagnostics` | Issues and recovery |
| `extensions.complete` | Whether counts / absence are reliable |
| `extensions.mutations` | `{operation, error, changes}`; confirmed saved effects |

`error: null` means success; partial failure returns available objects and one
message describing saved effects, failure, and recovery. Full failure returns no
payload or durable changes. Writes are serial; earlier successful operations
remain saved. Failed instance activation stops later writes.
`calendarInfo` may request Calendar permission.
