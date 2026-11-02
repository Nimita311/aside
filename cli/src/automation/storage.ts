import { AUTOMATION_HISTORY_LIMIT, DIAGNOSTIC_RETENTION_DAYS } from '../core/system-config.js';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileCrashSafe } from '../mcp/tools/index-file.js';
import { readManagedText } from '../core/managed-path.js';
import type { ResolvedModel, AutomationDefinition } from '../core/automation.js';

export interface RunRecord {
  actionId?: string; templateId?: string; original?: string; completionError?: string;
  id: string; key: string; root: string; definedIn: string; occurrence: string; started: string; finished?: string;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'unobserved'; session: string;
  definition: AutomationDefinition; latenessMs: number; cwd?: string; prompt?: string; model?: ResolvedModel & { name: string };
  command?: string; args?: string[]; pid?: number; exitCode?: number | null; signal?: string | null; error?: string;
}
export class RunStorage {
  readonly session = randomUUID();
  private claims = new Map<string, number>();
  private protected = new Set<string>();
  constructor(private root: string) { this.root = resolve(root); }
  private directory(key: string): string { return join(this.root, createHash('sha256').update(key).digest('hex').slice(0, 32)); }
  lastClaim(key: string): number | undefined {
    if (!this.claims.has(key)) {
      try {
        const value = JSON.parse(readFileSync(join(this.directory(key), 'claim.json'), 'utf8'));
        if (value.key !== key || !Number.isFinite(value.occurrence)) throw new Error('Invalid automation claim');
        this.claims.set(key, value.occurrence);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return this.claims.get(key);
  }
  claim(key: string, occurrence: number): boolean {
    if (occurrence <= (this.lastClaim(key) ?? -Infinity)) return false;
    mkdirSync(this.directory(key), { recursive: true, mode: 0o700 });
    writeFileCrashSafe(join(this.directory(key), 'claim.json'), JSON.stringify({ key, occurrence }));
    this.claims.set(key, occurrence); return true;
  }
  start(run: RunRecord): string {
    const path = join(this.directory(run.key), run.id);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    this.save(run); return path;
  }
  save(run: RunRecord): void {
    writeFileCrashSafe(join(this.directory(run.key), run.id, 'run.json'), JSON.stringify(run, null, 2) + '\n');
  }
  // Delegation completion can still save its result after the subprocess has
  // finished. Keep that record until its final host callback has settled.
  protect(run: RunRecord): () => void {
    const path = join(this.directory(run.key), run.id);
    this.protected.add(path);
    return () => this.protected.delete(path);
  }
  history(key?: string): Array<RunRecord & { directory: string }> {
    const directories = key ? [this.directory(key)] : this.subdirs(this.root).map(name => join(this.root, name));
    return directories.flatMap(directory => this.subdirs(directory).flatMap(id => {
      const path = join(directory, id);
      try {
        const run = JSON.parse(readFileSync(join(path, 'run.json'), 'utf8')) as RunRecord;
        // A run belongs to the bucket derived from its immutable job key and
        // directory ID. Ignore corrupt metadata that impersonates another job.
        if (typeof run.key !== 'string' || run.id !== id || this.directory(run.key) !== directory) return [];
        // A previous process's unfinished execution has no observed outcome.
        return [{ ...run, status: run.status === 'running' && run.session !== this.session ? 'unobserved' as const : run.status, directory: path }];
      } catch { return []; }
    })).sort((a, b) => b.started.localeCompare(a.started));
  }
  prune(key: string): void {
    this.removeCompleted(Date.now(), key);
  }
  cleanup(now = Date.now()): { runs: number } { return this.removeCompleted(now); }
  purge(root?: string): { runs: number } { return this.removeCompleted(undefined, undefined, root); }
  private removeCompleted(now?: number, key?: string, root?: string): { runs: number } {
    let runs = 0;
    if (now !== undefined && !Number.isFinite(now)) throw new Error('Invalid automation retention time');
    if (!this.ordinaryDirectory(this.root)) return { runs };
    const cutoff = now === undefined ? undefined : now - DIAGNOSTIC_RETENTION_DAYS * 86_400_000;
    const buckets = key === undefined ? this.subdirs(this.root).filter(name => /^[a-f0-9]{32}$/.test(name))
      : [basename(this.directory(key))];
    for (const bucket of buckets) {
      const directory = join(this.root, bucket);
      if (!this.ordinaryDirectory(directory)) continue;
      const completed = this.subdirs(directory).filter(id => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)).flatMap(id => {
        const path = join(directory, id);
        try {
          const run = JSON.parse(readManagedText(this.root, join(path, 'run.json'))) as RunRecord;
          if (typeof run.key !== 'string' || run.id !== id || this.directory(run.key) !== directory
            || typeof run.root !== 'string' || typeof run.session !== 'string'
            || !['running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'unobserved'].includes(run.status)
            || typeof run.started !== 'string' || !Number.isFinite(Date.parse(run.started))
            || run.finished !== undefined && (typeof run.finished !== 'string' || !Number.isFinite(Date.parse(run.finished)))) return [];
          if (root !== undefined && run.root !== root || this.protected.has(path)
            || run.session === this.session && (run.status === 'running' || run.finished === undefined)) return [];
          return [{ run, path }];
        } catch { return []; }
      }).sort((a, b) => b.run.started.localeCompare(a.run.started));
      for (const [index, {run, path}] of completed.entries()) {
        if (cutoff !== undefined && index < AUTOMATION_HISTORY_LIMIT && Date.parse(run.finished ?? run.started) > cutoff) continue;
        // Only delete known regular files. Unknown contents and symlinks are
        // retained, and no recursive operation can reach outside this layout.
        for (const name of ['stdout.log', 'stderr.log', 'run.json']) {
          const file = join(path, name);
          if (this.ordinaryFile(file)) unlinkSync(file);
        }
        runs++;
        this.removeEmpty(path);
      }
      if (root === undefined) {
        for (const id of this.subdirs(directory).filter(id => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))) this.removeEmpty(join(directory, id));
      }
      this.removeEmpty(directory);
    }
    return { runs };
  }
  private ordinaryDirectory(path: string): boolean {
    try { return lstatSync(path).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private ordinaryFile(path: string): boolean {
    try { return lstatSync(path).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private removeEmpty(path: string): void {
    if (this.ordinaryDirectory(path) && readdirSync(path).length === 0) rmdirSync(path);
  }
  private subdirs(path: string): string[] {
    try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
}
