import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendRecurrenceSchedule, assertRecurrence, CompiledRecurrence } from '../src/core/recurrence.js';

const now = new Date('2026-10-09T18:00:00Z');
const weekly = { dtstart: '2026-10-02T09:00', timezone: 'America/Los_Angeles', rrule: 'FREQ=WEEKLY;BYDAY=FR' };
const monthly = { dtstart: '2026-11-02T09:00', timezone: 'America/Los_Angeles', rrule: 'FREQ=MONTHLY;BYDAY=1MO' };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('append-only recurrence schedules', () => {
  it('starts a new recurrence with a valid future schedule', () => {
    expect(appendRecurrenceSchedule(undefined, monthly, now)).toEqual([monthly]);
    expect(() => appendRecurrenceSchedule(undefined, weekly, now)).toThrow('before now');
    expect(() => appendRecurrenceSchedule(undefined, { ...monthly, rrule: 'FREQ=WEEKLY;BYDAY=TU' }, now)).toThrow('dtstart must match');
  });

  it('preserves earlier schedules and closes only the final pattern', () => {
    const first = { dtstart: '2026-01-01T09:00', timezone: weekly.timezone, rrule: 'FREQ=DAILY;COUNT=2' };
    const before = [first, weekly];
    const appended = appendRecurrenceSchedule(before, monthly, now);
    expect(appended).toEqual([first, { ...weekly, rrule: weekly.rrule + ';UNTIL=20261030T160000Z' }, monthly]);
    expect(appended[0]).toBe(first);
    expect(before).toEqual([first, weekly]);
  });

  it('retains the ending text of an already-ended COUNT or UNTIL rule', () => {
    for (const rrule of ['RRULE:FREQ=DAILY;COUNT=2', 'FREQ=DAILY;UNTIL=20260102']) {
      const previous = { dtstart: '2026-01-01', rrule };
      const next = { dtstart: '2026-11-02', rrule: 'FREQ=DAILY' };
      const appended = appendRecurrenceSchedule([previous], next, now);
      expect(appended).toEqual([previous, next]);
      expect(appended[0]).toBe(previous);
    }
  });

  it('closes an all-day COUNT with a date UNTIL and preserves the anchor', () => {
    const previous = { dtstart: '2026-01-01', rrule: 'FREQ=DAILY;COUNT=1000' };
    const next = { dtstart: '2026-11-12', rrule: 'FREQ=WEEKLY' };
    expect(appendRecurrenceSchedule([previous], next, now)).toEqual([
      { ...previous, rrule: 'FREQ=DAILY;UNTIL=20261111' }, next,
    ]);
  });

  it('shortens an existing UNTIL rather than keeping two endings', () => {
    const previous = { dtstart: '2027-01-01', rrule: 'RRULE:FREQ=DAILY;UNTIL=20270131' };
    const next = { dtstart: '2027-01-15', rrule: 'FREQ=WEEKLY' };
    expect(appendRecurrenceSchedule([previous], next, now)).toEqual([
      { ...previous, rrule: 'RRULE:FREQ=DAILY;UNTIL=20270114' }, next,
    ]);
  });

  it('closes a floating rule using its local inclusive UNTIL', () => {
    const previous = { dtstart: weekly.dtstart, rrule: weekly.rrule };
    const next = { dtstart: monthly.dtstart, rrule: monthly.rrule };
    expect(appendRecurrenceSchedule([previous], next, now)).toEqual([
      { ...previous, rrule: weekly.rrule + ';UNTIL=20261030T090000' }, next,
    ]);
  });

  it('excludes the exact boundary occurrence from the preceding rule', () => {
    const previous = { dtstart: '2026-10-02T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    const next = { dtstart: '2026-10-16T09:00', timezone: 'UTC', rrule: 'FREQ=WEEKLY' };
    expect(appendRecurrenceSchedule([previous], next, now)[0].rrule).toBe('FREQ=DAILY;UNTIL=20261015T090000Z');
  });

  it('accepts an anchor at now but rejects backdated or reordered appends', () => {
    const next = { dtstart: '2026-10-09T18:00', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    expect(appendRecurrenceSchedule(undefined, next, now)).toEqual([next]);
    expect(() => appendRecurrenceSchedule([weekly], weekly, new Date('2026-10-01T00:00:00Z'))).toThrow('after the final schedule');
    expect(() => appendRecurrenceSchedule([monthly], { ...monthly, dtstart: '2026-10-26T09:00', rrule: 'FREQ=WEEKLY' }, now)).toThrow('after the final schedule');
    expect(() => appendRecurrenceSchedule([weekly], { ...next, dtstart: '2026-10-09T17:59' }, now)).toThrow('before now');
  });

  it('rejects invalid preceding history and mixing all-day with timed schedules', () => {
    expect(() => appendRecurrenceSchedule([weekly, weekly], monthly, now)).toThrow('nonoverlapping');
    expect(() => appendRecurrenceSchedule([{ dtstart: '2026-01-01', rrule: 'FREQ=DAILY' }], monthly, now)).toThrow('cannot mix');
  });

  it('cuts a large filtered COUNT without computing a distant endpoint', () => {
    const previous = { dtstart: '2000-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=MINUTELY;BYHOUR=9,17;COUNT=1000000000' };
    const next = { dtstart: '2026-10-10T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    const endpoint = vi.spyOn(CompiledRecurrence.prototype, 'lastInstant').mockImplementation(() => { throw new Error('Distant endpoint was computed'); });
    expect(appendRecurrenceSchedule([previous], next, now)[0].rrule).toBe('FREQ=MINUTELY;BYHOUR=9,17;UNTIL=20261009T175900Z');
    expect(endpoint).not.toHaveBeenCalled();
  });

  it('preserves a zoned first-fold occurrence before a second-fold boundary', () => {
    const previous = { dtstart: '2026-10-31T01:30', timezone: weekly.timezone, rrule: 'FREQ=DAILY' };
    const next = { dtstart: '2026-11-01T09:15', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    const appended = appendRecurrenceSchedule([previous], next, new Date('2026-11-01T09:00:00Z'));
    expect(appended[0].rrule).toBe('FREQ=DAILY;UNTIL=20261101T083000Z');
    expect([...new CompiledRecurrence(appended[0]).occurrences('t')].map(row => row.identity.original)).toEqual([
      '2026-10-31T08:30:00Z', '2026-11-01T08:30:00Z',
    ]);
  });

  it('retains a floating gap identity when using the last authored occurrence', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const previous = { dtstart: '2026-03-07T02:30', rrule: 'FREQ=DAILY' };
    const next = { dtstart: '2026-03-09T02:30', rrule: 'FREQ=WEEKLY' };
    const appended = appendRecurrenceSchedule([previous], next, new Date('2026-03-07T19:00:00Z'));
    expect(appended[0].rrule).toBe('FREQ=DAILY;UNTIL=20260308T023000');
    expect([...new CompiledRecurrence(appended[0]).occurrences('t')].map(row => row.identity.original)).toEqual([
      '2026-03-07T02:30', '2026-03-08T02:30',
    ]);
  });

  it('places a changed timezone boundary in the old timezone', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const previous = { dtstart: '2026-10-01T09:00', rrule: 'FREQ=DAILY' };
    const next = { dtstart: '2026-10-10T12:00', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    expect(appendRecurrenceSchedule([previous], next, now)[0].rrule).toBe('FREQ=DAILY;UNTIL=20261009T090000');
  });

  it('closes a mixed-zone gap boundary at the preceding actual occurrence', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const previous = { dtstart: '2026-03-07T02:30', rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=30' };
    const next = { dtstart: '2026-03-08T10:00', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    expect(appendRecurrenceSchedule([previous], next, new Date('2026-03-07T19:00:00Z'))[0].rrule).toBe('FREQ=DAILY;BYHOUR=2,3;BYMINUTE=30;UNTIL=20260307T033000');
  });

  it('detects an already-ended floating COUNT that overlaps a zoned gap boundary', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const previous = { dtstart: '2026-03-07T02:30', rrule: 'FREQ=DAILY;COUNT=2' };
    const next = { dtstart: '2026-03-08T10:00', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    expect(() => assertRecurrence([previous, next])).toThrow('nonoverlapping');
    expect(appendRecurrenceSchedule([previous], next, new Date('2026-03-07T19:00:00Z'))[0].rrule).toBe('FREQ=DAILY;UNTIL=20260307T023000');
  });

  it.each([
    ['Australia/Lord_Howe', '2026-10-03T02:15', '2026-10-03T15:30', '2026-10-03T03:00:00Z'],
    ['Pacific/Apia', '2011-12-29T09:00', '2011-12-30T10:00', '2011-12-29T22:00:00Z'],
  ])('uses the actual gap width for floating overlap in %s', (zone, dtstart, boundary, current) => {
    vi.stubEnv('TZ', zone);
    const previous = { dtstart, rrule: 'FREQ=DAILY;COUNT=2' };
    const next = { dtstart: boundary, timezone: 'UTC', rrule: 'FREQ=DAILY' };
    expect(() => assertRecurrence([previous, next])).toThrow('nonoverlapping');
    expect(() => assertRecurrence(appendRecurrenceSchedule([previous], next, new Date(current)))).not.toThrow();
  });

  it('detects floating gap overlap even when a later wall clock precedes the boundary', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const previous = { dtstart: '2026-03-07T02:55', rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=5,55;COUNT=6' };
    const next = { dtstart: '2026-03-08T10:10', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    expect(() => assertRecurrence([previous, next])).toThrow('nonoverlapping');
    const appended = appendRecurrenceSchedule([previous], next, new Date('2026-03-07T19:00:00Z'));
    expect(appended[0].rrule).toBe('FREQ=DAILY;BYHOUR=2,3;BYMINUTE=5,55;UNTIL=20260308T030500');
    expect(() => assertRecurrence(appended)).not.toThrow();
  });

  it('retains first-fold history when closing at a mixed-zone second-fold boundary', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const previous = { dtstart: '2026-10-31T01:30', rrule: 'FREQ=DAILY' };
    const next = { dtstart: '2026-11-01T09:15', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    const appended = appendRecurrenceSchedule([previous], next, new Date('2026-11-01T09:00:00Z'));
    expect(appended[0].rrule).toBe('FREQ=DAILY;UNTIL=20261101T013000');
  });

  it('retains historical offset seconds in the zoned UNTIL', () => {
    const previous = { dtstart: '1971-01-01T09:00', timezone: 'Africa/Monrovia', rrule: 'FREQ=DAILY' };
    const next = { dtstart: '1971-01-03T09:00', timezone: previous.timezone, rrule: 'FREQ=WEEKLY' };
    expect(appendRecurrenceSchedule([previous], next, new Date('1971-01-02T10:00:00Z'))[0].rrule).toBe('FREQ=DAILY;UNTIL=19710102T094430Z');
  });

  it('orders consecutive all-day dates independently of a skipped local day', () => {
    vi.stubEnv('TZ', 'Pacific/Apia');
    const previous = { dtstart: '2011-12-30', rrule: 'FREQ=DAILY;COUNT=1' };
    const next = { dtstart: '2011-12-31', rrule: 'FREQ=DAILY' };
    expect(assertRecurrence([previous, next])).toEqual([previous, next]);
    expect(appendRecurrenceSchedule([previous], next, new Date('2011-12-30T10:00:00Z'))).toEqual([previous, next]);
  });

  it('rejects literal all-day overlap on a skipped local day and closes it on append', () => {
    vi.stubEnv('TZ', 'Pacific/Apia');
    const previous = { dtstart: '2011-12-29', rrule: 'FREQ=DAILY;COUNT=2' };
    const next = { dtstart: '2011-12-30', rrule: 'FREQ=DAILY' };
    expect(() => assertRecurrence([previous, next])).toThrow('nonoverlapping');
    expect(appendRecurrenceSchedule([previous], next, new Date('2011-12-29T22:00:00Z'))).toEqual([
      { ...previous, rrule: 'FREQ=DAILY;UNTIL=20111229' }, next,
    ]);
  });
});
