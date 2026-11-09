import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceCalendarLifecycle} from '../src/daemon/calendar-lifecycle.js';
import {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {storeAction} from '../src/mcp/calendar/sync.js';
import {CalendarSyncFixture as CalSync} from './calendar-fixture.js';
import * as managed from '../src/core/managed-path.js';
import { calendarMutationFixture,savedEvent} from './calendar-fixture.js';
import {buildMarker} from '../src/mcp/calendar/markers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); vi.useRealTimers();});

function fixture() {
  const root = mkdtempSync('/private/tmp/aside-calendar-lifecycle-');
  mkdirSync(join(root, 'actions', '2026'), {recursive: true});
  writeFileSync(join(root, 'aside.md'), '---\nid: calendar-lifecycle\nname: Calendar lifecycle\n---\n');
  const file = (id: string) => join(root, 'actions', '2026', `${id}.md`);
  const write = (id: string, extra = 'scheduled: 2026-06-01T09:00\ncalendar: Work') => writeFileSync(file(id), `---\nname: ${id}\ncreated: 2026-06-01\n${extra}\n---\n${id} body\n`);
  write('existing');
  const store = new Store(root), cal = new CalClient(null), sync = new CalSync(cal, '', store, undefined, undefined, calendarMutationFixture(store));
  const owner = new InstanceCalendarLifecycle(vi.fn()); owner.register(store, sync);
  cleanups.push(() => {owner.unregister(store); sync.dispose(); cal.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  return {root, file, write, store, cal, sync, owner};
}

function calendar(f: ReturnType<typeof fixture>) {
  let event = savedEvent({calendar: 'Work', marker: buildMarker('calendar-lifecycle', 'existing', 'active'), title: '▢ existing',
    start: '2026-06-01T09:00', end: '2026-06-01T09:30', durationMinutes: 30});
  vi.spyOn(f.cal, 'available').mockReturnValue(true);
  const auth = vi.spyOn(f.cal, 'authStatus').mockResolvedValue({status: 'fullAccess'});
  const routing = vi.spyOn(f.cal, 'listCalendars').mockResolvedValue({calendars: [{id: 'work', name: 'Work', account: 'local', writable: true, type: 'local'}]});
  const list = vi.spyOn(f.cal, 'listEvents').mockImplementation(async () => ({events: [event]}));
  const get = vi.spyOn(f.cal, 'getEvents').mockImplementation(async () => ({events: [event]}));
  const upsert = vi.spyOn(f.cal, 'upsertEvent').mockImplementation(async args => {event = savedEvent(args, 'event'); return {eventId: 'event'};});
  return {auth, routing, list, get, upsert, current: () => event};
}

describe('Calendar instance lifecycle ownership', () => {
  it('preserves the cold startup deletion-import without forwarding the initial baseline', async () => {
    const f = fixture(), forward = vi.spyOn(f.sync, 'syncActions').mockResolvedValue([]);
    const reverse = vi.spyOn(f.sync, 'reconcile').mockResolvedValue();
    await f.owner.reconcile(f.store);
    expect(forward.mock.calls[0][0]).toEqual([]);
    expect(forward.mock.calls[0][1].map(action => action.id)).toEqual(['existing']);
    expect(reverse).toHaveBeenCalledOnce();
  });

  it('forwards loaded direct additions, reschedules, cleared calendars, and prefix edits', async () => {
    const f = fixture(), forward = vi.spyOn(f.sync, 'syncActions').mockImplementation(async actions => actions.map(action => ({id: action.id, status: 'synced'})));
    const reverse = vi.spyOn(f.sync, 'reconcile').mockResolvedValue();
    await f.owner.reconcile(f.store); forward.mockClear();
    f.write('new'); f.store.rebuild(); await f.owner.changed(f.store);
    expect(forward.mock.calls.at(-1)![0].map(action => action.id)).toEqual(['new']);
    f.write('existing', 'scheduled: 2026-06-01T11:00\ncalendar: Work'); f.store.rebuild(); await f.owner.changed(f.store);
    expect(forward.mock.calls.at(-1)![0][0].frontMatter.scheduled).toBe('2026-06-01T11:00');
    f.write('existing', 'scheduled: 2026-06-01T11:00'); f.store.rebuild(); await f.owner.changed(f.store);
    expect(forward.mock.calls.at(-1)![0].map(action => action.id)).toEqual(['existing']);
    expect(forward.mock.calls.at(-1)![0][0].frontMatter.calendar).toBeUndefined();
    writeFileSync(join(f.root, 'aside.md'), '---\nid: calendar-lifecycle\nname: Calendar lifecycle\nconfig:\n  scheduledEventTitlePrefix: "Next "\n---\n');
    f.store.rebuild(); await f.owner.changed(f.store);
    expect(forward.mock.calls.at(-1)![0].map(action => action.id)).toEqual(['new']);
    expect(reverse).toHaveBeenCalledTimes(5);
  });

  it('retries known local intents after helper repair without recreating failed cold deletions', async () => {
    const f = fixture();
    const forward = vi.spyOn(f.sync, 'syncActions').mockResolvedValue([]);
    vi.spyOn(f.sync, 'reconcile').mockResolvedValue();
    vi.spyOn(f.sync, 'status').mockReturnValue({id: 'existing', status: 'failed', reason: 'reverse write failed'});
    await f.owner.reconcile(f.store); await f.owner.reconcile(f.store);
    expect(forward.mock.calls.every(call => call[0].length === 0)).toBe(true);
    f.write('new'); f.store.rebuild();
    forward.mockResolvedValueOnce([{id: 'new', status: 'error', reason: 'helper unavailable'}]);
    await f.owner.changed(f.store);
    forward.mockResolvedValueOnce([{id: 'new', status: 'synced'}]);
    await f.owner.reconcile(f.store);
    expect(forward.mock.calls.at(-1)![0].map(action => action.id)).toEqual(['new']);
    await f.owner.reconcile(f.store);
    expect(forward.mock.calls.at(-1)![0]).toEqual([]);
  });

  it('retains changed snapshots after unexpected forward failures and stops future phases on unload', async () => {
    const f = fixture();
    const forward = vi.spyOn(f.sync, 'syncActions').mockRejectedValueOnce(new Error('unexpected local failure')).mockResolvedValue([]);
    const reverse = vi.spyOn(f.sync, 'reconcile').mockResolvedValue();
    f.write('new'); f.store.rebuild();
    await expect(f.owner.changed(f.store)).rejects.toThrow('unexpected local failure');
    await f.owner.reconcile(f.store);
    expect(forward.mock.calls.at(-1)![0].map(action => action.id)).toEqual(['new']);
    forward.mockImplementationOnce(async () => {f.owner.unregister(f.store); return [];});
    await f.owner.reconcile(f.store);
    expect(reverse).toHaveBeenCalledOnce();
    await f.owner.changed(f.store);
    expect(forward).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])('coalesces a newer loaded mutation before reverse import (notification already delivered=%s)', async notify => {
    const f = fixture(), reverse = vi.spyOn(f.sync, 'reconcile').mockResolvedValue();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {entered = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    const forward = vi.spyOn(f.sync, 'syncActions').mockImplementationOnce(async () => {entered(); await gate; return [];}).mockResolvedValue([]);
    f.write('new'); f.store.rebuild(); const first = f.owner.changed(f.store); await started;
    f.write('new', 'scheduled: 2026-06-01T12:00\ncalendar: Work'); f.store.rebuild(); const second = notify ? f.owner.changed(f.store) : Promise.resolve();
    release(); await Promise.all([first, second]);
    expect(forward).toHaveBeenCalledTimes(2);
    expect(forward.mock.calls[1][0][0].frontMatter.scheduled).toBe('2026-06-01T12:00');
    expect(reverse).toHaveBeenCalledOnce();
  });

  it('forwards a loaded write buffered by the common owner before its cold reverse import', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.spyOn(f.store, 'watch').mockImplementation(() => {});
    const lifecycle = new InstanceLifecycle({reconciliationIntervalMs: 0, debounceMs: 5});
    lifecycle.addFeature('calendar', {
      load: store => f.owner.register(store, f.sync), changed: store => f.owner.changed(store),
      reconcile: store => f.owner.reconcile(store), unload: store => f.owner.unregister(store),
    });
    cleanups.push(() => lifecycle.close());
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {enter = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    const forward = vi.spyOn(f.sync, 'syncActions').mockImplementationOnce(async () => {enter(); await gate; return [];}).mockResolvedValue([]);
    const reverse = vi.spyOn(f.sync, 'reconcile').mockResolvedValue();
    lifecycle.register(f.store);
    await vi.advanceTimersByTimeAsync(0); await started;
    f.write('new'); f.store.rebuild();
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(forward.mock.calls.map(call => call[0].map(action => action.id))).toEqual([[], ['new']]);
    expect(reverse).toHaveBeenCalledOnce();
    expect(reverse.mock.calls[0][0].map(action => action.id)).toEqual(['existing', 'new']);
  });

  it.each(['access', 'routing', 'events', 'relocation'])('preserves a known write buffered during reverse %s work', async phase => {
    vi.useFakeTimers();
    const f = fixture(), cal = calendar(f);
    if (phase === 'access') {
      const forward = f.sync.syncActions.bind(f.sync);
      vi.spyOn(f.sync, 'syncActions').mockImplementation(forward).mockResolvedValueOnce([]);
    } else await f.owner.reconcile(f.store);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {entered = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    const reverse = f.sync.reconcile.bind(f.sync);
    vi.spyOn(f.sync, 'reconcile').mockImplementation(reverse).mockImplementationOnce((actions, canImport) => {
      const event = cal.current();
      if (phase === 'access') cal.auth.mockImplementationOnce(async () => {entered(); await gate; return {status: 'fullAccess'};});
      if (phase === 'routing') cal.routing.mockImplementationOnce(async () => {
        entered(); await gate; return {calendars: [{id: 'work', name: 'Work', account: 'local', writable: true, type: 'local'}]};
      });
      if (phase === 'events') cal.get.mockImplementationOnce(async () => {entered(); await gate; return {events: [event]};});
      if (phase === 'relocation') {
        cal.get.mockResolvedValueOnce({events: []});
        cal.list.mockImplementationOnce(async () => {entered(); await gate; return {events: [event]};});
      }
      return reverse(actions, canImport);
    });
    vi.spyOn(f.store, 'watch').mockImplementation(() => {});
    const lifecycle = new InstanceLifecycle({reconciliationIntervalMs: 0, debounceMs: 5});
    const deliver = vi.fn((store: Store) => f.owner.reconcile(store));
    lifecycle.addFeature('calendar', {load: store => f.owner.register(store, f.sync), changed: deliver, reconcile: deliver,
      unload: store => f.owner.unregister(store)});
    cleanups.push(() => lifecycle.close()); lifecycle.register(f.store);
    await vi.advanceTimersByTimeAsync(0); await started;
    const action = f.store.getAction('existing')!;
    f.store.saveAction('existing', {...action.frontMatter, scheduled: '2026-06-01T12:00'}, action.body, f.file('existing'));
    // The common owner cannot deliver another callback until this reverse pass
    // finishes; the import fence must see the newer loaded revision itself.
    expect(deliver).toHaveBeenCalledOnce();
    release(); await vi.advanceTimersByTimeAsync(0); await lifecycle.flush();
    expect(f.store.getAction('existing')!.frontMatter.scheduled).toBe('2026-06-01T12:00');
    expect(cal.current().start).toBe('2026-06-01T12:00');
    expect(f.sync.changesSinceStart()).not.toContainEqual(expect.objectContaining({summary: expect.stringContaining('12:00 ->')}));
  });

  it('rechecks local intent before the final cold deschedule and forwards it before another callback', async () => {
    const f = fixture(); f.write('other'); f.store.rebuild();
    f.owner.unregister(f.store); f.owner.register(f.store, f.sync);
    const events = new Map(['existing', 'other'].map(id => [id, savedEvent({calendar: 'Work',
      marker: buildMarker('calendar-lifecycle', id, 'active'), title: `▢ ${id}`,
      start: '2026-06-01T09:00', end: '2026-06-01T09:30', durationMinutes: 30}, id)]));
    vi.spyOn(f.cal, 'available').mockReturnValue(true);
    vi.spyOn(f.cal, 'authStatus').mockResolvedValue({status: 'fullAccess'});
    vi.spyOn(f.cal, 'listCalendars').mockResolvedValue({calendars: [{id: 'work', name: 'Work', account: 'local', writable: true, type: 'local'}]});
    vi.spyOn(f.cal, 'listEvents').mockImplementation(async () => ({events: [...events.values()]}));
    const get = vi.spyOn(f.cal, 'getEvents').mockImplementation(async args => ({events: [...events.values()].filter(event => args.eventIds.includes(event.id))}));
    let holdOther = false, entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {entered = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    vi.spyOn(f.cal, 'upsertEvent').mockImplementation(async args => {
      const id = args.marker.endsWith('/existing') ? 'existing' : 'other';
      if (holdOther && id === 'other') {holdOther = false; entered(); await gate;}
      events.set(id, savedEvent(args, id)); return {eventId: id};
    });
    const initial = f.store.getActionIds().map(id => storeAction(f.store, id)!);
    // Establish tracked events without completing the cold deletion import.
    await f.sync.syncActions(initial, initial);
    events.delete('existing'); events.get('other')!.title = 'old title';
    get.mockResolvedValueOnce({events: []}); holdOther = true;
    const work = f.owner.reconcile(f.store); await started;
    // The first missing action is already queued for cold descheduling, while
    // another action's Calendar write is awaiting confirmation.
    const action = f.store.getAction('existing')!;
    f.store.saveAction('existing', {...action.frontMatter, scheduled: '2026-06-01T12:00'}, action.body, f.file('existing'));
    release(); await work;
    expect(f.store.getAction('existing')!.frontMatter.scheduled).toBe('2026-06-01T12:00');
    expect(events.get('existing')!.start).toBe('2026-06-01T12:00');
    expect(f.sync.changesSinceStart()).not.toContainEqual(expect.objectContaining({id: 'existing', summary: 'descheduled (event deleted)'}));
  });

  it('reads Calendar status solely from loaded content and leaves filesystem repair to lifecycle', async () => {
    const f = fixture();
    vi.spyOn(f.cal, 'available').mockReturnValue(true);
    vi.spyOn(f.cal, 'authStatus').mockResolvedValue({status: 'fullAccess'});
    vi.spyOn(f.cal, 'listCalendars').mockResolvedValue({calendars: [{id: 'work', name: 'Work', account: 'local', writable: true, type: 'local'}]});
    vi.spyOn(f.cal, 'listEvents').mockResolvedValue({events: []});
    let saved: ReturnType<typeof savedEvent>;
    vi.spyOn(f.cal, 'upsertEvent').mockImplementation(async args => {saved = savedEvent(args, 'event'); return {eventId: 'event'};});
    vi.spyOn(f.cal, 'getEvents').mockImplementation(async () => ({events: [saved]}));
    await f.sync.syncActions([storeAction(f.store, 'existing')!], []);
    const reads = vi.spyOn(managed, 'readManagedText').mockImplementation(() => {throw new Error('Status must use loaded memory');});
    f.write('existing', 'scheduled: 2026-06-01T14:00\ncalendar: Work');
    expect(f.sync.status('existing')?.status).toBe('synced');
    expect(f.sync.statuses()).toHaveLength(1);
    expect(f.sync.report()).toEqual([]); expect(f.sync.failureDiagnostics()).toEqual([]);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    f.store.rebuild();
    expect(f.sync.status('existing')).toBeUndefined();
  });

  it.each(['calendar', 'scheduled', 'cancelled'])('reports queued event removal from loaded %s changes without doing I/O', async change => {
    const f = fixture();
    vi.spyOn(f.cal, 'available').mockReturnValue(true);
    vi.spyOn(f.cal, 'authStatus').mockResolvedValue({status: 'fullAccess'});
    vi.spyOn(f.cal, 'listCalendars').mockResolvedValue({calendars: [{id: 'work', name: 'Work', account: 'local', writable: true, type: 'local'}]});
    vi.spyOn(f.cal, 'listEvents').mockResolvedValue({events: []});
    let saved: ReturnType<typeof savedEvent>;
    const upsert = vi.spyOn(f.cal, 'upsertEvent').mockImplementation(async args => {saved = savedEvent(args, 'event'); return {eventId: 'event'};});
    const get = vi.spyOn(f.cal, 'getEvents').mockImplementation(async () => ({events: [saved]}));
    const remove = vi.spyOn(f.cal, 'deleteEvent').mockResolvedValue({deleted: true});
    await f.sync.syncActions([storeAction(f.store, 'existing')!], []);
    expect(f.sync.status('existing')?.status).toBe('synced');
    const action = f.store.getAction('existing')!;
    const patch = change === 'cancelled' ? {resolution: 'cancelled' as const} : {[change]: undefined};
    f.store.saveAction('existing', {...action.frontMatter, ...patch}, action.body, f.file('existing'));
    upsert.mockClear(); get.mockClear();
    const reads = vi.spyOn(managed, 'readManagedText').mockImplementation(() => {throw new Error('Status must use loaded memory');});
    expect(f.sync.status('existing')).toMatchObject({id: 'existing', status: 'pending', reason: 'calendar event removal pending'});
    expect(f.sync.statuses()).toContainEqual(expect.objectContaining({id: 'existing', status: 'pending'}));
    expect(reads).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    reads.mockRestore();
    await f.owner.changed(f.store);
    expect(remove).toHaveBeenCalledOnce();
    expect(f.sync.status('existing')).toEqual({id: 'existing', status: 'removed'});
  });

  it('preserves an external delegation-only edit when reverse Calendar work would rewrite metadata', async () => {
    const f = fixture(), file = f.file('existing');
    vi.spyOn(f.cal, 'available').mockReturnValue(true);
    vi.spyOn(f.cal, 'authStatus').mockResolvedValue({status: 'fullAccess'});
    vi.spyOn(f.cal, 'listCalendars').mockResolvedValue({calendars: [{id: 'work', name: 'Work', account: 'local', writable: true, type: 'local'}]});
    const moved = savedEvent({calendar: 'Work', marker: buildMarker('calendar-lifecycle', 'existing', 'active'), title: '▢ existing', start: '2026-06-01T11:00', end: '2026-06-01T11:30', durationMinutes: 30});
    vi.spyOn(f.cal, 'listEvents').mockImplementation(async () => {
      writeFileSync(file, readFileSync(file, 'utf8').replace('calendar: Work', 'calendar: Work\ndelegation: &loop\n  run: *loop'));
      return {events: [moved]};
    });
    const save = vi.spyOn(f.store, 'saveAction');
    await f.sync.reconcile([storeAction(f.store, 'existing')!]);
    expect(save).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toContain('run: *loop');
    expect(readFileSync(file, 'utf8')).toContain('scheduled: 2026-06-01T09:00');
  });

  it('does not rearm retries after an in-flight helper call completes during unload', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.spyOn(f.cal, 'available').mockReturnValue(true);
    let authorized!: () => void;
    vi.spyOn(f.cal, 'authStatus').mockImplementation(() => new Promise(resolve => {authorized = () => resolve({status: 'fullAccess'});}));
    const sync = f.sync.syncActions([storeAction(f.store, 'existing')!], []);
    f.sync.dispose(); authorized(); await sync;
    expect(vi.getTimerCount()).toBe(0);
    expect(await f.sync.syncActions([storeAction(f.store, 'existing')!], [])).toEqual([
      {id: 'existing', status: 'skipped', reason: 'instance is no longer loaded'},
    ]);
  });
});
