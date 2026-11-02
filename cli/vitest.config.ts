import { defineConfig } from 'vitest/config';
import { mkdtempSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

// init.ts imports template files as raw text — the esbuild text loader handles
// that in the bundle; this is the Vite-side equivalent for the source tests, so
// the same imports resolve to file contents under vitest.
function rawTemplates() {
  return {
    name: 'raw-templates',
    enforce: 'pre' as const,
    load(id: string) {
      if (/[\\/](templates|mcp[\\/]resources)[\\/].*\.(md|yaml)$/.test(id)
        || /[\\/]agent[\\/]graphql[\\/]skills[\\/]aside[\\/]SKILL\.md$/.test(id)) {
        return `export default ${JSON.stringify(readFileSync(id, 'utf-8'))};`;
      }
      return null;
    },
  };
}

// Bundle-driven tests spawn a real daemon. Give the suite its own daemon
// directory — short, because a socket path is capped near 100 bytes — and stop it in global teardown.
const daemonHome = mkdtempSync('/tmp/aside-test-');
process.env.ASIDE_DAEMON_HOME = daemonHome;

export default defineConfig({
  plugins: [rawTemplates()],
  test: {
    globals: false,
    // Leave headroom for the suite's native probes, workers, and CLI subprocesses.
    maxWorkers: Math.max(1, Math.min(8, availableParallelism() - 1)),
    globalSetup: ['./test/global-setup.ts'],
    // No calendar helper: the suite's daemon must never reach the real calendar.
    // Tests that exercise sync point ASIDE_CAL_BIN at a stub and run their own daemon.
    env: { ASIDE_DAEMON_HOME: daemonHome, ASIDE_CAL_BIN: '/nonexistent/aside-cal' },
  },
});
