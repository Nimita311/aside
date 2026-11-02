import { describe, expect, it } from 'vitest';
import rrule from 'rrule';
import { Temporal } from '@js-temporal/polyfill';
import { RecurrenceCounter } from '../src/core/rrule-count.js';
import { compileSchedule } from '../src/automation/schedule.js';

const cases = [
  ['FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29', '2020-01-08T08:15', '2033-01-01'],
  ['FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO;WKST=SU', '2020-01-08T08:15', '2027-01-01'],
  ['FREQ=YEARLY;BYDAY=1MO,-1FR', '2020-01-08T08:15', '2027-01-01'],
  ['FREQ=MONTHLY;INTERVAL=2;BYDAY=1MO,-1FR', '2024-01-08T08:15', '2027-01-01'],
  ['FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=8,14', '2024-01-08T08:15', '2027-01-01'],
  ['FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', '2024-01-08T08:15', '2027-01-01'],
  ['FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,WE;WKST=SU', '2024-01-08T08:15', '2027-01-01'],
  ['FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8,15;BYSETPOS=1,-1', '2024-01-09T09:15', '2027-01-01'],
  ['FREQ=DAILY;INTERVAL=5', '2024-01-08T08:15', '2027-01-01'],
  ['FREQ=DAILY;BYSETPOS=1,-1', '2026-03-01T02:30', '2026-03-15'],
  ['FREQ=HOURLY;INTERVAL=3;BYMINUTE=10,35;BYDAY=MO,WE', '2026-03-01T08:15', '2026-03-30'],
  ['FREQ=HOURLY;INTERVAL=7;BYHOUR=1,9,17;BYMINUTE=0,30', '2026-03-01T08:15', '2026-03-30'],
  ['FREQ=MINUTELY;INTERVAL=7;BYHOUR=9,17;BYDAY=MO,TU,WE,TH,FR', '2026-03-06T09:05', '2026-03-15'],
  ['FREQ=MINUTELY;INTERVAL=7;BYMINUTE=1,11,21;BYSECOND=15,35', '2026-03-01T08:15', '2026-03-05'],
  ['FREQ=SECONDLY;INTERVAL=7;BYHOUR=9,17;BYMINUTE=10,35;BYSECOND=7,14,21', '2026-03-01T08:15', '2026-03-05'],
] as const;

function oracle(text: string, start: string, end: string, zone: string) {
  const options = { ...rrule.RRule.parseString(text), dtstart: new Date(start + 'Z') };
  const rule = new rrule.RRule(options, true);
  let expanded: Date[];
  if (rule.options.freq >= rrule.RRule.HOURLY) {
    // Expand anchored ticks without the library's BY-skip shortcuts, then
    // filter. This independently exposes interval phase changes in those skips.
    const base = new rrule.RRule({ freq: options.freq, interval: options.interval, dtstart: options.dtstart,
      ...(rule.options.freq === rrule.RRule.HOURLY && { byminute: options.byminute }),
      ...(rule.options.freq <= rrule.RRule.MINUTELY && { bysecond: options.bysecond }), bysetpos: options.bysetpos }, true);
    const days = new rrule.RRule({ freq: rrule.RRule.DAILY, dtstart: new Date(start.slice(0, 10) + 'T00:00Z'), byhour: 0, byminute: 0, bysecond: 0,
      byweekday: options.byweekday, bymonth: options.bymonth, bymonthday: options.bymonthday, byyearday: options.byyearday, byweekno: options.byweekno }, true);
    const allowedDays = new Set(days.between(new Date(start.slice(0, 10) + 'T00:00Z'), new Date(end + 'Z'), true).map(d => d.toISOString().slice(0, 10)));
    const includes = (filter: number | number[] | null | undefined, value: number) => filter == null || (Array.isArray(filter) ? filter : [filter]).includes(value);
    expanded = base.between(new Date(start + 'Z'), new Date(end + 'Z'), true).filter(d => allowedDays.has(d.toISOString().slice(0, 10)) &&
      includes(options.byhour, d.getUTCHours()) &&
      (rule.options.freq < rrule.RRule.MINUTELY || includes(options.byminute, d.getUTCMinutes())) &&
      (rule.options.freq < rrule.RRule.SECONDLY || includes(options.bysecond, d.getUTCSeconds())));
  } else expanded = rule.between(new Date(start + 'Z'), new Date(end + 'Z'), true);
  // Recurrence is a set; rrule may emit repeated dates for overlapping BYSETPOS.
  const walls = [...new Set(expanded.map(d => d.getTime()))];
  const dates = walls.flatMap(wall => {
    const plain = Temporal.PlainDateTime.from(new Date(wall).toISOString().slice(0, -1));
    const resolved = plain.toZonedDateTime(zone, { disambiguation: 'earlier' });
    return resolved.toPlainDateTime().equals(plain) ? [{ wall, instant: resolved.epochMilliseconds }] : [];
  });
  return { rule, dates };
}

describe('RRULE counting against ordinary expansion', () => {
  it.each(cases)('counts %s with exact period and DST semantics', (text, start, end) => {
    for (const zone of ['UTC', 'America/Los_Angeles']) {
      const { rule, dates } = oracle(text, start, end, zone);
      const counter = new RecurrenceCounter(rule, zone);
      const probes = [new Date(start + 'Z').getTime() - 1, new Date(end + 'Z').getTime(), ...dates.filter((_, i) => i % Math.max(1, Math.floor(dates.length / 12)) === 0).flatMap(d => [d.wall - 1, d.wall])];
      // Descending and non-monotonic calls exercise cached prefix rewinds.
      for (const wall of [...probes, ...probes.toReversed()]) expect(counter.countThrough(new Date(wall)), `${text}, ${zone}, ${new Date(wall).toISOString()}`).toBe(dates.filter(d => d.wall <= wall).length);
    }
  });
  it.each(cases.filter(([text]) => /HOURLY|MINUTELY|SECONDLY/.test(text)))('seeks COUNT %s without changing filtered phase', (text, start, end) => {
    const { dates } = oracle(text, start, end, 'UTC');
    if (!dates.length) return;
    const count = Math.min(200, dates.length);
    const schedule = compileSchedule({ dtstart: start, rrule: text + ';COUNT=' + count, timezone: 'UTC' });
    for (const index of [0, Math.floor(count / 2), count - 1]) {
      const after = dates[index].instant;
      expect(schedule.next(after), text + ', index ' + index).toBe(index + 1 < count ? dates[index + 1].instant : undefined);
    }
  });
});
