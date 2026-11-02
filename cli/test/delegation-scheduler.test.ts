import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationScheduler } from '../src/automation/scheduler.js';
import { delegationKey, delegationSource, nextDelegation } from '../src/automation/delegation.js';
import { projectionId, projectedAction } from '../src/core/recurrence.js';
import { scheduleInstant } from '../src/core/scheduling.js';
import type { Action } from '../src/core/types.js';

const definition = {run: {model: 'external', prompt: '#artifact/2026-10-12-instructions'}};
const base = Date.parse('2026-10-12T12:00:00Z');
let scheduler: AutomationScheduler;
beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(base);});
afterEach(() => {scheduler?.close(); vi.useRealTimers();});
function action(fields: Partial<Action['frontMatter']>): Action {return {frontMatter: {name: 'Work', created: '2026-10-12T09:00', delegation: definition, ...fields}, body: 'Do the work.'};}
function setup() {
  const claims = new Map<string, number>();
  const run = vi.fn(async () => {});
  scheduler = new AutomationScheduler({run, claim: (key, at) => {if (at <= (claims.get(key) ?? -Infinity)) return false; claims.set(key, at); return true;}, lastClaim: key => claims.get(key)}, 'UTC', {now: Date.now, monotonic: Date.now});
  return {run, claims};
}
describe('delegation deadlines', () => {
  it('follows the action schedule and disarms when completed, cancelled, or unscheduled', async () => {
    const {run} = setup();
    const task = action({scheduled: '2026-10-12T12:01', timezone: 'UTC'});
    const source = () => delegationSource('/instance', 'work', '2026-10-12-task', task);
    scheduler.replace([source()]);
    expect(scheduler.status()[0].next).toBe('2026-10-12T12:01:00.000Z');
    task.frontMatter.resolution = 'done'; scheduler.replace([source()]);
    await vi.advanceTimersByTimeAsync(60000); expect(run).not.toHaveBeenCalled();
    delete task.frontMatter.resolution; task.frontMatter.scheduled = '2026-10-12T12:02'; scheduler.replace([source()]);
    task.frontMatter.resolution = 'cancelled'; scheduler.replace([source()]);
    await vi.advanceTimersByTimeAsync(60000); expect(run).not.toHaveBeenCalled();
    delete task.frontMatter.resolution; delete task.frontMatter.scheduled; scheduler.replace([source()]);
    expect(scheduler.status()[0].next).toBeUndefined();
  });
  it('seeks recurrence without a lookahead horizon, excludes saved occurrences, and advances through every projection', async () => {
    const {run} = setup();
    const template = action({recurrence: [{dtstart: '2026-10-12T12:01', timezone: 'UTC', rrule: 'FREQ=MINUTELY;COUNT=4'}]});
    scheduler.replace([delegationSource('/instance', 'work', '2026-10-12-template', template, ['2026-10-12T12:02:00Z'])]);
    await vi.advanceTimersByTimeAsync(240000);
    expect(run.mock.calls.map(call => call[1])).toEqual([base + 60000, base + 180000, base + 240000]);
    expect(scheduler.status()[0].next).toBeUndefined();
    const distant = action({recurrence: [{dtstart: '2099-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=YEARLY;COUNT=1'}]});
    expect(nextDelegation({id: 'template', action: distant}, base)?.at).toBe(Date.parse('2099-01-01T09:00:00Z'));
  });
  it('replaces the pending deadline on schedule edits and retains claims across clock rollback', async () => {
    const {run} = setup();
    const task = action({scheduled: '2026-10-12T12:01', timezone: 'UTC'});
    scheduler.replace([delegationSource('/instance', 'work', 'task', task)]);
    task.frontMatter.scheduled = '2026-10-12T12:02'; scheduler.replace([delegationSource('/instance', 'work', 'task', task)]);
    await vi.advanceTimersByTimeAsync(120000); expect(run).toHaveBeenCalledOnce();
    vi.setSystemTime(base); scheduler.discontinuity();
    await vi.advanceTimersByTimeAsync(120000); expect(run).toHaveBeenCalledOnce();
  });
  it('uses the same key for a projection and its materialized occurrence', () => {
    const template = action({recurrence: [{dtstart: '2026-10-12T12:01', timezone: 'UTC', rrule: 'FREQ=DAILY'}]});
    const identity = {template: '2026-10-12-template', original: '2026-10-12T12:01:00Z', timezone: 'UTC'};
    const occurrence = projectedAction(template, identity, '2026-10-12T12:01');
    expect(delegationKey('/instance', projectionId(identity), occurrence)).toBe(delegationKey('/instance', '2026-10-13-saved', occurrence));
    expect(occurrence.frontMatter.delegation).toEqual(definition);
  });
  it('honors saved occurrence timing independently of the template and keeps a cleared occurrence suppressed', async () => {
    const {run} = setup();
    const template = action({recurrence: [{dtstart: '2026-10-12T12:01', timezone: 'UTC', rrule: 'FREQ=MINUTELY;COUNT=3'}]});
    const identity = {template: 'template', original: '2026-10-12T12:01:00Z', timezone: 'UTC'};
    const saved = projectedAction(template, identity, '2026-10-12T12:05');
    scheduler.replace([delegationSource('/instance', 'work', 'template', template, [identity.original]), delegationSource('/instance', 'work', 'saved', saved)]);
    await vi.advanceTimersByTimeAsync(300000);
    expect(run.mock.calls.map(call => call[1])).toEqual([base + 120000, base + 180000, base + 300000]);
    vi.setSystemTime(base); scheduler.close(); setup();
    delete saved.frontMatter.delegation;
    scheduler.replace([delegationSource('/instance', 'work', 'template', template, [identity.original])]);
    expect(scheduler.status()[0].next).toBe('2026-10-12T12:02:00.000Z');
  });
  it('uses date-only midnight locally, skips named-zone gaps, and uses the first fold', () => {
    const allDay = action({scheduled: '2026-10-13', timezone: 'Asia/Tokyo'});
    expect(nextDelegation({id: 'all-day', action: allDay}, base)?.at).toBe(scheduleInstant('2026-10-13'));
    const gap = action({recurrence: [{dtstart: '2026-03-07T02:30', timezone: 'America/New_York', rrule: 'FREQ=DAILY;COUNT=3'}]});
    expect(nextDelegation({id: 'gap', action: gap}, Date.parse('2026-03-07T08:00:00Z'))?.action.frontMatter.scheduled).toBe('2026-03-09T02:30');
    const fold = action({scheduled: '2026-11-01T01:30', timezone: 'America/New_York'});
    expect(nextDelegation({id: 'fold', action: fold}, Date.parse('2026-11-01T04:00:00Z'))?.at).toBe(Date.parse('2026-11-01T05:30:00Z'));
  });
});
