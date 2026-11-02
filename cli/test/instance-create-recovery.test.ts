import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';

const callbacks = vi.hoisted(() => new Map<string, (args: any) => Promise<any>>());
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {
  registerTool(name: string, _config: unknown, callback: (args: any) => Promise<any>) { callbacks.set(name, callback); }
  async connect() {}
} }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
import { startServer, type Backend } from '../src/mcp/server.js';

const dirs: string[] = [];
const listeners: (() => void)[] = [];
afterEach(() => {
  callbacks.clear();
  for (const listener of listeners.splice(0)) process.stdin.removeListener('end', listener);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('instance creation recovery', () => {
  it.each([false, true])('reports saved files and preserves active selection after daemon failure (active=%s)', async active => {
    const root = mkdtempSync('/tmp/aside-create-recovery-'); dirs.push(root);
    const previous = active ? join(root, 'previous') : null;
    if (previous) init(previous, { name: 'Previous', description: 'Previous destination' });
    let fail = true;
    const backend: Backend = {
      knownInstances: async () => previous ? [previous] : [],
      issues: async path => { if ((!previous || realpathSync(path) !== realpathSync(previous)) && fail) throw new Error('Daemon connection failed'); return []; },
      tool: async () => '', show: async () => { throw new Error('Unused'); }, close() {},
    };
    const oldListeners = new Set(process.stdin.listeners('end'));
    await startServer(previous, previous ? [previous] : [], [], false, backend, { graphql: false });
    for (const listener of process.stdin.listeners('end')) if (!oldListeners.has(listener)) listeners.push(listener as () => void);
    const path = join(root, 'new-instance');
    const result = await callbacks.get('create_instance')!({ path, name: 'New', description: 'New destination' });
    const text = result.content[0].text;
    expect(result.isError).toBe(true);
    expect(text).toContain('Created:');
    expect(text).toContain('unconfirmed');
    expect(text).toContain('Daemon connection failed');
    expect(text).toContain('select_instance');
    expect(text).toContain(path);
    expect(text).not.toContain('Cannot create instance');
    expect(text).not.toContain('Created and activated');
    expect(existsSync(join(path, 'aside.md'))).toBe(true);
    const listing = (await callbacks.get('list_instances')!({})).content[0].text;
    expect(listing.startsWith(previous ? 'Active: Previous' : 'No active aside instance')).toBe(true);
    fail = false;
    const selected = await callbacks.get('select_instance')!({ path });
    expect(selected.content[0].text).toContain('Active: New');
    expect(selected.content[0].text).toContain(path);
    expect((await callbacks.get('list_instances')!({})).content[0].text.startsWith('Active: New')).toBe(true);
  });
});
