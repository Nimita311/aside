import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const webappDir = path.dirname(fileURLToPath(import.meta.url));

export async function entryOutputPaths(options, metafile) {
  const workingDir = options.absWorkingDir ?? process.cwd();
  const inputs = Array.isArray(options.entryPoints)
    ? options.entryPoints.map(entry => typeof entry === 'string' ? entry : entry.in)
    : Object.values(options.entryPoints ?? {});
  const entryInputs = new Set(inputs.map(input => path.resolve(workingDir, input)));
  // esbuild resolves source symlinks unless preserveSymlinks is enabled.
  await Promise.all([...entryInputs].map(async input => {
    try { entryInputs.add(await realpath(input)); } catch { /* Plugin entry points may not be files. */ }
  }));
  return new Set(Object.entries(metafile.outputs)
    // Lazy chunks also have entryPoint metadata, but are not configured entries.
    .filter(([, output]) => output.entryPoint && entryInputs.has(path.resolve(workingDir, output.entryPoint)))
    .map(([output]) => path.resolve(workingDir, output)));
}

async function publish(file) {
  // A tab may fetch an existing chunk during a rebuild. Replace each file
  // atomically so that request always receives a complete old or new module.
  const temporary = path.join(path.dirname(file.path), `.${path.basename(file.path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, file.contents, { flag: 'wx' });
    await rename(temporary, file.path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// esbuild removes outdated chunks during context rebuilds. Write its outputs
// ourselves so open tabs can still load their earlier diagram modules.
const preserveChunks = {
  name: 'preserve-chunks',
  setup(build) {
    build.onEnd(async result => {
      if (result.errors.length) return;
      const files = result.outputFiles ?? [];
      const entryPaths = await entryOutputPaths(build.initialOptions, result.metafile);
      const directories = new Set(files.map(file => path.dirname(file.path)));
      await Promise.all([...directories].map(directory => mkdir(directory, { recursive: true })));
      const entries = files.filter(file => entryPaths.has(file.path));
      await Promise.all(files.filter(file => !entries.includes(file)).map(publish));
      // Publish entries after every chunk they reference is available.
      await Promise.all(entries.map(publish));
    });
  },
};

// Production and watch builds must agree on module paths.
export const buildOptions = {
  entryPoints: { app: 'src/app.ts', style: 'style.css', 'static-data': 'lib/static-store.ts' },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  splitting: true,
  outdir: 'dist',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  write: false,
  metafile: true,
  plugins: [preserveChunks],
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: webappDir,
};

// Artifact pages load the SDK through a classic script in their opaque origin.
export const iframeClientBuildOptions = {
  ...buildOptions, entryPoints: { 'iframe-client': 'src/iframe-client.ts' }, format: 'iife', splitting: false,
};
