import { WebAuth } from '../src/web/auth.js';
import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RegexWorkerPool } from '../src/mcp/search.js';
import { Store } from '../src/source/store.js';
import { handleQueryArtifacts } from '../src/mcp/tools/query.js';
import { executeGraphQL, type GraphQLResult } from '../src/graphql/schema.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateAction, handleUpdateProject, handleUpdateEntry } from '../src/mcp/tools/update.js';
import { handleCreateArtifact, handleUpdateArtifact } from '../src/mcp/tools/artifact.js';
import { init } from '../src/source/bootstrap.js';
import { Daemon } from '../src/daemon/daemon.js';
import { DaemonClient } from '../src/daemon/client.js';
import { InstanceHost, type ToolResult } from '../src/daemon/host.js';
import { daemonPaths } from '../src/daemon/paths.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { daemonSession } from './support/graphql-host.js';

const badText = 'a'.repeat(50_000) + '!';
const catastrophic = '^(a+)+$';
const execute = promisify(execFile);
const pools: RegexWorkerPool[] = [];
const roots: string[] = [];
const pool = (options = {}) => { const value = new RegexWorkerPool(options); pools.push(value); return value; };
const temporary = () => { const dir = mkdtempSync('/tmp/aside-search-'); roots.push(dir); return dir; };
afterEach(() => { for (const p of pools.splice(0)) p.close(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
// Hold one search open, so a test can change the store during matching.
function heldMatcher(inspect?: (fields: string[][]) => void) {
  let started!: () => void, finish!: (indices: number[]) => void;
  const searching = new Promise<void>(resolve => { started = resolve; });
  const match = (_pattern: string, fields: string[][]) => { inspect?.(fields); started(); return new Promise<number[]>(resolve => { finish = resolve; }); };
  return { matcher: { match }, searching, release: (indices: number[]) => finish(indices) };
}

describe('bounded native regex workers', () => {
  it('keeps JavaScript syntax, case-insensitive matching, field boundaries, and ordered indices', async () => {
    expect(await pool().match('(?<=foo)bar|^qux$', [['FOOBAR'], ['fo', 'obar'], ['qux'], ['none']])).toEqual([0, 2]);
  });
  it('terminates expensive matching while another worker and the owner thread keep responding', async () => {
    const p = pool({ executionTimeoutMs: 250 });
    const slow = expect(p.match(catastrophic, [[badText]])).rejects.toThrow(/timed out/);
    expect(await p.match('safe', [['SAFE']])).toEqual([0]);
    const tick = await new Promise(resolve => setTimeout(() => resolve('owner responsive'), 10));
    expect(tick).toBe('owner responsive'); await slow;
    expect(await p.match('recovered', [['Recovered']])).toEqual([0]);
  });
  it('bounds queued work and drains it after replacing a timed-out worker', async () => {
    const p = pool({ workerCount: 1, queueLimit: 1, executionTimeoutMs: 200 });
    const active = expect(p.match(catastrophic, [[badText]])).rejects.toThrow(/timed out/);
    const queued = p.match('next', [['NEXT']]);
    await expect(p.match('overflow', [['overflow']])).rejects.toThrow(/overloaded/);
    await active; expect(await queued).toEqual([0]);
  });
  it('bounds queue waiting independently from execution time', async () => {
    const p = pool({ workerCount: 1, executionTimeoutMs: 500, queueTimeoutMs: 30 });
    const controller = new AbortController();
    const active = expect(p.match(catastrophic, [[badText]], { signal: controller.signal })).rejects.toThrow(/cancelled/);
    await expect(p.match('queued', [['queued']])).rejects.toThrow(/waiting for a worker/);
    controller.abort(); await active;
  });
  it('cancels running and queued work on disconnect and recovers capacity', async () => {
    const p = pool({ workerCount: 1 }); const activeSignal = new AbortController(), queuedSignal = new AbortController();
    const active = expect(p.match(catastrophic, [[badText]], { signal: activeSignal.signal })).rejects.toThrow(/disconnected/);
    const queued = expect(p.match('queued', [['queued']], { signal: queuedSignal.signal })).rejects.toThrow(/disconnected/);
    queuedSignal.abort(); activeSignal.abort(); await Promise.all([active, queued]);
    expect(await p.match('fresh', [['fresh']])).toEqual([0]);
  });
  it('settles active/queued searches and refuses new searches on shutdown', async () => {
    const p = pool({ workerCount: 1 });
    const active = expect(p.match(catastrophic, [[badText]])).rejects.toThrow(/shutting down/);
    const queued = expect(p.match('queued', [['queued']])).rejects.toThrow(/shutting down/);
    p.close(); p.close(); await Promise.all([active, queued]);
    await expect(p.match('later', [['later']])).rejects.toThrow(/shutting down/);
  });
  it('bounds individual and aggregate snapshots and releases reservations', async () => {
    const p = pool({ snapshotMaxBytes: 100_000, poolMaxBytes: 100_001 });
    await expect(p.match('a', [['small']], { snapshotBytes: 100_001 })).rejects.toThrow(/too large/);
    const controller = new AbortController();
    const active = expect(p.match(catastrophic, [[badText]], { signal: controller.signal, snapshotBytes: 100_000 })).rejects.toThrow(/disconnected/);
    await expect(p.match('b', [['bb']])).rejects.toThrow(/overloaded/);
    controller.abort(); await active;
    expect(await p.match('b', [['bb']])).toEqual([0]);
  });
  it('bounds record-array overhead even for empty searchable fields', async () => {
    await expect(pool().match('anything', Array.from({ length: 100_001 }, () => ['']))).rejects.toThrow(/too many records/);
  });
  it.each(['exit', 'invalid-result'])('reports %s worker failures as errors, never empty matches', async kind => {
    const file = join(temporary(), 'worker.mjs');
    writeFileSync(file, kind === 'exit' ? 'process.exit(3);' : "import { parentPort } from 'node:worker_threads'; parentPort.on('message', job => parentPort.postMessage({id: job.id}));");
    await expect(pool({ workerUrl: pathToFileURL(file) }).match('match', [['match']])).rejects.toThrow(/worker.*(exited|invalid result)/);
  });
});

describe('query snapshot coherence', () => {
  it('keeps parse diagnostics from the same snapshot as matching', async () => {
    const dir = temporary(); init(dir, { name: 'Warnings', description: 'Warnings' }); const store = new Store(dir);
    try {
      handleCapture(store, { content: 'Before entry', description: 'Before summary' }, new Date(2026, 9, 4, 10));
      handleCreateArtifact(store, { name: 'Before artifact', description: 'Before artifact summary', body: 'Before artifact body' }, new Date(2026, 9, 4, 10));
      const manifest = readFileSync(join(dir, 'aside.md'), 'utf8');
      writeFileSync(join(dir, 'aside.md'), manifest.replace(/^id: .+$/m, 'id: INVALID')); store.rebuild();
      const issue = store.getIssues()[0]; expect(issue).toBeDefined();
      const handler = heldMatcher(), graphql = heldMatcher();
      const artifacts = handleQueryArtifacts(store, { search: 'Before' }, handler);
      const entries = executeGraphQL(store, 'query', { document: '{ entries(where: {regex: "Before"}) { totalCount } }' }, graphql);
      await Promise.all([handler.searching, graphql.searching]);
      writeFileSync(join(dir, 'aside.md'), manifest); store.rebuild(); expect(store.getIssues()).toEqual([]);
      handler.release([0]); graphql.release([0]);
      expect(await artifacts).toContain(issue.message);
      const result = await entries;
      expect(result.data).toEqual({ entries: { totalCount: 1 } });
      expect(result.extensions?.diagnostics).toContainEqual(expect.objectContaining({ code: issue.code, message: issue.message }));
      expect(result.extensions?.complete).toBe(false);
    } finally { store.close(); }
  });
  it.each(['entries', 'actions', 'projects', 'artifacts', 'query_artifacts'] as const)('keeps %s matches, fields and counts from before concurrent mutation', async kind => {
    const dir = temporary(); init(dir, { name: 'Snapshot', description: 'Snapshot' }); const store = new Store(dir);
    try {
      const captured = handleCapture(store, { content: 'Before entry', description: 'Before entry summary', projects: [{ name: 'Before project', description: 'Before project summary' }], actions: [{ name: 'Before action', description: 'Before action summary' }] }, new Date(2026, 9, 4, 10));
      handleCreateArtifact(store, { name: 'Before artifact', description: 'Before artifact summary', body: 'Before artifact body' }, new Date(2026, 9, 4, 10));
      const entry = store.getEntries()[0].meta.created, action = captured.createdActionIds[0], project = captured.createdProjectIds[0], artifact = store.getArtifactIds()[0];
      const held = heldMatcher(fields => expect(fields.flat().join(' ')).toContain('Before'));
      const graphql = async (root: 'entries' | 'actions' | 'projects' | 'artifacts', id: string, fields: string) => {
        const { data, errors } = await executeGraphQL(store, 'query', { document: `query($id: ID!) { ${root}(where: {ids: [$id], regex: "Before"}) { count totalCount nodes { ${fields} } } }`, variables: { id } }, held);
        expect(errors).toBeUndefined();
        const page = data![root] as { count: number; totalCount: number; nodes: unknown[] };
        return `${page.count} of ${page.totalCount}\n${JSON.stringify(page.nodes)}`;
      };
      const result = {
        entries: () => graphql('entries', entry, 'content description'),
        actions: () => graphql('actions', action, 'name description body projects { nodes { id } }'),
        projects: () => graphql('projects', project, 'name description body'),
        artifacts: () => graphql('artifacts', artifact, 'name description content { ... on MarkdownContent { text } }'),
        query_artifacts: () => handleQueryArtifacts(store, { ids: [artifact], search: 'Before', detail: 'full' }, held),
      }[kind]();
      await held.searching;
      handleUpdateAction(store, { id: action, name: 'After action', description: 'After action summary', body: 'After action body' });
      handleUpdateProject(store, { id: project, name: 'After project', description: 'After project summary', body: 'After project body' });
      handleUpdateEntry(store, { id: entry, content: 'After entry', description: 'After entry summary', projects: [], actions: [] });
      handleUpdateArtifact(store, { id: artifact, name: 'After artifact', description: 'After artifact summary', body: 'After artifact body' });
      held.release([0]); const text = await result;
      expect(text).toMatch(/^1 of 1/); expect(text).toContain('Before'); expect(text).not.toContain('After');
      if (kind === 'actions') expect(text).toContain(project);
    } finally { store.close(); }
  });
});

describe('search lifecycle and shipping artifacts', () => {
  it.each(['tool', 'graphql'] as const)('serves other socket clients and browser requests during expensive %s matching, cancels on disconnect', async rpc => {
    const home = temporary(), dir = join(temporary(), 'instance'); init(dir, { name: 'Concurrent', description: 'Concurrent' });
    const searches = pool(); const host = new InstanceHost(new CalClient(null), searches);
    const paths = daemonPaths({ ASIDE_DAEMON_HOME: home }); const daemon = new Daemon({ paths, host, webPort: 0 });
    const first = new DaemonClient({ paths }), second = new DaemonClient({ paths });
    const query = async (client: DaemonClient, search?: string, options?: { read?: boolean }) => {
      if (rpc === 'tool') return (await client.request<ToolResult>('tool', { instance: dir, name: 'query_artifacts', args: search ? { search } : { limit: 1 } }, options)).text;
      const { result } = await client.request<{ result: GraphQLResult }>('graphql', { session: daemonSession(dir), mode: 'query', args: {
        document: 'query($regex: String) { artifacts(where: {regex: $regex}, limit: 1) { count totalCount } }', variables: { regex: search },
      } }, options);
      if (result.errors) throw new Error(JSON.stringify(result.errors));
      const page = result.data!.artifacts as { count: number; totalCount: number };
      return `${page.count} of ${page.totalCount}`;
    };
    expect(await daemon.listen()).toBe(true);
    try {
      await first.request('tool', { instance: dir, name: 'create_artifact', args: { name: 'Slow target', description: 'Slow target', body: badText } });
      const slow = query(first, catastrophic).catch(error => error);
      const started = Date.now();
      expect(await query(second, undefined, { read: true })).toMatch(/^1 of 1/);
      const { port } = await second.request<{ port: number }>('serve', { navigate: false });
      expect((await fetch(`http://127.0.0.1:${port}/-/api/instances`, { headers: { Authorization: `Bearer ${new WebAuth(paths.state).issue().token}` } })).ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(1500);
      first.close(); expect(await slow).toBeInstanceOf(Error);
      expect(await query(second, 'Slow target', { read: true })).toMatch(/^1 of 1/);
      const interrupted = query(second, catastrophic).catch(error => error);
      await new Promise(resolve => setTimeout(resolve, 30));
      const stopping = Date.now(); await daemon.shutdown();
      expect(Date.now() - stopping).toBeLessThan(1000); expect(await interrupted).toBeInstanceOf(Error);
    } finally { first.close(); second.close(); await daemon.shutdown(); }
  });
  it('runs built regex search and an explicit two-second timeout with no source tree or node_modules', async () => {
    const root = temporary(), dist = join(root, 'cli', 'dist'); mkdirSync(dist, { recursive: true });
    for (const file of ['main.js', 'runtime.js', 'regex-worker.js']) copyFileSync(join(__dirname, '../dist', file), join(dist, file));
    const data = join(root, 'instance'), home = join(root, 'daemon');
    const env = { ...process.env, ASIDE_DAEMON_HOME: home, ASIDE_CAL_BIN: '/nonexistent/aside-cal' };
    const cli = (args: string[]) => execute(process.execPath, [join(dist, 'main.js'), ...args], { env, encoding: 'utf8' });
    try {
      await cli(['instance', 'init', '--dir', data, '--name', 'Bundle', '--description', 'Bundle']);
      const draft = join(root, 'draft.md'); writeFileSync(draft, badText);
      await cli(['artifact', 'create', '--dir', data, '--name', 'Slow target', '--description', 'Slow target', '--body-file', draft]);
      const normal = await cli(['artifact', 'query', '--dir', data, '--search', '(?<=Slow )target']);
      expect(normal.stdout).toContain('#artifact/');
      const started = Date.now();
      await expect(cli(['artifact', 'query', '--dir', data, '--search', catastrophic])).rejects.toThrow(/timed out after 2 seconds/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      expect((await cli(['artifact', 'query', '--dir', data, '--search', 'Slow target'])).stdout).toContain('#artifact/');
    } finally { await cli(['daemon', 'stop']).catch(() => {}); }
  }, 15_000);
});
