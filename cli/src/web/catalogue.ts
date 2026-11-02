// Browser discovery reads registered manifests; it never loads record stores
// or starts calendar sync. Paths, rather than IDs, are the registration keys.
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isInstanceId } from '../core/identity.js';
import { checkoutInfo, instanceFamily, type WorktreeInfo } from '../core/worktree.js';
import { isAsideDir, readManifestResult, MANIFEST_FILE } from '../core/instance.js';

export interface AvailableInstance {
  id: string;
  name?: string;
  description?: string;
  path: string;
  error?: string;
  address?: string;
  alias?: string;
  duplicatePaths?: string[];
  worktree?: WorktreeInfo;
  calendarWarning?: string;
  summary?: InstanceCardSummary;
}

export interface InstanceCardSummary {
  projects: { open: number; total: number };
  actions: { open: number; total: number };
  entries: number;
  latest?: string;
  lastEdited?: string;
}

export function instanceAlias(id: string, path: string): string {
  return `${id}~${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
}

export function resolveInstanceAddress(instances: AvailableInstance[], address: string): AvailableInstance | undefined {
  const matches = instances.filter(instance => address.includes('~')
    ? (instance.alias ?? instanceAlias(instance.id, instance.path)) === address
    : (instance.address ?? instance.id) === address);
  return matches.length === 1 ? matches[0] : undefined;
}

export function availableInstances(paths: string[]): AvailableInstance[] {
  const seen = new Set<string>();
  const instances: AvailableInstance[] = [];
  for (const registered of paths) {
    let path = resolve(registered);
    try { path = realpathSync(path); } catch { /* A registered canonical directory may be temporarily inaccessible. */ }
    if (seen.has(path)) continue;
    seen.add(path);
    if (!isAsideDir(path)) continue;
    const result = readManifestResult(path), readError = result.issues.find(issue => issue.code === 'read_error');
    if (readError || !isAsideDir(path)) continue;
    const { id, name, description } = result.value;
    const checkout = checkoutInfo(path);
    instances.push({ id, name, description, path, alias: instanceAlias(id, path),
      ...(checkout.worktree ? { worktree: checkout.worktree } : {}),
      ...(checkout.error ? { calendarWarning: checkout.error } : {}),
      ...(!isInstanceId(id) ? { error: 'aside.md needs a valid instance id (lowercase letters, numbers, and hyphens).' } : {}) });
  }
  for (const instance of instances) {
    if (!isInstanceId(instance.id)) continue;
    const matches = instances.filter(other => other.id === instance.id);
    const families = new Set(matches.map(other => instanceFamily(other.path)));
    const conflict = families.size > 1;
    instance.address = conflict || instance.worktree?.linked ? instance.alias : instance.id;
    if (conflict) {
      instance.duplicatePaths = matches.map(other => other.path);
      instance.calendarWarning = `Duplicate instance ID “${instance.id}”. Calendar sync is paused until independent instances have unique IDs in aside.md.\n${instance.duplicatePaths.join('\n')}`;
    }
    // A truncated hash collision is never allowed to select arbitrary files.
    if (instances.filter(other => other.alias === instance.alias).length > 1) instance.error = 'Instance address hash collision. Move one instance to another directory.';
  }
  return instances;
}

// An existing directory or its manifest is registered in place, with aliases
// reduced to one canonical path. Picking other files never creates an instance.
export function registrationPath(selected: string): string {
  const path = resolve(selected);
  const directory = statSync(path).isDirectory() ? path : basename(path) === MANIFEST_FILE ? dirname(path) : '';
  if (!directory || !isAsideDir(directory)) throw new Error('Choose an existing aside directory or its aside.md manifest.');
  return realpathSync(directory);
}

export type PickerKind = 'directory' | 'manifest';
export type InstanceRegistration = { kind: PickerKind } | { path: string };
export function pickInstance(kind: PickerKind): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('The native picker is available on macOS. Register an existing instance with aside instance add --dir <path>.');
  const command = kind === 'directory'
    ? 'POSIX path of (choose folder with prompt "Choose your Aside instance folder")'
    : 'POSIX path of (choose file with prompt "Choose an existing aside.md manifest")';
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', command], (error, stdout, stderr) => {
      if (!error) resolve(stdout.trim());
      else if (/\(-128\)/.test(stderr)) resolve(null);
      else reject(new Error(`Could not open the native picker: ${stderr.trim() || error.message}`));
    });
  });
}
