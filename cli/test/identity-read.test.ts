import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { shouldRetainKnownInstance } from '../src/core/instance.js';
import { InstanceHost } from '../src/daemon/host.js';
import { Daemon } from '../src/daemon/daemon.js';
import { DaemonClient } from '../src/daemon/client.js';
import { daemonPaths, type DaemonPaths } from '../src/daemon/paths.js';
import type { Status } from '../src/daemon/protocol.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { storeAction } from '../src/mcp/calendar/sync.js';
import type { CalEvent } from '../src/mcp/calendar/protocol.js';
import { savedEvent } from './calendar-fixture.js';

const execFileAsync = promisify(execFile), cleanup: Array<() => void | Promise<void>> = [];
const permissionTests = process.platform !== 'win32' && process.getuid?.() !== 0;
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const actionId = '2026-05-15-action';

function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/aside-id-read-test-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b'), c = join(root, 'c');
  for (const path of [a, b, c]) {
    mkdirSync(path); writeFileSync(join(path, 'aside.md'), `---\nid: ${path === c ? 'other' : 'shared-work'}\nname: Work\n---\n`);
  }
  mkdirSync(join(a, 'actions', '2026'), { recursive: true });
  writeFileSync(join(a, 'actions', '2026', `${actionId}.md`), '---\nname: Action\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work\n---\n');
  const paths = daemonPaths({ ASIDE_DAEMON_HOME: join(root, 'daemon') }); mkdirSync(paths.state);
  return { root, a, b, c, paths };
}

function fakeClient() {
  const cal = new CalClient(null), events = new Map<string, CalEvent>();
  vi.spyOn(cal, 'available').mockReturnValue(true);
  const auth = vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  const calendars = vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'caldav' }] });
  const list = vi.spyOn(cal, 'listEvents').mockImplementation(async ({ start, end, calendars }) => ({ events: [...events.values()].filter(event =>
    (!calendars || calendars.includes(event.calendar)) && event.startInstant < new Date(end).getTime() && event.endInstant >= new Date(start).getTime()) }));
  const get = vi.spyOn(cal, 'getEvents').mockImplementation(async ({ eventIds }) => ({ events: eventIds.flatMap(id => events.has(id) ? [events.get(id)!] : []) }));
  const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {
    const eventId = args.eventId ?? 'fake-event'; events.set(eventId, savedEvent(args, eventId)); return { eventId };
  });
  const remove = vi.spyOn(cal, 'deleteEvent').mockResolvedValue({ deleted: true });
  return { cal, events, calls: [auth, calendars, list, get, upsert, remove], upsert };
}

function hostFor(known: () => string[]) {
  const fake = fakeClient(), host = new InstanceHost(fake.cal);
  host.setKnownPaths(known); cleanup.push(() => host.close());
  return { host, ...fake };
}

async function queueAction(host: InstanceHost, path: string) {
  const loaded = host.load(path), action = storeAction(loaded.store, actionId)!;
  await host.flush(); await loaded.sync.syncActions([action], [action]);
  return { loaded, action };
}

function assertNoHelper(calls: ReturnType<typeof fakeClient>['calls']) { for (const call of calls) expect(call).not.toHaveBeenCalled(); }

describe('known identity read failures', () => {
  it.skipIf(!permissionTests).each([false, true])('preserves a duplicate peer through EACCES (loaded: %s) until its successful identity change', async loadedPeer => {
    const f = fixture(), h = hostFor(() => [f.a, f.b]);
    if (loadedPeer) h.host.load(f.b);
    const { loaded, action } = await queueAction(h.host, f.a);
    expect(loaded.sync.status(actionId)?.status).toBe('disabled'); assertNoHelper(h.calls);
    chmodSync(join(f.b, 'aside.md'), 0);
    try {
      h.host.refreshIdentities(); await h.host.flush();
      await loaded.sync.syncActions([], [action]); await loaded.sync.reconcile([action]);
      const issue = h.host.issues(f.a).find(issue => issue.code === 'instance_id_conflict');
      expect(issue?.message).toContain('EACCES'); expect(issue?.message).toContain(f.a); expect(issue?.message).toContain(f.b);
      expect(issue?.message).toContain('preserving its existing id'); expect(issue?.message).not.toContain('Give each distinct instance');
      expect(loaded.sync.status(actionId)).toMatchObject({ status: 'disabled', reason: issue?.message });
      expect(h.host.loadedPaths().sort()).toEqual(loadedPeer ? [f.a, f.b] : [f.a]); assertNoHelper(h.calls);
    } finally { chmodSync(join(f.b, 'aside.md'), 0o600); }
    h.host.refreshIdentities(); await h.host.flush();
    expect(h.host.issues(f.a)).toContainEqual(expect.objectContaining({ code: 'instance_id_conflict' })); assertNoHelper(h.calls);
    writeFileSync(join(f.b, 'aside.md'), '---\nid: personal\n---\n'); h.host.refreshIdentities(); await h.host.flush();
    await loaded.sync.syncActions([], [action]);
    expect(h.host.issues(f.a).some(issue => issue.code === 'instance_id_conflict')).toBe(false);
    expect(loaded.sync.status(actionId)).toMatchObject({ status: 'synced', eventId: 'fake-event' });
    expect(h.upsert.mock.calls[0][0].marker).toBe(`aside://shared-work/action/${actionId}`);
  });

  it('does not mistake EISDIR for removal of a registered duplicate', async () => {
    const f = fixture(), h = hostFor(() => [f.a, f.b]), { loaded, action } = await queueAction(h.host, f.a);
    rmSync(join(f.b, 'aside.md')); mkdirSync(join(f.b, 'aside.md'));
    expect(shouldRetainKnownInstance(f.b)).toBe(true);
    h.host.refreshIdentities(); await h.host.flush(); await loaded.sync.syncActions([], [action]);
    expect(loaded.sync.status(actionId)).toMatchObject({ status: 'disabled', reason: expect.stringContaining('EISDIR') }); assertNoHelper(h.calls);
    rmSync(join(f.b, 'aside.md'), { recursive: true }); writeFileSync(join(f.b, 'aside.md'), '---\nid: personal\n---\n');
    h.host.refreshIdentities(); await h.host.flush(); await loaded.sync.syncActions([], [action]);
    expect(loaded.sync.status(actionId)?.status).toBe('synced');
  });

  it.skipIf(!permissionTests)('does not block a distinct verified identity when its peer later becomes unreadable', async () => {
    const f = fixture(); writeFileSync(join(f.b, 'aside.md'), '---\nid: personal\n---\n');
    const h = hostFor(() => [f.a, f.b]);
    h.events.set('fake-event', savedEvent({ marker: `aside://shared-work/action/${actionId}`, calendar: 'Work', title: '▢ Action', start: '2026-05-15T10:00', end: '2026-05-15T10:30', durationMinutes: 30 }, 'fake-event'));
    const { loaded, action } = await queueAction(h.host, f.a);
    expect(loaded.sync.status(actionId)?.status).toBe('synced'); for (const call of h.calls) call.mockClear();
    chmodSync(join(f.b, 'aside.md'), 0);
    try {
      h.host.refreshIdentities(); await h.host.flush(); await loaded.sync.syncActions([action], [action]);
      expect(h.host.issues(f.a)).toEqual([]); expect(loaded.sync.status(actionId)?.status).toBe('synced');
      expect(h.upsert).toHaveBeenCalledOnce(); expect(h.upsert.mock.calls[0][0].eventId).toBe('fake-event');
    } finally { chmodSync(join(f.b, 'aside.md'), 0o600); }
  });

  it.skipIf(!permissionTests)('observes registered metadata before any store loads', async () => {
    const f = fixture(); writeFileSync(join(f.b, 'aside.md'), '---\nid: personal\n---\n');
    const h = hostFor(() => [f.a, f.b]); expect(h.host.loadedPaths()).toEqual([]); assertNoHelper(h.calls);
    chmodSync(join(f.b, 'aside.md'), 0);
    try {
      h.events.set('fake-event', savedEvent({ marker: `aside://shared-work/action/${actionId}`, calendar: 'Work', title: '▢ Action', start: '2026-05-15T10:00', end: '2026-05-15T10:30', durationMinutes: 30 }, 'fake-event'));
      const { loaded } = await queueAction(h.host, f.a);
      expect(h.host.issues(f.a)).toEqual([]); expect(loaded.sync.status(actionId)?.status).toBe('synced');
      expect(h.host.loadedPaths()).toEqual([f.a]); expect(h.upsert).toHaveBeenCalled();
    } finally { chmodSync(join(f.b, 'aside.md'), 0o600); }
  });

  it.each(['remove', 'forget'] as const)('resumes after verified %s of an unloaded conflicting registration', async resolution => {
    const f = fixture(); let known = [f.a, f.b]; const h = hostFor(() => known), { loaded, action } = await queueAction(h.host, f.a);
    assertNoHelper(h.calls);
    if (resolution === 'remove') { rmSync(join(f.b, 'aside.md')); expect(shouldRetainKnownInstance(f.b)).toBe(false); }
    else known = [f.a];
    h.host.refreshIdentities(); await h.host.flush(); await loaded.sync.syncActions([], [action]);
    expect(h.host.issues(f.a)).toEqual([]); expect(loaded.sync.status(actionId)?.status).toBe('synced');
  });

  it.each(['remove', 'forget'] as const)('resumes after %s of a cold-start registration whose identity could not be read', async resolution => {
    const f = fixture(); rmSync(join(f.b, 'aside.md')); mkdirSync(join(f.b, 'aside.md'));
    let known = [f.a, f.b]; const h = hostFor(() => known), { loaded, action } = await queueAction(h.host, f.a);
    expect(h.host.issues(f.a)).toContainEqual(expect.objectContaining({ code: 'instance_identity_unavailable', message: expect.stringContaining('EISDIR') }));
    expect(loaded.sync.status(actionId)?.status).toBe('disabled'); assertNoHelper(h.calls);
    if (resolution === 'remove') rmSync(join(f.b, 'aside.md'), { recursive: true }); else known = [f.a];
    h.host.refreshIdentities(); await h.host.flush(); await loaded.sync.syncActions([], [action]);
    expect(h.host.issues(f.a)).toEqual([]); expect(loaded.sync.status(actionId)?.status).toBe('synced');
  });

  it('keeps a loaded peer in the guard after forgetting only its catalogue registration', async () => {
    const f = fixture(); let known = [f.a, f.b]; const h = hostFor(() => known); h.host.load(f.b);
    const { loaded, action } = await queueAction(h.host, f.a); known = [f.a]; h.host.refreshIdentities(); await h.host.flush();
    await loaded.sync.syncActions([], [action]); expect(loaded.sync.status(actionId)?.status).toBe('disabled'); assertNoHelper(h.calls);
    h.host.unload(f.b); h.host.refreshIdentities(); await h.host.flush(); await loaded.sync.syncActions([], [action]);
    expect(loaded.sync.status(actionId)?.status).toBe('synced');
  });
});

async function startDaemon(paths: DaemonPaths) {
  const fake = fakeClient(), host = new InstanceHost(fake.cal), daemon = new Daemon({ paths, host, webPort: 0 });
  expect(await daemon.listen()).toBe(true); cleanup.push(() => daemon.shutdown());
  const client = new DaemonClient({ paths, launcher: async () => { throw new Error('Unexpected launch'); } }); cleanup.push(() => client.close());
  return { daemon, host, client, ...fake };
}

describe('catalogue read failure retention', () => {
  it.skipIf(!permissionTests)('retains unreadable registrations through status, add/forget and restart without certifying an unknown identity', async () => {
    const f = fixture(); writeFileSync(f.paths.known, JSON.stringify([f.a, f.b]));
    const first = await startDaemon(f.paths), { loaded, action } = await queueAction(first.host, f.a);
    chmodSync(join(f.b, 'aside.md'), 0);
    try {
      expect((await first.client.request<Status>('status')).known).toEqual([f.a]);
      assertNoHelper(first.calls);
      await first.client.request('known.add', { paths: [f.c] }); await first.client.request('known.forget', { paths: [f.c] });
      expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.a, f.b]);
      // Registering c now starts its sync; the conflicting action must remain blocked.
      await loaded.sync.syncActions([], [action]);
      expect(loaded.sync.status(actionId)?.status).toBe('disabled');
      expect(first.upsert).not.toHaveBeenCalled();
      expect(first.calls.at(-1)).not.toHaveBeenCalled();
      first.client.close(); await first.daemon.shutdown();
      const second = await startDaemon(f.paths), next = await queueAction(second.host, f.a);
      expect((await second.client.request<Status>('status')).known).toEqual([f.a]);
      expect(second.host.issues(f.a)).toContainEqual(expect.objectContaining({ code: 'instance_identity_unavailable', message: expect.stringContaining('EACCES') }));
      expect(next.loaded.sync.status(actionId)?.status).toBe('disabled'); assertNoHelper(second.calls);
      chmodSync(join(f.b, 'aside.md'), 0o600); second.host.refreshIdentities(); await second.host.flush();
      expect(next.loaded.sync.status(actionId)?.reason).toContain('is shared by'); assertNoHelper(second.calls);
      writeFileSync(join(f.b, 'aside.md'), '---\nid: personal\n---\n'); second.host.refreshIdentities(); await second.host.flush();
      await next.loaded.sync.syncActions([], [next.action]); expect(next.loaded.sync.status(actionId)?.status).toBe('synced');
      rmSync(join(f.b, 'aside.md'));
      expect((await second.client.request<Status>('status')).known).toEqual([f.a]);
      expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.a]);
    } finally { if (shouldRetainKnownInstance(f.b)) chmodSync(join(f.b, 'aside.md'), 0o600); }
  });

  it.skipIf(!permissionTests)('offline listings hide unreadable paths while retaining internal identity metadata', async () => {
    const f = fixture(); writeFileSync(f.paths.known, JSON.stringify([f.a, f.b, f.c])); chmodSync(join(f.b, 'aside.md'), 0);
    const env = { ...process.env, ASIDE_DAEMON_HOME: f.paths.state, ASIDE_CAL_BIN: '/nonexistent/aside-cal' };
    try {
      const status = await execFileAsync(process.execPath, ['dist/main.js', 'daemon', 'status'], { env });
      expect(status.stdout).not.toContain(f.b); expect(status.stdout).not.toContain('EACCES');
      expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.a, f.b, f.c]);
      const forget = await execFileAsync(process.execPath, ['dist/main.js', 'instance', 'forget', '--dir', f.c], { env }).catch(error => error);
      expect(forget.stdout).not.toContain(f.b); expect(forget.stdout).not.toContain('EACCES');
      expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.a, f.b]);
      await execFileAsync(process.execPath, ['dist/main.js', 'instance', 'add', '--dir', f.c], { env }).catch(error => { expect(error.code).toBe(1); });
      expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.a, f.b, f.c]);
      await execFileAsync(process.execPath, ['dist/main.js', 'instance', 'forget', '--dir', f.b], { env });
      expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.a, f.c]);
    } finally { chmodSync(join(f.b, 'aside.md'), 0o600); }
  });
});
