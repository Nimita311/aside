import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir, cpus, totalmem, release, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Store } from '../src/source/store.js';
import { RegexWorkerPool } from '../src/mcp/search.js';
import { SemanticSearchService } from '../src/semantic/search.js';
import { OllamaEmbedder, type SemanticEmbedder, type SemanticEmbeddingGeneration, type EmbeddingOptions } from '../src/semantic/embedding.js';
import { collectDocuments, chunkDocument } from '../src/semantic/documents.js';
import { writeSemanticFixture, type SemanticCase } from './semantic-fixture.js';

const { values } = parseArgs({ options: {
  models: { type: 'string', default: 'qwen3-embedding:0.6b,bge-m3' },
  url: { type: 'string', default: 'http://127.0.0.1:11434' },
  size: { type: 'string', default: '300' }, repeats: { type: 'string', default: '2' },
  output: { type: 'string' }, keep: { type: 'boolean', default: false },
} });
const size = Number(values.size), repeats = Number(values.repeats);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be 1–20.');
const root = mkdtempSync(join(tmpdir(), 'aside-semantic-bench-'));
const fixture = writeSemanticFixture(join(root, 'data'), size);
const store = new Store(join(root, 'data'));
if (store.getIssues().some(issue => issue.severity === 'error')) throw new Error(`Invalid fixture: ${JSON.stringify(store.getIssues())}`);
const documents = collectDocuments(store).sort((a, b) => b.created.localeCompare(a.created) || a.handle.localeCompare(b.handle));
if (documents.length !== size) throw new Error(`Fixture expected ${size} records, loaded ${documents.length}.`);
const chunks = documents.flatMap(chunkDocument);
const regex = new RegexWorkerPool({ workerUrl: new URL('./regex-worker.js', import.meta.url) });
const now = () => performance.now();
const mib = (bytes: number) => bytes / 1024 / 1024;
const round = (value: number) => Math.round(value * 1000) / 1000;
const quantile = (samples: number[], fraction: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};
const latency = (samples: number[]) => ({ samples: samples.length, p50Ms: round(quantile(samples, 0.5)), p95Ms: round(quantile(samples, 0.95)) });
const mean = (samples: number[]) => samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
function metrics(handles: string[], test: SemanticCase) {
  const gains = handles.map(handle => test.relevance[handle] ?? 0);
  const relevant = Object.keys(test.relevance).length;
  const recall = (k: number) => handles.slice(0, k).filter(handle => (test.relevance[handle] ?? 0) > 0).length / relevant;
  const dcg = (numbers: number[]) => numbers.reduce((sum, gain, rank) => sum + (2 ** gain - 1) / Math.log2(rank + 2), 0);
  const ideal = dcg(Object.values(test.relevance).sort((a, b) => b - a).slice(0, 10));
  const rank = gains.findIndex(gain => gain > 0);
  return { recall5: recall(5), recall10: recall(10), reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1), ndcg10: dcg(gains.slice(0, 10)) / ideal };
}
interface QueryResult { id: string; category: string; query: string; regex?: string; handles: string[]; metrics: ReturnType<typeof metrics>; latencyMs: number[] }
function summarize(results: QueryResult[]) {
  const group = (items: QueryResult[]) => ({ queries: items.length,
    recall5: round(mean(items.map(item => item.metrics.recall5))), recall10: round(mean(items.map(item => item.metrics.recall10))),
    mrr10: round(mean(items.map(item => item.metrics.reciprocalRank))), ndcg10: round(mean(items.map(item => item.metrics.ndcg10))),
    latency: latency(items.flatMap(item => item.latencyMs)),
  });
  return { all: group(results), paraphrase: group(results.filter(item => item.category === 'paraphrase')), exact: group(results.filter(item => item.category === 'exact')) };
}
class MeasuredEmbedder implements SemanticEmbedder {
  readonly model: string;
  private generationIdentity?: string;
  calls: Array<{ texts: number; characters: number; ms: number }> = [];
  constructor(readonly inner: OllamaEmbedder) { this.model = inner.model; }
  async resolveGeneration(options?: EmbeddingOptions): Promise<SemanticEmbeddingGeneration> {
    const generation = await this.inner.resolveGeneration(options);
    if (this.generationIdentity !== undefined && generation.identity !== this.generationIdentity) {
      throw new Error('Embedding model generation changed during the benchmark. Rerun with a stable model.');
    }
    this.generationIdentity = generation.identity;
    return {
      model: generation.model, identity: generation.identity,
      embed: async (texts, request) => {
        const start = now(); const vectors = await generation.embed(texts, request);
        this.calls.push({texts: texts.length,characters: texts.reduce((sum,text) => sum+text.length,0),ms: now()-start});
        return vectors;
      },
      embedQuery: async (query, request) => {
        const start = now(); const vector = generation.embedQuery ? await generation.embedQuery(query,request) : (await generation.embed([query],request))[0];
        this.calls.push({texts: 1,characters: query.length,ms: now()-start});
        return vector;
      },
    };
  }
  snapshot() { return { calls: this.calls.length, texts: this.calls.reduce((sum, call) => sum + call.texts, 0), ms: this.calls.reduce((sum, call) => sum + call.ms, 0) }; }
}
function directoryBytes(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? directoryBytes(join(directory, entry.name)) : statSync(join(directory, entry.name)).size), 0);
}
function modelAllocation(models: Array<{digest?: string; size?: number; size_vram?: number; context_length?: number}> | undefined, identity: string) {
  const digest = identity.match(/@([0-9a-f]{64})(?:\n|$)/)?.[1];
  return models?.find(item => typeof item.digest === 'string' && item.digest.replace(/^sha256:/, '').toLowerCase() === digest);
}
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${values.url!.replace(/\/$/, '')}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Ollama ${path}: HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function main() {
  const output: Record<string, any> = {
    system: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, ramGiB: totalmem() / 1024 ** 3, node: process.version },
    fixture: { records: documents.length, chunks: chunks.length, characters: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0), queries: fixture.cases.length, repeats, relevanceGrades: { entry: 3, action: 2, project: 1 } },
    method: { regex: 'Hand-authored case-insensitive regex; matches name/description/body; boolean matches ordered newest created then handle. Patterns supplied beside every query.', semantic: 'Real production SemanticSearchService, explicitly selected dense mode (production default), warm local Ollama model; evaluation-only hybrid BM25+dense RRF comparator; no answer generation or reranking. Production embedQuery hook preserves model instructions. Each query embeds on every repetition.', percentiles: 'Nearest rank; single client sequential; first search includes index construction and one query.', memory: 'Node RSS sampled every 20ms during each model run. Ollama /api/ps model allocation reported separately; not total machine peak.', quality: 'Authored synthetic corpus and relevance judgments; quality is a smoke test, not an independent corpus benchmark.' },
    sourceHashes: Object.fromEntries(['src/semantic/search.ts', 'src/semantic/documents.ts', 'src/semantic/embedding.ts', 'bench/semantic-fixture.ts'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    lancedbVersion: JSON.parse(readFileSync('node_modules/@lancedb/lancedb/package.json', 'utf8')).version,
    ollamaVersion: await api('/api/version'), models: [],
  };
  const texts = documents.map(document => [document.name, document.description, document.content]);
  // Start the worker before measuring steady-state latency.
  await regex.match('warmup', [['warmup']]);
  const baseline: QueryResult[] = [];
  for (const test of fixture.cases) {
    let handles: string[] = []; const samples: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
      const start = now(); const matches = await regex.match(test.regex, texts); samples.push(now() - start);
      handles = matches.slice(0, 10).map(index => documents[index].handle);
    }
    baseline.push({ id: test.id, category: test.category, query: test.query, regex: test.regex, handles, metrics: metrics(handles, test), latencyMs: samples.map(round) });
  }
  output.regex = { summary: summarize(baseline), results: baseline };
  console.log(`Regex: ${JSON.stringify(output.regex.summary)}`);
  for (const model of values.models!.split(',').map(value => value.trim()).filter(Boolean)) {
    console.log(`Benchmarking ${model}: ${size} records, ${fixture.cases.length} queries × ${repeats}`);
    const embedder = new MeasuredEmbedder(new OllamaEmbedder({ model, url: values.url, timeoutMs: 120_000 }));
    const modelStart = now();
    const generation = await embedder.resolveGeneration();
    const warmVectors = await generation.embed(['A disposable benchmark warm-up sentence.']);
    const modelLoadMs = now() - modelStart;
    const identity = generation.identity;
    embedder.calls = [];
    const indexRoot = join(root, 'indexes', model.replace(/[^a-zA-Z0-9_-]/g, '-'));
    mkdirSync(indexRoot, { recursive: true });
    let service = new SemanticSearchService({ embedder, indexRoot, batchSize: 16, retrievalMode: 'semantic' });
    const startingRss = process.memoryUsage().rss; let peakRss = startingRss;
    const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    try {
      const coldStart = now();
      await service.reconcile(store);
      const first = await service.search(store, { query: 'Prepare a useful summary of the recent decisions.', first: 10 }); const firstSearchMs = now() - coldStart;
      const coldEmbedding = embedder.snapshot();
      const results: QueryResult[] = [];
      for (const test of fixture.cases) {
        let handles: string[] = []; const samples: number[] = [];
        for (let repeat = 0; repeat < repeats; repeat++) {
          const start = now(); const result = await service.search(store, { query: test.query, first: 10 }); samples.push(now() - start);
          handles = result.hits.map(hit => hit.handle);
        }
        results.push({ id: test.id, category: test.category, query: test.query, handles, metrics: metrics(handles, test), latencyMs: samples.map(round) });
      }
      // Reuse the same stored vectors to isolate fusion quality from embedding
      // model and indexing differences. This hook is not a public API mode.
      const hybridService = new SemanticSearchService({ embedder, indexRoot, batchSize: 16, retrievalMode: 'hybrid' });
      const hybridResults: QueryResult[] = [];
      try {
        await hybridService.reconcile(store);
        await hybridService.search(store, { query: 'Hybrid retrieval warm-up.', first: 10 });
        for (const test of fixture.cases) {
          let handles: string[] = []; const samples: number[] = [];
          for (let repeat = 0; repeat < repeats; repeat++) {
            const start = now(); const result = await hybridService.search(store, { query: test.query, first: 10 }); samples.push(now() - start);
            handles = result.hits.map(hit => hit.handle);
          }
          hybridResults.push({ id: test.id, category: test.category, query: test.query, handles, metrics: metrics(handles, test), latencyMs: samples.map(round) });
        }
      } finally { await hybridService.close(); }
      const callsBeforeRestart = embedder.snapshot();
      await service.close();
      service = new SemanticSearchService({ embedder, indexRoot, batchSize: 16, retrievalMode: 'semantic' });
      const restartStart = now();
      await service.reconcile(store);
      await service.search(store, { query: fixture.cases[0].query, first: 10 });
      const restartMs = now() - restartStart;
      const callsAfterRestart = embedder.snapshot();
      const original = readFileSync(fixture.editedFile, 'utf8');
      writeFileSync(fixture.editedFile, `${original}\n\nRestoration checklist updated after the second successful recovery rehearsal.\n`);
      store.rebuild();
      const editStart = now();
      await service.reconcile(store);
      const editResult = await service.search(store, { query: 'restoration checklist recovery rehearsal', first: 10 });
      const editMs = now() - editStart;
      const callsAfterEdit = embedder.snapshot();
      writeFileSync(fixture.editedFile, original); store.rebuild();
      const ps = await api('/api/ps');
      const allocation = modelAllocation(ps.models, identity);
      const run = {
        model, identity, dimension: warmVectors[0].length, modelWarmupMs: round(modelLoadMs), indexedChunks: first.indexedChunks,
        firstSearchMs: round(firstSearchMs), initialEmbedding: { calls: coldEmbedding.calls, texts: coldEmbedding.texts, totalMs: round(coldEmbedding.ms) },
        // Conservative throughput includes the first query, cache write, and index creation.
        initialChunksPerSecond: round(first.indexedChunks / (firstSearchMs / 1000)), indexBytes: directoryBytes(indexRoot),
        memory: { startingNodeRssMiB: round(mib(startingRss)), peakNodeRssMiB: round(mib(peakRss)), finalNodeRssMiB: round(mib(process.memoryUsage().rss)), ollamaReportedModelBytes: allocation?.size ?? null, ollamaReportedGpuBytes: allocation?.size_vram ?? null, ollamaReportedContextLength: allocation?.context_length ?? null },
        restart: { ms: round(restartMs), embeddedTexts: callsAfterRestart.texts - callsBeforeRestart.texts, embeddingCalls: callsAfterRestart.calls - callsBeforeRestart.calls, note: 'New service object and connection in the same Node process; persisted index reused. One query embedding is expected; not an OS process restart.' },
        incrementalEdit: { handle: fixture.editedHandle, foundEditedRecord: editResult.hits.some(hit => hit.handle === fixture.editedHandle), ms: round(editMs), embeddedTexts: callsAfterEdit.texts - callsAfterRestart.texts, embeddingCalls: callsAfterEdit.calls - callsAfterRestart.calls, note: 'One short action body changed; includes one query embedding.' },
        summary: summarize(results), results, hybrid: { summary: summarize(hybridResults), results: hybridResults },
      };
      output.models.push(run);
      console.log(`${model}: ${JSON.stringify({ firstSearchMs: run.firstSearchMs, initialChunksPerSecond: run.initialChunksPerSecond, memory: run.memory, summary: run.summary, restart: run.restart, incrementalEdit: run.incrementalEdit })}`);
      if (values.output) writeFileSync(resolve(values.output), JSON.stringify(output, null, 2) + '\n');
    } finally { clearInterval(sample); await service.close(); }
  }
  if (values.output) { writeFileSync(resolve(values.output), JSON.stringify(output, null, 2) + '\n'); console.log(`Results: ${resolve(values.output)}`); }
  else console.log(JSON.stringify(output, null, 2));
}

try { await main(); }
finally { regex.close(); store.close(); if (!values.keep) rmSync(root, { recursive: true, force: true }); else console.log(`Retained fixture and indexes: ${root}`); }
