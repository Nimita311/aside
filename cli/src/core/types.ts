import type { AutomationDeclarations, ExecutionConfig } from './automation.js';
import type { DelegationDefinition } from './delegation.js';
import type { RecurrenceSchedule, OccurrenceIdentity } from './recurrence.js';
export interface EntryMeta {
  created: string;
  projects?: string[];
  actions?: string[];
}

export interface Entry {
  meta: EntryMeta;
  content: string;
  weekFile: string; // Extension-free weekly file ID (normally its Monday date).
}

export interface WeeklyFileMeta {
  week: number;
  week_start: string;
  week_end: string;
}

export interface ProjectFrontMatter {
  automations?: AutomationDeclarations;
  name: string;
  created: string;
  ended?: string;
  related_projects?: RelatedProject[];
}

export interface RelatedProject {
  project: string;
  description: string;
}

export interface Project {
  frontMatter: ProjectFrontMatter;
  body: string;
}

export interface ActionFrontMatter {
  delegation?: DelegationDefinition;
  recurrence?: RecurrenceSchedule[];
  occurrence?: OccurrenceIdentity;
  name: string;
  created: string;
  scheduled?: string;
  timezone?: string; // IANA zone for `scheduled`; floating if unset
  duration?: string; // ISO 8601 event length; default if unset
  calendar?: string; // readable calendar name; unsynced if unset
  calendar_account?: string; // optional readable account qualifier
  deadline?: string;
  resolution?: 'done' | 'cancelled';
}

export interface Action {
  frontMatter: ActionFrontMatter;
  body: string;
}

export interface ArtifactFrontMatter {
  name: string;
  created: string;
  attachments?: string[];
}

export interface Artifact {
  frontMatter: ArtifactFrontMatter;
  body: string;
}

// Instance-level manifest (`aside.md`) front matter. `id` is the stable instance
// identifier — a lowercase ASCII hostname label, generated at creation and stable — that records such as
// calendar markers reference. `version` is the aside plugin version the instance
// was created with; `description` exists for agent discovery and selection.
export interface Manifest {
  automations?: AutomationDeclarations;
  id: string;
  version?: string;
  name?: string;
  description?: string;
  config?: InstanceConfig;
}

// Per-instance settings, under the manifest's `config` key. Calendar event-title
// prefixes are prepended to the action `name` on the synced event, keyed by the
// action's lifecycle state; when unset they default (scheduled: `▢ `, done: `✓ `).
// An explicit empty string is a real value (e.g. drop the done `✓`), distinct from
// an absent key, which takes the default.
export interface InstanceConfig {
  recurrenceLookaheadDays?: number;
  scheduledEventTitlePrefix?: string;
  doneEventTitlePrefix?: string;
}

// `.aside` config file (control plane): pointers to data directories and an
// optional default selection (a path; it need not be one of the pointers).
// `discovery` toggles the structural scan of $PWD and its children; when false,
// instances come only from `pointers`/`default` (defaults to true). All fields
// optional. Distinct from the per-instance manifest (`aside.md`) — the config
// says where instances are; the manifest says what one instance is.
export interface AsideConfig {
  execution?: ExecutionConfig;
  pointers?: string[];
  default?: string;
  discovery?: boolean;
  worktreeDetection?: boolean;
}

// One item in a year index (`index.yaml`) — all entities
// share the shape: the entity's id and its one-line description.
export interface IndexItem {
  id: string;
  description: string;
}

// A recoverable problem found while parsing a file. The parser never throws;
// instead it records issues and returns a best-effort value. `file` is filled
// in by the loader (Store / validator), which knows the path; leaf parsers
// only know the field.
export type IssueSeverity = 'error' | 'warning';

export interface ParseIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  field?: string;
  file?: string;
}

// The single contract every parser returns: a value that is always usable plus
// the issues encountered producing it. Consumers that want tolerance use
// `value`; consumers that want to report (validator, MCP) read `issues`.
export interface ParseResult<T> {
  value: T;
  issues: ParseIssue[];
}

export interface ValidationResult {
  passed: boolean;
  dataChecksRun: boolean;
  checks: CheckResult[];
}

export interface CheckResult {
  name: string;
  passed: boolean;
  details?: string[];
}

// Shared collection vocabulary; storage and transport adapters keep their own
// loading, revision, and persistence state.
export type EntityKind = 'project' | 'action' | 'artifact';
export const ENTITY_KINDS: readonly EntityKind[] = ['project', 'action', 'artifact'];
export interface EntityRecord { project: Project; action: Action; artifact: Artifact }
export type IndexKind = 'notes' | 'projects' | 'actions' | 'artifacts';
export type RecordIndexes = Record<IndexKind, IndexItem[]>;
export interface InstanceRecord { manifest: Manifest; body: string }
export interface WeeklyValue { meta: WeeklyFileMeta; entries: Entry[] }
