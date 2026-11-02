import * as rrulePackage from 'rrule';
import { Temporal } from '@js-temporal/polyfill';

const rrule = rrulePackage as unknown as { RRule: typeof rrulePackage.RRule; Weekday: typeof rrulePackage.Weekday;
  default?: { RRule: typeof rrulePackage.RRule; Weekday: typeof rrulePackage.Weekday } };
const RRule = rrule.RRule ?? rrule.default!.RRule, Weekday = rrule.Weekday ?? rrule.default!.Weekday;
type Rule = InstanceType<typeof RRule>;
const DAY = 86400000;
const MAX_WALL = new Date('9999-12-31T23:59:59.999Z').getTime();
interface Gap { from: number; to: number }
interface Period { end: number; next: number; days: number[]; times: number[]; positions?: number[] }
interface Checkpoint { cursor: number; count: number }
const dateAt = (year: number, month = 0) => {
  const date = new Date(0); date.setUTCFullYear(year, month, 1); return date.getTime();
};
function lowerBound(values: number[], value: number): number {
  let low = 0, high = values.length;
  while (low < high) { const mid = (low + high) >>> 1; if (values[mid] < value) low = mid + 1; else high = mid; }
  return low;
}

/** Counts an anchored, fake-UTC RRULE without expanding every historical tick.
 * Calendar periods aggregate their time sets; subdaily rules reuse each day's
 * time pattern. Zone transitions exclude nonexistent clocks without consuming
 * COUNT. Repeated clocks count once, at the first instant, as in the scheduler.
 */
export class RecurrenceCounter {
  private readonly start: number;
  private readonly step?: number;
  private readonly noClockCandidates: boolean;
  private readonly times: number[] = [];
  private readonly allowedYears = new Map<number, Set<number>>();
  private readonly patterns = new Map<number, number[]>();
  private readonly checkpoints: Checkpoint[] = [];
  private readonly gaps: Gap[] = [];
  private transition?: Temporal.ZonedDateTime | null;
  private cursor: number;
  private prefix = 0;
  private period?: Period;
  constructor(private rule: Rule, private zone?: string) {
    const opts = rule.options;
    this.start = opts.dtstart.getTime(); this.cursor = this.start;
    this.noClockCandidates = opts.freq >= RRule.HOURLY && !this.clockCandidatesExist();
    if (opts.freq >= RRule.WEEKLY && Object.entries(rule.origOptions).every(([key, value]) =>
      value == null || ['freq', 'interval', 'wkst', 'dtstart', 'count', 'until', 'tzid'].includes(key))) {
      this.step = opts.interval * (opts.freq === RRule.WEEKLY ? 7 * DAY : opts.freq === RRule.DAILY ? DAY :
        opts.freq === RRule.HOURLY ? 3600000 : opts.freq === RRule.MINUTELY ? 60000 : 1000);
    }
    if (opts.freq <= RRule.DAILY) for (const hour of opts.byhour) for (const minute of opts.byminute)
      for (const second of opts.bysecond) this.times.push((hour * 3600 + minute * 60 + second) * 1000);
    this.times = [...new Set(this.times)].sort((a, b) => a - b);
    this.checkpoints.push({ cursor: this.cursor, count: 0 });
  }
  countThrough(wall: Date): number {
    const through = Math.min(wall.getTime(), MAX_WALL);
    if (through < this.start || this.noClockCandidates) return 0;
    this.extendGaps(through);
    if (this.step !== undefined) {
      const count = (from: number, to: number) => Math.max(0,
        Math.floor((to - this.start) / this.step!) - Math.max(0, Math.ceil((from - this.start) / this.step!)) + 1);
      let result = count(this.start, through);
      for (const gap of this.gaps) if (gap.from <= through) result -= count(Math.max(this.start, gap.from), Math.min(through, gap.to - 1));
      return result;
    }
    let low = 0, high = this.checkpoints.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.checkpoints[middle].cursor <= through) low = middle + 1; else high = middle; }
    const point = this.checkpoints[Math.max(0, low - 1)];
    if (through < this.cursor || point.cursor > this.cursor) {
      this.cursor = point.cursor; this.prefix = point.count; this.period = undefined;
    }
    for (;;) {
      if (this.cursor > MAX_WALL || !Number.isFinite(this.cursor)) return this.prefix;
      this.period ??= this.buildPeriod();
      if (through <= this.period.end) return this.prefix + this.periodCount(this.period, through);
      this.prefix += this.periodCount(this.period, this.period.end);
      const previousYear = new Date(this.cursor).getUTCFullYear();
      this.cursor = this.period.next; this.period = undefined;
      if (new Date(this.cursor).getUTCFullYear() > previousYear &&
        this.cursor > this.checkpoints[this.checkpoints.length - 1].cursor) this.checkpoints.push({ cursor: this.cursor, count: this.prefix });
    }
  }
  nextWall(wall: Date, inclusive = false): Date | undefined {
    let threshold = Math.max(this.start, wall.getTime() + (inclusive ? 0 : 1));
    if (threshold > MAX_WALL || this.noClockCandidates) return undefined;
    if (this.step !== undefined) {
      for (;;) {
        const candidate = this.start + Math.max(0, Math.ceil((threshold - this.start) / this.step)) * this.step;
        if (candidate > MAX_WALL) return undefined;
        this.extendGaps(candidate);
        const gap = this.gaps.find(gap => candidate >= gap.from && candidate < gap.to);
        if (!gap) return new Date(candidate);
        threshold = gap.to;
      }
    }
    this.countThrough(new Date(threshold));
    for (;;) {
      if (this.cursor > MAX_WALL || !Number.isFinite(this.cursor)) return undefined;
      this.period ??= this.buildPeriod();
      this.extendGaps(this.period.end);
      const candidates: number[] = [];
      if (this.period.positions) {
        const length = this.period.days.length * this.period.times.length;
        for (const position of this.period.positions) {
          const index = position > 0 ? position - 1 : length + position;
          if (index >= 0 && index < length) candidates.push(this.period.days[Math.floor(index / this.period.times.length)] + this.period.times[index % this.period.times.length]);
        }
      } else {
        for (const day of this.period.days) {
          let index = lowerBound(this.period.times, threshold - day);
          while (index < this.period.times.length) {
            const candidate = day + this.period.times[index];
            const gap = this.gaps.find(gap => candidate >= gap.from && candidate < gap.to);
            if (!gap) { candidates.push(candidate); break; }
            index = lowerBound(this.period.times, gap.to - day);
          }
        }
      }
      const candidate = candidates.filter(value => value >= threshold && value >= this.start &&
        !this.gaps.some(gap => value >= gap.from && value < gap.to)).sort((a, b) => a - b)[0];
      if (candidate !== undefined) return new Date(candidate);
      if (this.period.end >= MAX_WALL) return undefined;
      this.countThrough(new Date(this.period.end + 1));
      threshold = Math.max(threshold, this.cursor);
    }
  }
  previousWall(wall: Date, inclusive = false): Date | undefined {
    let upper = Math.min(MAX_WALL, wall.getTime() - (inclusive ? 0 : 1));
    if (this.step !== undefined) {
      this.extendGaps(upper);
      for (;;) {
        const index = Math.floor((upper - this.start) / this.step);
        if (index < 0) return undefined;
        const candidate = this.start + index * this.step;
        const gap = this.gaps.find(gap => candidate >= gap.from && candidate < gap.to);
        if (!gap) return new Date(candidate);
        upper = gap.from - 1;
      }
    }
    const target = this.countThrough(new Date(upper));
    if (!target) return undefined;
    if (target > this.prefix && this.period) {
      const { days, times, positions } = this.period;
      const allowed = (candidate: number) => candidate >= this.start && candidate <= upper &&
        !this.gaps.some(gap => candidate >= gap.from && candidate < gap.to);
      if (positions) {
        const length = days.length * times.length;
        let candidate = -Infinity;
        for (const position of positions) {
          const index = position > 0 ? position - 1 : length + position;
          if (index < 0 || index >= length) continue;
          const value = days[Math.floor(index / times.length)] + times[index % times.length];
          if (value > candidate && allowed(value)) candidate = value;
        }
        if (Number.isFinite(candidate)) return new Date(candidate);
      } else for (let i = days.length - 1; i >= 0; i--) {
        const day = days[i];
        let index = lowerBound(times, Math.min(upper, day + DAY - 1) - day + 1) - 1;
        while (index >= 0) {
          const candidate = day + times[index];
          if (candidate < this.start) break;
          const gap = this.gaps.find(gap => candidate >= gap.from && candidate < gap.to);
          if (!gap && allowed(candidate)) return new Date(candidate);
          index = gap ? lowerBound(times, gap.from - day) - 1 : index - 1;
        }
      }
    }
    let lower = this.start;
    // Find the instant at which this prefix count first becomes present. Year
    // checkpoints keep backwards probes local; this never expands occurrences.
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      if (this.countThrough(new Date(middle)) >= target) upper = middle; else lower = middle + 1;
    }
    return new Date(lower);
  }
  private extendGaps(through: number): void {
    if (!this.zone) return;
    if (this.transition === undefined) this.transition = Temporal.Instant.fromEpochMilliseconds(this.start - 2 * DAY)
      .toZonedDateTimeISO(this.zone).getTimeZoneTransition('next');
    while (this.transition && this.transition.epochMilliseconds <= through + 2 * DAY) {
      const transition: Temporal.ZonedDateTime = this.transition;
      const before = transition.subtract({ nanoseconds: 1 }).offsetNanoseconds / 1000000;
      const after = transition.offsetNanoseconds / 1000000;
      if (after > before) this.gaps.push({ from: transition.epochMilliseconds + before, to: transition.epochMilliseconds + after });
      this.transition = transition.getTimeZoneTransition('next');
    }
  }
  private daysInYear(year: number): Set<number> {
    let days = this.allowedYears.get(year);
    if (days) return days;
    const opts = this.rule.options;
    const weekdays = [...(opts.byweekday ?? []), ...(opts.bynweekday ?? []).map(([day, ordinal]) => new Weekday(day, ordinal))];
    const filters = {
      bymonth: opts.bymonth, bymonthday: [...opts.bymonthday, ...opts.bynmonthday],
      byyearday: opts.byyearday, byweekno: opts.byweekno, byweekday: weekdays.length ? weekdays : undefined,
      byeaster: opts.byeaster, wkst: opts.wkst,
    };
    // Prevent the YEARLY/MONTHLY constructor from inventing DTSTART day filters.
    if (!filters.bymonthday.length && !weekdays.length && !filters.byweekno?.length &&
      !filters.byyearday?.length && filters.byeaster == null) filters.byyearday = Array.from({ length: 366 }, (_, i) => i + 1);
    const dayRule = new RRule({ ...filters, freq: opts.freq === RRule.MONTHLY ? RRule.MONTHLY : RRule.YEARLY,
      dtstart: new Date(dateAt(year)), until: new Date(dateAt(year + 1) - 1), byhour: [0], byminute: [0], bysecond: [0] }, true);
    days = new Set(dayRule.all().map(date => date.getTime())); this.allowedYears.set(year, days);
    return days;
  }
  private allowed(day: number): boolean { return this.daysInYear(new Date(day).getUTCFullYear()).has(day); }
  private buildPeriod(): Period {
    const opts = this.rule.options, date = new Date(this.cursor), day = Math.floor(this.cursor / DAY) * DAY;
    if (opts.freq >= RRule.HOURLY) {
      const width = opts.freq === RRule.HOURLY ? 3600000 : opts.freq === RRule.MINUTELY ? 60000 : 1000;
      const origin = Math.floor(this.start / width) * width, step = width * opts.interval;
      const next = origin + Math.ceil((day + DAY - origin) / step) * step;
      return { end: day + DAY - 1, next, days: this.allowed(day) ? [day] : [], times: this.timePattern(day) };
    }
    let from: number, end: number, next: number;
    if (opts.freq === RRule.YEARLY) {
      from = dateAt(date.getUTCFullYear()); end = dateAt(date.getUTCFullYear() + 1);
      next = dateAt(date.getUTCFullYear() + opts.interval);
    } else if (opts.freq === RRule.MONTHLY) {
      from = dateAt(date.getUTCFullYear(), date.getUTCMonth()); end = dateAt(date.getUTCFullYear(), date.getUTCMonth() + 1);
      next = dateAt(date.getUTCFullYear(), date.getUTCMonth() + opts.interval);
    } else if (opts.freq === RRule.WEEKLY) {
      const weekday = (date.getUTCDay() + 6) % 7;
      from = day; end = day + ((opts.wkst - weekday + 6) % 7 + 1) * DAY;
      next = end + (opts.interval - 1) * 7 * DAY;
    } else { from = day; end = day + DAY; next = day + opts.interval * DAY; }
    const days: number[] = [];
    for (let current = from; current < end; current += DAY) if (this.allowed(current)) days.push(current);
    return { end: end - 1, next, days, times: this.times, positions: opts.bysetpos?.length ? opts.bysetpos : undefined };
  }
  private periodCount(period: Period, through: number): number {
    if (!period.times.length || !period.days.length) return 0;
    const countDay = (day: number, times: number[]) => {
      const lower = Math.max(this.start, day), upper = Math.min(through, day + DAY - 1);
      if (upper < lower) return 0;
      let count = lowerBound(times, upper - day + 1) - lowerBound(times, lower - day);
      for (const gap of this.gaps) {
        if (gap.from > upper) break;
        if (gap.to > lower) count -= lowerBound(times, Math.min(upper + 1, gap.to) - day) - lowerBound(times, Math.max(lower, gap.from) - day);
      }
      return count;
    };
    if (!period.positions) return period.days.reduce((count, day) => count + countDay(day, period.times), 0);
    const length = period.days.length * period.times.length;
    let result = 0;
    const seen = new Set<number>();
    for (const position of period.positions) {
      const index = position > 0 ? position - 1 : length + position;
      if (index < 0 || index >= length || seen.has(index)) continue;
      seen.add(index);
      result += countDay(period.days[Math.floor(index / period.times.length)], [period.times[index % period.times.length]]);
    }
    return result;
  }
  private timePattern(day: number): number[] {
    const opts = this.rule.options;
    const width = opts.freq === RRule.HOURLY ? 3600000 : opts.freq === RRule.MINUTELY ? 60000 : 1000;
    const origin = Math.floor(this.start / width) * width, step = opts.interval * width;
    const phase = ((day - origin) % step + step) % step;
    let times = this.patterns.get(phase);
    if (times) return times;
    const values: number[] = [];
    const hours = opts.byhour?.length ? [...new Set(opts.byhour)] : Array.from({ length: 24 }, (_, i) => i);
    const minutes = opts.byminute?.length ? [...new Set(opts.byminute)] : Array.from({ length: 60 }, (_, i) => i);
    const seconds = opts.bysecond?.length ? [...new Set(opts.bysecond)] : Array.from({ length: 60 }, (_, i) => i);
    const appendPeriod = (period: number, lower: number[]) => {
      if ((day + period - origin) % step !== 0) return;
      lower.sort((a, b) => a - b);
      if (opts.bysetpos?.length) for (const position of opts.bysetpos) {
        const value = lower[position > 0 ? position - 1 : lower.length + position];
        if (value !== undefined) values.push(period + value);
      } else for (const value of lower) values.push(period + value);
    };
    // Advance anchored frequency periods first, then apply BY filters. Library
    // shortcuts that skip rejected hours can otherwise change the interval's
    // phase, or loop forever for a valid combination of interval and BY fields.
    for (const hour of hours) {
      if (opts.freq === RRule.HOURLY) {
        const lower = minutes.flatMap(minute => seconds.map(second => (minute * 60 + second) * 1000));
        appendPeriod(hour * 3600000, lower);
      } else for (const minute of minutes) {
        if (opts.freq === RRule.MINUTELY) appendPeriod((hour * 60 + minute) * 60000, seconds.map(second => second * 1000));
        else for (const second of seconds) appendPeriod((hour * 3600 + minute * 60 + second) * 1000, [0]);
      }
    }
    times = [...new Set(values)].sort((a, b) => a - b); this.patterns.set(phase, times); return times;
  }
  private clockCandidatesExist(): boolean {
    const opts = this.rule.options;
    const units = opts.freq === RRule.HOURLY ? 24 : opts.freq === RRule.MINUTELY ? 1440 : 86400;
    let a = opts.interval, divisor = units;
    while (divisor) { const remainder = a % divisor; a = divisor; divisor = remainder; }
    const origin = Math.floor(this.start / (DAY / units));
    const hours = opts.byhour?.length ? [...new Set(opts.byhour)] : Array.from({ length: 24 }, (_, i) => i);
    const minutes = opts.byminute?.length ? [...new Set(opts.byminute)] : Array.from({ length: 60 }, (_, i) => i);
    const seconds = opts.bysecond?.length ? [...new Set(opts.bysecond)] : Array.from({ length: 60 }, (_, i) => i);
    const size = opts.freq === RRule.HOURLY ? minutes.length * seconds.length : opts.freq === RRule.MINUTELY ? seconds.length : 1;
    if (opts.bysetpos?.length && !opts.bysetpos.some(position => Math.abs(position) <= size)) return false;
    for (const hour of hours) {
      if (opts.freq === RRule.HOURLY) { if ((hour - origin) % a === 0) return true; }
      else for (const minute of minutes) {
        if (opts.freq === RRule.MINUTELY) { if ((hour * 60 + minute - origin) % a === 0) return true; }
        else for (const second of seconds) if ((hour * 3600 + minute * 60 + second - origin) % a === 0) return true;
      }
    }
    return false;
  }

}

// Wake/clock changes recompile schedules. Preserve their immutable counting
// indexes so a discontinuity does not repeat the historical calendar scan.
const counters = new Map<string, RecurrenceCounter>();
export function recurrenceCounter(rule: Rule, zone?: string): RecurrenceCounter {
  const key = `${rule.toString()}\n${zone ?? ''}`;
  let counter = counters.get(key);
  if (!counter) counter = new RecurrenceCounter(rule, zone);
  counters.delete(key); counters.set(key, counter);
  if (counters.size > 32) counters.delete(counters.keys().next().value!);
  return counter;
}
