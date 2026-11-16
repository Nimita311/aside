import type { StoreView } from '../../cli/src/core/data-snapshot';
import type { WebQueryRequest, WebQueryResult } from '../../cli/src/core/web-query';
import { WEB_QUERY_TIMEOUT_MS } from '../../cli/src/core/web-query';
import { entryWeek, type Entry, type EntityRef } from '../lib/types';
import { effectiveSourceOrder, parseSourcePage, sourceRequest, SourceIncompleteError, type SourceDefinition, type SourceOrder } from './entry-source';

export const QUERY_FLOW_PAGE_SIZE = 50;

// The abortable, deadline-bounded requests of one disposable session. `subject`
// names the session in its cancellation and timeout messages.
export function createRequestScope(subject: string) {
  const controllers = new Set<AbortController>();
  const cancelled = () => new Error(`${subject} request cancelled.`);
  return {
    get busy(): boolean { return controllers.size > 0; },
    abort(): void { for (const controller of controllers) controller.abort(cancelled()); },
    async run<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const controller = new AbortController();
      controllers.add(controller);
      let rejectAborted!: (reason: Error) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
      const onAbort = () => rejectAborted(controller.signal.reason instanceof Error ? controller.signal.reason : cancelled());
      controller.signal.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error(`${subject} request timed out. Try again.`)), WEB_QUERY_TIMEOUT_MS);
      try {
        // Race explicitly: a transport or test adapter may ignore AbortSignal.
        return await Promise.race([run(controller.signal), aborted]);
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', onAbort);
        controllers.delete(controller);
      }
    },
  };
}

export interface QueryFlowOptions {
  definition: SourceDefinition;
  store: Pick<StoreView, 'getWeekEntries'>;
  query(request: WebQueryRequest, signal: AbortSignal): Promise<WebQueryResult>;
  filter?: EntityRef | null;
  search?: string;
  range?: { start: string; end: string };
  variables?: Record<string, unknown>;
  order?: SourceOrder;
}

export interface QueryFlowSession {
  readonly entries: readonly Entry[];
  readonly hasMore: boolean;
  readonly complete: boolean;
  readonly error: Error | null;
  readonly incomplete: boolean;
  readonly loading: boolean;
  readonly totalCount: number | null;
  readonly order: SourceOrder;
  loadMore(): Promise<void>;
  contains(id: string, overrides?: { filter?: EntityRef | null; search?: string }): Promise<boolean>;
  dispose(): void;
}

// A session is one fixed intersection of the agent source and browsing inputs.
// The server determines membership and order before pagination. Hydration only
// recovers native entry metadata; it never filters or reorders a returned page.
export function createQueryFlow(options: QueryFlowOptions): QueryFlowSession {
  const order = effectiveSourceOrder(options.definition, options.order, options.variables);
  const inputs = {
    filter: options.filter ? { ...options.filter } : null,
    search: options.search ?? '',
    range: options.range ? { ...options.range } : undefined,
    variables: options.variables ? structuredClone(options.variables) : undefined,
    order: options.order,
  };
  const requests = createRequestScope('Entry source');
  let records: Entry[] = [];
  let totalCount: number | null = null;
  let complete = false;
  let error: Error | null = null;
  let incomplete = false;
  let disposed = false;
  let pending: Promise<void> | null = null;

  // Not async: a caller awaits the scope's own promise, with no added turn.
  const request = <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    disposed ? Promise.reject(new Error('This entry source is no longer active.')) : requests.run(run);

  function loadMore(): Promise<void> {
    if (disposed || complete) return Promise.resolve();
    if (pending) return pending;
    error = null; incomplete = false;
    const offset = records.length;
    const task = request(async signal => {
      const response = await options.query(sourceRequest(options.definition, {
        ...inputs, offset, limit: QUERY_FLOW_PAGE_SIZE,
      }), signal);
      if (signal.aborted || disposed) return;
      const page = parseSourcePage(options.definition, response, {
        offset, limit: QUERY_FLOW_PAGE_SIZE, previousId: records.at(-1)?.meta.created, order,
      });
      if (totalCount !== null && page.totalCount !== totalCount) {
        throw new Error('This entry source changed while loading. Refresh the view to continue.');
      }
      const seen = new Set(records.map(entry => entry.meta.created));
      if (page.ids.some(id => seen.has(id)) || new Set(page.ids).size !== page.ids.length) {
        throw new Error('The entry source returned duplicate entries.');
      }
      const weeks = new Map(await Promise.all([...new Set(page.ids.map(entryWeek))]
        .map(async week => [week, await options.store.getWeekEntries(week)] as const)));
      const entries = page.ids.map(id => {
        const entry = weeks.get(entryWeek(id))?.find(candidate => candidate.meta.created === id);
        if (!entry) throw new Error(`Entry ${id} is missing from the current instance data. Refresh the view and try again.`);
        return entry;
      });
      if (signal.aborted || disposed) return;
      records = [...records, ...entries];
      totalCount = page.totalCount;
      complete = records.length === totalCount;
    }).catch(reason => {
      if (disposed) return;
      error = reason instanceof Error ? reason : new Error(String(reason));
      incomplete = reason instanceof SourceIncompleteError;
    }).finally(() => { if (pending === task) pending = null; });
    pending = task;
    return task;
  }

  async function contains(id: string, overrides: { filter?: EntityRef | null; search?: string } = {}): Promise<boolean> {
    return request(async signal => {
      const response = await options.query(sourceRequest(options.definition, {
        ...inputs,
        filter: overrides.filter === undefined ? inputs.filter : overrides.filter,
        search: overrides.search ?? inputs.search,
        offset: 0, limit: 1, additionalWhere: { ids: [id] },
      }), signal);
      signal.throwIfAborted();
      const page = parseSourcePage(options.definition, response, { offset: 0, limit: 1, order });
      if (page.totalCount > 1 || page.ids.some(candidate => candidate !== id)) {
        throw new Error('The entry source returned an invalid membership result.');
      }
      return page.ids.length === 1;
    });
  }

  return {
    get entries() { return records; },
    get hasMore() { return !disposed && !complete; },
    get complete() { return complete; },
    get error() { return error; },
    get incomplete() { return incomplete; },
    get loading() { return pending !== null || requests.busy; },
    get totalCount() { return totalCount; },
    get order() { return order; },
    loadMore, contains,
    dispose() {
      disposed = true;
      requests.abort();
    },
  };
}
