import { defineConfig } from 'vitest/config';

// Tests pick their environment per file (`// @vitest-environment happy-dom`);
// the setup file repairs that environment's globals where Node's own differ.
export default defineConfig({
  test: { setupFiles: ['./test/setup.ts'] },
});
