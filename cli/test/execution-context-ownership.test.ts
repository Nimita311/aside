import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ModelCatalog} from '../src/automation/models.js';
import {readExecutionContextSnapshot} from '../src/source/execution-context.js';
import {AutomationModelWarmup} from '../src/automation/model-warmup.js';
import {AutomationRunner} from '../src/automation/execution.js';
import {RunStorage} from '../src/automation/storage.js';
import {compileSchedule} from '../src/automation/schedule.js';
import type {AutomationSource, ScheduledJob} from '../src/automation/scheduler.js';
import {validateDefinition} from '../src/core/automation.js';

let root: string, warmup: AutomationModelWarmup | undefined, runner: AutomationRunner | undefined;
beforeEach(() => {root = realpathSync(mkdtempSync('/private/tmp/aside-execution-context-'));});
afterEach(async () => {
  await warmup?.close(); await runner?.close(); warmup = undefined; runner = undefined;
  vi.restoreAllMocks(); rmSync(root, {recursive: true, force: true});
});
function executable(name: string, body = '') {
  const file = join(root, name); writeFileSync(file, `#!${process.execPath}\n${body}`); chmodSync(file, 0o700); return file;
}

describe('published execution settings', () => {
  it('keeps model inspection pinned to published settings while the source config changes', async () => {
    executable('codex'); const agent = executable('agent');
    const file = join(root, '.aside');
    writeFileSync(file, `execution:\n  models:\n    loaded: {command: ${JSON.stringify(agent)}}\n`);
    const executionContext = readExecutionContextSnapshot(root);
    const discover = vi.fn(async () => [{model: 'test'}]);
    const models = new ModelCatalog({discover, stateDirectory: join(root, 'catalog'), env: () => ({HOME: root, PATH: root})});
    writeFileSync(file, 'execution: [invalid]\n');
    const first = await models.for(root, {executionContext});
    expect(first.models.map(model => model.name)).toEqual(['CODEX_TEST', 'loaded']);
    // Metadata changes in the authored config must not invalidate this captured
    // generation through a hidden file fingerprint either.
    rmSync(file); mkdirSync(file);
    expect(await models.for(root, {executionContext})).toEqual(first);
    expect(discover).toHaveBeenCalledOnce();
    const unreadable = readExecutionContextSnapshot(root);
    await expect(models.for(root, {executionContext: unreadable})).rejects.toThrow('Cannot read execution config');
  });

  it('refreshes model warmup from a new published context without rereading the source file', () => {
    const file = join(root, '.aside');
    writeFileSync(file, 'execution:\n  models:\n    external: {command: third-agent}\n');
    const first = readExecutionContextSnapshot(root);
    writeFileSync(file, '{}\n'); const second = readExecutionContextSnapshot(root);
    writeFileSync(file, 'execution: [invalid]\n');
    const lookup = vi.fn(async () => ({models: [], diagnostics: [], revision: 'fixture'}));
    warmup = new AutomationModelWarmup(() => {}, lookup);
    const source: AutomationSource = {key: 'published', root, instance: 'work', definedIn: 'instance work',
      declaration: {schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: 'external', prompt: '#artifact/2026-10-08-instructions'}}};
    warmup.replace([{...source, executionContext: first}]);
    expect(warmup.warnings()).toEqual([]);
    warmup.replace([{...source, executionContext: second}]);
    expect(warmup.warnings()).toEqual([expect.objectContaining({message: 'Model "external" is not defined in this instance\'s .aside'})]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps an older captured discovery from replacing a newer generation picker', async () => {
    executable('codex');
    const file = join(root, '.aside');
    writeFileSync(file, '{}\n'); const first = readExecutionContextSnapshot(root);
    writeFileSync(file, 'execution: {cwd: .}\n'); const second = readExecutionContextSnapshot(root);
    let release!: (models: {model: string}[]) => void;
    const discover = vi.fn().mockImplementationOnce(() => new Promise<{model: string}[]>(resolve => {release = resolve;}))
      .mockResolvedValue([{model: 'new'}]);
    const directory = join(root, 'catalog');
    const models = new ModelCatalog({discover, stateDirectory: directory, env: () => ({HOME: root, PATH: root})});
    const pending = models.for(root, {executionContext: first});
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
    await models.for(root, {executionContext: second});
    release([{model: 'old'}]); await pending;
    const saved = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!), 'utf8'));
    expect(saved.catalogs.codex).toEqual([{model: 'new'}]);
    expect((await models.for(root, {executionContext: second})).models.map(model => model.name)).toEqual(['CODEX_NEW']);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('launches with the captured model and cwd, then adopts a newly published generation', async () => {
    const agent = executable('agent', "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));");
    const file = join(root, '.aside'), cwd = join(root, 'next'); mkdirSync(cwd);
    const config = (directory: string, argument: string) => writeFileSync(file,
      `execution:\n  cwd: ${directory}\n  models:\n    external:\n      command: ${JSON.stringify(agent)}\n      args: [${argument}]\n`);
    config('.', 'loaded'); const first = readExecutionContextSnapshot(root);
    config('next', 'next'); const second = readExecutionContextSnapshot(root);
    writeFileSync(file, 'execution: [invalid]\n');
    const storage = new RunStorage(join(root, 'runs')); runner = new AutomationRunner(storage);
    const definition = validateDefinition({schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: 'external', prompt: '#artifact/2026-10-08-instructions'}});
    const job: ScheduledJob = {key: 'published', root, instance: 'work', definedIn: 'instance work', declaration: definition,
      definition, schedule: compileSchedule(definition.schedule), executionContext: first};
    const one = runner.launch(job, Date.now()); await one.done;
    expect(one.record.status).toBe('succeeded');
    expect(JSON.parse(readFileSync(join(one.directory, 'stdout.log'), 'utf8'))).toEqual({cwd: root, args: ['loaded']});
    const two = runner.launch({...job, executionContext: second}, Date.now()); await two.done;
    expect(two.record.status).toBe('succeeded');
    expect(JSON.parse(readFileSync(join(two.directory, 'stdout.log'), 'utf8'))).toEqual({cwd, args: ['next']});
    rmSync(cwd, {recursive: true});
    const removed = runner.launch({...job, executionContext: second}, Date.now()); await removed.done;
    expect(removed.record.status).toBe('failed');
    expect(removed.record.error).toContain('ENOENT');
  });
});
