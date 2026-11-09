import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, valueFromASTUntyped, visit } from 'graphql';
import type { Entry } from '../lib/types';
import type { WebQueryRequest, WebQueryResult } from '../../cli/src/core/web-query';
import { WEB_QUERY_TIMEOUT_MS } from '../../cli/src/core/web-query';
import { createQueryFlow, type QueryFlowOptions, type QueryFlowSession } from '../src/query-flow';
import type { SourceDefinition } from '../src/entry-source';

const definition: SourceDefinition = {
  query: 'query Decisions($where: EntryWhere) { entries(where: $where, orderBy: CREATED_DESC) { nodes { id } } }',
  operationName: 'Decisions',
  variables: { where: { or: [{ search: 'decision' }, { search: 'review' }], not: { search: 'draft' } } },
};
function argumentsFor(request: WebQueryRequest): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  visit(parse(request.query), { Field(node) {
    if (node.name.value === 'entries') result = Object.fromEntries((node.arguments ?? [])
      .map(argument => [argument.name.value, valueFromASTUntyped(argument.value, request.variables)]));
  } });
  return result;
}
const records: Entry[] = Array.from({ length: 60 }, (_, index) => ({
  meta: { created: `2026-10-18T10:${String(59 - index).padStart(2, '0')}`, projects: ['2026-10-12-missing'], actions: ['2026-10-12-review'] },
  content: `Decision ${index}`, weekFile: '2026-10-12',
}));
function page(ids: string[], offset = 0, totalCount = ids.length): WebQueryResult {
  return { data: { entries: { nodes: ids.map(id => ({ id })), offset, count: ids.length, totalCount } }, extensions: { complete: true } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const sessions: QueryFlowSession[] = [];
type Query = QueryFlowOptions['query'];
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.useRealTimers(); });

describe('paginated agent entry source', () => {
  function setup(query = vi.fn<Query>(async () => page(records.slice(0, 50).map(record => record.meta.created), 0, 60)), overrides: Partial<QueryFlowOptions> = {}) {
    const store = { getWeekEntries: vi.fn(async () => records) };
    const session = createQueryFlow({
      definition, store, query, filter: { type: 'project', id: '2026-10-12-aurora' }, search: 'retry + rollback', ...overrides,
    });
    sessions.push(session);
    return { session, store, query };
  }

  it('sends the complete intersection before each page and retains native entry metadata', async () => {
    const query = vi.fn<Query>(async request => {
      const offset = argumentsFor(request).offset as number;
      return page(records.slice(offset, offset + 50).map(record => record.meta.created), offset, 60);
    });
    const { session, store } = setup(query);
    expect(session.complete).toBe(false);
    await session.loadMore();
    expect(argumentsFor(query.mock.calls[0][0])).toEqual({
      where: { and: [definition.variables!.where, { browse: { project: '2026-10-12-aurora', search: 'retry + rollback' } }] },
      offset: 0, limit: 50, orderBy: 'CREATED_DESC',
    });
    expect(session.entries).toHaveLength(50);
    expect(session.entries[0]).toBe(records[0]);
    expect(session.entries[0].meta.projects).toEqual(['2026-10-12-missing']);
    expect(store.getWeekEntries).toHaveBeenCalledTimes(1);
    expect(session.hasMore).toBe(true); expect(session.complete).toBe(false);
    await session.loadMore();
    expect(argumentsFor(query.mock.calls[1][0]).offset).toBe(50);
    expect(session.entries).toEqual(records);
    expect(session.totalCount).toBe(60);
    expect(session.complete).toBe(true); expect(session.hasMore).toBe(false);
    await session.loadMore(); expect(query).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping loads and retries a failed page at its original offset', async () => {
    const first = deferred<WebQueryResult>();
    const query = vi.fn<Query>().mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(new Error('Temporarily offline'))
      .mockResolvedValueOnce(page(records.slice(50).map(record => record.meta.created), 50, 60));
    const { session } = setup(query);
    const loading = session.loadMore();
    expect(session.loadMore()).toBe(loading); expect(session.loading).toBe(true);
    first.resolve(page(records.slice(0, 50).map(record => record.meta.created), 0, 60));
    await loading;
    await session.loadMore();
    expect(session.error?.message).toContain('offline');
    expect(session.entries).toHaveLength(50); expect(session.hasMore).toBe(true);
    await session.loadMore();
    expect(query.mock.calls.slice(1).map(([request]) => argumentsFor(request).offset)).toEqual([50, 50]);
    expect(session.error).toBeNull(); expect(session.complete).toBe(true);
  });

  it('does not commit part of a page when a query ID cannot be hydrated', async () => {
    const { session, store } = setup(vi.fn<Query>(async () => page(records.slice(0, 2).map(record => record.meta.created))));
    store.getWeekEntries.mockResolvedValueOnce([records[0]]);
    await session.loadMore();
    expect(session.error?.message).toContain(records[1].meta.created);
    expect(session.entries).toEqual([]); expect(session.totalCount).toBeNull();
    expect(session.complete).toBe(false);
    await session.loadMore();
    expect(session.entries).toEqual(records.slice(0, 2)); expect(session.complete).toBe(true);
  });

  it.each([
    ['errors', { errors: [{ message: 'Invalid query' }], extensions: { complete: false } }, false],
    ['incomplete corpus', { ...page([]), extensions: { complete: false } }, true],
    ['missing completeness', { data: page([]).data }, true],
    ['invalid offset', page([records[0].meta.created], 1, 2), false],
    ['duplicate IDs', page([records[0].meta.created, records[0].meta.created]), false],
    ['wrong order', page([records[1].meta.created, records[0].meta.created]), false],
    ['incorrect count', { data: { entries: { nodes: [], offset: 0, count: 1, totalCount: 1 } }, extensions: { complete: true } }, false],
  ])('keeps %s distinct from a verified empty result', async (_, response, incomplete) => {
    const { session } = setup(vi.fn<Query>(async () => response));
    await session.loadMore();
    expect(session.error).toBeInstanceOf(Error);
    expect(session.incomplete).toBe(incomplete);
    expect(session.complete).toBe(false); expect(session.entries).toEqual([]);
  });

  it('does not continue an offset cursor through a changed collection', async () => {
    const query = vi.fn<Query>()
      .mockResolvedValueOnce(page(records.slice(0, 50).map(record => record.meta.created), 0, 60))
      .mockResolvedValueOnce(page(records.slice(50, 59).map(record => record.meta.created), 50, 59));
    const { session } = setup(query);
    await session.loadMore(); await session.loadMore();
    expect(session.entries).toHaveLength(50);
    expect(session.error?.message).toContain('changed while loading');
    expect(session.complete).toBe(false);
  });

  it('verifies membership with the same source and browsing predicates without changing its cursor', async () => {
    const query = vi.fn<Query>(async () => page([records[0].meta.created]));
    const { session } = setup(query);
    expect(await session.contains(records[0].meta.created)).toBe(true);
    const request = query.mock.calls[0][0];
    expect(argumentsFor(request).offset).toBe(0); expect(argumentsFor(request).limit).toBe(1);
    expect(argumentsFor(request).where).toEqual({ and: [
      definition.variables!.where,
      { browse: { project: '2026-10-12-aurora', search: 'retry + rollback' } },
      { ids: [records[0].meta.created] },
    ] });
    expect(session.entries).toEqual([]); expect(session.totalCount).toBeNull();
    query.mockResolvedValueOnce(page([]));
    expect(await session.contains(records[0].meta.created)).toBe(false);
    query.mockResolvedValueOnce(page([]));
    await session.contains(records[0].meta.created, { filter: null });
    expect(argumentsFor(query.mock.calls[2][0]).where).toEqual({ and: [
      definition.variables!.where, { browse: { search: 'retry + rollback' } }, { ids: [records[0].meta.created] },
    ] });
  });

  it('hydrates and pages in the query’s ascending order without reversing records', async () => {
    const ascending = [...records].reverse();
    const query = vi.fn<Query>(async request => {
      const args = argumentsFor(request), offset = args.offset as number;
      expect(args.orderBy).toBe('CREATED_ASC');
      return page(ascending.slice(offset, offset + 50).map(record => record.meta.created), offset, ascending.length);
    });
    const { session } = setup(query, { definition: { ...definition, query: definition.query.replace('CREATED_DESC', 'CREATED_ASC') } });
    expect(session.order).toBe('CREATED_ASC');
    await session.loadMore(); await session.loadMore();
    expect(session.entries).toEqual(ascending);
    expect(session.complete).toBe(true); expect(session.error).toBeNull();
  });

  it('applies a user order override and keeps range predicates on membership probes', async () => {
    const query = vi.fn<Query>(async () => page([records[0].meta.created]));
    const range = { start: '2026-10-01T10:30', end: '2026-10-31' };
    const { session } = setup(query, { order: 'CREATED_ASC', range });
    expect(session.order).toBe('CREATED_ASC');
    await session.contains(records[0].meta.created);
    expect(argumentsFor(query.mock.calls[0][0])).toMatchObject({ orderBy: 'CREATED_ASC', where: { and: [definition.variables!.where,
      { browse: { project: '2026-10-12-aurora', search: 'retry + rollback', createdFrom: range.start, createdTo: range.end } },
      { ids: [records[0].meta.created] }] } });
  });

  it('settles a timeout even when the transport ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const query = vi.fn<Query>(() => new Promise<WebQueryResult>(() => {}));
    const { session } = setup(query);
    const loading = session.loadMore();
    await vi.advanceTimersByTimeAsync(WEB_QUERY_TIMEOUT_MS);
    await loading;
    expect(query.mock.calls[0][1].aborted).toBe(true);
    expect(session.error?.message).toContain('timed out');
    expect(session.loading).toBe(false); expect(session.hasMore).toBe(true);
  });

  it('cancels discarded sessions and ignores late query completions', async () => {
    const response = deferred<WebQueryResult>();
    const query = vi.fn<Query>(() => response.promise);
    const { session, store } = setup(query);
    const loading = session.loadMore(); session.dispose(); await loading;
    expect(query.mock.calls[0][1].aborted).toBe(true);
    response.resolve(page([records[0].meta.created]));
    await Promise.resolve(); await Promise.resolve();
    expect(session.entries).toEqual([]); expect(session.error).toBeNull();
    expect(session.hasMore).toBe(false); expect(session.loading).toBe(false);
    // The response may finish parsing after cancellation, but it must never
    // perform hydration or append content to the discarded session.
    expect(store.getWeekEntries).not.toHaveBeenCalled();
  });
});
