import { describe, expect, it, vi } from 'vitest';
import rrule from 'rrule';
import { RecurrenceCounter } from '../src/core/rrule-count.js';

describe('RRULE count index reuse', () => {
  it('reuses forward checkpoints after validation reads the anchor again', () => {
    const rule = new rrule.RRule({ ...rrule.RRule.parseString('FREQ=MINUTELY;INTERVAL=7;BYHOUR=9,17;BYDAY=MO,TU,WE,TH,FR'),
      dtstart: new Date('2000-01-03T09:05Z') }, true);
    const counter = new RecurrenceCounter(rule, 'UTC');
    const builds = vi.spyOn(counter as unknown as { buildPeriod(): unknown }, 'buildPeriod');
    const query = new Date('2026-10-09T09:05Z');
    const first = counter.nextWall(query);
    expect(first).toBeDefined();
    expect(builds.mock.calls.length).toBeGreaterThan(9000);
    counter.nextWall(rule.options.dtstart, true);
    builds.mockClear();
    expect(counter.nextWall(query)).toEqual(first);
    expect(builds.mock.calls.length).toBeLessThan(366);
  });
  it('reads dense past occurrences from one indexed day', () => {
    const rule = new rrule.RRule({ ...rrule.RRule.parseString('FREQ=MINUTELY;BYHOUR=9,17;BYDAY=MO,TU,WE,TH,FR'),
      dtstart: new Date('2000-01-03T09:00Z') }, true);
    const counter = new RecurrenceCounter(rule, 'UTC');
    const builds = vi.spyOn(counter as unknown as { buildPeriod(): unknown }, 'buildPeriod');
    let cursor = counter.previousWall(new Date('2026-10-09T17:59Z'), true)!;
    builds.mockClear();
    for (let i = 0; i < 100; i++) {
      const next = counter.previousWall(cursor)!;
      expect(next.getTime()).toBeLessThan(cursor.getTime()); cursor = next;
    }
    expect(builds.mock.calls.length).toBeLessThan(5);
    expect(cursor.toISOString()).toBe('2026-10-09T09:19:00.000Z');
  });
});
