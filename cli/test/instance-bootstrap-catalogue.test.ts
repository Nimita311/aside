import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceHost} from '../src/daemon/host.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {init} from '../src/source/bootstrap.js';
import {Store} from '../src/source/store.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('bootstrap catalogue publication', () => {
  it('notifies the written root when an admission alias was retargeted', () => {
    const home = mkdtempSync('/private/tmp/aside-bootstrap-alias-');
    const original = join(home, 'original'), target = join(home, 'target'), alias = join(home, 'alias');
    cleanup.push(() => rmSync(home, {recursive: true, force: true}));
    vi.stubEnv('ASIDE_DAEMON_HOME', join(home, 'state'));
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    const host = new InstanceHost(new CalClient(null)); cleanup.push(() => host.close());
    host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
    init(original, {name: 'Original', description: 'Already loaded'});
    symlinkSync(original, alias); host.load(alias);
    rmSync(alias); mkdirSync(target); symlinkSync(target, alias);

    const result = host.bootstrapInstance({path: alias, name: 'New target', description: 'Written through alias'});

    expect(result.dataDir).toBe(alias);
    expect(host.metadata(original).value.manifest.name).toBe('Original');
    expect(host.metadata(target).value.manifest.name).toBe('New target');
    expect(host.isLoaded(target)).toBe(false);
    expect(host.loadedPaths()).toEqual([original]);
  });

  it('replaces stale metadata for a previously loaded unregistered root without loading it again', () => {
    const home = mkdtempSync('/private/tmp/aside-bootstrap-catalogue-'), root = join(home, 'source');
    cleanup.push(() => rmSync(home, {recursive: true, force: true}));
    vi.stubEnv('ASIDE_DAEMON_HOME', join(home, 'state'));
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    const host = new InstanceHost(new CalClient(null)); cleanup.push(() => host.close());
    host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
    init(root, {name: 'Previous', description: 'Old metadata'});
    host.unloadKey(host.load(root).key);
    expect(host.metadata(root).value.manifest.name).toBe('Previous');
    rmSync(root, {recursive: true}); mkdirSync(root);

    const result = host.bootstrapInstance({path: root, name: 'Recreated', description: 'Current metadata'});

    expect(result.created).toEqual(['aside.md']);
    expect(host.isLoaded(root)).toBe(false); expect(host.loadedPaths()).toEqual([]);
    expect(host.metadata(root).value.manifest).toMatchObject({name: 'Recreated', description: 'Current metadata'});
    expect(host.availableInstances([root])).toEqual([expect.objectContaining({path: root, name: 'Recreated', description: 'Current metadata'})]);
    expect(host.availableInstances()).toEqual([]);
  });
});
