import { eventTimes, savedEvent } from './calendar-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync, storeAction } from '../src/mcp/calendar/sync.js';
import { buildMarker } from '../src/mcp/calendar/markers.js';
import { calendarRoutingError } from '../src/mcp/calendar/routing.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import type { CalCalendar, CalEvent } from '../src/mcp/calendar/protocol.js';

const calendar = (name: string, account: string, writable = true): CalCalendar => ({ id: `${account}-${name}`, name, account, writable, type: 'calDAV' });
const dirs: string[] = [];
const syncers: CalSync[] = [];
afterEach(() => { for (const sync of syncers.splice(0)) sync.dispose(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

function fixture(calendars: CalCalendar[], account?: string) {
  const dir = mkdtempSync('/tmp/aside-routing-'); dirs.push(dir);
  writeFileSync(join(dir, 'aside.md'), '---\nid: work\n---\n');
  const store = new Store(dir);
  const result = handleCapture(store, { content: 'I will deploy.', description: 'Deploy', actions: [{ name: 'Deploy', description: 'Deploy', scheduled: '2026-05-15T10:00', calendar: 'Work', calendar_account: account }] }, new Date('2026-05-15T09:00:00'));
  const id = result.createdActionIds[0];
  const cal = new CalClient(null);
  vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  const list = vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars });
  const events = vi.spyOn(cal, 'listEvents').mockResolvedValue({ events: [] });
  const get = vi.spyOn(cal, 'getEvents').mockResolvedValue({ events: [] });
  const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {
    get.mockResolvedValue({ events: [savedEvent(args)] });
    return { eventId: 'event' };
  });
  const remove = vi.spyOn(cal, 'deleteEvent').mockResolvedValue({ deleted: true });
  const sync = new CalSync(cal, 'work', store); syncers.push(sync);
  return { store, id, cal, list, events, get, upsert, remove, sync, action: () => storeAction(store, id)! };
}

function event(id: string, account: string, name = 'Work'): CalEvent {
  return eventTimes({ id: 'event', url: buildMarker('work', id, 'active'), calendar: name, calendar_account: account, title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' });
}

describe('readable calendar routing', () => {
  it('requires one name or name/account match, including duplicate account names', () => {
    const calendars = [calendar('Work', 'iCloud'), calendar('Work', 'Google')];
    expect(calendarRoutingError(calendars, { calendar: 'Work' })?.code).toBe('calendar-ambiguous');
    expect(calendarRoutingError(calendars, { calendar: 'Work', calendar_account: 'Google' })).toBeUndefined();
    expect(calendarRoutingError(calendars, { calendar: 'Work', calendar_account: 'Missing' })?.code).toBe('calendar-not-found');
    expect(calendarRoutingError([calendar('Work', 'Google'), calendar('Work', 'Google')], { calendar: 'Work', calendar_account: 'Google' })?.code).toBe('calendar-ambiguous');
    expect(calendarRoutingError([calendar('Work', 'Google', false)], { calendar: 'Work' })?.code).toBe('calendar-read-only');
  });

  it('persists and patches the account while omitting it for unique names', () => {
    const f = fixture([calendar('Work', 'iCloud')]);
    expect(readFileSync(f.store.getActionFile(f.id)!, 'utf8')).not.toContain('calendar_account');
    handleUpdateAction(f.store, { id: f.id, calendar_account: 'Google' });
    f.store.rebuild(); expect(f.action().frontMatter.calendar_account).toBe('Google');
    handleUpdateAction(f.store, { id: f.id, description: 'Updated' });
    expect(f.action().frontMatter.calendar_account).toBe('Google');
    handleUpdateAction(f.store, { id: f.id, calendar_account: null });
    expect(readFileSync(f.store.getActionFile(f.id)!, 'utf8')).not.toContain('calendar_account');
  });

  it('blocks ambiguous forward routing, then routes a supplied account exactly', async () => {
    const f = fixture([calendar('Work', 'iCloud'), calendar('Work', 'Google')]);
    expect((await f.sync.syncActions([f.action()], [f.action()]))[0].code).toBe('calendar-ambiguous');
    expect(f.upsert).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    handleUpdateAction(f.store, { id: f.id, calendar_account: 'Google' });
    await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.upsert.mock.calls[0][0]).toMatchObject({ calendar: 'Work', calendar_account: 'Google' });
  });

  it.each(['missing', 'ambiguous', 'read-only'])('does not deschedule a cold action with a %s route', async kind => {
    const calendars = kind === 'missing' ? [] : kind === 'ambiguous' ? [calendar('Work', 'iCloud'), calendar('Work', 'Google')] : [calendar('Work', 'iCloud', false)];
    const f = fixture(calendars);
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.scheduled).toBe('2026-05-15T10:00');
    expect(f.sync.report().some(item => item.id === f.id && item.reason.includes('calendar'))).toBe(true);
    expect(f.upsert).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });

  it('keeps a repaired route queued instead of interpreting its missing event as deletion', async () => {
    const f = fixture([]);
    await f.sync.reconcile([f.action()]);
    f.list.mockResolvedValue({ calendars: [calendar('Work', 'iCloud')] });
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.scheduled).toBe('2026-05-15T10:00');
    expect(f.sync.status(f.id)).toMatchObject({ status: 'pending', retry: true });
    await f.sync.syncActions([], [f.action()]);
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.action().frontMatter.scheduled).toBe('2026-05-15T10:00');
  });

  it('imports a move to another account with the same calendar name', async () => {
    const f = fixture([calendar('Work', 'iCloud'), calendar('Work', 'Google')], 'iCloud');
    f.events.mockResolvedValue({ events: [event(f.id, 'Google')] });
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.calendar_account).toBe('Google');
    expect(f.sync.changesSinceStart()).toContainEqual({ id: f.id, summary: 'moved to the Work (Google) calendar' });
    expect(f.events.mock.calls.every(([args]) => args.calendars === undefined)).toBe(true);
  });

  it('relocates a reassigned event across accounts and calendar names', async () => {
    const f = fixture([calendar('Work', 'iCloud'), calendar('Personal', 'Google')], 'iCloud');
    f.events.mockResolvedValueOnce({ events: [event(f.id, 'iCloud')] });
    await f.sync.reconcile([f.action()]);
    f.events.mockResolvedValue({ events: [{ ...event(f.id, 'Google', 'Personal'), id: 'moved-event' }] });
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter).toMatchObject({ calendar: 'Personal', calendar_account: 'Google', scheduled: '2026-05-15T10:00' });
    expect(f.events.mock.calls.every(([args]) => args.calendars === undefined)).toBe(true);
  });

  it('keeps omitted account metadata omitted when a unique event remains in place', async () => {
    const f = fixture([calendar('Work', 'iCloud')]); f.events.mockResolvedValue({ events: [event(f.id, 'iCloud')] });
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.calendar_account).toBeUndefined();
  });

  it('blocks newly ambiguous routing on a warm reconcile without overwriting the action', async () => {
    const f = fixture([calendar('Work', 'iCloud')]); f.events.mockResolvedValue({ events: [event(f.id, 'iCloud')] });
    await f.sync.reconcile([f.action()]);
    f.list.mockResolvedValue({ calendars: [calendar('Work', 'iCloud'), calendar('Work', 'Google')] });
    await f.sync.reconcile([f.action()]);
    expect(f.action().frontMatter.scheduled).toBe('2026-05-15T10:00');
    expect(f.sync.status(f.id)?.status).toBe('failed');
    expect(f.upsert).not.toHaveBeenCalled();
  });
});
