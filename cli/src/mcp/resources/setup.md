# Set up and configure an instance

## Select or create

| Task | Schema |
| --- | --- |
| Discover workspace and known instances | `Query.instances` |
| Select an existing instance | `Mutation.selectInstance` |
| Create an instance | `Mutation.createInstance`, `CreateInstanceInput` |
| Read selected identity, effective settings, instructions, and validation | `Query.activeInstance`; null when no valid selection |
| Distinguish session selection from discovery membership | `Instance.active`, `Instance.workspace` |
| Change instructions, Calendar title prefixes, automation declarations, or recurrence lookahead | `Mutation.updateInstance`, `UpdateInstanceInput` |

- Prefer one instance unless lasting separation is wanted.
- Offer the tutorial to new users.
- When creating an instance inside a Git repository, keep its data tracked unless the user opts out; explain this choice.

`Query.activeInstance` reads the selected instance without choosing another.
Metadata-only instance reads do not load records or start job scheduling.
Inspect response diagnostics alongside its settings, instructions, and validation.

Instructions can be supplied at creation via `CreateInstanceInput.body` and
replaced afterward via `UpdateInstanceInput.body`. Omit `body` to preserve them;
an empty string clears them, while null is rejected. Include only instructions
the user actually stated. Read the saved text through `Instance.body`.

Set `UpdateInstanceInput.settings.scheduledEventTitlePrefix` or
`UpdateInstanceInput.settings.doneEventTitlePrefix` to change Calendar event titles.
Omit a prefix to preserve it, use an empty string for no prefix, or use null to
restore the default (`▢ ` for scheduled actions and `✓ ` for completed actions).
Read effective values, including defaults, through `Instance.settings`.
`InstanceSettingsInput` patches selected settings; omitted fields are preserved,
and the schema describes each field's clearing rules. Changing an effective prefix queues Calendar
sync for the instance's scheduled actions and recurrence templates. The mutation
error reports known sync issues; saving the setting does not confirm that
Calendar has finished updating the titles.

## Configure startup discovery

Startup discovery is configured outside GraphQL. For requested local setup, edit
`.aside` in the MCP launch working directory, preserving unrelated settings.
This file is not searched for in ancestor directories, and selecting an instance
does not move its scope to that instance.

```yaml
pointers: [./aside]
default: ./aside
discovery: false
```

- Paths resolve relative to this `.aside` file.
- Restart MCP after changing these settings.

Other `.aside` settings have different scopes: automation execution reads
`execution` from the owning instance root, resolving `execution.cwd` there.
Git worktree policy reads `worktreeDetection` from the primary checkout root.
It defaults to true; false restores independent-instance behavior, while
duplicate-ID checks remain active. Local `.aside` configuration edits do not
authorize direct record or manifest edits.

## Shared daemon and registrations

The daemon watches known instances after clients disconnect. These maintenance
commands are outside GraphQL and do not replace MCP record operations:

| Task | CLI route |
| --- | --- |
| Inspect service, login job, and known/loaded instances | `aside daemon status --json` |
| Start or reuse the service | `aside daemon start` |
| Start at login on macOS | `aside daemon install` |
| Stop the shared service | `aside daemon stop` |
| Remove startup at future logins | `aside daemon uninstall` |
| Register an existing instance | `aside instance add --dir <path>` |
| List registrations without starting the service | `aside instance list --json` |
| Forget a registration while preserving its files | `aside instance forget --dir <path>` |

Service commands apply to the shared per-user daemon, with no instance path.
MCP selection or creation also registers an instance; registration alone does
not select it for this session. Forgetting removes the registration immediately.
An instance in use stays loaded until remaining clients and browser tabs release
it; later activation can register it again.

Stopping refuses while agent clients or browser tabs are connected. An explicit
`aside daemon stop --force` disconnects them and stops the shared service.
Uninstall removes the saved login job without stopping the daemon or unloading
an already loaded login job; that job can remain until logout.
