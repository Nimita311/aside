import { STORE_REBUILD_DEBOUNCE_MS, ATTACHMENT_POLL_INTERVAL_MS } from '../core/system-config.js';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import { readInstanceData, type InstanceFile } from '../core/reader.js';
import { assertManagedPath, readManagedText } from '../core/managed-path.js';
import { artifactAttachmentPath, collectArtifactReferenceSources, listArtifactAttachments, parseArtifactHandle } from '../core/artifact.js';
import { isMap, parseDocument, stringify } from 'yaml';
import { parseProjectFile, parseActionFile, parseArtifactFile, parseWeeklyFile } from '../core/parser.js';
import type { ArtifactReferenceSource } from '../core/artifact.js';
import { artifactReferenceSources, type Relations } from '../core/record-model.js';
import { DataCore } from '../core/data-core.js';
import { assertRecurrence, assertRecurrenceUpdate, assertOccurrence, occurrenceKey, recurrenceIssues, type RecurrenceSchedule } from '../core/recurrence.js';
import type { CoreRecords, DataSnapshot } from '../core/data-snapshot.js';
import { MANIFEST_FILE, readInstanceRecordResult, emptyManifest } from '../core/instance.js';
import { serializeProject, serializeAction, serializeArtifact } from './tools/serialize.js';
import type { RelatedProjectEdits } from './tools/link-edits.js';
import type { AutomationEdits } from './tools/automation-edits.js';
import { mergeMetadata } from './tools/front-matter.js';
import { assertScheduling } from '../core/scheduling.js';
import { prependIndex, updateIndexDescription, oneLineDescription, writeFileCrashSafe } from './tools/index-file.js';
import { readRecurrenceHistory, recurrenceHistoryPath, writeRecurrenceHistory } from './recurrence-history.js';
import { persistMutationWrite, recordMutationChange, recordMutationFailure } from './tools/mutation-result.js';
import type {
  Entry,
  Project,
  Action,
  Artifact,
  ProjectFrontMatter,
  ActionFrontMatter,
  ArtifactFrontMatter,
  Manifest,
  IndexItem,
  ParseIssue,
  ParseResult,
  IndexKind,
  RecordIndexes,
} from '../core/types.js';

// Which entity's year index a synchronous update targets.
export type { IndexKind } from '../core/types.js';

// What one load of the instance yields: the state `rebuild` swaps in whole.
interface Loaded extends CoreRecords {
  files: Record<IndexKind, Map<string, string>>;
}

function attachmentStat(root: string, file: string): Stats | undefined {
  try {
    assertManagedPath(root, dirname(file), 'directory');
    return lstatSync(file);
  } catch { return undefined; }
}

function attachmentChanged(current: Stats | undefined, previous: Stats | undefined): boolean {
  if (!current || !previous) return current !== previous;
  return current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs || current.size !== previous.size || current.ino !== previous.ino || current.nlink !== previous.nlink;
}

// Attachment-only reconciliation edits the YAML document instead of serializing
// the parsed record, preserving custom keys, comments, and the exact body bytes.
function reconcileArtifactAttachments(dataDir: string, id: string, artifact: Artifact, file: string, owner: object): boolean {
  const original = readManagedText(dataDir, file);
  const attachments = listArtifactAttachments(dataDir, id);
  if (attachments.length) artifact.frontMatter.attachments = attachments;
  else delete artifact.frontMatter.attachments;
  const match = original.match(/^(\uFEFF?\s*---[ \t\r]*\n)(?:([\s\S]*?)\n)?(---[ \t\r]*(?:\n[\s\S]*)?)$/);
  if (!match) return false;
  const metadata = (match[2] ?? '').replace(/\r(?=\n|$)/g, '');
  const document = parseDocument(metadata);
  if (document.errors.length || !isMap(document.contents)) return false;
  const values = document.toJS({ mapAsMap: true }) as Map<unknown, unknown>;
  if (attachments.length ? JSON.stringify(values.get('attachments')) === JSON.stringify(attachments) : !values.has('attachments')) return false;
  const newline = match[1].endsWith('\r\n') ? '\r\n' : '\n';
  const yaml = mergeMetadata(metadata, stringify(attachments.length ? { attachments } : {}), ['attachments'], file).replace(/\n/g, newline);
  persistMutationWrite(owner, {kind: 'artifact', id, effect: 'UPDATED', path: file, fields: ['attachments']},
    () => writeFileCrashSafe(file, `${match[1]}${yaml}${newline}${match[3]}`, dataDir));
  return true;
}

export class Store {
  private changeListeners = new Set<() => void>();
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }
  private dataDir: string;
  private readonly core = new DataCore();
  private snapshotCache: Promise<DataSnapshot> | undefined;
  private revision = 0;
  private recordRevision = 0;
  private readonly indexRevisions: Record<IndexKind, number> = { notes: 0, projects: 0, actions: 0, artifacts: 0 };
  private get entries(): Entry[] { return this.core.getEntries(); }
  private get projects(): ReadonlyMap<string, Project> { return this.core.getProjects(); }
  private get actions(): ReadonlyMap<string, Action> { return this.core.getActions(); }
  private get artifacts(): ReadonlyMap<string, Artifact> { return this.core.getArtifacts(); }
  private get indexes(): RecordIndexes { return this.core.getIndexes(); }
  private get relations(): Relations { return this.core.cachedRelations(); }
  private get manifest(): Manifest { return this.core.getInstance()?.manifest ?? emptyManifest(); }
  private get issues(): ParseIssue[] { return this.core.getIssues(); }
  private set issues(issues: ParseIssue[]) { this.core.setIssues(issues); this.invalidateSnapshots(); }
  snapshot(): Promise<DataSnapshot> { return this.snapshotCache ??= this.core.snapshot(); }
  // Includes descriptions, diagnostics, and attachment metadata, not just records.
  getRevision(): number { return this.revision; }
  getRecordRevision(): number { return this.recordRevision; }
  getIndexRevision(kind: IndexKind): number { return this.indexRevisions[kind]; }
  private invalidateSnapshots(indexKind?: IndexKind): void {
    this.snapshotCache = undefined;
    this.revision++;
    if (indexKind) this.indexRevisions[indexKind]++;
    else this.recordRevision++;
  }
  private referencedArtifactFiles: string[] = [];
  private attachmentWatches = new Map<string, Stats | undefined>();
  private attachmentPoll: ReturnType<typeof setInterval> | undefined;
  // Absolute file path each entity was loaded from, per kind. Entries map to
  // their weekly file (several entries share one); the rest to their own file.
  private files: Record<IndexKind, Map<string, string>> = { notes: new Map(), projects: new Map(), actions: new Map(), artifacts: new Map() };
  private watcher: ReturnType<typeof chokidarWatch> | null = null;
  private recurrenceHistory = new Map<string, RecurrenceSchedule[]>();
  private recurrenceHistoryFile: string | undefined;
  private recurrenceHistoryError: string | undefined;
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.rebuild();
  }

  // Load into fresh structures first and only swap them in on success, so a
  // throw mid-load (e.g. under the watcher) keeps the previous state intact.
  rebuild(): void {
    const loaded = this.load();
    const historyFile = recurrenceHistoryPath(this.dataDir, loaded.instance.manifest.id ?? '');
    if (historyFile !== this.recurrenceHistoryFile || this.recurrenceHistoryError) {
      if (historyFile !== this.recurrenceHistoryFile) this.recurrenceHistory = new Map();
      this.recurrenceHistoryFile = historyFile;
      try { this.recurrenceHistory = readRecurrenceHistory(historyFile); this.recurrenceHistoryError = undefined; }
      catch (error) { this.recurrenceHistoryError = `Cannot read accepted recurrence history: ${(error as Error).message}`; }
    }
    const accepted = new Map(this.recurrenceHistory);
    const referencedTemplates = new Set([...loaded.actions.values()].flatMap(action => action.frontMatter.occurrence ? [action.frontMatter.occurrence.template] : []));
    const coveredOriginals = new Map<string, Set<string>>();
    for (const action of loaded.actions.values()) if (action.frontMatter.occurrence) {
      const occurrence = action.frontMatter.occurrence;
      const originals = coveredOriginals.get(occurrence.template) ?? new Set<string>();
      originals.add(occurrence.original);
      coveredOriginals.set(occurrence.template, originals);
    }
    for (const [id, action] of loaded.actions) {
      const before = this.recurrenceHistory.get(id);
      try {
        if (this.recurrenceHistoryError && (before || action.frontMatter.recurrence)) throw new Error(this.recurrenceHistoryError);
        const file = loaded.files.actions.get(id), relativeFile = file && relative(this.dataDir, file);
        if ((before || action.frontMatter.recurrence !== undefined) && loaded.issues.some(issue => issue.severity === 'error' && (issue.file === file || issue.file === relativeFile) && (issue.field === 'recurrence' || issue.code === 'invalid_yaml'))) throw new Error('Recurrence declaration is malformed; preserve accepted history until it is repaired.');
        if (action.frontMatter.recurrence) {
          assertRecurrence(action.frontMatter.recurrence);
          if (action.frontMatter.scheduled || action.frontMatter.resolution || action.frontMatter.occurrence) throw new Error('A recurrence template cannot also be scheduled, resolved, or an occurrence.');
        } else if (before) {
          if (referencedTemplates.has(id)) throw new Error('Cannot remove recurrence from a referenced template; retain the template with recurrence: [].');
          throw new Error('Cannot clear a recurrence template; remove its schedules and retain recurrence: [].');
        }
        assertRecurrenceUpdate(before, action.frontMatter.recurrence, new Date(), coveredOriginals.get(id));
        if (action.frontMatter.recurrence) accepted.set(id, structuredClone(action.frontMatter.recurrence));
        else accepted.delete(id);
      }
      catch (error) { loaded.issues.push({ severity: 'error', code: 'recurrence_history_changed', message: (error as Error).message, file: loaded.files.actions.get(id), field: 'recurrence' }); }
    }
    for (const id of this.recurrenceHistory.keys()) if (!loaded.actions.has(id)) loaded.issues.push({ severity: 'error', code: 'invalid_recurrence_relationship', message: `${id}: Recurrence template is missing; retain the template and end its final rule.`, file: this.files.actions.get(id), field: 'recurrence' });
    if (!this.recurrenceHistoryError && JSON.stringify([...accepted]) !== JSON.stringify([...this.recurrenceHistory])) {
      try { writeRecurrenceHistory(historyFile, accepted); this.recurrenceHistory = accepted; }
      catch (error) {
        this.recurrenceHistoryError = `Cannot save accepted recurrence history: ${(error as Error).message}`;
        for (const [id, action] of loaded.actions) if (action.frontMatter.recurrence) loaded.issues.push({ severity: 'error', code: 'recurrence_history_changed', message: this.recurrenceHistoryError, file: loaded.files.actions.get(id), field: 'recurrence' });
      }
    }
    for (const message of recurrenceIssues(loaded.actions)) loaded.issues.push({ severity: 'error', code: 'invalid_recurrence_relationship', message });
    this.core.replaceRecords(loaded);
    this.invalidateSnapshots();
    const present: Record<IndexKind, Set<string>> = {
      notes: new Set(this.core.getEntries().map(entry => entry.meta.created)),
      projects: new Set(this.core.getProjects().keys()), actions: new Set(this.core.getActions().keys()), artifacts: new Set(this.core.getArtifacts().keys()),
    };
    for (const kind of Object.keys(present) as IndexKind[]) for (const [id, file] of this.files[kind]) {
      if (present[kind].has(id) && !loaded.files[kind].has(id)) loaded.files[kind].set(id, file);
    }
    this.files = loaded.files;
    this.buildRelationships();
  }

  // Raw data access

  getEntries(): Entry[] {
    return this.entries;
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  getAction(id: string): Action | undefined {
    return this.actions.get(id);
  }

  getArtifact(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  // The entities by id — live, read-only views of the store's maps.
  getProjects(): ReadonlyMap<string, Project> {
    return this.projects;
  }

  getActions(): ReadonlyMap<string, Action> {
    return this.actions;
  }

  getArtifacts(): ReadonlyMap<string, Artifact> {
    return this.artifacts;
  }

  getProjectIds(): string[] {
    return Array.from(this.projects.keys());
  }

  getActionIds(): string[] {
    return Array.from(this.actions.keys());
  }

  getArtifactIds(): string[] {
    return Array.from(this.artifacts.keys());
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

  // The one-line index description of an entity, when it is indexed.
  getIndexDescription(kind: IndexKind, id: string): string | undefined {
    return this.indexes[kind].find((item) => item.id === id)?.description;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  // Absolute path of the file backing an entity, for agents that want to edit
  // it directly. Entries resolve to their weekly file. Undefined if unknown.
  getEntryFile(id: string): string | undefined {
    return this.files.notes.get(id);
  }

  getProjectFile(id: string): string | undefined {
    return this.files.projects.get(id);
  }

  getActionFile(id: string): string | undefined {
    return this.files.actions.get(id);
  }

  getArtifactFile(id: string): string | undefined {
    return this.files.artifacts.get(id);
  }

  // Instance manifest (name/description/version) from `aside.md`.
  getInstance() { return this.core.getInstance(); }

  getManifest(): Manifest {
    return this.manifest;
  }

  // Parse issues collected during the last rebuild, tagged with their file
  // (relative to the data dir). The server surfaces these to the agent so it
  // knows when a file was loaded best-effort rather than cleanly.
  getIssues(): ParseIssue[] {
    return this.issues;
  }

  // Derived relationships

  getRelations(): Relations { return this.relations; }

  getActionsForProject(projectId: string): string[] {
    return Array.from(this.relations.actionsByProject.get(projectId) ?? []);
  }

  getProjectsForAction(actionId: string): string[] {
    return Array.from(this.relations.projectsByAction.get(actionId) ?? []);
  }

  getProjectsForArtifact(id: string): string[] {
    return Array.from(this.relations.projectsByArtifact.get(id) ?? []);
  }

  getActionsForArtifact(id: string): string[] {
    return Array.from(this.relations.actionsByArtifact.get(id) ?? []);
  }

  getArtifactBacklinks(id: string): string[] {
    return Array.from(this.relations.artifactBacklinks.get(id) ?? []);
  }

  getReferencedArtifactFiles(): string[] {
    return [...this.referencedArtifactFiles];
  }

  getArtifactReferenceSources(): ArtifactReferenceSource[] {
    return artifactReferenceSources(this.core.getRecords());
  }

  // ----- Writes: disk and memory together -----
  // capture and update persist every change through these methods, so the on-disk
  // file and the in-memory copy are derived from the same serialization. This
  // includes untouched metadata preserved from a newer external edit. A read
  // later in the same call — and the calendar sync that
  // follows — sees fresh state without waiting for the watcher (which stays, below,
  // only to pick up edits made outside these tools). Each method mirrors the parser
  // (trims body/content, drops empty lists) so memory equals a rebuild from disk.

  // Write a project to its file and into memory. `file` is its absolute path.
  saveProject(id: string, frontMatter: ProjectFrontMatter, body: string | undefined, file: string, fields?: readonly string[], automationEdits?: AutomationEdits, relatedProjectEdits?: RelatedProjectEdits): void {
    assertManagedPath(this.dataDir, file, 'file', true);
    const serialized = serializeProject(frontMatter, body, file, fields, automationEdits, relatedProjectEdits);
    const persisted = parseProjectFile(serialized).value;
    mkdirSync(dirname(file), { recursive: true });
    let unchanged = false;
    try { unchanged = readManagedText(this.dataDir, file) === serialized; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!unchanged) persistMutationWrite(this, {kind: 'project', id, effect: existsSync(file) ? 'UPDATED' : 'CREATED', path: file},
      () => writeFileCrashSafe(file, serialized, this.dataDir));
    this.core.upsertEntity('project', id, persisted);
    this.invalidateSnapshots();
    this.files.projects.set(id, file);
    this.buildRelationships();
  }

  getOccurrenceOriginals(template: string): ReadonlySet<string> {
    return new Set([...this.getActions().values()].flatMap(action => action.frontMatter.occurrence?.template === template ? [action.frontMatter.occurrence.original] : []));
  }

  assertRecurrenceChange(id: string, recurrence: RecurrenceSchedule[] | undefined): void {
    if (this.recurrenceHistoryError && (recurrence || this.getAction(id)?.frontMatter.recurrence)) throw new Error(this.recurrenceHistoryError);
    const before = this.recurrenceHistory.get(id);
    if (before === undefined || JSON.stringify(before) === JSON.stringify(recurrence)) return;
    assertRecurrenceUpdate(before, recurrence, new Date(), this.getOccurrenceOriginals(id));
  }

  // Write an action to its file and into memory. `file` is its absolute path.
  saveAction(id: string, frontMatter: ActionFrontMatter, body: string | undefined, file: string, fields?: readonly string[]): void {
    assertManagedPath(this.dataDir, file, 'file', true);
    const serialized = serializeAction(frontMatter, body, file, fields);
    const parsed = parseActionFile(serialized);
    const declarationIssue = parsed.issues.find(issue => issue.code === 'invalid_recurrence' || issue.code === 'invalid_occurrence'
      || issue.code === 'wrong_type' && ['scheduled', 'deadline', 'timezone', 'duration'].includes(issue.field ?? ''));
    if (declarationIssue) throw new Error(declarationIssue.message);
    const persisted = parsed.value;
    // Untouched fields can come from a newer external edit. Validate and accept
    // exactly the recurrence/provenance that will be persisted, not stale input.
    frontMatter = persisted.frontMatter;
    assertScheduling(frontMatter);
    const previous = this.getAction(id)?.frontMatter;
    if (frontMatter.recurrence !== undefined) {
      frontMatter.recurrence = assertRecurrence(frontMatter.recurrence);
      if (frontMatter.scheduled || frontMatter.resolution || frontMatter.occurrence) throw new Error('A recurrence template cannot also be scheduled, resolved, or an occurrence.');
    }
    this.assertRecurrenceChange(id, frontMatter.recurrence);
    if ((previous?.recurrence !== undefined || this.recurrenceHistory.has(id)) && frontMatter.recurrence === undefined) {
      if ([...this.getActions().values()].some(action => action.frontMatter.occurrence?.template === id)) throw new Error('Cannot remove recurrence from a referenced template; retain the template with recurrence: [].');
      throw new Error('Cannot clear a recurrence template; remove its schedules and retain recurrence: [].');
    }
    if (frontMatter.occurrence) {
      frontMatter.occurrence = assertOccurrence(frontMatter.occurrence);
      if (!this.getAction(frontMatter.occurrence.template)?.frontMatter.recurrence) throw new Error('Occurrence template is missing or is not a recurrence template.');
      if (previous?.occurrence && JSON.stringify(previous.occurrence) !== JSON.stringify(frontMatter.occurrence)) throw new Error('Occurrence provenance is immutable.');
      for (const [otherId, other] of this.getActions()) if (otherId !== id && other.frontMatter.occurrence && occurrenceKey(other.frontMatter.occurrence) === occurrenceKey(frontMatter.occurrence)) throw new Error(`Occurrence is already saved as ${otherId}.`);
    } else if (previous?.occurrence) throw new Error('Occurrence provenance cannot be removed.');
    mkdirSync(dirname(file), { recursive: true });
    const accepted = new Map(this.recurrenceHistory);
    if (frontMatter.recurrence) accepted.set(id, structuredClone(frontMatter.recurrence));
    else accepted.delete(id);
    const historyChanged = JSON.stringify([...accepted]) !== JSON.stringify([...this.recurrenceHistory]);
    // Persist before acknowledging the record write, so a restart cannot forget
    // a successfully accepted schedule. A failed record write retains the old
    // baseline. A crash between the two writes errs toward a history diagnostic.
    if (historyChanged) writeRecurrenceHistory(this.recurrenceHistoryFile!, accepted);
    try { persistMutationWrite(this, {kind: 'action', id, effect: existsSync(file) ? 'UPDATED' : 'CREATED', path: file},
      () => writeFileCrashSafe(file, serialized, this.dataDir)); }
    catch (error) {
      if (historyChanged) try { writeRecurrenceHistory(this.recurrenceHistoryFile!, this.recurrenceHistory); }
      catch (rollbackError) {
        recordMutationChange(this, {kind: 'recurrenceHistory', id, effect: 'UPDATED', path: this.recurrenceHistoryFile!});
        recordMutationFailure(this, {kind: 'recurrenceHistory', id, path: this.recurrenceHistoryFile!, message: (rollbackError as Error).message});
        this.recurrenceHistoryError = `Cannot restore accepted recurrence history after a failed record write: ${(rollbackError as Error).message}`;
        this.issues = [...this.issues, { severity: 'error', code: 'recurrence_history_changed', message: this.recurrenceHistoryError, file, field: 'recurrence' }];
        throw new Error(`${(error as Error).message}. ${this.recurrenceHistoryError}`, { cause: error });
      }
      throw error;
    }
    this.recurrenceHistory = accepted;
    this.core.upsertEntity('action', id, persisted);
    this.invalidateSnapshots();
    this.files.actions.set(id, file);
    this.buildRelationships();
  }

  saveArtifact(id: string, frontMatter: ArtifactFrontMatter, body: string | undefined, file: string, fields?: readonly string[]): void {
    assertManagedPath(this.dataDir, file, 'file', true);
    mkdirSync(dirname(file), { recursive: true });
    const attachments = listArtifactAttachments(this.dataDir, id);
    if (attachments.length) frontMatter.attachments = attachments;
    else delete frontMatter.attachments;
    const serialized = serializeArtifact(frontMatter, body, file, fields);
    const persisted = parseArtifactFile(serialized).value;
    persistMutationWrite(this, {kind: 'artifact', id, effect: existsSync(file) ? 'UPDATED' : 'CREATED', path: file},
      () => writeFileCrashSafe(file, serialized, this.dataDir));
    this.core.upsertEntity('artifact', id, persisted);
    this.invalidateSnapshots();
    this.files.artifacts.set(id, file);
    this.buildRelationships();
  }

  refreshArtifactAttachments(id: string): void {
    const artifact = this.artifacts.get(id);
    const file = this.files.artifacts.get(id);
    if (!artifact || !file) throw new Error(`Artifact "${id}" not found.`);
    try {
      reconcileArtifactAttachments(this.dataDir, id, artifact, file, this);
      const persisted = parseArtifactFile(readManagedText(this.dataDir, file)).value;
      // Inventory is authoritative even when malformed metadata prevented a
      // rewrite. Retain that overlay while refreshing newer name/body edits.
      if (artifact.frontMatter.attachments?.length) persisted.frontMatter.attachments = artifact.frontMatter.attachments;
      else delete persisted.frontMatter.attachments;
      this.core.upsertEntity('artifact', id, persisted);
    } finally {
      // Reconciliation can change memory before a filesystem operation fails.
      this.invalidateSnapshots();
    }
    this.buildRelationships();
  }

  // Write a weekly file (already rendered by the caller, which owns the entry-block
  // layout) and upsert its entry into memory, keyed by created timestamp.
  // Parse the rendered block so preserved external link edits are also reflected
  // in relationships immediately, before the watcher sees the file.
  saveEntry(created: string, _projectIds: string[], _actionIds: string[], _content: string, file: string, weeklyContent: string): void {
    assertManagedPath(this.dataDir, file, 'file', true);
    const entry = parseWeeklyFile(weeklyContent, basename(file)).value.entries.find(entry => entry.meta.created === created);
    if (!entry) throw new Error(`Cannot save entry "${created}" — not found in the rendered weekly file.`);
    mkdirSync(dirname(file), { recursive: true });
    persistMutationWrite(this, {kind: 'entry', id: created, effect: this.files.notes.has(created) ? 'UPDATED' : 'CREATED', path: file},
      () => writeFileCrashSafe(file, weeklyContent, this.dataDir));
    this.core.upsertEntry(entry);
    this.invalidateSnapshots();
    this.files.notes.set(created, file);
    this.buildRelationships();
  }

  // Prepend a new item (newest first) to the year index beside `file`, on disk and
  // in memory. `kind` is the entity's subdir. The entity's own write created the
  // directory, so this only appends. Descriptions are made single-line here (and
  // in setIndexEntry) — the two places one enters an index.
  addIndexEntry(kind: IndexKind, file: string, id: string, description: string): void {
    const desc = oneLineDescription(description);
    const indexFile = join(dirname(file), 'index.yaml');
    persistMutationWrite(this, {kind: 'index', id, effect: 'CREATED', path: indexFile, fields: ['description']},
      () => prependIndex(indexFile, id, desc, this.dataDir));
    this.indexes[kind].unshift({ id, description: desc });
    this.invalidateSnapshots(kind);
  }

  // Update an existing index item's description in place, on disk and in memory.
  // The index lives beside the entity's own file, so its path resolves from the
  // file the entity was loaded from. No-op when the item is absent (matches
  // updateIndexDescription on disk); returns whether the description was saved,
  // so the update tools can say when a description was not persisted.
  setIndexEntry(kind: IndexKind, id: string, description: string): boolean {
    const desc = oneLineDescription(description);
    const file = this.files[kind].get(id);
    const item = this.indexes[kind].find((it) => it.id === id);
    if (!file || !item) {
      recordMutationFailure(this, {kind: 'index', id, fields: ['description'], message: 'Description not saved: index entry is missing. Run aside instance validate.'});
      return false;
    }
    const indexFile = join(dirname(file), 'index.yaml');
    let saved: boolean;
    try { saved = updateIndexDescription(indexFile, id, desc, this.dataDir); }
    catch (error) {
      recordMutationFailure(this, {kind: 'index', id, path: indexFile, fields: ['description'], message: error instanceof Error ? error.message : String(error)});
      throw error;
    }
    if (!saved) {
      recordMutationFailure(this, {kind: 'index', id, path: indexFile, fields: ['description'], message: 'Description not saved: index entry is unavailable or could not be safely updated. Run aside instance validate.'});
      return false;
    }
    recordMutationChange(this, {kind: 'index', id, effect: 'UPDATED', path: indexFile, fields: ['description']});
    item.description = desc;
    this.invalidateSnapshots(kind);
    return true;
  }

  // The watcher catches edits made outside the daemon's tools — manual file edits and
  // the syncer's reverse-calendar writes — rebuilding from disk after a 100ms
  // debounce. capture/update keep the store fresh on their own (see above).
  watch(): void {
    const watchedRoot = assertManagedPath(this.dataDir, this.dataDir, 'directory');
    const watcher = this.watcher = chokidarWatch(watchedRoot, {
      // Hidden files *inside* the data dir. Matching the absolute path would
      // ignore everything when the instance lives under a dot-directory.
      ignored: (path: string, stats?: Stats) => {
        // The reader's lowercase paths also resolve case aliases on macOS.
        const parts = relative(watchedRoot, path).toLowerCase().split(sep);
        if (parts.some(part => part.startsWith('.'))) return true;
        if (parts.length === 1 && (parts[0] === '' || parts[0] === MANIFEST_FILE)) return false;
        // Match the reader's layout without walking unrelated user files.
        // Attachment directories have their own bounded metadata polling below.
        if (!['notes', 'projects', 'actions', 'artifacts'].includes(parts[0])) return true;
        if (parts.length === 1) return false;
        if (!/^\d{4}$/.test(parts[1])) return true;
        if (parts.length === 2) return false;
        return parts.length > 3 || stats?.isDirectory() === true ||
          (!parts[2].endsWith('.md') && parts[2] !== 'index.yaml');
      },
      ignoreInitial: true,
      followSymlinks: false,
      persistent: true,
    });
    watcher.on('all', () => this.scheduleRebuild());
    // Native watches attach after the initial scan. Rescan its directories
    // after readiness so records created in that gap remain watched.
    watcher.once('ready', () => {
      if (this.watcher !== watcher) return;
      watcher.add(Object.keys(watcher.getWatched()).filter(path => path === watchedRoot || path.startsWith(watchedRoot + sep)));
      this.scheduleRebuild();
    });
    this.refreshAttachmentWatches();
  }

  private scheduleRebuild(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      try {
        this.rebuild();
      } catch (err) {
        // rebuild swaps state only on success, so the last good state is
        // still live; record the failure where the server surfaces issues.
        // One standing issue, refreshed — repeated failures must not grow
        // the list without bound.
        this.issues = this.issues.filter((i) => i.code !== 'rebuild_failed');
        this.issues = [...this.issues, {
          severity: 'error',
          code: 'rebuild_failed',
          message: `rebuild after a file change failed: ${err instanceof Error ? err.message : String(err)}`,
        }];
        for (const listener of this.changeListeners) listener();
      }
    }, STORE_REBUILD_DEBOUNCE_MS);
  }

  // Poll each immediate attachment folder for additions/removals, and selected
  // files for content changes. No recursive walk or binary-content read occurs.
  private refreshAttachmentWatches(): void {
    if (!this.watcher) return;
    const files = new Set(this.referencedArtifactFiles.flatMap(handle => {
      const ref = parseArtifactHandle(handle);
      return ref?.filename && this.artifacts.has(ref.id)
        ? [artifactAttachmentPath(this.dataDir, ref.id, ref.filename)] : [];
    }));
    for (const id of this.artifacts.keys()) {
      try { files.add(dirname(artifactAttachmentPath(this.dataDir, id, 'attachment'))); }
      catch { /* malformed IDs are reported by the reader/validator */ }
    }
    for (const file of this.attachmentWatches.keys()) {
      if (!files.has(file)) {
        this.attachmentWatches.delete(file);
      }
    }
    for (const file of files) {
      this.attachmentWatches.set(file, attachmentStat(this.dataDir, file));
    }
    if (!this.attachmentWatches.size) {
      clearInterval(this.attachmentPoll);
      this.attachmentPoll = undefined;
    } else if (!this.attachmentPoll) {
      this.attachmentPoll = setInterval(() => {
        let changed = false;
        for (const [file, previous] of this.attachmentWatches) {
          const current = attachmentStat(this.dataDir, file);
          if (attachmentChanged(current, previous)) {
            this.attachmentWatches.set(file, current);
            changed = true;
          }
        }
        if (changed) this.scheduleRebuild();
      }, ATTACHMENT_POLL_INTERVAL_MS);
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    clearTimeout(this.rebuildTimer);
    clearInterval(this.attachmentPoll);
    this.attachmentPoll = undefined;
    this.attachmentWatches.clear();
  }

  // Read the manifest, entries, entities, and their indexes into fresh
  // structures via the shared reader — the single place that walks the on-disk
  // layout. Each loaded file carries its parse issues, which `take` records
  // tagged with the file's relative path. Nothing here touches the instance
  // fields, so a throw leaves the store as it was.
  private load(): Loaded {
    const issues: ParseIssue[] = [];
    // Unwrap a parse result, recording its issues against the originating file.
    const take = <T>(result: ParseResult<T>, file: string): T => {
      for (const issue of result.issues) issues.push({ ...issue, file });
      return result.value;
    };
    // Entities keyed by id, each with the absolute path it was loaded from.
    const entities = <T>(files: InstanceFile<T>[], read: (file: InstanceFile<T>) => T = (file) => take(file, file.relPath)) => {
      const values = new Map<string, T>();
      const paths = new Map<string, string>();
      for (const file of files) {
        values.set(file.id, read(file));
        paths.set(file.id, join(this.dataDir, file.relPath));
      }
      return { values, paths };
    };
    const index = (files: InstanceFile<IndexItem[]>[]): IndexItem[] => [...files].reverse().flatMap((file) => take(file, file.relPath));

    const instance = take(readInstanceRecordResult(this.dataDir), MANIFEST_FILE);
    const data = readInstanceData(this.dataDir);
    // Files the reader could not read at all (permissions, races with external
    // edits) surface the same way parse issues do — the agent must know when a
    // query is answering from a partial load.
    issues.push(...data.errors);

    const weeks = new Map<string, Entry[]>();
    const entryFiles = new Map<string, string>();
    for (const wf of data.weeks) {
      const parsed = take(wf, wf.relPath);
      const filePath = join(this.dataDir, wf.relPath);
      weeks.set(wf.id, parsed.entries);
      for (const e of parsed.entries) entryFiles.set(e.meta.created, filePath);
    }
    const noteIndex = index(data.noteIndexes);
    const projects = entities(data.projects);
    const projectIndex = index(data.projectIndexes);
    const actions = entities(data.actions);
    const actionIndex = index(data.actionIndexes);
    const artifacts = entities(data.artifacts, (af) => {
      let result: ParseResult<Artifact> = af;
      try {
        const file = join(this.dataDir, af.relPath);
        if (reconcileArtifactAttachments(this.dataDir, af.id, result.value, file, this)) {
          result = parseArtifactFile(readManagedText(this.dataDir, file));
        }
      } catch (error) {
        issues.push({ severity: 'error', code: 'artifact_attachment_index_error', file: af.relPath,
          message: `Attachment index could not be reconciled: ${error instanceof Error ? error.message : String(error)}` });
      }
      return take(result, af.relPath);
    });
    const artifactIndex = index(data.artifactIndexes);

    return {
      weeks, projects: projects.values, actions: actions.values, artifacts: artifacts.values,
      indexes: { notes: noteIndex, projects: projectIndex, actions: actionIndex, artifacts: artifactIndex },
      files: { notes: entryFiles, projects: projects.paths, actions: actions.paths, artifacts: artifacts.paths },
      instance, issues,
    };
  }

  // Validate selected attachment targets, then derive the authored record graph.
  // Recomputed after writes and external edits.
  private buildRelationships(): void {
    const sources = this.getArtifactReferenceSources();
    const traversed = collectArtifactReferenceSources(this.dataDir, sources, this.artifacts);
    this.referencedArtifactFiles = traversed.attachments;
    this.refreshAttachmentWatches();
    this.issues = this.issues.filter(issue => !issue.code.startsWith('artifact_reference_') && issue.code !== 'artifact_attachment_read_error');
    const sourceFile = (handle: string): string => {
      if (handle.startsWith('#entry/')) return this.files.notes.get(handle.slice(7)) ?? handle;
      if (handle.startsWith('#project/')) return this.files.projects.get(handle.slice(9)) ?? handle;
      if (handle.startsWith('#action/')) return this.files.actions.get(handle.slice(8)) ?? handle;
      const ref = parseArtifactHandle(handle);
      if (!ref) return handle;
      if (ref.filename === undefined) return this.files.artifacts.get(ref.id) ?? handle;
      return artifactAttachmentPath(this.dataDir, ref.id, ref.filename);
    };
    this.issues = [...this.issues, ...traversed.issues.map(issue => ({ ...issue, file: relative(this.dataDir, sourceFile(issue.file!)) }))];
    this.core.deriveRelations(traversed.sources, new Set(traversed.availableAttachments));
    this.invalidateSnapshots();
    for (const listener of this.changeListeners) listener();
  }
}
