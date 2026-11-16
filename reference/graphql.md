# GraphQL surface

Sources: [executable schema](../cli/src/graphql/sdl.ts) · [system schema](../cli/src/graphql/system-info-sdl.ts) · [persisted YAML](frontmatter.md). GraphQL names use camel case.

## Discovery

| Item | Behavior |
| --- | --- |
| `document` | Required GraphQL source text. |
| `variables` | Optional JSON object. |
| `operationName` | Optional; required to disambiguate multiple operations. |
| MCP tools | `query` for queries; `mutate` for mutations; no subscriptions. |
| Response | Structured content and JSON text; GraphQL errors mark MCP reply as error and retain available partial data. |
| Full schema | `aside://graphql/schema`: documented SDL. |
| Targeted schema | Introspection, e.g. `__type(name: "ActionWhere")`; an alternative to full SDL. |
| Discovery effects | Static; no selected instance or model-vendor contact required. |
| Model choices | Strings from `Instance.execution.models`, not an enum. |

| MCP resource | Purpose |
| --- | --- |
| `aside://docs/records` | Find, capture, edit, and open records/files |
| `aside://docs/planning` | Schedule work, recurrence, and Calendar |
| `aside://docs/automate` | Configure and inspect automatic execution |
| `aside://docs/setup` | Instances, startup, and settings |
| `aside://docs/about` | Product concepts and rationale |

## Root queries

| Field | Result / purpose |
| --- | --- |
| `systemInfo` | Global build, daemon, installation, search prerequisites, and Calendar status; probes only selected sections |
| `geocodeAddress(input:)` | Native Apple place/address candidates; no selection, record writes, API key, or current-location permission required |
| `instances` | Workspace candidates and daemon-known instances, including canonical paths and selection/membership metadata |
| `activeInstance` | This session's selected instance or null |
| `entry(id:)`, `project(id:)`, `action(id:)`, `artifact(id:)` | Exact typed record; IDs omit handle prefixes |
| `entries`, `projects`, `actions`, `artifacts` | Typed filtered pages |
| `search(where:, rankBy:, offset:, limit:)` | Globally ordered saved-record hits across types |

| Item | Behavior |
| --- | --- |
| Record scope | Selected instance. |
| Metadata discovery | Available without selection. |
| Instance fields | Records, instructions/settings, validation, Calendar sync, automations/history, execution context. |
| Geocode input | `query` text; optional geographic `region` hint, not a restriction. |
| Geocode result | Status and provider-ordered names, coordinates, formatted addresses, inspection URLs. |
| No match | `NO_RESULTS`; refine query and retry. |
| Selection / effects | No automatic candidate choice; rendering never geocodes. |

## Records and relationships

| Type | Selected fields |
| --- | --- |
| `Entry` | `id`, `created`, `description`, `content`, `filePath`, `projects`, `actions`, `artifacts` |
| `Project` | `id`, `name`, `body`, `status`, `ended`, `relatedProjects`, `actions`, `entries`, `artifacts`, `automations` |
| `Action` | `id`, `name`, `body`, `status`, scheduling fields, `recurrence`, `occurrence`, `delegation`, `projects`, `entries`, `artifacts` |
| `Artifact` | `id`, `name`, `content`, `attachments`, `projects`, `actions`, `entries` |
| `ArtifactContent` | Union of `MarkdownContent {text}` and `Attachment` |
| `Attachment` | `filename`, `handle`, validated `filePath`, `backlinks`, `error` |
| `LinkTarget` | Common `id`, `handle`, `created`, `description`, `filePath`, `links`, `backlinks`, `attachmentLinks` |
| `ProjectRelation` | `project`, `direction`, `outgoingDescription`, `incomingDescription` |

| Item | Behavior |
| --- | --- |
| Relationships | Entry tags/authored references; see [record designs](../design/system.md#data-structure). |
| Links/backlinks | Exact record or attachment targets. |
| `relatedProjects.direction` | `OUTGOING`, `INCOMING`, `BIDIRECTIONAL`; combines with target filters/pagination. |

## Filters and pages

| Item | Behavior |
| --- | --- |
| Collection arguments | `where`, `orderBy`, `offset`, `limit`; filter/order before pagination. |
| Page fields | `nodes`, `offset`, `count`, `totalCount`. |
| Next page | Continue at `offset + count` until `totalCount`, including nested pages. |
| Counts | Matches before pagination; check [completeness](#responses-and-failures). |
| Page defaults/limits | [Configuration](configuration.md#behavior-defaults). |

| Predicate | Meaning |
| --- | --- |
| `ids` | Exact IDs; `[]` matches nothing |
| `createdFrom` / `createdTo` | Inclusive authored-date bounds; similarly `ended`, `scheduled`, and `deadline` on relevant types |
| `regex` | Case-insensitive ECMAScript pattern over authored text; excludes attachment bytes |
| `search` | Deprecated alias for `regex`; cannot coexist with it in the same filter |
| `and`, `or`, `not` | Boolean composition; siblings are ANDed; `and: []` is true, `or: []` false |
| `projectIds`, `actionIds`, `relatedTo` | Association IDs where supported; `[]` means no association; `relatedTo` considers existing outgoing links |
| `projects`, `actions`, `entries`, `artifacts`, `relatedProjects` | Typed relationship predicates with `some` / `none` over the full related set |
| `status` | `ProjectStatus`: `OPEN`/`CLOSED`; action status list: `BACKLOG`/`SCHEDULED`/`DONE`/`CANCELLED` |
| `EntryWhere.browse` | Native project/action focus, literal `search`, and entry timestamp bounds, including inline references |
| `ActionWhere.recurrenceExists` | Template presence, including dormant `[]` |
| `ActionWhere.occurrence` | `template`, exact `original`, and/or `projected`; `{}` matches any occurrence |

| Item | Behavior |
| --- | --- |
| `some: {}` | At least one related record. |
| `none: {}` | No related records; incomplete diagnostics prevent confirmed absence. |
| Omitted/null filter | Unrestricted. |
| Date bounds | `YYYY-MM-DD`. |
| Record order | `CREATED_DESC` default; `CREATED_ASC` supported. |
| Additional action orders | `SCHEDULED_ASC/DESC`, `DEADLINE_ASC/DESC`. |
| Missing dates / ties | Missing values last in either direction; deterministic ID ties. |
| Unsaved occurrence | No creation time. |

### Projection schedule ranges

| Item | Behavior |
| --- | --- |
| Collection members | Saved actions, templates, projected occurrences. |
| Expansion bounds | Positive schedule predicates through Boolean branches. |
| Non-bounding predicates | `not` and related-record predicates do not bound parent expansion. |
| Implicit upper bound | One calendar year after today or a later positive lower bound; applies only to unsaved projections. |
| Exact action lookup | Resolves projection IDs independently of collection ranges. |
| `extensions.defaultProjectionRanges` | Implicit ends excluding matches; aliased paths and affected templates. |
| Completeness | An implicit projection end does not make the response incomplete. |
| Chosen review period | Supply explicit `scheduledFrom` and `scheduledTo`. |
| Template lifecycle | Null status; negated status predicates can include templates. |
| Work-only query | Add `recurrenceExists: false`. |

## Search

| Item | Behavior |
| --- | --- |
| `SearchWhere` groups | `entries`, `projects`, `actions`, `artifacts`; typed filters above. |
| No groups | Search all saved kinds. |
| Non-null groups | Union of only supplied kinds. |
| `rankBy` | Exactly one: `semantic` plain language, or `order` creation/schedule/deadline. |
| Page fields | `hits`, `totalCount`, `count`, `offset`, `model`, `indexedChunks`. |
| Hit fields | `kind`, `handle`, `snippet`, `score`, typed `record`. |
| Counts | Eligibility before ranking; counts-only selections skip inference. |
| Semantic ranking | No hidden match threshold or language fallback. |
| Excluded content | Attachment bytes and unsaved projections. |
| Unavailable | `SEMANTIC_SEARCH_UNAVAILABLE` with reason/recovery/model. |
| Model service failure | `SEMANTIC_SEARCH_FAILED`. |

## Mutations

| Mutation | Main input / result |
| --- | --- |
| `selectInstance(path:)` | Existing directory → selection receipt |
| `createInstance(input:)` | `path`, `name`, `description`, optional `body`/`tutorial` → creation/selection receipt and optional `tutorialProjectId` |
| `updateInstance(input:)` | Instructions, settings, automations → `InstancePayload` |
| `capture(input:)` | Entry content/description and project/action links → entry plus created records |
| `updateEntry(id:, input:)` | Content/description and link edits → entry plus created records |
| `updateProject(id:, input:)` | Name/body, closure, relationships, automations → `ProjectPayload` |
| `updateAction(id:, input:)` | Name/body, lifecycle, scheduling, recurrence, delegation → `ActionPayload` |
| `updateOccurrence(input:)` | Exact template/original identity plus ordinary action edits → materialized/reused `ActionPayload` |
| `createArtifact(input:)`, `updateArtifact(id:, input:)` | Maintained body and attachment operations → `ArtifactPayload` |
| `runDelegation(id:)` | Immediate saved/projected action execution → retained `AutomationRun`; template IDs require an occurrence |
| `show(input:)` | Local browser opening or HTTP MCP public URL → URL/outcome/error |
| `showUrl(input:)` | HTTP URL for the client browser to open |
| `requestCalendarAccess` | Explicit macOS permission request → global Calendar status |

| Item | Behavior |
| --- | --- |
| Selection lifetime | This session only. |
| Select/create failure | Stops later writes. |
| Registration failure after creation | Files survive; recover by selecting their path. |
| Project/action creation | Entry context through capture/updateEntry. |
| Artifact creation | Independent of entries. |
| Projection edit | Materializes without creating an entry. |

### Writes

| Input family | Behavior |
| --- | --- |
| `content` / `contentFile`; `body` / `bodyFile` | Mutually exclusive per field. File sources are absolute readable regular UTF-8 server-local files; the full text is used without metadata parsing. Resolve all sources before writes |
| Ordinary updates | Omit to preserve; value to replace. Nullable fields clear with null. Name, description, content/body reject null; empty content/body clears |
| Entry project/action links | `set` or `add`/`remove`; links use `existingId` or contextual `create` |
| Related projects | `set` or `upsert`/`remove`; directional descriptions retained |
| Automations | `set` or `patch`/`upsert`/`remove`; patches preserve omitted nested fields and allow explicit clearing |
| Recurrence | Exactly one of `append`, `setEnd`, or `remove`, selecting exact authored start/zone; final removal retains dormant `[]` |
| Artifact prompts | `ArtifactLinkInput`: exactly one of bare `existingId` or complete inline `create` |
| Attachments | `source` absolute file path, optional `filename`; add/replace by exact name; `removeAttachments` removes names. Reject conflicting destinations and dangling references |

| Item | Behavior |
| --- | --- |
| Collection replacement | `set` is exclusive with patch operations; `set: []` replaces with no items. |
| Empty/null edit container | Generally preserves collection; exact exceptions in schema descriptions. |
| Recurrence history edits | Cannot expose new unsaved past occurrences. |
| Saved-record identity | Preserved by writes. |
| `BACKLOG` | Clears schedule/resolution. |
| `SCHEDULED` | Requires schedule. |
| Template status | Remains unresolved. |

### Execution and Calendar inspection

| Item | Behavior |
| --- | --- |
| `Instance.execution` | Configuration `filePath`, effective `cwd`, `models(refresh:)`. |
| New model value | Validate against defining instance catalog. |
| Saved unavailable model | Remains readable. |
| `refresh: true` | Explicit vendor rediscovery. |
| Automation observation | `next`, `running`, `log`; owner `automationLog` pages. |
| `Action.delegationLog` | Survives clearing declaration; template includes all occurrence runs. |
| `AutomationRun` | Status, timing, model, command, output paths, `completionError`. |
| `output(stream:, offset:, limit:)` | UTF-8 byte pages; continue while `nextOffset < totalBytes`. |
| Run status | `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `UNOBSERVED`. |
| Inspection effects | Never dispatches work. |
| `systemInfo.calendar` | Authorization/destinations; no permission request or event access. |
| `Instance.calendarSync` | `syncStates`, `failures`, `issues`, imported `changes`; available even when helper fails. |
| Local save | Does not confirm Calendar event; inspect pending/failed observations. |
| `Instance.validation` | `passed`, `dataChecksRun`, detailed checks. |

## Responses and failures

| Response extension | Meaning |
| --- | --- |
| `diagnostics` | Observed issues and recovery |
| `complete` | False whenever diagnostics exist, including model warnings; assess before asserting counts/absence |
| `mutations` | Confirmed operation effects, including partial saves; `operation`, `error`, `changes`, and optional nonfatal notices |
| `defaultProjectionRanges` | Implicit recurrence expansion bounds |

| Item | Behavior |
| --- | --- |
| Success | Mutation payload `error: null`. |
| Partial failure | Saved objects retained; incomplete steps explained. |
| Confirmed effects | Mutation receipts and failing field’s `errors[].extensions.partialResult`. |
| Write ordering | Serial; later failure does not roll back earlier effects. |
| Partial/lost response | Read back; retry only unapplied requested work. Creates have no idempotency key. |
| Budget exhaustion | Abort without partial data; retain confirmed mutation receipts. |
| Limits | [Query limits](configuration.md#query-limits) also apply to introspection. |

## Query collection

```graphql
query Workspace {
  instances { id name path }
  activeInstance { id body }
  systemInfo { calendar { authorization } search { semantic { available reason recovery } } }
}
```

```graphql
query ProjectReview($id: ID!) {
  project(id: $id) {
    id name body
    actions(where: {status: [BACKLOG, SCHEDULED]}, limit: 20) {
      nodes { id name scheduled deadline } offset count totalCount
    }
    entries(limit: 3) { nodes { id description content } totalCount }
  }
}
```

```graphql
query PlannedWork($from: Date!, $to: Date!) {
  actions(where: {recurrenceExists: false, scheduledFrom: $from, scheduledTo: $to},
          orderBy: SCHEDULED_ASC, limit: 20) {
    nodes { id name status scheduled occurrence { original projected template { id } } }
    offset count totalCount
  }
}
```

```graphql
query Recall($need: String!) {
  search(rankBy: {semantic: $need}, limit: 10) {
    totalCount model indexedChunks
    hits { handle snippet score record { ... on Entry { content } ... on Project { name body } } }
  }
}
```

```graphql
mutation Capture($contentFile: String!, $description: String!) {
  capture(input: {contentFile: $contentFile, description: $description}) {
    entry { id } error
  }
}
```

### Webpage queries

| Item | Behavior |
| --- | --- |
| Endpoint | `POST /-/api/instances/<address>/graphql`. |
| Request | `{query, variables?, operationName?}`. |
| Scope | Read-only, instance chosen by URL; remote authentication belongs to deployment. |
| Allowed roots | `entry`, `entries`, `project`, `projects`, `action`, `actions`, `artifact`, `artifacts`, `search`. |
| Excluded operations | Mutations, instance discovery, introspection except `__typename`, automation/runtime, model discovery, geocoding. |
| Nested objects | Records, references, attachments, recurrence, search results. |
| Limits | [Configuration](configuration.md#query-limits). |
| SDK bootstrap | Aside installs `window.aside` before indexed HTML preview scripts; startup JS/CSS inline. |
| SDK call | `aside.query(query, variables?, {operationName}?)`. |
| Resources | `aside.resource(reference)` → Blob, up to 16 MiB; parent performs protected reads. |
| Resource references | `./filename` in the source artifact, or canonical indexed attachment handle in the selected instance. |
| Media | Use Blob URLs; release when replaced. Direct protected resource URLs are outside the authoring contract. |
| Lifetime | Preview replacement/navigation or instance switch revokes the bridge and cancels pending work. |
| GraphQL errors | Resolve with response. |
| Transport/input/timeout errors | Reject promise. |
| Standalone HTML / external iframe | No SDK capability. |
| Trust | [Browser boundary](../design/interfaces.md#browser-boundary). |
