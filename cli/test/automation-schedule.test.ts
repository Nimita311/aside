import { describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { compileSchedule } from '../src/automation/schedule.js';
import rrule from 'rrule';
import { validateDefinition, validateExecutionConfig } from '../src/core/automation.js';

const at = (text: string) => new Date(text).getTime();
const iso = (value: number | undefined) => value === undefined ? undefined : new Date(value).toISOString();
describe('automation schedules', () => {
  it('uses absolute timestamps and never replays one at or before now', () => {
    const schedule = compileSchedule({ at: '2026-10-09T08:00:00-07:00' });
    expect(iso(schedule.next(at('2026-10-09T14:59:59Z')))).toBe('2026-10-09T15:00:00.000Z');
    expect(schedule.next(at('2026-10-09T15:00:00Z'))).toBeUndefined();
    expect(() => compileSchedule({ at: '2026-10-09T08:00' })).toThrow(/offset/);
    expect(() => compileSchedule({ at: '2026-02-30T08:00Z' })).toThrow();
  });
  it('evaluates cron in its zone across DST and preserves Unix day/weekday OR', () => {
    const schedule = compileSchedule({ cron: '0 8 * * 1-5', timezone: 'America/Los_Angeles' });
    expect(iso(schedule.next(at('2026-10-30T15:00:00Z')))).toBe('2026-11-02T16:00:00.000Z');
    const unix = compileSchedule({ cron: '0 8 15 * 1', timezone: 'UTC' });
    expect(iso(unix.next(at('2026-10-14T08:00:00Z')))).toBe('2026-10-15T08:00:00.000Z');
    expect(iso(unix.next(at('2026-10-15T08:00:00Z')))).toBe('2026-10-19T08:00:00.000Z');
    expect(() => compileSchedule({ cron: '* * * * * *' })).toThrow(/five/);
    expect(() => compileSchedule({ cron: 'garbage * * * *' })).toThrow();
  });
  it('anchors RRULE intervals and COUNT, with an absolute UNTIL boundary', () => {
    const schedule = compileSchedule({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=3', dtstart: '2026-10-05T08:00', timezone: 'America/Los_Angeles' });
    expect(iso(schedule.next(at('2026-10-05T15:00Z')))).toBe('2026-10-19T15:00:00.000Z');
    expect(iso(schedule.next(at('2026-10-19T15:00Z')))).toBe('2026-11-02T16:00:00.000Z');
    expect(schedule.next(at('2026-11-02T16:00Z'))).toBeUndefined();
    const until = compileSchedule({ rrule: 'FREQ=DAILY;UNTIL=20261006T145959Z', dtstart: '2026-10-05T08:00', timezone: 'America/Los_Angeles' });
    expect(until.next(at('2026-10-05T15:00Z'))).toBeUndefined();
  });
  it('skips invalid DST clocks without consuming COUNT and uses the first repeated hour', () => {
    const schedule = compileSchedule({ rrule: 'FREQ=DAILY;COUNT=3', dtstart: '2026-03-07T02:30', timezone: 'America/Los_Angeles' });
    expect(iso(schedule.next(at('2026-03-07T10:30Z')))).toBe('2026-03-09T09:30:00.000Z');
    expect(iso(schedule.next(at('2026-03-09T09:30Z')))).toBe('2026-03-10T09:30:00.000Z');
    expect(schedule.next(at('2026-03-10T09:30Z'))).toBeUndefined();
    const repeated = compileSchedule({ rrule: 'FREQ=DAILY', dtstart: '2026-10-31T01:30', timezone: 'America/Los_Angeles' });
    expect(iso(repeated.next(at('2026-11-01T08:29Z')))).toBe('2026-11-01T08:30:00.000Z');
    expect(iso(repeated.next(at('2026-11-01T08:30Z')))).toBe('2026-11-02T09:30:00.000Z');
  });
  it('honors UTC UNTIL inside the second repeated hour', () => {
    const schedule = compileSchedule({ rrule: 'FREQ=DAILY;UNTIL=20261101T091500Z', dtstart: '2026-10-31T01:30', timezone: 'America/Los_Angeles' });
    expect(iso(schedule.next(at('2026-11-01T08:15Z')))).toBe('2026-11-01T08:30:00.000Z');
    expect(schedule.next(at('2026-11-01T08:30Z'))).toBeUndefined();
    const outside = compileSchedule({ rrule: 'FREQ=DAILY;UNTIL=20261101T091500Z', dtstart: '2026-10-31T02:00', timezone: 'America/Los_Angeles' });
    expect(outside.next(at('2026-11-01T08:15Z'))).toBeUndefined();
  });
  it('seeks unfiltered high-frequency RRULEs arithmetically', () => {
    const schedule = compileSchedule({ rrule: 'FREQ=SECONDLY;INTERVAL=7', dtstart: '2000-01-01T00:00', timezone: 'UTC' });
    const before = at('2026-10-08T12:00Z');
    const next = schedule.next(before)!;
    expect(next).toBeGreaterThan(before);
    expect(next - before).toBeLessThanOrEqual(7000);
    expect((next - at('2000-01-01T00:00Z')) % 7000).toBe(0);
  });
  it('seeks a billion COUNT ticks without resolving historical clocks', () => {
    const wallReads = vi.spyOn(Temporal.PlainDateTime, 'from');
    try {
      const declaration = { rrule: 'FREQ=SECONDLY;COUNT=1000000000', dtstart: '2000-01-01T00:00', timezone: 'UTC' };
      const query = at('2026-10-08T12:00Z');
      expect(compileSchedule(declaration).next(query)).toBe(query + 1000);
      // Wake/recompile and backwards clock changes must retain the same COUNT.
      expect(compileSchedule(declaration).next(query - 3600000)).toBe(query - 3600000 + 1000);
      expect(compileSchedule(declaration).next(at('2040-01-01T00:00Z'))).toBeUndefined();
      expect(wallReads.mock.calls.length).toBeLessThan(20);
    } finally { wallReads.mockRestore(); }
  });
  it('counts late queries across DST without consuming nonexistent minutes', () => {
    const declaration = { rrule: 'FREQ=MINUTELY;COUNT=4240', dtstart: '2026-03-07T00:30', timezone: 'America/Los_Angeles' };
    const schedule = compileSchedule(declaration);
    expect(iso(schedule.next(at('2026-03-08T09:59Z')))).toBe('2026-03-08T10:00:00.000Z');
    expect(iso(compileSchedule(declaration).next(at('2026-03-10T07:08Z')))).toBe('2026-03-10T07:09:00.000Z');
    expect(schedule.next(at('2026-03-10T07:09Z'))).toBeUndefined();
    expect(iso(schedule.next(at('2026-03-08T09:59Z')))).toBe('2026-03-08T10:00:00.000Z');
  });
  it.each([
    ['FREQ=HOURLY;INTERVAL=3;BYDAY=MO,WE,FR;BYHOUR=8,17;BYMINUTE=10,35;COUNT=200', '2026-01-02T08:10', '2026-01-20T12:00Z'],
    ['FREQ=MINUTELY;INTERVAL=7;BYDAY=MO,WE,FR;BYHOUR=9,17;COUNT=3000', '2026-01-02T09:05', '2026-10-09T09:05Z'],
    ['FREQ=MINUTELY;INTERVAL=7;BYSECOND=15,35;BYSETPOS=-1;COUNT=500', '2026-03-06T09:05', '2026-03-08T12:00Z'],
    ['FREQ=SECONDLY;INTERVAL=7;BYMINUTE=5,10;BYSECOND=15,35;COUNT=300', '2026-03-06T09:05', '2026-03-06T12:00Z'],
  ])('preserves COUNT and anchored subdaily phase in %s', (text, dtstart, query) => {
    const parsed = rrule.RRule.parseString(text), count = parsed.count!;
    const normalized = new rrule.RRule({ ...parsed, dtstart: new Date(dtstart + ':00Z') }, true).options;
    const baseline = new rrule.RRule({ freq: normalized.freq, interval: normalized.interval, dtstart: normalized.dtstart,
      byminute: normalized.freq === rrule.RRule.HOURLY ? normalized.byminute : undefined,
      bysecond: normalized.freq < rrule.RRule.SECONDLY ? normalized.bysecond : undefined,
      bysetpos: normalized.bysetpos }, true);
    const values: number[] = [];
    baseline.all((date) => {
      if (normalized.byweekday?.length && !normalized.byweekday.includes((date.getUTCDay() + 6) % 7) ||
        normalized.byhour?.length && !normalized.byhour.includes(date.getUTCHours()) ||
        normalized.freq >= rrule.RRule.MINUTELY && normalized.byminute?.length && !normalized.byminute.includes(date.getUTCMinutes()) ||
        normalized.freq >= rrule.RRule.SECONDLY && normalized.bysecond?.length && !normalized.bysecond.includes(date.getUTCSeconds())) return true;
      const wall = Temporal.PlainDateTime.from(date.toISOString().slice(0, -1));
      const instant = wall.toZonedDateTime('America/Los_Angeles', { disambiguation: 'earlier' });
      if (instant.toPlainDateTime().equals(wall)) values.push(instant.epochMilliseconds);
      return values.length < count;
    });
    const schedule = compileSchedule({ rrule: text, dtstart, timezone: 'America/Los_Angeles' });
    let after = at(query);
    for (let i = 0; i < 5; i++) {
      const expected = values.find(value => value > after);
      expect(schedule.next(after)).toBe(expected);
      if (expected === undefined) break;
      after = expected;
    }
  });
  it('finds a valid anchored occurrence where library BY-field skipping would loop', () => {
    const schedule = compileSchedule({ rrule: 'FREQ=MINUTELY;INTERVAL=7;BYHOUR=9,17;BYDAY=MO,TU,WE,TH,FR;COUNT=100',
      dtstart: '2026-03-01T08:15', timezone: 'UTC' });
    expect(iso(schedule.next(at('2026-03-01T08:15Z')))).toBe('2026-03-02T09:06:00.000Z');
  });
  it('finishes safely for impossible clock filters and the final supported year', () => {
    const impossible = compileSchedule({ rrule: 'FREQ=MINUTELY;INTERVAL=60;BYMINUTE=30;COUNT=1000000000',
      dtstart: '2026-03-01T08:00', timezone: 'UTC' });
    expect(impossible.next(at('2026-03-01T08:00Z'))).toBeUndefined();
    const finalYear = compileSchedule({ rrule: 'FREQ=HOURLY;BYMINUTE=0;COUNT=100', dtstart: '9999-12-31T23:00', timezone: 'UTC' });
    expect(finalYear.next(at('9999-12-31T23:00Z'))).toBeUndefined();
  });
  it.each([
    ['FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29', '2020-01-01T08:15', '2026-10-08T12:00Z'],
    ['FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO;WKST=SU', '2020-01-01T08:15', '2026-10-08T12:00Z'],
    ['FREQ=MONTHLY;INTERVAL=2;BYDAY=1MO,-1FR', '2020-01-08T08:15', '2026-10-08T12:00Z'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', '2020-01-08T08:15', '2026-10-08T12:00Z'],
    ['FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2020-01-08T08:15', '2026-10-08T12:00Z'],
    ['FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,WE;WKST=SU', '2020-01-08T08:15', '2026-10-08T12:00Z'],
    ['FREQ=DAILY;INTERVAL=5', '2020-01-08T08:15', '2026-10-08T12:00Z'],
    ['FREQ=HOURLY;INTERVAL=3;BYMINUTE=10,35', '2026-10-08T08:15', '2026-10-10T12:00Z'],
    ['FREQ=MINUTELY;INTERVAL=7;BYSECOND=15,35', '2026-10-08T08:15', '2026-10-08T12:00Z'],
  ])('seeks %s without changing its anchored recurrence', (text, dtstart, query) => {
    const baseline = new rrule.RRule({ ...rrule.RRule.parseString(text), dtstart: new Date(dtstart + ':00Z') }, true);
    const schedule = compileSchedule({ rrule: text, dtstart, timezone: 'UTC' });
    let after = at(query);
    for (let i = 0; i < 5; i++) {
      const expected = baseline.after(new Date(after), false)?.getTime();
      expect(schedule.next(after)).toBe(expected);
      after = expected!;
    }
  });
  it('accepts RRULE properties in any order and rejects duplicate properties', () => {
    const schedule = compileSchedule({ rrule: 'BYDAY=MO;FREQ=WEEKLY', dtstart: '2026-10-05T08:00', timezone: 'UTC' });
    expect(iso(schedule.next(at('2026-10-05T08:00Z')))).toBe('2026-10-12T08:00:00.000Z');
    expect(() => compileSchedule({ rrule: 'FREQ=DAILY;INTERVAL=2;INTERVAL=3', dtstart: '2026-10-05T08:00', timezone: 'UTC' })).toThrow(/repeat/);
  });
  it.each([
    'BYHOUR=24', 'BYHOUR=-1', 'BYMINUTE=60', 'BYSECOND=99', 'BYMONTH=13', 'BYMONTH=0',
    'BYMONTHDAY=0', 'BYMONTHDAY=-32', 'BYYEARDAY=367', 'BYWEEKNO=-54', 'BYSETPOS=0',
    'BYDAY=54MO', 'BYDAY=MO=TU', 'BYMONTHDAY=1junk', 'BYEASTER=1', 'BYHOUR=', 'WKST=XX', 'WKST=MO,TU',
  ])('rejects malformed RRULE %s before it can normalize or silently discard occurrences', part => {
    expect(() => compileSchedule({ rrule: `FREQ=DAILY;${part}`, dtstart: '2026-10-08T08:00', timezone: 'UTC' })).toThrow();
  });
  it('preserves valid second-precision automation schedules', () => {
    const schedule = compileSchedule({ rrule: 'FREQ=MINUTELY;BYSECOND=15,45', dtstart: '2026-10-08T08:00:15', timezone: 'UTC' });
    expect(iso(schedule.next(at('2026-10-08T08:00:00Z')))).toBe('2026-10-08T08:00:15.000Z');
    expect(iso(schedule.next(at('2026-10-08T08:00:15Z')))).toBe('2026-10-08T08:00:45.000Z');
  });
  it('rejects ambiguous declarations, unsupported options and impossible bounds', () => {
    const run = { script: 'echo' };
    expect(() => validateDefinition({ schedule: { cron: '* * * * *', at: '2026-10-10T12:00Z' }, run })).toThrow(/exactly one/);
    expect(() => validateDefinition({ schedule: { cron: '* * * * *' }, run, enabled: 'false' })).toThrow(/boolean/);
    expect(() => validateDefinition({ schedule: { cron: '* * * * *' }, run, timout: 'PT1M' })).toThrow(/Unknown/);
    expect(() => compileSchedule({ rrule: 'FREQ=DAILY;COUNT=2;UNTIL=20261010T000000Z', dtstart: '2026-10-08T12:00' })).toThrow(/combine/);
    expect(() => compileSchedule({ rrule: 'FREQ=DAILY;INTERVAL=0', dtstart: '2026-10-08T12:00' })).toThrow(/positive/);
    expect(() => compileSchedule({ rrule: 'FREQ=DAILY', dtstart: '2026-02-30T12:00' })).toThrow();
  });
  it.each([
    'Do this', '', ' ', '#artifact/not-an-id', '#artifact/2026-02-30-instructions',
    '#artifact/2026-10-08-instructions/prompt.md', '#artifact/2026-10-08-instructions/../secret',
    '#artifact/2026-10-08-instructions\0', {artifact: '#artifact/2026-10-08-instructions'}, null, 123,
  ])('rejects prompts other than direct primary artifact handles: %j', prompt => {
    expect(() => validateDefinition({schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: 'external', prompt}})).toThrow(/run.prompt/);
  });
  it('validates model selectors without requiring installed or currently available models', () => {
    const schedule = { at: '2026-10-10T12:00Z' };
    for (const model of ['CODEX_CURRENT_ID', 'CLAUDE_SONNET', 'digest', '_external', 'constructor']) {
      expect(validateDefinition({ schedule, run: { model, prompt: '#artifact/2026-10-08-instructions' } }).run).toEqual({ model, prompt: '#artifact/2026-10-08-instructions' });
    }
    for (const model of ['', ' ', 'gpt-6.1-sol', '__private', 'true', 'false', 'null', {}, 123]) {
      expect(() => validateDefinition({ schedule, run: { model, prompt: '#artifact/2026-10-08-instructions' } })).toThrow();
    }
    expect(() => validateDefinition({ schedule, run: { script: 'echo', model: 'digest', prompt: '#artifact/2026-10-08-instructions' } })).toThrow(/exactly one/);
    expect(() => validateDefinition({ schedule, run: { agent: 'digest', prompt: '#artifact/2026-10-08-instructions' } })).toThrow();
  });
  it('accepts named built-in choices or custom stdin CLIs and rejects ambiguous or reserved names', () => {
    const models = { writing: { model: 'CLAUDE_SONNET' }, external: { command: './my-agent', args: ['run', 'a b'] } };
    expect(validateExecutionConfig({ cwd: 'work', models })).toEqual({ cwd: 'work', models });
    for (const model of [
      { model: 'writing' }, { model: 'CLAUDE_SONNET', command: 'claude' }, { model: 'CLAUDE_SONNET', args: [] },
      { command: '' }, { command: 'agent', args: 'run' }, { command: 'agent', args: ['bad\0value'] }, {}, { engine: 'codex' },
    ]) expect(() => validateExecutionConfig({ models: { custom: model } })).toThrow();
    for (const name of ['CODEX_CUSTOM', 'CLAUDE_CUSTOM', '__private', 'true', 'false', 'null', 'my-agent']) {
      expect(() => validateExecutionConfig({ models: { [name]: { command: 'agent' } } })).toThrow();
    }
    expect(() => validateExecutionConfig({ agents: {} })).toThrow(/Unknown/);
  });
});
