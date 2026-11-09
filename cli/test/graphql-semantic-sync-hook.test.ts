import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {lifecycleOperationsFixture} from './lifecycle-operations-fixture.js';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {executeGraphQLWithOwner as executeGraphQL, type MutationRunner} from './graphql-owner-fixture.js';
import {SemanticSetupError} from '../src/semantic/embedding.js';
import {Store} from '../src/source/store.js';
import {handleCapture} from '../src/mcp/tools/capture.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession} from '../src/mcp/instance-session.js';

describe('GraphQL semantic synchronization hooks', () => {
  let home: string;
  const stores = new Map<string, Store>();
  const loadedInstance = (root: string) => {
    const store = stores.get(root);
    return store ? {value: store.getInstance()!, issues: store.getIssues()} : undefined;
  };
  const instanceRecord = async (root: string) => loadedInstance(root);
  const now = new Date(2026, 9, 28, 10);
  function fixture(name = 'source') {
    const root = join(home, name); mkdirSync(root);
    writeFileSync(join(root, 'aside.md'), `---\nid: ${name}\nname: ${name}\n---\n`);
    const store = new Store(root); stores.set(root, store);
    return {root, store};
  }
  beforeEach(() => { home = realpathSync(mkdtempSync('/private/tmp/aside-graphql-semantic-hook-')); });
  afterEach(() => { vi.restoreAllMocks(); for (const store of stores.values()) store.close(); stores.clear(); rmSync(home, {recursive: true, force: true}); });

  it('notifies once for confirmed writes across selected instances, including before a later failure', async () => {
    const a = fixture('alpha'), b = fixture('beta');
    const registry = new InstanceRegistry([a.root, b.root]); registry.activate(a.root);
    const session = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [a.root, b.root], issues: async () => [], instanceRecord}), [], false, home);
    const onMutation = vi.fn();
    const mutate: MutationRunner = (operation, args: any) => {
      if (operation !== 'capture') throw new Error('The later mutation failed before writing.');
      return handleCapture(stores.get(registry.activeInstance!)!, args, now);
    };
    const result = await executeGraphQL(() => stores.get(registry.activeInstance!)!, 'mutation', {document: `mutation {
      first: capture(input: {content: "Alpha context", description: "Alpha"}) {entry{id}}
      selectInstance(path: ${JSON.stringify(b.root)}) {instance{path}}
      second: capture(input: {content: "Beta context", description: "Beta"}) {entry{id}}
      updateProject(id: "missing", input: {name: "Never saved"}) {error}
    }`}, {instances: session, mutate, onMutation, loadedInstance});
    expect(result.errors).toHaveLength(1);
    expect(onMutation).toHaveBeenCalledExactlyOnceWith([a.root, b.root]);
    expect(a.store.getEntries()[0].content).toBe('Alpha context');
    expect(b.store.getEntries()[0].content).toBe('Beta context');
  });

  it('notifies after a partial persisted failure even when no saved fields are selected', async () => {
    const {root, store} = fixture(); const onMutation = vi.fn();
    const mutate: MutationRunner = (_operation, args: any) => {
      handleCapture(store, args, now);
      throw new Error('Failure after persistence');
    };
    const result = await executeGraphQL(store, 'mutation', {document: 'mutation{capture(input:{content:"Saved",description:"Saved"}){error}}'}, {mutate, onMutation});
    expect(result.errors).toBeUndefined();
    expect((result.data!.capture as any).error).toContain('Failure after persistence');
    expect(store.getEntries()[0].content).toBe('Saved');
    expect(onMutation).toHaveBeenCalledExactlyOnceWith([root]);
  });

  it('notifies after saved writes when the request is cancelled', async () => {
    const {root, store} = fixture(); const onMutation = vi.fn(), controller = new AbortController();
    const mutate: MutationRunner = (_operation, args: any) => {
      const saved = handleCapture(store, args, now);
      controller.abort(new Error('Cancelled after save'));
      return saved;
    };
    const result = await executeGraphQL(store, 'mutation', {document: 'mutation{capture(input:{content:"Saved despite cancellation",description:"Saved"}){entry{id}}}'},
      {mutate, onMutation, signal: controller.signal});
    expect(result.errors).toBeDefined();
    expect(store.getEntries()[0].content).toBe('Saved despite cancellation');
    expect(onMutation).toHaveBeenCalledExactlyOnceWith([root]);
  });

  it('reports newly created instance files while selection-only operations remain silent', async () => {
    const {root} = fixture(); const registry = new InstanceRegistry([root]);
    const session = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [root], issues: async () => [], instanceRecord,
      created: async (path: string) => {const store = new Store(path); stores.set(path, store); return store.getIssues();},
    }), [], false, home);
    const onMutation = vi.fn(), source = () => { throw new Error('Metadata operations do not load records.'); };
    const selected = await executeGraphQL(source, 'mutation', {document: `mutation{selectInstance(path:${JSON.stringify(root)}){instance{path}}}`}, {instances: session, onMutation, loadedInstance});
    expect(selected.errors).toBeUndefined(); expect(onMutation).not.toHaveBeenCalled();
    const created = join(home, 'created');
    const result = await executeGraphQL(source, 'mutation', {document: `mutation{createInstance(input:{path:${JSON.stringify(created)},name:"Created",description:"Created"}){instance{path}}}`}, {instances: session, onMutation, loadedInstance});
    expect(result.errors).toBeUndefined();
    expect(onMutation).toHaveBeenCalledExactlyOnceWith([created]);
  });

  it('does not notify for reads, no-op mutation journals, or failures before writes', async () => {
    const {store} = fixture(); const onMutation = vi.fn();
    const read = await executeGraphQL(store, 'query', {document: '{entries{totalCount}}'}, {onMutation});
    expect(read.errors).toBeUndefined();
    const noOp = await executeGraphQL(store, 'mutation', {document: 'mutation{capture(input:{content:"Ignored",description:"Ignored"}){error}}'}, {onMutation, mutate: () => ({text: ''})});
    expect(noOp.errors).toBeUndefined();
    const failed = await executeGraphQL(store, 'mutation', {document: 'mutation{capture(input:{content:"Never saved",description:"Never saved"}){error}}'}, {onMutation, mutate: () => {throw new Error('No writes');}});
    expect(failed.errors).toBeDefined(); expect(onMutation).not.toHaveBeenCalled();
  });

  it('reports persisted instance creation even when registration fails afterward', async () => {
    const created = join(home, 'created');
    const session = new InstanceSession(new InstanceRegistry(), lifecycleOperationsFixture({knownInstances: async () => [], instanceRecord,
      issues: async () => {throw new Error('Registration failed');}}), [], false, home);
    const onMutation = vi.fn();
    const result = await executeGraphQL(() => {throw new Error('No store');}, 'mutation', {
      document: `mutation{createInstance(input:{path:${JSON.stringify(created)},name:"Created",description:"Created"}){error}}`,
    }, {instances: session, onMutation, loadedInstance});
    expect(result.errors).toBeUndefined();
    expect((result.data!.createInstance as any).error).toContain('Registration failed');
    expect(onMutation).toHaveBeenCalledExactlyOnceWith([created]);
    expect(session.registry.activeInstance).toBeNull();
  });

  it('preserves confirmed mutation results if the maintenance callback fails', async () => {
    const {store} = fixture();
    const result = await executeGraphQL(store, 'mutation', {document: 'mutation{capture(input:{content:"Saved",description:"Saved"}){entry{id}}}'}, {
      mutate: (_operation, args: any) => handleCapture(store, args, now), onMutation: () => {throw new Error('Queue unavailable');},
    });
    expect(result.errors).toBeUndefined(); expect((result.data!.capture as any).entry.id).toBeTruthy();
    expect(store.getEntries()[0].content).toBe('Saved');
  });

  it('checks index synchronization before returning an empty semantic result without query inference', async () => {
    const {store} = fixture(); const semanticSearch = vi.fn(), semanticReconcile = vi.fn(async () => undefined);
    const result = await executeGraphQL(store, 'query', {document: '{search(rankBy:{semantic:"Deleted content"}){totalCount hits{handle}}}'}, {semanticSearch, semanticReconcile});
    expect(result.errors).toBeUndefined(); expect(result.data).toEqual({search: {totalCount: 0, hits: []}});
    expect(semanticReconcile).toHaveBeenCalledExactlyOnceWith(store, {signal: expect.any(AbortSignal)});
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('checks synchronization for filtered empty pages and rejects source drift during it', async () => {
    const {store} = fixture(); handleCapture(store, {content: 'Original', description: 'Original'}, now);
    const semanticReconcile = vi.fn(async () => {handleCapture(store, {content: 'A concurrent edit', description: 'Edit'}, new Date(2026, 9, 28, 11));});
    const result = await executeGraphQL(store, 'query', {document: '{search(where:{entries:{ids:[]}},rankBy:{semantic:"No eligible records"}){hits{handle}}}'}, {semanticReconcile});
    expect(result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Aside changed during search')})]);
    expect(semanticReconcile).toHaveBeenCalledOnce();
  });

  it('preserves structured prerequisite failures for empty semantic results', async () => {
    const {store} = fixture();
    const semanticReconcile = vi.fn(async () => {throw new SemanticSetupError('Index unavailable', {reason: 'INDEX_UNAVAILABLE', model: 'local', recovery: 'Retry'});});
    const result = await executeGraphQL(store, 'query', {document: '{search(rankBy:{semantic:"No results"}){hits{handle}}}'}, {semanticReconcile});
    expect(result.errors).toEqual([expect.objectContaining({extensions: {code: 'SEMANTIC_SEARCH_UNAVAILABLE', reason: 'INDEX_UNAVAILABLE', model: 'local', recovery: 'Retry'}})]);
  });

  it('does not force semantic maintenance for counts-only, regex, or field ordering', async () => {
    const {store} = fixture(); const semanticReconcile = vi.fn(async () => undefined);
    for (const document of ['{search(rankBy:{semantic:"Count only"}){totalCount}}', '{search(where:{entries:{regex:"anything"}}){hits{handle}}}', '{search(rankBy:{order:CREATED_DESC}){hits{handle}}}']) {
      const result = await executeGraphQL(store, 'query', {document}, {semanticReconcile});
      expect(result.errors).toBeUndefined();
    }
    expect(semanticReconcile).not.toHaveBeenCalled();
  });
});
