import { eventTimes } from './calendar-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSchedulingDate, parseDurationMinutes, schedulingIssues } from '../src/core/scheduling.js';
import { validate } from '../src/core/validator.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateAction, handleUpdateEntry } from '../src/mcp/tools/update.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { buildMarker } from '../src/mcp/calendar/markers.js';
import { CalSync, storeAction } from '../src/mcp/calendar/sync.js';

const dirs: string[] = [], syncers: CalSync[] = [];
afterEach(() => { for (const s of syncers.splice(0)) s.dispose(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture() {
  const dir = mkdtempSync('/tmp/aside-scheduling-'); dirs.push(dir);
  writeFileSync(join(dir, 'aside.md'), '---\nid: work\n---\n');
  const store = new Store(dir);
  const captured = handleCapture(store, { content: 'Deploy tomorrow.', description: 'Deploy', actions: [{ name: 'Deploy', description: 'Deploy' }] }, new Date('2026-05-15T09:00:00'));
  return { dir, store, id: captured.createdActionIds[0], entry: captured.entryId };
}
function snapshot(dir: string): string { return JSON.stringify(readdirSync(dir, { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => [join(f.parentPath, f.name), readFileSync(join(f.parentPath, f.name), 'utf8')])); }
function calendar(store: Store) {
  const cal = new CalClient(null); vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] });
  vi.spyOn(cal, 'listEvents').mockResolvedValue({ events: [] }); vi.spyOn(cal, 'getEvents').mockResolvedValue({ events: [] });
  const upsert = vi.spyOn(cal, 'upsertEvent').mockResolvedValue({ eventId: 'event' }); const remove = vi.spyOn(cal, 'deleteEvent').mockResolvedValue({ deleted: true });
  const sync = new CalSync(cal, 'work', store); syncers.push(sync); return { sync, upsert, remove };
}
describe('scheduling contract', () => {
  it.each(['2026-02-29', '2026-04-31', '2026-00-10', '0000-01-01', '2026-01-01T24:00', '2026-01-01T12:60', '2026-01-01T12:30:00', '2026-01-01T12:30Z', 'tomorrow'])('rejects non-dates or unsupported clock formats: %s', value => expect(isSchedulingDate(value)).toBe(false));
  it.each(['2024-02-29', '2000-02-29T00:00', '0099-01-01', '2026-12-31T23:59'])('accepts real dates: %s', value => expect(isSchedulingDate(value)).toBe(true));
  it.each(['PT0M', '-PT1H', 'P1M', 'P1Y', 'P1W', 'PT', 'P1DT', 'PT90S', 'PT0.5H', 'garbage', 'PT9999999999999999999M'])('rejects unsupported/non-positive duration: %s', value => expect(parseDurationMinutes(value)).toBeUndefined());
  it('supports fixed days and seconds totaling whole minutes', () => { expect(parseDurationMinutes('P1D')).toBe(1440); expect(parseDurationMinutes('P1DT2H30M')).toBe(1590); expect(parseDurationMinutes('PT120S')).toBe(2); });
  it('rejects invalid zones and nonexistent local times, while allowing repeated times', () => {
    expect(schedulingIssues({ timezone: 'Made/Up' })[0]).toContain('timezone:');
    expect(schedulingIssues({ timezone: '+05:00' })[0]).toContain('timezone:');
    expect(schedulingIssues({ timezone: 'America/Los_Angeles', scheduled: '2026-03-08T02:30' })[0]).toContain('scheduled:');
    expect(schedulingIssues({ timezone: 'America/Los_Angeles', scheduled: '2026-11-01T01:30' })).toEqual([]);
    expect(schedulingIssues({ timezone: 'America/Los_Angeles', scheduled: '2026-03-08T01:30', duration: 'PT1H' })).toEqual([]);
    expect(schedulingIssues({ timezone: 'America/Los_Angeles', scheduled: '2026-03-08T01:45' })).toEqual([]);
  });
  it.each([{ scheduled: '2026-02-31' }, { deadline: '2026-05-15T25:00' }, { timezone: 'Mars/Olympus' }, { duration: 'PT0M' }])('rejects capture atomically for invalid fields %j', fields => {
    const f = fixture(), before = snapshot(f.dir);
    expect(() => handleCapture(f.store, { content: 'Bad scheduling', description: 'Bad', projects: [{ name: 'New project', description: 'New' }], actions: [{ name: 'Valid first', description: 'First' }, { name: 'Invalid second', description: 'Second', ...fields }] })).toThrow(Object.keys(fields)[0]);
    expect(snapshot(f.dir)).toBe(before);
  });
  it('rejects update_action without changing body, index description, or scheduling', () => {
    const f = fixture(), before = snapshot(f.dir);
    expect(() => handleUpdateAction(f.store, { id: f.id, scheduled: '2026-02-31', body: 'Replaced', description: 'Changed' })).toThrow('scheduled:');
    expect(snapshot(f.dir)).toBe(before);
  });
  it.each(['scheduled', 'deadline', 'timezone', 'duration'] as const)('rejects explicit empty %s rather than silently clearing it', field => {
    const f = fixture(), before = snapshot(f.dir);
    expect(() => handleUpdateAction(f.store, { id: f.id, [field]: '' })).toThrow(field + ':');
    expect(snapshot(f.dir)).toBe(before);
    expect(() => handleUpdateAction(f.store, { id: f.id, [field]: null })).not.toThrow();
  });
  it('refuses a reverse edit that has a nonexistent start in its explicit zone', async () => {
    const f = fixture(); handleUpdateAction(f.store, { id: f.id, scheduled: '2026-03-08T01:00', timezone: 'America/Los_Angeles', duration: 'PT30M', calendar: 'Work' });
    const c = calendar(f.store), action = storeAction(f.store, f.id)!, file = f.store.getActionFile(f.id)!, before = readFileSync(file, 'utf8');
    const ev = eventTimes({ id: 'event', url: buildMarker('work', f.id, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-03-08T02:30', end: '2026-03-08T03:00' }, 'America/Los_Angeles');
    const cal = (c.sync as unknown as { cal: CalClient }).cal;
    vi.mocked(cal.listEvents).mockResolvedValue({ events: [ev] });
    await c.sync.reconcile([action]);
    expect(readFileSync(file, 'utf8')).toBe(before); expect(c.sync.changesSinceStart()).toEqual([]);
    expect(c.sync.report().some(r => r.reason.includes('scheduled:'))).toBe(true); expect(c.upsert).not.toHaveBeenCalled();
  });
  it('rejects new actions in update_entry before changing any entity or entry', () => {
    const f = fixture(), before = snapshot(f.dir);
    expect(() => handleUpdateEntry(f.store, { id: f.entry, content: 'Changed', projects: [{ name: 'New', description: 'New' }], actions: [{ name: 'Bad', description: 'Bad', deadline: '2026-02-29' }] })).toThrow('deadline:');
    expect(snapshot(f.dir)).toBe(before);
  });
  it('reports direct-file issues and does not mutate them in forward or reverse sync', async () => {
    const f = fixture(); const file = f.store.getActionFile(f.id)!;
    writeFileSync(file, '---\nname: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-02-31T99:00\ndeadline: 2026-04-31\ntimezone: Made/Up\nduration: P1M\ncalendar: Work\n---\n'); f.store.rebuild();
    const check = validate(f.dir).checks.find(c => c.name === 'Action scheduling fields are valid')!;
    expect(check.passed).toBe(false); for (const field of ['scheduled', 'deadline', 'timezone', 'duration']) expect(check.details.some(d => d.includes(field + ':'))).toBe(true);
    const before = readFileSync(file, 'utf8'), c = calendar(f.store), action = storeAction(f.store, f.id)!;
    expect((await c.sync.syncActions([action], [action]))[0]).toMatchObject({ code: 'invalid-scheduling', status: 'error' });
    await c.sync.reconcile([action]); expect(readFileSync(file, 'utf8')).toBe(before); expect(c.upsert).not.toHaveBeenCalled(); expect(c.remove).not.toHaveBeenCalled();
  });
  it('sends P1D as 24 hours instead of silently using 30 minutes', async () => {
    const f = fixture(); handleUpdateAction(f.store, { id: f.id, scheduled: '2026-05-15T10:00', calendar: 'Work', duration: 'P1D' });
    const c = calendar(f.store), action = storeAction(f.store, f.id)!; await c.sync.syncActions([action], [action]);
    expect(c.upsert.mock.calls[0][0]).toMatchObject({ start: '2026-05-15T10:00', end: '2026-05-16T10:00', durationMinutes: 1440 });
  });
});
