import {createHash} from 'node:crypto';
import {isInstanceId} from './identity.js';
import type {Manifest} from './types.js';
import type {WorktreeInfo} from './worktree.js';

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

/** Linked checkouts of one instance share a family; any other path is its own. */
export function instanceFamilyKey(worktree: Pick<WorktreeInfo, 'commonDir' | 'primaryPath'> | undefined, path: string): string {
  return worktree ? `${worktree.commonDir}\0${worktree.primaryPath}` : path;
}

export function instanceIdError(id: string): {error?: string} {
  return isInstanceId(id) ? {} : {error: 'aside.md needs a valid instance id (lowercase letters, numbers, and hyphens).'};
}

/** One observed instance as catalogue input: identity, checkout, and what blocks it. */
export function observedInstance(path: string, {id, name, description}: Manifest, worktree?: WorktreeInfo, calendarWarning?: string): AvailableInstance {
  return {path, id, name, description, ...(worktree ? {worktree} : {}), ...(calendarWarning ? {calendarWarning} : {}), ...instanceIdError(id)};
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

/** Build routing metadata from lifecycle observations without touching files. */
export function cataloguedInstances(observed: readonly AvailableInstance[]): AvailableInstance[] {
  const instances = observed.map(instance => ({...instance, alias: instanceAlias(instance.id, instance.path)}));
  for (const instance of instances) {
    if (!isInstanceId(instance.id)) continue;
    const matches = instances.filter(other => other.id === instance.id);
    const families = new Set(matches.map(other => instanceFamilyKey(other.worktree, other.path)));
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
