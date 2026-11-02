import { stringify } from 'yaml';
import { attachmentFiles } from './attachments.js';
import { oneLineDescription } from './tools/index-file.js';
import type { Entry, Action, Project, Artifact, IndexItem, ParseIssue, Manifest } from '../core/types.js';
import { artifactContentFilename, artifactHandle } from '../core/artifact.js';
import { readManifestResult } from '../core/instance.js';

// Preserve ordinary values verbatim. JSON string quoting makes controls safe
// and remains unambiguous by also quoting literal JSON string representations.
export function formatScalar(value: string): string {
  let quotedLiteral = false;
  if (/^\s*"/.test(value)) {
    try { quotedLiteral = typeof JSON.parse(value) === 'string'; } catch { /* raw text */ }
  }
  if (!quotedLiteral && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return value;
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// A value rendered quoted even when plain — for prose-like fields such as
// reasons and event ids, which read as text rather than identifiers.
export function quotedScalar(value: string): string {
  const escaped = formatScalar(value);
  return escaped === value ? JSON.stringify(value) : escaped;
}

export function formatList(values: string[]): string {
  return `[${values.map(value => {
    const escaped = formatScalar(value);
    if (escaped !== value) return escaped;
    return /[,\[\]{}"']|:\s|^[&*!?]/.test(value) || value !== value.trim() ? JSON.stringify(value) : value;
  }).join(', ')}]`;
}

// Render an instance with whatever its manifest provides, for agent-facing
// listings: identity leads, the data-directory path trails as a locating detail —
// `name — description  (path)` — falling back to just the path when the manifest
// carries no name/description. Whitespace (including newlines from block scalars)
// is collapsed so each instance stays on a single line.
export function formatInstanceLine(path: string, manifest: Manifest): string {
  const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const label = [oneLine(manifest.name), oneLine(manifest.description)].filter(Boolean).map(formatScalar).join(' — ');
  return label ? `${label}  (${formatScalar(path)})` : formatScalar(path);
}

// An instance in an agent listing, read from its manifest on disk: the
// `formatInstanceLine` rendering plus the read error when the manifest cannot be read.
export function formatInstanceEntry(path: string): string {
  const result = readManifestResult(path), line = formatInstanceLine(path, result.value);
  const error = result.issues.find(issue => issue.code === 'read_error');
  return error ? `${line}\n    manifest: ${formatScalar(error.message)}` : line;
}

// Concise, agent-facing summary of parse issues. Returns null when there is
// nothing to report. `note` is the parenthetical context in the header.
export function formatIssueSummary(
  issues: ParseIssue[],
  max = 5,
  note = 'data loaded best-effort; run validate for detail',
): string | null {
  if (issues.length === 0) return null;
  const files = new Set(issues.map(i => i.file).filter(Boolean));
  const head =
    `⚠ ${issues.length} parsing issue${issues.length === 1 ? '' : 's'}` +
    (files.size ? ` in ${files.size} file${files.size === 1 ? '' : 's'}` : '') +
    ` (${formatScalar(note)}):`;
  const lines = issues.slice(0, max).map(i => `  ${i.file ? formatScalar(i.file) + ': ' : ''}${formatScalar(i.message)}`);
  if (issues.length > max) lines.push(`  … (+${issues.length - max} more)`);
  return [head, ...lines].join('\n');
}

export function formatPagination(showing: number, total: number, offset = 0, limit = 20): string {
  const nextOffset = offset + showing < total ? offset + showing : null;
  return `${showing} of ${total}\noffset: ${offset}\nlimit: ${limit}\nnext_offset: ${nextOffset}`;
}

function formatIndexId(id: string): string {
  const escaped = formatScalar(id);
  return escaped === id && id.includes(' — ') ? JSON.stringify(id) : escaped;
}

// Index lines are one item per line, so descriptions (single-line by the index
// rule, but possibly multi-line in a hand-edited file) are collapsed to render.
export function formatIndexLine(item: IndexItem): string {
  return `${formatIndexId(item.id)} — ${formatScalar(oneLineDescription(item.description))}`;
}

// Each entity renders at two detail levels sharing one header: `meta` is the
// header alone, `full` appends an indented body/content block. Authored lines
// cannot masquerade as an unindented record header, even if they contain `id:`.
function formatTextBlock(field: 'body' | 'content' | 'description', text: string, indent = ''): string {
  return `${indent}${field}: |\n${text.split('\n').map(line => `${indent}  ${line}`).join('\n')}`;
}

export function formatEntryMeta(entry: Entry, file?: string, description?: string): string {
  const lines: string[] = [`id: ${formatScalar(entry.meta.created)}`];
  if (file) lines.push(`file: ${formatScalar(file)}`);
  if (description !== undefined) lines.push(`description: ${formatScalar(oneLineDescription(description))}`);
  if (entry.meta.projects?.length) lines.push(`projects: ${formatList(entry.meta.projects)}`);
  if (entry.meta.actions?.length) lines.push(`actions: ${formatList(entry.meta.actions)}`);
  return lines.join('\n');
}

export function formatEntryFull(entry: Entry, file?: string, description?: string): string {
  return `${formatEntryMeta(entry, file, description)}\n${formatTextBlock('content', entry.content)}`;
}

export function formatActionMeta(id: string, action: Action, projects: string[], file?: string, description?: string): string {
  const fm = action.frontMatter;
  const lines: string[] = [`id: ${formatScalar(id)}`];
  if (file) lines.push(`file: ${formatScalar(file)}`);
  lines.push(`name: ${formatScalar(fm.name)}`, `created: ${formatScalar(fm.created)}`);
  if (description !== undefined) lines.push(`description: ${formatScalar(oneLineDescription(description))}`);
  if (fm.scheduled) lines.push(`scheduled: ${formatScalar(fm.scheduled)}`);
  if (fm.timezone) lines.push(`timezone: ${formatScalar(fm.timezone)}`);
  if (fm.duration) lines.push(`duration: ${formatScalar(fm.duration)}`);
  if (fm.calendar) lines.push(`calendar: ${formatScalar(fm.calendar)}`);
  if (fm.calendar_account) lines.push(`calendar_account: ${formatScalar(fm.calendar_account)}`);
  if (fm.deadline) lines.push(`deadline: ${formatScalar(fm.deadline)}`);
  if (fm.resolution) lines.push(`resolution: ${formatScalar(fm.resolution)}`);
  if (fm.delegation !== undefined) lines.push(stringify({delegation: fm.delegation}).trimEnd());
  if (projects.length) lines.push(`projects: ${formatList(projects)}`);
  if (action.frontMatter.recurrence) lines.push(stringify({ recurrence: action.frontMatter.recurrence }).trimEnd());
  if (action.frontMatter.occurrence) lines.push(stringify({ occurrence: action.frontMatter.occurrence }).trimEnd());
  return lines.join('\n');
}

export function formatActionFull(id: string, action: Action, projects: string[], file?: string, description?: string): string {
  return `${formatActionMeta(id, action, projects, file, description)}\n${formatTextBlock('body', action.body)}`;
}

export function formatProjectMeta(id: string, project: Project, file?: string, description?: string): string {
  const fm = project.frontMatter;
  const lines: string[] = [`id: ${formatScalar(id)}`];
  if (file) lines.push(`file: ${formatScalar(file)}`);
  lines.push(`name: ${formatScalar(fm.name)}`, `created: ${formatScalar(fm.created)}`);
  if (description !== undefined) lines.push(`description: ${formatScalar(oneLineDescription(description))}`);
  if (fm.automations !== undefined) lines.push(stringify({ automations: fm.automations }).trimEnd());
  lines.push(`status: ${fm.ended ? 'closed' : 'open'}`);
  if (fm.ended) lines.push(`ended: ${formatScalar(fm.ended)}`);
  if (fm.related_projects?.length) {
    lines.push('related_projects:');
    for (const related of fm.related_projects) {
      lines.push(`  - project: ${formatScalar(related.project)}`, formatTextBlock('description', related.description, '    '));
    }
  }
  return lines.join('\n');
}

export function formatProjectFull(id: string, project: Project, file?: string, description?: string): string {
  return `${formatProjectMeta(id, project, file, description)}\n${formatTextBlock('body', project.body)}`;
}

export function formatArtifactIndex(item: IndexItem): string {
  return `${formatIndexId(`#artifact/${item.id}`)} — ${formatScalar(oneLineDescription(item.description))}`;
}

export function formatAttachmentFiles(dataDir: string, id: string, filenames: readonly string[]): string[] {
  if (!filenames.length) return [];
  const lines = ['attachment_files:'];
  for (const file of attachmentFiles(dataDir, id, filenames)) {
    lines.push(`  - filename: ${formatScalar(file.filename)}`);
    if (file.handle !== undefined) lines.push(`    handle: ${formatScalar(file.handle)}`);
    if (file.path !== undefined) lines.push(`    path: ${formatScalar(file.path)}`);
    if (file.error !== undefined) lines.push(`    error: ${formatScalar(file.error)}`);
  }
  return lines;
}

export function formatArtifactMeta(
  id: string,
  artifact: Artifact,
  projects: string[],
  actions: string[],
  backlinks: string[],
  description?: string,
  dataDir?: string,
): string {
  const fm = artifact.frontMatter;
  const lines = [`id: ${formatScalar(id)}`, `handle: ${formatScalar(`#artifact/${id}`)}`, `name: ${formatScalar(fm.name)}`, `created: ${formatScalar(fm.created)}`];
  if (description !== undefined) lines.push(`description: ${formatScalar(oneLineDescription(description))}`);
  if (fm.attachments?.length) lines.push(`attachments: ${formatList(fm.attachments)}`);
  if (dataDir && fm.attachments?.length) lines.push(...formatAttachmentFiles(dataDir, id, fm.attachments));
  const target = artifactContentFilename(artifact);
  if (target !== undefined) {
    try { lines.push(`target: ${formatScalar(artifactHandle(id, target))}`); } catch { /* invalid attachment */ }
  }
  if (projects.length) lines.push(`projects: ${formatList(projects)}`);
  if (actions.length) lines.push(`actions: ${formatList(actions)}`);
  if (backlinks.length) lines.push(`backlinks: ${formatList(backlinks)}`);
  return lines.join('\n');
}

export function formatArtifactFull(
  id: string,
  artifact: Artifact,
  projects: string[],
  actions: string[],
  backlinks: string[],
  description?: string,
  dataDir?: string,
): string {
  return `${formatArtifactMeta(id, artifact, projects, actions, backlinks, description, dataDir)}\n${formatTextBlock('body', artifact.body)}`;
}
