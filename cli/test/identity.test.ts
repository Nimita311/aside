import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInstanceId, isInstanceId } from '../src/core/identity.js';
import { parseManifest } from '../src/core/parser.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync, type SyncAction } from '../src/mcp/calendar/sync.js';
import { Store } from '../src/mcp/store.js';
import type { CalEvent } from '../src/mcp/calendar/protocol.js';
import { savedEvent } from './calendar-fixture.js';
const dirs: string[] = [], cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((f) => f()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
function instance(id: string): string { const path = mkdtempSync('/tmp/aside-identity-'); dirs.push(path); writeFileSync(join(path, 'aside.md'), `---\nid: ${id}\nname: Work\n---\n`); return path; }
const action: SyncAction = { id: '2026-05-15-deploy', frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work' }, body: 'body' };
function client() {
  const cal = new CalClient(null), events = new Map<string, CalEvent>();
  let sequence = 0;
  vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{id:'work',name:'Work',account:'iCloud',writable:true,type:'caldav'}] });
  vi.spyOn(cal, 'listEvents').mockImplementation(async ({ start, end, calendars }) => ({ events: [...events.values()].filter(event =>
    (!calendars || calendars.includes(event.calendar)) && event.startInstant < new Date(end).getTime() && event.endInstant >= new Date(start).getTime()) }));
  vi.spyOn(cal, 'getEvents').mockImplementation(async ({ eventIds }) => ({ events: eventIds.flatMap(id => events.has(id) ? [events.get(id)!] : []) }));
  vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {
    const eventId = args.eventId ?? [...events.values()].find(event => event.url === args.marker)?.id ?? `event-${++sequence}`;
    events.set(eventId, { ...savedEvent(args, eventId), calendar_account: args.calendar_account ?? 'iCloud' });
    return { eventId };
  });
  vi.spyOn(cal, 'deleteEvent').mockImplementation(async ({ eventId, marker }) => {
    const deleted = events.get(eventId)?.url === marker && events.delete(eventId);
    return { deleted };
  });
  cleanup.push(() => cal.close());
  return cal;
}
describe('stable instance identity', () => {
  it('requires a hostname label and reports invalid values without rewriting', () => {
    for (const id of ['a', 'work-123', 'a'.repeat(63)]) expect(isInstanceId(id)).toBe(true);
    for (const id of ['', '-work', 'work-', 'Work', 'work.log', '工作', 'a'.repeat(64)]) { expect(isInstanceId(id)).toBe(false); if (id) expect(parseManifest(`---\nid: ${id}\n---`).issues.some((i) => i.code === 'invalid_instance_id')).toBe(true); }
    expect(createInstanceId('Café Work')).toBe('cafe-work'); expect(isInstanceId(createInstanceId('工作'))).toBe(true);
  });
  it('reports all conflicting canonical paths without loading known instances', () => {
    const a = instance('work'), b = instance('work'), alias = join(a, 'alias'); symlinkSync(b, alias);
    const host = new InstanceHost(new CalClient(null)); cleanup.push(() => host.close()); host.setKnownPaths(() => [a, b, alias]);
    const issue = host.issues(a).find((i) => i.code === 'instance_id_conflict'); expect(issue?.message).toContain(a); expect(issue?.message).toContain(b); expect(host.loadedPaths()).toEqual([realpathSync(a)]);
    writeFileSync(join(b, 'aside.md'), '---\nid: personal\n---\n'); expect(host.issues(a).some((i) => i.code === 'instance_id_conflict')).toBe(false);
  });
  it('holds retries during a conflict and resumes after resolution', async () => {
    const cal = client(); let conflict = 'Duplicate work: /a, /b'; const sync = new CalSync(cal, 'work', undefined, undefined, () => conflict || null); cleanup.push(() => sync.dispose());
    await sync.syncActions([action], [action]); expect(sync.status(action.id)).toMatchObject({ status: 'disabled', reason: conflict }); await sync.syncActions([], [action]); expect(cal.authStatus).not.toHaveBeenCalled(); expect(cal.upsertEvent).not.toHaveBeenCalled();
    conflict = ''; await sync.syncActions([], [action]); expect(cal.upsertEvent).toHaveBeenCalledOnce(); expect(sync.status(action.id)?.status).toBe('synced');
    expect(cal.getEvents).toHaveBeenCalledWith({ eventIds: ['event-1'] });
  });
  it('stops an in-flight batch before its next calendar write', async () => {
    const cal = client(); let conflict = ''; vi.mocked(cal.listEvents).mockImplementation(async () => { conflict = 'Duplicate work'; return { events: [] }; }); const sync = new CalSync(cal, 'work', undefined, undefined, () => conflict || null); cleanup.push(() => sync.dispose());
    await sync.syncActions([action], [action]); expect(cal.upsertEvent).not.toHaveBeenCalled(); expect(cal.deleteEvent).not.toHaveBeenCalled(); expect(sync.status(action.id)).toMatchObject({ status: 'disabled', reason: conflict });
  });
  it('stops reverse writes when a collision appears during calendar reads', async () => {
    const path = instance('work'); mkdirSync(join(path, 'actions', '2026'), { recursive: true }); const file = join(path, 'actions', '2026', `${action.id}.md`), original = '---\nname: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work\n---\nbody\n'; writeFileSync(file, original);
    const store = new Store(path); cleanup.push(() => store.close()); const cal = client(); let conflict = ''; vi.mocked(cal.listEvents).mockImplementation(async () => { conflict = 'Duplicate work'; return { events: [] }; }); const sync = new CalSync(cal, '', store, undefined, () => conflict || null); cleanup.push(() => sync.dispose());
    await sync.reconcile([action]); expect(readFileSync(file, 'utf8')).toBe(original); expect(cal.deleteEvent).not.toHaveBeenCalled(); expect(cal.upsertEvent).not.toHaveBeenCalled();
  });
  it('discards an old identity completion and retries without its cached event ID', async () => {
    const path = instance('work'); mkdirSync(join(path, 'actions', '2026'), { recursive: true });
    writeFileSync(join(path, 'actions', '2026', `${action.id}.md`), '---\nname: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work\n---\nbody\n');
    const store = new Store(path); cleanup.push(() => store.close()); const cal = client();
    const sync = new CalSync(cal, '', store); cleanup.push(() => sync.dispose());
    const save = vi.mocked(cal.upsertEvent).getMockImplementation()!;
    vi.mocked(cal.upsertEvent).mockImplementationOnce(async args => {
      const saved = await save(args);
      writeFileSync(join(path, 'aside.md'), '---\nid: personal\n---\n');
      sync.status(action.id); // host/status observes the manifest edit during the helper call
      return saved;
    });
    await sync.syncActions([action], [action]);
    expect(sync.status(action.id)?.status).toBe('pending');
    await sync.syncActions([], [action]);
    expect(vi.mocked(cal.upsertEvent).mock.calls[1][0]).toMatchObject({ marker: `aside://personal/action/${action.id}` });
    expect(vi.mocked(cal.upsertEvent).mock.calls[1][0].eventId).toBeUndefined();
    expect(sync.status(action.id)?.status).toBe('synced');
    expect(cal.getEvents).toHaveBeenCalledWith({ eventIds: ['event-2'] });
  });

});
