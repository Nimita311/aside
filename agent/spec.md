# Agent Harness

Reference implementation for an AI agent operating on the productivity data framework.

The agent proposes changes in chat as it works; an entity is created only on the user's explicit yes. A direct creation request is that approval.

## Agent Behavior

The agent is a productivity assistant, not a passive file manager. During any conversation it should actively:

1. **Identify actions.** When the user describes work, decisions, or plans, surface concrete next steps as proposed actions. Don't wait for the user to say "create an action" — recognize actionable language ("I need to", "we should", "by Friday", "follow up with").

2. **Recognize project relationships.** Connect what the user is saying to existing open projects. Query open projects and propose tagging. If the topic doesn't fit any existing project, suggest whether it warrants a new one.

3. **Summarize for capture.** At the end of a conversation (or when the user signals they're done), distill the exchange into a capture-ready summary: goals discussed, key information learned, decisions made, and outstanding todos. This becomes the entry content.

The agent's job is to reduce the user's overhead in maintaining the system to near zero — the user talks naturally, the agent handles structure. Recognizing and proposing is active and continuous; **creating** requires the user's go.

Entries preserve events and context. Artifacts hold durable content that is maintained in place; create one independently, then reference its handle inline from an entry when there is context to capture.

## Access Contract

Agents use an active Aside MCP server for instance selection, queries, and all record writes. On entering an instance, the agent loads its manifest instructions through GraphQL `activeInstance.body` (or the instance query in legacy mode). If MCP is unavailable or an operation fails, the agent reports the blocker and resolves it before continuing that operation.

Long content can be supplied as prepared Markdown drafts under the [content-source contract](../cli/spec.md#content-sources).
Agents prefer [date smart elements](../design/date-reference.md) whenever possible
in authored Markdown; MCP write guides include syntax examples.

## Instance Customization

The body of an instance's `aside.md` manifest holds user instructions that customize the agent within that instance — a per-instance `CLAUDE.md` for vocabulary, default tagging, output format, or named recipes (e.g. a "standup").

- **Always loaded.** The agent reads the body through MCP on entering an instance and applies it within the user's request and permissions.
- **Scoped.** Instructions apply to their own instance only — never to another.
- **Customizes, not triggers.** It shapes behavior when the agent is invoked but starts nothing on its own; scheduling lives in the surrounding harness.

## Skill Architecture

The GraphQL package (`agent/graphql`) installs a thin `aside` skill: record roles,
basic handles, relationships, and a concise five-choice guide routing table.
Guide reading and schema discovery need no instance selection. Before record
work, agents check the selection and read that instance's instructions.
MCP initialization embeds that body for clients without skills and adds shared
access, intent, response, and read/write recovery instructions inline from
`cli/src/mcp/resources/shared/session.md`.

GraphQL MCP lists exactly these five guides plus `aside://graphql/schema`:

| Guide URI | Scope |
| --- | --- |
| `aside://docs/records` | Find, recall, capture, and edit entries, projects, actions, artifacts, and attachments |
| `aside://docs/planning` | Review backlog and deadlines, schedule work, manage recurrence, and inspect Calendar sync |
| `aside://docs/automate` | Execution schedules, runtime setup, and inspection |
| `aside://docs/setup` | Instance selection/creation, startup discovery, and settings |
| `aside://docs/about` | Deeper design rationale |

Each task guide retains the relevant workflow and lifecycle policies from the
legacy skill, plus exact schema pointers. The four operational guides
include the shared authoring section in the same resource response; no extra
read is needed. Shared authoring rules and attachment input descriptions explain
the [data access granted by importing HTML](../webapp/spec.md#iframe-graphql).
Guides have no cross-guide prerequisites for the usual task;
relevant adjacent operations are included as schema pointers.
Shared sections have one source under `cli/src/mcp/resources/shared/` and are not
separately advertised resources. Recovery is part of shared session instructions,
not a separate guide. Headings, bullets, and operation tables keep the guides
readable. They do not repeat general advice or field contracts.
The documented executable schema defines operations,
fields, formats, and states; a live SDL resource and introspection expose the same
contracts. See [surface responsibilities](../design/graphql.md#agent-surface).

The legacy package (`agent/legacy`) installs the existing comprehensive skill and
its automation/recurrence references, paired with `aside mcp --legacy`. The
installer selects one package; the two skills are never shipped together.
Agent access follows the [access contract](#access-contract).

### Executor invocation

The executor agent receives:
- The matching package's `skills/aside/SKILL.md` as its instructions
- Access to the Aside MCP tools and, in GraphQL mode, resource listing and reading
- Permission to prepare Markdown input files and read returned attachment paths

It does NOT receive the design docs, agent spec, or test verification instructions.

## MCP Tools

The Aside MCP server provides the agent interface:

`aside mcp` defaults to GraphQL, exposing only `query` and `mutate`. Both accept
standard GraphQL source text in `document`, optional JSON `variables`, and
`operationName`. Validation is `Instance.validation`; navigation uses the
`show(input:)` mutation, and calendar information and permission use the single
`calendarInfo` mutation. Query `instances` and `activeInstance` and mutate with
`selectInstance` and `createInstance`; discovery and introspection need no active
instance. Query `models` for available automation selections and introspect the
selected instance's `Model` enum. The agent prefers targeted introspection for a
few known types and `aside://graphql/schema` for the full documented API; either
route suffices. The resource serves the current session's cached executable
schema. Context changes invalidate the model catalog; `models(refresh: true)`
explicitly refreshes discovery. Reacquire the schema after changing instance,
execution-model context, or catalog. Choose workflow guidance directly from
`resources/list`; `aside://docs/about` explains design rather than routing tasks.
The same authoring and access rules apply; see the
[GraphQL contract](../design/graphql.md).

Entry, project, action, and artifact domain fields are exposed directly on their
objects. All action collections and counts include saved actions, templates, and
future projected occurrences within the instance lookahead. The same filters and
pagination apply throughout; there is no separate planning query. An action's
`occurrence` contains immutable provenance and a `projected` indicator, or is null
for ordinary actions and templates.
Templates are identified by a non-null `recurrence` list (`[]` when dormant) and
have null lifecycle status. `ActionWhere.recurrence_exists` selects or excludes
all templates, including histories whose schedules have ended. Direct status
predicates exclude templates, while unfiltered lists and negated status predicates
can include them. Combine `recurrence_exists: false` with a negated lifecycle
predicate for queries limited to ordinary actions and occurrences.

`aside mcp --legacy` opts into the following separate tools:

- `list_instances` / `select_instance` / `create_instance` — instance discovery, selection, and creation
- `query_instance` / `update_instance` — instance instructions and configuration
- `query_models` — available automation selections
- `capture` — create a new entry, optionally creating new projects/actions in the same call
- `query_entries` / `query_actions` / `query_projects` / `query_artifacts` — filtered reads
- `planning_actions` / `update_occurrence` — recurrence projections and occurrence edits
- `create_artifact` / `update_artifact` — maintain content and import or remove attachments; return stable inline handles, indexed attachment filenames, and validated absolute paths to saved copies for read-only retrieval
- `update_entry` — edit an existing entry's content, description, or project/action links
- `update_action` / `update_project` — lifecycle change to an existing action (reschedule, deschedule, complete, cancel) or project (close, reopen, edit related projects), rename either display name without changing IDs or links, or edit a body/description
- `validate` — consistency checks
- `show` — display timelines, project hierarchies, artifacts, and raw files in the webapp.

Entity writes, including long-body revisions, take prepared Markdown drafts through `content_file`/`body_file`; see the [content-source contract](../cli/spec.md#content-sources). Artifact imports accept any file format and return handles for inline references. Agents may read validated attachment paths from metadata/full queries and write receipts using their existing file and format-specific tools; all record operations and attachment imports/removals remain through MCP. Storage, index maintenance, and validation rules belong to MCP; the topic resources describe authoring decisions (the skill in legacy mode).

## Calendar Sync

Calendar integration lives in the MCP, backed by a native EventKit helper (macOS). See `design/calendar.md`.

- **Forward sync is automatic inside `capture` / `update_entry` / `update_action`** — scheduling, rescheduling, completing, or cancelling an action saves its record and starts calendar work. Receipts report the calendar state; the agent calls no separate sync tool and checks the `calendarInfo` mutation (legacy `calendar_info`) when confirmation is needed.
- **Sync-back runs inside the [daemon](../design/daemon.md)** — a catch-up reconcile when the instance loads, then on calendar changes while it stays loaded — importing user calendar edits (move, resize, re-pin to another calendar, the `/done` / `/cancelled` / `/backlog` url markers, and a deletion, which deschedules the action) into action files.
- **`calendarInfo`** (GraphQL mutation; `calendar_info` tool in legacy mode) reports calendar state for the agent: auth status, available calendars and their metadata, pending and completed sync states, sync issues (e.g. an action pinned to a missing calendar), and changes applied since the instance loaded. Instance observations remain available when the helper fails. When calendar access is undecided or write-only it requests full access, surfacing the macOS permission prompt. Follow its observed category and recovery guidance; a saved record with pending sync is not a confirmed event.
