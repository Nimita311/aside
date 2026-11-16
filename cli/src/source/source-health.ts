import {dirname, resolve} from 'node:path';
import type {IndexKind, ParseIssue} from '../core/types.js';

export type SourceRecordKind = 'entry' | 'project' | 'action' | 'artifact';

/** Load completeness is independent of a feature's domain requirements. A
 * tolerant record can remain readable while its source diagnostics are shown. */
export interface SourceHealth {
  readonly complete: boolean;
  readonly issue?: ParseIssue;
  /** Source/parser diagnostics, excluding derived reference/attachment health. */
  readonly issues: readonly ParseIssue[];
}

export interface SourceHealthPublication {
  corpus: SourceHealth;
  manifest: SourceHealth;
  records: Record<SourceRecordKind, ReadonlyMap<string, SourceHealth>>;
  recordIssues: Record<SourceRecordKind, ReadonlyMap<string, readonly ParseIssue[]>>;
  unknownRecord: SourceHealth;
}

const kinds: ReadonlyArray<readonly [SourceRecordKind, IndexKind]> = [
  ['entry', 'notes'], ['project', 'projects'], ['action', 'actions'], ['artifact', 'artifacts'],
];
const incomplete = new Set(['read_error', 'rebuild_failed', 'invalid_yaml', 'unterminated_entry_block']);
const noIssues: readonly ParseIssue[] = Object.freeze([]);
const complete: SourceHealth = Object.freeze({complete: true, issues: noIssues});
/** Issues read from source files, as opposed to those derived from references between them. */
export const sourceDiagnostic = (issue: ParseIssue) => !issue.code.startsWith('artifact_reference_')
  && issue.code !== 'artifact_attachment_read_error';

/** Classify parser omissions next to source publication, where layout and
 * best-effort loading are defined. This function never touches the filesystem. */
export function sourceHealthPublication(root: string, issues: readonly ParseIssue[], files: Record<IndexKind, Map<string, string>>): SourceHealthPublication {
  root = resolve(root);
  const paths = new Map<string, string>();
  const path = (file: string) => {
    let saved = paths.get(file);
    if (saved === undefined) {saved = resolve(root, file); paths.set(file, saved);}
    return saved;
  };
  const global = issues.filter(issue => issue.code === 'rebuild_failed');
  const order = new Map(issues.map((issue, index) => [issue, index]));
  const missingIdentity = (issue: ParseIssue) => issue.code === 'missing_field' && issue.field === 'created'
    && /(?:^|[/\\])notes[/\\]\d{4}[/\\][^/\\]+\.md$/.test(issue.file ?? '');
  const health = (associated: readonly ParseIssue[]): SourceHealth => {
    if (!associated.length) return complete;
    const diagnostics = associated.filter(sourceDiagnostic);
    if (!diagnostics.length) return complete;
    const issue = diagnostics.find(issue => issue.severity === 'error' && (incomplete.has(issue.code) || missingIdentity(issue)));
    return {complete: issue === undefined, ...(issue ? {issue} : {}), issues: diagnostics};
  };
  const byPath = new Map<string, ParseIssue[]>(), byId = new Map<string, ParseIssue[]>();
  for (const issue of issues) {
    if (issue.file) {
      const file = path(issue.file);
      const group = byPath.get(file) ?? [];
      group.push(issue); byPath.set(file, group);
    }
    // The source relationship validator identifies an action without a physical
    // file. Keep that legacy association here, including its entity kind.
    const colon = issue.message.indexOf(':');
    if (colon !== -1 && !issue.file && issue.code === 'invalid_recurrence_relationship') {
      const id = issue.message.slice(0, colon);
      const group = byId.get(id) ?? [];
      group.push(issue); byId.set(id, group);
    }
  }
  const associated = (file: string, actionId?: string): readonly ParseIssue[] => {
    const found = new Set<ParseIssue>(global);
    let current = path(file);
    for (;;) {
      for (const issue of byPath.get(current) ?? []) found.add(issue);
      if (current === root) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (actionId) for (const issue of byId.get(actionId) ?? []) found.add(issue);
    return found.size ? [...found].sort((a, b) => order.get(a)! - order.get(b)!) : noIssues;
  };
  const packets = new Map<string, {diagnostics: readonly ParseIssue[]; health: SourceHealth}>();
  const packet = (file: string, actionId?: string) => {
    const normalized = path(file);
    // Entries in one weekly file share their source health. An action whose
    // relationship diagnostics name its identity needs a distinct association.
    const identity = actionId && byId.has(actionId) ? actionId : undefined;
    const key = identity === undefined ? normalized : `${normalized}\0${identity}`;
    let saved = packets.get(key);
    if (!saved) {
      const diagnostics = associated(normalized, identity);
      saved = {diagnostics, health: health(diagnostics)};
      packets.set(key, saved);
    }
    return saved;
  };
  const records = {} as Record<SourceRecordKind, Map<string, SourceHealth>>;
  const recordIssues = {} as Record<SourceRecordKind, Map<string, readonly ParseIssue[]>>;
  for (const [kind, index] of kinds) {
    records[kind] = new Map(); recordIssues[kind] = new Map();
    for (const [id, file] of files[index]) {
      const source = packet(file, kind === 'action' ? id : undefined);
      records[kind].set(id, source.health);
      recordIssues[kind].set(id, source.diagnostics);
    }
  }
  const corpus = health(issues);
  // A missing record is confirmed absent only after a complete corpus load.
  return {corpus, manifest: packet('aside.md').health, records, recordIssues, unknownRecord: corpus};
}
