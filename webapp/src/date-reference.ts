import { isCalendarDate, scheduleInstant, wallTimeAt } from '../../cli/src/core/scheduling';

export interface DateReference {
  start: string;
  end?: string;
}

interface DateValue {
  kind: 'date' | 'local' | 'instant';
  wall: string;
  instant?: number;
}

// A deliberately small ISO 8601 subset: extended calendar dates, clocks to
// minutes or seconds (up to millisecond precision), Z or numeric offsets,
// and Temporal-style bracketed IANA time zones with an optional offset.
function parseDateValue(value: string): DateValue | null {
  if (isCalendarDate(value)) return { kind: 'date', wall: value };
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?(?:\[([A-Za-z._][A-Za-z0-9._+-]*(?:\/[A-Za-z._][A-Za-z0-9._+-]*)*)\])?$/.exec(value);
  if (!match || !isCalendarDate(match[1])) return null;
  const offset = match[6];
  // Unknown local offset -00:00 is outside the supported ISO offset subset.
  if (offset === '-00:00') return null;
  const timezone = match[7];
  const wall = `${match[1]}T${match[2]}:${match[3]}${match[4] ? `:${match[4]}${match[5] ?? ''}` : ''}`;
  let zoneClock: Intl.DateTimeFormat | undefined;
  if (timezone) {
    if (timezone.split('/').some(part => part === '.' || part === '..')) return null;
    try { zoneClock = new Intl.DateTimeFormat('en', { timeZone: timezone, second: '2-digit' }); } catch { return null; }
  }
  if (!offset && !timezone) return { kind: 'local', wall };
  let instant: number | undefined;
  if (offset) {
    instant = Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}${offset}`);
    // Numeric offsets must agree with the named zone. Z denotes an exact UTC
    // time whose named-zone annotation supplies context, not a local clock.
    if (timezone && offset !== 'Z') {
      const second = zoneClock!.formatToParts(instant).find(part => part.type === 'second')!.value;
      if (wallTimeAt(instant, timezone) !== wall.slice(0, 16) || Number(second) !== Number(match[4] ?? 0)) return null;
    }
  } else {
    // Use Aside's existing named-clock contract: first occurrence of repeated
    // clocks; nonexistent clocks stay literal. Preserve seconds and fractions.
    const minute = scheduleInstant(wall.slice(0, 16), timezone);
    if (minute === undefined) return null;
    instant = minute + Number(match[4] ?? 0) * 1000 + Math.round(Number(match[5] ?? 0) * 1000);
  }
  if (!Number.isFinite(instant)) return null;
  // Converted values must still fit the calendar and route's four-digit years.
  const localYear = new Date(instant!).getFullYear();
  if (localYear < 1 || localYear > 9999) return null;
  return { kind: 'instant', wall, instant };
}

export function dateHandle(ref: DateReference): string {
  return `#date/${ref.start}${ref.end === undefined ? '' : `/${ref.end}`}`;
}

export function parseDateHandle(handle: string): DateReference | null {
  if (!handle.startsWith('#date/')) return null;
  // Zone names also contain slashes; only slashes outside brackets divide
  // interval endpoints. Unbalanced or nested brackets invalidate the handle.
  const value = handle.slice(6);
  const bounds: string[] = [];
  let bracket = false, startIndex = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '[') {
      if (bracket) return null;
      bracket = true;
    } else if (value[index] === ']') {
      if (!bracket) return null;
      bracket = false;
    } else if (value[index] === '/' && !bracket) {
      bounds.push(value.slice(startIndex, index));
      startIndex = index + 1;
    }
  }
  if (bracket) return null;
  bounds.push(value.slice(startIndex));
  if (bounds.length < 1 || bounds.length > 2) return null;
  const [start, end] = bounds;
  const first = parseDateValue(start);
  if (!first) return null;
  if (end !== undefined) {
    const last = parseDateValue(end);
    if (!last || last.kind !== first.kind) return null;
    const orderValue = (value: DateValue) => value.instant ?? Date.parse(`${value.wall.length === 16 ? `${value.wall}:00` : value.wall}${value.kind === 'date' ? 'T00:00:00' : ''}Z`);
    if (orderValue(last) < orderValue(first)) return null;
  }
  return { start, ...(end === undefined ? {} : { end }) };
}

// Validate complete tokens so malformed values never render as partial dates.
const INLINE = /(?<![\p{L}\p{N}\p{M}_/\\])#date\/[^\s<>(){}"'`]+/gu;
export function dateMentions(text: string): { ref: DateReference; index: number; length: number }[] {
  const mentions: { ref: DateReference; index: number; length: number }[] = [];
  for (const match of text.matchAll(INLINE)) {
    const handle = match[0].replace(/[.,;:!?]+$/g, '');
    const ref = parseDateHandle(handle);
    if (ref) mentions.push({ ref, index: match.index, length: handle.length });
  }
  return mentions;
}

// Floating dates/clocks stay authored. Offset timestamps convert to the
// browser zone for display and navigation without changing their saved value.
export function localDateStamp(value: string): string {
  const parsed = parseDateValue(value);
  if (parsed?.instant === undefined) return value;
  const date = new Date(parsed.instant);
  const seconds = parsed.wall.length > 16 ? `:${String(date.getSeconds()).padStart(2, '0')}${parsed.wall.slice(19)}` : '';
  return `${wallTimeAt(parsed.instant)}${seconds}`;
}

// HTML's datetime attribute has no bracketed-zone syntax. Named-zone values
// carry their exact UTC instant here; the authored handle remains on the chip.
export function dateTimeAttribute(value: string): string {
  if (!value.includes('[')) return value;
  const instant = parseDateValue(value)?.instant;
  return instant === undefined ? value : new Date(instant).toISOString();
}
