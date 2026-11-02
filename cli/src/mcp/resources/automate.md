# Automate work

Automations run scripts or agents on a schedule. Their declarations belong to
a project or the instance.

## Define the job

| Task | Schema |
| --- | --- |
| Read this project's / instance's declarations | `Project.automations`, `Instance.automations` → `AutomationPage` |
| Edit named project jobs | `Mutation.updateProject`, `UpdateProjectInput.automations` |
| Edit named instance jobs | `Mutation.updateInstance`, `UpdateInstanceInput.automations` |
| Replace all declarations deliberately | `UpdateProjectInput.automations.set`, `UpdateInstanceInput.automations.set` |
| Job options and timing | `CreateAutomationInput`, `UpdateAutomationInput`, `AutomationScheduleInput`, `AutomationSchedulePatchInput` |
| Script or agent execution | `AutomationRunDefinition`, `AutomationRunInput`, `AutomationRunPatchInput` |
| Agent instructions | `ArtifactLinkInput`, `AutomationRunDefinition.prompt` → `Artifact`, `Artifact.content`; see [Records](aside://docs/records) |
| Jobs on a new project | `CreateProjectInput.automations` |

- Use `automations.patch` to change only selected fields on an existing named job. Omitted fields are preserved, including an unavailable saved model; only explicitly supplied model choices must be selectable. Schedule and run fields merge recursively. Null removes optional fields and restores defaults; schedule/run themselves cannot be null, and the resulting job must remain valid. When switching execution or schedule forms, explicitly null incompatible old fields and supply the new required fields.
- Use `automations.upsert` to create or replace a named job's complete definition, or `automations.remove` to remove named jobs. Each name may appear in only one operation. Unrelated declarations are preserved without validation, including malformed jobs.
- Use `automations.set` for deliberate complete replacement, validating every supplied job; `set: []` clears all jobs. It is exclusive with `patch`, `upsert`, and `remove`.
- When asked to set up a job, save its configuration without performing the scheduled task.
- Model jobs require `run.prompt: {existingId: "artifact-id"}` or `run.prompt: {create: {...}}`, using `ArtifactLinkInput`. Supply the exact Artifact ID without `#artifact/`, or a complete `CreateArtifactInput`. Inline creation saves an artifact and persists its handle directly in `run.prompt`. The agent reads the artifact's primary `content` through Aside; the harness passes its handle without copying content. The declaration's `prompt` returns the resolved `Artifact`; missing targets return null with diagnostics. Script jobs do not need a prompt.
- Frontmatter and legacy inputs use a direct primary artifact handle in `run.prompt`, such as `"#artifact/2026-10-10-review-instructions"`. Literal text, wrapped `{artifact: ...}` references, and attachment-specific handles are invalid declarations. They remain saved for repair, with null configuration and diagnostics on reads. Replace the prompt by linking or creating a primary instruction artifact; omitted prompt data is preserved.
- The harness supplies execution context, the owning instance ID, a Project or Action handle where applicable, the automation name for instance/project jobs, and a pointer to the prompt artifact for the agent to read. Write only the user's requested instructions into the prompt artifact; do not invent reporting or completion requirements.

```graphql
mutation {
  updateInstance(input: {automations: {
    upsert: [{name: "daily-check", schedule: {cron: "0 9 * * *"},
      run: {script: "./daily-check.sh"}}]
    remove: ["old-check"]
  }}) { instance { automations { nodes { name enabled } } } error }
}
```

Disable an existing job without reading or resubmitting its definition:

```graphql
mutation {
  updateInstance(input: {automations: {
    patch: [{name: "daily-check", enabled: false}]
  }}) { instance { automations { nodes { name enabled } } } error }
}
```

Use a discovered model and an existing instruction artifact:

```graphql
mutation($model: String!) {
  updateInstance(input: {automations: {
    upsert: [{name: "daily-review", schedule: {cron: "0 9 * * *"},
      run: {model: $model, prompt: {existingId: "2026-10-10-review-instructions"}}}]
  }}) { instance { automations { nodes { name run { prompt { id name } } } } } error }
}
```

Or create the instruction artifact with the job:

```graphql
mutation($model: String!) {
  updateInstance(input: {automations: {
    upsert: [{name: "daily-review", schedule: {cron: "0 9 * * *"},
      run: {model: $model, prompt: {create: {
        name: "Review instructions", description: "Instructions for daily review",
        body: "Review open actions and update their progress."
      }}}}]
  }}) { instance { automations { nodes { name run { prompt { id } } } } } error }
}
```

## Choose a model

- Discover with `Instance.execution.models`; use `ModelOption.name` exactly as the string `run.model` and inspect `ModelOption.availability`. Newly supplied choices are validated against the defining instance's catalog; saved selections remain readable when unavailable. Do not reinterpret vendor aliases.
- Built-in choices need no `.aside` and start fresh unattended sessions using installed authentication and settings.

### Custom execution

For requested custom execution, edit the known instance-root `.aside`, preserving
unrelated settings:

```yaml
execution:
  models:
    review_agent:
      command: my-agent
      args: [run, --non-interactive]
```

- Custom model names use GraphQL identifier syntax; `CODEX_`, `CLAUDE_`, `__`, `true`, `false`, and `null` are reserved.
- A built-in alias uses `model: <discovered built-in name>` instead of `command`/`args`; alias chains are unsupported.
- Custom CLIs receive prompts on stdin followed by EOF and only declared arguments, without a shell.
- Working directory defaults to the instance root; `execution.cwd` redirects it relative to that root. `.aside` resolves again at launch. Read `Instance.execution.cwd` and the expected config `filePath`; refresh `Instance.execution.models(refresh: true)` after setup.

## Inspect execution

- Only future occurrences observed while the daemon watches run: no catch-up, retry, resumption, or waking sleeping computers.
- Closing projects pauses jobs. Disabling/removing jobs drops queued work while active work finishes. Default Git worktree policy, identity conflicts, or unverifiable identities can pause execution; the primary checkout's `.aside` controls `worktreeDetection`.
- `Automation` exposes its declaration fields plus observed `next`, `running`, and retained execution `log`. Defaults are `enabled: true`, `timeout: "PT30M"`, and `overlap: LATEST`. Invalid saved declarations have null configuration fields and source diagnostics. `next`/`running` are null when observations are unavailable; an observed idle job has `running: false`. Inspect response diagnostics for scheduling restrictions and model warnings.
- `Instance.automations` contains only instance-owned declarations; `Project.automations` contains only that project's declarations. Use `Automation.log` for one named job, `Project.automationLog` for that project's retained runs, and `Instance.automationLog` for instance-owned runs. Each history stays within its owner and includes retained runs of removed declarations. History contains retained executions rather than every execution ever made. `UNOBSERVED` means a previous daemon left a run unfinished; success reports process exit, not proof that the user's requested task was completed.
- Declaration and history pages use `offset`/`limit` and the collection rules in the server instructions. History filters apply before pagination and order newest `started` first, then ID. `AutomationRunWhere.status` accepts a list: omitted means any status; `[]` matches none. `AutomationRun.name` records the launch name; `automation` resolves its current declaration in the same owner, or null after removal. `AutomationRun.prompt` contains the actual launched wrapper: context, owning instance, optional Project/Action handle, automation name for instance/project jobs, and prompt artifact pointer. Artifact contents are read by the agent and are not copied into this field.
- Use `AutomationRun.output` with `STDOUT` or `STDERR`. Continue from `nextOffset` while `nextOffset < totalBytes`. Output offsets count bytes; active logs may grow. An absent or pruned run returns null; a missing stream is empty. `filePath`, `stdoutLog`, and `stderrLog` locate retained run metadata and output. Inspect errors rather than treating unreadable output as empty.
- Inspection does not execute work manually. Use [Setup](aside://docs/setup) for service startup, login, and registration maintenance; `aside daemon status --json` inspects daemon loading and watching. `aside daemon automations --json` remains a machine-wide CLI inspection route.

```graphql
query {
  activeInstance {
    automations {
      nodes { name enabled next running log(limit: 1) { nodes { id status error } } }
    }
    automationLog(where: {status: [FAILED, TIMED_OUT]}, limit: 20) {
      totalCount nodes { id name status started finished error }
      offset count
    }
  }
}
```

## Delegate action work

Actions support one `delegation` with `run: {model, prompt}` and optional `timeout`.
Use `DelegationInput` on action creation, `updateAction`, or `updateOccurrence`;
GraphQL prompts link or create an instruction artifact. Omit an update to preserve,
replace the full declaration to change it, or use null to clear.

Delegation runs at the action's scheduled time. Templates supply it to every
unsaved occurrence, independent of query lookahead. Saved occurrences retain their
own declaration and current timing. Done/cancelled work never dispatches
from scheduling or lifecycle edits. Date-only work starts at local midnight.

Use `runDelegation(id)` through mutate only when immediate execution is requested.
It bypasses timing and returns an `AutomationRun` directly, with `action`
resolving the saved or projected owner, without editing the action. Its first
edit materializes a projection.
A template requires an occurrence ID; concurrent launches for one occurrence are
rejected. A successful exit marks the action done, including after edits,
cancellation, or clearing delegation during the run. Failed or cancelled processes
leave lifecycle unchanged. No separate review status applies.

Read `Action.delegation {next running log}` or `Action.delegationLog` for retained
history, including after clearing a declaration. Templates aggregate occurrence
runs; instance/project automation logs exclude them. `AutomationRun.output` pages
bounded UTF-8 output. `completionError` explains a successful run whose action
could not be completed because it no longer exists or a completion write failed.
Inspect saved effects before retrying an uncertain dispatch; there is no automatic retry.
Dispatch failures emit GraphQL errors. `AutomationRun.error` remains retained
execution failure data. Delegation uses the same `Automation`, `AutomationRun`,
`AutomationRunPage`, and `AutomationRunWhere` types as instance/project automation,
named `delegation`: timestamps, lateness,
model, launched prompt, command/args, PID, exit code/signal, metadata and log paths,
and bounded output paging. `AutomationRun.automation` resolves the current
declaration, which may differ from its launch configuration.
