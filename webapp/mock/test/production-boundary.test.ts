import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('mock development boundary', () => {
  it('keeps the scenario catalogue, data fixtures, and mock bootstrap out of production app and SDK bundles', async () => {
    const result = await build({
      absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
      entryPoints: ['src/app.ts', 'src/iframe-client.ts'],
      bundle: true, platform: 'browser', format: 'esm', outdir: 'dist',
      write: false, metafile: true, logLevel: 'silent',
    });
    expect(Object.keys(result.metafile!.inputs).filter(path => /(^|\/)mock\//.test(path))).toEqual([]);
    for (const output of result.outputFiles) {
      expect(output.text).not.toContain('X-Aside-Mock-Session');
      expect(output.text).not.toContain('mockSession');
      expect(output.text).not.toContain('/__mock/');
    }
  });
});
