import { eventTimes } from './calendar-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync, storeAction } from '../src/mcp/calendar/sync.js';
import { buildMarker } from '../src/mcp/calendar/markers.js';
import type { CalEvent } from '../src/mcp/calendar/protocol.js';

const dirs: string[] = [], syncers: CalSync[] = [];
afterEach(() => {
  for (const sync of syncers.splice(0)) sync.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function fixture(scheduled: string, duration?: string) {
  const dir = mkdtempSync('/tmp/aside-elapsed-'); dirs.push(dir);
  writeFileSync(join(dir, 'aside.md'), '---\nid: work\n---\n');
  const store = new Store(dir);
  const result = handleCapture(store, { content: 'Deploy.', description: 'Deploy', actions: [{ name: 'Deploy', description: 'Deploy', calendar: 'Work', scheduled, duration, timezone: 'America/Los_Angeles' }] }, new Date('2026-03-01T09:00:00'));
  const id = result.createdActionIds[0];
  const cal = new CalClient(null);
  vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] });
  const list = vi.spyOn(cal, 'listEvents').mockResolvedValue({ events: [] });
  const get = vi.spyOn(cal, 'getEvents').mockResolvedValue({ events: [] });
  const upsert = vi.spyOn(cal, 'upsertEvent').mockResolvedValue({ eventId: 'event' });
  vi.spyOn(cal, 'deleteEvent').mockResolvedValue({ deleted: true });
  const sync = new CalSync(cal, 'work', store); syncers.push(sync);
  const event = (end: string, durationMinutes?: number): CalEvent => eventTimes({ id: 'event', url: buildMarker('work', id, 'active'), calendar: 'Work', title: '▢ Deploy', start: scheduled.includes('T') ? scheduled : `${scheduled}T00:00`, end, durationMinutes }, 'America/Los_Angeles');
  const actual = (ev: CalEvent) => { list.mockResolvedValue({ events: [ev] }); get.mockResolvedValue({ events: [ev] }); };
  return { store, id, sync, upsert, actual, event, action: () => storeAction(store, id)! };
}

describe('fixed elapsed calendar duration', () => {
  // These helper responses describe instants across Los Angeles clock changes:
  // Mar 7 10:00 PST -> Mar 8 11:00 PDT and Oct 31 10:00 PDT -> Nov 1 09:00 PST.
  it.each([
    ['spring forward', '2026-03-07T10:00', '2026-03-08T11:00', 'P1D', 1440],
    ['fall back', '2026-10-31T10:00', '2026-11-01T09:00', 'P1D', 1440],
    ['default crossing the gap', '2026-03-08T01:45', '2026-03-08T03:15', undefined, 30],
  ] as const)('preserves duration and converges after %s', async (_, start, end, duration, minutes) => {
    const f = fixture(start, duration);
    await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.upsert.mock.calls[0][0]).toMatchObject({ start, timezone: 'America/Los_Angeles', durationMinutes: minutes });
    f.actual(f.event(end, minutes));
    await f.sync.reconcile([f.action()]);
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.duration).toBe(duration);
    expect(f.action().frontMatter.scheduled).toBe(start);
    expect(f.sync.changesSinceStart()).toEqual([]);
    expect(f.sync.report()).toEqual([]);
    expect(f.sync.status(f.id)?.status).toBe('synced');
    expect(f.upsert).toHaveBeenCalledOnce();
  });

  it('adopts a cold elapsed-duration event without importing its 23-hour wall span', async () => {
    const f = fixture('2026-10-31T10:00', 'P1D'); f.actual(f.event('2026-11-01T09:00', 1440));
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.duration).toBe('P1D');
    expect(f.sync.changesSinceStart()).toEqual([]);
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it('imports a genuine resize using elapsed minutes rather than the wall span', async () => {
    const f = fixture('2026-03-07T10:00', 'P1D');
    await f.sync.syncActions([f.action()], [f.action()]);
    // Mar 7 10 PST -> Mar 8 10 PDT is a 23-hour resize, despite a 24-hour wall span.
    f.actual(f.event('2026-03-08T10:00', 1380)); await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.duration).toBe('PT23H');
    expect(f.sync.changesSinceStart()).toContainEqual({ id: f.id, summary: 'resized to PT23H' });
    expect(f.upsert).toHaveBeenCalledOnce();
  });

  it('imports a move across the clock transition without changing its elapsed duration', async () => {
    const f = fixture('2026-03-07T10:00', 'P1D');
    await f.sync.syncActions([f.action()], [f.action()]);
    f.actual({ ...f.event('2026-03-09T11:00', 1440), start: '2026-03-08T11:00', startInstant: Date.parse('2026-03-08T18:00:00Z'), endInstant: Date.parse('2026-03-09T18:00:00Z') });
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter).toMatchObject({ scheduled: '2026-03-08T11:00', duration: 'P1D' });
    expect(f.upsert).toHaveBeenCalledOnce();
  });

  it('derives a resize from actual instants when elapsed minutes are omitted', async () => {
    const f = fixture('2026-05-15T10:00', 'PT30M'); f.actual(f.event('2026-05-15T11:00'));
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.duration).toBe('PT1H'); expect(f.upsert).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, NaN, Infinity])('rejects invalid elapsed metadata %s before writing an action', async minutes => {
    const f = fixture('2026-03-07T10:00', 'P1D');
    const file = f.store.getActionFile(f.id)!, before = readFileSync(file, 'utf8');
    f.actual(f.event('2026-03-08T11:00', minutes)); await f.sync.reconcile([f.action()]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(f.sync.report()[0].reason).toContain('duration:'); expect(f.upsert).not.toHaveBeenCalled();
  });

  it('keeps all-day events date based and ignores their physical elapsed length', async () => {
    const f = fixture('2026-03-08', 'P1D'); await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.upsert.mock.calls[0][0]).toMatchObject({ start: '2026-03-08T00:00', end: '2026-03-08T00:00', allDay: true });
    expect(f.upsert.mock.calls[0][0]).not.toHaveProperty('durationMinutes');
    f.actual({ ...f.event('2026-03-09T00:00', 1380), allDay: true }); await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.duration).toBe('P1D'); expect(f.sync.changesSinceStart()).toEqual([]); expect(f.upsert).toHaveBeenCalledOnce();
  });
});
