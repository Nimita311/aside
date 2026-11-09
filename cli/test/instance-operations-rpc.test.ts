import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Daemon} from '../src/daemon/daemon.js';
import {InstanceHost} from '../src/daemon/host.js';
import {daemonPaths, ensureDirs} from '../src/daemon/paths.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {daemonSession} from './support/graphql-host.js';

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
});
afterEach(async () => {
  access.reset();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function fixture(declarations = '') {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-instance-rpc-')), root = join(home, 'source'); mkdirSync(root);
  writeFileSync(join(root, 'aside.md'), `---\nid: published\nversion: fixture\nname: Published name\ndescription: Published description\nconfig: {scheduledEventTitlePrefix: "Plan "}\n${declarations}---\nPublished instructions.\n`);
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
  const paths = daemonPaths({ASIDE_DAEMON_HOME: join(home, 'daemon')}), daemon = new Daemon({host, paths});
  ensureDirs(paths);
  (daemon as any).known = [root];
  const {store} = host.load(root);
  const call = (method: string, params?: unknown) => (daemon as any).dispatch({}, method, params);
  cleanup.push(async () => {
    await (daemon as any).cacheWork; await (host as any).usageLog.flush(); await host.close();
    rmSync(home, {recursive: true, force: true});
  });
  return {home, root, paths, host, store, daemon, call};
}

const mutate = (f: ReturnType<typeof fixture>, document: string, variables: Record<string, unknown>, session: object = daemonSession(f.root)) =>
  f.call('graphql', {mode: 'mutation', session: {...session, cwd: f.home}, args: {document, variables}});
const createDocument = 'mutation($input:CreateInstanceInput!){createInstance(input:$input){error instance{id name description path body}}}';

describe('instance lifecycle RPC ownership', () => {
  it('reports neutral admission failures with GraphQL recovery guidance', async () => {
    const f = fixture(), missing = join(f.home, 'missing'), created = vi.spyOn(f.host, 'created');
    const select = await mutate(f, 'mutation($path:String!){selectInstance(path:$path){error}}', {path: missing});
    expect(select.result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Not an aside instance')})]);
    expect(select.result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Use createInstance')})]);
    expect(select.session.active).toBe(f.root);
    const create = await mutate(f, 'mutation($input:CreateInstanceInput!){createInstance(input:$input){error}}', {input: {path: f.root, name: 'Existing', description: 'Existing'}});
    expect(create.result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Already an aside instance')})]);
    expect(create.result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Use selectInstance')})]);
    expect(create.session.active).toBe(f.root);
    expect(created).not.toHaveBeenCalled(); expect(existsSync(missing)).toBe(false);
  });

  it('admits a loaded owner using published state and safely serializes cyclic authored declarations', async () => {
    const f = fixture(`automations: &declarations\n  digest:\n    schedule: {at: '2099-01-01T00:00:00Z'}\n    run: {script: echo}\n    extension: *declarations\n`);
    expect(() => JSON.stringify(f.store.getManifest())).toThrow(/circular|cyclic/i);
    writeFileSync(join(f.root, 'aside.md'), '---\nid: disk-ahead\nname: Disk ahead\n---\nUnobserved instructions.\n');
    const admit = vi.spyOn(f.host, 'admitInstance'), rebuild = vi.spyOn(f.store, 'rebuild');
    access.protect([f.root]);

    const response = await mutate(f, 'mutation($path:String!){selectInstance(path:$path){error instance{id name description path body}}}', {path: f.root},
      {workspace: [], encountered: [], active: null, configIssues: [], discovery: false});

    expect(response.result.errors).toBeUndefined();
    expect(response.result.data.selectInstance).toEqual({error: null, instance: {id: 'published', name: 'Published name', description: 'Published description', path: f.root, body: 'Published instructions.'}});
    expect(response.session.active).toBe(f.root);
    expect(admit).toHaveBeenCalledExactlyOnceWith(f.root);
    expect(() => JSON.stringify(response)).not.toThrow();
    expect(rebuild).not.toHaveBeenCalled(); expect(access.violations).toEqual([]);
    await expect(f.call('instances', {manifests: true})).rejects.toThrow(/circular|cyclic/i);
    expect(await f.call('instances')).toEqual([expect.objectContaining({path: f.root, id: 'published'})]);
    expect(access.violations).toEqual([]);
  });

  it('returns created effects and owner metadata after registering and loading a successful bootstrap', async () => {
    const f = fixture(), destination = join(f.home, 'created'), created = vi.spyOn(f.host, 'created');

    const {result, session} = await mutate(f, createDocument, {input: {path: destination, name: 'Created', description: 'New source', body: 'Created instructions.'}});

    expect(result.errors).toBeUndefined();
    expect(result.data.createInstance).toEqual({error: null, instance: {id: 'created', name: 'Created', description: 'New source', path: destination, body: 'Created instructions.'}});
    expect(result.extensions.mutations).toEqual([{operation: 'createInstance', error: null,
      changes: [expect.objectContaining({kind: 'instance', id: 'created', effect: 'CREATED', path: join(destination, 'aside.md'), fields: ['manifest']})]}]);
    expect(session.active).toBe(destination);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(created).toHaveBeenCalledExactlyOnceWith(destination, {});
    expect(f.host.isLoaded(destination)).toBe(true);
    expect(f.host.metadata(destination).value.manifest.id).toBe('created');
    expect((f.daemon as any).known).toEqual([f.root, destination]);
    expect(JSON.parse(readFileSync(f.paths.known, 'utf8'))).toEqual([f.root, destination]);
  });

  it('returns durable effects and bootstrap metadata when owner loading fails after creation', async () => {
    const f = fixture(), destination = join(f.home, 'created');
    const created = vi.spyOn(f.host, 'created').mockImplementationOnce(() => {throw new Error('Owner load failed');});

    const {result, session} = await mutate(f, 'mutation($input:CreateInstanceInput!){createInstance(input:$input){error instance{id name path}}}', {input: {path: destination, name: 'Created', description: 'Durable source'}});

    expect(result.errors).toBeUndefined();
    expect(result.data.createInstance.instance).toEqual({id: 'created', name: 'Created', path: destination});
    expect(result.data.createInstance.error).toContain('Owner load failed'); expect(result.data.createInstance.error).toContain('unconfirmed');
    expect(result.extensions.mutations[0].changes).toEqual([expect.objectContaining({kind: 'instance', id: 'created', effect: 'CREATED', path: join(destination, 'aside.md'), fields: ['manifest']})]);
    expect(session.active).toBe(f.root);
    expect(created).toHaveBeenCalledExactlyOnceWith(destination, {});
    expect(existsSync(join(destination, 'aside.md'))).toBe(true);
    expect(f.host.isLoaded(destination)).toBe(false); expect((f.daemon as any).known).toEqual([f.root]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('returns complete ordinary manifests from published memory without reopening changed source', async () => {
    const f = fixture(`automations:\n  digest:\n    schedule: {at: '2099-01-01T00:00:00Z'}\n    run: {script: echo}\n`);
    const manifest = structuredClone(f.store.getManifest());
    writeFileSync(join(f.root, 'aside.md'), '---\nid: disk-ahead\n---\n');
    const rebuild = vi.spyOn(f.store, 'rebuild');
    access.protect([f.root]);

    const result = await f.call('instances', {manifests: true});

    expect(result).toEqual([expect.objectContaining({path: f.root, id: 'published', manifest})]);
    expect(result[0].manifest).toMatchObject({version: 'fixture', config: {scheduledEventTitlePrefix: 'Plan '}, automations: {digest: {run: {script: 'echo'}}}});
    expect(rebuild).not.toHaveBeenCalled(); expect(access.violations).toEqual([]);
  });
});
