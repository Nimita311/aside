import { DAEMON_POLL_INTERVAL_MS } from '../core/system-config.js';
import { closeSync, constants, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

// darwin open(2) flags: an exclusive kernel flock taken at open, failing with
// EAGAIN instead of blocking when held.
const O_NONBLOCK = 0x0004;
const O_EXLOCK = 0x0020;

// An exclusive lock on a file, held for as long as this process keeps it. On
// macOS it is a kernel flock, released the instant the holder exits or
// crashes. Elsewhere it is a pid file, stale once its process is gone.
export class FileLock {
  private fd: number | null = null;

  constructor(private path: string) {}

  tryAcquire(): boolean {
    if (this.fd !== null) return false;
    if (process.platform === 'darwin') {
      try {
        this.fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | O_NONBLOCK, 0o600);
        return true;
      } catch {
        return false;
      }
    }
    // Link a file that already holds our pid into place, so the lock never
    // exists without its owner written in it.
    const own = `${this.path}.${process.pid}`;
    try {
      writeFileSync(own, String(process.pid), { mode: 0o600 });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          linkSync(own, this.path);
          this.fd = openSync(this.path, 'r');
          return true;
        } catch {
          if (pidAlive(this.path)) return false;
          try { unlinkSync(this.path); } catch {}
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      try { unlinkSync(own); } catch {}
    }
  }

  async acquireWait(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.tryAcquire()) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, DAEMON_POLL_INTERVAL_MS));
    }
    return true;
  }

  release(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    closeSync(fd);
    if (process.platform !== 'darwin') {
      try { unlinkSync(this.path); } catch {}
    }
  }
}

// Whether some process holds the lock right now.
export function isLocked(path: string): boolean {
  const probe = new FileLock(path);
  if (!probe.tryAcquire()) return true;
  probe.release();
  return false;
}

function pidAlive(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
