import { createHash } from 'node:crypto';
import { assertRecurrence, CompiledRecurrence, type RecurrenceSchedule } from '../../core/recurrence.js';
import { scheduleInstant, wallTimeAt } from '../../core/scheduling.js';
import type { NativeRecurrenceRule } from './protocol.js';

export interface NativeSeries { key: string; schedule: RecurrenceSchedule; rule: NativeRecurrenceRule }
const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// Only pass fields EventKit preserves. A rejected translation leaves Aside's
// complete RRULE untouched and is surfaced in calendar_info.
export function nativeSeries(schedule: RecurrenceSchedule): NativeSeries[] {
  assertRecurrence([schedule]);
  const parts: Record<string, string> = Object.fromEntries(schedule.rrule.replace(/^RRULE:/, '').split(';').map(p => p.split('=')));
  let frequency = parts.FREQ.toLowerCase(), interval = Number(parts.INTERVAL ?? 1);
  const dailyWeekdays = frequency === 'daily' && interval === 1 && parts.BYDAY && !/\d/.test(parts.BYDAY) && !parts.COUNT;
  if (dailyWeekdays) frequency = 'weekly';
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) throw new Error(`EventKit cannot represent ${parts.FREQ} natively.`);
  if (parts.WKST && parts.WKST !== 'MO' && (frequency === 'weekly' && interval > 1 || parts.BYWEEKNO)) throw new Error('EventKit cannot preserve this WKST.');
  const allowed: Record<string, string[]> = { BYDAY: ['weekly', 'monthly', 'yearly'], BYMONTHDAY: ['monthly'], BYMONTH: ['yearly'], BYWEEKNO: ['yearly'], BYYEARDAY: ['yearly'] };
  for (const [field, frequencies] of Object.entries(allowed)) if (parts[field] && !frequencies.includes(frequency)) throw new Error(`EventKit ignores ${field} with ${parts.FREQ}.`);
  if (parts.BYMONTHDAY && parts.BYDAY) throw new Error('EventKit cannot preserve the intersection of BYDAY and BYMONTHDAY.');
  if (parts.BYSETPOS && !Object.keys(allowed).some(k => parts[k])) throw new Error('EventKit ignores BYSETPOS without a day/month filter.');
  const hours = parts.BYHOUR?.split(',') ?? [schedule.dtstart.slice(11, 13)];
  const minutes = parts.BYMINUTE?.split(',') ?? [schedule.dtstart.slice(14, 16)];
  if (hours.length * minutes.length > 32 || hours.length * minutes.length > 1 && (parts.COUNT || parts.BYSETPOS)) throw new Error('This time-of-day expansion cannot be split into exact native series.');
  const result: NativeSeries[] = [];
  for (const hour of hours) for (const minute of minutes) {
    const dtstart = schedule.dtstart.length === 10 ? schedule.dtstart : `${schedule.dtstart.slice(0, 11)}${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    // Earlier phases begin with their first occurrence at/after the authored anchor.
    const phaseParts = { ...parts, ...(parts.BYHOUR && { BYHOUR: hour }), ...(parts.BYMINUTE && { BYMINUTE: minute }) };
    const phase = { ...schedule, rrule: Object.entries(phaseParts).map(([k,v]) => `${k}=${v}`).join(';') };
    const next = new CompiledRecurrence(phase).occurrences('', schedule.dtstart).next().value;
    if (!next) continue;
    const anchor = dtstart.length === 10 ? next.scheduled : next.scheduled;
    if (!schedule.timezone && anchor.includes('T') && wallTimeAt(scheduleInstant(anchor)!) !== anchor) throw new Error('EventKit cannot preserve a floating recurrence anchor inside a local daylight-saving gap.');
    const rule: NativeRecurrenceRule = { frequency: frequency as NativeRecurrenceRule['frequency'], interval };
    // A translated daily period has one clock. Its valid BYSETPOS cannot be
    // carried to the whole week, where it would discard authored weekdays.
    for (const [source, target] of [['BYMONTHDAY', 'monthDays'], ['BYMONTH', 'months'], ['BYWEEKNO', 'weeks'], ['BYYEARDAY', 'yearDays'], ['BYSETPOS', 'positions']] as const) if (parts[source] && !(dailyWeekdays && source === 'BYSETPOS')) rule[target] = parts[source].split(',').map(Number);
    if (parts.BYDAY) rule.days = parts.BYDAY.split(',').map(day => { const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(day)!; return { day: weekdays.indexOf(match[2]) + 1, week: Number(match[1] ?? 0) }; });
    if (parts.COUNT) rule.count = Number(parts.COUNT);
    if (parts.UNTIL) rule.until = new CompiledRecurrence(schedule).lastInstant();
    const key = createHash('sha256').update(JSON.stringify([anchor, schedule.timezone ?? null])).digest('hex').slice(0, 16);
    result.push({ key, schedule: { ...phase, dtstart: anchor }, rule });
  }
  return result;
}
