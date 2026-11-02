import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateOccurrence } from '../src/mcp/tools/recurrence.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import { InstanceHost } from '../src/daemon/host.js';
import { nativeSeries } from '../src/mcp/calendar/recurrence-rule.js';
import { RecurrenceCalSync, isNativeOccurrence } from '../src/mcp/calendar/recurrence-sync.js';
import { CalSync, storeAction } from '../src/mcp/calendar/sync.js';
import { RecurrenceMirror } from '../src/mcp/calendar/recurrence-state.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { scheduleInstant, wallTimeAt } from '../src/core/scheduling.js';
import type { CalEvent, UpsertEventArgs } from '../src/mcp/calendar/protocol.js';

const schedule = { dtstart: '2026-10-09T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY;COUNT=3' };
let dir: string, store: Store, template: string, cal: CalClient, sync: RecurrenceCalSync;
let events: CalEvent[];
const originalTZ = process.env.TZ;
function event(args: UpsertEventArgs, id = 'head'): CalEvent { const startInstant = scheduleInstant(args.start,args.timezone)!; const endInstant = startInstant + (args.durationMinutes ?? 0)*60000; return { id, url: args.marker, title: args.title, calendar: args.calendar, start: !args.timezone && !args.allDay ? wallTimeAt(startInstant) : args.start, end: !args.timezone && !args.allDay ? wallTimeAt(endInstant) : args.end, timezone: args.timezone ?? null, allDay: args.allDay, startInstant, endInstant, durationMinutes: args.durationMinutes }; }
const calendars = [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00Z'));
  dir = mkdtempSync('/private/tmp/aside-recur-cal-'); init(dir, { name: 'Calendar recurrence', description: 'Fixture' }); store = new Store(dir);
  template = handleCapture(store, { content: 'Repeat', description: 'Repeat', actions: [{ name: 'Review', description: 'Review', recurrence: [schedule], calendar: 'Work' }] }).createdActionIds[0];
  cal = new CalClient(null); sync = new RecurrenceCalSync(cal); events = [];
  vi.spyOn(cal,'getSeries').mockImplementation(async args => { expect(args.start).toMatch(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/); return { events: events.filter(e => e.url === args.marker || e.url.startsWith(args.marker + '/')) }; });
  vi.spyOn(cal,'getEvents').mockImplementation(async args => ({ events: events.filter(event => args.eventIds.includes(event.id)) }));
  vi.spyOn(cal,'listEvents').mockRejectedValue(new Error('Series discovery must not use a fixed date horizon.'));
  vi.spyOn(cal,'upsertSeries').mockImplementation(async args => { const master = { ...event(args, args.eventId ?? args.marker), recurring: true, seriesHead: true, externalId: 'external:' + args.marker, seriesRule: args.seriesRule, original: args.timezone ? args.start + ':00Z' : args.allDay ? args.start.slice(0,10) : args.start }; events = [master, ...events.filter(e => e.url !== args.marker || e.detached)]; return { eventId: master.id, externalId: master.externalId }; });
  vi.spyOn(cal,'deleteSeries').mockImplementation(async args => { events = events.filter(e => e.url !== args.marker && !e.url.startsWith(args.marker + '/')); return { deleted: true }; });
  vi.spyOn(cal,'upsertEvent').mockImplementation(async args => ({ eventId: 'ordinary' }));
  vi.spyOn(cal,'upsertOccurrence').mockImplementation(async args => {
    const index = events.findIndex(e => e.original === args.original);
    if (args.remove) { if (index >= 0) events.splice(index,1); return { eventId: '' }; }
    const saved = { ...event(args, 'exception'), detached: true, recurring: true, original: args.original, seriesRule: events.find(e => !e.detached && e.url === args.marker.replace(/\/done$/,''))?.seriesRule ?? nativeSeries(schedule)[0].rule };
    if (index >= 0) events[index] = saved; else events.push(saved);
    return { eventId: saved.id };
  });
});
afterEach(() => { store.close(); vi.restoreAllMocks(); vi.useRealTimers(); if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; rmSync(dir, { recursive: true, force: true }); });
const run = (reverse = false) => sync.sync(store, store.getInstance()!.manifest.id!, calendars, { active: '', done: '✓ ' }, () => {}, reverse);
function ordinaryForward(): CalSync {
  vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars });
  vi.mocked(cal.listEvents).mockResolvedValue({ events: [] });
  return new CalSync(cal, store.getInstance()!.manifest.id!, store);
}
async function ordinaryFixture() {
  await run();
  const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
  await run();
  const action = store.getAction(template)!, occurrence = structuredClone(store.getAction(saved)!);
  store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
  const first = ordinaryForward(), actions = () => [...store.getActions().keys()].map(id => storeAction(store, id)!);
  try { await first.syncActions([storeAction(store, template)!], actions()); }
  finally { first.dispose(); }
  events.push(event(vi.mocked(cal.upsertEvent).mock.calls[0][0], 'ordinary'));
  vi.spyOn(cal, 'deleteEvent').mockImplementation(async args => { events = events.filter(event => event.id !== args.eventId); return { deleted: true }; });
  return { saved, action, occurrence, actions };
}
async function conversionFixture() {
  const unused = store.getAction(template)!;
  store.saveAction(template, { ...unused.frontMatter, recurrence: [], calendar: undefined }, unused.body, store.getActionFile(template)!);
  const converted = handleCapture(store, { content: 'Make this work repeat', description: 'Repeat work', actions: [{
    name: 'Repeat this action', description: 'Repeat this action', scheduled: schedule.dtstart, timezone: 'UTC', calendar: 'Work',
  }] }).createdActionIds[0];
  const forward = ordinaryForward();
  vi.mocked(cal.listEvents).mockImplementation(async () => ({ events: [...events] }));
  vi.mocked(cal.upsertEvent).mockImplementation(async args => {
    const saved = event(args, args.eventId ?? 'ordinary-copy');
    events = [...events.filter(existing => existing.id !== saved.id), saved];
    return { eventId: saved.id };
  });
  const remove = vi.spyOn(cal, 'deleteEvent').mockImplementation(async args => {
    events = events.filter(existing => existing.id !== args.eventId);
    return { deleted: true };
  });
  const actions = () => [...store.getActions().keys()].map(id => storeAction(store, id)!);
  try {
    await forward.syncActions([storeAction(store, converted)!], actions());
    expect(events.map(saved => saved.id)).toEqual(['ordinary-copy']);
  } catch (error) { forward.dispose(); throw error; }
  return { converted, forward, remove, actions };
}

describe('native recurrence Calendar mapping', () => {
  it('translates native rules, keeps keys stable when ending them, and splits multiple times exactly', () => {
    expect(nativeSeries(schedule)[0].rule).toEqual({ frequency: 'daily', interval: 1, count: 3 });
    const weekly = { ...schedule, rrule: 'FREQ=WEEKLY;BYDAY=FR' };
    expect(nativeSeries(weekly)[0].key).toBe(nativeSeries({ ...weekly, rrule: weekly.rrule+';UNTIL=20261030T090000Z' })[0].key);
    expect(nativeSeries({ ...schedule, rrule: 'FREQ=DAILY;BYHOUR=9,17' }).map(s => s.schedule.dtstart)).toEqual(['2026-10-09T09:00','2026-10-09T17:00']);
    expect(() => nativeSeries({ ...schedule, rrule: 'FREQ=MONTHLY;BYMONTH=10' })).toThrow('ignores');
    expect(() => nativeSeries({ ...schedule, rrule: 'FREQ=HOURLY' })).toThrow('cannot represent');
    expect(nativeSeries({ dtstart: '2026-10-12T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY;BYDAY=MO,TU;BYSETPOS=1' })[0].rule).toEqual({ frequency: 'weekly', interval: 1, days: [{ day: 2, week: 0 }, { day: 3, week: 0 }] });
  });
  it('creates a native series without allocating actions and stops writing when unchanged', async () => {
    expect(await run()).toMatchObject([{ id: template, status: 'synced' }]); expect(store.getActions().size).toBe(1);
    await run(true); await run(); expect(cal.upsertSeries).toHaveBeenCalledOnce(); expect(cal.upsertOccurrence).not.toHaveBeenCalled();
  });
  it('keeps an empty template dormant without publishing a native or ordinary event', async () => {
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
    expect(await run(true)).toMatchObject([{ id: template, status: 'synced' }]);
    expect(store.getIssues()).toEqual([]); expect(store.getActions().size).toBe(1);
    expect(cal.upsertSeries).not.toHaveBeenCalled(); expect(cal.upsertEvent).not.toHaveBeenCalled();
    expect(cal.upsertOccurrence).not.toHaveBeenCalled(); expect(events).toEqual([]);
  });
  it.each(['warm', 'cold', 'rotated', 'legacy'])('retires the ordinary event when a scheduled action becomes a recurrence template (%s)', async mode => {
    const fixture = await conversionFixture(), { converted, remove, actions } = fixture;
    let forward = fixture.forward;
    try {
      const recurrence = mode === 'rotated' ? { ...schedule, dtstart: '2099-01-01T09:00' } : schedule;
      handleUpdateAction(store, { id: converted, scheduled: null, resolution: null, recurrence: { append: recurrence } });
      if (mode === 'rotated') events[0].id = 'rotated-copy';
      if (mode === 'legacy') {
        const mirror = new RecurrenceMirror(dir, store.getInstance()!.manifest.id!);
        const path = (mirror as unknown as { path: string }).path;
        const stored = JSON.parse(readFileSync(path, 'utf8'));
        delete stored.ordinaryStarts;
        writeFileSync(path, JSON.stringify(stored));
      }
      if (mode !== 'warm') {
        forward.dispose(); forward = new CalSync(cal, store.getInstance()!.manifest.id!, store);
      }
      vi.mocked(cal.listEvents).mockClear();
      await forward.syncActions([storeAction(store, converted)!], actions());
      expect(store.getAction(converted)!.frontMatter).toMatchObject({ recurrence: [recurrence] });
      expect(events.some(saved => saved.seriesHead && saved.url.includes(converted))).toBe(true);
      expect(remove).toHaveBeenCalledWith(expect.objectContaining({ eventId: mode === 'rotated' ? 'rotated-copy' : 'ordinary-copy' }));
      expect(events.every(saved => saved.seriesHead)).toBe(true);
      if (mode === 'rotated') expect(cal.listEvents).toHaveBeenCalledWith({ start: '2026-09-08', end: '2026-11-09' });
      else expect(cal.listEvents).not.toHaveBeenCalled();
      expect(remove.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(cal.upsertSeries).mock.invocationCallOrder[0]);
      await forward.syncActions([], actions());
      expect(remove).toHaveBeenCalledOnce(); expect(cal.upsertSeries).toHaveBeenCalledOnce();
    } finally { forward.dispose(); }
  });
  it.each(['throw', 'unconfirmed'])('retains template handoff evidence through %s removal and retries after restart', async failure => {
    const fixture = await conversionFixture(), { converted, remove, actions } = fixture;
    let forward = fixture.forward;
    try {
      handleUpdateAction(store, { id: converted, scheduled: null, recurrence: { append: schedule } });
      if (failure === 'throw') remove.mockRejectedValueOnce(new Error('Provider unavailable.'));
      else remove.mockResolvedValueOnce({ deleted: false });
      expect(await forward.syncActions([storeAction(store, converted)!], actions())).toEqual(expect.arrayContaining([expect.objectContaining({ id: converted, status: 'error' })]));
      expect(events.map(saved => saved.id)).toEqual(['ordinary-copy']);
      expect(cal.upsertSeries).not.toHaveBeenCalled();
      const mirror = new RecurrenceMirror(dir, store.getInstance()!.manifest.id!);
      expect(mirror.ordinaryEvents.get(converted)).toBe('ordinary-copy');
      expect(mirror.ordinaryStarts.get(converted)).toBe(schedule.dtstart);
      forward.dispose(); forward = new CalSync(cal, store.getInstance()!.manifest.id!, store);
      await forward.syncActions([], actions());
      expect(events.every(saved => saved.seriesHead)).toBe(true);
      expect(cal.upsertSeries).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledTimes(2);
      expect(new RecurrenceMirror(dir, store.getInstance()!.manifest.id!).pendingNative.has(converted)).toBe(false);
    } finally { forward.dispose(); }
  });
  it('retries native publication after retiring a template copy without reseeding its deleted cached ID', async () => {
    const { converted, forward, remove, actions } = await conversionFixture();
    try {
      handleUpdateAction(store, { id: converted, scheduled: null, recurrence: { append: schedule } });
      vi.mocked(cal.upsertSeries).mockRejectedValueOnce(new Error('Native publication unavailable.'));
      expect(await forward.syncActions([storeAction(store, converted)!], actions())).toEqual(expect.arrayContaining([expect.objectContaining({ id: converted, status: 'error' })]));
      expect(events).toEqual([]); expect(remove).toHaveBeenCalledOnce();
      await forward.syncActions([], actions());
      expect(events.some(saved => saved.seriesHead)).toBe(true);
      expect(remove).toHaveBeenCalledOnce(); expect(cal.upsertSeries).toHaveBeenCalledTimes(2);
    } finally { forward.dispose(); }
  });
  it.each(['dormant', 'unbound'])('retires an ordinary copy even when conversion leaves the template %s', async mode => {
    const { converted, forward, remove, actions } = await conversionFixture();
    try {
      handleUpdateAction(store, { id: converted, scheduled: null, ...(mode === 'unbound' ? { calendar: null } : {}), recurrence: { append: schedule } });
      if (mode === 'dormant') handleUpdateAction(store, { id: converted, recurrence: { remove: { dtstart: schedule.dtstart, timezone: schedule.timezone } } });
      await forward.syncActions([storeAction(store, converted)!], actions());
      expect(events).toEqual([]); expect(remove).toHaveBeenCalledOnce(); expect(cal.upsertSeries).not.toHaveBeenCalled();
      const mirror = new RecurrenceMirror(dir, store.getInstance()!.manifest.id!);
      expect(mirror.ordinaryEvents.has(converted)).toBe(false); expect(mirror.ordinaryStarts.has(converted)).toBe(false);
      expect(mirror.pendingNative.has(converted)).toBe(false);
    } finally { forward.dispose(); }
  });
  it.each(['foreign', 'recurring', 'unsafe'])('preserves a %s prior ordinary copy and blocks native publication', async mode => {
    const { converted, forward, remove, actions } = await conversionFixture();
    try {
      if (mode === 'foreign') events[0].url = 'aside://another-instance/action/foreign';
      else if (mode === 'recurring') events[0].recurring = true;
      else events[0].durationMinutes = 0;
      const before = structuredClone(events);
      handleUpdateAction(store, { id: converted, scheduled: null, recurrence: { append: schedule } });
      expect(await forward.syncActions([storeAction(store, converted)!], actions())).toEqual(expect.arrayContaining([expect.objectContaining({ id: converted, status: 'error' })]));
      expect(events).toEqual(before); expect(remove).not.toHaveBeenCalled(); expect(cal.upsertSeries).not.toHaveBeenCalled();
      expect(new RecurrenceMirror(dir, store.getInstance()!.manifest.id!).ordinaryEvents.get(converted)).toBe('ordinary-copy');
    } finally { forward.dispose(); }
  });
  it.each(['name', 'body', 'calendar', 'recurrence', 'prefix'])('invalidates a template success after its %s changes', async field => {
    const forward = ordinaryForward();
    const actions = () => [...store.getActions().keys()].map(id => storeAction(store, id)!);
    try {
      await forward.syncActions([storeAction(store, template)!], actions());
      expect(forward.status(template)).toMatchObject({ status: 'synced' });
      const before = store.getAction(template)!;
      if (field === 'prefix') {
        const manifest = store.getDataDir() + '/aside.md';
        writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/\n---\n/, '\nconfig:\n  scheduledEventTitlePrefix: "New prefix "\n---\n'));
        store.rebuild();
      } else {
        const fm = { ...before.frontMatter };
        if (field === 'name') fm.name = 'Renamed routine';
        if (field === 'calendar') delete fm.calendar;
        if (field === 'recurrence') fm.recurrence = [schedule, { ...schedule, dtstart: '2026-10-20T09:00' }];
        store.saveAction(template, fm, field === 'body' ? 'Updated instructions' : before.body, store.getActionFile(template)!);
      }
      expect(forward.status(template)).toBeUndefined();
      await forward.syncActions([storeAction(store, template)!], actions());
      expect(forward.status(template)).toMatchObject({ status: field === 'calendar' ? 'removed' : 'synced' });
    } finally { forward.dispose(); }
  });
  it('persists a legacy task start before API conversion and retires its event without an existing event hint', async () => {
    const { converted, forward } = await conversionFixture();
    forward.dispose();
    const instance = store.getInstance()!.manifest.id!;
    const mirror = new RecurrenceMirror(dir, instance);
    mirror.ordinaryEvents.clear(); mirror.ordinaryStarts.clear(); mirror.save();
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    // Exclude initial background reconciliation so this exercises the API's
    // explicit start evidence, without warming an event-ID cache first.
    const originalSync = CalSync.prototype.syncActions;
    let startup = true;
    vi.spyOn(CalSync.prototype, 'syncActions').mockImplementation(function (...args) {
      if (startup && args[0].length === 0) { startup = false; return Promise.resolve([]); }
      return originalSync.apply(this, args);
    });
    vi.spyOn(CalSync.prototype, 'reconcile').mockResolvedValue(null);
    const prepare = CalSync.prototype.prepareTemplateConversion;
    const captured = vi.spyOn(CalSync.prototype, 'prepareTemplateConversion').mockImplementation(function (before) {
      prepare.call(this, before);
      const persisted = new RecurrenceMirror(dir, instance);
      expect(persisted.ordinaryEvents.has(converted)).toBe(false);
      expect(persisted.ordinaryStarts.get(converted)).toBe(schedule.dtstart);
      expect(readFileSync(store.getActionFile(converted)!, 'utf8')).not.toContain('recurrence:');
    });
    const host = new InstanceHost(cal);
    try {
      const saved = await host.tool(dir, 'update_action', { id: converted, scheduled: null, resolution: null,
        recurrence: { append: { ...schedule, dtstart: '2099-01-01T09:00' } } });
      expect(saved.text).toContain(converted); expect(captured).toHaveBeenCalledOnce();
      await host.flush();
      expect(cal.deleteEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'ordinary-copy' }));
      expect(events.every(saved => saved.seriesHead)).toBe(true);
    } finally { await host.close(); }
  });
  it('fails API conversion before writing the task if required legacy handoff evidence cannot be saved', async () => {
    const { converted, forward } = await conversionFixture();
    forward.dispose();
    const mirror = new RecurrenceMirror(dir, store.getInstance()!.manifest.id!);
    mirror.ordinaryEvents.clear(); mirror.ordinaryStarts.clear(); mirror.save();
    const file = store.getActionFile(converted)!, before = readFileSync(file, 'utf8');
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    vi.spyOn(CalSync.prototype, 'syncActions').mockResolvedValue([]);
    vi.spyOn(CalSync.prototype, 'reconcile').mockResolvedValue(null);
    vi.spyOn(RecurrenceMirror.prototype, 'save').mockImplementationOnce(() => { throw new Error('State volume is read-only.'); });
    const host = new InstanceHost(cal);
    try {
      await expect(host.tool(dir, 'update_action', { id: converted, scheduled: null, recurrence: { append: schedule } }))
        .rejects.toThrow('no action records were changed');
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(cal.deleteEvent).not.toHaveBeenCalled(); expect(cal.upsertSeries).not.toHaveBeenCalled();
    } finally { await host.close(); }
  });
  it('prunes a removed schedule before importing old gestures and forwards saved actions as ordinary events', async () => {
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
    await run(); const occurrence = structuredClone(store.getAction(saved)!);
    const oldMarker = events[0].url;
    events.push({ ...events[0], id: 'old-gesture', seriesHead: false, detached: true, url: oldMarker + '/done',
      original: '2026-10-11T09:00:00Z', start: '2026-10-11T09:00', end: '2026-10-11T09:30',
      startInstant: Date.parse('2026-10-11T09:00Z'), endInstant: Date.parse('2026-10-11T09:30Z') });
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
    sync = new RecurrenceCalSync(cal);
    await run(true);
    expect(cal.deleteSeries).toHaveBeenCalledWith(expect.objectContaining({ marker: oldMarker }));
    expect(store.getActions().size).toBe(2); expect(store.getAction(saved)).toEqual(occurrence);
    expect(store.getIssues()).toEqual([]); expect(events).toEqual([]);
    expect(isNativeOccurrence(store, occurrence)).toBe(false);

    const forward = ordinaryForward();
    try {
      const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
      await forward.syncActions([storeAction(store, template)!], actions);
      expect(forward.status(saved)).toMatchObject({ id: saved, status: 'synced' });
      expect(cal.upsertEvent).toHaveBeenCalledWith(expect.objectContaining({ marker: expect.stringContaining('/action/' + saved), start: '2026-10-10T11:00' }));
      expect(cal.upsertSeries).toHaveBeenCalledOnce();
      await forward.syncActions([storeAction(store, template)!], actions);
      expect(cal.upsertEvent).toHaveBeenCalledOnce();
    } finally { forward.dispose(); }
  });
  it('defers ordinary export when removing the old native family fails and retries after it is pruned', async () => {
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
    await run();
    const action = store.getAction(template)!, occurrence = structuredClone(store.getAction(saved)!);
    store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
    vi.mocked(cal.deleteSeries).mockRejectedValueOnce(new Error('Provider unavailable.')).mockRejectedValueOnce(new Error('Provider unavailable.'));
    const forward = ordinaryForward();
    try {
      const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
      const results = await forward.syncActions(actions, actions);
      expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ id: template, status: 'error' })]));
      expect(cal.upsertEvent).not.toHaveBeenCalled();
      expect(events.some(event => event.seriesHead)).toBe(true);
      expect(store.getAction(saved)).toEqual(occurrence);
      expect(forward.status(saved)).toMatchObject({ status: 'pending', retry: true });
      await forward.reconcile(actions);
      expect(cal.upsertEvent).not.toHaveBeenCalled(); expect(store.getAction(saved)).toEqual(occurrence);
      await forward.syncActions([], actions);
      expect(events).toEqual([]);
      expect(cal.upsertEvent).toHaveBeenCalledOnce();
      expect(cal.upsertEvent).toHaveBeenCalledWith(expect.objectContaining({ marker: expect.stringContaining('/action/' + saved), start: '2026-10-10T11:00' }));
      expect(store.getAction(saved)).toEqual(occurrence);
    } finally { forward.dispose(); }
  });
  it('retains a native family when its removal is unconfirmed and an owned root survives', async () => {
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
    await run();
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
    vi.mocked(cal.deleteSeries).mockResolvedValueOnce({ deleted: false });
    const forward = ordinaryForward();
    try {
      const actions = () => [...store.getActions().keys()].map(id => storeAction(store, id)!);
      await forward.syncActions([storeAction(store, template)!], actions());
      expect(cal.upsertEvent).not.toHaveBeenCalled();
      expect(events.some(event => event.seriesHead)).toBe(true);
      expect(new RecurrenceMirror(dir, store.getInstance()!.manifest.id!).families.size).toBe(1);
      expect(forward.status(saved)).toMatchObject({ status: 'pending', retry: true });
      await forward.syncActions([], actions());
      expect(events).toEqual([]);
      expect(cal.upsertEvent).toHaveBeenCalledOnce();
      expect(new RecurrenceMirror(dir, store.getInstance()!.manifest.id!).families.size).toBe(0);
    } finally { forward.dispose(); }
  });
  it('keeps supported families and their exceptions when an appended schedule is unsupported', async () => {
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', resolution: 'done' }).id;
    await run();
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [schedule, { dtstart: '2026-10-12T09:00', timezone: 'UTC', rrule: 'FREQ=HOURLY;COUNT=3' }] }, action.body, store.getActionFile(template)!);
    const forward = ordinaryForward();
    try {
      const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
      const results = await forward.syncActions([storeAction(store, template)!], actions);
      expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ id: template, status: 'error' })]));
      expect(cal.deleteSeries).not.toHaveBeenCalled();
      expect(events.some(event => event.seriesHead)).toBe(true);
      expect(events.some(event => event.detached && event.original === '2026-10-10T09:00:00Z')).toBe(true);
      expect(forward.status(saved)).toMatchObject({ status: 'synced' });
      expect(cal.upsertEvent).not.toHaveBeenCalled();
    } finally { forward.dispose(); }
  });
  it('exports a safely retired occurrence while a separate native family and unsupported rule remain', async () => {
    const action = store.getAction(template)!, first = { ...schedule, rrule: 'FREQ=DAILY;COUNT=1' };
    const second = { ...schedule, dtstart: '2026-10-10T09:00', rrule: 'FREQ=DAILY;COUNT=2' };
    store.saveAction(template, { ...action.frontMatter, recurrence: [first, second] }, action.body, store.getActionFile(template)!);
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-11T09:00:00Z', scheduled: '2026-10-11T11:00' }).id;
    await run();
    store.saveAction(template, { ...action.frontMatter, recurrence: [first, { ...second, rrule: 'FREQ=HOURLY;COUNT=3' }] }, action.body, store.getActionFile(template)!);
    const forward = ordinaryForward();
    try {
      const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
      const results = await forward.syncActions([storeAction(store, template)!], actions);
      expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ id: template, status: 'error' })]));
      expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ start: first.dtstart, seriesHead: true });
      expect(cal.deleteSeries).toHaveBeenCalledOnce(); expect(cal.upsertEvent).toHaveBeenCalledOnce();
      expect(forward.status(saved)).toMatchObject({ status: 'synced' });
    } finally { forward.dispose(); }
  });
  it('retains a detached family until its removal is observed', async () => {
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
    await run(); events = events.filter(event => event.detached);
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
    vi.mocked(cal.upsertOccurrence).mockResolvedValueOnce({ eventId: '' });
    const forward = ordinaryForward();
    try {
      const actions = () => [...store.getActions().keys()].map(id => storeAction(store, id)!);
      await forward.syncActions([storeAction(store, template)!], actions());
      expect(cal.upsertEvent).not.toHaveBeenCalled(); expect(events).toHaveLength(1);
      expect(new RecurrenceMirror(dir, store.getInstance()!.manifest.id!).families.size).toBe(1);
      expect(forward.status(saved)).toMatchObject({ status: 'pending', retry: true });
      await forward.syncActions([], actions());
      expect(events).toEqual([]); expect(cal.upsertEvent).toHaveBeenCalledOnce();
    } finally { forward.dispose(); }
  });
  it.each([false, true])('retires an ordinary copy created while its template concurrently restores native eligibility, lost reply=%s', async lostReply => {
    const forward = ordinaryForward();
    try {
      const actions = () => [...store.getActions().keys()].map(id => storeAction(store, id)!);
      await forward.syncActions([storeAction(store, template)!], actions());
      const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
      await forward.syncActions([storeAction(store, saved)!], actions());
      const action = store.getAction(template)!;
      store.saveAction(template, { ...action.frontMatter, recurrence: [{ ...schedule, rrule: 'FREQ=DAILY;COUNT=1' }] }, action.body, store.getActionFile(template)!);
      vi.mocked(cal.upsertEvent).mockImplementationOnce(async args => {
        store.saveAction(template, action.frontMatter, action.body, store.getActionFile(template)!);
        events.push(event(args, 'ordinary-raced'));
        if (lostReply) throw new Error('Provider wrote the event but its reply was lost.');
        return { eventId: 'ordinary-raced' };
      });
      vi.spyOn(cal, 'deleteEvent').mockImplementation(async args => { events = events.filter(event => event.id !== args.eventId); return { deleted: true }; });
      vi.mocked(cal.listEvents).mockImplementation(async () => ({ events: [...events] }));
      await forward.syncActions([storeAction(store, template)!], actions());
      expect(events.some(event => event.id === 'ordinary-raced')).toBe(true);
      await forward.syncActions([], actions());
      expect(events.some(event => event.id === 'ordinary-raced')).toBe(false);
      expect(events.some(event => event.detached && event.original === '2026-10-10T09:00:00Z')).toBe(true);
      expect(cal.deleteEvent).toHaveBeenCalledOnce();
    } finally { forward.dispose(); }
  });
  it('does not import a cold missing ordinary event while a removed native occurrence awaits export', async () => {
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
    await run();
    const action = store.getAction(template)!, occurrence = structuredClone(store.getAction(saved)!);
    store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
    await run(true); // A new outer syncer must find the persisted handoff after pruning.
    const forward = ordinaryForward();
    try {
      const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
      await forward.reconcile(actions);
      expect(events).toEqual([]); expect(store.getAction(saved)).toEqual(occurrence);
      expect(forward.status(saved)).toMatchObject({ status: 'pending', retry: true });
      await forward.syncActions([], actions);
      expect(cal.upsertEvent).toHaveBeenCalledOnce(); expect(store.getAction(saved)).toEqual(occurrence);
    } finally { forward.dispose(); }
  });
  it.each(['done', 'deleted'] as const)('imports a cold ordinary %s gesture when there is no native handoff', async gesture => {
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
    const first = ordinaryForward();
    const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
    try { await first.syncActions([storeAction(store, saved)!], actions); }
    finally { first.dispose(); }
    const args = vi.mocked(cal.upsertEvent).mock.calls[0][0];
    if (gesture === 'done') events = [{ ...event(args, 'ordinary'), url: args.marker + '/done', title: '✓ Review' }];
    vi.mocked(cal.listEvents).mockImplementation(async () => ({ events: [...events] }));
    const cold = new CalSync(cal, store.getInstance()!.manifest.id!, store);
    try {
      await cold.reconcile(actions);
      if (gesture === 'done') expect(store.getAction(saved)!.frontMatter.resolution).toBe('done');
      else expect(store.getAction(saved)!.frontMatter.scheduled).toBeUndefined();
      expect(cal.upsertEvent).toHaveBeenCalledOnce();
      expect(store.getAction(saved)!.frontMatter.occurrence).toEqual({ template, original: '2026-10-10T09:00:00Z', timezone: 'UTC' });
    } finally { cold.dispose(); }
  });
  it('exports a retained saved action after pruning when its replacement rule is unsupported natively', async () => {
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
    await run();
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ ...schedule, rrule: 'FREQ=HOURLY;COUNT=3' }] }, action.body, store.getActionFile(template)!);
    const forward = ordinaryForward();
    try {
      const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
      const results = await forward.syncActions([storeAction(store, template)!], actions);
      expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ id: template, status: 'error' })]));
      expect(events).toEqual([]);
      expect(cal.upsertEvent).toHaveBeenCalledWith(expect.objectContaining({ marker: expect.stringContaining('/action/' + saved) }));
      expect(forward.status(saved)).toMatchObject({ status: 'synced' });
    } finally { forward.dispose(); }
  });
  it('exports a materialized action from an unsupported rule that never had a native family', async () => {
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ ...schedule, rrule: 'FREQ=HOURLY;COUNT=3' }] }, action.body, store.getActionFile(template)!);
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-09T10:00:00Z', resolution: 'done' }).id;
    const forward = ordinaryForward();
    try {
      const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
      await forward.syncActions([storeAction(store, saved)!], actions);
      expect(cal.upsertSeries).not.toHaveBeenCalled();
      expect(cal.upsertEvent).toHaveBeenCalledWith(expect.objectContaining({ marker: expect.stringContaining('/action/' + saved + '/done') }));
      expect(forward.status(saved)).toMatchObject({ status: 'synced' });
    } finally { forward.dispose(); }
  });
  it.each(['none', 'throw', 'unconfirmed', 'rotated'])('hands off a saved exception after shortening with cleanup failure=%s', async failure => {
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
    await run();
    const action = store.getAction(template)!, occurrence = structuredClone(store.getAction(saved)!);
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ ...schedule, rrule: 'FREQ=DAILY;UNTIL=20261009T090000Z' }] }, action.body, store.getActionFile(template)!);
    if (failure === 'throw') vi.mocked(cal.upsertOccurrence).mockRejectedValueOnce(new Error('Detached cleanup unavailable.'));
    if (failure === 'unconfirmed') vi.mocked(cal.upsertOccurrence).mockResolvedValueOnce({ eventId: '' });
    if (failure === 'rotated') vi.mocked(cal.upsertOccurrence).mockImplementationOnce(async args => {
      events = events.map(event => event.original === args.original ? { ...event, id: 'rotated-exception' } : event);
      return { eventId: '' };
    });
    const forward = ordinaryForward();
    try {
      const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
      await forward.syncActions([storeAction(store, template)!], actions);
      if (failure !== 'none') {
        expect(cal.upsertEvent).not.toHaveBeenCalled(); expect(events.some(event => event.detached)).toBe(true);
        expect(forward.status(saved)).toMatchObject({ status: 'pending', retry: true });
        await forward.syncActions([], actions);
      }
      expect(events.filter(event => event.detached)).toEqual([]);
      expect(cal.deleteSeries).not.toHaveBeenCalled();
      expect(cal.upsertOccurrence).toHaveBeenCalledWith(expect.objectContaining({ original: '2026-10-10T09:00:00Z', remove: true }));
      expect(cal.upsertEvent).toHaveBeenCalledOnce(); expect(store.getAction(saved)).toEqual(occurrence);
      await forward.syncActions([], actions);
      expect(cal.upsertEvent).toHaveBeenCalledOnce();
    } finally { forward.dispose(); }
  });
  it.each([false, true])('retires the ordinary copy before restoring a native exception with cleanup failure=%s', async failure => {
    await run();
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }).id;
    await run(); const occurrence = structuredClone(store.getAction(saved)!);
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
    const first = ordinaryForward();
    const actions = () => [...store.getActions().keys()].map(id => storeAction(store, id)!);
    try { await first.syncActions([storeAction(store, template)!], actions()); }
    finally { first.dispose(); }
    events.push(event(vi.mocked(cal.upsertEvent).mock.calls[0][0], 'ordinary'));
    vi.spyOn(cal, 'deleteEvent').mockImplementation(async args => {
      expect(events.find(event => event.id === args.eventId)!.url).toBe(args.marker);
      events = events.filter(event => event.id !== args.eventId); return { deleted: true };
    });
    if (failure) vi.mocked(cal.deleteEvent).mockRejectedValueOnce(new Error('Ordinary cleanup unavailable.'));
    store.saveAction(template, { ...action.frontMatter, recurrence: [schedule] }, action.body, store.getActionFile(template)!);
    let resumed = new CalSync(cal, store.getInstance()!.manifest.id!, store);
    try {
      await resumed.syncActions([storeAction(store, template)!], actions());
      if (failure) {
        expect(cal.upsertSeries).toHaveBeenCalledOnce(); expect(events.some(event => event.id === 'ordinary')).toBe(true);
        expect(resumed.status(saved)).toMatchObject({ status: 'pending', retry: true });
        resumed.dispose(); resumed = new CalSync(cal, store.getInstance()!.manifest.id!, store);
        await resumed.syncActions([], actions());
      }
      expect(events.some(event => event.id === 'ordinary')).toBe(false);
      expect(events.filter(event => event.detached)).toHaveLength(1);
      expect(cal.upsertSeries).toHaveBeenCalledTimes(2); expect(cal.upsertEvent).toHaveBeenCalledOnce();
      expect(store.getAction(saved)).toEqual(occurrence);
      const deletion = vi.mocked(cal.deleteEvent).mock.invocationCallOrder.at(-1)!;
      expect(deletion).toBeLessThan(vi.mocked(cal.upsertSeries).mock.invocationCallOrder[1]);
      await resumed.syncActions([], actions());
      expect(cal.deleteEvent).toHaveBeenCalledTimes(failure ? 2 : 1);
      expect(cal.upsertSeries).toHaveBeenCalledTimes(2);
    } finally { resumed.dispose(); }
  });
  it.each(['missing', 'stale'])('adopts an ordinary copy from a %s hint before native publication', async hint => {
    const { saved, action, occurrence, actions } = await ordinaryFixture();
    const mirror = new RecurrenceMirror(dir, store.getInstance()!.manifest.id!);
    if (hint === 'missing') mirror.ordinaryEvents.clear(); else mirror.ordinaryEvents.set(saved, 'old-id');
    mirror.save();
    vi.mocked(cal.listEvents).mockImplementation(async () => ({ events: [...events] }));
    store.saveAction(template, { ...action.frontMatter, recurrence: [schedule] }, action.body, store.getActionFile(template)!);
    const resumed = new CalSync(cal, store.getInstance()!.manifest.id!, store);
    try {
      await resumed.syncActions([storeAction(store, template)!], actions());
      expect(cal.deleteEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'ordinary' }));
      expect(events.some(event => event.id === 'ordinary')).toBe(false);
      expect(events.filter(event => event.detached)).toHaveLength(1);
      expect(store.getAction(saved)).toEqual(occurrence);
    } finally { resumed.dispose(); }
  });
  it('resumes native publication after ordinary cleanup succeeded and its hinted copy is absent on restart', async () => {
    const { saved, action, occurrence, actions } = await ordinaryFixture();
    store.saveAction(template, { ...action.frontMatter, recurrence: [schedule] }, action.body, store.getActionFile(template)!);
    vi.mocked(cal.upsertSeries).mockRejectedValueOnce(new Error('Native publication unavailable.'));
    let resumed = new CalSync(cal, store.getInstance()!.manifest.id!, store);
    try {
      await resumed.syncActions([storeAction(store, template)!], actions());
      expect(cal.deleteEvent).toHaveBeenCalledOnce(); expect(events).toEqual([]);
      expect(resumed.status(saved)).toMatchObject({ status: 'pending', retry: true });
      // Simulate the durable hint lagging a confirmed delete.
      const mirror = new RecurrenceMirror(dir, store.getInstance()!.manifest.id!);
      mirror.ordinaryEvents.set(saved, 'ordinary'); mirror.save();
      resumed.dispose(); resumed = new CalSync(cal, store.getInstance()!.manifest.id!, store);
      await resumed.syncActions([], actions());
      expect(events.some(event => event.seriesHead)).toBe(true);
      expect(events.filter(event => event.detached)).toHaveLength(1);
      expect(cal.deleteEvent).toHaveBeenCalledOnce(); expect(store.getAction(saved)).toEqual(occurrence);
      expect(resumed.status(saved)).toMatchObject({ status: 'synced' });
      store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
      await resumed.syncActions([], actions());
      expect(cal.upsertEvent).toHaveBeenCalledTimes(2);
    } finally { resumed.dispose(); }
  });
  it('preserves a concurrent saved source edit before ordinary retirement', async () => {
    const { saved, action, actions } = await ordinaryFixture();
    store.saveAction(template, { ...action.frontMatter, recurrence: [schedule] }, action.body, store.getActionFile(template)!);
    vi.mocked(cal.getEvents).mockImplementationOnce(async args => {
      const current = store.getAction(saved)!;
      store.saveAction(saved, { ...current.frontMatter, scheduled: '2026-10-10T14:00' }, current.body, store.getActionFile(saved)!);
      return { events: events.filter(event => args.eventIds.includes(event.id)) };
    });
    const resumed = new CalSync(cal, store.getInstance()!.manifest.id!, store);
    try {
      const results = await resumed.syncActions([storeAction(store, template)!], actions());
      expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ id: template, status: 'error' })]));
      expect(cal.deleteEvent).not.toHaveBeenCalled(); expect(cal.upsertSeries).toHaveBeenCalledOnce();
      expect(store.getAction(saved)!.frontMatter.scheduled).toBe('2026-10-10T14:00');
      await resumed.syncActions([], actions());
      expect(events.find(event => event.detached)!.start).toBe('2026-10-10T14:00');
    } finally { resumed.dispose(); }
  });
  it('preserves an unsafe ordinary copy and waits for safe retirement before publishing native work', async () => {
    const { saved, action, occurrence, actions } = await ordinaryFixture();
    events[0].endInstant += 30000; events[0].durationMinutes = 30.5;
    store.saveAction(template, { ...action.frontMatter, recurrence: [schedule] }, action.body, store.getActionFile(template)!);
    const resumed = new CalSync(cal, store.getInstance()!.manifest.id!, store);
    try {
      await resumed.syncActions([storeAction(store, template)!], actions());
      expect(cal.deleteEvent).not.toHaveBeenCalled(); expect(cal.upsertSeries).toHaveBeenCalledOnce();
      expect(store.getAction(saved)).toEqual(occurrence);
      events[0].endInstant -= 30000; events[0].durationMinutes = 30;
      await resumed.syncActions([], actions());
      expect(cal.deleteEvent).toHaveBeenCalledOnce(); expect(cal.upsertSeries).toHaveBeenCalledTimes(2);
      expect(store.getAction(saved)).toEqual(occurrence);
    } finally { resumed.dispose(); }
  });
  it('materializes a projected per-occurrence gesture and reuses its native event', async () => {
    await run();
    events.push({ ...events[0], id: 'second', detached: true, original: '2026-10-10T09:00:00Z', start: '2026-10-10T11:00', end: '2026-10-10T11:30', startInstant: Date.parse('2026-10-10T11:00Z'), endInstant: Date.parse('2026-10-10T11:30Z') });
    const entryCount = store.getEntries().length;
    await run(true);
    const action = [...store.getActions().values()].find(a => a.frontMatter.occurrence)!;
    expect(action.frontMatter.scheduled).toBe('2026-10-10T11:00'); expect(action.frontMatter.occurrence!.original).toBe('2026-10-10T09:00:00Z');
    expect(store.getEntries()).toHaveLength(entryCount); expect(cal.upsertSeries).toHaveBeenCalledOnce();
    await run(true); expect(store.getActions().size).toBe(2);
  });
  it('exports completion as a native exception without repeatedly saving it', async () => {
    await run(); handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', resolution: 'done' });
    await run(); expect(cal.upsertOccurrence).toHaveBeenCalledOnce(); expect(events.find(e => e.detached)?.url).toMatch(/\/done$/);
    await run(true); await run(); expect(cal.upsertOccurrence).toHaveBeenCalledOnce();
  });
  it('removes native series on unpinning and retains saved actions without repeated writes', async () => {
    await run(); handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', resolution: 'done' }); await run();
    const action = store.getAction(template)!; const { calendar, ...fm } = action.frontMatter; store.saveAction(template, fm, action.body, store.getActionFile(template)!);
    await run(); expect(cal.deleteSeries).toHaveBeenCalled();
    const forward = ordinaryForward();
    try {
      const actions = [...store.getActions().keys()].map(id => storeAction(store, id)!);
      await forward.syncActions([storeAction(store, template)!], actions);
      expect(cal.upsertEvent).toHaveBeenCalledOnce();
      await forward.syncActions([], actions);
      expect(cal.upsertEvent).toHaveBeenCalledOnce(); expect(store.getActions().size).toBe(2);
    } finally { forward.dispose(); }
  });
  it('does not import recurrence rule or whole-series timing edits', async () => {
    await run(); const before = JSON.stringify(store.getAction(template));
    events[0] = { ...events[0], start: '2026-10-09T11:00', seriesRule: { frequency: 'weekly', interval: 1 } };
    await run(true); expect(JSON.stringify(store.getAction(template))).toBe(before); expect(store.getActions().size).toBe(1);
  });
  it('removes a replaced future family after restart, before publishing its replacement', async () => {
    await run(); const oldMarker = events[0].url;
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ ...schedule, dtstart: '2026-10-12T09:00' }] }, action.body, store.getActionFile(template)!);
    sync = new RecurrenceCalSync(cal);
    await run();
    expect(cal.deleteSeries).toHaveBeenCalledWith(expect.objectContaining({ marker: oldMarker }));
    expect(events).toHaveLength(1); expect(events[0].start).toBe('2026-10-12T09:00');
    expect(vi.mocked(cal.deleteSeries).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(cal.upsertSeries).mock.invocationCallOrder[1]);
  });
  it('prunes a removed time-of-day decomposition phase', async () => {
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ ...schedule, rrule: 'FREQ=DAILY;BYHOUR=9,17' }] }, action.body, store.getActionFile(template)!);
    await run(); expect(events).toHaveLength(2);
    const removedMarker = events.find(e => e.start.endsWith('17:00'))!.url;
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ ...schedule, rrule: 'FREQ=DAILY;BYHOUR=9' }] }, action.body, store.getActionFile(template)!);
    await run(); expect(events).toHaveLength(1);
    expect(cal.deleteSeries).toHaveBeenCalledWith(expect.objectContaining({ marker: removedMarker }));
  });
  it('restores a whole-series timing or all-day edit from Aside', async () => {
    await run();
    events[0] = { ...events[0], start: '2026-10-09T11:00', end: '2026-10-09T11:30', startInstant: Date.parse('2026-10-09T11:00Z'), endInstant: Date.parse('2026-10-09T11:30Z') };
    await run(true); expect(events[0].start).toBe(schedule.dtstart); expect(store.getActions().size).toBe(1);
    events[0] = { ...events[0], allDay: true, timezone: null };
    await run(true); expect(events[0].allDay).toBeFalsy(); expect(store.getActions().size).toBe(1);
    expect(cal.upsertSeries).toHaveBeenCalledTimes(3);
  });
  it('does not interpret its own cancellation removal as descheduling, including after restart', async () => {
    await run(); handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', resolution: 'done' }); await run(); await run(true);
    handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', resolution: 'cancelled' }); await run();
    sync = new RecurrenceCalSync(cal); await run(true);
    const action = [...store.getActions().values()].find(a => a.frontMatter.occurrence)!;
    expect(action.frontMatter.scheduled).toBe('2026-10-10T09:00'); expect(action.frontMatter.resolution).toBe('cancelled');
  });
  it('imports all witnessed per-occurrence deletions in one pass after restart', async () => {
    await run();
    for (const day of ['10','11']) events.push({ ...events[0], id: 'day-' + day, seriesHead: false,
      original: `2026-10-${day}T09:00:00Z`, start: `2026-10-${day}T09:00`, end: `2026-10-${day}T09:30`,
      startInstant: Date.parse(`2026-10-${day}T09:00Z`), endInstant: Date.parse(`2026-10-${day}T09:30Z`) });
    await run(true); events = events.filter(e => e.seriesHead); sync = new RecurrenceCalSync(cal);
    await run(true);
    const actions = [...store.getActions().values()].filter(a => a.frontMatter.occurrence);
    expect(actions).toHaveLength(2); expect(actions.every(a => !a.frontMatter.scheduled)).toBe(true);
    expect(actions.map(a => a.frontMatter.occurrence!.original).sort()).toEqual(['2026-10-10T09:00:00Z','2026-10-11T09:00:00Z']);
  });
  it('discovers a native detached item ten years away and a move six years farther without date windows', async () => {
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ ...schedule, rrule: 'FREQ=YEARLY' }] }, action.body, store.getActionFile(template)!);
    await run();
    events.push({ ...events[0], id: 'distant', detached: true, seriesHead: false, original: '2036-10-09T09:00:00Z',
      start: '2042-10-09T11:00', end: '2042-10-09T11:30', startInstant: Date.parse('2042-10-09T11:00Z'), endInstant: Date.parse('2042-10-09T11:30Z') });
    await run(true);
    const occurrence = [...store.getActions().values()].find(a => a.frontMatter.occurrence)!;
    expect(occurrence.frontMatter.occurrence!.original).toBe('2036-10-09T09:00:00Z'); expect(occurrence.frontMatter.scheduled).toBe('2042-10-09T11:00');
    await run(true);
    expect(cal.getSeries).toHaveBeenCalledWith(expect.objectContaining({ externalId: events[0].externalId }));
    expect(cal.listEvents).not.toHaveBeenCalled();
  });

  it('preserves a new Aside occurrence edit when an older native exception is read first', async () => {
    await run(); handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }); await run(); await run(true);
    handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T14:00' });
    await run(true);
    const action = [...store.getActions().values()].find(a => a.frontMatter.occurrence)!;
    expect(action.frontMatter.scheduled).toBe('2026-10-10T14:00'); expect(events.find(event => event.detached)!.start).toBe('2026-10-10T14:00');
  });

  it('recovers an unsafe native exception only after an explicit unambiguous Aside start edit', async () => {
    await run(); handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T11:00' }); await run();
    const exception = events.find(event => event.detached)!;
    exception.endInstant += 30000; exception.durationMinutes = 30.5;
    expect(await run(true)).toMatchObject([{ id: template, status: 'error' }]);
    const writes = vi.mocked(cal.upsertOccurrence).mock.calls.length;
    handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', name: 'Renamed', duration: 'PT45M' });
    expect(await run()).toMatchObject([{ id: template, status: 'error' }]);
    expect(cal.upsertOccurrence).toHaveBeenCalledTimes(writes);
    handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00:00Z', scheduled: '2026-10-10T14:00' });
    expect(await run()).toEqual(expect.arrayContaining([expect.objectContaining({ id: template, status: 'synced' })]));
    expect(cal.upsertOccurrence).toHaveBeenLastCalledWith(expect.objectContaining({ allowTimeReplacement: true, start: '2026-10-10T14:00', durationMinutes: 45 }));
    expect(events.find(event => event.detached)!.start).toBe('2026-10-10T14:00');
  });

  it('materializes a normalized floating-gap Calendar gesture with its literal occurrence identity', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ dtstart: '2027-03-13T02:30', rrule: 'FREQ=DAILY;COUNT=3' }] }, action.body, store.getActionFile(template)!);
    await run();
    events.push({ ...events[0], id: 'gap', seriesHead: false, detached: true, url: events[0].url + '/done',
      original: '2027-03-14T03:30', originalLocal: '2027-03-14T03:30', originalInstant: Date.parse('2027-03-14T10:30Z'),
      start: '2027-03-14T03:30', end: '2027-03-14T04:00', startInstant: Date.parse('2027-03-14T10:30Z'), endInstant: Date.parse('2027-03-14T11:00Z') });
    await run(true);
    const occurrence = [...store.getActions().values()].find(action => action.frontMatter.occurrence)!;
    expect(occurrence.frontMatter).toMatchObject({ occurrence: { template, original: '2027-03-14T02:30' }, scheduled: '2027-03-14T03:30', resolution: 'done' });
    const writes = vi.mocked(cal.upsertOccurrence).mock.calls.length;
    await run(true); await run(); expect(cal.upsertOccurrence).toHaveBeenCalledTimes(writes);
  });

  it('confirms floating-gap normalization for an Aside completion without changing its provenance', async () => {
    process.env.TZ = 'America/Los_Angeles';
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ dtstart: '2027-03-13T02:30', rrule: 'FREQ=DAILY;COUNT=3' }] }, action.body, store.getActionFile(template)!);
    await run(); handleUpdateOccurrence(store, { template, original: '2027-03-14T02:30', resolution: 'done' });
    await run();
    const occurrence = [...store.getActions().values()].find(action => action.frontMatter.occurrence)!;
    expect(occurrence.frontMatter).toMatchObject({ occurrence: { template, original: '2027-03-14T02:30' }, scheduled: '2027-03-14T03:30', resolution: 'done' });
    expect(cal.getEvents).toHaveBeenCalled();
    const writes = vi.mocked(cal.upsertOccurrence).mock.calls.length;
    await run(true); await run(); expect(cal.upsertOccurrence).toHaveBeenCalledTimes(writes);
  });

  it('diagnoses a floating first anchor in a DST gap rather than shift its entire native pattern', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(() => nativeSeries({ dtstart: '2027-03-14T02:30', rrule: 'FREQ=DAILY' })).toThrow('anchor inside a local daylight-saving gap');
  });

  it('retains an exported floating exception lookup hint when confirmation fails', async () => {
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [{ dtstart: '2026-10-09T09:00', rrule: 'FREQ=DAILY;COUNT=3' }] }, action.body, store.getActionFile(template)!);
    await run(); handleUpdateOccurrence(store, { template, original: '2026-10-10T09:00', scheduled: '2042-10-10T11:00' });
    vi.mocked(cal.getEvents).mockRejectedValueOnce(new Error('Read interrupted.'));
    expect(await run()).toMatchObject([{ id: template, status: 'error' }]);
    sync = new RecurrenceCalSync(cal); await run();
    expect(cal.getSeries).toHaveBeenLastCalledWith(expect.objectContaining({ occurrences: expect.arrayContaining([expect.objectContaining({ original: '2026-10-10T09:00', eventId: 'exception', start: '2042-10-10T11:00' })]) }));
  });

});
