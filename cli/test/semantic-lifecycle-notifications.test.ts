import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {InstanceHost} from '../src/daemon/host.js';
import type {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import type {SemanticSearchService} from '../src/semantic/search.js';
import type {SemanticIndexSnapshot} from '../src/semantic/types.js';
import {Store} from '../src/source/store.js';
import {hostGraphQL} from './support/graphql-host.js';

const projectId = '2026-10-28-item';
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

function fixture() {
  const home = mkdtempSync('/private/tmp/aside-semantic-notifications-'), root = join(home, 'source');
  vi.stubEnv('ASIDE_DAEMON_HOME', join(home, 'state'));
  mkdirSync(join(root, 'projects', '2026'), {recursive: true});
  writeFileSync(join(root, 'aside.md'), '---\nid: semantic-notifications\n---\n');
  writeFileSync(join(root, 'projects', '2026', 'index.yaml'), `- id: ${projectId}\n  description: Item\n`);
  writeFileSync(join(root, 'projects', '2026', `${projectId}.md`), '---\nname: Item\ncreated: 2026-10-28\n---\nOriginal body.\n');
  const state = {model: 'model-v1'};
  const snapshot = (store: Store): SemanticIndexSnapshot => ({sourceVersion: store.getSourceVersion(),
    model: state.model, indexedChunks: store.getProjects().size});
  // This service has no embedder or database: owner notifications alone drive
  // these tests, without contacting Ollama or adding a worker change listener.
  const reconcile = vi.fn<SemanticSearchService['reconcile']>(async store => snapshot(store));
  const service = {reconcile, close: async () => {}} as unknown as SemanticSearchService;
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 0, reconciliationIntervalMs: 0});
  host.configureSemantic({service: () => service, reconciliation: {
    debounceMs: 0, reconciliationIntervalMs: 0, retryMinMs: 10, retryMaxMs: 40,
  }});
  const {store} = host.load(root);
  const lifecycle = (host as unknown as {sources: InstanceLifecycle}).sources;
  cleanup.push(async () => {await host.close(); rmSync(home, {recursive: true, force: true});});
  const update = () => hostGraphQL(host, root, 'mutate', {document: `mutation {updateProject(id: "${projectId}", input: {body: "Updated through the host."}) {error}}`});
  return {host, root, store, lifecycle, state, reconcile, snapshot, update};
}

describe('semantic notifications through the instance host', () => {
  it('cancels obsolete index work before it completes when the host publishes a newer source', async () => {
    const f = fixture();
    let resolve!: (snapshot: SemanticIndexSnapshot) => void;
    const held = new Promise<SemanticIndexSnapshot>(yes => {resolve = yes;});
    let firstSignal: AbortSignal | undefined, firstSnapshot: SemanticIndexSnapshot | undefined;
    f.reconcile.mockImplementationOnce((store, options) => {
      firstSignal = options?.signal; firstSnapshot = f.snapshot(store);
      return held;
    });
    const flushing = f.lifecycle.flush();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.reconcile).toHaveBeenCalledOnce(); expect(firstSignal?.aborted).toBe(false);
      await f.update();
      expect(f.store.getSourceVersion()).not.toBe(firstSnapshot!.sourceVersion);
      await vi.advanceTimersByTimeAsync(0);
      // The old service promise is still held. Cancellation must follow source
      // publication rather than waiting for its stale inference to finish.
      expect(firstSignal!.aborted).toBe(true);
      expect(f.reconcile).toHaveBeenCalledTimes(2);
      await flushing;
      expect(await f.reconcile.mock.results[1].value).toMatchObject({sourceVersion: f.store.getSourceVersion()});
      expect(f.lifecycle.issues(f.store)).toEqual([]);
    } finally {
      resolve(firstSnapshot ?? f.snapshot(f.store));
      await flushing;
    }
  });

  it.each(['explicit check', 'unchanged source refresh'] as const)('checks a model change on the next independent %s', async request => {
    const f = fixture();
    await f.lifecycle.flush();
    expect(f.reconcile).toHaveBeenCalledOnce();
    await f.update(); await f.lifecycle.flush();
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    const sourceVersion = f.store.getSourceVersion();
    f.state.model = 'model-v2';

    if (request === 'explicit check') f.lifecycle.reconcileFeature('semantic');
    else {
      f.lifecycle.refresh(f.store);
      expect(f.store.getSourceVersion()).toBe(sourceVersion);
    }
    await f.lifecycle.flush();

    expect(f.reconcile).toHaveBeenCalledTimes(3);
    expect(await f.reconcile.mock.results[2].value).toMatchObject({sourceVersion, model: 'model-v2'});
    expect(f.lifecycle.issues(f.store)).toEqual([]);
  });
});
