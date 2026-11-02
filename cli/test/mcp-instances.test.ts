import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer, type Backend } from '../src/mcp/server.js';
import { resolveDataDir } from '../src/commands/mcp.js';
const handlers = vi.hoisted(() => new Map<string, (args?: any) => Promise<any>>());
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class { registerTool(name: string, _definition: unknown, handler: any) { handlers.set(name, handler); } async connect() {} } }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); handlers.clear(); });
function instance(name: string, id = name) { const d = realpathSync(mkdtempSync('/tmp/aside-list-')); dirs.push(d); writeFileSync(join(d,'aside.md'),`---\nid: ${id}\nname: ${name}\n---\n`); return d; }
function backend(known: () => string[]): Backend { return { knownInstances: vi.fn(async () => known()), issues: vi.fn(async () => []), tool: vi.fn(async (path) => String(path)), show: vi.fn(), close: vi.fn() }; }
const result = async (name: string, args?: any) => (await handlers.get(name)!(args)).content[0].text as string;
describe('MCP merged instance listing', () => {
  it('surfaces unreadable workspace configuration in listings and selection receipts without changing fallback rules', async () => {
    const local = instance('Local');
    mkdirSync(join(local, '.aside'));
    const resolution = resolveDataDir(local, []);
    expect(resolution.dataDir).toBe(local);
    expect(resolution.discovery).toBe(true);
    expect(resolution.configIssues[0]).toMatchObject({ code: 'read_error', file: '.aside' });
    const b = backend(() => []);
    await startServer(resolution.dataDir, resolution.candidates, resolution.configIssues, resolution.discovery, b, { graphql: false });
    for (const text of [await result('list_instances'), await result('select_instance', { path: local })]) {
      expect(text).toContain('from the .aside config');
      expect(text).toContain('Could not read .aside');
      expect(text).toContain('Configuration was not applied');
      expect(text).toContain('restart this agent session');
    }
    expect(await result('query_projects', {})).toBe(local);
  });
  it('fetches the daemon catalog with no active instance and keeps global instances unselected', async () => {
    const other = instance('other'); let known = [other]; const b = backend(() => known); await startServer(null, [], [], false, b, { graphql: false });
    const text = await result('list_instances'); expect(text).toContain('No active aside instance'); expect(text).toContain('In this workspace:\n  none'); expect(text).toContain(`Other known instances:\n  other  (${other})`); expect(b.issues).not.toHaveBeenCalled();
    const added = instance('added'); known.push(added); expect(await result('list_instances')).toContain(added); expect(b.knownInstances).toHaveBeenCalledTimes(2);
  });
  it('deduplicates symlinks by path and preserves distinct directories with duplicate IDs', async () => {
    const local = instance('Local', 'work'), other = instance('Other', 'work'); const alias = join(other,'alias'); symlinkSync(local, alias);
    const b = backend(() => [alias, local, other]); await startServer(local, [local, alias], [], true, b, { graphql: false });
    const text = await result('list_instances'); expect(text).not.toContain(alias); expect(text).toContain(`[active] Local  (${local})`); expect(text).toContain(`Other  (${other})`); expect(text).toContain('Duplicate instance ID detected: work');
  });
  it('does not report expected worktree copies as duplicate IDs', async () => {
    const primary = instance('Primary', 'work'), linked = `${primary}-linked`;
    dirs.push(linked);
    const git = (...args: string[]) => execFileSync('git', ['-C', primary, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'pipe' });
    git('init', '-b', 'main'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--no-gpg-sign', '-m', 'fixture');
    git('worktree', 'add', '--detach', linked);
    await startServer(linked, [linked], [], true, backend(() => [primary, linked]), { graphql: false });
    const text = await result('list_instances');
    expect(text).toContain(primary); expect(text).toContain(linked);
    expect(text).not.toContain('Duplicate instance ID');
  });
  it('selection is independent of source membership and catalog changes', async () => {
    const local = instance('Local'), other = instance('Other'); let known = [local, other]; const b = backend(() => known); await startServer(local, [local], [], true, b, { graphql: false });
    await result('select_instance', {path: other}); let text = await result('list_instances'); expect(text).toContain(`In this workspace:\n  Local  (${local})`); expect(text).toContain(`Other known instances:\n  [active] Other  (${other})`);
    known = []; text = await result('list_instances'); expect(text).toContain(`Active: Other  (${other})`); expect(await result('query_projects', {})).toBe(other);
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('omits unreadable registrations and preserves repair guidance on attempted selection', async () => {
    const workspace = instance('Workspace', 'work'), other = instance('Other', 'work'), alias = join(workspace, 'alias'); symlinkSync(other, alias);
    const b = backend(() => [workspace, alias, other]); await startServer(null, [workspace], [], true, b, { graphql: false });
    chmodSync(join(workspace, 'aside.md'), 0); chmodSync(join(other, 'aside.md'), 0);
    try {
      const text = await result('list_instances');
      expect(text).toContain('In this workspace:\n  none'); expect(text).toContain('Other known instances:\n  none');
      expect(text).not.toContain(workspace); expect(text).not.toContain(other); expect(text).not.toContain(alias);
      expect(text).not.toContain('Duplicate instance ID');
      expect(b.issues).not.toHaveBeenCalled(); expect(b.tool).not.toHaveBeenCalled();
      await expect(result('select_instance', { path: other })).rejects.toThrow(/EACCES.*preserving its existing id/);
      expect(await result('list_instances')).toContain('No active aside instance'); expect(b.issues).not.toHaveBeenCalled();
    } finally { chmodSync(join(workspace, 'aside.md'), 0o600); chmodSync(join(other, 'aside.md'), 0o600); }
    const repaired = await result('list_instances'); expect(repaired).toContain('Duplicate instance ID detected: work'); expect(repaired).not.toContain('EACCES');
  });
  it('clears an active unreadable instance without another backend load', async () => {
    const active = instance('Active', 'work'), b = backend(() => [active]); await startServer(active, [active], [], true, b, { graphql: false });
    vi.mocked(b.issues).mockClear(); vi.mocked(b.issues).mockRejectedValue(new Error('Unexpected record load'));
    rmSync(join(active, 'aside.md')); mkdirSync(join(active, 'aside.md'));
    const text = await result('list_instances'); expect(text).toContain('No active aside instance');
    expect(text).not.toContain(active); expect(b.issues).not.toHaveBeenCalled();
  });
  it('does not diagnose invalid IDs as duplicate valid identities', async () => {
    const a = instance('One', 'INVALID'), b = instance('Two', 'INVALID'); await startServer(null, [], [], true, backend(() => [a, b]), { graphql: false });
    const text = await result('list_instances'); expect(text).toContain(a); expect(text).toContain(b); expect(text).not.toContain('Duplicate instance ID');
  });
});
