import { assertRecurrence, assertOccurrence, recurrenceIssues } from './recurrence.js';
import { existsSync, realpathSync } from 'node:fs';
import { isWallMinute, schedulingIssues } from './scheduling.js';
import { join, resolve } from 'node:path';
import type {
  CheckResult,
  ValidationResult,
  Entry,
  Project,
  Action,
  Artifact,
  ParseIssue,
  IndexItem,
} from './types.js';
import { extractEntryBlocks, parseEntryBlock, splitFrontMatter } from './parser.js';
import { isAsideDir, MANIFEST_FILE, readManifestResult } from './instance.js';
import { readInstanceData } from './reader.js';
import type { InstanceFile, InstanceData, WeeklyValue } from './reader.js';
import { assertArtifactId, assertAttachmentFilename, artifactHandle, artifactAttachmentRelativePath, parseArtifactHandle, collectArtifactReferenceSources, listArtifactAttachments } from './artifact.js';
import type { ArtifactReferenceSource } from './artifact.js';
import { extractContentReferences } from './content-reference.js';
import { contentAttachmentPath } from './content-attachment.js';
import { weekFilePath } from './record-reference.js';

// The validator reads the instance through the same `readInstanceData` the MCP
// Store uses, so the two can never disagree about which files count or what a
// missing index means. Structural reads use the parsed `value`/`issues`, while the
// style lints inspect the raw `content` for formatting the parser normalizes
// away (bare keys, empty fields, list syntax). Artifact references resolve only
// the supporting files selected by an inline handle or implicit file content.

type WeekFile = InstanceFile<WeeklyValue>;
type ProjFile = InstanceFile<Project>;
type ActFile = InstanceFile<Action>;
type ArtFile = InstanceFile<Artifact>;
type NamedFile = ProjFile | ActFile | ArtFile;

function isMonday(dateStr: string): boolean {
  const d = new Date(dateStr + 'T00:00:00');
  return !isNaN(d.getTime()) && d.getDay() === 1;
}

// Raw front-matter lines, for the style lints that inspect formatting the
// parser normalizes away (e.g. dangling empty keys). Uses the shared splitter,
// so the lints scan exactly the region the parser reads. Structural reads go
// through the shared parser instead — see the checks below.
function frontMatterLines(content: string): string[] {
  const { yaml } = splitFrontMatter(content);
  return yaml ? yaml.split('\n') : [];
}

// Top-level front-matter keys written with no value (`key:` / `key: `). The
// parser silently treats these as absent, so detecting them is a style lint on
// the raw text. A bare `key:` followed by an indented block (a block sequence
// or mapping, e.g. `related_projects:` with items beneath it) is NOT empty —
// its value is on the following lines — so we only flag keys with nothing under
// them.
function emptyFrontMatterKeys(content: string): string[] {
  const keys: string[] = [];
  const lines = frontMatterLines(content);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w-]+):\s*$/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++; // blank lines may precede block children
    if (j < lines.length && /^\s+\S/.test(lines[j])) continue; // has block children
    keys.push(m[1]);
  }
  return keys;
}

// The required-field checks below derive "what's missing" from the parser's
// own issues, so they cannot drift from how the Store actually reads a file.
function missingFields(issues: ParseIssue[], fields: string[]): string[] {
  return issues
    .filter((i) => i.code === 'missing_field' && i.field != null && fields.includes(i.field))
    .map((i) => i.field!);
}

// Visit every line of every entry's metadata block, labelled by file and
// 1-based entry position — the scan the raw-text entry lints share.
function eachEntryMetaLine(weeks: WeekFile[], visit: (line: string, at: string) => void): void {
  for (const wf of weeks) {
    const blocks = extractEntryBlocks(wf.content);
    for (let i = 0; i < blocks.length; i++) {
      for (const line of blocks[i].trim().split('\n')) {
        visit(line, `${wf.name} entry ${i + 1}`);
      }
    }
  }
}

function checkRecurrence(actions: ActFile[]): CheckResult {
  const details = recurrenceIssues(new Map(actions.map(a => [a.id, a.value])));
  for (const file of actions) try {
    if (file.value.frontMatter.recurrence) assertRecurrence(file.value.frontMatter.recurrence);
    if (file.value.frontMatter.occurrence) assertOccurrence(file.value.frontMatter.occurrence);
  } catch (error) { details.push(`${file.name}: ${(error as Error).message}`); }
  return { name: 'Action recurrence and provenance are valid', passed: !details.length, details };
}

function checkScheduling(actions: ActFile[]): CheckResult {
  const details = actions.flatMap(file => schedulingIssues(file.value.frontMatter).map(issue => `${file.name}: ${issue}`));
  return { name: 'Action scheduling fields are valid', passed: details.length === 0, details };
}

// --- Format checks ---

function checkInlineListSyntax(weeks: WeekFile[]): CheckResult {
  const issues: string[] = [];
  eachEntryMetaLine(weeks, (line, at) => {
    if (/^(projects|actions):\s*$/.test(line)) {
      issues.push(`${at}: '${line.trim()}' (bare key)`);
    }
    if (/^\s+-\s/.test(line)) {
      issues.push(`${at}: indented list item '${line.trim()}'`);
    }
  });
  return { name: 'Entry metadata uses inline YAML list syntax', passed: issues.length === 0, details: issues };
}

function checkNoEmptyFields(weeks: WeekFile[]): CheckResult {
  const issues: string[] = [];
  eachEntryMetaLine(weeks, (line, at) => {
    if (/^\w+:\s*\[\]\s*$/.test(line) || /^(\w+):\s*$/.test(line)) {
      issues.push(`${at}: '${line.trim()}'`);
    }
  });
  return { name: 'No empty fields in entry metadata', passed: issues.length === 0, details: issues };
}

function checkCreatedFormat(weeks: WeekFile[]): CheckResult {
  const issues: string[] = [];
  for (const wf of weeks) {
    const blocks = extractEntryBlocks(wf.content);
    for (let i = 0; i < blocks.length; i++) {
      const created = parseEntryBlock(blocks[i]).value.created;
      if (created && !isWallMinute(created)) {
        issues.push(`${wf.name} entry ${i + 1}: '${created}'`);
      }
    }
  }
  return { name: 'Created timestamps are ISO 8601 minute precision', passed: issues.length === 0, details: issues };
}

function checkWeeklyFilenames(weeks: WeekFile[]): CheckResult {
  const issues: string[] = [];
  for (const wf of weeks) {
    const dateStr = wf.id;
    if (!isMonday(dateStr)) {
      issues.push(`${wf.name} is not a Monday`);
    }
  }
  return { name: 'Weekly filenames are Monday dates', passed: issues.length === 0, details: issues };
}

function checkWeeklyFrontMatter(weeks: WeekFile[]): CheckResult {
  const issues: string[] = [];
  for (const wf of weeks) {
    const missing = missingFields(wf.issues, ['week', 'week_start', 'week_end']);
    if (missing.length > 0) {
      issues.push(`${wf.name}: missing ${missing.join(', ')}`);
    }
  }
  return { name: 'Weekly files have required front matter', passed: issues.length === 0, details: issues };
}

// Projects and actions share the `YYYY-MM-DD-<slug>.md` filename rule
// (design/project.md, design/action.md) — one check per entity kind.
function checkEntityFilenames(files: (ProjFile | ActFile)[], entityType: string): CheckResult {
  const issues: string[] = [];
  for (const f of files) {
    if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(f.name)) {
      issues.push(f.name);
    }
  }
  return { name: `${entityType} filenames have date prefix`, passed: issues.length === 0, details: issues };
}

// Named entities share the `YYYY-MM-DD-<slug>` filename rule; the entity type
// only labels the result.
function checkCreatedMatch(files: NamedFile[], entityType: string): CheckResult {
  const issues: string[] = [];
  for (const f of files) {
    const created = f.value.frontMatter.created;
    const stem = f.id;
    const nameMatch = stem.match(/^(\d{4}-\d{2}-\d{2})-/);
    if (nameMatch && created) {
      if (nameMatch[1] !== created.slice(0, 10)) {
        issues.push(`${f.name}: date code ${nameMatch[1]} != created ${created.slice(0, 10)}`);
      }
    }
  }
  return { name: `${entityType} date codes match created dates`, passed: issues.length === 0, details: issues };
}

function checkReverseChronological(weeks: WeekFile[]): CheckResult {
  const issues: string[] = [];
  for (const wf of weeks) {
    const blocks = extractEntryBlocks(wf.content);
    const timestamps = blocks.map(block => parseEntryBlock(block).value.created).filter(Boolean);
    for (let i = 0; i < timestamps.length - 1; i++) {
      if (timestamps[i] < timestamps[i + 1]) {
        issues.push(`${wf.name}: '${timestamps[i]}' before '${timestamps[i + 1]}'`);
        break;
      }
    }
  }
  return { name: 'Entries in reverse chronological order', passed: issues.length === 0, details: issues };
}

// --- Consistency checks ---

// Every id an entry links (`projects`/`actions` metadata) must have a file; the
// metadata key doubles as the check's label.
function checkReferencedExist(allEntries: Entry[], ids: Set<string>, key: 'projects' | 'actions'): CheckResult {
  const missing: string[] = [];
  for (const entry of allEntries) {
    for (const id of entry.meta[key] || []) {
      if (!ids.has(id)) missing.push(`${weekFilePath(entry.weekFile)}: #entry/${entry.meta.created} references missing ${key === 'projects' ? 'project' : 'action'} ${id}`);
    }
  }
  return { name: `Referenced ${key} have files`, passed: missing.length === 0, details: [...new Set(missing)] };
}

function checkActionsReferenced(actionIds: Set<string>, referencedActions: Set<string>): CheckResult {
  const unreferenced = [...actionIds].filter((a) => !referencedActions.has(a)).sort();
  return {
    name: 'All action files referenced by entries',
    passed: unreferenced.length === 0,
    details: unreferenced,
  };
}

// The index checks compare the index against the files. A missing index file
// contributes no items (the reader skips it), so an empty `indexItems` means
// "nothing indexed" — identical to how the Store reads it. The comparison then
// fails only on a real mismatch (entries/files exist but aren't indexed, or
// vice versa), never merely because an index file is absent.
function checkNoteIndexCount(indexItems: IndexItem[], allEntries: Entry[]): CheckResult {
  if (indexItems.length !== allEntries.length) {
    return {
      name: 'Notes index count matches entries',
      passed: false,
      details: [`index has ${indexItems.length}, weekly files have ${allEntries.length}`],
    };
  }
  return { name: 'Notes index count matches entries', passed: true };
}

function checkNoteIndexIds(indexItems: IndexItem[], allEntries: Entry[]): CheckResult {
  const indexIds = new Set(indexItems.map((i) => i.id));
  const entryIds = new Set(allEntries.map((e) => e.meta.created));
  const onlyIndex = [...indexIds].filter((id) => !entryIds.has(id));
  const onlyFiles = [...entryIds].filter((id) => !indexIds.has(id));
  const issues: string[] = [];
  if (onlyIndex.length) issues.push(`In index but not files: ${onlyIndex.slice(0, 5).join(', ')}`);
  if (onlyFiles.length) issues.push(`In files but not index: ${onlyFiles.slice(0, 5).join(', ')}`);
  return { name: 'Notes index IDs match entries', passed: issues.length === 0, details: issues };
}

// Index and files must list exactly the same ids, both ways. Shared by the
// project and action indexes; `entityType` ('Project' | 'Action') labels the result.
function checkEntityIndexMatch(indexItems: { id: string }[], fileIds: Set<string>, entityType: string): CheckResult {
  const indexIds = new Set(indexItems.map((i) => i.id));
  const onlyIndex = [...indexIds].filter((n) => !fileIds.has(n));
  const onlyFiles = [...fileIds].filter((n) => !indexIds.has(n));
  const issues: string[] = [];
  if (onlyIndex.length) issues.push(`In index but no file: ${onlyIndex.join(', ')}`);
  if (onlyFiles.length) issues.push(`File but not in index: ${onlyFiles.join(', ')}`);
  return { name: `${entityType} index matches files`, passed: issues.length === 0, details: issues };
}

function checkNoDuplicateEntryIds(allEntries: Entry[]): CheckResult {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const entry of allEntries) {
    const id = entry.meta.created;
    if (seen.has(id)) {
      duplicates.push(`${id} in ${seen.get(id)} and ${entry.weekFile}.md`);
    } else {
      seen.set(id, `${entry.weekFile}.md`);
    }
  }
  return { name: 'No duplicate entry IDs', passed: duplicates.length === 0, details: duplicates };
}

function checkArtifactIdentity(files: ArtFile[]): CheckResult {
  const issues: string[] = [];
  for (const f of files) {
    const id = f.id;
    try {
      assertArtifactId(id);
    } catch (e) {
      issues.push(`${f.relPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (f.relPath !== `artifacts/${id.slice(0, 4)}/${id}.md`) {
      issues.push(`${f.relPath}: record must be in its ID's creation year`);
    }
    if (!f.value.frontMatter.name.trim()) issues.push(`${f.relPath}: name must not be empty`);
    if (!isWallMinute(f.value.frontMatter.created)) {
      issues.push(`${f.relPath}: invalid created timestamp '${f.value.frontMatter.created}'`);
    }
  }
  return { name: 'Artifact identities and storage are valid', passed: issues.length === 0, details: issues };
}

function checkArtifactDuplicates(files: ArtFile[], indexes: InstanceFile<IndexItem[]>[]): CheckResult {
  const issues: string[] = [];
  for (const [kind, records] of [
    ['record', files.map((f) => ({ id: f.id, path: f.relPath }))],
    ['index item', indexes.flatMap((f) => f.value.map((item) => ({ id: item.id, path: f.relPath })))],
  ] as const) {
    const seen = new Map<string, string>();
    for (const { id, path } of records) {
      const previous = seen.get(id);
      if (previous) issues.push(`Duplicate ${kind} '${id}' in ${previous} and ${path}`);
      else seen.set(id, path);
    }
  }
  return { name: 'No duplicate artifact IDs', passed: issues.length === 0, details: issues };
}

// Compare each year independently: a globally matching set would still accept
// an index item misplaced in another year's index.
function checkArtifactIndexMatch(files: ArtFile[], indexes: InstanceFile<IndexItem[]>[]): CheckResult {
  const years = new Set([...files, ...indexes].map((f) => f.relPath.split('/')[1]));
  const issues: string[] = [];
  for (const year of [...years].sort()) {
    const fileIds = new Set(files.filter((f) => f.relPath.split('/')[1] === year).map((f) => f.id));
    const items = indexes.filter((f) => f.relPath.split('/')[1] === year).flatMap((f) => f.value);
    const check = checkEntityIndexMatch(items, fileIds, 'Artifact');
    for (const detail of check.details ?? []) issues.push(`artifacts/${year}/index.yaml: ${detail}`);
  }
  return { name: 'Artifact index matches files', passed: issues.length === 0, details: issues };
}

function checkArtifactAttachments(dataDir: string, files: ArtFile[]): CheckResult {
  const issues: string[] = [];
  for (const f of files) {
    const id = f.id;
    for (const issue of f.issues.filter(issue => issue.field === 'attachments')) {
      issues.push(`${f.relPath}: ${issue.message}`);
    }
    const indexed = f.value.frontMatter.attachments ?? [];
    const names = new Set<string>();
    for (const filename of indexed) {
      try { assertAttachmentFilename(filename); }
      catch (err) { issues.push(`${f.relPath}: ${err instanceof Error ? err.message : String(err)}`); }
      if (names.has(filename)) issues.push(`${f.relPath}: Duplicate attachment '${filename}'`);
      names.add(filename);
    }
    try {
      const actual = new Set(listArtifactAttachments(dataDir, id));
      for (const filename of names) {
        if (!actual.has(filename)) issues.push(`${f.relPath}: Attachment indexed but no regular file: ${filename}`);
      }
      for (const filename of actual) {
        if (!names.has(filename)) issues.push(`${f.relPath}: Attachment file missing from attachments index: ${filename}`);
      }
    } catch (err) {
      issues.push(`${f.relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { name: 'Artifact attachments index matches files', passed: issues.length === 0, details: issues };
}

function checkArtifactReferences(dataDir: string, data: InstanceData): CheckResult {
  const sources: ArtifactReferenceSource[] = [
    ...data.weeks.flatMap((f) => f.value.entries.map((entry) => ({
      handle: `#entry/${entry.meta.created}`,
      markdown: entry.content,
    }))),
    ...data.projects.map((f) => ({ handle: `#project/${f.id}`, markdown: f.value.body })),
    ...data.actions.map((f) => ({ handle: `#action/${f.id}`, markdown: f.value.body })),
    ...data.artifacts.map((f) => ({ handle: `#artifact/${f.id}`, markdown: f.value.body })),
  ];
  const artifacts = new Map(data.artifacts.map((f) => [f.id, f.value]));
  const { issues } = collectArtifactReferenceSources(dataDir, sources, artifacts);
  const paths = new Map<string, string>([
    ...data.weeks.flatMap(f => f.value.entries.map(entry => [`#entry/${entry.meta.created}`, f.relPath] as const)),
    ...data.projects.map(f => [`#project/${f.id}`, f.relPath] as const),
    ...data.actions.map(f => [`#action/${f.id}`, f.relPath] as const),
    ...data.artifacts.map(f => [`#artifact/${f.id}`, f.relPath] as const),
  ]);
  return {
    name: 'Artifact references and content files exist',
    passed: issues.length === 0,
    details: issues.map((issue) => {
      const attachment = issue.file ? parseArtifactHandle(issue.file) : undefined;
      let path = paths.get(issue.file ?? '') ?? issue.file;
      if (attachment?.filename !== undefined) {
        try { path = artifactAttachmentRelativePath(attachment.id, attachment.filename); } catch { /* Use the invalid authored handle. */ }
      }
      return `${path}: ${issue.message}`;
    }),
  };
}

function checkEntriesInCorrectWeek(weeks: WeekFile[]): CheckResult {
  const issues: string[] = [];
  for (const wf of weeks) {
    const mondayStr = wf.id;
    const monday = new Date(mondayStr + 'T00:00:00');
    if (isNaN(monday.getTime())) continue;
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);

    for (const entry of wf.value.entries) {
      const entryDate = new Date(entry.meta.created.slice(0, 10) + 'T00:00:00');
      if (entryDate < monday || entryDate > sunday) {
        issues.push(`${wf.name}: entry ${entry.meta.created} outside week range`);
      }
    }
  }
  return { name: 'Entries in correct weekly file', passed: issues.length === 0, details: issues };
}

function checkWeeklyFrontMatterConsistency(weeks: WeekFile[]): CheckResult {
  const issues: string[] = [];
  for (const wf of weeks) {
    const meta = wf.value.meta;
    const stem = wf.id;
    if (meta.week_start && meta.week_start !== stem) {
      issues.push(`${wf.name}: week_start=${meta.week_start} != filename ${stem}`);
    }
    if (meta.week_start && meta.week_end) {
      const ws = new Date(meta.week_start + 'T00:00:00');
      const we = new Date(meta.week_end + 'T00:00:00');
      // Rounded because a DST transition inside the week makes the local-time
      // difference 6 days ± 1 hour.
      const diff = Math.round((we.getTime() - ws.getTime()) / (1000 * 60 * 60 * 24));
      if (diff !== 6) {
        issues.push(`${wf.name}: week_start to week_end is ${diff} days, expected 6`);
      }
    }
  }
  return { name: 'Weekly front matter is self-consistent', passed: issues.length === 0, details: issues };
}

// Direct-content references share the query scanner and resolve only actual
// records/indexed regular attachments. Metadata relations have separate checks.
function checkInlineMentions(dataDir: string, data: InstanceData): CheckResult {
  const issues: string[] = [];
  const targets = new Map<string, string>();
  const sources: { handle: string; markdown: string; path: string }[] = [];
  for (const week of data.weeks) for (const entry of week.value.entries) {
    const handle = `#entry/${entry.meta.created}`;
    targets.set(handle, week.relPath);
    sources.push({ handle, markdown: entry.content, path: week.relPath });
  }
  for (const kind of ['project', 'action', 'artifact'] as const) for (const file of data[`${kind}s`]) {
    const handle = `#${kind}/${file.id}`;
    targets.set(handle, file.relPath);
    sources.push({ handle, markdown: file.value.body, path: file.relPath });
  }
  for (const artifact of data.artifacts) {
    for (const filename of [...new Set(artifact.value.frontMatter.attachments ?? [])].sort()) {
      let handle: string;
      try {
        handle = artifactHandle(artifact.id, filename);
        contentAttachmentPath(dataDir, artifact.id, filename);
        targets.set(handle, artifactAttachmentRelativePath(artifact.id, filename));
      } catch { continue; } // Attachment metadata checks explain unavailable files.
    }
  }
  const seen = new Set<string>();
  const roots = [...new Set([resolve(dataDir), realpathSync(dataDir)])];
  for (const source of sources) {
    for (const reference of extractContentReferences(source.markdown, source.path, roots)) {
      let handle: string;
      try {
        handle = reference.kind === 'artifact' ? artifactHandle(reference.id, reference.filename) : `#${reference.kind}/${reference.id}`;
      } catch (error) {
        const issue = `${source.path}: invalid ${reference.kind} reference ${reference.id}: ${(error as Error).message}`;
        if (!seen.has(issue)) { seen.add(issue); issues.push(issue); }
        continue;
      }
      if (!targets.has(handle) || reference.filePath !== undefined && targets.get(handle) !== reference.filePath) {
        const issue = `${source.path}: ${source.handle} references missing ${reference.filename === undefined ? reference.kind : 'attachment'} ${handle}${reference.filePath === undefined ? '' : ` (${reference.filePath})`}`;
        if (!seen.has(issue)) { seen.add(issue); issues.push(issue); }
      }
    }
  }
  return { name: 'Inline mentions reference existing entities', passed: issues.length === 0, details: issues };
}

// Both related_projects checks read the parsed front matter, not the raw text,
// so prose that happens to contain "project: x" can never trip them.
function checkRelatedProjects(projects: ProjFile[], projectIds: Set<string>): CheckResult {
  const issues: string[] = [];
  for (const pf of projects) {
    const stem = pf.id;
    for (const r of pf.value.frontMatter.related_projects ?? []) {
      if (r.project !== stem && !projectIds.has(r.project)) {
        issues.push(`${pf.relPath}: related project '${r.project}' not found`);
      }
    }
  }
  return { name: 'Related projects reference existing projects', passed: issues.length === 0, details: issues };
}

function checkNoSelfReferences(projects: ProjFile[]): CheckResult {
  const issues: string[] = [];
  for (const pf of projects) {
    const stem = pf.id;
    for (const r of pf.value.frontMatter.related_projects ?? []) {
      if (r.project === stem) {
        issues.push(`${pf.name}: references itself in related_projects`);
      }
    }
  }
  return { name: 'No self-references', passed: issues.length === 0, details: issues };
}

// Named entities require `name` and `created`; the plural labels the result.
function checkRequiredEntityFields(files: NamedFile[], plural: string): CheckResult {
  const issues: string[] = [];
  for (const f of files) {
    for (const field of missingFields(f.issues, ['name', 'created'])) {
      issues.push(`${f.name}: missing '${field}'`);
    }
  }
  return { name: `${plural} have required fields (name, created)`, passed: issues.length === 0, details: issues };
}

// Style lint on the raw front matter, shared by named entities.
function checkNoEmptyEntityFields(files: NamedFile[], entity: string): CheckResult {
  const issues: string[] = [];
  for (const f of files) {
    for (const key of emptyFrontMatterKeys(f.content)) {
      issues.push(`${f.name}: empty field '${key}'`);
    }
  }
  return { name: `No empty fields in ${entity} front matter`, passed: issues.length === 0, details: issues };
}

// One rule governs every index, because every entity carries a minute-precision
// `created` timestamp: list entities newest-first by `created`. The only per-type
// difference is how an index id maps to that timestamp — a note's id IS its
// created timestamp, while a named entity ID (`YYYY-MM-DD-<slug>`) only reveals
// the day, so its created is resolved from the entity file — and that difference
// is captured entirely by the `createdById` map the caller passes in. We then
// require the listed order to be non-increasing, matching what query results use.
// Ids with no resolvable timestamp are skipped (the index/file match checks
// report those); entities sharing a minute tie, so either order is accepted.
function checkIndexCreatedOrder(
  indexFiles: InstanceFile<{ id: string }[]>[],
  createdById: Map<string, string>,
  entityType: string,
): CheckResult {
  const fmt = (id: string, ts: string) => (id === ts ? `'${id}'` : `'${id}' (created ${ts})`);
  const issues: string[] = [];
  for (const idx of indexFiles) {
    const ids = idx.value.map((i) => i.id);
    for (let i = 0; i < ids.length - 1; i++) {
      const a = createdById.get(ids[i]);
      const b = createdById.get(ids[i + 1]);
      if (a && b && a < b) {
        issues.push(`${idx.relPath}: ${fmt(ids[i], a)} before ${fmt(ids[i + 1], b)}`);
        break;
      }
    }
  }
  return { name: `${entityType} index in reverse chronological order`, passed: issues.length === 0, details: issues };
}

function checkValidEntryMetaFields(weeks: WeekFile[]): CheckResult {
  const validFields = new Set(['created', 'projects', 'actions']);
  const issues: string[] = [];
  eachEntryMetaLine(weeks, (line, at) => {
    const m = line.match(/^(\w+):/);
    if (m && !validFields.has(m[1])) {
      issues.push(`${at}: unknown field '${m[1]}'`);
    }
  });
  return { name: 'Entry metadata uses only valid fields', passed: issues.length === 0, details: issues };
}

// Surfaces everything the shared parser flagged while reading each file, so the
// validator reports exactly what the live MCP Store (Store.getIssues) does —
// the two never diverge on what is malformed, and both tag issues with the
// file's path relative to the data dir. The dedicated required-field checks
// above additionally give missing name/created/week a friendlier per-entity
// framing; the overlap is intentional.
function checkParseIssues(data: InstanceData): CheckResult[] {
  // Reader-level failures (a file that vanished mid-walk, a permissions error)
  // come pre-tagged with their path and surface as structural errors alongside
  // the parse issues.
  const all: ParseIssue[] = [...data.errors];
  const collect = (files: InstanceFile<unknown>[]) => {
    for (const f of files) {
      for (const i of f.issues) all.push({ ...i, file: f.relPath });
    }
  };
  collect(data.weeks);
  collect(data.projects);
  collect(data.actions);
  collect(data.artifacts);
  collect(data.noteIndexes);
  collect(data.projectIndexes);
  collect(data.actionIndexes);
  collect(data.artifactIndexes);

  const format = (i: ParseIssue) => `${i.file}: ${i.message}`;
  const errors = all.filter((i) => i.severity === 'error').map(format);
  const warnings = all.filter((i) => i.severity === 'warning').map(format);
  return [
    { name: 'Files load without structural errors', passed: errors.length === 0, details: errors },
    { name: 'Front matter parses without recovery', passed: warnings.length === 0, details: warnings },
  ];
}

// An aside instance is identified by an `aside.md` manifest. Validation defers
// to isAsideDir for "is this an instance?" — the single definition shared with
// discovery, resolution, and select_instance — then additionally reports any parse
// issues, so identity and data-health never disagree.
function checkManifest(dataDir: string): { check: CheckResult; isInstance: boolean } {
  const name = 'Instance has an aside.md manifest';
  const result = readManifestResult(dataDir);
  const readErrors = result.issues.filter(issue => issue.code === 'read_error');
  if (readErrors.length) return { isInstance: false, check: { name, passed: false, details: readErrors.map(issue => issue.message) } };
  if (!isAsideDir(dataDir)) {
    const detail = existsSync(join(dataDir, MANIFEST_FILE)) ? `${MANIFEST_FILE} has no front matter` : `${MANIFEST_FILE} not found`;
    return { isInstance: false, check: { name, passed: false, details: [detail] } };
  }
  const issues = result.issues;
  return { isInstance: true, check: { name, passed: issues.length === 0, details: issues.map((i) => i.message) } };
}

// --- Public API ---

export function validate(dataDir: string): ValidationResult {
  dataDir = resolve(dataDir);
  const manifest = checkManifest(dataDir);
  // Data checks require a recognizable, readable instance. Empty collections
  // from an unrelated directory must not be reported as passing validation.
  if (!manifest.isInstance) return { passed: false, dataChecksRun: false, checks: [manifest.check] };
  const data = readInstanceData(dataDir);
  const { weeks, projects, actions, artifacts } = data;

  const actionIds = new Set(actions.map((f) => f.id));
  const projectIds = new Set(projects.map((f) => f.id));

  const allEntries: Entry[] = weeks.flatMap((w) => w.value.entries);

  const noteIndexItems = data.noteIndexes.flatMap((f) => f.value);
  const projectIndexItems = data.projectIndexes.flatMap((f) => f.value);
  const actionIndexItems = data.actionIndexes.flatMap((f) => f.value);

  const referencedActions = new Set<string>();
  for (const entry of allEntries) {
    for (const a of entry.meta.actions || []) referencedActions.add(a);
  }

  // id -> created timestamp, per entity type, for the index-order check. A note's
  // id IS its created timestamp; a named entity resolves to its file's created.
  const entryCreatedById = new Map(allEntries.map((e) => [e.meta.created, e.meta.created]));
  const projectCreatedById = new Map(projects.map((f) => [f.id, f.value.frontMatter.created]));
  const actionCreatedById = new Map(actions.map((f) => [f.id, f.value.frontMatter.created]));
  const artifactCreatedById = new Map(artifacts.map((f) => [f.id, f.value.frontMatter.created]));

  const checks: CheckResult[] = [
    manifest.check,
    checkInlineListSyntax(weeks),
    checkNoEmptyFields(weeks),
    checkNoEmptyEntityFields(actions, 'action'),
    checkNoEmptyEntityFields(projects, 'project'),
    checkNoEmptyEntityFields(artifacts, 'artifact'),
    checkRequiredEntityFields(actions, 'Actions'),
    checkScheduling(actions),
    checkRecurrence(actions),
    checkRequiredEntityFields(projects, 'Projects'),
    checkRequiredEntityFields(artifacts, 'Artifacts'),
    checkCreatedFormat(weeks),
    checkWeeklyFilenames(weeks),
    checkWeeklyFrontMatter(weeks),
    checkEntityFilenames(actions, 'Action'),
    checkEntityFilenames(projects, 'Project'),
    checkCreatedMatch(actions, 'Action'),
    checkCreatedMatch(projects, 'Project'),
    checkCreatedMatch(artifacts, 'Artifact'),
    checkArtifactIdentity(artifacts),
    checkArtifactDuplicates(artifacts, data.artifactIndexes),
    checkArtifactAttachments(dataDir, artifacts),
    checkArtifactReferences(dataDir, data),
    checkReverseChronological(weeks),
    checkValidEntryMetaFields(weeks),
    checkReferencedExist(allEntries, actionIds, 'actions'),
    checkReferencedExist(allEntries, projectIds, 'projects'),
    checkActionsReferenced(actionIds, referencedActions),
    checkNoteIndexCount(noteIndexItems, allEntries),
    checkNoteIndexIds(noteIndexItems, allEntries),
    checkEntityIndexMatch(projectIndexItems, projectIds, 'Project'),
    checkEntityIndexMatch(actionIndexItems, actionIds, 'Action'),
    checkArtifactIndexMatch(artifacts, data.artifactIndexes),
    checkIndexCreatedOrder(data.noteIndexes, entryCreatedById, 'Notes'),
    checkIndexCreatedOrder(data.projectIndexes, projectCreatedById, 'Project'),
    checkIndexCreatedOrder(data.actionIndexes, actionCreatedById, 'Action'),
    checkIndexCreatedOrder(data.artifactIndexes, artifactCreatedById, 'Artifact'),
    checkNoDuplicateEntryIds(allEntries),
    checkEntriesInCorrectWeek(weeks),
    checkWeeklyFrontMatterConsistency(weeks),
    checkInlineMentions(dataDir, data),
    checkRelatedProjects(projects, projectIds),
    checkNoSelfReferences(projects),
    ...checkParseIssues(data),
  ];

  return {
    passed: checks.every((c) => c.passed),
    dataChecksRun: true,
    checks,
  };
}
