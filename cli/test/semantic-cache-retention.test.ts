import { afterEach, describe, expect, it, vi } from 'vitest';
import * as filesystem from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SemanticCacheRetention, SEMANTIC_CACHE_RETENTION_MS } from '../src/semantic/cache-retention.js';
import { hashText } from '../src/semantic/documents.js';
import { withSemanticCacheAccess } from '../src/semantic/search.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {...original, rm: vi.fn(original.rm)};
});

const homes: string[] = [];
afterEach(() => {vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, {recursive: true, force: true});});

function fixture(retentionMs = 100) {
  const home = mkdtempSync('/private/tmp/aside-cache-retention-'); homes.push(home);
  const indexRoot = join(home, 'search');
  let now = 1_000;
  const create = (path: string) => {
    const location = join(indexRoot, hashText(path));
    mkdirSync(location, {recursive: true}); writeFileSync(join(location, 'cache-data'), path);
    return location;
  };
  const retention = () => new SemanticCacheRetention({indexRoot, retentionMs, now: () => now});
  const metadata = (location: string) => JSON.parse(readFileSync(join(location, '.retention.json'), 'utf8'));
  return {home, indexRoot, create, retention, metadata, advance: (ms: number) => {now += ms;}};
}

describe('whole-instance semantic cache retention', () => {
  it('uses thirty days by default and rejects an invalid period', () => {
    expect(SEMANTIC_CACHE_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const f = fixture();
    expect(() => new SemanticCacheRetention({indexRoot: f.indexRoot, retentionMs: -1})).toThrow('retention period');
  });

  it('leaves missing caches absent when registering, forgetting, or checking', async () => {
    const f = fixture(), retention = f.retention();
    await retention.forget(['/missing'], true); await retention.register(['/missing']); await retention.collect([]);
    expect(existsSync(f.indexRoot)).toBe(false);
  });

  it('keeps a forgotten cache until its period expires and a check occurs', async () => {
    const f = fixture(), path = '/instance/kept', location = f.create(path), retention = f.retention();
    await retention.forget([path], false);
    expect(f.metadata(location)).toEqual({version: 1, unregisteredSince: 1_000});
    f.advance(99); await retention.collect([]); expect(existsSync(location)).toBe(true);
    f.advance(1); expect(existsSync(location)).toBe(true);
    await retention.collect([]); expect(existsSync(location)).toBe(false);
  });

  it('does not extend retention when forgetting the same path again', async () => {
    const f = fixture(), path = '/instance/repeated', location = f.create(path), retention = f.retention();
    await retention.forget([path], false); f.advance(90); await retention.forget([path], false);
    expect(f.metadata(location).unregisteredSince).toBe(1_000);
    f.advance(10); await retention.collect([]); expect(existsSync(location)).toBe(false);
  });

  it('resumes an explicit removal request after restart and waits for active users', async () => {
    const f = fixture(), path = '/instance/busy', location = f.create(path);
    await f.retention().forget([path], true);
    expect(f.metadata(location).removeRequested).toBe(true);
    const restored = f.retention();
    await restored.collect([], [path]); expect(existsSync(location)).toBe(true);
    // Ordinary forget does not override an earlier explicit removal request.
    await restored.forget([path], false); expect(f.metadata(location).removeRequested).toBe(true);
    await restored.collect([]); expect(existsSync(location)).toBe(false);
  });

  it('cancels expiration on registration without changing retained cache bytes', async () => {
    const f = fixture(), path = '/instance/reused', location = f.create(path), retention = f.retention();
    await retention.forget([path], false); f.advance(200); await retention.register([path]);
    expect(readdirSync(location)).toEqual(['cache-data']);
    await retention.collect([path]); expect(readFileSync(join(location, 'cache-data'), 'utf8')).toBe(path);
    // A later removal starts a new period rather than reviving old expiration.
    await retention.forget([path], false); expect(f.metadata(location).unregisteredSince).toBe(1_200);
  });

  it('finishes an explicit pending removal before registration can reuse the cache', async () => {
    const f = fixture(), path = '/instance/purged', location = f.create(path), retention = f.retention();
    await retention.forget([path], true); await retention.collect([], [path]);
    expect(existsSync(location)).toBe(true);
    await retention.register([path]); expect(existsSync(location)).toBe(false);
  });

  it('protects registered caches even when stale metadata says they are expired or pending removal', async () => {
    const f = fixture(), path = '/instance/registered', location = f.create(path), retention = f.retention();
    await retention.forget([path], false); f.advance(200); await retention.collect([path]);
    expect(existsSync(join(location, '.retention.json'))).toBe(false);
    await retention.forget([path], true); await retention.collect([path]);
    expect(f.metadata(location).removeRequested).toBe(true);
    expect(existsSync(location)).toBe(true);
  });

  it('starts a conservative clock when observing a legacy cache or malformed metadata', async () => {
    const f = fixture(), legacy = f.create('/instance/legacy'), malformed = f.create('/instance/malformed');
    writeFileSync(join(malformed, '.retention.json'), '{invalid');
    f.advance(1_000); await f.retention().collect([]);
    expect(f.metadata(legacy).unregisteredSince).toBe(2_000);
    expect(f.metadata(malformed).unregisteredSince).toBe(2_000);
    f.advance(99); await f.retention().collect([]); expect(existsSync(legacy)).toBe(true);
    f.advance(1); await f.retention().collect([]);
    expect(existsSync(legacy)).toBe(false); expect(existsSync(malformed)).toBe(false);
  });

  it.each([{version: 2, unregisteredSince: 0}, {version: 1, unregisteredSince: -1},
    {version: 1, unregisteredSince: 0, removeRequested: false}, []])('does not trust malformed state %j', async state => {
    const f = fixture(), location = f.create('/instance/corrupt');
    writeFileSync(join(location, '.retention.json'), JSON.stringify(state));
    await f.retention().collect([]); expect(f.metadata(location)).toEqual({version: 1, unregisteredSince: 1_000});
  });

  it('keeps an expired cache while in use and collects it on the next check after release', async () => {
    const f = fixture(), path = '/instance/expired-busy', location = f.create(path), retention = f.retention();
    await retention.forget([path], false); f.advance(100);
    await retention.collect([], [path]); expect(existsSync(location)).toBe(true);
    await retention.collect([]); expect(existsSync(location)).toBe(false);
  });

  it('rechecks current registration after waiting for a native search operation', async () => {
    const f = fixture(), path = '/instance/race', location = f.create(path), retention = f.retention();
    await retention.forget([path], true);
    let release!: () => void;
    const held = withSemanticCacheAccess(() => new Promise<void>(resolve => {release = resolve;}));
    await Promise.resolve();
    const registered: string[] = [];
    const collection = retention.collect(() => registered);
    registered.push(path); release(); await held; await collection;
    expect(existsSync(location)).toBe(true);
  });

  it('rechecks registration immediately before deleting after filesystem awaits', async () => {
    const f = fixture(), path = '/instance/last-check', location = f.create(path), retention = f.retention();
    await retention.forget([path], true);
    let checks = 0;
    await retention.collect(() => ++checks >= 3 ? [path] : []);
    expect(checks).toBe(3); expect(existsSync(location)).toBe(true);
  });

  it('keeps the removal marker when deleting a cached child fails, then resumes on retry', async () => {
    const f = fixture(), path = '/instance/retry', location = f.create(path), retention = f.retention();
    await retention.forget([path], true);
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm;
    vi.mocked(filesystem.rm).mockImplementationOnce(async (target, options) => {
      if (target === join(location, 'cache-data')) throw Object.assign(new Error('Cache temporarily busy'), {code: 'EBUSY'});
      return original(target, options);
    });
    await expect(retention.collect([])).rejects.toThrow('Cache temporarily busy');
    expect(f.metadata(location).removeRequested).toBe(true);
    await retention.collect([]); expect(existsSync(location)).toBe(false);
  });

  it('continues collecting other caches when one pending removal repeatedly fails', async () => {
    const f = fixture(), paths = ['/instance/busy', '/instance/other'];
    paths.forEach(path => f.create(path));
    const retention = f.retention(); await retention.forget(paths, true);
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm;
    let busy: string | undefined;
    vi.mocked(filesystem.rm).mockImplementation(async (target, options) => {
      if (String(target).endsWith('/cache-data')) {
        busy ??= dirname(String(target));
        if (dirname(String(target)) === busy) throw Object.assign(new Error('Cache temporarily busy'), {code: 'EBUSY'});
      }
      return original(target, options);
    });
    await expect(retention.collect([])).rejects.toThrow('Cache temporarily busy');
    expect(readdirSync(f.indexRoot).map(name => join(f.indexRoot, name))).toEqual([busy]);
    expect(f.metadata(busy!).removeRequested).toBe(true);
    // A permanently failing cache does not keep unrelated removals pending.
    await expect(retention.collect([])).rejects.toThrow('Cache temporarily busy');
    vi.mocked(filesystem.rm).mockImplementation(original);
    await retention.collect([]); expect(readdirSync(f.indexRoot)).toEqual([]);
  });

  it('ignores unknown entries and refuses symlinked caches or cache roots', async () => {
    const f = fixture(), outside = join(f.home, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'preserve'), 'outside'); mkdirSync(f.indexRoot);
    symlinkSync(outside, join(f.indexRoot, hashText('/instance/symlink')));
    mkdirSync(join(f.indexRoot, 'unrecognized')); writeFileSync(join(f.indexRoot, 'notes'), 'not a cache');
    const retention = f.retention();
    await retention.forget(['/instance/symlink'], true); await retention.register(['/instance/symlink']);
    await retention.collect([]); f.advance(1_000); await retention.collect([]);
    expect(readFileSync(join(outside, 'preserve'), 'utf8')).toBe('outside');
    expect(existsSync(join(f.indexRoot, 'unrecognized'))).toBe(true);
    const alias = join(f.home, 'root-alias'); symlinkSync(outside, alias);
    const aliased = new SemanticCacheRetention({indexRoot: alias, retentionMs: 0});
    await aliased.collect([]); expect(readdirSync(outside)).toEqual(['preserve']);
  });

  it('does not follow metadata or nested data symlinks when collecting a cache', async () => {
    const f = fixture(), path = '/instance/links', location = f.create(path), outside = join(f.home, 'outside');
    mkdirSync(outside); const marker = join(outside, 'preserve'); writeFileSync(marker, 'outside');
    symlinkSync(marker, join(location, '.retention.json')); symlinkSync(outside, join(location, 'data-link'));
    await f.retention().collect([]);
    expect(readFileSync(marker, 'utf8')).toBe('outside');
    f.advance(100); await f.retention().collect([]);
    expect(existsSync(location)).toBe(false); expect(readFileSync(marker, 'utf8')).toBe('outside');
  });
});
