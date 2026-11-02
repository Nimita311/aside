import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertArtifactId } from './artifact-reference.js';

type ManagedKind = 'file' | 'directory';

export function isManagedInstancePath(relativePath: string): boolean {
  return managedInstancePathKind(relativePath) !== undefined;
}

export function managedInstancePathKind(relativePath: string): ManagedKind | undefined {
  // Reserve case aliases too: the filesystem may resolve them to the same
  // managed path even when the caller supplies different letter casing.
  const path = relativePath.toLowerCase();
  if (path === 'aside.md') return 'file';
  const parts = path.split(sep);
  if (!['notes', 'projects', 'actions', 'artifacts'].includes(parts[0])) return;
  if (parts.length === 1) return 'directory';
  if (!/^\d{4}$/.test(parts[1])) return;
  if (parts.length === 2) return 'directory';
  if (parts.length === 3 && (parts[2] === 'index.yaml' || parts[2].endsWith('.md'))) return 'file';
  if (parts[0] !== 'artifacts' || parts.length > 4 || parts[2].slice(0, 4) !== parts[1]) return;
  try { assertArtifactId(parts[2].normalize('NFKC')); }
  catch { return; }
  if (parts.length === 3) return 'directory';
  if (parts[3]) return 'file';
}

function pathError(code: string, message: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}: ${path}`), { code, path });
}

function containedRelative(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel;
}

// The selected root may be an alias (including the OS's /tmp alias). Every
// component owned by Aside below that root must be an ordinary file/directory.
// Same-user processes are trusted; this is not a sandbox against concurrent
// replacement of parent directories by another process running as that user.
export function assertManagedPath(root: string, path: string, kind: ManagedKind, allowMissing = false): string {
  const selectedRoot = resolve(root);
  const canonicalRoot = realpathSync(selectedRoot);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(selectedRoot, path);
  const rel = containedRelative(selectedRoot, absolutePath) ?? containedRelative(canonicalRoot, absolutePath);
  if (rel === undefined) throw pathError('EINVAL', 'Managed path is outside the instance', path);
  if (!lstatSync(canonicalRoot).isDirectory()) throw pathError('ENOTDIR', 'Instance root is not a directory', root);
  const parts = rel ? rel.split(sep) : [];
  const canonicalPath = join(canonicalRoot, ...parts);
  if (!parts.length && kind === 'file') throw pathError('EISDIR', 'Managed file is a directory', path);
  let current = canonicalRoot;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return canonicalPath;
      throw error;
    }
    if (stat.isSymbolicLink()) throw pathError('ELOOP', 'Symlinks are not allowed in Aside-managed paths', current);
    const expected = i === parts.length - 1 ? kind : 'directory';
    if (expected === 'directory' && !stat.isDirectory()) throw pathError('ENOTDIR', 'Managed directory is not a directory', current);
    if (expected === 'file' && !stat.isFile()) {
      throw pathError(stat.isDirectory() ? 'EISDIR' : 'EINVAL', 'Managed file is not a regular file', current);
    }
  }
  return canonicalPath;
}

export function readManagedText(root: string, path: string): string {
  const checked = assertManagedPath(root, path, 'file');
  const fd = openSync(checked, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw pathError('EINVAL', 'Managed file is not a regular file', checked);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
