import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/source/bootstrap.js';
import { Store } from '../src/source/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { createArtifact } from '../src/mcp/tools/artifact.js';
import { handleUpdateAction, handleUpdateProject } from '../src/mcp/tools/update.js';
import { buildGraphQLSchema, executeGraphQL, type GraphQLExecutionOptions } from '../src/graphql/schema.js';
import { collectDocuments } from '../src/semantic/documents.js';
import { SemanticSearchService } from '../src/semantic/search.js';
import { prepareWebQuery } from '../src/web/query.js';

describe('unified saved-record GraphQL search', () => {
  let root: string, store: Store;
  let open: string, quiet: string, closed: string, scheduled: string, finished: string, orphan: string;
  let plan: string, unused: string, kickoff: string, progress: string;
  let semanticSearch: NonNullable<GraphQLExecutionOptions['semanticSearch']>;
  const matcher = { match: vi.fn(async (pattern: string, texts: string[][]) => {
    const regex = new RegExp(pattern, 'i');
    return texts.flatMap((fields, index) => fields.some(text => regex.test(text)) ? [index] : []);
  }) };
  const query = (document: string, variables?: Record<string, unknown>, options: GraphQLExecutionOptions = {}) =>
    executeGraphQL(store, 'query', { document, variables }, { matcher, semanticSearch, ...options });
  const data = (result: any) => { expect(result.errors).toBeUndefined(); return result.data; };
  const handles = (page: any) => page.hits.map((hit: any) => hit.handle);
  const savedCount = () => store.getEntries().length + store.getProjects().size + store.getActions().size + store.getArtifacts().size;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'));
    root = mkdtempSync('/private/tmp/aside-unified-search-');
    init(root, { name: 'Unified search fixture', description: 'Saved-record membership and ranking' });
    store = new Store(root);
    plan = createArtifact(store, { name: 'Plan', description: 'Cobalt launch plan', body: '# Cobalt launch\n\nReview the plan before shipping.' }, new Date(2026, 4, 30, 8)).id;
    unused = createArtifact(store, { name: 'Unused', description: 'Unused notes', body: 'Unrelated material.' }, new Date(2026, 5, 7, 8)).id;
    let captured = handleCapture(store, {
      content: `Cobalt kickoff #artifact/${plan}`, description: 'Cobalt kickoff',
      projects: [{ name: 'Open', description: 'Open launch project' }],
      actions: [{ name: 'Review', description: 'Review the launch plan', scheduled: '2026-06-12T10:00', deadline: '2026-06-13' }],
    }, new Date(2026, 5, 1, 10));
    open = captured.createdProjectIds[0]; scheduled = captured.createdActionIds[0]; kickoff = captured.entryId;
    captured = handleCapture(store, {
      content: 'Old activity', description: 'Quiet kickoff', projects: [{ name: 'Quiet', description: 'Quiet project' }],
      actions: [{ name: 'Quiet task', description: 'Unfinished quiet work', deadline: '2026-06-14' }],
    }, new Date(2026, 5, 2, 10));
    quiet = captured.createdProjectIds[0];
    captured = handleCapture(store, {
      content: 'Closed work', description: 'Closed project kickoff', projects: [{ name: 'Closed', description: 'Closed project' }],
      actions: [{ name: 'Cancelled task', description: 'Old task', scheduled: '2026-06-11', deadline: '2026-06-12' }],
    }, new Date(2026, 5, 3, 10));
    closed = captured.createdProjectIds[0];
    handleUpdateProject(store, { id: closed, ended: '2026-06-04T10:00' });
    handleUpdateAction(store, { id: captured.createdActionIds[0], resolution: 'cancelled' });
    handleUpdateProject(store, { id: open, related_projects: [{ project: quiet, description: 'Supports quiet work' }] });
    captured = handleCapture(store, {
      content: 'Delivered the launch', description: 'Finished work', projects: [open],
      actions: [{ name: 'Finished', description: 'Delivered task', deadline: '2026-06-11' }],
    }, new Date(2026, 5, 4, 10));
    finished = captured.createdActionIds[0];
    handleUpdateAction(store, { id: finished, resolution: 'done' });
    orphan = handleCapture(store, { content: 'Ungrouped', description: 'Standalone task',
      actions: [{ name: 'Orphan', description: 'No project' }] }, new Date(2026, 5, 5, 10)).createdActionIds[0];
    progress = handleCapture(store, { content: 'Recent cobalt progress', description: 'Progress update', projects: [open] }, new Date(2026, 5, 6, 10)).entryId;
    semanticSearch = vi.fn(async (source, input, options) => {
      const { allowedHandles, offset = 0 } = options as { allowedHandles?: readonly string[]; offset?: number };
      const docs = collectDocuments(source).filter(document => !allowedHandles || allowedHandles.includes(document.handle))
        .sort((a, b) => b.handle.localeCompare(a.handle));
      return { model: 'test-local-model', indexedChunks: collectDocuments(source).length,
        hits: docs.slice(offset, offset + (input.first ?? 20)).map(document => ({
          kind: document.kind, id: document.id, handle: document.handle, name: document.name,
          description: document.description, snippet: document.content.slice(0, 100), score: 0.75,
        })) };
    });
    matcher.match.mockClear();
    expect(store.getIssues()).toEqual([]);
  });
  afterEach(() => { store.close(); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it('replaces the old public semantic root with a discoverable one-of ranking contract', async () => {
    const schema = buildGraphQLSchema();
    const fields = schema.getQueryType()!.getFields();
    expect(fields.search).toBeDefined();
    expect(fields.semanticSearch).toBeUndefined();
    expect(fields.entries).toBeDefined(); expect(fields.projects).toBeDefined();
    expect(fields.actions).toBeDefined(); expect(fields.artifacts).toBeDefined();
    const ranking = schema.getType('SearchRanking') as any;
    expect(ranking.isOneOf).toBe(true);
    expect(Object.keys(ranking.getFields())).toEqual(['semantic', 'order']);
    expect(Object.keys((schema.getType('SearchWhere') as any).getFields())).toEqual(['entries', 'projects', 'actions', 'artifacts']);
    expect(schema.getType('SemanticSearchHit')).toBeUndefined();
    const discovered = data(await query(`{
      root:__type(name:"Query"){fields{name}}
      ranking:__type(name:"SearchRanking"){isOneOf inputFields{name}}
      oldHit:__type(name:"SemanticSearchHit"){name}
    }`));
    expect(discovered.root.fields.map((field: any) => field.name)).toContain('search');
    expect(discovered.root.fields.map((field: any) => field.name)).not.toContain('semanticSearch');
    expect(discovered.ranking).toEqual({isOneOf: true, inputFields: [{name: 'semantic'}, {name: 'order'}]});
    expect(discovered.oldHit).toBeNull();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('defaults to all saved kinds and creation descending without touching models', async () => {
    const result = data(await query(`{
      omitted: search(limit:100) {totalCount count offset model indexedChunks hits {handle kind score}}
      empty: search(where:{},rankBy:{order:CREATED_DESC},limit:100) {totalCount count offset model indexedChunks hits {handle kind score}}
    }`));
    expect(result.omitted).toEqual(result.empty);
    expect(result.omitted).toMatchObject({totalCount: savedCount(), count: savedCount(), offset: 0, model: null, indexedChunks: 0});
    expect(new Set(result.omitted.hits.map((hit: any) => hit.kind))).toEqual(new Set(['ENTRY', 'PROJECT', 'ACTION', 'ARTIFACT']));
    expect(result.omitted.hits.every((hit: any) => hit.score === null)).toBe(true);
    expect(semanticSearch).not.toHaveBeenCalled(); expect(matcher.match).not.toHaveBeenCalled();
  });

  it('unions only non-null requested groups and paginates once across their kinds', async () => {
    const result = data(await query(`{
      all: search(where:{entries:{},projects:{},artifacts:null},rankBy:{order:CREATED_ASC},limit:100) {totalCount hits {handle kind}}
      page: search(where:{entries:{},projects:{},artifacts:null},rankBy:{order:CREATED_ASC},offset:2,limit:3) {totalCount count offset hits {handle kind}}
      empty: search(where:{actions:{ids:[]}},rankBy:{order:CREATED_ASC}) {totalCount count hits {handle}}
      projects: search(where:{entries:null,projects:{}}) {totalCount hits {kind}}
    }`));
    expect(result.all.totalCount).toBe(store.getEntries().length + store.getProjects().size);
    expect(new Set(result.all.hits.map((hit: any) => hit.kind))).toEqual(new Set(['ENTRY', 'PROJECT']));
    expect(result.page).toMatchObject({totalCount: result.all.totalCount, count: 3, offset: 2});
    expect(result.page.hits).toEqual(result.all.hits.slice(2, 5));
    expect(result.empty).toEqual({totalCount: 0, count: 0, hits: []});
    expect(result.projects.totalCount).toBe(store.getProjects().size);
    expect(result.projects.hits.every((hit: any) => hit.kind === 'PROJECT')).toBe(true);
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it.each(['CREATED_ASC', 'CREATED_DESC', 'SCHEDULED_ASC', 'SCHEDULED_DESC', 'DEADLINE_ASC', 'DEADLINE_DESC'])('preserves typed action ordering for %s', async order => {
    const result = data(await query(`{
      expected: actions(orderBy:${order},limit:100) {nodes {handle}}
      actual: search(where:{actions:{}},rankBy:{order:${order}},limit:100) {hits {handle} totalCount}
    }`));
    expect(handles(result.actual)).toEqual(result.expected.nodes.map((node: any) => node.handle));
    expect(result.actual.totalCount).toBe(store.getActions().size);
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('puts non-actions and missing schedules last while ordering a mixed collection', async () => {
    const result = data(await query('{search(rankBy:{order:SCHEDULED_ASC},limit:100){hits{handle record{__typename}}}}')).search;
    expect(result.hits[0].handle).toContain('cancelled-task');
    expect(result.hits[1].handle).toBe(`#action/${scheduled}`);
    expect(new Set(result.hits.slice(2).map((hit: any) => hit.record.__typename))).toEqual(new Set(['Entry', 'Project', 'Action', 'Artifact']));
  });

  it.each(['entries', 'projects', 'actions', 'artifacts'] as const)('reuses rich %s filters for both field and semantic ranking', async group => {
    const cases = {
      entries: { type: 'Entry', expected: [kickoff, progress], where: {
        and: [{or: [{regex: 'cobalt'}, {regex: 'progress'}]}, {not: {regex: 'old'}}],
        projects: {some: {status: 'OPEN'}}, createdFrom: '2026-06-01', createdTo: '2026-06-06',
      } },
      projects: { type: 'Project', expected: [open, quiet], where: {
        and: [{status: 'OPEN'}, {or: [{regex: 'open'}, {regex: 'quiet'}]}], not: {ids: [closed]},
        actions: {some: {status: ['BACKLOG', 'SCHEDULED']}}, entries: {none: {createdFrom: '2026-06-07'}},
      } },
      actions: { type: 'Action', expected: [scheduled], where: {
        and: [{or: [{status: ['BACKLOG']}, {status: ['SCHEDULED']}]}, {not: {regex: 'quiet'}}],
        projects: {some: {status: 'OPEN', regex: 'open'}}, deadlineFrom: '2026-06-10', deadlineTo: '2026-06-15',
      } },
      artifacts: { type: 'Artifact', expected: [plan], where: {
        and: [{regex: 'plan'}, {not: {regex: 'unused'}}], projects: {some: {actions: {some: {status: ['SCHEDULED']}}}},
        createdFrom: '2026-05-01', createdTo: '2026-06-01',
      } },
    };
    const selected = cases[group];
    const result = data(await query(`query($where:${selected.type}Where!){
      expected:${group}(where:$where,limit:100,orderBy:CREATED_ASC){totalCount nodes{id handle}}
      actual:search(where:{${group}:$where},rankBy:{order:CREATED_ASC},limit:100){totalCount hits{id handle}}
      semantic:search(where:{${group}:$where},rankBy:{semantic:"Find relevant context"},limit:100){totalCount hits{id handle}}
    }`, {where: selected.where}));
    expect(result.expected.nodes.map((node: any) => node.id).sort()).toEqual([...selected.expected].sort());
    expect(result.actual).toEqual({totalCount: result.expected.totalCount, hits: result.expected.nodes});
    expect(result.semantic.totalCount).toBe(result.expected.totalCount);
    expect(handles(result.semantic).sort()).toEqual(result.expected.nodes.map((node: any) => node.handle).sort());
    expect(semanticSearch).toHaveBeenCalledOnce();
    expect((vi.mocked(semanticSearch).mock.calls[0][2] as any).allowedHandles.slice().sort()).toEqual(handles(result.actual).sort());
  });

  it('passes the eligible union, semantic query, global offset and cancellation signal to retrieval', async () => {
    const controller = new AbortController();
    const result = data(await query(`{search(where:{projects:{status:OPEN},entries:{ids:["${progress}"]}},
      rankBy:{semantic:"What did we decide?"},offset:1,limit:1){totalCount count offset model indexedChunks hits{handle score record{handle}}}}`, undefined, {signal: controller.signal})).search;
    const allowed = [`#project/${open}`, `#project/${quiet}`, `#entry/${progress}`];
    expect(result).toMatchObject({totalCount: 3, count: 1, offset: 1, model: 'test-local-model', indexedChunks: savedCount()});
    expect(result.hits).toEqual([{handle: [...allowed].sort((a, b) => b.localeCompare(a))[1], score: 0.75,
      record: {handle: [...allowed].sort((a, b) => b.localeCompare(a))[1]}}]);
    expect(semanticSearch).toHaveBeenCalledWith(store, {query: 'What did we decide?', first: 1}, {
      signal: expect.any(AbortSignal), allowedHandles: expect.arrayContaining(allowed), offset: 1,
    });
    expect((vi.mocked(semanticSearch).mock.calls[0][2] as any).allowedHandles).toHaveLength(3);
    expect(matcher.match).not.toHaveBeenCalled();
  });

  it('keeps totalCount as filter membership even when retrieval returns fewer hits', async () => {
    const original = semanticSearch;
    semanticSearch = vi.fn(async (...args) => { const result = await original(...args); return {...result, hits: result.hits.slice(0, 1)}; });
    const result = data(await query('{search(where:{projects:{status:OPEN}},rankBy:{semantic:"launch work"},limit:20){totalCount count offset hits{id}}}')).search;
    expect(result).toMatchObject({totalCount: 2, count: 1, offset: 0});
    expect(result.hits).toHaveLength(1);
    const exhausted = data(await query('{search(rankBy:{semantic:"anything"},offset:999,limit:10){totalCount count offset model indexedChunks hits{id}}}')).search;
    expect(exhausted).toEqual({totalCount: savedCount(), count: 0, offset: 999, model: null, indexedChunks: 0, hits: []});
    expect(semanticSearch).toHaveBeenCalledOnce();
  });

  it('answers direct counts-only semantic pages without ranking or model access', async () => {
    const document = `query {
      search(where:{projects:{status:OPEN}},rankBy:{semantic:"launch priorities"},offset:1,limit:1){totalCount count offset}
    }`;
    expect(data(await query(document)).search).toEqual({totalCount: 2, count: 1, offset: 1});
    expect(data(await executeGraphQL(store, 'query', {document}, {matcher})).search).toEqual({totalCount: 2, count: 1, offset: 1});
    expect(semanticSearch).not.toHaveBeenCalled(); expect(matcher.match).not.toHaveBeenCalled();
    expect((await query('{search(rankBy:{semantic:"   "}){totalCount count offset}}')).errors).toBeDefined();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('answers named and inline counts-only fragments without a semantic service', async () => {
    const document = `query {
      named:search(where:{projects:{status:OPEN}},rankBy:{semantic:"launch priorities"},offset:1,limit:1){...Counts}
      inline:search(where:{projects:{status:OPEN}},rankBy:{semantic:"launch priorities"},offset:1,limit:1){... on SearchPage{totalCount count offset}}
      nested:search(where:{projects:{status:OPEN}},rankBy:{semantic:"launch priorities"},offset:1,limit:1){...Nested}
    }
    fragment Counts on SearchPage{totalCount count offset}
    fragment Nested on SearchPage{... on SearchPage{...Counts}}`;
    const expected = {named: {totalCount: 2, count: 1, offset: 1}, inline: {totalCount: 2, count: 1, offset: 1}, nested: {totalCount: 2, count: 1, offset: 1}};
    expect(data(await query(document))).toEqual(expected);
    expect(data(await executeGraphQL(store, 'query', {document}, {matcher}))).toEqual(expected);
    expect(semanticSearch).not.toHaveBeenCalled(); expect(matcher.match).not.toHaveBeenCalled();
  });

  it.each([
    {selection: 'hits @skip(if:$skip){handle}', fragment: ''},
    {selection: 'hits @include(if:$include){handle}', fragment: ''},
    {selection: 'model @skip(if:$skip) indexedChunks @include(if:$include)', fragment: ''},
    {selection: '...Hidden @skip(if:$skip)', fragment: 'fragment Hidden on SearchPage{hits{handle}}'},
    {selection: '... on SearchPage @include(if:$include){hits{handle}}', fragment: ''},
  ])('honors directive-controlled ranking selections: $selection', async ({selection, fragment}) => {
    const document = `query($skip:Boolean!=true,$include:Boolean!=false){
      search(where:{projects:{status:OPEN}},rankBy:{semantic:"launch priorities"}){
        totalCount count @include(if:$include) offset @skip(if:$skip) ${selection}
      }
    } ${fragment}`;
    // Both defaults and explicitly coerced values leave only totalCount active.
    expect(data(await query(document)).search).toEqual({totalCount: 2});
    expect(data(await executeGraphQL(store, 'query', {document, variables: {skip: true, include: false}}, {matcher})).search).toEqual({totalCount: 2});
    expect(semanticSearch).not.toHaveBeenCalled();
    const enabled = data(await query(document, {skip: false, include: true})).search;
    expect(enabled).toMatchObject({totalCount: 2, count: 2, offset: 0});
    expect(semanticSearch).toHaveBeenCalledOnce();
    expect(matcher.match).not.toHaveBeenCalled();
  });

  it('does not let a skipped fragment suppress a later active spread of the same ranking fields', async () => {
    const result = data(await query(`{
      search(where:{projects:{status:OPEN}},rankBy:{semantic:"launch priorities"}){
        totalCount ...Hits @skip(if:true) ...Hits @include(if:true)
      }
    } fragment Hits on SearchPage{hits{handle}}`)).search;
    expect(result.totalCount).toBe(2); expect(result.hits).toHaveLength(2);
    expect(semanticSearch).toHaveBeenCalledOnce();
  });

  it('materializes semantic hits selected through fragments rather than mistaking them for counts-only pages', async () => {
    const result = data(await query(`query{search(where:{projects:{status:OPEN}},rankBy:{semantic:"launch priorities"}){totalCount ...Hits}}
      fragment Hits on SearchPage{hits{handle}}`)).search;
    expect(result.totalCount).toBe(2);
    expect(handles(result).sort()).toEqual([`#project/${open}`, `#project/${quiet}`].sort());
    expect(semanticSearch).toHaveBeenCalledOnce();
  });

  it('applies eligibility and global pagination through the real local vector service with an injected embedder', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(text => /cobalt|launch/i.test(text) ? [1, 0, 0.1] : [0, 1, 0.1]));
    const service = new SemanticSearchService({embedder: {model: 'deterministic-test-vectors', resolveGeneration: async () => ({model: 'deterministic-test-vectors', identity: 'deterministic-test-vectors', embed})}, indexRoot: join(root, '.search-index')});
    try {
      await service.reconcile(store);
      const options = {semanticSearch: service.search.bind(service)};
      const result = data(await query(`{
        full:search(where:{actions:{ids:["${scheduled}","${finished}"]},entries:{ids:["${kickoff}"]}},rankBy:{semantic:"cobalt launch"},limit:10){totalCount hits{handle score record{handle}}}
        page:search(where:{actions:{ids:["${scheduled}","${finished}"]},entries:{ids:["${kickoff}"]}},rankBy:{semantic:"cobalt launch"},offset:1,limit:1){totalCount count offset hits{handle score record{handle}}}
        narrow:search(where:{actions:{ids:["${finished}"]}},rankBy:{semantic:"cobalt launch"},limit:1){totalCount hits{handle}}
      }`, undefined, options));
      expect(result.full.totalCount).toBe(3);
      expect(handles(result.full).sort()).toEqual([`#action/${scheduled}`, `#action/${finished}`, `#entry/${kickoff}`].sort());
      expect(result.page).toMatchObject({totalCount: 3, count: 1, offset: 1});
      expect(result.page.hits).toEqual(result.full.hits.slice(1, 2));
      expect(result.full.hits.every((hit: any) => hit.record.handle === hit.handle && Number.isFinite(hit.score))).toBe(true);
      // The eligible record must survive even when excluded records score higher.
      expect(result.narrow).toEqual({totalCount: 1, hits: [{handle: `#action/${finished}`}]});
      expect(embed).toHaveBeenCalled();
      expect(semanticSearch).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });

  it('keeps field ordering available without a semantic service and surfaces model errors without fallback', async () => {
    const plain = await executeGraphQL(store, 'query', {document: '{search{count model hits{score}}}'}, {matcher});
    expect(data(plain).search.model).toBeNull();
    const missing = await executeGraphQL(store, 'query', {document: '{search(rankBy:{semantic:"ending without dialogue"}){hits{id}}}'}, {matcher});
    expect(JSON.stringify(missing.errors)).toMatch(/requires.*local embedding model/i);
    semanticSearch = vi.fn(async () => { throw new Error('Install the local embedding model.'); });
    const failed = await query('{search(rankBy:{semantic:"ending without dialogue"}){hits{id}}}');
    expect(JSON.stringify(failed.errors)).toContain('Install the local embedding model');
    expect(matcher.match).not.toHaveBeenCalled();
  });

  it('rejects snippets from a changed source snapshot', async () => {
    const original = semanticSearch;
    semanticSearch = async (...args) => {
      const result = await original(...args);
      handleCapture(store, {content: 'Newer decision', description: 'Changed while retrieving'}, new Date(2026, 5, 8, 10));
      return result;
    };
    const result = await query('{search(rankBy:{semantic:"launch"}){hits{snippet record{handle}}}}');
    expect(result.data).toBeNull();
    expect(JSON.stringify(result.errors)).toContain('same revision');
  });

  it.each(['{}', '{semantic:null}', '{order:null}', '{semantic:"launch",order:CREATED_DESC}'])('rejects invalid one-of ranking %s before invoking a model', async rank => {
    const result = await query(`{search(rankBy:${rank}){hits{id}}}`);
    expect(result.errors).toBeDefined();
    expect(semanticSearch).not.toHaveBeenCalled(); expect(matcher.match).not.toHaveBeenCalled();
  });

  it('enforces one-of validation on variable values too', async () => {
    for (const rank of [{}, {semantic: null}, {order: null}, {semantic: 'launch', order: 'CREATED_DESC'}]) {
      expect((await query('query($rank:SearchRanking!){search(rankBy:$rank){hits{id}}}', {rank})).errors).toBeDefined();
    }
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it.each(['offset:-1', 'limit:0', 'limit:101'])('rejects invalid pagination %s before model work', async args => {
    expect((await query(`{search(rankBy:{semantic:"launch"},${args}){hits{id}}}`)).errors).toBeDefined();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('excludes projected occurrences while retaining them in typed action queries', async () => {
    const template = handleCapture(store, {content: 'Routine context', description: 'Daily routine', projects: [open],
      actions: [{name: 'Daily review', description: 'Daily launch review', recurrence: [{dtstart: '2026-06-11', rrule: 'FREQ=DAILY'}]}],
    }, new Date(2026, 5, 9, 10)).createdActionIds[0];
    const result = data(await query(`{
      projected:actions(where:{occurrence:{projected:true}},limit:100){totalCount nodes{id filePath}}
      searchProjected:search(where:{actions:{occurrence:{projected:true}}},rankBy:{semantic:"daily review"}){totalCount count hits{id}}
      saved:search(where:{actions:{}},limit:100){totalCount hits{id record{... on Action{occurrence{projected} recurrence{dtstart}}}}}
    }`));
    expect(result.projected.totalCount).toBeGreaterThan(0);
    expect(result.projected.nodes.every((node: any) => node.filePath === null)).toBe(true);
    expect(result.searchProjected).toEqual({totalCount: 0, count: 0, hits: []});
    expect(result.saved.totalCount).toBe(store.getActions().size);
    expect(result.saved.hits.find((hit: any) => hit.id === template).record.recurrence).toEqual([{dtstart: '2026-06-11'}]);
    expect(result.saved.hits.every((hit: any) => !hit.record.occurrence?.projected)).toBe(true);
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('admits bounded webpage search with record data and rejects privileged runtime selections', () => {
    const permitted = prepareWebQuery({query: `query($limit:Int!){search(where:{entries:{regex:"cobalt"},projects:{status:OPEN}},
      rankBy:{semantic:"launch context"},offset:1,limit:$limit){totalCount count offset model indexedChunks hits{kind id handle snippet score
      record{handle filePath ... on Entry{entryText:content projects{nodes{id name}}} ... on Project{name body} ... on Action{name scheduled} ... on Artifact{name artifactContent:content{... on MarkdownContent{text}}}}}}}`, variables: {limit: 20}});
    expect(permitted, JSON.stringify(permitted)).toHaveProperty('args');
    for (const limit of [0, 101]) expect(prepareWebQuery({query: `query($limit:Int!){search(limit:$limit){hits{id}}}`, variables: {limit}})).toHaveProperty('result.errors');
    for (const selection of ['... on Project{automations{totalCount}}', '... on Project{automationLog{totalCount}}', '... on Action{delegation{state}}']) {
      const rejected = prepareWebQuery({query: `{search{hits{record{${selection}}}}}`});
      expect(rejected).toHaveProperty('result.errors');
      expect(JSON.stringify(rejected)).toMatch(/unavailable|Cannot query field/);
    }
    expect(prepareWebQuery({query: '{semanticSearch(query:"launch"){hits{id}}}'})).toHaveProperty('result.errors');
    expect(semanticSearch).not.toHaveBeenCalled();
  });
});
