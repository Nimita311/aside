import { CronExpressionParser } from 'cron-parser';
import rrule from 'rrule';
import { Temporal } from '@js-temporal/polyfill';
import type { AutomationSchedule } from '../core/automation.js';
import { recurrenceCounter } from '../core/rrule-count.js';

const { RRule } = rrule;
export interface Schedule { next(after: number): number | undefined; description: string }
const wallPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const ruleFields = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYWEEKNO', 'BYYEARDAY', 'BYSETPOS', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'WKST']);
function validateRuleParts(text: string): Record<string, string> {
  const parts = text.replace(/^RRULE:/, '').split(';').map(part => part.split('='));
  const names = parts.map(part => part[0]);
  if (/[\r\n]/.test(text) || !names.includes('FREQ') || names.some(name => !ruleFields.has(name)) || parts.some(part => part.length !== 2 || !part[1])) throw new Error('rrule must contain FREQ and standard rule parts with nonempty values');
  if (new Set(names).size !== names.length) throw new Error('rrule cannot repeat a property');
  const values = Object.fromEntries(parts) as Record<string, string>;
  if (values.WKST && !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(values.WKST)) throw new Error('Invalid WKST value');
  if (values.BYDAY?.split(',').some(day => !/^([+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/.test(day) || Math.abs(parseInt(day)) > 53)) throw new Error('Invalid BYDAY values');
  // rrule accepts some out-of-range values and normalizes them into other
  // clocks, so validate authored values before compiling or saving a schedule.
  for (const [name, max, negative] of [['BYMONTH', 12, false], ['BYHOUR', 23, false], ['BYMINUTE', 59, false], ['BYSECOND', 59, false], ['BYMONTHDAY', 31, true], ['BYYEARDAY', 366, true], ['BYWEEKNO', 53, true], ['BYSETPOS', 366, true]] as const) {
    if (values[name]?.split(',').some(value => !/^-?\d+$/.test(value) || Number(value) > max || Number(value) < (negative ? -max : 0) || (negative || name === 'BYMONTH') && Number(value) === 0)) throw new Error(`Invalid ${name} values`);
  }
  return values;
}
function wallDate(text: string): Date {
  if (!wallPattern.test(text)) throw new Error('dtstart must be a real wall time YYYY-MM-DDTHH:mm[:ss]');
  const wall = Temporal.PlainDateTime.from(text);
  if (wall.year < 1) throw new Error('dtstart year must be positive');
  return new Date(wall.toString() + 'Z');
}
function periodDate(year: number, month: number): Date {
  const date = new Date(0); date.setUTCFullYear(year, month, 1); return date;
}
function wallInstant(date: Date, zone: string): number | undefined {
  const wall = Temporal.PlainDateTime.from(date.toISOString().slice(0, -1));
  const zoned = wall.toZonedDateTime(zone, { disambiguation: 'earlier' });
  // Skip nonexistent wall times; repeated hours use their first instant.
  return zoned.toPlainDateTime().equals(wall) ? zoned.epochMilliseconds : undefined;
}
function fakeWall(ms: number, zone: string): Date {
  return new Date(Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDateTime().toString() + 'Z');
}
export function compileSchedule(schedule: AutomationSchedule, localZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Schedule {
  if ('at' in schedule) {
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(schedule.at)) throw new Error('at must be an ISO timestamp with Z or an explicit offset');
    const at = Temporal.Instant.from(schedule.at).epochMilliseconds;
    return { description: schedule.at, next: after => at > after ? at : undefined };
  }
  const zone = schedule.timezone ?? localZone;
  if ('cron' in schedule) {
    if (schedule.cron.trim().split(/\s+/).length !== 5 || /\bH\b/.test(schedule.cron)) throw new Error('cron must have five deterministic fields (minute hour day month weekday)');
    // Retain the iterator until a discontinuity or edit, avoiding re-parsing each tick.
    let cursor = CronExpressionParser.parse(schedule.cron, { tz: zone });
    let previous: number | undefined;
    return { description: `${schedule.cron}, ${zone}`, next(after) {
      if (previous === undefined || after !== previous) cursor = CronExpressionParser.parse(schedule.cron, { tz: zone, currentDate: after });
      try { previous = cursor.next().getTime(); return previous; }
      catch (error) {
        if ((error as Error).message.includes('Out of the time span range')) return undefined;
        throw error;
      }
    } };
  }
  const parts = validateRuleParts(schedule.rrule);
  const start = wallDate(schedule.dtstart);
  if (wallInstant(start, zone) === undefined) throw new Error('dtstart does not exist in its time zone');
  const options = RRule.parseString(schedule.rrule);
  if (options.count != null && options.until) throw new Error('rrule cannot combine COUNT and UNTIL');
  for (const [name, value] of [['INTERVAL', options.interval], ['COUNT', options.count]] as const) {
    if (value != null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${name} must be a positive integer`);
  }
  const untilValue = parts.UNTIL;
  let until: number | undefined;
  if (untilValue) {
    if (!/^\d{8}T\d{6}Z$/.test(untilValue)) throw new Error('RRULE UNTIL must be a UTC timestamp YYYYMMDDTHHmmssZ');
    until = Temporal.Instant.from(untilValue.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')).epochMilliseconds;
    options.until = fakeWall(until, zone);
    // A UTC boundary in the second repeated hour can follow first-fold clocks
    // with a later wall value. Broaden only the iterator's wall bound; the UTC
    // check below remains the inclusive source-of-truth end.
    const firstInstant = wallInstant(options.until, zone)!;
    if (until > firstInstant) options.until = new Date(options.until.getTime() + until - firstInstant);
  }
  // Generate wall clocks in UTC, then resolve them explicitly. rrule's TZID
  // conversion depends on the process's local zone and normalizes DST gaps.
  const count = options.count ?? undefined;
  const rule = new RRule({ ...options, count: undefined, dtstart: start }, true);
  const simpleTick = options.freq !== undefined && options.freq >= RRule.HOURLY &&
    Object.keys(options).every(key => ['freq', 'interval', 'until', 'wkst'].includes(key));
  const step = (options.interval ?? 1) * (options.freq === RRule.HOURLY ? 3600000 : options.freq === RRule.MINUTELY ? 60000 : 1000);
  const seekOptions = { ...options, count: undefined,
    // Preserve original ordinal weekdays and negative month days, along with
    // defaults inferred from the original DTSTART rather than a seek boundary.
    bymonth: rule.options.bymonth,
    bymonthday: options.bymonthday ?? [...rule.options.bymonthday, ...rule.options.bynmonthday],
    byweekday: options.byweekday ?? rule.options.byweekday,
    byhour: rule.options.byhour, byminute: rule.options.byminute, bysecond: rule.options.bysecond,
  };
  // Seek to an aligned recurrence period near the query, retaining the rule's
  // expanded default BY fields. This avoids rescanning years of history on each
  // dispatch, including filtered SECONDLY/MINUTELY rules.
  const seek = (threshold: Date, inclusive: boolean): Date | null => {
    const frequency = rule.options.freq, interval = rule.options.interval;
    let elapsed: number, boundary: Date;
    if (frequency === RRule.YEARLY) {
      elapsed = threshold.getUTCFullYear() - start.getUTCFullYear();
      const periods = Math.max(0, Math.floor(elapsed / interval) - 1);
      boundary = periodDate(start.getUTCFullYear() + periods * interval, 0);
    } else if (frequency === RRule.MONTHLY) {
      elapsed = (threshold.getUTCFullYear() - start.getUTCFullYear()) * 12 + threshold.getUTCMonth() - start.getUTCMonth();
      const periods = Math.max(0, Math.floor(elapsed / interval) - 1);
      boundary = periodDate(start.getUTCFullYear(), start.getUTCMonth() + periods * interval);
    } else {
      const width = frequency === RRule.WEEKLY ? 604800000 : frequency === RRule.DAILY ? 86400000 :
        frequency === RRule.HOURLY ? 3600000 : frequency === RRule.MINUTELY ? 60000 : 1000;
      let origin = Math.floor(start.getTime() / width) * width;
      if (frequency === RRule.WEEKLY) {
        origin = Math.floor(start.getTime() / 86400000) * 86400000 -
          (((start.getUTCDay() + 6) % 7 - rule.options.wkst + 7) % 7) * 86400000;
      }
      const periods = Math.max(0, Math.floor((threshold.getTime() - origin) / (width * interval)) - 1);
      boundary = new Date(origin + periods * width * interval);
    }
    if (boundary <= start) return rule.after(threshold, inclusive);
    return new RRule({ ...seekOptions, dtstart: boundary }, true).after(threshold, inclusive);
  };
  const counter = count !== undefined || rule.options.freq >= RRule.HOURLY && !simpleTick ? recurrenceCounter(rule, zone) : undefined;
  return { description: `${schedule.rrule}; DTSTART=${schedule.dtstart}, ${zone}`, next(after) {
    const threshold = fakeWall(after, zone);
    // Arithmetic seek for unfiltered high-frequency rules, keeping DTSTART phase.
    if (count !== undefined && counter!.countThrough(threshold) >= count) return undefined;
    let date = counter ? counter.nextWall(threshold, true) ?? null : simpleTick ? new Date(start.getTime() + Math.max(0, Math.floor((threshold.getTime() - start.getTime()) / step)) * step)
      : seek(threshold, true);
    while (date) {
      if (options.until && date > options.until) return undefined;
      if (count !== undefined && counter!.countThrough(date) > count) return undefined;
      const instant = wallInstant(date, zone);
      if (instant !== undefined && instant > after) return until === undefined || instant <= until ? instant : undefined;
      date = counter ? counter.nextWall(date, false) ?? null : simpleTick ? new Date(date.getTime() + step) : seek(date, false);
    }
    return undefined;
  } };
}
