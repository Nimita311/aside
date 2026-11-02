import { assertAutomationDeclarations } from '../../automation/declaration.js';
import type { AutomationDeclarations } from '../../core/automation.js';
import { assertDelegation, type DelegationDefinition } from '../../core/delegation.js';
import { applyRecurrenceMutation, type RecurrenceMutation } from '../../core/recurrence.js';
import { dirname, join, relative } from 'node:path';
import { Store } from '../store.js';
import { assertScheduling, isWallMinute } from '../../core/scheduling.js';
import { assertCalendarName } from '../../core/calendar-name.js';
import { formatActionMeta, formatProjectMeta, formatEntryMeta, formatScalar } from '../format.js';
import { validateEntryContent, buildEntryBlock, renderEntries, splitEntrySegments, splitWeekFile } from './entry-file.js';
import { resolveEntityRefs, type NewProject, type NewAction } from './capture.js';
import { resolveMarkdownSource } from './content-source.js';
import { parseEntryBlock, ENTRY_PREAMBLE } from '../../core/parser.js';
import type { ActionFrontMatter, ProjectFrontMatter, RelatedProject } from '../../core/types.js';
import { assertAutomationEdits, hasAutomationEdits, type AutomationEdits } from './automation-edits.js';
import { trackMutation } from './mutation-result.js';
import { parseMetadata } from './front-matter.js';
import { assertLinkEdits, assertRelatedProjectEdits, hasLinkEdits, hasRelatedProjectEdits, linkId, mergeLinkIds, type LinkEdits, type RelatedProjectEdits } from './link-edits.js';
import { assertManagedPath, readManagedText } from '../../core/managed-path.js';

function assertUpdatePaths(store: Store, file: string, description?: string): void {
  assertManagedPath(store.getDataDir(), file, 'file');
  if (description !== undefined) assertManagedPath(store.getDataDir(), join(dirname(file), 'index.yaml'), 'file', true);
}

// Persist a description change and return a warning suffix for the response
// when it landed nowhere: an entity with no index row (hand-created, never
// indexed) silently keeps its old description otherwise, while the tool
// reports success.
function descriptionWarning(store: Store, kind: 'notes' | 'projects' | 'actions', id: string, description?: string): string {
  if (description === undefined) return '';
  if (store.setIndexEntry(kind, id, description)) return '';
  return `\nwarning: description not saved — index entry for ${formatScalar(id)} could not be updated (run \`aside instance validate\`)`;
}

// A field-patch over an existing action or project. The convention mirrors a
// JSON merge patch on the front matter:
//   - field omitted  → leave unchanged
//   - field = value  → set / replace
//   - field = null   → remove the field (returns the entity to the prior state,
//                      e.g. deschedule, reopen)
// Renaming changes only the display name. IDs, filenames, and created timestamps
// remain fixed. Entry content is amended through `update_entry`, not here.
export interface UpdateActionArgs {
  delegation?: DelegationDefinition | null;
  id: string;
  recurrence?: RecurrenceMutation;
  name?: string;
  scheduled?: string | null;
  deadline?: string | null;
  resolution?: 'done' | 'cancelled' | null;
  calendar?: string | null;
  calendar_account?: string | null;
  duration?: string | null;
  timezone?: string | null;
  body?: string;
  body_file?: string;
  description?: string;
}

export interface UpdateProjectArgs {
  automations?: AutomationDeclarations | null;
  automationEdits?: AutomationEdits | null;
  id: string;
  name?: string;
  ended?: string | null;
  related_projects?: RelatedProject[] | null;
  relatedProjectEdits?: RelatedProjectEdits | null;
  body?: string;
  body_file?: string;
  description?: string;
}

// An entry's content and links are amended in place (its weekly file block). The
// id (the created timestamp) never changes. `projects`/`actions` replace the whole
// link set — value sets it, `null` or `[]` clears it, omitted leaves it. Each list
// item is an existing ID or a new-entity object, created exactly as in `capture`;
// only entry creation stays in `capture`.
// projectEdits/actionEdits add or remove only selected IDs, preserving other tags.
export interface UpdateEntryArgs {
  id: string;
  content?: string;
  content_file?: string;
  description?: string;
  projects?: (string | NewProject)[] | null;
  actions?: (string | NewAction)[] | null;
  projectEdits?: LinkEdits<NewProject> | null;
  actionEdits?: LinkEdits<NewAction> | null;
}

// The update_entry outcome mirrors CaptureResult: the human-readable tool response
// plus the ids it created, so the MCP server's calendar sync acts on the ids
// directly instead of re-parsing the text.
export interface UpdateEntryResult {
  text: string;
  createdProjectIds: string[];
  createdActionIds: string[];
}

// The action fields the merge patch can touch — also what `fileChanged` derives
// from, so the patch and the rewrite trigger cannot drift.
const ACTION_PATCH_FIELDS = ['name', 'scheduled', 'deadline', 'resolution', 'calendar', 'calendar_account', 'duration', 'timezone', 'delegation'] as const;

// Apply one provided merge-patch field: null (or an empty string) removes it, a
// value sets it. Callers skip undefined fields (leave unchanged).
function patchField<T extends object>(fm: T, key: keyof T, value: unknown): void {
  if (value === null || value === '') delete (fm as Record<string, unknown>)[key as string];
  else (fm as Record<string, unknown>)[key as string] = value;
}

function assertName(name: string | undefined): void {
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new Error('name must be a nonblank string.');
}

export function handleUpdateAction(store: Store, args: UpdateActionArgs, now = new Date()): string {
  return trackMutation(store, () => updateAction(store, args, now)).value;
}
function updateAction(store: Store, args: UpdateActionArgs, now: Date): string {
  if (args.delegation !== undefined && args.delegation !== null) assertDelegation(args.delegation);
  assertName(args.name);
  assertCalendarName(args.calendar);
  const action = store.getAction(args.id);
  if (!action) {
    throw new Error(`Cannot update action "${args.id}" — not found.\nHint: use query_actions to verify the ID; create new actions with capture or update_entry.`);
  }

  // Null clears; every supplied string must satisfy the capture contract.
  for (const key of ['scheduled', 'deadline', 'timezone', 'duration'] as const) {
    if (args[key] !== undefined && args[key] !== null) assertScheduling({ [key]: args[key] });
  }

  const fm: ActionFrontMatter = { ...action.frontMatter };
  const file = store.getActionFile(args.id);
  if (!file) throw new Error(`Cannot update action "${args.id}" — file not found.`);
  assertUpdatePaths(store, file, args.description);
  if (args.recurrence !== undefined) {
    const issue = store.getIssues().find(issue => issue.severity === 'error' &&
      (issue.code === 'invalid_yaml' || /recurrence|occurrence/.test(issue.code) || /^(recurrence|occurrence)(?:\W|$)/.test(issue.field ?? '')) &&
      (issue.file === file || issue.file === relative(store.getDataDir(), file) || issue.message.startsWith(args.id + ':')));
    if (issue) throw new Error(`${issue.message} Repair the recurrence declaration before mutating its schedules.`);
    fm.recurrence = applyRecurrenceMutation(action.frontMatter.recurrence, args.recurrence, now, store.getOccurrenceOriginals(args.id));
  }
  for (const key of ACTION_PATCH_FIELDS) {
    if (args[key] !== undefined) patchField(fm, key, args[key]);
  }

  assertScheduling(fm);
  const replacementBody = resolveMarkdownSource(args.body, args.body_file, 'body');
  // The .md file holds the front matter and body; the description lives only in
  // the index. Rewrite the file only when a file-backed field changed — never for
  // a description-only update.
  const fileChanged = args.recurrence !== undefined || replacementBody !== undefined || ACTION_PATCH_FIELDS.some((key) => args[key] !== undefined);
  if (fileChanged) store.saveAction(args.id, fm, replacementBody, file,
    [...ACTION_PATCH_FIELDS.filter(key => args[key] !== undefined), ...(args.recurrence !== undefined ? ['recurrence'] : [])]);
  const warning = descriptionWarning(store, 'actions', args.id, args.description);

  const updated = store.getAction(args.id)!;
  const description = store.getIndexDescription('actions', args.id);
  return `updated: ${formatScalar(args.id)}${warning}\n\n${formatActionMeta(args.id, updated, store.getProjectsForAction(args.id), file, description)}`;
}

export function handleUpdateProject(store: Store, args: UpdateProjectArgs): string {
  return trackMutation(store, () => updateProject(store, args)).value;
}
function updateProject(store: Store, args: UpdateProjectArgs): string {
  assertName(args.name);
  if (args.related_projects !== undefined && args.relatedProjectEdits != null) throw new Error('Provide either related_projects or relatedProjectEdits, not both.');
  if (args.relatedProjectEdits) assertRelatedProjectEdits(args.relatedProjectEdits);
  if (args.automations !== undefined && args.automationEdits != null) throw new Error('Provide either automations or automationEdits, not both.');
  const automationEdits = args.automationEdits == null ? undefined : assertAutomationEdits(args.automationEdits);
  if (args.ended != null && !isWallMinute(args.ended)) {
    throw new Error('ended must be a real floating time YYYY-MM-DDTHH:mm (00:00–23:59); use null to reopen the project. No records were changed.');
  }
  const project = store.getProject(args.id);
  if (!project) {
    throw new Error(`Cannot update project "${args.id}" — not found.\nHint: use query_projects to verify the ID; create new projects with capture or update_entry.`);
  }

  const automations = args.automations == null ? args.automations : assertAutomationDeclarations(args.automations);
  const fm: ProjectFrontMatter = { ...project.frontMatter };
  if (automations !== undefined) {
    if (automations === null || !Object.keys(automations).length) delete fm.automations;
    else fm.automations = automations;
  }
  if (args.name !== undefined) fm.name = args.name;
  if (args.ended !== undefined) patchField(fm, 'ended', args.ended);
  if (args.related_projects !== undefined) {
    if (args.related_projects === null || args.related_projects.length === 0) {
      delete fm.related_projects;
    } else {
      for (const rp of args.related_projects) {
        if (!store.getProject(rp.project)) {
          throw new Error(`Related project "${rp.project}" not found.\nHint: use query_projects to find the correct ID.`);
        }
      }
      fm.related_projects = args.related_projects;
    }
  }
  for (const link of args.relatedProjectEdits?.upsert ?? []) {
    if (!store.getProject(link.project)) throw new Error(`Related project "${link.project}" not found.\nHint: use query_projects to find the correct ID.`);
  }

  const replacementBody = resolveMarkdownSource(args.body, args.body_file, 'body');
  const file = store.getProjectFile(args.id);
  if (!file) throw new Error(`Cannot update project "${args.id}" — file not found.`);
  assertUpdatePaths(store, file, args.description);
  // The .md file holds the front matter and body; the description lives only in
  // the index. Rewrite the file only when a file-backed field changed — never for
  // a description-only update.
  const fileChanged = args.automations !== undefined || hasAutomationEdits(automationEdits) || args.name !== undefined || args.ended !== undefined || args.related_projects !== undefined || hasRelatedProjectEdits(args.relatedProjectEdits) || replacementBody !== undefined;
  // Undefined keeps the exact existing Markdown tail, including indentation and
  // trailing blank lines that the read parser normalizes in its domain snapshot.
  if (fileChanged) store.saveProject(args.id, fm, replacementBody, file,
    ['name', 'automations', 'ended', 'related_projects'].filter(key => args[key as keyof UpdateProjectArgs] !== undefined), automationEdits, args.relatedProjectEdits ?? undefined);
  const warning = descriptionWarning(store, 'projects', args.id, args.description);

  const updated = store.getProject(args.id)!;
  const description = store.getIndexDescription('projects', args.id);
  return `updated: ${formatScalar(args.id)}${warning}\n\n${formatProjectMeta(args.id, updated, file, description)}`;
}

export function handleUpdateEntry(store: Store, args: UpdateEntryArgs, now?: Date): UpdateEntryResult {
  return trackMutation(store, () => updateEntry(store, args, now)).value;
}

// Find only the selected entry's metadata bytes. A metadata-only patch must not
// re-render Markdown, neighbouring entries, or the weekly file's separators.
function entryMetadataRange(body: string, id: string): {start: number; end: number; newline: string} | undefined {
  const separators = [...body.matchAll(new RegExp(ENTRY_PREAMBLE.source, 'gm'))];
  const ranges = [0, ...separators.map(match => match.index + match[0].length)];
  for (let index = 0; index < ranges.length; index++) {
    const segment = body.slice(ranges[index], separators[index]?.index ?? body.length);
    const fence = segment.match(/^(\s*```entry\s*\n)([\s\S]*?)```/);
    if (!fence || parseEntryBlock(fence[2]).value.created !== id) continue;
    const start = ranges[index] + fence[1].length;
    return {start, end: start + fence[2].length, newline: fence[1].endsWith('\r\n') ? '\r\n' : '\n'};
  }
}

function updateEntry(store: Store, args: UpdateEntryArgs, now?: Date): UpdateEntryResult {
  const currentTime = now ?? new Date();
  for (const [field, patch] of [['projects', 'projectEdits'], ['actions', 'actionEdits']] as const) {
    if (args[field] !== undefined && args[patch] != null) throw new Error(`Provide either ${field} or ${patch}, not both.`);
    if (args[patch]) assertLinkEdits(args[patch] as LinkEdits<NewProject | NewAction>, patch, currentTime);
  }
  const entry = store.getEntries().find(e => e.meta.created === args.id);
  if (!entry) {
    throw new Error(`Cannot update entry "${args.id}" — not found.\nHint: use query_entries to verify the ID, or capture to create a new entry.`);
  }
  const file = store.getEntryFile(args.id);
  if (!file) throw new Error(`Cannot update entry "${args.id}" — weekly file not found.`);
  assertUpdatePaths(store, file, args.description);

  const replacementContent = resolveMarkdownSource(args.content, args.content_file, 'content');
  let content = replacementContent ?? entry.content;
  if (replacementContent !== undefined) validateEntryContent(content);

  // The weekly file holds the content and links; the description lives only in
  // the index. Rewrite the file only when a file-backed field changed — never for
  // a description-only update (which would also re-canonicalize the neighbours).
  const projectsChanged = args.projects !== undefined || hasLinkEdits(args.projectEdits);
  const actionsChanged = args.actions !== undefined || hasLinkEdits(args.actionEdits);
  const projectRefs = args.projects ?? args.projectEdits?.add ?? [];
  const actionRefs = args.actions ?? args.actionEdits?.add ?? [];
  const changedTags = [...(projectsChanged ? ['projects'] : []), ...(actionsChanged ? ['actions'] : [])];
  const fileChanged = replacementContent !== undefined || projectsChanged || actionsChanged;

  // Parse the weekly file and locate the entry's segment before creating any new
  // entities, so a deterministic failure here can't leave orphans behind.
  let split: { frontMatter: string; body: string } | undefined;
  let originalWeeklyContent: string | undefined;
  let metadataRange: ReturnType<typeof entryMetadataRange>;
  let segments: string[] = [];
  let targetIndex = -1;
  let originalMetadata: string | undefined;
  let currentProjectIds = entry.meta.projects ?? [];
  let currentActionIds = entry.meta.actions ?? [];
  if (fileChanged) {
    originalWeeklyContent = readManagedText(store.getDataDir(), file);
    split = splitWeekFile(originalWeeklyContent) ?? undefined;
    if (!split) throw new Error(`Cannot update entry "${args.id}" — could not parse weekly file.`);
    segments = splitEntrySegments(split.body);
    targetIndex = segments.findIndex((segment) => {
      // Read `created:` only from the segment's leading ```entry fence — the
      // same rule extractEntryBlocks uses — so a `created:` line in entry prose
      // can never identify the segment, however the metadata block is shaped.
      const fence = segment.match(/^\s*```entry\s*\n([\s\S]*?)```/);
      return fence !== null && parseEntryBlock(fence[1]).value.created === args.id;
    });
    if (targetIndex === -1) throw new Error(`Cannot update entry "${args.id}" — not found in weekly file.`);
    const target = segments[targetIndex].match(/^\s*```entry\s*\n([\s\S]*?)```\s*\n?([\s\S]*)/)!;
    originalMetadata = target[1];
    if (replacementContent === undefined) {
      metadataRange = entryMetadataRange(split.body, args.id);
      if (!metadataRange) throw new Error(`Cannot update entry "${args.id}" — metadata not found in weekly file.`);
      originalMetadata = split.body.slice(metadataRange.start, metadataRange.end);
    }
    // Patch the current disk tags, including external edits not yet observed by
    // the watcher. Tolerant reads may drop malformed IDs; refuse to erase them
    // implicitly when a patch needs to preserve that list.
    const diskMetadata = parseEntryBlock(originalMetadata).value;
    const rawMetadata = parseMetadata(originalMetadata, `entry ${args.id}`).toJS();
    for (const [field, patch] of [['projects', 'projectEdits'], ['actions', 'actionEdits']] as const) {
      const current = rawMetadata[field];
      if (hasLinkEdits(args[patch]) && current != null && (!Array.isArray(current) || current.some(id => typeof id !== 'string'))) {
        throw new Error(`Cannot patch entry ${args.id}: existing ${field} must be a list of text IDs. Repair it or replace the full list.`);
      }
    }
    currentProjectIds = diskMetadata.projects ?? [];
    currentActionIds = diskMetadata.actions ?? [];
    // New entity IDs are deterministic. Preflight the complete metadata merge
    // before resolving references creates records: even valid YAML can contain
    // custom aliases that cannot safely survive replacement of a link list.
    const predictedIds = (refs: (string | NewProject | NewAction)[]) => refs.map(ref => linkId(ref, currentTime));
    buildEntryBlock(args.id,
      args.projects !== undefined ? predictedIds(projectRefs) : mergeLinkIds(currentProjectIds, predictedIds(projectRefs), args.projectEdits?.remove ?? []),
      args.actions !== undefined ? predictedIds(actionRefs) : mergeLinkIds(currentActionIds, predictedIds(actionRefs), args.actionEdits?.remove ?? []),
      content, originalMetadata, changedTags);
  }

  // Merge-patch: omit a field to keep it. Content is replaced wholesale; the link
  // lists replace the whole set, with null/[] clearing them. A provided list is
  // resolved like capture's: existing IDs are validated, new-entity objects are
  // created (this entry is their context).
  const refs = resolveEntityRefs(store, projectRefs, actionRefs, currentTime);
  const projectIds = args.projects !== undefined ? refs.projectIds : mergeLinkIds(currentProjectIds, refs.projectIds, args.projectEdits?.remove ?? []);
  const actionIds = args.actions !== undefined ? refs.actionIds : mergeLinkIds(currentActionIds, refs.actionIds, args.actionEdits?.remove ?? []);

  if (fileChanged && split) {
    const updatedBlock = buildEntryBlock(args.id, projectIds, actionIds, content, originalMetadata, changedTags);
    let weeklyContent: string;
    if (replacementContent === undefined && metadataRange && originalWeeklyContent !== undefined) {
      const metadata = updatedBlock.match(/^```entry\n([\s\S]*?)```/)![1].replace(/\n/g, metadataRange.newline);
      const bodyOffset = originalWeeklyContent.length - split.body.length;
      weeklyContent = originalWeeklyContent.slice(0, bodyOffset + metadataRange.start) + metadata + originalWeeklyContent.slice(bodyOffset + metadataRange.end);
    } else {
      segments[targetIndex] = updatedBlock;
      weeklyContent = split.frontMatter + '\n' + renderEntries(segments) + '\n';
    }
    store.saveEntry(args.id, projectIds, actionIds, content, file, weeklyContent);
  }
  const warning = descriptionWarning(store, 'notes', args.id, args.description);

  const description = store.getIndexDescription('notes', args.id);
  const updated = store.getEntries().find(entry => entry.meta.created === args.id)!;
  const lines: string[] = [`updated: ${formatScalar(args.id)}${warning}`];
  if (refs.createdProjectIds.length > 0) lines.push(`projects_created: [${refs.createdProjectIds.join(', ')}]`);
  if (refs.createdActionIds.length > 0) lines.push(`actions_created: [${refs.createdActionIds.join(', ')}]`);
  const text = `${lines.join('\n')}\n\n${formatEntryMeta(updated, file, description)}`;
  return { text, createdProjectIds: refs.createdProjectIds, createdActionIds: refs.createdActionIds };
}
