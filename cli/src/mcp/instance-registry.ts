// Session selection and canonical-path catalog merging. Workspace membership
// comes from startup candidates; later selections never reclassify it.
import { instanceKey } from '../daemon/host.js';
import {resolve} from 'node:path';

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
    return { workspace: [...this.workspace], encountered: [...this.known], active: this.active };
  }

  restore(selection: InstanceSelection): void {
    // The owner canonicalizes admission. Round trips preserve those identities
    // without resolving their directories again.
    this.workspace = new Set(selection.workspace.map(path => resolve(path)));
    this.known = new Set([...this.workspace, ...selection.encountered.map(path => resolve(path))]);
    this.active = selection.active === null ? null : resolve(selection.active);
    if (this.active) this.known.add(this.active);
  }

  // Make an instance (by path) active, recording it as encountered.
  activate(path: string): void {
    this.active = instanceKey(path);
    this.known.add(this.active);
  }

  // Selection of an owner-admitted path consumes its published identity.
  activateAdmitted(path: string): void {
    this.active = resolve(path);
    this.known.add(this.active);
  }

  // Every instance encountered this session, in first-seen order.
  all(): string[] {
    return [...this.known];
  }

  catalogue(daemonKnown: string[]): InstanceListing[] {
    const paths = new Set([...this.known, ...daemonKnown.map(path => resolve(path))]);
    return [...paths].map((path) => ({
      path, workspace: this.workspace.has(path), active: path === this.active,
    }));
  }

  // Only the catalogue owner decides eligibility. Serializing or reading a
  // session never reopens manifests or clears selection on a transient read.
  reconcile(available: readonly string[]): void {
    const valid = new Set(available.map(path => resolve(path)));
    for (const path of this.known) {
      if (valid.has(path)) continue;
      this.known.delete(path);
      this.workspace.delete(path);
      if (this.active === path) this.active = null;
    }
  }
}
