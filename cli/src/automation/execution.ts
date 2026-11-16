import { AUTOMATION_PROMPT_MAX_BYTES, AUTOMATION_OUTPUT_MAX_BYTES, AUTOMATION_TERMINATE_TIMEOUT_MS } from '../core/system-config.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertArtifactPrompt, automationName, namedModel, timeoutMs, type ResolvedModel } from '../core/automation.js';
import { builtinModel, executablePath, killProcessGroup } from './models.js';
import { delegationIdentity } from './delegation.js';
import {assertExecutionCwd} from '../runtime/execution-cwd.js';
import {resolveExecutionContext} from '../core/execution-context.js';
import type { ScheduledJob } from './scheduler.js';
import { RunStorage, type RunRecord } from './storage.js';

export function wrapPrompt(job: ScheduledJob, prompt: string): string {
  assertArtifactPrompt(prompt);
  const context = job.delegation
    ? "This is an Aside action delegation. The user has delegated an action to you to complete. A successful exit marks this action done. Follow the user's instructions autonomously."
    : "This is an Aside automation execution. The user scheduled this work to run automatically. Follow the user's instructions autonomously.";
  const owner = job.delegation ? `Action: #action/${job.delegation.id}\n`
    : job.definedIn.startsWith('#project/') ? `Project: ${job.definedIn}\n` : '';
  const name = job.delegation ? '' : `Automation name: ${automationName(job.key)}\n`;
  return `${context}

Instance: ${job.instance}
${owner}${name}User's instruction: ${prompt}`;
}
// Launches resolve exactly as discovery does: explicit paths against the
// execution cwd, bare names on absolute PATH entries only, never the cwd.
function resolveExecutable(command: string, cwd: string): string {
  if (command.includes('/') || command.includes('\\')) return resolve(cwd, command);
  const found = executablePath(command, cwd);
  if (!found) throw new Error(`ENOENT: executable ${JSON.stringify(command)} was not found on an absolute PATH entry`);
  return found;
}
export function modelCommand(model: ResolvedModel): { command: string; args: string[] } {
  if ('command' in model) return { command: model.command, args: [...(model.args ?? [])] };
  const args = model.engine === 'codex'
    ? ['-a', 'never', 'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--json', '-']
    : ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto'];
  // Codex consumes stdin for the final '-', so insert flags before that argument.
  const index = model.engine === 'codex' ? args.length - 1 : args.length;
  args.splice(index, 0, '--model', model.model);
  return { command: model.engine, args };
}
export class AutomationRunner {
  private children = new Set<{ child: ChildProcess; cancel: () => void; done: Promise<void> }>();
  private closed = false;
  private runs = new Set<Promise<RunRecord>>();
  constructor(private storage: RunStorage, private changed: () => void = () => {}) {}
  run(job: ScheduledJob, occurrence: number): Promise<void> {
    return this.launch(job, occurrence).done.then(() => {});
  }
  launch(job: ScheduledJob, occurrence: number): {record: RunRecord; directory: string; done: Promise<RunRecord>} {
    if (this.closed) throw new Error('Execution runner is closed.');
    const record: RunRecord = { id: randomUUID(), key: job.key, root: job.root, definedIn: job.definedIn,
      occurrence: new Date(occurrence).toISOString(), started: new Date().toISOString(), status: 'running', session: this.storage.session,
      definition: job.definition, latenessMs: Math.max(0, Date.now() - occurrence), ...delegationIdentity(job.delegation) };
    const outputDir = this.storage.start(record);
    this.changed();
    const work = this.runObserved(job, record, outputDir);
    this.runs.add(work);
    void work.finally(() => this.runs.delete(work)).catch(() => {});
    return {record, directory: outputDir, done: work};
  }
  private async runObserved(job: ScheduledJob, run: RunRecord, outputDir: string): Promise<RunRecord> {
    try {
      const { config, cwd } = resolveExecutionContext(job.executionContext);
      assertExecutionCwd(cwd);
      run.cwd = cwd;
      let command: string, args: string[], prompt: string | undefined;
      if ('script' in job.definition.run) {
        command = job.definition.run.script;
        args = job.definition.run.args ?? [];
      } else {
        const selection = job.definition.run.model;
        const named = namedModel(config, selection);
        const model = named && 'command' in named ? named : builtinModel(named?.model ?? selection, job.root);
        if (!model) throw new Error(`Model ${JSON.stringify(selection)} is not configured in ${join(job.root, '.aside')} or has no recorded built-in identity`);
        run.model = { name: selection, ...model };
        ({ command, args } = modelCommand(model));
        prompt = wrapPrompt(job, job.definition.run.prompt);
        if (!prompt.trim() || Buffer.byteLength(prompt) > AUTOMATION_PROMPT_MAX_BYTES) throw new Error('Execution prompt is empty or too large');
        run.prompt = prompt;
      }
      // The record keeps the declared command; the launch uses its resolution.
      run.command = command; run.args = args;
      const executable = resolveExecutable(command, cwd);
      this.storage.save(run);
      await this.execute(run, outputDir, executable, args, cwd, prompt, timeoutMs(job.definition.timeout));
    } catch (error) { run.status = 'failed'; run.error = (error as Error).message; }
    run.finished = new Date().toISOString();
    this.storage.save(run); this.storage.prune(job.key); this.changed();
    return run;
  }
  private async execute(run: RunRecord, directory: string, command: string, args: string[], cwd: string, prompt: string | undefined, timeout: number): Promise<void> {
    const child = spawn(command, args, { cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let termination: Promise<void> | undefined;
    const groupAlive = () => {
      if (!child.pid) return false;
      if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    };
    const stop = (status: 'cancelled' | 'timed_out') => {
      if (termination || (run.status !== 'running' && !groupAlive())) return;
      run.status = status;
      termination = new Promise<void>(resolveTermination => {
        const finish = () => {
          clearTimeout(killTimer); child.removeListener('close', closed);
          killProcessGroup(child, 'SIGKILL'); resolveTermination();
        };
        const closed = () => { if (!groupAlive()) finish(); };
        killProcessGroup(child, 'SIGTERM');
        // A leader can exit while descendants keep running with redirected
        // output. Keep escalation alive until the group is gone or grace ends.
        const killTimer = setTimeout(finish, AUTOMATION_TERMINATE_TIMEOUT_MS);
        child.once('close', closed);
        closed();
      });
    };
    const output = (stream: NodeJS.ReadableStream, name: string) => {
      let bytes = 0;
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        const remaining = AUTOMATION_OUTPUT_MAX_BYTES - bytes;
        if (remaining > 0) this.push(chunk.subarray(0, remaining));
        bytes += chunk.length; callback();
      } });
      return pipeline(stream, limit, createWriteStream(join(directory, name), { mode: 0o600 })).catch(error => { stop('cancelled'); throw error; });
    };
    const streams = [output(child.stdout!, 'stdout.log'), output(child.stderr!, 'stderr.log')];
    // Consume logging failures immediately, then await all results below.
    for (const work of streams) void work.catch(() => {});
    child.stdin!.on('error', () => {});
    child.stdin!.end(prompt);
    const done = new Promise<void>(resolveDone => {
      child.once('spawn', () => { run.pid = child.pid; this.storage.save(run); });
      child.once('error', error => { run.status = 'failed'; run.error = error.message; });
      child.once('close', (code, signal) => {
        run.exitCode = code; run.signal = signal;
        if (run.status === 'running') run.status = code === 0 ? 'succeeded' : 'failed';
        resolveDone();
      });
    });
    const active = { child, cancel: () => stop('cancelled'), done };
    this.children.add(active);
    timer = setTimeout(() => stop('timed_out'), timeout); timer.unref?.();
    try {
      await done;
      for (const result of await Promise.allSettled(streams)) {
        if (result.status === 'rejected') throw result.reason;
      }
    } finally {
      clearTimeout(timer);
      if (termination) await termination;
      this.children.delete(active);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const children = [...this.children];
    for (const active of children) active.cancel();
    await Promise.allSettled([...this.runs]);
  }
}
