import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceHost} from '../src/daemon/host.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession} from '../src/mcp/instance-session.js';
import {Store} from '../src/source/store.js';
import {executeGraphQL} from '../src/graphql/schema.js';
import {lifecycleMetadataFixture} from './lifecycle-metadata-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
});
afterEach(async () => {
  access.reset();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.useRealTimers();
});
function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-required-state-'));
  cleanup.push(() => rmSync(home, {recursive: true, force: true}));
  const root = join(home, 'selected'); mkdirSync(root);
  writeFileSync(join(root, 'aside.md'), '---\nid: selected\nname: Selected\n---\nPublished instructions.\n');
  writeFileSync(join(root, '.aside'), '{}\n');
  return {home, root};
}
function session(paths: string[], active: string, state = lifecycleMetadataFixture(...paths)) {
  const registry = new InstanceRegistry(paths); registry.activate(active);
  return new InstanceSession(registry, {knownInstances: async () => paths, issues: async () => [], instanceRecord: state.instanceRecord}, [], false);
}
const noRecords = () => {throw new Error('Metadata inspection must not load records');};

describe('required lifecycle state', () => {
  it('requires explicit owner observation before exposing passive metadata', () => {
    const {root} = fixture(), host = new InstanceHost(new CalClient(null));
    cleanup.push(() => host.close());
    access.protect([root]);
    expect(() => host.metadata(root)).toThrow('Lifecycle-provided instance metadata is unavailable');
    expect(access.violations).toEqual([]);
    access.reset(); host.observeInstances([root]); access.protect([root]);
    expect(host.metadata(root).value.manifest.name).toBe('Selected');
    expect(access.violations).toEqual([]);
  });

  it.each(['missing', 'unavailable'] as const)('rejects %s instance metadata without reading a valid manifest', async mode => {
    const {root} = fixture(), instances = session([root], root);
    access.protect([root]);
    const result = await executeGraphQL(noRecords, 'query', {document: '{activeInstance{id name body}}'}, {
      instances, ...(mode === 'unavailable' ? {loadedInstance: () => undefined} : {}),
    });
    expect(result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Lifecycle-provided instance metadata'),
      extensions: {code: 'LIFECYCLE_STATE_UNAVAILABLE', state: 'instance metadata'}})]);
    expect(access.violations).toEqual([]);
  });

  it.each(['missing', 'unavailable'] as const)('rejects %s execution state without reopening .aside', async mode => {
    const {root} = fixture(), state = lifecycleMetadataFixture(root), instances = session([root], root, state);
    access.protect([root]);
    const result = await executeGraphQL(noRecords, 'query', {document: '{activeInstance{execution{cwd}}}'}, {
      instances, loadedInstance: state.loadedInstance,
      ...(mode === 'unavailable' ? {executionContext: () => undefined} : {}),
    });
    expect(result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Lifecycle-provided execution context'),
      extensions: {code: 'LIFECYCLE_STATE_UNAVAILABLE', state: 'execution context'}})]);
    expect(access.violations).toEqual([]);
  });

  it.each(['missing', 'unavailable'] as const)('rejects %s cross-instance records without constructing a temporary Store', async mode => {
    const {home, root} = fixture(), other = join(home, 'other'), prompt = '2026-10-30-instructions';
    mkdirSync(join(other, 'artifacts', '2026'), {recursive: true});
    writeFileSync(join(other, 'aside.md'), `---\nid: other\nautomations:\n  digest:\n    schedule: {at: '2099-01-01T00:00:00Z'}\n    run: {model: CUSTOM, prompt: '#artifact/${prompt}'}\n---\n`);
    writeFileSync(join(other, 'artifacts', '2026', `${prompt}.md`), '---\nname: Instructions\ncreated: 2026-10-30T09:00\n---\nSaved prompt.\n');
    const store = new Store(root); cleanup.push(() => store.close());
    const state = lifecycleMetadataFixture(root, other), instances = session([root, other], root, state);
    const rebuild = vi.spyOn(Store.prototype, 'rebuild');
    access.protect([root, other]);
    const result = await executeGraphQL(store, 'query', {document: '{instances{path automations{nodes{run{prompt{id}}}}}}'}, {
      instances, loadedInstance: state.loadedInstance,
      ...(mode === 'unavailable' ? {resolveStore: () => undefined} : {}),
    });
    expect(result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Lifecycle-provided records'),
      extensions: {code: 'LIFECYCLE_STATE_UNAVAILABLE', state: 'records'}})]);
    expect(rebuild).not.toHaveBeenCalled(); expect(access.violations).toEqual([]);
  });

  it.each(['missing', 'unavailable'] as const)('preserves the %s execution-state error during mutation preflight', async mode => {
    const {root} = fixture(), state = lifecycleMetadataFixture(root), instances = session([root], root, state);
    const source = vi.fn(noRecords), mutate = vi.fn();
    access.protect([root]);
    const result = await executeGraphQL(source, 'mutation', {document: `mutation {
        updateInstance(input: {automations: {set: [{name: "digest", schedule: {at: "2099-01-01T00:00:00Z"},
          run: {model: "CUSTOM", prompt: {existingId: "2026-10-30-instructions"}}}]}}) { error }
      }`}, {instances, loadedInstance: state.loadedInstance, mutate,
        ...(mode === 'unavailable' ? {executionContext: () => undefined} : {}),
      });
    expect(result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Lifecycle-provided execution context'),
      extensions: {code: 'LIFECYCLE_STATE_UNAVAILABLE', state: 'execution context'}})]);
    expect(source).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
    expect(access.violations).toEqual([]);
  });

  it('uses owner-observed passive configuration until the owner publishes another observation', async () => {
    const {root} = fixture(), work = join(root, 'work'); mkdirSync(work);
    writeFileSync(join(root, '.aside'), 'execution: {cwd: work}\n');
    const host = new InstanceHost(new CalClient(null));
    host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
    cleanup.push(() => host.close());
    host.observeInstances([root]);
    const instances = session([root], root);
    const load = vi.spyOn(host, 'load');
    writeFileSync(join(root, '.aside'), 'execution: [invalid]\n');
    access.protect([root]);
    const result = await host.graphql(instances, 'query', {document: '{activeInstance{execution{cwd}}}'});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({activeInstance: {execution: {cwd: work}}});
    expect(load).not.toHaveBeenCalled(); expect(access.violations).toEqual([]);
    access.reset();
    host.observeInstances([root]); access.protect([root]);
    const updated = await host.graphql(instances, 'query', {document: '{activeInstance{execution{cwd}}}'});
    expect(updated.data).toEqual({activeInstance: {execution: {cwd: null}}});
    expect(updated.extensions?.diagnostics).toContainEqual(expect.objectContaining({code: 'execution_config', message: expect.stringContaining('Invalid execution config')}));
    expect(access.violations).toEqual([]);
  });
});
