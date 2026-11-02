import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const { supportsNode } = createRequire(import.meta.url)('../node-version.cjs');
const launcher = join(root, 'cli/dist/main.js');

function fixture(run: (dir: string, preload: string) => void): void {
  const dir = mkdtempSync('/tmp/aside-node-');
  const preload = join(dir, 'version.mjs');
  writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: process.env.TEST_NODE_VERSION });\nObject.defineProperty(process, 'version', { value: 'v' + process.env.TEST_NODE_VERSION });\n`);
  try { run(dir, preload); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// These tests simulate the reported version with the current executable. Actual
// supported Node binaries are a separate release validation, not simulated here.
describe('Node requirement', () => {
  it.each([
    ['18.20.8', false], ['20.19.0', false], ['22.11.9', false],
    ['22.12.0', true], ['22.12.1', true], ['24.0.0', true], ['26.7.0', true],
    ['not a version', false],
  ])('accepts %s: %s', (version, supported) => {
    expect(supportsNode(version)).toBe(supported);
  });

  it('source builds reject old Node before dependency installs or native builds', () => fixture((dir, preload) => {
    symlinkSync('/usr/bin/dirname', join(dir, 'dirname'));
    const invoked = join(dir, 'npm-invoked');
    writeFileSync(join(dir, 'node'), `#!/bin/sh\nexec "${process.execPath}" --import "${preload}" "$@"\n`);
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\necho called > "${invoked}"\nexit 99\n`);
    chmodSync(join(dir, 'node'), 0o755);
    chmodSync(join(dir, 'npm'), 0o755);
    const result = spawnSync('/bin/bash', [join(root, 'build.sh')], {
      env: { ...process.env, PATH: dir, TEST_NODE_VERSION: '22.11.0' }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('>= 22.12.0; detected v22.11.0');
    expect(result.stderr).toContain(process.execPath);
    expect(result.stderr).toContain('24 LTS');
    expect(existsSync(invoked)).toBe(false);
  }));

  it('source builds explain a missing Node executable', () => fixture(dir => {
    symlinkSync('/usr/bin/dirname', join(dir, 'dirname'));
    const result = spawnSync('/bin/bash', [join(root, 'build.sh')], { env: { ...process.env, PATH: dir }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no Node executable found on PATH');
    expect(result.stderr).toContain('Install Node.js 24 LTS');
    expect(result.stdout).toBe('');
  }));

  it('the CLI build rejects old Node before importing esbuild', () => fixture((dir, preload) => {
    // The same build script with only its local guard files; esbuild is absent.
    for (const file of ['build.mjs', 'node-version.cjs']) writeFileSync(join(dir, file), readFileSync(join(root, 'cli', file)));
    const result = spawnSync(process.execPath, ['--import', preload, join(dir, 'build.mjs')], {
      env: { ...process.env, TEST_NODE_VERSION: '18.20.8' }, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('detected v18.20.8');
    expect(result.stderr).not.toContain('Cannot find package');
  }));

  describe.skipIf(!existsSync(launcher))('public launcher', () => {
    it.each([['mcp'], ['daemon', 'run'], ['plugin', 'install', '--agent', 'codex']])('rejects old Node before %j loads the runtime', (...args) => fixture((dir, preload) => {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(dir, 'main.js'), readFileSync(launcher));
      const marker = join(dir, 'runtime-loaded');
      writeFileSync(join(dir, 'runtime.js'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
      const result = spawnSync(process.execPath, ['--import', preload, join(dir, 'main.js'), ...args], {
        env: { ...process.env, TEST_NODE_VERSION: '22.11.0', ASIDE_DAEMON_HOME: join(dir, 'daemon') }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('detected v22.11.0');
      expect(result.stderr).toContain(process.execPath);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(dir, 'daemon'))).toBe(false);
    }));

    it.each(['22.12.0', '24.0.0'])('loads the runtime at a supported reported version %s', version => fixture((dir, preload) => {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(dir, 'main.js'), readFileSync(launcher));
      writeFileSync(join(dir, 'runtime.js'), "console.log('runtime loaded');");
      expect(execFileSync(process.execPath, ['--import', preload, join(dir, 'main.js')], {
        env: { ...process.env, TEST_NODE_VERSION: version }, encoding: 'utf8',
      })).toContain('runtime loaded');
    }));
  });
});
