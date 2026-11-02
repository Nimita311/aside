import { defaultSearchMatcher, validateSearchPattern, type SearchMatcher } from '../search.js';
import { REGEX_SNAPSHOT_MAX_BYTES, REGEX_SNAPSHOT_MAX_RECORDS } from '../../core/system-config.js';
import { isCalendarDate } from '../../core/scheduling.js';
import type { z } from 'zod';
import type { TOOL_SCHEMAS } from '../schemas.js';
import { Store } from '../store.js';
import {
  formatPagination,
  formatEntryMeta,
  formatEntryFull,
  formatIndexLine,
  formatActionMeta,
  formatActionFull,
  formatProjectMeta,
  formatProjectFull,
  formatArtifactIndex,
  formatArtifactMeta,
  formatArtifactFull,
  formatIssueSummary,
} from '../format.js';
import type { Entry, Action, Project, Artifact, IndexItem, ParseIssue } from '../../core/types.js';

// The handlers take exactly what the tool schemas admit.
export type QueryArtifactsArgs = z.infer<typeof TOOL_SCHEMAS.query_artifacts>;
type QueryEntriesArgs = z.infer<typeof TOOL_SCHEMAS.query_entries>;
type QueryActionsArgs = z.infer<typeof TOOL_SCHEMAS.query_actions>;
type QueryProjectsArgs = z.infer<typeof TOOL_SCHEMAS.query_projects>;

function queryLimit(limit: number | undefined): number {
  const value = limit ?? 20;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('limit must be an integer from 1 to 100.');
  }
  return value;
}

function queryOffset(offset: number | undefined): number {
  const value = offset ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('offset must be a nonnegative integer.');
  }
  return value;
}

// A trailing reminder when a set-membership filter (`ids`, `status`) is passed as
// an empty list. An empty set matches nothing, so the result is always empty —
// almost certainly not what the caller intended. Surfacing it keeps the empty
// result from reading like a genuine "no matches" and nudges the agent to omit
// the filter (which means "no constraint") instead. Relationship filters are
// excluded: there `[]` is a real query (entities with none of that relationship).
function emptyFilterNote(emptyNames: string[]): string {
  if (emptyNames.length === 0) return '';
  const plural = emptyNames.length > 1;
  const list = emptyNames.join(' and ');
  const verb = plural ? 'were empty lists' : 'was an empty list';
  const matches = plural ? 'match' : 'matches';
  const it = plural ? 'them' : 'it';
  return `\n\nNote: ${list} ${verb}, which ${matches} nothing. Omit ${it} for no filter, or pass the values you want.`;
}

// Index descriptions keyed by id — every handler uses them both for search and
// for index-mode output.
function indexById(items: IndexItem[]): Map<string, IndexItem> {
  return new Map(items.map(item => [item.id, item]));
}

// Sort newest-first by the entity's created timestamp (lexicographic on the
// ISO strings), matching the year indexes' order.
function sortNewestFirst<T>(items: T[], created: (item: T) => string): void {
  items.sort((a, b) => (created(a) < created(b) ? 1 : created(a) > created(b) ? -1 : 0));
}

// Push an exact-id filter. The caller only passes a provided list, so [] means
// "match nothing" (no id is in an empty set); omit = the caller doesn't call.
function pushIdFilter<T>(filters: ((item: T) => boolean)[], ids: string[], getId: (item: T) => string): void {
  const idSet = new Set(ids);
  filters.push(item => idSet.has(getId(item)));
}

// Push a relationship filter with the shared semantics: [] = items with none of
// the relationship, values = items with any of them (omit = the caller doesn't
// call).
function pushRelationFilter<T>(filters: ((item: T) => boolean)[], values: string[], get: (item: T) => string[]): void {
  if (values.length === 0) {
    filters.push(item => get(item).length === 0);
  } else {
    const set = new Set(values);
    filters.push(item => get(item).some(v => set.has(v)));
  }
}

// Push inclusive from/to day-bounds on an optional timestamp field. An absent
// field never matches a bound.
function pushDateFilters<T>(
  filters: ((item: T) => boolean)[],
  from: string | undefined,
  to: string | undefined,
  get: (item: T) => string | undefined,
  field: string,
): void {
  for (const [name, value] of [[`${field}_from`, from], [`${field}_to`, to]]) {
    if (value !== undefined && !isCalendarDate(value)) {
      throw new Error(`${name} must be a valid date in YYYY-MM-DD format.`);
    }
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error(`${field}_from must be on or before ${field}_to.`);
  }
  if (from !== undefined) {
    filters.push(item => {
      const v = get(item);
      return v != null && v.slice(0, 10) >= from;
    });
  }
  if (to !== undefined) {
    filters.push(item => {
      const v = get(item);
      return v != null && v.slice(0, 10) <= to;
    });
  }
}

// The scaffold every query handler shares: apply the entity-specific filter
// predicates, then the search regex over the entity's text fields, paginate,
// render at the requested detail, and append the empty-filter note. Per-entity
// logic stays in the caller as data — predicates, search fields, formatters.
export interface QueryContext { matcher: SearchMatcher; signal?: AbortSignal }

function runQuery<T>(
  items: T[],
  args: { search?: string; detail?: 'index' | 'metadata' | 'full'; offset?: number; limit?: number },
  spec: {
    filters: ((item: T) => boolean)[];
    searchTexts: (item: T) => string[];
    formatFull: (item: T) => string;
    formatMeta: (item: T) => string;
    formatIndex: (item: T) => string;
    empties: string[];
    issues: ParseIssue[];
  },
  context?: QueryContext,
): string | Promise<string> {
  const offset = queryOffset(args.offset);
  const limit = queryLimit(args.limit);
  if (args.search) validateSearchPattern(args.search);
  for (const f of spec.filters) items = items.filter(f);

  const detail = args.detail;
  const format = detail === 'full' ? spec.formatFull : detail === 'metadata' ? spec.formatMeta : spec.formatIndex;
  const issueSummary = formatIssueSummary(spec.issues);
  const footer = emptyFilterNote(spec.empties) + (issueSummary ? `\n\n${issueSummary}` : '');
  function render(rows: string[], total = rows.length, paged = false): string {
    const page = paged ? rows : rows.slice(offset, offset + limit);
    const lines = [formatPagination(page.length, total, offset, limit), ''];
    if (detail === 'full' || detail === 'metadata') lines.push(page.join('\n\n'));
    else lines.push(...page);
    return lines.join('\n') + footer;
  }
  if (!args.search) return render(items.slice(offset, offset + limit).map(format), items.length, true);

  if (items.length > REGEX_SNAPSHOT_MAX_RECORDS) throw new Error('Regex search snapshot has too many records. Narrow the query with IDs, dates, or relationships.');
  const rows: string[] = [];
  const texts: string[][] = [];
  let snapshotBytes = 0;
  for (const item of items) {
    const fields = spec.searchTexts(item);
    snapshotBytes += fields.reduce((sum, field) => sum + Buffer.byteLength(field, 'utf8'), 0);
    if (snapshotBytes > REGEX_SNAPSHOT_MAX_BYTES) throw new Error('Regex search snapshot is too large. Narrow the query with IDs, dates, or relationships.');
    const row = format(item);
    snapshotBytes += Buffer.byteLength(row, 'utf8');
    if (snapshotBytes > REGEX_SNAPSHOT_MAX_BYTES) throw new Error('Regex search snapshot is too large. Narrow the query with IDs, dates, or relationships.');
    rows.push(row); texts.push(fields);
  }
  return (context?.matcher ?? defaultSearchMatcher()).match(args.search, texts, { signal: context?.signal, snapshotBytes })
    .then(indices => render(indices.map(index => rows[index])));
}

export function handleQueryEntries(store: Store, args: QueryEntriesArgs, context?: QueryContext): string | Promise<string> {
  const indexMap = indexById(store.getNoteIndex());

  const filters: ((e: Entry) => boolean)[] = [];
  if (args.ids) pushIdFilter(filters, args.ids, e => e.meta.created);
  if (args.projects) pushRelationFilter(filters, args.projects, e => e.meta.projects ?? []);
  if (args.actions) pushRelationFilter(filters, args.actions, e => e.meta.actions ?? []);
  pushDateFilters(filters, args.created_from, args.created_to, e => e.meta.created, 'created');

  const empties: string[] = [];
  if (args.ids?.length === 0) empties.push('ids');

  return runQuery(store.getEntries(), args, {
    filters,
    // Search matches the entry's content and its index description.
    searchTexts: e => [e.content, indexMap.get(e.meta.created)?.description ?? ''],
    // Full shows the real index description when one exists; unlike the
    // metadata branch there is no content-slice fallback — the content itself
    // follows.
    formatFull: e => formatEntryFull(e, store.getEntryFile(e.meta.created), indexMap.get(e.meta.created)?.description),
    formatMeta: e => {
      const desc = indexMap.get(e.meta.created)?.description ?? e.content.slice(0, 80);
      return formatEntryMeta(e, store.getEntryFile(e.meta.created), desc);
    },
    formatIndex: e =>
      formatIndexLine(indexMap.get(e.meta.created) ?? { id: e.meta.created, description: e.content.slice(0, 80) }),
    empties,
    issues: store.getIssues(),
  }, context);
}

export function handleQueryActions(store: Store, args: QueryActionsArgs, context?: QueryContext): string | Promise<string> {
  const items = Array.from(store.getActions(), ([id, action]) => ({ id, action }));
  sortNewestFirst(items, item => item.action.frontMatter.created);
  const indexMap = indexById(store.getActionIndex());

  type Item = { id: string; action: Action };
  const filters: ((item: Item) => boolean)[] = [];
  if (args.ids) pushIdFilter(filters, args.ids, item => item.id);
  if (args.projects) pushRelationFilter(filters, args.projects, item => store.getProjectsForAction(item.id));
  pushDateFilters(filters, args.created_from, args.created_to, item => item.action.frontMatter.created, 'created');
  pushDateFilters(filters, args.scheduled_from, args.scheduled_to, item => item.action.frontMatter.scheduled, 'scheduled');
  pushDateFilters(filters, args.deadline_from, args.deadline_to, item => item.action.frontMatter.deadline, 'deadline');

  // Status filter — mutually-exclusive lifecycle states, derived purely from
  // which fields are present (no clock). Time-relative views (overdue, slipped,
  // upcoming) are composed by the caller as status + a scheduled/deadline bound.
  // Omit = no filter; [] = match nothing (no state is in an empty set).
  if (args.status) {
    const statusSet = new Set(args.status);
    filters.push(item => {
      const fm = item.action.frontMatter;
      if (statusSet.has('done') && fm.resolution === 'done') return true;
      if (statusSet.has('cancelled') && fm.resolution === 'cancelled') return true;
      if (statusSet.has('scheduled') && fm.resolution == null && fm.scheduled != null) return true;
      if (statusSet.has('backlog') && fm.resolution == null && fm.scheduled == null) return true;
      return false;
    });
  }

  const empties: string[] = [];
  if (args.ids?.length === 0) empties.push('ids');
  if (args.status?.length === 0) empties.push('status');

  return runQuery(items, args, {
    filters,
    // Search matches all of the action's text: name, index description, body.
    searchTexts: item => [item.action.frontMatter.name, indexMap.get(item.id)?.description ?? '', item.action.body],
    formatFull: item => formatActionFull(item.id, item.action, store.getProjectsForAction(item.id), store.getActionFile(item.id), indexMap.get(item.id)?.description),
    formatMeta: item => formatActionMeta(item.id, item.action, store.getProjectsForAction(item.id), store.getActionFile(item.id), indexMap.get(item.id)?.description),
    formatIndex: item =>
      formatIndexLine(indexMap.get(item.id) ?? { id: item.id, description: item.action.frontMatter.name }),
    empties,
    issues: store.getIssues(),
  }, context);
}

export function handleQueryProjects(store: Store, args: QueryProjectsArgs, context?: QueryContext): string | Promise<string> {
  const items = Array.from(store.getProjects(), ([id, project]) => ({ id, project }));
  sortNewestFirst(items, item => item.project.frontMatter.created);
  const indexMap = indexById(store.getProjectIndex());

  type Item = { id: string; project: Project };
  const filters: ((item: Item) => boolean)[] = [];
  if (args.ids) pushIdFilter(filters, args.ids, item => item.id);
  if (args.related_to) {
    pushRelationFilter(filters, args.related_to, item =>
      (item.project.frontMatter.related_projects ?? []).map(r => r.project));
  }
  pushDateFilters(filters, args.created_from, args.created_to, item => item.project.frontMatter.created, 'created');
  pushDateFilters(filters, args.ended_from, args.ended_to, item => item.project.frontMatter.ended, 'ended');

  // Lifecycle: a project is open until `ended` is set.
  if (args.status === 'open') filters.push(item => item.project.frontMatter.ended == null);
  if (args.status === 'closed') filters.push(item => item.project.frontMatter.ended != null);

  const empties: string[] = [];
  if (args.ids?.length === 0) empties.push('ids');

  return runQuery(items, args, {
    filters,
    // Search matches all of the project's text: name, index description, body.
    searchTexts: item => [item.project.frontMatter.name, indexMap.get(item.id)?.description ?? '', item.project.body],
    formatFull: item => formatProjectFull(item.id, item.project, store.getProjectFile(item.id), indexMap.get(item.id)?.description),
    formatMeta: item => formatProjectMeta(item.id, item.project, store.getProjectFile(item.id), indexMap.get(item.id)?.description),
    formatIndex: item =>
      formatIndexLine(indexMap.get(item.id) ?? { id: item.id, description: item.project.frontMatter.name }),
    empties,
    issues: store.getIssues(),
  }, context);
}

export function handleQueryArtifacts(store: Store, args: QueryArtifactsArgs, context?: QueryContext): string | Promise<string> {
  const items = Array.from(store.getArtifacts(), ([id, artifact]) => ({ id, artifact }));
  sortNewestFirst(items, item => item.artifact.frontMatter.created);
  const indexMap = indexById(store.getArtifactIndex());
  type Item = { id: string; artifact: Artifact };
  const filters: ((item: Item) => boolean)[] = [];
  if (args.ids) pushIdFilter(filters, args.ids, item => item.id);
  if (args.projects) pushRelationFilter(filters, args.projects, item => store.getProjectsForArtifact(item.id));
  if (args.actions) pushRelationFilter(filters, args.actions, item => store.getActionsForArtifact(item.id));
  pushDateFilters(filters, args.created_from, args.created_to, item => item.artifact.frontMatter.created, 'created');
  return runQuery(items, args, {
    filters,
    searchTexts: item => [item.artifact.frontMatter.name, indexMap.get(item.id)?.description ?? '', item.artifact.body],
    formatFull: item => formatArtifactFull(item.id, item.artifact, store.getProjectsForArtifact(item.id), store.getActionsForArtifact(item.id), store.getArtifactBacklinks(item.id), indexMap.get(item.id)?.description, store.getDataDir()),
    formatMeta: item => formatArtifactMeta(item.id, item.artifact, store.getProjectsForArtifact(item.id), store.getActionsForArtifact(item.id), store.getArtifactBacklinks(item.id), indexMap.get(item.id)?.description, store.getDataDir()),
    formatIndex: item => formatArtifactIndex(indexMap.get(item.id) ?? { id: item.id, description: item.artifact.frontMatter.name }),
    empties: args.ids?.length === 0 ? ['ids'] : [],
    issues: store.getIssues(),
  }, context);
}
