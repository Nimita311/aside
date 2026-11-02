import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scheduleInstant, schedulingIssues, wallTimeAt } from '../src/core/scheduling.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync, storeAction } from '../src/mcp/calendar/sync.js';
import { buildMarker } from '../src/mcp/calendar/markers.js';
import { eventTimingDiagnostic } from '../src/mcp/calendar/timing.js';
import type { CalEvent } from '../src/mcp/calendar/protocol.js';

const fixtures: Array<{ dir: string; store: Store; sync: CalSync }> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) { f.sync.dispose(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function fixture({ done = false, scheduled = '2026-03-08T02:30', duration, timezone }: { done?: boolean; scheduled?: string; duration?: string; timezone?: string } = {}) {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  const dir = mkdtempSync('/tmp/aside-floating-sync-');
  writeFileSync(join(dir, 'aside.md'), '---\nid: work\n---\n');
  const store = new Store(dir);
  const { createdActionIds: [id] } = handleCapture(store, { content: 'Review', description: 'Review', actions: [{ name: 'Review', description: 'Review', scheduled, duration, timezone, calendar: 'Work' }] }, new Date('2026-03-01T09:00'));
  if (done) { const a = store.getAction(id)!; store.saveAction(id, { ...a.frontMatter, resolution: 'done' }, a.body, store.getActionFile(id)!); }
  const cal = new CalClient(null), events = new Map<string, CalEvent>();
  vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] });
  const list = vi.spyOn(cal, 'listEvents').mockImplementation(async () => ({ events: [...events.values()] }));
  const get = vi.spyOn(cal, 'getEvents').mockImplementation(async ({ eventIds }) => ({ events: eventIds.map(eid => events.get(eid)).filter((e): e is CalEvent => !!e) }));
  const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {
    const eid = args.eventId ?? 'event';
    const zone = args.timezone, startInstant = scheduleInstant(args.start, zone)!;
    const endInstant = startInstant + (args.durationMinutes ?? 0) * 60000;
    events.set(eid, { id: eid, calendar: args.calendar, calendar_account: args.calendar_account, title: args.title, url: args.marker,
      start: wallTimeAt(startInstant, zone), end: wallTimeAt(endInstant, zone), timezone: zone ?? null, allDay: args.allDay,
      durationMinutes: args.durationMinutes, startInstant, endInstant });
    return { eventId: eid };
  });
  const remove = vi.spyOn(cal, 'deleteEvent').mockImplementation(async ({ eventId }) => ({ deleted: events.delete(eventId) }));
  const sync = new CalSync(cal, 'work', store); fixtures.push({ dir, store, sync });
  return { dir, store, sync, id, cal, events, list, get, upsert, remove, action: () => storeAction(store, id)!, file: store.getActionFile(id)! };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('floating Calendar save confirmation', () => {
  it('accepts a real floating gap clock and resolves its normal local instant, keeping named-zone gaps invalid', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(schedulingIssues({ scheduled: '2026-03-08T02:30' })).toEqual([]);
    expect(scheduleInstant('2026-03-08T02:30')).toBe(Date.parse('2026-03-08T10:30Z'));
    expect(wallTimeAt(scheduleInstant('2026-03-08T02:30')!)).toBe('2026-03-08T03:30');
    expect(scheduleInstant('2026-03-08T02:30', 'America/Los_Angeles')).toBeUndefined();
    expect(schedulingIssues({ scheduled: '2026-03-08T02:30', timezone: 'America/Los_Angeles' })[0]).toContain('scheduled:');
    expect(scheduleInstant('2026-02-30T02:30')).toBeUndefined();
  });
  it.each([false, true])('immediately imports its own normalized floating save and certifies the canonical version (done=%s)', async done => {
    const f = fixture({ done });
    expect(f.action().frontMatter.scheduled).toBe('2026-03-08T02:30');
    const saving = f.upsert.getMockImplementation()!;
    f.upsert.mockImplementation(async args => { expect(f.action().frontMatter.scheduled).toBe('2026-03-08T02:30'); return saving(args); });
    expect((await f.sync.syncActions([f.action()], [f.action()]))[0]).toMatchObject({ status: 'synced', eventId: 'event' });
    expect(f.get).toHaveBeenCalledWith({ eventIds: ['event'] });
    expect(f.action().frontMatter).toMatchObject({ scheduled: '2026-03-08T03:30', ...(done ? { resolution: 'done' } : {}) });
    expect(f.action().frontMatter.timezone).toBeUndefined(); expect(f.action().frontMatter.duration).toBeUndefined();
    expect(f.sync.status(f.id)).toMatchObject({ status: 'synced', eventId: 'event' }); expect(f.sync.report()).toEqual([]);
    await f.sync.reconcile([f.action()]); await f.sync.reconcile([f.action()]); await f.sync.syncActions([], [f.action()]);
    expect(f.upsert).toHaveBeenCalledOnce(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.sync.status(f.id)?.status).toBe('synced');
  });
  it.each(['\n', '\r\n'])('preserves indented Markdown bytes while Calendar imports a normalized scheduling field with newline %j', async newline => {
    const f = fixture();
    const original = readFileSync(f.file, 'utf8');
    const metadata = original.match(/^---\n([\s\S]*?)\n---/)![1].replace(/\n/g, newline);
    const tail = `${newline}${newline}    indented code${newline}    second line${newline}${newline}${newline}`;
    writeFileSync(f.file, `---${newline}${metadata}${newline}---${tail}`);
    f.store.rebuild();
    expect((await f.sync.syncActions([f.action()], [f.action()]))[0].status).toBe('synced');
    expect(f.action().frontMatter.scheduled).toBe('2026-03-08T03:30');
    const saved = readFileSync(f.file, 'utf8');
    expect(saved.slice(saved.indexOf(`${newline}---`) + newline.length + 3)).toBe(tail);
  });
  it.each([
    ['2026-03-08T01:45', undefined, '2026-03-08T03:15', 30],
    ['2026-03-07T10:00', 'P1D', '2026-03-08T11:00', 1440],
    ['2026-10-31T10:00', 'P1D', '2026-11-01T09:00', 1440],
  ] as const)('confirms fixed elapsed duration across clock changes (%s)', async (scheduled, duration, end, minutes) => {
    const f = fixture({ scheduled, duration }); await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.events.get('event')).toMatchObject({ start: scheduled, end, durationMinutes: minutes });
    expect(f.action().frontMatter).toMatchObject({ scheduled }); expect(f.action().frontMatter.duration).toBe(duration);
    await f.sync.reconcile([f.action()]); expect(f.upsert).toHaveBeenCalledOnce(); expect(f.sync.report()).toEqual([]);
  });
  it('keeps the authored value and receipt pending while saved-event confirmation is outstanding', async () => {
    const f = fixture(), entered = deferred<void>(), response = deferred<{ events: CalEvent[] }>();
    f.get.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const saving = f.sync.syncActions([f.action()], [f.action()]); await entered.promise;
    expect(f.action().frontMatter.scheduled).toBe('2026-03-08T02:30'); expect(f.sync.status(f.id)?.status).toBe('pending');
    response.resolve({ events: [...f.events.values()] }); await saving;
    expect(f.action().frontMatter.scheduled).toBe('2026-03-08T03:30'); expect(f.sync.status(f.id)?.status).toBe('synced');
  });
  it.each(['missing', 'unreachable', 'foreign'] as const)('retries %s confirmation using the saved ID without another upsert or deletion', async failure => {
    const f = fixture();
    if (failure === 'unreachable') f.get.mockRejectedValueOnce(new Error('confirmation transport failed'));
    else f.get.mockImplementationOnce(async () => ({ events: failure === 'missing' ? [] : [{ ...f.events.get('event')!, url: buildMarker('other', f.id, 'active') }] }));
    expect((await f.sync.syncActions([f.action()], [f.action()]))[0].status).toBe('error');
    expect(f.action().frontMatter.scheduled).toBe('2026-03-08T02:30'); expect(f.sync.status(f.id)).toMatchObject({ status: 'pending', retry: true });
    f.list.mockResolvedValue({ events: [] }); f.get.mockResolvedValueOnce({ events: [] });
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.scheduled).toBe('2026-03-08T02:30'); expect(f.remove).not.toHaveBeenCalled();
    await f.sync.syncActions([], [f.action()]);
    expect(f.action().frontMatter.scheduled).toBe('2026-03-08T03:30'); expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.sync.status(f.id)?.status).toBe('synced'); expect(f.sync.report()).toEqual([]);
  });
  it('does not canonicalize after a failed save', async () => {
    const f = fixture(); f.upsert.mockRejectedValueOnce(new Error('save failed'));
    await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.get).not.toHaveBeenCalled(); expect(f.action().frontMatter.scheduled).toBe('2026-03-08T02:30');
    expect(f.sync.status(f.id)?.status).toBe('pending');
  });
  it('preserves a concurrent whole-file edit and subsequently saves its current state using the retained ID', async () => {
    const f = fixture(), entered = deferred<void>(), response = deferred<{ events: CalEvent[] }>();
    f.get.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const saving = f.sync.syncActions([f.action()], [f.action()]); await entered.promise;
    const before = readFileSync(f.file, 'utf8');
    writeFileSync(f.file, before.replace('name: Review', 'name: Revised').replace('2026-03-08T02:30', '2026-03-08T04:00') + '\nConcurrent body edit\n');
    const changed = readFileSync(f.file, 'utf8');
    response.resolve({ events: [...f.events.values()] }); expect((await saving)[0].status).toBe('error');
    expect(readFileSync(f.file, 'utf8')).toBe(changed); expect(f.sync.status(f.id)?.status).toBe('pending');
    f.store.rebuild(); await f.sync.syncActions([], [f.action()]);
    expect(f.upsert).toHaveBeenCalledTimes(2); expect(f.upsert.mock.calls[1][0]).toMatchObject({ eventId: 'event', start: '2026-03-08T04:00', title: '▢ Revised' });
    expect(readFileSync(f.file, 'utf8')).toBe(changed); expect(f.sync.status(f.id)?.status).toBe('synced');
  });
  it('never writes a normalized result across an instance identity change during readback', async () => {
    const f = fixture(), entered = deferred<void>(), response = deferred<{ events: CalEvent[] }>();
    f.get.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const saving = f.sync.syncActions([f.action()], [f.action()]); await entered.promise;
    writeFileSync(join(f.dir, 'aside.md'), '---\nid: other\n---\n'); response.resolve({ events: [...f.events.values()] });
    expect((await saving)[0].status).toBe('error'); expect(f.action().frontMatter.scheduled).toBe('2026-03-08T02:30');
    expect(f.sync.status(f.id)?.status).toBe('pending'); expect(f.upsert).toHaveBeenCalledOnce();
  });
  it('requires actual canonical wall metadata rather than accepting contradictory gap text', async () => {
    const f = fixture(); f.get.mockImplementationOnce(async () => ({ events: [{ ...f.events.get('event')!, start: '2026-03-08T02:30' }] }));
    expect((await f.sync.syncActions([f.action()], [f.action()]))[0]).toMatchObject({ status: 'error', code: 'event-time-unrepresentable' });
    expect(f.action().frontMatter.scheduled).toBe('2026-03-08T02:30'); expect(f.sync.status(f.id)?.status).toBe('failed');
    expect(eventTimingDiagnostic({ ...f.events.get('event')!, start: '2026-03-08T02:30' })?.reason).toContain('start wall time disagrees');
  });
  it('normalizes an own save made while reverse repair restores a scheduled done action', async () => {
    const f = fixture({ done: true }), startInstant = Date.parse('2026-03-08T10:30Z');
    f.events.set('event', { id: 'event', calendar: 'Work', title: '✓ Review', url: buildMarker('work', f.id, 'done'), start: '2026-03-08T03:30', end: '2026-03-08T04:00', timezone: null, startInstant, endInstant: startInstant + 30 * 60000, durationMinutes: 30 });
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter).toMatchObject({ scheduled: '2026-03-08T03:30', resolution: 'done' });
    expect(f.upsert).toHaveBeenCalledOnce(); expect(f.sync.status(f.id)?.status).toBe('synced');
    await f.sync.reconcile([f.action()]); expect(f.upsert).toHaveBeenCalledOnce();
  });
  it('queues confirmation failures during reverse repair rather than importing a later missing read as deletion', async () => {
    const f = fixture({ done: true }), startInstant = Date.parse('2026-03-08T10:30Z');
    f.events.set('event', { id: 'event', calendar: 'Work', title: '✓ Review', url: buildMarker('work', f.id, 'done'), start: '2026-03-08T03:30', end: '2026-03-08T04:00', timezone: null, startInstant, endInstant: startInstant + 30 * 60000, durationMinutes: 30 });
    f.get.mockRejectedValueOnce(new Error('confirmation failed')); await f.sync.reconcile([f.action()]);
    expect(f.sync.status(f.id)).toMatchObject({ status: 'pending', retry: true }); expect(f.action().frontMatter.scheduled).toBe('2026-03-08T02:30');
    await f.sync.syncActions([], [f.action()]);
    expect(f.action().frontMatter.scheduled).toBe('2026-03-08T03:30'); expect(f.upsert).toHaveBeenCalledOnce(); expect(f.sync.report()).toEqual([]);
  });
  it.each([{ scheduled: '2026-03-08', timezone: undefined }, { scheduled: '2026-03-08T02:30', timezone: 'UTC' }])('keeps all-day dates and named-zone forward rules (%j)', async fields => {
    const f = fixture(fields); await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.get).not.toHaveBeenCalled(); expect(f.action().frontMatter.scheduled).toBe(fields.scheduled); expect(f.sync.status(f.id)?.status).toBe('synced');
  });
});

it.skipIf(process.platform !== 'darwin')('native parser permits only floating normalization and an unsaved EventKit object retains the effective time', () => {
  const dir = mkdtempSync('/tmp/aside-floating-native-');
  try {
    const native = readFileSync(new URL('../native/aside-cal/main.swift', import.meta.url), 'utf8');
    const functions = native.slice(native.indexOf('func parseWall('), native.indexOf('// A timed calendar event'));
    const probe = `import Foundation\nimport EventKit\n${functions}\n
let la = TimeZone(identifier: "America/Los_Angeles")!
let normalized = parseWall("2026-03-08T02:30", la, normalizeFloating: true)!
precondition(isoWall(normalized, la) == "2026-03-08T03:30")
precondition(parseWall("2026-03-08T02:30", la) == nil)
for invalid in ["2026-02-30T02:30", "2026-01-01T24:00", "0000-01-01T02:30", "2026-01-01T02:60"] {
  precondition(parseWall(invalid, la, normalizeFloating: true) == nil)
}
let event = EKEvent(eventStore: EKEventStore())
event.startDate = normalized
event.endDate = normalized.addingTimeInterval(1800)
event.timeZone = nil
precondition(event.timeZone == nil)
precondition(isoWall(event.startDate, la) == "2026-03-08T03:30")
precondition(isoWall(event.endDate, la) == "2026-03-08T04:00")
print("floating=03:30 named-gap=invalid invalid-civil=invalid unsaved-event=03:30→04:00")\n`;
    const source = join(dir, 'probe.swift'), binary = join(dir, 'probe'); writeFileSync(source, probe);
    execFileSync('xcrun', ['swiftc', '-module-cache-path', join(dir, 'modules'), source, '-o', binary], { timeout: 60000 });
    expect(execFileSync(binary, { encoding: 'utf8', timeout: 10000 })).toContain('floating=03:30 named-gap=invalid invalid-civil=invalid unsaved-event=03:30→04:00');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 75000);
