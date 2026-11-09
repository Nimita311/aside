import {afterEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {connect} from '@lancedb/lancedb';
import {Daemon, writeKnown} from '../src/daemon/daemon.js';
import {DaemonClient} from '../src/daemon/client.js';
import {InstanceHost} from '../src/daemon/host.js';
import {daemonPaths} from '../src/daemon/paths.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {SemanticSearchService, semanticIndexGenerationKey, withSemanticCacheAccess} from '../src/semantic/search.js';
import {hashText} from '../src/semantic/documents.js';
import {SemanticCacheRetention, SEMANTIC_CACHE_RETENTION_MS} from '../src/semantic/cache-retention.js';
import type {SemanticEmbedder} from '../src/semantic/embedding.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, message: string) {
  const deadline = Date.now() + 4_000;
  do {
    if (await check()) return;
    await sleep(20);
  } while (Date.now() < deadline);
  throw new Error(message);
}

function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-cache-daemon-'));
  const paths = daemonPaths({ASIDE_DAEMON_HOME: home});
  const root = join(home, 'data'), indexRoot = join(home, 'search');
  mkdirSync(join(root, 'projects', '2026'), {recursive: true});
  writeFileSync(join(root, 'aside.md'), '---\nid: cache-daemon\nname: Cache daemon\n---\n');
  writeFileSync(join(root, 'projects', '2026', 'index.yaml'), '- id: item\n  description: Item\n');
  const file = join(root, 'projects', '2026', 'item.md');
  const write = (body: string) => writeFileSync(file, `---\nname: Item\ncreated: 2026-10-28\n---\n\n${body}\n`);
  write('Original registered source');
  const state = {embeddings: 0, identities: 0};
  const embedder: SemanticEmbedder = {
    model: 'cache-daemon',
    resolveGeneration: async () => {
      state.identities++;
      return {model: 'cache-daemon', identity: 'cache-daemon-weights',
        embed: async texts => {state.embeddings += texts.length; return texts.map(() => [1, 0.5, 0.25]);}};
    },
  };
  const daemons: Daemon[] = [], clients: DaemonClient[] = [], services: SemanticSearchService[] = [];
  function host(preload = false) {
    const value = new InstanceHost(new CalClient(null));
    if (preload) value.load(root);
    const service = new SemanticSearchService({embedder, indexRoot}); services.push(service);
    value.configureSemantic({service: () => service, reconciliation: {
      debounceMs: 5, retryMinMs: 20, retryMaxMs: 50, reconciliationIntervalMs: 50,
    }});
    return value;
  }
  async function start(known: string[] | string = [root], instance = host()) {
    if (typeof known === 'string') writeFileSync(paths.known, known);
    else writeKnown(paths, known);
    const daemon = new Daemon({paths, host: instance, webPort: 0}); daemons.push(daemon);
    expect(await daemon.listen()).toBe(true);
    return {daemon, host: instance};
  }
  function client() {
    const value = new DaemonClient({paths, launcher: async () => {throw new Error('Test daemon unexpectedly unavailable.');}});
    clients.push(value); return value;
  }
  const cache = (path = root) => join(indexRoot, hashText(path));
  const location = join(cache(), semanticIndexGenerationKey('cache-daemon-weights'));
  const rows = () => withSemanticCacheAccess(async () => {
    if (!existsSync(location)) return [];
    const connection = await connect(location);
    try {
      if (!(await connection.tableNames()).includes('chunks')) return [];
      const table = await connection.openTable('chunks');
      try {return (await table.query().select(['text']).toArray()).map(row => row.text as string);}
      finally {table.close();}
    } finally {connection.close();}
  });
  const indexed = (text: string) => until(async () => (await rows()).some(row => row.includes(text)), `Index did not contain ${JSON.stringify(text)}.`);
  const metadata = (path = root) => JSON.parse(readFileSync(join(cache(path), '.retention.json'), 'utf8'));
  const age = (path: string, time = Date.now() - SEMANTIC_CACHE_RETENTION_MS - 1_000) => {
    writeFileSync(join(cache(path), '.retention.json'), JSON.stringify({version: 1, unregisteredSince: time}));
  };
  const synthetic = (path: string) => {
    const location = cache(path); mkdirSync(location, {recursive: true}); writeFileSync(join(location, 'sentinel'), 'Retained cache bytes');
    return location;
  };
  cleanups.push(async () => {
    for (const client of clients) client.close();
    for (const daemon of daemons) await daemon.shutdown();
    await Promise.all(services.map(service => service.close()));
    rmSync(home, {recursive: true, force: true});
  });
  return {home, paths, root, cache, state, write, host, start, client, rows, indexed, metadata, age, synthetic};
}

describe('daemon semantic cache lifecycle', () => {
  it('defers explicit clearing while connected, then deletes on disconnect without another status request', async () => {
    const f = fixture(), {host} = await f.start(); await f.indexed('Original registered source');
    const user = f.client(), admin = f.client();
    await user.request('instance.info', {instance: f.root});
    const reply = await admin.request('known.forget', {paths: [f.root], clearCache: true});
    expect(reply).toMatchObject({known: [], cache: {clearRequested: [f.root]}});
    expect(f.metadata().removeRequested).toBe(true);
    expect(host.loadedPaths()).toContain(f.root);
    const before = {...f.state}; f.write('Changed after forgetting');
    await sleep(180);
    expect(f.state).toEqual(before);
    expect(existsSync(f.cache())).toBe(true);
    user.close();
    await until(() => !existsSync(f.cache()), 'Pending cache removal did not run after its last user disconnected.');
    expect(host.loadedPaths()).not.toContain(f.root);
    await sleep(120);
    expect(f.state).toEqual(before); expect(existsSync(f.cache())).toBe(false);
    expect(existsSync(join(f.root, 'aside.md'))).toBe(true);
  });

  it('removes immediately when forgetting an unused instance with explicit clearing', async () => {
    const f = fixture(); await f.start(); await f.indexed('Original registered source');
    await f.client().request('known.forget', {paths: [f.root], clearCache: true});
    expect(existsSync(f.cache())).toBe(false);
    expect(existsSync(join(f.root, 'projects', '2026', 'item.md'))).toBe(true);
  });

  it('keeps by default, then lazily expires an unregistered cache during an owner cache check', async () => {
    const f = fixture(), {daemon} = await f.start(); await f.indexed('Original registered source');
    const admin = f.client(); await admin.request('known.forget', {paths: [f.root]});
    // Finish collection queued by forgetting before simulating expiration.
    await (daemon as any).collectSemanticCaches(); await (daemon as any).cacheWork;
    expect(existsSync(f.cache())).toBe(true);
    expect(f.metadata()).toEqual({version: 1, unregisteredSince: expect.any(Number)});
    f.age(f.root);
    expect(existsSync(f.cache())).toBe(true);
    await (daemon as any).collectSemanticCaches();
    expect(existsSync(f.cache())).toBe(false);
  });

  it('expires old orphan caches at startup, preserves registered caches, and starts a clock for legacy caches', async () => {
    const f = fixture(), orphan = '/previous/forgotten-instance', legacy = '/previous/legacy-instance';
    f.synthetic(f.root); f.age(f.root);
    const obsolete = f.synthetic(orphan); f.age(orphan);
    const observed = f.synthetic(legacy), started = Date.now();
    await f.start();
    expect(existsSync(obsolete)).toBe(false);
    expect(readFileSync(join(f.cache(), 'sentinel'), 'utf8')).toBe('Retained cache bytes');
    expect(existsSync(join(f.cache(), '.retention.json'))).toBe(false);
    expect(existsSync(observed)).toBe(true);
    expect(f.metadata(legacy).unregisteredSince).toBeGreaterThanOrEqual(started);
    await f.indexed('Original registered source');
  });

  it('fulfills a pending clear before re-registration rebuilds through the same native service', async () => {
    const f = fixture(); await f.start(); await f.indexed('Original registered source');
    const user = f.client(), admin = f.client();
    await user.request('instance.info', {instance: f.root});
    writeFileSync(join(f.cache(), 'old-cache-sentinel'), 'Must be removed by explicit clear');
    await admin.request('known.forget', {paths: [f.root], clearCache: true});
    expect(existsSync(join(f.cache(), 'old-cache-sentinel'))).toBe(true);
    const embeddings = f.state.embeddings;
    f.write('Newly registered source');
    await admin.request('known.add', {paths: [f.root]});
    await f.indexed('Newly registered source');
    expect(existsSync(join(f.cache(), 'old-cache-sentinel'))).toBe(false);
    expect(existsSync(join(f.cache(), '.retention.json'))).toBe(false);
    expect(f.state.embeddings).toBeGreaterThan(embeddings);
    expect((await f.rows()).every(row => !row.includes('Original registered source'))).toBe(true);
  });

  it('reattaches maintenance to a preloaded host when startup restores its registration', async () => {
    const f = fixture(), host = f.host(true);
    await f.start([f.root], host);
    // Reading the table directly creates no client or selection to repair startup.
    await f.indexed('Original registered source');
    expect(f.state.embeddings).toBe(1);
    f.write('Edit after restored registration');
    await f.indexed('Edit after restored registration');
    expect((await f.rows()).every(row => !row.includes('Original registered source'))).toBe(true);
  });

  it('persists retention before forgetting and preserves an instance registered during that await', async () => {
    const f = fixture(); await f.start(); await f.indexed('Original registered source');
    const original = SemanticCacheRetention.prototype.forget;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => {entered = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    vi.spyOn(SemanticCacheRetention.prototype, 'forget').mockImplementationOnce(async function(paths, clear) {
      entered(); await gate; await original.call(this, paths, clear);
    });
    const admin = f.client(), newcomer = f.client();
    const forgetting = admin.request('known.forget', {paths: [f.root], clearCache: true});
    try {
      await waiting;
      expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.root]);
      const other = join(f.home, 'newcomer'); mkdirSync(other);
      writeFileSync(join(other, 'aside.md'), '---\nid: newcomer\nname: Newcomer\n---\n');
      await newcomer.request('instance.info', {instance: other});
      expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.root, other]);
      release();
      expect(await forgetting).toMatchObject({known: [other]});
      expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([other]);
      expect(existsSync(f.cache())).toBe(false);
    } finally {release(); await forgetting.catch(() => {});}
  });

  it('leaves registration and maintenance intact when retention intent cannot be persisted', async () => {
    const f = fixture(); await f.start(); await f.indexed('Original registered source');
    const admin = f.client();
    vi.spyOn(SemanticCacheRetention.prototype, 'forget').mockRejectedValueOnce(new Error('Retention metadata is not writable.'));
    await expect(admin.request('known.forget', {paths: [f.root], clearCache: true})).rejects.toThrow('Retention metadata is not writable');
    expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.root]);
    expect(existsSync(f.cache())).toBe(true);
    f.write('Updated after failed forgetting'); await f.indexed('Updated after failed forgetting');
    // A later attempt can commit; the rejected lifecycle operation did not
    // poison either the cache queue or registration maintenance.
    await admin.request('known.forget', {paths: [f.root], clearCache: true});
    expect(existsSync(f.cache())).toBe(false);
  });

  it('returns a committed registration receipt when physical cache cleanup must retry', async () => {
    const f = fixture(), {daemon} = await f.start(); await f.indexed('Original registered source');
    const admin = f.client();
    const collecting = vi.spyOn(SemanticCacheRetention.prototype, 'collect').mockRejectedValue(new Error('Cache file is busy.'));
    const result = await admin.request('known.forget', {paths: [f.root], clearCache: true});
    expect(result).toMatchObject({known: [], changed: [f.root], cache: {clearRequested: [f.root]}});
    expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([]);
    expect(f.metadata().removeRequested).toBe(true);
    collecting.mockRestore();
    await (daemon as any).collectSemanticCaches();
    await until(() => !existsSync(f.cache()), 'Accepted cache clearing did not retry after reclamation recovered.');
  });

  it('keeps an unrelated automatically pruned cache when explicitly clearing a different instance', async () => {
    const f = fixture(), other = join(f.home, 'missing-later'); mkdirSync(other);
    const manifest = join(other, 'aside.md'); writeFileSync(manifest, '---\nid: missing-later\n---\n');
    const retained = f.synthetic(other);
    await f.start([f.root, other]); await f.indexed('Original registered source');
    rmSync(manifest);
    await f.client().request('known.forget', {paths: [f.root], clearCache: true});
    expect(existsSync(f.cache())).toBe(false);
    expect(existsSync(retained)).toBe(true);
    expect(f.metadata(other)).toEqual({version: 1, unregisteredSince: expect.any(Number)});
  });

  it('preserves expired cache data on startup and status when the registration file is malformed', async () => {
    const f = fixture(); f.synthetic(f.root); f.age(f.root);
    const metadata = readFileSync(join(f.cache(), '.retention.json'), 'utf8');
    const malformed = '{"registration list is incomplete":';
    await f.start(malformed);
    expect(existsSync(f.cache())).toBe(true);
    expect(readFileSync(join(f.cache(), '.retention.json'), 'utf8')).toBe(metadata);
    await f.client().request('status'); await sleep(60);
    expect(readFileSync(join(f.cache(), 'sentinel'), 'utf8')).toBe('Retained cache bytes');
    expect(readFileSync(join(f.cache(), '.retention.json'), 'utf8')).toBe(metadata);
    expect(readFileSync(f.paths.known, 'utf8')).toBe(malformed);
    expect(f.state.embeddings).toBe(0);
  });
});
