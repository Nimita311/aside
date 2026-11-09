import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import {Store} from '../src/source/store.js';

const cleanup: Array<() => void> = [];
beforeEach(() => {vi.useFakeTimers(); vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});});
afterEach(() => {for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); vi.useRealTimers();});
async function fixture() {
  const root = mkdtempSync('/private/tmp/aside-feature-retry-');
  writeFileSync(join(root, 'aside.md'), '---\nid: feature-retry\n---\n');
  const store = new Store(root), lifecycle = new InstanceLifecycle({debounceMs: 5, reconciliationIntervalMs: 0});
  cleanup.push(() => {lifecycle.close(); rmSync(root, {recursive: true, force: true});});
  lifecycle.register(store); await lifecycle.flush();
  return {store, lifecycle};
}

describe('instance feature retry scheduling', () => {
  it('preserves a deferred request made during active work without spinning at the ordinary debounce', async () => {
    const f = await fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const reconcile = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);
    f.lifecycle.addFeature('integration', {reconcile}); await vi.advanceTimersByTimeAsync(0);
    f.lifecycle.requestFeatureReconcile('integration', f.store, 30_000);
    release(); await vi.advanceTimersByTimeAsync(0);
    await f.lifecycle.flush(); expect(reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_999); expect(reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(reconcile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not postpone already accepted work when a later retry is requested', async () => {
    const f = await fixture(), reconcile = vi.fn();
    f.lifecycle.addFeature('integration', {reconcile});
    f.lifecycle.requestFeatureReconcile('integration', f.store, 30_000);
    await f.lifecycle.flush(); expect(reconcile).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces retries to the earliest deadline and lets new source changes supersede it', async () => {
    const f = await fixture(), reconcile = vi.fn(), changed = vi.fn();
    f.lifecycle.addFeature('integration', {reconcile, changed}); await f.lifecycle.flush();
    reconcile.mockClear();
    f.lifecycle.requestFeatureReconcile('integration', f.store, 30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    f.lifecycle.requestFeatureReconcile('integration', f.store, 30_000);
    await vi.advanceTimersByTimeAsync(19_999); expect(reconcile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(reconcile).toHaveBeenCalledOnce();
    f.lifecycle.requestFeatureReconcile('integration', f.store, 30_000);
    f.store.rebuild(); await vi.advanceTimersByTimeAsync(5);
    expect(changed).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledTimes(2);
    f.lifecycle.requestFeatureReconcile('integration', f.store, 30_000);
    f.lifecycle.unregister(f.store); expect(vi.getTimerCount()).toBe(0);
  });
});
