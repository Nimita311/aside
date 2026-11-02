import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, rmSync } from 'node:fs';

// The rest of the suite imports from src/, so it exercises the source-tree path
// layout. The shipped artifact runs from cli/dist/main.js, one directory
// shallower than cli/src/commands — a difference that silently broke template
// resolution in init. This smoke test runs the actual committed bundle so that
// class of source-vs-bundle drift fails here instead of in production.
const BUNDLE = join(__dirname, '..', 'dist', 'main.js');

describe.skipIf(!existsSync(BUNDLE))('bundled CLI', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('default init writes a valid manifest-only instance', () => {
    tmpDir = join(tmpdir(), `aside-test-bundle-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    // The default path builds aside.md programmatically (yaml.stringify) with no
    // templates — exercise it through the bundle since it's now the common case.
    execFileSync('node', [BUNDLE, 'instance', 'init', '--dir', tmpDir, '--name', 'Bundle', '--description', 'smoke'], { encoding: 'utf-8' });
    expect(existsSync(join(tmpDir, 'aside.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'notes'))).toBe(false);

    const validate = execFileSync('node', [BUNDLE, 'instance', 'validate', '--dir', tmpDir], { encoding: 'utf-8' });
    expect(validate).toContain('[OK]');
  });

  it('init --tutorial resolves its templates and creates a valid directory', () => {
    tmpDir = join(tmpdir(), `aside-test-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    // --tutorial lays down the template-backed scaffold, so this throws
    // (non-zero exit) if the embedded templates can't be loaded from the bundle.
    execFileSync('node', [BUNDLE, 'instance', 'init', '--dir', tmpDir, '--name', 'Bundle', '--description', 'smoke', '--tutorial'], { encoding: 'utf-8' });
    expect(existsSync(join(tmpDir, 'aside.md'))).toBe(true);
    const year = String(new Date().getFullYear());
    expect(existsSync(join(tmpDir, 'projects', year))).toBe(true);

    const validate = execFileSync('node', [BUNDLE, 'instance', 'validate', '--dir', tmpDir], { encoding: 'utf-8' });
    expect(validate).toContain('[OK]');
  });
});
