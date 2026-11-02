# Project

A project is a logical grouping of related work, identified by a unique ID. It is the primary organizational unit of the system.

## Properties

- **Named.** Each project has a human-readable display name and a derived unique ID: `YYYY-MM-DD-{slug-of-name}`. The ID is also the filename (without `.md`).
- **Logical, not physical.** A project's timeline and actions are derived from entries. The project file stores only what can't be derived.
- **Lifecycle.** A project is either `open` or `closed`.

## Storage

Directory: `projects/`

```
projects/
  2026/
    index.yaml
    2026-05-02-migration.md
    2026-04-15-infra.md
    ...
```

Each project has a markdown file with YAML front matter. The filename (without .md) is the project ID, derived from `created` date + slug of `name`.

### Project File

File name: `YYYY-MM-DD-{slug-of-name}.md`

```markdown
---
name: Migration
created: 2026-05-02T14:30
related_projects:
  - project: 2026-04-15-infra
    description: Infrastructure workstream supporting the migration
---

## Key contacts

- Alice: database lead
- Bob: API owner

## Goals

- Complete migration by end of Q3
- Zero data loss

## Constraints

- Must maintain read access to Notion during transition
```

Front matter fields:
- `name`: human-readable display name for the project
- `created`: ISO 8601 with minute precision (`YYYY-MM-DDTHH:MM`) — when the project was created
- `ended`: a real Gregorian floating date and clock in the same minute-precision format — when the project was closed. Omit if still open; use `null` on update to reopen. Invalid values are rejected before writing and reported for direct file edits.
- `automations`: named [scheduled scripts or agent prompts](automation.md); closing the project pauses future execution.
- `related_projects`: [relationships](#related-projects) to other projects (by ID), each with a natural language description

Status is implicit: a project is open if `ended` is absent, closed if it has a timestamp.

### General Information

The Markdown body after the front matter contains durable facts about the project, kept up to date — goals, key contacts, reference links, constraints. This is free-form Markdown.

### Related projects

Project relationships are open-ended; their descriptions explain their meaning.
They can support discoverability. When a relationship represents hierarchy,
declare it from the higher-level project to the lower-level project.

### Index

File: `projects/<year>/index.yaml`

A YAML list of all projects for that year, ordered reverse chronologically (latest first). Each item contains the project ID and a short description.

```yaml
- id: 2026-05-02-migration
  description: Migrate from Notion to text + AI + tools model
- id: 2026-04-15-infra
  description: Infrastructure platform buildout
```

MCP maintains the index when projects are created or updated, using the agent's authored description.

## Derived Views

These are computed from entity records and references:

- **Timeline**: all entries where this project appears in the `projects` metadata field, in chronological order (oldest first)
- **Actions**: all actions that co-occur with this project in entries
- **Related projects**: both explicit (from `related_projects`) and implicit (projects that frequently co-occur in entries)
- **Artifacts**: content linked to the project through [artifact references](artifact.md#references-and-rendering)

## Lifecycle

- **Creating a project**: `capture` or `update_entry` creates it with a `created` timestamp, index description, and context entry
- **Renaming a project**: `update_project` changes its nonblank display name while preserving the ID, filename, creation timestamp, and references
- **Closing a project**: `update_project` sets the `ended` timestamp
- **Reopening**: `update_project` clears the `ended` field

## Check-ins

Project check-ins are regular entries in the note tagged to the project. There is no enforced structure or cadence. Check-ins can be triggered by:
- User asking the agent directly
- Pre-defined prompts
- Scheduled jobs

The agent synthesizes project status from recent entries and actions when a check-in is requested.

## Open Questions

None — project design is complete.
