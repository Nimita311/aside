import type { Store } from '../source/store.js';

/** The source owner certifies whether the loaded corpus is complete. */
export function assertSearchSourceReadable(store: Store): void {
  const {complete, issue} = store.getSourceHealth();
  if (complete) return;
  const detail = issue ? `${issue.code}${issue.file ? ` at ${issue.file}` : ''}` : 'source observation unavailable';
  throw new Error(`Semantic source is not fully readable or parseable (${detail}). Repair the source files, then retry.`);
}

/** The lifecycle already published this hash; retrieval never hashes the corpus. */
export function searchSourceVersion(store: Store): string { return store.getSourceVersion(); }
