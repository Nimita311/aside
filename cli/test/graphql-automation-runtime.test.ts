import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStorage, type RunRecord } from '../src/automation/storage.js';
import { AutomationScheduler } from '../src/automation/scheduler.js';
import { automationRuntimeSnapshot, readAutomationLog } from '../src/graphql/automation-runtime.js';
import { init } from '../src/commands/init.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { Store } from '../src/mcp/store.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';
import { handleCapture } from '../src/mcp/tools/capture.js';

const workers = vi.hoisted(() => [] as Array<{
  emit(event: string, message: unknown): boolean;
  messages: Array<{ type: string; id?: number; root?: string }>;
}>);
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    messages: Array<{ type: string; id?: number; root?: string }> = [];
    constructor() { super(); workers.push(this); }
    postMessage(message: { type: string; id?: number; root?: string }) {
      this.messages.push(message);
      if (message.type === 'close') this.emit('message', { type: 'closed' });
    }
    terminate() { return Promise.resolve(0); }
  } };
});
import { AutomationController } from '../src/automation/controller.js';
import * as models from '../src/automation/models.js';

let temporary: string, root: string, other: string, storage: string;
let controller: AutomationController | undefined, host: InstanceHost | undefined;
const definition = { schedule: { cron: '0 8 * * *', timezone: 'UTC' }, run: { script: 'echo' } };
function run(instance: string, id: string, scope = 'instance work', name = 'daily/notes'): RunRecord {
  return { id, key: JSON.stringify([instance, scope, name]), root: instance, definedIn: scope,
    occurrence: '2026-10-10T08:00:00.000Z', started: '2026-10-10T08:00:00.000Z',
    finished: '2026-10-10T08:00:01.000Z', status: 'succeeded', session: 'prior', definition, latenessMs: 0 };
}
beforeEach(() => {
  temporary = realpathSync(mkdtempSync('/tmp/aside-graphql-runtime-'));
  root = join(temporary, 'selected'); other = join(temporary, 'other'); storage = join(temporary, 'runs');
  mkdirSync(root); mkdirSync(other);
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(models, 'catalogFor').mockResolvedValue({ models: [], diagnostics: [], revision: 'fixture' });
});
afterEach(async () => {
  await controller?.close(); await host?.close(); controller = undefined; host = undefined;
  workers.length = 0; vi.restoreAllMocks(); rmSync(temporary, { recursive: true, force: true });
});

describe('selected-instance automation runtime', () => {
  it('keeps names intact, reports runtime booleans, and scopes jobs, runs, and model warnings', () => {
    const selected = run(root, 'selected-run', '#project/2026-10-10-notes');
    const foreign = run(other, 'foreign-run');
    const snapshot = automationRuntimeSnapshot(root, {
      available: true,
      jobs: [
        { key: selected.key, root, definedIn: selected.definedIn, running: true, pending: '2026-10-10T09:00Z', next: '2026-10-11T08:00Z', enabled: true, blocked: false },
        { key: foreign.key, root: other, definedIn: foreign.definedIn, running: false, error: 'private error' },
      ],
      runs: [{ ...foreign, directory: '/other/logs' }, { ...selected, directory: '/selected/logs' }],
      modelWarnings: [
        { root, key: selected.key, definedIn: selected.definedIn, message: 'Selected model is unavailable' },
        { root: other, key: foreign.key, definedIn: foreign.definedIn, message: 'private warning' },
      ],
    });
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]).toMatchObject({ name: 'daily/notes', scope: 'project', projectId: '2026-10-10-notes', running: true,
      pending: '2026-10-10T09:00Z', enabled: true, blocked: false, warnings: ['Selected model is unavailable'] });
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({ id: selected.id, name: 'daily/notes', scope: 'project', stdoutLog: '/selected/logs/stdout.log' });
    expect(JSON.stringify(snapshot)).not.toContain('private error');
    expect(JSON.stringify(snapshot)).not.toContain('private warning');
  });

  it('reads retained scoped history without starting a worker and marks unfinished previous runs unobserved', async () => {
    const saved = new RunStorage(storage);
    saved.start({ ...run(root, 'unfinished'), status: 'running', finished: undefined });
    for (let index = 0; index < 205; index++) saved.start(run(other, `other-${index}`));
    controller = new AutomationController(storage);
    const report = await controller.inspect(root);
    expect(workers).toHaveLength(0);
    expect(report).toMatchObject({ available: true, jobs: [], runs: [{ id: 'unfinished', status: 'unobserved' }] });
  });

  it('asks an existing worker for all selected runs and retains global cached diagnostics', async () => {
    controller = new AutomationController(storage);
    const selected = run(root, 'selected-run'), foreign = run(other, 'foreign-run');
    controller.replace(root, [{ key: selected.key, root, definedIn: selected.definedIn, instance: 'work', declaration: definition }]);
    const pending = controller.inspect(root);
    expect(workers[0].messages.at(-1)).toMatchObject({ type: 'inspect', root });
    const jobs = [{ key: selected.key, root, definedIn: selected.definedIn, running: false },
      { key: foreign.key, root: other, definedIn: foreign.definedIn, running: false, error: 'foreign scheduler error' }];
    workers[0].emit('message', { type: 'inspection', id: workers[0].messages.at(-1)!.id,
      jobs, runs: Array.from({ length: 250 }, (_, index) => ({ ...selected, id: String(index), directory: storage })),
      modelWarnings: [{ root: other, key: foreign.key, definedIn: foreign.definedIn, message: 'foreign warning' }] });
    const report = await pending;
    expect(report.runs).toHaveLength(250); expect(report.jobs).toHaveLength(1); expect(report.modelWarnings).toEqual([]);
    expect(controller.issues(other)).toContain('instance work: foreign scheduler error');
  });

  it('preserves disk history when the worker fails and reports live state unavailable', async () => {
    const saved = new RunStorage(storage); saved.start(run(root, 'retained')); saved.start(run(other, 'private'));
    controller = new AutomationController(storage);
    const key = run(root, 'one').key;
    controller.replace(root, [{ key, root, definedIn: 'instance work', instance: 'work', declaration: definition }]);
    workers[0].emit('error', new Error('Worker stopped'));
    const report = await controller.inspect(root);
    expect(report).toMatchObject({ available: false, warning: 'Worker stopped', jobs: [], runs: [{ id: 'retained' }] });
    await expect(controller.inspect()).rejects.toThrow('Worker stopped');
    expect(workers).toHaveLength(1);
  });

  it('distinguishes disabled, blocked, and invalid jobs without guessing lifecycle states', () => {
    const scheduler = new AutomationScheduler({ run: async () => {}, claim: () => true, lastClaim: () => undefined });
    try {
      scheduler.replace([
        { key: 'disabled', root, definedIn: 'instance work', instance: 'work', declaration: { ...definition, enabled: false } },
        { key: 'blocked', root, definedIn: 'instance work', instance: 'work', declaration: { ...definition, enabled: true }, blocked: 'Worktree execution paused' },
        { key: 'invalid', root, definedIn: 'instance work', instance: 'work', declaration: {} },
      ]);
      expect(scheduler.status().find(job => job.key === 'disabled')).toMatchObject({ enabled: false, blocked: false, running: false });
      expect(scheduler.status().find(job => job.key === 'blocked')).toMatchObject({ enabled: true, blocked: true, error: 'Worktree execution paused' });
      expect(scheduler.status().find(job => job.key === 'invalid')?.enabled).toBeUndefined();
    } finally { scheduler.close(); }
  });

  it('keeps a removed job visible while its active execution finishes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    let finish!: () => void;
    const scheduler = new AutomationScheduler({ run: () => new Promise<void>(resolve => { finish = resolve; }), claim: () => true, lastClaim: () => undefined },
      'UTC', { now: () => Date.now(), monotonic: () => Date.now() });
    try {
      scheduler.replace([{ key: 'active', root, definedIn: 'instance work', instance: 'work',
        declaration: { ...definition, schedule: { cron: '* * * * *', timezone: 'UTC' } } }]);
      await vi.advanceTimersByTimeAsync(120000);
      expect(scheduler.status()[0]).toMatchObject({ running: true, pending: '2026-10-10T12:02:00.000Z' });
      scheduler.replace([]);
      expect(scheduler.status()).toHaveLength(1);
      expect(scheduler.status()[0]).toMatchObject({ running: true, enabled: false, next: undefined, pending: undefined });
      finish(); await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.status()).toEqual([]);
    } finally { scheduler.close(); vi.useRealTimers(); }
  });
});

describe('bounded automation logs', () => {
  it('reads byte ranges, supports EOF, and refuses other-instance or missing run IDs', () => {
    const saved = new RunStorage(storage), directory = saved.start(run(root, 'one'));
    const otherDirectory = saved.start(run(other, 'private'));
    writeFileSync(join(directory, 'stdout.log'), 'hello world'); writeFileSync(join(otherDirectory, 'stdout.log'), 'private');
    expect(readAutomationLog(storage, root, 'one', 'stdout', 0, 5)).toEqual({ text: 'hello', offset: 0, nextOffset: 5, totalBytes: 11 });
    expect(readAutomationLog(storage, root, 'one', 'stdout', 5, 100)).toMatchObject({ text: ' world', nextOffset: 11, totalBytes: 11 });
    expect(readAutomationLog(storage, root, 'one', 'stdout', 11, 100)).toMatchObject({ text: '', nextOffset: 11, totalBytes: 11 });
    expect(readAutomationLog(storage, root, 'private', 'stdout', 0, 100)).toBeNull();
    expect(readAutomationLog(storage, root, 'missing', 'stdout', 0, 100)).toBeNull();
    expect(readAutomationLog(storage, root, 'one', 'stderr', 0, 100)).toMatchObject({ text: '', totalBytes: 0 });
  });

  it('rejects unbounded or invalid ranges and refuses symlink log targets', () => {
    const saved = new RunStorage(storage), directory = saved.start(run(root, 'one'));
    const privateFile = join(temporary, 'private'); writeFileSync(privateFile, 'private');
    symlinkSync(privateFile, join(directory, 'stdout.log'));
    expect(() => readAutomationLog(storage, root, 'one', 'stdout', -1, 10)).toThrow('offset');
    expect(() => readAutomationLog(storage, root, 'one', 'stdout', 0, 65537)).toThrow('limit');
    expect(() => readAutomationLog(storage, root, 'one', '../private' as any, 0, 10)).toThrow('stream');
    expect(() => readAutomationLog(storage, root, 'one', 'stdout', 0, 10)).toThrow();
  });

  it('finishes UTF-8 code points at page boundaries even with a one-byte limit', () => {
    const saved = new RunStorage(storage), directory = saved.start(run(root, 'one'));
    writeFileSync(join(directory, 'stdout.log'), 'A🙂éZ');
    let offset = 0, text = '';
    do {
      const page = readAutomationLog(storage, root, 'one', 'stdout', offset, 1)!;
      expect(page.nextOffset).toBeGreaterThan(offset);
      text += page.text; offset = page.nextOffset;
      if (page.nextOffset >= page.totalBytes) break;
    } while (true);
    expect(text).toBe('A🙂éZ'); expect(offset).toBe(Buffer.byteLength(text));
  });

  it('rejects run metadata that claims a different root or storage bucket', () => {
    const saved = new RunStorage(storage), foreign = run(other, 'private');
    const directory = saved.start(foreign); writeFileSync(join(directory, 'stdout.log'), 'private');
    writeFileSync(join(directory, 'run.json'), JSON.stringify({ ...foreign, root }));
    expect(readAutomationLog(storage, root, 'private', 'stdout', 0, 100)).toBeNull();
    writeFileSync(join(directory, 'run.json'), JSON.stringify({ ...foreign, root, key: JSON.stringify([root, foreign.definedIn, 'daily/notes']) }));
    expect(readAutomationLog(storage, root, 'private', 'stdout', 0, 100)).toBeNull();
  });
});

describe('GraphQL daemon integration for automation inspection', () => {
  async function query(document: string, variables?: Record<string, unknown>) {
    const result = JSON.parse((await host!.tool(root, 'query', { document, variables })).text);
    expect(result.errors).toBeUndefined(); return result.data;
  }

  it('exposes paged retained run history and logs without starting a worker', async () => {
    init(root, { name: 'Selected', description: 'Fixture' });
    const saved = new RunStorage(storage);
    const directory = saved.start(run(root, 'selected-first'));
    saved.start({ ...run(root, 'selected-second'), started: '2026-10-09T08:00:00.000Z' });
    saved.start(run(other, 'private'));
    writeFileSync(join(directory, 'stdout.log'), 'hello world');
    host = new InstanceHost(new CalClient(null)); host.configureAutomation(storage);
    const data = await query(`{
      activeInstance {
        automations { totalCount nodes { name } }
        newest: automationLog(limit: 1) { totalCount offset count nodes { id name status stdoutLog filePath } }
        older: automationLog(limit: 1, offset: 1) { totalCount offset count nodes { id } }
        output: automationLog(where: {id: "selected-first"}) {
          nodes { output(stream: STDOUT, offset: 0, limit: 5) { offset text nextOffset totalBytes } }
        }
        private: automationLog(where: {id: "private"}) { totalCount nodes { id } }
      }
    }`);
    expect(data.activeInstance).toMatchObject({ automations: {totalCount: 0, nodes: []},
      newest: { totalCount: 2, offset: 0, count: 1, nodes: [{ id: 'selected-first', name: 'daily/notes', status: 'SUCCEEDED' }] },
      older: { totalCount: 2, offset: 1, count: 1, nodes: [{ id: 'selected-second' }] } });
    expect(data.activeInstance.newest.nodes[0].filePath).toBe(join(directory, 'run.json'));
    expect(data.activeInstance.output.nodes[0].output).toEqual({ offset: 0, text: 'hello', nextOffset: 5, totalBytes: 11 });
    expect(data.activeInstance.private).toEqual({totalCount: 0, nodes: []}); expect(workers).toHaveLength(0);
  });

  it('keeps histories owner-scoped, including removed names, and filters status sets before pagination', async () => {
    init(root, { name: 'Selected', description: 'Fixture' });
    const store = new Store(root);
    let first: string, second: string;
    try {
      const created = handleCapture(store, { content: 'Context', description: 'Context', projects: [
        { name: 'First', description: 'First owner', automations: { daily: definition } },
        { name: 'Second', description: 'Second owner', automations: { daily: definition } },
      ] }, new Date('2026-10-10T08:00:00Z'));
      [first, second] = created.createdProjectIds;
    } finally { store.close(); }
    const saved = new RunStorage(storage);
    saved.start(run(root, 'instance-success'));
    saved.start({ ...run(root, 'instance-failed'), status: 'failed' });
    saved.start(run(root, 'instance-removed', 'instance work', 'removed'));
    saved.start(run(root, 'first-daily', `#project/${first!}`, 'daily'));
    saved.start(run(root, 'first-removed', `#project/${first!}`, 'removed'));
    saved.start(run(root, 'second-daily', `#project/${second!}`, 'daily'));
    saved.start(run(root, 'deleted-project', '#project/deleted', 'daily'));
    // Loading project records can arm declared jobs. This fixture has no live
    // worker responses; provide retained history for the owner-filter checks.
    vi.spyOn(AutomationController.prototype, 'inspect').mockImplementation(async selectedRoot => ({
      available: true, jobs: [], runs: saved.history().filter(record => record.root === selectedRoot), modelWarnings: [],
    }));
    host = new InstanceHost(new CalClient(null)); host.configureAutomation(storage);
    const data = await query(`{
      activeInstance {
        automationLog { totalCount nodes { id name } }
        failures: automationLog(where: {status: [FAILED, TIMED_OUT]}) { totalCount nodes { id } }
        empty: automationLog(where: {status: []}) { totalCount nodes { id } }
        selected: automationLog(where: {status: [SUCCEEDED, FAILED]}, limit: 1, offset: 1) { totalCount count nodes { id } }
      }
      first: project(id: "${first!}") {
        automationLog { totalCount nodes { id name automation { name } } }
        automations { nodes { name log { totalCount nodes { id } } } }
      }
      second: project(id: "${second!}") { automationLog { totalCount nodes { id } } }
    }`);
    expect(data.activeInstance.automationLog).toEqual({ totalCount: 3, nodes: [
      { id: 'instance-success', name: 'daily/notes' },
      { id: 'instance-removed', name: 'removed' },
      { id: 'instance-failed', name: 'daily/notes' },
    ] });
    expect(data.activeInstance.failures).toEqual({ totalCount: 1, nodes: [{ id: 'instance-failed' }] });
    expect(data.activeInstance.empty).toEqual({ totalCount: 0, nodes: [] });
    expect(data.activeInstance.selected).toEqual({ totalCount: 3, count: 1, nodes: [{ id: 'instance-removed' }] });
    expect(data.first.automationLog).toEqual({ totalCount: 2, nodes: [
      { id: 'first-removed', name: 'removed', automation: null },
      { id: 'first-daily', name: 'daily', automation: { name: 'daily' } },
    ] });
    expect(data.first.automations).toEqual({ nodes: [{ name: 'daily', log: { totalCount: 1, nodes: [{ id: 'first-daily' }] } }] });
    expect(data.second.automationLog).toEqual({ totalCount: 1, nodes: [{ id: 'second-daily' }] });
  });

  it('reports absent automation support explicitly instead of presenting empty state as available', async () => {
    init(root, { name: 'Selected', description: 'Fixture' }); host = new InstanceHost(new CalClient(null));
    const result = JSON.parse((await host.tool(root, 'query', {document: '{ activeInstance { automations { nodes { name } } automationLog { totalCount nodes { id } } } }'})).text);
    expect(result.errors).toBeUndefined();
    expect(result.data.activeInstance).toMatchObject({ automations: {nodes: []}, automationLog: {totalCount: 0, nodes: []} });
    expect(result.extensions).toMatchObject({complete: false, diagnostics: expect.arrayContaining([
      expect.objectContaining({message: expect.stringContaining('no automation controller')}),
    ])});
    expect(workers).toHaveLength(0);
  });

  it('uses session selection without loading the instance or arming its saved jobs', async () => {
    init(root, { name: 'Selected', description: 'Fixture' });
    const manifest = join(root, 'aside.md');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('\n---\n', '\nautomations:\n  future:\n    schedule:\n      cron: "0 8 * * *"\n    run:\n      script: echo\n---\n'));
    host = new InstanceHost(new CalClient(null)); host.configureAutomation(storage);
    const load = vi.spyOn(host, 'load').mockImplementation(() => { throw new Error('Runtime inspection must not load an instance'); });
    const registry = new InstanceRegistry([root]); registry.activate(root);
    const session = new InstanceSession(registry, { knownInstances: async () => [root], issues: async () => [] }, [], true, true);
    const result = await host.graphql(session, 'query', { document: '{ activeInstance { automations { nodes { name enabled timeout overlap next running schedule { cron } run { script } } } automationLog { totalCount } } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({ activeInstance: {
      automations: {nodes: [{name: 'future', enabled: true, timeout: 'PT30M', overlap: 'LATEST', next: null, running: null, schedule: {cron: '0 8 * * *'}, run: {script: 'echo'}}]},
      automationLog: {totalCount: 0},
    } });
    expect(load).not.toHaveBeenCalled(); expect(workers).toHaveLength(0);
  });
});
