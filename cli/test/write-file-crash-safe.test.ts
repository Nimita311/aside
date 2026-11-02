import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';

describe('crash-safe file permissions', () => {
  let directory: string, fixture: string, caseDirectory: string;

  beforeAll(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'aside-file-permissions-')));
    fixture = join(directory, 'write.cjs');
    // A child process owns each umask, so these cases cannot change permissions
    // used by other tests or by Vitest's worker threads.
    buildSync({
      stdin: {
        contents: `
          import fs from 'node:fs';
          import { join } from 'node:path';
          import { writeFileCrashSafe } from ${JSON.stringify(join(__dirname, '../src/mcp/tools/index-file.ts'))};
          const { directory, mask, mode, failAt } = JSON.parse(process.argv[2]);
          const file = join(directory, 'record.md');
          if (mode !== undefined) {
            fs.writeFileSync(file, 'Original content');
            fs.chmodSync(file, mode);
          }
          process.umask(mask);
          const write = fs.writeFileSync;
          const chmod = fs.fchmodSync;
          let temporaryMode;
          fs.writeFileSync = (target, ...args) => {
            if (typeof target === 'number') {
              temporaryMode = fs.fstatSync(target).mode & 0o777;
              if (failAt === 'write') throw new Error('Injected write failure');
            }
            return write(target, ...args);
          };
          fs.fchmodSync = (...args) => {
            if (failAt === 'chmod') throw new Error('Injected chmod failure');
            return chmod(...args);
          };
          let error;
          try { writeFileCrashSafe(file, 'Replacement content', directory); }
          catch (failure) { error = failure.message; }
          console.log(JSON.stringify({
            mode: fs.statSync(file).mode & 0o777,
            content: fs.readFileSync(file, 'utf8'),
            files: fs.readdirSync(directory),
            temporaryMode,
            error,
          }));
        `,
        resolveDir: __dirname,
        loader: 'js',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: fixture,
    });
  });

  beforeEach(() => { caseDirectory = mkdtempSync(join(directory, 'case-')); });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  function write(options: { mask: number; mode?: number; failAt?: 'write' | 'chmod' }): {
    mode: number; content: string; files: string[]; temporaryMode: number; error?: string;
  } {
    return JSON.parse(execFileSync(process.execPath, [fixture, JSON.stringify({ directory: caseDirectory, ...options })], {
      encoding: 'utf8', timeout: 5000,
    }));
  }

  it.each([
    { mode: 0o600, mask: 0o022 },
    { mode: 0o640, mask: 0o077 },
    { mode: 0o664, mask: 0o077 },
  ])('preserves existing mode $mode with umask $mask', ({ mode, mask }) => {
    const result = write({ mode, mask });
    expect(result.error).toBeUndefined();
    expect(result.mode).toBe(mode);
    expect(result.content).toBe('Replacement content');
    expect(result.files).toEqual(['record.md']);
    expect(result.temporaryMode).toBe(0o600);
  });

  it.each([0o022, 0o077, 0o007])('keeps the existing creation policy for a new file with umask %i', mask => {
    const result = write({ mask });
    expect(result.error).toBeUndefined();
    expect(result.mode).toBe(0o666 & ~mask);
    expect(result.content).toBe('Replacement content');
    expect(result.files).toEqual(['record.md']);
  });

  it.each(['write', 'chmod'] as const)('keeps the original and removes the temporary file when %s fails', failAt => {
    const result = write({ mode: 0o600, mask: 0o022, failAt });
    expect(result.error).toBe(`Injected ${failAt} failure`);
    expect(result.mode).toBe(0o600);
    expect(result.content).toBe('Original content');
    expect(result.files).toEqual(['record.md']);
  });
});
