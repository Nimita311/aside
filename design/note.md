# Note

The note is the primary capture surface and source of truth for all time-bound information in the system.

## Properties

- **Add-only.** New entries are added to the top of the file. Existing entries may be amended within the same conversation but are not deleted. The note is a paper trail.
- **Reverse chronological.** Entries are ordered latest first within each file, for easy human browsing.
- **Human-readable.** The user reads the files directly, outside of chat. Format must be scannable.
- **Concise.** Entries capture only key information in complete, natural sentences.

## Storage

Directory: `notes/`

```
notes/
  2026/
    index.yaml
    2026-04-28.md
    2026-05-05.md
  ...
```

### Weekly Files

File name: `YYYY-MM-DD.md` where the date is the Monday of that week. The file lives under the Monday's year, so a week spanning New Year stays in one file.

Front matter:

```yaml
---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---
```

A blank line separates the front matter from the first entry.

Each file covers one calendar week (Monday to Sunday). Entries are ordered latest first within each file.

Weekly files contain the full content of every entry. They are the source of truth.

### Index

File: `notes/<year>/index.yaml`

A YAML list with one item per entry, ordered reverse chronologically (latest first). Each item contains the entry ID and a short, authored description — a headline for scanning the timeline.

```yaml
- id: 2026-05-02T16:00
  description: Reviewed database schema changes
- id: 2026-05-02T14:30
  description: Met with team about migration timeline
```

The index does not duplicate associations or references — those live in each entry's metadata and content.

MCP maintains the index on capture and update, using the agent's authored description. The agent keeps the description in step with the content. As with the other entity indexes, the description lives only here.

The agent uses `query_entries` to locate relevant entries, requesting full detail when it needs their content.

## Entry

An entry is the atomic unit of the note. Each entry captures one piece of information at a point in time.

### Format

Each entry starts with a horizontal rule (`---`) followed by a fenced code block tagged `entry` containing YAML metadata. Content follows as free-form markdown.

````markdown
---
```entry
created: 2026-05-02T14:30
projects: [2026-05-02-migration, 2026-04-15-infra]
actions: [2026-05-02-deploy-db]
```

Content goes here. Can use any markdown formatting
including headings, lists, code blocks, etc.

Need to coordinate with #project/2026-04-15-infra on #action/2026-05-02-deploy-db.
````

- **Preamble**: `---` marks the start of a new entry, immediately followed by the metadata block.
- **Metadata block**: a fenced code block with the `entry` identifier. Contains YAML key-value pairs. The `entry` identifier distinguishes metadata blocks from any code blocks in the content.
- **Content**: everything after the metadata block until the next entry. Supports full markdown.
- **Entry ID**: the `created` value (e.g., `2026-05-02T14:30`). Used as the identifier everywhere — in inline mentions and the index.

> Side note: an entry is recognized by the `---` + ```` ```entry ```` preamble, not a lone `---`, so content is free to contain bare `---` (e.g. horizontal rules).

### Conversation and Entry Lifecycle

By default, one conversation produces one entry. The agent may amend the entry's content and metadata over the course of the conversation — the agent should use best judgement and propose changes for user confirmation. If the user requests a new entry within the same conversation, the agent creates one with the current timestamp, placing it in the correct weekly file.

Entries stay on the record once written. Older entries remain as written; later corrections and developments are captured in new entries referencing the originals.

### Metadata Fields

- `created`: ISO 8601 with minute precision (`YYYY-MM-DDTHH:MM`) — when the entry was created. Also serves as the entry ID.
- `projects`: YAML inline list of project IDs — the authoritative project associations for this entry
- `actions`: YAML inline list of action IDs — the authoritative action associations for this entry

Metadata values are plain strings with no prefix or sigil. The YAML key provides the type context. Always use inline list syntax (`[a, b]`). Omit fields that are empty — only `created` is required.

Typical entry: one project, zero or one action, zero entry references. Multiple associations are supported but uncommon. Typically one conversation produces one entry.

### Inline Mentions

Entities can be mentioned inline in content using the `#type/id` syntax:
- `#project/2026-05-02-migration` — reference a project
- `#action/2026-05-02-deploy-db` — reference an action
- `#entry/2026-05-02T14:30` — reference another entry
- `#artifact/2026-05-02-migration-plan` — reference an artifact
- `#artifact/2026-05-02-migration-plan/schema.png` — reference an attachment by exact filename

Project, action, and entry mentions are informal cross-references; project/action associations come only from metadata. Artifact references establish [backlinks and contextual associations](artifact.md#references-and-rendering).

## What Goes In

Everything time-bound:
- Information received or learned
- Decisions made
- Meeting notes
- Plans and intentions
- Questions raised
- Status updates
- Actionables as they are identified

What does NOT go in the note:
- Persistent project facts (those go in project general information)
- Derived or synthesized content

## Artifacts

Link to [artifacts](artifact.md) for durable content; the entry preserves the event, decisions, and context surrounding that content.

## Open Questions

None — note design is complete.
