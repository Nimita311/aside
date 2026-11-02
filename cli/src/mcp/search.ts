import { Worker } from 'node:worker_threads';
import {
  REGEX_EXECUTION_TIMEOUT_MS, REGEX_QUEUE_TIMEOUT_MS, REGEX_WORKER_COUNT,
  REGEX_QUEUE_LIMIT, REGEX_PATTERN_MAX_CHARS, REGEX_SNAPSHOT_MAX_BYTES, REGEX_POOL_MAX_BYTES, REGEX_SNAPSHOT_MAX_RECORDS,
} from '../core/system-config.js';

export interface SearchOptions { signal?: AbortSignal; snapshotBytes?: number }
export interface SearchMatcher { match(pattern: string, texts: string[][], options?: SearchOptions): Promise<number[]> }
interface Job {
  id: number; pattern: string; texts: string[][]; bytes: number;
  resolve: (indices: number[]) => void; reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void;
}
interface Slot { worker?: Worker; job?: Job; terminating?: boolean }
export interface SearchPoolOptions {
  workerCount?: number; queueLimit?: number; executionTimeoutMs?: number; queueTimeoutMs?: number;
  snapshotMaxBytes?: number; poolMaxBytes?: number; workerUrl?: URL;
}

export function validateSearchPattern(pattern: string): void {
  if (pattern.length > REGEX_PATTERN_MAX_CHARS) throw new Error(`Search pattern too long: ${pattern.length} characters (max ${REGEX_PATTERN_MAX_CHARS}). Use a shorter regex.`);
  try { new RegExp(pattern, 'i'); } catch { throw new Error(`Invalid regex: ${pattern}`); }
}

function workerUrl(): URL {
  // Source tests use the separately built worker; the shipped runtime always
  // names its sibling artifact, including when diagnosing a missing build.
  return import.meta.url.endsWith('/src/mcp/search.ts')
    ? new URL('../../dist/regex-worker.js', import.meta.url)
    : new URL('./regex-worker.js', import.meta.url);
}

export class RegexWorkerPool implements SearchMatcher {
  private slots: Slot[];
  private queue: Job[] = [];
  private bytes = 0;
  private sequence = 0;
  private closed = false;
  private options: Required<SearchPoolOptions>;

  constructor(options: SearchPoolOptions = {}) {
    this.options = {
      workerCount: REGEX_WORKER_COUNT, queueLimit: REGEX_QUEUE_LIMIT,
      executionTimeoutMs: REGEX_EXECUTION_TIMEOUT_MS, queueTimeoutMs: REGEX_QUEUE_TIMEOUT_MS,
      snapshotMaxBytes: REGEX_SNAPSHOT_MAX_BYTES, poolMaxBytes: REGEX_POOL_MAX_BYTES,
      workerUrl: workerUrl(), ...options,
    };
    for (const key of ['workerCount', 'executionTimeoutMs', 'queueTimeoutMs', 'snapshotMaxBytes', 'poolMaxBytes'] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0) throw new Error(`Invalid regex pool ${key}.`);
    }
    if (!Number.isSafeInteger(this.options.queueLimit) || this.options.queueLimit < 0) throw new Error('Invalid regex pool queueLimit.');
    this.slots = Array.from({ length: this.options.workerCount }, () => ({}));
  }

  match(pattern: string, texts: string[][], options: SearchOptions = {}): Promise<number[]> {
    validateSearchPattern(pattern);
    if (this.closed) return Promise.reject(new Error('Regex search is unavailable because the daemon is shutting down.'));
    if (options.signal?.aborted) return Promise.reject(new Error('Regex search cancelled because the client disconnected.'));
    if (texts.length > REGEX_SNAPSHOT_MAX_RECORDS) return Promise.reject(new Error('Regex search snapshot has too many records. Narrow the query with IDs, dates, or relationships.'));
    const textBytes = texts.reduce((sum, fields) => sum + fields.reduce((n, field) => n + Buffer.byteLength(field, 'utf8'), 0), 0);
    const bytes = Math.max(textBytes, options.snapshotBytes ?? 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return Promise.reject(new Error('Invalid regex snapshot byte reservation.'));
    if (bytes > this.options.snapshotMaxBytes) return Promise.reject(new Error('Regex search snapshot is too large. Narrow the query with IDs, dates, or relationships.'));
    const idle = this.slots.find(slot => !slot.job && !slot.terminating);
    if ((!idle && this.queue.length >= this.options.queueLimit) || this.bytes + bytes > this.options.poolMaxBytes) return Promise.reject(new Error('Regex search is overloaded. Retry later or narrow the query.'));
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.sequence, pattern, texts: texts.map(fields => [...fields]), bytes, resolve, reject, signal: options.signal };
      this.bytes += bytes;
      if (job.signal) {
        job.abort = () => this.cancel(job, new Error('Regex search cancelled because the client disconnected.'));
        job.signal.addEventListener('abort', job.abort, { once: true });
      }
      if (idle) this.start(idle, job);
      else {
        this.queue.push(job);
        job.timer = setTimeout(() => this.cancel(job, new Error('Regex search timed out waiting for a worker. Retry later or narrow the query.')), this.options.queueTimeoutMs);
      }
    });
  }

  private start(slot: Slot, job: Job): void {
    clearTimeout(job.timer);
    slot.job = job;
    try {
      if (!slot.worker) {
        const worker = new Worker(this.options.workerUrl);
        slot.worker = worker;
        worker.on('message', (message: { id: number; indices?: number[]; error?: string }) => {
          if (slot.worker !== worker) return;
          if (typeof message !== 'object' || message === null) { this.finish(slot, new Error('Regex search worker returned an invalid result. Retry the query.'), undefined, true); return; }
          if (slot.job?.id !== message.id) return;
          if (message.error) this.finish(slot, new Error(`Regex search failed: ${message.error}`));
          else if (!Array.isArray(message.indices) || message.indices.some((index, position) => !Number.isSafeInteger(index) || index < 0 || index >= slot.job!.texts.length || (position > 0 && index <= message.indices![position - 1]))) this.finish(slot, new Error('Regex search worker returned an invalid result. Retry the query.'), undefined, true);
          else this.finish(slot, undefined, message.indices);
        });
        worker.on('error', error => { if (slot.worker === worker) this.finish(slot, new Error(`Regex search worker failed: ${error.message}`), undefined, true); });
        worker.on('exit', code => {
          if (slot.worker !== worker) return;
          this.finish(slot, new Error(`Regex search worker exited (${code}). Retry the query.`), undefined, true);
        });
      }
      slot.worker.ref();
      job.timer = setTimeout(() => {
        if (slot.job === job) this.finish(slot, new Error(`Regex search timed out after ${this.options.executionTimeoutMs / 1000} seconds. Use a simpler regex or narrow the query.`), undefined, true);
      }, this.options.executionTimeoutMs);
      slot.worker.postMessage({ id: job.id, pattern: job.pattern, texts: job.texts });
    } catch (error) {
      this.finish(slot, new Error(`Regex search worker could not start: ${error instanceof Error ? error.message : String(error)}`), undefined, true);
    }
  }

  private settle(job: Job, error?: Error, indices?: number[]): void {
    clearTimeout(job.timer);
    if (job.abort) job.signal?.removeEventListener('abort', job.abort);
    this.bytes -= job.bytes;
    if (error) job.reject(error); else job.resolve(indices!);
  }

  private finish(slot: Slot, error?: Error, indices?: number[], terminate = false): void {
    const job = slot.job;
    slot.job = undefined;
    if (terminate) {
      const worker = slot.worker; slot.worker = undefined;
      if (worker) {
        slot.terminating = true;
        void worker.terminate().catch(() => {}).finally(() => { slot.terminating = false; this.drain(slot); });
      }
    } else slot.worker?.unref();
    if (job) this.settle(job, error, indices);
    this.drain(slot);
  }

  private drain(slot: Slot): void {
    if (!this.closed && !slot.job && !slot.terminating && this.queue.length) this.start(slot, this.queue.shift()!);
  }

  private cancel(job: Job, error: Error): void {
    const slot = this.slots.find(slot => slot.job === job);
    if (slot) { this.finish(slot, error, undefined, true); return; }
    const index = this.queue.indexOf(job);
    if (index < 0) return;
    this.queue.splice(index, 1); this.settle(job, error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('Regex search cancelled because the daemon is shutting down.');
    for (const job of this.queue.splice(0)) this.settle(job, error);
    for (const slot of this.slots) this.finish(slot, error, undefined, true);
  }
}

let shared: RegexWorkerPool | undefined;
export function defaultSearchMatcher(): RegexWorkerPool { return shared ??= new RegexWorkerPool(); }
