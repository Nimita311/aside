# Find, capture, and edit records

## Find connected context

Follow linked entries for context, and project bodies and artifact content for current facts.

Project relationships are open-ended and can support discoverability. Their
descriptions explain their meaning. For hierarchy, declare the link from the
higher-level project to the lower-level project.

| Find or inspect | Schema reference |
| --- | --- |
| Entries, projects, actions, and artifacts | `Query.entries`, `Query.projects`, `Query.actions`, `Query.artifacts` |
| Exact wording and pattern matches | Collection `where.regex`; `EntryWhere.regex`, `ProjectWhere.regex`, `ActionWhere.regex`, `ArtifactWhere.regex` |
| Unified entity search, including semantic ranking | `Query.search`, `SearchWhere`, `SearchRanking`, `SearchPage`, `SearchHit` |
| Check semantic-search prerequisites | `Query.systemInfo`, `SystemInfo.search`, `SystemSearchInfo.semantic`, `SemanticSearchAvailability` |
| Entry text, dates, or tags | `EntryWhere` |
| Action text, state, or associated projects | `ActionWhere` |
| Unassigned work or absent relationships | `ActionWhere.projectIds`, `ProjectRelationFilter.none` |
| Project relationship targets and direction | `Project.relatedProjects`, `ProjectRelation.direction` |
| Filter existing outgoing project relationships | `ProjectWhere.relatedTo` |
| Counts and pagination | `ActionPage.offset`, `ActionPage.count`, `ActionPage.totalCount` |
| Record consistency | `Instance.validation` |
| Resolve an address or place to coordinates | `Query.geocodeAddress`, `GeocodeAddressInput` |
| Open a view in the default browser | `Mutation.show` |
| Get a URL to open in a chosen browser | `Mutation.showUrl` |

Record fields such as `Entry.created`, `Project.name`, `Action.scheduled`, and
`Artifact.content` are exposed directly. `filePath` gives the absolute containing
Markdown file path; entries share a weekly file. Entry relationships return
resolved projects and actions, whose IDs can be selected directly. Missing
targets are omitted and reported by validation. Action queries also include recurring
occurrences within the requested projection range; `Action.occurrence.projected` identifies
unsaved occurrences computed from their template. Reading never saves them;
editing returns a saved occurrence with `projected: false` and its saved ID,
handle, and `filePath`. Unsaved projections have null `filePath` and `created`.
The flag says whether the occurrence is saved; `Action.status` describes
its lifecycle. Templates have a non-null `Action.recurrence` list, including `[]`
when dormant, and a null status. Use `ActionWhere.recurrenceExists` to select or
exclude all templates, including ones whose schedules have ended. Direct status
predicates exclude templates; negated predicates can include them. Add
`recurrenceExists: false` to a negated lifecycle filter when selecting only work.
See [Planning](aside://docs/planning) for schedule ranges, identity, and
edit behavior. Projections inherit their template's current project and artifact
context. Use `Action.occurrence` when editing an individual repetition; its `template`
resolves the template `Action`, and `template.id` supplies the edit identity.

`Project.relatedProjects` returns one `ProjectRelation` per existing target.
`OUTGOING` is declared here, `INCOMING` by the other project, and `BIDIRECTIONAL`
means both declare the relationship. `outgoingDescription` and
`incomingDescription` retain their respective descriptions. Use the `direction`
list filter to select any combination before pagination; include `BIDIRECTIONAL`
when selecting every relationship pointing in or out.

## Filter and rank unified search

`Query.search` combines saved entries, projects, actions, and artifacts in one
ordered page. Each `SearchWhere` group uses the existing entity filter contract,
including dates, status, relationships, Boolean composition, and `regex`.
Omit `where` or use `{}` for all saved kinds. Supplying non-null groups selects
only those kinds; their eligible records are combined. A group with `{}` selects
all saved records of that kind. Null groups are omitted.

Regex is an explicit case-insensitive ECMAScript pattern, without delimiters or
flags. Keep it in each entity's filter. The old entity `where.search` field is a
deprecated alias for `regex`; do not put both in one filter. Existing typed
collection queries retain their own ordering, pagination, and relationship views.

```graphql
query FindWording($pattern: String!) {
  search(where: {
    entries: { regex: $pattern }
    actions: { regex: $pattern, status: [BACKLOG, SCHEDULED] }
  }, limit: 20) {
    totalCount count offset
    hits { kind handle snippet record { filePath } }
  }
}
```

Choose top-level `rankBy.semantic` for a natural-language information need,
including paraphrases with no exact wording in common. It ranks only records
satisfying the per-entity filters, by their best passage similarity. Regex
filtering and semantic ranking can be used together explicitly. Without semantic
ranking, search requires no embedding inference and defaults to newest creation
first. `rankBy.order` can choose creation, schedule, or deadline order; missing
schedule/deadline values and non-actions sort last in either direction.

The daemon maintains a disposable semantic index for each registered instance.
GraphQL writes and direct file edits schedule incremental synchronization.
Semantic ranking requires the configured embedding model and checks that the
index matches the current source before returning results. Setup failures are
explicit, with no fallback.

Check `SystemSearchInfo.semantic` through `Query.systemInfo` before relying on
semantic ranking in a new environment. It works without an instance selection and checks native support,
the configured Ollama endpoint, and model installation without inference or
indexing:

```graphql
query {
  systemInfo { search { semantic { available reason message recovery model } } }
}
```

If unavailable, explain the returned `message` and `recovery` to the user.
The check does not install Ollama, start it, or download a model. Availability is
a current prerequisite check, not a promise that every later inference request
will succeed. If a semantic request fails, inspect `errors[].extensions.code`,
`reason`, `recovery`, and `model`: `SEMANTIC_SEARCH_UNAVAILABLE` identifies a
missing prerequisite; `SEMANTIC_SEARCH_FAILED` identifies a model-service error.
Do not silently change the request to regex or field ordering.

```graphql
query {
  search(
    where: { entries: {createdFrom: "2026-10-01"}, projects: {} }
    rankBy: {semantic: "What did we decide about ending the sketch without dialogue?"}
    limit: 10
  ) {
    totalCount count offset model indexedChunks
    hits {
      kind handle snippet score
      record {
        filePath
        ... on Entry { content created }
        ... on Project { name body }
      }
    }
  }
}
```

`limit` and `offset` apply once to the combined ordering. `totalCount` counts all
saved records satisfying the filters, before ranking or pagination. Semantic
ranking changes order, not membership; there is no implicit similarity threshold.
Counts alone do not force embedding inference. Empty semantic result pages
still check index synchronization but do not embed query text. Hits are unique
records. Scores are cosine similarities for semantic
ranking and null for field ordering; they are not confidence probabilities.
Follow `SearchHit.record` for full content and relationships and cite handles or
source paths. Search covers saved Markdown and descriptions; attachment bytes
and unsaved recurring projections are excluded. Existing action collection
queries still include their normal recurrence projections. Index updates run
independently of queries; failed updates remain pending and are retried. A
semantic query waits for a current index or reports the failure rather than
using stale vectors.

## Open a browsing view

Use `show` when Aside should open the system's default browser:

```graphql
mutation {
  show(input: { project: "2026-10-07-migration", detail: true }) {
    url outcome error
  }
}
```

Use `showUrl` when the agent will open the view with its own browser tool:

```graphql
mutation {
  showUrl(input: { project: "2026-10-07-migration", detail: true })
}
```

Both accept `ShowInput`; empty input targets the active instance's timeline.
Pass `source: "#artifact/<id>/<filename>"` to open an explicit timeline definition. It composes
with `project` or `action`; content targets retain it as return context.
`showUrl` returns an HTTP URL without opening or navigating a browser. Open it
unchanged in the chosen browser. Local CLI/stdio URLs use localhost; HTTP MCP
URLs use the public request origin. `show` opens the host default browser for
local CLI/stdio and returns outcome `RETURNED` for HTTP MCP, leaving opening to
the client. Remote browser access uses deployment authentication.

## Follow content references

`LinkTarget` is the shared interface for `Entry`, `Project`, `Action`, and
`Artifact`. Its `links` and `backlinks` return first-class records through
`LinkPage`; `attachmentLinks` returns file targets through `AttachmentPage`.
These direct references are separate from tagged/contextual associations.
They resolve canonical handles and internal record/file links; code examples,
external URLs, self-references, and missing targets do not contribute to counts.
Validation reports missing targets with their source file and target ID.

`Artifact.backlinks` includes links to the artifact itself. `Attachment.backlinks`
includes links to that exact file. Attachments never originate links: their bytes
are not scanned, including when a file is an artifact's primary content.
Projections expose inherited forward content without creating persistent backlink sources.

Select shared interface fields directly and use fragments for specific content:

```graphql
query References($id: ID!) {
  artifact(id: $id) {
    links { offset count totalCount nodes { ...LinkedRecord } }
    backlinks { offset count totalCount nodes { ...LinkedRecord } }
    attachmentLinks { nodes { filename handle filePath backlinks { nodes { id handle } } } }
  }
}
fragment LinkedRecord on LinkTarget {
  __typename
  id handle created description filePath
  ... on Entry { content }
  ... on Project { name }
  ... on Action { name status }
  ... on Artifact { name }
}
```

## Capture a conversation

Propose capturing meaningful check-ins, decisions, context, and next steps.
Find fitting open projects; clarify uncertain capture value or project fit.
Allow untagged capture when a link is declined or no useful link fits.

| Task | Schema reference |
| --- | --- |
| Create an entry with contextual work | `Mutation.capture`, `CaptureInput` |
| Amend the current entry | `Mutation.updateEntry`, `UpdateEntryInput` |
| Replace or add/remove entry tags | `UpdateEntryInput.projects`, `UpdateEntryInput.actions` |
| Link or create projects/actions | `ProjectLinkInput`, `ActionLinkInput` |

## Maintain projects, actions, and artifacts

- Keep project facts and artifact content current.
- Close projects rather than delete them.
- Routine edits need no entry; offer to capture an occasion or decision separately when worth preserving.
- The server generates IDs and `created` timestamps; an entry's timestamp is always now. ID collisions are rejected before anything is written.
- A scheduled action with a target calendar maps to an event. Its deadline, description, and body become event notes; include references useful when performing the work.
- Edit the Aside action, not its derived event. Calendar-bound writes start synchronization automatically; inspect pending or failed sync with `Instance.calendarSync`.

| Task | Operation and input |
| --- | --- |
| Read current project / action / artifact content | `Query.project`, `Query.action`, `Query.artifact` |
| Edit project facts, name, summary, or links | `Mutation.updateProject`, `UpdateProjectInput`, `RelatedProjectInput` |
| Patch selected outgoing project relationships | `UpdateProjectInput.relatedProjects` |
| Close or reopen a project | `UpdateProjectInput.ended` |
| Edit or resolve an action, saving a projection when needed | `Mutation.updateAction`, `UpdateActionInput` |
| Create maintained content | `Mutation.createArtifact`, `CreateArtifactInput` |
| Edit content or attachments | `Mutation.updateArtifact`, `UpdateArtifactInput` |

Send only fields being changed. Prefer collection edits over reading and writing
back a full list: entry tag edits use `add`/`remove`, project relationships use
`upsert`/`remove`, and automation jobs use `patch`/`upsert`/`remove`. Each collection
also supports `set` to replace its complete contents; `set: []` clears it, and
`set` is exclusive with incremental operations. Omitted or null collection
inputs and empty incremental lists preserve existing items. Entry `add` and
`set` can link existing records or create new ones through the link inputs.
Bodies accept replacement text;
recurrence uses schedule commands and attachments use file imports/removals.

## Define an entry view

Create or update an artifact with a JSON supporting attachment, imported through
the attachment inputs below. Its exact attachment handle identifies the timeline;
filenames have no reserved meaning. Keep the query and its grouped conditions agent-owned. People
can pin, browse with one project/action focus and literal search, and inspect the
effective query without editing the definition.

```json
{
  "query": "query Focus($where: EntryWhere) { entries(where: $where, orderBy: CREATED_DESC) { nodes { id } } }",
  "variables": { "where": { "createdFrom": "2026-10-01" } }
}
```

The query selects an entry-page connection, including `nodes { id }`, under a
root or singular parent. Add `result` with the response path, such as
`"project.feed"`, when several entry pages are selected. Optional `operationName`
selects a named query. Native browsing combines its predicates with the query
before pagination, retains the authored ascending or descending creation order,
and supplies the page fields it needs. Test the query through `query`, then use
`showUrl(input: { source: "#artifact/<id>/decisions.json" })` to open it.
Sidebar sections explicitly reference timeline attachments or entity handles;
the webapp does not discover views by scanning filenames.

## Define the sidebar

Sidebar membership is explicit in the selected instance's `aside.md` at
`config.webapp.sidebar`. Read the current list before replacing it:

```graphql
query Sidebar {
  activeInstance { settings { webapp { sidebar { title items { label timeline entity } } } } }
}
mutation SetSidebar($sidebar: [SidebarSectionInput!]!) {
  updateInstance(input: { settings: { webapp: { sidebar: $sidebar } } }) { error }
}
```

```json
{"sidebar":[{"title":"Focus","items":[
  {"label":"Recent decisions","timeline":"#artifact/2026-10-12-review/decisions.json"},
  {"label":"Aurora entries","timeline":"#project/2026-10-12-aurora"},
  {"label":"Aurora brief","entity":"#project/2026-10-12-aurora"},
  {"label":"Dashboard","entity":"#artifact/2026-10-12-dashboard/index.html"}
]}]}
```

Sections and items are ordered arrays without IDs. Titles and labels are
optional. Each item contains exactly one target key. `timeline` accepts a
project/action handle, date jump, date-range filter, literal search string, or
explicit query attachment handle. It does not provide artifact-backlink filters.
`entity` opens the existing typed record/content reader; HTML fills the viewport.
A canonical `aside://<instance>/<route>` can capture composed native browsing
state. User Pin/Unpin edits this same list. Omission preserves it, `[]` clears it,
and supplying a list replaces it atomically while retaining other settings and
the instance body. Query attachments are managed separately with artifact APIs.

## Retrieve and attach files

`Artifact.content` is `MarkdownContent` (`text`) for a nonblank body, or
`Attachment` for a blank body with exactly one indexed attachment. It is null
when the body is blank and there are zero or multiple attachments. `attachments`
includes all attachments; Markdown content can have supporting files. File bytes
are not included in query responses. Write Markdown through artifact input `body`.

```graphql
query ReadArtifact($id: ID!) {
  artifact(id: $id) {
    content {
      __typename
      ... on MarkdownContent { text }
      ... on Attachment { filename handle filePath error }
    }
    attachments { filename handle filePath error }
  }
}
```

- Read `Artifact.attachments`, then its validated `Attachment.filePath` with file or format tools. Never edit managed copies directly.
- Attachment content is outside both regex and semantic record search: `ArtifactWhere.regex`, `Query.search`.
- Import, replace, and remove files through artifact mutations above. Use returned `Attachment.handle` values in content.
- Attachment references associate their parent artifact with context; backlinks remain specific to the exact target.
- Import with `CreateArtifactInput.attachments` or `UpdateArtifactInput.attachments` (`ArtifactAttachmentInput`); remove exact filenames with `UpdateArtifactInput.removeAttachments`.
