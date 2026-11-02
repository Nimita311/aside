import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatDate, formatTimestamp } from '../../core/date.js';
import { toKebabCase } from '../../core/slug.js';
import { assertScheduling } from '../../core/scheduling.js';
import { assertCalendarName } from '../../core/calendar-name.js';
import { assertManagedPath } from '../../core/managed-path.js';
import { assertRecurrence, CompiledRecurrence, occurrenceKey, planningActions, projectedAction, type OccurrenceIdentity } from '../../core/recurrence.js';
import { resolveMarkdownSource } from './content-source.js';
import { handleUpdateAction, type UpdateActionArgs } from './update.js';
import type { Store } from '../store.js';
import type { ActionFrontMatter } from '../../core/types.js';
import { assertDelegation } from '../../core/delegation.js';
import { trackMutation } from './mutation-result.js';

export type UpdateOccurrenceArgs = Omit<UpdateActionArgs, 'id' | 'recurrence'> & { template: string; original: string };
export function handleUpdateOccurrence(store: Store, args: UpdateOccurrenceArgs, now = new Date()): { id: string; text: string } {
  return trackMutation(store, () => updateOccurrence(store, args, now)).value;
}
function updateOccurrence(store: Store, args: UpdateOccurrenceArgs, now: Date): { id: string; text: string } {
  if (args.delegation !== undefined && args.delegation !== null) assertDelegation(args.delegation);
  if (Object.hasOwn(args, 'recurrence')) throw new Error('Recurrence commands apply to the template action, not an occurrence.');
  if (!Object.entries(args).some(([key, value]) => !['template', 'original'].includes(key) && value !== undefined)) throw new Error('An occurrence edit is required; use planning_actions to read projections.');
  const template = store.getAction(args.template);
  if (!template?.frontMatter.recurrence) throw new Error('Recurrence template not found.');
  const identityKey = occurrenceKey({ template: args.template, original: args.original });
  for (const [id, action] of store.getActions()) if (action.frontMatter.occurrence && occurrenceKey(action.frontMatter.occurrence) === identityKey) {
    const { template: _, original: __, ...patch } = args;
    return { id, text: handleUpdateAction(store, { id, ...patch }) };
  }
  let occurrence: { identity: OccurrenceIdentity; scheduled: string } | undefined;
  for (const schedule of assertRecurrence(template.frontMatter.recurrence)) {
    occurrence = new CompiledRecurrence(schedule).contains(args.template, args.original);
    if (occurrence) break;
  }
  if (!occurrence) throw new Error('Original occurrence does not exist in this template schedule. Query planning_actions for its exact identity.');
  const draft = projectedAction(template, occurrence.identity, occurrence.scheduled);
  const fm: ActionFrontMatter = { ...draft.frontMatter, created: formatTimestamp(now) };
  for (const key of ['name', 'scheduled', 'deadline', 'resolution', 'calendar', 'calendar_account', 'duration', 'timezone', 'delegation'] as const) {
    const value = args[key];
    if (value === null) delete fm[key];
    else if (value !== undefined) (fm as unknown as Record<string, unknown>)[key] = value;
  }
  if (!fm.name.trim()) throw new Error('name must be nonblank.');
  assertScheduling(fm); assertCalendarName(fm.calendar);
  const body = resolveMarkdownSource(args.body, args.body_file, 'body') ?? draft.body;
  const prefix = `${formatDate(now)}-${toKebabCase(fm.name)}`;
  const root = store.getDataDir();
  const directory = join(root, 'actions', String(now.getFullYear()));
  assertManagedPath(root, join(directory, 'index.yaml'), 'file', true);
  let id = prefix, suffix = 1;
  while (existsSync(assertManagedPath(root, join(directory, `${id}.md`), 'file', true)) || store.getAction(id)) id = `${prefix}-${++suffix}`;
  const file = join(directory, `${id}.md`);
  store.saveAction(id, fm, body, file);
  store.addIndexEntry('actions', file, id, args.description ?? store.getIndexDescription('actions', args.template) ?? fm.name);
  return { id, text: `materialized: ${id}\noccurrence: ${JSON.stringify(fm.occurrence)}` };
}

export function handlePlanningActions(store: Store, args: { from?: string; to?: string; after?: string; limit?: number; projects?: string[] }): string {
  const ids = args.projects ? [...store.getActions().keys()].filter(id => store.getProjectsForAction(id).some(p => args.projects!.includes(p))) : undefined;
  const page = planningActions(store.getActions(), { ...args, templates: ids, savedIds: ids, lookaheadDays: store.getInstance()?.manifest.config?.recurrenceLookaheadDays });
  return JSON.stringify(page);
}
