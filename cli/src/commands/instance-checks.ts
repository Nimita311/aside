import { isInstanceId } from '../core/identity.js';
import { instanceKey } from '../daemon/host.js';
import { instanceFamily } from '../core/worktree.js';
import type { HealthCheck } from './output.js';

// Listings diagnose catalogue-wide conflicts; individual files belong to validate.
export function instanceIdClashChecks(instances: { path: string; id: string }[]): HealthCheck[] {
  const byId = new Map<string, Set<string>>();
  for (const instance of instances) {
    if (!isInstanceId(instance.id)) continue;
    const paths = byId.get(instance.id) ?? new Set<string>();
    paths.add(instanceKey(instance.path));
    byId.set(instance.id, paths);
  }
  return [...byId].filter(([, paths]) => new Set([...paths].map(instanceFamily)).size > 1).map(([id, paths]) => ({
    code: 'instance_id_conflict', label: `Instance ID clash: ${id}`, passed: false,
    problems: [`Instance ID "${id}" is shared by ${[...paths].map(path => JSON.stringify(path)).join(', ')}.`],
    fixes: ['Remove extra copies with aside instance forget --dir <path>, or give distinct instances unique IDs in aside.md.'],
  }));
}
