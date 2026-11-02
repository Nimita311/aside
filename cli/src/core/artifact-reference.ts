import { toKebabCase } from './slug.js';
import { isCalendarDate } from './scheduling.js';
import type { Artifact } from './types.js';
import { markdownReferenceText } from './markdown.js';

export interface ArtifactReference {
  id: string;
  filename?: string;
}

export interface ArtifactReferenceSource {
  handle: string;
  markdown: string;
  projects?: string[];
  actions?: string[];
}

// An empty Markdown body with one attachment uses that file as its content.
export function artifactContentFilename(artifact: Artifact): string | undefined {
  return !artifact.body.trim() && artifact.frontMatter.attachments?.length === 1
    ? artifact.frontMatter.attachments[0]
    : undefined;
}

export function assertArtifactId(id: string): void {
  const match = id.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/u);
  if (!match || toKebabCase(match[2]) !== match[2] || !isCalendarDate(match[1])) throw new Error(`Invalid artifact id: ${id}`);
}

const utf8 = new TextEncoder();

export function assertAttachmentFilename(filename: string): void {
  if (!filename || filename === '.' || filename === '..' || /[/\\\x00-\x1f\x7f]/.test(filename) || utf8.encode(filename).length > 255) {
    throw new Error(`Attachment filename must be a single filename: ${filename}`);
  }
}

export function artifactHandle(id: string, filename?: string): string {
  assertArtifactId(id);
  if (filename !== undefined) assertAttachmentFilename(filename);
  const segment = filename === undefined ? '' : encodeURIComponent(filename)
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\.+$/, dots => '%2E'.repeat(dots.length));
  return `#artifact/${id}${filename === undefined ? '' : `/${segment}`}`;
}

export function parseArtifactHandle(target: string): ArtifactReference | undefined {
  if (!target.startsWith('#artifact/')) return undefined;
  const rest = target.slice('#artifact/'.length);
  const slash = rest.indexOf('/');
  const decode = (s: string) => {
    try { return decodeURIComponent(s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')); }
    catch { return s; }
  };
  return slash < 0
    ? { id: decode(rest) }
    : { id: decode(rest.slice(0, slash)), filename: decode(rest.slice(slash + 1)) };
}

export function extractArtifactReferences(markdown: string): ArtifactReference[] {
  const { destinations, prose } = markdownReferenceText(markdown);
  const out: ArtifactReference[] = [];
  // Explicit Markdown destinations retain filename punctuation and allow
  // angle-bracket destinations containing spaces. Nested escaped parentheses
  // are handled by the small balanced scan rather than a URL-ending regex.
  for (const destination of destinations) {
    const ref = parseArtifactHandle(destination);
    if (ref) out.push(ref);
  }
  for (const bare of prose.matchAll(/(?<![\p{L}\p{N}_/\\])#artifact\/[^\s<>()[\]{}"'`]+/gu)) {
    const ref = parseArtifactHandle(bare[0].replace(/[.,;:!?]+$/g, ''));
    if (ref) out.push(ref);
  }
  return out;
}

export function artifactRecordPath(id: string): string {
  assertArtifactId(id);
  return `artifacts/${id.slice(0, 4)}/${id}.md`;
}

export function artifactAttachmentRelativePath(id: string, filename: string): string {
  assertArtifactId(id);
  assertAttachmentFilename(filename);
  return `artifacts/${id.slice(0, 4)}/${id}/${filename}`;
}
