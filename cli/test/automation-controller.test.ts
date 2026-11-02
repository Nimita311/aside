import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutomationStatus } from '../src/automation/scheduler.js';
import { RunStorage, type RunRecord } from '../src/automation/storage.js';

const workers = vi.hoisted(() => [] as Array<{
  emit(event: string, message: unknown): boolean;
  messages: Array<{ type: string; id?: number }>;
}>);
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter {
    messages: Array<{ type: string; id?: number }> = [];
    constructor() { super(); workers.push(this); }
    postMessage(message: { type: string; id?: number }) {
      this.messages.push(message);
      if (message.type === 'close') this.emit('message', { type: 'closed' });
    }
    terminate() { return Promise.resolve(0); }
  } };
});
import { AutomationController } from '../src/automation/controller.js';

let controller: AutomationController | undefined;
afterEach(async () => { await controller?.close(); controller = undefined; workers.length = 0; });
describe('automation worker diagnostics', () => {
  it('surfaces wake-helper warnings for instances with jobs and clears resolved warnings', async () => {
    controller = new AutomationController('/tmp/aside-controller-test');
    controller.replace('/tmp/one', [{ key: 'one', root: '/tmp/one', instance: 'one', definedIn: 'instance one', declaration: {} }]);
    const jobs: AutomationStatus[] = [{ key: 'one', root: '/tmp/one', definedIn: 'instance one', running: false }];
    workers[0].emit('message', { type: 'status', jobs, warning: 'Native wake/clock helper is missing; rebuild the CLI.' });
    expect(controller.issues('/tmp/one')).toEqual(['Native wake/clock helper is missing; rebuild the CLI.']);
    expect(controller.issues('/tmp/other')).toEqual([]);
    workers[0].emit('message', { type: 'status', jobs });
    expect(controller.issues('/tmp/one')).toEqual([]);
    const inspection = controller.inspect();
    const id = workers[0].messages.at(-1)!.id;
    workers[0].emit('message', { type: 'inspection', id, jobs, runs: [], warning: 'Native wake/clock notifications are unavailable.' });
    expect((await inspection).warning).toBe('Native wake/clock notifications are unavailable.');
    expect(controller.issues('/tmp/one')).toEqual(['Native wake/clock notifications are unavailable.']);
    workers[0].emit('message', { type: 'status', jobs: [], warning: 'Native wake/clock notifications are unavailable.' });
    expect(controller.issues('/tmp/one')).toEqual([]);
  });
  it('cleans and purges offline history without starting a worker', async () => {
    const directory = mkdtempSync('/tmp/aside-controller-retention-'), storagePath = join(directory, 'runs');
    try {
      const storage = new RunStorage(storagePath), now = Date.now();
      const record = (id: string, age: number): RunRecord => ({id, key: 'job', root: '/fixtures/instance', definedIn: 'instance work',
        occurrence: new Date(now - age * 86_400_000).toISOString(), started: new Date(now - age * 86_400_000).toISOString(),
        status: 'succeeded', session: storage.session, latenessMs: 0,
        definition: {schedule: {cron: '0 8 * * *'}, run: {script: 'echo'}}});
      const expired = storage.start(record('expired', 31)), recent = storage.start(record('recent', 1));
      controller = new AutomationController(storagePath);
      expect(await controller.cleanup()).toEqual({runs: 1});
      expect(existsSync(expired)).toBe(false);
      expect(await controller.purge('/fixtures/instance')).toEqual({runs: 1});
      expect(existsSync(recent)).toBe(false);
      expect(workers).toHaveLength(0);
    } finally {rmSync(directory, {recursive: true, force: true});}
  });
  it('routes maintenance through the live worker and reports its errors', async () => {
    controller = new AutomationController('/tmp/aside-controller-test');
    controller.replace('/fixtures/instance', [{key: 'job', root: '/fixtures/instance', instance: 'work', definedIn: 'instance work', declaration: {}}]);
    const cleanup = controller.cleanup();
    const cleanupRequest = workers[0].messages.at(-1)!;
    expect(cleanupRequest).toMatchObject({type: 'cleanup'});
    workers[0].emit('message', {type: 'maintenance', id: cleanupRequest.id, result: {runs: 3}});
    expect(await cleanup).toEqual({runs: 3});
    const purge = controller.purge('/fixtures/instance');
    const purgeRequest = workers[0].messages.at(-1)!;
    expect(purgeRequest).toMatchObject({type: 'purge', root: '/fixtures/instance'});
    workers[0].emit('message', {type: 'error', id: purgeRequest.id, error: 'Synthetic cleanup failure'});
    await expect(purge).rejects.toThrow('Synthetic cleanup failure');
    expect(controller.issues('/fixtures/instance')).toEqual([]);
  });
  it.each(['cleanup', 'purge'] as const)('rejects offline %s filesystem failures through its promise', async operation => {
    const directory = mkdtempSync('/tmp/aside-controller-failure-'), blocked = join(directory, 'blocked');
    writeFileSync(blocked, 'Not a directory');
    controller = new AutomationController(join(blocked, 'runs'));
    try {
      await expect(controller[operation]()).rejects.toMatchObject({code: 'ENOTDIR'});
      expect(workers).toHaveLength(0);
    } finally {rmSync(directory, {recursive: true, force: true});}
  });
});
