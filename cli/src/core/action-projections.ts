import { assertRecurrence, CompiledRecurrence, occurrenceKey, projectedAction, projectionId } from './recurrence.js';
import { isCalendarDate, isWallMinute, scheduleInstant, wallTimeAt } from './scheduling.js';
import type { Action } from './types.js';

export interface ActionProjection { id: string; action: Action }

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// Expand only the configured future window. Saved records always remain in the
// caller's collection, including templates and occurrences moved out of range.
export function futureActionProjections(actions: ReadonlyMap<string, Action>, options: {
  now: Date; lookaheadDays?: number; limit?: number;
}): { nodes: ActionProjection[]; issues: string[] } {
  const nodes: ActionProjection[] = [], issues: string[] = [];
  const days = options.lookaheadDays ?? 7, limit = options.limit ?? 100_000;
  const now = options.now.getTime(), horizon = now + days * 86_400_000;
  if (!Number.isFinite(now) || !Number.isSafeInteger(days) || days < 0 || !Number.isFinite(new Date(horizon).getTime())) {
    return { nodes, issues: ['The recurrence lookahead window is outside the supported date range.'] };
  }
  const nowWall = wallTimeAt(now), horizonWall = wallTimeAt(horizon);
  if (!isWallMinute(nowWall) || !isWallMinute(horizonWall)) {
    return { nodes, issues: ['The recurrence lookahead window exceeds the supported years 0001–9999.'] };
  }
  const today = nowWall.slice(0, 10), lastDate = shiftDate(today, days);
  if (!isCalendarDate(lastDate)) return { nodes, issues: ['The recurrence lookahead window exceeds the supported years 0001–9999.'] };
  const seen = new Set<string>();
  for (const action of actions.values()) {
    if (action.frontMatter.occurrence) seen.add(occurrenceKey(action.frontMatter.occurrence));
  }
  let examined = 0;
  templates: for (const [template, action] of actions) {
    if (!action.frontMatter.recurrence) continue;
    try {
      const schedules = assertRecurrence(action.frontMatter.recurrence);
      for (const schedule of schedules) {
        const rule = new CompiledRecurrence(schedule);
        if (!rule.allDay && days === 0) continue;
        // Broad wall-date bounds cover repeated hours and floating clocks that
        // normalize across DST gaps; timed candidates are checked as instants.
        const zoneNow = wallTimeAt(now, schedule.timezone), zoneHorizon = wallTimeAt(horizon, schedule.timezone);
        if (!isWallMinute(zoneNow) || !isWallMinute(zoneHorizon)) throw new Error('The recurrence lookahead window exceeds the supported years 0001–9999 in this schedule’s timezone.');
        const lower = shiftDate(zoneNow.slice(0, 10), -1), upper = shiftDate(zoneHorizon.slice(0, 10), 1);
        const from = rule.allDay ? today : isCalendarDate(lower) ? lower : '0001-01-01';
        const to = rule.allDay ? lastDate : isCalendarDate(upper) ? upper : '9999-12-31';
        for (const next of rule.occurrences(template, from, to)) {
          if (++examined > limit) {
            issues.push(`Recurrence expansion exceeds ${limit} occurrences; reduce recurrenceLookaheadDays or recurrence frequency.`);
            break templates;
          }
          if (!rule.allDay) {
            const instant = scheduleInstant(next.scheduled, schedule.timezone);
            if (instant === undefined || instant <= now || instant > horizon) continue;
          }
          const key = occurrenceKey(next.identity);
          if (seen.has(key)) continue;
          seen.add(key);
          nodes.push({ id: projectionId(next.identity), action: projectedAction(action, next.identity, next.scheduled) });
        }
      }
    } catch (error) {
      issues.push(`${template}: ${(error as Error).message}`);
    }
  }
  return { nodes, issues };
}
