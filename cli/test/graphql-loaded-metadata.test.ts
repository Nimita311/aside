import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceHost} from '../src/daemon/host.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {Store} from '../src/source/store.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession, type InstanceBackend} from '../src/mcp/instance-session.js';
import {executeGraphQL} from '../src/graphql/schema.js';
import {handleUpdateInstance} from '../src/mcp/tools/instance.js';
import * as instanceFiles from '../src/core/instance.js';
import {lifecycleMetadataFixture} from './lifecycle-metadata-fixture.js';

const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function fixture() {
  const directory = realpathSync(mkdtempSync('/private/tmp/aside-loaded-metadata-'));
  cleanups.push(() => rmSync(directory, {recursive: true, force: true}));
  const host = new InstanceHost(new CalClient(null));
  // Keep the newer disk revision unobserved until the owner explicitly refreshes.
  host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
  cleanups.push(() => host.close());
  const write = (name: string, variant: 'loaded' | 'disk' = 'loaded') => {
    const path = join(directory, name); mkdirSync(path, {recursive: true});
    writeFileSync(join(path, 'aside.md'), `---\nid: ${variant}-${name}\nname: ${variant} ${name}\ndescription: ${variant} description\nconfig:\n  recurrenceLookaheadDays: ${variant === 'loaded' ? 3 : 17}\n  scheduledEventTitlePrefix: "${variant} "\n  doneEventTitlePrefix: "${variant} done "\nautomations:\n  ${variant}:\n    schedule:\n      at: 2099-01-01T00:00:00Z\n    run:\n      script: echo-${variant}\n---\n\n${variant} instructions.\n`);
    return path;
  };
  const session = (paths: string[], active: string, extra: Partial<InstanceBackend> = {}) => {
    const registry = new InstanceRegistry(paths); registry.activate(active);
    host.observeInstances(paths);
    const backend: InstanceBackend = {knownInstances: async () => paths, issues: vi.fn(async () => []),
      admitInstance: async path => {
        const issues = await backend.issues(path);
        return {path, record: host.metadata(path), issues};
      },
      instanceRecord: async (path: string) => host.metadata(path), ...extra};
    return {session: new InstanceSession(registry, backend, [], false), backend};
  };
  return {directory, host, write, session};
}

const fields = 'id name description path body settings { scheduledEventTitlePrefix doneEventTitlePrefix } automations { nodes { name run { script } } }';
const expected = (path: string, name: string, variant = 'loaded') => ({
  id: `${variant}-${name}`, name: `${variant} ${name}`, description: `${variant} description`, path,
  body: `${variant} instructions.`,
  settings: {scheduledEventTitlePrefix: `${variant} `, doneEventTitlePrefix: `${variant} done `},
  automations: {nodes: [{name: variant, run: {script: `echo-${variant}`}}]},
});

describe('passive metadata for lifecycle-owned instances', () => {
  it('uses loaded metadata throughout active and catalogue inspections while disk is ahead', async () => {
    const f = fixture(), active = f.write('active'), other = f.write('other');
    const loaded = [f.host.load(active).store, f.host.load(other).store];
    f.host.setKnownPaths(() => [active, other]);
    const load = vi.spyOn(f.host, 'load');
    const rebuild = loaded.map(store => vi.spyOn(store, 'rebuild'));
    const close = loaded.map(store => vi.spyOn(store, 'close'));
    const {session, backend} = f.session([active, other], active);
    f.write('active', 'disk'); f.write('other', 'disk');
    const read = vi.spyOn(instanceFiles, 'readInstanceRecordResult');

    const result = await f.host.graphql(session, 'query', {document: `{activeInstance {${fields}} instances {${fields}}}`});

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({activeInstance: expected(active, 'active'), instances: [expected(active, 'active'), expected(other, 'other')]});
    expect(load).not.toHaveBeenCalled();
    for (const spy of [...rebuild, ...close]) expect(spy).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(backend.issues).not.toHaveBeenCalled();
  });

  it('keeps registered but unloaded metadata inspections passive', async () => {
    const f = fixture(), active = f.write('active', 'disk'), other = f.write('other', 'disk');
    f.host.setKnownPaths(() => [active, other]);
    const load = vi.spyOn(f.host, 'load'), rebuild = vi.spyOn(Store.prototype, 'rebuild');
    const {session, backend} = f.session([active, other], active);

    const result = await f.host.graphql(session, 'query', {document: `{activeInstance {${fields}} instances {${fields}}}`});

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({activeInstance: expected(active, 'active', 'disk'), instances: [expected(active, 'active', 'disk'), expected(other, 'other', 'disk')]});
    expect(f.host.loadedPaths()).toEqual([]);
    expect(load).not.toHaveBeenCalled(); expect(rebuild).not.toHaveBeenCalled();
    expect(Store.prototype.watch).not.toHaveBeenCalled(); expect(backend.issues).not.toHaveBeenCalled();
  });

  it('captures each supplied metadata fixture once across aliases, catalogue fields, and automation owners', async () => {
    const f = fixture(), active = f.write('active'), other = f.write('other');
    const {session} = f.session([active, other], active);
    const source = vi.fn((): Store => {throw new Error('Passive inspection must not load records');});
    const state = lifecycleMetadataFixture(active, other);
    const read = vi.spyOn(instanceFiles, 'readInstanceRecordResult');
    const loadedInstance = vi.fn(state.loadedInstance);

    const result = await executeGraphQL(source, 'query', {
      document: `{one:activeInstance {${fields}} two:activeInstance {body} instances {${fields}}}`,
    }, {instances: session, loadedInstance});

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({one: expected(active, 'active'), two: {body: 'loaded instructions.'},
      instances: [expected(active, 'active'), expected(other, 'other')]});
    expect(read).not.toHaveBeenCalled();
    expect(loadedInstance.mock.calls).toHaveLength(2); expect(source).not.toHaveBeenCalled();
  });

  it('refreshes metadata snapshots between serial selection mutation payloads', async () => {
    const f = fixture(), path = f.write('selected');
    const store = f.host.load(path).store;
    let selection = 0;
    const {session} = f.session([path], path, {issues: async () => {
      selection++;
      handleUpdateInstance(store, {body: `Selection ${selection}.`, automations: {
        [`selection${selection}`]: {schedule: {at: '2099-01-01T00:00:00Z'}, run: {script: 'echo'}},
      }});
      return [];
    }});
    const source = vi.fn((): Store => {throw new Error('Selecting metadata must not build a record view');});
    const loadedInstance = () => ({value: store.getInstance()!, issues: []});

    const result = await executeGraphQL(source, 'mutation', {document: `mutation($path:String!){
      first:selectInstance(path:$path){instance{body automations{nodes{name}}}}
      second:selectInstance(path:$path){instance{body automations{nodes{name}}}}
    }`, variables: {path}}, {instances: session, loadedInstance});

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({first: {instance: {body: 'Selection 1.', automations: {nodes: [{name: 'selection1'}]}}},
      second: {instance: {body: 'Selection 2.', automations: {nodes: [{name: 'selection2'}]}}}});
    expect(source).not.toHaveBeenCalled();
  });

  it('uses loaded scalar and nested metadata together in selection mutation payloads', async () => {
    const f = fixture(), path = f.write('selected');
    const store = f.host.load(path).store;
    const {session} = f.session([path], path);
    f.write('selected', 'disk');
    const load = vi.spyOn(f.host, 'load'), rebuild = vi.spyOn(store, 'rebuild');

    const result = await f.host.graphql(session, 'mutation', {document: `mutation($path:String!){selectInstance(path:$path){instance{${fields}}}}`,
      variables: {path}});

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({selectInstance: {instance: expected(path, 'selected')}});
    expect(load).not.toHaveBeenCalled(); expect(rebuild).not.toHaveBeenCalled();
  });

  it('keeps metadata on the captured record snapshot when a loaded write arrives during a mixed query', async () => {
    const f = fixture(), path = f.write('selected');
    const store = f.host.load(path).store;
    const {session} = f.session([path], path, {knownInstances: async () => {
      handleUpdateInstance(store, {body: 'A newer loaded write.'});
      return [path];
    }});
    const loadedInstance = vi.fn(() => ({value: store.getInstance()!, issues: []}));

    const result = await executeGraphQL(() => store, 'query', {document: '{instances{body} activeInstance{body} projects{totalCount}}'},
      {instances: session, loadedInstance});

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({instances: [{body: 'loaded instructions.'}], activeInstance: {body: 'loaded instructions.'}, projects: {totalCount: 0}});
    expect(store.getInstance()!.body).toBe('A newer loaded write.');
    expect(loadedInstance).not.toHaveBeenCalled();
  });

  it('reports loaded manifest diagnostics even after the disk manifest is repaired', async () => {
    const f = fixture(), path = f.write('diagnostics');
    const manifest = join(path, 'aside.md');
    writeFileSync(manifest, '---\nid: loaded-diagnostics\nname: []\n---\n\nLoaded instructions.\n');
    const store = f.host.load(path).store;
    const issue = store.getIssues().find(issue => issue.field === 'name');
    expect(issue).toBeDefined();
    store.recordRebuildFailure(new Error('Unrelated source failure'));
    f.write('diagnostics', 'disk');
    const {session, backend} = f.session([path], path);

    const result = await f.host.graphql(session, 'query', {document: '{activeInstance{id name body} instances{id name}}'});

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({activeInstance: {id: 'loaded-diagnostics', name: null, body: 'Loaded instructions.'},
      instances: [{id: 'loaded-diagnostics', name: null}]});
    expect(result.extensions?.diagnostics).toContainEqual(expect.objectContaining({code: issue!.code, field: 'name', file: 'aside.md'}));
    expect(result.extensions?.diagnostics.some(issue => issue.code === 'rebuild_failed')).toBe(false);
    expect(backend.issues).not.toHaveBeenCalled();
  });
});
