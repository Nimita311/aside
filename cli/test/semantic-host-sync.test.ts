import {afterEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {connect} from '@lancedb/lancedb';
import {InstanceHost} from '../src/daemon/host.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession} from '../src/mcp/instance-session.js';
import {SemanticSearchService, semanticIndexGenerationKey, withSemanticCacheAccess} from '../src/semantic/search.js';
import {SemanticGenerationUnavailableError, SemanticSetupError, type SemanticEmbedder, type SemanticEmbeddingGeneration} from '../src/semantic/embedding.js';
import {hashText} from '../src/semantic/documents.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks();});

async function until(check: () => Promise<boolean> | boolean, message: string) {
  const deadline = Date.now() + 3_000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error(message);
}

function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-semantic-host-'));
  const root = join(home, 'data'), indexRoot = join(home, 'indexes');
  mkdirSync(join(root, 'projects', '2026'), {recursive: true});
  writeFileSync(join(root, 'aside.md'), '---\nid: host-sync\nname: Host sync\n---\n');
  writeFileSync(join(root, 'projects', '2026', 'index.yaml'), '- id: item\n  description: Item\n');
  const file = join(root, 'projects', '2026', 'item.md');
  const write = (body: string) => writeFileSync(file, `---\nname: Item\ncreated: 2026-10-28\n---\n\n${body}\n`);
  write('Original source');
  const state = {available: true, weights: 'host-sync-weights'};
  const identity = vi.fn(async () => {
    if (!state.available) throw new SemanticSetupError('Local model unavailable', {reason: 'OLLAMA_UNREACHABLE', recovery: 'Restore the local model service.', model: 'host-sync'});
    return state.weights;
  });
  const embed = vi.fn<SemanticEmbeddingGeneration['embed']>(async texts => texts.map(() => [1, 0.5, 0.25]));
  const embedQuery = vi.fn<NonNullable<SemanticEmbeddingGeneration['embedQuery']>>(async () => [1, 0.5, 0.25]);
  const queryGenerations: string[] = [];
  const embedder: SemanticEmbedder = {model: 'host-sync', resolveGeneration: async () => {
    const generation = await identity();
    return {model: 'host-sync', identity: generation, embed, embedQuery: (query, options) => {
      queryGenerations.push(generation); return embedQuery(query, options);
    }};
  }};
  const hosts: InstanceHost[] = [];
  function host(options: {service?: SemanticSearchService; preload?: boolean; reconciliationIntervalMs?: number} = {}) {
    const service = options.service ?? new SemanticSearchService({embedder, indexRoot});
    const instance = new InstanceHost(new CalClient(null)); hosts.push(instance);
    instance.configureSources({debounceMs: 0, reconciliationIntervalMs: 60_000});
    const loaded = options.preload ? instance.load(root) : undefined;
    instance.configureSemantic({service: () => service, reconciliation: {
      debounceMs: 5, retryMinMs: 20, retryMaxMs: 50, reconciliationIntervalMs: options.reconciliationIntervalMs ?? 60_000,
    }});
    return {host: instance, service, loaded: loaded ?? instance.load(root)};
  }
  const location = join(indexRoot, hashText(root), semanticIndexGenerationKey('host-sync-weights'));
  function rows(): Promise<Array<{text: string; handle: string}> | undefined> {
    return withSemanticCacheAccess(async () => {
      if (!existsSync(location)) return;
      const connection = await connect(location);
      try {
        if (!(await connection.tableNames()).includes('chunks')) return;
        const table = await connection.openTable('chunks');
        try { return (await table.query().select(['text', 'handle']).toArray()).map(row => ({text: row.text, handle: row.handle})); }
        finally {table.close();}
      } finally {connection.close();}
    });
  }
  const indexed = (text: string) => until(async () => {
    const current = await rows();
    return !!current?.some(row => row.text.includes(text));
  }, `Semantic index did not catch up to ${JSON.stringify(text)}.`);
  const registry = new InstanceRegistry([root]); registry.activate(root);
  const session = new InstanceSession(registry, {knownInstances: async () => [root], issues: async () => []}, [], false, root);
  cleanups.push(async () => {await Promise.all(hosts.map(instance => instance.close())); rmSync(home, {recursive: true, force: true});});
  return {home, root, indexRoot, file, write, state, identity, embed, embedQuery, queryGenerations, embedder, host, rows, indexed, session};
}

describe('registered instance semantic index maintenance', () => {
  it('indexes an already loaded instance and GraphQL writes without source notifications or a query', async () => {
    const f = fixture();
    // Isolate the execution hook from Store events and filesystem notifications.
    vi.spyOn((await import('../src/source/store.js')).Store.prototype, 'onChange').mockImplementation(() => () => {});
    const {host, loaded} = f.host({preload: true});
    loaded.store.close();
    await f.indexed('Original source');
    expect(f.embedQuery).not.toHaveBeenCalled();
    const result = await host.graphql(f.session, 'mutation', {document: 'mutation{capture(input:{content:"Saved through GraphQL",description:"New entry"}){entry{id}}}'});
    expect(result.errors).toBeUndefined();
    await f.indexed('Saved through GraphQL');
    expect(f.embedQuery).not.toHaveBeenCalled();
  });

  it('updates direct file edits and clears an empty corpus while the model is unavailable', async () => {
    const f = fixture(); f.host();
    await f.indexed('Original source');
    f.write('Changed directly on disk');
    await f.indexed('Changed directly on disk');
    expect((await f.rows())!.every(row => !row.text.includes('Original source'))).toBe(true);
    f.state.available = false;
    const documents = f.embed.mock.calls.length;
    unlinkSync(f.file);
    writeFileSync(join(f.root, 'projects', '2026', 'index.yaml'), '[]\n');
    await until(async () => await f.rows() === undefined, 'Deleting every source record left a persisted model generation.');
    expect(f.embed.mock.calls.length).toBe(documents);
    expect(f.embedQuery).not.toHaveBeenCalled();
  });

  it('rejects a dirty query during model failure and recovers through background retries', async () => {
    const f = fixture(); const {host, loaded} = f.host();
    await f.indexed('Original source');
    f.state.available = false;
    f.write('Source updated during outage');
    await until(() => loaded.store.getProject('item')?.body.includes('Source updated during outage') ?? false,
      'Source lifecycle did not observe the direct edit.');
    const unavailable = await host.graphql(f.session, 'query', {document: '{search(rankBy:{semantic:"Updated source"}){hits{handle snippet}}}'});
    expect(unavailable.errors).toEqual([expect.objectContaining({extensions: expect.objectContaining({reason: 'OLLAMA_UNREACHABLE'})})]);
    expect(f.embedQuery).not.toHaveBeenCalled();
    f.state.available = true;
    await f.indexed('Source updated during outage');
    expect((await f.rows())!.every(row => !row.text.includes('Original source'))).toBe(true);
    expect(f.embedQuery).not.toHaveBeenCalled();
  });

  it('refreshes a persisted index after edits made while the host was stopped', async () => {
    const f = fixture(); const first = f.host();
    await f.indexed('Original source');
    await first.host.close();
    f.write('Edited during downtime');
    f.host();
    await f.indexed('Edited during downtime');
    expect((await f.rows())!.every(row => !row.text.includes('Original source'))).toBe(true);
    expect(f.embedQuery).not.toHaveBeenCalled();
  });

  it('keeps queries on the loaded instance snapshot until its lifecycle observes a missed disk edit', async () => {
    const f = fixture(); const {host, loaded} = f.host();
    await f.indexed('Original source');
    loaded.store.close();
    f.write('Previously missed edit');
    const document = '{search(rankBy:{semantic:"Current source"}){hits{snippet}}}';
    const rebuild = vi.spyOn(loaded.store, 'rebuild');
    const loadedSnapshot = await host.graphql(f.session, 'query', {document});
    expect(loadedSnapshot.errors).toBeUndefined();
    expect((loadedSnapshot.data!.search as any).hits).toEqual([expect.objectContaining({snippet: expect.stringContaining('Original source')})]);
    expect(rebuild).not.toHaveBeenCalled();
    // Explicit source refresh belongs to the instance, and updates every query
    // surface before its index worker catches up with the loaded hash.
    await host.data(f.root, true);
    await f.indexed('Previously missed edit');
    rebuild.mockClear();
    const current = await host.graphql(f.session, 'query', {document});
    expect(current.errors).toBeUndefined();
    expect((current.data!.search as any).hits).toEqual([expect.objectContaining({snippet: expect.stringContaining('Previously missed edit')})]);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('stops maintaining an unloaded instance', async () => {
    const f = fixture(); const {host} = f.host();
    await f.indexed('Original source');
    host.unloadKey(f.root);
    const calls = f.embed.mock.calls.length;
    f.write('Edit after unload');
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(f.embed.mock.calls.length).toBe(calls);
    expect((await f.rows())!.some(row => row.text.includes('Original source'))).toBe(true);
    expect((await f.rows())!.some(row => row.text.includes('Edit after unload'))).toBe(false);
  });

  it('queues lifecycle model recovery when a pinned query generation disappears', async () => {
    const f = fixture(); const {host} = f.host();
    await f.indexed('Original source');
    const document = '{search(rankBy:{semantic:"Current source"}){hits{handle}}}';
    expect((await host.graphql(f.session, 'query', {document})).errors).toBeUndefined();
    const documents = f.embed.mock.calls.length;
    f.state.weights = 'replacement-weights';
    f.embedQuery.mockRejectedValueOnce(new SemanticGenerationUnavailableError('host-sync', 'Pinned generation disappeared'));
    const failed = await host.graphql(f.session, 'query', {document});
    expect(failed.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Pinned generation disappeared')})]);
    await until(() => f.embed.mock.calls.length > documents, 'Lifecycle did not build the replacement model generation.');
    expect((await host.graphql(f.session, 'query', {document})).errors).toBeUndefined();
    expect(f.queryGenerations.at(-1)).toBe('replacement-weights');
  });

  it('discovers and indexes model changes through the lifecycle without a search', async () => {
    const f = fixture(); const {host} = f.host({reconciliationIntervalMs: 30});
    await f.indexed('Original source');
    const document = '{search(rankBy:{semantic:"Current source"}){hits{handle}}}';
    expect((await host.graphql(f.session, 'query', {document})).errors).toBeUndefined();
    f.embed.mockClear(); f.embedQuery.mockClear();
    f.state.weights = 'replacement-weights';
    await until(() => f.embed.mock.calls.length > 0, 'Lifecycle did not discover and index the replacement generation.');
    expect(f.embedQuery).not.toHaveBeenCalled();
    expect((await host.graphql(f.session, 'query', {document})).errors).toBeUndefined();
    expect(f.queryGenerations.at(-1)).toBe('replacement-weights');
  });

  it('cancels pending background inference when the host closes', async () => {
    const f = fixture(); let requestSignal: AbortSignal | undefined;
    f.embed.mockImplementation((_texts, options) => new Promise((_resolve, reject) => {
      requestSignal = options?.signal;
      const abort = () => reject(requestSignal?.reason);
      requestSignal?.addEventListener('abort', abort, {once: true});
      if (requestSignal?.aborted) abort();
    }));
    const {host} = f.host();
    await until(() => requestSignal !== undefined, 'Background embedding did not start.');
    await host.close();
    expect(requestSignal!.aborted).toBe(true);
    expect(f.embedQuery).not.toHaveBeenCalled();
  });
});
