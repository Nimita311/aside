import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import {lifecycleOperationsFixture} from './lifecycle-operations-fixture.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession, type InstanceBackend} from '../src/mcp/instance-session.js';
import {formatInstanceEntry} from '../src/core/text.js';
import {readInstanceRecordResult} from '../src/core/instance.js';
import type {InstanceRecord, ParseResult} from '../src/core/types.js';
import {InstanceOperationError} from '../src/core/instance-operation-error.js';

const directories: string[] = [];
afterEach(() => {
  access.reset(); vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, {recursive: true, force: true});
});

function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-session-state-')); directories.push(home);
  const root = join(home, 'selected'); mkdirSync(root);
  writeFileSync(join(root, 'aside.md'), '---\nid: selected\nname: Unobserved name\n---\nDisk instructions.\n');
  const record: ParseResult<InstanceRecord> = {value: {manifest: {id: 'selected', name: 'Published name'}, body: 'Published instructions.'}, issues: []};
  const registry = new InstanceRegistry([root]); registry.activate(root);
  return {home, root, record, registry};
}

describe('instance session lifecycle metadata', () => {
  it('reads active and listing metadata through the supplied snapshot while disk is ahead', async () => {
    const f = fixture(), read = () => f.record;
    const session = new InstanceSession(f.registry, lifecycleOperationsFixture({knownInstances: async () => [f.root], issues: async () => []}));
    access.protect([f.root]);
    expect(await session.activeInstance(read)).toMatchObject({id: 'selected', name: 'Published name'});
    expect(await session.instances(read)).toEqual([expect.objectContaining({name: 'Published name'})]);
    f.registry.restore({...f.registry.selection(), active: null});
    expect(() => session.requireInstance()).toThrow(f.root);
    expect(access.violations).toEqual([]);
  });

  it('uses owner admission and creation results without validating or rereading source itself', async () => {
    const f = fixture(), destination = join(f.home, 'new');
    const admitInstance = vi.fn(async (path: string) => ({path, record: f.record, issues: []}));
    const createInstance = vi.fn(async ({path}: {path: string}) => ({path, record: f.record, issues: [], admitted: true, changes: []}));
    const session = new InstanceSession(f.registry, {knownInstances: async () => [f.root], issues: async () => [],
      instanceRecord: async () => f.record, admitInstance, createInstance});
    access.protect([f.root, destination]);
    expect((await session.selectInstance(f.root)).instance.name).toBe('Published name');
    expect((await session.createInstance({path: destination, name: 'New', description: 'New'})).instance.name).toBe('Published name');
    expect(admitInstance).toHaveBeenCalledWith(f.root);
    expect(createInstance).toHaveBeenCalledWith({path: destination, name: 'New', description: 'New'});
    expect(existsSync(destination)).toBe(false); expect(access.violations).toEqual([]);
  });

  it('adds recovery guidance to neutral owner errors without reading source', async () => {
    const f = fixture();
    const session = new InstanceSession(f.registry, {knownInstances: async () => [f.root], issues: async () => [],
      instanceRecord: async () => f.record,
      admitInstance: async () => {throw new InstanceOperationError('NOT_INSTANCE', 'Not an aside instance');},
      createInstance: async () => {throw new InstanceOperationError('ALREADY_INSTANCE', 'Already an aside instance');},
    }, [], false);
    access.protect([f.root]);
    await expect(session.selectInstance(f.root)).rejects.toThrow('Use createInstance');
    await expect(session.createInstance({path: f.root, name: 'New', description: 'New'})).rejects.toThrow('Use selectInstance');
    expect(f.registry.activeInstance).toBe(f.root); expect(access.violations).toEqual([]);
  });

  it('preserves selection when the owner cannot supply an admitted instance snapshot', async () => {
    const f = fixture(), selected = join(f.home, 'other'); mkdirSync(selected);
    const manifest = join(selected, 'aside.md'); writeFileSync(manifest, '---\nid: other\n---\n');
    const session = new InstanceSession(f.registry, lifecycleOperationsFixture({knownInstances: async () => [f.root], issues: async () => [], instanceRecord: async () => undefined}));
    access.protect([f.root, selected]);
    await expect(access.allow({paths: [manifest], operations: ['read'], reason: 'Explicit selection admission'}, () =>
      session.selectInstance(selected))).rejects.toThrow('Lifecycle-provided instance metadata is unavailable');
    expect(f.registry.activeInstance).toBe(f.root);
    expect(access.violations).toEqual([]);
  });

  it.each(['owner notification', 'owner metadata'])('retains explicit bootstrap receipts and prior selection when %s fails', async phase => {
    const f = fixture(), destination = join(f.home, 'new');
    const session = new InstanceSession(f.registry, lifecycleOperationsFixture({knownInstances: async () => [f.root], issues: async () => [],
      instanceRecord: async path => path === f.root ? f.record : undefined,
      created: async () => {if (phase === 'owner notification') throw new Error('Owner unavailable'); return [];},
    }));
    const result = await session.createInstance({path: destination, name: 'New instance', description: 'Created before owner failure'});
    expect(result.created).toBe(true); expect(result.activated).toBe(false);
    expect(result.instance.id).not.toBe(''); expect(result.instance.name).toBe('New instance');
    expect(result.error).toContain(phase === 'owner notification' ? 'Owner unavailable' : 'Lifecycle-provided instance metadata is unavailable');
    expect(result.changes).toEqual([expect.objectContaining({kind: 'instance', id: result.instance.id, effect: 'CREATED'})]);
    expect(existsSync(join(destination, 'aside.md'))).toBe(true);
    expect(f.registry.activeInstance).toBe(f.root);
  });

  it('uses owner-admitted metadata after bootstrap rather than rereading a newer disk manifest', async () => {
    const f = fixture(), destination = join(f.home, 'new'), records = new Map([[f.root, f.record]]);
    const session = new InstanceSession(f.registry, lifecycleOperationsFixture({knownInstances: async () => [...records.keys()], issues: async () => [],
      instanceRecord: async (path: string) => records.get(path), created: async (path: string) => {
        records.set(path, readInstanceRecordResult(path));
        writeFileSync(join(path, 'aside.md'), '---\nid: unobserved\nname: Disk ahead\n---\n');
        return [];
      },
    }));
    const result = await session.createInstance({path: destination, name: 'Owner admitted', description: 'Published at admission'});
    expect(result.error).toBeUndefined(); expect(result.activated).toBe(true);
    expect(result.instance.name).toBe('Owner admitted'); expect(result.instance.id).not.toBe('unobserved');
    expect(JSON.stringify(result)).not.toContain('Disk ahead');
  });

  it('formats explicit manifest observations without reading a file', () => {
    const f = fixture(); access.protect([f.root]);
    expect(formatInstanceEntry(f.root, {value: f.record.value.manifest, issues: []})).toContain('Published name');
    expect(access.violations).toEqual([]);
  });
});
