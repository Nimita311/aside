// The daemon has one stable browser origin for every instance.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsideWebServer, type WebBackend, type WebServerOptions } from './server.js';

const WEB_PORT = 24800;
export async function startWeb(appDir: string, backend: WebBackend, port = WEB_PORT, options: WebServerOptions): Promise<AsideWebServer> {
  const server = await AsideWebServer.start(appDir, backend, port, options);
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
  let browser: string | null = null;
  if (process.platform === 'darwin' && url.startsWith('file:')) {
    // A private HTML handoff must use the HTTP browser, even when .html files
    // are associated with an editor. AppKit reads Launch Services without
    // asking the browser for automation permission.
    const script = `ObjC.import('AppKit'); ObjC.unwrap($.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('http://localhost')).path)`;
    browser = await new Promise<string | null>(resolve => {
      execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000, maxBuffer: 16 * 1024 }, (error, stdout) => {
        const application = stdout?.trim();
        resolve(!error && application && path.isAbsolute(application) && application.endsWith('.app') ? application : null);
      });
    });
    if (!browser) return false;
  }
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [...(browser ? ['-a', browser] : []), url]] :
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    ['xdg-open', [url]];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
  });
}
