import { afterEach, describe, expect, it, vi } from 'vitest';
import { futureActionProjections } from '../src/core/action-projections.js';
import { occurrenceKey } from '../src/core/recurrence.js';
import type { RecurrenceSchedule } from '../src/core/recurrence.js';
import type { Action } from '../src/core/types.js';

const action = (recurrence: RecurrenceSchedule[]): Action => ({
  frontMatter: { name: 'Repeat', created: '2026-01-01T09:00', recurrence }, body: 'Instructions',
});
const originals = (result: ReturnType<typeof futureActionProjections>) => result.nodes.map(node => node.action.frontMatter.occurrence!.original);

afterEach(() => vi.unstubAllEnvs());

describe('finite action projections', () => {
  it('includes today’s all-day occurrence with zero lookahead, but no timed occurrence', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const actions = new Map([
      ['all-day', action([{ dtstart: '2026-01-01', rrule: 'FREQ=DAILY' }])],
      ['timed', action([{ dtstart: '2026-01-01T12:00', rrule: 'FREQ=DAILY' }])],
    ]);
    const result = futureActionProjections(actions, { now: new Date('2026-10-10T18:00:00Z'), lookaheadDays: 0 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-10-10']);
  });

  it('adds all-day lookahead as calendar days through a DST transition', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const actions = new Map([['t', action([{ dtstart: '2026-03-01', rrule: 'FREQ=DAILY' }])]]);
    const result = futureActionProjections(actions, { now: new Date('2026-03-08T07:30:00Z'), lookaheadDays: 7 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14']);
  });

  it('includes a timed occurrence exactly at the horizon and excludes the current instant', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([['t', action([{ dtstart: '2026-10-10T12:00', rrule: 'FREQ=DAILY' }])]]);
    const result = futureActionProjections(actions, { now: new Date('2026-10-10T12:00:00Z'), lookaheadDays: 1 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-10-11T12:00']);
  });

  it('uses elapsed time for zoned horizons through a repeated hour', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([
      ['inside', action([{ dtstart: '2026-10-31T01:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY' }])],
      ['outside', action([{ dtstart: '2026-10-31T02:00', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY' }])],
    ]);
    // The horizon is 01:15 in the second repeated hour. The first 01:30
    // occurs before it, even though its authored wall clock sorts later.
    const result = futureActionProjections(actions, { now: new Date('2026-10-31T09:15:00Z'), lookaheadDays: 1 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-11-01T08:30:00Z']);
  });

  it('does not project the first repeated-hour occurrence after that instant has passed', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const actions = new Map([['t', action([{ dtstart: '2026-10-31T01:30', rrule: 'FREQ=DAILY' }])]]);
    const result = futureActionProjections(actions, { now: new Date('2026-11-01T09:15:00Z'), lookaheadDays: 2 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-11-02T01:30']);
  });

  it('preserves a floating gap clock when its normalized instant is still upcoming', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const actions = new Map([['t', action([{ dtstart: '2026-03-07T02:30', rrule: 'FREQ=DAILY;COUNT=3' }])]]);
    // 02:30 normalizes to 03:30. At 03:15 its authored clock appears earlier,
    // but the occurrence's actual floating instant is still in the future.
    const result = futureActionProjections(actions, { now: new Date('2026-03-08T10:15:00Z'), lookaheadDays: 1 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-03-08T02:30', '2026-03-09T02:30']);
  });

  it('skips named-zone gaps without consuming the recurrence count', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([['t', action([{ dtstart: '2026-03-07T02:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY;COUNT=3' }])]]);
    const result = futureActionProjections(actions, { now: new Date('2026-03-07T12:00:00Z'), lookaheadDays: 3 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-03-09T09:30:00Z', '2026-03-10T09:30:00Z']);
  });

  it('does not add a minimum occurrence beyond lookahead or any historical occurrences', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([
      ['future', action([{ dtstart: '2026-12-01', rrule: 'FREQ=YEARLY' }])],
      ['past', action([{ dtstart: '2026-01-01', rrule: 'FREQ=DAILY;COUNT=2' }])],
    ]);
    const result = futureActionProjections(actions, { now: new Date('2026-10-10T12:00:00Z'), lookaheadDays: 7 });
    expect(result).toEqual({ nodes: [], issues: [] });
  });

  it('suppresses a saved occurrence even when it was resolved and moved beyond lookahead', () => {
    vi.stubEnv('TZ', 'UTC');
    const occurrence = { template: 't', original: '2026-10-10' };
    const saved: Action = { frontMatter: { name: 'Moved', created: '2026-10-01T09:00', scheduled: '2027-01-01', resolution: 'done', occurrence }, body: 'Saved instructions' };
    const actions = new Map([['t', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY' }])], ['saved', saved]]);
    const result = futureActionProjections(actions, { now: new Date('2026-10-10T12:00:00Z'), lookaheadDays: 2 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-10-11', '2026-10-12']);
    expect(result.nodes.some(node => occurrenceKey(node.action.frontMatter.occurrence!) === occurrenceKey(occurrence))).toBe(false);
    expect(actions.get('saved')).toBe(saved);
    expect(actions.size).toBe(2);
  });

  it('reports incomplete expansion when the occurrence budget is reached', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([['t', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY' }])]]);
    const result = futureActionProjections(actions, { now: new Date('2026-10-10T12:00:00Z'), lookaheadDays: 7, limit: 2 });
    expect(originals(result)).toEqual(['2026-10-10', '2026-10-11']);
    expect(result.issues).toEqual([expect.stringContaining('Recurrence expansion exceeds 2 occurrences')]);
  });

  it('expands nonoverlapping schedules and retains dormant templates without projections', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([
      ['t', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY;COUNT=2' }, { dtstart: '2026-10-12', rrule: 'FREQ=DAILY;COUNT=2' }])],
      ['dormant', action([])],
    ]);
    const result = futureActionProjections(actions, { now: new Date('2026-10-10T12:00:00Z'), lookaheadDays: 7 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
    expect(actions.get('dormant')?.frontMatter.recurrence).toEqual([]);
  });

  it('reports a malformed template while continuing other templates', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([
      ['invalid', action([{ dtstart: '2026-10-10', rrule: 'FREQ=INVALID' }])],
      ['valid', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY' }])],
    ]);
    const result = futureActionProjections(actions, { now: new Date('2026-10-10T12:00:00Z'), lookaheadDays: 0 });
    expect(originals(result)).toEqual(['2026-10-10']);
    expect(result.issues).toEqual([expect.stringMatching(/^invalid:/)]);
  });

  it.each([2, 7, Number.MAX_SAFE_INTEGER])('reports unsupported year horizons for %s lookahead days', lookaheadDays => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([['t', action([{ dtstart: '9999-12-30', rrule: 'FREQ=DAILY' }])]]);
    const result = futureActionProjections(actions, { now: new Date('9999-12-30T12:00:00Z'), lookaheadDays });
    expect(result.nodes).toEqual([]);
    expect(result.issues).toEqual([expect.stringMatching(/supported.*(?:range|years)/)]);
  });

  it('still projects through the last supported date', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([['t', action([{ dtstart: '9999-12-30T12:00', rrule: 'FREQ=DAILY' }])]]);
    const result = futureActionProjections(actions, { now: new Date('9999-12-30T12:00:00Z'), lookaheadDays: 1 });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['9999-12-31T12:00']);
  });

  it('reports a horizon beyond the supported year in the schedule’s timezone', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([['t', action([{ dtstart: '9999-01-01T12:00', timezone: 'Pacific/Kiritimati', rrule: 'FREQ=DAILY' }])]]);
    const result = futureActionProjections(actions, { now: new Date('9999-12-30T20:00:00Z'), lookaheadDays: 1 });
    expect(result.nodes).toEqual([]);
    expect(result.issues).toEqual([expect.stringContaining('supported years 0001–9999 in this schedule’s timezone')]);
  });
});
