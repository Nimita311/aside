import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseConfig } from '../core/parser.js';
import type { ExecutionConfig } from '../core/automation.js';
import { MODEL_CATALOG_LOCK_TIMEOUT_MS, MODEL_DISCOVERY_MAX_BYTES, MODEL_DISCOVERY_MAX_MODELS, MODEL_DISCOVERY_TERMINATE_TIMEOUT_MS, MODEL_DISCOVERY_TIMEOUT_MS } from '../core/system-config.js';
import { daemonPaths } from '../daemon/paths.js';
import { FileLock } from '../daemon/filelock.js';

export type ModelEngine = 'codex' | 'claude';
export interface VendorModel { model: string; label?: string }
export interface ModelOption {
  name: string; label: string; builtin: boolean;
  engine?: ModelEngine; model?: string;
  availability: 'AVAILABLE' | 'UNKNOWN'; reason?: string;
}
export interface ModelCatalogSnapshot { models: ModelOption[]; diagnostics: string[]; revision: string }
export interface CatalogOptions { refresh?: boolean; signal?: AbortSignal }
interface Binding { engine: ModelEngine; model: string; label: string }
interface SavedCatalog { version: 1; root: string; bindings: Record<string, Binding>; catalogs: Partial<Record<ModelEngine, VendorModel[]>> }
export type ModelDiscovery = (engine: ModelEngine, command: string, cwd: string, signal: AbortSignal, env: NodeJS.ProcessEnv) => Promise<VendorModel[]>;
export interface ModelCatalogOptions { discover?: ModelDiscovery; stateDirectory?: string; env?: () => NodeJS.ProcessEnv }

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); return Promise.reject(new Error('Model discovery interrupted')); }
  return new Promise((resolveResult, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Model discovery interrupted')); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolveResult, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}

export function readExecutionContext(root: string): { config: ExecutionConfig; cwd: string } {
  const file = join(root, '.aside');
  const parsed = existsSync(file) ? parseConfig(readFileSync(file, 'utf8')) : { value: {}, issues: [] };
  if (parsed.issues.some(issue => issue.severity === 'error')) throw new Error(`Invalid execution config: ${parsed.issues.map(issue => issue.message).join('; ')}`);
  const config = parsed.value.execution ?? {};
  const cwd = resolve(root, config.cwd ?? '.');
  if (!statSync(cwd).isDirectory()) throw new Error(`Execution cwd is not a directory: ${cwd}`);
  return { config, cwd };
}

// Spawn and discovery use the same PATH and effective working directory.
export function executablePath(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = command.includes('/') || command.includes('\\') ? [resolve(cwd, command)]
    // Relative or empty PATH entries would resolve inside the execution cwd,
    // letting a file written there stand in for a vendor CLI.
    : (env.PATH ?? '').split(delimiter).filter(directory => isAbsolute(directory)).flatMap(directory => {
      const base = join(directory, command);
      return process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')].map(extension => base + extension) : [base];
    });
  for (const path of candidates) {
    try { if (statSync(path).isFile()) { accessSync(path, constants.X_OK); return path; } } catch {}
  }
  return undefined;
}

export function modelEnumName(engine: ModelEngine, model: string): string {
  if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('Vendor reported an invalid model identifier');
  return `${engine.toUpperCase()}_${model.toUpperCase().replace(/[^A-Z0-9_]+/g, '_')}`;
}
function stateDirectory(env: NodeJS.ProcessEnv): string { return join(daemonPaths(env).state, 'models'); }
function cachePath(root: string, directory: string): string { return join(directory, hash(resolve(root)) + '.json'); }
function readSaved(root: string, directory: string): SavedCatalog {
  const path = cachePath(root, directory);
  try {
    if (statSync(path).size > 2 * MODEL_DISCOVERY_MAX_BYTES) throw new Error('Model cache is too large');
    const value = JSON.parse(readFileSync(path, 'utf8')) as SavedCatalog;
    if (!value || value.version !== 1 || value.root !== resolve(root) || !value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)
      || !value.catalogs || typeof value.catalogs !== 'object' || Array.isArray(value.catalogs)) throw new Error('Invalid model cache');
    for (const [name, binding] of Object.entries(value.bindings)) {
      if (!['codex', 'claude'].includes(binding.engine) || modelEnumName(binding.engine, binding.model) !== name || typeof binding.label !== 'string') throw new Error('Invalid model binding');
    }
    for (const engine of ['codex', 'claude'] as const) {
      if (!value.catalogs[engine]) continue;
      for (const model of validateVendorModels(value.catalogs[engine]!)) {
        const binding = value.bindings[modelEnumName(engine, model.model)];
        if (!binding || binding.engine !== engine || binding.model !== model.model) throw new Error('Invalid model catalog binding');
      }
    }
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { version: 1, root: resolve(root), bindings: {}, catalogs: {} };
}
function save(root: string, directory: string, value: SavedCatalog): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 2 * MODEL_DISCOVERY_MAX_BYTES) throw new Error('Model cache exceeds its size limit');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = cachePath(root, directory), temporary = join(directory, `.${randomUUID()}.tmp`);
  try { writeFileSync(temporary, serialized, { mode: 0o600 }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch {} }
}
async function mergeSaved(root: string, directory: string, discovered: SavedCatalog, updated: Set<ModelEngine>, current: () => boolean, signal?: AbortSignal): Promise<SavedCatalog> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = new FileLock(cachePath(root, directory) + '.lock');
  if (!await lock.acquireWait(MODEL_CATALOG_LOCK_TIMEOUT_MS)) throw new Error('Cannot lock the model catalog');
  try {
    signal?.throwIfAborted();
    const latest = readSaved(root, directory);
    const previous = JSON.stringify(latest);
    for (const [name, binding] of Object.entries(discovered.bindings)) {
      const current = latest.bindings[name];
      if (current && (current.engine !== binding.engine || current.model !== binding.model)) throw new Error(`Ambiguous vendor model enum name: ${name}`);
      latest.bindings[name] = binding;
    }
    // A probe from an old execution context may still add immutable identities,
    // but must not replace the current picker after a newer context was read.
    if (current()) for (const engine of updated) latest.catalogs[engine] = discovered.catalogs[engine];
    if (JSON.stringify(latest) !== previous) save(root, directory, latest);
    return latest;
  } finally { lock.release(); }
}

// Execution never queries a vendor. Keep historical bindings after a model
// disappears from the current picker, so a saved selection keeps its meaning.
export function builtinModel(name: string, root?: string): { engine: ModelEngine; model: string } | undefined {
  if (!root) return undefined;
  const directory = stateDirectory(process.env);
  const saved = readSaved(root, directory);
  const binding = Object.hasOwn(saved.bindings, name) ? saved.bindings[name] : undefined;
  return binding ? { engine: binding.engine, model: binding.model } : undefined;
}
function validateVendorModels(models: VendorModel[]): VendorModel[] {
  if (!Array.isArray(models) || models.length > MODEL_DISCOVERY_MAX_MODELS || Buffer.byteLength(JSON.stringify(models)) > MODEL_DISCOVERY_MAX_BYTES) throw new Error('Vendor model catalog exceeds its size limit');
  for (const model of models) {
    if (!model || typeof model.model !== 'string' || (model.label !== undefined && (typeof model.label !== 'string' || model.label.length > 1024))) throw new Error('Vendor reported an invalid model catalog');
    modelEnumName('codex', model.model);
  }
  return [...new Map(models.map(model => [model.model, model])).values()];
}
function fileStamp(path: string): string {
  try { const stat = statSync(path); return `${realpathSync(path)}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; } catch { return `${path}:absent`; }
}
function fingerprint(root: string, cwd: string, config: ExecutionConfig, env: NodeJS.ProcessEnv, commands: Partial<Record<ModelEngine, string>>, publication = false): string {
  const files = [join(root, '.aside'), join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'), 'config.toml'),
    join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), 'settings.json')];
  // Vendor initialization can update these without changing execution settings.
  // They invalidate cached reads, but do not make their own probe obsolete.
  if (!publication) files.push(join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'), 'auth.json'), join(env.HOME ?? homedir(), '.claude.json'));
  for (let directory = cwd;; directory = dirname(directory)) {
    files.push(join(directory, '.codex', 'config.toml'), join(directory, '.claude', 'settings.json'), join(directory, '.claude', 'settings.local.json'));
    if (dirname(directory) === directory) break;
  }
  // Only a digest is persisted/compared; environment credentials never appear
  // in state or diagnostics.
  const environment = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  const namedCommands = Object.entries(config.models ?? {}).flatMap(([name, definition]) => {
    if (!('command' in definition)) return [];
    const path = executablePath(definition.command, cwd, env);
    return [[name, path ? fileStamp(path) : null]];
  });
  return hash(JSON.stringify({ root, cwd, config, environment, namedCommands, commands: Object.entries(commands).map(([engine, path]) => [engine, path ? fileStamp(path) : null]), files: files.map(fileStamp) }));
}

export class ModelCatalog {
  private entries = new Map<string, { fingerprint: string; snapshot: ModelCatalogSnapshot }>();
  private pending = new Map<string, { controller: AbortController; work: Promise<ModelCatalogSnapshot>; subscribers: number; settled: boolean }>();
  constructor(private options: ModelCatalogOptions = {}) {}
  async for(root: string, options: CatalogOptions = {}): Promise<ModelCatalogSnapshot> {
    options.signal?.throwIfAborted();
    root = resolve(root);
    const env = this.options.env?.() ?? process.env;
    const directory = this.options.stateDirectory ?? stateDirectory(env);
    const key = cachePath(root, directory);
    const { config, cwd } = readExecutionContext(root);
    const commands = Object.fromEntries((['codex', 'claude'] as const).map(engine => [engine, executablePath(engine, cwd, env)])) as Partial<Record<ModelEngine, string>>;
    const version = fingerprint(root, cwd, config, env, commands);
    const publication = fingerprint(root, cwd, config, env, commands, true);
    const cached = this.entries.get(key);
    if (!options.refresh && cached?.fingerprint === version) return structuredClone(cached.snapshot);
    const currentFingerprint = (guard = false) => {
      try {
        const currentEnv = this.options.env?.() ?? process.env;
        const context = readExecutionContext(root);
        const installed = Object.fromEntries((['codex', 'claude'] as const).map(engine => [engine, executablePath(engine, context.cwd, currentEnv)]));
        return fingerprint(root, context.cwd, context.config, currentEnv, installed, guard);
      } catch { return undefined; }
    };
    const current = () => currentFingerprint(true) === publication;
    const pendingKey = key + ':' + version;
    const existing = this.pending.get(pendingKey);
    if (existing?.controller.signal.aborted) {
      const finished = existing.work.then(() => {}, () => {});
      await (options.signal ? abortable(finished, options.signal) : finished);
      return this.for(root, options);
    }
    let request = existing;
    if (!request) {
      const controller = new AbortController();
      request = { controller, work: undefined!, subscribers: 0, settled: false };
      const owned = request;
      owned.work = this.discover(root, directory, cwd, config, commands, env, current, controller.signal).then(snapshot => {
        if (current() && !controller.signal.aborted) {
          const finished = currentFingerprint();
          if (finished) this.entries.set(key, { fingerprint: finished, snapshot });
        }
        return snapshot;
      }).finally(() => {
        owned.settled = true;
        if (this.pending.get(pendingKey) === owned) this.pending.delete(pendingKey);
      });
      void owned.work.catch(() => {});
      this.pending.set(pendingKey, owned);
    }
    return structuredClone(await this.subscribe(request, options.signal));
  }
  private subscribe(request: { controller: AbortController; work: Promise<ModelCatalogSnapshot>; subscribers: number; settled: boolean }, signal?: AbortSignal): Promise<ModelCatalogSnapshot> {
    return new Promise((resolveResult, reject) => {
      let joined = true;
      request.subscribers++;
      const leave = () => {
        joined = false; request.subscribers--; signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        if (!joined) return;
        const reason = signal?.reason ?? new Error('Model discovery interrupted');
        leave();
        if (!request.subscribers && !request.settled) {
          request.controller.abort(reason);
          // The last caller owns teardown. In particular, worker shutdown must
          // wait until its detached discovery processes have been closed.
          request.work.then(() => reject(reason), () => reject(reason));
        } else reject(reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      request.work.then(value => { if (joined) { leave(); resolveResult(value); } }, error => { if (joined) { leave(); reject(error); } });
      if (signal?.aborted) abort();
    });
  }
  private async discover(root: string, directory: string, cwd: string, config: ExecutionConfig, commands: Partial<Record<ModelEngine, string>>, env: NodeJS.ProcessEnv, current: () => boolean, signal?: AbortSignal): Promise<ModelCatalogSnapshot> {
    const diagnostics: string[] = [];
    let saved: SavedCatalog;
    try { saved = readSaved(root, directory); }
    catch { saved = { version: 1, root, bindings: {}, catalogs: {} }; diagnostics.push('Cannot read the persisted model catalog'); }
    const previous = structuredClone(saved);
    const states = new Map<ModelEngine, string | undefined>();
    await Promise.all((['codex', 'claude'] as const).map(async engine => {
      const command = commands[engine];
      if (!command) return;
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => controller.abort(new Error('Model discovery timed out')), MODEL_DISCOVERY_TIMEOUT_MS);
      timer.unref?.();
      try {
        const work = (this.options.discover ?? discoverModels)(engine, command, cwd, controller.signal, env);
        // Real adapters settle only after their subprocess has been closed.
        // Injected transports may ignore cancellation, so bound those waits.
        const models = validateVendorModels(await (this.options.discover ? abortable(work, controller.signal) : work));
        const next: Record<string, Binding> = {};
        for (const model of models) {
          const name = modelEnumName(engine, model.model), existing = next[name] ?? saved.bindings[name];
          if (existing && (existing.engine !== engine || existing.model !== model.model)) throw new Error(`Ambiguous vendor model enum name: ${name}`);
          next[name] = { engine, model: model.model, label: model.label ?? model.model };
        }
        Object.assign(saved.bindings, next); saved.catalogs[engine] = models; states.set(engine, undefined);
      } catch (error) {
        const detail = error instanceof Error && /^(Ambiguous vendor model enum name: [A-Z0-9_]+|Vendor (reported an invalid model (identifier|catalog)|model catalog exceeds its size limit))$/.test(error.message) ? error.message : 'Model discovery failed';
        const reason = controller.signal.aborted ? 'Model discovery interrupted or timed out' : detail;
        states.set(engine, reason); diagnostics.push(`${engine}: ${reason}`);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }));
    signal?.throwIfAborted();
    try { saved = await mergeSaved(root, directory, saved, new Set([...states].filter(([, error]) => error === undefined).map(([engine]) => engine)), current, signal); }
    catch (error) {
      signal?.throwIfAborted();
      try { saved = readSaved(root, directory); } catch { saved = previous; }
      const reason = error instanceof Error && /^(Ambiguous vendor model enum name: [A-Z0-9_]+|Model cache exceeds its size limit)$/.test(error.message) ? error.message : 'Cannot persist the model catalog';
      diagnostics.push(reason);
      for (const engine of ['codex', 'claude'] as const) if (commands[engine]) states.set(engine, reason);
    }
    const models: ModelOption[] = [];
    for (const engine of ['codex', 'claude'] as const) {
      if (!commands[engine]) continue;
      const reason = states.get(engine);
      for (const model of saved.catalogs[engine] ?? []) models.push({ name: modelEnumName(engine, model.model), label: model.label ?? model.model, builtin: true, engine, model: model.model, availability: reason ? 'UNKNOWN' : 'AVAILABLE', ...(reason ? { reason } : {}) });
    }
    for (const [name, definition] of Object.entries(config.models ?? {})) {
      if ('command' in definition) {
        if (executablePath(definition.command, cwd, env)) models.push({ name, label: name, builtin: false, availability: 'AVAILABLE' });
        else diagnostics.push(`Named model ${name}: executable is not installed`);
      } else {
        const builtin = models.find(model => model.name === definition.model && model.builtin);
        if (builtin) models.push({ ...builtin, name, label: name, builtin: false });
        else diagnostics.push(`Named model ${name}: built-in selection ${definition.model} is unavailable`);
      }
    }
    models.sort((a, b) => a.name.localeCompare(b.name));
    return { models, diagnostics, revision: hash(JSON.stringify({ models, diagnostics })) };
  }
}

const catalog = new ModelCatalog();
export const catalogFor = (root: string, options: CatalogOptions = {}) => catalog.for(root, options);
const discoverModels: ModelDiscovery = (engine, command, cwd, signal, env) => engine === 'codex'
  ? discoverCodexModels(command, cwd, signal, env) : discoverClaudeModels(command, cwd, signal, env);

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const kill = (signal: NodeJS.Signals) => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
  };
  child.stdin?.end(); kill('SIGTERM');
  await new Promise<void>(resolveDone => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = () => { clearTimeout(timer); child.removeListener('close', closed); kill('SIGKILL'); resolveDone(); };
    child.once('close', closed);
    // The leader may already have exited while a descendant holds its stdio.
    // Always signal its process group, and do not wait for a past close event.
    if ((child.exitCode !== null || child.signalCode !== null) && child.stdout?.destroyed && child.stderr?.destroyed) closed();
    else { timer = setTimeout(closed, MODEL_DISCOVERY_TERMINATE_TIMEOUT_MS); timer.unref?.(); }
  });
}

export async function discoverCodexModels(command: string, cwd: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<VendorModel[]> {
  signal.throwIfAborted();
  const child = spawn(command, ['app-server', '--listen', 'stdio://'], { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0, buffer = '', bytes = 0;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => { for (const waiter of waiting.values()) waiter.reject(error); waiting.clear(); };
  const abort = () => fail(new Error('Model discovery interrupted'));
  signal.addEventListener('abort', abort, { once: true });
  child.stdin.on('error', () => fail(new Error('Codex model discovery input failed')));
  child.once('error', () => fail(new Error('Codex model discovery could not start')));
  child.once('exit', () => fail(new Error('Codex model discovery exited before completing')));
  child.once('close', () => fail(new Error('Codex model discovery exited before completing')));
  let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MODEL_DISCOVERY_MAX_BYTES) fail(new Error('Codex model discovery output exceeds its size limit')); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MODEL_DISCOVERY_MAX_BYTES) { fail(new Error('Codex model discovery output exceeds its size limit')); return; }
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line), waiter = waiting.get(message.id);
        if (!waiter) continue;
        waiting.delete(message.id);
        if (message.error) waiter.reject(new Error('Codex rejected model discovery'));
        else waiter.resolve(message.result);
      } catch { fail(new Error('Codex model discovery returned invalid JSON')); }
    }
  });
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (method: string, params: unknown) => new Promise<any>((resolveResponse, reject) => {
    const id = nextId++; waiting.set(id, { resolve: resolveResponse, reject }); send({ id, method, params });
  });
  try {
    await request('initialize', { clientInfo: { name: 'aside', title: 'Aside', version: '0.1.0' } });
    send({ method: 'initialized', params: {} });
    const models: VendorModel[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const result = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!result || !Array.isArray(result.data)) throw new Error('Codex reported an invalid model catalog');
      for (const model of result.data) if (!model.hidden) models.push({ model: model.model ?? model.id, label: model.displayName });
      validateVendorModels(models);
      cursor = result.nextCursor ?? undefined;
      if (cursor !== undefined && (typeof cursor !== 'string' || seen.has(cursor))) throw new Error('Codex model discovery repeated or invalidated a cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return models;
  } finally { signal.removeEventListener('abort', abort); fail(new Error('Model discovery closed')); await terminate(child); }
}

export async function discoverClaudeModels(command: string, cwd: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<VendorModel[]> {
  signal.throwIfAborted();
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  signal.throwIfAborted();
  const controller = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>(resolveDone => { finish = resolveDone; });
  // Keep streaming input open without sending any user message or inference.
  const input = async function* () { await finished; };
  let child: ChildProcess | undefined;
  const request = query({ prompt: input(), options: { cwd, env, pathToClaudeCodeExecutable: command,
    settingSources: ['user', 'project', 'local'], persistSession: false, abortController: controller,
    settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {},
    spawnClaudeCodeProcess: options => {
      child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let bytes = 0;
      const count = (chunk: Buffer) => { bytes += chunk.length; if (bytes > MODEL_DISCOVERY_MAX_BYTES) controller.abort(); };
      child.stdout!.on('data', count); child.stderr!.on('data', count);
      return child as ChildProcess & { stdin: NonNullable<ChildProcess['stdin']>; stdout: NonNullable<ChildProcess['stdout']> };
    } } });
  const abort = () => { controller.abort(); request.close(); finish(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const models = await abortable(request.supportedModels(), controller.signal);
    return validateVendorModels(models.flatMap(model => [
      { model: model.value, label: model.displayName },
      ...(model.resolvedModel !== undefined && model.resolvedModel !== model.value
        ? [{ model: model.resolvedModel, label: model.resolvedModel }] : []),
    ]));
  } finally { signal.removeEventListener('abort', abort); finish(); request.close(); if (child) await terminate(child); }
}
