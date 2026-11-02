import { assertAutomationDeclarations } from '../../automation/declaration.js';
import { assertRecurrence, type RecurrenceSchedule } from '../../core/recurrence.js';
import type { AutomationDeclarations } from '../../core/automation.js';
import { assertDelegation, type DelegationDefinition } from '../../core/delegation.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../store.js';
import { assertScheduling } from '../../core/scheduling.js';
import { assertCalendarName } from '../../core/calendar-name.js';
import { formatScalar } from '../format.js';
import { formatDate, formatTimestamp, getMonday, getSunday, getWeekNumber } from '../../core/date.js';
import { toKebabCase } from '../../core/slug.js';
import { validateEntryContent, buildEntryBlock, renderEntries, splitEntrySegments, splitWeekFile } from './entry-file.js';
import { resolveMarkdownSource } from './content-source.js';
import type { ActionFrontMatter, ProjectFrontMatter } from '../../core/types.js';
import { trackMutation } from './mutation-result.js';
import { assertManagedPath, readManagedText } from '../../core/managed-path.js';

export interface NewProject {
  automations?: AutomationDeclarations;
  name: string;
  description: string;
  body?: string;
  body_file?: string;
  related_projects?: { project: string; description: string }[];
}

export interface NewAction {
  delegation?: DelegationDefinition;
  recurrence?: RecurrenceSchedule[];
  name: string;
  description: string;
  body?: string;
  body_file?: string;
  scheduled?: string;
  timezone?: string;
  duration?: string;
  calendar?: string;
  calendar_account?: string;
  deadline?: string;
}

export interface CaptureArgs {
  content?: string;
  content_file?: string;
  description: string;
  projects?: (string | NewProject)[];
  actions?: (string | NewAction)[];
}

// The capture outcome: the human-readable tool response plus the ids it created,
// so callers (the MCP server's calendar sync) act on the ids directly instead of
// re-parsing the text.
export interface CaptureResult {
  text: string;
  entryId: string;
  createdProjectIds: string[];
  createdActionIds: string[];
}

// The outcome of resolving a link list that mixes existing IDs with new-entity
// objects: the full link sets (existing + created) plus the created subset, so
// callers can report and calendar-sync what this call brought into being.
export interface ResolvedRefs {
  projectIds: string[];
  actionIds: string[];
  createdProjectIds: string[];
  createdActionIds: string[];
}

// Split a link list into existing IDs and new-entity objects.
function partitionRefs<T>(refs: (string | T)[]): { existing: string[]; created: T[] } {
  const existing: string[] = [];
  const created: T[] = [];
  for (const r of refs) {
    if (typeof r === 'string') existing.push(r);
    else created.push(r);
  }
  return { existing, created };
}

// Every existing-ID ref must resolve; a miss fails the whole call before any writes.
function requireExisting(ids: string[], exists: (id: string) => boolean, entity: 'project' | 'action'): void {
  const cap = entity === 'project' ? 'Project' : 'Action';
  for (const id of ids) {
    if (!exists(id)) {
      throw new Error(`${cap} "${id}" not found.\nHint: pass an object with {name, description} to create a new ${entity}, or use query_${entity}s to find the correct ID.`);
    }
  }
}

// Reject derived-ID collisions, both within this call and against existing
// files. Distinct names can slugify to the same ID (e.g. "Eye + face" and
// "Eye face"), and the {today}- prefix only disambiguates across days.
function rejectIdCollisions(
  dataDir: string,
  ids: string[],
  named: { name: string }[],
  entityDir: string,
  entity: 'project' | 'action',
): void {
  const cap = entity === 'project' ? 'Project' : 'Action';
  if (ids.length) assertManagedPath(dataDir, join(entityDir, 'index.yaml'), 'file', true);
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (seen.has(id)) {
      throw new Error(`Two new ${entity}s derive the same ID "${id}" (from name "${named[i].name}"). Choose a different name.`);
    }
    seen.add(id);
    const file = assertManagedPath(dataDir, join(entityDir, `${id}.md`), 'file', true);
    if (existsSync(file)) {
      throw new Error(`${cap} ID "${id}" already exists. Choose a different name.`);
    }
  }
}

// Resolve `projects`/`actions` link lists: validate the existing IDs, then create
// the new entities. Name collisions are rejected up front, before any writes
// (step 3). Shared by capture and update_entry — the two tools whose link lists
// create projects and actions.
export function resolveEntityRefs(
  store: Store,
  projects: (string | NewProject)[],
  actions: (string | NewAction)[],
  currentTime: Date,
): ResolvedRefs {
  return trackMutation(store, () => resolveRefs(store, projects, actions, currentTime)).value;
}
function resolveRefs(store: Store, projects: (string | NewProject)[], actions: (string | NewAction)[], currentTime: Date): ResolvedRefs {
  const dataDir = store.getDataDir();
  const today = formatDate(currentTime);
  const year = String(currentTime.getFullYear());
  const projectsDir = join(dataDir, 'projects', year);
  const actionsDir = join(dataDir, 'actions', year);

  // 1. Separate existing refs from new entities
  const { existing: existingProjectIds, created: newProjects } = partitionRefs(projects);
  const { existing: existingActionIds, created: newActions } = partitionRefs(actions);

  for (const project of newProjects) if (project.automations !== undefined) assertAutomationDeclarations(project.automations);

  for (const action of newActions) {
    if (action.delegation !== undefined) assertDelegation(action.delegation);
    assertScheduling(action);
    assertCalendarName(action.calendar);
    if (action.recurrence) {
      assertRecurrence(action.recurrence);
      if (action.scheduled) throw new Error('A recurrence template cannot also have scheduled set.');
    }
  }

  // 2. Validate existing refs
  requireExisting(existingProjectIds, (id) => !!store.getProject(id), 'project');
  requireExisting(existingActionIds, (id) => !!store.getAction(id), 'action');

  // 3. Derive IDs for every new entity and reject collisions up front, before any
  // writes — so a call either creates everything or nothing. Doing this here (not
  // mid-loop) means the deterministic failure — a name collision — can no longer
  // fire after some projects/actions are already on disk. (An I/O failure
  // mid-sequence can still leave a partial create; only the collision check is
  // all-or-nothing.)
  const newProjectIds = newProjects.map(np => `${today}-${toKebabCase(np.name)}`);
  const newActionIds = newActions.map(na => `${today}-${toKebabCase(na.name)}`);
  rejectIdCollisions(dataDir, newProjectIds, newProjects, projectsDir, 'project');
  rejectIdCollisions(dataDir, newActionIds, newActions, actionsDir, 'action');

  // Validate related_projects references (existing projects or ones created here).
  for (const proj of newProjects) {
    if (proj.related_projects) {
      for (const rp of proj.related_projects) {
        if (!store.getProject(rp.project) && !newProjectIds.includes(rp.project)) {
          throw new Error(`Related project "${rp.project}" not found.\nHint: use query_projects to find the correct ID.`);
        }
      }
    }
  }

  // Resolve every draft before creating anything: a later unreadable source or
  // conflicting input must not leave earlier projects/actions behind.
  const projectBodies = newProjects.map(proj => resolveMarkdownSource(proj.body, proj.body_file, 'body') ?? '');
  const actionBodies = newActions.map(act => resolveMarkdownSource(act.body, act.body_file, 'body') ?? '');

  // 4. Create new projects (IDs derived and collision-checked in step 3).
  const createdProjectIds: string[] = [];
  for (let i = 0; i < newProjects.length; i++) {
    const proj = newProjects[i];
    const id = newProjectIds[i];
    const file = join(projectsDir, `${id}.md`);

    const fm: ProjectFrontMatter = { name: proj.name, created: formatTimestamp(currentTime) };
    if (proj.automations !== undefined) fm.automations = structuredClone(proj.automations);
    if (proj.related_projects && proj.related_projects.length > 0) fm.related_projects = proj.related_projects;
    store.saveProject(id, fm, projectBodies[i], file);
    store.addIndexEntry('projects', file, id, proj.description);

    createdProjectIds.push(id);
  }

  // 5. Create new actions (IDs derived and collision-checked in step 3).
  const createdActionIds: string[] = [];
  for (let i = 0; i < newActions.length; i++) {
    const act = newActions[i];
    const id = newActionIds[i];
    const file = join(actionsDir, `${id}.md`);

    const fm: ActionFrontMatter = { name: act.name, created: formatTimestamp(currentTime) };
    if (act.delegation !== undefined) fm.delegation = assertDelegation(act.delegation);
    if (act.recurrence) fm.recurrence = structuredClone(act.recurrence);
    if (act.scheduled) fm.scheduled = act.scheduled;
    if (act.timezone) fm.timezone = act.timezone;
    if (act.duration) fm.duration = act.duration;
    if (act.calendar) fm.calendar = act.calendar;
    if (act.calendar_account) fm.calendar_account = act.calendar_account;
    if (act.deadline) fm.deadline = act.deadline;
    store.saveAction(id, fm, actionBodies[i], file);
    store.addIndexEntry('actions', file, id, act.description);

    createdActionIds.push(id);
  }

  return {
    projectIds: [...existingProjectIds, ...createdProjectIds],
    actionIds: [...existingActionIds, ...createdActionIds],
    createdProjectIds,
    createdActionIds,
  };
}

// Create a new entry, optionally creating new projects and actions in the same
// call. The entry is always new — editing an existing entry is update_entry.
export function handleCapture(store: Store, args: CaptureArgs, now?: Date): CaptureResult {
  return trackMutation(store, () => capture(store, args, now)).value;
}
function capture(store: Store, args: CaptureArgs, now?: Date): CaptureResult {
  const currentTime = now ?? new Date();
  const dataDir = store.getDataDir();

  const content = resolveMarkdownSource(args.content, args.content_file, 'content');
  if (content === undefined) throw new Error('Provide either content or content_file.');
  validateEntryContent(content);

  // Create the entry — resolve timestamp collisions so each entry ID is unique.
  const existingTimestamps = new Set(store.getEntries().map(e => e.meta.created));
  let timestamp = formatTimestamp(currentTime);
  const entryTime = new Date(currentTime);
  while (existingTimestamps.has(timestamp)) {
    entryTime.setMinutes(entryTime.getMinutes() + 1);
    timestamp = formatTimestamp(entryTime);
  }
  const entryId = timestamp;

  // Derive the weekly file from entryTime, not currentTime: the collision bump
  // above can carry the entry past midnight into the next week (or year).
  const monday = getMonday(entryTime);
  const mondayStr = formatDate(monday);
  const weekFilePath = join(dataDir, 'notes', String(monday.getFullYear()), `${mondayStr}.md`);
  // Reject unsafe note destinations before creating any linked entities.
  assertManagedPath(dataDir, weekFilePath, 'file', true);
  assertManagedPath(dataDir, join(dataDir, 'notes', String(monday.getFullYear()), 'index.yaml'), 'file', true);

  const refs = resolveEntityRefs(store, args.projects ?? [], args.actions ?? [], currentTime);
  const { projectIds: allProjectIds, actionIds: allActionIds, createdProjectIds, createdActionIds } = refs;

  const entryBlock = buildEntryBlock(entryId, allProjectIds, allActionIds, content);

  let weeklyContent: string;
  if (existsSync(weekFilePath)) {
    // Prepend the new entry, then re-render every existing entry so the whole
    // file stays canonical. Re-splitting (rather than splicing the old body in
    // verbatim) restores each entry's `---` preamble, so files written by older
    // versions self-heal to canonical form on the next capture.
    const fileContent = readManagedText(dataDir, weekFilePath);
    const split = splitWeekFile(fileContent);
    if (split) {
      weeklyContent = split.frontMatter + '\n' + renderEntries([entryBlock, ...splitEntrySegments(split.body)]) + '\n';
    } else {
      // No recognizable front matter — keep any existing entries as the body.
      weeklyContent = renderEntries([entryBlock, ...splitEntrySegments(fileContent)]) + '\n';
    }
  } else {
    // Create new weekly file with front matter
    const sunday = getSunday(entryTime);
    const weekNum = getWeekNumber(entryTime);
    const weekFrontMatter = `---\nweek: ${weekNum}\nweek_start: ${mondayStr}\nweek_end: ${formatDate(sunday)}\n---\n`;
    weeklyContent = weekFrontMatter + '\n' + renderEntries([entryBlock]) + '\n';
  }

  store.saveEntry(entryId, allProjectIds, allActionIds, content, weekFilePath, weeklyContent);
  store.addIndexEntry('notes', weekFilePath, entryId, args.description);

  // Build the response — text for the agent, ids for programmatic callers.
  const lines: string[] = [`entry: ${formatScalar(entryId)}`, `file: ${formatScalar(weekFilePath)}`];
  if (createdProjectIds.length > 0) {
    lines.push(`projects_created: [${createdProjectIds.map(formatScalar).join(', ')}]`);
  }
  if (createdActionIds.length > 0) {
    lines.push(`actions_created: [${createdActionIds.map(formatScalar).join(', ')}]`);
  }
  return { text: lines.join('\n'), entryId, createdProjectIds, createdActionIds };
}
