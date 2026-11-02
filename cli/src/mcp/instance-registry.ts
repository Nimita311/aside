// Session selection and canonical-path catalog merging. Workspace membership
// comes from startup candidates; later selections never reclassify it.
import { instanceKey } from '../daemon/host.js';
import { isAsideDir } from '../core/instance.js';

export interface InstanceListing { path: string; workspace: boolean; active: boolean }
export interface InstanceSelection { workspace: string[]; encountered: string[]; active: string | null }

export class InstanceRegistry {
  private known: Set<string>;
  private workspace: Set<string>;
  private active: string | null = null;

  constructor(discovered: string[] = []) {
    this.known = new Set(discovered.map(instanceKey));
    this.workspace = new Set(this.known);
  }

  // The active instance's path, or null when none is selected.
  get activeInstance(): string | null {
    return this.active;
  }

  selection(): InstanceSelection {
    this.prune();
    return { workspace: [...this.workspace], encountered: [...this.known], active: this.active };
  }

  restore(selection: InstanceSelection): void {
    this.workspace = new Set(selection.workspace.map(instanceKey));
    this.known = new Set([...this.workspace, ...selection.encountered.map(instanceKey)]);
    this.active = selection.active === null ? null : instanceKey(selection.active);
    if (this.active) this.known.add(this.active);
    this.prune();
  }

  // Make an instance (by path) active, recording it as encountered.
  activate(path: string): void {
    this.active = instanceKey(path);
    this.known.add(this.active);
  }

  // Every instance encountered this session, in first-seen order.
  all(): string[] {
    this.prune();
    return [...this.known];
  }

  // Known instances other than the active one — candidates to switch to.
  others(): string[] {
    this.prune();
    return [...this.known].filter((p) => p !== this.active);
  }

  catalogue(daemonKnown: string[]): InstanceListing[] {
    this.prune();
    const paths = new Set([...this.known, ...daemonKnown.map(instanceKey)]);
    return [...paths].filter(isAsideDir).map((path) => ({
      path, workspace: this.workspace.has(path), active: path === this.active,
    }));
  }

  private prune(): void {
    for (const path of this.known) {
      if (isAsideDir(path)) continue;
      this.known.delete(path);
      this.workspace.delete(path);
      if (this.active === path) this.active = null;
    }
  }
}
