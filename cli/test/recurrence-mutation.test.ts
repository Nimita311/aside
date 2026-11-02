import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRecurrenceMutation, assertRecurrence, assertRecurrenceUpdate, CompiledRecurrence, planningActions, type RecurrenceMutation } from '../src/core/recurrence.js';
import { parseActionFile } from '../src/core/parser.js';
import { serializeAction } from '../src/mcp/tools/serialize.js';

const now = new Date('2026-10-09T12:30:00Z');
const daily = { dtstart: '2026-01-01', rrule: 'FREQ=DAILY' };
beforeEach(() => { vi.stubEnv('TZ', 'UTC'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('bounded recurrence mutations', () => {
  it('removes historical schedules without changing any retained schedule', () => {
    const first = { ...daily, rrule: 'FREQ=DAILY;UNTIL=20260131' };
    const second = { dtstart: '2026-02-01', rrule: 'FREQ=WEEKLY' };
    expect(applyRecurrenceMutation([first, second], { remove: { dtstart: first.dtstart } }, now)).toEqual([second]);
    expect(applyRecurrenceMutation([first], { remove: { dtstart: first.dtstart } }, now)).toEqual([]);
    expect(() => assertRecurrenceUpdate([first], [], now)).not.toThrow();
  });

  it('keeps an empty recurrence as a dormant template across serialization', () => {
    expect(assertRecurrence([])).toEqual([]);
    const action = { frontMatter: { name: 'Routine', created: '2026-01-01T09:00', recurrence: [] }, body: 'Reusable' };
    expect(parseActionFile(serializeAction(action.frontMatter, action.body)).value.frontMatter.recurrence).toEqual([]);
    expect(planningActions(new Map([['t', action]]), { now }).nodes).toEqual([]);
    const future = { dtstart: '2026-11-01', rrule: 'FREQ=DAILY' };
    expect(applyRecurrenceMutation([], { append: future }, now)).toEqual([future]);
    expect(() => applyRecurrenceMutation([], { append: daily }, now)).toThrow('before now');
    expect(() => assertRecurrenceUpdate([], [daily], now)).toThrow('before now');
  });

  it('allows ending an applied rule in the past', () => {
    expect(applyRecurrenceMutation([daily], { set_end: { schedule: { dtstart: daily.dtstart }, at: '2026-02-01T00:00Z' } }, now)).toEqual([
      { ...daily, rrule: 'FREQ=DAILY;UNTIL=20260131' },
    ]);
  });

  it('defaults the exclusive end to now and translates native date or timed UNTIL', () => {
    expect(applyRecurrenceMutation([daily], { set_end: { schedule: { dtstart: daily.dtstart } } }, now)[0].rrule).toBe('FREQ=DAILY;UNTIL=20261009');
    const timed = { dtstart: '2026-01-01T09:00', rrule: 'FREQ=DAILY' };
    expect(applyRecurrenceMutation([timed], { set_end: { schedule: { dtstart: timed.dtstart } } }, now)[0].rrule).toBe('FREQ=DAILY;UNTIL=20261009T090000');
  });

  it('excludes an occurrence exactly on the boundary but includes it after a fractional boundary', () => {
    const timed = { dtstart: '2026-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    const schedule = { dtstart: timed.dtstart, timezone: timed.timezone };
    expect(applyRecurrenceMutation([timed], { set_end: { schedule, at: '2026-01-02T09:00:00Z' } }, now)[0].rrule).toBe('FREQ=DAILY;UNTIL=20260101T090000Z');
    expect(applyRecurrenceMutation([timed], { set_end: { schedule, at: '2026-01-02T09:00:00.000000001Z' } }, now)[0].rrule).toBe('FREQ=DAILY;UNTIL=20260102T090000Z');
    expect(applyRecurrenceMutation([timed], { set_end: { schedule, at: '2026-01-01T09:00:00.000000001Z' } }, now)[0].rrule).toBe('FREQ=DAILY;UNTIL=20260101T090000Z');
  });

  it('preserves positive fractional cutoffs before the Unix epoch', () => {
    const timed = { dtstart: '1969-12-31T23:59', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    expect(applyRecurrenceMutation([timed], { set_end: { schedule: { dtstart: timed.dtstart, timezone: timed.timezone }, at: '1969-12-31T23:59:00.000000001Z' } }, now)[0].rrule).toBe('FREQ=DAILY;UNTIL=19691231T235900Z');
  });

  it('rejects an end at or before DTSTART instead of writing an invalid empty rule', () => {
    for (const at of ['2026-01-01T00:00Z', '2025-12-31T23:59:59.999999999Z']) expect(() => applyRecurrenceMutation([daily], { set_end: { schedule: { dtstart: daily.dtstart }, at } }, now)).toThrow('after DTSTART');
  });

  it('finds the new end independently of the existing COUNT or UNTIL', () => {
    for (const rrule of ['FREQ=DAILY;COUNT=2', 'FREQ=DAILY;UNTIL=20260102', 'RRULE:COUNT=2;FREQ=DAILY', 'RRULE:UNTIL=20260102;FREQ=DAILY']) {
      const previous = { ...daily, rrule };
      const result = applyRecurrenceMutation([previous], { set_end: { schedule: { dtstart: daily.dtstart }, at: '2026-01-05T00:00Z' } }, new Date('2026-01-02T12:00:00Z'));
      expect(result[0].rrule).toBe((rrule.startsWith('RRULE:') ? 'RRULE:' : '') + 'FREQ=DAILY;UNTIL=20260104');
    }
  });

  it('selects the exact wall DTSTART and zone, including floating schedules', () => {
    const zoned = { dtstart: '2027-01-01T09:00', timezone: 'Asia/Tokyo', rrule: 'FREQ=DAILY;COUNT=1' };
    const floating = { dtstart: zoned.dtstart, rrule: 'FREQ=DAILY' };
    const before = assertRecurrence([zoned, floating]);
    expect(applyRecurrenceMutation(before, { remove: { dtstart: floating.dtstart } }, now)).toEqual([zoned]);
    expect(applyRecurrenceMutation(before, { remove: { dtstart: zoned.dtstart, timezone: zoned.timezone } }, now)).toEqual([floating]);
    expect(() => applyRecurrenceMutation(before, { remove: { dtstart: zoned.dtstart, timezone: 'UTC' } }, now)).toThrow('not found');
  });

  it('rejects end extensions that overlap the neighboring schedule', () => {
    const first = { ...daily, rrule: 'FREQ=DAILY;UNTIL=20260131' };
    const second = { dtstart: '2026-02-01', rrule: 'FREQ=WEEKLY' };
    expect(() => applyRecurrenceMutation([first, second], { set_end: { schedule: { dtstart: first.dtstart }, at: '2026-02-02T00:00Z' } }, now, new Set(['2026-02-01']))).toThrow('nonoverlapping');
  });

  it('appends after queued future anchors and preserves all earlier history', () => {
    const active = { ...daily, rrule: 'FREQ=DAILY;UNTIL=20261130' };
    const queued = { dtstart: '2026-12-01', rrule: 'FREQ=DAILY' };
    const next = { dtstart: '2027-01-01', rrule: 'FREQ=WEEKLY' };
    expect(applyRecurrenceMutation([active, queued], { append: next }, now)).toEqual([active, { ...queued, rrule: 'FREQ=DAILY;UNTIL=20261231' }, next]);
    expect(() => applyRecurrenceMutation([active, queued], { append: { dtstart: '2026-11-01', rrule: 'FREQ=DAILY' } }, now)).toThrow('after the final schedule');
  });

  it.each(['2026-02-30T00:00Z', '2026-01-02T00:00', '2026-01-02T00:00+2500', '2026-01-02T00:00+24:00', '2026-01-02T00:00:60Z', '2026-01-02T00:00:00.0000000001Z'])('rejects invalid or unqualified end timestamp %s', at => {
    expect(() => applyRecurrenceMutation([daily], { set_end: { schedule: { dtstart: daily.dtstart }, at } }, now)).toThrow('valid ISO timestamp');
  });

  it('accepts a qualified minute timestamp with a colon offset', () => {
    const zoned = { dtstart: '2026-01-01T09:00', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY' };
    expect(applyRecurrenceMutation([zoned], { set_end: { schedule: { dtstart: zoned.dtstart, timezone: zoned.timezone }, at: '2026-01-03T09:00-08:00' } }, now)[0].rrule).toBe('FREQ=DAILY;UNTIL=20260102T170000Z');
  });

  it.each([{}, { append: daily, remove: { dtstart: daily.dtstart } }, { set_end: { schedule: { dtstart: daily.dtstart }, unknown: true } }, { remove: { dtstart: daily.dtstart, rrule: daily.rrule } }])('rejects malformed command shapes', mutation => {
    expect(() => applyRecurrenceMutation([daily], mutation as RecurrenceMutation, now)).toThrow();
  });

  it('keeps source-authored historical patterns immutable while allowing removals', () => {
    expect(() => assertRecurrenceUpdate([daily], [{ ...daily, rrule: 'FREQ=WEEKLY' }], now)).toThrow('before now');
    expect(() => assertRecurrenceUpdate([daily], [{ ...daily, dtstart: '2026-01-02' }], now)).toThrow('before now');
    expect(() => assertRecurrenceUpdate([daily], undefined, now)).not.toThrow();
    expect(() => assertRecurrenceUpdate(undefined, [daily], now)).not.toThrow();
  });
});

describe('no new past projections', () => {
  it('rejects historical end extension unless every added original is materialized', () => {
    const previous = { ...daily, rrule: 'FREQ=DAILY;COUNT=2' };
    const mutation = { set_end: { schedule: { dtstart: daily.dtstart }, at: '2026-01-05T00:00Z' } };
    expect(() => applyRecurrenceMutation([previous], mutation, now)).toThrow('new past projections');
    expect(() => applyRecurrenceMutation([previous], mutation, now, new Set(['2026-01-03', '2099-01-01']))).toThrow('new past projections');
    expect(applyRecurrenceMutation([previous], mutation, now, new Set(['2026-01-03', '2026-01-04']))[0].rrule).toBe('FREQ=DAILY;UNTIL=20260104');
  });

  it('requires exact UTC originals for a zoned historical extension', () => {
    const previous = { dtstart: '2026-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY;COUNT=2' };
    const mutation = { set_end: { schedule: { dtstart: previous.dtstart, timezone: previous.timezone }, at: '2026-01-05T09:00Z' } };
    expect(() => applyRecurrenceMutation([previous], mutation, now, new Set(['2026-01-03T09:00', '2026-01-04T09:00']))).toThrow('new past projections');
    expect(applyRecurrenceMutation([previous], mutation, now, new Set(['2026-01-03T09:00:00Z', '2026-01-04T09:00:00Z']))[0].rrule).toBe('FREQ=DAILY;UNTIL=20260104T090000Z');
  });

  it('does not count newly uncovered future projections as historical additions', () => {
    const previous = { ...daily, rrule: 'FREQ=DAILY;COUNT=2' };
    expect(() => applyRecurrenceMutation([previous], { set_end: { schedule: { dtstart: previous.dtstart }, at: '2026-01-20T00:00Z' } }, new Date('2026-01-02T12:00:00Z'))).not.toThrow();
  });

  it('rejects a large historical expansion by rank without enumerating occurrences', () => {
    const previous = { dtstart: '2000-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=MINUTELY;BYHOUR=9,17;COUNT=1' };
    const next = { ...previous, rrule: 'FREQ=MINUTELY;BYHOUR=9,17;COUNT=1000000000' };
    const iterator = vi.spyOn(CompiledRecurrence.prototype, 'occurrences').mockImplementation(function* () { throw new Error('Historical occurrences were enumerated'); });
    expect(() => assertRecurrenceUpdate([previous], [next], now)).toThrow('new past projections');
    expect(iterator).not.toHaveBeenCalled();
  });

  it.each([undefined, 'America/Los_Angeles'])('covers added first-fold history for timezone %s', timezone => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const previous = { dtstart: '2026-10-31T01:30', timezone, rrule: timezone ? 'FREQ=DAILY;UNTIL=20261101T081500Z' : 'FREQ=DAILY;UNTIL=20261101T011500' };
    const mutation = { set_end: { schedule: { dtstart: previous.dtstart, ...(timezone && { timezone }) }, at: '2026-11-01T09:15:00Z' } };
    const repeatedNow = new Date('2026-11-01T09:15:00Z');
    expect(() => applyRecurrenceMutation([previous], mutation, repeatedNow)).toThrow('new past projections');
    const original = timezone ? '2026-11-01T08:30:00Z' : '2026-11-01T01:30';
    expect(applyRecurrenceMutation([previous], mutation, repeatedNow, new Set([original]))[0].rrule).toBe(timezone ? 'FREQ=DAILY;UNTIL=20261101T083000Z' : 'FREQ=DAILY;UNTIL=20261101T013000');
  });

  it('detects floating gap additions even when the past occurrence count is unchanged', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const previous = { dtstart: '2026-03-07T02:55', rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=5,55;UNTIL=20260308T030500' };
    const next = { ...previous, rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=5,55;COUNT=5' };
    const afterGap = new Date('2026-03-08T19:00:00Z');
    expect(() => assertRecurrenceUpdate([previous], [next], afterGap)).toThrow('new past projections');
    expect(() => assertRecurrenceUpdate([previous], [next], afterGap, new Set(['2026-03-08T02:55']))).not.toThrow();
  });

  it('counts literal floating gap projections as past before their normalized instant', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const previous = { dtstart: '2026-03-07T02:55', rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=5,55;UNTIL=20260308T030500' };
    const next = { ...previous, rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=5,55;UNTIL=20260308T035500' };
    const withinGapNormalization = new Date('2026-03-08T10:10:00Z');
    expect(() => assertRecurrenceUpdate([previous], [next], withinGapNormalization)).toThrow('new past projections');
    expect(() => assertRecurrenceUpdate([previous], [next], withinGapNormalization, new Set(['2026-03-08T02:55']))).not.toThrow();
  });

  it('keeps tomorrow\'s all-day occurrence future during a repeated final hour', () => {
    vi.stubEnv('TZ', 'America/Santiago');
    const previous = { dtstart: '2026-04-04', rrule: 'FREQ=DAILY;COUNT=1' };
    const repeatedNow = new Date('2026-04-05T03:30:00Z');
    expect(applyRecurrenceMutation([previous], { set_end: {
      schedule: { dtstart: previous.dtstart }, at: '2026-04-06T04:00:00Z',
    } }, repeatedNow)[0].rrule).toBe('FREQ=DAILY;UNTIL=20260405');
  });

  it('considers today\'s all-day occurrence historical only after its actual midnight', () => {
    vi.stubEnv('TZ', 'America/Santiago');
    const previous = { dtstart: '2026-04-04', rrule: 'FREQ=DAILY;COUNT=1' };
    const next = { ...previous, rrule: 'FREQ=DAILY;COUNT=2' };
    expect(() => assertRecurrenceUpdate([previous], [next], new Date('2026-04-05T04:00:00Z'))).not.toThrow();
    expect(() => assertRecurrenceUpdate([previous], [next], new Date('2026-04-05T04:00:00.001Z'))).toThrow('new past projections');
  });
});
