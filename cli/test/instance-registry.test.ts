import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';

describe('InstanceRegistry', () => {
  let root: string, a: string, b: string, c: string, elsewhere: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync('/tmp/aside-registry-'));
    [a, b, c, elsewhere] = ['a', 'b', 'c', 'elsewhere'].map(name => {
      const path = join(root, name); mkdirSync(path); writeFileSync(join(path, 'aside.md'), `---\nid: ${name}\n---\n`); return path;
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('seeds from discovered instances with none active', () => {
    const r = new InstanceRegistry([a, b]);
    expect(r.activeInstance).toBeNull();
    expect(r.all()).toEqual([a, b]);
    expect(r.others()).toEqual([a, b]);
  });

  it('collects deleted, repurposed, and unreadable candidates before every listing and clears invalid selection', () => {
    const r = new InstanceRegistry([a, b, c]); r.activate(b);
    rmSync(b, { recursive: true }); writeFileSync(join(c, 'aside.md'), 'Repurposed directory');
    expect(r.all()).toEqual([a]); expect(r.activeInstance).toBeNull(); expect(r.others()).toEqual([a]);
    expect(r.catalogue([b, c])).toEqual([{ path: a, workspace: true, active: false }]);
    rmSync(join(a, 'aside.md')); mkdirSync(join(a, 'aside.md'));
    expect(r.all()).toEqual([]); expect(r.catalogue([a])).toEqual([]);
  });

  it('starts empty with no discovery', () => {
    const r = new InstanceRegistry();
    expect(r.activeInstance).toBeNull();
    expect(r.all()).toEqual([]);
  });

  it('activating a discovered instance makes it active without duplicating it', () => {
    const r = new InstanceRegistry([a, b]);
    r.activate(a);
    expect(r.activeInstance).toBe(a);
    expect(r.all()).toEqual([a, b]);
    expect(r.others()).toEqual([b]);
  });

  it('tracks an instance encountered via --dir/pointer that was not discovered', () => {
    const r = new InstanceRegistry([a]);
    r.activate(elsewhere); // e.g. --dir outside the scanned tree
    expect(r.activeInstance).toBe(elsewhere);
    expect(r.all()).toEqual([a, elsewhere]);
    expect(r.others()).toEqual([a]);
  });

  it('accumulates every instance selected via select_instance across the session', () => {
    const r = new InstanceRegistry([a, b]);
    r.activate(a); // startup
    r.activate(c); // select_instance to a fresh instance
    r.activate(b); // select_instance to a discovered instance
    expect(r.activeInstance).toBe(b);
    expect(r.all()).toEqual([a, b, c]);
    expect(r.others()).toEqual([a, c]);
  });

  it('switching back to a previously active instance keeps the set stable', () => {
    const r = new InstanceRegistry();
    r.activate(a);
    r.activate(b);
    r.activate(a);
    expect(r.activeInstance).toBe(a);
    expect(r.all()).toEqual([a, b]);
    expect(r.others()).toEqual([b]);
  });
});
