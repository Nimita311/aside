import nodeVersion from '../node-version.cjs';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

nodeVersion.assertSupportedNode();
const { build } = await import('esbuild');
const cli = fileURLToPath(new URL('..', import.meta.url));
const output = join(cli, '.cache', 'bench');
mkdirSync(output, { recursive: true });
await Promise.all([
  build({ entryPoints: [join(cli, 'bench', 'main.ts')], outfile: join(output, 'queries.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22.12',
    banner: { js: "import { createRequire as benchRequire } from 'node:module'; const require = benchRequire(import.meta.url);" },
  }),
  build({ entryPoints: [join(cli, 'src', 'mcp', 'regex-worker.ts')], outfile: join(output, 'regex-worker.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22.12' }),
]);
const child = spawn(process.execPath, [join(output, 'queries.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', cwd: cli });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
