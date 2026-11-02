# Aside

Aside is a plain text productivity framework that helps people capture, organize, and deliver work with AI agents.
The framework defines data structures that encourage good productivity habits and provides authoring tools for AI agents and browsing tools for people.

## Core Experience

The workflow starts with existing conversations between the user and an AI agent:

- **Capture with low friction.** Entries turn conversation into a chronological paper trail.
- **Organize by theme.** Projects bring related work together for review.
- **Deliver with accountability.** Scheduled actions map directly to calendar events.

Three roles work together to deliver the experience:

- **Agents** author and maintain records through MCP tools, supported by a folder structure that makes records easy to discover.
- **Software** organizes records and builds views from structured front matter and consistent, parseable formats.
- **People** review and browse the records through familiar text tools or dedicated software.

Plain text files hold the authoritative records without requiring a database.

- **Readable.** Records can be opened and read directly with ordinary text tools.
- **Interpretable.** Content, context, and relationships make the stored meaning explicit, without cryptic encoding or reliance on latent agent memory.
- **Browsable.** Search and navigation help locate relevant records and follow connections between them.

The user retains awareness and control over what is stored, how it is organized, and how it is used.

## Data Structure

Four familiar entities form the core:

| Entity | Meaning |
|---|---|
| [Entry](note.md) | A recorded event, decision, or piece of context. |
| [Project](project.md) | Related work organized around a theme. |
| [Action](action.md) | A concrete task or event. |
| [Artifact](artifact.md) | Durable content maintained over time. |

Relationships reflect ordinary work: entries connect projects and actions to their context, projects relate to other projects, and artifacts connect reusable content to the work around it. The records support chronological views of work and decisions and views of related information around projects, actions, or artifacts.

Stable IDs and handles make referencing easy and independent of file paths. The [identity rules](identity.md) define how these references remain stable.

The daemon runs the portable [data core](record-model.md) for both MCP and the webpage. Browser tabs consume structured snapshots. The same core can run in a browser against static files.

The framework provides a persistent core that users can extend through custom software and prompts. Users can add arbitrary files to an Aside directory and custom front matter to its records. Core tooling must respect these extensions and preserve information beyond the fields it understands.

## Design and Implementation Rules

- **The user's voice.** Authored content reflects the user's words and intent.
- **Absent empty fields.** Fields without values are omitted to keep records minimal; empty fields encountered during reading are treated as absent.
- **ISO timestamps.** Timestamps use ISO 8601 with minute precision (`YYYY-MM-DDTHH:MM`). Action schedules and deadlines can also be date-only.
- **Reverse chronology.** Records are presented newest first by default, including note entries, indexes, and query results.
