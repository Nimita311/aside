import {writeFileSync, renameSync, unlinkSync, openSync, closeSync, lstatSync, fchmodSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {assertManagedPath} from '../core/managed-path.js';

// Rewrite a file via a temp file in the same directory plus a rename, so a
// crash mid-write can never leave a truncated file. The temp name starts with
// a dot, which the reader and the Store's watcher both ignore. Shared with the
// Store's entity/weekly writes — every data-file write is crash-safe.
// Replacements retain the existing file's permission bits, independent of umask.
export function writeFileCrashSafe(path: string, data: string, managedRoot?: string): void {
  if (managedRoot !== undefined) path = assertManagedPath(managedRoot, path, 'file', true);
  const existing = lstatSync(path, { throwIfNoEntry: false });
  const mode = existing?.isFile() ? existing.mode & 0o7777 : undefined;
  const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  let created = false;
  try {
    const fd = openSync(tmp, 'wx', mode === undefined ? 0o666 : 0o600);
    created = true;
    try {
      writeFileSync(fd, data);
      if (mode !== undefined) fchmodSync(fd, mode);
    }
    finally { closeSync(fd); }
    if (managedRoot !== undefined) assertManagedPath(managedRoot, path, 'file', true);
    renameSync(tmp, path);
  } catch (e) {
    try {
      if (created) unlinkSync(tmp);
    } catch {
      // best effort — the write may have failed before the temp file existed
    }
    throw e;
  }
}
