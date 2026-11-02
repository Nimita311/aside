import * as rruleModule from 'rrule';
import { Temporal } from '@js-temporal/polyfill';
import { isCalendarDate, isWallMinute, scheduleInstant, wallTimeAt, schedulingIssues } from './scheduling.js';
import type { Action, ActionFrontMatter } from './types.js';
import { recurrenceCounter, type RecurrenceCounter } from './rrule-count.js';
const rrule = rruleModule as unknown as { RRule: typeof import('rrule').RRule; default?: { RRule: typeof import('rrule').RRule } };
const RRule = rrule.RRule ?? rrule.default!.RRule;

export interface RecurrenceSchedule { dtstart: string; rrule: string; timezone?: string }
export interface RecurrenceScheduleSelector { dtstart: string; timezone?: string }
export type RecurrenceMutation =
  | { append: RecurrenceSchedule; set_end?: never; remove?: never }
  | { set_end: { schedule: RecurrenceScheduleSelector; at?: string }; append?: never; remove?: never }
  | { remove: RecurrenceScheduleSelector; append?: never; set_end?: never };
export interface OccurrenceIdentity { template: string; original: string; timezone?: string }
export interface PlanningAction { id: string; action: Action; projected: boolean; occurrence?: OccurrenceIdentity }
export interface PlanningPage { nodes: PlanningAction[]; next: string | null; issues: string[] }

const fields = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYWEEKNO', 'BYYEARDAY', 'BYSETPOS', 'BYHOUR', 'BYMINUTE', 'BYSECOND', 'WKST']);
function wallDate(wall: string): Date { return new Date(wall.length === 10 ? wall + 'T00:00:00Z' : wall + ':00Z'); }
function wallString(date: Date, allDay: boolean): string { return date.toISOString().slice(0, allDay ? 10 : 16); }
function isOriginalInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value;
}
function wallUpperBound(ms: number, timezone?: string): string {
  const wall = wallTimeAt(ms, timezone);
  // In the second repeated hour, earlier instants can have later wall clocks.
  // Broaden the wall bound by the fold, then compare candidates as instants.
  const first = scheduleInstant(wall, timezone)!;
  return shiftedWall(wall, Math.max(0, Math.floor((ms - first) / 60000)), false);
}
function normalizationGapAt(ms: number): { from: number; to: number; transition: number } | undefined {
  // Floating gap clocks normalize forward. During that interval, an earlier
  // authored clock can resolve after the boundary and must remain in the seek.
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const instant = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone);
  const transition = instant.add({ nanoseconds: 1 }).getTimeZoneTransition('previous');
  if (!transition) return undefined;
  const before = transition.subtract({ nanoseconds: 1 }).offsetNanoseconds / 1000000, after = transition.offsetNanoseconds / 1000000;
  return after > before && ms - transition.epochMilliseconds < after - before
    ? { from: transition.epochMilliseconds + before, to: transition.epochMilliseconds + after, transition: transition.epochMilliseconds } : undefined;
}
function boundarySeekWall(ms: number, timezone?: string, allDay = false): string {
  const wall = wallTimeAt(ms, timezone);
  if (timezone || allDay) return allDay ? wall.slice(0, 10) : wall;
  const gap = normalizationGapAt(ms);
  return gap ? wallString(new Date(gap.from + ms - gap.transition), false) : wall;
}
export function occurrenceKey(value: OccurrenceIdentity): string { return JSON.stringify([value.template, value.original]); }
export function projectionId(value: OccurrenceIdentity): string { return `~${encodeURIComponent(value.template)}@${encodeURIComponent(value.original)}`; }

export function assertRecurrence(value: unknown): RecurrenceSchedule[] {
  if (!Array.isArray(value)) throw new Error('recurrence must be an ordered list of schedules; an empty list retains a dormant template.');
  let previous: CompiledRecurrence | undefined;
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`recurrence.${index} must be a schedule.`);
    const s = raw as Record<string, unknown>;
    if (Object.keys(s).some(key => !['dtstart', 'rrule', 'timezone'].includes(key))) throw new Error(`recurrence.${index} has an unknown field; use dtstart, rrule, timezone.`);
    if (typeof s.dtstart !== 'string' || (!isCalendarDate(s.dtstart) && !isWallMinute(s.dtstart))) throw new Error('dtstart must be a date or wall time at minute precision.');
    if (s.timezone !== undefined && (typeof s.timezone !== 'string' || isCalendarDate(s.dtstart))) throw new Error('All-day recurrence has no timezone; timed timezone must be an IANA name.');
    if (typeof s.rrule !== 'string' || !s.rrule || /[\r\n]/.test(s.rrule)) throw new Error('rrule must contain one RRULE.');
    const schedule: RecurrenceSchedule = { dtstart: s.dtstart, rrule: s.rrule, ...(s.timezone !== undefined && { timezone: s.timezone as string }) };
    const invalid = schedulingIssues({ scheduled: schedule.dtstart, timezone: schedule.timezone });
    if (invalid.length) throw new Error(invalid.join('\n'));
    const parts = schedule.rrule.replace(/^RRULE:/, '').split(';');
    const names = parts.map(p => p.split('=')[0]);
    if (!names.includes('FREQ') || names.some(n => !fields.has(n)) || new Set(names).size !== names.length || parts.some(p => p.split('=').length !== 2 || !p.split('=')[1])) throw new Error('rrule must contain FREQ and unique standard rule parts with nonempty values.');
    const partsByName = Object.fromEntries(parts.map(p => p.split('=')));
    if (partsByName.WKST && !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(partsByName.WKST)) throw new Error('WKST must be one weekday: MO, TU, WE, TH, FR, SA, or SU.');
    for (const name of ['INTERVAL', 'COUNT']) if (partsByName[name] !== undefined && !/^\+?\d+$/.test(partsByName[name])) throw new Error('INTERVAL and COUNT must be positive integers.');
    if (partsByName.BYDAY && partsByName.BYDAY.split(',').some((day: string) => !/^([+-]?[1-9]\d?)?(MO|TU|WE|TH|FR|SA|SU)$/.test(day) || Math.abs(parseInt(day)) > 53)) throw new Error('Invalid BYDAY values.');
    const options = RRule.parseString(schedule.rrule);
    if (options.count !== undefined && options.until) throw new Error('RRULE cannot combine COUNT and UNTIL.');
    for (const v of [options.interval, options.count]) if (v != null && (!Number.isSafeInteger(v) || v <= 0)) throw new Error('INTERVAL and COUNT must be positive integers.');
    for (const [name, max, negative] of [['BYMONTH', 12, false], ['BYHOUR', 23, false], ['BYMINUTE', 59, false], ['BYSECOND', 59, false], ['BYMONTHDAY', 31, true], ['BYYEARDAY', 366, true], ['BYWEEKNO', 53, true], ['BYSETPOS', 366, true]] as const) {
      const part = parts.find(p => p.startsWith(name + '='));
      if (part && part.split('=')[1].split(',').some(v => !/^-?\d+$/.test(v) || Number(v) > max || Number(v) < (negative ? -max : 0) || (negative || name === 'BYMONTH') && Number(v) === 0)) throw new Error(`Invalid ${name} values.`);
    }
    const seconds = options.bysecond === undefined ? [0] : Array.isArray(options.bysecond) ? options.bysecond : [options.bysecond];
    if (seconds.some(v => v !== 0) || options.freq === RRule.SECONDLY && (options.interval ?? 1) % 60 !== 0) throw new Error('Action recurrence must generate whole-minute starts; seconds are not rounded.');
    if (isCalendarDate(schedule.dtstart) && (options.freq! > RRule.DAILY || names.some(n => ['BYHOUR', 'BYMINUTE', 'BYSECOND'].includes(n)))) throw new Error('All-day recurrence cannot contain time-of-day parts or subdaily frequencies.');
    const until = parts.find(p => p.startsWith('UNTIL='))?.slice(6);
    if (until) {
      const pattern = isCalendarDate(schedule.dtstart) ? /^\d{8}$/ : schedule.timezone ? /^\d{8}T\d{6}Z$/ : /^\d{8}T\d{6}$/;
      const untilWall = `${until.slice(0,4)}-${until.slice(4,6)}-${until.slice(6,8)}` + (until.length > 8 ? `T${until.slice(9,11)}:${until.slice(11,13)}` : '');
      if (!pattern.test(until) || (!isCalendarDate(untilWall) && !isWallMinute(untilWall)) || until.length > 8 && Number(until.slice(13,15)) > 59 || !options.until || !Number.isFinite(options.until.getTime())) throw new Error('UNTIL must match DTSTART semantics: date for all-day, local time for floating, UTC for zoned schedules.');
    }
    const compiled = new CompiledRecurrence(schedule);
    if (!compiled.matchesStart()) throw new Error('dtstart must match the RRULE pattern.');
    if (previous) {
      if (previous.allDay !== compiled.allDay) throw new Error('Recurrence history cannot mix all-day and timed schedules.');
      let overlap = previous.allDay ? previous.schedule.dtstart >= compiled.schedule.dtstart : previous.startInstant >= compiled.startInstant;
      const boundary = previous.allDay ? compiled.schedule.dtstart : boundarySeekWall(compiled.startInstant, previous.schedule.timezone);
      if (!overlap) for (const next of previous.occurrences('', boundary)) {
        if (previous.allDay ? next.scheduled >= compiled.schedule.dtstart : scheduleInstant(next.scheduled, previous.schedule.timezone)! >= compiled.startInstant) { overlap = true; break; }
      }
      if (overlap) throw new Error('Recurrence schedules must be ordered and nonoverlapping; end the previous rule before the next starts.');
    }
    previous = compiled;
    return schedule;
  });
}

// RRule expands wall clocks in UTC; named zones are resolved afterwards. This
// avoids process-zone-dependent identity and skips DST gaps without consuming COUNT.
export class CompiledRecurrence {
  readonly allDay: boolean;
  readonly rule: InstanceType<typeof RRule>;
  readonly startInstant: number;
  private count?: number;
  private until?: number;
  private counter: RecurrenceCounter;
  private countEnd?: number;
  constructor(readonly schedule: RecurrenceSchedule) {
    this.allDay = isCalendarDate(schedule.dtstart);
    this.startInstant = scheduleInstant(schedule.dtstart, schedule.timezone)!;
    const options = RRule.parseString(schedule.rrule);
    this.count = options.count ?? undefined;
    if (options.until) {
      this.until = schedule.timezone ? options.until.getTime() : scheduleInstant(wallString(options.until, this.allDay))!;
      options.until = schedule.timezone ? wallDate(wallUpperBound(options.until.getTime(), schedule.timezone)) : options.until;
    }
    this.rule = new RRule({ ...options, dtstart: wallDate(schedule.dtstart), count: undefined });
    this.counter = recurrenceCounter(this.rule, schedule.timezone);
  }
  matchesStart(): boolean { return this.nextDate(wallDate(this.schedule.dtstart), true)?.getTime() === wallDate(this.schedule.dtstart).getTime(); }
  identity(template: string, date: Date): OccurrenceIdentity | undefined {
    const wall = wallString(date, this.allDay);
    const instant = scheduleInstant(wall, this.schedule.timezone);
    if (instant === undefined || this.until !== undefined && instant > this.until || this.count && (this.countEnd !== undefined ? date.getTime() > this.countEnd : this.counter.countThrough(date) > this.count)) return undefined;
    return { template, original: this.schedule.timezone ? new Date(instant).toISOString().replace('.000Z', 'Z') : wall, ...(this.schedule.timezone && { timezone: this.schedule.timezone }) };
  }
  wallFor(original: string): string | undefined {
    if (this.schedule.timezone) {
      if (!isOriginalInstant(original)) return undefined;
      return wallTimeAt(Date.parse(original), this.schedule.timezone);
    }
    return this.allDay ? isCalendarDate(original) ? original : undefined : isWallMinute(original) ? original : undefined;
  }
  private seekRule(threshold: Date): InstanceType<typeof RRule> {
    const start = this.rule.options.dtstart, frequency = this.rule.options.freq, interval = this.rule.options.interval;
    let boundary: Date;
    if (frequency === RRule.YEARLY) {
      const periods = Math.max(0, Math.floor((threshold.getUTCFullYear() - start.getUTCFullYear()) / interval) - 1);
      boundary = new Date(Date.UTC(start.getUTCFullYear() + periods * interval, 0, 1));
    } else if (frequency === RRule.MONTHLY) {
      const elapsed = (threshold.getUTCFullYear() - start.getUTCFullYear()) * 12 + threshold.getUTCMonth() - start.getUTCMonth();
      boundary = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + Math.max(0, Math.floor(elapsed / interval) - 1) * interval, 1));
    } else {
      const width = frequency === RRule.WEEKLY ? 604800000 : frequency === RRule.DAILY ? 86400000 : frequency === RRule.HOURLY ? 3600000 : frequency === RRule.MINUTELY ? 60000 : 1000;
      let origin = Math.floor(start.getTime() / width) * width;
      if (frequency === RRule.WEEKLY) origin = Math.floor(start.getTime() / 86400000) * 86400000 - ((start.getUTCDay() + 6) % 7 - this.rule.options.wkst + 7) % 7 * 86400000;
      boundary = new Date(origin + Math.max(0, Math.floor((threshold.getTime() - origin) / (width * interval)) - 1) * width * interval);
    }
    if (boundary <= start) return this.rule;
    return new RRule({ ...this.rule.origOptions, dtstart: boundary, bymonth: this.rule.options.bymonth,
      bymonthday: this.rule.origOptions.bymonthday ?? [...this.rule.options.bymonthday, ...this.rule.options.bynmonthday],
      byweekday: this.rule.origOptions.byweekday ?? this.rule.options.byweekday, byhour: this.rule.options.byhour,
      byminute: this.rule.options.byminute, bysecond: this.rule.options.bysecond });
  }
  private nextDate(threshold: Date, inclusive: boolean): Date | undefined {
    const date = this.rule.options.freq >= RRule.HOURLY ? this.counter.nextWall(threshold, inclusive) : this.seekRule(threshold).after(threshold, inclusive) ?? undefined;
    return date && (!this.rule.options.until || date <= this.rule.options.until) ? date : undefined;
  }
  private countedEnd(): number {
    if (this.countEnd !== undefined) return this.countEnd;
    const start = this.rule.options.dtstart.getTime(), maximum = new Date('9999-12-31T23:59:00Z').getTime();
    const frequency = this.rule.options.freq;
    const width = frequency === RRule.YEARLY ? 366 * 86400000 : frequency === RRule.MONTHLY ? 31 * 86400000 : frequency === RRule.WEEKLY ? 7 * 86400000 : frequency === RRule.DAILY ? 86400000 : frequency === RRule.HOURLY ? 3600000 : frequency === RRule.MINUTELY ? 60000 : 1000;
    let span = Math.max(60000, width * this.rule.options.interval * (this.count! - 1));
    let high = Math.min(maximum, start + span);
    while (this.counter.countThrough(new Date(high)) < this.count! && high < maximum) {
      span *= 2; high = Math.min(maximum, start + span);
    }
    if (this.counter.countThrough(new Date(high)) < this.count!) return this.countEnd = maximum;
    let low = Math.floor(start / 60000) - 1, upper = Math.floor(high / 60000);
    // Search the compressed rank, not the historical occurrence stream.
    while (upper - low > 1) {
      const mid = Math.floor((low + upper) / 2);
      if (this.counter.countThrough(new Date(mid * 60000)) >= this.count!) upper = mid;
      else low = mid;
    }
    return this.countEnd = upper * 60000;
  }
  previous(template: string, upper: string, inclusive = true): { identity: OccurrenceIdentity; scheduled: string } | undefined {
    let threshold = wallDate(upper);
    if (this.rule.options.until && threshold > this.rule.options.until) { threshold = this.rule.options.until; inclusive = true; }
    if (this.count && this.counter.countThrough(threshold) > this.count) {
      threshold = new Date(this.countedEnd()); inclusive = true;
    }
    while (threshold >= this.rule.options.dtstart) {
      const seek = this.seekRule(threshold);
      const date = this.rule.options.freq >= RRule.HOURLY ? this.counter.previousWall(threshold, inclusive) : seek.before(threshold, inclusive);
      if (date) {
        const identity = this.identity(template, date);
        if (identity) return { identity, scheduled: wallString(date, this.allDay) };
        threshold = date; inclusive = false;
      } else {
        if (seek === this.rule) return undefined;
        threshold = new Date(seek.options.dtstart.getTime() - 60000); inclusive = true;
      }
    }
    return undefined;
  }
  previousBefore(now: Date): { identity: OccurrenceIdentity; scheduled: string } | undefined {
    let wall = wallUpperBound(now.getTime() - 1, this.schedule.timezone), inclusive = true;
    for (;;) {
      const value = this.previous('', wall, inclusive);
      if (!value) return undefined;
      const instant = scheduleInstant(value.scheduled, this.schedule.timezone)!;
      if (instant < now.getTime()) return value;
      wall = value.scheduled; inclusive = false;
    }
  }
  lastBefore(now: Date): number {
    const value = this.previousBefore(now);
    return value ? scheduleInstant(value.scheduled, this.schedule.timezone)! : -Infinity;
  }
  pastExtent(now: Date): { rank: number; excluded?: { from: number; to: number } } {
    let last: { identity: OccurrenceIdentity; scheduled: string } | undefined;
    const local = wallTimeAt(now.getTime()), elapsed = now.getTime() - scheduleInstant(local)!;
    if (this.allDay) {
      const today = local.slice(0, 10);
      last = this.previous('', today, scheduleInstant(today)! < now.getTime());
    } else if (this.schedule.timezone || elapsed >= 60000) last = this.previousBefore(now);
    else {
      const upper = new Date(wallDate(local).getTime() + elapsed - 1);
      last = this.previous('', wallString(upper, this.allDay));
    }
    if (!last) return { rank: 0 };
    const rank = this.counter.countThrough(wallDate(last.scheduled));
    if (this.schedule.timezone || this.allDay || this.until === undefined) return { rank };
    // A floating UNTIL inside the normalized gap can exclude earlier authored
    // clocks while admitting a later clock. Keep that hole in the rank extent.
    const cutoff = this.until + 1, gap = normalizationGapAt(cutoff);
    if (!gap) return { rank };
    const from = this.counter.countThrough(new Date(gap.from + cutoff - gap.transition - 1)) + 1;
    const to = Math.min(rank, this.counter.countThrough(new Date(gap.to - 1)));
    return from <= to ? { rank, excluded: { from, to } } : { rank };
  }
  rankOf(original: string): number | undefined {
    const occurrence = this.contains('', original);
    return occurrence ? this.counter.countThrough(wallDate(occurrence.scheduled)) : undefined;
  }
  *occurrences(template: string, from?: string, to?: string): Generator<{ identity: OccurrenceIdentity; scheduled: string }> {
    const lower = from ? wallDate(from) : wallDate(this.schedule.dtstart);
    const upper = to ? wallDate(to.length === 10 && !this.allDay ? to + 'T23:59' : to) : undefined;
    let cursor = lower, inclusive = true;
    while (true) {
      const date = this.nextDate(cursor, inclusive);
      if (!date || upper && date > upper || this.count && this.counter.countThrough(date) > this.count) return;
      cursor = date; inclusive = false;
      const identity = this.identity(template, date);
      if (identity) yield { identity, scheduled: wallString(date, this.allDay) };
    }
  }
  lastInstant(): number {
    if (!this.count && this.until === undefined) return Infinity;
    if (this.until !== undefined) return this.lastBefore(new Date(this.until + 1));
    const last = this.previous('', wallString(new Date(this.countedEnd()), this.allDay));
    return last ? scheduleInstant(last.scheduled, this.schedule.timezone)! : -Infinity;
  }
  contains(template: string, original: string): { identity: OccurrenceIdentity; scheduled: string } | undefined {
    const wall = this.wallFor(original);
    if (!wall) return undefined;
    const found = this.occurrences(template, wall, wall).next().value;
    return found && found.identity.original === original ? found : undefined;
  }
}

function pattern(schedule: RecurrenceSchedule): string {
  const parts = schedule.rrule.replace(/^RRULE:/, '').split(';').filter(p => !p.startsWith('UNTIL=') && !p.startsWith('COUNT=')).sort();
  return JSON.stringify([schedule.dtstart, schedule.timezone ?? null, parts]);
}
function withoutEnd(schedule: RecurrenceSchedule): RecurrenceSchedule {
  const prefix = schedule.rrule.startsWith('RRULE:') ? 'RRULE:' : '';
  return { ...schedule, rrule: prefix + schedule.rrule.replace(/^RRULE:/, '').split(';').filter(part => !part.startsWith('UNTIL=') && !part.startsWith('COUNT=')).join(';') };
}
function withEnd(schedule: RecurrenceSchedule, last: { identity: OccurrenceIdentity; scheduled: string }): RecurrenceSchedule {
  const until = schedule.timezone ? last.identity.original.replace(/[-:]/g, '') : last.scheduled.replace(/[-:]/g, '') + (isCalendarDate(schedule.dtstart) ? '' : '00');
  const open = withoutEnd(schedule);
  return { ...open, rrule: `${open.rrule};UNTIL=${until}` };
}
function extentContains(extent: { rank: number; excluded?: { from: number; to: number } }, rank: number): boolean {
  return rank <= extent.rank && (!extent.excluded || rank < extent.excluded.from || rank > extent.excluded.to);
}
function extentSize(extent: { rank: number; excluded?: { from: number; to: number } }): number {
  return extent.rank - (extent.excluded ? extent.excluded.to - extent.excluded.from + 1 : 0);
}
function extentIntersection(a: { rank: number; excluded?: { from: number; to: number } }, b: { rank: number; excluded?: { from: number; to: number } }): number {
  const rank = Math.min(a.rank, b.rank), clipped = (value?: { from: number; to: number }) => value ? Math.max(0, Math.min(rank, value.to) - value.from + 1) : 0;
  const shared = a.excluded && b.excluded ? clipped({ from: Math.max(a.excluded.from, b.excluded.from), to: Math.min(a.excluded.to, b.excluded.to) }) : 0;
  return rank - clipped(a.excluded) - clipped(b.excluded) + shared;
}
export function assertRecurrenceUpdate(before: RecurrenceSchedule[] | undefined, after: RecurrenceSchedule[] | undefined, now = new Date(), coveredOriginals: ReadonlySet<string> = new Set()): void {
  if (!before) return;
  for (const next of after ?? []) {
    const previous = before.find(s => pattern(s) === pattern(next)), rule = new CompiledRecurrence(next);
    if (previous?.rrule === next.rrule) continue;
    const future = rule.pastExtent(now);
    if (!previous) {
      if (rule.startInstant < now.getTime() || extentSize(future)) throw new Error('Cannot add or rewrite a recurrence rule governing time before now.');
      continue;
    }
    const old = new CompiledRecurrence(previous).pastExtent(now), added = extentSize(future) - extentIntersection(old, future);
    if (!added) continue;
    if (coveredOriginals.size < added) throw new Error('Recurrence changes cannot create new past projections; materialized occurrence identities must cover every added past occurrence.');
    let covered = 0;
    for (const original of coveredOriginals) {
      const rank = rule.rankOf(original);
      if (rank !== undefined && extentContains(future, rank) && !extentContains(old, rank) && ++covered === added) break;
    }
    if (covered < added) throw new Error('Recurrence changes cannot create new past projections; materialized occurrence identities must cover every added past occurrence.');
  }
}

export function appendRecurrenceSchedule(before: RecurrenceSchedule[] | undefined, schedule: RecurrenceSchedule, now = new Date()): RecurrenceSchedule[] {
  const next = assertRecurrence([schedule])[0], incoming = new CompiledRecurrence(next);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid recurrence update time.');
  if (incoming.startInstant < now.getTime()) throw new Error('New recurrence schedules cannot start before now.');
  if (!before?.length) {
    assertRecurrenceUpdate(before ?? [], [next], now);
    return [next];
  }
  assertRecurrence(before);
  const schedules = [...before], tail = before[before.length - 1], previous = new CompiledRecurrence(tail);
  if (previous.allDay !== incoming.allDay) throw new Error('Recurrence history cannot mix all-day and timed schedules.');
  if (previous.allDay ? next.dtstart <= tail.dtstart : incoming.startInstant <= previous.startInstant) throw new Error('Append a recurrence schedule starting after the final schedule.');

  // DATE and floating clocks retain their authored coordinates. A zone change
  // instead places the boundary in the preceding schedule's clock.
  const authoredBoundary = previous.allDay || !tail.timezone && !next.timezone;
  const boundary = authoredBoundary ? next.dtstart : wallTimeAt(incoming.startInstant, tail.timezone);
  const seek = authoredBoundary ? boundary : boundarySeekWall(incoming.startInstant, tail.timezone);
  let overlaps = false;
  for (const occurrence of previous.occurrences('', seek)) {
    if (authoredBoundary || scheduleInstant(occurrence.scheduled, tail.timezone)! >= incoming.startInstant) { overlaps = true; break; }
  }
  if (overlaps) {
    const last = authoredBoundary ? previous.previous('', boundary, false) : previous.previousBefore(new Date(incoming.startInstant));
    if (!last || !authoredBoundary && scheduleInstant(last.scheduled, tail.timezone)! >= incoming.startInstant) throw new Error('Cannot close the final recurrence rule before the appended schedule.');
    schedules[schedules.length - 1] = withEnd(tail, last);
  }
  schedules.push(next);
  assertRecurrence(schedules);
  assertRecurrenceUpdate(before, schedules, now);
  return schedules;
}

function selectedSchedule(schedules: RecurrenceSchedule[], value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Schedule selector must contain dtstart and optional timezone.');
  const selector = value as Record<string, unknown>;
  if (Object.keys(selector).some(key => !['dtstart', 'timezone'].includes(key)) || typeof selector.dtstart !== 'string' || !isCalendarDate(selector.dtstart) && !isWallMinute(selector.dtstart) || selector.timezone !== undefined && typeof selector.timezone !== 'string') throw new Error('Schedule selector must contain dtstart and optional timezone.');
  const matches = schedules.flatMap((schedule, index) => schedule.dtstart === selector.dtstart && schedule.timezone === selector.timezone ? [index] : []);
  if (!matches.length) throw new Error('Recurrence schedule not found for the exact dtstart and timezone.');
  if (matches.length !== 1) throw new Error('Recurrence schedule selector is ambiguous.');
  return matches[0];
}
function exclusiveCutoff(value: string | undefined, now: Date): Date {
  if (value === undefined) {
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid recurrence update time.');
    return now;
  }
  try {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !isWallMinute(value.slice(0, 16))) throw new Error();
    const instant = Temporal.Instant.from(value);
    // Occurrences are integral milliseconds. Ceiling preserves an exclusive
    // cutoff whose positive fractional millisecond admits the boundary start.
    const cutoff = new Date(instant.epochMilliseconds + (instant.epochNanoseconds % 1000000n ? 1 : 0));
    if (!Number.isFinite(cutoff.getTime())) throw new Error();
    return cutoff;
  } catch { throw new Error('at must be a valid ISO timestamp with Z or an explicit colon offset.'); }
}
export function applyRecurrenceMutation(before: RecurrenceSchedule[] | undefined, mutation: RecurrenceMutation, now = new Date(), coveredOriginals: ReadonlySet<string> = new Set()): RecurrenceSchedule[] {
  if (!mutation || typeof mutation !== 'object' || Array.isArray(mutation) || Object.keys(mutation).length !== 1 || !Object.keys(mutation).every(key => ['append', 'set_end', 'remove'].includes(key))) throw new Error('Choose exactly one recurrence operation: append, set_end, or remove.');
  if (Object.hasOwn(mutation, 'append')) return appendRecurrenceSchedule(before, mutation.append!, now);
  const schedules = [...assertRecurrence(before ?? [])];
  if (Object.hasOwn(mutation, 'remove')) schedules.splice(selectedSchedule(schedules, mutation.remove), 1);
  else {
    const end = mutation.set_end;
    if (!end || typeof end !== 'object' || Array.isArray(end) || Object.keys(end).some(key => !['schedule', 'at'].includes(key))) throw new Error('set_end must contain a schedule selector and optional at timestamp.');
    const index = selectedSchedule(schedules, end.schedule), schedule = schedules[index], cutoff = exclusiveCutoff(end.at, now);
    const unbounded = new CompiledRecurrence(withoutEnd(schedule));
    if (cutoff.getTime() <= unbounded.startInstant) throw new Error('The exclusive recurrence end must be after DTSTART; remove the schedule to omit its first occurrence.');
    const last = unbounded.previousBefore(cutoff);
    if (!last) throw new Error('The recurrence end has no preceding occurrence; remove the schedule instead.');
    schedules[index] = withEnd(schedule, last);
  }
  assertRecurrence(schedules);
  assertRecurrenceUpdate(before, schedules, now, coveredOriginals);
  return schedules;
}

export function assertOccurrence(value: unknown): OccurrenceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('occurrence must contain template and original.');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some(k => !['template', 'original', 'timezone'].includes(k)) || typeof o.template !== 'string' || !o.template || typeof o.original !== 'string' || !o.original) throw new Error('Invalid occurrence provenance.');
  if (o.timezone !== undefined && (typeof o.timezone !== 'string' || !o.timezone || schedulingIssues({ scheduled: '2026-01-01T12:00', timezone: o.timezone }).length)) throw new Error('Invalid occurrence timezone.');
  if (o.timezone ? !isOriginalInstant(o.original) : !isCalendarDate(o.original) && !isWallMinute(o.original)) throw new Error('Invalid original occurrence value.');
  return { template: o.template, original: o.original, ...(o.timezone && { timezone: o.timezone as string }) };
}

export function projectedAction(template: Action, identity: OccurrenceIdentity, scheduled: string): Action {
  const { recurrence, occurrence, resolution, timezone, ...fm } = template.frontMatter;
  return { frontMatter: { ...fm, scheduled, ...(identity.timezone && { timezone: identity.timezone }), occurrence: identity }, body: template.body };
}

interface PlanningCursor { now: string; phase: number; clock: string; id: string }
function planningClock(row: PlanningAction): string {
  const fm = row.action.frontMatter;
  const instant = fm.scheduled && fm.timezone ? scheduleInstant(fm.scheduled, fm.timezone) : undefined;
  return instant === undefined ? fm.scheduled ?? fm.created : wallTimeAt(instant);
}
function planningPhase(row: PlanningAction, now: Date): number {
  const fm = row.action.frontMatter;
  if (!fm.scheduled) return 1;
  // Floating and all-day values retain their authored calendar coordinates,
  // including local clocks that happen to lie inside this machine's DST gap.
  const localNow = wallTimeAt(now.getTime());
  const secondFold = !fm.timezone && isWallMinute(fm.scheduled) && now.getTime() - scheduleInstant(localNow)! >= 60000;
  const future = fm.timezone || secondFold ? scheduleInstant(fm.scheduled, fm.timezone)! > now.getTime() : fm.scheduled > localNow;
  return future ? 0 : 2;
}
function comparePlanning(a: Pick<PlanningCursor, 'phase' | 'clock' | 'id'>, b: Pick<PlanningCursor, 'phase' | 'clock' | 'id'>): number {
  if (a.phase !== b.phase) return a.phase - b.phase;
  if (a.clock !== b.clock) return (a.clock < b.clock ? -1 : 1) * (a.phase === 0 ? 1 : -1);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function readPlanningCursor(cursor?: string): PlanningCursor | undefined {
  if (!cursor) return undefined;
  try {
    if (!cursor.startsWith('p1:')) throw new Error();
    const value = JSON.parse(decodeURIComponent(cursor.slice(3)));
    if (!value || !Number.isFinite(Date.parse(value.now)) || ![0, 1, 2].includes(value.phase) || !isSchedulingClock(value.clock) || typeof value.id !== 'string') throw new Error();
    return value;
  } catch { throw new Error('Invalid planning cursor; start a new planning query.'); }
}
function isSchedulingClock(value: unknown): value is string { return typeof value === 'string' && (isCalendarDate(value) || isWallMinute(value)); }
function shiftedWall(wall: string, minutes: number, allDay: boolean): string { return wallString(new Date(wallDate(wall).getTime() + minutes * 60000), allDay); }

export function planningActions(actions: ReadonlyMap<string, Action>, options: { from?: string; to?: string; after?: string; limit?: number; now?: Date; lookaheadDays?: number; templates?: string[]; savedIds?: string[]; projectionsOnly?: boolean } = {}): PlanningPage {
  if (options.from && !isCalendarDate(options.from) || options.to && !isCalendarDate(options.to) || options.from && options.to && options.from > options.to) throw new Error('Planning date bounds must be real dates with from no later than to.');
  const cursor = readPlanningCursor(options.after);
  const now = cursor ? new Date(cursor.now) : options.now ?? new Date(), limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Planning limit must be from 1 to 100.');
  const horizon = new Date(now.getTime() + (options.lookaheadDays ?? 7) * 86400000);
  const horizonDate = shiftedWall(wallTimeAt(now.getTime()).slice(0, 10), (options.lookaheadDays ?? 7) * 1440, true);
  const rows: PlanningAction[] = [], seen = new Set<string>(), issues: string[] = [];
  const history: (() => void)[] = [];
  const wanted = options.templates ? new Set(options.templates) : undefined;
  const key = (row: PlanningAction) => ({ phase: planningPhase(row, now), clock: planningClock(row), id: row.id });
  const eligible = (row: PlanningAction) => (!cursor || comparePlanning(key(row), cursor) > 0) &&
    (!options.from || !row.action.frontMatter.scheduled || row.action.frontMatter.scheduled >= options.from) &&
    (!options.to || !row.action.frontMatter.scheduled || row.action.frontMatter.scheduled.slice(0, 10) <= options.to);
  for (const [id, action] of actions) {
    if (action.frontMatter.occurrence) seen.add(occurrenceKey(action.frontMatter.occurrence));
    const row: PlanningAction = { id, action, projected: false, occurrence: action.frontMatter.occurrence };
    if (!options.projectionsOnly && !action.frontMatter.recurrence && (!options.savedIds || options.savedIds.includes(id)) && eligible(row)) rows.push(row);
  }
  for (const [template, action] of actions) if (action.frontMatter.recurrence && (!wanted || wanted.has(template))) {
    try {
      assertRecurrence(action.frontMatter.recurrence);
      const add = (identity: OccurrenceIdentity, scheduled: string) => {
        const row: PlanningAction = { id: projectionId(identity), action: projectedAction(action, identity, scheduled), projected: true, occurrence: identity };
        if (eligible(row) && !seen.has(occurrenceKey(identity))) {
          seen.add(occurrenceKey(identity)); rows.push(row); return true;
        }
        return false;
      };
      let firstFuture: { identity: OccurrenceIdentity; scheduled: string } | undefined;
      for (const schedule of action.frontMatter.recurrence) {
        const rule = new CompiledRecurrence(schedule), localNow = wallTimeAt(now.getTime(), schedule.timezone);
        const nowWall = rule.allDay ? localNow.slice(0, 10) : localNow;
        const upper = options.to ? rule.allDay ? options.to : options.to + 'T23:59' : rule.allDay ? horizonDate : wallUpperBound(horizon.getTime(), schedule.timezone);
        if (!cursor || cursor.phase === 0) {
          let lower = options.from && options.from > nowWall ? options.from : nowWall;
          if (cursor?.phase === 0) {
            // Calendar coordinates are ordered for floating clocks; a generous
            // date boundary also covers offsets when merging differently zoned rules.
            const coordinate = schedule.timezone ? wallTimeAt(scheduleInstant(cursor.clock)!, schedule.timezone) : cursor.clock;
            const cursorWall = shiftedWall(coordinate, -1440, rule.allDay);
            if (cursorWall > lower) lower = cursorWall;
          }
          let count = 0;
          for (const next of rule.occurrences(template, lower)) {
            const candidate: PlanningAction = { id: projectionId(next.identity), action: projectedAction(action, next.identity, next.scheduled), projected: true, occurrence: next.identity };
            if (planningPhase(candidate, now) !== 0 || seen.has(occurrenceKey(next.identity))) continue;
            if (!options.to && (!firstFuture || planningClock(candidate) < planningClock({ id: '', action: projectedAction(action, firstFuture.identity, firstFuture.scheduled), projected: true }))) firstFuture = next;
            if (next.scheduled > upper || !options.to && !rule.allDay && scheduleInstant(next.scheduled, schedule.timezone)! > horizon.getTime()) break;
            if (add(next.identity, next.scheduled) && ++count > limit) break;
          }
        }
        history.push(() => {
          try {
            // Upcoming work precedes history across all templates. Backwards paging
            // uses the RRULE's original wall coordinate, never an instant round trip.
            const pastBound = rule.allDay ? nowWall : wallUpperBound(now.getTime(), schedule.timezone);
            let before = upper < pastBound ? upper : pastBound;
            if (cursor?.phase === 2) {
              const coordinate = schedule.timezone ? wallTimeAt(scheduleInstant(cursor.clock)!, schedule.timezone) : cursor.clock;
              const cursorWall = shiftedWall(coordinate, 1440, rule.allDay);
              if (cursorWall < before) before = cursorWall;
            }
            let inclusive = true, count = 0;
            while (count <= limit) {
              const previous = rule.previous(template, before, inclusive);
              if (!previous || options.from && previous.scheduled < options.from) break;
              const row: PlanningAction = { id: projectionId(previous.identity), action: projectedAction(action, previous.identity, previous.scheduled), projected: true };
              if (planningPhase(row, now) === 2 && add(previous.identity, previous.scheduled)) count++;
              before = previous.scheduled; inclusive = false;
            }
          } catch (error) { issues.push(`${template}: ${(error as Error).message}`); }
        });
      }
      if (!options.to && firstFuture) add(firstFuture.identity, firstFuture.scheduled);
    } catch (error) { issues.push(`${template}: ${(error as Error).message}`); }
  }
  // A page full of upcoming/backlog work cannot contain history. Delay its
  // backward rank queries until they can contribute a visible row.
  if (rows.filter(row => planningPhase(row, now) < 2).length <= limit) for (const load of history) load();
  rows.sort((a, b) => comparePlanning(key(a), key(b)));
  const nodes = rows.slice(0, limit), last = nodes[nodes.length - 1];
  return { nodes, next: rows.length > limit && last ? 'p1:' + encodeURIComponent(JSON.stringify({ now: now.toISOString(), ...key(last) })) : null, issues };
}

export function recurrenceIssues(actions: ReadonlyMap<string, Action>): string[] {
  const issues: string[] = [], saved = new Map<string, string>();
  for (const [id, action] of actions) {
    const fm: ActionFrontMatter = action.frontMatter;
    if (fm.recurrence && (fm.scheduled || fm.resolution || fm.occurrence)) issues.push(`${id}: a template cannot also be a scheduled, resolved, or materialized action.`);
    if (fm.occurrence) {
      if (!actions.get(fm.occurrence.template)?.frontMatter.recurrence) issues.push(`${id}: missing recurrence template ${fm.occurrence.template}.`);
      const key = occurrenceKey(fm.occurrence);
      if (saved.has(key)) issues.push(`${id}: duplicate occurrence also saved as ${saved.get(key)}.`);
      saved.set(key, id);
    }
  }
  return issues;
}

// Synthetic handles resolve without inserting a record or extending the graph.
export function resolveProjection(actions: ReadonlyMap<string, Action>, id: string): Action | undefined {
  const match = /^~([^@]+)@(.+)$/.exec(id);
  if (!match) return undefined;
  try {
    const templateId = decodeURIComponent(match[1]), original = decodeURIComponent(match[2]);
    const key = occurrenceKey({ template: templateId, original });
    for (const action of actions.values()) if (action.frontMatter.occurrence && occurrenceKey(action.frontMatter.occurrence) === key) return undefined;
    const template = actions.get(templateId);
    if (!template?.frontMatter.recurrence) return undefined;
    assertRecurrence(template.frontMatter.recurrence);
    for (const schedule of template.frontMatter.recurrence) {
      const occurrence = new CompiledRecurrence(schedule).contains(templateId, original);
      if (occurrence) return projectedAction(template, occurrence.identity, occurrence.scheduled);
    }
  } catch {}
  return undefined;
}
