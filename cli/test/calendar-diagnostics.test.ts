import { eventTimes, savedEvent } from './calendar-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { parse } from 'yaml';
import { CalClient, CalError, CalUnavailable } from '../src/mcp/calendar/client.js';
import { diagnoseCalEnvironment } from '../src/mcp/calendar/diagnostics.js';
import { handleCalendarInfo } from '../src/mcp/calendar/info.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { buildMarker } from '../src/mcp/calendar/markers.js';
import { CalSync, storeAction, type SyncAction } from '../src/mcp/calendar/sync.js';
import type { CalAuthStatus } from '../src/mcp/calendar/protocol.js';
import { CALENDAR_HELPER_EXIT_DRAIN_MS } from '../src/core/system-config.js';
const dirs: string[] = [], clients: CalClient[] = [], syncers: CalSync[] = [];
afterEach(() => { for (const s of syncers.splice(0)) s.dispose(); for (const c of clients.splice(0)) c.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
function mocked(status: CalAuthStatus) {
  const cal = new CalClient(null); clients.push(cal); vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({ status });
  const request = vi.spyOn(cal, 'requestAccess').mockResolvedValue({ granted: true, status: 'fullAccess' });
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] });
  vi.spyOn(cal, 'listEvents').mockResolvedValue({ events: [] });
  const get = vi.spyOn(cal, 'getEvents').mockResolvedValue({ events: [] });
  const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {
    get.mockResolvedValue({ events: [savedEvent(args)] });
    return { eventId: 'event' };
  });
  return { cal, request, upsert };
}
function fake(code: string) {
  const dir = mkdtempSync('/tmp/aside-cal-diagnostic-'); dirs.push(dir); const path = join(dir, 'fake.cjs');
  writeFileSync(path, '#!/usr/bin/env node\n' + code); chmodSync(path, 0o755);
  const cal = new CalClient(path); clients.push(cal); vi.spyOn(process.stderr, 'write').mockReturnValue(true); return { cal, path };
}
const action: SyncAction = { id: 'deploy', frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work' }, body: '' };

describe('calendar diagnostics and source recovery', () => {
  it('separates non-macOS, older macOS, missing helper, and a supported helper', () => {
    expect(diagnoseCalEnvironment('linux', '6.8', '/fake', false)?.category).toBe('platform-unsupported');
    expect(diagnoseCalEnvironment('darwin', '22.6', '/fake', true)?.reason).toContain('older');
    expect(diagnoseCalEnvironment('darwin', '23.0', '/fake', false)).toMatchObject({ category: 'helper-missing', helper_path: '/fake' });
    expect(diagnoseCalEnvironment('darwin', '23.0', '/fake', true)).toBeUndefined();
  });
  it('reports source build, cached daemon detection, and regrant guidance for a missing helper', async () => {
    const parsed = parse(await handleCalendarInfo(new CalClient(null)));
    expect(parsed.category).toBe('helper-missing'); expect(parsed.helper_path).toBeTruthy();
    expect(parsed.recovery).toContain('cli/native/build.sh'); expect(parsed.recovery).toContain('restart the shared daemon'); expect(parsed.recovery).toContain('new calendar grant');
  });
  it.each(['notDetermined', 'writeOnly'] as const)('requests full access from %s and resumes reporting calendars', async status => {
    const f = mocked(status), parsed = parse(await handleCalendarInfo(f.cal));
    expect(f.request).toHaveBeenCalledOnce(); expect(parsed.auth).toBe('fullAccess'); expect(parsed.calendars).toContain('Work');
  });
  it.each(['denied', 'restricted'] as const)('does not re-prompt %s and reports distinct recovery', async status => {
    const f = mocked(status), parsed = parse(await handleCalendarInfo(f.cal));
    expect(f.request).not.toHaveBeenCalled(); expect(parsed.category).toBe(`authorization-${status}`);
    expect(parsed.recovery).toContain(status === 'denied' ? 'System Settings' : 'administrator');
  });
  it('keeps an undecided response factual without guessing that a GUI is absent', async () => {
    const f = mocked('notDetermined'); f.request.mockResolvedValue({ granted: false, status: 'notDetermined' });
    const parsed = parse(await handleCalendarInfo(f.cal)); expect(parsed.category).toBe('authorization-notDetermined');
    expect(parsed.recovery).toContain('cause is unknown'); expect(parsed.reason).not.toContain('session');
  });
  it('distinguishes a responding helper authorization failure from communication failure', async () => {
    const f = mocked('writeOnly'); f.request.mockRejectedValue(new CalError('EventKit refused the request', 'authorization-request-failed'));
    const parsed = parse(await handleCalendarInfo(f.cal)); expect(parsed.auth).toBe('writeOnly'); expect(parsed.category).toBe('authorization-request-failed'); expect(parsed.reason).toContain('EventKit');
    expect(parsed.reason).not.toContain('reach'); expect(parsed.helper_path).toBeTruthy(); expect(parsed.log_path).toBeTruthy();
    f.request.mockRejectedValue(new CalUnavailable('process died', { category: 'helper-exited', reason: 'process died', recovery: 'Retry' }));
    expect(parse(await handleCalendarInfo(f.cal)).category).toBe('helper-exited');
  });
  it('retains bounded stderr, helper path, log path, and exit code after a crash', async () => {
    const f = fake(`require('readline').createInterface({input:process.stdin}).on('line',()=>{ process.stderr.write('old-prefix'+ 'x'.repeat(8000)+' final-native-cause\\n',()=>process.exit(7)); });`);
    const error = await f.cal.authStatus().catch(e => e as CalUnavailable);
    expect(error).toBeInstanceOf(CalUnavailable); const d = f.cal.diagnosticForError(error);
    expect(d).toMatchObject({ category: 'helper-exited', helper_path: f.path, exit_code: 7 });
    expect(d.log_path).toBeTruthy(); expect(d.stderr?.length).toBeLessThanOrEqual(4096); expect(d.stderr).toContain('final-native-cause'); expect(d.stderr).not.toContain('old-prefix');
  });
  it('observes process exit even when a descendant keeps the stdio pipes open', async () => {
    const dir = mkdtempSync('/tmp/aside-cal-descendant-'); dirs.push(dir);
    const pidFile = join(dir, 'pid');
    const f = fake(`require('readline').createInterface({input:process.stdin}).once('line',()=>{
      const child = require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000);process.send("ready")'],{stdio:['ignore','inherit','inherit','ipc']});
      require('fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
      child.once('message',()=>process.stderr.write('supervisor-exited\\n',()=>process.exit(11)));
    });`);
    let error: unknown, pipesClosed = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    void f.cal.authStatus().catch(value => { error = value; });
    const proc = (f.cal as unknown as { proc: ChildProcessWithoutNullStreams }).proc;
    proc.once('close', () => { pipesClosed = true; });
    try {
      const signal = AbortSignal.timeout(5000);
      await Promise.all([once(proc, 'exit', { signal }), once(proc.stderr, 'data', { signal })]);
      // The descendant holds the pipes until cleanup; only the exit backstop can settle this request.
      await vi.advanceTimersByTimeAsync(CALENDAR_HELPER_EXIT_DRAIN_MS);
      expect(pipesClosed).toBe(false);
      expect(error).toBeInstanceOf(CalUnavailable);
      expect(f.cal.diagnosticForError(error)).toMatchObject({ category: 'helper-exited', exit_code: 11, stderr: expect.stringContaining('supervisor-exited') });
    } finally {
      vi.useRealTimers();
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      f.cal.close();
      if (!pipesClosed) await once(proc, 'close', { signal: AbortSignal.timeout(5000) });
    }
  }, 15_000);
  it('reports spawn errors with a helper path and no guessed permission cause', async () => {
    const dir = mkdtempSync('/tmp/aside-cal-spawn-'); dirs.push(dir); const path = join(dir, 'absent'); const cal = new CalClient(path); clients.push(cal);
    const error = await cal.authStatus().catch(e => e as CalUnavailable), d = cal.diagnosticForError(error);
    expect(d.category).toBe('helper-start-failed'); expect(d.helper_path).toBe(path); expect(d.reason).toContain('ENOENT'); expect(d.reason).not.toContain('TCC');
  });
  it('reports timeouts with command and stderr while preserving unknown command outcome', async () => {
    // The stub announces itself as soon as it starts, and the timeout leaves
    // room for a slow process launch under a loaded test run.
    const f = fake(`process.stderr.write('waiting-for-native-service\\n');require('readline').createInterface({input:process.stdin}).on('line',()=>{});`);
    const request = f.cal as unknown as { request(cmd: string, args: object, timeout: number): Promise<unknown> };
    const error = await request.request('list-calendars', {}, 1500).catch(e => e as CalUnavailable), d = f.cal.diagnosticForError(error);
    expect(d.category).toBe('helper-timeout'); expect(d.command).toBe('list-calendars'); expect(d.stderr).toContain('waiting-for-native-service'); expect(d.recovery).toContain('outcome is unknown');
  });
  it('exposes observed authorization and recovery while retaining retries, then clears them on success', async () => {
    const f = mocked('denied'); const sync = new CalSync(f.cal, 'work'); syncers.push(sync);
    await sync.syncActions([action], [action]); expect(sync.status(action.id)).toMatchObject({ status: 'pending', retry: true, diagnostic: { category: 'authorization-denied', auth: 'denied' } });
    const parsed = parse(await handleCalendarInfo(f.cal, sync)); expect(parsed.calendar_sync[0].category).toBe('authorization-denied'); expect(parsed.calendar_sync[0].recovery).toContain('System Settings');
    vi.mocked(f.cal.authStatus).mockResolvedValue({ status: 'fullAccess' }); await sync.syncActions([], [action]);
    expect(sync.status(action.id)).toMatchObject({ status: 'synced', eventId: 'event' }); expect(sync.status(action.id)?.diagnostic).toBeUndefined(); expect(sync.report()).toEqual([]);
  });
  it('updates the observed blocker on a retry-only batch without dropping the queue', async () => {
    const f = mocked('denied'), sync = new CalSync(f.cal, 'work'); syncers.push(sync);
    await sync.syncActions([action], [action]);
    vi.mocked(f.cal.authStatus).mockRejectedValue(new CalUnavailable('native service exited', { category: 'helper-exited', reason: 'native service exited', recovery: 'Retry', stderr: 'last-native-line' }));
    await sync.syncActions([], [action]);
    expect(sync.status(action.id)).toMatchObject({ status: 'pending', retry: true, diagnostic: { category: 'helper-exited', stderr: 'last-native-line' } });
    vi.mocked(f.cal.authStatus).mockResolvedValue({ status: 'fullAccess' }); await sync.syncActions([], [action]);
    expect(sync.status(action.id)?.status).toBe('synced'); expect(sync.report()).toEqual([]);
  });
  it('preserves reverse failure diagnostics after the helper metadata call recovers', async () => {
    const dir = mkdtempSync('/tmp/aside-cal-reverse-diagnostic-'); dirs.push(dir); writeFileSync(join(dir, 'aside.md'), '---\nid: work\n---\n');
    const store = new Store(dir); handleCapture(store, { content: 'Deploy', description: 'Deploy', actions: [{ name: 'Deploy', description: 'Deploy', scheduled: '2026-05-15T10:00', calendar: 'Work' }] });
    const f = mocked('fullAccess'), sync = new CalSync(f.cal, 'work', store); syncers.push(sync);
    vi.mocked(f.cal.listCalendars).mockRejectedValueOnce(new CalUnavailable('crash', { category: 'helper-exited', reason: 'crash', recovery: 'Retry', stderr: 'reverse-native-error', exit_code: 8 }));
    const actions = store.getActionIds().map(id => ({ id, ...store.getAction(id)! }));
    await sync.reconcile(actions); const parsed = parse(await handleCalendarInfo(f.cal, sync));
    expect(parsed.auth).toBe('fullAccess'); expect(parsed.calendar_diagnostics[0]).toMatchObject({ scope: 'reverse sync', category: 'helper-exited', stderr: 'reverse-native-error', exit_code: 8 });
    await sync.reconcile(actions); expect(sync.failureDiagnostics()).toEqual([]);
  });
  it('retains duplicate-pruning diagnostics after the primary event sync succeeds', async () => {
    const f = mocked('fullAccess'); const ev = eventTimes({ id: 'primary', url: buildMarker('work', action.id, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' });
    vi.mocked(f.cal.listEvents).mockResolvedValue({ events: [ev, { ...ev, id: 'duplicate' }] });
    vi.spyOn(f.cal, 'deleteEvent').mockRejectedValue(new CalUnavailable('duplicate removal crashed', { category: 'helper-exited', reason: 'duplicate removal crashed', recovery: 'Retry', stderr: 'duplicate-native-proof', helper_path: '/fake', exit_code: 7 }));
    const sync = new CalSync(f.cal, 'work'); syncers.push(sync); await sync.syncActions([action], [action]);
    expect(f.upsert).toHaveBeenCalledOnce();
    const parsed = parse(await handleCalendarInfo(f.cal, sync));
    expect(parsed.calendar_sync[0]).toMatchObject({ status: 'failed', category: 'helper-exited', stderr: 'duplicate-native-proof', exit_code: 7 });
    expect(sync.failureDiagnostics()[0].diagnostic.stderr).toBe('duplicate-native-proof');
    expect(JSON.stringify(parsed)).not.toContain('calendar_diagnostics'); // represented once in its action receipt
  });
  it('retains diagnostics when an event is relocated before a failed reverse update', async () => {
    const dir = mkdtempSync('/tmp/aside-cal-miss-diagnostic-'); dirs.push(dir); writeFileSync(join(dir, 'aside.md'), '---\nid: work\n---\n');
    const store = new Store(dir); const capture = handleCapture(store, { content: 'Deploy', description: 'Deploy', actions: [{ name: 'Deploy', description: 'Deploy', scheduled: '2026-05-15T10:00', calendar: 'Work' }] });
    const id = capture.createdActionIds[0], a = storeAction(store, id)!, f = mocked('fullAccess');
    const ev = eventTimes({ id: 'primary', url: buildMarker('work', id, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' });
    vi.mocked(f.cal.listEvents).mockResolvedValue({ events: [ev] });
    const sync = new CalSync(f.cal, 'work', store); syncers.push(sync); await sync.syncActions([a], [a]);
    vi.mocked(f.cal.getEvents).mockResolvedValue({ events: [] });
    vi.mocked(f.cal.listEvents).mockResolvedValue({ events: [{ ...ev, id: 'relocated', title: 'Wrong title' }] });
    f.upsert.mockRejectedValue(new CalUnavailable('relocated update crashed', { category: 'helper-exited', reason: 'relocated update crashed', recovery: 'Retry', stderr: 'relocated-native-proof', exit_code: 9 }));
    await sync.reconcile([a]); const parsed = parse(await handleCalendarInfo(f.cal, sync));
    expect(parsed.calendar_sync[0]).toMatchObject({ category: 'helper-exited', stderr: 'relocated-native-proof', exit_code: 9 });
  });
  it('retains helper failure diagnostics in queued sync after calendar_info recovers', async () => {
    const f = mocked('fullAccess'); f.upsert.mockRejectedValue(new CalUnavailable('crashed', { category: 'helper-exited', reason: 'crashed', recovery: 'Retry', helper_path: '/fake', stderr: 'native-crash-line', exit_code: 9 }));
    const sync = new CalSync(f.cal, 'work'); syncers.push(sync); await sync.syncActions([action], [action]);
    const parsed = parse(await handleCalendarInfo(f.cal, sync)); expect(parsed.auth).toBe('fullAccess'); expect(parsed.calendar_sync[0]).toMatchObject({ status: 'pending', retry: true, category: 'helper-exited', stderr: 'native-crash-line', exit_code: 9 });
  });
});
