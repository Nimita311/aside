import { Store } from '../mcp/store.js';
import { resolve } from 'node:path';
import { validateToolArgs } from '../mcp/schemas.js';
import { defaultSearchMatcher, type SearchMatcher } from '../mcp/search.js';
import { projectionId, resolveProjection } from '../core/recurrence.js';
import { futureActionProjections } from '../core/action-projections.js';
import { scheduleInstant } from '../core/scheduling.js';
import { buildProjectRelations, type ProjectRelationNode } from './references.js';
import { GraphQLBudgetError } from './execution-budget.js';
import type { Action, ParseIssue, EntryMeta, ProjectFrontMatter, ActionFrontMatter, ArtifactFrontMatter, RelatedProject } from '../core/types.js';

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
  return Object.entries(where).some(([key, value]) => key === 'search' ? !!value : hasSearch(value));
}

function compareCreated(a: RecordNode, b: RecordNode): number {
  const createdA = (a.record.meta ?? a.record.frontMatter).created;
  const createdB = (b.record.meta ?? b.record.frontMatter).created;
  return createdA < createdB ? -1 : createdA > createdB ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function paginate(nodes: readonly RecordNode[], ascending: boolean, offset: number, limit: number, needsPage: boolean) {
  const page = !needsPage ? [] : ascending ? nodes.slice(offset, offset + limit)
    : nodes.slice(Math.max(0, nodes.length - offset - limit), Math.max(0, nodes.length - offset)).reverse();
  return { nodes: page, offset, count: Math.min(limit, Math.max(0, nodes.length - offset)), totalCount: nodes.length };
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
  private readonly relations: ReturnType<Store['getRelations']>;
  private readonly entryArtifacts = new Map<string, string[]>();
  private readonly artifactEntries = new Map<string, string[]>();
  private readonly projectedActionsByProject = new Map<string, string[]>();
  private readonly projectedActionsByArtifact = new Map<string, string[]>();
  private readonly ordered = new Map<Kind, readonly RecordNode[]>();
  private readonly matches = new Map<string, readonly RecordNode[]>();
  private readonly actionTimes = new WeakMap<RecordNode, { scheduled: number | undefined; deadline: number | undefined }>();
  private matchedNodes = 0;
  private readonly recordRevision: number;
  private readonly indexRevisions: Record<Kind, number>;
  constructor(store: Store, private readonly projectionClock: string, now: Date, previous?: QuerySnapshot) {
    this.issues = [...store.getIssues()];
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
    if (previous && previous.recordRevision === this.recordRevision && previous.projectionClock === this.projectionClock) {
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
      this.projectedActionsByProject = previous.projectedActionsByProject;
      this.projectedActionsByArtifact = previous.projectedActionsByArtifact;
      this.issues.push(...previous.issues.filter(issue => issue.code === 'graphql_missing_relationship_target' || issue.code === 'graphql_recurrence_projection'));
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
    const savedActions = new Map([...this.records.action].map(([id, node]) => [id, node.record as Action]));
    const projections = futureActionProjections(savedActions, {
      now, lookaheadDays: store.getInstance()?.manifest.config?.recurrenceLookaheadDays,
    });
    this.issues.push(...projections.issues.map(message => ({ severity: 'warning' as const,
      code: 'graphql_recurrence_projection', field: 'recurrence', message })));
    for (const { id, action } of projections.nodes) {
      const template = action.frontMatter.occurrence!.template;
      this.records.action.set(id, { kind: 'action', id, record: action, projected: true, filePath: null,
        description: this.records.action.get(template)?.description ?? null, handle: `#action/${id}` });
      for (const project of this.relations.projectsByAction.get(template) ?? []) {
        const ids = this.projectedActionsByProject.get(project) ?? [];
        ids.push(id); this.projectedActionsByProject.set(project, ids);
      }
      for (const artifact of this.relations.artifactsByEntity.get(`#action/${template}`) ?? []) {
        const ids = this.projectedActionsByArtifact.get(artifact) ?? [];
        ids.push(id); this.projectedActionsByArtifact.set(artifact, ids);
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
      if (field === 'actions') return [...(r.actionsByProject.get(node.id) ?? []), ...(this.projectedActionsByProject.get(node.id) ?? [])];
      if (field === 'relatedProjects') return this.relatedProjectRelations(node).map(link => link.project.id);
    }
    if (node.kind === 'action' && field === 'projects') return r.projectsByAction.get(projectedTemplate ?? node.id) ?? [];
    if (node.kind === 'artifact') {
      if (field === 'projects') return r.projectsByArtifact.get(node.id) ?? [];
      if (field === 'actions') return [...(r.actionsByArtifact.get(node.id) ?? []), ...(this.projectedActionsByArtifact.get(node.id) ?? [])];
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
const snapshots = new WeakMap<Store, { revision: number; projectionClock: string; snapshot: QuerySnapshot }>();

export class QueryView {
  readonly records: Record<Kind, ReadonlyMap<string, RecordNode>>;
  readonly issues: readonly ParseIssue[];
  private readonly snapshot: QuerySnapshot;
  private readonly predicates = new Map<string, Promise<Predicate>>();
  private work = 0;
  private savedActions?: Map<string, Action>;
  private occurrenceActions?: Map<string, RecordNode>;
  private exactProjections = new Map<string, RecordNode | undefined>();

  constructor(
    store: Store, private matcher: SearchMatcher = defaultSearchMatcher(), private signal?: AbortSignal,
    private onBudgetExceeded: (message: string) => never = message => { throw new GraphQLBudgetError(message); },
  ) {
    const revision = store.getRevision();
    const minute = Math.floor(Date.now() / 60_000);
    const projectionClock = `${minute}:${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    let cached = snapshots.get(store);
    if (!cached || cached.revision !== revision || cached.projectionClock !== projectionClock) {
      cached = { revision, projectionClock, snapshot: new QuerySnapshot(store, projectionClock, new Date(minute * 60_000), cached?.snapshot) };
      snapshots.set(store, cached);
    }
    this.snapshot = cached.snapshot;
    this.records = this.snapshot.records;
    this.issues = this.snapshot.issues;
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
    return projection;
  }

  private tick(): void {
    if (this.signal?.aborted) throw new Error('GraphQL request cancelled.');
    if (++this.work > 100_000) this.onBudgetExceeded('GraphQL query work limit exceeded. Narrow the query or reduce nesting.');
  }

  relationIds(node: RecordNode, field: string): string[] { return this.snapshot.relationIds(node, field); }
  relatedProjectRelations(node: RecordNode) { return this.snapshot.relatedProjectRelations(node); }

  private scalarArgs(kind: Kind, where: Where): Where {
    const args: Where = {};
    for (const [key, value] of Object.entries(where)) {
      if (value == null || ['and', 'or', 'not'].includes(key) || key in relationKinds[kind]
        || kind === 'action' && ['occurrence', 'recurrenceExists'].includes(key)) continue;
      const storedKey = key === 'projectIds' ? 'projects' : key === 'actionIds' ? 'actions' : key === 'relatedTo' ? 'related_to'
        : key.replace(/(From|To)$/, suffix => suffix === 'From' ? '_from' : '_to');
      args[storedKey] = value;
    }
    return validateToolArgs(`query_${collections[kind]}`, args);
  }

  private scalarPredicate(args: Where): Predicate {
    const tests: Predicate[] = [];
    if (args.ids) {
      const ids = new Set<string>(args.ids);
      tests.push(node => ids.has(node.id));
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
        const value = (node.record.meta ?? node.record.frontMatter)[field]?.slice(0, 10);
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

  async compile(kind: Kind, where: Where = {}, depth = 0, scope?: readonly RecordNode[]): Promise<Predicate> {
    this.signal?.throwIfAborted();
    if (depth > 12) this.onBudgetExceeded('GraphQL filter nesting exceeds 12 levels.');
    // Without regex, predicates are valid for any node of their kind. Regex
    // must retain its candidate scope to preserve the worker's capacity limits.
    const key = `${kind}:${depth}:${JSON.stringify(where)}:${scope && hasSearch(where) ? JSON.stringify(scope.map(node => node.id)) : '*'}`;
    let compiled = this.predicates.get(key);
    if (!compiled) {
      compiled = this.compileUncached(kind, where, depth, scope);
      this.predicates.set(key, compiled);
    }
    return compiled;
  }

  private async compileUncached(kind: Kind, where: Where, depth: number, scope?: readonly RecordNode[]): Promise<Predicate> {
    const args = this.scalarArgs(kind, where);
    for (const field of ['created', 'scheduled', 'deadline', 'ended']) {
      if (args[`${field}_from`] && args[`${field}_to`] && args[`${field}_from`] > args[`${field}_to`]) {
        throw new Error(`${field}_from must be on or before ${field}_to.`);
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
    let narrowed: RecordNode[] | undefined;
    const narrowScope = () => narrowed ??= [...(scope ?? this.records[kind].values())].filter(node => {
      this.tick();
      return scalar(node);
    });
    if (where.and) {
      const predicates = await Promise.all(where.and.map(async (filter: Where) => this.compile(kind, filter, depth + 1, hasSearch(filter) ? narrowScope() : undefined)));
      tests.push(node => predicates.every(p => p(node)));
    }
    if (where.or) {
      const predicates = await Promise.all(where.or.map(async (filter: Where) => this.compile(kind, filter, depth + 1, hasSearch(filter) ? narrowScope() : undefined)));
      tests.push(node => predicates.some(p => p(node)));
    }
    if (where.not) {
      const predicate = await this.compile(kind, where.not, depth + 1, hasSearch(where.not) ? narrowScope() : undefined);
      tests.push(node => !predicate(node));
    }
    for (const [field, target] of Object.entries(relationKinds[kind]) as [string, Kind][]) {
      const relation = where[field];
      if (!relation) continue;
      let relatedScope: RecordNode[] | undefined;
      for (const operator of ['some', 'none']) {
        if (relation[operator] == null) continue;
        // Pure predicates can evaluate any target lazily. Only regex needs
        // the complete candidate scope before reserving worker capacity.
        const scopedSearch = hasSearch(relation[operator]);
        if (scopedSearch && !relatedScope) {
          const relatedIds = new Set<string>();
          for (const node of narrowScope()) for (const id of this.relationIds(node, field)) {
            this.tick(); relatedIds.add(id);
          }
          relatedScope = [...relatedIds].map(id => this.records[target].get(id)).filter((node): node is RecordNode => !!node);
        }
        const predicate = await this.compile(target, relation[operator], depth + 1, scopedSearch ? relatedScope : undefined);
        if (operator === 'none' && this.issues.length) throw new Error('Cannot evaluate none with record diagnostics: absence is unconfirmed. Inspect diagnostics and repair the records.');
        tests.push(node => {
          const ids = this.relationIds(node, field);
          if (operator === 'none' && ids.some(id => !this.records[target].has(id))) {
            throw new Error(`Cannot evaluate ${field}.none: a referenced record is missing.`);
          }
          const found = ids.some(id => {
            this.tick();
            const related = this.records[target].get(id);
            return related ? predicate(related) : false;
          });
          return operator === 'some' ? found : !found;
        });
      }
    }
    if (args.search) {
      // Apply already compiled filters before reserving worker capacity. For a
      // nested collection, unrelated records must not consume its search budget.
      const candidates = (narrowed ?? [...(scope ?? this.records[kind].values())]).filter(node => { this.tick(); return tests.every(test => test(node)); });
      const texts = candidates.map(node => node.kind === 'entry'
        ? [node.record.content, node.description ?? '']
        : [node.record.frontMatter.name, node.description ?? '', node.record.body]);
      const indices = await this.matcher.match(args.search, texts, { signal: this.signal });
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

  async list(kind: Kind, args: Where, parent?: RecordNode, field?: string, needsPage = true) {
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be from 1 to 100.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative integer.');
    const orderBy = args.orderBy ?? 'CREATED_DESC';
    const ascending = orderBy === 'CREATED_ASC';
    const timeOrder = kind === 'action' && /^(SCHEDULED|DEADLINE)_(ASC|DESC)$/.test(orderBy);
    const page = (nodes: readonly RecordNode[]) => paginate(
      timeOrder && needsPage ? this.snapshot.inActionTimeOrder(nodes, orderBy) : nodes,
      timeOrder || ascending, offset, limit, needsPage,
    );
    const where = args.where ?? {};
    const cacheKey = parent || hasSearch(where) ? undefined : `${kind}:${JSON.stringify(where)}`;
    const cached = cacheKey === undefined ? undefined : this.snapshot.cachedMatches(cacheKey);
    if (cached) { this.tick(); return page(cached); }
    const exactIds: string[] | undefined = args.where?.ids ?? undefined;
    const candidates = parent
      ? [...new Set(this.relationIds(parent, field!))].map(id => this.records[kind].get(id)).filter((node): node is RecordNode => !!node)
      : exactIds
        ? [...new Set(exactIds)].map(id => this.records[kind].get(id)).filter((node): node is RecordNode => !!node)
        : needsPage ? this.snapshot.inCreatedOrder(kind) : [...this.records[kind].values()];
    const predicate = await this.compile(kind, args.where ?? {}, 0, parent || exactIds ? candidates : undefined);
    if (!needsPage) {
      let totalCount = 0;
      for (const node of candidates) { this.tick(); if (predicate(node)) totalCount++; }
      return { nodes: [], offset, count: Math.min(limit, Math.max(0, totalCount - offset)), totalCount };
    }
    const nodes = candidates.filter(node => { this.tick(); return predicate(node); });
    if (parent || exactIds) nodes.sort(compareCreated);
    if (cacheKey !== undefined) this.snapshot.rememberMatches(cacheKey, nodes);
    return page(nodes);
  }
}
