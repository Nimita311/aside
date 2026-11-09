import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseWeeklyFile, parseProjectFile, parseActionFile, parseArtifactFile, parseIndex } from './parser.js';
import { createManagedReader } from './managed-path.js';
import type {
  WeeklyValue,
  Project,
  Action,
  Artifact,
  IndexItem,
  ParseIssue,
  ParseResult,
} from './types.js';

// One file read from an instance: where it lives, its raw text, the parsed
// value, and the issues the shared parser recorded producing that value.
// `content` is retained because the validator's style lints inspect raw
// formatting the parser deliberately normalizes away; everyone else reads
// `value`/`issues`. Issues are untagged here — the consumer tags them with
// `relPath` (the Store does this so its issues carry a file path).
export interface InstanceFile<T> {
  relPath: string; // relative to the data dir, e.g. "notes/2026/2026-05-04.md"
  name: string; // basename, e.g. "2026-05-04.md"
  id: string; // the basename without its extension — a record file's entity id
  content: string;
  value: T;
  issues: ParseIssue[];
}

export type { WeeklyValue } from './types.js';

/** Parse reuse is keyed by exact bytes, never timestamps. The cache owns its
 * parsed values; every read returns an isolated result that consumers may edit. */
export class InstanceReadCache {
  private files = new Map<string, {content: string; parser: unknown; result: ParseResult<unknown>}>();
  private seen = new Set<string>();
  clear(): void { this.files.clear(); this.seen.clear(); }
  begin(): void { this.seen.clear(); }
  end(): void { for (const path of this.files.keys()) if (!this.seen.has(path)) this.files.delete(path); }
  parse<T>(path: string, content: string, name: string, parser: (content: string, name: string) => ParseResult<T>): ParseResult<T> {
    this.seen.add(path);
    const previous = this.files.get(path);
    if (previous?.content === content && previous.parser === parser) return structuredClone(previous.result) as ParseResult<T>;
    const result = parser(content, name);
    this.files.set(path, {content, parser, result: structuredClone(result)});
    return result;
  }
}

type ManagedReader = ReturnType<typeof createManagedReader>;

// Everything read from one instance's year-partitioned data, with the
// directory-walking conventions applied in exactly one place. The MCP Store and
// the validator both build on this, so they cannot drift on which files count
// or what a missing index means: an absent `index.yaml` simply contributes no
// `InstanceFile`, hence an empty index — "no index = no indexed entries".
export interface InstanceData {
  weeks: InstanceFile<WeeklyValue>[];
  projects: InstanceFile<Project>[];
  actions: InstanceFile<Action>[];
  artifacts: InstanceFile<Artifact>[];
  noteIndexes: InstanceFile<IndexItem[]>[];
  projectIndexes: InstanceFile<IndexItem[]>[];
  actionIndexes: InstanceFile<IndexItem[]>[];
  artifactIndexes: InstanceFile<IndexItem[]>[];
  // Files or directories that could not be read (deleted mid-walk, permissions).
  // Each issue is tagged with the path relative to the data dir; the unreadable
  // file is skipped, so the walk — like parsing — never throws.
  errors: ParseIssue[];
}

// Record one unreadable path and move on — the walk's never-throws counterpart
// to the parser's totality. Deduplicated, since the markdown and index walks
// visit the same year directories.
function readError(errors: ParseIssue[], relPath: string, e: unknown): void {
  const message = `Could not read: ${e instanceof Error ? e.message : String(e)}`;
  if (errors.some((i) => i.file === relPath && i.message === message)) return;
  errors.push({ severity: 'error', code: 'read_error', message, file: relPath });
}

// Year directories under a subdir, sorted for determinism regardless of
// filesystem enumeration order.
function yearDirs(dataDir: string, relPath: string, errors: ParseIssue[], reader: ManagedReader): string[] {
  let names: string[];
  try {
    const base = reader.directory(join(dataDir, relPath), true);
    names = readdirSync(base).filter(name => /^\d{4}$/.test(name)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    readError(errors, relPath, e);
    return [];
  }
  return names.filter(name => {
    try { reader.directory(join(dataDir, relPath, name)); return true; }
    catch (e) { readError(errors, `${relPath}/${name}`, e); return false; }
  });
}

// Read and parse every `.md` file under subDir/<year>/. All `.md` files count
// (weekly/project/action filename conventions are checked by the validator, not
// enforced here), matching how the Store has always loaded them.
function readMarkdown<T>(
  dataDir: string,
  subDir: string,
  parse: (content: string, name: string) => ParseResult<T>,
  errors: ParseIssue[],
  reader: ManagedReader,
  cache?: InstanceReadCache,
): InstanceFile<T>[] {
  const out: InstanceFile<T>[] = [];
  const base = join(dataDir, subDir);
  for (const year of yearDirs(dataDir, subDir, errors, reader)) {
    const yearDir = join(base, year);
    let names: string[];
    try {
      names = readdirSync(reader.directory(yearDir))
        .filter(name => name.endsWith('.md')).sort();
    } catch (e) {
      readError(errors, `${subDir}/${year}`, e);
      continue;
    }
    for (const name of names) {
      const relPath = `${subDir}/${year}/${name}`;
      let content: string;
      try {
        content = reader.text(join(yearDir, name));
      } catch (e) {
        readError(errors, relPath, e);
        continue;
      }
      const { value, issues } = cache ? cache.parse(relPath, content, name, parse) : parse(content, name);
      out.push({ relPath, name, id: name.slice(0, -3), content, value, issues });
    }
  }
  return out;
}

// Read and parse the `index.yaml` in each subDir/<year>/, skipping years that
// have none. A skipped year contributes nothing, so a missing index reads as an
// empty index everywhere downstream.
function readIndexes<T>(
  dataDir: string,
  subDir: string,
  parse: (content: string) => ParseResult<T>,
  errors: ParseIssue[],
  reader: ManagedReader,
  cache?: InstanceReadCache,
): InstanceFile<T>[] {
  const out: InstanceFile<T>[] = [];
  const base = join(dataDir, subDir);
  for (const year of yearDirs(dataDir, subDir, errors, reader)) {
    const relPath = `${subDir}/${year}/index.yaml`;
    const path = join(base, year, 'index.yaml');
    let content: string;
    try {
      content = reader.text(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      readError(errors, relPath, e);
      continue;
    }
    const { value, issues } = cache ? cache.parse(relPath, content, 'index.yaml', parse) : parse(content);
    out.push({ relPath, name: 'index.yaml', id: 'index', content, value, issues });
  }
  return out;
}

// Read an instance's entities and their indexes from disk. The
// single place that maps the on-disk layout to in-memory data.
export function readInstanceData(dataDir: string, cache?: InstanceReadCache): InstanceData {
  dataDir = resolve(dataDir);
  const errors: ParseIssue[] = [];
  const reader = createManagedReader(dataDir);
  cache?.begin();
  try {
    return {
      weeks: readMarkdown(dataDir, 'notes', parseWeeklyFile, errors, reader, cache),
      projects: readMarkdown(dataDir, 'projects', parseProjectFile, errors, reader, cache),
      actions: readMarkdown(dataDir, 'actions', parseActionFile, errors, reader, cache),
      artifacts: readMarkdown(dataDir, 'artifacts', parseArtifactFile, errors, reader, cache),
      noteIndexes: readIndexes(dataDir, 'notes', parseIndex, errors, reader, cache),
      projectIndexes: readIndexes(dataDir, 'projects', parseIndex, errors, reader, cache),
      actionIndexes: readIndexes(dataDir, 'actions', parseIndex, errors, reader, cache),
      artifactIndexes: readIndexes(dataDir, 'artifacts', parseIndex, errors, reader, cache),
      errors,
    };
  } finally { cache?.end(); }
}
