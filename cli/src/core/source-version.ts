import { createHash, type Hash } from 'node:crypto';
import type { Store } from '../source/store.js';

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

// Hash one source value at a time. In particular, Markdown bodies go directly
// into the hash instead of allocating a serialized copy of the entire corpus.
function value(hash: Hash, source: unknown, ancestors = new Map<object, number>()): void {
  if (source == null) { hash.update('null;'); return; }
  if (typeof source === 'string') { hash.update(`s${Buffer.byteLength(source)}:`); hash.update(source); return; }
  if (typeof source !== 'object') { hash.update(`${typeof source}:${String(source)};`); return; }
  // Best-effort parsing retains malformed declarations, including cyclic YAML
  // aliases. Encode ancestor references without changing ordinary value hashes.
  const ancestor = ancestors.get(source);
  if (ancestor !== undefined) { hash.update(`ref:${ancestor};`); return; }
  ancestors.set(source, ancestors.size);
  try {
    if (Array.isArray(source)) {
      hash.update('['); for (const item of source) value(hash, item, ancestors); hash.update(']'); return;
    }
    if (source instanceof Map) {
      hash.update('map{');
      for (const [key, item] of [...source].sort(([a], [b]) => compare(a, b))) { value(hash, key, ancestors); value(hash, item, ancestors); }
      hash.update('}'); return;
    }
    hash.update('{');
    for (const key of Object.keys(source).sort()) {
      const item = (source as Record<string, unknown>)[key];
      // Missing and undefined metadata have the same GraphQL meaning.
      if (item !== undefined) { value(hash, key, ancestors); value(hash, item, ancestors); }
    }
    hash.update('}');
  } finally { ancestors.delete(source); }
}

/** Calculate the loaded snapshot hash when the instance publishes a change. */
export function loadedSourceVersion(store: Store): string {
  const hash = createHash('sha256');
  value(hash, store.getDataDir());
  value(hash, store.getInstance());
  value(hash, {notes: store.getNoteIndex(), projects: store.getProjectIndex(), actions: store.getActionIndex(), artifacts: store.getArtifactIndex()});
  value(hash, 'entries');
  hash.update('[');
  for (const entry of [...store.getEntries()].sort((a, b) => compare(a.meta.created, b.meta.created))) {
    value(hash, entry); value(hash, store.getEntryFile(entry.meta.created));
  }
  hash.update(']');
  for (const [kind, records, file] of [
    ['projects', store.getProjects(), (id: string) => store.getProjectFile(id)],
    ['actions', store.getActions(), (id: string) => store.getActionFile(id)],
    ['artifacts', store.getArtifacts(), (id: string) => store.getArtifactFile(id)],
  ] as const) {
    value(hash, kind);
    hash.update('[');
    for (const [id, record] of [...records].sort(([a], [b]) => compare(a, b))) {
      value(hash, id); value(hash, record); value(hash, file(id));
    }
    hash.update(']');
  }
  value(hash, store.getRelations());
  value(hash, store.getIssues());
  return hash.digest('hex');
}
