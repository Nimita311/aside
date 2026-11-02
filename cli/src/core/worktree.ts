// Git topology belongs to the instance's directory, never the client's cwd.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseConfig } from './parser.js';
import { isAsideDir, readManifest } from './instance.js';

export interface WorktreeInfo {
  root: string;
  commonDir: string;
  primaryPath: string;
  linked: boolean;
  label: string;
}
export interface CheckoutInfo { worktree?: WorktreeInfo; error?: string }

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

// Bound subprocess work during calendar guards and catalogue requests. Policy
// is read separately so editing .aside takes effect immediately.
const topology = new Map<string, { at: number; value: CheckoutInfo; primaryRoot?: string }>();
export function checkoutInfo(path: string): CheckoutInfo {
  path = canonical(path);
  let cached = topology.get(path);
  if (!cached || Date.now() - cached.at > 1000) {
    const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
      // Parent Git overrides must not change which directory is inspected.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    });
    let value: CheckoutInfo;
    let primaryRoot: string | undefined;
    try {
      // Separate results preserve newlines and trailing spaces in Git paths.
      const gitPath = (flag: string) => canonical(git('rev-parse', '--path-format=absolute', flag).replace(/\n$/, ''));
      const root = gitPath('--show-toplevel'), gitDir = gitPath('--git-dir'), commonDir = gitPath('--git-common-dir');
      const records = git('worktree', 'list', '--porcelain', '-z').split('\0\0').map(record => record.split('\0'));
      const primary = records[0]?.find(field => field.startsWith('worktree '))?.slice(9);
      if (!primary || records[0].includes('bare')) throw new Error('Git has no primary working checkout.');
      primaryRoot = canonical(primary);
      const record = records.find(fields => fields.some(field => field.startsWith('worktree ') && canonical(field.slice(9)) === root));
      if (!record) throw new Error('Git did not list the current working checkout.');
      const branch = record?.find(field => field.startsWith('branch refs/heads/'))?.slice(18);
      value = { worktree: { root, commonDir, primaryPath: canonical(join(primaryRoot, relative(root, path))),
        linked: gitDir !== commonDir, label: branch ?? `Detached ${basename(root)}` } };
    } catch (error) {
      // Ordinary non-Git instances are supported. Failed inspection of a Git
      // checkout must not accidentally enable calendar writes in a worktree.
      let ancestor = path;
      while (!existsSync(join(ancestor, '.git')) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      value = existsSync(join(ancestor, '.git')) ? { error: `Cannot verify Git checkout for ${path}: ${error instanceof Error ? error.message : String(error)}. Calendar sync is disabled.` } : {};
    }
    cached = { at: Date.now(), value, primaryRoot };
    if (topology.size > 1024) topology.clear();
    topology.set(path, cached);
  }
  const worktree = cached.value.worktree;
  if (worktree) {
    try {
      const config = parseConfig(readFileSync(join(cached.primaryRoot!, '.aside'), 'utf8'));
      if (config.issues.some(issue => issue.code === 'invalid_yaml' || issue.field === 'worktreeDetection')) return { error: 'Invalid worktreeDetection policy in the primary checkout’s .aside. Calendar sync is disabled until it is repaired.' };
      if (config.value.worktreeDetection === false) return {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { error: 'Cannot read the primary checkout’s .aside. Calendar sync is disabled until it is readable.' };
    }
  }
  return cached.value;
}

// Expected copies share the primary instance path. Matching IDs are checked by
// callers; different IDs or instances at different relative paths stay distinct.
export function instanceFamily(path: string): string {
  const info = checkoutInfo(path).worktree;
  return info ? `${info.commonDir}\0${info.primaryPath}` : canonical(path);
}

export function primaryCounterpart(path: string): string | undefined {
  const info = checkoutInfo(path).worktree;
  if (info?.linked && isAsideDir(info.primaryPath)
    && checkoutInfo(info.primaryPath).worktree?.commonDir === info.commonDir
    && readManifest(info.primaryPath).id === readManifest(path).id) return info.primaryPath;
  return undefined;
}

export function withPrimaryInstances(paths: string[]): string[] {
  const instances = new Set<string>();
  for (const path of paths) {
    instances.add(canonical(path));
    const primary = primaryCounterpart(path);
    if (primary) instances.add(primary);
  }
  return [...instances];
}

// Forgetting a real primary also forgets its registered counterpart checkouts.
// A displayed worktree representative has no ownership over its siblings.
export function withoutInstanceFamilies(known: string[], removed: string[]): string[] {
  const keys = new Set(removed.map(canonical));
  const primaries = removed.map(path => ({ path: canonical(path), info: checkoutInfo(path).worktree, id: readManifest(path).id }))
    .filter(primary => primary.info && !primary.info.linked);
  return known.filter(path => !keys.has(canonical(path)) && !primaries.some(primary =>
    readManifest(path).id === primary.id && instanceFamily(path) === instanceFamily(primary.path)));
}

export function worktreeCalendarReason(path: string): string | null {
  const info = checkoutInfo(path);
  if (info.error) return info.error;
  return info.worktree?.linked
    ? `Calendar sync is disabled in this Git worktree. Move changes into the primary checkout for calendar sync: ${info.worktree.primaryPath}`
    : null;
}
