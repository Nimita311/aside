import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashText } from './documents.js';
import { closeSemanticCacheHandles, withSemanticCacheAccess } from './search.js';
import { errorMessage } from '../core/error.js';

export const SEMANTIC_CACHE_RETENTION_DAYS = 30;
export const SEMANTIC_CACHE_RETENTION_MS = SEMANTIC_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const METADATA = '.retention.json';
const DIRECTORY_NAME = /^[0-9a-f]{64}$/;
type Paths = readonly string[] | (() => readonly string[]);
interface RetentionState { version: 1; unregisteredSince: number; removeRequested?: true }

export interface SemanticCacheRetentionOptions {
  indexRoot: string;
  retentionMs?: number;
  now?: () => number;
}

/** Instance paths supplied here must already use the daemon's canonical identity.
 * Registry changes and offline calls must be owned by the caller's registry lock.
 * No timer or source-file access is involved in cache retention. */
export class SemanticCacheRetention {
  private readonly root: string;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(options: SemanticCacheRetentionOptions) {
    this.root = resolve(options.indexRoot);
    this.retentionMs = options.retentionMs ?? SEMANTIC_CACHE_RETENTION_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 0) throw new Error('Invalid semantic cache retention period.');
  }

  /** Record the policy before removing registration. Missing caches stay absent. */
  forget(paths: readonly string[], clear: boolean): Promise<void> {
    return this.eachCache(paths, (location, previous) => this.write(location, {version: 1, unregisteredSince: previous?.unregisteredSince ?? this.time(),
      ...(clear || previous?.removeRequested ? {removeRequested: true as const} : {})}));
  }

  /** Complete an explicit pending purge before admission, then cancel expiry. */
  register(paths: readonly string[]): Promise<void> {
    return this.eachCache(paths, (location, state) => state?.removeRequested ? this.remove(location) : rm(join(location, METADATA), {force: true}));
  }

  // Visit each named instance's existing cache with its saved retention state.
  private eachCache(paths: readonly string[], visit: (location: string, state: RetentionState | undefined) => Promise<void>): Promise<void> {
    return withSemanticCacheAccess(async () => {
      if (!await this.rootExists()) return;
      for (const path of new Set(paths)) {
        const location = this.location(path);
        if (await this.directoryExists(location)) await visit(location, await this.state(location));
      }
    });
  }

  /** Observe orphaned caches and collect eligible ones at a caller-chosen check.
   * Daemon callers should supply getters so registration/use is rechecked after
   * filesystem awaits. Offline callers hold the daemon startup/lifetime locks. */
  collect(registered: Paths, inUse: Paths = []): Promise<void> {
    return withSemanticCacheAccess(async () => {
      if (!await this.rootExists()) return;
      const entries = await readdir(this.root, {withFileTypes: true});
      const failures: Error[] = [];
      for (const entry of entries) {
        if (!DIRECTORY_NAME.test(entry.name) || !entry.isDirectory()) continue;
        const location = join(this.root, entry.name);
        try {
          if (!await this.directoryExists(location)) continue;
          const state = await this.state(location);
          if (this.contains(registered, entry.name)) {
            // A pending explicit purge is fulfilled by register(), never silently
            // cancelled by inspection of the registry after a crash or a race.
            if (state && !state.removeRequested) await rm(join(location, METADATA), {force: true});
            continue;
          }
          if (!state) {
            // Legacy caches have no trustworthy deregistration date. Start their
            // retention clock on observation rather than inferring it from mtime.
            await this.write(location, {version: 1, unregisteredSince: this.time()});
            continue;
          }
          if (!state.removeRequested && this.time() - state.unregisteredSince < this.retentionMs) continue;
          if (this.contains(registered, entry.name) || this.contains(inUse, entry.name)) continue;
          // All cache reads/writes use this same queue. Closing every cached native
          // handle before unlinking prevents another service retaining old tables.
          await this.remove(location, () => this.contains(registered, entry.name) || this.contains(inUse, entry.name));
        } catch (error) {
          failures.push(new Error(`Could not collect semantic cache ${entry.name}: ${errorMessage(error)}`, {cause: error}));
        }
      }
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
    });
  }

  private location(path: string): string { return join(this.root, hashText(path)); }
  private contains(paths: Paths, key: string): boolean {
    return (typeof paths === 'function' ? paths() : paths).some(path => hashText(path) === key);
  }
  private time(): number {
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid semantic cache retention clock.');
    return time;
  }
  private async rootExists(): Promise<boolean> { return this.directoryExists(this.root); }
  private async directoryExists(location: string): Promise<boolean> {
    try { return (await lstat(location)).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private async state(location: string): Promise<RetentionState | undefined> {
    const path = join(location, METADATA);
    let value: unknown;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 4096) return;
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return;
      throw error;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || !Number.isSafeInteger(state.unregisteredSince) || (state.unregisteredSince as number) < 0
      || state.removeRequested !== undefined && state.removeRequested !== true) return;
    return state as unknown as RetentionState;
  }
  private async write(location: string, state: RetentionState): Promise<void> {
    const temporary = join(location, `.retention-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(state) + '\n', {mode: 0o600, flag: 'wx'});
      await rename(temporary, join(location, METADATA));
    } finally { await rm(temporary, {force: true}); }
  }
  private async remove(location: string, protectedNow?: () => boolean): Promise<void> {
    // lstat refuses a substituted top-level symlink. rm does not follow nested
    // symlinks, so a cache can never redirect reclamation outside this root.
    if (!await this.directoryExists(location)) return;
    if (protectedNow?.()) return;
    closeSemanticCacheHandles(location);
    // A recursive root removal can erase the policy marker before failing on
    // another child. Keep the marker until every cached byte has been removed,
    // so restart or retry still knows this cache must be cleared or expired.
    for (const name of await readdir(location)) {
      if (name !== METADATA) await rm(join(location, name), {recursive: true, force: true});
    }
    await rm(join(location, METADATA), {force: true});
    await rmdir(location);
  }
}
