import { entityFilePath, getMondayOfWeek, weekFilePath, assetMediaKind, type EntityRef } from '../lib/types';
import type { Artifact } from '../../cli/src/core/types';
import { artifactContentFilename } from '../../cli/src/core/artifact-reference';
import type { DocRef } from './route';

// A projection's readable source is the retained template, not a synthetic file.
export function actionSourceId(id: string): string {
  const match = /^~([^@]+)@(.+)$/.exec(id);
  try { return match ? decodeURIComponent(match[1]) : id; }
  catch { return id; }
}

export function documentFilePath(doc: DocRef, filter: EntityRef | null): string {
  if (doc.kind === 'asset') return doc.path;
  if (doc.kind === 'artifact') return entityFilePath('artifact', doc.id);
  if (!filter) return 'aside.md';
  if (filter.type === 'entry') return weekFilePath(getMondayOfWeek(new Date(filter.id.slice(0, 10) + 'T00:00:00')));
  return entityFilePath(filter.type, filter.type === 'action' ? actionSourceId(filter.id) : filter.id);
}

// Classify known file destinations before a read completes. The cached
// artifact supplies the implicit single-attachment rule for an artifact URL;
// an explicit attachment is authoritative even before that record is loaded.
export function documentIsHtml(doc: DocRef | null, artifact?: Artifact): boolean {
  if (!doc || doc.kind === 'detail') return false;
  const path = doc.kind === 'asset' ? doc.path
    : doc.filename ?? (artifact ? artifactContentFilename(artifact) : undefined);
  return path !== undefined && assetMediaKind(path) === 'webpage';
}
