import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getMondayOfWeek } from '../lib/types';
import { parseLooseDate, shiftDate, shiftByUnit } from '../src/dates';

// Pin a UTC+ timezone: formatting via toISOString() (UTC) would shift local
// midnight back a day, so these tests fail if the formatting is not local.
process.env.TZ = 'Asia/Tokyo';

describe('getMondayOfWeek', () => {
  it('formats from local date parts, not UTC', () => {
    // Local midnight on a Monday is the previous day in UTC.
    expect(getMondayOfWeek(new Date('2026-06-29T00:00:00'))).toBe('2026-06-29');
  });

  it('maps each weekday to its Monday', () => {
    expect(getMondayOfWeek(new Date('2026-07-01T12:00:00'))).toBe('2026-06-29'); // Wednesday
    expect(getMondayOfWeek(new Date('2026-07-05T09:30:00'))).toBe('2026-06-29'); // Sunday
    expect(getMondayOfWeek(new Date('2026-07-06T00:00:00'))).toBe('2026-07-06'); // next Monday
  });
});

describe('parseLooseDate', () => {
  // Year inference reads the clock — pin "today" to Jul 7, 2026.
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T12:00:00'));
  });
  afterAll(() => vi.useRealTimers());

  it('accepts year-first numeric forms', () => {
    expect(parseLooseDate('2026-05-31')).toBe('2026-05-31');
    expect(parseLooseDate('2026/5/3')).toBe('2026-05-03');
    expect(parseLooseDate('2023 3 12')).toBe('2023-03-12');
    expect(parseLooseDate('2026-05')).toBe('2026-05-01');
  });

  it('accepts US month-first forms, with 2-digit years', () => {
    expect(parseLooseDate('5/31/2026')).toBe('2026-05-31');
    expect(parseLooseDate('5/31/26')).toBe('2026-05-31');
    expect(parseLooseDate('5.31.99')).toBe('1999-05-31');
  });

  it('accepts spelled-out dates in any token order', () => {
    expect(parseLooseDate('May 31 2026')).toBe('2026-05-31');
    expect(parseLooseDate('31 May, 2026')).toBe('2026-05-31');
    expect(parseLooseDate('Sept 2024')).toBe('2024-09-01');
    expect(parseLooseDate('15th March 2026')).toBe('2026-03-15');
  });

  it('infers the year as the most recent occurrence', () => {
    expect(parseLooseDate('7/7')).toBe('2026-07-07');    // today → this year
    expect(parseLooseDate('7/8')).toBe('2025-07-08');    // tomorrow's day → last year
    expect(parseLooseDate('jul 20')).toBe('2025-07-20');
    expect(parseLooseDate('March')).toBe('2026-03-01');
    expect(parseLooseDate('3')).toBe('2026-03-01');      // bare month number
    expect(parseLooseDate('12')).toBe('2025-12-01');
  });

  it('jumps a bare year to its start', () => {
    expect(parseLooseDate('2024')).toBe('2024-01-01');
  });

  it('rejects nonexistent dates and non-dates', () => {
    expect(parseLooseDate('2026-02-30')).toBeNull();
    expect(parseLooseDate('Feb 31 2026')).toBeNull();
    expect(parseLooseDate('13')).toBeNull(); // no 13th month
    expect(parseLooseDate('septic 2024')).toBeNull();
    expect(parseLooseDate('')).toBeNull();
  });
});

describe('shiftDate', () => {
  it('clamps a month shift to the target month end', () => {
    expect(shiftDate('2026-05-31', -1, 0)).toBe('2026-04-30');
    expect(shiftDate('2026-01-31', 1, 0)).toBe('2026-02-28');
  });

  it('shifts by days across month boundaries', () => {
    expect(shiftDate('2026-05-31', 0, 7)).toBe('2026-06-07');
    expect(shiftDate('2026-01-03', 0, -7)).toBe('2025-12-27');
  });
});

describe('shiftByUnit', () => {
  it('steps a week in days and months/quarters in months', () => {
    expect(shiftByUnit('2026-07-07', 'week', -1)).toBe('2026-06-30');
    expect(shiftByUnit('2026-05-31', 'month', -1)).toBe('2026-04-30');
    expect(shiftByUnit('2026-05-31', 'quarter', 1)).toBe('2026-08-31');
  });
});
