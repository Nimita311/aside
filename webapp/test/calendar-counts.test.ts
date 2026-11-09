import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, valueFromASTUntyped, visit } from 'graphql';
import type { WebQueryRequest, WebQueryResult } from '../../cli/src/core/web-query';
import { WEB_QUERY_TIMEOUT_MS } from '../../cli/src/core/web-query';
import { getMondayOfWeek, type Entry } from '../lib/types';
import { createCalendarCounts, CalendarCountsIncompleteError, type CalendarCounts, type CalendarCountsOptions } from '../src/calendar-counts';
import { SourceIncompleteError, type SourceDefinition } from '../src/entry-source';

const project = '2026-10-01-aurora', action = '2026-10-01-review';
function entry(id: string, content: string, tags: Partial<Entry['meta']> = {}): Entry {
  return { meta: { created: id, ...tags }, content, weekFile: getMondayOfWeek(new Date(`${id.slice(0, 10)}T00:00:00`)) };
}
function nativeStore(entries: Entry[] = [], descriptions: Record<string, string> = {}) {
  const weeks = new Map<string, Entry[]>();
  for (const record of entries) weeks.set(record.weekFile, [...(weeks.get(record.weekFile) ?? []), record]);
  return {
    getWeeklyDates: vi.fn(() => [...weeks.keys()].sort().reverse()),
    getWeekEntries: vi.fn(async (week: string) => weeks.get(week) ?? []),
    getNoteIndex: vi.fn(() => entries.map(record => ({ id: record.meta.created, description: descriptions[record.meta.created] ?? '' }))),
    getSearchProgress: vi.fn(() => ({ loaded: weeks.size, total: weeks.size, pending: 0, complete: true, failures: [] as string[] })),
    loadAllWeeks: vi.fn(async () => true),
  };
}
const counters: CalendarCounts[] = [];
function counter(options: CalendarCountsOptions) {
  const result = createCalendarCounts(options); counters.push(result); return result;
}
afterEach(() => { counters.splice(0).forEach(value => value.dispose()); vi.useRealTimers(); });

describe('calendar activity for native entry timelines', () => {
  it('counts all matching records across adjacent months, independent of rendered pages', async () => {
    const store = nativeStore([
      entry('2026-09-30T23:59', 'A calmer start.', { projects: [project] }),
      entry('2026-10-01T09:00', 'Calmer mornings.', { projects: [project] }),
      entry('2026-10-01T10:00', `A calmer inline mention: #project/${project}.`),
      entry('2026-10-01T11:00', 'Body has no phrase.', { projects: [project] }),
      entry('2026-10-01T12:00', 'Calmer elsewhere.', { projects: ['other'] }),
      entry('2026-10-02T09:00', 'Calmer, outside active range.', { projects: [project] }),
      entry('2026-10-12T09:00', 'Calmer, outside calendar.', { projects: [project] }),
    ], { '2026-10-01T11:00': 'A CALMER note description' });
    const counts = await counter({ store, filter: { type: 'project', id: project }, search: ' calmer ',
      range: { start: '2026-09-30T23:00', end: '2026-10-01T11:00' } }).getDayCounts('2026-09-28', '2026-10-04');
    expect([...counts]).toEqual([
      ['2026-09-28', 0], ['2026-09-29', 0], ['2026-09-30', 1], ['2026-10-01', 3],
      ['2026-10-02', 0], ['2026-10-03', 0], ['2026-10-04', 0],
    ]);
    expect(store.getWeekEntries.mock.calls.map(([week]) => week)).toEqual(['2026-09-28']);
  });

  it('matches action references and entry focus with the same native predicate', async () => {
    const id = '2026-10-04T10:00';
    const store = nativeStore([entry(id, `Review #action/${action}.`), entry('2026-10-04T11:00', 'Other.')]);
    expect((await counter({ store, filter: { type: 'action', id: action } }).getDayCounts('2026-10-04', '2026-10-04')).get('2026-10-04')).toBe(1);
    expect((await counter({ store, filter: { type: 'entry', id } }).getDayCounts('2026-10-04', '2026-10-04')).get('2026-10-04')).toBe(1);
  });

  it('intersects an inspected clock range with the active timeline selection', async () => {
    const store = nativeStore([
      entry('2026-10-04T08:59', 'Calmer, before both ranges.', { projects: [project] }),
      entry('2026-10-04T09:15', 'Calmer, before the inspected range.', { projects: [project] }),
      entry('2026-10-04T09:30', 'Calmer, included boundary.', { projects: [project] }),
      entry('2026-10-04T10:00', 'Calmer, included boundary.', { projects: [project] }),
      entry('2026-10-04T10:01', 'Calmer, beyond the active timeline.', { projects: [project] }),
      entry('2026-10-04T09:45', 'A different note.', { projects: [project] }),
      entry('2026-10-04T09:50', 'Calmer, different project.', { projects: ['other'] }),
    ]);
    const counts = await counter({ store, filter: { type: 'project', id: project }, search: 'calmer',
      range: { start: '2026-10-04T09:00', end: '2026-10-04T10:00' },
      additionalRange: { start: '2026-10-04T09:30', end: '2026-10-04T11:00' },
    }).getDayCounts('2026-10-04', '2026-10-04');
    expect(counts.get('2026-10-04')).toBe(2);
  });

  it('snapshots filter/range inputs and coalesces or caches the same calendar grid', async () => {
    const store = nativeStore([entry('2026-10-04T10:00', 'A note.', { projects: [project] })]);
    const filter = { type: 'project' as const, id: project }, range = { start: '2026-10-04', end: '2026-10-04' };
    const calendar = counter({ store, filter, range });
    filter.id = 'other'; range.end = '2026-10-03';
    const first = calendar.getDayCounts('2026-10-04', '2026-10-04');
    expect(calendar.getDayCounts('2026-10-04', '2026-10-04')).toBe(first);
    expect((await first).get('2026-10-04')).toBe(1);
    expect(await calendar.getDayCounts('2026-10-04', '2026-10-04')).toBe(await first);
    expect(store.loadAllWeeks).toHaveBeenCalledTimes(1);
  });

  it('does not turn missing or diagnostically incomplete snapshot coverage into zero activity', async () => {
    const store = nativeStore();
    store.loadAllWeeks.mockResolvedValueOnce(false);
    const calendar = counter({ store });
    await expect(calendar.getDayCounts('2026-10-01', '2026-10-04')).rejects.toBeInstanceOf(CalendarCountsIncompleteError);
    store.getSearchProgress.mockReturnValueOnce({ loaded: 0, total: 1, pending: 0, complete: false, failures: ['notes/2026-09-28.md'] });
    await expect(calendar.getDayCounts('2026-10-01', '2026-10-04')).rejects.toBeInstanceOf(CalendarCountsIncompleteError);
    expect([...(await calendar.getDayCounts('2026-10-01', '2026-10-04')).values()]).toEqual([0, 0, 0, 0]);
  });

  it('validates calendar labels and advances across DST without changing day labels', async () => {
    const calendar = counter({ store: nativeStore() });
    await expect(calendar.getDayCounts('2026-02-30', '2026-03-03')).rejects.toThrow('ordered calendar dates');
    await expect(calendar.getDayCounts('2026-10-04', '2026-10-01')).rejects.toThrow('ordered calendar dates');
    expect([...(await calendar.getDayCounts('2026-10-31', '2026-11-03')).keys()]).toEqual(['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  });
});

const definition: SourceDefinition = {
  query: `query Calendar($project: ID!, $where: EntryWhere, $direction: RecordOrder = CREATED_DESC, $authored: Int = 9) {
    scope: project(id: $project) { result: entries(where: $where, limit: $authored, offset: 7, orderBy: $direction) {
      hits: nodes { stamp: id } total: totalCount from: offset size: count
    } }
  }`,
  operationName: 'Calendar',
  variables: { project, where: { or: [{ search: 'decision' }, { search: 'review' }], not: { search: 'draft' } } },
};
function entryArguments(request: WebQueryRequest): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  visit(parse(request.query), { Field(node) {
    if (node.name.value === 'entries') args = Object.fromEntries((node.arguments ?? []).map(value => [value.name.value, valueFromASTUntyped(value.value, request.variables)]));
  } });
  return args;
}
function page(ids: string[], offset = 0, totalCount = ids.length): WebQueryResult {
  return { data: { scope: { result: { hits: ids.map(stamp => ({ stamp })), from: offset, size: ids.length, total: totalCount } } }, extensions: { complete: true } };
}
const ids = Array.from({ length: 130 }, (_, index) => `2026-10-${index < 65 ? '04' : '03'}T${String(9 + Math.floor(index % 65 / 60)).padStart(2, '0')}:${String(index % 65 % 60).padStart(2, '0')}`).sort().reverse();

describe('calendar activity for authored entry sources', () => {
  it('ANDs an inspected clock range with the authored query and retained timeline range', async () => {
    const query = vi.fn<NonNullable<CalendarCountsOptions['query']>>(async request => {
      expect(entryArguments(request).where).toEqual({ and: [
        definition.variables!.where,
        { browse: { project, search: 'review', createdFrom: '2026-10-03', createdTo: '2026-10-04T10:00' } },
        { and: [
          { browse: { createdFrom: '2026-10-04', createdTo: '2026-10-04' } },
          { browse: { createdFrom: '2026-10-04T09:30', createdTo: '2026-10-04T11:00' } },
        ] },
      ] });
      return page(['2026-10-04T10:00', '2026-10-04T09:30']);
    });
    const calendar = counter({ store: nativeStore(), definition, query, filter: { type: 'project', id: project }, search: 'review',
      range: { start: '2026-10-03', end: '2026-10-04T10:00' },
      additionalRange: { start: '2026-10-04T09:30', end: '2026-10-04T11:00' },
    });
    expect((await calendar.getDayCounts('2026-10-04', '2026-10-04')).get('2026-10-04')).toBe(2);
    query.mockResolvedValueOnce(page(['2026-10-04T09:29']));
    await expect(calendar.getDayCounts('2026-10-04', '2026-10-05')).rejects.toThrow('outside its requested range');
  });

  it('counts every source page without hydration and preserves parent scope, grouped selection and browsing intersection', async () => {
    const store = nativeStore();
    const query = vi.fn<NonNullable<CalendarCountsOptions['query']>>(async request => {
      const args = entryArguments(request), offset = args.offset as number;
      expect(args).toEqual({ where: { and: [definition.variables!.where,
        { browse: { project, search: 'retry + rollback', createdFrom: '2026-10-03T09:00', createdTo: '2026-10-04' } },
        { browse: { createdFrom: '2026-09-28', createdTo: '2026-10-04' } },
      ] }, offset, limit: 100, orderBy: 'CREATED_DESC' });
      expect(request.variables?.project).toBe(project);
      expect(request.query).toContain('scope: project(id: $project)');
      return page(ids.slice(offset, offset + 100), offset, ids.length);
    });
    const calendar = counter({ store, definition, query, filter: { type: 'project', id: project }, search: 'retry + rollback',
      range: { start: '2026-10-03T09:00', end: '2026-10-04' } });
    const counts = await calendar.getDayCounts('2026-09-28', '2026-10-04');
    expect(counts.get('2026-10-04')).toBe(65); expect(counts.get('2026-10-03')).toBe(65);
    expect(query.mock.calls.map(([request]) => entryArguments(request).offset)).toEqual([0, 100]);
    expect(store.getWeekEntries).not.toHaveBeenCalled(); expect(store.loadAllWeeks).not.toHaveBeenCalled();
    expect(await calendar.getDayCounts('2026-09-28', '2026-10-04')).toBe(counts);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('respects ascending variable/default ordering and explicit user overrides', async () => {
    const query = vi.fn<NonNullable<CalendarCountsOptions['query']>>(async request => {
      expect(entryArguments(request).orderBy).toBe('CREATED_ASC');
      return page([ids.at(-1)!, ids[0]]);
    });
    await expect(counter({ store: nativeStore(), definition, query, order: 'CREATED_ASC' }).getDayCounts('2026-10-01', '2026-10-04')).resolves.toBeInstanceOf(Map);
    const fromVariable = { ...definition, variables: { ...definition.variables, direction: 'CREATED_ASC' } };
    await expect(counter({ store: nativeStore(), definition: fromVariable, query }).getDayCounts('2026-10-01', '2026-10-04')).resolves.toBeInstanceOf(Map);
  });

  it('rejects partial completeness, changed pages and entries outside the requested intersection', async () => {
    const query = vi.fn<NonNullable<CalendarCountsOptions['query']>>()
      .mockResolvedValueOnce({ ...page([]), extensions: { complete: false } })
      .mockResolvedValueOnce(page(ids.slice(0, 100), 0, 130))
      .mockResolvedValueOnce(page(ids.slice(100, 129), 100, 129))
      .mockResolvedValueOnce(page(['2026-09-01T09:00']));
    const calendar = counter({ store: nativeStore(), definition, query });
    await expect(calendar.getDayCounts('2026-10-01', '2026-10-04')).rejects.toBeInstanceOf(SourceIncompleteError);
    await expect(calendar.getDayCounts('2026-10-01', '2026-10-04')).rejects.toThrow('changed while loading');
    await expect(calendar.getDayCounts('2026-10-01', '2026-10-04')).rejects.toThrow('outside its requested range');
  });

  it('distinguishes a verified empty source from failure and retries failed requests', async () => {
    const query = vi.fn<NonNullable<CalendarCountsOptions['query']>>()
      .mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(page([]));
    const calendar = counter({ store: nativeStore(), definition, query });
    await expect(calendar.getDayCounts('2026-10-01', '2026-10-02')).rejects.toThrow('Offline');
    expect([...(await calendar.getDayCounts('2026-10-01', '2026-10-02')).values()]).toEqual([0, 0]);
  });

  it('times out ignored AbortSignals and aborts discarded contexts without publishing late counts', async () => {
    vi.useFakeTimers();
    const query = vi.fn<NonNullable<CalendarCountsOptions['query']>>(() => new Promise(() => {}));
    const calendar = counter({ store: nativeStore(), definition, query });
    const timedOut = expect(calendar.getDayCounts('2026-10-01', '2026-10-04')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(WEB_QUERY_TIMEOUT_MS); await timedOut;
    expect(query.mock.calls[0][1].aborted).toBe(true);
    const aborted = expect(calendar.getDayCounts('2026-10-01', '2026-10-04')).rejects.toThrow('cancelled');
    calendar.dispose(); await aborted;
    expect(query.mock.calls[1][1].aborted).toBe(true);
    await expect(calendar.getDayCounts('2026-10-01', '2026-10-04')).rejects.toThrow('no longer active');
  });
});
