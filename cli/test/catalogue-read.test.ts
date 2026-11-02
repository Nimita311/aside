import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableInstances } from '../src/web/catalogue.js';
import { WebAuth } from '../src/web/auth.js';
import { startWeb } from '../src/web/locate.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';

const permissionTests = process.platform !== 'win32' && process.getuid?.() !== 0;
const cleanup: Array<() => void> = [], app = fileURLToPath(new URL('../../webapp', import.meta.url));
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));
function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/aside-catalogue-read-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b');
  for (const path of [a, b]) { mkdirSync(path); writeFileSync(join(path, 'aside.md'), `---\nid: ${path === a ? 'one' : 'two'}\nname: ${path === a ? 'One' : 'Two'}\n---\n`); }
  return { root, a, b };
}

describe('registered metadata read failures', () => {
  it.skipIf(!permissionTests)('hides unreadable browser and MCP candidates and exposes repaired manifests again', async () => {
    const f = fixture(), alias = join(f.root, 'alias'); symlinkSync(f.b, alias);
    const registry = new InstanceRegistry([f.a]);
    chmodSync(join(f.a, 'aside.md'), 0); chmodSync(join(f.b, 'aside.md'), 0);
    try {
      expect(availableInstances([f.a, alias, f.b])).toEqual([]);
      expect(registry.catalogue([alias, f.b])).toEqual([]);
    } finally { chmodSync(join(f.a, 'aside.md'), 0o600); chmodSync(join(f.b, 'aside.md'), 0o600); }
    expect(availableInstances([f.a, f.b])).toEqual([
      expect.objectContaining({ id: 'one', address: 'one', name: 'One', path: f.a }),
      expect.objectContaining({ id: 'two', address: 'two', name: 'Two', path: f.b }),
    ]);
    registry.activate(f.a);
    rmSync(join(f.b, 'aside.md')); expect(availableInstances([f.a, f.b])).toHaveLength(1); expect(registry.catalogue([f.b])).toHaveLength(1);
  });

  it.skipIf(!permissionTests)('reports an inaccessible parent without throwing during canonical-path resolution', () => {
    const f = fixture(), parent = join(f.root, 'parent'), registered = join(parent, 'registered');
    mkdirSync(registered, { recursive: true }); writeFileSync(join(registered, 'aside.md'), '---\nid: locked\n---\n'); chmodSync(parent, 0);
    try {
      expect(() => realpathSync(registered)).toThrow(/EACCES/);
      expect(availableInstances([registered])).toEqual([]);
    } finally { chmodSync(parent, 0o700); }
  });

  it('omits unreadable paths while keeping structurally valid invalid-ID entries distinct', () => {
    const f = fixture();
    for (const path of [f.a, f.b]) { rmSync(join(path, 'aside.md')); mkdirSync(join(path, 'aside.md')); }
    expect(availableInstances([f.a, f.b])).toEqual([]);
    for (const path of [f.a, f.b]) { rmSync(join(path, 'aside.md'), { recursive: true }); writeFileSync(join(path, 'aside.md'), '---\nid: INVALID\n---\n'); }
    for (const row of availableInstances([f.a, f.b])) { expect(row.error).toContain('valid instance id'); expect(row.error).not.toContain('Duplicate'); }
  });

  it('omits unconfirmed rows over HTTP and rejects their routes while preserving duplicate-ID reporting', async () => {
    const f = fixture(), auth = new WebAuth(join(f.root, "auth")), headers = { Authorization: `Bearer ${auth.issue().token}` }, load = vi.fn(), server = await startWeb(app, { instances: () => availableInstances([f.a, f.b]), register: async () => null, remove: () => {}, load, data: async () => { throw new Error("Unexpected data request"); } }, 0, { auth, stateDirectory: join(f.root, "auth") });
    cleanup.push(() => server.close()); rmSync(join(f.b, 'aside.md')); mkdirSync(join(f.b, 'aside.md'));
    const rows = await (await fetch(`http://127.0.0.1:${server.port}/-/api/instances`, { headers })).json();
    expect(rows).toEqual([
      expect.objectContaining({ id: 'one', address: 'one', name: 'One', path: f.a }),
    ]);
    expect(load).not.toHaveBeenCalled(); expect(() => server.routeFor(f.b, '')).toThrow(/not registered/);
    expect(server.routeFor(f.a, '')).toBe('one/'); expect(load).not.toHaveBeenCalled();
    rmSync(join(f.b, 'aside.md'), { recursive: true }); writeFileSync(join(f.b, 'aside.md'), '---\nid: one\nname: Two\n---\n');
    const duplicates = availableInstances([f.a, f.b]);
    for (const row of duplicates) {
      expect(row.error).toBeUndefined(); expect(row.calendarWarning).toContain('Duplicate instance ID');
      expect(row.calendarWarning).toContain(f.a); expect(row.calendarWarning).toContain(f.b);
      expect(server.routeFor(row.path, '')).toBe(`${row.address}/`);
    }
    const response = await fetch(`http://127.0.0.1:${server.port}/-/api/instances/one`, { headers });
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: expect.stringContaining('unavailable') });
    expect(load).not.toHaveBeenCalled();
  });
});
