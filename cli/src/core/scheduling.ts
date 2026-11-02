import { formatTimestamp } from './date.js';

// Action schedules are Gregorian wall times, optionally qualified by a named zone.
// Capture, updates, validation, and calendar sync share the same contract.
export interface SchedulingFields {
  scheduled?: string;
  deadline?: string;
  timezone?: string;
  duration?: string;
}

// The event length an action without `duration` gets (design/calendar.md).
export const DEFAULT_DURATION_MIN = 30;

export function isSchedulingDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    (h === undefined || (Number(h) <= 23 && Number(mi) <= 59));
}

// A real calendar date alone, `YYYY-MM-DD` — query bounds, CLI date options,
// entry-id dates, and artifact-id date codes.
export function isCalendarDate(value: string): boolean {
  return value.length === 10 && isSchedulingDate(value);
}

// A real wall time at minute precision, `YYYY-MM-DDTHH:MM` — created
// timestamps and a project's `ended`.
export function isWallMinute(value: string): boolean {
  return value.length === 16 && isSchedulingDate(value);
}

// Fixed ISO durations only: days, hours, minutes, seconds. Calendar-relative
// years/months and sub-minute results cannot be represented by event wall times.
export function parseDurationMinutes(value: string): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value);
  if (!m || !m.slice(1).some(v => v !== undefined) || /T$/i.test(value)) return undefined;
  const minutes = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60;
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : undefined;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(ms: number, zone: string): Record<string, string> {
  let formatter = zoneFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    zoneFormatters.set(zone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value]));
}

// An instant's wall time; omitted zone means the runtime's local zone. This
// never changes a stored timestamp: browser conversion is presentation only.
export function wallTimeAt(ms: number, zone?: string): string {
  if (!zone) return formatTimestamp(new Date(ms));
  const parts = zoneParts(ms, zone);
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// Named wall times resolve to the first occurrence of a repeated hour, as in
// EventKit. Named-zone gaps have no instant and never fall back to local time.
// Floating clocks use normal local Date normalization, including DST gaps; a
// successful Calendar round trip can then canonicalize the stored clock.
// Date-only schedules ignore the zone and remain local calendar dates.
export function scheduleInstant(wall: string, zone?: string): number | undefined {
  if (!isSchedulingDate(wall)) return undefined;
  if (wall.length === 10 || !zone) {
    const [y, mo, day, h = 0, mi = 0] = wall.split(/[-T:]/).map(Number);
    const d = new Date(0);
    d.setFullYear(y, mo - 1, day);
    d.setHours(h, mi, 0, 0);
    return d.getTime();
  }
  return namedInstants(wall, zone)[0];
}

function namedInstants(wall: string, zone: string): number[] {
  const naive = new Date(wall + ':00Z').getTime();
  const candidates = new Set<number>();
  try {
    for (const hours of [-36, 0, 36]) {
      const probe = naive + hours * 3600000;
      const parts = zoneParts(probe, zone);
      const offset = new Date(`${wallTimeAt(probe, zone)}:${parts.second}Z`).getTime() - probe;
      const candidate = naive - offset;
      if (wallTimeAt(candidate, zone) === wall) candidates.add(candidate);
    }
  } catch { return []; }
  return [...candidates].sort((a, b) => a - b);
}

export function isRepeatedSchedule(wall: string, zone?: string): boolean {
  if (!isSchedulingDate(wall) || wall.length === 10) return false;
  return namedInstants(wall, zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone).length > 1;
}

export function schedulingIssues(fields: SchedulingFields): string[] {
  const issues: string[] = [];
  for (const field of ['scheduled', 'deadline'] as const) {
    const value = fields[field];
    if (value !== undefined && !isSchedulingDate(value)) {
      issues.push(`${field}: "${value}" must be a real date YYYY-MM-DD or local time YYYY-MM-DDTHH:mm (00:00–23:59).`);
    }
  }
  if (fields.timezone !== undefined) {
    let valid = !!fields.timezone && !/^[+-]/.test(fields.timezone);
    try { new Intl.DateTimeFormat('en', { timeZone: fields.timezone }); } catch { valid = false; }
    if (valid && fields.scheduled?.includes('T') && isSchedulingDate(fields.scheduled) && scheduleInstant(fields.scheduled, fields.timezone) === undefined) {
      issues.push(`scheduled: "${fields.scheduled}" does not exist in ${fields.timezone} because of a time-zone clock transition.`);
    }
    if (!valid) issues.push(`timezone: "${fields.timezone}" must be a recognized IANA time zone, such as Asia/Tokyo.`);
  }
  if (fields.duration !== undefined && parseDurationMinutes(fields.duration) === undefined) {
    issues.push(`duration: "${fields.duration}" must be a positive fixed ISO duration in whole minutes (e.g. PT30M, PT1H30M, P1D). Days are 24 elapsed hours; years, months, weeks, and sub-minute lengths are unsupported.`);
  }
  if (fields.scheduled?.includes('T') && isSchedulingDate(fields.scheduled)) {
    const length = fields.duration === undefined ? DEFAULT_DURATION_MIN : parseDurationMinutes(fields.duration);
    if (length !== undefined) {
      const end = new Date(new Date(fields.scheduled + ':00Z').getTime() + length * 60000);
      if (!Number.isFinite(end.getTime()) || end.getUTCFullYear() > 9999) issues.push('duration: event end exceeds the supported year range 0001–9999.');
    }
  }
  return issues;
}

export function assertScheduling(fields: SchedulingFields): void {
  const issues = schedulingIssues(fields);
  if (issues.length) throw new Error(`Invalid action scheduling.\n${issues.join('\n')}\nCorrect these fields and retry; no records were changed.`);
}
