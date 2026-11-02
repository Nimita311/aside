import { AUTOMATION_WORKER_TIMEOUT_MS } from '../core/system-config.js';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AutomationSource, AutomationStatus } from './scheduler.js';
import { RunStorage, type RunRecord } from './storage.js';
import type { ModelWarmupWarning } from './model-warmup.js';
import type { DelegationCallbacks, DelegationDispatchResult } from './delegation-protocol.js';

export interface AutomationInspection {
  jobs: AutomationStatus[];
  runs: Array<RunRecord & { directory: string }>;
  warning?: string;
  modelWarnings?: ModelWarmupWarning[];
  /** Present on scoped, read-only inspection; false when live state is unavailable. */
  available?: boolean;
}
// The host pushes changed declarations; the worker owns deadlines and subprocesses
// so synchronous instance reads and writes cannot delay dispatch.
export class AutomationController {
  private worker?: Worker;
  private sources = new Map<string, AutomationSource[]>();
  private fingerprints = new Map<string, string>();
  private jobs: AutomationStatus[] = [];
  private warning?: string;
  private modelWarnings: ModelWarmupWarning[] = [];
  private failure?: string;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: AutomationInspection) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closing?: Promise<void>;
  private dispatches = new Map<number, {resolve: (result: DelegationDispatchResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private maintenance = new Map<number, {resolve: (result: {runs: number}) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private finishClose?: () => void;
  constructor(private storage: string, private delegation?: DelegationCallbacks) {}
  dispatch(source: AutomationSource): Promise<DelegationDispatchResult> {
    if (!this.delegation || this.closing || this.failure) return Promise.reject(new Error(this.failure ?? 'Delegation runtime is unavailable.'));
    if (!this.worker) this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.dispatches.delete(id); reject(new Error('Delegation dispatch did not answer within 5 seconds. Inspect retained runs before retrying.'));}, AUTOMATION_WORKER_TIMEOUT_MS);
      this.dispatches.set(id, {resolve, reject, timer});
      this.worker!.postMessage({type: 'delegate', id, source});
    });
  }
  replace(root: string, sources: AutomationSource[]): void {
    if (this.closing) return;
    const fingerprint = JSON.stringify(sources);
    if (this.fingerprints.get(root) === fingerprint) return;
    this.fingerprints.set(root, fingerprint);
    if (sources.length) this.sources.set(root, sources); else this.sources.delete(root);
    if (this.sources.size && !this.worker && !this.failure) this.start();
    this.worker?.postMessage({ type: 'replace', sources: [...this.sources.values()].flat() });
  }
  private start(): void {
    const source = import.meta.url.endsWith('/src/automation/controller.ts');
    const url = new URL(source ? '../../dist/automation-worker.js' : './automation-worker.js', import.meta.url);
    this.worker = new Worker(url, { workerData: { storage: this.storage, wakeBinary: join(dirname(fileURLToPath(url)), 'aside-wake') } });
    this.worker.on('message', message => {
      if (message.type === 'delegation-request') {
        try {
          if (!this.delegation || this.closing) throw new Error('Delegation runtime is shutting down.');
          const value = message.operation === 'prepare' ? this.delegation.prepare(message.request)
            : this.delegation.complete(message.source, message.run);
          this.worker?.postMessage({type: 'delegation-response', requestId: message.requestId, value});
        } catch (error) {
          this.worker?.postMessage({type: 'delegation-response', requestId: message.requestId, error: (error as Error).message});
        }
      }
      if (message.type === 'delegated') {
        const request = this.dispatches.get(message.id);
        if (request) {clearTimeout(request.timer); this.dispatches.delete(message.id); if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);}
      }
      if (message.type === 'maintenance' || message.type === 'error') {
        const request = this.maintenance.get(message.id);
        if (request) {
          clearTimeout(request.timer); this.maintenance.delete(message.id);
          if (message.type === 'error') request.reject(new Error(message.error)); else request.resolve(message.result);
          return;
        }
      }
      if (message.type === 'status' || message.type === 'inspection') { this.jobs = message.jobs; this.warning = message.warning; this.modelWarnings = message.modelWarnings ?? []; }
      if (message.type === 'closed') this.finishClose?.();
      if (message.type === 'inspection' || message.type === 'error') {
        const request = this.pending.get(message.id);
        if (request) {
          clearTimeout(request.timer); this.pending.delete(message.id);
          if (message.type === 'error') request.reject(new Error(message.error));
          else request.resolve({ jobs: message.jobs, runs: message.runs, warning: message.warning, modelWarnings: message.modelWarnings });
        } else if (message.type === 'error') this.failure = message.error;
      }
    });
    this.worker.on('error', error => this.fail(error.message));
    this.worker.on('exit', code => {
      this.worker = undefined;
      if (!this.closing) this.fail(`Automation worker exited (${code}); restart the daemon to observe future schedules.`);
      this.finishClose?.();
    });
  }
  private fail(error: string): void {
    this.failure = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(error)); }
    this.pending.clear();
    for (const request of this.dispatches.values()) {clearTimeout(request.timer); request.reject(new Error(error));}
    this.dispatches.clear();
    for (const request of this.maintenance.values()) {clearTimeout(request.timer); request.reject(new Error(error));}
    this.maintenance.clear();
  }
  cleanup(): Promise<{runs: number}> { return this.maintain('cleanup'); }
  purge(root?: string): Promise<{runs: number}> { return this.maintain('purge', root); }
  private async maintain(operation: 'cleanup' | 'purge', root?: string): Promise<{runs: number}> {
    // Maintenance must not start scheduling work. The live worker alone knows
    // which records still have running subprocesses or completion callbacks.
    if (this.closing) return Promise.reject(new Error('Automation scheduler is closing.'));
    if (!this.worker) {
      const storage = new RunStorage(this.storage);
      return Promise.resolve(operation === 'cleanup' ? storage.cleanup() : storage.purge(root));
    }
    if (this.failure) return Promise.reject(new Error(this.failure));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.maintenance.delete(id); reject(new Error('Automation worker did not answer within 5 seconds.'));}, AUTOMATION_WORKER_TIMEOUT_MS);
      this.maintenance.set(id, {resolve, reject, timer});
      this.worker!.postMessage({type: operation, id, ...(root === undefined ? {} : {root})});
    });
  }
  issues(root: string): string[] {
    return [...(this.failure ? [this.failure] : []),
      ...(this.warning && this.jobs.some(job => job.root === root) ? [this.warning] : []),
      ...this.modelWarnings.filter(warning => warning.root === root).map(warning => `${warning.definedIn}: ${warning.message}`),
      ...this.jobs.filter(job => job.root === root && job.error).map(job => `${job.definedIn}: ${job.error}`)];
  }
  inspect(root?: string): Promise<AutomationInspection> {
    // GraphQL inspection is scoped and must never start a worker. A stopped or
    // failed scheduler can still provide retained history from disk.
    if (this.failure) {
      if (root === undefined) return Promise.reject(new Error(this.failure));
      return Promise.resolve({ available: false, jobs: [], runs: new RunStorage(this.storage).history().filter(run => run.root === root), warning: this.failure });
    }
    if (root === undefined && !this.worker && existsSync(this.storage)) this.start();
    if (!this.worker) return Promise.resolve({ available: true, jobs: [], runs: root === undefined ? [] : new RunStorage(this.storage).history().filter(run => run.root === root) });
    const id = ++this.sequence;
    return new Promise<AutomationInspection>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Automation worker did not answer within 5 seconds.')); }, AUTOMATION_WORKER_TIMEOUT_MS);
      this.pending.set(id, { resolve: value => resolve(root === undefined ? value : {
        ...value, available: true, jobs: value.jobs.filter(job => job.root === root),
        runs: value.runs.filter(run => run.root === root),
        modelWarnings: value.modelWarnings?.filter(warning => warning.root === root),
        warning: value.jobs.some(job => job.root === root) ? value.warning : undefined,
      }), reject, timer });
      this.worker!.postMessage({ type: 'inspect', id, ...(root === undefined ? {} : { root }) });
    }).catch(error => {
      if (root === undefined) throw error;
      return { available: false, jobs: [], runs: new RunStorage(this.storage).history().filter(run => run.root === root), warning: (error as Error).message };
    });
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (!this.worker) return;
      const worker = this.worker;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>(resolve => {
        this.finishClose = resolve;
        timer = setTimeout(resolve, AUTOMATION_WORKER_TIMEOUT_MS);
        worker.postMessage({ type: 'close' });
      });
      clearTimeout(timer);
      await worker.terminate();
      this.fail('Automation scheduler is closed.');
    })();
    return this.closing;
  }
}
