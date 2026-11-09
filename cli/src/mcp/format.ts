import { attachmentFiles, type AttachmentFile } from './attachments.js';
import { oneLineDescription } from '../core/description.js';
import type { Artifact, IndexItem, ParseIssue } from '../core/types.js';
import { artifactContentFilename, artifactHandle } from '../core/artifact.js';
import {formatScalar, formatList} from '../core/text.js';

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

// An artifact renders at two detail levels sharing one header: `meta` is the
// header alone, `full` appends an indented body block. Authored lines cannot
// masquerade as an unindented record header, even if they contain `id:`.
function formatBody(text: string): string {
  return `body: |\n${text.split('\n').map(line => `  ${line}`).join('\n')}`;
}

export function formatArtifactIndex(item: IndexItem): string {
  return `${formatIndexId(`#artifact/${item.id}`)} — ${formatScalar(oneLineDescription(item.description))}`;
}

export function formatAttachmentFiles(snapshot: readonly AttachmentFile[] | undefined, id: string, filenames: readonly string[]): string[] {
  if (!filenames.length) return [];
  const lines = ['attachment_files:'];
  for (const file of attachmentFiles(snapshot, id, filenames)) {
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
  attachments?: readonly AttachmentFile[],
): string {
  const fm = artifact.frontMatter;
  const lines = [`id: ${formatScalar(id)}`, `handle: ${formatScalar(`#artifact/${id}`)}`, `name: ${formatScalar(fm.name)}`, `created: ${formatScalar(fm.created)}`];
  if (description !== undefined) lines.push(`description: ${formatScalar(oneLineDescription(description))}`);
  if (fm.attachments?.length) lines.push(`attachments: ${formatList(fm.attachments)}`);
  if (fm.attachments?.length) lines.push(...formatAttachmentFiles(attachments, id, fm.attachments));
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
  attachments?: readonly AttachmentFile[],
): string {
  return `${formatArtifactMeta(id, artifact, projects, actions, backlinks, description, attachments)}\n${formatBody(artifact.body)}`;
}
