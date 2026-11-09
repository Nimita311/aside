import {lstatSync, readdirSync} from 'node:fs';
import {join, sep} from 'node:path';
import {managedInstancePathKind} from './managed-path.js';

export interface SourceMetadata {years: readonly string[]; lastEdited?: string}

/** Source loading publishes filesystem metadata alongside its parsed records. */
export function readSourceMetadata(root: string, publishedPaths: Iterable<string> = []): SourceMetadata {
  const years = new Set<string>();
  // An unreadable source retains its published records until it can be read
  // again. Keep their years discoverable without preserving deleted years.
  for (const relative of publishedPaths) {
    if (managedInstancePathKind(relative)) {
      const year = relative.split(sep)[1];
      if (year) years.add(year);
    }
  }
  let lastEdited = 0;
  const inspect = (relative: string): void => {
    const kind = managedInstancePathKind(relative);
    if (!kind) return;
    try {
      const file = join(root, relative), stat = lstatSync(file);
      if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) return;
      lastEdited = Math.max(lastEdited, stat.mtimeMs);
      const parts = relative.split(sep);
      if (parts.length === 2 && kind === 'directory') years.add(parts[1]);
      if (kind === 'directory') for (const name of readdirSync(file)) inspect(join(relative, name));
    } catch { /* Source diagnostics report unreadable paths. */ }
  };
  for (const path of ['aside.md', 'notes', 'projects', 'actions', 'artifacts']) inspect(path);
  return {years: [...years].sort(), ...(lastEdited ? {lastEdited: new Date(lastEdited).toISOString()} : {})};
}
