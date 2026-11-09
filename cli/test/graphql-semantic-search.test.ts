import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/source/bootstrap.js';
import { executeGraphQL, buildGraphQLSchema, type GraphQLExecutionOptions } from '../src/graphql/schema.js';
import { Store } from '../src/source/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateEntry } from '../src/mcp/tools/update.js';
import { prepareWebQuery } from '../src/web/query.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { SemanticSearchService } from '../src/semantic/search.js';

describe('explicit regex and semantic GraphQL retrieval', () => {
  let root: string;
  let store: Store;
  let entry: string;
  const matcher = {match: vi.fn(async (pattern: string, texts: string[][]) =>
    texts.flatMap((fields, index) => fields.some(text => new RegExp(pattern, 'i').test(text)) ? [index] : []))};
  let semanticSearch: NonNullable<GraphQLExecutionOptions['semanticSearch']>;
  const query = (document: string, variables?: Record<string, unknown>) =>
    executeGraphQL(store, 'query', {document, variables}, {matcher, semanticSearch});

  beforeEach(() => {
    root = mkdtempSync('/tmp/aside-semantic-api-');
    init(root, {name: 'Search fixture', description: 'Search mode contracts'});
    store = new Store(root);
    handleCapture(store, {content: 'We agreed to finish the sketch in silence.', description: 'Silent ending'}, new Date(2026, 9, 20, 10));
    entry = store.getEntries()[0].meta.created;
    semanticSearch = vi.fn(async () => ({model: 'test-embedding', indexedChunks: 1,
      hits: [{kind: 'entry' as const, id: entry, handle: `#entry/${entry}`, name: 'Silent ending',
        description: 'Silent ending', snippet: 'finish the sketch in silence', score: 1 / 61}]}));
    matcher.match.mockClear();
  });
  afterEach(() => { store.close(); vi.restoreAllMocks(); rmSync(root, {recursive: true, force: true}); });

  it('keeps regex explicit and preserves the legacy alias without invoking embeddings', async () => {
    const result = await query(`{
      explicit: entries(where: {regex: "sketch.*silence"}) {totalCount nodes {id}}
      legacy: entries(where: {search: "sketch.*silence"}) {totalCount nodes {id}}
      mismatch: entries(where: {regex: "dialogue"}) {totalCount}
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({explicit: {totalCount: 1, nodes: [{id: entry}]},
      legacy: {totalCount: 1, nodes: [{id: entry}]}, mismatch: {totalCount: 0}});
    expect(semanticSearch).not.toHaveBeenCalled();
    expect(matcher.match).toHaveBeenCalled();
  });

  it('retains regex inside boolean and relationship filters and rejects ambiguous aliases', async () => {
    const result = await query('{entries(where: {and: [{regex:"SILENT"}, {not:{regex:"dialogue"}}]}) {totalCount}}');
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({entries: {totalCount: 1}});
    const rejected = await query('{entries(where: {regex:"silent",search:"silence"}) {totalCount}}');
    expect(JSON.stringify(rejected.errors)).toContain('Use either regex');
  });

  it('passes natural language and structural constraints only to semantic retrieval and exposes source records', async () => {
    const text = 'What did we decide about ending without dialogue?';
    const result = await query(`query($query:String!){search(rankBy:{semantic:$query},limit:5,where:{entries:{createdFrom:"2026-10-01",createdTo:"2026-10-28"}}) {
      model indexedChunks hits {kind id handle snippet score record {__typename handle filePath ... on Entry {content}}}
    }}`, {query: text});
    expect(result.errors).toBeUndefined();
    expect(semanticSearch).toHaveBeenCalledWith(store, {query: text, first: 5}, {signal: expect.any(AbortSignal), allowedHandles: [`#entry/${entry}`], offset: 0});
    expect(matcher.match).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({search: {model: 'test-embedding', indexedChunks: 1,
      hits: [{kind: 'ENTRY', id: entry, handle: `#entry/${entry}`, record: {__typename: 'Entry', content: 'We agreed to finish the sketch in silence.'}}]}});
  });

  it('reports semantic unavailability without running a regex fallback', async () => {
    const result = await executeGraphQL(store, 'query', {document: '{search(rankBy:{semantic:"dialogue"}) {hits {id}}}'}, {matcher});
    expect(JSON.stringify(result.errors)).toContain('Semantic ranking requires');
    expect(matcher.match).not.toHaveBeenCalled();
  });

  it('propagates model setup failures without returning lexical-only results', async () => {
    semanticSearch = vi.fn(async () => { throw new Error('Install the local embedding model.'); });
    const result = await query('{search(rankBy:{semantic:"dialogue"}) {hits {id}}}');
    expect(JSON.stringify(result.errors)).toContain('Install the local embedding model');
    expect(matcher.match).not.toHaveBeenCalled();
  });

  it('rejects results when source changes while awaiting retrieval instead of mixing snippets with an older snapshot', async () => {
    const original = semanticSearch;
    semanticSearch = async (...args) => {
      const result = await original(...args);
      handleCapture(store, {content: 'A newer decision.', description: 'Changed while retrieving'}, new Date(2026, 9, 21, 10));
      return result;
    };
    const result = await query('{search(rankBy:{semantic:"ending"}) {hits {snippet record {... on Entry {content}}}}}');
    expect(JSON.stringify(result.errors)).toContain('same revision');
    expect(result.data).toBeNull();
  });

  it('allows a no-op rebuild during retrieval without discarding an unchanged source snapshot', async () => {
    const original = semanticSearch;
    const revision = store.getRevision();
    semanticSearch = async (...args) => {
      const result = await original(...args);
      store.rebuild();
      return result;
    };
    const result = await query('{search(rankBy:{semantic:"ending"}) {hits {snippet record {... on Entry {content}}}}}');
    expect(store.getRevision()).toBeGreaterThan(revision);
    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({search: {hits: [{snippet: 'finish the sketch in silence', record: {content: 'We agreed to finish the sketch in silence.'}}]}});
  });

  it.each(['body', 'description', 'instructions'])('still rejects an actual %s edit during retrieval', async field => {
    const original = semanticSearch;
    semanticSearch = async (...args) => {
      const result = await original(...args);
      if (field === 'body') handleUpdateEntry(store, {id: entry, content: 'The ending now includes dialogue.'});
      else if (field === 'description') store.setIndexEntry('notes', entry, 'An amended decision');
      else {
        const file = join(root, 'aside.md');
        writeFileSync(file, `${readFileSync(file, 'utf8')}\nNew instance instructions.\n`);
        store.rebuild();
      }
      return result;
    };
    const result = await query('{search(rankBy:{semantic:"ending"}) {hits {snippet record {... on Entry {content}}}}}');
    expect(result.data).toBeNull();
    expect(JSON.stringify(result.errors)).toContain('same revision');
  });

  it('makes the two query languages discoverable and keeps discovery free of inference', async () => {
    const schema = buildGraphQLSchema();
    const fields = (schema.getType('EntryWhere') as any).getFields();
    expect(fields.regex.description).toContain('ECMAScript regex');
    expect(fields.search.deprecationReason).toContain('rankBy.semantic');
    expect(schema.getQueryType()!.getFields()).not.toHaveProperty('semanticSearch');
    expect(schema.getQueryType()!.getFields().search.description).toContain('never changes filter membership');
    expect((await query('{__type(name:"SearchHit") {name}}')).errors).toBeUndefined();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('allows bounded semantic queries through webpage policy and rejects privileged source fields', () => {
    expect(prepareWebQuery({query: '{search(rankBy:{semantic:"silent ending"},limit:20) {model indexedChunks hits {kind id snippet record {handle ... on Entry {content}}}}}'})).toHaveProperty('args');
    for (const limit of [0, 101]) expect(prepareWebQuery({query: `{search(rankBy:{semantic:"ending"},limit:${limit}) {hits {id}}}`})).toHaveProperty('result.errors');
    expect(JSON.stringify(prepareWebQuery({query: '{search(rankBy:{semantic:"ending"}) {hits {record {... on Project {automations {totalCount}}}}}}'}))).toContain('unavailable');
  });

  it('wires daemon webpage retrieval and waits for native search shutdown before closing the host', async () => {
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    vi.spyOn(SemanticSearchService.prototype, 'search').mockImplementation(semanticSearch);
    vi.spyOn(SemanticSearchService.prototype, 'reconcile').mockImplementation(async loaded => ({
      sourceVersion: loaded.getSourceVersion(), model: 'fixture', indexedChunks: loaded.getEntries().length,
    }));
    let release!: () => void;
    const shutdown = new Promise<void>(resolve => { release = resolve; });
    const close = vi.spyOn(SemanticSearchService.prototype, 'close').mockReturnValue(shutdown);
    const host = new InstanceHost(new CalClient(null));
    try {
      const result = await host.webQuery(root, {document: '{search(rankBy:{semantic:"ending"}) {hits {id}}}'}, new AbortController().signal);
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({search: {hits: [{id: entry}]}});
      let finished = false;
      const closing = host.close().then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(close).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      release();
      await closing;
      expect(finished).toBe(true);
    } finally { release(); await host.close(); }
  });
});
