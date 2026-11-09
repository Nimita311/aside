import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, VectorQuery } from '@lancedb/lancedb';
import { Store } from '../src/source/store.js';
import { SemanticIndexNotCurrentError, SemanticSearchService, closeSemanticCacheHandles, semanticIndexGenerationKey, withSemanticCacheAccess } from '../src/semantic/search.js';
import { SemanticGenerationUnavailableError, type SemanticEmbedder } from '../src/semantic/embedding.js';
import {CHUNKER_VERSION, chunkDocument, collectDocuments, hashText} from '../src/semantic/documents.js';

const fixtures: {home: string; store: Store; service: SemanticSearchService}[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const {home, store, service} of fixtures.splice(0)) {
    await service.close(); store.close(); rmSync(home, {recursive: true, force: true});
  }
});

function fixture() {
  const home = mkdtempSync('/tmp/aside-model-identity-'), data = join(home, 'data'), indexRoot = join(home, 'index');
  mkdirSync(join(data, 'projects', '2026'), {recursive: true});
  writeFileSync(join(data, 'aside.md'), '---\nid: model-identity\n---\n');
  writeFileSync(join(data, 'projects', '2026', 'index.yaml'), '- id: fruit\n  description: Fruit\n- id: space\n  description: Space\n');
  for (const id of ['fruit', 'space']) writeFileSync(join(data, 'projects', '2026', `${id}.md`), `---\nname: ${id}\ncreated: 2026-10-28\n---\n${id}`);
  const state = {weights: 'old', changeDuringDocument: false, changeDuringQuery: false, unavailable: false};
  const documents: string[] = [], queries: string[] = [];
  const vector = (text: string, weights: string) => /fruit/i.test(text)
    ? weights === 'old' ? [1, 0] : [0, 1]
    : weights === 'old' ? [0, 1] : [1, 0];
  const resolveGeneration = vi.fn(async () => {
    const weights = state.weights;
    const available = () => {
      if (state.unavailable) throw new SemanticGenerationUnavailableError('mutable-local-model', 'Pinned generation unavailable');
    };
    return Object.freeze({
      model: 'mutable-local-model', identity: weights,
      embed: async (texts: string[]) => {
        available(); documents.push(weights);
        if (state.changeDuringDocument) {state.changeDuringDocument = false; state.weights = 'new';}
        return texts.map(text => vector(text, weights));
      },
      embedQuery: async (query: string) => {
        available(); queries.push(weights);
        if (state.changeDuringQuery) {state.changeDuringQuery = false; state.weights = 'new';}
        return vector(query, weights);
      },
    });
  });
  const embedder: SemanticEmbedder = {model: 'mutable-local-model', resolveGeneration};
  const store = new Store(data), service = new SemanticSearchService({embedder, indexRoot, batchSize: 1});
  fixtures.push({home, store, service});
  return {state, store, service, indexRoot, documents, queries, resolveGeneration};
}

const fruitHit = {handle: '#project/fruit', score: 1};

describe('lifecycle-owned pinned model generations', () => {
  it('rebuilds legacy alias vectors even when their certificate claims the current digest', async () => {
    const f = fixture(), parent = join(f.indexRoot, hashText(f.store.getDataDir()));
    const legacy = join(parent, hashText(`old\n${CHUNKER_VERSION}`));
    const current = join(parent, semanticIndexGenerationKey('old'));
    mkdirSync(legacy, {recursive: true});
    const connection = await connect(legacy);
    let version: number;
    const rows = collectDocuments(f.store).flatMap(chunkDocument).map(chunk => ({...chunk,
      // The legacy alias changed to different weights during inference and
      // reverted before its identity checks, leaving a misleading certificate.
      vector: /fruit/i.test(chunk.text) ? [0, 1] : [1, 0],
    }));
    try {
      const table = await connection.createTable('chunks', rows);
      try {version = await table.version();} finally {table.close();}
    } finally {connection.close();}
    writeFileSync(join(legacy, 'live.version'), `${version!}\n`);
    writeFileSync(join(legacy, 'snapshot.json'), JSON.stringify({format: 1,
      sourceVersion: f.store.getSourceVersion(), identity: 'old', version: version!, indexedChunks: rows.length,
    }));
    await f.service.reconcile(f.store);
    expect(f.documents).toEqual(['old', 'old']);
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it('keeps every document batch and query on one generation when the configured tag changes during indexing', async () => {
    const f = fixture(); f.state.changeDuringDocument = true;
    await f.service.reconcile(f.store);
    expect(f.documents).toEqual(['old', 'old']);
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect(f.queries).toEqual(['old']);
    expect(f.resolveGeneration).toHaveBeenCalledOnce();
    await f.service.reconcile(f.store);
    expect(f.documents).toEqual(['old', 'old', 'new', 'new']);
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect(f.queries).toEqual(['old', 'new']);
  });

  it('keeps query weights pinned until lifecycle reconciliation publishes the replacement', async () => {
    const f = fixture(); await f.service.reconcile(f.store);
    f.state.changeDuringQuery = true;
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect(f.queries).toEqual(['old', 'old']);
    expect(f.resolveGeneration).toHaveBeenCalledOnce();
    await f.service.reconcile(f.store);
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect(f.queries).toEqual(['old', 'old', 'new']);
    expect(f.resolveGeneration).toHaveBeenCalledTimes(2);
  });

  it('completes a pinned query when a tag changes while native ranking is in flight', async () => {
    const f = fixture(); await f.service.reconcile(f.store);
    const original = VectorQuery.prototype.toArray;
    vi.spyOn(VectorQuery.prototype, 'toArray').mockImplementation(async function(this: VectorQuery, ...args) {
      const rows = await original.apply(this, args); f.state.weights = 'new'; return rows;
    });
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect(f.queries).toEqual(['old']);
    expect(f.resolveGeneration).toHaveBeenCalledOnce();
  });

  it('never mixes generations even when a tag changes during embedding and reverts during ranking', async () => {
    const f = fixture(); await f.service.reconcile(f.store); f.state.changeDuringQuery = true;
    const original = VectorQuery.prototype.toArray;
    vi.spyOn(VectorQuery.prototype, 'toArray').mockImplementation(async function(this: VectorQuery, ...args) {
      f.state.weights = 'old'; return original.apply(this, args);
    });
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect(f.queries).toEqual(['old']);
    expect(f.resolveGeneration).toHaveBeenCalledOnce();
  });

  it('fails explicitly if the pinned generation is unavailable without rediscovering or falling back to the tag', async () => {
    const f = fixture(); await f.service.reconcile(f.store); f.state.weights = 'new'; f.state.unavailable = true;
    await expect(f.service.search(f.store, {query: 'fruit'})).rejects.toBeInstanceOf(SemanticGenerationUnavailableError);
    expect(f.resolveGeneration).toHaveBeenCalledOnce(); expect(f.queries).toEqual([]);
    f.state.unavailable = false; await f.service.reconcile(f.store);
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect(f.queries).toEqual(['new']);
  });

  it('requires lifecycle restoration after native handles and their generation binding are evicted', async () => {
    const f = fixture(); await f.service.reconcile(f.store);
    await withSemanticCacheAccess(async () => closeSemanticCacheHandles(f.indexRoot));
    await expect(f.service.search(f.store, {query: 'fruit'})).rejects.toBeInstanceOf(SemanticIndexNotCurrentError);
    expect(f.resolveGeneration).toHaveBeenCalledOnce(); expect(f.queries).toEqual([]);
    await f.service.reconcile(f.store);
    expect((await f.service.search(f.store, {query: 'fruit', first: 1})).hits[0]).toMatchObject(fruitHit);
    expect(f.documents).toEqual(['old', 'old']);
  });
});
