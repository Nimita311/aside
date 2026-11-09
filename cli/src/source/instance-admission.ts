// Explicit source admission and offline inspection. Live readers consume the
// catalogue already published by the daemon lifecycle.
import {realpathSync, statSync} from 'node:fs';
import {basename, dirname, resolve} from 'node:path';
import {isInstanceId} from '../core/identity.js';
import {checkoutInfo} from '../core/worktree.js';
import {isAsideDir, readManifestResult, MANIFEST_FILE} from '../core/instance.js';
import {cataloguedInstances, instanceAlias, type AvailableInstance} from '../core/catalogue.js';

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
  return cataloguedInstances(instances);
}

// An existing directory or its manifest is registered in place, with aliases
// reduced to one canonical path. Picking other files never creates an instance.
export function registrationPath(selected: string): string {
  const path = resolve(selected);
  const directory = statSync(path).isDirectory() ? path : basename(path) === MANIFEST_FILE ? dirname(path) : '';
  if (!directory || !isAsideDir(directory)) throw new Error('Choose an existing aside directory or its aside.md manifest.');
  return realpathSync(directory);
}
