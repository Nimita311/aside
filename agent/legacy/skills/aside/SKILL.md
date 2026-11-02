---
name: aside
description: Query and maintain Aside's plain text productivity records through MCP. Use to find context, review or plan work, capture conversations, manage projects and actions, and configure scheduled work in Aside.
allowed-tools: Bash Read Edit Write
---

# Aside

Aside is a plain text productivity framework for capturing, organizing, and delivering work. Its records support capture from conversations and queries for recall, review, and planning, viewed chronologically or through relationships between entities.

## Data Structure

- **Entry:** A time-bound note and chronological paper trail.
  Keep only key information in complete, natural sentences. Normally amend one
  entry during a conversation; start another for distinct context. Preserve older
  entries; record later corrections or developments in a new entry referencing
  the original.

- **Action:** A work item: a deadline expresses urgency; scheduling commits time.
  A scheduled action with a target calendar maps to a calendar event. Its body
  appears in calendar notes and holds references useful when performing the
  action. Resolve only on the user's decision, rather than deleting; elapsed
  time never resolves work.

- **Project:** A theme connecting related work, with durable project facts.
  Keep facts current; close rather than delete.

- **Artifact:** Durable content that can exist independently of entries.
  Maintain in place and keep content current.

| Relationship (n:m) | Kind | Source |
|---|---|---|
| Entry — Project / Action | Authoritative | `projects` and `actions` in entry front matter. |
| Project — Action | Derived | Co-occurring entry metadata; materialized occurrences also inherit their template's live project associations. |
| Project — Project | Authoritative, directional | `related_projects` in project front matter; declare hierarchy links on the higher-level project. |
| Any entity — Artifact | Authoritative | Inline `#artifact/id` references in content. |

Inline entry, project, and action handles are cross-references; an entry's project and action associations come from its front matter.

## Workflow

This skill accompanies the legacy MCP interface (`aside mcp --legacy`). Use the
entity and utility tools exposed by this session; their schemas define operation
inputs and outputs. Inspect write receipts for saved records and calendar
warnings before treating an operation as complete.

Select an instance through MCP, read its `aside.md` instructions directly, and apply them only within that instance. Use Aside MCP for all record queries and writes; counts and aggregates must use MCP results. Do not substitute CLI commands or direct reads or edits of record files. Local drafts and source files may be prepared or read for MCP calls. Artifact metadata/full queries and write receipts provide validated absolute attachment paths; read these saved copies with existing file or format-specific tools. This allowance is read-only: attachment imports/removals and all record operations remain through MCP. Use canonical handles in authored content; paths are current retrieval metadata and may change or disappear. Follow tool schemas and report failures.

Create entities only with explicit approval; a direct creation request counts. New projects and action templates require entry context; editing a recurrence occurrence can create its action without an entry.

- **Query and review.** Find relevant records, follow relationships, and read supporting content. Ground answers in the records; use browsing views when helpful and offer to capture meaningful check-ins.
- **Capture and organize.** Propose recording key decisions, context, and next steps from the conversation. Find fitting open projects; clarify uncertain value or fit and allow untagged capture if a link is declined. Use closed projects only when instructed.
- **Plan and deliver.** Review backlog, deadlines, and slipped work; propose priorities, rescheduling, or resolution. Clarify ambiguous scheduling details. Change the Aside action rather than its derived calendar event; distinguish a saved record from confirmed calendar completion.
- **Maintain content.** Update project facts and artifacts as information changes; capture an entry when the occasion or decisions are worth preserving.
- **Repeat actions.** For recurring work, read [recurrence](references/recurrence.md). Use a dedicated generic template; query projections separately and materialize only on an edit.
- **Automate work.** For scheduled scripts or agent work, read [automation setup](references/automation.md). Definitions live on an existing project or the instance; use MCP to maintain them.

`show` opens the requested view in the default browser through a fresh private
file handoff. The file automatically authorizes that browser and redirects to
the requested destination, including when its session is missing or expired.

Use `list_instances` to see both **In this workspace** (this session's discovery, configuration and `--dir`; `workspace: true`) and **Other known instances** remembered by the daemon (`workspace: false`). Active selection is independent per session; selecting an instance does not change which group it belongs to. Prefer one instance unless the user wants a lasting separation. Offer the tutorial to new users. Keep new instance data tracked when it is in a Git repository unless the user opts out, and explain this choice.

## Authoring Rules

- **Owner's voice.** Write as the note's owner: the user when assisting them, yourself for your own notes. Use first person sparingly.
- **Scannable format.** Keep key information only and make writing easy to scan. Use lists, tables, and Mermaid diagrams; avoid large blocks of text.
- **Rich content.** Use HTML within Markdown for visually rich content when helpful. Scripts and event handlers in Markdown are unsupported; HTML attachment previews run scripts inside sandboxed iframes.
- **References.** Mention other entities in authored text using `#type/id` handles rather than file paths. MCP ID fields use just `id`.

| Entity | Handle in text |
|---|---|
| Entry | `#entry/2026-05-02T14:30` |
| Project | `#project/2026-05-02-migration` |
| Action | `#action/2026-05-02-deploy-db` |
| Artifact | `#artifact/2026-05-02-migration-plan` |

Prefer date smart elements whenever possible in authored Markdown.

- Date: `#date/2026-10-15`
- Local date-time: `#date/2026-10-15T09:30`
- Named timezone: `#date/2026-10-15T09:30[America/Los_Angeles]`
- Offset timestamp: `#date/2026-10-15T09:30:00-07:00`
- UTC timestamp: `#date/2026-10-15T16:30:00Z`
- Date interval: `#date/2026-10-15/2026-10-18`
- Timed interval: `#date/2026-10-15T09:30/2026-10-15T10:30`

- **Attachments.** Import non-text files as artifact attachments when they provide lasting context or reference material, such as screenshots, diagrams, PDFs, or recordings. Reference them in authored text with `#artifact/id/filename`; embed image attachments with Markdown image syntax.
- **HTML trust.** Importing or replacing an HTML attachment trusts the page and its scripts. When previewed, they can read records across the selected instance through `aside.query()` and send that data externally. No extra trust prompt is required. Embed untrusted pages using external iframe URLs; they receive no query access. Embedding an indexed HTML artifact retains its query access.

Examples:

- File reference: `#artifact/2026-05-02-migration-plan/brief.pdf`
- Embedded image: `![Architecture](#artifact/2026-05-02-migration-plan/architecture.png)`
