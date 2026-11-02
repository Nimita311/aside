import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import { CalClient, CalError } from '../src/mcp/calendar/client.js';
import { CalSync, storeAction } from '../src/mcp/calendar/sync.js';
import { buildMarker, parseMarker } from '../src/mcp/calendar/markers.js';
import { handleCalendarInfo } from '../src/mcp/calendar/info.js';
import { eventTimingDiagnostic } from '../src/mcp/calendar/timing.js';
import { scheduleInstant, wallTimeAt } from '../src/core/scheduling.js';
import type { CalEvent } from '../src/mcp/calendar/protocol.js';

const fixtures: Array<{ dir: string; store: Store; sync: CalSync }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.sync.dispose(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); } vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function fixture() {
  const dir = mkdtempSync('/tmp/aside-unrepresentable-'); vi.stubEnv('ASIDE_DAEMON_HOME', join(dir, 'daemon')); writeFileSync(join(dir, 'aside.md'), '---\nid: work\n---\n');
  const store = new Store(dir);
  const { createdActionIds: [id] } = handleCapture(store, { content: 'Review', description: 'Review', actions: [{ name: 'Review', description: 'Review', scheduled: '2026-11-01T01:30', timezone: 'America/Los_Angeles', duration: 'PT30M', calendar: 'Work' }] }, new Date('2026-10-30T09:00'));
  const events = new Map<string, CalEvent>();
  const event = (start = Date.parse('2026-11-01T09:30:00Z'), minutes = 30): CalEvent => ({ id: 'event', url: buildMarker('work', id, 'active'), calendar: 'Work', title: '▢ Review', timezone: 'America/Los_Angeles', start: wallTimeAt(start, 'America/Los_Angeles'), end: wallTimeAt(start + minutes * 60000, 'America/Los_Angeles'), startInstant: start, endInstant: start + minutes * 60000, durationMinutes: minutes });
  events.set('event', event());
  const cal = new CalClient(null); vi.spyOn(cal, 'available').mockReturnValue(true); vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] });
  vi.spyOn(cal, 'listEvents').mockImplementation(async () => ({ events: [...events.values()] }));
  vi.spyOn(cal, 'getEvents').mockImplementation(async args => ({ events: args.eventIds.flatMap(id => events.has(id) ? [events.get(id)!] : []) }));
  const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {
    const old = args.eventId ? events.get(args.eventId) : [...events.values()].find(e => e.url === args.marker);
    const invalid = old && eventTimingDiagnostic(old);
    // The native helper guards the event again at mutation time, closing the
    // race between a changed signal and the next authoritative forward write.
    if (invalid && !args.allowTimeReplacement) throw new CalError(invalid.reason, 'event-time-unrepresentable', invalid);
    const key = old?.id ?? 'event-' + parseMarker(args.marker)!.actionId;
    const start = scheduleInstant(args.start, args.allDay ? undefined : args.timezone)!;
    const end = args.allDay ? start : start + args.durationMinutes! * 60000;
    events.set(key, { id: key, url: args.marker, calendar: args.calendar, title: args.title, timezone: args.timezone ?? null, start: args.start, end: wallTimeAt(end, args.timezone), startInstant: start, endInstant: end, durationMinutes: args.durationMinutes, allDay: args.allDay });
    return { eventId: key };
  });
  const remove = vi.spyOn(cal, 'deleteEvent').mockImplementation(async args => { const ev = events.get(args.eventId); const invalid = ev && eventTimingDiagnostic(ev); if (invalid) throw new CalError(invalid.reason, 'event-time-unrepresentable', invalid); events.delete(args.eventId); return { deleted: true }; });
  const sync = new CalSync(cal, 'work', store); fixtures.push({ dir, store, sync });
  const action = () => storeAction(store, id)!;
  const file = store.getActionFile(id)!;
  return { dir, store, id, file, sync, cal, event, events, upsert, remove, action };
}

describe('unrepresentable calendar times', () => {
  it.each([undefined, 'cancelled'] as const)('preserves Calendar when a template has malformed null recurrence and resolution %s', async resolution => {
    const f = fixture();
    handleUpdateAction(f.store, { id: f.id, scheduled: '2099-01-01T09:00', timezone: 'UTC' });
    f.events.set('event', { ...f.event(Date.parse('2099-01-01T09:00Z')), timezone: 'UTC', start: '2099-01-01T09:00', end: '2099-01-01T09:30' });
    await f.sync.syncActions([f.action()], [f.action()]);
    handleUpdateAction(f.store, { id: f.id, scheduled: null, timezone: null, recurrence: { append: { dtstart: '2099-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY' } } });
    writeFileSync(f.file, readFileSync(f.file, 'utf8').replace(/recurrence:\n(?:[ \t]+.*\n)+/, `recurrence: null\nscheduled: 2099-01-01T09:00\ntimezone: UTC\n${resolution ? `resolution: ${resolution}\n` : ''}`));
    f.store.rebuild();
    expect(f.store.getIssues().some(issue => issue.code === 'recurrence_history_changed')).toBe(true);
    const source = readFileSync(f.file, 'utf8'), native = JSON.stringify([...f.events]);
    f.upsert.mockClear(); f.remove.mockClear();
    const result = await f.sync.syncActions([f.action()], [f.action()]);
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.id, status: 'error', code: 'invalid-scheduling' })]));
    await f.sync.reconcile([f.action()]);
    expect(f.upsert).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(readFileSync(f.file, 'utf8')).toBe(source); expect(JSON.stringify([...f.events])).toBe(native);
  });
  it('preserves a second repeated-hour event and record during cold reverse and forward sync', async () => {
    const f = fixture(), before = readFileSync(f.file, 'utf8'), original = JSON.stringify([...f.events]);
    await f.sync.reconcile([f.action()]);
    const [result] = await f.sync.syncActions([f.action()], [f.action()]);
    expect(result).toMatchObject({ status: 'error', code: 'event-time-unrepresentable' });
    expect(readFileSync(f.file, 'utf8')).toBe(before); expect(JSON.stringify([...f.events])).toBe(original);
    expect(f.upsert).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.sync.changesSinceStart()).toEqual([]);
    expect(f.sync.status(f.id)).toMatchObject({ status: 'failed', diagnostic: { category: 'event-time-unrepresentable' } });
    const info = await handleCalendarInfo(f.cal, f.sync); expect(info).toContain(f.id); expect(info).toContain('event-time-unrepresentable'); expect(info).toContain('both directions'); expect(info).toContain('unambiguous'); expect(info).not.toContain('retry: true');
  });
  it('detects an unsafe event on the first cold forward sweep without overwriting it', async () => {
    const f = fixture(), original = JSON.stringify([...f.events]); await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.sync.report()[0].reason).toContain('repeated hour'); expect(JSON.stringify([...f.events])).toBe(original); expect(f.upsert).not.toHaveBeenCalled();
  });
  it('parks a warm native refusal before a reverse changed notification arrives', async () => {
    const f = fixture(); f.events.set('event', f.event(Date.parse('2026-11-01T08:30:00Z')));
    await f.sync.syncActions([f.action()], [f.action()]); f.events.set('event', f.event());
    handleUpdateAction(f.store, { id: f.id, name: 'Renamed' }); const before = readFileSync(f.file, 'utf8');
    await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.sync.status(f.id)?.diagnostic?.category).toBe('event-time-unrepresentable'); expect(readFileSync(f.file, 'utf8')).toBe(before);
    const attempts = f.upsert.mock.calls.length;
    await f.sync.syncActions([f.action()], [f.action()]); expect(f.upsert).toHaveBeenCalledTimes(attempts);
  });
  it.each([{ name: 'Renamed' }, { body: 'Changed notes' }, { duration: 'PT1H' }, { scheduled: '2026-11-01T01:30' }, { timezone: 'US/Pacific' }])('does not unblock unrelated or still-ambiguous record changes %j', async patch => {
    const f = fixture(); await f.sync.reconcile([f.action()]); handleUpdateAction(f.store, { id: f.id, ...patch });
    const before = readFileSync(f.file, 'utf8'), original = JSON.stringify([...f.events]);
    await f.sync.syncActions([f.action()], [f.action()]); await f.sync.reconcile([f.action()]);
    expect(readFileSync(f.file, 'utf8')).toBe(before); expect(JSON.stringify([...f.events])).toBe(original); expect(f.upsert).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.sync.status(f.id)?.status).toBe('failed');
  });
  it.each([{ scheduled: '2026-11-01T09:30', timezone: 'UTC' }, { scheduled: '2026-11-01T02:30' }])('allows an explicit unambiguous start edit %j', async patch => {
    const f = fixture(); await f.sync.reconcile([f.action()]); handleUpdateAction(f.store, { id: f.id, ...patch });
    await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.upsert).toHaveBeenCalledOnce(); expect(f.upsert.mock.calls[0][0].allowTimeReplacement).toBe(true);
    expect(f.events.get('event')!.startInstant).toBe(scheduleInstant(patch.scheduled, patch.timezone ?? 'America/Los_Angeles'));
    expect(f.sync.report()).toEqual([]); expect(f.sync.status(f.id)?.status).toBe('synced'); await f.sync.reconcile([f.action()]); expect(f.upsert).toHaveBeenCalledOnce();
  });
  it('does not use a start edit to bypass missing helper timing metadata', async () => {
    const f = fixture(); f.events.get('event')!.startInstant = undefined as unknown as number;
    await f.sync.reconcile([f.action()]); handleUpdateAction(f.store, { id: f.id, scheduled: '2026-11-01T02:30' });
    const before = readFileSync(f.file, 'utf8'); await f.sync.syncActions([f.action()], [f.action()]);
    expect(readFileSync(f.file, 'utf8')).toBe(before); expect(f.upsert).not.toHaveBeenCalled(); expect(f.sync.status(f.id)?.status).toBe('failed');
    f.events.set('event', f.event(Date.parse('2026-11-01T08:30:00Z')));
    await f.sync.syncActions([f.action()], [f.action()]); expect(f.upsert).toHaveBeenCalledOnce(); expect(f.sync.report()).toEqual([]);
  });
  it('parks a native removal refusal without retrying a cancelled action', async () => {
    const f = fixture(); f.events.set('event', f.event(Date.parse('2026-11-01T08:30:00Z')));
    await f.sync.syncActions([f.action()], [f.action()]); f.events.set('event', f.event());
    handleUpdateAction(f.store, { id: f.id, resolution: 'cancelled' });
    await f.sync.syncActions([f.action()], [f.action()]); expect(f.remove).toHaveBeenCalledOnce();
    expect(f.sync.status(f.id)?.diagnostic?.category).toBe('event-time-unrepresentable');
    await f.sync.syncActions([f.action()], [f.action()]); expect(f.remove).toHaveBeenCalledOnce(); expect(f.events.has('event')).toBe(true);
  });
  it('queues an explicit start edit found on disk before reverse import can undo it', async () => {
    const f = fixture(); await f.sync.reconcile([f.action()]); handleUpdateAction(f.store, { id: f.id, scheduled: '2026-11-01T02:30' });
    await f.sync.reconcile([f.action()]); expect(f.action().frontMatter.scheduled).toBe('2026-11-01T02:30');
    expect(f.sync.status(f.id)?.status).toBe('pending'); await f.sync.syncActions([], [f.action()]); expect(f.upsert).toHaveBeenCalledOnce(); expect(f.sync.report()).toEqual([]);
  });
  it('resumes when Calendar corrects its start to the first occurrence', async () => {
    const f = fixture(); await f.sync.reconcile([f.action()]); f.events.set('event', f.event(Date.parse('2026-11-01T08:30:00Z')));
    await f.sync.reconcile([f.action()]); expect(f.sync.report()).toEqual([]); expect(f.sync.status(f.id)?.status).toBe('synced'); expect(f.upsert).not.toHaveBeenCalled();
  });
  it('imports a calendar-origin UTC expression of the second occurrence faithfully', async () => {
    const f = fixture(); await f.sync.reconcile([f.action()]); const ev = f.events.get('event')!;
    f.events.set('event', { ...ev, timezone: 'UTC', start: wallTimeAt(ev.startInstant, 'UTC'), end: wallTimeAt(ev.endInstant, 'UTC') });
    await f.sync.reconcile([f.action()]); expect(f.action().frontMatter).toMatchObject({ scheduled: '2026-11-01T09:30', timezone: 'UTC' }); expect(f.sync.report()).toEqual([]); expect(f.upsert).not.toHaveBeenCalled();
  });
  it.each(['done', 'cancelled', 'backlog'] as const)('preserves unsafe events even with a /%s gesture', async suffix => {
    const f = fixture(), before = readFileSync(f.file, 'utf8'); f.events.get('event')!.url = buildMarker('work', f.id, suffix);
    await f.sync.reconcile([f.action()]); expect(readFileSync(f.file, 'utf8')).toBe(before); expect(f.remove).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it('preserves all duplicates when any event for the action has an unsafe time', async () => {
    const f = fixture(); f.events.set('first', { ...f.event(Date.parse('2026-11-01T08:30:00Z')), id: 'first' });
    await f.sync.syncActions([f.action()], [f.action()]); expect(f.events.size).toBe(2); expect(f.remove).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it('keeps another action usable while one action is blocked', async () => {
    const f = fixture(); const { createdActionIds: [good] } = handleCapture(f.store, { content: 'Other', description: 'Other', actions: [{ name: 'Other', description: 'Other', scheduled: '2026-11-01T03:00', timezone: 'America/Los_Angeles', calendar: 'Work' }] }, new Date('2026-10-30T10:00'));
    const actions = [f.action(), storeAction(f.store, good)!]; const result = await f.sync.syncActions(actions, actions);
    expect(result.map(r => r.status)).toEqual(['error', 'synced']); expect(f.sync.status(good)?.status).toBe('synced'); expect(f.upsert).toHaveBeenCalledOnce();
  });
  it.each([{ startInstant: undefined }, { endInstant: Infinity }, { timezone: undefined }, { durationMinutes: undefined, endInstant: Date.parse('2026-11-01T08:30:30Z'), end: '2026-11-01T01:30' }, { endInstant: Date.parse('2026-11-01T08:00:00Z'), end: '2026-11-01T01:00', durationMinutes: undefined }, { end: '2026-11-01T07:00' }])('rejects malformed or unrepresentable helper timing %j before any mutation', async patch => {
    const f = fixture(), before = readFileSync(f.file, 'utf8'); f.events.set('event', { ...f.event(Date.parse('2026-11-01T08:30:00Z')), ...patch } as CalEvent);
    await f.sync.reconcile([f.action()]); expect(readFileSync(f.file, 'utf8')).toBe(before); expect(f.sync.changesSinceStart()).toEqual([]); expect(f.upsert).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.sync.status(f.id)?.diagnostic?.category).toBe('event-time-unrepresentable');
  });
});
