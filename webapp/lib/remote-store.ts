import { planningActions, resolveProjection, type PlanningPage } from '../../cli/src/core/recurrence';
// Presentation cache for a daemon-owned core. No file parsing or graph building.
import { mapLimit } from '../../cli/src/core/async';
import type { DataSource } from '../../cli/src/core/data-source';
import type { DataSnapshot, StoreView, Relations, SearchProgress, FileDiagnostic, CheckScope, HotSet, PendingUpdate, UpdateSummary } from '../../cli/src/core/data-snapshot';
import type { Entry, Project, Action, Artifact } from '../../cli/src/core/types';
import type { EntityRef } from '../../cli/src/core/record-reference';

export interface SnapshotSource extends Pick<DataSource, 'read' | 'revalidate' | 'assetUrl' | 'assetVersion'> {
  snapshot(version?: string, refresh?: boolean): Promise<{ value: DataSnapshot; version: string } | 'unchanged'>;
}

export class RemoteStore implements StoreView {
  private data!: DataSnapshot;
  private version?: string;
  private revision = 0;
  private appliedRevision = 0;
  private checking = false;
  private weeks = new Map<string, Entry[]>();
  private projects = new Map<string, Project>();
  private actions = new Map<string, Action>();
  private artifacts = new Map<string, Artifact>();
  private relations!: Relations;
  private weeksByEntity = new Map<string, string[]>();
  private entryContents = new Map<string, string>();
  private artifactContents = new Map<string, string>();
  private assetErrors = new Map<string, string>();
  private diagnostics = new Map<string, FileDiagnostic>();
  private searchListeners = new Set<() => void>();
  private diagnosticListeners = new Set<() => void>();
  private assets = new Map<string, { text: string; version: string }>();
  private assetLoads = new Map<string, Promise<string>>();
  private media = new Map<string, string | null | undefined>();
  private assetRevisions = new Map<string, number>();
  private assetReads = new Map<string, number>();

  constructor(private source: SnapshotSource) {}
  async init(): Promise<void> {
    const result = await this.source.snapshot();
    if (result === 'unchanged') throw new Error('The daemon returned no initial data.');
    this.install(result.value, result.version, ++this.revision);
  }
  private install(data: DataSnapshot, version: string, revision: number, notify = true): void {
    if (revision < this.appliedRevision) return;
    this.appliedRevision = revision;
    this.data = data;
    this.version = version;
    this.weeks = new Map(data.weeks);
    this.projects = new Map(data.projects);
    this.actions = new Map(data.actions);
    this.artifacts = new Map(data.artifacts);
    this.weeksByEntity = new Map(data.weeksByEntity);
    this.relations = Object.fromEntries(Object.entries(data.relations).map(([key, values]) => [key, new Map(values as [string, unknown][])])) as unknown as Relations;
    this.entryContents = new Map(data.weeks.flatMap(([, entries]) => entries.map(entry => [entry.meta.created, entry.content] as [string, string])));
    this.artifactContents = new Map(data.artifacts.map(([id, artifact]) => [id, artifact.body]));
    this.diagnostics = new Map(data.diagnostics.map(diagnostic => [diagnostic.path, diagnostic]));
    for (const [path, error] of this.assetErrors) {
      this.diagnostics.set(path, { path, issues: this.diagnostics.get(path)?.issues ?? [], error });
    }
    if (notify) this.publish();
  }
  private publish(): void {
    for (const listener of this.diagnosticListeners) listener();
    for (const listener of this.searchListeners) listener();
  }
  subscribeSearch(listener: () => void): () => void { this.searchListeners.add(listener); return () => this.searchListeners.delete(listener); }
  subscribeDiagnostics(listener: () => void): () => void { this.diagnosticListeners.add(listener); return () => this.diagnosticListeners.delete(listener); }
  getSearchProgress(): SearchProgress { return this.data.searchProgress; }
  async warmSearch(retry = false): Promise<void> { if (retry) await this.refresh(); }
  getDiagnostics(): FileDiagnostic[] { return [...this.diagnostics.values()]; }
  diagnosticsFor(path: string): FileDiagnostic | undefined { return this.diagnostics.get(path); }
  getInstance() { return this.data.instance; }
  getDisplayName(kind: 'project' | 'action', id: string): string { return (kind === 'project' ? this.projects.get(id) : this.getCachedAction(id))?.frontMatter.name ?? id; }
  getArtifactDisplayName(id: string): string { return this.artifacts.get(id)?.frontMatter.name ?? id; }
  getCachedProject(id: string) { return this.projects.get(id); }
  getCachedAction(id: string) { return this.actions.get(id) ?? resolveProjection(this.actions, id); }
  async getPlanningActions(project?: string, after?: string): Promise<PlanningPage> {
    const relations = await this.getRelations();
    return planningActions(this.actions, { projectionsOnly: true, templates: project ? relations.actionsByProject.get(project) ?? [] : undefined, after, lookaheadDays: this.getInstance()?.manifest.config?.recurrenceLookaheadDays });
  }

  getCachedArtifact(id: string) { return this.artifacts.get(id); }
  getCachedEntryContents() { return this.entryContents; }
  getCachedArtifactContents() { return this.artifactContents; }
  async getWeekEntries(week: string): Promise<Entry[]> { return this.weeks.get(week) ?? []; }
  async getProject(id: string): Promise<Project> { return this.require(this.projects, 'Project', id); }
  async getAction(id: string): Promise<Action> { return this.getCachedAction(id) ?? this.require(this.actions, 'Action', id); }
  async getArtifact(id: string): Promise<Artifact> { return this.require(this.artifacts, 'Artifact', id); }
  private require<T>(records: Map<string, T>, kind: string, id: string): T {
    const value = records.get(id);
    if (!value) throw new Error(`${kind} record not found: ${id}`);
    return value;
  }
  async getRelations(): Promise<Relations> { return this.relations; }
  async loadAllWeeks(): Promise<boolean> { return this.data.weeklyDates.every(week => this.weeks.has(week)); }
  isInitialized(): boolean { return this.version !== undefined; }
  isVerifiedEmpty(): boolean { return this.isInitialized() && this.data.instance !== null && this.diagnostics.size === 0 && Object.values(this.data.indexes).every(items => items.length === 0); }
  getNoteIndex() { return this.data.indexes.notes; }
  getProjectIndex() { return this.data.indexes.projects; }
  getActionIndex() { return this.data.indexes.actions; }
  getArtifactIndex() { return this.data.indexes.artifacts; }
  getWeeklyDates(): string[] { return this.data.weeklyDates; }
  filterWeeks(ref: EntityRef): string[] { return this.weeksByEntity.get(`#${ref.type}/${ref.id}`) ?? []; }
  hasValidators(): boolean { return true; }

  private async refresh(): Promise<void> {
    const revision = ++this.revision;
    const result = await this.source.snapshot(undefined, true);
    if (result !== 'unchanged') this.install(result.value, result.version, revision);
  }
  async reloadFile(path: string): Promise<void> {
    if (this.assets.has(path) || this.assetReads.has(path)) {
      if (this.media.has(path)) await this.prepareAssetUrl(path, true);
      else await this.readAsset(path, true);
    } else await this.refresh();
  }

  async check(scope: CheckScope, hot: HotSet, changedPaths: string[] = []): Promise<PendingUpdate | null> {
    if (this.checking) return null;
    this.checking = true;
    try {
      const revision = ++this.revision;
      const result = await this.source.snapshot(this.version, scope === 'full' || changedPaths.length > 0);
      const summary: UpdateSummary = { weeks: new Set(), entities: new Set(), assets: new Set(), indexesChanged: false };
      if (result !== 'unchanged') {
        summary.indexesChanged = JSON.stringify(result.value.indexes) !== JSON.stringify(this.data.indexes) || JSON.stringify(result.value.instance) !== JSON.stringify(this.data.instance);
        const diff = <T>(previous: [string, T][], next: [string, T][], changed: Set<string>, prefix = '') => {
          const before = new Map(previous), after = new Map(next);
          for (const id of new Set([...before.keys(), ...after.keys()])) {
            if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))) changed.add(prefix + id);
          }
        };
        diff(this.data.weeks, result.value.weeks, summary.weeks);
        diff(this.data.projects, result.value.projects, summary.entities, '#project/');
        diff(this.data.actions, result.value.actions, summary.entities, '#action/');
        diff(this.data.artifacts, result.value.artifacts, summary.entities, '#artifact/');
        // Supporting Markdown can change the graph while records stay identical.
        summary.indexesChanged ||= JSON.stringify(result.value.relations) !== JSON.stringify(this.data.relations);
      }
      const assetStages = new Map<string, { text: string; version: string } | null>();
      const mediaStages = new Map<string, string | null | undefined>();
      const assetBases = new Map<string, number>();
      const clearedErrors = new Set<string>();
      const paths = new Set([...(scope === 'full' ? [...this.assets.keys(), ...this.assetLoads.keys(), ...this.media.keys(), ...this.assetErrors.keys()] : hot.assets), ...changedPaths.filter(path => this.assets.has(path) || this.assetLoads.has(path) || this.media.has(path) || this.assetErrors.has(path))]);
      await mapLimit([...paths], 6, async path => {
        assetBases.set(path, this.assetReads.get(path) ?? 0);
        const cached = this.assets.get(path);
        try {
          if (cached || this.assetLoads.has(path) || (!this.media.has(path) && this.assetErrors.has(path))) {
            const value = cached ? await this.source.revalidate(path, cached.version) : await this.source.read(path);
            if (value !== 'unchanged') { assetStages.set(path, value); summary.assets.add(path); }
          } else if (this.media.has(path)) {
            const value = await this.source.assetVersion?.(path);
            if (value === undefined) {
              if (changedPaths.includes(path)) { mediaStages.set(path, value); summary.assets.add(path); }
              return;
            }
            if (value !== this.media.get(path) || changedPaths.includes(path)) { mediaStages.set(path, value); summary.assets.add(path); }
          } else return;
          if (this.assetErrors.has(path)) { clearedErrors.add(path); summary.assets.add(path); }
        } catch (error) {
          if (revision >= this.appliedRevision && (this.assetReads.get(path) ?? 0) === assetBases.get(path)) this.reportAssetFailure(path, error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (result === 'unchanged' && !summary.assets.size && !clearedErrors.size) return null;
      return { summary, apply: () => {
        if (revision < this.appliedRevision) return;
        if (result !== 'unchanged') this.install(result.value, result.version, revision, false);
        this.appliedRevision = revision;
        for (const path of clearedErrors) {
          if ((this.assetReads.get(path) ?? 0) === assetBases.get(path)) this.clearAssetFailure(path);
        }
        for (const [path, value] of assetStages) {
          if ((this.assetReads.get(path) ?? 0) !== assetBases.get(path)) continue;
          this.assetReads.set(path, (this.assetReads.get(path) ?? 0) + 1);
          if (value) this.assets.set(path, value); else this.assets.delete(path);
          this.clearAssetFailure(path);
        }
        for (const [path, value] of mediaStages) {
          if ((this.assetReads.get(path) ?? 0) !== assetBases.get(path)) continue;
          this.assetReads.set(path, (this.assetReads.get(path) ?? 0) + 1);
          this.media.set(path, value);
          this.assetRevisions.set(path, (this.assetRevisions.get(path) ?? 0) + 1);
          if (value === null) this.setAssetFailure(path, 'Media file is missing');
          else if (value !== undefined) this.clearAssetFailure(path);
        }
        this.publish();
      } };
    } finally { this.checking = false; }
  }

  getAsset(path: string): Promise<string> { return this.readAsset(path); }
  private readAsset(path: string, force = false): Promise<string> {
    const cached = this.assets.get(path);
    if (!force && cached) return Promise.resolve(cached.text);
    const pending = this.assetLoads.get(path);
    if (!force && pending) return pending;
    const revision = (this.assetReads.get(path) ?? 0) + 1;
    this.assetReads.set(path, revision);
    const missing = () => new Error(`Asset file not found: ${path}`);
    let load!: Promise<string>;
    load = (async (): Promise<string> => {
      try {
        const value = await this.source.read(path);
        if (this.assetReads.get(path) !== revision) {
          const newer = this.assetLoads.get(path);
          if (newer && newer !== load) return newer;
          const latest = this.assets.get(path);
          if (!latest) throw missing();
          return latest.text;
        }
        if (!value) throw missing();
        this.assets.set(path, value);
        this.clearAssetFailure(path);
        this.publish();
        return value.text;
      } catch (error) {
        if (this.assetReads.get(path) === revision) this.reportAssetFailure(path, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    })();
    this.assetLoads.set(path, load);
    const done = () => { if (this.assetLoads.get(path) === load) this.assetLoads.delete(path); };
    load.then(done, done);
    return load;
  }
  assetUrl(path: string): string | null {
    const url = this.source.assetUrl(path);
    if (!url) return null;
    if (!this.media.has(path)) this.media.set(path, undefined);
    const revision = this.assetRevisions.get(path);
    return revision === undefined ? url : `${url}${url.includes('?') ? '&' : '?'}aside_revision=${revision}`;
  }
  async prepareAssetUrl(path: string, retry = false): Promise<string | null> {
    if (!this.assetUrl(path)) return null;
    if (!retry && this.media.get(path) != null && !this.diagnosticsFor(path)?.error) return this.assetUrl(path);
    const revision = (this.assetReads.get(path) ?? 0) + 1;
    this.assetReads.set(path, revision);
    try {
      const version = await this.source.assetVersion?.(path);
      if (this.assetReads.get(path) !== revision) return this.assetUrl(path);
      if (version === null) throw new Error(`Media file not found: ${path}`);
      this.media.set(path, version);
      this.clearAssetFailure(path);
      if (retry) this.assetRevisions.set(path, (this.assetRevisions.get(path) ?? 0) + 1);
      this.publish();
      return this.assetUrl(path);
    } catch (error) {
      if (this.assetReads.get(path) === revision) this.reportAssetFailure(path, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  private clearAssetFailure(path: string): void {
    this.assetErrors.delete(path);
    const diagnostic = this.data.diagnostics.find(diagnostic => diagnostic.path === path);
    if (diagnostic) this.diagnostics.set(path, diagnostic);
    else this.diagnostics.delete(path);
  }
  private setAssetFailure(path: string, error: string): void {
    if (!this.assetReads.has(path)) this.assetReads.set(path, 0);
    this.assetErrors.set(path, error);
    this.diagnostics.set(path, { path, issues: this.diagnostics.get(path)?.issues ?? [], error });
  }
  reportAssetFailure(path: string, error: Error): void {
    this.setAssetFailure(path, error.message);
    this.publish();
  }
}
