import { automationName } from '../core/automation.js';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AutomationInspection } from '../automation/controller.js';
import { RunStorage, type RunRecord } from '../automation/storage.js';

export type AutomationScope = 'instance' | 'project' | 'action';
export type AutomationLogStream = 'stdout' | 'stderr';
export interface AutomationJobRuntime {
  key: string; name: string; scope: AutomationScope; projectId?: string; actionId?: string; templateId?: string; original?: string; definedIn: string;
  schedule?: string; next?: string; running: boolean; pending?: string;
  enabled?: boolean; blocked?: boolean; error?: string; warnings: string[];
}
export interface AutomationRunRuntime {
  id: string; key: string; name: string; scope: AutomationScope; projectId?: string; actionId?: string; templateId?: string; original?: string; definedIn: string;
  status: RunRecord['status']; occurrence: string; started: string; finished?: string; latenessMs: number;
  error?: string; completionError?: string; cwd?: string; prompt?: string; model?: string; command?: string; args?: string[];
  pid?: number; exitCode?: number | null; signal?: string | null; stdoutLog: string; stderrLog: string;
}
export interface AutomationRuntimeSnapshot {
  available: boolean; warning?: string; jobs: AutomationJobRuntime[]; runs: AutomationRunRuntime[];
}
export interface AutomationLogPage {
  text: string; offset: number; nextOffset: number; totalBytes: number;
}

function identity(record: { key: string; definedIn: string; actionId?: string; templateId?: string; original?: string }): { name: string; scope: AutomationScope; projectId?: string; actionId?: string; templateId?: string; original?: string } {
  const name = automationName(record.key);
  if (record.definedIn.startsWith('#action/')) return {name, scope: 'action', actionId: record.actionId ?? record.definedIn.slice('#action/'.length), templateId: record.templateId, original: record.original};
  return record.definedIn.startsWith('#project/')
    ? { name, scope: 'project', projectId: record.definedIn.slice('#project/'.length) }
    : { name, scope: 'instance' };
}

function belongsToRoot(record: { key: string; root: string; definedIn: string }, root: string): boolean {
  if (record.root !== root) return false;
  try {
    const key = JSON.parse(record.key);
    return Array.isArray(key) && key.length === 3 && key[0] === root && key[1] === record.definedIn && typeof key[2] === 'string';
  } catch { return false; }
}

/** One retained execution shape for every automation owner. */
export function automationRunRuntime(run: RunRecord & {directory: string}): AutomationRunRuntime {
  return {
    ...identity(run), id: run.id, key: run.key, definedIn: run.definedIn,
    status: run.status, occurrence: run.occurrence, started: run.started, finished: run.finished,
    latenessMs: run.latenessMs, error: run.error, completionError: run.completionError, cwd: run.cwd, prompt: run.prompt,
    model: run.model?.name, command: run.command, args: run.args, pid: run.pid,
    exitCode: run.exitCode, signal: run.signal,
    stdoutLog: join(run.directory, 'stdout.log'), stderrLog: join(run.directory, 'stderr.log'),
  };
}

/** API view of a daemon observation, defensively scoped to the selected root. */
export function automationRuntimeSnapshot(root: string, inspection: AutomationInspection): AutomationRuntimeSnapshot {
  const jobs = inspection.jobs.filter(job => belongsToRoot(job, root));
  return {
    available: inspection.available !== false,
    warning: inspection.warning,
    jobs: jobs.map(job => ({ ...identity(job), key: job.key, definedIn: job.definedIn,
      schedule: job.schedule, next: job.next, running: job.running, pending: job.pending,
      enabled: job.enabled, blocked: job.blocked, error: job.error,
      warnings: (inspection.modelWarnings ?? []).filter(warning => warning.root === root && warning.key === job.key).map(warning => warning.message),
    })),
    runs: inspection.runs.filter(run => belongsToRoot(run, root)).map(automationRunRuntime),
  };
}

/** Byte ranges are bounded and read only from a retained run in this instance. */
export function readAutomationLog(storage: string, root: string, runId: string, stream: AutomationLogStream, offset: number, limit: number): AutomationLogPage | null {
  if (stream !== 'stdout' && stream !== 'stderr') throw new Error('Automation log stream must be stdout or stderr.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Automation log offset must be a nonnegative safe integer.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536) throw new Error('Automation log limit must be between 1 and 65536 bytes.');
  const run = new RunStorage(storage).history().find(run => {
    if (run.id !== runId || !belongsToRoot(run, root)) return false;
    const bucket = createHash('sha256').update(run.key).digest('hex').slice(0, 32);
    return run.directory === join(storage, bucket, run.id);
  });
  if (!run) return null;
  let descriptor: number;
  try { descriptor = openSync(join(run.directory, `${stream}.log`), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', offset, nextOffset: offset, totalBytes: 0 };
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('Automation log is not a regular file.');
    // Finish a UTF-8 character at the requested boundary (at most three extra
    // bytes) so paging with nextOffset never corrupts multibyte log output.
    const bytes = Buffer.alloc(Math.max(0, Math.min(limit + 3, stat.size - offset)));
    const read = bytes.length ? readSync(descriptor, bytes, 0, bytes.length, offset) : 0;
    let count = Math.min(limit, read);
    while (count < read && (bytes[count] & 0xc0) === 0x80) count++;
    return { text: bytes.subarray(0, count).toString('utf8'), offset,
      nextOffset: offset + count, totalBytes: stat.size };
  } finally { closeSync(descriptor); }
}
