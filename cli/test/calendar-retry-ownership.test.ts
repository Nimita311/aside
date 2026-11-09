import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import {InstanceCalendarLifecycle} from '../src/daemon/calendar-lifecycle.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {CalSync, storeAction} from '../src/mcp/calendar/sync.js';
import {SyncLock} from '../src/mcp/calendar/lock.js';
import {CALENDAR_SYNC_RETRY_MS, CALENDAR_RECONCILE_RETRY_MS} from '../src/core/system-config.js';

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  // Prove the retry reads current owner state without a fresh source signal.
  vi.spyOn(Store.prototype, 'onChange').mockImplementation(() => () => {});
});
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture() {
  const root = mkdtempSync('/private/tmp/aside-calendar-retry-owner-');
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'actions', '2026'), {recursive: true});
  writeFileSync(join(root, 'aside.md'), '---\nid: retry-owner\n---\n');
  const file = join(root, 'actions', '2026', 'existing.md');
  writeFileSync(file, '---\nname: Existing\ncreated: 2026-06-01\nscheduled: 2026-06-01T09:00\ncalendar: Work\n---\nBody.\n');
  const store = new Store(root), cal = new CalClient(null);
  const lifecycle = new InstanceLifecycle({reconciliationIntervalMs: 0, debounceMs: 5});
  const calendar = new InstanceCalendarLifecycle((source, delay) => lifecycle.requestFeatureReconcile('calendar', source, delay));
  const sync = new CalSync(cal, '', store, undefined, undefined, write => {lifecycle.mutation(store, write);});
  const reconcile = (source: Store) => calendar.reconcile(source);
  lifecycle.addFeature('calendar', {load: source => calendar.register(source, sync), changed: reconcile, reconcile,
    unload: source => calendar.unregister(source)});
  cleanup.push(() => {lifecycle.close(); sync.dispose(); cal.close();});
  lifecycle.register(store); await lifecycle.flush();
  vi.spyOn(cal, 'available').mockReturnValue(true);
  const auth = vi.spyOn(cal, 'authStatus').mockResolvedValue({status: 'denied'});
  return {store, cal, sync, lifecycle, file, auth};
}

describe('Calendar retry ownership', () => {
  it.each(['pending-delivery', 'lock-contention'] as const)('delivers %s retries through lifecycle using the latest loaded actions', async reason => {
    const f = await fixture();
    const delay = reason === 'pending-delivery' ? CALENDAR_SYNC_RETRY_MS : CALENDAR_RECONCILE_RETRY_MS;
    const requested = vi.spyOn(f.lifecycle, 'requestFeatureReconcile');
    if (reason === 'pending-delivery') await f.sync.syncActions([storeAction(f.store, 'existing')!], []);
    else {
      f.auth.mockResolvedValue({status: 'fullAccess'});
      const held = vi.spyOn(SyncLock.prototype, 'tryAcquire').mockReturnValue(false);
      await f.sync.reconcile([storeAction(f.store, 'existing')!]); held.mockRestore();
    }
    expect(requested).toHaveBeenCalledWith('calendar', f.store, delay);
    expect(vi.getTimerCount()).toBe(1);
    const forward = vi.spyOn(f.sync, 'syncActions').mockResolvedValue([]);
    vi.spyOn(f.sync, 'reconcile').mockResolvedValue();
    // Shutdown draining must not turn a future provider retry into a hot loop.
    await f.lifecycle.flush(); expect(forward).not.toHaveBeenCalled();
    const action = f.store.getAction('existing')!;
    f.store.saveAction('existing', {...action.frontMatter, scheduled: '2026-06-01T12:00'}, action.body, f.file);
    await vi.advanceTimersByTimeAsync(delay - 1); expect(forward).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(forward).toHaveBeenCalledOnce();
    expect(forward.mock.calls[0][1][0].frontMatter.scheduled).toBe('2026-06-01T12:00');
  });

  it('cancels pending reconciliation when its instance is unloaded', async () => {
    const f = await fixture(); await f.sync.syncActions([storeAction(f.store, 'existing')!], []);
    expect(vi.getTimerCount()).toBe(1);
    f.lifecycle.unregister(f.store);
    const forward = vi.spyOn(f.sync, 'syncActions');
    await vi.advanceTimersByTimeAsync(CALENDAR_SYNC_RETRY_MS);
    expect(forward).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('fails explicitly when a protocol adapter has pending work without a lifecycle provider', async () => {
    const cal = new CalClient(null), sync = new CalSync(cal, 'retry-owner');
    cleanup.push(() => {sync.dispose(); cal.close();});
    vi.spyOn(cal, 'available').mockReturnValue(true);
    vi.spyOn(cal, 'authStatus').mockResolvedValue({status: 'denied'});
    expect(await sync.syncActions([{id: 'existing', frontMatter: {name: 'Existing', created: '2026-06-01',
      scheduled: '2026-06-01T09:00', calendar: 'Work'}, body: ''}], [])).toEqual([
      {id: 'existing', status: 'error', reason: 'calendar sync failed: Calendar reconciliation requires a lifecycle owner.'},
    ]);
    expect(sync.status('existing')).toMatchObject({status: 'failed', reason: expect.stringContaining('lifecycle owner')});
    expect(vi.getTimerCount()).toBe(0);
  });
});
