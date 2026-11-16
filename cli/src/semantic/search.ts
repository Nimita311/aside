import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Connection, Table } from '@lancedb/lancedb';
import type { Store } from '../source/store.js';
import { daemonPaths } from '../daemon/paths.js';
import { OllamaEmbedder, SemanticSetupError, validateVectors, type SemanticEmbedder, type SemanticEmbeddingGeneration } from './embedding.js';
import { CHUNKER_VERSION, chunkDocument, collectDocuments, hashText, lexicalRanking, type SemanticKind, type SearchChunk } from './documents.js';
import { assertSearchSourceReadable, searchSourceVersion } from './source-version.js';
import { writeFileCrashSafe } from '../storage/atomic-file.js';
import type {SemanticIndexSnapshot} from './types.js';
import {abortable} from '../core/async.js';

export interface SemanticSearchInput {
  query: string; first?: number; kinds?: SemanticKind[]; projects?: string[]; from?: string; to?: string;
}
export interface SemanticHit {
  kind: SemanticKind; id: string; handle: string; name: string; description: string; snippet: string; score: number;
}
export interface SemanticSearchResult { model: string; indexedChunks: number; hits: SemanticHit[] }
export interface SemanticSearchRequestOptions {
  signal?: AbortSignal;
  /** Saved record handles selected by the caller's structural predicates. */
  allowedHandles?: readonly string[];
  /** Skip this many ranked unique source records, after structural filtering. */
  offset?: number;
}
export interface SemanticSearchOptions {
  embedder?: SemanticEmbedder;
  /** Parent directory; indexes are isolated by source path, model weights and chunker version. */
  indexRoot?: string;
  batchSize?: number;
  /** Evaluation hook. Public search defaults to dense semantic retrieval. */
  retrievalMode?: 'hybrid' | 'semantic';
}
interface OpenIndex { location: string; connection: Connection; table?: Table; dimension?: number }
interface CompletedIndex {
  sourceVersion: string;
  identity: string;
  generation: SemanticEmbeddingGeneration;
  chunks: SearchChunk[];
  index: OpenIndex;
  version: number;
}
interface IndexCertificate {
  format: 1;
  sourceVersion: string;
  identity: string;
  version: number;
  indexedChunks: number;
}
const CERTIFICATE = 'snapshot.json';

/** Alias-based indexes cannot prove that every stored vector used its digest.
 * A separate namespace establishes the pinned-generation contract on upgrade. */
export function semanticIndexGenerationKey(identity: string): string {
  return hashText(`pinned-generation-v1\n${identity}\n${CHUNKER_VERSION}`);
}

/** Retrieval never repairs an index. Its instance lifecycle can schedule repair
 * when the loaded source and the last completed durable snapshot disagree. */
export class SemanticIndexNotCurrentError extends Error {
  constructor(message = 'Semantic index is not current for the loaded instance. Wait for instance synchronization, then retry.') {
    super(message);
    this.name = 'SemanticIndexNotCurrentError';
  }
}
// All services in the process share one mutation queue. A rejected/cancelled job
// releases it without poisoning later requests, including another instance.
let queue: Promise<unknown> = Promise.resolve();
const indexCaches = new Set<Map<string, OpenIndex>>();
const completedCaches = new Set<Map<string, CompletedIndex>>();

function invalidateCompletedSnapshots(location: string): void {
  const root = resolve(location);
  for (const cache of completedCaches) for (const [instance, snapshot] of cache) {
    if (snapshot.index.location === root || snapshot.index.location.startsWith(root + sep)) cache.delete(instance);
  }
}

/** Serialize maintenance with all native readers and writers in this process.
 * Production cache access belongs to the daemon holding its lifetime lock. */
export function withSemanticCacheAccess<T>(work: () => Promise<T>): Promise<T> {
  const task = queue.then(work);
  queue = task.catch(() => {});
  return task;
}

/** Call only inside withSemanticCacheAccess, before removing cache files. */
export function closeSemanticCacheHandles(instanceLocation: string): void {
  const root = resolve(instanceLocation);
  invalidateCompletedSnapshots(root);
  for (const cache of indexCaches) for (const [location, index] of cache) {
    if (location !== root && !location.startsWith(root + sep)) continue;
    index.table?.close(); index.connection.close();
    cache.delete(location);
  }
}

const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const cosineScore = (distance: number): number => Math.max(-1, Math.min(1, 1 - distance));

function validateInput(input: SemanticSearchInput): number {
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 4000) throw new Error('Semantic query must contain 1–4000 characters.');
  const first = input.first ?? 20;
  if (!Number.isInteger(first) || first < 1 || first > 100) throw new Error('Semantic first must be an integer between 1 and 100.');
  if (input.kinds && (!Array.isArray(input.kinds) || input.kinds.some(kind => !['entry', 'project', 'action', 'artifact'].includes(kind)))) throw new Error('Unknown semantic search kind.');
  if (input.projects && (!Array.isArray(input.projects) || input.projects.length > 100 || input.projects.some(project => typeof project !== 'string' || !project || project.length > 300))) throw new Error('Semantic projects must contain at most 100 project IDs.');
  for (const value of [input.from, input.to]) if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value) || !Number.isFinite(Date.parse(value)))) throw new Error('Semantic date filters must be ISO dates or timestamps.');
  if (input.from && input.to && input.from > input.to) throw new Error('Semantic from must be before to.');
  return first;
}

function eligible(chunk: SearchChunk, input: SemanticSearchInput): boolean {
  if (input.kinds?.length && !input.kinds.includes(chunk.kind)) return false;
  if (input.projects?.length) {
    const memberships = JSON.parse(chunk.projects) as string[];
    if (!input.projects.some(id => memberships.includes(id.replace(/^#project\//, '')))) return false;
  }
  if (input.from && chunk.created < input.from) return false;
  const upper = input.to?.length === 10 ? `${input.to}T\uffff` : input.to;
  return !upper || chunk.created <= upper;
}

export class SemanticSearchService {
  private readonly embedder: SemanticEmbedder;
  private readonly indexRoot?: string;
  private readonly batchSize: number;
  private readonly mode: 'hybrid' | 'semantic';
  private readonly indexes = new Map<string, OpenIndex>();
  private readonly completed = new Map<string, CompletedIndex>();
  private readonly lifetime = new AbortController();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: SemanticSearchOptions = {}) {
    this.embedder = options.embedder ?? new OllamaEmbedder();
    this.indexRoot = options.indexRoot;
    this.batchSize = options.batchSize ?? 16;
    this.mode = options.retrievalMode ?? 'semantic';
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 64) throw new Error('Semantic embedding batch size must be between 1 and 64.');
    indexCaches.add(this.indexes);
    completedCaches.add(this.completed);
  }

  async search(store: Store, input: SemanticSearchInput, options: SemanticSearchRequestOptions = {}): Promise<SemanticSearchResult> {
    const first = validateInput(input);
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Semantic offset must be a safe nonnegative integer.');
    if (options.allowedHandles !== undefined && (!Array.isArray(options.allowedHandles) || options.allowedHandles.length > 1_000_000 || options.allowedHandles.some(handle => typeof handle !== 'string' || !handle || handle.length > 1000))) {
      throw new Error('Semantic allowedHandles must contain at most one million nonempty record handles.');
    }
    // Requests can queue behind another instance's index mutation. Snapshot all
    // caller-owned filters now, so later mutation cannot change this request.
    const savedInput: SemanticSearchInput = { ...input, kinds: input.kinds ? [...input.kinds] : undefined, projects: input.projects ? [...input.projects] : undefined };
    const allowed = options.allowedHandles === undefined ? undefined : new Set(options.allowedHandles);
    return this.queued(store, options.signal, (signal, sourceVersion) => this.execute(store, savedInput, first, signal, sourceVersion, allowed, offset));
  }

  /** Refresh saved document vectors without embedding a query or applying search filters. */
  async reconcile(store: Store, options: {signal?: AbortSignal} = {}): Promise<SemanticIndexSnapshot> {
    return this.queued(store, options.signal, async (signal, sourceVersion) => {
      const {chunks, finish} = await this.synchronize(store, signal, sourceVersion);
      await finish();
      return {sourceVersion, model: this.embedder.model, indexedChunks: chunks.length};
    });
  }

  /** Queue work against the source version loaded now. An abort releases the
   * caller without waiting for the queue. */
  private queued<T>(store: Store, requested: AbortSignal | undefined, work: (signal: AbortSignal, sourceVersion: string) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.lifetime.signal, ...(requested ? [requested] : [])]);
    signal.throwIfAborted();
    const sourceVersion = searchSourceVersion(store);
    const task = withSemanticCacheAccess(() => work(signal, sourceVersion));
    this.pending = task.catch(() => {});
    return abortable(task, signal);
  }

  private instanceLocation(store: Store): string {
    return resolve(this.indexRoot ?? join(daemonPaths().state, 'search'), hashText(store.getDataDir()));
  }

  private async openChunks(connection: Connection): Promise<Table | undefined> {
    try { return await connection.openTable('chunks'); }
    catch (error) {
      // Native discovery can list a chunks.lance directory whose initial write
      // never committed a manifest. Treat it as uncommitted, then invalidate
      // removes the generation before another model call or table creation.
      if (error instanceof Error && error.message.startsWith("Table 'chunks' was not found")) return undefined;
      throw error;
    }
  }

  /** Bind the committed chunks table, if any, and learn its vector dimension. */
  private async bindChunks(index: OpenIndex): Promise<void> {
    if (!(await index.connection.tableNames()).includes('chunks')) return;
    index.table = await this.openChunks(index.connection);
    if (!index.table) return;
    const rows = await index.table.query().select(['vector']).limit(1).toArray();
    if (rows.length) index.dimension = rows[0].vector.length;
  }

  private async chunkIds(table: Table): Promise<Set<string>> {
    return new Set<string>((await table.query().select(['chunkId']).toArray()).map(row => row.chunkId));
  }

  /** Vectors this generation already stores for the batch's texts, by embedding hash. */
  private async savedVectors(table: Table, batch: SearchChunk[]): Promise<Map<string, number[]>> {
    const reused = await table.query().where(`"embeddingHash" IN (${[...new Set(batch.map(chunk => chunk.embeddingHash))].map(sqlString).join(',')})`).select(['embeddingHash', 'vector']).toArray();
    return new Map<string, number[]>(reused.map(row => [row.embeddingHash, Array.from(row.vector as Iterable<number>)]));
  }

  private async openLocation(location: string, create: boolean): Promise<OpenIndex> {
    let index = this.indexes.get(location);
    if (index) {
      // Another service in this process may have committed to the same table.
      if (!index.table) await this.bindChunks(index);
      await index.table?.checkoutLatest();
      return index;
    }
    let lance: typeof import('@lancedb/lancedb');
    try { lance = await import('@lancedb/lancedb'); }
    catch {
      const unsupported = process.platform === 'darwin' && process.arch === 'x64';
      throw new SemanticSetupError(unsupported
        ? 'Semantic search requires Apple Silicon on macOS: the current LanceDB release does not provide an Intel Mac binary. Regex search remains available.'
        : 'Local semantic index support is unavailable. Rebuild or reinstall the Aside CLI with its LanceDB native sidecar.', {
          reason: unsupported ? 'UNSUPPORTED_PLATFORM' : 'INDEX_UNAVAILABLE', model: this.embedder.model,
          recovery: unsupported ? 'Use a supported Apple Silicon build for semantic ranking; field ordering and regex remain available.' : 'Rebuild or reinstall the Aside CLI with its LanceDB native sidecar.',
        });
    }
    if (create) await mkdir(location, { recursive: true, mode: 0o700 });
    const connection = await lance.connect(location);
    index = { location, connection };
    try { await this.bindChunks(index); }
    catch (error) { connection.close(); throw error; }
    this.indexes.set(location, index);
    return index;
  }

  private async generationLocations(store: Store, stable: () => void): Promise<string[]> {
    stable();
    const location = this.instanceLocation(store);
    let entries;
    try { entries = await readdir(location, {withFileTypes: true}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    // Retired directories may contain only part of a native table after a
    // failed deletion or crash. Finish removing them before opening any table.
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\.retired-[0-9a-f]{64}$/.test(entry.name)) continue;
      stable();
      const retired = join(location, entry.name);
      closeSemanticCacheHandles(retired);
      await rm(retired, {recursive: true, force: true});
      stable();
    }
    return entries.filter(entry => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name)).map(entry => join(location, entry.name));
  }

  private async removeGeneration(location: string, stable: () => void): Promise<void> {
    stable();
    closeSemanticCacheHandles(location);
    // Publish retirement atomically before unlinking native files. A damaged
    // partial deletion must never be interpreted as a live index on retry.
    const retired = join(dirname(location), `.retired-${basename(location)}`);
    try { await rename(location, retired); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      stable();
      return;
    }
    stable();
    await rm(retired, {recursive: true, force: true});
    stable();
  }

  private async prepareMutation(index: OpenIndex, stable: () => void): Promise<void> {
    stable();
    // Known lifecycle writes invalidate published bindings before changing or
    // pruning native storage. Readers need not rediscover those changes.
    invalidateCompletedSnapshots(index.location);
    // Native writes can create files and fail before publishing a new version.
    // Invalidate first so even an unchanged committed version gets scrubbed.
    await rm(join(index.location, 'live.version'), {force: true});
    await rm(join(index.location, CERTIFICATE), {force: true});
    stable();
  }

  private async cleanVersion(index: OpenIndex): Promise<number | undefined> {
    try {
      const saved = await readFile(join(index.location, 'live.version'), 'utf8');
      if (/^[1-9][0-9]*\n?$/.test(saved) && Number.isSafeInteger(Number(saved))) return Number(saved);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return undefined;
  }

  private async certificate(location: string): Promise<IndexCertificate | undefined> {
    let saved: string;
    try { saved = await readFile(join(location, CERTIFICATE), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (saved.length > 4096) return;
    let value: Partial<IndexCertificate>;
    try { value = JSON.parse(saved); } catch { return; }
    if (!value || value.format !== 1 || typeof value.sourceVersion !== 'string' || typeof value.identity !== 'string'
      || !Number.isSafeInteger(value.version) || value.version! < 1 || !Number.isSafeInteger(value.indexedChunks)
      || value.indexedChunks! < 1 || value.indexedChunks! > 1_000_000) return;
    return value as IndexCertificate;
  }

  /** Atomic overwrite removes tombstoned data even below Lance's compaction
   * thresholds. Pruning then removes the historical files. The checkpoint is
   * published last, so an interrupted write or cleanup is retried on reopen. */
  private async maintain(index: OpenIndex, stable: () => void, recover: boolean): Promise<void> {
    if (!index.table) { await this.removeGeneration(index.location, stable); return; }
    stable();
    const version = await index.table.version();
    const cleanVersion = await this.cleanVersion(index);
    stable();
    if (cleanVersion === version) return;
    if (!await index.table.countRows()) { await this.removeGeneration(index.location, stable); return; }
    await this.prepareMutation(index, stable);
    if (recover) {
      const live = await index.table.query().toArrow();
      stable();
      await index.table.add(live, {mode: 'overwrite'});
      stable();
    }
    for (let attempt = 0; ; attempt++) {
      const current = await index.table.version();
      const versions = await index.table.listVersions();
      const committed = versions.find(item => item.version === current);
      if (!committed) throw new Error('Semantic index current storage version is missing. Retry maintenance.');
      stable();
      // Date truncates native timestamp precision. One millisecond beyond this
      // committed version prunes it if optimize replaces it; the latest version
      // is always retained. This is a commit boundary, not an age-based policy.
      await index.table.optimize({cleanupOlderThan: new Date(committed.timestamp.getTime() + 1), deleteUnverified: true});
      stable();
      if ((await index.table.listVersions()).length === 1) break;
      // Compaction can itself publish intermediate versions newer than the
      // original cutoff. Prune those on the next pass before checkpointing.
      if (attempt >= 2) throw new Error('Semantic index historical storage could not be reclaimed. Retry maintenance.');
    }
    const cleaned = await index.table.version();
    writeFileCrashSafe(join(index.location, 'live.version'), `${cleaned}\n`, index.location);
    stable();
  }

  /** Copy reusable vectors inside this same generation, then remove old source rows.
   * This happens before any model call so deletions do not depend on Ollama.
   * It never copies a vector between model/chunker generation directories. */
  private async invalidate(index: OpenIndex, chunks: SearchChunk[], stable: () => void): Promise<void> {
    if (!index.table) { await this.removeGeneration(index.location, stable); return; }
    stable();
    const existing = await this.chunkIds(index.table);
    const current = new Set(chunks.map(chunk => chunk.chunkId));
    const missing = chunks.filter(chunk => !existing.has(chunk.chunkId));
    let prepared = false;
    for (let start = 0; start < missing.length; start += this.batchSize) {
      stable();
      const batch = missing.slice(start, start + this.batchSize);
      const byText = await this.savedVectors(index.table, batch);
      const matching = batch.filter(chunk => byText.has(chunk.embeddingHash));
      if (!matching.length) continue;
      const vectors = validateVectors(matching.map(chunk => byText.get(chunk.embeddingHash)), matching.length, index.dimension);
      if (!prepared) { await this.prepareMutation(index, stable); prepared = true; }
      stable();
      await index.table.add(matching.map((chunk, offset) => ({...chunk, vector: vectors[offset]})));
      stable();
    }
    const obsolete = [...existing].filter(id => !current.has(id));
    for (let start = 0; start < obsolete.length; start += 500) {
      if (!prepared) { await this.prepareMutation(index, stable); prepared = true; }
      stable();
      await index.table.delete(`"chunkId" IN (${obsolete.slice(start, start + 500).map(sqlString).join(',')})`);
      stable();
    }
    await this.maintain(index, stable, true);
  }

  private async synchronize(store: Store, signal: AbortSignal, sourceVersion: string) {
    const stable = () => {
      signal.throwIfAborted();
      assertSearchSourceReadable(store);
      if (searchSourceVersion(store) !== sourceVersion) throw new Error('Aside changed while semantic search was indexing. Retry to search the latest content; completed batches are saved.');
    };
    stable();
    const instance = this.instanceLocation(store);
    const generations = await this.generationLocations(store, stable);
    const previous = this.completed.get(instance);
    let generation: SemanticEmbeddingGeneration | undefined;
    // A source fingerprint is meaningful across Store rebuilds. Reuse only a
    // completed table whose durable certificate, native version and cleanup
    // checkpoint still match. Out-of-band drift is checked here, not by readers.
    if (previous?.sourceVersion === sourceVersion && generations.length === 1
      && generations[0] === previous.index.location && this.indexes.get(generations[0]) === previous.index) {
      const index = await this.openLocation(generations[0], false);
      stable();
      const version = await index.table?.version();
      const certificate = await this.certificate(index.location);
      stable();
      if (version === previous.version && await this.cleanVersion(index) === version
        && certificate?.sourceVersion === sourceVersion && certificate.identity === previous.identity
        && certificate.version === version && certificate.indexedChunks === previous.chunks.length) {
        stable();
        generation = await this.embedder.resolveGeneration({signal});
        stable();
        if (generation.identity === previous.identity) return this.synchronized(store, sourceVersion, generation,
          previous.chunks, index, version, stable);
      }
    }
    this.completed.delete(instance);
    const chunks = collectDocuments(store).flatMap(chunkDocument);
    if (chunks.length > 1_000_000) throw new Error('Semantic corpus exceeds one million chunks. Split the instance before indexing.');
    // No model or native table open is needed to remove an empty corpus.
    if (!chunks.length) {
      for (const location of generations) await this.removeGeneration(location, stable);
      return {chunks, index: undefined, stable, finish: async () => { stable(); }};
    }
    for (const location of generations) {
      stable();
      const index = await this.openLocation(location, false);
      stable();
      await this.invalidate(index, chunks, stable);
    }
    stable();
    generation ??= await this.embedder.resolveGeneration({signal});
    stable();
    const identity = generation.identity;
    const location = join(this.instanceLocation(store), semanticIndexGenerationKey(identity));
    const index = await this.openLocation(location, true);
    stable();
    const existing = index.table ? await this.chunkIds(index.table) : new Set<string>();
    const missing = chunks.filter(chunk => !existing.has(chunk.chunkId));
    for (let start = 0; start < missing.length; start += this.batchSize) {
      stable();
      const batch = missing.slice(start, start + this.batchSize);
      const byText = index.table ? await this.savedVectors(index.table, batch) : new Map<string, number[]>();
      const needed = [...new Map(batch.filter(chunk => !byText.has(chunk.embeddingHash)).map(chunk => [chunk.embeddingHash, chunk])).values()];
      if (needed.length) {
        const fresh = validateVectors(await generation.embed(needed.map(chunk => chunk.text), { signal }), needed.length, index.dimension);
        stable();
        needed.forEach((chunk, offset) => byText.set(chunk.embeddingHash, fresh[offset]));
      }
      const vectors = validateVectors(batch.map(chunk => byText.get(chunk.embeddingHash)), batch.length, index.dimension);
      stable();
      index.dimension ??= vectors[0].length;
      const rows = batch.map((chunk, offset) => ({ ...chunk, vector: vectors[offset] }));
      if (start === 0) await this.prepareMutation(index, stable);
      if (index.table) await index.table.add(rows);
      else index.table = await index.connection.createTable('chunks', rows);
      stable();
    }
    // A completed marker is returned only after every document batch and the
    // final source checks. Every batch uses the same pinned model generation.
    // Partial batches remain resumable on failure.
    await this.maintain(index, stable, false);
    // The selected generation is complete before any fallback/resumable state
    // from previous model or chunker generations is discarded.
    const superseded = generations.filter(previous => previous !== location);
    for (const previous of superseded) await this.removeGeneration(previous, stable);
    return this.synchronized(store, sourceVersion, generation, chunks, index, await index.table!.version(), stable);
  }

  private synchronized(store: Store, sourceVersion: string, generation: SemanticEmbeddingGeneration,
    chunks: SearchChunk[], index: OpenIndex, version: number, stable: () => void) {
    const identity = generation.identity;
    return {chunks, index, stable, finish: async () => {
      stable();
      const certificate: IndexCertificate = {format: 1, sourceVersion, identity, version, indexedChunks: chunks.length};
      const saved = await this.certificate(index.location);
      stable();
      if (!saved || JSON.stringify(saved) !== JSON.stringify(certificate)) {
        writeFileCrashSafe(join(index.location, CERTIFICATE), `${JSON.stringify(certificate)}\n`, index.location);
      }
      stable();
      this.completed.set(this.instanceLocation(store), {sourceVersion, identity, generation, chunks, index, version});
    }};
  }

  /** Read the lifecycle's published binding. Durable validation and recovery
   * belong to reconciliation; nominal queries only check loaded memory. */
  private retrieval(store: Store, signal: AbortSignal, sourceVersion: string) {
    const stable = () => {
      signal.throwIfAborted();
      if (searchSourceVersion(store) !== sourceVersion) throw new Error('Aside changed while semantic search was running. Retry to search the latest loaded snapshot.');
    };
    stable();
    if (!store.getEntries().length && !store.getProjects().size && !store.getActions().size && !store.getArtifacts().size) {
      return {chunks: [] as SearchChunk[], index: undefined, generation: undefined, stable};
    }
    // Lifecycle resolution binds actual weights to this completed index. A
    // missing/evicted binding must be restored by lifecycle reconciliation.
    const snapshot = this.completed.get(this.instanceLocation(store));
    if (!snapshot || snapshot.sourceVersion !== sourceVersion) throw new SemanticIndexNotCurrentError();
    const {generation, index} = snapshot;
    if (!index.table || this.indexes.get(index.location) !== index || generation.identity !== snapshot.identity) throw new SemanticIndexNotCurrentError();
    return {chunks: snapshot.chunks, index, generation, stable};
  }

  private async execute(store: Store, input: SemanticSearchInput, first: number, signal: AbortSignal, sourceVersion: string, allowed: ReadonlySet<string> | undefined, offset: number): Promise<SemanticSearchResult> {
    const {chunks, index, generation, stable} = this.retrieval(store, signal, sourceVersion);
    const candidates = input.kinds?.length === 0 || input.projects?.length === 0 ? []
      : chunks.filter(chunk => (!allowed || allowed.has(chunk.handle)) && eligible(chunk, input));
    const handles = [...new Set(candidates.map(chunk => chunk.handle))];
    if (!candidates.length || !index?.table || offset >= handles.length) {
      stable();
      return {model: this.embedder.model, indexedChunks: chunks.length, hits: []};
    }
    const prefix = Math.min(offset + first, handles.length);
    if (!generation) throw new SemanticIndexNotCurrentError();
    const [vector] = validateVectors(generation.embedQuery ? [await generation.embedQuery(input.query, { signal })] : await generation.embed([input.query], { signal }), 1, index.dimension);
    stable();
    let candidateCount = Math.min(Math.max(prefix * 8, 100), candidates.length);
    const byId = new Map(candidates.map(chunk => [chunk.chunkId, chunk]));
    let dense: Array<{ chunkId: string; _distance: number }>;
    for (;;) {
      let query = index.table.vectorSearch(vector).distanceType('cosine').select(['chunkId', '_distance']).limit(candidateCount);
      // Prefilter happens in LanceDB before nearest-neighbor top-k. Project
      // membership is derived by Aside, not inferred from embedding text.
      if (candidates.length !== chunks.length) query = query.where(`handle IN (${handles.map(sqlString).join(',')})`);
      dense = await query.toArray();
      stable();
      if (candidateCount === candidates.length) break;
      // Native top-k may choose any subset of equal-distance rows. Retrieve
      // every tie at the requested unique-record boundary before applying our
      // deterministic passage order; otherwise changing page size or offset
      // can change earlier pages or repeat records across pages.
      const seen = new Set<string>(); let boundary: number | undefined;
      const ranked = dense.map(row => ({ ...row, score: cosineScore(row._distance) }))
        .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
      for (const row of ranked) {
        const handle = byId.get(row.chunkId)?.handle;
        if (!handle || seen.has(handle)) continue;
        seen.add(handle);
        if (seen.size === prefix) { boundary = row.score; break; }
      }
      if (boundary !== undefined && dense.length && cosineScore(dense[dense.length - 1]._distance) < boundary) break;
      // One long document must not crowd other source records out of top-k;
      // a large equal-score group also has to be fetched in full.
      candidateCount = Math.min(candidateCount * 2, candidates.length);
    }
    const lexical = this.mode === 'hybrid' ? lexicalRanking(candidates, input.query, candidateCount) : [];
    const fused = new Map<string, number>();
    if (this.mode === 'semantic') for (const row of dense) fused.set(row.chunkId, cosineScore(row._distance));
    else for (const ranking of [dense, lexical]) ranking.forEach((row, rank) => fused.set(row.chunkId, (fused.get(row.chunkId) ?? 0) + 1 / (60 + rank + 1)));
    const hits: SemanticHit[] = []; const seen = new Set<string>();
    for (const [id, score] of [...fused].sort(([idA, a], [idB, b]) => b - a || idA.localeCompare(idB))) {
      const chunk = byId.get(id); if (!chunk || seen.has(chunk.handle)) continue;
      seen.add(chunk.handle);
      hits.push({ kind: chunk.kind, id: chunk.id, handle: chunk.handle, name: chunk.name, description: chunk.description, snippet: chunk.snippet, score });
      if (hits.length === prefix) break;
    }
    stable();
    return { model: this.embedder.model, indexedChunks: chunks.length, hits: hits.slice(offset, offset + first) };
  }

  async close(): Promise<void> {
    this.lifetime.abort(new Error('Semantic search service is closed.'));
    await this.pending;
    for (const index of this.indexes.values()) { index.table?.close(); index.connection.close(); }
    this.indexes.clear();
    this.completed.clear();
    indexCaches.delete(this.indexes);
    completedCaches.delete(this.completed);
  }
}
