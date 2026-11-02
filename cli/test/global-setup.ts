import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// The suite's daemon lives in its own directory (set in vitest.config.ts), so
// tests never reach the user's. Stop it and remove the directory afterwards.
export default function setup(): () => void {
  return () => {
    const home = process.env.ASIDE_DAEMON_HOME;
    if (!home) return;
    const bundle = join(__dirname, '..', 'dist', 'main.js');
    if (existsSync(bundle)) {
      try {
        execFileSync('node', [bundle, 'daemon', 'stop', '--force'], { stdio: 'ignore', timeout: 20_000 });
      } catch {}
    }
    rmSync(home, { recursive: true, force: true });
  };
}
