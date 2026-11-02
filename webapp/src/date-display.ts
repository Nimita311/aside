import type { DateTimePreferences, DisplayStyle, TimeFormat } from './preferences';
import { localDateStamp } from './date-reference';

export type DateTimeFormat = TimeFormat | DateTimePreferences;
type ZoneClock = { instant: number; timeZone?: string };
const formatters = new Map<string, Intl.DateTimeFormat>();
const columnWidths = new Map<string, Map<string, number>>();

function locale(): string[] | undefined {
  return typeof navigator === 'undefined' || !navigator.languages.length ? undefined : [...navigator.languages];
}

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locales = locale();
  const settings = { calendar: 'gregory', ...options };
  // Default-zone formatters stay fresh if the device timezone changes.
  if (!settings.timeZone) return new Intl.DateTimeFormat(locales, settings);
  const key = JSON.stringify([locales, settings]);
  let result = formatters.get(key);
  if (!result) {
    if (formatters.size >= 128) formatters.clear();
    result = new Intl.DateTimeFormat(locales, settings);
    formatters.set(key, result);
  }
  return result;
}

// Format calendar fields in UTC so date-only values and floating clocks never
// shift a day or normalize across a daylight-saving gap. UTC is only a carrier;
// visible zone names come from the browser clock (or the authored schedule).
function calendarDate(stamp: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(stamp);
  if (!match) return new Date(NaN);
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
  if (!year || hour > 23 || minute > 59 || second > 59) return new Date(NaN);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return new Date(NaN);
  return date;
}

function preferences(value: DateTimeFormat): DateTimePreferences {
  return typeof value === 'string' ? { timeFormat: value } : value;
}

function clockOptions(clock: TimeFormat): Intl.DateTimeFormatOptions {
  return clock === 'locale' ? {} : clock === '24h' ? { hourCycle: 'h23' } : { hour12: true };
}

export function clockSelection(clock: TimeFormat): '12h' | '24h' {
  if (clock !== 'locale') return clock;
  return formatter({ hour: 'numeric', timeZone: 'UTC' }).resolvedOptions().hour12 ? '12h' : '24h';
}

function displayStamp(stamp: string): string | undefined {
  if (isNaN(calendarDate(stamp).getTime())) return undefined;
  const local = localDateStamp(stamp);
  // Failed conversions (including unsupported offsets and out-of-range
  // local years) must not masquerade as floating browser clocks.
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(stamp) && local === stamp) return undefined;
  return local;
}

function formatted(stamp: string, options: Intl.DateTimeFormatOptions, zone?: ZoneClock): string {
  const localStamp = displayStamp(stamp);
  if (localStamp === undefined) return stamp;
  if (localStamp !== stamp) zone ??= { instant: Date.parse(stamp) };
  stamp = localStamp;
  const carrier = calendarDate(stamp);
  const parts = formatter({ ...options, timeZone: 'UTC' }).formatToParts(carrier);
  if (parts.some(part => part.type === 'timeZoneName')) {
    const local = new Date(stamp.slice(0, 19));
    const style = options.timeStyle === 'full' ? 'long' : 'short';
    const zoneParts = formatter({
      timeZoneName: style, ...(zone ? { timeZone: zone.timeZone } : {}),
    }).formatToParts(zone ? new Date(zone.instant) : local);
    const name = zoneParts.find(part => part.type === 'timeZoneName')?.value ?? '';
    for (const part of parts) if (part.type === 'timeZoneName') part.value = name;
  }
  // Use ordinary spaces in generated labels, keeping search/copy predictable.
  return parts.map(part => part.value).join('').replace(/[\u00a0\u202f]/g, ' ');
}

export function formatDate(stamp: string, style: DateTimePreferences['dateFormat'] = 'medium'): string {
  if (style === 'iso') {
    return displayStamp(stamp)?.slice(0, 10) ?? stamp;
  }
  return formatted(stamp, { dateStyle: style });
}

export function formatClock(stamp: string, value: DateTimeFormat, style?: DisplayStyle, zone?: ZoneClock): string {
  if (stamp.length <= 10) return '';
  const prefs = preferences(value);
  return formatted(stamp, { timeStyle: style ?? prefs.timeStyle ?? 'short', ...clockOptions(prefs.timeFormat) }, zone);
}

// Clock-only labels use the same time style as complete timestamps.
export function formatTime(stamp: string, value: DateTimeFormat): string {
  return formatClock(stamp, value);
}

export function formatStamp(stamp: string, value: DateTimeFormat, zone?: ZoneClock): string {
  if (displayStamp(stamp) === undefined) return stamp;
  const prefs = preferences(value);
  const dateStyle = prefs.dateFormat ?? 'medium';
  if (stamp.length <= 10) return formatDate(stamp, dateStyle);
  if (dateStyle === 'iso') return `${formatDate(stamp, 'iso')} ${formatClock(stamp, prefs, undefined, zone)}`;
  return formatted(stamp, { dateStyle, timeStyle: prefs.timeStyle ?? 'short', ...clockOptions(prefs.timeFormat) }, zone);
}

export function calendarLabel(stamp: string, options: Intl.DateTimeFormatOptions): string {
  return formatted(stamp, { calendar: 'gregory', ...options });
}

export function formatMonth(stamp: string, prefs: DateTimePreferences): string {
  if (prefs.dateFormat === 'iso') return stamp.slice(0, 7);
  const style = prefs.dateFormat ?? 'medium';
  const parts = dateParts(stamp, style);
  const year = parts.find(part => part.type === 'year')?.value ?? '';
  const month = parts.find(part => part.type === 'month')?.value ?? '';
  return calendarLabel(stamp, {
    year: style === 'short' && year.length === 2 ? '2-digit' : 'numeric',
    month: /^\p{N}+$/u.test(month) ? month.length === 2 ? '2-digit' : 'numeric' : style === 'medium' ? 'short' : 'long',
  });
}

export interface DateColumn { key: string; type: string; value: string; width: number }

function dateParts(stamp: string, style: DateTimePreferences['dateFormat']): Intl.DateTimeFormatPart[] {
  if (style === 'iso') return [
    { type: 'year', value: stamp.slice(0, 4) }, { type: 'literal', value: '-' },
    { type: 'month', value: stamp.slice(5, 7) }, { type: 'literal', value: '-' },
    { type: 'day', value: stamp.slice(8, 10) },
  ];
  return formatter({ dateStyle: style ?? 'medium', timeZone: 'UTC' }).formatToParts(calendarDate(stamp));
}

// Stable column widths let partial day markers align with the full readout,
// while preserving the chosen style's names, padding, ordering and separators.
export function dateColumns(stamp: string, prefs: DateTimePreferences): DateColumn[] {
  const style = prefs.dateFormat ?? 'medium';
  const cacheKey = JSON.stringify([locale(), style]);
  let widths = columnWidths.get(cacheKey);
  if (!widths) {
    widths = new Map();
    const samples = [
      ...Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-25`),
      ...Array.from({ length: 7 }, (_, i) => `2026-10-${12 + i}`),
    ];
    for (const sample of samples) for (const [index, part] of dateParts(sample, style).entries()) {
      const key = part.type === 'literal' ? `literal-${index}` : part.type;
      const width = Array.from(part.value).reduce((sum, char) => sum + (/[^\u0000-\u2e7f]/.test(char) ? 2 : 1), 0);
      widths.set(key, Math.max(widths.get(key) ?? 0, width));
    }
    if (columnWidths.size >= 32) columnWidths.clear();
    columnWidths.set(cacheKey, widths);
  }
  return dateParts(stamp, style).map((part, index) => {
    const key = part.type === 'literal' ? `literal-${index}` : part.type;
    return { key, type: part.type, value: part.value.replace(/[\u00a0\u202f]/g, ' '), width: widths!.get(key) ?? part.value.length };
  });
}
