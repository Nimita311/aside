import {createHash} from 'node:crypto';
import {cpus, arch, platform, release, totalmem} from 'node:os';
import {mkdtempSync, readdirSync, statSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {connect} from '@lancedb/lancedb';
import type {Store} from '../src/source/store.js';
import type {EmbeddingOptions, SemanticEmbeddingGeneration} from '../src/semantic/embedding.js';

const {values} = parseArgs({options: {
  module: {type: 'string'}, provenance: {type: 'string'}, label: {type: 'string', default: 'current'}, ref: {type: 'string'},
  sizes: {type: 'string', default: '100,1000,10000'}, samples: {type: 'string', default: '30'},
  'large-samples': {type: 'string', default: '10'}, warmups: {type: 'string', default: '5'},
  dimension: {type: 'string', default: '1024'}, output: {type: 'string'}, compare: {type: 'string'},
}});
if (!values.module || !values.output || !values.provenance) throw new Error('Provide --module, --provenance and --output. Use semantic-freshness-run.mjs to build a snapshot.');
const positive = (value: string | undefined, name: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
};
const samples = positive(values.samples, 'samples'), largeSamples = positive(values['large-samples'], 'large-samples');
const warmups = positive(values.warmups, 'warmups'), dimension = positive(values.dimension, 'dimension');
const sizes = values.sizes!.split(',').map(value => positive(value, 'size'));
const implementation = await import(pathToFileURL(resolve(values.module)).href);
const expected = values.compare ? JSON.parse(readFileSync(values.compare, 'utf8')) : undefined;
const fixtureRoot = mkdtempSync('/private/tmp/aside-freshness-bench-');
process.env.ASIDE_DAEMON_HOME = join(fixtureRoot, 'daemon');
const now = () => performance.now();
const stats = (times: number[]) => {
  const sorted = [...times].sort((a,b) => a-b);
  const quantile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length*p)-1)];
  return {samples: times.length, p50Ms: quantile(.5), p95Ms: quantile(.95), minMs: sorted[0], maxMs: sorted.at(-1), meanMs: times.reduce((sum,time) => sum+time,0)/times.length};
};
function fileStats(directory: string): {files: number; bytes: number} {
  let files = 0, bytes = 0;
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const child = fileStats(path); files += child.files; bytes += child.bytes; }
    else if (entry.isFile()) {files++; bytes += statSync(path).size;}
  }
  return {files,bytes};
}
function fileMetadata(directory: string, prefix = ''): unknown[] {
  return readdirSync(directory, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory,entry.name), name = join(prefix,entry.name);
    if (entry.isDirectory()) return fileMetadata(path,name);
    const stat = statSync(path);
    return [[name,stat.size,stat.mtimeMs,stat.ctimeMs]];
  });
}
function endpointBase(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}
function completedLocation(instanceRoot: string): string {
  const generations = readdirSync(instanceRoot, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name));
  if (generations.length !== 1) throw new Error(`Expected one completed semantic generation, found ${generations.length}.`);
  return join(instanceRoot, generations[0].name);
}
function vector(text: string): number[] {
  let state = createHash('sha256').update(text).digest().readUInt32LE(0) || 1;
  return Array.from({length: dimension}, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000 * 2 - 1;
  });
}
const result: Record<string, any> = {
  label: values.label, ...JSON.parse(readFileSync(values.provenance,'utf8')),
  snapshotSha256: createHash('sha256').update(readFileSync(values.module)).digest('hex'),
  system: {platform: platform(),arch: arch(),release: release(),cpu: cpus()[0]?.model,cores: cpus().length,ramGiB: totalmem()/1024**3,node: process.version},
  method: {
    warmups, sourceSamples: samples, rankedSamples: samples, rankedSamplesAt10000OrMore: largeSamples,
    dimension, cache: 'Warm OS filesystem cache and completed native semantic index; no file watchers or periodic reconciliation.',
    sourceOnly: 'Lifecycle source-refresh cost: actual Store.rebuild plus loaded-hash access; unchanged bytes and exact source hash asserted. This phase is outside retrieval in the optimized implementation.',
    ranked: 'Sequential lifecycle index-readiness barrier then read-only SemanticSearchService.search; includes loaded-hash comparison, generation binding or legacy model checks, native index validation and vector ranking. Source rebuilds and model discovery per query are measured explicitly.',
    vectors: 'Deterministic SHA256-seeded 1024-dimensional vectors (or --dimension); document and query inference excluded. Actual configured Ollama /api/tags identity calls are measured during ranked searches.',
    setup: 'Index creation and model-generation discovery excluded. The pinned implementation resolves and verifies its real native Ollama digest once before synthetic indexing. The legacy implementation captures identity once to avoid HTTP checks for synthetic document batches.',
    fixture: 'Existing synthetic writeSemanticFixture;12 entries share a weekly note, most remaining records occupy individual Markdown files.',
    percentiles: 'Nearest-rank percentiles; sequential single client; phase percentiles must not be added to derive a total percentile.',
    exclusions: 'No real embedding inference, daemon socket transport, GraphQL filtering/serialization, first indexing or cold disk cache. This is a freshness/retrieval benchmark, not embedding quality or complete production latency.',
    checks: 'Warm queries must embed no documents, preserve native table version/checkpoint and source/index file metadata, and produce identical handles per query within and across revisions. Loaded-version implementations must rebuild no source during retrieval. Generation-bound implementations must perform no discovery during retrieval and must use the same captured generation for documents and queries.',
  }, results: [],
};
const save = () => writeFileSync(resolve(values.output!), JSON.stringify(result,null,2)+'\n');

try {
  for (const records of sizes) {
    const data = join(fixtureRoot, String(records)), indexRoot = join(fixtureRoot,'indexes',String(records));
    const fixture = implementation.writeSemanticFixture(data, records);
    const store: Store = new implementation.Store(data);
    let sourceRebuilds = 0;
    const rebuild = store.rebuild.bind(store);
    store.rebuild = () => {sourceRebuilds++; rebuild();};
    let service: any, reconciler: any;
    try {
      implementation.assertSearchSourceReadable(store);
      const sourceHash = implementation.searchSourceVersion(store);
      const refresh: number[] = [], fingerprint: number[] = [], sourceTotal: number[] = [];
      for (let repeat=0; repeat<warmups+samples; repeat++) {
        const started = now(); store.rebuild(); const rebuilt = now();
        implementation.assertSearchSourceReadable(store);
        if (implementation.searchSourceVersion(store) !== sourceHash) throw new Error('Unchanged source refresh changed the fingerprint.');
        const finished = now();
        if (repeat>=warmups) {refresh.push(rebuilt-started); fingerprint.push(finished-rebuilt); sourceTotal.push(finished-started);}
      }
      const inner = new implementation.OllamaEmbedder();
      const modelEndpoint = endpointBase(inner.url);
      const pinnedGeneration = typeof inner.resolveGeneration === 'function';
      const capturedGeneration = pinnedGeneration ? await inner.resolveGeneration() : undefined;
      const capturedIdentity: string = capturedGeneration?.identity ?? await inner.identity();
      let liveIdentity = false, identityCalls = 0, identityMs = 0, generationResolutions = 0, documentEmbeddings = 0, queryEmbeddings = 0;
      const documentGenerations = new Set<string>(), queryGenerations = new Set<string>();
      const embedDocuments = async (texts: string[]) => {documentEmbeddings += texts.length;documentGenerations.add(capturedIdentity);return texts.map(vector);};
      const embedQuery = async (query: string) => {queryEmbeddings++;queryGenerations.add(capturedIdentity);return vector(`query:${query}`);};
      const generation: SemanticEmbeddingGeneration = {model: inner.model,identity: capturedIdentity,embed: embedDocuments,embedQuery};
      const embedder = pinnedGeneration ? {
        model: inner.model,
        resolveGeneration: async (_options?: EmbeddingOptions) => {generationResolutions++;return generation;},
      } : {
        model: inner.model,
        identity: async (options?: EmbeddingOptions) => {
          if (!liveIdentity) return capturedIdentity;
          const started=now();
          try {return await inner.identity(options);}
          finally {identityCalls++; identityMs += now()-started;}
        },
        embed: embedDocuments,
        embedQuery,
      };
      service = new implementation.SemanticSearchService({embedder,indexRoot,batchSize:64});
      reconciler = new implementation.InstanceSemanticLifecycle({reconcile: (current: Store, options: {signal: AbortSignal}) => service.reconcile(current,options),debounceMs:0,reconciliationIntervalMs:0});
      reconciler.register(store); await reconciler.ensureCurrent(store);
      liveIdentity = true;
      const queries: string[] = fixture.cases.slice(0,3).map((item: {query: string}) => item.query);
      const rankedHandles: Record<string,string[]> = {};
      const ranked: number[] = [], ensureTimes: number[] = [], searchTimes: number[] = [], identityTimes: number[] = [], identityCounts: number[] = [], generationCounts: number[] = [], sourceCounts: number[] = [];
      const repeats = records>=10_000 ? largeSamples : samples;
      const location = completedLocation(join(indexRoot, implementation.hashText(store.getDataDir())));
      async function persistedVersion() {
        const connection = await connect(location);
        try {
          const table = await connection.openTable('chunks');
          try {return {version:await table.version(),checkpoint:readFileSync(join(location,'live.version'),'utf8')};}
          finally {table.close();}
        } finally {connection.close();}
      }
      const beforeStorage = await persistedVersion(), beforeDocuments = documentEmbeddings;
      const beforeFiles = JSON.stringify({source:fileMetadata(data),index:fileMetadata(indexRoot)});
      for (let repeat=0; repeat<warmups+repeats; repeat++) {
        const query = queries[repeat%queries.length], priorCalls=identityCalls, priorIdentity=identityMs, priorGenerations=generationResolutions, priorRebuilds=sourceRebuilds;
        const started=now(); await reconciler.ensureCurrent(store); const ensured=now();
        const page = await service.search(store,{query,first:10}); const finished=now();
        const handles = page.hits.map((hit: {handle:string}) => hit.handle);
        if (rankedHandles[query] && JSON.stringify(rankedHandles[query])!==JSON.stringify(handles)) throw new Error('Warm unchanged search changed ranked handles.');
        rankedHandles[query] = handles;
        if (typeof store.getSourceVersion === 'function' && sourceRebuilds !== priorRebuilds) throw new Error('Retrieval rebuilt source instead of using the loaded snapshot.');
        if (pinnedGeneration && (identityCalls!==priorCalls || generationResolutions!==priorGenerations)) throw new Error('Retrieval rediscovered the embedding model instead of using its pinned generation.');
        if (repeat>=warmups) {ranked.push(finished-started);ensureTimes.push(ensured-started);searchTimes.push(finished-ensured);identityTimes.push(identityMs-priorIdentity);identityCounts.push(identityCalls-priorCalls);generationCounts.push(generationResolutions-priorGenerations);sourceCounts.push(sourceRebuilds-priorRebuilds);}
      }
      const afterStorage = await persistedVersion();
      if (JSON.stringify(beforeStorage)!==JSON.stringify(afterStorage)) throw new Error('Warm queries rewrote native storage.');
      if (JSON.stringify({source:fileMetadata(data),index:fileMetadata(indexRoot)})!==beforeFiles) throw new Error('Warm queries changed source or index files.');
      if (documentEmbeddings!==beforeDocuments) throw new Error('Warm queries embedded unchanged documents.');
      if (pinnedGeneration && (documentGenerations.size!==1 || queryGenerations.size!==1 || !documentGenerations.has(capturedIdentity) || !queryGenerations.has(capturedIdentity))) throw new Error('Documents and queries used different embedding generations.');
      const comparison = expected?.results.find((row: {records:number}) => row.records===records);
      if (expected && !comparison) throw new Error(`Comparison has no ${records}-record result.`);
      if (comparison && (comparison.model!==inner.model || comparison.modelIdentity!==capturedIdentity || comparison.modelEndpoint!==modelEndpoint)) throw new Error('Comparison used a different embedding model generation or endpoint.');
      if (comparison && Object.entries(rankedHandles).some(([query,handles]) => JSON.stringify(comparison.rankedHandles[query])!==JSON.stringify(handles))) throw new Error('Before/after ranked handles differ.');
      const row = {records,...fileStats(data),model:inner.model,modelIdentity:capturedIdentity,modelEndpoint,sourceOnly:{refresh:stats(refresh),fingerprint:stats(fingerprint),total:stats(sourceTotal)},ranked:{total:stats(ranked),ensureCurrent:stats(ensureTimes),serviceSearch:stats(searchTimes),identity:stats(identityTimes),identityCallsPerQuery:[...new Set(identityCounts)],generationResolutionsPerQuery:[...new Set(generationCounts)],pinnedQueryGeneration:pinnedGeneration ? capturedIdentity : null,sourceRebuildsPerQuery:[...new Set(sourceCounts)],documentEmbeddings:documentEmbeddings-beforeDocuments,queryEmbeddings,nativeStorageUnchanged:true,sourceAndIndexFilesUnchanged:true,rankedHandlesEqualToComparison:comparison ? true : null},rankedHandles};
      result.results.push(row); save();
      console.log(JSON.stringify({label:values.label,records,source:row.sourceOnly.total,ranked:row.ranked.total,identity:row.ranked.identity,identityCalls:row.ranked.identityCallsPerQuery}));
    } finally {await reconciler?.close();await service?.close();store.close();}
  }
} finally {rmSync(fixtureRoot,{recursive:true,force:true});}
save();
