import { assertDelegation } from '../core/delegation.js';
import { assertRecurrence, CompiledRecurrence, projectedAction, projectionId } from '../core/recurrence.js';
import { assertScheduling, scheduleInstant, wallTimeAt } from '../core/scheduling.js';
import type { Action } from '../core/types.js';
import type { AutomationSource, ScheduledJob } from './scheduler.js';

export interface DelegationSource { id: string; action: Action; excludedOriginals?: string[] }
export interface DelegationTarget { id: string; action: Action; at: number }
export function delegationKey(root: string, id: string, action: Action): string {
  return JSON.stringify([root, `#action/${action.frontMatter.occurrence ? projectionId(action.frontMatter.occurrence) : id}`, 'delegation']);
}
export function delegationSource(root: string, instance: string, id: string, action: Action, excludedOriginals?: string[], blocked?: string): AutomationSource {
  action = structuredClone(action);
  const key = delegationKey(root, id, action);
  const declaration = action.frontMatter.delegation;
  return {key, root, instance, definedIn: JSON.parse(key)[1], declaration: {
    schedule: {at: '2000-01-01T00:00:00Z'}, run: declaration?.run,
    ...(declaration?.timeout === undefined ? {} : {timeout: declaration.timeout}),
    enabled: !action.frontMatter.resolution, overlap: 'skip',
  }, delegation: {id, action, ...(excludedOriginals ? {excludedOriginals: [...excludedOriginals]} : {})}, ...(blocked ? {blocked} : {})};
}

/** Seek authored recurrence directly, without the query projection horizon. */
export function nextDelegation(source: DelegationSource, after: number): DelegationTarget | undefined {
  const {frontMatter: fm} = source.action;
  if (fm.resolution) return undefined;
  if (fm.recurrence === undefined) {
    const at = fm.scheduled ? scheduleInstant(fm.scheduled, fm.timezone) : undefined;
    return at !== undefined && at > after ? {id: source.id, action: source.action, at} : undefined;
  }
  const excluded = new Set(source.excludedOriginals);
  let result: DelegationTarget | undefined;
  for (const schedule of assertRecurrence(fm.recurrence)) {
    const rule = new CompiledRecurrence(schedule);
    const wall = wallTimeAt(after, rule.allDay ? undefined : schedule.timezone);
    // Include the previous wall day to cover clock normalization and DST folds.
    const from = new Date(Date.parse(wall.slice(0, 10) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    for (const occurrence of rule.occurrences(source.id, from)) {
      const at = scheduleInstant(occurrence.scheduled, occurrence.identity.timezone);
      if (at === undefined || at <= after || excluded.has(occurrence.identity.original)) continue;
      if (!result || at < result.at) result = {id: projectionId(occurrence.identity), action: projectedAction(source.action, occurrence.identity, occurrence.scheduled), at};
      break;
    }
  }
  return result;
}

export function compileDelegation(source: AutomationSource): Pick<ScheduledJob, 'definition' | 'schedule'> {
  const delegation = source.delegation!;
  const definition = assertDelegation(delegation.action.frontMatter.delegation);
  assertScheduling(delegation.action.frontMatter);
  if (delegation.action.frontMatter.recurrence !== undefined) assertRecurrence(delegation.action.frontMatter.recurrence);
  return {definition: {...definition, schedule: {at: '2000-01-01T00:00:00Z'}, overlap: 'skip', enabled: !delegation.action.frontMatter.resolution},
    schedule: {description: `Action schedule: ${delegation.action.frontMatter.scheduled ?? 'recurrence/backlog'}`,
      next: after => nextDelegation(delegation, after)?.at}};
}
