import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/source/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync, desiredFromAction, importFromEvent, storeAction } from '../src/mcp/calendar/sync.js';
import { actionLocationIssues, calendarLocation, sameCalendarLocation } from '../src/mcp/calendar/location.js';
import { savedEvent } from './calendar-fixture.js';
import type { CalEvent } from '../src/mcp/calendar/protocol.js';

const office = '#location/?geo=37.7614,-122.4241&postal=Tartine%20Bakery/600%20Guerrero%20St/San%20Francisco/';
const other = '#location/?geo=51.5,-0.12&postal=London/GB/';
const fixtures: Array<{dir: string; store: Store; sync: CalSync}> = [];
function editLocation(file: string, value: string): void {
  // YAML may wrap a long quoted scalar over continuation lines.
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^location:[^\n]*(?:\n[ \t]+[^\n]*)*/m,
    'location: ' + JSON.stringify(value)));
}
afterEach(() => {
  for (const f of fixtures.splice(0)) { f.sync.dispose(); f.store.close(); rmSync(f.dir, {recursive: true, force: true}); }
  vi.restoreAllMocks();
});

function fixture(location: string | undefined = office, floating = false) {
  const dir = mkdtempSync('/tmp/aside-location-calendar-');
  writeFileSync(join(dir, 'aside.md'), '---\nid: work\n---\n');
  const store = new Store(dir);
  const id = handleCapture(store, {content: 'Meeting', description: 'Meeting', actions: [{
    name: 'Meeting', description: 'Meeting', calendar: 'Work', scheduled: '2026-10-31T10:00',
    ...(!floating ? {timezone: 'UTC'} : {}), location, body: 'Other mention: ' + other,
  }]}).createdActionIds[0];
  const cal = new CalClient(null), events = new Map<string, CalEvent>();
  vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({status: 'fullAccess'});
  const calendars = [{id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV'}];
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({calendars});
  vi.spyOn(cal, 'listEvents').mockImplementation(async () => ({events: [...events.values()]}));
  const get = vi.spyOn(cal, 'getEvents').mockImplementation(async ({eventIds}) => ({
    events: eventIds.flatMap(id => events.has(id) ? [events.get(id)!] : []),
  }));
  const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {
    const saved = savedEvent(args, args.eventId ?? 'event');
    events.set(saved.id, saved);
    return {eventId: saved.id};
  });
  const sync = new CalSync(cal, 'work', store);
  fixtures.push({dir, store, sync});
  const action = () => storeAction(store, id)!;
  return {store, sync, id, events, get, upsert, calendars, action,
    file: store.getActionFile(id)!,
    forward: () => sync.syncActions([action()], [action()])};
}

describe('one-way action location export', () => {
  it.each([
    ['#location/?postal=Tartine%20Bakery/600%20Guerrero%20St/', {title: 'Tartine Bakery, 600 Guerrero St'}],
    ['#location/?geo=1,2', {title: '1, 2', latitude: 1, longitude: 2}],
    ['#location/?geo=1,2,3;u=4&postal=Office/', {title: 'Office', latitude: 1, longitude: 2}],
  ] as const)('maps saved handle %s without looking at its label or body', (location, expected) => {
    expect(calendarLocation(location)).toEqual(expected);
    const desired = desiredFromAction({id: 'meeting', frontMatter: {
      name: 'Meeting', created: '2026-10-31', scheduled: '2026-10-31T10:00', calendar: 'Work', location,
    }, body: '[An unrelated label](' + other + ')'}, 'work', {active: '', done: ''});
    expect(desired).toMatchObject({have: true, up: {location: expected}});
  });

  it('requires a valid complete handle and uses explicit null to remove a venue', () => {
    expect(calendarLocation(undefined)).toBeNull();
    for (const invalid of ['', 'London', '[Office](' + office + ')', office + '&unknown=x']) {
      expect(actionLocationIssues(invalid)).not.toEqual([]);
      expect(() => calendarLocation(invalid)).toThrow('location:');
    }
    expect(actionLocationIssues(null)).not.toEqual([]);
  });

  it('compares returned positions without treating default altitude as authored data', () => {
    expect(sameCalendarLocation(null, undefined)).toBe(true);
    expect(sameCalendarLocation({title: 'Point', latitude: 1, longitude: 2}, {title: 'Point', latitude: 1, longitude: 2, altitude: 0})).toBe(true);
    expect(sameCalendarLocation({title: 'Point', latitude: 1, longitude: 2, altitude: 4}, {title: 'Point', latitude: 1, longitude: 2})).toBe(false);
    expect(sameCalendarLocation({title: 'Office'}, {title: 'Office', latitude: 1, longitude: 2})).toBe(false);
  });

  it.each([false, true])('exports then updates and clears location without changing event timing (floating=%s)', async floating => {
    const f = fixture(office, floating);
    expect((await f.forward())[0].status).toBe('synced');
    expect(f.events.get('event')?.location).toEqual(calendarLocation(office));
    const before = f.events.get('event')!;
    handleUpdateAction(f.store, {id: f.id, location: other});
    expect((await f.forward())[0].status).toBe('synced');
    expect(f.events.get('event')).toMatchObject({location: calendarLocation(other), start: before.start, end: before.end});
    handleUpdateAction(f.store, {id: f.id, location: null});
    expect((await f.forward())[0].status).toBe('synced');
    expect(f.events.get('event')?.location).toBeNull();
    expect(f.action().frontMatter.location).toBeUndefined();
  });

  it('restores Calendar location edits without importing them or rewriting the action file', async () => {
    const f = fixture();
    await f.forward();
    const authored = readFileSync(f.file, 'utf8');
    f.events.get('event')!.location = calendarLocation(other);
    await f.sync.reconcile([f.action()]);
    expect(f.upsert).toHaveBeenCalledTimes(2);
    expect(f.events.get('event')?.location).toEqual(calendarLocation(office));
    expect(readFileSync(f.file, 'utf8')).toBe(authored);
    await f.sync.reconcile([f.action()]);
    expect(f.upsert).toHaveBeenCalledTimes(2);
    const imported = importFromEvent(f.action(), {...f.events.get('event')!, location: calendarLocation(other)}, f.calendars);
    expect(imported.fm.location).toBe(office);
    expect(imported.summaries).toEqual([]);
  });

  it.each([false, true])('converges when the Calendar store discards altitude, preserving the authored handle (floating=%s)', async floating => {
    const handle = '#location/?geo=37.7614,-122.4241,12.5;u=8&postal=Office/';
    const f = fixture(handle, floating);
    const save = f.upsert.getMockImplementation()!;
    f.upsert.mockImplementation(async args => {
      const result = await save(args);
      const venue = f.events.get(result.eventId)?.location;
      if (venue) delete venue.altitude;
      return result;
    });
    expect((await f.forward())[0].status).toBe('synced');
    const source = readFileSync(f.file, 'utf8');
    await f.sync.reconcile([f.action()]);
    await f.sync.reconcile([f.action()]);
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.events.get('event')?.location).toEqual({title: 'Office', latitude: 37.7614, longitude: -122.4241});
    expect(f.action().frontMatter.location).toBe(handle);
    expect(readFileSync(f.file, 'utf8')).toBe(source);
  });

  it('blocks invalid saved location data before touching the existing event', async () => {
    const f = fixture();
    await f.forward();
    const before = structuredClone(f.events.get('event'));
    editLocation(f.file, 'not-a-location-handle');
    f.store.rebuild();
    expect(f.action().frontMatter.location).toBe('not-a-location-handle');
    expect((await f.forward())[0]).toMatchObject({status: 'error', reason: expect.stringContaining('location:')});
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.events.get('event')).toEqual(before);
  });

  it('preserves a concurrent on-disk location edit during Calendar timing imports', async () => {
    const f = fixture();
    await f.forward();
    const event = f.events.get('event')!;
    f.events.set('event', {...event, start: '2026-10-31T11:00', end: '2026-10-31T11:30',
      startInstant: event.startInstant + 3600000, endInstant: event.endInstant + 3600000});
    f.get.mockImplementationOnce(async () => {
      editLocation(f.file, other);
      return {events: [f.events.get('event')!]};
    });
    await f.sync.reconcile([f.action()]);
    const source = readFileSync(f.file, 'utf8');
    expect(source).toContain(other);
    expect(source).toContain('2026-10-31T10:00');
    expect(f.upsert).toHaveBeenCalledOnce();
  });
});
