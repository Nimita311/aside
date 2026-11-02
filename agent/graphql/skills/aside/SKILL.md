---
name: aside
description: Find context, capture conversations, plan work, and maintain projects, actions, artifacts, and scheduled work in Aside through GraphQL MCP.
---

# Aside

Aside turns conversations into plain text records for recall, planning, and delivery.

## Records

| Record | Purpose | Handle |
| --- | --- | --- |
| Entry | Time-bound context; chronological history. | `#entry/id` |
| Project | A theme with current, durable facts. | `#project/id` |
| Action | Work: deadlines express urgency; schedules commit time. | `#action/id` |
| Artifact | Independent content maintained in place. | `#artifact/id` |

Record ID inputs use bare IDs, without the handle prefix.

## Relationships

| Relationship | Source |
| --- | --- |
| Entry → Project / Action | Authoritative entry tags. |
| Project / Action → Entry | Entry tags or mentions in entry content. |
| Project — Action | Shared entry tags; recurring occurrences also inherit their template's projects. |
| Project — Project | Authored directional links. |
| Any record — Artifact | Inline references to the artifact or its attachments. |

Relationships are many-to-many. Other inline handles are cross-references,
not entry tags.

## Start

Read the guide for the current task; `resources/list` exposes the same choices.

| Task | Guide |
| --- | --- |
| Find, capture, or edit records and files; open browsing views | [Records](aside://docs/records) |
| Review priorities; schedule, resolve, or repeat work; check Calendar | [Planning](aside://docs/planning) |
| Run scripts or agents on a schedule | [Automation](aside://docs/automate) |
| Choose/create an instance; configure its settings or startup | [Setup](aside://docs/setup) |
| Answer questions about Aside's design | [About](aside://docs/about) |

Use `query` and `mutate` for operations. Inspect needed types through targeted
`query` introspection or read the [full schema](aside://graphql/schema).
Either route suffices; guides and introspection need no instance selection.

Use `Mutation.show` to open a view in the default browser, or `Mutation.showUrl`
to get a fresh private `file://` handoff URL for a chosen local browser. Opening
the file automatically authorizes that browser and redirects to the requested
view. Open it immediately as returned; see the Records guide for examples.

For record work, check `Query.activeInstance`. Discover alternatives with
`Query.instances` and select with `Mutation.selectInstance` as needed. Read
`Instance.body` when entering an instance and apply its instructions only there.
