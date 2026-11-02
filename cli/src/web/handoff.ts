// A one-use authorization code is delivered in a private file, never in the
// browser URL or the process arguments visible to another local account.
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WEB_HANDOFF_LIFETIME_MS = 2 * 60 * 1000;
export interface WebHandoff { url: string; cleanup(): Promise<void> }

export async function createWebHandoff(stateDir: string, origin: string, code: string): Promise<WebHandoff> {
  const target = new URL(origin);
  if (target.protocol !== 'http:' || target.hostname !== 'localhost' || target.origin !== origin ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(code)) throw new Error('Invalid Aside browser authorization handoff.');
  const web = path.join(stateDir, 'web');
  const dir = path.join(web, 'handoffs');
  for (const directory of [stateDir, web, dir]) {
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error('Aside web state must be a private directory owned by the current user.');
    }
  }
  const file = path.join(dir, `${randomBytes(24).toString('base64url')}.html`);
  const nonce = randomBytes(24).toString('base64url');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; form-action ${origin}; base-uri 'none'"><title>Opening Aside</title></head><body><p>Opening Aside…</p><form method="post" action="${origin}/-/auth/complete"><input type="hidden" name="code" value="${code}"></form><script nonce="${nonce}">document.forms[0].submit();</script></body></html>`;
  await fs.writeFile(file, html, { mode: 0o600, flag: 'wx' });
  const timer = setTimeout(() => { void fs.unlink(file).catch(() => {}); }, WEB_HANDOFF_LIFETIME_MS);
  timer.unref();
  return {
    url: pathToFileURL(file).href,
    async cleanup() {
      clearTimeout(timer);
      try { await fs.unlink(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    },
  };
}
