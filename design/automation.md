# Automation

Automations run a script or an agent prompt at a scheduled time. Definitions are configuration in the top-level `automations` mapping of `aside.md` or a project file. Each key names one automation within that file; there are no separate automation files. Closed projects pause their automations. A prompt can create actions using ordinary Aside tools.

## Declaration

The same declaration applies to projects and instances:

```yaml
automations:
  daily-digest:
    schedule:
      cron: "0 8 * * 1-5"
      timezone: America/Los_Angeles
    run:
      model: CLAUDE_SONNET
      prompt: "#artifact/2026-10-08-digest-instructions"
  organize:
    schedule:
      at: "2026-10-15T09:00:00-07:00"
    run:
      script: ./scripts/organize.sh
      args: [--recent]
```

A schedule specifies exactly one form:

| Form | Fields |
|---|---|
| Cron | `cron`: five fields, minute through weekday; optional IANA `timezone`. Unix day-of-month/weekday OR semantics. |
| RRULE | `rrule`: one rule containing `FREQ`, `dtstart`: wall time `YYYY-MM-DDTHH:mm[:ss]`, optional IANA `timezone`. `UNTIL` uses UTC `YYYYMMDDTHHmmssZ`; cannot combine with `COUNT`. |
| Timestamp | `at`: ISO timestamp with an explicit offset or `Z`. |

Omitted time zones use the machine's current local zone. RRULE keeps subdaily intervals anchored to `DTSTART` before applying `BY` filters, skips nonexistent wall times without consuming `COUNT`, and uses the first instant of repeated wall times. Cron uses cron-parser's DST semantics.

`run` selects either `script` with optional string `args`, or `model` with `prompt`. Model is a built-in selection or a named selection from `.aside`. Built-in names prefix the vendor's reported identifier with `CODEX_` or `CLAUDE_` and normalize it to identifier syntax; execution uses the exact reported identifier. Vendor aliases pass through unchanged. Aside defines no rolling aliases. Script arguments pass directly to the executable, without a shell; the executable resolves like a named model `command`. Prompts are direct primary artifact handles:

```yaml
run:
  model: digest
  prompt: "#artifact/2026-10-08-digest-instructions"
```

The launched prompt points to the artifact; the agent reads its primary content
through Aside. The harness does not resolve or copy artifact contents at launch.
GraphQL authoring validates readable, nonblank primary content before saving a
new reference or inline artifact. Literal prompts, wrapped references, and
attachment-specific handles are invalid declarations.

Optional fields: `enabled` (default true), `timeout` (positive fixed ISO duration, default `PT30M`, maximum 2147483647ms), and `overlap` (`latest` or `skip`, default `latest`). Unknown declaration fields or invalid values disable that declaration and appear in diagnostics; valid siblings continue. Ordinary project edits preserve declarations.

## Authoring interface

GraphQL `Instance.automations` and `Project.automations` return typed declaration pages belonging only to their enclosing owner. `Automation` exposes `name`, typed `schedule` and `run`, effective `enabled`, `timeout`, and `overlap`, plus observed `next`, `running`, and retained `log`. Invalid saved declarations remain inspectable by name with null configuration and source diagnostics. GraphQL complete declarations use `[CreateAutomationInput!]`; updates use `[UpdateAutomationInput!]`. `run.model` is a string validated against the defining instance's `Instance.execution.models` catalog only when newly supplied. Saved selections remain readable when unavailable. `Execution.models(refresh: true)` refreshes discovery; schema discovery and introspection never query vendors and do not depend on the catalog.

GraphQL `run.prompt` accepts `ArtifactLinkInput`: exactly one of `existingId`, the exact Artifact ID without `#artifact/`, or `create`, a complete `CreateArtifactInput`. Inline creation saves an artifact and persists its handle directly in `run.prompt` with the owner; full validation failure saves neither. Confirmed writes remain in partial results if a subsequent disk operation fails. `AutomationRunDefinition.prompt` resolves the Artifact only when selected; model/configuration-only reads do not load artifact records. Missing targets return null with source diagnostics. Invalid saved declarations remain inspectable with null configuration fields; ordinary record edits preserve them for repair. Replace an invalid prompt through `run.prompt` with an `ArtifactLinkInput`; omitted prompt data is never rewritten automatically.

Legacy entity tools expose project declarations through `query_projects` at metadata/full detail and instance declarations through `query_instance`. `update_project` and `update_instance` accept `automations`; new projects in `capture` and `update_entry` also accept it. `query_models` exposes the same model choices.

Legacy instance/project updates accept `automationEdits`; GraphQL updates use `automations: AutomationEditsInput`: `patch` changes only supplied fields on existing jobs, `upsert` creates or replaces complete jobs, and `remove` deletes exact names, harmlessly ignoring absent jobs. GraphQL uses `[UpdateAutomationInput!]` and `[CreateAutomationInput!]`; entity tools use named maps. Patches merge `schedule` and `run` fields, preserve omitted fields, and remove fields explicitly set to `null`. Null `enabled`, `timeout`, or `overlap` restores the default; `schedule` and `run` themselves cannot be null. Switching schedule/execution forms requires explicitly nulling incompatible old fields and supplying the new required fields. Edited jobs must be structurally valid after merging; only newly supplied model choices must be selectable, so an omitted unavailable saved model can be retained while disabling or rescheduling a job. Untouched YAML declarations, comments, and scalar values are preserved, including malformed jobs. Each name is nonblank, unique within a list, and may occur in only one operation. Null or empty edits preserve declarations. A malformed whole YAML map must be repaired before partial editing. Instance updates preserve identity and omitted metadata/body. The automation resource teaches setup and runtime inspection.

Legacy `automations` deliberately replaces all declarations; omit to preserve, or use `null` or an empty map/list to clear. It validates every supplied declaration and schedule. A non-null legacy `automationEdits` input is exclusive with any supplied whole-map replacement. GraphQL uses `automations.set` for complete replacement, exclusive with `patch`, `upsert`, and `remove`; `set: []` clears declarations.

Automation defined on an action is called [delegation](delegation.md) and accepts
prompts only. Its deadlines come from action schedules and recurrence rules. It
shares execution settings and the `Automation`, `AutomationRun`,
`AutomationRunPage`, and `AutomationRunWhere` GraphQL types.

## Execution settings

Each launch begins at the instance root and reads `.aside` there if present. `execution.cwd` can point elsewhere, resolved relative to that root. Instance, project, and action automations use this same rule. `.aside` execution settings need no separate registration or watcher.

```yaml
execution:
  cwd: ..
  models:
    digest:
      model: CLAUDE_SONNET
    external:
      command: my-agent
      args: [run, --non-interactive]
```

Named models specify exactly one built-in `model`, or `command` with optional string `args`. Alias chaining is unsupported. Names use GraphQL identifier syntax and reserve `CODEX_`, `CLAUDE_`, `__`, `true`, `false`, and `null`. Custom CLIs receive the wrapped prompt through stdin followed by EOF, with only the declared arguments. Executable paths containing `/` resolve against the execution cwd; bare commands use PATH, considering only absolute entries. Existing authentication and configuration apply. Each execution starts a fresh session.

Built-in Codex uses `-a never exec --sandbox workspace-write --skip-git-repo-check --json -`; Claude uses `-p --output-format stream-json --verbose --permission-mode auto`. Both add `--model` with the vendor identifier. Use a custom CLI definition when different launch arguments are needed.

Discovery uses Codex's app-server model catalog and Claude's SDK model catalog without sending an inference prompt. It runs on demand, is cached by execution context, and has no polling timer. Missing CLIs exclude their choices; failed discovery retains the last successful choices with unknown availability. Named models appear when their executable or built-in target is available. Discovery and exact built-in bindings live in daemon state, outside records; a scheduled launch uses recorded bindings without contacting a vendor to resolve its selection.

Claude discovery keeps the execution cwd, environment, and user, project, and local settings so model restrictions and provider configuration apply. It disables settings/plugin hooks and automatic MCP connections for the discovery session. Credential helpers and administrator-enforced hooks can still run. Managed MCP policy can refuse discovery; the same failed-discovery behavior applies.

Ingesting enabled built-in agent declarations also warms this metadata cache, independently of deadlines. A first execution scheduled before discovery finishes can fail for a missing binding; it is neither delayed nor retried. Script and custom CLI declarations require no vendor discovery. Refresh model discovery after changing execution settings if a newly selected built-in identity has not been recorded.

The harness supplies only execution context, the owning instance ID, an optional
`Project` handle, the automation name, and a pointer to the user's instruction
artifact. Instance automation omits the project line. Automation context is “This is an Aside automation execution. The user scheduled this work
to run automatically. Follow the user's instructions autonomously.” The agent
discovers other record metadata through Aside.

## Scheduling and lifetime

The daemon watches declarations through its existing instance stores and receives its own project edits immediately. A dedicated worker computes one future occurrence per automation and keeps a min heap with one deadline timer. Unchanged declarations retain their cached deadline; edits replace pending deadlines. There is no scheduling polling or idle timer. Long waits are capped at Node's timer limit and rearmed.

On macOS a separate native helper supplies sleep, wake, clock, and time-zone notifications. Sleep disarms deadlines; wake and clock changes recompute from now. Notifications and the timer provide best-effort dispatch accuracy; agent startup latency is separate. Automation does not wake a sleeping computer. The CLI build supplies the helper independently of the calendar helper.

Past occurrences are missed. Startup, wake, reload after absence, and daemon replacement consider only future times, including for one-time timestamps. There is no catch-up, retry, or resumption of an execution. History describes observed runs; a previous process's unfinished run is `unobserved`.

Overlap permits one active execution per automation. `latest` retains only the latest occurrence observed while that execution runs, then launches one follow-up when it finishes. `skip` drops overlapping occurrences. Pending follow-ups exist only in memory and are discarded on edits, disabling, deletion, sleep, clock changes, and daemon shutdown. Already running work finishes after edits, closing the project, or unloading its instance; shutdown cancels it. Different automations can run concurrently.

On POSIX systems, cancellation and timeouts send `SIGTERM` to the execution's process group, allow up to two seconds for graceful exit, then send `SIGKILL` to remaining group members. Run completion and shutdown await this teardown even when the launcher exits and descendants redirect their output. Windows termination applies to the launched process.

A claim is saved before dispatch or queueing, preventing duplicate dispatch of an already observed occurrence after clock rollback. Claims are keyed by canonical instance path, defining entity, and automation name. Linked Git worktrees and conflicted or unverifiable instance identities pause execution under the same ownership rules as calendar sync. Resolving the blocker arms future occurrences only.

## Inspection

`aside daemon automations` inspects the running daemon without starting it; `--json` includes definitions' deadlines, active/queued state, errors, and up to 200 recent observed runs. Human output shows ten recent runs and their log directories. It never invokes work manually.

GraphQL observes each declaration through `Automation.next` and `running`; unavailable observations return null and scheduling issues appear in shared response diagnostics. `Automation.log` scopes history to its owner and name. `Project.automationLog` contains only that project's retained runs; `Instance.automationLog` contains only instance-owned runs. Each owner retains histories of removed declarations. Pages use `nodes`, `offset`, `count`, and `totalCount`, with filters applied before pagination and ordering by newest `started`, then ID. `AutomationRunWhere.status` is a list; omission matches any status and `[]` matches none. Inspection neither starts a worker nor dispatches work manually; retained disk history remains accessible when live inspection fails, and old unfinished runs become `UNOBSERVED`.

`AutomationRun.name` records the launch name; `automation` resolves the current declaration within the same owner, or null after removal. Its `prompt` is the actual launched text, containing execution context, the owning instance, an optional project, the automation name, and the prompt artifact handle. Its `filePath` locates retained `run.json`, while `stdoutLog` and `stderrLog` locate output. `AutomationRun.output(stream, offset, limit)` returns `text`, `offset`, `nextOffset`, and `totalBytes`; continue while `nextOffset < totalBytes`. A missing or pruned run returns null, a missing stream is empty, and active output can grow between reads. Shared byte-paging constraints are documented in the GraphQL schema.

Runtime data lives under the daemon state directory's `automation/`, separate from Aside records. Each run saves its definition, occurrence, dispatch lateness, resolved cwd and model, launched prompt, process arguments, observed exit status, stdout, and stderr. Status reflects the process outcome, without inferring whether the user's task was completed. Output is capped at 10 MiB per stream, prompts at 1 MiB. History retention and explicit purge follow the [daemon diagnostic policy](daemon.md#diagnostic-retention); the automation worker protects active runs and pending delegation completion while applying that policy.
