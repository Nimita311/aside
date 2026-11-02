import { deepStrictEqual } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { cpus, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/mcp/store.js';
import { RegexWorkerPool } from '../src/mcp/search.js';
import { writeFixture, DAY, SINCE } from './fixture.js';
import { CASES, Context, QueryLimitError, type Caller, type Metrics, type Reply } from './cases.js';
import { backendCaller } from './backend.js';
import { startProfile, type ProfileResult } from './profile.js';

interface Sample extends Metrics { ms: number; prepareMs: number }
interface Summary { p50Ms: number; p95Ms: number; minMs: number; maxMs: number; meanMs: number; calls: number; rounds: number; requestBytes: number; responseBytes: number; responseTextBytes: number; samples: Sample[] }
interface Failed extends Metrics { error: string }
type Outcome = Summary | Failed;
interface Result { case: string; question: string; answerCount: number; graphql: Outcome; legacy: Outcome }
const time = (outcome: Outcome) => 'error' in outcome ? 'LIMIT' : `${outcome.p50Ms.toFixed(2)} / ${outcome.p95Ms.toFixed(2)}`;
const cli = fileURLToPath(new URL('../..', import.meta.url));
const help = `Canonical Aside query benchmark

  npm run bench:queries -- [options]

  --sizes 100,1000,5000  Entry counts; 40–100000 each (default shown)
  --samples 10           Measured runs per query/interface
  --warmup 2             Unmeasured runs per query/interface
  --page-size 100        Exhaustive collection page size (1–100)
  --cases <ids>          Comma-separated case IDs (default: all ${CASES.length})
  --cache warm          warm, after-write (description), or after-record-write
  --fanout 1            Projects tagged per non-orphan entry (1–8)
  --body-bytes 0        Extra body/content bytes per record (0–65536)
  --cpu-profile <base>  Save backend V8 CPU profiles as <base>-<size>.cpuprofile
  --allow-limits        Record known query capacity errors; correctness failures still abort
  --transport backend   backend or stdio; stdio requires npm run build
  --output <file.json>   JSON report; a Markdown sibling is also written
  --help                Show this help

Case IDs: ${CASES.map(c => c.id).join(', ')}
Default output: .cache/bench/query-results.json
`;

function integer(value: string, min: number, max: number, name: string) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return number;
}
function summarize(samples: Sample[]): Summary {
  const sorted = samples.map(s => s.ms).sort((a, b) => a - b);
  const { calls, rounds, requestBytes, responseBytes, responseTextBytes } = samples[0];
  for (const sample of samples) deepStrictEqual(
    [sample.calls, sample.rounds, sample.requestBytes, sample.responseBytes, sample.responseTextBytes],
    [calls, rounds, requestBytes, responseBytes, responseTextBytes], 'Workload changed between samples',
  );
  return { p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
    minMs: sorted[0], maxMs: sorted.at(-1)!, meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    calls, rounds, requestBytes, responseBytes, responseTextBytes, samples };
}

async function stdioCaller(dir: string): Promise<{ call: Caller; close(): Promise<void> }> {
  const bundle = join(cli, 'dist', 'main.js');
  if (!existsSync(bundle)) throw new Error('Build the CLI first: npm run build');
  const daemonHome = mkdtempSync(join(tmpdir(), 'aside-query-daemon-'));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  env.ASIDE_DAEMON_HOME = daemonHome; env.ASIDE_CAL_BIN = '/nonexistent/aside-benchmark-cal';
  const legacy = new Client({ name: 'canonical-query-benchmark', version: '1' });
  const graph = new Client({ name: 'canonical-query-benchmark', version: '1' });
  const close = async () => {
    await Promise.allSettled([legacy.close(), graph.close()]);
    await new Promise<void>(done => execFile(process.execPath, [bundle, 'daemon', 'stop', '--force'], { env, timeout: 20_000 }, () => done()));
    rmSync(daemonHome, { recursive: true, force: true });
  };
  try {
    const connections = await Promise.allSettled([
      legacy.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, 'mcp', '--legacy', '--dir', dir], env, stderr: 'ignore' })),
      graph.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, 'mcp', '--dir', dir], env, stderr: 'ignore' })),
    ]);
    const failure = connections.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    // Load the store and establish the daemon before measuring warm workflows.
    await graph.callTool({ name: 'query', arguments: { document: '{ __typename }' } });
    return { call: async (name, args) => (name === 'query' ? graph : legacy).callTool({ name, arguments: args }) as Promise<Reply>, close };
  } catch (error) { await close(); throw error; }
}

async function main() {
  const { values } = parseArgs({ options: {
    sizes: { type: 'string', default: '100,1000,5000' }, samples: { type: 'string', default: '10' }, warmup: { type: 'string', default: '2' },
    'page-size': { type: 'string', default: '100' }, cases: { type: 'string' }, transport: { type: 'string', default: 'backend' },
    output: { type: 'string', default: '.cache/bench/query-results.json' }, help: { type: 'boolean' },
    cache: { type: 'string', default: 'warm' }, fanout: { type: 'string', default: '1' },
    'body-bytes': { type: 'string', default: '0' }, 'cpu-profile': { type: 'string' },
    'allow-limits': { type: 'boolean', default: false },
  } });
  if (values.help) { console.log(help); return; }
  let interrupted = false;
  // Let the current request settle, then reach the resource cleanup in finally.
  // The launcher forwards signals here instead of leaving a detached daemon.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { interrupted = true; });
  const checkInterrupted = () => { if (interrupted) throw new Error('Benchmark interrupted.'); };
  const sizes = values.sizes!.split(',').map(s => integer(s, 40, 100_000, 'size'));
  const samples = integer(values.samples!, 1, 1_000, 'samples'), warmup = integer(values.warmup!, 0, 100, 'warmup');
  const pageSize = integer(values['page-size']!, 1, 100, 'page-size');
  const fanout = integer(values.fanout!, 1, 8, 'fanout'), bodyBytes = integer(values['body-bytes']!, 0, 65_536, 'body-bytes');
  if (!['warm', 'after-write', 'after-record-write'].includes(values.cache!)) throw new Error('cache must be warm, after-write, or after-record-write.');
  if (!['backend', 'stdio'].includes(values.transport!)) throw new Error('transport must be backend or stdio.');
  if (values['cpu-profile'] && values.transport !== 'backend') throw new Error('CPU profiles require backend transport to capture the query executor.');
  const ids = values.cases?.split(',') ?? CASES.map(c => c.id);
  const cases = ids.map(id => { const found = CASES.find(c => c.id === id); if (!found) throw new Error(`Unknown case: ${id}`); return found; });
  const output = resolve(values.output!);
  if (!output.endsWith('.json')) throw new Error('output must end with .json.');
  let revision: string | null = null, dirty: boolean | null = null;
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cli, encoding: 'utf8' }).trim(); dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: cli, encoding: 'utf8' }).trim(); } catch {}
  const report = {
    schemaVersion: 2, generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, revision, dirty },
    settings: { transport: values.transport, sizes, samples, warmup, pageSize, cache: values.cache, fanout, bodyBytes, allowLimits: values['allow-limits'], deadlineThrough: DAY, recentSince: SINCE },
    documents: cases.map(c => ({ id: c.id, question: c.question, document: c.document })),
    datasets: [] as { entries: number; projects: number; actions: number; artifacts: number; fixtureMs: number; storeLoadMs: number; results: Result[] }[],
    profiles: [] as ProfileResult[],
  };
  console.log(`Canonical queries · ${values.transport} · ${samples} samples after ${warmup} warmups · page ${pageSize}`);
  for (const size of sizes) {
    checkInterrupted();
    const dir = mkdtempSync(join(tmpdir(), 'aside-query-bench-'));
    let store: Store | undefined, pool: RegexWorkerPool | undefined, remote: Awaited<ReturnType<typeof stdioCaller>> | undefined;
    let stopProfile: Awaited<ReturnType<typeof startProfile>> | undefined;
    try {
      let start = performance.now(); const fixture = writeFixture(dir, size, { fanout, bodyBytes }); const fixtureMs = performance.now() - start;
      start = performance.now(); store = new Store(dir); const storeLoadMs = performance.now() - start;
      if (store.getIssues().length) throw new Error(`Invalid benchmark fixture: ${JSON.stringify(store.getIssues())}`);
      let call: Caller;
      if (values.transport === 'stdio') { store.close(); store = undefined; remote = await stdioCaller(dir); call = remote.call; }
      else { pool = new RegexWorkerPool({ workerUrl: new URL('./regex-worker.js', import.meta.url) }); call = backendCaller(store, pool); }
      const dataset = { entries: fixture.entries.length, projects: fixture.projects.length, actions: fixture.actions.length, artifacts: fixture.artifacts.length, fixtureMs, storeLoadMs, results: [] as Result[] };
      console.log(`\n${size} entries, ${dataset.projects} projects, ${dataset.actions} actions, ${dataset.artifacts} artifacts`);
      if (values['cpu-profile']) stopProfile = await startProfile();
      for (const task of cases) {
        const expected = task.expected(fixture);
        const timings = { graphql: [] as Sample[], legacy: [] as Sample[] };
        const failures: Partial<Record<'graphql' | 'legacy', Failed>> = {};
        for (let iteration = -warmup; iteration < samples; iteration++) {
          // Alternate order to reduce systematic JIT/GC/cache bias. Each
          // workflow starts with an empty client-side state and fetches its data.
          for (const mode of (iteration % 2 === 0 ? ['graphql', 'legacy'] : ['legacy', 'graphql']) as ('graphql' | 'legacy')[]) {
            checkInterrupted();
            if (failures[mode]) continue;
            start = performance.now();
            if (values.cache !== 'warm') {
              // Preserve the oracle while exercising actual index-only or
              // record writes. The record mode also rebuilds the shared graph.
              const project = fixture.projects.find(p => p.id === fixture.focus)!;
              const reply = await call('update_project', { id: project.id, ...(values.cache === 'after-write' ? { description: project.description } : { name: project.name }) });
              if (reply.isError) throw new Error('Benchmark cache invalidation failed.');
            }
            const prepareMs = performance.now() - start;
            const ctx = new Context(call, pageSize);
            start = performance.now();
            let answer: unknown;
            try { answer = await task[mode](ctx, fixture); }
            catch (error) {
              if (!values['allow-limits'] || !(error instanceof QueryLimitError)) throw error;
              failures[mode] = { ...ctx.metrics, error: error.message };
              continue;
            }
            const ms = performance.now() - start;
            deepStrictEqual(answer, expected, `${size} entries, ${task.id}, ${mode}: wrong or truncated answer`);
            if (iteration >= 0) timings[mode].push({ ...ctx.metrics, ms, prepareMs });
          }
        }
        const result = { case: task.id, question: task.question, answerCount: Array.isArray(expected) ? expected.length : 1, graphql: failures.graphql ?? summarize(timings.graphql), legacy: failures.legacy ?? summarize(timings.legacy) };
        dataset.results.push(result);
        const p50 = (o: Outcome) => 'error' in o ? 'LIMIT' : `${o.p50Ms.toFixed(2)}ms`;
        console.log(`${task.id.padEnd(32)} GraphQL ${p50(result.graphql).padStart(9)} / ${String(result.graphql.calls).padStart(3)} calls · legacy ${p50(result.legacy).padStart(9)} / ${String(result.legacy.calls).padStart(3)} calls`);
      }
      report.datasets.push(dataset);
    } finally {
      try { if (stopProfile) report.profiles.push(await stopProfile(`${resolve(values['cpu-profile']!)}-${size}.cpuprofile`)); }
      finally {
        try { store?.close(); await pool?.close(); }
        finally {
          try { await remote?.close(); }
          finally { rmSync(dir, { recursive: true, force: true }); }
        }
      }
    }
  }
  const lines = [
    '# Canonical query benchmark', '', `Generated: ${report.generatedAt}. Node ${report.environment.node}, ${report.environment.cpu}, ${values.transport} transport.`, '',
    `${samples} measured runs after ${warmup} warmups per case/interface; page size ${pageSize}. Quantiles use nearest rank. All successful complete answers matched the independently authored fixture oracle. Capacity errors have no latency score.`, '',
    `Cache: ${values.cache}; relationship fanout: ${fanout}; extra body bytes: ${bodyBytes}. Timings cover complete query workflows and client joins. Preparing writes are excluded and recorded separately as prepareMs. After-write mode changes an index description; after-record-write rewrites record metadata and rebuilds the graph. Subsequent pages may reuse production caches. Fixture generation, store loading, server startup, schema discovery, and LLM inference are excluded. Dependency rounds preserve pagination dependencies and parallelize independent legacy calls. Response bytes count serialized MCP result payloads, including GraphQL text + structuredContent; JSON-RPC framing is excluded.`, '',
    '| Entries | Query | Answer rows | GraphQL p50/p95 ms | Legacy p50/p95 ms | Calls G/L | Rounds G/L | Response KiB G/L |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const dataset of report.datasets) for (const r of dataset.results) lines.push(
    `| ${dataset.entries} | ${r.case} | ${r.answerCount} | ${time(r.graphql)} | ${time(r.legacy)} | ${r.graphql.calls}/${r.legacy.calls} | ${r.graphql.rounds}/${r.legacy.rounds} | ${(r.graphql.responseBytes / 1024).toFixed(1)}/${(r.legacy.responseBytes / 1024).toFixed(1)} |`,
  );
  for (const dataset of report.datasets) for (const r of dataset.results) for (const mode of ['graphql', 'legacy'] as const) {
    const outcome = r[mode];
    if ('error' in outcome) lines.push('', `LIMIT · ${dataset.entries} entries · ${r.case} · ${mode}: ${outcome.error}`);
  }
  for (const profile of report.profiles) {
    lines.push('', `CPU profile: ${profile.path}. Includes both interfaces, warmups, and any preparing writes; excludes fixture generation and initial Store loading.`, '', '| Frame (self time) | ms |', '| --- | ---: |');
    for (const { frame, ms } of profile.selfMs.slice(0, 15)) lines.push(`| ${frame.replaceAll('|', '\\|')} | ${ms.toFixed(2)} |`);
  }
  lines.push('', 'GraphQL documents and raw per-run measurements are in the JSON sibling. Small-sample p95 values are noisy; this measures query plans, not model reasoning accuracy or time. No pass/fail timing thresholds are imposed.', '');
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  const markdown = output.slice(0, -5) + '.md'; writeFileSync(markdown, lines.join('\n'));
  console.log(`\nReports: ${output}\n         ${markdown}`);
}

main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
