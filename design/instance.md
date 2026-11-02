# Instances & Workspaces

## Instance

A directory of aside data, marked by an `aside.md` manifest at its root. It is the unit of storage and selection — one user's notes, projects, actions, and artifacts.

Aside manages `aside.md`, the collection and year directories under `notes`, `projects`, `actions`, and `artifacts`, their immediate Markdown records and `index.yaml` files, and each artifact’s attachment directory and immediate files. These paths must be ordinary files and directories; their names are recognized regardless of letter case. Symlinks are rejected even when they point inside the instance; reads skip invalid paths with diagnostics and mutations fail before following them. The selected instance root may itself be an alias and is resolved canonically. Explicit import sources follow symlinks normally. User-file previews retain the [web server’s containment policy](../cli/spec.md#web-server). Local processes running as the same user remain trusted.

Other files have no prescribed organization. Aside reads them only as needed for an explicit import, reference, or preview; it does not discover records in them or parse unrequested supporting files. There is no special user-file directory such as `assets/`. Background record loading and watching follow the managed layout; raw-file views use only the content and change metadata needed to display their requested files.

An instance carries two identifiers, for different contexts:

- **Path** — its local handle. Tooling selects and tracks an instance by directory path; the directory can move freely.
- **`id`** — its durable identifier, set in the manifest and immutable. Used where a path can't reach or persist, notably calendar event markers. Generated at creation from the name where possible, with an independent fallback. Renaming or moving an instance never changes its ID.

## Manifest — `aside.md`

The instance's own configuration. Front matter:

- `id` — required, stable; 1–63 lowercase ASCII letters, digits or hyphens, starting and ending with a letter or digit. It is the hostname in calendar `aside://` markers and normally the browser instance path. Browser addresses can carry a computed directory suffix without changing this ID.
- `name`, `description` — display name and one-line summary; `description` helps an agent choose among instances.
- `version` — the plugin version the instance was created with.
- `automations` — named [scheduled scripts or agent prompts](automation.md).
- `config` — per-instance settings (e.g. calendar event-title prefixes).

Below the front matter is free-form markdown that tooling never parses: user-authored instructions that shape agent behavior in this instance. The agent loads it on entering.

An unreadable manifest reports its original read failure and repair guidance. Calendar sync pauses while preserving the last observed identity and retries after the existing manifest or its permissions are restored; a read failure never asks the user to replace the stable ID.

## Workspace

The set of instances one agent session works with, at most one **active** at a time — a workspace maps to a session. It is seeded at startup and stays dynamic: the agent can switch the active instance, add a known one, or create a new one mid-session.

Instances enter a workspace from several sources:

- **Launch argument** — a directory named explicitly when the session starts.
- **Auto-discovery** — the working directory and its immediate children that hold a manifest.
- **`.aside` config** — its `pointers` and `default` (below).
- **The session** — any instance `selectInstance` adds by path, or `createInstance` makes new (legacy tools: `select_instance` and `create_instance`).

`createInstance` saves files before daemon registration and activation. If a
later step fails, its receipt reports the created path and current selection;
recover with `selectInstance` after resolving the reported failure. Existing
files are preserved, so repeating creation is not the recovery step.

The `instances` query (legacy tool: `list_instances`) fetches the daemon's known catalogue each time and merges it with this session's valid candidates, deduplicating by canonical directory path, never by ID. It lists both groups even with no active selection:

- **In this workspace** — included by this session's directory discovery, `.aside` pointers/default, or explicit `--dir`. Configured pointers can lie outside the checkout.
- **Other known instances** — remembered by the daemon or encountered later in this session. Selecting one does not change its membership.

The default GraphQL interface provides the `instances` and
`activeInstance` query fields and the `selectInstance` and `createInstance`
mutations. Discovery and introspection work with no selection. Results expose
the canonical path, manifest identity and display fields, active status, and
workspace membership. Selection affects this session only, not `.aside`'s saved
`default`. See the [GraphQL contract](graphql.md#instances) for inputs and failure recovery.

These labels describe workspace scope. Active selection remains per session; catalogue refresh never selects or redirects it; a selection whose path no longer passes the instance check is cleared. Lists prune stale session candidates and return only paths that currently pass `isAsideDir`. Unreadable registrations remain internal identity guards rather than selectable list entries. Every activation is remembered by the daemon, while automatic selection uses only this session's workspace candidates. Creation and selection receipts report the active path and the next session's selection rules.

The browser chooser uses the entry flow's date gutter, dividers, hover highlight, and summary facts. Dates show the latest managed-data edit, including attachment and directory metadata, without reparsing records or scanning unrelated user files. Selecting a card opens the instance on the same page; the top-left instance switcher offers quick switching with names, descriptions, and branch/path disambiguation. **Add instance** expands in place into a path form. **Browse…** selects a local folder and fills the path; **Add instance** then registers it. Typed paths accept an existing folder or manifest and must be absolute or begin with `~/`; registration canonicalizes aliases. Discovery refreshes when the page regains focus or becomes visible; cancelling the folder selector leaves the list unchanged. The **Forget** icon removes a registration without deleting files or interrupting active agent sessions; that explanation appears on hover or keyboard focus. Independent duplicate-ID groups appear last and remain selectable. An amber warning icon plus the monospace ID marks the conflict, once per group; hover/focus explains it and identifies conflicting paths. A crossed-out calendar icon represents calendar sync being disabled or paused. Card indicators open Settings details. Forgetting uses the directory path, so a conflicting ID does not prevent forgetting an extra copy. An agent's later activation can register a directory again.

Prefer to **consolidate**. Most users want a single instance; add another only for a deliberate, lasting separation (e.g. work vs. personal), since each split fragments history and divides where capture lands.

## Workspace config — `.aside`

The control plane, normally kept outside the data directories. Where the manifest describes one instance, `.aside` says which instances a workspace draws on:

- `pointers` — instances to include, by path.
- `default` — the instance to activate by default (need not be a pointer).
- `discovery` — defaults to true, enabling the auto-discovery scan above; `discovery: false` turns it off, leaving only the listed instances.
- `execution` — launch settings for [automations](automation.md#execution-settings), read from the defining instance root at each launch.
- `worktreeDetection` — defaults to true. Repository policy is read from the primary checkout's root `.aside`, independently of the launching session's working directory. `worktreeDetection: false` restores independent-instance behavior; duplicate IDs still pause calendar sync. This repository policy may live at the root even when that root is itself an instance. The workspace selection fields retain their existing scope.

## Git worktrees and browser addresses

Git topology is inspected from the canonical instance directory. Git's primary checkout is the calendar authority, regardless of its branch name. Linked worktrees always keep their own files, stores, and agent selection, but perform no calendar writes, reverse reconciliation, removals, or retries. Calendar status explains that changes must reach the primary checkout for sync; this expected state is informational rather than a duplicate-ID warning.

Instances at the same relative path across checkouts of one Git repository, with matching manifest IDs, form a worktree group. Registering or activating a linked instance also registers and loads its readable, matching primary counterpart. Forgetting an actual primary also forgets its registered counterparts with matching IDs; forgetting a worktree affects only that checkout. Removal is respected by catalogue refreshes and daemon restarts; a later explicit registration or activation can add the family again. The chooser places the primary first and keeps registered worktrees compact, showing branch or detached-checkout labels without repeating names and descriptions. Worktrees can be initialized, registered, and viewed without a readable primary counterpart. When the primary is absent, the worktree with the first canonical path supplies the full summary row and the remaining worktrees stay compact. This display role does not change its files, address, or calendar policy.

The bare browser address `/<id>/…` belongs to a unique independent instance or the primary of a worktree group. Linked checkouts use `/<id>~<hash>/…`. Independent groups sharing an ID all use suffixed addresses; their ambiguous bare ID is unavailable, just like an unknown instance.

Every instance accepts its suffixed alias. The hash is the first 16 hexadecimal characters of SHA-256 of the canonical instance directory; symlink aliases converge and moving the directory changes the hash. These addresses are computed, never written to manifests, calendar markers, or the saved registry. Hash collisions are rejected rather than selecting an arbitrary directory. After authorization, the browser resolves a suffixed alias and replaces it with the instance's canonical address, preserving the view, query, and fragment. The public shell does not reveal whether an alias is registered.

Browser data and control requests use the exact alias so an open page keeps its directory if another copy appears. Metadata refresh updates its displayed URL and calendar notice. Settings shows conflicting paths and recovery guidance for independent duplicates, or an informational worktree message with the primary path. Compact indicators show these reasons on hover or focus; card indicators also open Settings. The side-panel summary keeps its original name, description, and facts.

## Auto-selection

Workspace candidates are deduplicated by canonical directory path before
selection. Symlink aliases count as one instance; distinct directories remain
separate even when their manifests share an ID. Selected paths are canonical.

At startup one instance is activated by the first of these rules that applies:

1. **A directory named explicitly** at launch.
2. **The configured `default`.**
3. **The working directory**, when it is itself an instance — part of auto-discovery, so skipped under `discovery: false`.
4. **A single workspace candidate**, when only one comes from discovery, configuration and launch arguments.

If none applies — e.g. several candidates and no `default` — no instance is active and the agent selects one with the `selectInstance` mutation (legacy tool: `select_instance`).

## Identity conflicts

Distinct independent instance groups with the same ID remain separately discoverable and browsable through their suffixed addresses. The daemon blocks calendar sync for every affected instance and reports the ID and paths through MCP issues, mutation receipts, and `calendar_info`. Metadata checks include known unloaded instances and do not load them. An unreadable known manifest retains its registration and last successfully observed identity. On startup, an unreadable registration with no observed identity pauses other instances' calendar work until its identity can be verified, its removal verified, or it is forgotten. Restore the manifest or its permissions without changing its existing ID. A successful identity change, verified removal, or forgetting an unloaded registration clears its previous observation. Resolve a verified conflict by assigning the independent instance a different ID; sync resumes automatically.
