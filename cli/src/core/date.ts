// Shared date helpers for the weekly-file layout (Monday–Sunday) and ISO 8601
// minute-precision timestamps. The local variants read the runtime's clock;
// the UTC variant formats wall-clock arithmetic carried out on UTC fields.

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad4 = (n: number): string => String(n).padStart(4, '0');

export function formatDate(d: Date): string {
  return `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ISO 8601 with minute precision: `YYYY-MM-DDTHH:MM`.
export function formatTimestamp(d: Date): string {
  return `${formatDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// The same shape from the date's UTC fields — for wall-clock strings moved
// through UTC arithmetic, where the zone is reapplied downstream.
export function formatUtcTimestamp(d: Date): string {
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

// Monday of the week containing `d`.
export function getMonday(d: Date): Date {
  const result = new Date(d);
  const day = result.getDay();
  const diff = result.getDate() - day + (day === 0 ? -6 : 1);
  result.setDate(diff);
  return result;
}

// Sunday of the week containing `d`.
export function getSunday(d: Date): Date {
  const monday = getMonday(d);
  const result = new Date(monday);
  result.setDate(result.getDate() + 6);
  return result;
}

// ISO week number for `d`.
export function getWeekNumber(d: Date): number {
  const target = new Date(d.valueOf());
  // Compare Thursdays at midnight: a time-of-day would tip the rounding below
  // in years whose Jan 4 is not a Thursday.
  target.setHours(0, 0, 0, 0);
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 60 * 60 * 1000));
}
