import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync, storeAction } from '../src/mcp/calendar/sync.js';
import { buildMarker } from '../src/mcp/calendar/markers.js';
import { eventTimes, savedEvent } from './calendar-fixture.js';

const fixtures: Array<{ dir: string; store: Store; sync: CalSync }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.sync.dispose(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }); } vi.restoreAllMocks(); });
function fixture(zone?: string) {
  const dir = mkdtempSync('/tmp/aside-calendar-zone-');
  writeFileSync(join(dir, 'aside.md'), '---\nid: work\n---\n');
  const store = new Store(dir);
  const { createdActionIds: [id] } = handleCapture(store, { content: 'Review', description: 'Review', actions: [{ name: 'Review', description: 'Review', scheduled: '2026-03-08T01:00', timezone: zone, calendar: 'Work' }] }, new Date('2026-03-01T09:00'));
  const cal = new CalClient(null);
  vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] });
  const list = vi.spyOn(cal, 'listEvents').mockResolvedValue({ events: [] });
  const get = vi.spyOn(cal, 'getEvents').mockResolvedValue({ events: [] });
  const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {
    get.mockResolvedValue({ events: [savedEvent(args)] });
    return { eventId: 'event' };
  });
  const remove = vi.spyOn(cal, 'deleteEvent').mockResolvedValue({ deleted: true });
  const sync = new CalSync(cal, 'work', store); fixtures.push({ dir, store, sync });
  const actual = (timezone: string | null, start = '2026-03-08T01:00', end = '2026-03-08T01:30') => {
    const ev = eventTimes({ id: 'event', url: buildMarker('work', id, 'active'), calendar: 'Work', title: '▢ Review', start, end, durationMinutes: 30 }, timezone);
    list.mockResolvedValue({ events: [ev] }); get.mockResolvedValue({ events: [ev] }); return ev;
  };
  return { dir, id, store, sync, actual, upsert, remove, action: () => storeAction(store, id)! };
}

describe('calendar timezone round trips', () => {
  it.each([['UTC', 'GMT'], ['Etc/UTC', 'UTC'], ['US/Pacific', 'America/Los_Angeles']])('retains the authored %s when Calendar reports its alias %s', async (authored, reported) => {
    const f = fixture(authored);
    await f.sync.syncActions([f.action()], [f.action()]);
    const path = f.store.getActionFile(f.id)!, before = readFileSync(path, 'utf8');
    f.actual(reported);
    await f.sync.reconcile([f.action()]);
    await f.sync.reconcile([f.action()]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(f.sync.changesSinceStart()).toEqual([]);
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.sync.status(f.id)?.status).toBe('synced');
    expect(f.sync.report()).toEqual([]);
  });
  it('imports a distinct named zone even when its current offset is identical', async () => {
    const f = fixture('UTC');
    await f.sync.syncActions([f.action()], [f.action()]);
    f.actual('Europe/London'); // March 8 is before the London clock transition.
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.timezone).toBe('Europe/London');
    expect(f.sync.changesSinceStart()).toContainEqual({ id: f.id, summary: 'timezone UTC -> Europe/London' });
    expect(f.upsert).toHaveBeenCalledOnce();
  });
  it('imports a calendar-origin zone change together with its wall time', async () => {
    const f = fixture('America/Los_Angeles');
    await f.sync.syncActions([f.action()], [f.action()]);
    const ev = f.actual('UTC', '2026-03-08T02:30', '2026-03-08T03:00');
    expect(ev.startInstant).toBe(Date.parse('2026-03-08T02:30:00Z'));
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter).toMatchObject({ scheduled: '2026-03-08T02:30', timezone: 'UTC' });
    expect(f.sync.report()).toEqual([]); expect(f.upsert).toHaveBeenCalledOnce();
    await f.sync.reconcile([f.action()]);
    expect(f.upsert).toHaveBeenCalledOnce(); expect(f.sync.status(f.id)?.status).toBe('synced');
  });
  it.each([[undefined, 'Asia/Tokyo'], ['America/Los_Angeles', null], [undefined, 'UTC'], ['UTC', null]] as const)('preserves the distinction from %s to %s', async (original, next) => {
    const f = fixture(original); await f.sync.syncActions([f.action()], [f.action()]); f.actual(next);
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.timezone).toBe(next ?? undefined);
    expect(f.sync.changesSinceStart()).toContainEqual({ id: f.id, summary: `timezone ${original ?? 'floating'} -> ${next ?? 'floating'}` });
    expect(f.upsert).toHaveBeenCalledOnce();
  });
  it('diagnoses an unrecognized calendar zone without silently using local time', async () => {
    const f = fixture('America/Los_Angeles'), file = f.store.getActionFile(f.id)!, before = readFileSync(file, 'utf8');
    f.actual('Mars/Olympus'); await f.sync.reconcile([f.action()]);
    expect(readFileSync(file, 'utf8')).toBe(before); expect(f.sync.report()[0].reason).toContain('timezone:');
    expect(f.upsert).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
});
