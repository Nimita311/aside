// Transport and UI contracts contain no parser or runtime dependency on DataCore.
import type { DataCore } from './data-core.js';
import type { Entry, Project, Action, Artifact, RecordIndexes, InstanceRecord, ParseIssue } from './types.js';
import type { Relations } from './record-model.js';
import type { FileDiagnostic, SearchProgress } from './data-core.js';
export type { Relations } from './record-model.js';
export type { EntityKind, EntityRecord, InstanceRecord } from './types.js';
export type { SearchProgress, FileDiagnostic, CheckScope, HotSet, UpdateSummary, PendingUpdate } from './data-core.js';

// Public browser-facing operations; excludes the daemon adapter's mutation API.
export type StoreView = Pick<DataCore,
  'init' | 'subscribeSearch' | 'getSearchProgress' | 'warmSearch' |
  'getDiagnostics' | 'diagnosticsFor' | 'subscribeDiagnostics' | 'reloadFile' |
  'getPlanningActions' | 'getInstance' | 'getDisplayName' | 'getCachedProject' | 'getCachedAction' |
  'getCachedArtifact' | 'getArtifactDisplayName' | 'getCachedArtifactContents' |
  'getCachedEntryContents' | 'getWeekEntries' | 'getProject' | 'getAction' |
  'getArtifact' | 'getAsset' | 'assetUrl' | 'prepareAssetUrl' | 'reportAssetFailure' |
  'hasValidators' | 'check' | 'loadAllWeeks' | 'getRelations' | 'isInitialized' |
  'isVerifiedEmpty' | 'getNoteIndex' | 'getProjectIndex' | 'getActionIndex' |
  'getArtifactIndex' | 'getWeeklyDates' | 'filterWeeks'>;

export interface CoreRecords {
  weeks: Map<string, Entry[]>;
  projects: Map<string, Project>;
  actions: Map<string, Action>;
  artifacts: Map<string, Artifact>;
  indexes: RecordIndexes;
  instance: InstanceRecord;
  issues: ParseIssue[];
}
export type SnapshotRelations = { [K in keyof Relations]: Relations[K] extends Map<string, infer V> ? [string, V][] : never };
export interface DataSnapshot {
  instance: InstanceRecord | null;
  indexes: RecordIndexes;
  weeklyDates: string[];
  weeks: [string, Entry[]][];
  projects: [string, Project][];
  actions: [string, Action][];
  artifacts: [string, Artifact][];
  relations: SnapshotRelations;
  weeksByEntity: [string, string[]][];
  diagnostics: FileDiagnostic[];
  searchProgress: SearchProgress;
}
