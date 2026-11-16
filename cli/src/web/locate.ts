// One loopback listener serves every instance.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsideWebServer, type WebBackend } from './server.js';

const WEB_PORT = 24800;
export async function startWeb(appDir: string, backend: WebBackend, port = WEB_PORT): Promise<AsideWebServer> {
  const server = await AsideWebServer.start(appDir, backend, port);
  if (!server) throw new Error(`Aside's browser port ${port} is already in use. Close the process using it and retry.`);
  return server;
}

// The webapp shell to serve: the sibling webapp/ checkout — resolved relative
// to this module, which lives at cli/dist (bundled) or cli/src/web (tests) —
// or an explicit --app-dir override.
export function resolveAppDir(override?: string): string {
  const candidates = override
    ? [path.resolve(override)]
    : ['../../webapp', '../../../webapp'].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
  const appDir = candidates.find((dir) => existsSync(path.join(dir, 'index.html')));
  if (!appDir) {
    throw new Error(`Webapp not found${override ? ` at ${candidates[0]}` : ''} — pass --app-dir <path> pointing at the webapp checkout.`);
  }
  if (!existsSync(path.join(appDir, 'dist/app.js'))) {
    throw new Error(`Webapp bundle not built: ${path.join(appDir, 'dist/app.js')} is missing. Run \`npm run build\` in webapp/.`);
  }
  return appDir;
}

// Open the user's default browser at a URL. False when it can't be opened
// (headless session) — the caller shares the URL instead.
export async function openBrowser(url: string): Promise<boolean> {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]] :
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    ['xdg-open', [url]];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
  });
}
