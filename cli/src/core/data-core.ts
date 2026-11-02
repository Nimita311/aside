import { planningActions, resolveProjection, type PlanningPage } from './recurrence.js';
import { mapLimit } from './async.js';
import type { DataSource } from './data-source.js';
import type {
  Entry,
  Project,
  Action,
  Artifact,
  IndexItem,
  RecordIndexes,
  ParseResult,
  ParseIssue,
} from './types.js';
import { deriveWeeklyFiles, getMondayOfWeek, weekFilePath, entityFilePath, entryReferences, entityKey, type EntityRef } from './record-reference.js';
import { parseIndex, parseWeeklyFile, parseProjectFile, parseActionFile, parseArtifactFile, parseManifest, splitFrontMatter } from './parser.js';
import { artifactHandle, artifactAttachmentRelativePath, parseArtifactHandle } from './artifact-reference.js';

import { buildRelations, artifactReferenceSources, type RecordCollection, type Relations } from './record-model.js';
import { ENTITY_KINDS, type EntityKind, type EntityRecord, type IndexKind, type InstanceRecord } from './types.js';
import type { ArtifactReferenceSource as ArtifactSource } from './artifact-reference.js';
import type { CoreRecords, DataSnapshot, SnapshotRelations } from './data-snapshot.js';
export { ENTITY_KINDS };
export type { Relations, EntityKind, EntityRecord, InstanceRecord };

export interface SearchProgress { loaded: number; total: number; pending: number; complete: boolean; failures: string[] }

export interface FileDiagnostic {
  path: string;
  issues: ParseIssue[];
  error?: string;
}

// A catch-up check's inputs and outputs — see "Catch-up" in spec.md. A light
// check covers the indexes plus the hot set; a full sweep also revalidates
// every cached file.
export type CheckScope = 'light' | 'full';

const ENTITY_PARSERS: { [K in EntityKind]: (raw: string) => ParseResult<EntityRecord[K]> } = {
  project: parseProjectFile, action: parseActionFile, artifact: parseArtifactFile,
};
const ENTITY_INDEX: Record<EntityKind, Exclude<IndexKind, 'notes'>> = { project: 'projects', action: 'actions', artifact: 'artifacts' };
type EntityCaches = { [K in EntityKind]: Map<string, EntityRecord[K]> };
type StagedEntities = { [K in EntityKind]: Map<string, Staged<EntityRecord[K]>> };

// What the app is currently showing — the files a light check revalidates
// beyond the indexes, since a body edit doesn't show in an index.
export interface HotSet {
  weeks: string[];                            // mondays rendered in the flow
  entities: { kind: EntityKind; id: string }[]; // filtered/open entity
  assets: string[];                           // asset open in the reader
}

// What a check found, for scoping the re-render.
export interface UpdateSummary {
  weeks: Set<string>;      // mondays whose entries changed (added, edited, deleted)
  entities: Set<string>;   // complete project/action/artifact handles changed, added, or removed
  assets: Set<string>;
  indexesChanged: boolean;
}

// A check's staged findings. apply() lands them in one synchronous pass —
// the caller invokes it when the app is quiet, then re-renders per summary.
export interface PendingUpdate {
  summary: UpdateSummary;
  apply(): void;
}

const INDEX_KINDS = ['notes', 'projects', 'actions', 'artifacts'] as const;

function indexFilePath(kind: IndexKind, year: string): string {
  return `${kind}/${year}/index.yaml`;
}

const WEEK_PATH = /^notes\/\d{4}\/(\d{4}-\d{2}-\d{2})\.md$/;
const ENTITY_PATH = /^(projects|actions|artifacts)\/\d{4}\/([^/]+)\.md$/;
const KIND_OF_INDEX: Record<string, EntityKind> = { projects: 'project', actions: 'action', artifacts: 'artifact' };

// The record a root-relative path addresses — a weekly file by its Monday, or
// an entity record by kind and id — else null.
function recordAt(path: string): { week: string } | { kind: EntityKind; id: string } | null {
  const week = WEEK_PATH.exec(path)?.[1];
  if (week) return { week };
  const entity = ENTITY_PATH.exec(path);
  return entity ? { kind: KIND_OF_INDEX[entity[1]], id: entity[2] } : null;
}

// A staged file change and the revision of the read that selected it. Apply
// skips a stage only when a later-issued read already wrote the cache.
interface Staged<T> {
  value: T | null;
  version: string | null;
  readRevision: number;
}

export class DataCore {
  private source?: DataSource;
  private years: string[] = [];
  // Per-year index items — the unit indexes change in — plus the flat
  // reverse-chron arrays reads use, rebuilt whenever a year changes.
  private yearIndexes: Record<IndexKind, Map<string, IndexItem[]>> = {
    notes: new Map(), projects: new Map(), actions: new Map(), artifacts: new Map(),
  };
  private indexes: RecordIndexes = { notes: [], projects: [], actions: [], artifacts: [] };
  private weeklyCache: Map<string, Entry[]> = new Map();
  private weeklyLoads: Map<string, Promise<Entry[]>> = new Map();
  // Memoized getCachedEntryContents result; nulled by cacheWeek.
  private entryRecords: Entry[] | null = null;
  private entryContents: Map<string, string> | null = null;
  private entities: EntityCaches = { project: new Map(), action: new Map(), artifact: new Map() };
  private artifactContents: Map<string, string> | null = null;
  private entityLoads = new Map<string, Promise<unknown>>();
  private entityWriteRevisions = new Map<string, number>();
  private assetCache: Map<string, string> = new Map();
  private assetLoads = new Map<string, Promise<string | null>>();
  private assetWriteRevisions = new Map<string, number>();
  private addressableAssets = new Set<string>();
  private assetVersions = new Map<string, string | null>();
  private assetRevisions = new Map<string, number>();
  // Version of every fetched file by path — what catch-up checks revalidate
  // against. No entry means the file was absent (or never read).
  private versions: Map<string, string> = new Map();
  private fileReadRevisions = new Map<string, number>();
  private fileWriteReadRevisions = new Map<string, number>();
  private allWeeksLoad: Promise<boolean> | null = null;
  private instance: InstanceRecord | null = null;
  private initialized = false;
  private relationsCache: Relations | null = null;
  private relationRevision = 0;
  // Reverse-chron weeks that hold a match for a filter, memoized per ref — lets
  // a filtered flow load only weeks with matching entries and skip the empty
  // ones the raw week stream would otherwise walk. Valid only once every week
  // is cached (relationsCache set); before then filterWeeks returns null and
  // callers fall back to the full week list.
  private filterWeeksCache: Map<string, string[]> = new Map();
  private checking = false;
  private searchListeners = new Set<() => void>();
  private searchNotification = false;
  private searchWarming: Promise<void> | null = null;
  private reloads = new Map<string, Promise<void>>();
  private diagnostics = new Map<string, FileDiagnostic>();
  private diagnosticListeners = new Set<() => void>();

  subscribeSearch(listener: () => void): () => void {
    this.searchListeners.add(listener);
    return () => this.searchListeners.delete(listener);
  }
  private publishSearch(): void {
    if (this.searchNotification) return;
    this.searchNotification = true;
    queueMicrotask(() => {
      this.searchNotification = false;
      for (const listener of this.searchListeners) listener();
    });
  }
  getSearchProgress(): SearchProgress {
    const weeks = this.getWeeklyDates();
    const indexed = ENTITY_KINDS.flatMap(kind => this.indexes[ENTITY_INDEX[kind]].map(item => ({ kind, id: item.id })));
    const total = weeks.length + indexed.length;
    const loaded = weeks.filter(week => this.weeklyCache.has(week)).length
      + indexed.filter(({ kind, id }) => this.entities[kind].has(id)).length;
    const paths = new Set([
      'aside.md',
      ...this.years.flatMap(year => INDEX_KINDS.map(kind => indexFilePath(kind, year))),
      ...weeks.map(weekFilePath),
      ...indexed.flatMap(({ kind, id }) => {
        try { return [entityFilePath(kind, id)]; }
        catch { return []; } // malformed indexed handles still count as unloaded
      }),
    ]);
    const pending = [...this.weeklyLoads.keys()].filter(week => paths.has(weekFilePath(week))).length
      + [...this.entityLoads.keys()].filter(path => paths.has(path)).length + (this.searchWarming ? 1 : 0);
    const failures = [...this.diagnostics.keys()].filter(path => paths.has(path));
    return { loaded, total, pending, complete: loaded === total && pending === 0 && failures.length === 0, failures };
  }
  warmSearch(retry = false): Promise<void> {
    if (this.searchWarming) return this.searchWarming;
    this.searchWarming = (async () => {
      if (retry) await Promise.all(this.getSearchProgress().failures.map(path => this.reloadFile(path).catch(() => {})));
      await Promise.all([this.warmEntities(), this.getRelations().catch(() => null)]);
    })().finally(() => { this.searchWarming = null; this.publishSearch(); });
    this.publishSearch();
    return this.searchWarming;
  }

  getDiagnostics(): FileDiagnostic[] { return [...this.diagnostics.values()]; }
  diagnosticsFor(path: string): FileDiagnostic | undefined { return this.diagnostics.get(path); }
  subscribeDiagnostics(listener: () => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }
  private recordDiagnostics(path: string, issues: ParseIssue[], error?: string): void {
    const previous = this.diagnostics.get(path);
    const diagnostic = { path, issues: issues.map(issue => ({ ...issue, file: path })), ...(error && { error }) };
    if (issues.length || error) this.diagnostics.set(path, diagnostic);
    else this.diagnostics.delete(path);
    if (JSON.stringify(previous) !== JSON.stringify(this.diagnostics.get(path))) {
      for (const listener of this.diagnosticListeners) listener();
      this.publishSearch();
    }
  }
  private recordReadFailure(path: string, error: unknown): void {
    this.recordDiagnostics(path, this.diagnostics.get(path)?.issues ?? [], error instanceof Error ? error.message : String(error));
  }
  private clearReadFailure(path: string): void {
    this.recordDiagnostics(path, this.diagnostics.get(path)?.issues ?? []);
  }
  private parseResult<T>(result: ParseResult<T>, path: string): T {
    if ((this.fileWriteReadRevisions.get(path) ?? 0) === (this.fileReadRevisions.get(path) ?? 0)) this.recordDiagnostics(path, result.issues);
    return result.value;
  }


  constructor(source?: DataSource) {
    this.source = source;
  }

  private fileSource(): DataSource {
    if (!this.source) throw new Error('This core is hydrated by its filesystem adapter.');
    return this.source;
  }

  // The daemon's synchronous filesystem adapter replaces the same caches that
  // the asynchronous static-file adapter populates. Only this class owns records.
  replaceRecords(records: CoreRecords): void {
    // An unreadable path is unknown, not deleted. Retain its last readable
    // records; a later successful disk scan can repair or remove them.
    const unreadable = records.issues.filter(issue => issue.code === 'read_error' && issue.file).map(issue => issue.file!);
    const failed = (path: string) => unreadable.some(file => path === file || path.startsWith(file + '/'));
    const retain = <T>(previous: ReadonlyMap<string, T>, next: Map<string, T>, path: (id: string) => string) => {
      for (const [id, value] of previous) {
        try { if (!next.has(id) && failed(path(id))) next.set(id, value); }
        catch { /* invalid record IDs already have parser/validator diagnostics */ }
      }
    };
    retain(this.weeklyCache, records.weeks, weekFilePath);
    retain(this.entities.project, records.projects, id => entityFilePath('project', id));
    retain(this.entities.action, records.actions, id => entityFilePath('action', id));
    retain(this.entities.artifact, records.artifacts, id => entityFilePath('artifact', id));
    for (const kind of INDEX_KINDS) {
      const loaded = new Set(records.indexes[kind].map(item => item.id));
      records.indexes[kind].push(...this.indexes[kind].filter(item => !loaded.has(item.id) && failed(indexFilePath(kind, item.id.slice(0, 4)))));
      records.indexes[kind].sort((a, b) => Number(b.id.slice(0, 4)) - Number(a.id.slice(0, 4)));
    }
    this.weeklyCache = records.weeks;
    this.entities = { project: records.projects, action: records.actions, artifact: records.artifacts };
    this.indexes = records.indexes;
    this.years = [...new Set([
      ...Object.values(records.indexes).flat().map(item => item.id.slice(0, 4)),
      ...records.issues.flatMap(issue => issue.file?.match(/^(?:notes|projects|actions|artifacts)\/(\d{4})(?:\/|$)/)?.[1] ?? []),
    ].filter(year => /^\d{4}$/.test(year)))].sort();
    this.instance = records.instance;
    this.setIssues(records.issues);
    this.initialized = true;
    this.entryRecords = null;
    this.entryContents = null;
    this.artifactContents = null;
    this.relationsCache = null;
    this.filterWeeksCache.clear();
    this.relationRevision++;
  }

  getEntries(): Entry[] {
    return this.entryRecords ??= [...this.weeklyCache.values()].flat().sort((a, b) => a.meta.created < b.meta.created ? 1 : a.meta.created > b.meta.created ? -1 : 0);
  }
  getProjects(): ReadonlyMap<string, Project> { return this.entities.project; }
  getActions(): ReadonlyMap<string, Action> { return this.entities.action; }
  getArtifacts(): ReadonlyMap<string, Artifact> { return this.entities.artifact; }
  getRecords(): RecordCollection {
    return { entries: this.getEntries(), projects: this.entities.project, actions: this.entities.action, artifacts: this.entities.artifact };
  }
  getIndexes(): RecordIndexes { return this.indexes; }
  getIssues(): ParseIssue[] { return this.getDiagnostics().flatMap(diagnostic => diagnostic.issues); }
  setIssues(issues: ParseIssue[]): void {
    this.diagnostics.clear();
    for (const issue of issues) {
      const path = issue.file ?? 'aside.md';
      const diagnostic: FileDiagnostic = this.diagnostics.get(path) ?? { path, issues: [] };
      diagnostic.issues.push(issue);
      this.diagnostics.set(path, diagnostic);
    }
  }
  upsertEntity<K extends EntityKind>(kind: K, id: string, value: EntityRecord[K]): void {
    this.cacheEntity(kind, id, value);
    this.relationsCache = null;
    this.relationRevision++;
    this.filterWeeksCache.clear();
  }
  upsertEntry(entry: Entry): void {
    const entries = this.weeklyCache.get(entry.weekFile) ?? [];
    const index = entries.findIndex(candidate => candidate.meta.created === entry.meta.created);
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
    entries.sort((a, b) => a.meta.created < b.meta.created ? 1 : a.meta.created > b.meta.created ? -1 : 0);
    this.cacheWeek(entry.weekFile, entries);
    this.relationsCache = null;
    this.filterWeeksCache.clear();
  }
  deriveRelations(sources: readonly ArtifactSource[], availableAttachments?: ReadonlySet<string>): Relations {
    this.relationsCache = buildRelations(this.getRecords(), sources, availableAttachments);
    this.filterWeeksCache.clear();
    return this.relationsCache;
  }
  cachedRelations(): Relations {
    if (!this.relationsCache) throw new Error('Relationships have not been loaded.');
    return this.relationsCache;
  }

  // JSON contains the derived graph and week selection as well as records;
  // clients decode it without parsing files or rebuilding relationships.
  async snapshot(): Promise<DataSnapshot> {
    const revision = this.relationRevision;
    const relations = await this.getRelations();
    if (revision !== this.relationRevision) return this.snapshot();
    const weeksByEntry = new Map(this.getEntries().map(entry => [entry.meta.created, entry.weekFile]));
    const dates = this.getWeeklyDates();
    const indexedDates = new Set(dates);
    const weeksByEntity = [...relations.entriesByEntity].map(([handle, ids]): [string, string[]] => {
      const weeks = new Set(ids.map(id => weeksByEntry.get(id)));
      return [handle, [...weeks].filter((week): week is string => week !== undefined && indexedDates.has(week)).sort().reverse()];
    });
    for (const [id, week] of weeksByEntry) weeksByEntity.push([`#entry/${id}`, indexedDates.has(week) ? [week] : []]);
    return structuredClone({
      instance: this.instance, indexes: this.indexes, weeklyDates: dates,
      weeks: [...this.weeklyCache], projects: [...this.entities.project], actions: [...this.entities.action], artifacts: [...this.entities.artifact],
      relations: Object.fromEntries(Object.entries(relations).map(([key, map]) => [key, [...map]])) as SnapshotRelations,
      weeksByEntity, diagnostics: this.getDiagnostics(), searchProgress: this.getSearchProgress(),
    });
  }

  // Read a file and record its version for later revalidation.
  private beginFileRead(path: string): number {
    const revision = (this.fileReadRevisions.get(path) ?? 0) + 1;
    this.fileReadRevisions.set(path, revision);
    return revision;
  }

  private async readTracked(path: string, superseded?: () => string | null | undefined): Promise<string | null> {
    const readRevision = this.beginFileRead(path);
    let result;
    try { result = await this.fileSource().read(path); }
    catch (error) {
      const current = superseded?.();
      if (current !== undefined) return current;
      if (this.fileReadRevisions.get(path) === readRevision && (this.fileWriteReadRevisions.get(path) ?? 0) <= readRevision) this.recordReadFailure(path, error);
      throw error;
    }
    const current = superseded?.();
    if (current !== undefined) return current;
    if (this.fileReadRevisions.get(path) === readRevision && (this.fileWriteReadRevisions.get(path) ?? 0) <= readRevision) this.clearReadFailure(path);
    this.fileWriteReadRevisions.set(path, readRevision);
    if (result == null) {
      this.versions.delete(path);
      return null;
    }
    this.versions.set(path, result.version);
    return result.text;
  }

  // The manifest marks the data root as an instance; a source without one
  // (or an unreadable one) just has no instance record. Read untracked —
  // it takes no part in catch-up; a reload picks up manifest edits.
  private async loadInstance(): Promise<void> {
    try {
      const raw = await this.fileSource().read('aside.md');
      if (raw == null) { this.recordReadFailure('aside.md', 'Instance manifest aside.md is missing'); return; }
      if (raw != null) {
        this.instance = {
          manifest: this.parseResult(parseManifest(raw.text), 'aside.md'),
          body: splitFrontMatter(raw.text).body.trim(),
        };
      }
    } catch (err) {
      this.recordReadFailure('aside.md', err);
      console.warn('Failed to read aside.md:', err);
    }
  }

  async init(): Promise<void> {
    this.initialized = false;
    const instanceLoad = this.loadInstance();
    this.years = await this.fileSource().listYears();

    await Promise.all(this.years.flatMap((year) => INDEX_KINDS.map(async (kind) => {
      const path = indexFilePath(kind, year);
      try {
        const raw = await this.readTracked(path);
        if (raw != null) this.yearIndexes[kind].set(year, this.parseResult(parseIndex(raw), path));
      } catch (err) {
        console.warn(`Failed to read ${path}:`, err);
      }
    })));
    this.rebuildIndexArrays();

    // Eagerly load every entity record to populate the display-name caches.
    await Promise.all([instanceLoad, this.warmEntities()]);
    this.initialized = true;
  }

  // Fetch every indexed entity record into its cache; a failed read stays
  // diagnosed rather than failing the batch.
  private warmEntities(): Promise<unknown> {
    return Promise.all(ENTITY_KINDS.flatMap(kind => this.indexes[ENTITY_INDEX[kind]].map(item => this.loadEntity(kind, item.id).catch(() => null))));
  }

  reloadFile(path: string): Promise<void> {
    const current = this.reloads.get(path);
    if (current) return current;
    const load = this.reloadRecordFile(path).finally(() => { this.reloads.delete(path); this.publishSearch(); });
    this.reloads.set(path, load);
    return load;
  }

  private async reloadRecordFile(path: string): Promise<void> {
    if (path === 'aside.md') { await this.loadInstance(); return; }
    const index = /^(notes|projects|actions|artifacts)\/(\d{4})\/index\.yaml$/.exec(path);
    if (index) {
      const raw = await this.readTracked(path);
      const kind = index[1] as IndexKind, year = index[2];
      if (raw === null) { this.yearIndexes[kind].delete(year); this.recordDiagnostics(path, []); }
      else this.yearIndexes[kind].set(year, this.parseResult(parseIndex(raw), path));
      this.rebuildIndexArrays(); this.relationRevision++; this.filterWeeksCache.clear(); this.relationsCache = null; this.allWeeksLoad = null;
      await this.warmEntities();
      return;
    }
    const record = recordAt(path);
    if (record && 'week' in record) {
      const { week } = record;
      await this.weeklyLoads.get(week)?.catch(() => {});
      const raw = await this.readTracked(path);
      const entries = raw === null ? [] : this.parseResult(parseWeeklyFile(raw, week), path).entries;
      if (raw === null) this.recordDiagnostics(path, []);
      this.cacheWeek(week, entries); this.relationsCache = null; this.allWeeksLoad = null;
      return;
    }
    if (record) {
      await this.entityLoads.get(path)?.catch(() => {});
      const raw = await this.readTracked(path);
      if (raw === null) { this.recordReadFailure(path, 'Record file is missing'); return; }
      const { kind, id } = record;
      this.cacheEntity(kind, id, this.parseResult(ENTITY_PARSERS[kind](raw), path));
      this.entityWriteRevisions.set(path, (this.entityWriteRevisions.get(path) ?? 0) + 1);
      this.relationRevision++; this.relationsCache = null;
      return;
    }
    if (this.assetCache.has(path) || this.assetLoads.has(path) || this.diagnostics.has(path)) {
      await this.assetLoads.get(path)?.catch(() => {});
      const raw = await this.readTracked(path);
      if (raw === null) { this.recordReadFailure(path, 'File is missing'); return; }
      this.assetCache.set(path, raw);
      this.assetWriteRevisions.set(path, (this.assetWriteRevisions.get(path) ?? 0) + 1);
      this.recordDiagnostics(path, []); this.relationRevision++; this.relationsCache = null;
      return;
    }
    throw new Error(`This file has not been loaded as a record or supporting file: ${path}`);
  }

  getInstance(): InstanceRecord | null {
    return this.instance;
  }

  // Newest year first, so each flat index lands reverse chronological.
  private rebuildIndexArrays(): void {
    const flatten = (byYear: Map<string, IndexItem[]>): IndexItem[] =>
      [...byYear.keys()].sort().reverse().flatMap((y) => byYear.get(y)!);
    for (const kind of INDEX_KINDS) this.indexes[kind] = flatten(this.yearIndexes[kind]);
    this.publishSearch();
  }

  getDisplayName(type: 'project' | 'action', id: string): string {
    return (type === 'action' ? this.getCachedAction(id) : this.entities[type].get(id))?.frontMatter.name ?? id;
  }

  // Synchronous cache reads — projects and actions load eagerly at init, so a
  // chip's status resolves without awaiting, like the display names.
  getCachedProject(id: string): Project | undefined {
    return this.entities.project.get(id);
  }

  getCachedAction(id: string): Action | undefined {
    return this.entities.action.get(id) ?? resolveProjection(this.entities.action, id);
  }

  async getPlanningActions(project?: string, after?: string): Promise<PlanningPage> {
    const relations = await this.getRelations();
    return planningActions(this.entities.action, { projectionsOnly: true, templates: project ? relations.actionsByProject.get(project) ?? [] : undefined, after, lookaheadDays: this.getInstance()?.manifest.config?.recurrenceLookaheadDays });
  }

  getCachedArtifact(id: string): Artifact | undefined {
    return this.entities.artifact.get(id);
  }

  getArtifactDisplayName(id: string): string {
    return this.entities.artifact.get(id)?.frontMatter.name ?? id;
  }

  getCachedArtifactContents(): Map<string, string> {
    if (!this.artifactContents) {
      this.artifactContents = new Map([...this.entities.artifact].map(([id, artifact]) => [id, artifact.body]));
    }
    return this.artifactContents;
  }

  // A snapshot of every entry sitting in the weekly cache, keyed by entry id —
  // the search's full-text corpus (only loaded entries match by body). Memoized
  // until a week load or catch-up changes the cache, so the same map identity
  // serves every keystroke.
  getCachedEntryContents(): Map<string, string> {
    if (!this.entryContents) {
      const contents = new Map<string, string>();
      for (const entries of this.weeklyCache.values()) {
        for (const e of entries) contents.set(e.meta.created, e.content);
      }
      this.entryContents = contents;
    }
    return this.entryContents;
  }

  // The one write path into weeklyCache, so the entry-contents memo can never
  // go stale against it.
  private cacheWeek(monday: string, entries: Entry[]): void {
    this.weeklyCache.set(monday, entries);
    this.publishSearch();
    this.entryRecords = null;
    this.entryContents = null;
    this.relationRevision++;
  }

  // Resolves to [] when the weekly file does not exist. Concurrent calls for
  // the same week share one fetch.
  getWeekEntries(monday: string): Promise<Entry[]> {
    const cached = this.weeklyCache.get(monday);
    if (cached) return Promise.resolve(cached);

    let load = this.weeklyLoads.get(monday);
    if (!load) {
      const path = weekFilePath(monday);
      load = this.readTracked(path, () => this.weeklyCache.has(monday) ? null : undefined).then((raw) => {
        const latest = this.weeklyCache.get(monday);
        if (latest) return latest;
        const entries = raw == null
          ? []
          : this.parseResult(parseWeeklyFile(raw, monday), path).entries;
        this.cacheWeek(monday, entries);
        return entries;
      });
      this.weeklyLoads.set(monday, load);
      this.publishSearch();
      // Drop the in-flight entry once settled: a success now lives in
      // weeklyCache (the early return above), a failure is free to retry.
      const done = () => { this.weeklyLoads.delete(monday); this.publishSearch(); };
      load.then(done, done);
    }
    return load;
  }

  getProject(id: string): Promise<Project> {
    return this.loadEntity('project', id);
  }

  getAction(id: string): Promise<Action> {
    const projected = resolveProjection(this.entities.action, id);
    return projected ? Promise.resolve(projected) : this.loadEntity('action', id);
  }

  getArtifact(id: string): Promise<Artifact> {
    return this.loadEntity('artifact', id);
  }

  // The one write path into an entity cache; artifact bodies also feed the
  // search corpus memo, which the write invalidates.
  private cacheEntity<K extends EntityKind>(kind: K, id: string, value: EntityRecord[K]): void {
    this.entities[kind].set(id, value);
    if (kind === 'artifact') this.artifactContents = null;
  }

  // Cached fetch-and-parse for an entity record. Concurrent callers share one
  // fetch; a catch-up edit or deletion supersedes an older pending request.
  private async loadEntity<K extends EntityKind>(kind: K, id: string): Promise<EntityRecord[K]> {
    const cache = this.entities[kind];
    const cached = cache.get(id);
    if (cached) return cached;

    const path = entityFilePath(kind, id);
    const pending = this.entityLoads.get(path);
    if (pending) return pending as Promise<EntityRecord[K]>;
    const base = this.entityWriteRevisions.get(path);
    const load = this.readTracked(path, () =>
      this.entityWriteRevisions.get(path) === base ? undefined : null,
    ).then(raw => {
      if (this.entityWriteRevisions.get(path) !== base) {
        const latest = cache.get(id);
        if (latest !== undefined) return latest;
        throw new Error(`${kind} file not found: ${path}`);
      }
      if (raw == null) throw new Error(`${kind} file not found: ${path}`);
      const value = this.parseResult(ENTITY_PARSERS[kind](raw), path);
      this.cacheEntity(kind, id, value);
      this.entityWriteRevisions.set(path, (base ?? 0) + 1);
      this.relationsCache = null;
      this.relationRevision++;
      return value;
    });
    load.catch(error => { this.recordReadFailure(path, error); });
    this.entityLoads.set(path, load);
    this.publishSearch();
    const done = () => { this.entityLoads.delete(path); this.publishSearch(); };
    load.then(done, done);
    return load;
  }

  // Raw asset file content. Assets are plain files outside the entity model —
  // no parsing, just text.
  async getAsset(path: string): Promise<string> {
    const raw = await this.loadAssetText(path);
    if (raw == null) {
      const error = new Error(`Asset file not found: ${path}`);
      this.recordReadFailure(path, error);
      throw error;
    }
    return raw;
  }

  private loadAssetText(path: string): Promise<string | null> {
    const cached = this.assetCache.get(path);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.assetLoads.get(path);
    if (pending) return pending;
    const base = this.assetWriteRevisions.get(path);
    const load = this.readTracked(path, () =>
      this.assetWriteRevisions.get(path) === base ? undefined : this.assetCache.get(path) ?? null,
    ).then(text => {
      // A check may have installed newer contents or a deletion while this
      // request was pending. Preserve its cache and version together.
      if (this.assetWriteRevisions.get(path) !== base) return this.assetCache.get(path) ?? null;
      if (text !== null) {
        this.assetCache.set(path, text);
        this.assetWriteRevisions.set(path, (base ?? 0) + 1);
        this.relationsCache = null;
        this.relationRevision++;
      }
      return text;
    });
    this.assetLoads.set(path, load);
    this.publishSearch();
    const done = () => { this.assetLoads.delete(path); this.publishSearch(); };
    load.then(done, done);
    return load;
  }

  // URL for an asset's bytes, for embedding media directly (see DataSource.assetUrl).
  assetUrl(path: string): string | null {
    const url = this.fileSource().assetUrl(path);
    if (url === null) return null;
    this.addressableAssets.add(path);
    const revision = this.assetRevisions.get(path);
    if (revision === undefined) return url;
    return `${url}${url.includes('?') ? '&' : '?'}aside_revision=${revision}`;
  }

  // Check addressable media without treating its bytes as text. Successful
  // metadata is reused until a change check or an explicit retry updates it.
  async prepareAssetUrl(path: string, retry = false): Promise<string | null> {
    const url = this.assetUrl(path);
    if (url === null) return null;
    const previous = this.assetVersions.get(path);
    if (!retry && previous != null && !this.diagnosticsFor(path)?.error) return url;
    const readRevision = this.beginFileRead(path);
    const current = () => this.fileReadRevisions.get(path) === readRevision;
    try {
      const version = await this.fileSource().assetVersion?.(path);
      if (current() && version !== undefined) this.assetVersions.set(path, version);
      if (version === null) throw new Error(`Failed to check ${url}: 404 Not Found`);
      if (current()) {
        this.fileWriteReadRevisions.set(path, readRevision);
        this.clearReadFailure(path);
        if (retry || (previous !== undefined && version !== undefined && version !== previous)) {
          this.assetRevisions.set(path, (this.assetRevisions.get(path) ?? 0) + 1);
        }
      }
      return this.assetUrl(path);
    } catch (error) {
      if (current()) this.recordReadFailure(path, error);
      throw error;
    }
  }

  reportAssetFailure(path: string, error: Error): void { this.recordReadFailure(path, error); }

  // Whether any fetched file carried a server validator — a validator-less
  // source pays a full download per checked file, so callers stretch the
  // full-sweep cadence.
  hasValidators(): boolean {
    for (const v of this.versions.values()) {
      if (!v.startsWith('hash:')) return true;
    }
    return false;
  }

  // Catch-up check: revalidate the indexes (light) or every cached file
  // (full), plus the hot set and any server-pushed paths, and stage what
  // changed. Resolves to null when nothing changed or a check is already
  // running. Never blocks reads and never evicts on a network error — a
  // failed file logs and stays as it was.
  async check(scope: CheckScope, hot: HotSet, changedPaths: string[] = []): Promise<PendingUpdate | null> {
    if (this.checking) return null;
    this.checking = true;
    try {
      return await this.runCheck(scope, hot, changedPaths);
    } finally {
      this.checking = false;
    }
  }

  private async runCheck(scope: CheckScope, hot: HotSet, changedPaths: string[]): Promise<PendingUpdate | null> {
    const stagedIndexes = new Map<string, Staged<IndexItem[]>>(); // `${kind}/${year}`
    const stagedWeeks = new Map<string, Staged<Entry[]>>();       // monday
    const stagedEntities: StagedEntities = { project: new Map(), action: new Map(), artifact: new Map() }; // id
    const stageEntity = <K extends EntityKind>(kind: K, id: string, staged: Staged<EntityRecord[K]>) => { stagedEntities[kind].set(id, staged); };
    const stagedAssets = new Map<string, Staged<string>>();       // path
    const stagedMedia = new Map<string, { value: string | null; base: string | null | undefined }>();
    const stagedDiagnostics = new Map<string, ParseIssue[]>();
    const parseResult = <T>(result: ParseResult<T>, path: string): T => {
      stagedDiagnostics.set(path, result.issues); return result.value;
    };
    const missingFiles = new Set<string>();
    const checkedReadRevisions = new Map<string, number>();

    // Revalidate one path: 'unchanged', the new content, or null (deleted).
    // No recorded version means the file was absent — a plain read probes for
    // its appearance. Errors read as unchanged: never evict on failure.
    const checkFile = async (path: string): Promise<{ text: string; version: string } | 'unchanged' | null> => {
      const version = this.versions.get(path);
      checkedReadRevisions.set(path, this.beginFileRead(path));
      try {
        if (version == null) {
          const result = await this.fileSource().read(path);
          if (result === null) missingFiles.add(path);
          return result ?? 'unchanged';
        }
        const result = await this.fileSource().revalidate(path, version);
        if (result === 'unchanged') this.clearReadFailure(path);
        return result;
      } catch (err) {
        this.recordReadFailure(path, err);
        console.warn(`Catch-up check failed for ${path}:`, err);
        return 'unchanged';
      }
    };

    // Indexes for every known year, plus a probe for the current year's
    // appearing mid-session (the new-year rollover, or a first-ever entry).
    const currentYear = String(new Date().getFullYear());
    const checkYears = [...new Set([...this.years, ...await this.fileSource().listYears(), currentYear])];
    await mapLimit(
      checkYears.flatMap((year) => INDEX_KINDS.map((kind) => ({ kind, year }))),
      6,
      async ({ kind, year }) => {
        const path = indexFilePath(kind, year);
        const result = await checkFile(path);
        if (result === 'unchanged') return;
        stagedIndexes.set(`${kind}/${year}`, {
          value: result && parseResult(parseIndex(result.text), path),
          version: result && result.version,
          readRevision: checkedReadRevisions.get(path)!,
        });
      },
    );

    // Diff staged indexes by id: added/removed note ids mark their weeks for
    // revalidation; added/removed entities get their files checked below.
    const weeksToCheck = new Set<string>();
    const entitiesToCheck = new Map<string, { kind: EntityKind; id: string }>();
    const addEntity = (kind: EntityKind, id: string) => entitiesToCheck.set(`${kind}/${id}`, { kind, id });
    const diffIds: { id: string }[] = [];
    for (const [key, staged] of stagedIndexes) {
      const [kind, year] = key.split('/') as [IndexKind, string];
      const oldIds = new Set((this.yearIndexes[kind].get(year) ?? []).map((i) => i.id));
      const newIds = new Set((staged.value ?? []).map((i) => i.id));
      for (const id of [...oldIds, ...newIds]) {
        if (oldIds.has(id) && newIds.has(id)) continue;
        if (kind === 'notes') diffIds.push({ id });
        else addEntity(KIND_OF_INDEX[kind], id);
      }
    }
    for (const monday of deriveWeeklyFiles(diffIds)) weeksToCheck.add(monday);

    // The rest of the check set: everything cached (full), or the hot set —
    // what's on screen plus the current week, the file still growing.
    const assetsToCheck = new Set<string>();
    if (scope === 'full') {
      for (const monday of this.weeklyCache.keys()) weeksToCheck.add(monday);
      for (const kind of ENTITY_KINDS) for (const id of this.entities[kind].keys()) addEntity(kind, id);
      for (const path of this.assetCache.keys()) assetsToCheck.add(path);
      for (const path of this.assetLoads.keys()) assetsToCheck.add(path);
    } else {
      for (const monday of hot.weeks) weeksToCheck.add(monday);
      weeksToCheck.add(getMondayOfWeek(new Date()));
      for (const e of hot.entities) addEntity(e.kind, e.id);
      for (const path of hot.assets) {
        if (this.assetCache.has(path) || this.assetLoads.has(path) || this.assetWriteRevisions.has(path)) assetsToCheck.add(path);
      }
    }

    for (const path of this.diagnostics.keys()) {
      const record = recordAt(path);
      if (record && 'week' in record) weeksToCheck.add(record.week);
      else if (record) addEntity(record.kind, record.id);
      else if (this.assetCache.has(path) || this.assetLoads.has(path) || this.assetWriteRevisions.has(path)) assetsToCheck.add(path);
    }

    // Server-pushed paths check directly — how a cold file's body edit lands
    // without waiting for a full sweep. Indexes are always checked above;
    // unrecognized paths matter only when they're a cached asset.
    for (const path of changedPaths) {
      const record = recordAt(path);
      if (record && 'week' in record) weeksToCheck.add(record.week);
      else if (record) addEntity(record.kind, record.id);
      else if (this.assetCache.has(path) || this.assetLoads.has(path) || this.assetWriteRevisions.has(path)) assetsToCheck.add(path);
    }

    await mapLimit([...weeksToCheck], 6, async (monday) => {
      const path = weekFilePath(monday);
      const result = await checkFile(path);
      if (result === 'unchanged') return;
      stagedWeeks.set(monday, {
        value: result && parseResult(parseWeeklyFile(result.text, monday), path).entries,
        version: result && result.version,
        readRevision: checkedReadRevisions.get(path)!,
      });
    });

    await mapLimit([...entitiesToCheck.values()], 6, async ({ kind, id }) => {
      const path = entityFilePath(kind, id);
      const pending = this.entityLoads.has(path);
      const result = await checkFile(path);
      if (result === 'unchanged' && !(missingFiles.has(path) && (pending || this.entityLoads.has(path)))) return;
      const selected = result === 'unchanged' ? null : result;
      const readRevision = checkedReadRevisions.get(path)!;
      stageEntity(kind, id, { value: selected && parseResult(ENTITY_PARSERS[kind](selected.text), path), version: selected && selected.version, readRevision });
    });

    await mapLimit([...assetsToCheck], 6, async (path) => {
      const result = await checkFile(path);
      if (result === 'unchanged') {
        // Fence an older explicit file read that captured content before a
        // catch-up check observed its deletion.
        if (missingFiles.has(path) && (this.assetLoads.has(path) || this.assetCache.has(path))) {
          stagedAssets.set(path, { value: null, version: null, readRevision: checkedReadRevisions.get(path)! });
        }
        return;
      }
      stagedAssets.set(path, { value: result && result.text, version: result && result.version, readRevision: checkedReadRevisions.get(path)! });
    });

    const mediaToCheck = new Set(scope === 'full' ? this.addressableAssets : hot.assets);
    for (const path of changedPaths) if (this.addressableAssets.has(path)) mediaToCheck.add(path);
    await mapLimit([...mediaToCheck].filter(path => !this.assetCache.has(path)), 6, async path => {
      const base = this.assetVersions.get(path);
      try {
        const value = await this.fileSource().assetVersion?.(path);
        const pushed = changedPaths.includes(path);
        if (value === undefined) {
          if (pushed) stagedMedia.set(path, { value: base ?? 'available', base });
        } else if (value !== base || pushed) stagedMedia.set(path, { value, base });
      } catch (err) {
        console.warn(`Catch-up check failed for ${path}:`, err);
      }
    });

    if (!stagedIndexes.size && !stagedWeeks.size && ENTITY_KINDS.every(kind => !stagedEntities[kind].size) && !stagedAssets.size && !stagedMedia.size) {
      return null;
    }

    const summary: UpdateSummary = {
      weeks: new Set(stagedWeeks.keys()),
      entities: new Set(ENTITY_KINDS.flatMap(kind => [...stagedEntities[kind].keys()].map(id => entityKey(kind, id)))),
      assets: new Set([...stagedAssets.keys(), ...stagedMedia.keys()]),
      indexesChanged: stagedIndexes.size > 0,
    };
    return { summary, apply: () => {
      this.applyStaged(stagedIndexes, stagedWeeks, stagedEntities, stagedAssets, stagedDiagnostics);
      for (const [path, staged] of stagedMedia) {
        if (this.assetVersions.get(path) !== staged.base) continue;
        this.assetVersions.set(path, staged.value);
        this.assetRevisions.set(path, (this.assetRevisions.get(path) ?? 0) + 1);
      }
    } };
  }

  // Land a check's findings in one synchronous pass, then rebuild derived
  // state from the updated cache. Read issuance decides freshness, so an
  // older request completing late cannot displace a newer check.
  private applyStaged(
    stagedIndexes: Map<string, Staged<IndexItem[]>>,
    stagedWeeks: Map<string, Staged<Entry[]>>,
    stagedEntities: StagedEntities,
    stagedAssets: Map<string, Staged<string>>,
    stagedDiagnostics: Map<string, ParseIssue[]>,
  ): void {
    const land = <T>(path: string, staged: Staged<T>, set: (value: T) => void, remove: () => void): boolean => {
      if ((this.fileWriteReadRevisions.get(path) ?? 0) > staged.readRevision) return false;
      if (staged.value === null) {
        remove();
        this.versions.delete(path);
      } else {
        set(staged.value);
        this.versions.set(path, staged.version!);
      }
      this.fileWriteReadRevisions.set(path, staged.readRevision);
      this.recordDiagnostics(path, stagedDiagnostics.get(path) ?? []);
      return true;
    };

    const landEntity = <K extends EntityKind>(kind: K, id: string, staged: Staged<EntityRecord[K]>): boolean => {
      const path = entityFilePath(kind, id);
      if (!land(path, staged, value => this.cacheEntity(kind, id, value), () => this.entities[kind].delete(id))) return false;
      this.entityWriteRevisions.set(path, (this.entityWriteRevisions.get(path) ?? 0) + 1);
      return true;
    };

    let indexesChanged = false;
    for (const [key, staged] of stagedIndexes) {
      const [kind, year] = key.split('/') as [IndexKind, string];
      const path = indexFilePath(kind, year);
      if (land(path, staged, (items) => this.yearIndexes[kind].set(year, items), () => this.yearIndexes[kind].delete(year))) {
        indexesChanged = true;
      }
    }
    if (indexesChanged) {
      this.rebuildIndexArrays();
      this.years = [...new Set(INDEX_KINDS.flatMap((k) => [...this.yearIndexes[k].keys()]))].sort();
    }

    let entriesChanged = false;
    for (const [monday, staged] of stagedWeeks) {
      // A deleted weekly file reads as an empty week, like a 404 on load.
      if (land(weekFilePath(monday), staged, (entries) => this.cacheWeek(monday, entries), () => this.cacheWeek(monday, []))) {
        entriesChanged = true;
      }
    }
    for (const kind of ENTITY_KINDS) {
      for (const [id, staged] of stagedEntities[kind]) {
        if (!landEntity(kind, id, staged)) continue;
        if (kind === 'artifact') this.artifactContents = null;
        entriesChanged = true;
      }
    }
    for (const [path, staged] of stagedAssets) {
      if (land(path, staged, (text) => this.assetCache.set(path, text), () => this.assetCache.delete(path))) {
        this.assetWriteRevisions.set(path, (this.assetWriteRevisions.get(path) ?? 0) + 1);
        entriesChanged = true;
      }
    }

    if (indexesChanged || entriesChanged) {
      this.relationRevision++;
      this.filterWeeksCache.clear();
      this.allWeeksLoad = null;
      // Swap in a freshly built relation map — but only when every listed
      // week is cached (a staged week fetch may have failed); otherwise drop
      // the map so the next getRelations re-runs loadAllWeeks, which retries
      // the missing week (a kept stale map had no repair path for an
      // off-screen week that never gets re-checked).
      if (this.relationsCache) {
        this.relationsCache = this.getWeeklyDates().every((m) => this.weeklyCache.has(m))
          ? this.buildRelations()
          : null;
      }
    }
  }

  // Fetch every weekly file into the cache and resolve to whether all succeeded.
  // Idempotent; on partial failure the memoized promise is dropped so a later
  // call retries the failed weeks (successful ones stay cached).
  loadAllWeeks(): Promise<boolean> {
    if (!this.allWeeksLoad) {
      this.allWeeksLoad = Promise.all(
        this.getWeeklyDates().map((monday) =>
          this.getWeekEntries(monday).then(
            () => true,
            (err) => {
              console.warn(`Failed to load week ${monday}:`, err);
              return false;
            }
          )
        )
      ).then((results) => {
        const complete = !results.includes(false);
        if (!complete) this.allWeeksLoad = null;
        return complete;
      });
    }
    return this.allWeeksLoad;
  }

  async getRelations(): Promise<Relations> {
    if (this.relationsCache) return this.relationsCache;
    const complete = await this.loadAllWeeks();
    const relations = this.buildRelations();
    // Cache only when every week loaded — an incomplete map stays retryable.
    if (complete) this.relationsCache = relations;
    return relations;
  }

  private recordCollection(
    weeks = this.weeklyCache,
    projects = this.entities.project,
    actions = this.entities.action,
    artifacts = this.entities.artifact,
  ): RecordCollection {
    return { entries: [...weeks.values()].flat(), projects, actions, artifacts };
  }

  private buildRelations(): Relations {
    const records = this.recordCollection();
    return buildRelations(records, artifactReferenceSources(records));
  }

  isInitialized(): boolean { return this.initialized; }

  isVerifiedEmpty(): boolean {
    return this.initialized && this.instance !== null && this.diagnostics.size === 0
      && INDEX_KINDS.every(kind => this.indexes[kind].length === 0);
  }

  getNoteIndex(): IndexItem[] {
    return this.indexes.notes;
  }

  getProjectIndex(): IndexItem[] {
    return this.indexes.projects;
  }

  getActionIndex(): IndexItem[] {
    return this.indexes.actions;
  }

  getArtifactIndex(): IndexItem[] {
    return this.indexes.artifacts;
  }

  getWeeklyDates(): string[] {
    return deriveWeeklyFiles(this.indexes.notes);
  }

  // The reverse-chron weeks that contain at least one entry matching `ref`
  // (tag or inline mention, per entryReferences), or null when the timeline
  // isn't fully cached yet — the caller then loads every week instead. Scans
  // the in-memory weekly cache once per ref and memoizes; relationsCache being
  // set guarantees loadAllWeeks succeeded, so every week is present to scan.
  filterWeeks(ref: EntityRef): string[] | null {
    if (!this.relationsCache) return null;
    const key = `${ref.type}/${ref.id}`;
    const memo = this.filterWeeksCache.get(key);
    if (memo) return memo;

    const matching = new Set<string>();
    for (const [monday, entries] of this.weeklyCache) {
      if (entries.some((e) => entryReferences(e, ref))) matching.add(monday);
    }
    const weeks = deriveWeeklyFiles(this.indexes.notes).filter((m) => matching.has(m));
    this.filterWeeksCache.set(key, weeks);
    return weeks;
  }
}
