import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

// Exercise the real application closure without starting connections or
// exposing private state in the shipped entry point.
export async function loadApp<T>(exports: string): Promise<T> {
  const path = resolve('src/app.ts');
  const source = readFileSync(path, 'utf8').replace("document.addEventListener('DOMContentLoaded', init);", '');
  const bundled = await build({
    stdin: { contents: `${source}\nexport { ${exports} };`, resolveDir: dirname(path), loader: 'ts' },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'TestApp', write: false,
    // These application fixtures do not render Mermaid; retain its lazy
    // boundary instead of bundling the runtime into each fixture.
    external: ['mermaid'],
  });
  return new Function(`${bundled.outputFiles[0].text}\nreturn TestApp;`)();
}
