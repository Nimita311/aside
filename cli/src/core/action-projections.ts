import { assertRecurrence, CompiledRecurrence, occurrenceKey, projectedAction, projectionId } from './recurrence.js';
import { isCalendarDate } from './scheduling.js';
import type { Action } from './types.js';

export interface ActionProjection { id: string; action: Action }

// Bounds use each occurrence's authored schedule date, just like action filters.
// Saved identities suppress projections even when their actual schedule moved.
export function actionProjections(actions: ReadonlyMap<string, Action>, options: {
  from?: string; to: string; tick?: () => void;
}): { nodes: ActionProjection[]; issues: string[]; limitedTemplates: string[] } {
  if (!isCalendarDate(options.to) || options.from !== undefined && !isCalendarDate(options.from)) {
    throw new Error('Projection range bounds must be calendar dates within years 0001–9999.');
  }
  if (options.from !== undefined && options.from > options.to) throw new Error('scheduledFrom must be on or before scheduledTo.');
  const nodes: ActionProjection[] = [], issues: string[] = [], limitedTemplates: string[] = [];
  const seen = new Set<string>();
  for (const action of actions.values()) {
    if (action.frontMatter.occurrence) seen.add(occurrenceKey(action.frontMatter.occurrence));
  }
  const nextDay = options.to === '9999-12-31' ? undefined
    : new Date(Date.parse(`${options.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  for (const [template, action] of actions) {
    if (!action.frontMatter.recurrence) continue;
    let rules: CompiledRecurrence[];
    try {
      rules = assertRecurrence(action.frontMatter.recurrence).map(schedule => new CompiledRecurrence(schedule));
    } catch (error) {
      issues.push(`${template}: ${(error as Error).message}`);
      continue;
    }
    let limited = false;
    for (const rule of rules) {
      for (const next of rule.occurrences(template, options.from, options.to)) {
        options.tick?.();
        const key = occurrenceKey(next.identity);
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push({ id: projectionId(next.identity), action: projectedAction(action, next.identity, next.scheduled) });
      }
      if (!limited && nextDay) for (const next of rule.occurrences(template, nextDay, '9999-12-31')) {
        options.tick?.();
        if (seen.has(occurrenceKey(next.identity))) continue;
        limited = true;
        break;
      }
    }
    if (limited) limitedTemplates.push(template);
  }
  return { nodes, issues, limitedTemplates };
}
