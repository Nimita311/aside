import { CALENDAR_HELPER_TIMEOUT_MS, CALENDAR_HELPER_TERMINATE_TIMEOUT_MS, CALENDAR_HELPER_EXIT_DRAIN_MS } from '../../core/system-config.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { platform, release } from 'node:os';
import { daemonPaths } from '../../daemon/paths.js';
import { diagnoseCalEnvironment, type CalendarDiagnostic } from './diagnostics.js';
import type {
  UpsertSeriesArgs, UpsertOccurrenceArgs, GetSeriesArgs,
  CalRequest,
  CalErrorCode,
  AuthStatusResult,
  RequestAccessResult,
  ListCalendarsResult,
  UpsertEventArgs,
  UpsertEventResult,
  DeleteEventArgs,
  DeleteEventResult,
  ListEventsArgs,
  ListEventsResult,
  GetEventsArgs,
  GetEventsResult,
} from './protocol.js';

// Thrown when the helper can't be reached at all (absent binary, spawn failure,
// or it exited). Distinguished from a helper-reported error so callers can tell
// "calendar sync isn't available here" from "that command failed".
export class CalUnavailable extends Error {
  constructor(message: string, readonly diagnostic?: CalendarDiagnostic) { super(message); }
}

// A helper-reported command failure. `code` is the structured class the helper
// attached to the response (see protocol.ts); absent for uncoded (transient)
// failures.
export class CalError extends Error {
  constructor(message: string, readonly code?: CalErrorCode, readonly diagnostic?: CalendarDiagnostic) {
    super(message);
  }
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

// The bundled helper sits next to the compiled entrypoint (dist/main.js →
// dist/aside-cal). ASIDE_CAL_BIN overrides this for dev and tests.
function bundledBinPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'aside-cal');
}

// Locate a usable helper binary, or null when calendar sync can't run here
// (non-macOS, or the helper hasn't been built). null makes the feature degrade
// to "unavailable" rather than erroring.
export function resolveCalBin(): string | null {
  const candidate = process.env.ASIDE_CAL_BIN || bundledBinPath();
  return diagnoseCalEnvironment(platform(), release(), candidate, existsSync(candidate)) ? null : candidate;
}

// Talks to one long-lived aside-cal process over JSON/stdio. The process is
// spawned lazily on first request and respawned if it dies; it shuts down when
// the daemon exits (stdin close ends its loop). Requests are matched to responses
// by a monotonic id.
export class CalClient {
  private binPath: string | null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private changedListeners = new Set<() => void>();
  private exitListeners = new Set<() => void>();
  private buf = '';
  private seq = 0;
  private stderr = '';
  private unavailable?: CalendarDiagnostic;
  private expectedPath: string;

  // Pass a path (or null) to inject one; omit to auto-resolve the bundled binary.
  constructor(binPath?: string | null) {
    this.expectedPath = binPath || process.env.ASIDE_CAL_BIN || bundledBinPath();
    this.unavailable = binPath === undefined
      ? diagnoseCalEnvironment(platform(), release(), this.expectedPath, existsSync(this.expectedPath))
      : binPath === null ? diagnoseCalEnvironment('darwin', '23', this.expectedPath, false) : undefined;
    this.binPath = binPath === undefined ? (this.unavailable ? null : this.expectedPath) : binPath;
  }

  // Whether a helper binary is present to talk to. calendar_info reports this so
  // the agent can explain that sync is macOS-only / not yet built.
  available(): boolean {
    return this.binPath !== null;
  }

  helperPath(): string { return this.expectedPath; }

  availabilityDiagnostic(): CalendarDiagnostic | undefined {
    return this.available() ? undefined : this.unavailable;
  }

  diagnosticForError(error: unknown, command?: string): CalendarDiagnostic {
    if ((error instanceof CalUnavailable || error instanceof CalError) && error.diagnostic) return { ...error.diagnostic, ...(command ? { command } : {}) };
    const code = error instanceof CalError ? error.code : undefined;
    const recovery = code === 'calendar-not-found' || code === 'calendar-ambiguous' || code === 'calendar-read-only'
      ? 'Call calendar_info and choose a uniquely named writable calendar, or supply calendar_account; rename calendars/accounts when names still collide.'
      : code === 'invalid-scheduling' ? 'Correct the action scheduling fields and run aside instance validate before retrying.'
      : code === 'event-time-unrepresentable' ? 'Sync is blocked in both directions for this action. Fix the Calendar time or explicitly change scheduled/timezone to an unambiguous start, then check calendar_info; name, notes, and duration-only edits do not unblock it.'
      : code === 'event-recurring' ? 'Remove the calendar event recurrence to resume sync.'
      : 'Inspect the helper stderr and daemon log, then call calendar_info again. Pending sync retries remain queued.';
    return this.context({ category: code || (command === 'request-access' ? 'authorization-request-failed' : error instanceof CalError ? 'helper-command-failed' : error instanceof CalUnavailable ? 'helper-communication-failed' : 'operation-failed'), reason: error instanceof Error ? error.message : String(error), recovery, ...(command ? { command } : {}) });
  }

  private context(diagnostic: CalendarDiagnostic): CalendarDiagnostic {
    let log: string | undefined;
    try { log = daemonPaths().log; } catch {}
    return { ...diagnostic, helper_path: this.expectedPath, ...(log ? { log_path: log } : {}), ...(this.stderr ? { stderr: this.stderr } : {}) };
  }

  authStatus(): Promise<AuthStatusResult> {
    return this.request<AuthStatusResult>('auth-status');
  }

  // Surfaces the OS permission prompt. No timeout — the user may take a while to
  // answer the dialog.
  requestAccess(): Promise<RequestAccessResult> {
    return this.request<RequestAccessResult>('request-access', {}, 0);
  }

  listCalendars(): Promise<ListCalendarsResult> {
    return this.request<ListCalendarsResult>('list-calendars');
  }

  upsertEvent(args: UpsertEventArgs): Promise<UpsertEventResult> {
    return this.request<UpsertEventResult>('upsert-event', { ...args });
  }

  upsertSeries(args: UpsertSeriesArgs): Promise<UpsertEventResult> { return this.request('upsert-series', { ...args }); }

  upsertOccurrence(args: UpsertOccurrenceArgs): Promise<UpsertEventResult> { return this.request('upsert-occurrence', { ...args }); }

  deleteSeries(args: DeleteEventArgs): Promise<DeleteEventResult> { return this.request('delete-series', { ...args }); }

  getSeries(args: GetSeriesArgs): Promise<GetEventsResult> { return this.request('get-series', { ...args }); }

  deleteEvent(args: DeleteEventArgs): Promise<DeleteEventResult> {
    return this.request<DeleteEventResult>('delete-event', { ...args });
  }

  listEvents(args: ListEventsArgs): Promise<ListEventsResult> {
    return this.request<ListEventsResult>('list-events', { ...args });
  }

  getEvents(args: GetEventsArgs): Promise<GetEventsResult> {
    return this.request<GetEventsResult>('get-events', { ...args });
  }

  // Subscribe to the helper's async `changed` signal (the calendar store mutated).
  // Returns an unsubscribe function.
  onChanged(cb: () => void): () => void {
    this.changedListeners.add(cb);
    return () => this.changedListeners.delete(cb);
  }

  // Notified whenever the helper process goes away (exit, spawn failure, or
  // close()). CalSync uses this to drop its cached access check — a TCC
  // revocation kills the helper, so its death is the cue to re-verify auth.
  onExit(cb: () => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  // Stop the helper. The next request respawns it. Shut down over the documented
  // path — closing stdin ends the helper's read loop, and the disclaimed child
  // exits with it — rather than a kill(), which would reach only the supervising
  // stub and orphan the child with its pipes still open into our parse buffer.
  close(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.stdin.end();
      } catch {
        proc.kill();
      }
      // Backstop for a wedged helper that never notices the closed stdin.
      const t = setTimeout(() => proc.kill(), CALENDAR_HELPER_TERMINATE_TIMEOUT_MS);
      t.unref?.();
      proc.once('exit', () => clearTimeout(t));
    }
    const err = new CalUnavailable('calendar helper closed');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.buf = '';
    for (const cb of this.exitListeners) cb();
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    if (!this.binPath) throw new CalUnavailable('calendar helper (aside-cal) is not available', this.unavailable);
    this.stderr = '';
    const proc = spawn(this.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdout.setEncoding('utf8');
    // Guarded like the terminal events below: a killed helper's late flush
    // must not corrupt the respawned helper's parse buffer.
    proc.stdout.on('data', (chunk: string) => {
      if (this.proc === proc) this.onData(chunk);
    });
    // Forward the helper's stderr to ours (diagnostics) and, crucially, drain it
    // so a chatty helper can't fill the pipe buffer and block.
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      if (this.proc === proc) this.stderr = (this.stderr + chunk).slice(-4096);
      process.stderr.write(chunk);
    });
    // Only act on a terminal event from the *current* process. A previous
    // helper's late exit (e.g. after close() already respawned) must not reject
    // the new process's requests or null out the live handle.
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const onTerminate = (err: CalUnavailable) => {
      clearTimeout(exitTimer);
      if (this.proc === proc) this.fail(err);
    };
    const exitError = (code: number | null, signal: NodeJS.Signals | null) => new CalUnavailable(`calendar helper exited (${signal ?? code})`, this.context({
      category: 'helper-exited', reason: `calendar helper exited (${signal ?? code})`,
      recovery: 'Inspect helper stderr and the daemon log. A fresh helper will be started on the next retry; call calendar_info to check its state.',
      ...(code !== null ? { exit_code: code } : {}), ...(signal ? { signal } : {}),
    }));
    // A write to a dead helper's stdin emits EPIPE here; route it through fail()
    // rather than letting an unhandled stream error reach the process.
    proc.stdin.on('error', (err) => onTerminate(new CalUnavailable(`calendar helper stdin error: ${err.message}`, this.context({ category: 'helper-communication-failed', reason: err.message, recovery: 'Inspect helper stderr and the daemon log; queued sync will retry with a new helper process.' }))));
    // close follows the stdio drain, retaining the final crash diagnostic. A
    // bounded exit backstop also handles descendants holding inherited pipes.
    proc.on('exit', (code, signal) => {
      exitTimer = setTimeout(() => onTerminate(exitError(code, signal)), CALENDAR_HELPER_EXIT_DRAIN_MS);
      exitTimer.unref?.();
    });
    proc.on('close', (code, signal) => onTerminate(exitError(code, signal)));
    proc.on('error', (err) => onTerminate(new CalUnavailable(`calendar helper failed to start: ${err.message}`, this.context({ category: 'helper-start-failed', reason: err.message, recovery: 'Inspect the helper path, executable permissions, stderr and daemon log. Repair the source build, restart the shared daemon if the helper was replaced, then call calendar_info.' }))));
    this.proc = proc;
    return proc;
  }

  // Parse complete newline-delimited responses and resolve their requests.
  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: unknown; ok?: boolean; result?: unknown; error?: string; code?: string; signal?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore unparseable lines
      }
      if (msg.id === undefined || msg.id === null) {
        // Async push (no id), e.g. the `changed` signal.
        if (msg.signal === 'changed') for (const cb of this.changedListeners) cb();
        continue;
      }
      const key = String(msg.id);
      const p = this.pending.get(key);
      if (!p) continue;
      this.pending.delete(key);
      if (msg.ok) {
        p.resolve(msg.result ?? {});
      } else {
        const error = new CalError(msg.error || 'calendar helper error', msg.code as CalErrorCode | undefined);
        const diagnostic = this.diagnosticForError(error);
        p.reject(new CalError(error.message, error.code, diagnostic));
      }
    }
  }

  // The process died or never started: reject everything in flight and reset so
  // the next request tries a fresh spawn.
  private fail(err: CalUnavailable): void {
    this.proc = null;
    this.buf = '';
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const cb of this.exitListeners) cb();
  }

  private request<T>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = CALENDAR_HELPER_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = this.ensureStarted();
      } catch (e) {
        reject(e as Error);
        return;
      }
      const id = String(++this.seq);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.delete(id)) {
                const diagnostic = this.context({ category: 'helper-timeout', command: cmd, reason: `calendar helper timed out on ${cmd}`, recovery: 'Inspect helper stderr and the daemon log; the command outcome is unknown. Pending sync retries remain queued. Call calendar_info to check recovery.' });
                        reject(new CalUnavailable(diagnostic.reason, diagnostic));
              }
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        resolve: (r) => {
          if (timer) clearTimeout(timer);
          resolve(r as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          const diagnostic = this.diagnosticForError(e, cmd);
            reject(e instanceof CalUnavailable ? new CalUnavailable(e.message, diagnostic)
            : e instanceof CalError ? new CalError(e.message, e.code, diagnostic) : e);
        },
      });
      const req: CalRequest = { id, cmd, ...args };
      try {
        proc.stdin.write(JSON.stringify(req) + '\n');
      } catch (e) {
        if (this.pending.delete(id)) {
          if (timer) clearTimeout(timer);
          reject(new CalUnavailable(`calendar helper write failed: ${(e as Error).message}`, this.diagnosticForError(e, cmd)));
        }
      }
    });
  }
}
