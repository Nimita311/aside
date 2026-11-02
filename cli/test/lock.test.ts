import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SyncLock } from '../src/mcp/calendar/lock.js';

const dirs: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'aside-lock-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// One holder per instance data dir within the process.
describe('SyncLock', () => {
  it('conflicts between two locks on one dir; release lets the other in', () => {
    const d = dir();
    const a = new SyncLock(d);
    const b = new SyncLock(d);
    expect(a.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false); // exclusive while held
    a.release();
    expect(b.tryAcquire()).toBe(true); // freed by release
    b.release();
  });

  it('is reusable sequentially: acquire / release / acquire', () => {
    const d = dir();
    const a = new SyncLock(d);
    expect(a.tryAcquire()).toBe(true);
    a.release();
    expect(a.tryAcquire()).toBe(true);
    a.release();
  });

  it('acquireWait succeeds once the holder releases', async () => {
    const d = dir();
    const a = new SyncLock(d);
    const b = new SyncLock(d);
    expect(a.tryAcquire()).toBe(true);
    const wait = b.acquireWait(5000);
    setTimeout(() => a.release(), 300);
    expect(await wait).toBe(true);
    b.release();
  });

  it('acquireWait times out while the lock stays held', async () => {
    const d = dir();
    const a = new SyncLock(d);
    const b = new SyncLock(d);
    expect(a.tryAcquire()).toBe(true);
    expect(await b.acquireWait(300)).toBe(false);
    a.release();
  });

  it('is a no-op without a data dir', () => {
    const a = new SyncLock();
    const b = new SyncLock();
    expect(a.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
  });

  it('releasing a lock that was never acquired leaves the holder in place', () => {
    const d = dir();
    const a = new SyncLock(d);
    const b = new SyncLock(d);
    expect(a.tryAcquire()).toBe(true);
    b.release();
    expect(b.tryAcquire()).toBe(false);
    a.release();
  });
});
