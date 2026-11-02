import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { builtinModel, discoverClaudeModels, discoverCodexModels, executablePath, ModelCatalog, modelEnumName, readExecutionContext, type ModelDiscovery } from '../src/automation/models.js';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }));
let root: string, state: string, env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = realpathSync(mkdtempSync('/tmp/aside-models-')); state = join(root, 'state');
  mkdirSync(join(root, 'bin')); env = { PATH: join(root, 'bin'), ASIDE_DAEMON_HOME: state, HOME: root };
  vi.stubEnv('ASIDE_DAEMON_HOME', state);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); sdk.query.mockReset(); rmSync(root, { recursive: true, force: true }); });
function executable(name: string, body = ''): string {
  const path = join(root, 'bin', name);
  writeFileSync(path, `#!${process.execPath}\n${body}`); chmodSync(path, 0o700); return path;
}
function catalog(discover: ModelDiscovery): ModelCatalog { return new ModelCatalog({ discover, env: () => env }); }

describe('instance model catalogs', () => {
  it('discovers only installed runtimes, exact vendor aliases and configured executable names', async () => {
    executable('claude'); executable('custom');
    writeFileSync(join(root, '.aside'), 'execution:\n  models:\n    digest: {model: CLAUDE_SONNET}\n    external: {command: custom, args: [run]}\n    missing: {command: nonexistent}\n');
    const discover = vi.fn<ModelDiscovery>(async () => [{ model: 'sonnet', label: 'Sonnet' }, { model: 'claude-sonnet-5' }]);
    const result = await catalog(discover).for(root);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0].slice(0, 3)).toEqual(['claude', join(root, 'bin', 'claude'), root]);
    expect(result.models.map(model => model.name)).toEqual(['CLAUDE_CLAUDE_SONNET_5', 'CLAUDE_SONNET', 'digest', 'external']);
    expect(result.models.find(model => model.name === 'digest')).toMatchObject({ builtin: false, engine: 'claude', model: 'sonnet' });
    expect(result.diagnostics).toContain('Named model missing: executable is not installed');
    expect(builtinModel('CLAUDE_SONNET', root)).toEqual({ engine: 'claude', model: 'sonnet' });
    expect(builtinModel('CODEX_DEFAULT', root)).toBeUndefined();
  });
  it('caches requests, explicitly refreshes, and preserves exact removed model bindings across restart', async () => {
    executable('codex');
    const discover = vi.fn<ModelDiscovery>().mockResolvedValueOnce([{ model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]).mockResolvedValue([{ model: 'gpt-6.2-sol' }]);
    const first = catalog(discover), snapshot = await first.for(root);
    expect(snapshot.models[0]).toMatchObject({ name: 'CODEX_GPT_6_1_SOL', model: 'gpt-6.1-sol' });
    snapshot.models[0].label = 'mutated';
    expect((await first.for(root)).models[0].label).toBe('GPT-6.1 Sol');
    expect(discover).toHaveBeenCalledTimes(1);
    expect((await first.for(root, { refresh: true })).models.map(model => model.name)).toEqual(['CODEX_GPT_6_2_SOL']);
    expect(builtinModel('CODEX_GPT_6_1_SOL', root)).toEqual({ engine: 'codex', model: 'gpt-6.1-sol' });
    expect((await catalog(discover).for(root)).models[0].name).toBe('CODEX_GPT_6_2_SOL');
  });
  it('retains persisted last-good choices as unknown when vendor discovery fails without leaking its error', async () => {
    executable('codex');
    await catalog(async () => [{ model: 'gpt-6.1-sol' }]).for(root);
    const result = await catalog(async () => { throw new Error('secret_api_key=credentials'); }).for(root);
    expect(result.models[0]).toMatchObject({ name: 'CODEX_GPT_6_1_SOL', availability: 'UNKNOWN' });
    expect(JSON.stringify(result)).not.toContain('secret_api_key');
    expect(result.diagnostics).toEqual(['codex: Model discovery failed']);
  });
  it('does not invent aliases or show last-good choices when runtime is uninstalled', async () => {
    const path = executable('claude');
    const models = catalog(async () => [{ model: 'sonnet' }]);
    await models.for(root); rmSync(path);
    expect((await models.for(root)).models).toEqual([]);
    expect(builtinModel('CLAUDE_SONNET', root)).toEqual({ engine: 'claude', model: 'sonnet' });
  });
  it('updates named CLI choices when its executable is installed or removed', async () => {
    writeFileSync(join(root, '.aside'), 'execution:\n  models:\n    external: {command: custom}\n');
    const models = catalog(async () => []);
    expect((await models.for(root)).models).toEqual([]);
    const path = executable('custom');
    expect((await models.for(root)).models.map(model => model.name)).toEqual(['external']);
    rmSync(path); expect((await models.for(root)).models).toEqual([]);
  });
  it('invalidates on effective cwd, named configuration, PATH and runtime replacement', async () => {
    executable('codex'); mkdirSync(join(root, 'work'));
    const discover = vi.fn<ModelDiscovery>(async () => [{ model: 'gpt-6.1-sol' }]);
    const models = catalog(discover); await models.for(root);
    writeFileSync(join(root, '.aside'), 'execution: {cwd: work}'); await models.for(root);
    expect(discover.mock.calls.at(-1)?.[2]).toBe(join(root, 'work'));
    writeFileSync(join(root, 'work', '.claude-settings.json'), 'unrelated'); await models.for(root);
    expect(discover).toHaveBeenCalledTimes(2);
    mkdirSync(join(root, 'work', '.claude')); writeFileSync(join(root, 'work', '.claude', 'settings.json'), '{}'); await models.for(root);
    executable('codex', '/* replacement */'); await models.for(root);
    env = { ...env, PATH: env.PATH + ':/nonexistent' }; await models.for(root);
    expect(discover).toHaveBeenCalledTimes(5);
  });
  it('rejects colliding vendor identifiers and never reinterprets historical selections', async () => {
    executable('codex');
    const first = await catalog(async () => [{ model: 'gpt-6.1-sol' }, { model: 'gpt_6_1_sol' }]).for(root);
    expect(first.models).toEqual([]); expect(first.diagnostics[0]).toContain('Ambiguous vendor model enum name');
    await catalog(async () => [{ model: 'gpt-6.1-sol' }]).for(root);
    const changed = await catalog(async () => [{ model: 'gpt_6_1_sol' }]).for(root);
    expect(changed.models[0]).toMatchObject({ model: 'gpt-6.1-sol', availability: 'UNKNOWN' });
    expect(builtinModel('CODEX_GPT_6_1_SOL', root)).toEqual({ engine: 'codex', model: 'gpt-6.1-sol' });
  });
  it('withholds new choices when metadata cannot be persisted and preserves malformed caches', async () => {
    executable('codex');
    writeFileSync(state, 'not a directory');
    expect((await catalog(async () => [{ model: 'new-model' }]).for(root)).models).toEqual([]);
    rmSync(state); await catalog(async () => [{ model: 'old-model' }]).for(root);
    const { readdirSync } = await import('node:fs');
    const path = join(state, 'models', readdirSync(join(state, 'models')).find(name => name.endsWith('.json'))!);
    writeFileSync(path, '{malformed');
    const result = await catalog(async () => [{ model: 'new-model' }]).for(root);
    expect(result.models).toEqual([]); expect(readFileSync(path, 'utf8')).toBe('{malformed');
    expect(() => builtinModel('CODEX_OLD_MODEL', root)).toThrow();
  });
  it('preserves the last readable cache when cumulative historical identities reach its size limit', async () => {
    executable('codex'); let batch = 0;
    const models = catalog(async () => Array.from({ length: 500 }, (_, index) => ({ model: `batch${batch}-model${index}`, label: 'x'.repeat(1024) })));
    await models.for(root);
    batch = 1; await models.for(root, { refresh: true });
    const { readdirSync } = await import('node:fs');
    const path = join(state, 'models', readdirSync(join(state, 'models')).find(name => name.endsWith('.json'))!);
    const previous = readFileSync(path, 'utf8');
    batch = 2;
    const rejected = await models.for(root, { refresh: true });
    expect(rejected.diagnostics).toContain('Model cache exceeds its size limit');
    expect(rejected.models).toHaveLength(500);
    expect(rejected.models[0]).toMatchObject({ availability: 'UNKNOWN', reason: 'Model cache exceeds its size limit' });
    expect(rejected.models.every(model => model.model?.startsWith('batch1-'))).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(previous);
    expect(builtinModel('CODEX_BATCH0_MODEL0', root)?.model).toBe('batch0-model0');
    expect(builtinModel('CODEX_BATCH2_MODEL0', root)).toBeUndefined();
  });
  it('bounds vendor catalog size and coalesces simultaneous requests', async () => {
    executable('codex');
    let release!: (models: Array<{ model: string }>) => void;
    const discover = vi.fn<ModelDiscovery>(() => new Promise(resolveDone => { release = resolveDone; }));
    const models = catalog(discover), first = models.for(root), second = models.for(root);
    release([{ model: 'sonnet' }]);
    expect(await first).toEqual(await second); expect(discover).toHaveBeenCalledTimes(1);
    expect((await catalog(async () => Array.from({ length: 501 }, (_, index) => ({ model: `m${index}` }))).for(root)).diagnostics[0]).toContain('size limit');
  });
  it('keeps shared discovery alive when its first caller cancels', async () => {
    executable('codex');
    let release!: (models: Array<{ model: string }>) => void;
    const discover = vi.fn<ModelDiscovery>(() => new Promise(resolveDone => { release = resolveDone; }));
    const models = catalog(discover), firstCaller = new AbortController();
    const first = models.for(root, { signal: firstCaller.signal }), second = models.for(root);
    firstCaller.abort();
    await expect(first).rejects.toThrow();
    release([{ model: 'shared-model' }]);
    expect((await second).models[0].model).toBe('shared-model');
    expect(discover).toHaveBeenCalledOnce();
    expect((await models.for(root)).models[0].model).toBe('shared-model');
  });
  it('does not publish an old context after a newer probe completed, while preserving both identities', async () => {
    executable('codex'); mkdirSync(join(root, 'work'));
    const releases: Array<(models: Array<{ model: string }>) => void> = [];
    const discover = vi.fn<ModelDiscovery>(() => new Promise(resolveDone => releases.push(resolveDone)));
    const models = catalog(discover), first = models.for(root);
    writeFileSync(join(root, '.aside'), 'execution: {cwd: work}');
    const second = models.for(root);
    releases[1]([{ model: 'current-cwd-model' }]); await second;
    releases[0]([{ model: 'previous-cwd-model' }]); await first;
    expect(builtinModel('CODEX_PREVIOUS_CWD_MODEL', root)?.model).toBe('previous-cwd-model');
    expect(builtinModel('CODEX_CURRENT_CWD_MODEL', root)?.model).toBe('current-cwd-model');
    expect((await models.for(root)).models.map(model => model.model)).toEqual(['current-cwd-model']);
    expect(discover).toHaveBeenCalledTimes(2);
    const fallback = await catalog(async () => { throw new Error('unavailable'); }).for(root);
    expect(fallback.models.map(model => model.model)).toEqual(['current-cwd-model']);
  });
  it('persists historical bindings from an obsolete probe without publishing them as current choices', async () => {
    executable('codex'); mkdirSync(join(root, 'work'));
    let release!: (models: Array<{ model: string }>) => void;
    const models = catalog(() => new Promise(resolveDone => { release = resolveDone; }));
    const first = models.for(root);
    writeFileSync(join(root, '.aside'), 'execution: {cwd: work}');
    release([{ model: 'old-context-model' }]);
    expect((await first).models).toEqual([]);
    expect(builtinModel('CODEX_OLD_CONTEXT_MODEL', root)?.model).toBe('old-context-model');
    expect((await catalog(async () => { throw new Error('unavailable'); }).for(root)).models).toEqual([]);
  });
  it('publishes initialization metadata and caches against its final volatile file stamps', async () => {
    executable('codex');
    const discover = vi.fn<ModelDiscovery>(async () => {
      mkdirSync(join(root, '.codex'));
      writeFileSync(join(root, '.codex', 'auth.json'), '{}');
      writeFileSync(join(root, '.claude.json'), '{"numStartups":1}');
      return [{ model: 'initialized-model' }];
    });
    const models = catalog(discover);
    expect((await models.for(root)).models[0].model).toBe('initialized-model');
    expect(builtinModel('CODEX_INITIALIZED_MODEL', root)?.model).toBe('initialized-model');
    expect((await models.for(root)).models[0].model).toBe('initialized-model');
    expect(discover).toHaveBeenCalledOnce();
  });
  it('merges concurrent catalog writers without losing immutable historical bindings', async () => {
    executable('codex');
    let firstRelease!: (models: Array<{ model: string }>) => void, secondRelease!: (models: Array<{ model: string }>) => void;
    const first = catalog(() => new Promise(resolveDone => { firstRelease = resolveDone; })).for(root);
    const second = catalog(() => new Promise(resolveDone => { secondRelease = resolveDone; })).for(root);
    firstRelease([{ model: 'first-model' }]); await first;
    secondRelease([{ model: 'second-model' }]); await second;
    expect(builtinModel('CODEX_FIRST_MODEL', root)).toEqual({ engine: 'codex', model: 'first-model' });
    expect(builtinModel('CODEX_SECOND_MODEL', root)).toEqual({ engine: 'codex', model: 'second-model' });
  });
  it('rejects array-shaped persisted mappings without silently losing new bindings', async () => {
    executable('codex');
    await catalog(async () => [{ model: 'old-model' }]).for(root);
    const { readdirSync } = await import('node:fs');
    const path = join(state, 'models', readdirSync(join(state, 'models')).find(name => name.endsWith('.json'))!);
    for (const field of ['bindings', 'catalogs']) {
      const malformed = { version: 1, root, bindings: {}, catalogs: {}, [field]: [] };
      writeFileSync(path, JSON.stringify(malformed));
      expect((await catalog(async () => [{ model: 'new-model' }]).for(root)).models).toEqual([]);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(malformed);
      expect(() => builtinModel('CODEX_NEW_MODEL', root)).toThrow('Invalid model cache');
    }
  });
  it('rejects a conflicting concurrent binding instead of overwriting its exact vendor identifier', async () => {
    executable('codex');
    let firstRelease!: (models: Array<{ model: string }>) => void, secondRelease!: (models: Array<{ model: string }>) => void;
    const first = catalog(() => new Promise(resolveDone => { firstRelease = resolveDone; })).for(root);
    const second = catalog(() => new Promise(resolveDone => { secondRelease = resolveDone; })).for(root);
    firstRelease([{ model: 'gpt-6.1-sol' }]); await first;
    secondRelease([{ model: 'gpt_6_1_sol' }]);
    const result = await second;
    expect(result.models[0]).toMatchObject({ model: 'gpt-6.1-sol', availability: 'UNKNOWN' });
    expect(result.diagnostics).toContain('Ambiguous vendor model enum name: CODEX_GPT_6_1_SOL');
    expect(builtinModel('CODEX_GPT_6_1_SOL', root)).toEqual({ engine: 'codex', model: 'gpt-6.1-sol' });
  });
  it('cancels discovery promptly and does not cache an aborted snapshot', async () => {
    executable('codex'); const controller = new AbortController();
    const discover = vi.fn<ModelDiscovery>().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue([{ model: 'gpt-6.1-sol' }]);
    const models = catalog(discover), first = models.for(root, { signal: controller.signal });
    controller.abort(); await expect(first).rejects.toThrow();
    expect((await models.for(root)).models[0].model).toBe('gpt-6.1-sol');
    expect(discover).toHaveBeenCalledTimes(2);
  });
  it('bounds a provider that ignores cancellation with an initialization timeout', async () => {
    executable('codex'); vi.useFakeTimers();
    const work = catalog(() => new Promise(() => {})).for(root);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await work).diagnostics).toContain('codex: Model discovery interrupted or timed out');
  });
  it('reads only instance .aside and resolves custom binaries in effective cwd', () => {
    mkdirSync(join(root, 'work')); writeFileSync(join(root, 'work', '.aside'), 'execution: {cwd: bad}');
    writeFileSync(join(root, '.aside'), 'execution: {cwd: work}');
    expect(readExecutionContext(root).cwd).toBe(join(root, 'work'));
    const path = join(root, 'work', 'agent'); writeFileSync(path, ''); chmodSync(path, 0o700);
    expect(executablePath('./agent', join(root, 'work'), env)).toBe(path);
    expect(executablePath('agent', root, env)).toBeUndefined();
    writeFileSync(join(root, '.aside'), 'execution: {agents: {bad: {engine: codex}}}');
    expect(() => readExecutionContext(root)).toThrow('Invalid execution config');
  });

  it('ignores relative and empty PATH entries so the execution cwd cannot supply a vendor CLI', () => {
    mkdirSync(join(root, 'work'));
    const planted = join(root, 'work', 'codex'); writeFileSync(planted, ''); chmodSync(planted, 0o700);
    for (const PATH of ['', '.', 'bin', `.${delimiter}${join(root, 'bin')}`]) {
      expect(executablePath('codex', join(root, 'work'), { ...env, PATH })).toBeUndefined();
    }
    const real = executable('codex');
    expect(executablePath('codex', join(root, 'work'), { ...env, PATH: `.${delimiter}${join(root, 'bin')}` })).toBe(real);
  });
});

describe('inference-free runtime discovery', () => {
  it('initializes Codex, requests each catalog page and sends no thread or inference request', async () => {
    const log = join(root, 'messages.jsonl');
    const path = executable('codex', `const fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line', line=>{fs.appendFileSync(${JSON.stringify(log)},line+'\\n');const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));if(m.method==='model/list')console.log(JSON.stringify({id:m.id,result:m.params.cursor?{data:[{model:'second',displayName:'Second'}],nextCursor:null}:{data:[{model:'gpt-6.1-sol',displayName:'Sol'}],nextCursor:'next'}}));});`);
    expect(await discoverCodexModels(path, root, AbortSignal.timeout(3000), env)).toEqual([{ model: 'gpt-6.1-sol', label: 'Sol' }, { model: 'second', label: 'Second' }]);
    const messages = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(messages.map(message => message.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list']);
    expect(messages[3].params.cursor).toBe('next');
  });
  it('rejects malformed Codex output and aborts a hung app-server', async () => {
    const path = executable('codex', "process.stdin.on('data',()=>console.log('invalid-json'));");
    await expect(discoverCodexModels(path, root, AbortSignal.timeout(3000), env)).rejects.toThrow('invalid JSON');
    const hanging = executable('codex', "process.stdin.resume();");
    await expect(discoverCodexModels(hanging, root, AbortSignal.timeout(40), env)).rejects.toThrow('interrupted');
  });
  it('waits for forced cleanup when an app-server ignores termination', async () => {
    const pidFile = join(root, 'pid');
    const path = executable('codex', `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`);
    const controller = new AbortController(), work = discoverCodexModels(path, root, controller.signal, env);
    // Await fixture readiness without relying on native watcher permissions.
    try { await vi.waitFor(() => { expect(existsSync(pidFile)).toBe(true); }, { timeout: 3000, interval: 20 }); }
    finally { controller.abort(); }
    await expect(work).rejects.toThrow('interrupted');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    // SIGKILL is sent before discovery settles; reap notification may arrive
    // on the next event-loop turn.
    await new Promise(resolveDone => setTimeout(resolveDone, 20));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('closes an exited wrapper and its surviving process-group descendants promptly', async () => {
    const pidFile = join(root, 'descendant-pid');
    const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.send('ready');setInterval(()=>{},1000);`;
    const path = executable('codex', `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});child.once('message',()=>process.exit(0));`);
    await expect(discoverCodexModels(path, root, AbortSignal.timeout(3000), env)).rejects.toThrow('exited before completing');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1000, interval: 20 });
  });
  it('waits for owned subprocess teardown when the last catalog caller cancels', async () => {
    const pidFile = join(root, 'owned-pid');
    executable('codex', `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000);`);
    const models = new ModelCatalog({ env: () => env }), firstCaller = new AbortController(), lastCaller = new AbortController();
    const first = models.for(root, { signal: firstCaller.signal }), last = models.for(root, { signal: lastCaller.signal });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 3000, interval: 20 });
    firstCaller.abort(); await expect(first).rejects.toThrow();
    let finished = false;
    const rejected = expect(last).rejects.toThrow().then(() => { finished = true; });
    lastCaller.abort(); await Promise.resolve();
    expect(finished).toBe(false);
    await rejected;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1000, interval: 20 });
  });
  it('exposes Claude native aliases and reported exact IDs without yielding an inference prompt', async () => {
    const close = vi.fn(); let input!: AsyncIterator<unknown>;
    sdk.query.mockImplementation(({ prompt }) => {
      input = prompt[Symbol.asyncIterator]();
      return { supportedModels: async () => [
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
        { value: 'sonnet[1m]', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 1M' },
        { value: 'opus', displayName: 'Opus' },
        { value: 'claude-haiku-5', resolvedModel: 'claude-haiku-5', displayName: 'Haiku' },
      ], close };
    });
    const discovered = await discoverClaudeModels('/installed/claude', root, AbortSignal.timeout(3000), env);
    expect(discovered.map(model => model.model)).toEqual(['sonnet', 'claude-sonnet-5', 'sonnet[1m]', 'opus', 'claude-haiku-5']);
    expect(discovered.filter(model => model.model === 'claude-sonnet-5')).toHaveLength(1);
    expect(discovered.find(model => model.model === 'claude-haiku-5')).toMatchObject({ label: 'Haiku' });
    expect(await input.next()).toEqual({ value: undefined, done: true });
    expect(sdk.query.mock.calls[0][0].options).toMatchObject({
      cwd: root, env, pathToClaudeCodeExecutable: '/installed/claude', persistSession: false,
      settingSources: ['user', 'project', 'local'], settings: { disableAllHooks: true },
      strictMcpConfig: true,
    });
    expect(sdk.query.mock.calls[0][0].options.mcpServers).toEqual({});
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('closes Claude discovery on failure and cancellation without sending a prompt', async () => {
    const close = vi.fn();
    sdk.query.mockReturnValue({ supportedModels: () => Promise.reject(new Error('vendor failure')), close });
    await expect(discoverClaudeModels('/installed/claude', root, new AbortController().signal, env)).rejects.toThrow('vendor failure');
    sdk.query.mockReturnValue({ supportedModels: () => new Promise(() => {}), close });
    await expect(discoverClaudeModels('/installed/claude', root, AbortSignal.timeout(20), env)).rejects.toThrow('interrupted');
    expect(close).toHaveBeenCalledTimes(3);
  });
  it('preserves exact vendor IDs and rejects invalid IDs instead of guessing', () => {
    expect(modelEnumName('claude', 'sonnet[1m]')).toBe('CLAUDE_SONNET_1M_');
    expect(modelEnumName('codex', 'gpt-6.1-sol')).toBe('CODEX_GPT_6_1_SOL');
    expect(() => modelEnumName('codex', '\u0000')).toThrow('invalid model');
  });
});
