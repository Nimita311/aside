import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Kind, getOperationAST, type DocumentNode, type SelectionNode } from 'graphql';
import type { GraphQLResult } from './schema.js';
import type { MutationChange } from '../mcp/tools/mutation-result.js';
import { daemonPaths } from '../daemon/paths.js';
import { readManifestResult } from '../core/instance.js';
import { DIAGNOSTIC_RETENTION_DAYS } from '../core/system-config.js';

const DAY = 86_400_000;
const FILE = /^(\d{4}-\d{2}-\d{2})-(\d{3,})\.jsonl$/;
const BUCKET = /^[a-f0-9]{64}$/;
export const usageBaseDirectory = (logs = daemonPaths().logs) => join(logs, 'graphql');
export const usageDirectory = (root: string, logs = daemonPaths().logs) => {
  let canonical = resolve(root);
  try { canonical = realpathSync(root); } catch { /* Retain the canonical path supplied by the collector. */ }
  return join(usageBaseDirectory(logs), createHash('sha256').update(canonical).digest('hex'));
};
export const legacyUsageDirectory = (root: string) => join(root, '.aside-logs', 'graphql');
export interface EffectCounts { created: number; updated: number; removed: number }
export interface UsageEvent {
  schemaVersion: 1; timestamp: string; requestId: string; operation: 'query' | 'mutation';
  shape: string | null; shapeHash: string | null; fields: string[];
  durationMs: number; outcome: 'success' | 'partial' | 'failure' | 'cancelled';
  errorCategory: 'validation' | 'execution' | 'mutation' | 'cancelled' | null;
  errorCount: number; effects: EffectCounts;
}

/** Describe only the selected operation. No aliases, authored operation/variable
 * names, literal values, variable values, or response content enter the shape. */
export function queryShape(document: DocumentNode, operationName?: string) {
  const operation = getOperationAST(document, operationName);
  if (!operation) return null;
  const fragments = new Map(document.definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION).map(d => [d.name.value, d]));
  const fields = new Set<string>();
  const selections = (nodes: readonly SelectionNode[], prefix = ''): string => nodes.map(node => {
    const directives = (node.directives ?? []).map(d => `@${d.name.value}`).sort().join('');
    if (node.kind === Kind.FIELD) {
      const path = prefix ? `${prefix}.${node.name.value}` : node.name.value;
      fields.add(path);
      const args = node.arguments?.map(a => `${a.name.value}:?`).sort().join(',') ?? '';
      return `${node.name.value}${args ? `(${args})` : ''}${directives}${node.selectionSet ? `{${selections(node.selectionSet.selections, path)}}` : ''}`;
    }
    const fragment = node.kind === Kind.FRAGMENT_SPREAD ? fragments.get(node.name.value) : node;
    return fragment ? `...${fragment.typeCondition?.name.value ?? ''}${directives}{${selections(fragment.selectionSet.selections, prefix)}}` : '';
  }).join(' ');
  const shape = `${operation.operation}{${selections(operation.selectionSet.selections)}}`;
  return {shape, shapeHash: createHash('sha256').update(shape).digest('hex'), fields: [...fields].sort()};
}

/** One collector per execution, including executions that change selection. */
export class UsageRequest {
  private started = performance.now();
  private timestamp = new Date().toISOString();
  private requestId = randomUUID();
  private scopes = new Map<string, EffectCounts>();
  private description: ReturnType<typeof queryShape> = null;
  private executed = false;
  constructor(private logger: GraphQLUsageLog, private operation: 'query' | 'mutation') {}
  touch(root: string): void {
    try {
      const canonical = realpathSync(root);
      if (!this.scopes.has(canonical)) this.scopes.set(canonical, {created: 0, updated: 0, removed: 0});
    } catch { /* A removed or unavailable instance cannot receive a log. */ }
  }
  describe(document: DocumentNode, operationName?: string): void { this.description = queryShape(document, operationName); }
  executing(): void { this.executed = true; }
  validationFailed(): void { this.executed = false; }
  changes(root: string, changes: readonly MutationChange[]): void {
    this.touch(root);
    let canonical: string;
    try { canonical = realpathSync(root); } catch { return; }
    const effects = this.scopes.get(canonical)!;
    for (const change of changes) effects[change.effect === 'CREATED' ? 'created' : change.effect === 'UPDATED' ? 'updated' : 'removed']++;
  }
  finish(result: GraphQLResult | undefined, fallback: string | null, cancelled: boolean): void {
    // Introspection/discovery with no instance context does not invent one.
    if (!this.scopes.size && fallback) this.touch(fallback);
    const mutations = result?.extensions?.mutations;
    const mutationErrors = Array.isArray(mutations) ? mutations.filter(m => m?.error).length : 0;
    const errorCount = (result?.errors?.length ?? (result ? 0 : 1)) + mutationErrors;
    const effects = [...this.scopes.values()];
    const hasChanges = effects.some(e => e.created + e.updated + e.removed > 0);
    const hasData = !!result?.data && Object.values(result.data).some(v => v !== null && v !== undefined);
    const outcome = cancelled ? 'cancelled' : !errorCount ? 'success' : hasChanges || hasData ? 'partial' : 'failure';
    const errorCategory = cancelled ? 'cancelled' : !errorCount ? null : !this.executed ? 'validation' : mutationErrors ? 'mutation' : 'execution';
    const durationMs = Math.round((performance.now() - this.started) * 100) / 100;
    for (const [root, instanceEffects] of this.scopes) this.logger.record(root, {
      schemaVersion: 1, timestamp: this.timestamp, requestId: this.requestId, operation: this.operation,
      shape: this.description?.shape ?? null, shapeHash: this.description?.shapeHash ?? null, fields: this.description?.fields ?? [],
      durationMs, outcome, errorCategory, errorCount, effects: instanceEffects,
    });
  }
}

export interface UsageLogOptions { logs?: string; retentionDays?: number; maxBytes?: number; segmentBytes?: number; queueBytes?: number }
export interface UsageCleanup { files: number; collections: number }
/** The host owns this writer. Requests never await disk I/O; errors are contained
 * and reported as counters rather than changing GraphQL results. */
export class GraphQLUsageLog {
  private tails = new Map<string, Promise<void>>();
  private queuedBytes = 0;
  private dropped = 0;
  private errors = 0;
  private limits: Required<Omit<UsageLogOptions, 'logs'>>;
  private logs: string;
  constructor(options: UsageLogOptions = {}) {
    const {logs = daemonPaths().logs, ...limits} = options;
    this.logs = logs;
    this.limits = {retentionDays: DIAGNOSTIC_RETENTION_DAYS, maxBytes: 100 * 1024 * 1024, segmentBytes: 5 * 1024 * 1024, queueBytes: 4 * 1024 * 1024, ...limits};
  }
  start(operation: 'query' | 'mutation'): UsageRequest { return new UsageRequest(this, operation); }
  status() { return {queuedBytes: this.queuedBytes, dropped: this.dropped, errors: this.errors}; }
  record(root: string, event: UsageEvent): void {
    try { root = realpathSync(root); } catch { this.errors++; this.dropped++; return; }
    const line = JSON.stringify(event) + '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes + 1 > this.limits.maxBytes || bytes > 256 * 1024 || this.queuedBytes + bytes > this.limits.queueBytes) { this.dropped++; return; }
    this.queuedBytes += bytes;
    void this.serialize(usageDirectory(root, this.logs), async () => {
      try { await this.append(root, line, bytes); }
      catch { this.errors++; this.dropped++; }
      finally { this.queuedBytes -= bytes; }
    });
  }
  private serialize<T>(directory: string, work: () => Promise<T>): Promise<T> {
    const operation = (this.tails.get(directory) ?? Promise.resolve()).then(work);
    const tail = operation.then(() => {}, () => {}).finally(() => {
      if (this.tails.get(directory) === tail) this.tails.delete(directory);
    });
    this.tails.set(directory, tail);
    return operation;
  }
  async flush(timeoutMs?: number): Promise<void> {
    const pending = Promise.all(this.tails.values());
    if (timeoutMs === undefined) { await pending; return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([pending, new Promise<void>(done => { timer = setTimeout(done, timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  /** Sweep every owned bucket, including instances that no longer exist. */
  cleanup(): Promise<UsageCleanup> { return this.maintain(false); }
  /** Purge one canonical instance path, or every usage collection. */
  purge(root?: string): Promise<UsageCleanup> { return this.maintain(true, root); }
  private async directory(path: string): Promise<boolean> {
    try {
      if (!(await lstat(path)).isDirectory()) throw new Error('Invalid log directory');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private async maintain(purge: boolean, root?: string): Promise<UsageCleanup> {
    const directories = new Set(root === undefined ? this.tails.keys() : [usageDirectory(root, this.logs)]);
    if (root === undefined && await this.directory(this.logs) && await this.directory(usageBaseDirectory(this.logs))) {
      for (const name of await readdir(usageBaseDirectory(this.logs))) {
        if (BUCKET.test(name)) directories.add(join(usageBaseDirectory(this.logs), name));
      }
    }
    const result: UsageCleanup = {files: 0, collections: 0};
    const outcomes = await Promise.allSettled([...directories].map(directory => this.serialize(directory, async () => {
      // The parent checks also run inside the queue: a preceding operation may
      // have created or removed the tree while the sweep was enumerating it.
      if (!await this.directory(this.logs) || !await this.directory(usageBaseDirectory(this.logs))) return;
      let info;
      try { info = await lstat(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!info.isDirectory()) return;
      const files = await this.prune(directory, purge, 0);
      result.files += files.removed;
      const names = await readdir(directory);
      if (names.length === 1 && names[0] === 'instance.json') {
        if (!(await lstat(join(directory, 'instance.json'))).isFile()) return;
        await unlink(join(directory, 'instance.json'));
      } else if (names.length) return;
      await rmdir(directory);
      result.collections++;
    })));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return result;
  }
  private async prune(directory: string, purge: boolean, reservedBytes: number) {
    const files: {name: string; path: string; bytes: number}[] = [];
    let removed = 0;
    const now = Date.now();
    for (const name of (await readdir(directory)).filter(name => FILE.test(name)).sort((a, b) =>
      a.slice(0, 10).localeCompare(b.slice(0, 10)) || Number(FILE.exec(a)![2]) - Number(FILE.exec(b)![2]))) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if (purge || Date.parse(name.slice(0, 10)) + this.limits.retentionDays * DAY <= now) {
        await unlink(path); removed++;
      } else files.push({name, path, bytes: info.size});
    }
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    while (files.length && total + reservedBytes > this.limits.maxBytes) {
      const oldest = files.shift()!; await unlink(oldest.path); total -= oldest.bytes; removed++;
    }
    return {files, removed};
  }
  private async append(root: string, line: string, bytes: number): Promise<void> {
    // The instance is only read. All collection files live beside daemon.log.
    if (!(await stat(join(root, 'aside.md'))).isFile()) throw new Error('Instance is unavailable');
    if (!await this.directory(this.logs)) await mkdir(this.logs, {recursive: true, mode: 0o700});
    await this.directory(this.logs);
    await chmod(this.logs, 0o700);
    for (const directory of [usageBaseDirectory(this.logs), usageDirectory(root, this.logs)]) {
      try { await mkdir(directory, {mode: 0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await this.directory(directory);
      await chmod(directory, 0o700);
    }
    const directory = usageDirectory(root, this.logs);
    // Paths belong in the bucket's association metadata, never request events.
    // Hash canonical paths rather than IDs so aliases share a bucket while
    // worktrees and instances with duplicate manifest IDs stay separate.
    const metadata = await open(join(directory, 'instance.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!(await metadata.stat()).isFile()) throw new Error('Invalid instance metadata');
      await metadata.chmod(0o600);
      await metadata.writeFile(JSON.stringify({schemaVersion: 1, path: root, id: readManifestResult(root).value.id}) + '\n');
    } finally { await metadata.close(); }
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    // Reserve one byte to terminate a line interrupted by a previous crash.
    const {files} = await this.prune(directory, false, bytes + 1);
    const last = files.filter(file => file.name.startsWith(today)).at(-1);
    const sequence = last ? Number(FILE.exec(last.name)![2]) : 1;
    const name = last && last.bytes + bytes + 1 <= this.limits.segmentBytes ? last.name
      : `${today}-${String(last ? sequence + 1 : 1).padStart(3, '0')}.jsonl`;
    const file = await open(join(directory, name), constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Invalid log file');
      await file.chmod(0o600);
      if (info.size) {
        const end = Buffer.alloc(1);
        const {bytesRead} = await file.read(end, 0, 1, info.size - 1);
        if (bytesRead && end[0] !== 10) await file.writeFile('\n');
      }
      await file.writeFile(line);
    } finally { await file.close(); }
  }
}
