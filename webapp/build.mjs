import { build } from 'esbuild';
import { buildOptions, iframeClientBuildOptions } from './build-config.mjs';

await build({ ...buildOptions, minify: true });
await build({ ...iframeClientBuildOptions, minify: true });
