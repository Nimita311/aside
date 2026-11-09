import type { Store } from '../source/store.js';
import type {InstanceCardSummary} from '../core/catalogue.js';

const summaries = new WeakMap<Store, { revision: number; value: InstanceCardSummary }>();

// Counts and file metadata belong to the same published source observation.
export function instanceCardSummary(store: Store): InstanceCardSummary {
  const cached = summaries.get(store);
  if (cached?.revision === store.getRevision()) return cached.value;
  const projects = store.getProjectIndex(), actions = store.getActionIndex();
  const {lastEdited} = store.getSourceMetadata();
  const value: InstanceCardSummary = {
    projects: { open: projects.filter(({ id }) => { const p = store.getProject(id); return p && !p.frontMatter.ended; }).length, total: projects.length },
    actions: { open: actions.filter(({ id }) => { const a = store.getAction(id); return a && !a.frontMatter.resolution; }).length, total: actions.length },
    entries: store.getNoteIndex().length,
    latest: store.getNoteIndex()[0]?.id,
    ...(lastEdited ? {lastEdited} : {}),
  };
  summaries.set(store, {revision: store.getRevision(), value});
  return value;
}
