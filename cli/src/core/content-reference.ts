// Direct content links, separate from tagged/contextual record associations.
// Query and validation share this scanner; callers resolve targets themselves.
import { markdownReferenceText } from './markdown.js';
import { parseArtifactHandle } from './artifact-reference.js';
import { ID_CHAR, resolveRelativePath, safeDecode } from './record-reference.js';

export type ContentReferenceKind = 'entry' | 'project' | 'action' | 'artifact';
export interface ContentReference {
  kind: ContentReferenceKind;
  id: string;
  filename?: string;
  // A file link must resolve to the actual containing file, not just a stem.
  filePath?: string;
}

const entityHandle = new RegExp(`^#(project|action)/(${ID_CHAR}+)$`, 'u');
const bareHandle = /(?<![\p{L}\p{N}_/\\])#(?:entry|project|action|artifact)\/[^\s<>()[\]{}"'`]+/gu;

export function parseContentHandle(target: string): ContentReference | undefined {
  const artifact = parseArtifactHandle(target);
  if (artifact) return { kind: 'artifact', ...artifact };
  const decoded = safeDecode(target);
  const entity = entityHandle.exec(decoded);
  if (entity) return { kind: entity[1] as 'project' | 'action', id: entity[2] };
  const entry = /^#entry\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)$/.exec(decoded);
  return entry ? { kind: 'entry', id: entry[1] } : undefined;
}

// Disk adapters provide the authored root and its real path. Normalization is
// lexical and portable: no lookup/following of an outside filesystem target.
function normalizeAbsoluteDestination(baseFile: string, destination: string, roots: readonly string[]): string | undefined {
  if (!destination.startsWith('/')) return destination;
  const boundary = destination.search(/[?#]/);
  const rawPath = boundary < 0 ? destination : destination.slice(0, boundary);
  const suffix = boundary < 0 ? '' : destination.slice(boundary);
  const absolute = safeDecode(rawPath);
  const normalize = (path: string) => {
    const segments: string[] = [];
    for (const segment of path.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment);
    }
    return `/${segments.join('/')}`;
  };
  const target = normalize(absolute);
  for (const root of roots) {
    const prefix = `${normalize(root).replace(/\/$/, '')}/`;
    if (!target.startsWith(prefix)) continue;
    const depth = baseFile.split('/').length - 1;
    // Encode the already-decoded path once; resolveRelativePath decodes it.
    const relative = target.slice(prefix.length).split('/').map(encodeURIComponent).join('/');
    return `${'../'.repeat(depth)}${relative}${suffix}`;
  }
  return undefined;
}

function parseFileReference(baseFile: string, destination: string): ContentReference | undefined {
  const path = resolveRelativePath(baseFile, destination);
  if (path === null) return undefined;
  const record = /^(projects|actions|artifacts)\/[^/]+\/([^/]+)\.md$/.exec(path);
  if (record) return { kind: record[1].slice(0, -1) as 'project' | 'action' | 'artifact', id: record[2], filePath: path };
  const attachment = /^artifacts\/[^/]+\/([^/]+)\/([^/]+)$/.exec(path);
  if (attachment) return { kind: 'artifact', id: attachment[1], filename: attachment[2], filePath: path };
  if (!/^notes\/[^/]+\/[^/]+\.md$/.test(path)) return undefined;
  const fragment = destination.indexOf('#');
  if (fragment < 0) return undefined; // The weekly container is not an entry.
  const target = safeDecode(destination.slice(fragment + 1));
  const entry = parseContentHandle(target.startsWith('entry/') ? `#${target}` : `#entry/${target}`);
  return entry && { ...entry, filePath: path };
}

export function extractContentReferences(markdown: string, baseFile: string, roots: readonly string[] = []): ContentReference[] {
  const { destinations, prose } = markdownReferenceText(markdown);
  const out: ContentReference[] = [];
  for (const destination of destinations) {
    const normalized = normalizeAbsoluteDestination(baseFile, destination, roots);
    const reference = parseContentHandle(destination) ?? (normalized === undefined ? undefined : parseFileReference(baseFile, normalized));
    if (reference) out.push(reference);
  }
  for (const match of prose.matchAll(bareHandle)) {
    const reference = parseContentHandle(match[0].replace(/[.,;:!?]+$/g, ''));
    if (reference) out.push(reference);
  }
  return out;
}
