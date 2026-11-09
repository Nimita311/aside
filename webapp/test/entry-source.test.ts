import { describe, expect, it } from 'vitest';
import { Kind, buildSchema, graphql, parse, valueFromASTUntyped, visit } from 'graphql';
import { graphQLSDL } from '../../cli/src/graphql/sdl';
import type { WebQueryRequest } from '../../cli/src/core/web-query';
import { effectiveSourceOrder, parseEntrySource, sourceRequest, parseSourcePage, SourceIncompleteError } from '../src/entry-source';

const predicate = { or: [{ createdFrom: '2026-10-01' }, { not: { ids: ['2026-10-02T10:00'] } }] };
const definition = (changes: Record<string, unknown> = {}) => parseEntrySource(JSON.stringify({
  query: 'query Focus($where: EntryWhere) { flow: entries(where: $where) { nodes { id } } }', variables: { where: predicate }, ...changes,
}));
function argumentsFor(request: WebQueryRequest, index = 0): Record<string, unknown> {
  const results: Record<string, unknown>[] = [];
  visit(parse(request.query), { Field(node) {
    if (node.name.value === 'entries') results.push(Object.fromEntries((node.arguments ?? [])
      .map(argument => [argument.name.value, valueFromASTUntyped(argument.value, request.variables)])));
  } });
  return results[index];
}
const response = (page: Record<string, unknown> = {}) => ({ data: { flow: {
  nodes: [{ id: '2026-10-03T10:00' }, { id: '2026-10-01T10:00' }], offset: 0, count: 2, totalCount: 2, ...page,
} }, extensions: { complete: true } });

describe('entry query declarations', () => {
  it('infers entry pages from the schema and adds native pagination metadata', () => {
    const def = definition({ query: '{ flow: entries { nodes { id } } }', variables: undefined });
    const request = sourceRequest(def, { offset: 10, limit: 20 });
    expect(argumentsFor(request)).toMatchObject({ offset: 10, limit: 20 });
    expect(request.query).toContain('offset'); expect(request.query).toContain('count'); expect(request.query).toContain('totalCount');
    expect(def.result).toBeUndefined(); expect(effectiveSourceOrder(def)).toBe('CREATED_DESC');
  });

  it('composes the authored group, native focus, literal phrase, range, and probe before pagination', () => {
    const def = definition(), original = structuredClone(def.variables);
    const request = sourceRequest(def, { filter: { type: 'project', id: 'work' }, search: '  C++ [x].*  ', offset: 50, limit: 50,
      range: { start: '2026-10-01T10:30', end: '2026-10-02' }, additionalWhere: { ids: ['2026-10-01T10:00'] } });
    expect(argumentsFor(request)).toEqual({ where: { and: [predicate,
      { browse: { project: 'work', search: 'C++ [x].*', createdFrom: '2026-10-01T10:30', createdTo: '2026-10-02' } },
      { ids: ['2026-10-01T10:00'] }] }, offset: 50, limit: 50 });
    expect(def.variables).toEqual(original);
    expect(argumentsFor(sourceRequest(def, { filter: { type: 'action', id: 'task' }, offset: 0, limit: 20 })).where)
      .toEqual({ and: [predicate, { browse: { action: 'task' } }] });
    expect(argumentsFor(sourceRequest(def, { offset: 0, limit: 20 })).where).toEqual(predicate);
  });

  it('preserves inline nested predicates and variable defaults', () => {
    const def = definition({ query: `query($after: Date = "2026-10-01") {
      flow: entries(where: {or: [{createdFrom: $after}, {not: {ids: []}}]}) { nodes { id } }
    }`, variables: undefined });
    expect(argumentsFor(sourceRequest(def, { search: 'word', offset: 0, limit: 20 })).where)
      .toEqual({ and: [{ or: [{ createdFrom: '2026-10-01' }, { not: { ids: [] } }] }, { browse: { search: 'word' } }] });
  });

  it('does not change a shared predicate or pagination variable in another selected collection', () => {
    const def = definition({ query: `query($where: EntryWhere, $limit: Int!) {
      flow: entries(where: $where, limit: $limit) { nodes { id } }
      other: entries(where: $where, limit: $limit) { nodes { id } }
    }`, variables: { where: predicate, limit: 7 }, result: 'flow' });
    const request = sourceRequest(def, { search: 'phrase', offset: 10, limit: 20 });
    expect(argumentsFor(request)).toMatchObject({ offset: 10, limit: 20, where: { and: [predicate, { browse: { search: 'phrase' } }] } });
    expect(argumentsFor(request, 1)).toEqual({ where: predicate, limit: 7 });
  });

  it('derives app pagination without requiring authored pagination variable values', () => {
    const def = definition({ query: 'query($offset:Int!, $limit:Int!) { flow:entries(offset:$offset,limit:$limit){nodes{id}} }', variables: undefined });
    const request = sourceRequest(def, { offset: 50, limit: 25 });
    expect(argumentsFor(request)).toMatchObject({ offset: 50, limit: 25 });
    expect(request.query).not.toContain('$offset'); expect(request.query).not.toContain('$limit');
  });

  it('executes the adapted operation against the schema with collision-safe variables and original grouping', async () => {
    const def = definition({ query: 'query($_asideWhere:EntryWhere){flow:entries(where:$_asideWhere,orderBy:CREATED_ASC){nodes{id}}}',
      variables: { _asideWhere: predicate } });
    const request = sourceRequest(def, { offset: 0, limit: 20, search: 'literal [x].*' });
    let received: Record<string, unknown> | undefined;
    const result = await graphql({ schema: buildSchema(graphQLSDL()), source: request.query, variableValues: request.variables,
      rootValue: { entries: (args: Record<string, unknown>) => {
        received = args;
        return { nodes: [{ id: '2026-10-01T10:00' }], offset: 0, count: 1, totalCount: 1 };
      } } });
    expect(result.errors).toBeUndefined();
    expect(received).toMatchObject({ where: { and: [predicate, { browse: { search: 'literal [x].*' } }] }, orderBy: 'CREATED_ASC', offset: 0, limit: 20 });
    expect(parseSourcePage(def, { ...result, extensions: { complete: true } }, { offset: 0, limit: 20 }).ids)
      .toEqual(['2026-10-01T10:00']);
  });

  it.each([
    ['{ flow:entries(orderBy:CREATED_ASC){nodes{id}} }', {}, 'CREATED_ASC'],
    ['query($order:RecordOrder=CREATED_ASC){flow:entries(orderBy:$order){nodes{id}}}', {}, 'CREATED_ASC'],
    ['query($order:RecordOrder!){flow:entries(orderBy:$order){nodes{id}}}', { order: 'CREATED_DESC' }, 'CREATED_DESC'],
    ['{flow:entries{nodes{id}}}', {}, 'CREATED_DESC'],
  ] as const)('honors the query ordering: %s', (query, variables, order) => {
    const def = definition({ query, variables });
    expect(effectiveSourceOrder(def)).toBe(order);
    expect(effectiveSourceOrder(def, 'CREATED_ASC')).toBe('CREATED_ASC');
    expect(argumentsFor(sourceRequest(def, { offset: 0, limit: 20, order: 'CREATED_DESC' })).orderBy).toBe('CREATED_DESC');
  });

  it('supports aliases, nested singular parents, and nullable empty results', () => {
    const def = definition({ query: `{ context:project(id:"work") { timeline:entries(orderBy:CREATED_ASC) {
      items:nodes { key:id } skip:offset size:count total:totalCount
    } } }`, variables: undefined });
    const complete = { extensions: { complete: true } };
    expect(parseSourcePage(def, { ...complete, data: { context: { timeline: {
      items: [{ key: '2026-10-01T10:00' }, { key: '2026-10-03T10:00' }], skip: 0, size: 2, total: 2,
    } } } }, { offset: 0, limit: 20 }).ids).toEqual(['2026-10-01T10:00', '2026-10-03T10:00']);
    expect(parseSourcePage(def, { ...complete, data: { context: null } }, { offset: 0, limit: 20 }))
      .toEqual({ ids: [], offset: 0, count: 0, totalCount: 0 });
    expect(parseSourcePage(def, { ...complete, data: { context: { timeline: { items: [], skip: 0, size: 0, total: 0 } } } },
      { offset: 0, limit: 20 }).ids).toEqual([]);
  });

  it.each([
    '... @include(if:$show) { count:totalCount _count:offset } nodes{id}',
    '... @include(if:$show) { nodes:totalCount _nodes:offset }',
  ])('reserves aliases in conditional fragments when adding native page fields: %s', async selection => {
    const def = definition({ query: `query($show:Boolean!){flow:entries{${selection}}}`, variables: { show: true } });
    const request = sourceRequest(def, { offset: 0, limit: 1 });
    const result = await graphql({ schema: buildSchema(graphQLSDL()), source: request.query, variableValues: request.variables,
      rootValue: { entries: () => ({ nodes: [{ id: '2026-10-03T10:00' }], offset: 0, count: 1, totalCount: 2 }) } });
    expect(result.errors).toBeUndefined();
    expect(parseSourcePage(def, { ...result, extensions: { complete: true } }, { offset: 0, limit: 1 }))
      .toEqual({ ids: ['2026-10-03T10:00'], offset: 0, count: 1, totalCount: 2 });
  });

  it('requires a result response path only when several entry collections are eligible', () => {
    const query = '{ entries{nodes{id}} context:project(id:"work"){feed:entries{nodes{id}}} }';
    expect(() => definition({ query, variables: undefined })).toThrow('Several entry collections');
    const def = definition({ query, variables: undefined, result: 'context.feed' });
    const request = sourceRequest(def, { offset: 10, limit: 20 });
    expect(argumentsFor(request, 0)).toEqual({});
    expect(argumentsFor(request, 1)).toMatchObject({ offset: 10, limit: 20 });
  });

  it('supports selected named operations and fragments without inferring from runtime rows', () => {
    const def = definition({ operationName: 'Focus', query: `query Other { actions { nodes { id } } }
      query Focus { ...Root } fragment Root on Query { flow:entries { ...Page } }
      fragment Page on EntryPage { nodes { ...Identity } } fragment Identity on LinkTarget { id }`, variables: undefined });
    const request = sourceRequest(def, { offset: 0, limit: 20 });
    expect(parse(request.query).definitions.filter(node => node.kind === Kind.OPERATION_DEFINITION)).toHaveLength(1);
    expect(request.query).not.toContain('query Other');
    expect(parseSourcePage(def, response({ nodes: [], count: 0, totalCount: 0 }), { offset: 0, limit: 20 }).ids).toEqual([]);
  });

  it('rejects directives on fragment definitions instead of discarding their apparent condition', () => {
    expect(() => definition({ query: 'query { ...Root } fragment Root on Query @skip(if:true) { flow:entries{nodes{id}} }', variables: undefined }))
      .toThrow('Fragment definitions cannot have directives');
  });

  it.each([
    { query: 'mutation { selectInstance(input:{id:"work"}) { instance { id } } }', variables: undefined },
    { query: '{actions{nodes{id}}}', variables: undefined },
    { query: '{projects{nodes{entries{nodes{id}}}}}', variables: undefined },
    { query: '{flow:entries{nodes{id}}}', variables: undefined, result: 'missing' },
    { query: 'query($skip:Boolean!){flow:entries@skip(if:$skip){nodes{id}}}', variables: { skip: true } },
    { query: 'query($term:String!){flow:entries(where:{search:$term}){nodes{id}}}', variables: undefined },
    { variables: { where: 'not an EntryWhere' } },
    { variables: { unknown: true } },
    { kind: 'entry-flow' },
    { inputs: { where: 'where' } },
    { query: '{...Root} fragment Root on Query {flow:entries{nodes{id}}} fragment Root on Query {flow:entries{nodes{id}}}', variables: undefined },
  ])('rejects an unsupported or invalid declaration: %j', changes => {
    expect(() => definition(changes)).toThrow('Invalid entry query');
  });

  it('handles prototype-name variables without losing the composed predicate', () => {
    const def = definition({ query: 'query($__proto__:EntryWhere){flow:entries(where:$__proto__){nodes{id}}}',
      variables: JSON.parse('{"__proto__":{"ids":[]}}') });
    expect(argumentsFor(sourceRequest(def, { search: 'literal', offset: 0, limit: 20 })).where)
      .toEqual({ and: [{ ids: [] }, { browse: { search: 'literal' } }] });
  });
});

describe('entry query pages', () => {
  it('accepts a complete page and a verified exhausted result', () => {
    expect(parseSourcePage(definition(), response(), { offset: 0, limit: 20 }))
      .toEqual({ ids: ['2026-10-03T10:00', '2026-10-01T10:00'], offset: 0, count: 2, totalCount: 2 });
    expect(parseSourcePage(definition(), response({ nodes: [], offset: 2, count: 0 }), { offset: 2, limit: 20 }).ids).toEqual([]);
  });
  it('distinguishes incomplete reads and query errors from verified empty results', () => {
    expect(() => parseSourcePage(definition(), { ...response(), extensions: { complete: false } }, { offset: 0, limit: 20 })).toThrow(SourceIncompleteError);
    expect(() => parseSourcePage(definition(), { ...response(), errors: [{ message: 'Budget exceeded' }] }, { offset: 0, limit: 20 })).toThrow('Budget exceeded');
  });
  it.each([
    { nodes: [], count: 0 }, { offset: 1 }, { totalCount: -1 },
    { nodes: [{ id: '2026-10-01T10:00' }, { id: '2026-10-03T10:00' }] },
    { nodes: [{ id: '2026-10-01T10:00' }, { id: '2026-10-01T10:00' }] },
    { nodes: [{ id: 'not-an-entry' }, { id: '2026-10-01T10:00' }] },
  ])('rejects inconsistent or unordered page data: %j', page => {
    expect(() => parseSourcePage(definition(), response(page), { offset: 0, limit: 20 })).toThrow();
  });
  it('checks order across pages in the effective direction', () => {
    const def = definition();
    expect(() => parseSourcePage(def, response(), { offset: 0, limit: 20, previousId: '2026-10-03T10:00' })).toThrow('descending');
    const ascending = response({ nodes: [{ id: '2026-10-01T10:00' }, { id: '2026-10-03T10:00' }] });
    expect(parseSourcePage(def, ascending, { offset: 0, limit: 20, order: 'CREATED_ASC', previousId: '2026-09-30T10:00' }).ids)
      .toEqual(['2026-10-01T10:00', '2026-10-03T10:00']);
    expect(() => parseSourcePage(def, ascending, { offset: 0, limit: 20, order: 'CREATED_ASC', previousId: '2026-10-02T10:00' })).toThrow('ascending');
  });
});
