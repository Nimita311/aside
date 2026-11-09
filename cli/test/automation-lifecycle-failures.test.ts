import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AutomationSource} from '../src/automation/scheduler.js';

const bridge = vi.hoisted(() => ({replace: undefined as ((sources: AutomationSource[]) => void) | undefined,
  close: undefined as (() => void) | undefined}));
vi.mock('node:worker_threads', async importOriginal => {
  const original = await importOriginal<typeof import('node:worker_threads')>();
  const {EventEmitter} = await import('node:events');
  return {...original, Worker: class extends EventEmitter {
    postMessage(message: {type: string; sources?: AutomationSource[]}) {
      if (message.type === 'replace') bridge.replace?.(message.sources!);
      if (message.type === 'close') {bridge.close?.(); this.emit('message', {type: 'closed'});}
    }
    terminate() {return Promise.resolve(0);}
  }};
});
import {AutomationScheduler} from '../src/automation/scheduler.js';
import {InstanceHost} from '../src/daemon/host.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {Store} from '../src/source/store.js';

let host: InstanceHost | undefined, scheduler: AutomationScheduler | undefined, directory: string | undefined;
afterEach(async () => {
  try {await host?.close();}
  finally {
    scheduler?.close(); bridge.replace = undefined; bridge.close = undefined;
    if (directory) rmSync(directory, {recursive: true, force: true});
    host = undefined; scheduler = undefined; directory = undefined;
    vi.restoreAllMocks(); vi.useRealTimers();
  }
});

describe('automation feature failure isolation', () => {
  it('suspends obsolete jobs after cyclic source edits while preserving other roots and recovering after repair', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T19:00:00Z'));
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    const run = vi.fn(async () => {});
    scheduler = new AutomationScheduler({run, claim: () => true, lastClaim: () => undefined}, 'UTC', {
      now: () => Date.now(), monotonic: () => Date.now(),
    });
    bridge.replace = sources => scheduler!.replace(sources);
    bridge.close = () => scheduler!.close();
    directory = mkdtempSync('/private/tmp/aside-automation-lifecycle-');
    const source = (root: string, id: string, cyclic = false) => {
      mkdirSync(root, {recursive: true});
      writeFileSync(join(root, 'aside.md'), `---\nid: ${id}\nname: ${id}\nautomations:\n  job:${cyclic ? ' &cycle' : ''}\n    schedule:\n      at: 2099-01-01T00:00:00Z\n    run:\n      script: unused-test-command\n${cyclic ? '    unexpected: *cycle\n' : ''}---\n`);
    };
    const failing = join(directory, 'failing'), healthy = join(directory, 'healthy');
    source(failing, 'failing-root'); source(healthy, 'healthy-root');
    host = new InstanceHost(new CalClient(null));
    host.configureSources({debounceMs: 5, retryMinMs: 10, retryMaxMs: 40, reconciliationIntervalMs: 0});
    host.configureAutomation(join(directory, 'runs'));
    const loaded = host.load(failing); host.load(healthy);
    await vi.advanceTimersByTimeAsync(10);
    expect(scheduler.status().map(job => job.root).sort()).toEqual([failing, healthy].sort());
    const healthyDeadline = scheduler.status().find(job => job.root === healthy)!.next;

    source(failing, 'failing-root', true); loaded.store.rebuild();
    expect(loaded.store.getIssues()).toContainEqual(expect.objectContaining({code: 'invalid_automation'}));
    await vi.advanceTimersByTimeAsync(5);
    expect(scheduler.status().map(job => job.root)).toEqual([healthy]);
    expect(scheduler.status()[0].next).toBe(healthyDeadline);
    expect(host.issues(failing)).toContainEqual(expect.objectContaining({code: 'instance_feature_failed', field: 'automation'}));
    await vi.advanceTimersByTimeAsync(50);
    expect(scheduler.status().map(job => job.root)).toEqual([healthy]);
    expect(run).not.toHaveBeenCalled();

    source(failing, 'failing-root'); loaded.store.rebuild();
    await vi.advanceTimersByTimeAsync(5);
    expect(scheduler.status().map(job => job.root).sort()).toEqual([failing, healthy].sort());
    expect(scheduler.status().find(job => job.root === healthy)!.next).toBe(healthyDeadline);
    expect(host.issues(failing).some(issue => issue.code === 'instance_feature_failed' && issue.field === 'automation')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
