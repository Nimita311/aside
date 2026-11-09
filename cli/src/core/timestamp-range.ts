import { isCalendarDate, isWallMinute } from './scheduling.js';

export interface TimestampRange { start: string; end: string }

// Calendar endpoints include their whole day; clocks retain their instant.
export function rangeBoundary(value: string, end = false): string {
  if (isCalendarDate(value)) return `${value}T${end ? '23:59:59.999' : '00:00:00.000'}`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(value) || !isWallMinute(value.slice(0, 16))) {
    throw new Error('Date range bounds must be calendar dates or local ISO timestamps.');
  }
  const clock = value.length === 16 ? `${value}:00` : value;
  const [seconds, fraction = ''] = clock.split('.');
  return `${seconds}.${fraction.padEnd(3, '0')}`;
}

export function withinTimestampRange(id: string, range?: TimestampRange): boolean {
  return !range || rangeBoundary(id) >= rangeBoundary(range.start) && rangeBoundary(id) <= rangeBoundary(range.end, true);
}
