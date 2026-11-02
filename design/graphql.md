# GraphQL agent interface

`aside mcp` uses GraphQL by default and exposes only `query` and `mutate`.
Records, instance operations, validation, webapp navigation, and calendar
information are GraphQL fields. Use `aside mcp --legacy` to opt into the separate
legacy tools for one MCP session. Plugin installation pairs the selected API
with its own skill: `agent/graphql` by default, `agent/legacy` with
`aside plugin install --legacy`. Both packages use the same plugin identity;
changing mode replaces the registration rather than installing competing skills.

Both interfaces use the same daemon instance, parsed records, relationship
derivations, persistence handlers, and calendar sync. GraphQL introduces no
persisted fields or separate database. GraphQL.js executes inside the daemon;
no additional HTTP listener is needed.

The existing localhost web server also exposes instance-scoped, read-only record
queries for HTML artifact dashboards. Its restricted query policy and iframe SDK
are specified in [Iframe GraphQL](../webapp/spec.md#iframe-graphql).

## Agent surface

The GraphQL skill is a thin orientation: record purposes, basic handles,
authoritative versus derived relationships, and a concise five-choice guide
routing table with schema discovery.
Keep only high-level, frequently needed orientation in the skill. Authoring syntax and
examples, response mechanics, and task-specific edge cases belong in the shared
instructions or guides below; field contracts belong in the executable schema.
Guides and schema discovery are available before instance selection; record work
starts by checking the selection and loading its instructions through `Instance.body`.
The legacy skill and its file references ship only in the legacy package.
Neither package includes harness specifications or test results.

GraphQL MCP initialization embeds the skill body, stripping its YAML front matter,
so clients without skills receive the same foundation. The build imports the
skill directly; there is no separately maintained copy or runtime file read.
Initialization adds the shared access, intent, response, and read/write recovery
instructions from `cli/src/mcp/resources/shared/session.md` inline.
`resources/list` advertises exactly five guides plus the schema resource:

| Guide URI | Responsibility |
| --- | --- |
| `aside://docs/records` | Find, recall, capture, and edit entries, projects, actions, artifacts, and attachments |
| `aside://docs/planning` | Review backlog and deadlines, schedule work, manage recurrence, and diagnose Calendar sync |
| `aside://docs/automate` | Schedule execution, configure custom runtimes, and inspect execution state |
| `aside://docs/setup` | Select or create an instance, understand startup discovery, and change instance settings |
| `aside://docs/about` | Deeper design rationale: plain text ownership, execution, architecture, and instance boundaries |

The sixth resource, `aside://graphql/schema`, provides the documented executable
schema. The about guide is for conceptual questions, not a prerequisite for tasks.

Guides are bundled from `cli/src/mcp/resources/`; reading them requires neither
an active instance nor a daemon connection. The about resource distills the design
docs without repeating the skill's record model or API mechanics. Task guides
contain only additional Aside-specific policy or behavior that cannot be inferred
from the schema, with precise operation
and type pointers. Task guides have no cross-guide prerequisites; relevant adjacent
steps appear inline so the usual task needs one guide. Plain code references such
as `Type` or `Type.field` identify schema symbols. Agents use the skill's shared
`aside://graphql/schema` discovery link or targeted introspection to inspect them.
The four operational guides include `shared/authoring.md` in the same
resource response: voice, formatting, handles, attachments, and prepared inputs are maintained once
and delivered in the same read. The fragments are bundled, not separately listed
resources or additional prerequisites. Task-specific lifecycle, creation-context,
and planning policies stay in the relevant guide. Headings, bullets, and operation
tables keep each guide scannable.

Generic agent advice, GraphQL tutorials, and copied field contracts do not belong
in the guides. The executable schema owns field contracts and replacement/clearing
semantics; initialization instructions describe response extensions outside the
type system and provide common read/write recovery steps. There is no separate
recovery resource.

`aside://graphql/schema` reads documented SDL directly from the daemon through
the read-only `graphql.schema` RPC, carrying this MCP session. The daemon returns
`{ result: { sdl, diagnostics }, session }`. It uses the executable schema shared
with GraphQL validation and execution, without reconstructing a schema from
introspection JSON. SDL is printed lazily once per executable schema object.
The schema is static across instance selection and execution configuration.
Schema resources and introspection do not discover models, load records, or arm
jobs. Model names are ordinary strings validated against the defining instance's
catalog when supplied in writes.

Prefer targeted introspection through `query` for a few known types, and the
resource for the complete readable API or broad exploration; these are alternate
routes, not consecutive prerequisites. Discover runtime choices separately through
`Instance.execution.models`; select `refresh: true` to recheck vendor discovery.
Each request retains its catalog snapshot across concurrent refreshes.
Schema failures are reported instead of falling back to stale content; resource
diagnostics remain available as SDL comments.
Legacy MCP does not advertise these resources or GraphQL initialization instructions.

The two tool descriptions contain only their operation purpose and resource
routing. Tool input schemas describe transport arguments; GraphQL describes the API.

## Discovery and responses

Both tools require `document` containing standard GraphQL source text, plus
optional JSON `variables` and optional
`operationName`. The latter is required for ambiguous multi-operation documents.
`query` accepts only queries; `mutate` accepts only mutations.
Subscriptions are unsupported. Discover types, fields, and inputs with standard
introspection through `query`:

```graphql
{ __type(name: "ActionWhere") { inputFields { name description } } }
```

The GraphQL response is returned as MCP `structuredContent` and as JSON in a text
block. GraphQL errors mark the reply `isError`, preserving partial data except
when an [execution budget](#execution-bounds) aborts the operation. Extensions
always contain `diagnostics`, `complete`, and `mutations`. Completeness is
conservative: any diagnostics make it false, including model-discovery warnings.
Inspect their categories before drawing conclusions. Record diagnostics or
missing relationship targets also prevent `none` from asserting absence.

`extensions.mutations[].operation` is the GraphQL mutation field name, regardless of
aliases or internal handler routing. Editing a projection through `updateAction`
reports `updateAction`; calling `updateOccurrence` reports `updateOccurrence`.

## CLI

The same GraphQL interface is available with `aside graphql query` and
`aside graphql mutate`. Provide `--document '<graphql>'` or
`--document-file <path>` (`-` reads stdin), optional `--variables '<json>'` or
`--variables-file <path>`, and `--operation-name <name>` for named documents.
`--dir <path>` selects an instance; otherwise workspace discovery and configuration
follow MCP. Selection lasts for one invocation, so put selection and dependent
writes in one mutation document.

The CLI returns standard GraphQL JSON directly and exits with status 1 when
errors occur. It retains available partial data and `extensions.mutations`. `--json` is
accepted with identical output. Document syntax, static schema selections, and
operation mode are checked before contacting the daemon; instance-specific
model validation runs in the daemon before writes. Query requests may be retried after
connection loss, while mutations are never automatically repeated.

```sh
aside graphql query --document '{ instances { id name path } }'
aside graphql mutate --dir ~/aside/work --document-file save.graphql --variables-file values.json
```

## Local usage logging

The daemon collects GraphQL queries and mutations in
`graphql/<instance-key>/YYYY-MM-DD-NNN.jsonl`, grouped by accessed instance.
Paths are relative to the [daemon log directory](daemon.md#files), which also
contains `daemon.log` and follows `ASIDE_DAEMON_HOME` relocation.
The key is the SHA-256 hash of the canonical instance directory. Each collection's
`instance.json` links that key to the canonical path and current manifest ID.
Aliases share a collection; different directories, including worktrees and
instances with duplicate IDs, remain separate. Moving an instance directory
starts a new collection. Request events themselves do not contain instance paths.
Collection is automatic for requests
through MCP and the CLI, including the legacy `query`/`mutate` execution path.
Other legacy tools, HTTP requests, and schema-resource reads are not logged.
CLI document validation before daemon connection remains outside collection.

Each completion event has `schemaVersion: 1`, UTC `timestamp`, `requestId`,
`operation`, redacted `shape`, SHA-256 `shapeHash`, selected `fields`,
`durationMs`, `outcome`, `errorCategory`, `errorCount`, and `effects` counts.
Shapes describe only the selected operation, expand fragments, remove aliases
and authored operation/variable names, and replace argument values with `?`.
No literal values, variable values, record IDs, paths, returned content, or
freeform error messages are retained. Invalid source can have a null shape.
Field paths describe the requested selections, including selections skipped by
directives; they are not counts of resolver invocations.

Attribution follows actual record and instance-content access and successful
selection/creation. A request that crosses instances writes one event to each,
sharing its request ID. Each copy contains only that instance's confirmed write
counts; request duration and overall outcome describe the complete operation.
If execution resolves no instance, its initial active instance receives the
event when one was supplied. Unscoped discovery/introspection is not logged and
logging never loads a Store to invent an instance. Metadata-only instance
listings do not create collections in every listed directory.
Confirmed writes count journal changes, including indexes, files and attachments,
as well as records. GraphQL errors and mutation receipt errors both contribute to
failure classification; durable effects remain counted after a partial failure.

The host serializes asynchronous appends per canonical instance directory with
a bounded 4 MiB total queue and a 256 KiB event limit. Daily files rotate at
5 MiB. Retention and explicit purge follow the
[daemon diagnostic policy](daemon.md#diagnostic-retention), with cleanup serialized
against appends to each collection. Unrelated files are untouched.
Directories use `0700`, files `0600`; log-directory and log-file symlinks are
rejected. Logging writes no files or Git ignore rules inside instance directories
and does not trigger their record watchers. Daemon-home relocation moves these
collections with the other daemon logs.

I/O failures and queue overflow drop events without changing GraphQL responses.
`aside daemon status` exposes queued bytes, dropped events, and logging errors
for the current daemon process. Shutdown allows up to two seconds to flush after
requests drain. A crash can lose unfinished or buffered events; these are usage
logs, not a durable audit journal. Read retries appear as separate executions.

```bash
aside usage summary --dir ~/aside/work --since 7d
aside usage summary --dir ~/aside/work --since 30d --json
```

Summary reads retained JSONL directly without starting a daemon or collecting
another event. `--dir` resolves the instance's collection in the configured log
folder; it defaults to the current directory. `--since` defaults to
`7d`. It reports query/mutation counts, outcomes, introspection requests, common
shapes and fields, confirmed writes, and nearest-rank p50/p95 daemon execution
latency. Malformed or truncated lines are skipped and counted. The writer
terminates an incomplete final line before appending, preserving subsequent events
after a crash. Client startup,
MCP queueing, and transport latency are outside the timing measurement.
Existing `.aside-logs/graphql/` collections from the earlier instance-local
implementation remain readable alongside central logs; summaries neither move
nor modify those files. All new collection writes use the daemon log folder.

## Instances

`instances` lists the session's workspace candidates together with the daemon's
other known instances. `activeInstance` returns this session's selection or null.
Both fields and schema introspection work without an active instance. An
`Instance` exposes `id`, `name`, `description`, canonical `path`, `active`,
`workspace`, `settings`, `body`, `automations`, and `validation`. Settings return
effective values including defaults. Workspace membership comes from startup discovery, `.aside`
configuration, and `--dir`; selecting or creating an instance does not change it.
Distinct directories with duplicate IDs remain separate rows. Configuration,
manifest, record, and duplicate-identity diagnostics appear in extensions.

```graphql
query {
  activeInstance { id name path }
  instances { id name description path active workspace }
}

mutation {
  selectInstance(path: "/data/work") { instance { id path active } error }
}

mutation {
  createInstance(input: {
    path: "/data/personal"
    name: "Personal"
    description: "Personal projects and notes"
    tutorial: true
  }) {
    instance { id path }
    tutorialProjectId error
  }
}
```

`selectInstance` selects an existing instance. `createInstance` requires an empty
or nonexistent directory and creates and activates it, preserving the legacy
`path`, `name`, `description`, optional instruction `body`, and `tutorial` inputs.
Prefer absolute paths. Relative selection and creation paths resolve against
the MCP session's launch working directory, not the daemon's directory.
Selection is local to this MCP session and does not modify the saved startup
default. Other sessions retain their selections. Record root fields use the
active instance; a later mutation field uses the selection made by an earlier
`selectInstance` or `createInstance` in the same document.

Instance mutation payloads expose `error: String`, null on success. If instance
files saved but activation failed, `createInstance` returns the available
instance and one error message naming
saved effects, failure, and recovery. The previous selection remains active.
Resolve the problem and call `selectInstance` for the saved path; do not recreate
it. Full failure returns no payload and leaves no durable changes.

Failed selection or activation stops all later mutation effects through an
explicit guard, so dependent writes cannot land in the previous instance.
Earlier successful operations retain their results in `extensions.mutations`.
Root record queries use the selected instance. Startup defaults remain local
configuration rather than a mutation field.

Metadata-only `activeInstance` and `instances` reads inspect identity, settings,
and instructions without loading records or starting scheduling. `validation`
runs file checks when selected, with diagnostics in the response. It returns null with no valid
selection and never chooses an alternative. Mutation payloads retain their
`instance` fields for the selected, created, or updated instance.

Startup discovery reads `.aside` only in the MCP launch working directory.
Automation execution reads `.aside` at the instance root instead, and Git
worktree policy reads `worktreeDetection` in the primary checkout's root `.aside`.
By default linked worktrees do not write Calendar events or run automations;
`worktreeDetection: false` restores independent-instance behavior, with duplicate
identity checks still enforced. `updateInstance` edits the instruction body,
Calendar title prefixes, recurrence lookahead, and automation declarations while
preserving identity and omitted fields. Empty instruction text clears the body;
empty prefixes remove decoration, while null prefixes restore application defaults.
Settings are patched under `UpdateInstanceInput.settings` through
`InstanceSettingsInput`; omission preserves each value and null restores its
default for title prefixes. Null lookahead is rejected. `Instance.settings`
exposes effective values through `InstanceSettings`.

## Records and relationships

Root fields provide `entry`, `project`, `action`, and `artifact` by ID, and
`entries`, `projects`, `actions`, and `artifacts` collections. Records expose ID,
canonical handle, index description, domain fields directly on the object,
and their content. For example, query `Entry.created`,
`Project.name`, `Action.scheduled`, and `Artifact.content` without storage-format
wrappers. `filePath` is the absolute path of the containing Markdown file; entries
share their weekly file. Unsaved action projections have null `filePath` and
`occurrence.projected: true`. Entry tag relationships return resolved projects
and actions; select their `id` when needed. Missing targets are omitted and
reported by validation. Status reuses the derived lifecycle state.
Enums use `BACKLOG`, `SCHEDULED`, `DONE`, `CANCELLED`, `OPEN`, and `CLOSED`.

`activeInstance` exposes the selected instance's root path, settings, and instructions.
`Instance.automations` returns only instance-owned declarations, and
`Project.automations` only that project's declarations, as typed `AutomationPage`
collections. `Automation` exposes the declaration, `next` and `running`
conveniences, and `log` history. Invalid saved declarations have null configuration
fields and source diagnostics. Unavailable observations are null.

`automations.patch` on instance/project updates changes supplied fields on
existing jobs, recursively merging schedule/run fields and preserving omitted
values, including saved unavailable model choices. Null removes optional fields;
the merged job must remain valid. `upsert` creates/replaces complete named jobs
and `remove` deletes named jobs. Unrelated declarations are not validated.
`automations.set` replaces all declarations on that owner and validates every
supplied job; `set: []` clears it and is exclusive with incremental operations.

`Automation.log` scopes retained history to that job; `Project.automationLog`
scopes it to that project. `Instance.automationLog` includes only instance-owned
jobs. Each owner retains history for removed declarations within that owner.
`AutomationRunWhere.status` accepts a list; omit it for any status, or use [] for none. `AutomationRun.output`
reads bounded stdout/stderr byte pages. These observations do not execute work.
Inspection problems appear in diagnostics; retained history can remain available.

`Instance.execution` exposes execution configuration and `models(refresh:)`.
Select `models` to discover built-in and named choices; use each `ModelOption.name`
exactly as the string `run.model`. Only supplied choices require a current catalog
match; omitted saved selections are preserved. Model discovery diagnostics include
the defining instance's configuration path in response extensions.

`Action.recurrence` exposes typed template schedules. `Action.occurrence`
resolves its template as an `Action`; `template.id`, `original`, and
optional `timezone` form its immutable identity. Missing or invalid template
targets return null with consistency diagnostics. `projected` distinguishes an
unsaved occurrence from a saved one; edit/filter inputs retain the template ID. Ordinary actions and recurrence templates have no occurrence.

The same `Action` type represents all three domain shapes. A non-null recurrence
list identifies a template, with `[]` retaining a dormant template. Templates
have null `status`: they define repetition and do not have an ordinary work
lifecycle. Ordinary actions and occurrences have no recurrence list and retain
the derived `BACKLOG`, `SCHEDULED`, `DONE`, or `CANCELLED` status. Occurrence
provenance identifies one repetition independently of that lifecycle; its
projected flag indicates whether the repetition is saved, not whether it is done.

All action collections include saved actions, recurrence templates, and future
projected occurrences within the instance's `recurrenceLookaheadDays` horizon.
The same fields, relationship filters, counts, and pagination apply to each;
there is no separate planning query. `action(id:)` also resolves generated IDs
within that horizon. Date filters narrow this finite set rather than expanding
recurrence outside the configured lookahead. Projections inherit their template's
current projects and artifact context, without creating persistent entry tags
or artifact backlinks.

`ActionWhere.occurrence` filters by projected state and/or exact template ID.
An empty occurrence predicate matches any occurrence, excluding ordinary actions
and templates; combine it with `not` to select actions without an occurrence.
`projected: false` selects saved occurrences, while
`not: {occurrence: {projected: true}}` excludes projections and keeps other saved action kinds.
All-day projections include today through the horizon date, while timed
projections are strictly after the current minute through the horizon. The
unified collection does not generate unsaved past occurrences or an extra
occurrence beyond the configured horizon. Projection failures contribute
response diagnostics and make `extensions.complete` false.

`ActionWhere.recurrenceExists: true` selects every non-null recurrence list,
including `[]` and nonempty histories whose schedules have ended or produce no
future occurrences. False selects ordinary actions and saved or projected
occurrences. Omitted or null leaves the filter unrestricted. Unfiltered lists
still include templates, while a direct lifecycle status predicate excludes
them. For example,
`status: [BACKLOG]` selects unresolved unscheduled work, rather than template
definitions. Null status is an output state for templates, not a valid item in
the status enum filter. Boolean composition follows normal predicate logic:
`not: {status: [DONE]}` includes null-status templates. Add
`recurrenceExists: false` alongside that predicate for work excluding templates.

`updateAction(id:, input:)` accepts a listed projection ID and materializes that
occurrence automatically, returning its saved action.
`updateOccurrence(input:)` edits an exact template/original identity and returns
the saved action. A projection's `Action.handle` is transient and must not be
stored as a durable reference; an occurrence edit returns its saved action
handle. See [recurrence](recurrence.md).

Relationships reuse the [record graph](record-model.md):

- Project/action association follows entry metadata and live recurrence template inheritance.
- Project/action `entries` follow tagged and inline entry references in the graph.
- Entry `projects` and `actions` follow its metadata tags. Entry ID association
  filters also remain metadata-only.
- Artifact project/action associations reuse the current reference derivation.
  Artifact `entries` and entry `artifacts` use valid entry references to the artifact
  or its attachments, separate from exact-target backlinks.
- `relatedProjects` returns a `ProjectRelationPage`, with one existing target per
  pair. `ProjectRelation` contains non-null `project` and `direction` plus separate
  outgoing/incoming descriptions. Direction reports which side declared the
  [open-ended relationship](project.md#related-projects); both declarations yield
  `BIDIRECTIONAL`. Its `direction` list filters edges and `where` filters targets
  before counts and pagination; omit direction for any, or [] for none.
  `relatedTo` filters existing outgoing or bidirectional targets.
- Artifact `attachments` returns indexed filenames, handles, validated absolute paths,
  and retrieval errors through the existing attachment validator.
  Attachment contents are not loaded into query responses.

`Artifact.content` is the `ArtifactContent` union of `MarkdownContent` and
`Attachment`, following [artifact content selection](artifact.md#file-content).
`MarkdownContent.text` is returned without additional trimming; attachment
content is represented by metadata, not file bytes. `attachments` includes every
attachment, including supporting files alongside Markdown content. Artifact
create/update inputs retain `body` for authoring Markdown and use `attachments`
(`ArtifactAttachmentInput`) for imports; `removeAttachments` removes exact filenames.
`Attachment.filePath` gives the validated saved-copy path. See the
[records resource](../cli/src/mcp/resources/records.md#retrieve-and-attach-files)
for a fragment query.

`LinkTarget` is an interface implemented by `Entry`, `Project`, `Action`, and
`Artifact`. Shared identity, creation, description, file path, and reference fields
can be selected directly; concrete fragments select entity-specific content.
`links` and `backlinks` return `LinkPage` collections of record objects.
`attachmentLinks` returns `AttachmentPage` collections of file targets, and
`Attachment.backlinks` returns the records referencing that exact file.
Attachments never originate links; their bytes are not scanned, including
when an attachment is an artifact's primary content. Artifact backlinks target
only the artifact itself, and attachment backlinks target only that attachment.

Canonical handles and internal relative/absolute file paths resolve existing
targets; code, external URLs, record self references, and missing targets do not
create graph members. A record can reference its own attachments. Missing targets
are omitted before counts and diagnosed with the source file and target type/ID.
Results deduplicate and sort by canonical handle. Contextual artifact associations
remain separate from these direct edges. Projections expose inherited forward
links without becoming persistent backlink sources. See the
[content-reference query](../cli/src/mcp/resources/records.md#follow-content-references).

## Filters and pagination

`where` supports existing scalar filters: exact IDs, inclusive date bounds,
lifecycle status, and case-insensitive ECMAScript regex search. The `Date` scalar
accepts real `YYYY-MM-DD` dates; bounds compare the authored date portion, not
converted instants. Search matches the same fields as legacy queries and runs
through the existing bounded regex worker pool. Scalar and relationship filters
narrow candidates before search; nested collections search their related set.

Relationship inputs support nested `some` and `none` predicates. An empty
predicate matches all records: `projects: { none: {} }` finds unassigned actions.
`and` and `or` accept lists; `not` accepts one predicate. Sibling conditions are
all required; empty `and` is true and empty `or` is false. Null optional filters are omitted.

ID association filters use `projectIds`/`actionIds`, reserving
`projects`/`actions` for relationship predicates. Empty exact-ID or action-status
lists match nothing; empty association-ID lists mean unassociated.

```graphql
query Overdue($yesterday: Date!) {
  actions(
    where: {
      status: [BACKLOG, SCHEDULED]
      deadlineTo: $yesterday
      projects: { some: { status: OPEN } }
    }
    limit: 20
  ) {
    nodes {
      id
      name
      deadline
      occurrence { template { id } original projected }
      projects(where: { status: OPEN }) { nodes { id name } }
    }
    totalCount
    offset
    count
  }
}
```

Each collection returns a `*Page` with `nodes`, `offset`, `count`, and
`totalCount`. `limit` defaults to 20 (range 1–100); `offset` is a nonnegative
integer, defaulting to zero. `count` is the number of items in the requested page.
`orderBy` supports `CREATED_DESC` (default) and `CREATED_ASC`,
with ID as a deterministic tie-breaker. Action collections use `ActionOrder`,
which also supports `SCHEDULED_ASC`/`SCHEDULED_DESC` and
`DEADLINE_ASC`/`DEADLINE_DESC`; other collections use `RecordOrder`.
Date ordering puts missing or unresolvable values last in both directions,
with creation time ascending then ID ascending as tie-breakers. Timed schedules
compare instants in the action's zone; floating schedules and all-day midnight
use the server's local zone. Deadlines always use the server's local zone,
independently of the action's scheduled timezone. Filters apply before pagination;
relationship predicates inspect the full related set, not its returned page.
`totalCount` counts matches before pagination. Continue at `offset + count` while
that value is below `totalCount`; nested collections paginate independently.
Changes between calls can move page boundaries.

Cross-record arithmetic, correlated value comparisons, arbitrary aggregation,
and variable-length paths are not built-in filters. Fetch connected evidence
and compute these in the agent.

## Validation, navigation, and calendar information

Validation belongs to `Instance`. Query `activeInstance { validation { passed
checks { name passed details } } }`, or select `validation` on entries in
`instances` to check several instances without switching the active selection.
`dataChecksRun` distinguishes a blocked manifest check from completed data
checks. Each request reads the files directly and reuses results for repeated
selections of the same instance. Record queries remain root shortcuts for the
active instance; they do not require an `activeInstance` wrapper.

Use `show(input:)` to open the requested view in the default browser, or
`showUrl(input:)` to get a URL for the agent to open in its chosen browser.
Both are mutations because they prepare fresh
[browser authorization](daemon.md#browser-authorization). They share `ShowInput`:
project or action filters, one entry/asset/artifact/detail view, and an optional
artifact attachment filename. No input targets the active instance's timeline.
`show` returns `url` (the clean bookmark URL), `outcome` (`OPENED` or
`UNAVAILABLE`), and `error`. `showUrl` returns a single `String`, without opening
or navigating a browser.

Each call creates a temporary private HTML handoff file. Opening it automatically
authorizes that browser and redirects to the requested destination, including
when its session is missing or expired. The `file://` URL returned by `showUrl`
is intentional: owner-only file permissions protect its one-use authorization
code. Request a fresh URL for each opening and open it immediately, unchanged, in
a browser/profile on the same machine able to read local files. It expires after
two minutes and is not a bookmark. Agents need no token or authentication steps.

`calendarInfo` is a single mutation that reports authorization, available
calendars, diagnostics, per-action sync states, outstanding failures/issues,
and changes observed since the instance loaded. It requests full access when
permission is undecided or write-only, preserving the macOS permission prompt.
Denied, restricted, unavailable, and helper failure states are returned as
structured data with recovery guidance. No active instance is required for
machine authorization and calendars; an active instance adds its sync state.
`calendars: null` means listing was unavailable, while `[]` means it succeeded
with no calendars. Calendar information never reads or writes events.

```graphql
query {
  activeInstance { validation { passed dataChecksRun checks { name passed details } } }
}

mutation {
  calendarInfo {
    authorization calendars { name account writable }
    diagnostics { category reason recovery }
    syncStates { id status reason retry diagnostic { category recovery } }
  }
  show(input: { project: "2026-10-07-migration", detail: true }) { url outcome }
}

# Open the returned file URL in the browser chosen by the agent.
mutation {
  showUrl(input: { project: "2026-10-07-migration", detail: true })
}
```

These mutations append `{operation, error, changes}` to `extensions.mutations`,
even when the caller omits `error`. Query mode rejects their mutation documents before prompting
for permission, preparing authorization, or opening the browser.

## Writes

Mutations are `updateInstance(input:)`, `capture(input:)`, `updateEntry(id:, input:)`,
`updateProject(id:, input:)`, `updateAction(id:, input:)`,
`updateOccurrence(input:)`, `createArtifact(input:)`, and `updateArtifact(id:, input:)`. Inputs preserve the
domain validation, `contentFile`/`bodyFile`, artifact imports/removals, and
supported null clearing. GraphQL fields, arguments, and input fields use
camelCase; storage field names remain unchanged. Omitted fields preserve values;
null is accepted only where the underlying operation supports clearing.

Prefer patches that send only fields being changed. Entry tag edits use
`UpdateEntryInput.projects`/`actions` with `add` link inputs and `remove` IDs;
`UpdateProjectInput.relatedProjects` uses `upsert` relationship descriptions and
`remove` IDs. Incremental edits preserve other links and current ordering,
appending new ones. Re-adding a
saved tag or removing an absent link is harmless. Duplicate IDs and IDs appearing
in both operations are rejected. Omitted or null collection inputs and empty
incremental lists do nothing. Each collection edit input supports `set` for
explicit complete replacement, exclusive with incremental operations; `set: []`
clears it. Entry `set` and `add` accept links to existing records or inline
creates. Replacing tags changes associations without deleting their records.
Bodies accept replacement text; recurrence schedules and attachments use their
existing edit commands.

Updating a projected action uses the same ordinary editable fields as an action
edit and saves the occurrence. Its synthetic ID is resolved within the current
lookahead; recurrence commands apply to templates or convert an eligible ordinary
action into a template. For an explicit
occurrence edit, copy `Action.occurrence.template.id` and `.original` into
`UpdateOccurrenceInput` rather than recomputing identity from its current schedule.

Model automation prompt inputs use `ArtifactLinkInput @oneOf`: exact
`existingId` or inline `create: CreateArtifactInput`. `AutomationRunDefinition.prompt`
returns the resolved `Artifact`. Its primary body or single readable text attachment
supplies instructions at launch; raw prompt text and filename selectors are not
GraphQL inputs. Inline creations are prepared before effects and saved within the
owner's mutation journal after its preflight succeeds. Existing stored literals or
explicit file references remain on disk; selecting them as an artifact returns
null with conversion guidance. `AutomationRun.prompt` retains the actual launched
text, including harness context.

Project creation accepts initial `automations` as `[CreateAutomationInput!]`.
Project and instance updates accept `automations: AutomationEditsInput`, with
`set`, `patch`, `upsert`, and `remove`. Each complete declaration contains
`name`, `schedule`,
`run`, and optional definition fields; `run.model` is a catalog-validated string.
All selected mutation roots are preflighted before any write. In documents that
switch instances, each automation model must be selectable in the instance
receiving that write. Omission or null preserves declarations; `set: []` clears
them. Prefer incremental operations for individual job changes.
`updateInstance` also patches instructions, recurrence lookahead, and Calendar
title prefixes through `settings`, preserving its identity and omitted configuration.

Action creation accepts an initial `recurrence` list, with `[]` creating a dormant
template. Omit optional creation fields that do not apply; creation inputs do
not use update-style null clearing. `updateAction.input.recurrence`
is a OneOf command: `append: {dtstart, rrule, timezone?}`,
`setEnd: {schedule: {dtstart, timezone?}, at?}`, or `remove: {dtstart, timezone?}`.
It changes the selected template's schedules and preserves saved occurrences.
Removing the last schedule retains `recurrence: []` and null status; schedule
commands do not turn the template back into an ordinary action.
`append` can also convert an ordinary action, retaining its ID, entry tags, and
context. Its resulting state must have no scheduled time or completion; use
`status: null` in the same update to clear a template's lifecycle. Occurrences
cannot be converted
because their provenance is immutable. Invalid changes fail before writing.
See [schedule changes](recurrence.md#schedule-changes).

`UpdateActionInput.status` and `UpdateOccurrenceInput.status` express lifecycle
commands. `DONE` and `CANCELLED` retain the current schedule. `BACKLOG` clears
both schedule and completion; `SCHEDULED` clears completion and requires a
resulting scheduled time. Null is accepted only when the resulting action is a
template, clearing lifecycle fields; omission preserves the current lifecycle.
Storage retains resolution and scheduling separately; the public object exposes
the derived `status` and its useful `scheduled` value.

Project/action link inputs use standard GraphQL OneOf objects with exactly one
of `existingId` or `create`. The adapter converts these into existing mixed
ID/new-record lists before calling the domain handler.

```graphql
mutation {
  capture(input: {
    content: "Review the migration plan."
    description: "Migration review"
    projects: [{ existingId: "2026-10-07-migration" }]
    actions: [{ create: {
      name: "Review plan"
      description: "Review the migration plan"
    } }]
  }) {
    error
    entry { id }
    createdActions { id }
  }
}
```

Payloads expose available affected records and `error: String`. Null means
success. Partial failure returns the saved records or IDs and one agent-readable
message describing what saved, what failed, and how to recover. Capture and entry
payloads include `createdProjects`/`createdActions`; navigate the entry for all links.
Full failure returns no payload, raises a GraphQL error, and leaves no durable
changes from that operation. Validation and write preparation run before effects
wherever possible; durable saved effects determine partial failure.

Each completed operation appends `{operation, error, changes}` to
`extensions.mutations`, even when those fields are not selected or a later
response field fails. `changes` retains confirmed record, file, and index effects
with their available IDs and paths. This applies to linked
creates, record/index saves, attachment imports/removals, and instance writes.
A missing description index row is reported even when the record saved.

Top-level mutations execute serially with a fresh read view after each write.
They are not a transaction: earlier successful writes remain saved on failure.
Only `query` is classified as a repeatable read by the daemon client.
Never automatically retry mutations after an uncertain transport outcome.
Inspect partial results and read back the affected records; retry only requested
changes that remain unapplied. Occurrences can be recovered with exact
`ActionWhere.occurrence: {template, original}` regardless of rescheduling.
Partial results describe responses that arrive; a completely lost response still
requires readback because creates have no idempotency key.

## Execution bounds

Mixed record and instance-metadata queries share one loaded snapshot regardless
of sibling field order. Reads retain a consistent snapshot of records, descriptions, and relationships.
The latest snapshot is reused until the Store revision changes. Metadata writes,
attachment reconciliation, diagnostics, and external rebuilds create a fresh view.
Older snapshots remain valid for reads already in flight. Scalar filters compile
only requested checks, exact root IDs use direct lookup, and created ordering is
reused within the snapshot. Count-only selections avoid constructing a page.

Complete non-regex root matches are cached per snapshot, so offset continuations
reuse the join. This LRU retains at most 32 filters, 100,000 record references, and
8,192 characters per filter key. Failed evaluations, nested collection results,
and regex results are not cached. Filters containing regex keep their candidate
scope, including through Boolean and relationship predicates. Cancellation and
evaluation budgets belong to each request, including checks on cached reads.
The first read after a record change rebuilds the snapshot and computes uncached
filters. Index-only changes copy descriptions for the affected record kind and
refresh cached node references. Metadata, graph maps, ordering, and non-regex
matches remain valid; older reads retain their descriptions. Regex runs anew.
Parsing, variables, expanded fragment selections, filters, record evaluations,
resolved fields, response text, and serialized query responses are bounded.
Current limits are:

- 64,000 document characters and 5,000 tokens.
- 256,000 serialized variable characters, 24 variable levels, 5,000 variable nodes.
- 16 selection levels, 2,000 expanded selections across the document, checked
  before schema validation; 100 query/20 mutation root fields per operation.
- 12 filter levels and 100,000 evaluations per read view.
- 100,000 executed response fields and 8 MiB of UTF-8 text from coerced leaf
  values, including strings inside lists.
- 8 MiB for the complete serialized query response, checked with a bounded walk
  before JSON serialization.

Standard introspection, explicit resolvers, and default resolvers share the same
execution budgets. Exceeding a runtime budget aborts the operation and returns an
error without partial data. Already completed mutation effects remain recorded
in `extensions.mutations`; there is no rollback, and later mutation fields do
not run. Already-started mutation effects settle before cancellation is reported,
preserving their receipts and final session selection. Cancellation propagates to
cooperative asynchronous work, including regex search and model discovery. The
executor stops scheduling fields and expanding results after exhaustion; it
cannot preempt a synchronous resolver already in progress. Cancellation is also
checked during filtering and before each write. Ordinary field errors retain
GraphQL's partial-data behavior.

The [canonical query benchmark](query-benchmark.md) compares equivalent GraphQL
and legacy query plans for latency, tool calls, dependency rounds, and payload
size, including pagination and optional real MCP transport.
