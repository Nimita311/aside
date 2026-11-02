import { entityFilePath, getMondayOfWeek, weekFilePath, type EntityRef } from '../lib/types';
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
