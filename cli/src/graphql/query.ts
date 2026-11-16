import { Store } from '../source/store.js';
import { resolve } from 'node:path';
import { validateToolArgs } from '../mcp/schemas.js';
import { defaultSearchMatcher, type SearchMatcher } from '../mcp/search.js';
import { CompiledRecurrence, projectedAction, projectionId, resolveProjection } from '../core/recurrence.js';
import { actionProjections } from '../core/action-projections.js';
import { isCalendarDate, scheduleInstant, wallTimeAt } from '../core/scheduling.js';
import { buildProjectRelations, type ProjectRelationNode } from './references.js';
import { GraphQLBudgetError } from './execution-budget.js';
import { rangeBoundary } from '../core/timestamp-range.js';
import { entryReferences } from '../core/record-reference.js';
import type { Action, ParseIssue, EntryMeta, ProjectFrontMatter, ActionFrontMatter, ArtifactFrontMatter, RelatedProject } from '../core/types.js';
import type {AttachmentFile} from '../core/attachment-metadata.js';

export type Kind = 'entry' | 'project' | 'action' | 'artifact';
export interface RecordNode {
  kind: Kind;
  id: string;
  description: string | null;
  handle: string;
  filePath: string | null;
  record: any;
  projected: boolean;
}
export type Where = Record<string, any>;
export interface DefaultProjectionRange {
  path: string;
  scheduledTo: string;
  templates: string[];
  message: string;
}
type Predicate = (node: RecordNode) => boolean;
const collections = { entry: 'entries', project: 'projects', action: 'actions', artifact: 'artifacts' } as const;
const relationKinds: Record<Kind, Partial<Record<string, Kind>>> = {
  entry: { projects: 'project', actions: 'action', artifacts: 'artifact' },
  project: { actions: 'action', entries: 'entry', artifacts: 'artifact', relatedProjects: 'project' },
  action: { projects: 'project', entries: 'entry', artifacts: 'artifact' },
  artifact: { projects: 'project', actions: 'action', entries: 'entry' },
};
const relationFields = Object.fromEntries(Object.entries(relationKinds).map(([kind, fields]) => [kind, Object.entries(fields)])) as Record<Kind, [string, Kind][]>;

// Copy mutable metadata branches before sharing a query snapshot.
function copyMetadata<T extends EntryMeta | ProjectFrontMatter | ActionFrontMatter | ArtifactFrontMatter>(source: T): T {
  const copy = { ...source };
  if ('recurrence' in copy && copy.recurrence) copy.recurrence = structuredClone(copy.recurrence);
  if ('occurrence' in copy && copy.occurrence) copy.occurrence = { ...copy.occurrence };
  if ('delegation' in copy && copy.delegation) copy.delegation = structuredClone(copy.delegation);
  if ('automations' in copy && copy.automations) copy.automations = structuredClone(copy.automations);
  if ('projects' in copy && copy.projects) copy.projects = [...copy.projects];
  if ('actions' in copy && copy.actions) copy.actions = [...copy.actions];
  if ('attachments' in copy && copy.attachments) copy.attachments = [...copy.attachments];
  if ('related_projects' in copy && copy.related_projects) copy.related_projects = copy.related_projects.map((link: RelatedProject) => ({ ...link }));
  return copy;
}

function hasSearch(where: unknown): boolean {
  if (where == null || typeof where !== 'object') return false;
  if (Array.isArray(where)) return where.some(hasSearch);
  return Object.entries(where).some(([key, value]) => (key === 'search' || key === 'regex') ? !!value : hasSearch(value));
}

function compareCreated(a: RecordNode, b: RecordNode): number {
  const createdA = a.projected ? undefined : (a.record.meta ?? a.record.frontMatter).created;
  const createdB = b.projected ? undefined : (b.record.meta ?? b.record.frontMatter).created;
  if (createdA == null || createdB == null) return createdA == null && createdB == null
    ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : createdA == null ? 1 : -1;
  return createdA < createdB ? -1 : createdA > createdB ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function projectionTruth(where: Where): boolean | undefined {
  const tests: (boolean | undefined)[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value == null) continue;
    if (key === 'createdFrom' || key === 'createdTo') tests.push(false);
    else if (key === 'recurrenceExists') tests.push(!value);
    else if (key === 'status') tests.push((Array.isArray(value) ? value : [value]).includes('scheduled'));
    else if (key === 'occurrence') tests.push(value.projected === false ? false
      : value.template != null || value.original != null ? undefined : true);
    else if (key === 'ids') tests.push(value.some((id: string) => id.startsWith('~')) ? undefined : false);
    else if (key === 'and') tests.push(andTruth(value.map(projectionTruth)));
    else if (key === 'or') {
      const branches = value.map(projectionTruth);
      tests.push(branches.includes(true) ? true : branches.every((result: boolean | undefined) => result === false) ? false : undefined);
    } else if (key === 'not') {
      const result = projectionTruth(value);
      tests.push(result === undefined ? undefined : !result);
    } else tests.push(undefined);
  }
  return andTruth(tests);
}

function andTruth(values: (boolean | undefined)[]): boolean | undefined {
  return values.includes(false) ? false : values.every(value => value === true) ? true : undefined;
}

function mayProject(where: Where): boolean { return projectionTruth(where) !== false; }

function positiveActionIds(where: Where): string[] {
  return [...(where.ids ?? []), ...[...(where.and ?? []), ...(where.or ?? [])].flatMap(positiveActionIds)];
}

// One finite conjunct is enough to avoid expansion. Leave intersections to the
// predicate, since a saved ID and its projection alias can name the same row.
function finiteActionIds(where: Where): string[] | undefined {
  if (where.ids != null) return where.ids;
  for (const child of where.and ?? []) {
    const ids = finiteActionIds(child);
    if (ids !== undefined) return ids;
  }
  if (where.or) {
    const branches = where.or.map(finiteActionIds);
    if (branches.every((ids: string[] | undefined) => ids !== undefined)) return branches.flat();
  }
  return undefined;
}

// Bounds belong to this ActionWhere's Boolean tree, never a related record's
// filter or a negated predicate. An unbounded OR branch keeps history unbounded.
function projectionBounds(where: Where): { from?: string; latestFrom?: string; to?: string } {
  let from = where.scheduledFrom ?? undefined, latestFrom = from, to = where.scheduledTo ?? undefined;
  const merge = (value: string | undefined, other: string | undefined) => !value ? other : !other ? value : value > other ? value : other;
  for (const child of where.and ?? []) {
    const bounds = projectionBounds(child);
    from = merge(from, bounds.from); latestFrom = merge(latestFrom, bounds.latestFrom); to = merge(to, bounds.to);
  }
  if (where.or?.length) {
    const branches = where.or.map(projectionBounds);
    const possible = where.or.filter(mayProject).map(projectionBounds);
    const lower = possible.length && possible.every((branch: {from?: string}) => branch.from)
      ? possible.map((branch: {from: string}) => branch.from).sort()[0] : undefined;
    from = merge(from, lower);
    for (const bounds of branches) { latestFrom = merge(latestFrom, bounds.latestFrom); to = merge(to, bounds.to); }
  }
  return { from, latestFrom, to };
}

function oneYearAfter(date: string): string {
  if (!isCalendarDate(date)) throw new Error('Date must be a valid YYYY-MM-DD calendar date.');
  const year = Math.min(9999, Number(date.slice(0, 4)) + 1);
  const next = `${String(year).padStart(4, '0')}${date.slice(4)}`;
  return isCalendarDate(next) ? next : `${String(year).padStart(4, '0')}-02-28`;
}

function hasActionRelations(where: Where): boolean {
  if (where == null || typeof where !== 'object') return false;
  if (Array.isArray(where)) return where.some(hasActionRelations);
  return !!where.actions || Object.values(where).some(value => typeof value === 'object' && hasActionRelations(value));
}

// Template prefiltering uses only values shared by its projected occurrences.
function templateNoticeWhere(where: Where): Where {
  const result: Where = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === 'scheduledFrom' || key === 'scheduledTo') continue;
    if (key === 'occurrence' && value) { const {original, ...rest} = value; result[key] = rest; }
    else if (key === 'and' || key === 'or') result[key] = value.map(templateNoticeWhere);
    else if (key === 'not') {
      const stripped = templateNoticeWhere(value);
      if (JSON.stringify(stripped) === JSON.stringify(value)) result[key] = stripped;
    } else result[key] = value;
  }
  return result;
}

function nextDate(date: string): string | undefined {
  return date === '9999-12-31' ? undefined
    : new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function projectionProbePoints(where: Where, dates = new Set<string>(), originals = new Set<string>(), ids = new Set<string>()) {
  if (where.scheduledFrom != null) dates.add(where.scheduledFrom);
  if (where.scheduledTo != null) {
    const after = nextDate(where.scheduledTo);
    if (after) dates.add(after);
  }
  if (where.occurrence?.original != null) originals.add(where.occurrence.original);
  for (const id of where.ids ?? []) ids.add(id);
  for (const child of [...(where.and ?? []), ...(where.or ?? []), ...(where.not ? [where.not] : [])]) {
    projectionProbePoints(child, dates, originals, ids);
  }
  return {dates, originals, ids};
}

function paginate(nodes: readonly RecordNode[], offset: number, limit: number, needsPage = true) {
  return { nodes: needsPage ? nodes.slice(offset, offset + limit) : [], offset, count: Math.min(limit, Math.max(0, nodes.length - offset)), totalCount: nodes.length };
}

export function status(node: RecordNode): string | null {
  const fm = node.record.frontMatter;
  if (node.kind === 'project') return fm.ended == null ? 'open' : 'closed';
  if (node.kind !== 'action') return null;
  if (fm.recurrence != null) return null;
  return fm.resolution ?? (fm.scheduled == null ? 'backlog' : 'scheduled');
}

// Store writes replace relationships, but can mutate metadata and indexes in
// place. Copy those once per revision so concurrent reads retain their snapshot.
class QuerySnapshot {
  readonly records: Record<Kind, Map<string, RecordNode>>;
  readonly issues: ParseIssue[];
  readonly attachments: ReadonlyMap<string, readonly AttachmentFile[]>;
  readonly referenceRoots: readonly string[];
  private readonly relations: ReturnType<Store['getRelations']>;
  private readonly entryArtifacts = new Map<string, string[]>();
  private readonly artifactEntries = new Map<string, string[]>();
  private readonly ordered = new Map<Kind, readonly RecordNode[]>();
  private readonly matches = new Map<string, readonly RecordNode[]>();
  private readonly actionTimes = new WeakMap<RecordNode, { scheduled: number | undefined; deadline: number | undefined }>();
  private matchedNodes = 0;
  private readonly recordRevision: number;
  private readonly indexRevisions: Record<Kind, number>;
  constructor(store: Store, previous?: QuerySnapshot) {
    this.issues = [...store.getIssues()];
    this.attachments = new Map([...store.getArtifacts().keys()].map(id => [id, store.getAttachmentFiles(id).map(file => ({...file}))]));
    this.referenceRoots = [...store.getReferenceRoots()];
    this.relations = store.getRelations();
    this.records = { entry: new Map(), project: new Map(), action: new Map(), artifact: new Map() };
    const indexes = {
      entry: store.getNoteIndex(), project: store.getProjectIndex(),
      action: store.getActionIndex(), artifact: store.getArtifactIndex(),
    };
    this.recordRevision = store.getRecordRevision();
    this.indexRevisions = {
      entry: store.getIndexRevision('notes'), project: store.getIndexRevision('projects'),
      action: store.getIndexRevision('actions'), artifact: store.getIndexRevision('artifacts'),
    };
    if (previous && previous.recordRevision === this.recordRevision) {
      // Index-only writes preserve all metadata, graph, and non-regex matches.
      // Copy the changed kind's nodes to keep older reads' descriptions stable.
      this.records = { ...previous.records };
      const changed = new Set<Kind>();
      for (const kind of Object.keys(this.records) as Kind[]) if (this.indexRevisions[kind] !== previous.indexRevisions[kind]) {
        changed.add(kind);
        const descriptions = new Map(indexes[kind].map(item => [item.id, item.description]));
        this.records[kind] = new Map([...previous.records[kind]].map(([id, node]) => {
          const description = descriptions.get(node.projected ? node.record.frontMatter.occurrence.template : id) ?? null;
          return [id, node.description === description ? node : { ...node, description }];
        }));
      }
      const refresh = (nodes: readonly RecordNode[]) => nodes.length && changed.has(nodes[0].kind)
        ? nodes.map(node => this.records[node.kind].get(node.id)!) : nodes;
      this.ordered = new Map([...previous.ordered].map(([kind, nodes]) => [kind, refresh(nodes)]));
      this.matches = new Map([...previous.matches].map(([key, nodes]) => [key, refresh(nodes)]));
      this.matchedNodes = previous.matchedNodes;
      this.entryArtifacts = previous.entryArtifacts;
      this.artifactEntries = previous.artifactEntries;
      this.issues.push(...previous.issues.filter(issue => issue.code === 'graphql_missing_relationship_target'));
      return;
    }
    for (const kind of Object.keys(this.records) as Kind[]) {
      const descriptions = new Map(indexes[kind].map(item => [item.id, item.description]));
      const records = kind === 'entry'
        ? store.getEntries().map(entry => [entry.meta.created, entry] as const)
        : [...(kind === 'project' ? store.getProjects() : kind === 'action' ? store.getActions() : store.getArtifacts())];
      for (const [id, source] of records) {
        const record = 'meta' in source
          ? { ...source, meta: copyMetadata(source.meta) }
          : { ...source, frontMatter: copyMetadata(source.frontMatter) };
        const filePath = kind === 'entry' ? store.getEntryFile(id) : kind === 'project' ? store.getProjectFile(id)
          : kind === 'action' ? store.getActionFile(id) : store.getArtifactFile(id);
        this.records[kind].set(id, { kind, id, record, description: descriptions.get(id) ?? null,
          handle: `#${kind}/${id}`, filePath: filePath ? resolve(filePath) : null, projected: false });
      }
    }
    // Attachment reconciliation failures can change metadata without replacing
    // the graph. Recopy metadata, but reuse derived maps and missing targets.
    if (previous && previous.relations === this.relations) {
      this.entryArtifacts = previous.entryArtifacts;
      this.artifactEntries = previous.artifactEntries;
    } else {
      for (const [source, artifacts] of this.relations.artifactsByEntity) {
        if (!source.startsWith('#entry/')) continue;
        const id = source.slice(7);
        this.entryArtifacts.set(id, [...artifacts]);
        for (const artifact of artifacts) {
          const entries = this.artifactEntries.get(artifact) ?? [];
          entries.push(id);
          this.artifactEntries.set(artifact, entries);
        }
      }
    }
    for (const kind of Object.keys(this.records) as Kind[]) for (const node of this.records[kind].values()) {
      if (kind === 'project') for (const link of node.record.frontMatter.related_projects ?? []) {
        if (!this.records.project.has(link.project)) this.issues.push({severity: 'error', code: 'graphql_missing_relationship_target',
          field: 'relatedProjects', file: node.filePath ?? node.handle,
          message: `${node.handle} references a missing project: ${link.project}. Repair the source declaration.`});
      }
      for (const [field, target] of relationFields[kind]) {
        let missing: Set<string> | undefined;
        for (const id of this.relationIds(node, field)) if (!this.records[target].has(id) && !missing?.has(id)) {
          (missing ??= new Set()).add(id);
          this.issues.push({ severity: 'warning', code: 'graphql_missing_relationship_target', field, file: node.filePath ?? node.handle,
            message: `${node.handle} references a missing ${target}: ${id}. Relationship results may be incomplete.` });
        }
      }
    }
  }

  relationIds(node: RecordNode, field: string): string[] {
    const r = this.relations;
    const projectedTemplate = node.kind === 'action' && node.projected
      ? (node.record as Action).frontMatter.occurrence?.template : undefined;
    if (node.kind === 'entry') {
      if (field === 'artifacts') return this.entryArtifacts.get(node.id) ?? [];
      return node.record.meta[field] ?? [];
    }
    if (field === 'entries') {
      return node.kind === 'artifact'
        ? this.artifactEntries.get(node.id) ?? []
        : r.entriesByEntity.get(node.handle) ?? [];
    }
    // Projections inherit the template's body and contextual artifact links,
    // without becoming persistent sources in the relationship graph.
    if (field === 'artifacts') return r.artifactsByEntity.get(projectedTemplate ? `#action/${projectedTemplate}` : node.handle) ?? [];
    if (node.kind === 'project') {
      if (field === 'actions') return r.actionsByProject.get(node.id) ?? [];
      if (field === 'relatedProjects') return this.relatedProjectRelations(node).map(link => link.project.id);
    }
    if (node.kind === 'action' && field === 'projects') return r.projectsByAction.get(projectedTemplate ?? node.id) ?? [];
    if (node.kind === 'artifact') {
      if (field === 'projects') return r.projectsByArtifact.get(node.id) ?? [];
      if (field === 'actions') return r.actionsByArtifact.get(node.id) ?? [];
    }
    return [];
  }

  private projectRelations?: Map<string, ProjectRelationNode[]>;
  relatedProjectRelations(node: RecordNode): readonly ProjectRelationNode[] {
    this.projectRelations ??= buildProjectRelations(this.records.project);
    return this.projectRelations.get(node.id) ?? [];
  }

  inCreatedOrder(kind: Kind): readonly RecordNode[] {
    let rows = this.ordered.get(kind);
    if (!rows) {
      rows = [...this.records[kind].values()].sort(compareCreated);
      this.ordered.set(kind, rows);
    }
    return rows;
  }

  cachedMatches(key: string): readonly RecordNode[] | undefined {
    const rows = this.matches.get(key);
    if (rows) { this.matches.delete(key); this.matches.set(key, rows); }
    return rows;
  }

  rememberMatches(key: string, rows: readonly RecordNode[]): void {
    // Bound retained keys and references independently of dataset size. Store
    // only complete successful non-regex root results, never predicates/workers.
    if (key.length > 8_192 || rows.length > 100_000) return;
    const previous = this.matches.get(key);
    if (previous) this.matchedNodes -= previous.length;
    this.matches.delete(key);
    this.matches.set(key, rows); this.matchedNodes += rows.length;
    while (this.matches.size > 32 || this.matchedNodes > 100_000) {
      const oldest = this.matches.keys().next().value!;
      this.matchedNodes -= this.matches.get(oldest)!.length;
      this.matches.delete(oldest);
    }
  }

  inActionTimeOrder(nodes: readonly RecordNode[], orderBy: string): readonly RecordNode[] {
    const field = orderBy.startsWith('SCHEDULED_') ? 'scheduled' : 'deadline';
    const direction = orderBy.endsWith('_ASC') ? 1 : -1;
    const value = (node: RecordNode) => {
      let times = this.actionTimes.get(node);
      if (!times) {
        const fm = node.record.frontMatter as ActionFrontMatter;
        // The named zone qualifies scheduling only. Deadlines are authored local
        // clocks; all-day values ignore a named scheduling zone.
        times = {
          scheduled: fm.scheduled == null ? undefined : scheduleInstant(fm.scheduled, fm.timezone),
          deadline: fm.deadline == null ? undefined : scheduleInstant(fm.deadline),
        };
        this.actionTimes.set(node, times);
      }
      return times[field];
    };
    // Resolve named-zone clocks once per record, outside the comparator: Intl
    // resolution costs must not multiply with sort comparisons.
    for (const node of nodes) value(node);
    return [...nodes].sort((a, b) => {
      const av = value(a), bv = value(b);
      if (av == null || bv == null) return av == null && bv == null ? compareCreated(a, b) : av == null ? 1 : -1;
      return direction * (av - bv) || compareCreated(a, b);
    });
  }
}

// Only the latest snapshot is retained by the cache. Older snapshots live as
// long as their active requests; the Store itself is weakly referenced.
const snapshots = new WeakMap<Store, { revision: number; snapshot: QuerySnapshot }>();

export class QueryView {
  readonly records: Record<Kind, ReadonlyMap<string, RecordNode>>;
  readonly issues: ParseIssue[];
  readonly attachments: ReadonlyMap<string, readonly AttachmentFile[]>;
  readonly referenceRoots: readonly string[];
  private readonly snapshot: QuerySnapshot;
  private readonly predicates = new Map<string, Promise<Predicate>>();
  private work = 0;
  private savedActions?: Map<string, Action>;
  private occurrenceActions?: Map<string, RecordNode>;
  private exactProjections = new Map<string, RecordNode | undefined>();
  private readonly now: Date;
  private readonly actionRecords: Map<string, RecordNode>;
  private readonly expansions = new Map<string, { nodes: RecordNode[]; limitedTemplates: string[] }>();
  private readonly ranges = new Map<string, DefaultProjectionRange>();
  get defaultProjectionRanges(): DefaultProjectionRange[] { return [...this.ranges.values()]; }

  constructor(
    store: Store, private matcher: SearchMatcher = defaultSearchMatcher(), private signal?: AbortSignal,
    private onBudgetExceeded: (message: string) => never = message => { throw new GraphQLBudgetError(message); },
  ) {
    const revision = store.getRevision();
    const minute = Math.floor(Date.now() / 60_000);
    this.now = new Date(minute * 60_000);
    let cached = snapshots.get(store);
    if (!cached || cached.revision !== revision) {
      cached = { revision, snapshot: new QuerySnapshot(store, cached?.snapshot) };
      snapshots.set(store, cached);
    }
    this.snapshot = cached.snapshot;
    this.actionRecords = new Map(this.snapshot.records.action);
    this.records = {...this.snapshot.records, action: this.actionRecords};
    this.issues = [...this.snapshot.issues];
    this.attachments = this.snapshot.attachments;
    this.referenceRoots = this.snapshot.referenceRoots;
  }

  action(id: string): RecordNode | undefined {
    this.tick();
    const node = this.records.action.get(id);
    if (node) return node;
    if (!id.startsWith('~')) return undefined;
    if (!this.savedActions) {
      this.savedActions = new Map(); this.occurrenceActions = new Map();
      for (const [savedId, candidate] of this.records.action) {
        if (candidate.projected) continue;
        const occurrence = candidate.record.frontMatter.occurrence;
        if (occurrence) this.occurrenceActions.set(projectionId(occurrence), candidate);
        this.savedActions.set(savedId, candidate.record);
      }
    }
    const saved = this.occurrenceActions!.get(id);
    if (saved) return saved;
    if (this.exactProjections.has(id)) return this.exactProjections.get(id);
    const action = resolveProjection(this.savedActions, id);
    const projection: RecordNode | undefined = action ? {kind: 'action', id, record: action, projected: true, filePath: null,
      description: this.records.action.get(action.frontMatter.occurrence!.template)?.description ?? null, handle: `#action/${id}`} : undefined;
    this.exactProjections.set(id, projection);
    if (projection) this.actionRecords.set(id, projection);
    return projection;
  }

  private tick(): void {
    if (this.signal?.aborted) throw new Error('GraphQL request cancelled.');
    if (++this.work > 100_000) this.onBudgetExceeded('GraphQL query work limit exceeded. Narrow action projection dates with scheduledFrom and scheduledTo, or reduce query nesting.');
  }

  relationIds(node: RecordNode, field: string): string[] { return this.snapshot.relationIds(node, field); }
  relatedProjectRelations(node: RecordNode) { return this.snapshot.relatedProjectRelations(node); }

  private relatedNodes(node: RecordNode, field: string, actions?: readonly RecordNode[]): RecordNode[] {
    const target = relationKinds[node.kind][field]!;
    const ids = new Set(this.relationIds(node, field));
    const saved = [...ids].map(id => this.records[target].get(id)).filter((row): row is RecordNode => !!row);
    if (target !== 'action' || node.kind !== 'project' && node.kind !== 'artifact') return saved;
    return [...saved, ...(actions ?? []).filter(row => row.projected && ids.has(row.record.frontMatter.occurrence.template))];
  }

  private projectionNode(id: string, action: Action, remember = true): RecordNode {
    const template = action.frontMatter.occurrence!.template;
    const node: RecordNode = {kind: 'action', id, record: action, projected: true, filePath: null,
      description: this.snapshot.records.action.get(template)?.description ?? null, handle: `#action/${id}`};
    if (remember) this.actionRecords.set(id, node);
    return node;
  }

  private templateEligible(where: Where, template: string, action: Action): boolean {
    const metadata = {...action.frontMatter, recurrence: undefined, scheduled: '2000-01-01', occurrence: {template, original: ''}};
    const sample: RecordNode = {kind: 'action', id: '', record: {...action, frontMatter: metadata},
      projected: true, filePath: null, description: null, handle: ''};
    const stripped = templateNoticeWhere(where);
    // These fields are invariant across a template's unsaved occurrences.
    // Unknown predicates (text, relationships, negation) stay conservative.
    const args = this.scalarArgs('action', stripped);
    delete args.ids;
    if (!this.scalarPredicate(args)(sample)) return false;
    if (where.ids != null && !where.ids.some((id: string) => id.startsWith(`~${encodeURIComponent(template)}@`))) return false;
    if (where.occurrence?.template != null && where.occurrence.template !== template || where.occurrence?.projected === false
      || where.recurrenceExists === true) return false;
    if (where.and?.some((child: Where) => !this.templateEligible(child, template, action))) return false;
    return !where.or || where.or.some((child: Where) => this.templateEligible(child, template, action));
  }

  private actionCandidates(where: Where, parent?: RecordNode, field?: string, allowedTemplates?: ReadonlySet<string>) {
    const saved = parent ? this.relatedNodes(parent, field!) : [...this.snapshot.records.action.values()];
    const relationIds = new Set(parent ? this.relationIds(parent, field!) : []);
    const resolveIds = (requested: string[]) => {
      const resolved = [...new Set(requested)].map(id => this.action(id)).filter((node): node is RecordNode => !!node);
      return [...new Map(resolved.map(node => [node.id, node])).values()].filter(node =>
        !parent || relationIds.has(node.id) || node.projected && (parent.kind === 'project' || parent.kind === 'artifact')
          && relationIds.has(node.record.frontMatter.occurrence.template));
    };
    const finiteIds = finiteActionIds(where);
    if (finiteIds !== undefined) return {nodes: resolveIds(finiteIds), defaulted: false, to: '', limitedTemplates: [] as string[]};
    if (!mayProject(where)) return {nodes: saved, defaulted: false, to: '', limitedTemplates: [] as string[]};
    const exact = resolveIds(positiveActionIds(where));
    const combine = (nodes: RecordNode[]) => [...new Map([...nodes, ...exact].map(node => [node.id, node])).values()];
    const bounds = projectionBounds(where), today = wallTimeAt(this.now.getTime()).slice(0, 10);
    const to = bounds.to ?? oneYearAfter(bounds.latestFrom && bounds.latestFrom > today ? bounds.latestFrom : today);
    const templates = new Map([...this.snapshot.records.action].filter(([id, node]) => node.record.frontMatter.recurrence != null
      && this.templateEligible(where, id, node.record)
      && (!allowedTemplates || allowedTemplates.has(id))
      && (!parent || (parent.kind === 'project' || parent.kind === 'artifact') && this.relationIds(parent, field!).includes(id)))
      .map(([id, node]) => [id, node.record as Action]));
    if (!templates.size || bounds.from && bounds.from > to) return {nodes: combine(saved), defaulted: !bounds.to, to, limitedTemplates: [] as string[]};
    const key = JSON.stringify([bounds.from, to, [...templates.keys()]]);
    let expansion = this.expansions.get(key);
    if (!expansion) {
      const actions = new Map([...this.snapshot.records.action].filter(([, node]) => !node.record.frontMatter.recurrence
        || templates.has(node.id)).map(([id, node]) => [id, node.record as Action]));
      const result = actionProjections(actions, {from: bounds.from, to, tick: () => this.tick()});
      for (const message of result.issues) if (!this.issues.some(issue => issue.code === 'graphql_recurrence_projection' && issue.message === message)) {
        this.issues.push({severity: 'warning', code: 'graphql_recurrence_projection', field: 'recurrence', message});
      }
      expansion = {nodes: result.nodes.map(({id, action}) => this.projectionNode(id, action)), limitedTemplates: result.limitedTemplates};
      this.expansions.set(key, expansion);
    }
    return {nodes: combine([...saved, ...expansion.nodes]), defaulted: !bounds.to, to, limitedTemplates: expansion.limitedTemplates};
  }

  private async notice(where: Where, expansion: ReturnType<QueryView['actionCandidates']>, path: string, filterPath = path + '.where'): Promise<void> {
    if (!expansion.defaulted || !expansion.limitedTemplates.length) return;
    const after = nextDate(expansion.to);
    if (!after) return;
    const points = projectionProbePoints(where);
    const starts = [...new Set([after, ...points.dates].filter(date => date > expansion.to))].sort();
    const included = new Set(expansion.nodes.map(node => node.id));
    const saved = new Set([...this.snapshot.records.action.values()].flatMap(node =>
      node.record.frontMatter.occurrence ? [projectionId(node.record.frontMatter.occurrence)] : []));
    const samples = new Map<string, RecordNode>();
    for (const template of expansion.limitedTemplates) {
      const action = this.snapshot.records.action.get(template)!.record as Action;
      const originals = new Set(points.originals);
      const prefix = `~${encodeURIComponent(template)}@`;
      for (const id of points.ids) if (id.startsWith(prefix)) {
        try { originals.add(decodeURIComponent(id.slice(prefix.length))); } catch {}
      }
      const add = (next: {identity: NonNullable<ActionFrontMatter['occurrence']>; scheduled: string}) => {
        const id = projectionId(next.identity);
        if (next.scheduled.slice(0, 10) > expansion.to && !saved.has(id) && !included.has(id)) {
          samples.set(id, this.projectionNode(id, projectedAction(action, next.identity, next.scheduled), false));
        }
        return id;
      };
      // Date predicates change only at their boundaries. Probe each resulting
      // interval, plus exact identities, without enumerating the excluded future.
      for (const schedule of action.frontMatter.recurrence!) {
        const rule = new CompiledRecurrence(schedule);
        for (const original of originals) {
          this.tick();
          const next = rule.contains(template, original);
          if (next) add(next);
        }
        for (const start of starts) for (const next of rule.occurrences(template, start, '9999-12-31')) {
          this.tick();
          const id = add(next);
          if (!saved.has(id) && !included.has(id) && !points.ids.has(id) && !originals.has(next.identity.original)) break;
        }
      }
    }
    const nodes = [...samples.values()];
    const predicate = await this.compile('action', where, 0, nodes, path, filterPath);
    const templates = nodes.filter(node => predicate(node)).map(node => node.record.frontMatter.occurrence.template as string);
    if (!templates.length) return;
    const key = `${path}:${expansion.to}`, previous = this.ranges.get(key);
    this.ranges.set(key, {path, scheduledTo: expansion.to, templates: [...new Set([...(previous?.templates ?? []), ...templates])].sort(),
      message: `Projected occurrences for these recurring templates are generated through ${expansion.to} by default (one year). Saved actions are unaffected. Use an explicit scheduledFrom and scheduledTo date range to query projections outside this limit.`});
  }

  /** Unified search reuses entity predicates over saved source records. */
  async selectSaved(kind: Kind, where: Where = {}): Promise<RecordNode[]> {
    const candidates = [...this.records[kind].values()].filter(node => !node.projected);
    const predicate = await this.compile(kind, where, 0, candidates);
    return candidates.filter(node => { this.tick(); return predicate(node); });
  }

  private scalarArgs(kind: Kind, where: Where): Where {
    if (where.regex != null && where.search != null) throw new Error('Use either regex or the legacy search alias in one filter, not both.');
    const args: Where = {};
    for (const [key, value] of Object.entries(where)) {
      if (value == null || ['and', 'or', 'not'].includes(key) || key in relationKinds[kind]
        || kind === 'action' && ['occurrence', 'recurrenceExists'].includes(key) || kind === 'entry' && key === 'browse') continue;
      const storedKey = key === 'regex' ? 'search' : key === 'projectIds' ? 'projects' : key === 'actionIds' ? 'actions' : key === 'relatedTo' ? 'related_to'
        : key.replace(/(From|To)$/, suffix => suffix === 'From' ? '_from' : '_to');
      args[storedKey] = value;
    }
    return validateToolArgs(`query_${collections[kind]}`, args);
  }

  private scalarPredicate(args: Where): Predicate {
    const tests: Predicate[] = [];
    if (args.ids) {
      const ids = new Set<string>(args.ids);
      tests.push(node => ids.has(node.id) || node.kind === 'action' && node.record.frontMatter.occurrence
        && ids.has(projectionId(node.record.frontMatter.occurrence)));
    }
    if (args.status) {
      const statuses = new Set<string>(Array.isArray(args.status) ? args.status : [args.status]);
      tests.push(node => {
        const current = status(node);
        return current != null && statuses.has(current);
      });
    }
    for (const field of ['created', 'scheduled', 'deadline', 'ended']) {
      const from = args[`${field}_from`], to = args[`${field}_to`];
      if (from == null && to == null) continue;
      tests.push(node => {
        const value = node.projected && field === 'created' ? undefined : (node.record.meta ?? node.record.frontMatter)[field]?.slice(0, 10);
        return value != null && (from == null || value >= from) && (to == null || value <= to);
      });
    }
    for (const field of ['projects', 'actions', 'related_to']) {
      if (!args[field]) continue;
      const wanted = new Set<string>(args[field]);
      tests.push(node => {
        // Match resolved outgoing declarations, excluding incoming-only links.
        const ids: string[] = field === 'related_to'
          ? this.relatedProjectRelations(node).filter(link => link.direction !== 'incoming').map(link => link.project.id)
          : this.relationIds(node, field);
        return wanted.size ? ids.some(id => wanted.has(id)) : ids.length === 0;
      });
    }
    return tests.length ? node => tests.every(test => test(node)) : () => true;
  }

  async compile(kind: Kind, where: Where = {}, depth = 0, scope?: readonly RecordNode[], path = kind + 's', filterPath = path + '.where'): Promise<Predicate> {
    this.signal?.throwIfAborted();
    if (depth > 12) this.onBudgetExceeded('GraphQL filter nesting exceeds 12 levels.');
    // Without regex, predicates are valid for any node of their kind. Regex
    // must retain its candidate scope to preserve the worker's capacity limits.
    const key = `${kind}:${depth}:${JSON.stringify(where)}:${scope && (hasSearch(where) || hasActionRelations(where)) ? JSON.stringify(scope.map(node => node.id)) : '*'}:${hasActionRelations(where) ? filterPath : ''}`;
    let compiled = this.predicates.get(key);
    if (!compiled) {
      compiled = this.compileUncached(kind, where, depth, scope, path, filterPath);
      this.predicates.set(key, compiled);
    }
    return compiled;
  }

  private async compileUncached(kind: Kind, where: Where, depth: number, scope: readonly RecordNode[] | undefined, path: string, filterPath: string): Promise<Predicate> {
    const args = this.scalarArgs(kind, where);
    for (const field of ['created', 'scheduled', 'deadline', 'ended']) {
      if (args[`${field}_from`] && args[`${field}_to`] && args[`${field}_from`] > args[`${field}_to`]) {
        throw new Error(`${field}From must be on or before ${field}To.`);
      }
    }
    const baseScalar = this.scalarPredicate(args);
    const occurrence = kind === 'action' ? where.occurrence : undefined;
    const recurrenceExists = kind === 'action' ? where.recurrenceExists : undefined;
    const scalar: Predicate = occurrence == null && recurrenceExists == null ? baseScalar : node => {
      if (!baseScalar(node)) return false;
      const fm = node.record.frontMatter;
      if (recurrenceExists != null && (fm.recurrence != null) !== recurrenceExists) return false;
      if (occurrence == null) return true;
      const metadata = fm.occurrence;
      return !!metadata && (occurrence.projected == null || node.projected === occurrence.projected)
        && (occurrence.template == null || metadata.template === occurrence.template)
        && (occurrence.original == null || metadata.original === occurrence.original);
    };
    const tests: Predicate[] = [scalar];
    if (kind === 'entry' && where.browse != null) {
      const { project, action, search, createdFrom, createdTo } = where.browse;
      const from = createdFrom == null ? undefined : rangeBoundary(createdFrom);
      const to = createdTo == null ? undefined : rangeBoundary(createdTo, true);
      if (from && to && from > to) throw new Error('Date range start must not follow its end.');
      if (project != null && action != null) throw new Error('Entry browsing accepts one project or action, not both.');
      const ref = project != null ? { type: 'project' as const, id: project }
        : action != null ? { type: 'action' as const, id: action } : null;
      const needle = (search ?? '').trim().toLowerCase();
      tests.push(node => (!from || rangeBoundary(node.id) >= from) && (!to || rangeBoundary(node.id) <= to)
        && (!ref || entryReferences(node.record, ref)) && (!needle
        || [node.id, node.description ?? '', node.record.content].some(text => text.toLowerCase().includes(needle))));
    }
    let narrowed: RecordNode[] | undefined;
    const narrowScope = () => narrowed ??= [...(scope ?? this.records[kind].values())].filter(node => {
      this.tick();
      return scalar(node);
    });
    // Not async: each caller decides where a synchronous narrowing failure surfaces.
    const nested = (filter: Where, suffix: string) => this.compile(kind, filter, depth + 1,
      hasSearch(filter) || hasActionRelations(filter) ? narrowScope() : undefined, path, `${filterPath}.${suffix}`);
    if (where.and) {
      const predicates = await Promise.all(where.and.map(async (filter: Where, index: number) => nested(filter, `and.${index}`)));
      tests.push(node => predicates.every(p => p(node)));
    }
    if (where.or) {
      const predicates = await Promise.all(where.or.map(async (filter: Where, index: number) => nested(filter, `or.${index}`)));
      tests.push(node => predicates.some(p => p(node)));
    }
    if (where.not) {
      const predicate = await nested(where.not, 'not');
      tests.push(node => !predicate(node));
    }
    for (const [field, target] of relationFields[kind]) {
      const relation = where[field];
      if (!relation) continue;
      for (const operator of ['some', 'none']) {
        if (relation[operator] == null) continue;
        const relatedWhere = relation[operator], relationPath = `${filterPath}.${field}.${operator}`;
        let actionScope: ReturnType<QueryView['actionCandidates']> | undefined;
        if (target === 'action') {
          const allowedTemplates = new Set(narrowScope().flatMap(node => node.kind === 'project' || node.kind === 'artifact'
            ? this.relationIds(node, field) : []));
          actionScope = this.actionCandidates(relatedWhere, undefined, undefined, allowedTemplates);
          await this.notice(relatedWhere, actionScope, relationPath, relationPath);
        }
        const scoped = hasSearch(relatedWhere) || hasActionRelations(relatedWhere);
        const relatedScope = scoped ? [...new Map(narrowScope().flatMap(node => this.relatedNodes(node, field, actionScope?.nodes))
          .map(node => [node.id, node])).values()] : undefined;
        const predicate = await this.compile(target, relatedWhere, depth + 1, relatedScope, relationPath, relationPath);
        if (operator === 'none' && this.issues.length) throw new Error('Cannot evaluate none with record diagnostics: absence is unconfirmed. Inspect diagnostics and repair the records.');
        tests.push(node => {
          const ids = this.relationIds(node, field);
          if (operator === 'none' && ids.some(id => !this.records[target].has(id))) {
            throw new Error(`Cannot evaluate ${field}.none: a referenced record is missing.`);
          }
          const found = this.relatedNodes(node, field, actionScope?.nodes).some(related => {
            this.tick(); return predicate(related);
          });
          return operator === 'some' ? found : !found;
        });
      }
    }
    const pattern = args.search;
    if (pattern) {
      // Apply already compiled filters before reserving worker capacity. For a
      // nested collection, unrelated records must not consume its search budget.
      const candidates = (narrowed ?? [...(scope ?? this.records[kind].values())]).filter(node => { this.tick(); return tests.every(test => test(node)); });
      const texts = candidates.map(node => node.kind === 'entry'
        ? [node.record.content, node.description ?? '']
        : [node.record.frontMatter.name, node.description ?? '', node.record.body]);
      const indices = await this.matcher.match(pattern, texts, { signal: this.signal });
      const matching = new Set(indices.map(index => candidates[index].id));
      tests.push(node => matching.has(node.id));
    }
    const results = new Map<string, boolean>();
    return node => {
      if (results.has(node.id)) return results.get(node.id)!;
      this.tick();
      const result = tests.every(test => test(node));
      results.set(node.id, result);
      return result;
    };
  }

  async list(kind: Kind, args: Where, parent?: RecordNode, field?: string, needsPage = true, path = field ?? kind + 's') {
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be from 1 to 100.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative integer.');
    const orderBy = args.orderBy ?? 'CREATED_DESC';
    const ascending = orderBy === 'CREATED_ASC';
    const timeOrder = kind === 'action' && /^(SCHEDULED|DEADLINE)_(ASC|DESC)$/.test(orderBy);
    const page = (nodes: readonly RecordNode[]) => {
      if (!needsPage) return paginate(nodes, offset, limit, false);
      if (timeOrder) return paginate(this.snapshot.inActionTimeOrder(nodes, orderBy), offset, limit);
      // Missing creation times stay last in both directions. Reverse only saved
      // rows; projected rows retain a stable ID order across pages.
      const saved = nodes.filter(node => !node.projected), projected = nodes.filter(node => node.projected);
      return paginate([...ascending ? saved : [...saved].reverse(), ...projected], offset, limit);
    };
    const where = args.where ?? {};
    const hasTemplates = [...this.snapshot.records.action.values()].some(node => node.record.frontMatter.recurrence != null);
    const dynamic = hasTemplates && (kind === 'action' && (mayProject(where) && where.ids == null
      || positiveActionIds(where).some(id => id.startsWith('~'))) || hasActionRelations(where));
    const cacheKey = parent || hasSearch(where) || dynamic ? undefined : `${kind}:${JSON.stringify(where)}`;
    const cached = cacheKey === undefined ? undefined : this.snapshot.cachedMatches(cacheKey);
    if (cached) { this.tick(); return page(cached); }
    const exactIds: string[] | undefined = where.ids ?? undefined;
    const expansion = kind === 'action' ? this.actionCandidates(where, parent, field) : undefined;
    const candidates = expansion?.nodes ?? (parent ? this.relatedNodes(parent, field!)
      : exactIds ? [...new Set(exactIds)].map(id => this.records[kind].get(id)).filter((node): node is RecordNode => !!node)
        : needsPage ? [...this.snapshot.inCreatedOrder(kind)] : [...this.records[kind].values()]);
    const predicate = await this.compile(kind, where, 0, candidates, path);
    if (expansion) await this.notice(where, expansion, path);
    const nodes = candidates.filter(node => { this.tick(); return predicate(node); });
    nodes.sort(compareCreated);
    if (cacheKey !== undefined) this.snapshot.rememberMatches(cacheKey, nodes);
    return page(nodes);
  }
}
