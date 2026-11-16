# CLI surface

Source: [command tree and help definitions](../cli/src/commands/options.ts).

## Common conventions

| Item | Behavior |
| --- | --- |
| Help | `aside --help`, `aside <command> --help`, or `aside help <command> <subcommand>`; bare groups show help. |
| Version | `aside --version`. |
| Arguments | Named options for data/paths; optional positional `show` target. |
| Option syntax | `--option value` or `--option=value`; `--` ends option parsing. |
| Rejected input | Unknown options, extra positionals, duplicate scalar options/flags, missing values, conflicts. |
| Repeated options | Preserve input order. |
| Help effects | Bypasses required/conflict checks; starts no runtime work. |
| Exit status | 0 on success; 1 on errors or failed checks. |
| Human errors / logs | stderr; `NO_COLOR` suppresses terminal color. |
| Human `--json` | One stdout document: `schema_version`, `command`, `ok`, `data`, `checks`, `diagnostics`; partial results retained. |
| GraphQL output | Standard GraphQL JSON; no human-report envelope. |
| MCP output | Stdio MCP transport; no `--json`. |
| Help output | Text, including when `--json` is supplied. |

## Commands

| Command | Options beyond `--json` | Behavior |
| --- | --- | --- |
| `show [target]` | `--dir`, `--source`, `--url`, `--app-dir` | Open a target or the chooser; see [navigation](#navigation) |
| `graphql query` / `graphql mutate` | `--dir`, `--document`, `--document-file`, `--variables`, `--variables-file`, `--operation-name` | Execute through the shared daemon |
| `mcp` | `--dir`; no `--json` | Serve GraphQL tools and resources over stdio |
| `artifact create` | `--dir`, required `--name`/`--description`, `--body`, `--body-file`, repeatable `--file` | Create maintained content and import attachments |
| `artifact update` | `--dir`, required `--id`, `--name`, `--description`, `--body`, `--body-file`, repeatable `--file`/`--remove-file` | Edit content or attachments |
| `artifact query` | `--dir`, repeatable `--id`/`--project`/`--action`, `--from`, `--to`, `--search`, `--detail`, `--offset`, `--limit` | Query artifacts |
| `instance init` | Required `--dir`/`--name`/`--description`, optional `--body`, `--tutorial` | Create files directly, without registration |
| `instance add` | Required repeatable `--dir` | Register a validated batch of existing instances |
| `instance forget` | Required repeatable `--dir`, `--clear-cache` | Remove registrations, preserving records |
| `instance list` | None | List known instances; no daemon startup |
| `instance validate` | `--dir` | Check files directly; defaults to current directory |
| `daemon start` | `--foreground` | Start, replace an older build, or reuse a compatible daemon |
| `daemon install` | None | Install/load the macOS login job and restart under it |
| `daemon uninstall` | None | Remove saved job; leave the running daemon and loaded supervision |
| `daemon status` | None | Inspect daemon, saved job, and known instances; no startup |
| `daemon automations` | None | Inspect deadlines and retained runs; no startup or manual execution |
| `daemon stop` | `-f`, `--force` | Stop when idle; force bypasses busy refusal and shuts down gracefully |
| `diagnostics purge` | Exactly one of `--dir` or `--all` | Remove completed diagnostic history; preserve active work and records |
| `usage summary` | `--dir`, `--since` | Summarize local GraphQL usage offline |
| `plugin install` | Required `--agent`, optional `--force`, `--print` | Install this checkout's plugin |
| `plugin remove` | Required `--agent`, optional `--print` | Remove plugin and unused marketplace registration |
| `plugin status` | None | Inspect CLI/build and both agent registrations |

| Item | Behavior |
| --- | --- |
| Daemon scope | Per-user service; instance paths rejected. |
| Internal host | `daemon run` is callable but hidden from help. |
| General queries | Use GraphQL; no `aside query` command. |

## Navigation

| Item | Behavior |
| --- | --- |
| Target | Quoted record handle or Aside URL; see [URL shapes](urls.md). |
| No target/source | Open the chooser. |
| Handle/source selection | `--dir`, normal workspace selection, or a sole known instance. |
| Aside URL selection | Its registered instance; explicit `--dir` must agree. |
| `--source` | Exact indexed artifact attachment handle. |
| Ordinary `show` | Open the local HTTP URL in the default browser. |
| `--url` | Print HTTP URL without opening a browser. |
| `--url --dir <path>` | Print that instance timeline URL. |
| `--dir` without `--url` | Requires a target or source. |
| `--app-dir` | Webapp checkout containing built assets. |
| Chosen browser | GraphQL `showUrl`; open its returned HTTP URL. |

```sh
aside show
aside show --url --dir ~/aside/work
aside show '#project/2026-10-05-launch' --dir ~/aside/work
aside show --source '#artifact/2026-10-05-review/decisions.json' --dir ~/aside/work
```

## GraphQL and MCP

| Item | Behavior |
| --- | --- |
| Document | Exactly one of `--document` or `--document-file`; `--document-file -` reads stdin. |
| Variables | Inline JSON or file, exclusively. |
| Named operations | Select with `--operation-name`. |
| CLI file paths | Relative to invocation directory. |
| Paths within inputs | [Server-local contract](graphql.md#writes). |
| Operation mode | `query` accepts queries; `mutate` accepts mutations. |
| Preflight | Syntax, static selections, variables, and mode validate before daemon connection. |
| Selection lifetime | One invocation; combine selection and dependent writes in one mutation. |
| Retry | Queries may reconnect/retry; uncertain mutations are never automatically repeated. |
| Workspace | MCP and GraphQL CLI share [discovery](configuration.md#workspace-selection). |
| Without selection | Introspection and global status remain available. |
| MCP surface | `query`, `mutate`, five guides, schema resource; see [discovery](graphql.md#discovery). |

```sh
aside graphql query --document '{ instances { id name path } }'
aside graphql query --dir ~/aside/work --document-file request.graphql --variables-file values.json
cat save.graphql | aside graphql mutate --document-file - --operation-name Save
```

## Artifact operations

| Item | Behavior |
| --- | --- |
| Instance | `--dir` or current directory, which must itself be an instance; no workspace discovery. |
| Body | `--body` and `--body-file` are exclusive. |
| Import | `--file <path>` retains basename; `--file <filename>=<path>` selects destination. |
| Relative sources | Resolve from invocation directory. |
| Removal | Exact attachment filenames. |
| Dates / search | Inclusive `YYYY-MM-DD` bounds; `--search` is regex. |
| `index` detail | Handles and descriptions. |
| `metadata` detail | Fields, associations, attachments, validated saved-copy paths. |
| `full` detail | Metadata plus body. |
| Pagination | Header: `total`, `offset`, `limit`, `next_offset`; continue until `next_offset` is null. |
| Quoted scalars | Ambiguous/control-bearing text is JSON quoted; decode the complete string before reuse. |
| Defaults | [Configuration](configuration.md#behavior-defaults). |

## Instance and daemon receipts

| Item | Behavior |
| --- | --- |
| `init` | Write manifest only; `--tutorial` adds Meet Aside project and starter records. |
| Registration | Use `instance add`; init does not register. |
| Daemon startup | Instance init/add/forget/list/validate never start it. |
| Batch validation | All paths validate before registry changes. |
| Unreachable registry owner | Report failure; do not overwrite its registry. |
| Add/forget JSON | `instances` plus per-path `results`. |
| Forget primary | Also forget registered matching worktrees. |
| `--clear-cache` | Remove semantic cache after active use ends. |
| Default cache retention | [Storage and retention](configuration.md#storage-and-retention). |
| Unreadable/unrecognized manifest | Data checks blocked; `dataChecksRun: false`. |
| Recognized manifest with invalid metadata | Run data checks and report every check. |
| Failed checks | Nonzero exit. |
| Start receipt | `started`, `replaced`, or `reused`; previous PID on replacement. |
| Foreground ownership | Stay running after readiness report. |
| Busy non-forced stop | Fail; schedule no deferred stop. |
| Successful stop | Wait for exit; retain saved login job. |
| Status failure | Preserve available observations and recovery paths. |

## Diagnostics and installation

| Item | Behavior |
| --- | --- |
| Usage period | Positive day duration, e.g. `7d`, up to `36500d`. |
| Usage report | Outcomes, redacted shapes, fields, confirmed writes, latency; no record-content reads or daemon startup. |
| Purge scope/result | Accept previous/deleted instance paths; report removed log/run counts. |
| Agent | `claude` or `codex`; both install `agent/graphql/` and run `aside mcp` from PATH. |
| `--force` | Replace conflicting marketplace location. |
| `--print` | Show commands without running them. |
| Disabled state | Preserve deliberate disabling; report inspection/verification failures. |
| Status coverage | Registration/build files; not live MCP connectivity. |
| Refresh | Refresh edited plugin configuration/skills; runtime rebuilds use the existing checkout. |

Setup: [source installation](../README.md#get-started) · [requirements, paths, environment](configuration.md).
