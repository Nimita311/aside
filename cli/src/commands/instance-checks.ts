import { isInstanceId } from '../core/identity.js';
import type { HealthCheck } from './output.js';
import type {AvailableInstance} from '../core/catalogue.js';
import {resolve} from 'node:path';

// Listings diagnose catalogue-wide conflicts; individual files belong to validate.
export function instanceIdClashChecks(instances: Pick<AvailableInstance, 'path' | 'id' | 'worktree'>[]): HealthCheck[] {
  const byId = new Map<string, Set<string>>();
  const families = new Map<string, string>();
  for (const instance of instances) {
    if (!isInstanceId(instance.id)) continue;
    const paths = byId.get(instance.id) ?? new Set<string>();
    const path = resolve(instance.path);
    paths.add(path);
    families.set(path, instance.worktree ? `${instance.worktree.commonDir}\0${instance.worktree.primaryPath}` : path);
    byId.set(instance.id, paths);
  }
  return [...byId].filter(([, paths]) => new Set([...paths].map(path => families.get(path))).size > 1).map(([id, paths]) => ({
    code: 'instance_id_conflict', label: `Instance ID clash: ${id}`, passed: false,
    problems: [`Instance ID "${id}" is shared by ${[...paths].map(path => JSON.stringify(path)).join(', ')}.`],
    fixes: ['Remove extra copies with aside instance forget --dir <path>, or give distinct instances unique IDs in aside.md.'],
  }));
}
