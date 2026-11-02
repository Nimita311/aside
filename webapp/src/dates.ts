import { toDateStr } from '../lib/types';

// Date parsing and calendar arithmetic behind the jump-to-date control, kept
// DOM-free so it can be unit-tested (dates.test.ts). All arithmetic is local
// time — matching the marker/latch date format — so nothing drifts a day
// across a timezone.

export const CAL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// A calendar date as YYYY-MM-DD, or null if it doesn't exist (rejects overflow
// like Feb 31, which the Date constructor would silently roll into March).
function validDate(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return toDateStr(dt);
}

// The year to assume for a month/day given without one: this year if that date
// is today or already past, else last year — it reads as the most recent
// occurrence, matching the timeline's look-backward bias. A bare month uses
// day 1, so the current month still resolves to this year.
function inferYear(month: number, day: number): number {
  const now = new Date();
  const cm = now.getMonth() + 1;
  const passed = month < cm || (month === cm && day <= now.getDate());
  return passed ? now.getFullYear() : now.getFullYear() - 1;
}

// The 1-based month a token names — a month whose full name it begins (≥3
// letters), so "sep"/"sept"/"september" match but "septic" or "junk" don't. 0
// if none. Three-letter prefixes are unique across the months.
function monthFromName(tok: string): number {
  const k = tok.toLowerCase();
  if (k.length < 3) return 0;
  return CAL_MONTHS.findIndex((n) => n.toLowerCase().startsWith(k)) + 1;
}

// Parse a spelled-out date in any token order — "May 31 2026", "31 May",
// "Sept 2024", "March" — inferring the year when absent. Null if no month name.
function parseNamedDate(s: string): string | null {
  let month = 0, day = 0, year = 0;
  for (const raw of s.replace(/,/g, ' ').trim().split(/\s+/)) {
    const tok = raw.replace(/(\d+)(st|nd|rd|th)$/i, '$1'); // drop 15th → 15
    const mn = monthFromName(tok);
    if (mn && !month) month = mn;
    else if (/^\d{4}$/.test(tok)) year = +tok;
    else if (/^\d{1,2}$/.test(tok) && !day) day = +tok;
    else return null; // an unrecognized token means this isn't a plain date
  }
  if (!month) return null;
  return validDate(year || inferYear(month, day || 1), month, day || 1);
}

// A 2-digit year to a 4-digit one, POSIX pivot: 00–68 → 2000s, 69–99 → 1900s.
function fullYear(yy: number): number {
  return yy < 69 ? 2000 + yy : 1900 + yy;
}

// Parse a loosely-typed date to YYYY-MM-DD, or null. Accepts year-first
// (2026-05-31, 2026/5/3, 2023 3 12), US month-first (5/31/2026, 5/31/26), a
// bare year (2026 → its Jan 1), spelled-out names in any order, and year-less
// forms (5/31, "March", "3") whose year is inferred from the date. Numeric
// parts may be split by -, /, ., or spaces.
export function parseLooseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.\s]+(\d{1,2})(?:[-/.\s]+(\d{1,2}))?$/);
  if (m) return validDate(+m[1], +m[2], m[3] ? +m[3] : 1);
  m = s.match(/^(\d{1,2})[-/.\s]+(\d{1,2})[-/.\s]+(\d{2}|\d{4})$/);
  if (m) return validDate(m[3].length === 2 ? fullYear(+m[3]) : +m[3], +m[1], +m[2]);
  // Year-less numeric month/day (5/31) — infer the year from the date.
  m = s.match(/^(\d{1,2})[-/.\s]+(\d{1,2})$/);
  if (m) return validDate(inferYear(+m[1], +m[2]), +m[1], +m[2]);
  const named = parseNamedDate(s);
  if (named) return named;
  // A bare year jumps to its start.
  m = s.match(/^(\d{4})$/);
  if (m) return validDate(+m[1], 1, 1);
  // Bare month number (1–12) → the first of that month, year inferred.
  m = s.match(/^(\d{1,2})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return validDate(inferYear(+m[1], 1), +m[1], 1);
  return null;
}

// Shift a YYYY-MM-DD by whole months then days. The day is clamped to the
// target month's length so a month-end date lands on the month end, not spilled
// into the next month (May 31 − 1 month is April 30, not May 1).
export function shiftDate(dateStr: string, months: number, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  if (months) {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

// The period the quick navigator steps by.
export type JumpUnit = 'week' | 'month' | 'quarter';
export const JUMP_UNITS: { key: JumpUnit; label: string; months: number; days: number }[] = [
  { key: 'week', label: 'Week', months: 0, days: 7 },
  { key: 'month', label: 'Month', months: 1, days: 0 },
  { key: 'quarter', label: 'Quarter', months: 3, days: 0 },
];

// Shift a date by one period in `dir` (+1 newer / −1 older).
export function shiftByUnit(dateStr: string, unit: JumpUnit, dir: number): string {
  const u = JUMP_UNITS.find((j) => j.key === unit)!;
  return shiftDate(dateStr, u.months * dir, u.days * dir);
}

// The first of a date's month. Stepping from here never overflows a short
// month (April has no 31st, so "May 31 − 1 month" must not roll forward).
export function monthStart(dateStr: string): Date {
  const d = new Date(dateStr + 'T00:00:00');
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
