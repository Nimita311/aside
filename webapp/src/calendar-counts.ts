import type { StoreView } from '../../cli/src/core/data-snapshot';
import { isCalendarDate } from '../../cli/src/core/scheduling';
import { withinTimestampRange, type TimestampRange } from '../../cli/src/core/timestamp-range';
import { WEB_QUERY_TIMEOUT_MS, type WebQueryRequest, type WebQueryResult } from '../../cli/src/core/web-query';
import { entryReferences, getMondayOfWeek, type EntityRef } from '../lib/types';
import { effectiveSourceOrder, parseSourcePage, sourceRequest, type SourceDefinition, type SourceOrder } from './entry-source';
import { matchesFlowSearch } from './flow-search';

type CalendarStore = Pick<StoreView, 'getWeeklyDates' | 'getWeekEntries' | 'getNoteIndex' | 'getSearchProgress' | 'loadAllWeeks'>;

export interface CalendarCountsOptions {
  store: CalendarStore;
  definition?: SourceDefinition;
  query?(request: WebQueryRequest, signal: AbortSignal): Promise<WebQueryResult>;
  filter?: EntityRef | null;
  search?: string;
  range?: TimestampRange;
  /** An inspected period, intersected with the retained timeline's range. */
  additionalRange?: TimestampRange;
  variables?: Record<string, unknown>;
  order?: SourceOrder;
}

export interface CalendarCounts {
  /** Inclusive local calendar dates, including the adjacent-month cells. */
  getDayCounts(from: string, to: string): Promise<ReadonlyMap<string, number>>;
  dispose(): void;
}

export class CalendarCountsIncompleteError extends Error {
  constructor() {
    super('Calendar activity cannot be verified while instance data is incomplete.');
    this.name = 'CalendarCountsIncompleteError';
  }
}

const PAGE_SIZE = 100;
const DAY_MS = 86_400_000;

function emptyDays(from: string, to: string): Map<string, number> {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    throw new Error('Calendar count bounds must be ordered calendar dates.');
  }
  const days = new Map<string, number>();
  // UTC arithmetic advances calendar labels without DST or runtime-zone drift.
  for (let time = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); time <= end; time += DAY_MS) {
    days.set(new Date(time).toISOString().slice(0, 10), 0);
  }
  return days;
}

/** A fixed snapshot of the retained timeline's selection, independent of its rendered pages. */
export function createCalendarCounts(options: CalendarCountsOptions): CalendarCounts {
  const store = options.store;
  const definition = options.definition ? structuredClone(options.definition) : undefined;
  const inputs = {
    filter: options.filter ? { ...options.filter } : null,
    search: options.search ?? '',
    range: options.range ? { ...options.range } : undefined,
    additionalRange: options.additionalRange ? { ...options.additionalRange } : undefined,
    variables: options.variables ? structuredClone(options.variables) : undefined,
    order: options.order,
  };
  const query = options.query;
  const complete = new Map<string, ReadonlyMap<string, number>>();
  const pending = new Map<string, Promise<ReadonlyMap<string, number>>>();
  const controllers = new Set<AbortController>();
  let disposed = false;

  async function request<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (disposed) throw new Error('This calendar timeline is no longer active.');
    const controller = new AbortController();
    controllers.add(controller);
    let rejectAborted!: (reason: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    const onAbort = () => rejectAborted(controller.signal.reason instanceof Error
      ? controller.signal.reason : new Error('Calendar activity request cancelled.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('Calendar activity request timed out. Try again.')), WEB_QUERY_TIMEOUT_MS);
    try {
      return await Promise.race([run(controller.signal), aborted]);
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      controllers.delete(controller);
    }
  }

  async function countNative(from: string, to: string, days: Map<string, number>): Promise<void> {
    await request(async signal => {
      // RemoteStore returns [] for a missing snapshot week. Confirm coverage
      // before interpreting an absent record as a verified zero.
      if (!await store.loadAllWeeks() || !store.getSearchProgress().complete) throw new CalendarCountsIncompleteError();
      signal.throwIfAborted();
      const firstWeek = getMondayOfWeek(new Date(`${from}T00:00:00`));
      const lastWeek = getMondayOfWeek(new Date(`${to}T00:00:00`));
      const weeks = store.getWeeklyDates().filter(week => week >= firstWeek && week <= lastWeek);
      const descriptions = new Map(store.getNoteIndex().map(item => [item.id, item.description]));
      const records = await Promise.all(weeks.map(week => store.getWeekEntries(week)));
      signal.throwIfAborted();
      const seen = new Set<string>();
      for (const entry of records.flat()) {
        const id = entry.meta.created, day = id.slice(0, 10);
        if (seen.has(id)) throw new Error('Calendar activity received duplicate entries.');
        seen.add(id);
        if (days.has(day) && (!inputs.filter || entryReferences(entry, inputs.filter))
          && matchesFlowSearch(entry, inputs.search, descriptions.get(id)) && withinTimestampRange(id, inputs.range)
          && withinTimestampRange(id, inputs.additionalRange)) {
          days.set(day, days.get(day)! + 1);
        }
      }
    });
  }

  async function countSource(from: string, to: string, days: Map<string, number>): Promise<void> {
    if (!definition || !query) throw new Error('The calendar entry source has no query transport.');
    const order = effectiveSourceOrder(definition, inputs.order, inputs.variables);
    const seen = new Set<string>();
    let totalCount: number | null = null;
    let previousId: string | undefined;
    do {
      await request(async signal => {
        const offset = seen.size;
        const response = await query(sourceRequest(definition, {
          ...inputs, offset, limit: PAGE_SIZE,
          // Keep the active range ANDed with the grid bounds, rather than
          // replacing it. The authored parent/query selection stays intact.
          additionalWhere: inputs.additionalRange ? { and: [
            { browse: { createdFrom: from, createdTo: to } },
            { browse: { createdFrom: inputs.additionalRange.start, createdTo: inputs.additionalRange.end } },
          ] } : { browse: { createdFrom: from, createdTo: to } },
        }), signal);
        signal.throwIfAborted();
        const page = parseSourcePage(definition, response, { offset, limit: PAGE_SIZE, previousId, order, variables: inputs.variables });
        if (totalCount !== null && page.totalCount !== totalCount) {
          throw new Error('Calendar activity changed while loading. Refresh the view to continue.');
        }
        totalCount = page.totalCount;
        for (const id of page.ids) {
          const day = id.slice(0, 10);
          if (seen.has(id)) throw new Error('Calendar activity received duplicate entries.');
          if (!days.has(day) || !withinTimestampRange(id, inputs.range) || !withinTimestampRange(id, inputs.additionalRange)) throw new Error('The calendar entry source returned an entry outside its requested range.');
          seen.add(id);
          days.set(day, days.get(day)! + 1);
        }
        previousId = page.ids.at(-1);
      });
    } while (seen.size < totalCount!);
  }

  function getDayCounts(from: string, to: string): Promise<ReadonlyMap<string, number>> {
    if (disposed) return Promise.reject(new Error('This calendar timeline is no longer active.'));
    const key = `${from}/${to}`;
    const cached = complete.get(key);
    if (cached) return Promise.resolve(cached);
    const loading = pending.get(key);
    if (loading) return loading;
    const task = (async () => {
      const days = emptyDays(from, to);
      if (definition) await countSource(from, to, days);
      else await countNative(from, to, days);
      if (disposed) throw new Error('This calendar timeline is no longer active.');
      complete.set(key, days);
      return days;
    })().finally(() => { if (pending.get(key) === task) pending.delete(key); });
    pending.set(key, task);
    return task;
  }

  return {
    getDayCounts,
    dispose() {
      disposed = true;
      complete.clear();
      for (const controller of controllers) controller.abort(new Error('Calendar activity request cancelled.'));
    },
  };
}
