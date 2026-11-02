# Find, capture, and edit records

## Find connected context

Follow linked entries for context, and project bodies and artifact content for current facts.

Project relationships are open-ended and can support discoverability. Their
descriptions explain their meaning. For hierarchy, declare the link from the
higher-level project to the lower-level project.

| Find or inspect | Schema reference |
| --- | --- |
| Entries, projects, actions, and artifacts | `Query.entries`, `Query.projects`, `Query.actions`, `Query.artifacts` |
| Entry text, dates, or tags | `EntryWhere` |
| Action text, state, or associated projects | `ActionWhere` |
| Unassigned work or absent relationships | `ActionWhere.projectIds`, `ProjectRelationFilter.none` |
| Project relationship targets and direction | `Project.relatedProjects`, `ProjectRelation.direction` |
| Filter existing outgoing project relationships | `ProjectWhere.relatedTo` |
| Counts and pagination | `ActionPage.offset`, `ActionPage.count`, `ActionPage.totalCount` |
| Record consistency | `Instance.validation` |
| Open a view in the default browser | `Mutation.show` |
| Get a URL to open in a chosen browser | `Mutation.showUrl` |

Record fields such as `Entry.created`, `Project.name`, `Action.scheduled`, and
`Artifact.content` are exposed directly. `filePath` gives the absolute containing
Markdown file path; entries share a weekly file. Entry relationships return
resolved projects and actions, whose IDs can be selected directly. Missing
targets are omitted and reported by validation. Action queries also include future recurring
occurrences within the instance lookahead; `Action.occurrence.projected` identifies
unsaved occurrences computed from their template. Reading never saves them;
editing returns a saved occurrence with `projected: false` and its saved ID,
handle, and `filePath`. Unsaved projections have null `filePath`.
The flag says whether the occurrence is saved; `Action.status` describes
its lifecycle. Templates have a non-null `Action.recurrence` list, including `[]`
when dormant, and a null status. Use `ActionWhere.recurrenceExists` to select or
exclude all templates, including ones whose schedules have ended. Direct status
predicates exclude templates; negated predicates can include them. Add
`recurrenceExists: false` to a negated lifecycle filter when selecting only work.
See [Planning](aside://docs/planning) for lookahead, identity, and
edit behavior. Projections inherit their template's current project and artifact
context. Use `Action.occurrence` when editing an individual repetition; its `template`
resolves the template `Action`, and `template.id` supplies the edit identity.

`Project.relatedProjects` returns one `ProjectRelation` per existing target.
`OUTGOING` is declared here, `INCOMING` by the other project, and `BIDIRECTIONAL`
means both declare the relationship. `outgoingDescription` and
`incomingDescription` retain their respective descriptions. Use the `direction`
list filter to select any combination before pagination; include `BIDIRECTIONAL`
when selecting every relationship pointing in or out.

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
`showUrl` returns one string and never opens or navigates a browser. Open that
string unchanged in the chosen browser/profile on the daemon's machine, using a
tool that can open local files.

The returned `file://` URL is intentional. Each call creates a temporary private
HTML file protected by owner-only Unix permissions. Opening it sends a one-use
code to the daemon, automatically installs valid browser authorization, and
redirects to the requested view. Missing or expired sessions need no manual
authentication or token handling. Request a fresh URL for each opening and open
it immediately: the file is single-use and expires after two minutes. It is not a
bookmark or a remote web URL. The `url` field on `show` is a clean bookmark URL;
opening that URL alone does not authorize a different browser.

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
- A scheduled action with a target calendar maps to an event. Its body becomes event notes; include references useful when performing the work.
- Edit the Aside action, not its derived event. Calendar-bound writes start synchronization automatically; inspect pending or failed sync with `Mutation.calendarInfo`.

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
- Attachment content is outside record search: `ArtifactWhere.search`.
- Import, replace, and remove files through artifact mutations above. Use returned `Attachment.handle` values in content.
- Attachment references associate their parent artifact with context; backlinks remain specific to the exact target.
- Import with `CreateArtifactInput.attachments` or `UpdateArtifactInput.attachments` (`ArtifactAttachmentInput`); remove exact filenames with `UpdateArtifactInput.removeAttachments`.
