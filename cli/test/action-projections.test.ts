import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionProjections } from '../src/core/action-projections.js';
import { occurrenceKey } from '../src/core/recurrence.js';
import type { RecurrenceSchedule } from '../src/core/recurrence.js';
import type { Action } from '../src/core/types.js';

const action = (recurrence: RecurrenceSchedule[]): Action => ({
  frontMatter: { name: 'Repeat', created: '2026-01-01T09:00', recurrence }, body: 'Instructions',
});
const originals = (result: ReturnType<typeof actionProjections>) => result.nodes.map(node => node.action.frontMatter.occurrence!.original);
const saved = (template: string, original: string, scheduled = original): Action => ({
  frontMatter: { name: 'Saved', created: '2026-10-01T09:00', scheduled, occurrence: { template, original } }, body: 'Saved instructions',
});

afterEach(() => vi.unstubAllEnvs());

describe('action projection ranges', () => {
  it('includes the full boundary day for all-day and timed schedules', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([
      ['all-day', action([{ dtstart: '2026-01-01', rrule: 'FREQ=DAILY' }])],
      ['midnight', action([{ dtstart: '2026-01-01T00:00', rrule: 'FREQ=DAILY' }])],
      ['late', action([{ dtstart: '2026-01-01T23:59', rrule: 'FREQ=DAILY' }])],
    ]);
    const result = actionProjections(actions, { from: '2026-10-10', to: '2026-10-10' });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-10-10', '2026-10-10T00:00', '2026-10-10T23:59']);
    expect(result.limitedTemplates).toEqual(['all-day', 'midnight', 'late']);
  });

  it('expands history from DTSTART when there is no lower bound', () => {
    const actions = new Map([['t', action([{ dtstart: '2000-01-01', rrule: 'FREQ=DAILY;COUNT=3' }])]]);
    const result = actionProjections(actions, { to: '2026-10-10' });
    expect(originals(result)).toEqual(['2000-01-01', '2000-01-02', '2000-01-03']);
    expect(result.limitedTemplates).toEqual([]);
  });

  it('seeks directly into past and far-future ranges', () => {
    const actions = new Map([['t', action([{ dtstart: '2000-01-01', rrule: 'FREQ=DAILY' }])]]);
    expect(originals(actionProjections(actions, { from: '2001-01-01', to: '2001-01-02' })))
      .toEqual(['2001-01-01', '2001-01-02']);
    expect(originals(actionProjections(actions, { from: '2099-01-01', to: '2099-01-02' })))
      .toEqual(['2099-01-01', '2099-01-02']);
  });

  it('uses authored dates for named zones even when UTC falls on another day', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([
      ['east', action([{ dtstart: '2026-10-10T00:30', timezone: 'Pacific/Kiritimati', rrule: 'FREQ=DAILY' }])],
      ['west', action([{ dtstart: '2026-10-10T23:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY' }])],
    ]);
    const result = actionProjections(actions, { from: '2026-10-10', to: '2026-10-10' });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-10-09T10:30:00Z', '2026-10-11T06:30:00Z']);
    expect(result.nodes.map(node => node.action.frontMatter.scheduled)).toEqual(['2026-10-10T00:30', '2026-10-10T23:30']);
    expect(result.nodes.map(node => node.action.frontMatter.occurrence!.timezone)).toEqual(['Pacific/Kiritimati', 'America/Los_Angeles']);
  });

  it('includes all-day dates and floating gap clocks through daylight saving changes', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const actions = new Map([
      ['all-day', action([{ dtstart: '2026-03-07', rrule: 'FREQ=DAILY;COUNT=3' }])],
      ['floating', action([{ dtstart: '2026-03-07T02:30', rrule: 'FREQ=DAILY;COUNT=3' }])],
    ]);
    const result = actionProjections(actions, { from: '2026-03-08', to: '2026-03-09' });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-03-08', '2026-03-09', '2026-03-08T02:30', '2026-03-09T02:30']);
  });

  it('skips named-zone gaps without consuming COUNT and preserves repeated-hour identity', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([
      ['gap', action([{ dtstart: '2026-03-07T02:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY;COUNT=3' }])],
      ['fold', action([{ dtstart: '2026-10-31T01:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY;COUNT=3' }])],
    ]);
    expect(originals(actionProjections(actions, { from: '2026-03-08', to: '2026-03-10' })))
      .toEqual(['2026-03-09T09:30:00Z', '2026-03-10T09:30:00Z']);
    expect(originals(actionProjections(actions, { from: '2026-11-01', to: '2026-11-01' })))
      .toEqual(['2026-11-01T08:30:00Z']);
  });

  it('suppresses saved identities even when resolved and moved beyond the range', () => {
    const moved = saved('t', '2026-10-10', '2027-01-01');
    moved.frontMatter.resolution = 'done';
    const actions = new Map([['t', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY' }])], ['saved', moved]]);
    const result = actionProjections(actions, { from: '2026-10-10', to: '2026-10-12' });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['2026-10-11', '2026-10-12']);
    expect(result.nodes.some(node => occurrenceKey(node.action.frontMatter.occurrence!) === occurrenceKey(moved.frontMatter.occurrence!))).toBe(false);
    expect(actions.get('saved')).toBe(moved);
    expect(actions.size).toBe(2);
  });

  it('expands nonoverlapping schedules while retaining dormant and ended templates', () => {
    const actions = new Map([
      ['t', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY;COUNT=2' }, { dtstart: '2026-10-12', rrule: 'FREQ=DAILY;COUNT=2' }])],
      ['dormant', action([])],
      ['ended', action([{ dtstart: '2000-01-01', rrule: 'FREQ=DAILY;COUNT=2' }])],
    ]);
    const result = actionProjections(actions, { from: '2026-10-10', to: '2026-10-13' });
    expect(originals(result)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13']);
    expect(result.limitedTemplates).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(actions.get('dormant')?.frontMatter.recurrence).toEqual([]);
  });

  it('reports only templates with unsaved occurrences after the upper bound', () => {
    const actions = new Map([
      ['open', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY' }])],
      ['future', action([{ dtstart: '2099-01-01', rrule: 'FREQ=YEARLY;COUNT=1' }])],
      ['saved-tail', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY;COUNT=3' }])],
      ['saved-1', saved('saved-tail', '2026-10-11')],
      ['saved-2', saved('saved-tail', '2026-10-12', '2025-01-01')],
    ]);
    const tick = vi.fn();
    const result = actionProjections(actions, { from: '2026-10-10', to: '2026-10-10', tick });
    expect(result.limitedTemplates).toEqual(['open', 'future']);
    expect(tick).toHaveBeenCalledTimes(6);
  });

  it('continues probing saved identities until the first unsaved occurrence', () => {
    const actions = new Map([
      ['t', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY;COUNT=4' }])],
      ['saved-1', saved('t', '2026-10-11')],
      ['saved-2', saved('t', '2026-10-12')],
    ]);
    const tick = vi.fn();
    const result = actionProjections(actions, { to: '2026-10-10', tick });
    expect(result.limitedTemplates).toEqual(['t']);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it('propagates budget failures during expansion and after-bound probing', () => {
    const actions = new Map([['t', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY' }])]]);
    const failure = new Error('GraphQL query work limit exceeded. Narrow the schedule range.');
    let calls = 0;
    expect(() => actionProjections(actions, { to: '2026-10-12', tick: () => { if (++calls > 2) throw failure; } })).toThrow(failure);
    calls = 0;
    expect(() => actionProjections(actions, { to: '2026-10-10', tick: () => { if (++calls > 1) throw failure; } })).toThrow(failure);
  });

  it('reports a malformed template while continuing other templates', () => {
    const actions = new Map([
      ['invalid', action([{ dtstart: '2026-10-10', rrule: 'FREQ=INVALID' }])],
      ['valid', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY;COUNT=1' }])],
    ]);
    const result = actionProjections(actions, { to: '2026-10-10' });
    expect(originals(result)).toEqual(['2026-10-10']);
    expect(result.issues).toEqual([expect.stringMatching(/^invalid:/)]);
  });

  it.each([
    { to: '10000-01-01' }, { to: '2026-02-30' }, { from: '0000-01-01', to: '2026-10-10' },
  ])('rejects invalid range bounds: %j', options => {
    expect(() => actionProjections(new Map(), options)).toThrow('calendar dates within years 0001–9999');
  });

  it('rejects an inverted range', () => {
    expect(() => actionProjections(new Map(), { from: '2026-10-11', to: '2026-10-10' }))
      .toThrow('scheduledFrom must be on or before scheduledTo');
  });

  it('includes the last supported date without probing past year 9999', () => {
    vi.stubEnv('TZ', 'UTC');
    const actions = new Map([['t', action([{ dtstart: '9999-12-30T12:00', rrule: 'FREQ=DAILY' }])]]);
    const result = actionProjections(actions, { from: '9999-12-31', to: '9999-12-31' });
    expect(result.issues).toEqual([]);
    expect(originals(result)).toEqual(['9999-12-31T12:00']);
    expect(result.limitedTemplates).toEqual([]);
  });
});
