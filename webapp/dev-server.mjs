// Development uses the same daemon backend and routes as the released app.
// Rebuild the shell on edits and print its URL through the shared daemon.
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildOptions, iframeClientBuildOptions, webappDir } from './build-config.mjs';

const bundle = path.resolve(webappDir, '../cli/dist/main.js');
if (!existsSync(bundle)) throw new Error('Build cli/ with npm run build before starting the webapp development server.');
const ctx = await esbuild.context(buildOptions);
const iframeClient = await esbuild.context(iframeClientBuildOptions);
await ctx.rebuild();
await iframeClient.rebuild();
await ctx.watch();
await iframeClient.watch();
const child = spawn(process.execPath, [bundle, 'show', '--url', ...process.argv.slice(2), '--app-dir', webappDir], { stdio: 'inherit' });
let stopping = false;
child.on('exit', async code => {
  if (stopping || code === 0) return;
  await ctx.dispose();
  await iframeClient.dispose();
  process.exit(code ?? 1);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  stopping = true;
  child.kill(signal);
  await ctx.dispose();
  await iframeClient.dispose();
  process.exit(0);
});
