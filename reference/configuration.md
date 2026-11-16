# Configuration and defaults

Sources: [parser](../cli/src/core/parser.ts) · [instance registry](../cli/src/mcp/instance-registry.ts) · [execution configuration](../cli/src/core/automation.ts).

## Workspace selection

| Item | Behavior |
| --- | --- |
| File | Launching directory’s `.aside`; plain YAML, no global `.aside`. |
| Read time | Session startup; restart after changing selection settings. |
| Paths | Relative to defining file; leading `~` expands to home. |

| Key | Default | Meaning |
| --- | --- | --- |
| `pointers` | None | Instance directory paths included in this workspace |
| `default` | None | Startup instance path; need not be a pointer |
| `discovery` | `true` | Scan the working directory and immediate children for `aside.md` |
| `worktreeDetection` | `true` | Worktree ownership policy; read from the primary repository root's `.aside` |
| `execution` | See below | Execution context read from the instance-root `.aside` |

| Item | Behavior |
| --- | --- |
| Selection order | Explicit `--dir` → configured default → working-directory instance with discovery enabled → sole workspace candidate. |
| No winning candidate | No active selection. |
| Deduplication | Canonical paths; aliases count once. |
| Explicit selection | Discovery still collects candidates. |
| Later selection | Changes the session, not the saved default. |
| Config failure | Report diagnostics; remaining valid discovery inputs still apply. |

```yaml
default: ~/aside/work
pointers:
  - ~/aside/work
  - ~/aside/personal
discovery: true
```

## Instance settings

Location: manifest [`config`](frontmatter.md#instance-manifest). Read effective values through `Instance.settings`; patch with `updateInstance`.

| Key | Default | Meaning |
| --- | --- | --- |
| `scheduledEventTitlePrefix` | `"▢ "` | Prefix before active event titles |
| `doneEventTitlePrefix` | `"✓ "` | Prefix before completed event titles |
| `webapp.sidebar` | No custom sections | Ordered sections and shortcuts |

| Item | Behavior |
| --- | --- |
| Title-prefix clearing | Empty string removes prefix; GraphQL null restores default. |
| Sidebar sections | Ordered list of `{title?, items}`. |
| Sidebar item | Optional `label`; exactly one of `timeline` or `entity`. |
| Timeline target | Native smart target, literal search, Aside timeline URL, or exact query attachment handle. |
| Entity target | Record/content page. |
| Built-ins | Entries and Overview exist independently of sidebar declarations. |
| Sidebar update | Omit to preserve; `[]` clears; supplied list replaces after validation. |
| Pin/unpin | Updates the same persisted declaration. |

```yaml
config:
  webapp:
    sidebar:
      - title: Focus
        items:
          - label: Decisions
            timeline: "#artifact/2026-10-12-decisions/query.json"
          - label: Project brief
            entity: "#project/2026-10-12-aurora"
```

## Execution settings

| Item | Behavior |
| --- | --- |
| Source / owners | Instance-root `.aside`; applies to instance, project, and action jobs. |
| `execution.cwd` | Instance root by default; relative values resolve there. |
| `execution.models` | Named built-in selections or custom commands. |
| Published context | Lifecycle supplies context to discovery and launches. |
| Malformed context | Diagnose failure; do not silently change working directory. |

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

| Item | Behavior |
| --- | --- |
| Named selection | Exactly one built-in `model`, or `command` with optional string `args`; no alias chaining. |
| Names | GraphQL identifier syntax; reserve `CODEX_`, `CLAUDE_`, `__`, `true`, `false`, `null`. |
| Built-ins | Vendor-discovered identifiers, prefixed/normalized; no fixed Aside aliases. |
| Catalog | `Instance.execution.models`; `refresh: true` rechecks after provider/context changes. |
| Command containing `/` | Resolve from execution cwd. |
| Bare command | Search absolute PATH entries. |
| Custom CLI input | Prompt on stdin then EOF; only declared arguments; no shell. |
| Built-in session | Fresh session with existing authentication/provider settings. |

| Engine | Launch arguments |
| --- | --- |
| Codex | `-a never exec --sandbox workspace-write --skip-git-repo-check --json --model <vendor-id> -` |
| Claude | `-p --output-format stream-json --verbose --permission-mode auto --model <vendor-id>` |

| Item | Behavior |
| --- | --- |
| Discovery | Cached; no inference. Schema reads never discover vendors. |
| Failed discovery | May retain last-known choices with unknown availability. |
| Scheduled built-in launch | Uses recorded binding; missing binding fails without delay/retry. |
| Script jobs | No model discovery required. |

## Environment and platform

| Setting | Default / behavior |
| --- | --- |
| Runtime | Node.js 22.12+; `.nvmrc` selects Node.js 24 |
| Native services | macOS 14+; source build needs Xcode Command Line Tools |
| Browser origin | `http://localhost:24800`, bound to `127.0.0.1`; a collision fails |
| `ASIDE_DAEMON_HOME` | Platform paths below; override relocates state, logs, and saved job beneath one directory |
| `ASIDE_EMBEDDING_URL` | `http://127.0.0.1:11434`; HTTP(S), no embedded credentials |
| `ASIDE_EMBEDDING_MODEL` | `qwen3-embedding:0.6b`; nonempty, at most 256 characters |
| `ASIDE_NATIVE_BIN` | Bundled `cli/dist/aside-native` shared executable |
| `ASIDE_CAL_BIN`, `ASIDE_GEO_BIN` | Optional per-service standalone helpers; override the shared helper for that service |
| `CODEX_HOME` | `~/.codex` for plugin inspection/registration |
| `CLAUDE_CONFIG_DIR` | `~/.claude` for plugin inspection/registration |
| `NO_COLOR` | Unset; presence disables CLI terminal color |

| Item | Behavior |
| --- | --- |
| Relative daemon home | Resolve from launching client; propagate absolute path. |
| Changed daemon environment | Restart daemon. |
| Login job | One per user, including relocated state. |
| Native resolution order | Per-service injection → per-service environment → injected shared binary → shared environment → bundled binary. |

Semantic setup: Ollama 0.40+ and an explicitly installed embedding model.

```sh
ollama pull qwen3-embedding:0.6b
```

| Item | Behavior |
| --- | --- |
| Service/model installation | Explicit user setup; Aside neither starts Ollama nor downloads models. |
| Native semantic platform | Apple Silicon on macOS; other features and regex remain available on Intel Macs. |
| Qwen context | 8,192 tokens; no truncation. |

## Behavior defaults

| Setting | Default / bounds |
| --- | --- |
| Collection pages | Offset 0, limit 20; limit 1–100 |
| Artifact CLI detail | `index` |
| Record ordering | `CREATED_DESC` |
| Search ranking | Creation order descending unless a ranking is supplied |
| Projection upper bound | One calendar year after today or a later positive lower bound; saved rows are unaffected |
| Timed Calendar event duration | 30 elapsed minutes |
| Calendar routing | None without an action destination; no calendar is created |
| Automation enabled / overlap | `true` / `latest` |
| Automation/delegation timeout | `PT30M`, maximum 2,147,483,647 ms |
| Delegation overlap | `skip` |
| Omitted execution/schedule zone | Local machine zone |
| Usage summary period | `7d`, maximum `36500d` |
| Automation output paging | 16,384 bytes; request 1–65,536, allowing UTF-8 completion |

## Query limits

Sources: [GraphQL executor](../cli/src/graphql/schema.ts) · [budgets](../cli/src/graphql/execution-budget.ts) · [webpage policy](../cli/src/web/query.ts) · [constants](../cli/src/core/system-config.ts).

| Limit | MCP / GraphQL CLI | Webpage queries |
| --- | --- | --- |
| Document | 64,000 characters, 5,000 tokens | Full request 64 KiB |
| Variables | 256,000 serialized characters; 24 levels, 5,000 nodes | Within request limit |
| Selection depth / expanded fields | 16 / 2,000 | 8 / 200 |
| Root fields | 100 query / 20 mutation | 10 query; one operation |
| Filter depth / evaluations | 12 / 100,000 per read view | Shared filter budget |
| Executed fields | 100,000 | 10,000 estimated and executed |
| Leaf text / serialized response | 8 MiB / 8 MiB | 1 MiB / 1 MiB |
| Concurrency / rate | Shared runtime budgets | 4 active per instance, 8 global; 60 per instance/minute |
| Deadline | Cooperative cancellation; regex limits below | 10 seconds; iframe SDK 12 seconds |

| Item | Behavior |
| --- | --- |
| Iframe pending queries | 4 per frame; 8 per parent page. |
| Budget failure | Explicit failure; never empty success. |
| Timer cancellation | Cooperative; cannot forcibly preempt synchronous JavaScript. |

## Runtime defaults

Source: [system-config.ts](../cli/src/core/system-config.ts). Fixed operational defaults, not `.aside` settings.

| Area | Defaults |
| --- | --- |
| Daemon startup / shutdown / handshake | 10 s / 25 s / 5 s |
| Request drain / command lock | 10 s / 30 s |
| Regex workers / waiting queue | 2 / 8 |
| Regex pattern / execution / queue wait | 256 characters / 2 s / 5 s |
| Regex snapshots | 100,000 records, 16 MiB/request, 64 MiB pooled UTF-8 |
| Calendar debounce / retry | 2 s reconcile debounce/retry; 30 s sync retry |
| Calendar lock / shutdown flush / helper | 15 s / 10 s / 30 s |
| Geocoding helper / queue | 30 s / 16 waiting |
| Model discovery | 15 s, 1 MiB output, 500 choices |
| Automation prompt / output | 1 MiB prompt; 10 MiB per output stream |
| Automation teardown | SIGTERM then up to 2 s before SIGKILL on POSIX |
| Source refresh / attachment poll | 100 ms debounce / 500 ms |
| Browser checks | 60 s while visible plus focus checks; every tenth timed check full (every thirtieth without validators) |
| File-change notifications | 200 ms coalescing, 30 s SSE heartbeat |

## Storage and retention

| Platform | Default location |
| --- | --- |
| macOS state | `~/Library/Application Support/sh.117.aside/` |
| macOS logs | `~/Library/Logs/sh.117.aside/` |
| macOS login job | `~/Library/LaunchAgents/sh.117.aside.daemon.plist` |
| Other state | `$XDG_STATE_HOME/sh.117.aside/`; fallback `~/.local/state/sh.117.aside/` |
| Other logs | State directory's `logs/` |

| Item | Behavior |
| --- | --- |
| State contents | Registrations, socket/locks, execution claims/history, recurrence history/mirrors. |
| Logs | `daemon.log` and per-instance GraphQL usage collections. |
| Usage privacy | Redacted shapes and confirmed effects; no request values or response content. |
| Instance log identity | Canonical path hashes separate instances/worktrees. |
| Socket path | Maximum 103 bytes. |
| Diagnostic age | 30 days. |
| Usage capacity | 100 MiB per instance. |
| Automation history | Latest 50 completed runs per job. |
| Cleanup triggers | Startup, daily, relevant writes. |
| Protected state | Active runs, pending completion, dispatch claims. |
| Explicit cleanup | `diagnostics purge` clears completed history. |
| Semantic caches | Expire after 30 days unregistered, on lazy check. |
| Forget with `--clear-cache` | Persist removal request; wait for active use to finish. |

## Browser preferences

Storage: browser origin, shared across instances; not manifest settings. Source: [preferences.ts](../webapp/src/preferences.ts).

| Preference | Default / choices |
| --- | --- |
| Appearance | System; explicit light/dark choice persists |
| Date style | Medium; Short/Medium/Long/Full/ISO |
| Time style | Short; Short/Medium/Long/Full |
| Clock | Locale default; explicit 12/24-hour |
| Week starts on | Monday; weekday 0–6 |
| Animation speed | Normal (1); Off (0), Fast (0.5), Slow (2) |
| Expand project/action tags | Both false |
| `/` search shortcut | Enabled |

| Item | Behavior |
| --- | --- |
| Locale/calendar | Browser locale; Gregorian calendar. |
| Resolved instants | Display in browser timezone. |
| Floating clocks / dates | Retain authored calendar fields. |
| Formatting changes | Preserve IDs, handles, prose, focus, and reading state. |
