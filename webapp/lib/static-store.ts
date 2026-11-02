// Optional browser entry point for a plain static data host (including Pages).
// The daemon app does not import or instantiate this module.
import { DataCore } from '../../cli/src/core/data-core';
import { UrlDataSource } from '../../cli/src/core/data-source';

export { DataCore, UrlDataSource };
export async function loadStaticStore(baseUrl: string, years?: string[]) {
  const source = new UrlDataSource(baseUrl, years);
  const store = new DataCore(source);
  await store.init();
  return { store, source };
}
