# Aside CLI

Unified command-line tool and MCP server for the Aside productivity framework.

## Overview

A single `aside` binary that provides:
- Human-facing CLI commands for common operations
- MCP server for agent access to the same operations
- The [daemon](#daemon) both are clients of, which holds each instance's records, syncs the calendar, and serves the webapp

## Principles

- **The design docs are the spec.** The CLI implements `design/`. If the CLI introduces a rule not in the design docs, update the design docs first.
- **MCP is the agent interface.** Agent access follows the [access contract](../agent/spec.md#access-contract). CLI commands serve human and programmatic use.
- **Shared core, tailored output.** CLI and MCP run the same operations in the daemon: human-readable CLI reports, GraphQL JSON, and compact plain text for legacy MCP tools.
- **One owner.** Record commands and MCP tools reach an instance only through the daemon, which serializes their writes. `instance init` and `instance validate` work on files directly and need no daemon.
- **Robust reads.** Parsing never crashes on malformed or missing data — it recovers to sensible defaults, surfaces what it had to recover (e.g. on `select_instance`), and stays in agreement with `validate` on what counts as well-formed.

Actions are subcommands; data and paths are named options. All instance directories use `--dir <path>` (repeatable for instance add/forget). Options accept `--option value` and `--option=value`; use the latter for values beginning with a dash. Every command supports `--help` and `-h`, and bare command groups show help. Unknown arguments, duplicate scalar options, missing values, and positional data arguments are errors except for the optional URL or handle accepted by `show`. Help validates syntax but never starts a daemon, changes configuration, or creates files. Errors go to stderr and exit with status 1. Help and validation use color only on a terminal, respecting `NO_COLOR`; redirected output is plain text. Recovery hints use the commands available in the selected interface.

## Output

Human reports follow [CLI output](../design/cli-output.md): section dividers,
concrete information separated from `[OK]` / `[ERROR]` health checks, and instance
names annotated with `(loaded, N active sessions)` with their paths
directly underneath. MCP-equivalent commands retain their MCP output format.

All human commands accept `--json`, including heavy reports (`plugin status`,
`daemon status`, instance lists, `instance validate`, and artifact queries at every detail
level). JSON is one document containing `schema_version`, `command`, `ok`, `data`,
`checks`, and `diagnostics`; it preserves operation results and partial failures.
Artifact data uses native MCP `content` blocks and complete parse issues. JSON
errors also go to stdout, with a nonzero exit status. Help remains plain human
output. `mcp` uses its own transport and does not accept `--json`. `graphql query` and
`graphql mutate` always return standard GraphQL JSON; `--json` is accepted with
the same output and does not add the human-command envelope.

`aside mcp` defaults to the [GraphQL interface](../design/graphql.md),
exposing only the `query` and `mutate` tools for all MCP operations. Both accept
standard GraphQL source text in the required `document` argument, with optional
`variables` and `operationName`.
Instance selection, validation, display, and calendar operations are GraphQL
fields in this mode: `selectInstance`/`createInstance`, `Instance.validation`,
`show`/`showUrl`, and `calendarInfo`.
`aside mcp --legacy` opts into the separate legacy tools for this session.
GraphQL executes inside the same daemon and uses existing records and write
handlers, without changing persistence.

## Commands

### `aside artifact <create|update|query>`

Manage [artifacts](../design/artifact.md) through the same handlers as MCP, run by the daemon. `--dir <path>` selects an instance; it defaults to the current directory, which must contain `aside.md`. These commands do not discover or select other instances.

```sh
aside artifact create --name "Design review" --description "Current design" --body-file review.md
aside artifact create --name "Brief" --description "Review PDF" --file brief.pdf
aside artifact update --id <id> --body-file revised.md --file desktop.png
aside artifact update --id <id> --remove-file brief.pdf --file revised.pdf
aside artifact query --project <id> --detail full
```

- **Create:** requires `--name` and `--description`. Optional `--body`, `--body-file`, and repeatable `--file` follow the [artifact write contract](#create_artifact--update_artifact).
- **Update:** requires one artifact ID through `--id <id>`. The same fields are optional; repeatable `--remove-file` removes exact attachment filenames; `--remove-file=<filename>` also accepts names that start with a dash. Imports and removals can be combined to replace a file under a new name.
- **Query:** repeatable `--id`, `--project`, and `--action`; `--from`/`--to` (inclusive creation dates, `YYYY-MM-DD`); `--search` (regex); `--detail index|metadata|full`; `--offset` (nonnegative integer); `--limit` (1–100). See [`query_artifacts`](#query_artifacts).

`--body` and `--body-file` are mutually exclusive. Relative body and import source paths resolve from the working directory. Repeat `--file <path>` to import files with their existing basenames, or use `--file <filename>=<path>` to choose an exact destination filename. Unknown arguments and duplicate scalar options are errors. Output uses artifact handles ready to reference inline.

### `aside show [<aside-url|handle>] [--dir <path>]`

Open content in the default browser. No target opens the instance selector, even when the working directory is an instance. The target accepts `aside://<instance-id>/…` or a quoted object handle: `#project/<id>`, `#action/<id>`, `#entry/<created>`, or `#artifact/<id>[/<filename>]`. Projects and actions open their detail reader; entries are shown in the timeline; artifacts and attachments open their reader. Calendar URL lifecycle suffixes locate the action without changing it.

An Aside URL identifies a registered instance by its stable manifest ID. Workspace discovery and `.aside` pointers can also locate it. Handles use `--dir` when supplied, otherwise the workspace's normal auto-selection; if that selects nothing, a sole known instance can be used. Ambiguous selections report an error with `--dir` guidance. A URL and explicit directory must identify the same instance. `--dir` requires a target or `--url`.

Like MCP `show`, the command prepares a fresh private authorization handoff and opens it in the default browser, which automatically reaches the requested view. The command prints the clean browser URL and exits, leaving the daemon and browser tab serving it. With `--url`, validate the same target but print only its web URL without preparing authorization or opening or navigating a browser tab. Without a target, print the chooser URL; `--url --dir <path>` prints that instance’s timeline URL. JSON retains `data.url` and reports `reused_tab: false`. Browser-launch failure reports the clean URL and asks for a local `aside show` to authorize the browser. Authorization follows [browser authorization](../design/daemon.md#browser-authorization); `--url` never prints credentials or renews authorization. Agents choosing another browser use GraphQL `showUrl`, whose private file URL authorizes that browser automatically. `--app-dir <path>` optionally selects the webapp assets. Help and invalid syntax do not start a daemon or open a browser.

```sh
aside show
aside show --url
aside show --url --dir ~/aside/work
aside show 'aside://work/action/2026-10-05-review'
aside show '#project/2026-10-05-launch' --dir ~/aside/work
aside show '#artifact/2026-10-05-brief/brief.pdf' --dir ~/aside/work
```

### `aside graphql <query|mutate>`

Execute a standard GraphQL document through the shared daemon. `query` accepts
only GraphQL queries; `mutate` accepts only GraphQL mutations. The required
source is either `--document <graphql>` or `--document-file <path>`; use
`--document-file -` to read stdin. Optional `--variables <json>` or
`--variables-file <path>` supplies a JSON object. These source pairs are mutually
exclusive. `--operation-name <name>` selects a named operation when the document
contains more than one. File paths resolve against the invocation's working
directory. Record `content_file`/`body_file` and imported attachment source paths
inside GraphQL inputs retain the schema's absolute-path contract.

`--dir <path>` selects an explicit instance. Otherwise use the same workspace
configuration, discovery, and auto-selection rules as MCP. Introspection,
instance discovery/creation, and machine calendar information work without an
active instance. Selection lasts for this invocation; `selectInstance` and
`createInstance` affect later mutation fields in the same document and do not
persist a startup default.

Output is standard GraphQL JSON with `data`, `errors`, and `extensions` as
applicable, including partial data, successful receipts, and confirmed partial-write results.
[Execution-budget failures](../design/graphql.md#execution-bounds) return errors without partial data and retain confirmed mutation receipts. GraphQL
errors exit with status 1; input and transport failures return an `errors` array
with status 1. `--json` is optional and produces the same output. Help and invalid
CLI arguments, JSON variable inputs, document syntax, operation modes, and static
schema selections are checked before connecting to or starting the daemon.
Instance-specific model validation runs in the daemon before writes.
Query requests may reconnect and retry; mutation requests with uncertain outcomes
must not be repeated automatically.

```sh
aside graphql query --document '{ activeInstance { id name path } }'
aside graphql query --dir ~/aside/work --document-file request.graphql --variables-file variables.json
cat save.graphql | aside graphql mutate --document-file - --operation-name Save
aside graphql mutate --document 'mutation { calendarInfo { authorization } }'
```

### `aside usage summary [--dir <path>] [--since <days>] [--json]`

Read per-instance GraphQL usage logs offline. `--dir` defaults to the current
directory and must contain an instance manifest. `--since` is a positive day
duration such as `7d` (the default), at most `36500d`. JSON uses the normal human
CLI report envelope. Report request and operation counts, outcomes, introspection,
common redacted shapes and selected fields, confirmed write counts, p50/p95
daemon execution latency, and skipped malformed-line counts. An instance with
no logs returns an empty summary. Does not start the daemon or load records.

GraphQL reads and mutations collect completion metadata in
`<daemon logs>/graphql/<instance-key>/`; `instance.json` links each collection to
its canonical instance path and manifest ID. No request values or response content
are retained. Multi-instance operations share a request ID across their collections
and keep confirmed write counts local. See [usage logging](../design/graphql.md#local-usage-logging).

### `aside mcp [--dir <path>] [--legacy]`

Start the MCP server. GraphQL is the default: expose only `query` and `mutate`,
which accept standard GraphQL documents. `--legacy` opts into the separate
instance, entity, validation, display, and calendar tools. Exposes tools for agent
use over stdio, as a [daemon](#daemon) client: it owns the session's workspace and
sends each tool call to the daemon, naming the active instance.

Use `--dir <path>` for an explicit instance. Positional paths and unsupported options are rejected before discovery or server startup.

Instance resolution is a three-step flow: **discover → auto-select → track**. A directory is an aside instance if it has an `aside.md` manifest — the single definition of validity. A `.aside` config file (pointers + default) may also name instances; see *Configuration* below.

**1. Discover.** Gather candidate instances: scan `$PWD` and its immediate children for an `aside.md` manifest — unless the config sets `discovery: false` — plus any pointers/default from a `$PWD/.aside` config that resolve to valid instances. Canonical paths identify candidates and selections, so symlink aliases count once before auto-selection; see [Auto-selection](../design/instance.md#auto-selection). Discovery runs regardless of how one ends up selected; an explicit `--dir` is not discovery and works either way.

**2. Auto-select.** Choose the active instance in precedence order:
1. `--dir <path>` — use this path directly (must contain an `aside.md` manifest).
2. Config default — the `.aside` config's `default`, if it resolves to a valid instance.
3. `$PWD` itself — if the current directory is an instance, use it, even when it also has child instances (part of discovery, so skipped under `discovery: false`).
4. Sole candidate — if exactly one instance was found.

Zero or multiple candidates select nothing: the server starts with no active instance, the candidates are offered through the `instances` query (`list_instances` in legacy mode), and the agent picks one with the `selectInstance` mutation (`select_instance` in legacy mode).

**3. Track throughout the session.** The server remembers every instance encountered — those discovered, config pointers, one passed via `--dir`, and any later selected with `selectInstance` (`select_instance` in legacy mode). `instances` (`list_instances` in legacy mode) reports the active instance plus the rest, each with its `name`/`description`, so the agent can switch between them at any time.

### Configuration

A `.aside` config file — normally kept outside data directories (e.g. in a working directory) — locates instances and picks a default. Its optional `execution` block is read at the instance root for [automation model discovery and launch](../design/automation.md#execution-settings). Its YAML instance-selection fields are `pointers` (paths to instances), `default` (a path to use by default; it need not be among the pointers), and `discovery` (default `true`; `false` turns off the structural scan of `$PWD` and its children, so instances come only from `pointers`/`default`). Paths are resolved relative to the config file, with a leading `~` expanded to the home directory. Instance-selection settings are read from `$PWD` at startup (no global config; changes take effect on restart). Read failures, malformed config and pointers/default that don't resolve to a valid instance are reported when listing or selecting instances, not fatal. An unreadable config contributes no settings; its diagnostic gives the reason and asks the user to repair the file or permissions and restart the session. Normal discovery and auto-selection rules still apply to the remaining valid inputs.

```yaml
default: ~/aside/work
pointers:
  - ~/aside/work
  - ~/aside/personal
```

### `aside instance <init|add|forget|list|validate>`

Create instances, manage registrations, and validate records. The daemon syncs every known instance; these commands never start it.

- **`add --dir <path> [--dir <path>]…`** — register existing instances and report each path as registered or already registered. Every added path must be an instance; validate the whole batch before applying it.
- **`forget --dir <path> [--dir <path>]…`** — remove registrations and report each path as forgotten or not registered, preserving instance files. An instance in use remains loaded until its last client or tab disconnects. Using it again registers it again.
- **`list`** — list all known instances by name and canonical path, reporting ID clashes across distinct directories. Query the running daemon or read and collect the saved registry while stopped. When a daemon is unreachable but owns the registry, show the saved list and fail with the log path and retry instructions without changing its files.

- **`validate [--dir <path>]`** — run format, consistency, and relationship checks directly on instance files, defaulting to the current directory. A missing, unreadable, or unrecognized manifest blocks data checks as described in [validation output](../design/cli-output.md); otherwise print every diagnostic, including all issues within failed checks. Exit 0 when all checks pass and 1 otherwise.

All five support `--json`, with structured checks. Registry commands return `data.instances`; `add` and `forget` also return per-path `data.results` as described in [command receipts](../design/daemon.md#commands). Validation returns the directory and complete check results; initialization returns the created files and instance directory. `list` accepts no instance paths. Registry edits use the [daemon’s startup and lifetime locks](../design/daemon.md#commands) when stopped.

#### `init --dir <path>`

Bootstrap a new Aside instance. Its stable manifest ID is a hostname label as specified in [Instances](../design/instance.md); name and path changes never regenerate it. Writes the `aside.md` manifest; by default the instance is empty (the data scaffold is created on first capture). It does not register the instance; use `aside instance add --dir <path>` for ongoing sync. Options:

- `--dir <path>` — new instance directory (**required**)
- `--name <name>` — instance display name (**required**)
- `--description <text>` — one-line manifest summary (**required**)
- `--body <text>` — free-form per-instance instructions (manifest body)
- `--tutorial` — also lay down the guided getting-started content (the "Meet Aside" tour project, starter actions, and a seeded first entry)

### `aside daemon <operation>`

Manage the [daemon](../design/daemon.md) and its login job. The design doc owns the behavior; the mechanics are under [*Daemon*](#daemon).

```sh
aside daemon start                       # start or reuse the shared daemon
aside daemon install                     # the same at every login, supervised by launchd
aside daemon status
aside daemon automations [--json]
```

- **`start [--foreground]`** — start or reuse the shared daemon, following the [connection and build replacement rules](../design/daemon.md#connecting). Report whether it started, replaced, or reused the daemon; JSON adds `action` (`started`, `replaced`, or `reused`) to the status data and `previousPid` on replacement. `--foreground` makes this command the daemon when none is running and reports once ready.
- **`install`** — write and load the login job, restarting the daemon under it. macOS only. Saved jobs are recognized and refreshed across rebuilds.
- **`uninstall`** — remove the saved login job for future logins. The running daemon and any job already loaded in launchd are untouched; loaded supervision can restart it after a crash until logout.
- **`status`** — the shared information/health report for daemon state, saved login configuration, and instance ID clashes. Instance entries use display names plus loaded/session annotations and keep the directory beneath the name. Instance diagnostics follow the [listing rules](../design/cli-output.md); individual manifest and data problems belong to `instance validate`. Unknown live state is omitted when unreachable. `--json` returns native daemon and login-job values, structured instances, and checks. Failed checks exit nonzero. Never starts a daemon.
- **`stop [-f|--force]`** — when no other client or tab is connected, shut the daemon down and wait for it to exit. Without `--force`, when in use, fail nonzero with client/tab counts, instance context when available, and instructions to use `aside daemon stop --force`, leaving the daemon running. A refusal schedules no deferred exit. `-f`/`--force` bypasses the busy refusal using the fixed-core `shutdown` request, drains requests, flushes pending calendar work, and disconnects clients and tabs. Report success only after the daemon exits; JSON sets `stopped: true` and retains the observed connection/tab counts and instance context. Successful stop retains the saved login job: another client or the next login can restart the daemon.

`start`, `install`, `status`, `automations`, `stop`, and `uninstall` apply to the daemon shared by all instances for the user. They reject positional arguments before connecting or changing files, with operation-specific usage.

`status` and `stop` work with no daemon running. Manage registrations with `aside instance add`, `aside instance forget`, and `aside instance list`.

`automations` inspects future deadlines, active/queued executions and recent run logs without starting the daemon. See [Automation](../design/automation.md) for declaration, execution and lifetime rules.

### `aside diagnostics purge (--dir <path> | --all)`

Delete daemon-managed GraphQL usage logs and completed automation history under
the [diagnostic retention policy](../design/daemon.md#diagnostic-retention).
Exactly one scope is required; `--dir` accepts a previous or deleted instance
location. `--json` reports removed usage-file, collection, and automation-run
counts. The command never starts the daemon and preserves active runs, scheduling
claims, and instance records.

### `aside plugin <install|remove|status>`

Install Aside's plugin from this source checkout, for the user. `install` and `remove` require `--agent claude` or `--agent codex`; `status` checks both agents. By default, both agents install the GraphQL package and run `aside mcp` from `PATH`; `--legacy` selects the separate legacy package running `aside mcp --legacy`. The build script runs `npm link`, so a runtime rebuild reaches each agent at its next session and they share one [daemon](#daemon).

```sh
aside plugin install --agent claude
aside plugin install --agent codex
aside plugin install --agent codex --legacy  # select the legacy package
aside plugin status
```

- **`install --agent claude`** — adds the checkout’s `agent/graphql/` directory as a local-directory marketplace and installs the plugin at user scope. The marketplace uses that same directory as the plugin source.
- **`install --agent codex`** — adds the checkout’s `agent/graphql/` directory as a local marketplace and installs the plugin from `agent/graphql/`. Refresh the installed plugin when its configuration or skill changes; rebuilding the runtime alone does not require a refresh.
- **`--legacy`** — select `agent/legacy/` for install, remove, or status. Both packages share one plugin identity, so installing a different surface replaces the registration and skill rather than installing both. Switching between packages in this checkout needs no `--force`. Claude scopes and enabled choices are preserved; a disabled Codex plugin must be enabled before changing its package because its CLI cannot restore disabled state.
- **`remove --agent <claude|codex>`** — uninstall the selected plugin and remove its marketplace when no other installation needs it. Use `--legacy` when removing the legacy package; a mismatched selection fails before making changes.
- **`--force`** — replace a marketplace of the same name that points at another checkout. Claude plugin installation preserves existing project/local installations and scope-specific enabled choices. Refuse before removing a marketplace if its other plugins or installation scopes cannot be preserved.
- **`--print`** — show the commands instead of running them.
- **Action output** — install and remove print plain receipts; `--print` lists commands directly. Include verification failures and fixes without headings or passing checks. Print operation failures once on stderr with multiline diagnostics and recovery commands. JSON retains the complete checks and operation results.
- **`status`** — report concrete CLI/build/marketplace paths separately from health checks grouped by CLI, Claude Code, and Codex. Checks use `[OK]` / `[ERROR]`, with problems and fixes on failure. Build checks establish file presence. Detect a different checkout behind `aside` on PATH and use this CLI's explicit invocation for recovery. Inspect both agents even if one fails; JSON retains partial results and all checks. Failed checks or inspections exit nonzero. Registration inspection does not check MCP connectivity.

Both agents use Claude-compatible manifests inside the selected package (`agent/graphql/` or `agent/legacy/`); there are no separate Codex manifests. Each package contains only its own skill and MCP configuration. The GraphQL package ships a thin skill covering the record model and task discovery; task resources carry workflow and authoring guidance. The legacy package ships the existing comprehensive skill and its references. Developer specifications and test material remain outside both packages. Plugin installation never stages or copies plugin files. Native plugin caches may copy that configuration, but execution always resolves `aside` through the agent's `PATH`.

When migrating an older standalone Codex setup, first remove its direct registration with `codex mcp remove aside` and remove `~/.agents/skills/aside` only if it is the old Aside symlink. Plugin installation does not remove standalone MCP registrations or personal skills.

Existing registrations at this checkout’s former `agent/` package migrate to the selected package on `aside plugin install`. For a marketplace registered at the checkout root, run `aside plugin install --agent claude --force` to move Claude to `agent/graphql/`. If Codex cannot list the Aside marketplace because its manifest is missing, report recovery commands: remove the stale marketplace with Codex’s CLI, then retry the requested install or removal; `status` suggests reinstalling the selected package. Inspection still fails without making changes; human diagnostics and JSON health checks include the recovery commands.

Plugin commands change agent configuration only through each agent's CLI. Repeating installation leaves an up-to-date installation unchanged. Preserve deliberate disabling; if refreshing a disabled plugin would enable it, stop with recovery instructions. When an agent's CLI or `aside` is unavailable, report recovery instructions. Failed inspection stops installation before changes, and failed verification after a change is reported explicitly. Plugin commands require a source checkout with the shared marketplace manifest, plugin, and launcher under `cli/dist/`.

### `aside query <entity> [filters]`

**Planned — not yet implemented.** Querying is currently available through the MCP query tools.

Query entities with optional filters by relationship or date range.

```
aside query entries --project <name> --from <date> --to <date>
aside query actions --project <name> --from <date> --to <date>
aside query projects --from <date> --to <date>
```

- `<entity>` — one of `entries`, `actions`, `projects`
- `--project <name>` — filter by project association
- `--from <date>` — start of date range (inclusive)
- `--to <date>` — end of date range (inclusive)
- `--search <term>` — full-text filter on content
- `--status open|closed|backlog|scheduled|done|cancelled` — lifecycle filter (projects: open/closed; actions: backlog/scheduled/done/cancelled)

All filters are optional and composable. Dates accept `YYYY-MM-DD` or relative shorthands (`today`, `this-week`, `last-week`).

## Daemon

The mechanics behind [design/daemon.md](../design/daemon.md), which owns the model: roles, lifecycle, the connect and replace rules, and failure behavior.

### Process

Operational defaults and limits are defined in [`system-config.ts`](src/core/system-config.ts), including the browser minute cadence. Consumers import named values with explicit units.

The source build emits dependency-free `main.js` (launcher), `runtime.js`, `regex-worker.js`, and `automation-worker.js` in `cli/dist`; all four are required at runtime on the supported Node versions. On macOS the build also emits `aside-wake`, a notification helper compiled independently of `aside-cal`. The daemon is this same bundle, run as `aside daemon run` — the internal form clients spawn, detached, with its output appended to the log and its working directory set to the persistent daemon state directory — or as `aside daemon start --foreground`. Either way it takes the lifetime lock before listening and exits at once when another daemon holds it. `SIGTERM` and `SIGINT` shut it down cleanly.

| Setting | Value |
|---|---|
| Wait for a launched daemon to answer | 10 s |
| Wait for a daemon to exit after `shutdown` | 25 s |
| Wait for the handshake reply | 5 s; a daemon that does not answer is treated as absent |
| Calendar flush at shutdown | forward syncs in flight, then one attempt at each retry queue, capped at 10 s |
| Regex workers / waiting queue | 2 workers / at most 8 queued searches |
| Regex execution / queue wait | 2 s / 5 s; timeout is an explicit tool error |
| Regex snapshot budgets | 100,000 records and 16 MiB per query; 64 MiB total reserved UTF-8 snapshot payload |

Default state and log locations and daemon-home relocation follow [daemon files](../design/daemon.md#files). Non-macOS builds have no login job. The state directory holds `automation/` claims and run logs, `daemon.sock`, `start.lock`, `daemon.lock` (the lifetime lock), and `known.json`. The locks are kernel `flock`s on macOS and pid files elsewhere, subject to the [release platform constraints](../design/daemon.md#constraints). A socket path over 103 bytes is rejected.

### Build identity

`build.mjs` stamps the bundle with its build time. The handshake carries `{ build: { version, builtAt } }`: `version` is the shared software version, and `builtAt` orders builds for [replacement](../design/daemon.md#replacing-an-older-daemon). Clients require an exact version match for MCP and instance operations.

### Requests

JSON-RPC 2.0, one message per line. A handler failure is error `-32000` carrying the tool's message; a request the daemon declined because it is shutting down is `-32001`, which a client may always resend; an unknown method is `-32601`.

| Method | Params | Result |
|---|---|---|
| `hello` | `{ build }` | the daemon's `{ build, pid }` |
| `shutdown` | — | `{}`, then the daemon exits |
| `automation.status` | — | `{ jobs, runs, warning? }`; automation status and observed runs, as described in [Automation](../design/automation.md#inspection). |
| `diagnostics.purge` | `{ root? }` (absolute canonical instance path; omitted for all) | `{ usage: { files, collections }, automation: { runs } }`; deletes completed diagnostic history without loading instances. |
| `status` | — | `hello`'s result plus `connections`, `tabs`, `known`, `loaded` |
| `stop` | — | `{ stopped, connections, tabs, instances }` — exits when `stopped`; otherwise keeps running. Counts exclude the requesting connection; `instances` names paths held by other clients or tabs. |
| `known.add` / `known.forget` | `{ paths }` | `{ known, changed }` (canonical requested paths whose registration changed) |
| `instance.info` | `{ instance }` | `{ issues }` — loads the instance |
| `tool` | `{ instance, name, args, issues? }` | `{ text, issues? }` |
| `graphql` | `{ mode, args, session }` | `{ result, session }` — GraphQL response and updated session selection |
| `graphql.schema` | `{ session }` | `{ result: { sdl, diagnostics }, session }` — current session's documented executable schema and diagnostics |
| `show` | `{ instance, args, appDir?, navigate? }` | `{ route, port, tab, url, launchUrl? }` |
| `serve` | `{ instance?, appDir?, navigate? }` | `{ route, port, tab, url, launchUrl? }` |

`hello` and `shutdown` are the fixed core. `show` and `serve` prepare a fresh private browser-authorization handoff by default; their caller opens its `launchUrl` or returns it to an agent. `navigate: false` validates and returns the clean route without creating or renewing authorization or changing tabs. `tool` runs one MCP tool by name against the instance and returns its text; `calendar_info` also runs with `instance: null`. With `issues: true` — the CLI's form — the daemon rereads the instance from disk first and returns its parse issues alongside. The daemon sends one notification, `shutting-down`, after which a client reconnects before its next request.

Query tools and `calendar_info` are reads: a client repeats one after a lost connection. Every other tool is a write.

The GraphQL MCP interface uses `graphql` with `mode: query` or `mutation`.
`session` carries canonical workspace and encountered paths, the active path or
null, the MCP working directory, discovery state, and configuration diagnostics.
The daemon returns the updated selection, including after a partially successful
mutation. The MCP
server retains that state across reconnects; it is never a shared daemon default.
Queries may be retried; mutations must not be retried after an uncertain response.
The same GraphQL schema and record executor also serve single-instance `tool`
requests, which do not have MCP session operations available.

The read-only `graphql.schema` request serves `aside://graphql/schema` directly
from the daemon and may be retried after connection loss. It carries the same
session state and returns the schema matching that session's instance and catalog
revision. SDL is printed lazily once per executable schema object; the resource
does not reconstruct it through introspection JSON. Cold sessions use the cached
static schema. Context changes invalidate the model catalog; schema reads reuse
valid catalog entries. `models(refresh: true)` explicitly refreshes vendor
discovery. Resource responses preserve diagnostics as SDL comments. See the
[GraphQL contract](../design/graphql.md#agent-surface) for discovery guidance.

### Login job

The [login job](../design/daemon.md#files) runs this install's `node <bundle> daemon start --foreground` with `RunAtLoad`, `KeepAlive` on unsuccessful exit only, and output to the daemon log. The job environment records the writing build's time as `ASIDE_JOB_BUILT_AT` and any resolved relocation as `ASIDE_DAEMON_HOME`; without a relocation the default macOS state and log locations remain distinct. A client about to start or replace the daemon rewrites a job from an older build, or one naming a bundle that no longer exists. `install` and a job rewrite load it with `launchctl bootout` then `bootstrap`; a client starting the daemon uses `launchctl kickstart`, loading the job first when launchd does not have it. `uninstall` deletes the file and leaves launchd's loaded copy until logout.

## Web Server

The daemon owns one HTTP server at `http://localhost:24800`, bound to `127.0.0.1`. It starts when the webapp bundle is available, so authorized tabs reconnect after daemon replacement. See [browser authorization](../design/daemon.md#browser-authorization) for token handling and the accepted local impersonation risk. A port collision is an explicit error; Aside never silently changes the origin. The sibling `webapp/` supplies the shell; `aside show --app-dir <path>` overrides its asset directory.

- `/` — instance chooser; listing reads registered manifests without loading record stores or calendar sync.
- `/<instance-id>/…` — instance timeline and singular entity routes (see webapp *URL state*); safe instance paths serve the app shell, including unavailable instances so the UI can explain recovery.
- `/-/assets/<path>` — regular, non-hidden build files under the selected webapp's `dist/`, including shell CSS, JS, and bundle maps. The decoded path must be relative, with no empty, dot, parent, or hidden segments; symlinks and non-regular files are rejected. No filename or extension allowlist is required.
- `/-/api` — authenticated software version.
- `GET /-/api/auth` — authenticated session deadline, without renewal.
- `POST /-/auth/complete` — receives the private handoff code and serves a same-origin authorization bridge.
- `POST /-/auth/redeem` — atomically consumes that one-use code, renews the browser profile's valid session or creates one, and returns authorization and the requested destination. Requires the exact daemon origin and `X-Aside-Control: 1`.
- `GET /-/api/instances/<id>/access` — session-bound file-signing material for native media.
- `/-/files/<session>/<instance>/<scope>/<signature>/files/…` — scoped signed GET/HEAD reads with active-session and realpath checks.
- `GET /-/api/instances` — every daemon-known instance, with stable ID, name, description, canonical path, and any identity conflict. Unloaded instances are included. Garbage-collect verified non-instances before returning this list. Removed, repurposed, and unreadable directories are omitted; every returned path must pass the instance check.
- `POST /-/api/instances/register` — `{kind: "directory" | "manifest"}` opens the macOS native picker; `{path: "<folder or aside.md>"}` registers an entered path directly on every platform. Supply one method. Typed paths must be absolute or start with `~/` (expanded against the user's home); invalid request shapes return 400. Validate an existing directory or `aside.md`, canonicalize and deduplicate its path, and persist it in place. Cancellation returns `{instance: null}` and changes nothing. Invalid selections return a recoverable error.
- `POST /-/api/instances/remove` — `{path: "<canonical directory>"}` forgets that listed directory's registration and returns `{instances: [...]}` with the refreshed catalogue. Paths disambiguate duplicate IDs. Missing entries return 404; invalid paths return 400. Files and active sessions are preserved.
- `GET /-/api/instances/<id>` — metadata for one unambiguous instance. Unknown IDs return 404; duplicate IDs return 409 with every conflicting path.
- `/-/api/instances/<id>/files/…` — instance files and media, with validators. Missing files return 404. [Managed paths](../design/instance.md#instance) reject symlinks; other media paths require resolved containment within the instance.
- `GET /-/api/instances/<id>/years` — all stored year directories, without a fixed time window.
- `POST /-/api/instances/<id>/graphql` — read-only record queries with `{query, variables?, operationName?}` and standard GraphQL responses. Uses the [webpage query policy](../webapp/spec.md#iframe-graphql), independent of MCP session selection.
- `GET /-/api/instances/<id>/watch` — coalesced instance file-change events over SSE.
- `/-/api/instances/<id>/control` — tab registration over SSE and focus reporting over POST; navigation reaches only tabs displaying that instance.
- `/-/api/control` — chooser tab registration and focus reporting, without loading an instance.

The daemon stays running and syncs all known instances independently of browser tabs. A selected-instance tab keeps a forgotten instance loaded until it closes. Browser selection does not change any MCP session selection. Duplicate IDs are never resolved by directory ordering.

### Security

The listener enforces the [per-user browser authorization boundary](../design/daemon.md#browser-authorization):

- Every API requires a valid bearer token, including discovery, reads, conditional reads, and streams. Signed file grants authorize only their bounded read scope.
- The public shell and assets expose no catalogue or record data. Responses suppress referrers.
- The application shell carries a Content Security Policy: scripts, stylesheets, fonts, and connections only from the daemon origin, with inline styles permitted for rendered Markdown and diagrams; authored images, media, and frames from the origin, `http(s)` URLs, or (images) `data:`; no plugins, form submission, base URLs, or framing. Record content that escapes sanitization therefore cannot run as the app. Previews are separate documents governed by their own file responses.

- No CORS headers; the browser and daemon are same-origin.
- The `Host` header must be localhost, preventing DNS rebinding.
- Stateful SSE endpoints require same-origin browser requests. Control POST endpoints require both the exact origin, when supplied, and `X-Aside-Control: 1`; foreign pages cannot open native pickers or steer tabs, including pages on another localhost port. Authenticated non-browser callers can use the header without an Origin. The file handoff enters through the separate authorization endpoints described above.
- Instance HTML and SVG file responses (`.html` / `.htm` / `.svg`, case-insensitive) preserve their MIME types and use `Content-Security-Policy: sandbox allow-scripts`, including conditional responses. Direct file navigation retains the [webpage preview boundary](../webapp/spec.md#webpage-embeds).

## MCP Tools

The MCP server exposes the required interface for agent queries and writes. Agents can submit prepared drafts under the [content-source contract](#content-sources).

### Design Principles

- **Agent ergonomics first.** Tool names, argument shapes, and return formats are optimized for LLM consumption — compact plain text with canonical values, complete metadata, and explicit continuation and completion state.
- **Three detail levels.** Query tools default to index-level results (ID + description). Pass `detail: "metadata"` for all fields without the body, or `detail: "full"` for fields plus body.
- **Composable filters.** Query tools accept multiple optional filters that narrow results. Omitting a filter means no constraint on that dimension. An empty array `[]` is never ignored; it is always a real constraint: for relationship filters (`projects`, `actions`, `related_to`) it matches entities with none of that relationship; for set-membership filters (`ids`, `status`) it matches nothing. An empty set-membership filter is almost always a mistake (the caller meant to omit it), so the response appends a note that it matched nothing.
- **Search spans authored text.** A `search` filter is a case-insensitive regex (max 256 characters) matched against an entry's content and index description, or a named entity's name, index description, and body. Artifact attachment contents are not searched. Matching uses native JavaScript regex syntax in the daemon’s bounded worker pool, with a two-second execution deadline; timed-out workers are terminated and replaced. Queue overload, snapshot limits, worker failures, cancellation, and queue/execution timeouts return explicit errors, never partial or empty-success results. Narrow filters or simplify the regex before retrying.
- **Invalid input is an error.** Every tool rejects unsupported top-level and nested arguments before making changes; the daemon validates the same strict schemas for direct tool requests. Input a tool cannot act on — a malformed regex, or a write targeting a missing entity — returns an MCP error, not a normal result. A query that simply matches nothing (e.g. an unknown ID in a filter) is not an error: it returns an empty result.
- **Shared state.** The daemon holds each instance's entity records and indexes in memory, with relationship caches built from entry tags and inline artifact references. Queries use cached records; attachment references validate exact file presence without reading their contents. Every session on an instance sees the same cache. A regex query snapshots filtered record text, the requested detail fields (including relationships, paths, and descriptions), and parse warnings before yielding; matching, counts, pagination, and output use that same snapshot despite concurrent edits. Record mutations stay synchronous and ordered in the owner daemon. Disconnect cancels the client’s queued and executing searches; shutdown settles all pending searches and terminates workers.

### Instance State

The MCP server resolves its workspace at startup (see directory resolution above) and asks the daemon to load the active instance. Loading an instance:
1. Loads all year indexes and project, action, and artifact records
2. Parses all weekly files to extract entries
3. Builds derived relationship maps (project↔action from entry co-occurrence; artifact associations from inline references)

Writes update the cache inline. The daemon watches for external file changes, including reverse-calendar writes, and rebuilds the cache from disk. Legacy `create_instance` and `validate` run in the MCP server itself, on files. In GraphQL mode, `createInstance` runs in the daemon through the same instance initialization and recovery handler. GraphQL mode replaces the three instance tools with `instances` and `activeInstance` queries and `selectInstance` and `createInstance` mutations. Validation is the read-only `Instance.validation` field. `show(input:)`, `showUrl(input:)`, and `calendarInfo` are mutations; calendar information preserves permission requests and structured recovery in a single call, even without an active instance. These are the only MCP tools in this mode; guides and schema are MCP resources; see the [GraphQL contract](../design/graphql.md).

### Pagination

All query tools accept integer `offset` (default 0, nonnegative) and integer `limit` (default 20, 1–100). Invalid values are errors. Date bounds must be real `YYYY-MM-DD` dates, with `from` no later than `to`.

Response header is always the first line: `{showing} of {total}` — e.g., `3 of 12`. `showing` is the page size; `total` is the number of records matching all filters and search before pagination. Use `limit: 1` and read `total` when only a count is needed. For groups expressible by filters or date ranges, query each group separately; otherwise page the needed records and compute the aggregate. Parsing warnings mean the data was loaded best-effort, so counts may be incomplete.

The header is followed by `offset`, `limit`, and `next_offset`. Continue with the returned `next_offset`; `null` means the last page, including an exhausted offset or no matches.

### Response Format

Responses are compact plain text. IDs and timestamp fields contain only canonical values, without weekday suffixes. Queries append a concise warning when tolerant parsing recovered malformed data; run `validate` for complete diagnostics.

Scalar text containing control characters or ambiguous syntax in its output context is JSON-quoted and escaped, including literal JSON strings and list or index delimiters within IDs. Decode a complete JSON-string scalar before reusing it; other scalars are verbatim. Ordinary canonical IDs and timestamps remain unquoted.

- **Index mode** (default): one line per item — `{id} — {description}`. Artifacts use `#artifact/{id}` in place of the bare ID.
- **Metadata mode**: all metadata as `key: value` lines, including index descriptions and each related project's ID and relationship description, without the body. Relationship descriptions use an indented `description: |` block to preserve their full text.
- **Full mode**: metadata followed by `content: |` for entries or `body: |` for named entities. Every authored line is indented by two spaces, preserving the text after removing that prefix. Records start with unindented `id:` fields, separated by blank lines; metadata-like authored text remains inside its body.

Entry, action, and project metadata/full results include a `file:` line (absolute path) after `id:` identifying the source record. For entries this is the weekly file. Index mode omits it. Artifact results include `handle: #artifact/{id}` instead; their storage path follows the prescribed layout.

Results are always reverse chronological (latest first).

### Instance Tools

An instance is addressed by its data-directory path. Listings lead with the manifest's `name — description` and trail the path: `name — description  (path)`, falling back to the path alone when the manifest has no name.

#### `select_instance`

Select the active instance for subsequent tool calls (see instance resolution under `aside mcp`). The path must already be an instance (have an `aside.md` manifest); use `create_instance` to make a new one.

**Arguments:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | yes | Absolute path to the instance's data directory |

On activation the response reports the active instance, daemon registration and next-session selection rules, and notes any parse issues found while loading it — best-effort reads surfaced so the agent can flag malformed files (see *Robust reads*).

#### `query_instance` / `update_instance`

`query_instance` takes no arguments and returns the selected instance's absolute
`path`, parsed `manifest` (including `automations`), and instruction `body` as JSON.
`update_instance` accepts `automations` for complete replacement or
`automationEdits` for individual jobs, as described in
[Automation](../design/automation.md). These inputs are mutually exclusive when
edits are non-null. `recurrenceLookaheadDays` optionally updates the nonnegative
integer `config.recurrenceLookaheadDays`. `body` replaces user-authored instance
instructions; omit to preserve, empty text to clear, and null is rejected.
`scheduledEventTitlePrefix` and `doneEventTitlePrefix` edit the respective config
values; omit to preserve, empty text for no prefix, and null to restore defaults.
Preserve manifest identity and omitted fields/body. The receipt includes the
updated instance. GraphQL reads through `activeInstance`, returning null without
a valid selection, and writes through `updateInstance(input:)` with the same
settings. GraphQL execution inspection uses `automationRuntime` and
`automationLog`; see [GraphQL](../design/graphql.md).

#### `query_models`

Lists selectable built-in and named automation models for the selected instance
as JSON, including availability and discovery diagnostics. Optional `refresh`
(boolean, default false) refreshes the cached catalog. Discovery sends no inference
prompt. GraphQL uses `models(refresh:)`; see [Automation](../design/automation.md).

#### `list_instances`

Fetch the daemon catalogue and merge it with session candidates, deduplicated by canonical path. Return **In this workspace** and **Other known instances** with active selection shown independently, even when none is active. Before returning lists, prune stale session candidates and collect verified non-instances from the daemon registry. Every listed path must currently pass `isAsideDir`; unreadable registrations are retained only as internal identity guards, never as list entries. Clear an invalid active selection without selecting another instance. Failed instance use also triggers collection and cached stores are revalidated before use. See [workspace membership](../design/instance.md#workspace). No arguments.

#### `create_instance`

Create a new instance at `path` and make it active. The path must not already be an instance (it must be empty or not exist). The manifest is written with the given `name`/`description`/`body`; `version` is set automatically.

**Arguments:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | yes | Absolute path for the new instance. If the user gave no location, use a directory named `aside` |
| `name` | string | yes | Display name for the instance |
| `description` | string | yes | One-line summary that helps agents pick among instances |
| `body` | string | no | Free-form manifest body (per-instance instructions); include only what the user stated |
| `tutorial` | boolean | no | If true, also create the "Meet Aside" guided-tour project, starter actions, and a seeded first entry. Default false (empty instance). |

By default the instance is empty — only `aside.md` is written, and the data scaffold (year folders, indexes, weekly files) is created on first capture. With `tutorial: true`, the response additionally instructs the agent to read the tour project and walk the user through it.

### Recurrence planning and edits

Action creation inputs accept `recurrence`, the ordered
RRULE schedules in [Action recurrence](../design/recurrence.md). Templates cannot
be scheduled, resolved, or materialized actions, including dormant templates
with an empty schedule list. Metadata/full action reads include recurrence
and occurrence provenance. Legacy queries and counts retain saved records only;
GraphQL action collections also include future projections, as described below.

`update_action.recurrence` accepts exactly one command, also exposed through
GraphQL `updateAction.input.recurrence`:

| Command | Input | Effect |
|---------|-------|--------|
| `append` | `{dtstart, rrule, timezone?}` | Append a future schedule after the final stored start; close an overlapping final rule with inclusive `UNTIL`. Earlier queued schedules and already-ended rules stay unchanged. |
| `set_end` | `{schedule: {dtstart, timezone?}, at?}` | Set the selected rule's exclusive occurrence-start cutoff. `at` is an explicit-offset ISO timestamp, default now, after that rule's start. The server derives native `UNTIL`. |
| `remove` | `{dtstart, timezone?}` | Remove the selected rule, including historical rules. Removing the last leaves a dormant template with `recurrence: []`. |

Copy selectors from action metadata. Retained rule patterns, anchors, and zones
cannot be patched. Shortening or removal may drop projections; extensions must
not expose new historical projections unless the exact occurrence identities
already have saved actions. Validate the full result before writing; saved
actions, template, and provenance remain. To stop the entire recurrence, end its
active rule and remove queued rules.

`planning_actions` accepts inclusive `from`/`to` dates, optional project IDs,
`limit` (1–100, default 100), and opaque `after`. It returns JSON `nodes` with
`id`, `action`, `projected`, and optional `occurrence`, plus `next` and `issues`.
Continue with `after: next` until null; there is no history cutoff. Omitted dates
use the instance lookahead and include at least one future occurrence per template.

`update_occurrence` requires `template`, exact `original`, and at least one
ordinary action edit. It accepts the same editable fields as `update_action`,
except `id` and `recurrence`. It reuses an existing occurrence identity or
materializes an ordinary action without creating an entry. GraphQL exposes
`updateOccurrence(input:)` for the same identity-based edit.

GraphQL uses one action collection instead of a separate planning query.
`actions` and nested action connections include saved actions, templates, and
future occurrences within `InstanceConfig.recurrenceLookaheadDays`; filters,
counts, ordering, and pagination apply to the combined set. `action(id:)` resolves
saved IDs and generated projection IDs within that horizon. `Action.recurrence`
and `Action.occurrence` are direct fields. The latter contains immutable
`template`, `original`, optional `timezone`, and `projected`: true for an unsaved
occurrence, false after materialization. Ordinary actions and templates have no
occurrence. A non-null recurrence list identifies a template, including `[]` for
a dormant template; its GraphQL status is null. Ordinary actions and occurrences
have no recurrence list and retain their lifecycle status. Provenance and
projected state are independent of completion or cancellation.
Projections inherit their template's live projects and artifact
context without creating persistent tags or backlinks. Projection handles remain
transient; use the saved handle returned after editing for durable references.
`ActionWhere.occurrence` filters by `projected` and/or exact `template`; `{}`
matches any occurrence. Projection failures appear in response diagnostics and
make `extensions.complete` false. `updateAction(id:, input:)` accepts a listed
projection ID and automatically materializes it using an ordinary action edit;
recurrence commands edit template schedules. `ActionWhere.recurrence_exists`
selects every non-null recurrence list when true, including `[]` and nonempty
histories whose schedules have ended or produce no future occurrences. It selects
ordinary actions and occurrences when false, and is unrestricted when omitted
or null. Direct status predicates exclude templates; unfiltered action lists
still include them. Negation follows normal predicate logic, so
`NOT: {status: [DONE]}` includes null-status templates. Also set
`recurrence_exists: false` when that query should return only work.

For GraphQL creation, a supplied recurrence list or `[]` creates a template.
Omit irrelevant optional creation fields; null clearing belongs to updates.
`updateAction.input.recurrence.append` can convert an ordinary action into a
template while preserving its ID and context. The resulting action must be
unscheduled and unresolved; existing `scheduled` and `resolution` can be cleared
with null in that update. Occurrences cannot be converted to templates. Removing
the last schedule leaves a dormant template with `recurrence: []` and null status.

### Query Tools

All query tools accept:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `detail` | string | no | `index` (default), `metadata`, or `full` |
| `offset` | integer | no | Nonnegative starting index (default 0) |
| `limit` | integer | no | Max results (default 20, 1–100) |

#### `query_entries`

Find entries by project, date range, or content.

**Arguments:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ids` | string[] | no | Exact entry IDs (created timestamps) (`[]` = match nothing) |
| `projects` | string[] | no | Filter by project IDs (`[]` = entries with no project) |
| `actions` | string[] | no | Filter by action IDs (`[]` = entries with no action) |
| `created_from` | string | no | Start date inclusive (`YYYY-MM-DD`) |
| `created_to` | string | no | End date inclusive (`YYYY-MM-DD`) |
| `search` | string | no | Regex matched against entry content and description (case-insensitive) |

**Returns (index):**
```
3 of 12
offset: 0
limit: 3
next_offset: 3

2026-05-05T14:00 — Met with team about migration timeline
2026-05-04T09:00 — Morning standup notes
2026-05-03T15:30 — Reviewed schema changes
```

**Returns (full):**
```
2 of 12
offset: 0
limit: 2
next_offset: 2

id: 2026-05-05T14:00
file: /data/notes/2026/2026-05-04.md
description: Met with team about migration timeline
projects: [2026-05-02-migration]
actions: [2026-05-05-deploy-db]
content: |
  Met with team about migration timeline. Decided to go with option B for the migration approach.

id: 2026-05-04T09:00
file: /data/notes/2026/2026-05-04.md
description: Morning standup notes
content: |
  Morning standup. Quick check-in, nothing blocking.
```

#### `query_actions`

Find actions by project, schedule, deadline, or lifecycle status.

**Arguments:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ids` | string[] | no | Exact action IDs (`[]` = match nothing) |
| `projects` | string[] | no | Filter by associated project IDs (`[]` = actions with no project) |
| `created_from` | string | no | Creation date start (`YYYY-MM-DD`) |
| `created_to` | string | no | Creation date end (`YYYY-MM-DD`) |
| `scheduled_from` | string | no | Scheduled date start (`YYYY-MM-DD`) |
| `scheduled_to` | string | no | Scheduled date end (`YYYY-MM-DD`) |
| `deadline_from` | string | no | Deadline start (`YYYY-MM-DD`) |
| `deadline_to` | string | no | Deadline end (`YYYY-MM-DD`) |
| `status` | string[] | no | Match actions in any of the listed states (OR): `backlog`, `scheduled`, `done`, `cancelled` (`[]` = match nothing). Compose overdue/slipped/upcoming as a status + `deadline_to`/`scheduled_to`/`scheduled_from` |
| `search` | string | no | Regex matched against name, description, and body (case-insensitive) |

**Returns (index):**
```
2 of 5
offset: 0
limit: 2
next_offset: 2

2026-05-05-deploy-db — Migrate production database to new schema
2026-05-02-review-schema — Review schema changes with the team
```

**Returns (full):**
```
1 of 5
offset: 0
limit: 1
next_offset: 1

id: 2026-05-05-deploy-db
file: /data/actions/2026/2026-05-05-deploy-db.md
name: Deploy DB
created: 2026-05-05T14:30
description: Migrate production database to new schema
scheduled: 2026-05-15T10:00
deadline: 2026-05-20T17:00
projects: [2026-05-02-migration]
body: |
  Migrate the production database to the new schema. Coordinate with the infra team on downtime window.
```

The `projects` field is derived from entry co-occurrence.

#### `query_projects`

Find projects by date range, relationships, or lifecycle status.

**Arguments:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ids` | string[] | no | Exact project IDs (`[]` = match nothing) |
| `related_to` | string[] | no | Filter by related project IDs (`[]` = projects with no related project) |
| `created_from` | string | no | Created date start (`YYYY-MM-DD`) |
| `created_to` | string | no | Created date end (`YYYY-MM-DD`) |
| `ended_from` | string | no | Ended date start (`YYYY-MM-DD`) |
| `ended_to` | string | no | Ended date end (`YYYY-MM-DD`) |
| `status` | string | no | One of: `open`, `closed` |
| `search` | string | no | Regex matched against name, description, and body (case-insensitive) |

**Returns (index):**
```
1 of 3
offset: 0
limit: 1
next_offset: 1

2026-05-02-migration — Migrate from Notion to text + AI + tools model
```

**Returns (full):**
```
1 of 3
offset: 0
limit: 1
next_offset: 1

id: 2026-05-02-migration
file: /data/projects/2026/2026-05-02-migration.md
name: Migration
created: 2026-05-02T14:30
description: Migrate from Notion to text + AI + tools model
status: open
related_projects:
  - project: 2026-04-15-infra
    description: |
      Infrastructure supporting the migration
body: |
  ## Goals
  - Complete migration by Q3
  - Zero data loss
  ## Constraints
  - Must maintain read access during transition
```

Results are ordered reverse chronologically (latest first) by default.

#### `query_artifacts`

Find maintained content by creation date, inline-reference associations, or authored text. Accepts the common `detail`, `offset`, and `limit` arguments.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ids` | string[] | no | Exact artifact IDs (`[]` = match nothing) |
| `projects` | string[] | no | Associated project IDs (`[]` = no project association) |
| `actions` | string[] | no | Associated action IDs (`[]` = no action association) |
| `created_from` | string | no | Created date start, inclusive (`YYYY-MM-DD`) |
| `created_to` | string | no | Created date end, inclusive (`YYYY-MM-DD`) |
| `search` | string | no | Regex matched against name, description, and Markdown body (case-insensitive) |

Associations derive from [inline references](../design/artifact.md#references-and-rendering): an entry's tags provide project/action context; a reference in a project or action body associates that entity directly. Referencing an attachment gives its parent artifact the same project/action associations; backlinks target the exact artifact or attachment referenced. Handles in inline code or code blocks remain text and create no links, backlinks, or associations. Attachments never originate links; their contents are not scanned for references.

Results are newest first by `created`. Metadata includes the canonical `handle`, indexed `attachments`, `attachment_files` containing exact filenames, canonical handles and validated absolute saved-copy paths (or useful errors), implicit file `target` when applicable, derived project/action associations, and deduplicated source `backlinks`; full detail adds the Markdown body. Attachment filenames are available without reading file contents. See the [file content rule](../design/artifact.md#file-content).

```text
1 of 1
offset: 0
limit: 1
next_offset: null

#artifact/2026-10-02-design-review — Current design
```

### Write Tools

#### Content Sources

Entry content accepts `content` or `content_file`; action/project/artifact bodies accept `body` or `body_file`. Action/project bodies also accept file sources when created inside `capture` or `update_entry`.

- **One source per field.** Inline and file arguments are mutually exclusive, even when empty or identical. `capture` requires exactly one entry-content source. On updates, omit both to keep the current content/body; an empty string or empty file clears it. New named-entity bodies are empty when both sources are omitted.
- **Server-local files.** A file argument is an absolute path to a readable regular UTF-8 Markdown file on the MCP server's filesystem. The entire file is the content/body; front matter is not interpreted as entity metadata. Metadata and index descriptions stay in their structured arguments.
- **Preflight before writes.** Resolve all sources, including nested bodies, and validate their content before any mutation. Source errors leave the instance unchanged. Resolved text uses the same handlers, cache/index updates, and calendar sync as inline text.

#### `capture`

Create a new entry, optionally creating new projects and actions. To edit an existing entry, use `update_entry`.

**Arguments:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content` | string | one source | Entry content (markdown); see *Content Sources* |
| `content_file` | string | one source | Markdown source file for the entry content |
| `description` | string | yes | The entry's one-line index description, authored in the user's voice |
| `projects` | array | no | Each item is a string (existing ID) or an object (new project) |
| `actions` | array | no | Each item is a string (existing ID) or an object (new action) |

Each new project object:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Display name (ID derived from date + slug of this) |
| `description` | string | yes | One-line index description |
| `body` | string | no | Project body (goals, contacts, constraints) |
| `body_file` | string | no | Markdown source file for the project body |
| `automations` | object | no | Named map of [automation declarations](../design/automation.md) |
| `related_projects` | object[] | no | List of `{project, description}` links |

Each new action object:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Short display name (ID derived from date + slug of this) |
| `description` | string | yes | One-line index description (the fuller phrasing the name is shortened from) |
| `body` | string | no | Action details |
| `body_file` | string | no | Markdown source file for the action body |
| `recurrence` | object[] | no | Ordered template schedules; see [Recurrence planning and edits](#recurrence-planning-and-edits) |
| `scheduled` | string | no | ISO 8601 with minute precision, or date-only for all-day work |
| `deadline` | string | no | ISO 8601 with minute precision, or date-only when no time was specified |
| `calendar` | string | no | Readable calendar name; must resolve uniquely |
| `calendar_account` | string | no | Optional readable account qualifier; name/account pair must resolve uniquely |
| `duration` | string | no | Event length as a positive fixed ISO duration in whole minutes (e.g. `PT1H`, `P1D` = 24 elapsed hours across clock changes) |
| `timezone` | string | no | Named IANA time zone for timed `scheduled` (e.g. `Asia/Tokyo`); omitted means floating, all-day dates ignore it |

**Returns:** the entry ID and its source weekly file, plus any newly created entity IDs.
```
entry: 2026-05-09T14:30
file: /data/notes/2026/2026-05-04.md
projects_created: [2026-05-09-migration]
actions_created: [2026-05-09-deploy-db]
```

**Errors:**

When parameters are invalid, the tool returns a plain-text error explaining what's wrong and how to fix it:

```
Error: project "nonexistent-project" not found.
Hint: pass an object with {name, description} to create a new project, or use query_projects to find the correct ID.
```

#### `create_artifact` / `update_artifact`

Create or maintain durable content independently of entries. To record its surrounding context, create the artifact first and include the returned handle inline in `capture` or `update_entry`. `capture` creates only entries, projects, and actions.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | update only | Exact artifact ID |
| `name` | string | create only | Display name; editable without changing the ID |
| `description` | string | create only | One-line index description; editable on update |
| `body` | string | no | Markdown body; see *Content Sources* |
| `body_file` | string | no | Markdown source file for the body |
| `files` | object[] | no | Imports: `{source: absolute-path, filename?: exact-filename}` |
| `remove_files` | string[] | no | Update only: exact attachment filenames to remove |

Creation derives an immutable date-and-name ID and minute-precision `created` timestamp. The record and imports use the prescribed [artifact storage layout](../design/artifact.md#identity-and-storage). Source paths are transient inputs and never enter front matter or handles.

- **Imports:** `source` must be a readable regular file on the server's filesystem; any format is accepted. `filename` defaults to its basename and must be a single filename. Reserved staging names (`.<UUID>.tmp` and `.<13-digit timestamp>-<base36 suffix>.tmp`) are rejected. Files are copied, preserving the source. Update imports add or replace named files; other files remain untouched. Omitted `files` or `[]` does nothing. Duplicate destinations, including case and Unicode normalization variants, are errors. Replacements must preserve the exact spelling of an existing attachment filename.
- **Attachments:** MCP maintains the `attachments` front matter index and reports it in metadata and write receipts. It is not an input field. An empty Markdown body with exactly one attachment uses that file as the artifact content; see the [file content rule](../design/artifact.md#file-content).
- **Removals:** `remove_files` names existing regular attachments to remove. Omission or `[]` preserves them. Importing and removing the same filename is an error; use an import alone to replace its contents. A removal that leaves a dangling reference in a record body is rejected. Combine imports and removals to replace a sole attachment under a new name.
- **Preflight:** resolve sources and validate the resulting body, attachment set, references, and destinations before writing. Invalid inputs leave the instance unchanged. Sources are snapshotted before attachment replacements or removals.

Both tools return the artifact handle, metadata, and handles for files imported by the call. Queries at metadata/full detail and both write receipts include `attachment_files` for every current indexed attachment: `filename`, canonical `handle`, and absolute `path` to its managed saved copy. The server checks exact filename membership, ordinary regular-file status, and realpath containment in the managed artifact directory and instance. Invalid or missing files have an `error` and no readable path; removed files have no retrieval entry. Agents may read these paths with their existing file or format tools. Paths are current read-only retrieval metadata; filenames remain the persisted index and handles remain the authored references. Attachment handles URI-escape the filename segment, including spaces, punctuation, and literal percent signs; the exact disk filename stays unchanged. For example, `design (final).png` is referenced as `#artifact/<id>/design%20%28final%29.png`. Updating preserves the ID and creation timestamp.

```text
artifact: #artifact/2026-10-02-design-review
name: Design review
created: 2026-10-02T14:30
attachments: [desktop.png]
attachment_files:
  - filename: desktop.png
    handle: #artifact/2026-10-02-design-review/desktop.png
    path: /absolute/aside/artifacts/2026/2026-10-02-design-review/desktop.png
files_imported:
  #artifact/2026-10-02-design-review/desktop.png
```

#### `update_action` / `update_project` / `update_entry`

Edit an existing entity in place. `update_action` and `update_project` change lifecycle and details — rename, schedule, reschedule, complete, cancel, close, reopen, or edit a body, related projects, or index description; `update_entry` edits an entry's content, its index description, and its project/action links. `update_action` and `update_project` do **not** create entities (use `capture` or `update_entry`), and no update changes an ID, filename, or creation timestamp (`name`+`created` initially derive an action/project ID; the `created` timestamp is the entry ID). One tool per entity kind, so each exposes only its own fields.

Updates patch fields with merge-patch semantics:
- **Omit** a field — leave it unchanged.
- **Value** — set or replace the field.
- **`null`** — remove the field (e.g. deschedule, reopen, clear a deadline; for a list field, clear the list).

`update_action.recurrence` uses the schedule commands above rather than replacement
or null clearing.

Prefer collection patches for individual edits. `projectEdits` and `actionEdits`
on entry updates use `add` (existing IDs or new contextual records) and `remove`
(IDs); `relatedProjectEdits` uses `upsert` (project ID and description) and
`remove` (IDs). Omitted, null, or empty lists preserve other items. Duplicate IDs
or IDs appearing in both operations are rejected. Existing link order stays
fixed, with new items appended; re-adding a saved tag or removing an absent link
is harmless. Each patch input is exclusive with its supplied full-replacement
field. Automation jobs use the patches in [Automation](../design/automation.md).
Bodies accept replacement text; omitted content is preserved.

Most updates need no entry. Capture a separate entry only when the change carries context worth recording.

**`update_action` arguments:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | yes | Exact action ID (e.g. `2026-05-05-deploy-db`) |
| `name` | string | no | Nonblank display name; omission preserves it. Renaming also updates a linked calendar event title. |
| `recurrence` | object | no | Exactly one of `append`, `set_end`, or `remove`; see [Recurrence planning and edits](#recurrence-planning-and-edits) |
| `scheduled` | string \| null | no | ISO 8601 with minute precision, or date-only for all-day work; `null` to deschedule. |
| `deadline` | string \| null | no | ISO 8601 with minute precision, or date-only when no time was specified; `null` to remove. |
| `resolution` | string \| null | no | `done` to complete, `cancelled` to cancel; `null` to reactivate. |
| `calendar` | string \| null | no | Readable calendar name; `null` stops syncing and removes the event. |
| `calendar_account` | string \| null | no | Readable account qualifier; omit to preserve, `null` to clear. |
| `duration` | string \| null | no | Event length (positive fixed ISO duration in whole minutes, e.g. `PT1H`, `P1D` = 24 elapsed hours across clock changes); `null` for the default. |
| `timezone` | string \| null | no | Named IANA time zone for timed `scheduled`; `null` for a floating time. All-day dates ignore it. |
| `body` | string | no | Replace the markdown body; see *Content Sources* |
| `body_file` | string | no | Markdown source file for the replacement body |
| `description` | string | no | Update the one-line index description. Omit to keep the current one. |

**`update_project` arguments:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | yes | Exact project ID (e.g. `2026-05-02-migration`) |
| `name` | string | no | Nonblank display name; omission preserves it. IDs, filenames, timestamps, and references stay fixed. |
| `ended` | string \| null | no | ISO 8601 with minute precision (typically now) to close; `null` to reopen. |
| `automations` | object \| null | no | Replace the complete automation map; omit to preserve, `null` or `{}` to clear. Validated before writing. |
| `automationEdits` | object \| null | no | Patch/upsert/remove named jobs without validating unrelated declarations; see [Automation](../design/automation.md). Exclusive with a supplied complete replacement when non-null. |
| `related_projects` | object[] \| null | no | Replaces the list entirely (full desired set of `{project, description}`); `null` or `[]` clears it. |
| `relatedProjectEdits` | object \| null | no | Patch selected outgoing links with `upsert`/`remove`; prefer for individual changes. |
| `body` | string | no | Replace the markdown body; see *Content Sources* |
| `body_file` | string | no | Markdown source file for the replacement body |
| `description` | string | no | Update the one-line index description. Omit to keep the current one. |

**`update_entry` arguments:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | yes | Exact entry ID (the `created` timestamp, e.g. `2026-05-05T14:30`) |
| `content` | string | no | Replace the entry content; see *Content Sources* |
| `content_file` | string | no | Markdown source file for the replacement content |
| `description` | string | no | Replace the one-line index description. Omit to keep the current one. |
| `projects` | array \| null | no | Each item is a string (existing ID) or an object (new project, as in `capture`). Replaces the whole set; `null` or `[]` clears it. |
| `actions` | array \| null | no | Each item is a string (existing ID) or an object (new action, as in `capture`). Replaces the whole set; `null` or `[]` clears it. |
| `projectEdits` | object \| null | no | Patch selected project tags with `add`/`remove`. |
| `actionEdits` | object \| null | no | Patch selected action tags with `add`/`remove`. |

New objects are created exactly as in `capture`; the confirmation carries the same `projects_created` / `actions_created` lines.

Writes can fail after earlier effects have saved. GraphQL retains confirmed
changes and incomplete steps in `extensions.mutations` and the failing field's
`errors[].extensions.partialResult`; see the [GraphQL write contract](../design/graphql.md#writes).
Read back saved effects and retry only unapplied steps. A completely lost response
still requires readback; creates have no idempotency key.

Scheduled action creation and calendar-affecting updates append `calendar_sync` records with `id`, `status`, and a reason or retry flag when applicable. The entry/update confirmation establishes the local save. Calendar states are `pending` (in flight or awaiting retry), `synced` (event confirmed), `removed` (event removal confirmed), `disabled` (sync unavailable or not routed), and `failed` (a standing failure). Use `calendar_info` to observe completion; results describe work observed since the daemon loaded the instance. Blocked/pending states include observed `category` and `recovery`, plus authorization or bounded process diagnostics when available.

**Returns:** a confirmation line and the resulting metadata (same shape as a query in `metadata` detail):
```
updated: 2026-05-05-deploy-db

id: 2026-05-05-deploy-db
file: /data/actions/2026/2026-05-05-deploy-db.md
name: Deploy DB
created: 2026-05-05T14:30
description: Migrate production database to new schema
scheduled: 2026-05-15T10:00
resolution: done
projects: [2026-05-02-migration]
```

**Errors:**
```
Error: cannot update action "2026-05-05-deploy-db" — not found.
Hint: use query_actions to verify the ID; create new actions with capture or update_entry.
```

### Utility Tools

#### `validate`

Run all validation checks against the data directory and return every diagnostic without truncation.

**Arguments:** none

**Returns:**
```
PASS  Entry metadata uses inline YAML list syntax
PASS  Created timestamps are ISO 8601 minute precision
FAIL  Referenced projects have files
      - 2025-05-21-website-redesign
PASS  No duplicate entry IDs

21 of 23 checks passed
```

#### `calendar_info`

Calendar state for the agent. For the active instance it reports auth status, available calendars, per-action `calendar_sync` states, `issues` (actions left unsynced: no calendar, a missing/ambiguous/read-only one, or a transient failure awaiting retry), and reverse-sync `changes` applied since the instance loaded (calendar gestures synced back to actions). With no active instance it reports auth status and calendars alone. Instance states, issues, and changes are reported even when the helper is unavailable or an auth request fails. When access is undecided or write-only it requests full access. Denied access directs the user to System Settings; restricted access directs them to an administrator or device policy. An undecided response does not establish why the prompt failed to complete. Authorization-command failures and helper communication failures have distinct categories. Process failures report `category`, `recovery`, the helper/log paths, bounded stderr, and observed command/exit/signal. Unsupported systems and missing source helpers are separate categories; missing-helper recovery includes building, restarting the daemon, and rechecking access. Reverse failures without an action receipt appear in `calendar_diagnostics`. `event-time-unrepresentable` blocks an action in both directions while preserving its record/event: fix the Calendar time or explicitly change scheduled/timezone to an unambiguous start (UTC can express a repeated-hour instant); name, notes, duration-only, unchanged, or still-ambiguous edits do not clear it. Missing or contradictory helper metadata requires repairing the helper. macOS only; never reads or writes events. See `calendar.md` (sync model) and `calendar-impl.md` (mechanics).

**Returns:**
```
auth: fullAccess
calendars: Work (iCloud, writable), Personal (iCloud, read-only)
calendar_sync:
  - id: 2026-05-05-deploy-db
    status: failed
    reason: "calendar not found: Ops"
  - id: 2026-05-06-write-up
    status: disabled
    reason: "no calendar"
issues:
  2026-05-05-deploy-db — calendar not found: Ops
  2026-05-06-write-up — no calendar
changes:
  2026-05-02-review-schema — rescheduled 2026-05-16T09:00 -> 2026-05-17T09:00
```

#### `show`

Show content to the user in the webapp. The daemon uses its shared server (see *Web Server*) and prepares a fresh private handoff file, which the caller opens in the default browser. Opening the file automatically authorizes that browser and redirects to the requested destination; an existing or expired session requires no separate step. See [browser authorization](../design/daemon.md#browser-authorization). GraphQL callers wanting to choose another browser use `showUrl(input:)` with the same target fields and open its returned `file://` URL immediately; it creates the handoff without opening or navigating any browser.

Use it when the user would benefit from seeing content rather than reading tool output — timelines, project hierarchies, artifacts, and raw files.

Arguments mirror the webapp's route grammar (see the webapp spec's *URL state*); all are optional, and none means the plain flow:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project` | string | no | Project ID — filtered flow + summary panel (exclusive with `action`) |
| `action` | string | no | Action ID — filtered flow + summary panel |
| `detail` | boolean | no | Open the project/action's complete record in the document reader |
| `entry` | string | no | Entry ID — scroll the flow to it (alone, or within the project/action filter) |
| `asset` | string | no | Root-relative file path — open in the document reader |
| `artifact` | string | no | Artifact ID — open its Markdown or implicit file content in the reader |
| `filename` | string | no | Exact supporting filename; requires `artifact` |

Artifact and attachment targets open in the existing reader; pass `project` or `action` to keep that timeline scope. `filename` requires `artifact`; `entry`, `asset`, `artifact`, and `detail` are mutually exclusive.

An unknown ID or a combination outside the route grammar is an error with a hint. Raw-file targets must be regular files within the instance and follow the file server's [managed-path policy](../design/instance.md#instance).

**Returns:** the route, the clean bookmark URL, and what happened — `opened browser` or `no browser available — run aside show locally to authorize the browser` (headless sessions):
```
showing: /work/project/2026-05-02-migration/detail
url: http://localhost:24800/work/project/2026-05-02-migration/detail
tab: opened browser
```

## Technology

- **Language:** TypeScript
- **Runtime:** Node.js >= 22.12.0; Node.js 24 LTS recommended (`.nvmrc` selects 24)
- **Package manager:** npm
- **CLI framework:** lightweight arg parsing (no heavy framework — commands are few and stable)
- **MCP:** `@modelcontextprotocol/sdk`
- **Daemon protocol:** JSON-RPC 2.0 over a Unix domain socket

## Distribution

Aside is installed from a local clone: the user clones the repo, runs
`build.sh` at the repo root (CLI bundle, webapp bundle, and — on macOS with a
Swift toolchain — the aside-cal helper), and registers the clone with each
agent using [`aside plugin`](#aside-plugin-installremovestatus). Each agent's MCP server runs
`aside mcp` from `PATH`, through the linked public launcher (`cli/dist/main.js`), which checks the Node version
before importing the self-contained application bundle (`cli/dist/runtime.js`),
and starts the daemon through that same launcher. Regex workers use the sibling `cli/dist/regex-worker.js`; plugin status checks that required artifact too. Build outputs are gitignored,
never committed. A rebuilt bundle replaces a running daemon on its next connection.

The source build checks Node before installing dependencies or building the native
helper. The CLI build also checks before importing esbuild. CLI, MCP, and daemon
launches reject an unsupported version on stderr with the requirement, detected
version, executable path, and instructions to upgrade and retry. Saved agent and
login-job commands may need their Node path updated. The application targets
Node.js 22.12; the dependency-free launcher remains parseable by older Node.
Keep all three generated JavaScript files together when moving a build.

For standalone CLI use, build and link globally from `cli/`:
```
npm run build
npm link
```

Then use anywhere:
```
aside instance init --dir ~/my-aside --name "Personal" --description "Personal records"
aside instance validate --dir ~/my-aside
```

The `bin` field in package.json maps `aside` to the compiled entry point.
