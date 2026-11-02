import { afterAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebHandoff, WEB_HANDOFF_LIFETIME_MS } from '../src/web/handoff.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'aside-web-handoff-'));
  roots.push(dir);
  return dir;
}
afterAll(async () => { await Promise.all(roots.map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe('automatic private-file browser handoff', () => {
  const code = 'a'.repeat(43);
  const origin = 'http://localhost:24800';

  it('keeps the one-use code out of the launch URL and posts only to localhost', async () => {
    const state = await root();
    const handoff = await createWebHandoff(state, origin, code);
    try {
      const url = new URL(handoff.url);
      const file = fileURLToPath(url);
      expect(url.protocol).toBe('file:');
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      expect(handoff.url).not.toContain(code);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      const html = await fs.readFile(file, 'utf8');
      expect(html).toContain(`method="post" action="${origin}/-/auth/complete"`);
      expect(html).toContain(`name="code" value="${code}"`);
      expect(html).toContain('document.forms[0].submit();');
      expect(html).toContain("default-src 'none'");
      expect(html).toContain(`form-action ${origin}`);
      expect(html).toContain('content="no-referrer"');
      const nonce = html.match(/script nonce="([^"]+)"/)![1];
      expect(html).toContain(`script-src 'nonce-${nonce}'`);
      expect(WEB_HANDOFF_LIFETIME_MS).toBe(120_000);
    } finally { await handoff.cleanup(); }
    await expect(fs.access(fileURLToPath(handoff.url))).rejects.toMatchObject({ code: 'ENOENT' });
    await handoff.cleanup();
  });

  it('uses unrelated random filenames for separate shows', async () => {
    const state = await root();
    const first = await createWebHandoff(state, origin, code);
    const second = await createWebHandoff(state, origin, code);
    try { expect(first.url).not.toBe(second.url); }
    finally { await first.cleanup(); await second.cleanup(); }
  });

  it('rejects remote, non-HTTP, and injected targets or codes before writing', async () => {
    const state = await root();
    for (const target of ['https://localhost:24800', 'http://example.com', `${origin}/`, `${origin}/?x=1`, `${origin}#token`, 'http://user:pass@localhost:24800', 'http://127.0.0.1:24800']) {
      await expect(createWebHandoff(state, target, code)).rejects.toThrow('Invalid Aside');
    }
    await expect(createWebHandoff(state, origin, '"><script>alert(1)</script>')).rejects.toThrow('Invalid Aside');
    expect(await fs.readdir(state)).toEqual([]);
  });

  it.each(['state', 'web', 'handoffs'])('rejects other-user-readable %s directories before writing a handoff', async location => {
    const state = await root();
    const directory = location === 'state' ? state : path.join(state, 'web', ...(location === 'handoffs' ? ['handoffs'] : []));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o755);
    await expect(createWebHandoff(state, origin, code)).rejects.toThrow('private directory');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('rejects a handoff directory redirected outside private state', async () => {
    const state = await root();
    await fs.mkdir(path.join(state, 'web'), { mode: 0o700 });
    await fs.symlink(await root(), path.join(state, 'web/handoffs'));
    await expect(createWebHandoff(state, origin, code)).rejects.toThrow('private directory');
  });
});
