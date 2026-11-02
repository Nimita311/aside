# Daemon

One background process per user owns what agent sessions share: each instance's loaded records, calendar sync, [automations](automation.md), and the web server. MCP servers and CLI commands are its clients.

## Roles

| Process | Owns |
|---|---|
| **Daemon** | Per-instance record cache and file watching, every record write, [calendar sync](calendar.md), [automation scheduling and execution](automation.md), the web server and its browser tabs. |
| **Client** | Its session's [workspace](instance.md#workspace) — discovery and the active instance — plus its interface: the tools or commands it offers and how it takes their input. |

A client names the instance on every request; the daemon holds no session state beyond which instances each connection has used.

Every agent session runs its own MCP server over stdio, and that server is a client. CLI commands that read or write records are clients too; `instance init` and `instance validate` work on files directly and need no daemon.

## Guarantees

On the [supported release platform](#constraints):

- **Serialized writes.** All record writes for an instance pass through one process in order, so concurrent sessions cannot overwrite each other's changes.
- **One cache.** A write by one session is immediately visible to the others.
- **One calendar syncer.** Exactly one process reads and mutates the calendar.
- **One browser origin.** The daemon serves every registered instance at `http://localhost:24800`; each view carries its stable instance ID in its path, and tabs stay live across agent sessions.

Direct file edits remain valid: the daemon watches each loaded instance and reloads what changed.

The daemon owns each instance's portable [data core](record-model.md), shared by MCP and the webpage. HTTP supplies parsed snapshots, derived relationships and diagnostics; browser tabs keep a presentation cache. Raw file endpoints supply supporting text and media.

## Lifecycle

Once started, the daemon stays running until explicitly stopped or shut down for replacement. It watches and syncs every known instance, even with no clients or browser tabs connected. `aside daemon start` starts or reuses it; `aside daemon install` also starts it at login.

`instance list` and offline daemon status garbage-collect the saved registry
before returning valid instances. Direct cleanup uses the startup and lifetime locks and re-reads under
the locks, so it cannot overwrite a concurrently starting daemon or another CLI
edit. If a daemon owns the registry but is unreachable, filter the displayed
saved list and report unavailability without modifying its files.

### Instances

- **Known.** The daemon remembers every instance named by a client or registered through the browser, across restarts. Registrations and loaded stores use canonical directory paths: an alias is accepted but its later removal or retargeting cannot redirect the registered instance. Before returning an instance list or after a failed instance operation, garbage-collect verified non-instances from the saved registry, cached stores, and connection references. Public listings include only paths that currently pass `isAsideDir`; a removed, repurposed, or unreadable directory is never advertised as an instance. Manifest read failures retain internal registration metadata and its [identity blocker](instance.md#identity-conflicts) until repair or explicit forgetting. Recheck validity even when a store is already cached, before permitting another operation. Each client keeps independent selection and workspace auto-selection rules.
- **Loaded.** Every known instance loads at startup or registration and stays cached, watched, and synced. A failed load is reported in status and does not remove a valid registration. A forgotten instance unloads after its last client or browser tab disconnects; verified non-instances unload immediately.

### Commands

| Command | Effect |
|---|---|
| `aside daemon start [--foreground]` | Start or reuse the shared daemon. |
| `aside daemon install` | Install the login job and restart the daemon under it. |
| `aside daemon uninstall` | Remove the saved job for future logins, leaving the running daemon and any loaded launchd job as they are. |
| `aside instance add --dir <path> [--dir <path>]…` | Add instances to the known list. |
| `aside instance forget --dir <path> [--dir <path>]…` | Remove instances from the known list, preserving their files. |
| `aside instance list` | List all known instances without starting the daemon. |
| `aside daemon status` | Whether it is running, version, connections, the login job, and known and loaded instances. |
| `aside daemon stop [-f\|--force]` | Exit when no other clients or tabs are connected; force a graceful shutdown when in use. |

`start`, `install`, `status`, `stop`, and `uninstall` apply to the shared per-user service and accept
no instance paths. Without `--force`, a busy `stop` returns nonzero with client and tab counts,
instance context when available, and instructions to use `aside daemon stop --force`;
it leaves the daemon running and schedules no deferred stop.
`-f`/`--force` bypasses the busy refusal through the fixed-core shutdown request,
draining requests and flushing calendar work before disconnecting clients and tabs.
Success is reported only after the daemon has exited. The saved login job is retained, so a
new client or the next login can restart the daemon for all known instances.

When the socket does not answer but the lifetime lock is held, `instance list`
and `daemon status` report the daemon as unreachable and label its catalogue as
the saved list. These inspections and `daemon stop` fail nonzero with the log
path and retry instructions; none assumes the daemon has exited. A stale unlocked file
does not prevent a truthful not-running result.

`instance add` and `instance forget` edit the running daemon's catalogue through its socket. When
no daemon answers, they take the start lock and check again. Direct file edits
also require the lifetime lock, so an unreachable or starting daemon's catalogue
is left untouched with a retry instruction. Validate each complete path batch
before changing the catalogue or loading additions. An invalid path leaves the
whole batch unapplied; valid additions are recorded together before loading
them, so identity checks see the complete catalogue.
Both commands report a result for each canonical requested path, distinguishing
changed registrations from paths already registered or already absent. JSON
receipts include `results` (`path`, `registered`, and `changed`) alongside the
remaining `instances`; ID clashes appear in listings and daemon status, while
individual manifest and data diagnostics belong to `instance validate`.
When connected to an older daemon that supplies no change receipt, `changed` is
omitted and the result confirms the requested registration state.

`start` [connects](#connecting) like any client, including [replacing an older build](#replacing-an-older-daemon), and reuses an equal or newer running build. It reports whether it started, replaced, or reused the daemon, including the previous PID on replacement. When `start` has to launch the daemon, it detaches it and returns once it answers; with `--foreground` the command is the daemon, for a supervisor, and reports once ready.

### Login job

Aside owns the launchd job that starts the daemon at login; the user never writes one. It runs `aside daemon start --foreground` and launchd restarts it after a crash but not after a clean exit.

- **One launcher.** While the job is installed, a client that finds no daemon starts it through launchd.
- **Kept current.** The job records the build and install location that wrote it. A client from a newer build rewrites the job to its own before [replacing the daemon](#replacing-an-older-daemon).

`uninstall` removes only the saved plist for future logins. It does not stop the
running daemon or unload launchd's copy; loaded supervision can restart the daemon
after a crash until logout. To stop the current shared daemon, close other agent
sessions and webapp tabs, then run `aside daemon stop`, or use `aside daemon stop --force`.

### Files

Default locations, readable only by the user:

| Platform | Location | Holds |
|---|---|---|
| macOS | `~/Library/Application Support/sh.117.aside/` | Socket, start lock, lifetime lock, known-instances list, automation claims and run logs, accepted recurrence history and Calendar mirrors, browser session hashes and deadlines, and temporary handoffs. |
| macOS | `~/Library/Logs/sh.117.aside/` | Daemon log and `graphql/` usage collections linked to each instance. |
| macOS | `~/Library/LaunchAgents/sh.117.aside.daemon.plist` | Login job, when installed. Its service label is the plist basename without `.plist`. |
| Other platforms | `$XDG_STATE_HOME/sh.117.aside/` | The same state files, with logs in the `logs/` subdirectory and no login job. `XDG_STATE_HOME` defaults to `~/.local/state`. |

`ASIDE_DAEMON_HOME` relocates state, logs, and the saved job file beneath one
directory. Relative values resolve against the launching client's working
directory; foreground daemons, detached children, and login jobs retain the
absolute location, including recovery diagnostics. The per-user launchd service
remains shared across relocations: `install` still replaces the shared login job.

### Diagnostic retention

Daemon-managed diagnostic history expires after 30 days. GraphQL usage collections
also have a 100 MiB limit per instance; automation history also keeps at most the
latest fifty completed runs per job. Automation age uses completion time, or start
time for an unobserved run without a completion timestamp.

Cleanup runs at startup and every 24 hours while the daemon runs, across all
collections, including inactive or deleted instances and removed jobs. Writes also
apply their collection's limits. Empty usage collections lose their instance-path
association metadata. Automation cleanup removes empty run and job directories,
while preserving scheduling claims needed to prevent duplicate execution. Active
runs, including delegation completion callbacks, are retained. Expiry while the
daemon is stopped is enforced on its next startup.

`aside diagnostics purge --dir <path>` deletes one instance's retained usage logs
and completed automation history; `--all` selects all instances. Exactly one scope
is required. A previous or deleted instance path is accepted. The command never
starts a daemon or schedules work: it uses the live daemon, or holds its start and
lifetime locks during offline deletion. Instance records and scheduling claims
are preserved. Deletion stays within managed diagnostic collections and leaves
unrecognized files and symlinks untouched.

## Connecting

A client never starts a daemon before looking for one:

1. **Locate.** Connect to the daemon's socket.
2. **Handshake.** Exchange software version and build identity; builds are ordered by build time.
3. **Start.** Only when nothing answers: take the start lock, look again, then launch the daemon — through the login job when installed, otherwise detached from the client's host — and connect.

On macOS, the start lock makes simultaneous clients converge on one daemon. A daemon also holds the lifetime lock from start to exit, and a new one refuses to start while it is held. The kernel releases it the moment the holder dies, so two daemons never serve the same user, and a socket left behind with no listener is replaced by the next daemon to take the lock.

### Replacing an older daemon

A client whose build is newer than the daemon's replaces it, under the start lock:

1. **Ask it to shut down.** The daemon acknowledges shutdown, cancels automation executions and pending regex searches, settles in-flight requests, flushes pending calendar work, and exits.
2. **Start the client's build and reload all known instances.** Other clients reconnect to the new daemon.

A daemon that does not exit in time stays in service, exactly as when the client's build is the older one. Either way MCP and instance operations require matching software versions; a mismatch is reported so the session or daemon can be restarted. An older client never replaces a newer daemon, so two builds cannot keep displacing each other.

## Protocol

[JSON-RPC 2.0](https://www.jsonrpc.org/specification) over a Unix domain stream socket: UTF-8 JSON, one message per line — the protocol and framing MCP uses over stdio.

The client and daemon use the same CLI and share the repository's software version, updated at release. They compare that version directly; build time distinguishes development builds and drives daemon replacement.

- **Requests** carry the instance path and the operation's arguments. Errors are JSON-RPC error objects with a machine-readable code.
- **Notifications** flow both ways without a reply, e.g. the daemon announcing that it is shutting down.
- **A fixed core.** The handshake and the shutdown request keep their shape across releases, so any client can identify and replace any daemon.
- **Paths are absolute.** The client resolves draft and import paths against its own working directory before sending them.
- **Frames are bounded.** A line longer than the configured limit closes the connection; its pending requests fail as disconnected.

Filesystem permissions on the socket are the authentication. The daemon listens on no network port for this protocol; the web server's localhost port serves browsers only.

## Concurrent queries

Socket requests are dispatched concurrently. The daemon keeps each instance’s cache, record mutations, and calendar syncer authoritative; record writes remain ordered per instance. Regex queries capture their searchable text and requested output fields in one consistent snapshot before yielding. A bounded worker pool executes case-insensitive native JavaScript regex matching without blocking other clients, the browser server, or calendar work.

Each search has a two-second execution deadline. Timeout terminates and replaces the worker and reports an error, never partial results or a false empty result. Worker count, queue capacity/wait, snapshot budgets, shutdown timings, and retries live in [system configuration](../cli/src/core/system-config.ts). Disconnect cancels that client’s pending searches; shutdown rejects new searches, settles queued/running work, and terminates workers. Workers ship beside the dependency-free CLI runtime.

## Failure

- **Daemon unreachable mid-session.** The client [connects](#connecting) again. Reads are retried transparently.
- **Connection lost during a write.** The outcome is unknown. The client reports that, and the agent checks the record before repeating the write.
- **Daemon cannot start.** The client reports the blocker; it never falls back to writing files itself.

## Constraints

- **Release platforms.** The first release is supported and tested on macOS. CLI and MCP remain runnable on other platforms. Their PID-file locks can admit two daemons during simultaneous recovery from a stale owner; replacing this fallback with kernel locking is deferred.
- **One machine.** A daemon assumes it is the only one serving its instances. Two machines sharing one instance is unsupported: each daemon would act on the same calendar.
- **Sandboxed shells.** A CLI command run by an agent inside a sandbox may be unable to reach the socket. Agents use MCP, whose server runs outside the sandbox; daemon-backed CLI commands are for people.
- **Remote sessions.** A session in a cloud container starts its own daemon there. It shares nothing with the user's machine and has no calendar.

## Browser

The daemon starts its shared HTTP listener when the webapp bundle is available. The chooser at `/` lists all registered instances with their canonical paths, including unloaded ones, after browser authorization. Only paths passing the instance check appear; unreadable manifests stay hidden until they can be verified again. See [browser catalogue management](instance.md#workspace) for adding and removing registrations. Duplicate stable IDs display all conflicting paths and cannot select an arbitrary directory.

Instance views use `/<id>/…`; global APIs and assets use `/-/…` (see the [CLI Web Server specification](../cli/spec.md#web-server)). Every file, media URL, cache, change stream, and tab control is scoped to its instance. Browser tab and MCP session selections are independent; the daemon syncs all known instances. CLI and MCP/GraphQL `show` prepare fresh authorization and open the requested view in the default browser. GraphQL `showUrl` prepares the same handoff and returns its file URL for the caller to open in a chosen browser, without opening or navigating any tab. CLI `show --url` validates the target and prints its clean web URL without preparing authorization or opening a browser, then disconnects.


### Browser authorization

Processes running as the current Unix user are trusted and use the private daemon
socket. HTTP clients prove authorization with a random
256-bit bearer token. The public shell and assets reveal no instance data.
Every API, file read, conditional response and event stream requires an active
session. POST bodies are authorized again before their actions begin. There is no
account, password, pairing step, or per-instance approval.

Every CLI or MCP/GraphQL `show` and GraphQL `showUrl` call creates a private
HTML handoff file before returning, even when a browser is already connected.
`show` opens that file in the default browser; `showUrl` returns its `file://` URL
for immediate opening in another browser or profile on the same machine that can
read local files. The file automatically posts a one-use code to the daemon,
which completes authorization in that browser's origin and replaces the location
with the requested clean view URL. Redemption renews the browser profile's valid
session for 30 days, preserving its token, file grants, and other open tabs;
missing or expired sessions receive a new token in browser local storage. No
session is created for an unopened handoff, and no separate authentication step
is needed. The handoff expires after two minutes and
is removed after redemption or expiry; request a fresh URL for each opening.
Its URL is not a bookmark or a remote web URL. The general browser token and
handoff code never appear in printed URLs, browser URLs or process arguments.
CLI `show --url` prints only a clean bookmark URL and never creates or renews
authorization.

Ordinary requests and browsing never extend the deadline. At its local deadline,
the browser hides private content and rechecks the server before discarding the
shared token, so a missed authorization handoff cannot sign out other tabs. Expiry closes streams,
rejects all private reads, and clears the UI's data and iframe access while keeping
its route. The UI says: “To reconnect, run aside show or ask your agent to show this
in Aside.” A new handoff restores existing tabs automatically. Session hashes and
deadlines persist in private daemon state across restarts; directories are mode
0700 and files mode 0600, owned by the current user.

The canonical origin is `http://localhost:24800`, bound only to `127.0.0.1`.
Bearer authentication, strict Host/origin checks, browser origin isolation, and
the application shell's Content Security Policy (scripts only from the daemon's
own assets) protect the real daemon from unauthorized local clients, hostile
websites, and record content that escapes sanitization.
HTTP does not authenticate the server: a malicious local account can occupy the
port while Aside is stopped and steal a visiting browser's stored token. This
impersonation risk is accepted; browser access does not provide the private Unix
socket's full isolation between OS accounts. A port collision fails explicitly.

Native media and sandboxed documents use signed read-only URLs scoped to one file
or an HTML document's resource folder. The signing key is bound to the active
session and canonical instance path; it never reaches authored documents. Grants
expire with their session and survive daemon restarts. [Managed instance paths](instance.md#instance)
reject symlinks. Exact-file grants for other media allow symlink targets inside the
instance; HTML resource grants also keep resolved targets inside the granted folder.
Authenticated fetches carry the general token only to
the exact origin.
