import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@lancedb/lancedb';
import { Store } from '../src/source/store.js';
import { SemanticIndexNotCurrentError, SemanticSearchService, semanticIndexGenerationKey, withSemanticCacheAccess, closeSemanticCacheHandles } from '../src/semantic/search.js';
import type { SemanticEmbedder } from '../src/semantic/embedding.js';
import { searchSourceVersion } from '../src/semantic/source-version.js';
import { hashText } from '../src/semantic/documents.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {...original, readFile: vi.fn(original.readFile), rm: vi.fn(original.rm)};
});

const fixtures: Array<{home: string; store: Store; services: SemanticSearchService[]}> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const {home, store, services} of fixtures.splice(0)) {
    await Promise.all(services.map(service => service.close()));
    store.close(); rmSync(home, {recursive: true, force: true});
  }
});

function fixture() {
  const home = mkdtempSync('/private/tmp/aside-semantic-reconcile-'), data = join(home, 'data'), indexRoot = join(home, 'indexes');
  mkdirSync(join(data, 'projects/2026'), {recursive: true});
  writeFileSync(join(data, 'aside.md'), '---\nid: reconcile-fixture\n---\n');
  writeFileSync(join(data, 'projects/2026/index.yaml'), '- id: alpha\n  description: Alpha\n- id: beta\n  description: Beta\n');
  const write = (id: string, body: string) => writeFileSync(join(data, 'projects/2026', `${id}.md`), `---\nname: ${id}\ncreated: 2026-10-28\n---\n${body}`);
  write('alpha', 'Original apple passage.'); write('beta', 'Original banana passage.');
  const store = new Store(data), services: SemanticSearchService[] = [];
  const state = {identity: 'weights-one', unavailable: false, failEmbedding: false};
  const embed = vi.fn(async (texts: string[]) => {
    if (state.failEmbedding) throw new Error('Inference unavailable');
    return texts.map(() => [1, 2, 3]);
  });
  const identity = vi.fn(async () => {
    if (state.unavailable) throw new Error('Model service unavailable');
    return state.identity;
  });
  const embedder: SemanticEmbedder = {model: 'fixture-model', resolveGeneration: async () => ({model: 'fixture-model', identity: await identity(), embed})};
  const service = () => {
    const value = new SemanticSearchService({embedder, indexRoot, batchSize: 1});
    services.push(value); return value;
  };
  const rows = async () => {
    const parent = join(indexRoot, hashText(store.getDataDir()));
    const result: Array<{directory: string; rows: Record<string, any>[]}> = [];
    for (const directory of readdirSync(parent).filter(name => /^[0-9a-f]{64}$/.test(name))) {
      const connection = await connect(join(parent, directory));
      try {
        if (!(await connection.tableNames()).includes('chunks')) continue;
        const table = await connection.openTable('chunks');
        try { result.push({directory, rows: await table.query().toArray()}); }
        finally { table.close(); }
      } finally { connection.close(); }
    }
    return result;
  };
  fixtures.push({home, store, services});
  const parent = join(indexRoot, hashText(store.getDataDir()));
  const location = (identity = state.identity) => join(parent, semanticIndexGenerationKey(identity));
  const versions = async () => {
    const connection = await connect(location());
    try {
      const table = await connection.openTable('chunks');
      try { return (await table.listVersions()).map(version => version.version); }
      finally { table.close(); }
    } finally { connection.close(); }
  };
  return {home, data, indexRoot, parent, location, store, state, embed, identity, service, write, rows, versions};
}

describe('semantic index reconciliation independent of ranking', () => {
  it('indexes registered source content without embedding a query, then incrementally updates it', async () => {
    const f = fixture(), service = f.service();
    expect(await service.reconcile(f.store)).toEqual({sourceVersion: searchSourceVersion(f.store), model: 'fixture-model', indexedChunks: 2});
    expect(f.embed.mock.calls.flatMap(([texts]) => texts)).toHaveLength(2);
    f.embed.mockClear();
    f.write('alpha', 'A changed apple passage.'); unlinkSync(join(f.data, 'projects/2026/beta.md')); f.store.rebuild();
    const updated = await service.reconcile(f.store);
    expect(updated.sourceVersion).toBe(searchSourceVersion(f.store));
    expect(updated.indexedChunks).toBe(1);
    expect(f.embed).toHaveBeenCalledExactlyOnceWith([expect.stringContaining('changed apple')], {signal: expect.any(AbortSignal)});
    expect((await f.rows())[0].rows.map(row => row.text)).toEqual([expect.stringContaining('changed apple')]);
  });

  it('clears every persisted generation for an empty source without contacting an unavailable model', async () => {
    const f = fixture(), first = f.service();
    await first.reconcile(f.store); f.state.identity = 'weights-two'; await first.reconcile(f.store); await first.close();
    cpSync(f.location(), join(f.parent, hashText('legacy-other-generation')), {recursive: true});
    unlinkSync(join(f.data, 'projects/2026/alpha.md')); unlinkSync(join(f.data, 'projects/2026/beta.md')); f.store.rebuild();
    f.state.unavailable = true; f.identity.mockClear(); f.embed.mockClear();
    const restored = f.service();
    expect(await restored.reconcile(f.store)).toEqual({sourceVersion: searchSourceVersion(f.store), model: 'fixture-model', indexedChunks: 0});
    expect(f.identity).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual([]);
    expect(readdirSync(f.parent)).toEqual([]);
  });

  it('invalidates deleted and replaced passages before an inference failure, then resumes', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    f.write('alpha', 'Replacement apple passage.'); unlinkSync(join(f.data, 'projects/2026/beta.md')); f.store.rebuild();
    f.state.failEmbedding = true;
    await expect(service.reconcile(f.store)).rejects.toThrow('Inference unavailable');
    expect((await f.rows()).every(generation => generation.rows.length === 0)).toBe(true);
    f.state.failEmbedding = false;
    expect((await service.reconcile(f.store)).indexedChunks).toBe(1);
    expect((await f.rows())[0].rows.map(row => row.text)).toEqual([expect.stringContaining('Replacement apple')]);
  });

  it('does not mark reconciliation complete when the source changes during inference', async () => {
    const f = fixture(), service = f.service();
    f.embed.mockImplementationOnce(async texts => { f.write('alpha', 'Newer apple passage.'); f.store.rebuild(); return texts.map(() => [1, 2, 3]); });
    await expect(service.reconcile(f.store)).rejects.toThrow('Aside changed');
    expect((await service.reconcile(f.store)).sourceVersion).toBe(searchSourceVersion(f.store));
    expect((await f.rows())[0].rows.some(row => row.text.includes('Original apple'))).toBe(false);
  });

  it('rejects an outdated empty eligible query until the lifecycle reconciles its loaded source', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    unlinkSync(join(f.data, 'projects/2026/beta.md')); f.store.rebuild(); f.embed.mockClear();
    await expect(service.search(f.store, {query: 'no results'}, {allowedHandles: []})).rejects.toBeInstanceOf(SemanticIndexNotCurrentError);
    expect(f.embed).not.toHaveBeenCalled();
    await service.reconcile(f.store);
    expect((await service.search(f.store, {query: 'no results'}, {allowedHandles: []})).hits).toEqual([]);
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.rows())[0].rows.map(row => row.handle)).toEqual(['#project/alpha']);
  });

  it('reopens a table created by another service after an interrupted initial build', async () => {
    const f = fixture(), interrupted = f.service();
    f.state.failEmbedding = true;
    await expect(interrupted.reconcile(f.store)).rejects.toThrow('Inference unavailable');
    f.state.failEmbedding = false;
    await f.service().reconcile(f.store); f.embed.mockClear();
    expect((await interrupted.reconcile(f.store)).indexedChunks).toBe(2);
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.rows())[0].rows).toHaveLength(2);
  });

  it('stops opening persisted generations when reconciliation is cancelled', async () => {
    const f = fixture(), initial = f.service();
    await initial.reconcile(f.store); f.state.identity = 'weights-two'; await initial.reconcile(f.store); await initial.close();
    cpSync(f.location(), join(f.parent, hashText('legacy-other-generation')), {recursive: true});
    const restored = f.service(), controller = new AbortController();
    const openLocation = (restored as any).openLocation.bind(restored);
    const opened = vi.spyOn(restored as any, 'openLocation').mockImplementation(async (...args) => {
      const result = await openLocation(...args);
      controller.abort(new Error('Instance was unregistered'));
      return result;
    });
    await expect(restored.reconcile(f.store, {signal: controller.signal})).rejects.toThrow('Instance was unregistered');
    // Wait for the native operation to finish as well as the cancelled caller.
    await restored.close();
    expect(opened).toHaveBeenCalledOnce();
  });
});

function cacheContains(path: string, text: string): boolean {
  return readdirSync(path, {withFileTypes: true}).some(entry => entry.isDirectory()
    ? cacheContains(join(path, entry.name), text)
    : entry.isFile() && readFileSync(join(path, entry.name)).includes(Buffer.from(text)));
}

describe('registered semantic cache storage maintenance', () => {
  it('never creates or repairs an index from retrieval and certifies only lifecycle reconciliation', async () => {
    const f = fixture(), service = f.service();
    await expect(service.search(f.store, {query: 'apple'})).rejects.toBeInstanceOf(SemanticIndexNotCurrentError);
    expect(f.embed).not.toHaveBeenCalled(); expect(existsSync(f.parent)).toBe(false);
    await service.reconcile(f.store);
    const certificate = JSON.parse(readFileSync(join(f.location(), 'snapshot.json'), 'utf8'));
    expect(certificate).toMatchObject({format: 1, sourceVersion: searchSourceVersion(f.store), identity: f.state.identity, indexedChunks: 2});
    const version = await f.versions(), saved = readFileSync(join(f.location(), 'snapshot.json'), 'utf8');
    f.embed.mockClear();
    await service.search(f.store, {query: 'apple'});
    expect(await f.versions()).toEqual(version);
    expect(readFileSync(join(f.location(), 'snapshot.json'), 'utf8')).toBe(saved);
    expect(f.embed).toHaveBeenCalledExactlyOnceWith(['apple'], {signal: expect.any(AbortSignal)});
  });

  it('compares the indexed hash with the loaded snapshot without independently rereading source files', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    f.write('alpha', 'Not loaded by the instance lifecycle yet');
    expect((await service.search(f.store, {query: 'apple'})).hits.some(hit => hit.snippet.includes('Original apple'))).toBe(true);
    f.store.rebuild(); f.embed.mockClear();
    await expect(service.search(f.store, {query: 'apple'})).rejects.toBeInstanceOf(SemanticIndexNotCurrentError);
    expect(f.embed).not.toHaveBeenCalled();
    await service.reconcile(f.store);
    expect((await service.search(f.store, {query: 'apple'})).hits.some(hit => hit.snippet.includes('Not loaded by the instance lifecycle yet'))).toBe(true);
  });

  it.each(['missing', 'mismatched'])('leaves a %s persisted certificate for lifecycle recovery while queries use the published binding', async state => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    const path = join(f.location(), 'snapshot.json'), saved = readFileSync(path, 'utf8');
    if (state === 'missing') unlinkSync(path);
    else writeFileSync(path, JSON.stringify({...JSON.parse(saved), sourceVersion: 'not-the-loaded-source'}));
    f.embed.mockClear();
    expect((await service.search(f.store, {query: 'apple'})).hits).toHaveLength(2);
    expect(state === 'missing' ? existsSync(path) : readFileSync(path, 'utf8') === saved).toBe(false);
    f.embed.mockClear();
    await service.reconcile(f.store);
    expect(readFileSync(path, 'utf8')).toBe(saved);
    expect(f.embed).not.toHaveBeenCalled();
    const retired = join(f.parent, `.retired-${hashText('pending cleanup')}`); mkdirSync(retired);
    writeFileSync(join(retired, 'sentinel'), 'Lifecycle-owned obsolete data');
    await service.search(f.store, {query: 'apple'});
    expect(existsSync(retired)).toBe(true);
    await service.reconcile(f.store); expect(existsSync(retired)).toBe(false);
  });

  it('uses only the published binding without source diagnostics, freshness metadata or model discovery', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    const index = [...(service as any).indexes.values()][0] as any;
    const reads = vi.spyOn(f.store, 'getEntries');
    const diagnostics = vi.spyOn(f.store, 'getIssues');
    const health = vi.spyOn(f.store, 'getSourceHealth');
    const query = vi.spyOn(index.table, 'query');
    const version = vi.spyOn(index.table, 'version');
    const checkout = vi.spyOn(index.table, 'checkoutLatest');
    const opens = vi.spyOn(service as any, 'openLocation');
    const checkpoint = vi.spyOn(service as any, 'cleanVersion');
    const certificate = vi.spyOn(service as any, 'certificate');
    const metadataReads = vi.mocked(filesystem.readFile); metadataReads.mockClear();
    f.identity.mockClear(); f.embed.mockClear();
    expect((await service.search(f.store, {query: 'apple'})).hits).toHaveLength(2);
    expect(f.identity).not.toHaveBeenCalled();
    expect(f.embed).toHaveBeenCalledExactlyOnceWith(['apple'], {signal: expect.any(AbortSignal)});
    expect(reads).toHaveBeenCalledOnce(); // Empty-source check, without document/chunk reconstruction.
    expect(query).toHaveBeenCalledOnce(); // The vector lookup, without full chunk-ID scans.
    expect(diagnostics).not.toHaveBeenCalled(); expect(health).not.toHaveBeenCalled();
    expect(metadataReads).not.toHaveBeenCalled();
    expect(version).not.toHaveBeenCalled(); expect(checkout).not.toHaveBeenCalled();
    expect(opens).not.toHaveBeenCalled(); expect(checkpoint).not.toHaveBeenCalled(); expect(certificate).not.toHaveBeenCalled();
    query.mockClear();
    f.identity.mockClear();
    await service.reconcile(f.store);
    expect(f.identity).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(metadataReads).toHaveBeenCalled(); expect(certificate).toHaveBeenCalled();
    expect(version).toHaveBeenCalled(); expect(checkout).toHaveBeenCalled(); expect(health).toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it('uses the completed generation without metadata discovery and leaves discovery failures to the lifecycle', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    f.state.unavailable = true; f.embed.mockClear(); f.identity.mockClear();
    expect((await service.search(f.store, {query: 'apple'})).hits).toHaveLength(2);
    expect(f.identity).not.toHaveBeenCalled();
    expect(f.embed).toHaveBeenCalledExactlyOnceWith(['apple'], {signal: expect.any(AbortSignal)});
    await expect(service.reconcile(f.store)).rejects.toThrow('Model service unavailable');
  });

  it('repairs out-of-band native commits during lifecycle reconciliation instead of validating them in queries', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    const connection = await connect(f.location());
    try {
      const table = await connection.openTable('chunks');
      try {await table.delete(`handle = '#project/alpha'`);}
      finally {table.close();}
    } finally {connection.close();}
    f.embed.mockClear();
    const validation = vi.spyOn(service as any, 'openLocation');
    await service.search(f.store, {query: 'apple'});
    expect(validation).not.toHaveBeenCalled();
    f.embed.mockClear();
    await service.reconcile(f.store);
    expect((await service.search(f.store, {query: 'apple'})).hits).toHaveLength(2);
    expect(f.embed.mock.calls.flatMap(([texts]) => texts)).toEqual([
      expect.stringContaining('Original apple passage.'), 'apple',
    ]);
    expect((await f.rows())[0].rows).toHaveLength(2);
  });

  it('invalidates published readers before known lifecycle maintenance changes their native generation', async () => {
    const f = fixture(), reader = f.service(), writer = f.service();
    await reader.reconcile(f.store); await writer.reconcile(f.store);
    unlinkSync(join(f.location(), 'live.version'));
    await writer.reconcile(f.store);
    f.embed.mockClear();
    await expect(reader.search(f.store, {query: 'apple'})).rejects.toBeInstanceOf(SemanticIndexNotCurrentError);
    expect(f.embed).not.toHaveBeenCalled();
    await reader.reconcile(f.store);
    expect((await reader.search(f.store, {query: 'apple'})).hits).toHaveLength(2);
  });

  it('checks the durable cleanup checkpoint even when source and committed table versions match', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    const orphan = join(f.location(), 'chunks.lance', 'data', '00000000-0000-0000-0000-000000000000.lance');
    writeFileSync(orphan, 'Uncommitted data from another failed owner');
    unlinkSync(join(f.location(), 'live.version'));
    f.state.unavailable = true; f.embed.mockClear();
    await expect(service.reconcile(f.store)).rejects.toThrow('Model service unavailable');
    expect(existsSync(orphan)).toBe(false);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('physically removes deleted and replaced passages before contacting an unavailable model', async () => {
    const f = fixture(), service = f.service(), deleted = 'UNIQUE_DELETED_SEMANTIC_PASSAGE_82df1747';
    const replaced = 'UNIQUE_REPLACED_SEMANTIC_PASSAGE_c208bbef';
    f.write('beta', deleted); f.write('alpha', replaced);
    for (let index = 0; index < 98; index++) f.write(`extra-${index}`, `Unchanged passage ${index}.`);
    f.store.rebuild();
    await service.reconcile(f.store);
    expect(cacheContains(f.parent, deleted)).toBe(true);
    expect(cacheContains(f.parent, replaced)).toBe(true);
    unlinkSync(join(f.data, 'projects/2026/beta.md')); f.write('alpha', 'A new apple passage.'); f.store.rebuild();
    f.state.unavailable = true; f.embed.mockClear();
    await expect(service.reconcile(f.store)).rejects.toThrow('Model service unavailable');
    expect(f.embed).not.toHaveBeenCalled();
    expect(cacheContains(f.parent, deleted)).toBe(false);
    expect(cacheContains(f.parent, replaced)).toBe(false);
    expect((await f.rows())[0].rows).toHaveLength(98);
    expect(await f.versions()).toHaveLength(1);
  });

  it('recovers a legacy single-version table that still has tombstoned bytes', async () => {
    const f = fixture(), service = f.service(), deleted = 'LEGACY_TOMBSTONE_SEMANTIC_PASSAGE_915ef78e';
    f.write('beta', deleted);
    for (let index = 0; index < 98; index++) f.write(`extra-${index}`, `Other passage ${index}.`);
    f.store.rebuild(); await service.reconcile(f.store); await service.close();
    unlinkSync(join(f.data, 'projects/2026/beta.md')); f.store.rebuild();
    const connection = await connect(f.location());
    try {
      const table = await connection.openTable('chunks');
      try {
        await table.delete(`handle = '#project/beta'`);
        const latest = (await table.listVersions()).at(-1)!;
        await table.optimize({cleanupOlderThan: new Date(latest.timestamp.getTime() + 1), deleteUnverified: true});
        expect(await table.listVersions()).toHaveLength(1);
      } finally { table.close(); }
    } finally { connection.close(); }
    expect(cacheContains(f.parent, deleted)).toBe(true);
    unlinkSync(join(f.location(), 'live.version'));
    f.state.unavailable = true; f.embed.mockClear();
    await expect(f.service().reconcile(f.store)).rejects.toThrow('Model service unavailable');
    expect(cacheContains(f.parent, deleted)).toBe(false);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('prunes append history without changing storage on unchanged source or reopening', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    expect(await f.versions()).toHaveLength(1);
    const firstVersion = await f.versions();
    const checkpoint = readFileSync(join(f.location(), 'live.version'), 'utf8');
    await service.reconcile(f.store); await service.close();
    await f.service().reconcile(f.store);
    expect(await f.versions()).toEqual(firstVersion);
    expect(readFileSync(join(f.location(), 'live.version'), 'utf8')).toBe(checkpoint);
    f.write('gamma', 'A new grape passage.'); f.store.rebuild();
    await f.service().reconcile(f.store);
    expect((await f.rows())[0].rows).toHaveLength(3);
    expect(await f.versions()).toHaveLength(1);
  });

  it('retries interrupted cleanup before certifying the source current', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    const index = [...(service as any).indexes.values()][0] as any;
    const optimize = vi.spyOn(index.table, 'optimize').mockRejectedValueOnce(new Error('Storage temporarily busy'));
    unlinkSync(join(f.data, 'projects/2026/beta.md')); f.store.rebuild();
    await expect(service.reconcile(f.store)).rejects.toThrow('Storage temporarily busy');
    expect((await service.reconcile(f.store)).indexedChunks).toBe(1);
    expect(optimize).toHaveBeenCalledTimes(2);
    expect(await f.versions()).toHaveLength(1);
    expect((await f.rows())[0].rows.map(row => row.handle)).toEqual(['#project/alpha']);
  });

  it('recovers orphan files from a failed native write even when its committed version did not change', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    const version = await f.versions();
    const index = [...(service as any).indexes.values()][0] as any;
    const orphan = join(f.location(), 'chunks.lance', 'data', '00000000-0000-0000-0000-000000000000.lance');
    const add = vi.spyOn(index.table, 'add').mockImplementationOnce(async () => {
      writeFileSync(orphan, 'uncommitted embedding passage');
      throw new Error('Native commit interrupted');
    });
    f.write('gamma', 'A new grape passage.'); f.store.rebuild();
    await expect(service.reconcile(f.store)).rejects.toThrow('Native commit interrupted');
    expect(await f.versions()).toEqual(version);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(join(f.location(), 'live.version'))).toBe(false);
    // The source can also revert before retry. Neither its original version
    // nor the still-current native version makes an uncommitted file safe.
    unlinkSync(join(f.data, 'projects/2026/gamma.md')); f.store.rebuild();
    await service.reconcile(f.store);
    expect(existsSync(orphan)).toBe(false);
    expect(add).toHaveBeenCalledTimes(2);
    expect(await f.versions()).toHaveLength(1);
    expect((await f.rows())[0].rows).toHaveLength(2);
  });

  it('removes files left by an uncommitted initial table creation before contacting an unavailable model', async () => {
    const f = fixture(), service = f.service();
    const orphan = join(f.location(), 'chunks.lance', 'data', '00000000-0000-0000-0000-000000000000.lance');
    const open = (service as any).openLocation.bind(service);
    const opened = vi.spyOn(service as any, 'openLocation').mockImplementationOnce(async (...args) => {
      const index = await open(...args);
      vi.spyOn(index.connection, 'createTable').mockImplementationOnce(async () => {
        mkdirSync(join(f.location(), 'chunks.lance', 'data'), {recursive: true});
        writeFileSync(orphan, 'uncommitted initial embedding passage');
        throw new Error('Initial native commit interrupted');
      });
      return index;
    });
    await expect(service.reconcile(f.store)).rejects.toThrow('Initial native commit interrupted');
    expect(existsSync(orphan)).toBe(true);
    opened.mockRestore(); f.state.unavailable = true; f.embed.mockClear();
    await expect(service.reconcile(f.store)).rejects.toThrow('Model service unavailable');
    expect(existsSync(f.location())).toBe(false);
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('keeps the previous generation until a replacement finishes, then evicts every old handle', async () => {
    const f = fixture(), first = f.service(), second = f.service();
    await first.reconcile(f.store); await second.reconcile(f.store);
    const old = f.location();
    f.state.identity = 'weights-two';
    f.embed.mockRejectedValueOnce(new Error('Temporary embedding failure'));
    await expect(second.reconcile(f.store)).rejects.toThrow('Temporary embedding failure');
    expect(readdirSync(f.parent)).toContain(old.split('/').at(-1));
    await second.reconcile(f.store);
    expect((await f.rows()).map(generation => generation.directory)).toEqual([f.location().split('/').at(-1)]);
    expect([...(first as any).indexes.keys()]).not.toContain(old);
    f.state.identity = 'weights-one'; f.embed.mockClear();
    await first.reconcile(f.store);
    expect(f.embed).toHaveBeenCalledTimes(2);
    expect((await f.rows()).map(generation => generation.directory)).toEqual([old.split('/').at(-1)]);
  });

  it('finishes a partial retired-generation deletion before reopening healthy native tables', async () => {
    const f = fixture(), service = f.service(); await service.reconcile(f.store);
    const old = f.location(), retired = join(f.parent, `.retired-${old.split('/').at(-1)!}`);
    const originalRemove = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm;
    let interrupted = false;
    vi.spyOn(filesystem, 'rm').mockImplementation(async (path, options) => {
      if (path === retired && !interrupted) {
        interrupted = true;
        const data = join(retired, 'chunks.lance', 'data');
        unlinkSync(join(data, readdirSync(data).find(name => name.endsWith('.lance'))!));
        throw new Error('Retired generation deletion interrupted');
      }
      return originalRemove(path, options);
    });
    f.state.identity = 'weights-two';
    await expect(service.reconcile(f.store)).rejects.toThrow('Retired generation deletion interrupted');
    expect(existsSync(old)).toBe(false); expect(existsSync(retired)).toBe(true);
    expect(existsSync(join(f.location(), 'live.version'))).toBe(true);
    f.embed.mockClear();
    const openLocation = (service as any).openLocation.bind(service);
    vi.spyOn(service as any, 'openLocation').mockImplementation(async (...args) => {
      expect(existsSync(retired)).toBe(false);
      return openLocation(...args);
    });
    expect((await service.reconcile(f.store)).indexedChunks).toBe(2);
    expect(f.embed).not.toHaveBeenCalled();
    expect((await f.rows()).map(generation => generation.directory)).toEqual([f.location().split('/').at(-1)]);
    expect(existsSync(retired)).toBe(false);
  });

  it('removes retired generations for an empty source offline without following retired symlinks', async () => {
    const f = fixture(), initial = f.service(); await initial.reconcile(f.store); await initial.close();
    const retired = join(f.parent, `.retired-${f.location().split('/').at(-1)!}`);
    renameSync(f.location(), retired);
    const external = join(f.home, 'outside-cache'); mkdirSync(external);
    writeFileSync(join(external, 'sentinel'), 'Must stay outside cleanup');
    const linked = join(f.parent, `.retired-${hashText('symlink')}`); symlinkSync(external, linked);
    const unrelated = join(f.parent, '.retired-not-a-generation'); mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'sentinel'), 'Unrecognized directory');
    unlinkSync(join(f.data, 'projects/2026/alpha.md')); unlinkSync(join(f.data, 'projects/2026/beta.md')); f.store.rebuild();
    f.state.unavailable = true; f.embed.mockClear(); f.identity.mockClear();
    const restored = f.service(), opened = vi.spyOn(restored as any, 'openLocation');
    expect((await restored.reconcile(f.store)).indexedChunks).toBe(0);
    expect(existsSync(retired)).toBe(false);
    expect(opened).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled(); expect(f.identity).not.toHaveBeenCalled();
    expect(existsSync(linked)).toBe(true);
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('Must stay outside cleanup');
    expect(readFileSync(join(unrelated, 'sentinel'), 'utf8')).toBe('Unrecognized directory');
  });

  it('serializes external cache removal after a search and reopens evicted handles', async () => {
    const f = fixture(), service = f.service(), other = f.service();
    await service.reconcile(f.store); await other.reconcile(f.store);
    let start!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { start = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.embed.mockImplementationOnce(async texts => { start(); await held; return texts.map(() => [1, 2, 3]); });
    const search = service.search(f.store, {query: 'apple'}); await entered;
    const removed = withSemanticCacheAccess(async () => {
      closeSemanticCacheHandles(f.parent); rmSync(f.parent, {recursive: true});
    });
    release(); expect((await search).hits).toHaveLength(2); await removed;
    expect((service as any).indexes.size).toBe(0); expect((other as any).indexes.size).toBe(0);
    expect((service as any).completed.size).toBe(0); expect((other as any).completed.size).toBe(0);
    await other.reconcile(f.store); await service.reconcile(f.store);
    expect((await f.rows())[0].rows).toHaveLength(2);
  });
});
