// Portable record identities, file paths, and Markdown asset references.
import { getMonday, formatDate as toDateStr } from './date.js';
import type { Entry } from './types.js';
import { artifactRecordPath } from './artifact-reference.js';
import { markdownReferenceText } from './markdown.js';

export type EntityType = 'project' | 'action' | 'entry';

// Mixed browser caches and notifications use the complete handle, never a bare ID.
export function entityKey(type: EntityType | 'artifact', id: string): string {
  return `#${type}/${id}`;
}

export interface EntityRef {
  type: EntityType;
  id: string;
}

// An id character — letter, number, combining mark, underscore, or hyphen.
// Shared so the filtered flow and the relation map bound inline mentions the
// same way.
export const ID_CHAR = '[\\p{L}\\p{N}\\p{M}_-]';
const NAMED_HANDLE = new RegExp(`^#(project|action)/(${ID_CHAR}+)$`, 'u');
const BARE_MENTION = /(?<![\p{L}\p{N}_/\\])#(?:project|action)\/[^\s<>()[\]{}"'`]+/gu;

export function entryEntityIds(entry: Pick<Entry, 'meta' | 'content'>, type: 'project' | 'action'): string[] {
  const tags = type === 'project' ? entry.meta.projects : entry.meta.actions;
  const {destinations, prose} = markdownReferenceText(entry.content);
  const ids = new Set(tags ?? []);
  const mentions = [...destinations, ...[...prose.matchAll(BARE_MENTION)].map(match => match[0].replace(/[.,;:!?]+$/g, ''))];
  for (const mention of mentions) {
    const match = NAMED_HANDLE.exec(safeDecode(mention));
    if (match?.[1] === type) ids.add(match[2]);
  }
  return [...ids];
}

// Whether an entry references an entity — the one rule behind both the filtered
// flow and the relation map's entry lists, so the two always agree. A project or
// action matches a front-matter tag or an inline `#project/<id>` / `#action/<id>`
// mention (bounded by a non-id char, since ids can prefix one another); an entry
// ref matches only its own id. See spec.md.
export function entryReferences(
  entry: { meta: { created: string; projects?: string[]; actions?: string[] }; content: string },
  ref: EntityRef,
): boolean {
  if (ref.type === 'entry') return entry.meta.created === ref.id;
  return entryEntityIds(entry, ref.type).includes(ref.id);
}

export function getMondayOfWeek(date: Date): string {
  return toDateStr(getMonday(date));
}

export function deriveWeeklyFiles(entries: { id: string }[]): string[] {
  const mondays = new Set<string>();
  for (const entry of entries) {
    // new Date returns Invalid Date (not a throw) for a bad string; isNaN skips it.
    const date = new Date(entry.id.slice(0, 10) + 'T00:00:00');
    if (!isNaN(date.getTime())) mondays.add(getMondayOfWeek(date));
  }
  return Array.from(mondays).sort().reverse();
}

function getYearFromDate(dateStr: string): string {
  return dateStr.slice(0, 4);
}

// Parsers may receive a filename or the browser's week ID. Records retain
// the same extension-free ID in either case.
export function weekFileId(filename: string): string { return filename.replace(/\.md$/i, ''); }

// Root-relative path of the weekly file an entry lives in (weekFile is the Monday date).
export function weekFilePath(weekFile: string): string {
  return `notes/${getYearFromDate(weekFile)}/${weekFile}.md`;
}

// Root-relative path of a project/action record file.
export function entityFilePath(kind: 'project' | 'action' | 'artifact', id: string): string {
  if (kind === 'artifact') return artifactRecordPath(id);
  return `${kind}s/${getYearFromDate(id)}/${id}.md`;
}

// Tolerant percent-decoding: a hand-edited URL may not be valid
// percent-encoding, in which case the raw value is used.
export function safeDecode(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

// Resolve a relative markdown link against the file that contains it.
// `baseFile` is the containing file's root-relative path (e.g. "notes/2026/2026-05-18.md").
// Returns the target's root-relative path, or null when the href is not a plain
// relative path (scheme, absolute, fragment-only) or escapes the data root —
// null means "not an asset link, leave it alone".
export function resolveRelativePath(baseFile: string, href: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null; // http:, mailto:, data:, ...
  const raw = href.split('#')[0].split('?')[0];
  if (!raw) return null;
  const decoded = safeDecode(raw);
  const segments = baseFile.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null; // escapes the data root
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  return segments.length ? segments.join('/') : null;
}

// An asset reference discovered in markdown content: the linked file's
// root-relative path plus the link text it was written with.
export interface AssetLink {
  path: string;
  title: string;
}

// Plain links only — the (?<!!) guard excludes image embeds.
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

// Collect relative markdown links that resolve inside the data root.
// Code spans are stripped first so quoted link examples don't become
// phantom relations — mirroring the renderer, which never linkifies code.
export function extractAssetLinks(markdown: string, baseFile: string): AssetLink[] {
  const withoutCode = markdown
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/`[^`\n]*`/g, '');
  const links: AssetLink[] = [];
  for (const match of withoutCode.matchAll(MARKDOWN_LINK_RE)) {
    const path = resolveRelativePath(baseFile, match[2]);
    if (path) links.push({ path, title: match[1] || assetDisplayName(path) });
  }
  return links;
}

// Display name for an asset: file name without directory or extension.
export function assetDisplayName(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[a-z0-9]+$/i, '');
}
