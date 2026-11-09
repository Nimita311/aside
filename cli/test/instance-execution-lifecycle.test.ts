import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AutomationSource} from '../src/automation/scheduler.js';

const bridge = vi.hoisted(() => ({
  replace: undefined as ((sources: AutomationSource[], worker: {emit(event: string, message: unknown): boolean}) => void) | undefined,
  close: undefined as (() => void) | undefined,
  sources: [] as AutomationSource[][],
  watchers: [] as Array<{root: string; ignored(path: string): boolean; emit(event: string, ...args: unknown[]): boolean}>,
  blockConfigReads: false,
}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {...actual, readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
    if (bridge.blockConfigReads && String(args[0]).endsWith('/.aside')) throw new Error('Managed inspection reread execution settings');
    return actual.readFileSync(...args);
  })};
});
vi.mock('node:worker_threads', async importOriginal => {
  const original = await importOriginal<typeof import('node:worker_threads')>();
  const {EventEmitter} = await import('node:events');
  return {...original, Worker: class extends EventEmitter {
    postMessage(message: {type: string; sources?: AutomationSource[]}) {
      if (message.type === 'replace') {bridge.sources.push(structuredClone(message.sources!)); bridge.replace?.(message.sources!, this);}
      if (message.type === 'close') {bridge.close?.(); this.emit('message', {type: 'closed'});}
    }
    terminate() {return Promise.resolve(0);}
  }};
});
vi.mock('chokidar', async () => {
  const {EventEmitter} = await import('node:events');
  return {watch: (root: string, options: {ignored(path: string): boolean}) => {
    const watcher = Object.assign(new EventEmitter(), {root, ignored: options.ignored, close: () => Promise.resolve()});
    bridge.watchers.push(watcher); return watcher;
  }};
});
import {AutomationScheduler} from '../src/automation/scheduler.js';
import {AutomationModelWarmup} from '../src/automation/model-warmup.js';
import {InstanceHost} from '../src/daemon/host.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession} from '../src/mcp/instance-session.js';

let directory: string, host: InstanceHost | undefined, scheduler: AutomationScheduler | undefined, warmup: AutomationModelWarmup | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T19:00:00Z'));
  directory = realpathSync(mkdtempSync('/private/tmp/aside-instance-execution-'));
});
afterEach(async () => {
  bridge.blockConfigReads = false;
  await host?.close(); scheduler?.close(); await warmup?.close();
  host = undefined; scheduler = undefined; warmup = undefined;
  bridge.replace = undefined; bridge.close = undefined; bridge.sources = []; bridge.watchers = [];
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  rmSync(directory, {recursive: true, force: true});
});

function fixture(watch = false, periodic = 50) {
  const root = join(directory, 'instance'); mkdirSync(root);
  writeFileSync(join(root, 'aside.md'), `---\nid: execution-owner\nautomations:\n  model:\n    schedule: {at: 2099-01-01T00:00:00Z}\n    run: {model: external, prompt: "#artifact/2026-10-08-instructions"}\n---\n`);
  const config = join(root, '.aside');
  writeFileSync(config, `execution:\n  models:\n    external: {command: ${JSON.stringify(process.execPath)}}\n`);
  if (!watch) vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  let worker: {emit(event: string, message: unknown): boolean} | undefined;
  const changed = () => worker?.emit('message', {type: 'status', jobs: scheduler!.status(), modelWarnings: warmup!.warnings()});
  const run = vi.fn(async () => {});
  scheduler = new AutomationScheduler({run, claim: () => true, lastClaim: () => undefined, changed}, 'UTC', {now: () => Date.now(), monotonic: () => Date.now()});
  warmup = new AutomationModelWarmup(changed, async () => ({models: [], diagnostics: [], revision: 'fixture'}));
  bridge.replace = (sources, current) => {worker = current; scheduler!.replace(sources); warmup!.replace(sources);};
  bridge.close = () => scheduler!.close();
  host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 5, reconciliationIntervalMs: periodic});
  host.configureAutomation(join(directory, 'runs'));
  const {store} = host.load(root);
  return {root, config, store, run};
}

describe('instance-owned execution settings', () => {
  it('repairs a missed config-only edit and refreshes worker warnings without moving its deadline', async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(15);
    expect(bridge.sources).toHaveLength(1);
    const first = f.store.getExecutionContext(), hash = f.store.getSourceVersion(), deadline = scheduler!.status()[0].next;
    expect(warmup!.warnings()).toEqual([]);
    writeFileSync(f.config, '{}\n');
    expect(f.store.getExecutionContext()).toBe(first);
    await vi.advanceTimersByTimeAsync(40);
    expect(f.store.getExecutionContext().revision).not.toBe(first.revision);
    expect(f.store.getSourceVersion()).toBe(hash);
    expect(bridge.sources).toHaveLength(2);
    expect(bridge.sources[1][0].declaration).toEqual(bridge.sources[0][0].declaration);
    expect(bridge.sources[1][0].executionContext).toEqual(f.store.getExecutionContext());
    expect(scheduler!.status()[0].next).toBe(deadline);
    expect(host!.issues(f.root)).toContainEqual(expect.objectContaining({message: expect.stringContaining('Model "external" is not defined')}));
    expect(f.run).not.toHaveBeenCalled();
  });

  it('uses loaded context for GraphQL cwd and models while the config file is ahead', async () => {
    const f = fixture(false, 0); await vi.advanceTimersByTimeAsync(15);
    const registry = new InstanceRegistry([f.root]); registry.activate(f.root);
    const session = new InstanceSession(registry, {knownInstances: async () => [f.root], issues: async () => []}, [], false);
    writeFileSync(f.config, 'execution: [invalid]\n');
    vi.stubEnv('PATH', '/nonexistent');
    bridge.blockConfigReads = true; vi.mocked(readFileSync).mockClear();
    const rebuild = vi.spyOn(f.store, 'rebuild');
    const result = await host!.graphql(session, 'query', {document: '{activeInstance{execution{cwd models{name}}}}'});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({activeInstance: {execution: {cwd: f.root, models: [{name: 'external'}]}}});
    expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => String(path).endsWith('/.aside'))).toEqual([]);
    expect(rebuild).not.toHaveBeenCalled();
    expect(f.store.getExecutionContext().error).toBeUndefined();
  });

  it('pauses invalid execution settings and resumes after owner-driven repair', async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(15);
    const deadline = scheduler!.status()[0].next;
    writeFileSync(f.config, 'execution: [invalid]\n');
    await vi.advanceTimersByTimeAsync(40);
    expect(f.store.getExecutionContext().error).toContain('Invalid execution config');
    expect(scheduler!.status()).toEqual([expect.objectContaining({blocked: true, error: expect.stringContaining('Invalid execution config')})]);
    expect(host!.issues(f.root)).toContainEqual(expect.objectContaining({code: 'execution_config', file: '.aside'}));
    writeFileSync(f.config, `execution:\n  models:\n    external: {command: ${JSON.stringify(process.execPath)}}\n`);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.store.getExecutionContext().error).toBeUndefined();
    expect(scheduler!.status()[0].blocked).toBe(false);
    expect(scheduler!.status()[0].next).toBe(deadline);
    expect(warmup!.warnings()).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('delivers a root .aside watcher event through lifecycle and publishes its new execution generation', async () => {
    const f = fixture(true, 0); await vi.advanceTimersByTimeAsync(15);
    const first = f.store.getExecutionContext().revision, watcher = bridge.watchers.find(watcher => watcher.root === f.root)!;
    expect(watcher.ignored(f.config)).toBe(false);
    expect(watcher.ignored(join(f.root, '.unrelated'))).toBe(true);
    writeFileSync(f.config, '{}\n'); watcher.emit('all', 'change', f.config);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.store.getExecutionContext().revision).not.toBe(first);
    expect(bridge.sources.at(-1)![0].executionContext).toEqual(f.store.getExecutionContext());
    expect(warmup!.warnings()).toContainEqual(expect.objectContaining({message: expect.stringContaining('Model "external" is not defined')}));
  });

  it('publishes cwd disappearance and repair even when execution config bytes are unchanged', async () => {
    const f = fixture(); await vi.advanceTimersByTimeAsync(15);
    const cwd = join(f.root, 'work'); mkdirSync(cwd);
    const source = `execution:\n  cwd: work\n  models:\n    external: {command: ${JSON.stringify(process.execPath)}}\n`;
    writeFileSync(f.config, source); await host!.data(f.root, true); await vi.advanceTimersByTimeAsync(10);
    const original = f.store.getExecutionContext().revision;
    const registry = new InstanceRegistry([f.root]); registry.activate(f.root);
    const session = new InstanceSession(registry, {knownInstances: async () => [f.root], issues: async () => []}, [], false);
    const query = async () => {
      bridge.blockConfigReads = true; vi.mocked(readFileSync).mockClear();
      try {
        const result = await host!.graphql(session, 'query', {document: '{activeInstance{execution{cwd}}}'});
        expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => String(path).endsWith('/.aside'))).toEqual([]);
        expect(result.errors).toBeUndefined(); return result;
      } finally {bridge.blockConfigReads = false;}
    };
    rmSync(cwd, {recursive: true});
    expect((await query()).data).toEqual({activeInstance: {execution: {cwd}}});
    await vi.advanceTimersByTimeAsync(30);
    expect(f.store.getExecutionContext().revision).not.toBe(original);
    expect(f.store.getExecutionContext().error).toContain('Invalid execution cwd');
    const missing = await query();
    expect(missing.data).toEqual({activeInstance: {execution: {cwd: null}}});
    expect(missing.extensions?.diagnostics).toContainEqual(expect.objectContaining({code: 'execution_config', message: expect.stringContaining('Invalid execution cwd')}));
    expect(readFileSync(f.config, 'utf8')).toBe(source);
    mkdirSync(cwd); await vi.advanceTimersByTimeAsync(50);
    expect(f.store.getExecutionContext().revision).toBe(original);
    expect(f.store.getExecutionContext().error).toBeUndefined();
    expect((await query()).data).toEqual({activeInstance: {execution: {cwd}}});
  });
});
