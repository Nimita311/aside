import { CALENDAR_LOCK_POLL_MS } from '../../core/system-config.js';
// Calendar-mutation lock: one holder per instance data dir at a time. The
// daemon is the only process that touches the calendar (design/daemon.md), so
// this serializes the phases inside it — a forward batch and a reverse pass —
// which must never interleave on one instance. Constructed without a data dir
// (no store), there is nothing to serialize on and the lock is a no-op.
const held = new Set<string>();

export class SyncLock {
  private holding = false;

  constructor(private dataDir?: string) {}

  // Acquire without blocking. False means another phase on this instance holds
  // it, this one included.
  tryAcquire(): boolean {
    if (!this.dataDir) return true;
    if (held.has(this.dataDir)) return false;
    held.add(this.dataDir);
    this.holding = true;
    return true;
  }

  // Retry tryAcquire until it succeeds or timeoutMs passes.
  async acquireWait(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.tryAcquire()) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, CALENDAR_LOCK_POLL_MS));
    }
    return true;
  }

  release(): void {
    if (!this.holding || !this.dataDir) return;
    this.holding = false;
    held.delete(this.dataDir);
  }
}
