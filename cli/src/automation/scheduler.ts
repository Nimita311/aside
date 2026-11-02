import { AUTOMATION_MAX_TIMER_MS, AUTOMATION_CLOCK_DRIFT_MS } from '../core/system-config.js';
import { performance } from 'node:perf_hooks';
import { compileSchedule, type Schedule } from './schedule.js';
import { validateDefinition, type AutomationDefinition } from '../core/automation.js';
import { compileDelegation, type DelegationSource } from './delegation.js';

export interface AutomationSource { key: string; root: string; instance: string; definedIn: string; declaration: unknown; blocked?: string; delegation?: DelegationSource }
export interface ScheduledJob extends AutomationSource { definition: AutomationDefinition; schedule: Schedule }
interface Job extends ScheduledJob { revision: number; next?: number; active: boolean; pending?: number }
interface Deadline { key: string; revision: number; at: number }
export interface AutomationStatus {
  key: string; root: string; definedIn: string; actionId?: string; templateId?: string; original?: string; schedule?: string; next?: string; running: boolean; pending?: string; error?: string;
  enabled?: boolean; blocked?: boolean;
}
export interface SchedulerHooks {
  run(job: ScheduledJob, occurrence: number): Promise<void>;
  claim(key: string, occurrence: number): boolean;
  lastClaim(key: string): number | undefined;
  changed?(): void;
}
// A min heap contains only one live deadline per job. Stale revisions are
// discarded lazily, with periodic compaction after configuration churn.
export class AutomationScheduler {
  private jobs = new Map<string, Job>();
  private running = new Map<string, Job>();
  private errors = new Map<string, AutomationStatus>();
  private heap: Deadline[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private closed = false;
  private sleeping = false;
  private armedWall = 0;
  private armedMono = 0;
  constructor(private hooks: SchedulerHooks, private zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    private clock = { now: () => Date.now(), monotonic: () => performance.now() }) {}
  replace(sources: AutomationSource[]): void {
    const present = new Set(sources.map(source => source.key));
    for (const key of this.jobs.keys()) if (!present.has(key)) this.jobs.delete(key);
    for (const key of this.errors.keys()) if (!present.has(key)) this.errors.delete(key);
    for (const source of sources) {
      const existing = this.jobs.get(source.key);
      if (existing && JSON.stringify(existing.declaration) === JSON.stringify(source.declaration) && JSON.stringify(existing.delegation) === JSON.stringify(source.delegation) && existing.definedIn === source.definedIn && existing.blocked === source.blocked) {
        // Instance identity/context can change without changing a project's
        // declaration. Keep its deadline, but launch with the current metadata.
        Object.assign(existing, source);
        continue;
      }
      try {
        if (source.blocked) throw new Error(source.blocked);
        const compiled = source.delegation ? compileDelegation(source) : undefined;
        const definition = compiled?.definition ?? validateDefinition(source.declaration);
        const schedule = compiled?.schedule ?? compileSchedule(definition.schedule, this.zone);
        const job: Job = { ...source, definition, schedule, revision: ++this.sequence, active: this.running.has(source.key) };
        this.jobs.set(source.key, job);
        this.errors.delete(source.key);
        if (definition.enabled !== false && !this.sleeping) this.advance(job, this.clock.now());
      } catch (error) {
        this.jobs.delete(source.key);
        const enabled = source.declaration && typeof source.declaration === 'object' && !Array.isArray(source.declaration)
          ? (source.declaration as { enabled?: unknown }).enabled : undefined;
        this.errors.set(source.key, { key: source.key, root: source.root, definedIn: source.definedIn,
          ...(source.delegation ? {actionId: source.delegation.id} : {}),
          running: this.running.has(source.key), blocked: !!source.blocked,
          ...(typeof enabled === 'boolean' ? { enabled } : {}), error: (error as Error).message });
      }
    }
    if (this.heap.length > this.jobs.size * 2 + 64) {
      this.heap = [];
      for (const job of this.jobs.values()) if (job.next !== undefined) this.push({ key: job.key, revision: job.revision, at: job.next });
    }
    this.arm(); this.hooks.changed?.();
  }
  private advance(job: Job, after: number): void {
    try {
      job.next = job.schedule.next(Math.max(after, this.hooks.lastClaim(job.key) ?? -Infinity));
      if (job.next !== undefined) this.push({ key: job.key, revision: job.revision, at: job.next });
    } catch (error) {
      job.next = undefined;
      this.errors.set(job.key, { ...this.statusOf(job), error: (error as Error).message });
    }
  }
  // Native sleep/wake and clock/timezone notifications invalidate pending clocks.
  discontinuity(zone = this.zone): void {
    this.zone = zone; this.heap = [];
    for (const job of this.jobs.values()) {
      job.next = undefined; job.pending = undefined; job.revision = ++this.sequence;
      try { job.schedule = job.delegation ? compileDelegation(job).schedule : compileSchedule(job.definition.schedule, zone); }
      catch (error) { this.errors.set(job.key, { ...this.statusOf(job), error: (error as Error).message }); continue; }
      if (job.definition.enabled !== false && !this.sleeping) this.advance(job, this.clock.now());
    }
    this.arm(); this.hooks.changed?.();
  }
  sleep(): void { this.sleeping = true; this.discontinuity(); }
  wake(zone?: string): void { this.sleeping = false; this.discontinuity(zone); }
  private arm(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.closed || this.sleeping) return;
    let top = this.heap[0];
    while (top && (this.jobs.get(top.key)?.revision !== top.revision || this.jobs.get(top.key)?.next !== top.at)) { this.pop(); top = this.heap[0]; }
    if (!top) return;
    this.armedWall = this.clock.now(); this.armedMono = this.clock.monotonic();
    this.timer = setTimeout(() => this.fire(), Math.max(0, Math.min(AUTOMATION_MAX_TIMER_MS, top.at - this.clock.now())));
    this.timer.unref?.();
  }
  private fire(): void {
    this.timer = undefined;
    if (Math.abs(this.clock.now() - this.armedWall - (this.clock.monotonic() - this.armedMono)) > AUTOMATION_CLOCK_DRIFT_MS) { this.discontinuity(); return; }
    const now = this.clock.now();
    while (this.heap[0] && this.heap[0].at <= now) {
      const deadline = this.pop()!;
      const job = this.jobs.get(deadline.key);
      if (!job || job.revision !== deadline.revision || job.next !== deadline.at) continue;
      job.next = undefined;
      // Claim before launching, or even queuing, so a clock rollback cannot duplicate it.
      try {
        if (this.hooks.claim(job.key, deadline.at)) {
          if (!job.active) this.launch(job, deadline.at);
          else if ((job.definition.overlap ?? 'latest') === 'latest') job.pending = deadline.at;
        }
      } catch (error) { this.errors.set(job.key, { ...this.statusOf(job), error: (error as Error).message }); }
      this.advance(job, now);
    }
    this.arm(); this.hooks.changed?.();
  }
  private launch(job: Job, occurrence: number): void {
    job.active = true; this.running.set(job.key, job);
    Promise.resolve().then(() => this.hooks.run(job, occurrence)).catch(error => {
      this.errors.set(job.key, { ...this.statusOf(job), error: (error as Error).message });
    }).finally(() => {
      job.active = false; this.running.delete(job.key);
      const current = this.jobs.get(job.key);
      // Edits retain running state, but discard follow-ups defined by the old config.
      if (current) {
        current.active = false;
        const pending = current.pending; current.pending = undefined;
        if (!this.closed && !this.sleeping && current.definition.enabled !== false && pending !== undefined) this.launch(current, pending);
      }
      this.hooks.changed?.();
    });
  }
  private statusOf(job: Job): AutomationStatus {
    return { key: job.key, root: job.root, definedIn: job.definedIn,
      ...(job.delegation ? {actionId: job.delegation.id, templateId: job.delegation.action.frontMatter.occurrence?.template, original: job.delegation.action.frontMatter.occurrence?.original} : {}), schedule: job.schedule.description,
      enabled: job.definition.enabled !== false, blocked: false,
      next: job.next === undefined ? undefined : new Date(job.next).toISOString(), running: job.active, pending: job.pending === undefined ? undefined : new Date(job.pending).toISOString() };
  }
  status(): AutomationStatus[] {
    return [...this.jobs.values()].map(job => ({ ...this.statusOf(job), ...(this.errors.get(job.key)?.error ? { error: this.errors.get(job.key)!.error } : {}) }))
      .concat([...this.errors.values()].filter(error => !this.jobs.has(error.key)).map(error => ({ ...error, running: this.running.has(error.key) })))
      .concat([...this.running.values()].filter(job => !this.jobs.has(job.key) && !this.errors.has(job.key))
        .map(job => ({ ...this.statusOf(job), running: true, enabled: false, next: undefined, pending: undefined })))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  close(): void { this.closed = true; clearTimeout(this.timer); this.timer = undefined; this.heap = []; for (const job of this.jobs.values()) job.pending = undefined; }
  private push(item: Deadline): void {
    this.heap.push(item); let i = this.heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.heap[p].at <= item.at) break; this.heap[i] = this.heap[p]; i = p; }
    this.heap[i] = item;
  }
  private pop(): Deadline | undefined {
    const first = this.heap[0], tail = this.heap.pop();
    if (!this.heap.length || !tail) return first;
    let i = 0;
    while (i * 2 + 1 < this.heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.heap.length && this.heap[child + 1].at < this.heap[child].at) child++;
      if (this.heap[child].at >= tail.at) break;
      this.heap[i] = this.heap[child]; i = child;
    }
    this.heap[i] = tail; return first;
  }
}
