import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationScheduler, type AutomationSource } from '../src/automation/scheduler.js';

const base = new Date('2026-10-08T12:00:00Z').getTime();
const source = (key = 'test', declaration: unknown = { schedule: { cron: '* * * * *', timezone: 'UTC' }, run: { script: 'echo' } }): AutomationSource => ({ key, root: '/instance', instance: 'test', definedIn: 'instance test', declaration });
let schedulers: AutomationScheduler[];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(base); schedulers = []; });
afterEach(() => { for (const scheduler of schedulers) scheduler.close(); vi.useRealTimers(); });
function setup(run = vi.fn().mockResolvedValue(undefined)) {
  const claims = new Map<string, number>();
  const claim = vi.fn((key: string, at: number) => { if (at <= (claims.get(key) ?? -Infinity)) return false; claims.set(key, at); return true; });
  const scheduler = new AutomationScheduler({ run, claim, lastClaim: key => claims.get(key) }, 'UTC', { now: () => Date.now(), monotonic: () => Date.now() });
  schedulers.push(scheduler); return { scheduler, run, claims, claim };
}
describe('event-driven automation scheduler', () => {
  it('has no idle timer, one timer for multiple jobs, and fires the earliest deadline', async () => {
    const { scheduler, run } = setup();
    expect(vi.getTimerCount()).toBe(0);
    scheduler.replace([source(), source('later', { schedule: { at: '2026-10-08T12:00:30Z' }, run: { script: 'echo' } })]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe(base + 30000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.replace([]); expect(vi.getTimerCount()).toBe(0);
  });
  it('replaces timers on edits and preserves an unchanged deadline across rebuilds', async () => {
    const { scheduler, run } = setup();
    scheduler.replace([source()]);
    await vi.advanceTimersByTimeAsync(50000);
    scheduler.replace([source()]);
    expect(scheduler.status()[0].next).toBe('2026-10-08T12:01:00.000Z');
    scheduler.replace([source('test', { schedule: { at: '2026-10-08T12:02:00Z' }, run: { script: 'echo' } })]);
    await vi.advanceTimersByTimeAsync(10000); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000); expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refreshes instance context for unchanged project declarations while retaining their deadline', async () => {
    const { scheduler, run } = setup();
    const project = { ...source(), definedIn: '#project/2026-10-08-notes', instance: 'before' };
    scheduler.replace([project]);
    await vi.advanceTimersByTimeAsync(50000);
    scheduler.replace([{ ...project, instance: 'after' }]);
    expect(scheduler.status()[0].next).toBe('2026-10-08T12:01:00.000Z');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].instance).toBe('after');
  });
  it('skips past one-time executions and all slots missed during sleep', async () => {
    const { scheduler, run } = setup();
    scheduler.replace([source(), source('past', { schedule: { at: '2026-10-08T11:59Z' }, run: { script: 'echo' } })]);
    scheduler.sleep();
    await vi.advanceTimersByTimeAsync(600000);
    expect(run).not.toHaveBeenCalled();
    scheduler.wake();
    expect(scheduler.status().find(job => job.key === 'test')?.next).toBe('2026-10-08T12:11:00.000Z');
    await vi.advanceTimersByTimeAsync(60000); expect(run).toHaveBeenCalledTimes(1);
  });
  it('queues only the latest observed overlap and launches it once after the active run', async () => {
    let finish: () => void = () => {};
    const run = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const { scheduler } = setup(run);
    scheduler.replace([source()]);
    await vi.advanceTimersByTimeAsync(180000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.status()[0].pending).toBe('2026-10-08T12:03:00.000Z');
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1]).toBe(base + 180000);
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.status()[0].running).toBe(false);
  });
  it('edits and disable drop queued work, while skip overlap never queues', async () => {
    let finish: () => void = () => {};
    const run = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const { scheduler } = setup(run);
    scheduler.replace([source()]); await vi.advanceTimersByTimeAsync(120000);
    scheduler.replace([source('test', { schedule: { cron: '* * * * *', timezone: 'UTC' }, run: { script: 'echo' }, enabled: false })]);
    expect(scheduler.status()[0].running).toBe(true);
    finish(); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
    scheduler.replace([source('test', { schedule: { cron: '* * * * *', timezone: 'UTC' }, run: { script: 'echo' }, overlap: 'skip' })]);
    await vi.advanceTimersByTimeAsync(120000);
    expect(scheduler.status()[0].pending).toBeUndefined();
    finish(); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(2);
  });
  it('cannot overlap after delete/re-add or duplicate after clock rollback', async () => {
    let finish: () => void = () => {};
    const run = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const { scheduler } = setup(run);
    scheduler.replace([source()]); await vi.advanceTimersByTimeAsync(60000);
    scheduler.replace([]); scheduler.replace([source()]);
    await vi.advanceTimersByTimeAsync(60000); expect(run).toHaveBeenCalledTimes(1);
    finish(); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(2);
    finish(); await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(base); scheduler.discontinuity();
    expect(scheduler.status()[0].next).toBe('2026-10-08T12:03:00.000Z');
    await vi.advanceTimersByTimeAsync(120000); expect(run).toHaveBeenCalledTimes(2);
  });
  it('rearms long waits at the Node timer limit without premature execution', async () => {
    const { scheduler, run } = setup();
    const future = new Date(base + 60 * 86400000).toISOString();
    scheduler.replace([source('far', { schedule: { at: future }, run: { script: 'echo' } })]);
    await vi.advanceTimersByTimeAsync(2147483647);
    expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 86400000 - 2147483647);
    expect(run).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('changes implicit local zones without altering explicit zones', () => {
    const { scheduler } = setup();
    scheduler.replace([source('local', { schedule: { cron: '0 8 * * *' }, run: { script: 'echo' } }),
      source('explicit', { schedule: { cron: '0 8 * * *', timezone: 'UTC' }, run: { script: 'echo' } })]);
    scheduler.discontinuity('America/Los_Angeles');
    expect(scheduler.status().find(job => job.key === 'local')?.next).toBe('2026-10-08T15:00:00.000Z');
    expect(scheduler.status().find(job => job.key === 'explicit')?.next).toBe('2026-10-09T08:00:00.000Z');
  });
  it('does not retry a failed launch but keeps its next independent occurrence', async () => {
    const run = vi.fn().mockRejectedValue(new Error('Launch failed'));
    const { scheduler } = setup(run); scheduler.replace([source()]);
    await vi.advanceTimersByTimeAsync(60000); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59000); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); expect(run).toHaveBeenCalledTimes(2);
  });
  it('skips a deadline when wall-clock and monotonic time diverge', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const scheduler = new AutomationScheduler({ run, claim: () => true, lastClaim: () => undefined }, 'UTC',
      { now: () => Date.now(), monotonic: () => 0 });
    schedulers.push(scheduler);
    scheduler.replace([source('clock', { schedule: { at: '2026-10-08T12:00:30Z' }, run: { script: 'echo' } })]);
    await vi.advanceTimersByTimeAsync(30000); expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects one invalid sibling without losing valid jobs or polling', () => {
    const { scheduler } = setup();
    scheduler.replace([source(), source('bad', { schedule: { cron: 'bad' }, run: { script: 'echo' } })]);
    expect(scheduler.status().find(job => job.key === 'bad')?.error).toMatch(/five/);
    expect(scheduler.status().find(job => job.key === 'test')?.next).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
  });
});
