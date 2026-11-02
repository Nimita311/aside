import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { AutomationRunner, modelCommand, resolvePrompt } from '../src/automation/execution.js';
import { RunStorage } from '../src/automation/storage.js';
import { compileSchedule } from '../src/automation/schedule.js';
import * as models from '../src/automation/models.js';
import { validateDefinition } from '../src/core/automation.js';
import type { ScheduledJob } from '../src/automation/scheduler.js';
import { parseProjectFile, parseManifest, parseConfig } from '../src/core/parser.js';
import { serializeProject } from '../src/mcp/tools/serialize.js';
import { Store } from '../src/mcp/store.js';
import { handleUpdateProject } from '../src/mcp/tools/update.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});
const nativeCreateWriteStream = vi.mocked(createWriteStream).getMockImplementation()!;

let root: string, storage: RunStorage, runner: AutomationRunner;
beforeEach(() => { vi.mocked(createWriteStream).mockReset().mockImplementation(nativeCreateWriteStream);
  root = realpathSync(mkdtempSync('/tmp/aside-automation-exec-'));
  mkdirSync(join(root, 'artifacts', '2026'), {recursive: true});
  writeFileSync(join(root, 'artifacts', '2026', '2026-10-08-instructions.md'), '---\nname: Instructions\ncreated: 2026-10-08T12:00\n---\n\nOrganize this project.');
  storage = new RunStorage(join(root, 'runs')); runner = new AutomationRunner(storage); });
afterEach(async () => { vi.useRealTimers(); await runner.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  vi.mocked(createWriteStream).mockReset().mockImplementation(nativeCreateWriteStream);
  rmSync(root, { recursive: true, force: true }); });
function job(run: unknown, timeout?: string): ScheduledJob {
  const definition = validateDefinition({ schedule: { at: '2026-10-08T12:00Z' }, run, ...(timeout ? { timeout } : {}) });
  return { key: 'test', root, instance: 'work', definedIn: '#project/2026-10-08-notes', declaration: definition, definition, schedule: compileSchedule(definition.schedule) };
}
function script(name: string, body: string): string {
  const path = join(root, name); writeFileSync(path, '#!/usr/bin/env node\n' + body); chmodSync(path, 0o700); return path;
}
async function waitUntil(check: () => boolean, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture process');
    await delay(20);
  }
}
function processRunning(pid: number): boolean {
  const exists = () => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  };
  if (!exists()) return false;
  try {
    // A killed orphan can remain a zombie briefly while its new parent reaps it.
    const status = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return status.length > 0 && !status.startsWith('Z');
  } catch (error) { if (!exists()) return false; throw error; }
}
function processGroupFixture(inheritOutput = false, exitLeader = false): { ready: string; terminated: string } {
  const ready = join(root, 'child-ready.json'), terminated = join(root, 'child-terminated');
  const child = join(root, 'child.cjs');
  writeFileSync(child, `const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(terminated)}, 'received'));
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid: process.pid, leader: Number(process.argv[2])}));
setInterval(() => {}, 1000);
`);
  script('leader.cjs', `const fs = require('node:fs');
process.on('SIGTERM', () => process.exit(0));
require('node:child_process').spawn(process.execPath, [${JSON.stringify(child)}, String(process.pid)], {
  stdio: ['ignore', ${JSON.stringify(inheritOutput ? 'inherit' : 'ignore')}, ${JSON.stringify(inheritOutput ? 'inherit' : 'ignore')}]
});
${exitLeader ? `const ready = setInterval(() => { if (fs.existsSync(${JSON.stringify(ready)})) process.exit(0); }, 10);` : 'setInterval(() => {}, 1000);'}
`);
  return { ready, terminated };
}
async function readFixturePids(path: string): Promise<{pid: number; leader: number}> {
  let pids: {pid: number; leader: number} | undefined;
  await waitUntil(() => {
    try { pids = JSON.parse(readFileSync(path, 'utf8')); return true; } catch { return false; }
  });
  return pids!;
}
function cleanFixture(pids: {pid: number; leader: number} | undefined): void {
  if (!pids) return;
  try { process.kill(-pids.leader, 'SIGKILL'); } catch {}
  try { process.kill(pids.pid, 'SIGKILL'); } catch {}
}
describe('automation execution', () => {
  it('starts in the instance root, passes script arguments without shell interpretation and records output', async () => {
    script('script.js', "console.log(JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2)}));");
    await runner.run(job({ script: './script.js', args: ['$(touch should-not-exist)', 'a b'] }), Date.now());
    const [run] = storage.history(); expect(run.status).toBe('succeeded');
    expect(JSON.parse(readFileSync(join(run.directory, 'stdout.log'), 'utf8'))).toEqual({ cwd: root, args: ['$(touch should-not-exist)', 'a b'] });
    expect(run.cwd).toBe(root);
  });
  it('passes only source and artifact pointers and rereads .aside execution settings at every launch', async () => {
    mkdirSync(join(root, 'artifacts', '2026'), { recursive: true });
    const artifact = join(root, 'artifacts', '2026', '2026-10-08-instructions.md');
    writeFileSync(artifact, '---\nname: Instructions\ncreated: 2026-10-08T12:00\n---\n\nOrganize this project.');
    const fake = script('fake-agent.js', "let prompt=''; process.stdin.on('data', chunk=>prompt+=chunk); process.stdin.on('end',()=>console.log(JSON.stringify({cwd:process.cwd(),prompt,args:process.argv.slice(2)}))); ");
    const config = (cwd: string) => writeFileSync(join(root, '.aside'), `execution:\n  cwd: ${cwd}\n  models:\n    external:\n      command: ${JSON.stringify(fake)}\n      args: [fake-mode]\n`);
    config('.');
    const task = job({ model: 'external', prompt: '#artifact/2026-10-08-instructions' });
    task.key = JSON.stringify([root, task.definedIn, 'digest']);
    await runner.run(task, Date.now());
    const [first] = storage.history();
    const output = JSON.parse(readFileSync(join(first.directory, 'stdout.log'), 'utf8'));
    expect(output.cwd).toBe(root); expect(output.args).toEqual(['fake-mode']);
    expect(output.prompt).toBe("This is an Aside automation execution. The user scheduled this work to run automatically. Follow the user's instructions autonomously.\n\nInstance: work\nProject: #project/2026-10-08-notes\nAutomation name: digest\nUser's instruction: #artifact/2026-10-08-instructions");
    expect(first.prompt).toBe(output.prompt);
    mkdirSync(join(root, 'elsewhere')); config('elsewhere');
    writeFileSync(artifact, '---\nname: Instructions\ncreated: 2026-10-08T12:00\n---\n\nUse current instructions.');
    await runner.run(task, Date.now());
    const second = storage.history().find(run => run.id !== first.id)!;
    expect(second.cwd).toBe(join(root, 'elsewhere')); expect(second.prompt).toBe(first.prompt);
    rmSync(artifact);
    await runner.run(task, Date.now());
    const third = storage.history().find(run => run.id !== first.id && run.id !== second.id)!;
    expect(third.status).toBe('succeeded'); expect(third.prompt).toBe(first.prompt);
  });
  it.each(['codex', 'claude'] as const)('launches built-in %s with its exact vendor ID and wrapped prompt', async engine => {
    script(engine, "let prompt=''; process.stdin.on('data', chunk=>prompt+=chunk); process.stdin.on('end',()=>console.log(JSON.stringify({cwd:process.cwd(),prompt,args:process.argv.slice(2)}))); ");
    vi.stubEnv('PATH', root + delimiter + process.env.PATH);
    const vendorModel = 'custom/model-v2:latest';
    const name = engine === 'codex' ? 'CODEX_CUSTOM_MODEL_V2_LATEST' : 'CLAUDE_CUSTOM_MODEL_V2_LATEST';
    const lookup = vi.spyOn(models, 'builtinModel').mockReturnValue({ engine, model: vendorModel });
    await runner.run(job({ model: name, prompt: '#artifact/2026-10-08-instructions' }), Date.now());
    const [run] = storage.history(); expect(run.status).toBe('succeeded');
    const output = JSON.parse(readFileSync(join(run.directory, 'stdout.log'), 'utf8'));
    expect(lookup).toHaveBeenCalledWith(name, root);
    expect(output.cwd).toBe(root);
    expect(output.args).toEqual(modelCommand({ engine, model: vendorModel }).args);
    expect(output.args.slice(output.args.indexOf('--model'), output.args.indexOf('--model') + 2)).toEqual(['--model', vendorModel]);
    expect(output.prompt).toContain('This is an Aside automation execution.');
    expect(output.prompt).toContain('Instance: work\nProject: #project/2026-10-08-notes');
    expect(output.prompt).toContain("User's instruction: #artifact/2026-10-08-instructions");
    expect(output.prompt).not.toContain('Organize this project.');
    expect(run.model).toEqual({ name, engine, model: vendorModel });
    expect(run.command).toBe(engine);
    expect(run.prompt).toBe(output.prompt);
  });
  it.each(['codex', 'claude'] as const)('launches saved exact %s identities after discovery removes the choice', async engine => {
    script(engine, "let prompt=''; process.stdin.on('data', chunk=>prompt+=chunk); process.stdin.on('end',()=>console.log(JSON.stringify(process.argv.slice(2))));");
    vi.stubEnv('PATH', root + delimiter + process.env.PATH);
    vi.stubEnv('ASIDE_DAEMON_HOME', join(root, 'runtime'));
    const vendorModel = engine === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5';
    const discover = vi.fn(async (provider: string) => provider === engine ? [{ model: vendorModel }] : []);
    const catalog = new models.ModelCatalog({ discover });
    const initial = await catalog.for(root);
    const name = initial.models.find(model => model.engine === engine)!.name;
    discover.mockImplementation(async () => []);
    expect((await catalog.for(root, { refresh: true })).models).not.toContainEqual(expect.objectContaining({ name }));
    discover.mockClear();
    await runner.run(job({ model: name, prompt: '#artifact/2026-10-08-instructions' }), Date.now());
    expect(discover).not.toHaveBeenCalled();
    const [run] = storage.history(); expect(run.status).toBe('succeeded');
    const args = JSON.parse(readFileSync(join(run.directory, 'stdout.log'), 'utf8')) as string[];
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', vendorModel]);
    expect(run.model).toEqual({ name, engine, model: vendorModel });
  });
  it('resolves named built-in choices and honors launch-time cwd without replacing vendor aliases', async () => {
    vi.spyOn(models, 'builtinModel').mockReturnValue({ engine: 'claude', model: 'sonnet' });
    script('claude', "let prompt=''; process.stdin.on('data', chunk=>prompt+=chunk); process.stdin.on('end',()=>console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))); ");
    vi.stubEnv('PATH', root + delimiter + process.env.PATH);
    mkdirSync(join(root, 'elsewhere'));
    writeFileSync(join(root, '.aside'), 'execution:\n  cwd: elsewhere\n  models:\n    writing:\n      model: CLAUDE_SONNET\n');
    await runner.run(job({ model: 'writing', prompt: '#artifact/2026-10-08-instructions' }), Date.now());
    const [run] = storage.history(); expect(run.status).toBe('succeeded');
    const output = JSON.parse(readFileSync(join(run.directory, 'stdout.log'), 'utf8'));
    expect(output.cwd).toBe(join(root, 'elsewhere'));
    expect(output.args.slice(-2)).toEqual(['--model', 'sonnet']);
    expect(run.model).toEqual({ name: 'writing', engine: 'claude', model: 'sonnet' });
  });
  it('records a missing executable and exact unknown model names as failed', async () => {
    vi.stubEnv('PATH', root);
    const lookup = vi.spyOn(models, 'builtinModel').mockReturnValue({ engine: 'claude', model: 'sonnet' });
    await runner.run(job({ model: 'CLAUDE_SONNET', prompt: '#artifact/2026-10-08-instructions' }), Date.now());
    expect(storage.history()[0].error).toContain('ENOENT');
    lookup.mockReturnValue(undefined);
    writeFileSync(join(root, '.aside'), 'execution:\n  models: {}\n');
    for (const name of ['codex', 'constructor', 'CODEX_UNDISCOVERED']) {
      await runner.run(job({ model: name, prompt: '#artifact/2026-10-08-instructions' }), Date.now());
      expect(storage.history().some(run => run.error?.includes(`Model "${name}" is not configured`))).toBe(true);
    }
    expect(storage.history().every(run => run.status === 'failed')).toBe(true);
  });
  it('never launches a vendor CLI planted in the execution cwd through a relative PATH entry', async () => {
    mkdirSync(join(root, 'elsewhere')); writeFileSync(join(root, '.aside'), 'execution:\n  cwd: elsewhere\n');
    const planted = join(root, 'elsewhere', 'claude');
    writeFileSync(planted, '#!/bin/sh\necho planted\n'); chmodSync(planted, 0o700);
    vi.stubEnv('PATH', `.${delimiter}elsewhere${delimiter}`);
    vi.spyOn(models, 'builtinModel').mockReturnValue({ engine: 'claude', model: 'sonnet' });
    await runner.run(job({ model: 'CLAUDE_SONNET', prompt: '#artifact/2026-10-08-instructions' }), Date.now());
    await runner.run(job({ script: 'claude' }), Date.now());
    for (const run of storage.history()) {
      expect(run.status).toBe('failed'); expect(run.error).toContain('ENOENT');
      expect(run.command).toBe('claude');
    }
  });
  it('uses the artifact’s single primary UTF-8 attachment as prompt content', () => {
    const dir = join(root, 'artifacts', '2026'); mkdirSync(join(dir, '2026-10-08-prompt'), { recursive: true });
    writeFileSync(join(dir, '2026-10-08-prompt.md'), '---\nname: Prompt\ncreated: 2026-10-08T12:00\nattachments: [prompt.md]\n---\n');
    writeFileSync(join(dir, '2026-10-08-prompt', 'prompt.md'), 'Attached instructions');
    expect(resolvePrompt(root, '#artifact/2026-10-08-prompt')).toBe('Attached instructions');
    expect(resolvePrompt(relative(process.cwd(), root), '#artifact/2026-10-08-prompt')).toBe('Attached instructions');
    expect(() => resolvePrompt(root, '#artifact/2026-10-08-prompt/prompt.md')).toThrow(/primary artifact handle/);
    expect(() => resolvePrompt(root, '#artifact/2026-10-08-missing')).toThrow();
  });
  it('rejects prompt record and attachment-directory symlinks even within the instance', () => {
    const dir = join(root, 'artifacts', '2026');
    const record = join(dir, '2026-10-08-prompt.md');
    const saved = join(root, 'saved.md');
    writeFileSync(saved, '---\nname: Prompt\ncreated: 2026-10-08T12:00\n---\nInstructions');
    symlinkSync(saved, record);
    expect(() => resolvePrompt(root, '#artifact/2026-10-08-prompt')).toThrow(/Symlinks are not allowed/);
    rmSync(record);
    writeFileSync(record, '---\nname: Prompt\ncreated: 2026-10-08T12:00\nattachments: [prompt.md]\n---\n');
    mkdirSync(join(root, 'sources'));
    writeFileSync(join(root, 'sources', 'prompt.md'), 'Attached instructions');
    symlinkSync(join(root, 'sources'), join(dir, '2026-10-08-prompt'));
    expect(() => resolvePrompt(root, '#artifact/2026-10-08-prompt')).toThrow(/Symlinks are not allowed/);
    rmSync(join(dir, '2026-10-08-prompt'));
    renameSync(dir, join(root, 'saved-year'));
    symlinkSync(join(root, 'saved-year'), dir);
    expect(() => resolvePrompt(root, '#artifact/2026-10-08-prompt')).toThrow(/Symlinks are not allowed/);
  });
  it('records missing named models and bad configuration as failed, without invoking an agent', async () => {
    await runner.run(job({ model: 'external', prompt: '#artifact/2026-10-08-instructions' }), Date.now());
    expect(storage.history()[0].error).toMatch(/not configured/);
    writeFileSync(join(root, '.aside'), 'execution:\n  cwd: [wrong]\n');
    await runner.run(job({ script: 'echo' }), Date.now());
    expect(storage.history().some(run => run.error?.includes('Invalid execution config'))).toBe(true);
    expect(storage.history().every(run => run.status === 'failed')).toBe(true);
  });
  it('records nonzero exit, spawn failures, timeout, and explicit shutdown cancellation', async () => {
    script('fail.js', 'process.exit(7)');
    await runner.run(job({ script: './fail.js' }), Date.now());
    expect(storage.history()[0].exitCode).toBe(7);
    await runner.run(job({ script: './missing' }), Date.now());
    expect(storage.history().some(run => run.error?.includes('ENOENT'))).toBe(true);
    script('wait.js', 'setInterval(()=>{}, 10000)');
    await runner.run(job({ script: './wait.js' }, 'PT0.05S'), Date.now());
    expect(storage.history().some(run => run.status === 'timed_out')).toBe(true);
    const active = runner.run(job({ script: './wait.js' }), Date.now());
    await new Promise(resolve => setTimeout(resolve, 20)); await runner.close(); await active;
    expect(storage.history().some(run => run.status === 'cancelled')).toBe(true);
  });
  it.each(['timeout', 'shutdown'] as const)('keeps a successful exit while only log flushing remains at %s', async trigger => {
    const finalizers: Array<() => void> = [];
    let hold = true;
    vi.mocked(createWriteStream).mockImplementation(() => new Writable({
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) { if (hold) finalizers.push(callback); else callback(); },
    }) as unknown as ReturnType<typeof createWriteStream>);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    script('success.cjs', "console.log('finished');");
    const launched = runner.launch(job({ script: './success.cjs' }, 'PT5S'), Date.now());
    let settled = false;
    const completion = launched.done.then(() => { settled = true; });
    let closing: Promise<void> | undefined;
    try {
      await waitUntil(() => launched.record.status === 'succeeded' && finalizers.length === 2);
      if (trigger === 'timeout') await vi.advanceTimersByTimeAsync(5000);
      else closing = runner.close();
      expect(settled).toBe(false);
      expect(launched.record.status).toBe('succeeded');
    } finally {
      hold = false;
      for (const callback of finalizers.splice(0)) callback();
      if (!settled && launched.record.pid) {
        try { process.kill(-launched.record.pid, 'SIGKILL'); } catch {}
      }
      await vi.runAllTimersAsync();
      await completion;
      if (closing) await closing;
    }
    expect(launched.record.status).toBe('succeeded');
  });
  it.skipIf(process.platform === 'win32').each(['timed_out', 'cancelled'] as const)(
    'waits for the whole process group after %s even when a child closes its output pipes', async status => {
      const fixture = processGroupFixture();
      const launched = runner.launch(job({ script: './leader.cjs' }, status === 'timed_out' ? 'PT5S' : undefined), Date.now());
      let pids: {pid: number; leader: number} | undefined;
      let settled = false, closed = false;
      const completion = launched.done.then(() => { settled = true; });
      try {
        pids = await readFixturePids(fixture.ready);
        const closing = status === 'cancelled' ? runner.close().then(() => { closed = true; }) : undefined;
        await waitUntil(() => { try { return readFileSync(fixture.terminated, 'utf8') === 'received'; } catch { return false; } }, 7000);
        await delay(100);
        expect(processRunning(pids.pid)).toBe(true);
        expect(settled).toBe(false);
        if (closing) expect(closed).toBe(false);
        await waitUntil(() => settled, 5000);
        await completion;
        if (closing) await closing;
        await waitUntil(() => !processRunning(pids!.pid), 500);
        expect(launched.record.status).toBe(status);
      } finally {
        cleanFixture(pids ?? (launched.record.pid ? { pid: launched.record.pid, leader: launched.record.pid } : undefined));
        await completion;
      }
    }, 15000,
  );
  it.skipIf(process.platform === 'win32')('times out a process group whose launcher exited while a child holds the output pipes', async () => {
    const fixture = processGroupFixture(true, true);
    const launched = runner.launch(job({ script: './leader.cjs' }, 'PT5S'), Date.now());
    let pids: {pid: number; leader: number} | undefined;
    let settled = false;
    const completion = launched.done.then(() => { settled = true; });
    try {
      pids = await readFixturePids(fixture.ready);
      await waitUntil(() => !processRunning(pids!.leader));
      expect(processRunning(pids.pid)).toBe(true);
      await waitUntil(() => settled, 10000);
      await completion;
      await waitUntil(() => !processRunning(pids!.pid), 500);
      expect(launched.record.status).toBe('timed_out');
    } finally {
      cleanFixture(pids ?? (launched.record.pid ? { pid: launched.record.pid, leader: launched.record.pid } : undefined));
      await completion;
    }
  }, 15000);
  it.skipIf(process.platform === 'win32')('finishes process-group teardown before reporting a log capture failure', async () => {
    const sinks: Writable[] = [];
    vi.mocked(createWriteStream).mockImplementation(() => {
      const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      sinks.push(sink);
      return sink as unknown as ReturnType<typeof createWriteStream>;
    });
    const fixture = processGroupFixture();
    const launched = runner.launch(job({ script: './leader.cjs' }), Date.now());
    let pids: {pid: number; leader: number} | undefined;
    let settled = false;
    const completion = launched.done.then(() => { settled = true; });
    try {
      pids = await readFixturePids(fixture.ready);
      sinks[0].destroy(new Error('Synthetic log capture failure'));
      await waitUntil(() => { try { return readFileSync(fixture.terminated, 'utf8') === 'received'; } catch { return false; } });
      await delay(100);
      expect(processRunning(pids.pid)).toBe(true);
      expect(settled).toBe(false);
      await waitUntil(() => settled, 5000);
      await completion;
      await waitUntil(() => !processRunning(pids!.pid), 500);
      expect(launched.record.status).toBe('failed');
      expect(launched.record.error).toContain('Synthetic log capture failure');
    } finally {
      cleanFixture(pids ?? (launched.record.pid ? { pid: launched.record.pid, leader: launched.record.pid } : undefined));
      await completion;
    }
  }, 15000);
  it('persists only claims and observed outcomes; unfinished old runs stay unobserved', async () => {
    expect(storage.claim('test', 123)).toBe(true);
    const fresh = new RunStorage(join(root, 'runs')); expect(fresh.lastClaim('test')).toBe(123); expect(fresh.claim('test', 123)).toBe(false);
    storage.start({ id: 'unfinished', key: 'test', root, definedIn: 'instance work', occurrence: new Date().toISOString(), started: new Date().toISOString(), status: 'running', session: storage.session, definition: job({ script: 'echo' }).definition, latenessMs: 0 });
    expect(fresh.history()[0].status).toBe('unobserved');
    expect(storage.history()[0].status).toBe('running');
  });
  it('preserves all automation declarations during project updates and notifies the scheduler immediately', () => {
    const declarations = { digest: { schedule: { cron: '0 8 * * *' }, run: { model: 'external', prompt: '#artifact/2026-10-08-instructions' } }, typo: { enabled: 'false' } };
    const fm = { name: 'Notes', created: '2026-10-08T12:00', automations: declarations };
    expect(parseProjectFile(serializeProject(fm, 'Body')).value.frontMatter.automations).toEqual(declarations);
    expect(parseManifest('---\nid: work\nautomations:\n  test: {}\n---').value.automations).toEqual({ test: {} });
    expect(parseConfig('execution:\n  cwd: ..\n').value.execution?.cwd).toBe('..');
    writeFileSync(join(root, 'aside.md'), '---\nid: work\n---');
    const store = new Store(root);
    let changed = 0; store.onChange(() => changed++);
    const id = '2026-10-08-notes', file = join(root, 'projects', '2026', id + '.md');
    store.saveProject(id, fm, 'Body', file); handleUpdateProject(store, { id, name: 'Renamed' });
    expect(changed).toBe(2);
    expect(parseProjectFile(readFileSync(file, 'utf8')).value.frontMatter.automations).toEqual(declarations);
    store.close();
  });
  it('uses unattended built-in flags and forwards custom CLI arguments without adding flags', () => {
    expect(modelCommand({ engine: 'codex', model: 'exact-id' }).args).toContain('never');
    expect(modelCommand({ engine: 'claude', model: 'sonnet' }).args).toContain('-p');
    expect(modelCommand({ command: 'third-agent', args: ['run', 'literal value'] })).toEqual({ command: 'third-agent', args: ['run', 'literal value'] });
    expect(modelCommand({ command: 'third-agent' }).args).toEqual([]);
  });
});
