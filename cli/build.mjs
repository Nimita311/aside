import nodeVersion from './node-version.cjs';

nodeVersion.assertSupportedNode();
const { build, context } = await import('esbuild');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { execFileSync } = await import('node:child_process');
const { mkdirSync, existsSync, statSync, mkdtempSync, rmSync } = await import('node:fs');
// Separate wake helper; building it never touches the calendar helper or grant.
if (process.platform === 'darwin') {
  const source = 'native/aside-wake/main.swift', binary = 'dist/aside-wake';
  mkdirSync('dist', { recursive: true });
  if (!existsSync(binary) || Math.max(statSync(source).mtimeMs, statSync('build.mjs').mtimeMs) > statSync(binary).mtimeMs) {
    const cache = mkdtempSync(join(tmpdir(), 'aside-wake-build-'));
    try { execFileSync('swiftc', ['-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-module-cache-path', cache, '-framework', 'AppKit', '-framework', 'Foundation', source, '-o', binary], { stdio: 'inherit' }); }
    finally { rmSync(cache, { recursive: true, force: true }); }
  }
}

// Bundle the application with a dependency-free launcher so `aside` needs no
// node_modules at runtime.
const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.12',
  outfile: 'dist/runtime.js',
  // Embed the init templates into the bundle as strings. They become part of
  // the build output, so init carries them inline and never resolves a path to
  // cli/templates at runtime.
  loader: { '.md': 'text', '.yaml': 'text' },
  // Minify to keep the bundle small.
  minify: true,
  // The build identity the daemon handshake orders builds by (src/version.ts).
  define: { __ASIDE_BUILT_AT__: String(Date.now()) },
  // esbuild already preserves the entry file's shebang. We only need to provide
  // `require` for any CommonJS deps that call it at runtime (esbuild does not
  // inject this for ESM output).
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
};

const launcher = {
  entryPoints: ['src/launcher.js'], bundle: true, platform: 'node', format: 'esm',
  // The guard must parse on older Node releases to print the recovery message.
  target: 'node14', outfile: 'dist/main.js', external: ['./runtime.js'], logLevel: 'info',
};

const worker = {
  entryPoints: ['src/mcp/regex-worker.ts'], bundle: true, platform: 'node', format: 'esm',
  target: 'node22.12', outfile: 'dist/regex-worker.js', minify: true, logLevel: 'info',
};

const automationWorker = { ...worker, entryPoints: ['src/automation/worker.ts'], outfile: 'dist/automation-worker.js',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } };

if (process.argv.includes('--watch')) {
  const contexts = await Promise.all([context(options), context(launcher), context(worker), context(automationWorker)]);
  await Promise.all(contexts.map(ctx => ctx.watch()));
  console.log('esbuild: watching for changes…');
} else {
  await build(options);
  await build(launcher);
  await build(worker);
  await build(automationWorker);
}
