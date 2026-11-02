import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { RunStorage, type RunRecord } from '../src/automation/storage.js';
import { AUTOMATION_HISTORY_LIMIT, AUTOMATION_WORKER_TIMEOUT_MS, DIAGNOSTIC_RETENTION_DAYS } from '../src/core/system-config.js';
import { delegationSource } from '../src/automation/delegation.js';

const day = 86_400_000, now = Date.parse('2026-10-17T12:00:00Z');
let temporary: string, storagePath: string, storage: RunStorage;
function record(id: string, age: number, overrides: Partial<RunRecord> = {}): RunRecord {
  const root = join(temporary, 'instance');
  const started = new Date(now - age * day).toISOString();
  return {id, key: JSON.stringify([root, 'instance work', 'daily']), root, definedIn: 'instance work', occurrence: started,
    started, finished: started, status: 'succeeded', session: storage.session, latenessMs: 0,
    definition: {schedule: {cron: '0 8 * * *'}, run: {script: 'echo'}}, ...overrides};
}
function start(run: RunRecord): string {
  const directory = storage.start(run);
  writeFileSync(join(directory, 'stdout.log'), 'Synthetic private output');
  writeFileSync(join(directory, 'stderr.log'), 'Synthetic private error');
  return directory;
}
beforeEach(() => {
  temporary = realpathSync(mkdtempSync('/tmp/aside-retention-'));
  storagePath = join(temporary, 'runs'); storage = new RunStorage(storagePath);
});
afterEach(() => rmSync(temporary, {recursive: true, force: true}));

describe('automation diagnostic retention', () => {
  it('expires inactive jobs by completion age and retains durable claims', () => {
    const expired = record('expired', DIAGNOSTIC_RETENTION_DAYS);
    const directory = start(expired);
    storage.claim(expired.key, 123);
    start(record('recent-finish', 90, {finished: new Date(now - day).toISOString()}));
    start(record('other-job', 31, {key: JSON.stringify([expired.root, 'instance work', 'removed'])}));
    expect(storage.cleanup(now)).toEqual({runs: 2});
    expect(existsSync(directory)).toBe(false);
    expect(storage.history().map(run => run.id)).toEqual(['recent-finish']);
    expect(new RunStorage(storagePath).claim(expired.key, 123)).toBe(false);
    expect(JSON.parse(readFileSync(join(dirname(directory), 'claim.json'), 'utf8'))).toEqual({key: expired.key, occurrence: 123});
  });

  it('keeps only the latest 50 completed runs per job while protecting active runs', () => {
    for (let index = 0; index < AUTOMATION_HISTORY_LIMIT + 2; index++) {
      start(record(`run-${index}`, 0, {started: new Date(now - index * 1_000).toISOString()}));
    }
    const active = start(record('active', 60, {status: 'running', finished: undefined}));
    expect(storage.cleanup(now)).toEqual({runs: 2});
    expect(storage.history()).toHaveLength(AUTOMATION_HISTORY_LIMIT + 1);
    expect(existsSync(active)).toBe(true);
    expect(storage.history().some(run => run.id === 'run-51')).toBe(false);
  });

  it('prunes age as well as count after a completion', () => {
    const run = record('expired', 31, {finished: new Date(Date.now() - 31 * day).toISOString()});
    const directory = start(run);
    storage.prune(run.key);
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(dirname(directory))).toBe(false);
  });

  it('expires unfinished previous-session runs by start time', () => {
    start(record('stale', 31, {status: 'running', session: 'previous', finished: undefined}));
    start(record('recent', 1, {status: 'running', session: 'previous', finished: undefined}));
    expect(storage.cleanup(now)).toEqual({runs: 1});
    expect(storage.history().map(run => [run.id, run.status])).toEqual([['recent', 'unobserved']]);
  });

  it('protects an execution cancelled before spawn bookkeeping finishes', () => {
    const directory = start(record('cancelling', 31, {status: 'cancelled', finished: undefined}));
    expect(storage.cleanup(now)).toEqual({runs: 0});
    expect(storage.purge()).toEqual({runs: 0});
    expect(existsSync(join(directory, 'stdout.log'))).toBe(true);
  });

  it('purges only the selected instance completed runs and protects pending completion writes', () => {
    const run = record('completing', 1), release = storage.protect(run);
    const completing = start(run);
    const removed = start(record('completed', 1));
    const active = start(record('active', 1, {status: 'running', finished: undefined}));
    const other = start(record('other', 1, {root: join(temporary, 'other'), key: 'other-job'}));
    expect(storage.purge(run.root)).toEqual({runs: 1});
    expect(existsSync(removed)).toBe(false);
    expect(existsSync(completing)).toBe(true);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(other)).toBe(true);
    run.actionId = '2026-10-17-result'; storage.save(run);
    release();
    expect(storage.purge(run.root)).toEqual({runs: 1});
    expect(existsSync(completing)).toBe(false);
  });

  it('preserves unknown contents and malformed or misplaced metadata', () => {
    const known = start(record('known', 31));
    writeFileSync(join(known, 'unknown.txt'), 'Retain this file');
    const malformed = start(record('malformed', 31));
    writeFileSync(join(malformed, 'run.json'), '{');
    const misplaced = start(record('misplaced', 31));
    writeFileSync(join(misplaced, 'run.json'), JSON.stringify(record('different-id', 31)));
    const invalidDate = start(record('invalid-date', 31, {finished: 'invalid'}));
    const numericDate = start(record('numeric-date', 31, {started: 2026 as unknown as string}));
    const arrayDate = start(record('array-date', 31, {finished: ['2026-10-17'] as unknown as string}));
    expect(storage.cleanup(now)).toEqual({runs: 1});
    expect(readFileSync(join(known, 'unknown.txt'), 'utf8')).toBe('Retain this file');
    expect(existsSync(join(known, 'run.json'))).toBe(false);
    expect(existsSync(join(known, 'stdout.log'))).toBe(false);
    for (const path of [malformed, misplaced, invalidDate, numericDate, arrayDate]) expect(existsSync(join(path, 'stdout.log'))).toBe(true);
  });

  it('never follows root, bucket, run, metadata, or output symlinks', () => {
    const outside = join(temporary, 'outside'); mkdirSync(outside);
    const target = join(outside, 'private.txt'); writeFileSync(target, 'Keep outside contents');
    const run = record('symlink-output', 31), directory = start(run);
    rmSync(join(directory, 'stdout.log')); symlinkSync(target, join(directory, 'stdout.log'));
    const metadata = start(record('symlink-metadata', 31));
    rmSync(join(metadata, 'run.json')); symlinkSync(target, join(metadata, 'run.json'));
    symlinkSync(outside, join(dirname(directory), 'symlink-run'));
    symlinkSync(outside, join(storagePath, 'a'.repeat(32)));
    expect(storage.cleanup(now)).toEqual({runs: 1});
    expect(readFileSync(target, 'utf8')).toBe('Keep outside contents');
    expect(existsSync(join(metadata, 'stderr.log'))).toBe(true);
    const alias = join(temporary, 'alias'); symlinkSync(storagePath, alias);
    expect(new RunStorage(alias).purge()).toEqual({runs: 0});
    expect(readFileSync(target, 'utf8')).toBe('Keep outside contents');
  });

  it('protects a finished delegation until its host completion and final save settle', async () => {
    const root = join(temporary, 'instance'); mkdirSync(root);
    writeFileSync(join(root, '.aside'), JSON.stringify({execution: {models: {external: {
      command: process.execPath, args: ['-e', 'process.stdin.resume()'],
    }}}}));
    const source = delegationSource(root, 'work', '2026-10-17-task', {frontMatter: {
      name: 'Work', created: '2026-10-17T09:00',
      delegation: {run: {model: 'external', prompt: '#artifact/2026-10-17-instructions'}},
    }, body: ''});
    for (let index = 0; index < AUTOMATION_HISTORY_LIMIT + 1; index++) {
      start(record(`prior-${index}`, 0, {key: source.key, started: new Date(Date.now() - 1_000 - index).toISOString(), root}));
    }
    const worker = new Worker(new URL('../dist/automation-worker.js', import.meta.url), {workerData: {storage: storagePath, wakeBinary: '/fixtures/no-wake-helper'}});
    const workerWait = {timeout: AUTOMATION_WORKER_TIMEOUT_MS};
    const messages: any[] = [];
    worker.on('message', message => {
      messages.push(message);
      if (message.type === 'delegation-request' && message.operation === 'prepare') {
        worker.postMessage({type: 'delegation-response', requestId: message.requestId, value: {source}});
      }
    });
    try {
      await vi.waitFor(() => expect(messages.some(message => message.type === 'status')).toBe(true), workerWait);
      worker.postMessage({type: 'delegate', id: 1, source});
      await vi.waitFor(() => expect(messages.some(message => message.type === 'delegation-request' && message.operation === 'complete')).toBe(true), workerWait);
      const completion = messages.find(message => message.type === 'delegation-request' && message.operation === 'complete');
      expect(storage.history(source.key)).toHaveLength(AUTOMATION_HISTORY_LIMIT + 1);
      worker.postMessage({type: 'purge', id: 2, root});
      await vi.waitFor(() => expect(messages.find(message => message.type === 'maintenance' && message.id === 2)?.result).toEqual({runs: AUTOMATION_HISTORY_LIMIT}), workerWait);
      expect(storage.history(source.key).map(run => run.id)).toEqual([completion.run.id]);
      worker.postMessage({type: 'delegation-response', requestId: completion.requestId, value: '2026-10-17-result'});
      await vi.waitFor(() => expect(storage.history(source.key)[0]?.actionId).toBe('2026-10-17-result'), workerWait);
      worker.postMessage({type: 'purge', id: 3, root});
      await vi.waitFor(() => expect(messages.find(message => message.type === 'maintenance' && message.id === 3)?.result).toEqual({runs: 1}), workerWait);
      expect(storage.history(source.key)).toEqual([]);
    } finally {await worker.terminate();}
  }, 30_000);
});
