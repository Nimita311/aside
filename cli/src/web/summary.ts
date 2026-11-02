import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { managedInstancePathKind } from '../core/managed-path.js';
import type { Store } from '../mcp/store.js';
import type { InstanceCardSummary } from './catalogue.js';

const summaries = new WeakMap<Store, { at: number; value: InstanceCardSummary }>();

// Counts reuse the daemon's parsed records. Last edit reads filesystem metadata
// only for managed data, including indexes and attachments; it never parses
// the instance again or scans user-organized supporting files.
export function instanceCardSummary(store: Store): InstanceCardSummary {
  const cached = summaries.get(store);
  if (cached && Date.now() - cached.at < 1000) return cached.value;
  const projects = store.getProjectIndex(), actions = store.getActionIndex();
  let lastEdited = 0;
  const inspect = (relativePath: string): void => {
    const kind = managedInstancePathKind(relativePath);
    if (!kind) return;
    try {
      const path = join(store.getDataDir(), relativePath);
      const stat = lstatSync(path);
      if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) return;
      lastEdited = Math.max(lastEdited, stat.mtimeMs);
      if (kind === 'directory') {
        for (const entry of readdirSync(path)) inspect(join(relativePath, entry));
      }
    } catch { /* Unreadable records are reported by the store's diagnostics. */ }
  };
  for (const path of ['aside.md', 'notes', 'projects', 'actions', 'artifacts']) inspect(path);
  const value: InstanceCardSummary = {
    projects: { open: projects.filter(({ id }) => { const p = store.getProject(id); return p && !p.frontMatter.ended; }).length, total: projects.length },
    actions: { open: actions.filter(({ id }) => { const a = store.getAction(id); return a && !a.frontMatter.resolution; }).length, total: actions.length },
    entries: store.getNoteIndex().length,
    latest: store.getNoteIndex()[0]?.id,
    ...(lastEdited ? { lastEdited: new Date(lastEdited).toISOString() } : {}),
  };
  summaries.set(store, { at: Date.now(), value });
  return value;
}
