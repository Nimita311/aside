import type { Relations } from '../../cli/src/core/data-snapshot';
import { entityKey } from '../lib/types';
import { formatStamp, type FieldValue } from './render';

// An entity's linked assets, most recently linked first — dated by the
// latest entry linking them; a body-only link has no entry and keeps its
// place undated at the tail.
export function entityAssets(type: 'project' | 'action', id: string, relations: Relations): { path: string; title: string; updated?: string }[] {
  return (relations.assetsByEntity.get(entityKey(type, id)) ?? [])
    .map((a, i) => ({ path: a.path, title: a.title, updated: relations.entriesByAsset.get(a.path)?.[0], i }))
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '') || a.i - b.i)
    .map(({ path, title, updated }) => ({ path, title, updated }));
}

// The one stat every entity detail states: its entry count with the latest
// date — matching the filtered flow's count.
export function entityStats(type: 'project' | 'action', id: string, relations: Relations): [string, FieldValue][] {
  const entries = relations.entriesByEntity.get(entityKey(type, id)) ?? [];
  return [['Entries', entries.length
    ? current => `${entries.length} · latest ${formatStamp(entries[0].slice(0, 10), current)}`
    : '0']];
}

