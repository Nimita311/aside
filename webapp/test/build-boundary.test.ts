import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('browser data boundary', () => {
  it('builds the iframe SDK as a standalone classic script', async () => {
    const result = await build({ entryPoints:['src/iframe-client.ts'],bundle:true,platform:'browser',format:'iife',write:false,metafile:true,logLevel:'silent' });
    expect(result.outputFiles[0].text).not.toMatch(/^import\s/m);
    expect(Object.keys(result.metafile!.inputs).some(path=>path.includes('/graphql/') || path.endsWith('/data-core.ts'))).toBe(false);
  });
  it('bundles the daemon UI without the data core or record parser', async () => {
    const result = await build({ entryPoints: ['src/app.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some(path => path.endsWith('/data-core.ts'))).toBe(false);
    expect(inputs.some(path => path.endsWith('/parser.ts') || path.includes('/node_modules/yaml/'))).toBe(false);
  });
  it('bundles the optional static adapter and core for the browser without Node APIs', async () => {
    const result = await build({ entryPoints: ['lib/static-store.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
    expect(Object.keys(result.metafile!.inputs).some(path => path.endsWith('/data-core.ts'))).toBe(true);
  });
});
