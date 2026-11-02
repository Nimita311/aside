# Automation setup

Aside automations execute a script or an agent prompt. Store a named `automations`
map on an existing project or the instance. No separate record is needed. An
action's calendar time does not execute work; an automation prompt can create
actions through ordinary Aside tools.

Before replacing declarations, read them with `query_projects` (metadata detail)
or `query_instance`.

For agent work, first discover available models with `query_models`.

Use the returned `name` as `run.model`. Built-in `CODEX_*` and `CLAUDE_*`
selections use the vendor's exact model identifier or native alias. Named models
from the instance root's `.aside` share this selector. `query_models` with
`refresh: true` refreshes discovery without sending an inference prompt. Failed discovery can
retain last-known choices with `UNKNOWN` availability. Do not invent selectors
or reinterpret a vendor alias.

For example, update a project with a model name returned by discovery:

```json
{
  "id": "2026-10-08-notes",
  "automations": {
    "daily-digest": {
      "schedule": {"cron": "0 8 * * 1-5", "timezone": "America/Los_Angeles"},
      "run": {"model": "CLAUDE_SONNET", "prompt": "Summarize this project's recent notes."}
    }
  }
}
```

Write with `update_project` or `update_instance`. Writes replace **all declarations**:
preserve other jobs. Omission preserves them; `null` or an empty map
clears them. Inputs validate before writes. Saved malformed
or unavailable selections remain readable for repair. New projects in `capture`
or `update_entry` can include automations; project creation still requires the
user's request and entry context. Automation setup authorizes its configuration,
not unrelated work.

Each definition selects exactly one schedule and one execution:

- Cron: `{"cron":"0 8 * * *","timezone":"America/Los_Angeles"}`. Five fields.
- RRULE: `{"rrule":"FREQ=WEEKLY;BYDAY=MO","dtstart":"2026-10-12T09:00","timezone":"America/Los_Angeles"}`.
  Start is a wall time. `UNTIL` is UTC and cannot coexist with `COUNT`.
- Once: `{"at":"2026-10-15T09:00:00-07:00"}`. Offset or `Z` is required.
- Agent: `{"model":"CLAUDE_SONNET","prompt":"#artifact/2026-10-08-instructions"}`.
  Prompt must be a direct primary artifact handle: the artifact body or its
  single text attachment supplies instructions. Literal text, wrapped references,
  and attachment-specific handles are rejected. Select a discovered name.
- Script: `{"script":"./scripts/organize.sh","args":["--recent"]}`. Arguments
  are optional and pass directly without a shell.

Optional fields are `enabled` (default true), `timeout` (positive fixed ISO
duration, default `PT30M`), and `overlap` (`latest`, default, or `skip`).
`latest` coalesces observed
overlapping times to one follow-up; `skip` drops them. Time zones are optional
and default to the machine's local zone. Use the user's specified zone; clarify
timing only when it affects the requested schedule.

Built-in selections require no `.aside`. For requested named model setup, edit
the instance root's `.aside`, preserving unrelated settings:

```yaml
execution:
  models:
    digest:
      model: CLAUDE_SONNET
    external:
      command: my-agent
      args: [run, --non-interactive]
```

A named definition selects exactly one built-in `model`, or `command` with
optional `args`. Names start with a letter or underscore and contain only letters, digits, or underscores; `CODEX_`, `CLAUDE_`, `__`, and
enum keywords are reserved. Custom CLIs receive the prompt on stdin followed by
EOF and only declared arguments. Built-in adapters start fresh unattended
Codex or Claude sessions using installed authentication and settings. Working
directory starts at the instance root; optional `execution.cwd` redirects it
relative to that root. `.aside` and artifact prompts resolve again at launch.

The harness identifies an Aside automation execution, where it is defined, its
schedule and occurrence, and autonomous execution. Put only the user's requested
instructions in the prompt; do not add reporting or completion requirements.

Verify the saved declarations and write receipts. `aside daemon automations --json` inspects the running
daemon's deadlines, errors, active work, and recent run/log locations without
starting the daemon or executing work. Persistence alone does not confirm the
daemon is watching. Explain concrete inspection errors; do not run the task
manually to verify setup.

Only occurrences observed while watching execute. Past times are missed,
including on startup and wake; there is no retry, catch-up, or session resumption.
Automation does not wake a sleeping computer. Closed projects pause their jobs.
Set `enabled: false` to pause one job. Removing or disabling it drops queued
work and lets its current execution finish.
