import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/source/store.js';
import { SemanticIndexNotCurrentError, SemanticSearchService } from '../src/semantic/search.js';
import type { EmbeddingOptions, SemanticEmbedder, SemanticEmbeddingGeneration } from '../src/semantic/embedding.js';
import { chunkDocument, collectDocuments, lexicalRanking } from '../src/semantic/documents.js';
import { searchSourceVersion } from '../src/semantic/source-version.js';

const homes: string[] = []; const services: SemanticSearchService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixedGeneration(model: string, embed: SemanticEmbeddingGeneration['embed']): SemanticEmbedder {
  return {model, resolveGeneration: async () => ({model, identity: model, embed})};
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'aside-semantic-')); homes.push(home);
  const data = join(home, 'data');
  for (const kind of ['notes', 'projects', 'actions', 'artifacts']) mkdirSync(join(data, kind, '2026'), { recursive: true });
  writeFileSync(join(data, 'aside.md'), '---\nid: semantic-test\n---\n');
  writeFileSync(join(data, 'notes/2026/index.yaml'), '- id: 2026-10-26\n  description: Notes this week\n');
  writeFileSync(join(data, 'notes/2026/2026-10-26.md'), '---\nweek: 44\nweek_start: 2026-10-26\nweek_end: 2026-11-01\n---\n\n```entry\ncreated: "2026-10-27T10:00:00"\nprojects: [orchard]\nactions: [prune]\n```\n\nThe apple harvest is ready.\n\n---\n\n```entry\ncreated: "2026-10-28T12:00:00"\nprojects: [space]\n```\n\nA rocket launches to the moon.\n');
  writeFileSync(join(data, 'projects/2026/index.yaml'), '- id: orchard\n  description: Orchard planning and apple care\n- id: space\n  description: Moon mission\n');
  const writeProject = (id: string, body: string) => writeFileSync(join(data, `projects/2026/${id}.md`), `---\nname: ${id}\ncreated: "2026-01-01"\n---\n\n${body}\n`);
  writeProject('orchard', '# Harvest\nGather fruit from the trees.\n\n# Winter\nProtect roots against frost.');
  writeProject('space', 'Explore the solar system.');
  writeFileSync(join(data, 'actions/2026/index.yaml'), '- id: prune\n  description: Trim the fruit trees\n');
  writeFileSync(join(data, 'actions/2026/prune.md'), '---\nname: Prune trees\ncreated: "2026-10-25"\n---\n\nRemove dead branches from apple trees.');
  writeFileSync(join(data, 'artifacts/2026/index.yaml'), '[]\n');
  const store = new Store(data);
  const calls: string[][] = [];
  const embedder = {
    model: 'test-v1',
    identity: async () => 'test-v1',
    async embed(texts: string[], _options?: EmbeddingOptions) {
      calls.push(texts);
      return texts.map(text => [/apple|fruit|orchard|harvest|tree/i.test(text) ? 1 : 0.01, /rocket|moon|space|solar/i.test(text) ? 1 : 0.01, 0.1]);
    },
  };
  const provider: SemanticEmbedder = {model: embedder.model, resolveGeneration: async () => ({
    model: embedder.model, identity: await embedder.identity(), embed: (texts, options) => embedder.embed(texts, options),
  })};
  const service = (extra: ConstructorParameters<typeof SemanticSearchService>[0] = {}) => {
    const result = new SemanticSearchService({ embedder: provider, indexRoot: join(home, 'indexes'), ...extra }); services.push(result); return result;
  };
  const indexed = async (extra: ConstructorParameters<typeof SemanticSearchService>[0] = {}) => {
    const result = service(extra); await result.reconcile(store); return result;
  };
  return { home, data, store, calls, embedder, service, indexed, writeProject };
}

describe('persistent semantic search', () => {
  it('indexes entries individually and applies structural filters before top-k', async () => {
    const f = fixture(); const service = await f.indexed();
    const first = await service.search(f.store, { query: 'fruit', first: 1, kinds: ['entry'], projects: ['space'] });
    expect(first.hits).toHaveLength(1);
    expect(first.hits[0].id).toBe('2026-10-28T12:00:00');
    expect(first.hits[0].handle).toBe('#entry/2026-10-28T12:00:00');
    const date = await service.search(f.store, { query: 'fruit', kinds: ['entry'], from: '2026-10-27', to: '2026-10-27' });
    expect(date.hits.map(hit => hit.id)).toEqual(['2026-10-27T10:00:00']);
    const action = await service.search(f.store, { query: 'fruit', kinds: ['action'], projects: ['orchard'] });
    expect(action.hits[0].id).toBe('prune');
    expect(first.indexedChunks).toBe(6);
  });

  it('includes names and index descriptions and deduplicates chunks by source record', async () => {
    const f = fixture(); const result = await (await f.indexed()).search(f.store, { query: 'Orchard planning', kinds: ['project'] });
    expect(result.hits.filter(hit => hit.id === 'orchard')).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ name: 'orchard', description: 'Orchard planning and apple care' });
    expect(f.calls.flat().some(text => text.includes('Orchard planning and apple care'))).toBe(true);
  });

  it('persists across restarts, reuses unchanged passage vectors after edits, and removes deleted records', async () => {
    const f = fixture(); const first = await f.indexed();
    await first.search(f.store, { query: 'fruit' }); await first.close();
    f.calls.length = 0;
    const next = f.service(); await next.reconcile(f.store); await next.search(f.store, { query: 'fruit' });
    expect(f.calls).toEqual([['fruit']]);
    f.calls.length = 0;
    f.writeProject('orchard', '# Harvest\nGather ripe fruit from the trees.\n\n# Winter\nProtect roots against frost.'); f.store.rebuild();
    await expect(next.search(f.store, {query: 'fruit'})).rejects.toBeInstanceOf(SemanticIndexNotCurrentError);
    await next.reconcile(f.store);
    await next.search(f.store, { query: 'fruit' });
    expect(f.calls.flat()).toHaveLength(2); // changed Harvest passage + query, unchanged Winter reused
    unlinkSync(join(f.data, 'projects/2026/space.md')); f.store.rebuild();
    await next.reconcile(f.store);
    const result = await next.search(f.store, { query: 'moon', kinds: ['project'] });
    expect(result.hits.some(hit => hit.id === 'space')).toBe(false);
  });

  it('isolates two instances even when their manifest IDs match', async () => {
    const f = fixture(); const second = fixture(); const service = await f.indexed();
    await service.search(f.store, { query: 'fruit' });
    second.writeProject('space', 'A completely different space project.'); second.store.rebuild();
    await service.reconcile(second.store);
    const result = await service.search(second.store, { query: 'moon', kinds: ['project'], projects: ['space'] });
    expect(result.hits[0].snippet).toContain('completely different');
  });

  it('rebuilds when model fingerprint changes', async () => {
    const f = fixture(); let fingerprint = 'one'; f.embedder.identity = async () => fingerprint;
    const service = await f.indexed(); await service.search(f.store, { query: 'fruit' }); f.calls.length = 0;
    fingerprint = 'two'; await service.search(f.store, {query: 'fruit'}); // Lifecycle has not observed a replacement yet.
    f.calls.length = 0;
    await service.reconcile(f.store); await service.search(f.store, { query: 'fruit' });
    expect(f.calls.flat()).toHaveLength(7);
  });

  it('resumes committed batches after cancellation', async () => {
    const f = fixture(); const controller = new AbortController(); const original = f.embedder.embed.bind(f.embedder); let count = 0;
    f.embedder.embed = async (texts, options) => { if (++count === 2) controller.abort(new Error('cancelled')); options?.signal?.throwIfAborted(); return original(texts, options); };
    await expect(f.service({ batchSize: 2 }).reconcile(f.store, { signal: controller.signal })).rejects.toThrow('cancelled');
    f.calls.length = 0; f.embedder.embed = original;
    const result = await (await f.indexed({ batchSize: 2 })).search(f.store, { query: 'fruit' });
    expect(result.indexedChunks).toBe(6);
    expect(f.calls.flat()).toHaveLength(5); // 4 remaining passages + query
  });

  it('does not return stale source content after a mutation during inference', async () => {
    const f = fixture(); const service = await f.indexed();
    const original = f.embedder.embed.bind(f.embedder); let changed = false;
    f.embedder.embed = async (texts, options) => {
      const result = await original(texts, options);
      if (!changed) { changed = true; f.writeProject('space', 'New mission'); f.store.rebuild(); }
      return result;
    };
    await expect(service.search(f.store, { query: 'moon' })).rejects.toThrow('Aside changed');
  });

  it('allows no-op source rebuilds during document and query inference', async () => {
    const f = fixture(); const original = f.embedder.embed.bind(f.embedder);
    const before = searchSourceVersion(f.store), revision = f.store.getRevision();
    f.embedder.embed = async (texts, options) => {
      const result = await original(texts, options);
      f.store.rebuild();
      return result;
    };
    const result = await (await f.indexed({batchSize: 2})).search(f.store, {query: 'moon', kinds: ['project']});
    expect(f.store.getRevision()).toBeGreaterThan(revision);
    expect(searchSourceVersion(f.store)).toBe(before);
    expect(result.hits[0].handle).toBe('#project/space');
  });

  it('detects actual metadata, index description, and instance instruction changes', () => {
    const f = fixture(); let version = searchSourceVersion(f.store);
    f.store.rebuild();
    expect(searchSourceVersion(f.store)).toBe(version);
    const action = f.store.getAction('prune')!;
    f.store.saveAction('prune', {...action.frontMatter, name: 'New action name'}, action.body, f.store.getActionFile('prune')!);
    expect(searchSourceVersion(f.store)).not.toBe(version); version = searchSourceVersion(f.store);
    f.store.setIndexEntry('projects', 'orchard', 'Updated orchard description');
    expect(searchSourceVersion(f.store)).not.toBe(version); version = searchSourceVersion(f.store);
    writeFileSync(join(f.data, 'aside.md'), '---\nid: semantic-test\n---\nNew instance instructions.\n');
    f.store.rebuild();
    expect(searchSourceVersion(f.store)).not.toBe(version);
  });

  it('rejects invalid vectors and invalid input without regex fallback', async () => {
    const f = fixture(); const service = f.service({ embedder: fixedGeneration('broken', async texts => texts.map(() => [NaN, 0])) });
    await expect(service.reconcile(f.store)).rejects.toThrow('invalid vector');
    await expect(service.search(f.store, { query: '' })).rejects.toThrow('Semantic query');
    await expect(service.search(f.store, { query: 'fruit', first: 0 })).rejects.toThrow('Semantic first');
    await expect(service.search(f.store, { query: 'fruit', to: 'no' })).rejects.toThrow('ISO');
  });

  it('cancels queued work when closed and remains closed', async () => {
    const f = fixture(); const service = await f.indexed(); await service.close();
    await expect(service.search(f.store, { query: 'fruit' })).rejects.toThrow('closed');
  });

  it('uses an already synchronized corpus for empty structural filters without embedding a query', async () => {
    const f = fixture(); const service = await f.indexed();
    expect((await service.search(f.store, { query: 'fruit', kinds: [] })).hits).toEqual([]);
    expect((await service.search(f.store, { query: 'fruit', projects: [] })).hits).toEqual([]);
    expect(f.calls.flat()).toHaveLength(6);
    expect(f.calls.flat()).not.toContain('fruit');
  });

  it('returns unique source records even when one long document fills the initial nearest chunks', async () => {
    const f = fixture();
    f.writeProject('orchard', Array.from({ length: 125 }, (_, index) => `# Section ${index}\nApple fruit tree orchard harvest.`).join('\n\n')); f.store.rebuild();
    const result = await (await f.indexed()).search(f.store, { query: 'fruit', first: 2, kinds: ['project'] });
    expect(result.hits).toHaveLength(2);
    expect(new Set(result.hits.map(hit => hit.id)).size).toBe(2);
    expect(result.hits[0].score).toBeLessThanOrEqual(1);
    expect(result.hits[0].score).toBeGreaterThan(0.9);
  });

  it('restricts allowed handles before ranking and intersects legacy structural filters', async () => {
    const f = fixture();
    f.writeProject('orchard', Array.from({ length: 125 }, (_, index) => `# Distractor ${index}\nApple fruit tree orchard harvest.`).join('\n\n')); f.store.rebuild();
    const service = await f.indexed();
    const result = await service.search(f.store, { query: 'fruit', first: 1, kinds: ['project'] }, { allowedHandles: ['#project/space'] });
    expect(result.hits.map(hit => hit.handle)).toEqual(['#project/space']);
    expect(result.hits[0].score).toBeLessThan(0.1);
    f.calls.length = 0;
    const disjoint = await service.search(f.store, { query: 'fruit', projects: ['orchard'] }, { allowedHandles: ['#project/space'] });
    expect(disjoint.hits).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('paginates ranked unique records after deduplicating a long document', async () => {
    const f = fixture();
    f.writeProject('orchard', Array.from({ length: 125 }, (_, index) => `# Section ${index}\nApple fruit tree orchard harvest.`).join('\n\n')); f.store.rebuild();
    const service = await f.indexed(); const allowedHandles = ['#project/orchard', '#project/space'];
    const first = await service.search(f.store, { query: 'fruit', first: 1 }, { allowedHandles });
    const next = await service.search(f.store, { query: 'fruit', first: 1 }, { allowedHandles, offset: 1 });
    expect(first.hits.map(hit => hit.handle)).toEqual(['#project/orchard']);
    expect(next.hits.map(hit => hit.handle)).toEqual(['#project/space']);
    f.calls.length = 0;
    expect((await service.search(f.store, { query: 'fruit', first: 1 }, { allowedHandles, offset: 2 })).hits).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('reads already synchronized empty eligible pages while skipping query inference', async () => {
    const f = fixture(); const service = await f.indexed();
    expect((await service.search(f.store, { query: 'fruit' }, { allowedHandles: [] })).hits).toEqual([]);
    expect((await service.search(f.store, { query: 'fruit' }, { allowedHandles: ['#project/missing'] })).hits).toEqual([]);
    expect((await service.search(f.store, { query: 'fruit' }, { offset: Number.MAX_SAFE_INTEGER })).hits).toEqual([]);
    expect(f.calls.flat()).toHaveLength(6);
    expect(f.calls.flat()).not.toContain('fruit');
    for (const offset of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) await expect(service.search(f.store, { query: 'fruit' }, { offset })).rejects.toThrow('safe nonnegative integer');
  });

  it('keeps pagination stable across native top-k ties and picks a deterministic best passage', async () => {
    const f = fixture(); const allowedHandles: string[] = [];
    const ids = Array.from({ length: 300 }, (_, index) => `tied-${String(index).padStart(3, '0')}`);
    for (const id of ids) { f.writeProject(id, `A single passage for ${id}.`); allowedHandles.push(`#project/${id}`); }
    const multiple = 'tied-multiple';
    f.writeProject(multiple, Array.from({ length: 150 }, (_, index) => `# Section ${index}\nA different tied passage ${index}.`).join('\n\n'));
    allowedHandles.push(`#project/${multiple}`);
    writeFileSync(join(f.data, 'projects/2026/index.yaml'), [...ids, multiple].map(id => `- id: ${id}\n  description: Tied score regression`).join('\n'));
    f.store.rebuild();
    const service = await f.indexed({ embedder: fixedGeneration('constant-vectors', async texts => texts.map(() => [1, 1, 1])) });
    const full = await service.search(f.store, { query: 'a query', first: 100 }, { allowedHandles });
    const first = await service.search(f.store, { query: 'a query', first: 20 }, { allowedHandles });
    const next = await service.search(f.store, { query: 'a query', first: 20 }, { allowedHandles, offset: 20 });
    expect(first.hits).toEqual(full.hits.slice(0, 20));
    expect(next.hits).toEqual(full.hits.slice(20, 40));
    expect(new Set([...first.hits, ...next.hits].map(hit => hit.handle)).size).toBe(40);
    const selected = await service.search(f.store, { query: 'a query', first: 1 }, { allowedHandles: [`#project/${multiple}`] });
    const passages = collectDocuments(f.store).filter(document => document.handle === `#project/${multiple}`).flatMap(chunkDocument)
      .sort((a, b) => a.chunkId.localeCompare(b.chunkId));
    expect(selected.hits).toHaveLength(1);
    expect(selected.hits[0].snippet).toBe(passages[0].snippet);
  });

  it('copies caller-owned filters before waiting in the global queue', async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let block = false;
    const followingService = await f.indexed();
    const blocking = f.service({ embedder: fixedGeneration('test-v1', async (texts, options) => {if (block) {entered(); await gate;} return f.embedder.embed(texts, options);}) });
    await blocking.reconcile(f.store); block = true;
    const running = blocking.search(f.store, { query: 'fruit' });
    await started;
    const kinds: Array<'project' | 'entry'> = ['project']; const projects = ['space']; const allowedHandles = ['#project/space'];
    const input = { query: 'fruit', first: 1, kinds, projects }; const options = { allowedHandles, offset: 0 };
    const following = followingService.search(f.store, input, options);
    kinds[0] = 'entry'; projects[0] = 'orchard'; allowedHandles[0] = '#project/orchard'; input.query = 'moon'; options.offset = 100;
    release();
    await running;
    expect((await following).hits.map(hit => hit.handle)).toEqual(['#project/space']);
  });

  it('cancels a queued paginated request before it performs inference', async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let block = false;
    const followingService = await f.indexed();
    const blocking = f.service({ embedder: fixedGeneration('test-v1', async (texts, options) => {if (block) {entered(); await gate;} return f.embedder.embed(texts, options);}) });
    await blocking.reconcile(f.store); block = true;
    const running = blocking.search(f.store, { query: 'fruit' }); await started;
    const controller = new AbortController();
    const queued = followingService.search(f.store, { query: 'moon', first: 1 }, { allowedHandles: ['#project/orchard', '#project/space'], offset: 1, signal: controller.signal });
    controller.abort(new Error('cancelled page'));
    await expect(queued).rejects.toThrow('cancelled page');
    release(); await running;
    expect(f.calls.flat().filter(text => text === 'moon')).toEqual([]);
  });
});

describe('chunking and lexical ranking', () => {
  it('bounds passages, preserves heading context and gives exact terms a BM25 ranking', () => {
    const chunks = chunkDocument({ kind: 'project', id: 'test', handle: '#project/test', name: 'Test', description: 'Description', created: '2026-01-01', projects: [], content: `# Long section\n${'apples '.repeat(1000)}\n# Next\nrare-code-123` });
    expect(chunks.every(chunk => chunk.text.length < 3500)).toBe(true);
    expect(chunks[1].snippet.startsWith('# Long section')).toBe(true);
    expect(lexicalRanking(chunks, 'rare-code-123', 1)[0].chunkId).toBe(chunks.at(-1)?.chunkId);
  });
});
