import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../src/source/store.js';
import {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {storeAction} from '../src/mcp/calendar/sync.js';
import {CalendarSyncFixture as CalSync} from './calendar-fixture.js';
import {buildMarker} from '../src/mcp/calendar/markers.js';
import {savedEvent} from './calendar-fixture.js';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  // A missed watcher or failed publication must not conceal an omitted owner
  // notification for a write whose bytes already reached disk.
  vi.spyOn(Store.prototype, 'onChange').mockImplementation(() => () => {});
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe('Calendar partial source publication', () => {
  it.each(['record publication', 'relationship publication'])('repairs an ordinary reverse write after persistence succeeds and %s fails', async phase => {
    const root = mkdtempSync('/private/tmp/aside-calendar-partial-');
    mkdirSync(join(root, 'actions', '2026'), {recursive: true});
    writeFileSync(join(root, 'aside.md'), '---\nid: calendar-partial\n---\n');
    const file = join(root, 'actions', '2026', 'existing.md');
    writeFileSync(file, '---\nname: Existing\ncreated: 2026-06-01\nscheduled: 2026-06-01T09:00\ncalendar: Work\n---\nInstructions.\n');
    const store = new Store(root), cal = new CalClient(null);
    const lifecycle = new InstanceLifecycle({reconciliationIntervalMs: 0, debounceMs: 5});
    const observed = vi.fn((loaded: Store) => loaded.getAction('existing')?.frontMatter.scheduled);
    lifecycle.addFeature('test', {changed: observed}); lifecycle.register(store);
    const failures: unknown[] = [];
    const sync = new CalSync(cal, '', store, undefined, undefined, write => {
      try {lifecycle.mutation(store, write);}
      catch (error) {failures.push(error); throw error;}
    });
    cleanups.push(() => {sync.dispose(); lifecycle.close(); cal.close(); rmSync(root, {recursive: true, force: true});});
    await lifecycle.flush(); observed.mockClear();
    vi.spyOn(cal, 'available').mockReturnValue(true);
    vi.spyOn(cal, 'authStatus').mockResolvedValue({status: 'fullAccess'});
    vi.spyOn(cal, 'listCalendars').mockResolvedValue({calendars: [{id: 'work', name: 'Work', account: 'local', writable: true, type: 'local'}]});
    let event = savedEvent({calendar: 'Work', marker: buildMarker('calendar-partial', 'existing', 'active'), title: '▢ Existing',
      start: '2026-06-01T09:00', end: '2026-06-01T09:30', durationMinutes: 30});
    vi.spyOn(cal, 'listEvents').mockImplementation(async () => ({events: [event]}));
    vi.spyOn(cal, 'getEvents').mockImplementation(async () => ({events: [event]}));
    vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {event = savedEvent(args, 'event'); return {eventId: 'event'};});
    await sync.syncActions([storeAction(store, 'existing')!], [storeAction(store, 'existing')!]);
    event = savedEvent({calendar: 'Work', marker: buildMarker('calendar-partial', 'existing', 'active'), title: '▢ Existing',
      start: '2026-06-01T12:00', end: '2026-06-01T12:30', durationMinutes: 30});
    if (phase === 'record publication') vi.spyOn((store as any).core, 'upsertEntity').mockImplementationOnce(() => {throw new Error('Publication unavailable');});
    else vi.spyOn(store as any, 'buildRelationships').mockImplementationOnce(() => {throw new Error('Publication unavailable');});
    const invalidated = vi.spyOn(lifecycle, 'invalidate'), rebuild = vi.spyOn(store, 'rebuild');

    await sync.reconcile([storeAction(store, 'existing')!]);

    expect(readFileSync(file, 'utf8')).toContain('2026-06-01T12:00');
    expect(store.getAction('existing')!.frontMatter.scheduled).toBe(phase === 'record publication' ? '2026-06-01T09:00' : '2026-06-01T12:00');
    expect(failures).toEqual([expect.objectContaining({name: 'MutationWriteError', originalMessage: 'Publication unavailable',
      partialResult: expect.objectContaining({status: 'PARTIAL', changes: [expect.objectContaining({kind: 'action', id: 'existing', effect: 'UPDATED'})]})})]);
    if (phase === 'relationship publication') {
      expect(() => store.getSourceVersion()).toThrow('incomplete');
      expect(() => store.getRelations()).toThrow('Relationships have not been loaded');
      await expect(store.snapshot()).rejects.toThrow('Relationships have not been loaded');
      expect(store.getAction('existing')).toBe(store.getAction('existing'));
      expect(() => {store.getAction('existing')!.frontMatter.scheduled = 'Bypass';}).toThrow(TypeError);
    }
    expect(invalidated).toHaveBeenCalledWith(store);
    expect(rebuild).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(rebuild).toHaveBeenCalledOnce();
    expect(store.getAction('existing')!.frontMatter.scheduled).toBe('2026-06-01T12:00');
    expect(() => store.getSourceVersion()).not.toThrow();
    expect(() => store.getRelations()).not.toThrow();
    expect((await store.snapshot()).actions.find(([id]) => id === 'existing')![1].frontMatter.scheduled).toBe('2026-06-01T12:00');
    expect(observed).toHaveReturnedWith('2026-06-01T12:00');
  });
});
