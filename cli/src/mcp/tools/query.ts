import { defaultSearchMatcher, validateSearchPattern, type SearchMatcher } from '../search.js';
import { REGEX_SNAPSHOT_MAX_BYTES, REGEX_SNAPSHOT_MAX_RECORDS } from '../../core/system-config.js';
import { isCalendarDate } from '../../core/scheduling.js';
import type { z } from 'zod';
import type { TOOL_SCHEMAS } from '../schemas.js';
import { Store } from '../../source/store.js';
import {
  formatPagination,
  formatArtifactIndex,
  formatArtifactMeta,
  formatArtifactFull,
  formatIssueSummary,
} from '../format.js';
import type { Artifact, IndexItem, ParseIssue } from '../../core/types.js';

// The handler takes exactly what the schema admits.
export type QueryArtifactsArgs = z.infer<typeof TOOL_SCHEMAS.query_artifacts>;

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

// A trailing reminder when `ids` is an empty list. An empty set matches nothing,
// so the result is always empty — almost certainly not what the caller intended.
// Surfacing it keeps the empty result from reading like a genuine "no matches" and
// nudges the caller to omit the filter (which means "no constraint") instead.
// Relationship filters are excluded: there `[]` is a real query (records with none
// of that relationship).
const EMPTY_IDS_NOTE = '\n\nNote: ids was an empty list, which matches nothing. Omit it for no filter, or pass the values you want.';

// Index descriptions keyed by id, for both search and index-mode output.
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

// Apply the filter predicates, then the search regex over the record's text
// fields, paginate, render at the requested detail, and append the empty-filter
// note. Record-specific logic stays in the caller as data.
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
    emptyIds: boolean;
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
  const footer = (spec.emptyIds ? EMPTY_IDS_NOTE : '') + (issueSummary ? `\n\n${issueSummary}` : '');
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
    formatFull: item => formatArtifactFull(item.id, item.artifact, store.getProjectsForArtifact(item.id), store.getActionsForArtifact(item.id), store.getArtifactBacklinks(item.id), indexMap.get(item.id)?.description, store.getAttachmentFiles(item.id)),
    formatMeta: item => formatArtifactMeta(item.id, item.artifact, store.getProjectsForArtifact(item.id), store.getActionsForArtifact(item.id), store.getArtifactBacklinks(item.id), indexMap.get(item.id)?.description, store.getAttachmentFiles(item.id)),
    formatIndex: item => formatArtifactIndex(indexMap.get(item.id) ?? { id: item.id, description: item.artifact.frontMatter.name }),
    emptyIds: args.ids?.length === 0,
    issues: store.getIssues(),
  }, context);
}
