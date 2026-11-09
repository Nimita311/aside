import nodeVersion from './node-version.cjs';

nodeVersion.assertSupportedNode();
const { build, context } = await import('esbuild');
const { join } = await import('node:path');
const { execFileSync } = await import('node:child_process');
const { mkdirSync, existsSync, statSync, readdirSync, copyFileSync, writeFileSync } = await import('node:fs');
// Rebuild only for native changes: changing an ad-hoc signed binary can require
// Calendar access to be granted again, so TypeScript-only builds leave it alone.
if (process.platform === 'darwin') {
  const binary = 'dist/aside-native';
  const inputs = ['native/build.sh', ...readdirSync('native/aside-native')
    .filter(file => /\.(swift|plist)$/.test(file)).map(file => join('native/aside-native', file))];
  if (!existsSync(binary) || inputs.some(file => statSync(file).mtimeMs > statSync(binary).mtimeMs)) {
    execFileSync('bash', ['native/build.sh'], { stdio: 'inherit' });
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
  // Resolve the optional native search engine only when a semantic request
  // imports it. Its JS and platform binary are packaged below as a sidecar.
  external: ['@lancedb/lancedb'],
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

// Package LanceDB's JS dependencies into one CommonJS module. Only its native
// binary remains separate; the installed CLI needs no development node_modules
// tree, Python runtime, embedding providers, or external database service.
const lanceDir = 'dist/node_modules/@lancedb/lancedb';
mkdirSync(lanceDir, { recursive: true });
const lanceVersion = JSON.parse(await (await import('node:fs/promises')).readFile('node_modules/@lancedb/lancedb/package.json', 'utf8')).version;
writeFileSync(join(lanceDir, 'package.json'), JSON.stringify({ name: '@lancedb/lancedb', version: lanceVersion, main: 'index.cjs' }));
const nativePackages = readdirSync('node_modules/@lancedb').filter(name => name.startsWith(`lancedb-${process.platform}-${process.arch}`));
let nativeCount = 0;
for (const name of nativePackages) for (const file of readdirSync(join('node_modules/@lancedb', name))) if (file.endsWith('.node')) {
  copyFileSync(join('node_modules/@lancedb', name, file), join(lanceDir, file)); nativeCount++;
}
// Search is optional. In particular, current LanceDB releases omit macOS Intel
// binaries; building the ordinary CLI must still work on that supported host.
if (!nativeCount) console.warn(`Semantic search unavailable: no LanceDB native binary for ${process.platform}/${process.arch}. Regex and other Aside features remain available.`);
for (const file of ['license_header.txt', 'NODEJS_THIRD_PARTY_LICENSES.md', 'RUST_THIRD_PARTY_LICENSES.html']) {
  copyFileSync(join('node_modules/@lancedb/lancedb', file), join(lanceDir, file));
}
const lanceSidecar = {
  entryPoints: ['node_modules/@lancedb/lancedb/dist/index.js'], bundle: true,
  platform: 'node', format: 'cjs', target: 'node22.12', outfile: join(lanceDir, 'index.cjs'),
  external: ['*.node', '@lancedb/lancedb-*', '@huggingface/transformers', 'openai'],
  minify: true, logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const contexts = await Promise.all([context(options), context(launcher), context(worker), context(automationWorker), context(lanceSidecar)]);
  await Promise.all(contexts.map(ctx => ctx.watch()));
  console.log('esbuild: watching for changes…');
} else {
  await build(options);
  await build(launcher);
  await build(worker);
  await build(automationWorker);
  await build(lanceSidecar);
}
