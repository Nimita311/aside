import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import {lifecycleOperationsFixture} from './lifecycle-operations-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/source/bootstrap.js';
import {executeGraphQLWithOwner as executeGraphQL} from './graphql-owner-fixture.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession, type InstanceBackend } from '../src/mcp/instance-session.js';
import { Store } from '../src/source/store.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';
import {createArtifact} from '../src/mcp/tools/artifact.js';
import type {InstanceRecord, ParseResult} from '../src/core/types.js';
import {lifecycleMetadataFixture} from './lifecycle-metadata-fixture.js';

const dirs: string[] = [];
afterEach(() => { access.reset(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function root() { const dir = realpathSync(mkdtempSync('/tmp/aside-gql-session-')); dirs.push(dir); return dir; }
const noRecords = () => { throw new Error('Record store must not load for session operations'); };
const metadataFixture = (paths: readonly string[]) => lifecycleMetadataFixture(...paths);
const storeMetadata = (...stores: Store[]) => (path: string): ParseResult<InstanceRecord> | undefined => {
  const store = stores.find(store => store.getDataDir() === path);
  return store ? {value: store.getInstance()!, issues: store.getIssues()} : undefined;
};

describe('GraphQL instance operations', () => {
  it('supports introspection without selecting or loading an instance', async () => {
    const backend: InstanceBackend = { knownInstances: vi.fn(async () => []), issues: vi.fn(async () => []) };
    const session = new InstanceSession(new InstanceRegistry(), lifecycleOperationsFixture(backend), [], false);
    const result = await executeGraphQL(noRecords, 'query', {
      document: '{ __type(name: "CreateInstanceInput") { inputFields { name defaultValue } } activeInstance { path } instances { path } }',
    }, { instances: session });
    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({ activeInstance: null, instances: [] });
    expect((result.data!.__type as any).inputFields).toContainEqual({ name: 'tutorial', defaultValue: 'false' });
    expect(backend.issues).not.toHaveBeenCalled();
  });

  it('exposes activeInstance as the sole root instance read and returns null without loading records when unselected', async () => {
    const backend: InstanceBackend = { knownInstances: vi.fn(async () => []), issues: vi.fn(async () => []) };
    const session = new InstanceSession(new InstanceRegistry(), lifecycleOperationsFixture(backend), [], false);
    const source = vi.fn(noRecords);
    const result = await executeGraphQL(source, 'query', {
      document: '{ __type(name: "Query") { fields { name } } activeInstance { id settings { scheduledEventTitlePrefix } body } }',
    }, { instances: session });
    expect(result.errors).toBeUndefined();
    const fields = (result.data!.__type as any).fields.map((field: { name: string }) => field.name);
    expect(fields).toContain('activeInstance');
    expect(fields).not.toContain('instance');
    expect(result.data!.activeInstance).toBeNull();
    expect(source).not.toHaveBeenCalled();
    expect(backend.issues).not.toHaveBeenCalled();
  });

  it('reads selected metadata without loading records or collecting loaded-store diagnostics', async () => {
    const path = join(root(), 'selected');
    init(path, { name: 'Selected', description: 'Selected destination', body: 'Keep summaries brief.' });
    const store = new Store(path);
    const registry = new InstanceRegistry([path]); registry.activate(path);
    const backend: InstanceBackend = { knownInstances: async () => [path], issues: vi.fn(async () => store.getIssues()) };
    const session = new InstanceSession(registry, lifecycleOperationsFixture(backend), [], false);
    const source = vi.fn(() => store);
    try {
      const result = await executeGraphQL(source, 'query', {
        document: '{ activeInstance { id name description path active workspace settings { scheduledEventTitlePrefix doneEventTitlePrefix } body } }',
      }, { instances: session, loadedInstance: storeMetadata(store) });
      expect(result.errors).toBeUndefined();
      const loaded = store.getInstance()!;
      expect(result.data!.activeInstance).toEqual({
        id: loaded.manifest.id, name: 'Selected', description: 'Selected destination', path, active: true, workspace: true,
        settings: {scheduledEventTitlePrefix: '▢ ', doneEventTitlePrefix: '✓ '}, body: 'Keep summaries brief.',
      });
      expect(source).not.toHaveBeenCalled();
      expect(backend.issues).not.toHaveBeenCalled();
    } finally { store.close(); }
  });

  it('lists selected instances passively without loading records for diagnostics', async () => {
    const path = join(root(), 'selected-listing');
    init(path, {name: 'Selected listing', description: 'Metadata only'});
    const registry = new InstanceRegistry([path]); registry.activate(path);
    const backend: InstanceBackend = {knownInstances: vi.fn(async () => [path]), issues: vi.fn(async () => [])};
    const metadata = metadataFixture([path]);
    const session = new InstanceSession(registry, lifecycleOperationsFixture(backend), [], false);
    const source = vi.fn(noRecords);
    const result = await executeGraphQL(source, 'query', {
      document: '{ instances { path active settings { scheduledEventTitlePrefix } } activeInstance { name body } }',
    }, {instances: session, loadedInstance: metadata.loadedInstance});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({instances: [{path, active: true, settings: {scheduledEventTitlePrefix: '▢ '}}], activeInstance: {name: 'Selected listing', body: ''}});
    expect(source).not.toHaveBeenCalled();
    expect(backend.issues).not.toHaveBeenCalled();
  });

  it('resolves scoped content through lifecycle-owned stores without refreshing or closing them', async () => {
    const directory = root(), active = join(directory, 'active'), other = join(directory, 'other');
    init(active, {name: 'Active', description: 'Active'});
    init(other, {name: 'Other', description: 'Other'});
    const activeStore = new Store(active), otherStore = new Store(other);
    const artifact = createArtifact(otherStore, {name: 'Instructions', description: 'Prompt', body: 'Loaded prompt'}, new Date(2026, 9, 2, 10));
    handleUpdateInstance(otherStore, {automations: {digest: {schedule: {at: '2099-01-01T00:00:00Z'},
      run: {model: 'CUSTOM', prompt: `#artifact/${artifact.id}`}}}});
    const file = otherStore.getArtifactFile(artifact.id)!;
    writeFileSync(file, readFileSync(file, 'utf8').replace('Loaded prompt', 'External prompt'));
    const registry = new InstanceRegistry([active, other]); registry.activate(active);
    const session = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [active, other], issues: async () => []}), [], false);
    const rebuild = vi.spyOn(otherStore, 'rebuild'), close = vi.spyOn(otherStore, 'close');
    const resolveStore = vi.fn((path: string) => {
      expect(path).toBe(other);
      return otherStore;
    });
    try {
      const document = '{instances{path automations{nodes{run{prompt{content{...on MarkdownContent{text}}}}}}}}';
      const result: any = await executeGraphQL(() => activeStore, 'query', {
        document,
      }, {instances: session, resolveStore, loadedInstance: storeMetadata(activeStore, otherStore)});
      expect(result.errors).toBeUndefined();
      expect(result.data.instances.find((instance: any) => instance.path === other).automations.nodes[0].run.prompt.content).toEqual({text: 'Loaded prompt'});
      expect(resolveStore).toHaveBeenCalledExactlyOnceWith(other);
      expect(rebuild).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      // A declined owner resolution must fail, without loading a temporary
      // Store or adopting the newer disk content behind the owner's back.
      const decline = vi.fn((_path: string): Store | undefined => undefined);
      access.protect([active, other]);
      const passive: any = await executeGraphQL(() => activeStore, 'query', {document},
        {instances: session, resolveStore: decline, loadedInstance: storeMetadata(activeStore, otherStore)});
      expect(passive.errors).toEqual([expect.objectContaining({extensions: expect.objectContaining({code: 'LIFECYCLE_STATE_UNAVAILABLE'})})]);
      expect(decline).toHaveBeenCalledExactlyOnceWith(other);
      expect(otherStore.getArtifact(artifact.id)!.body).toBe('Loaded prompt');
      expect(close).not.toHaveBeenCalled();
      expect(access.violations).toEqual([]);
    } finally {access.reset(); rebuild.mockRestore(); close.mockRestore(); activeStore.close(); otherStore.close();}
  });

  it('fails missing lifecycle metadata explicitly without reopening an existing manifest', async () => {
    const path = root(); init(path, {name: 'Disk metadata', description: 'Unavailable owner state'});
    const registry = new InstanceRegistry([path]); registry.activate(path);
    const session = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [path], issues: async () => []}), [], false);
    access.protect([path]);
    const result = await executeGraphQL(noRecords, 'query', {document: '{activeInstance{name body}}'}, {instances: session});
    expect(result.errors).toEqual([expect.objectContaining({extensions: expect.objectContaining({code: 'LIFECYCLE_STATE_UNAVAILABLE'})})]);
    expect(access.violations).toEqual([]);
  });

  it.each([false, true])('uses coherent loaded Store metadata when explicitly provided (session: %s)', async withSession => {
    const path = join(root(), 'snapshot');
    init(path, { name: 'Loaded name', description: 'Loaded description', body: 'Loaded instructions.' });
    const store = new Store(path);
    const registry = new InstanceRegistry(); registry.activate(path);
    const backend: InstanceBackend = { knownInstances: async () => [path], issues: async () => store.getIssues() };
    const session = new InstanceSession(registry, lifecycleOperationsFixture(backend), [], false);
    const file = join(path, 'aside.md');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('Loaded name', 'External name').replace('Loaded description', 'External description').replace('Loaded instructions.', 'External instructions.'));
    try {
      const result = await executeGraphQL(store, 'query', {
        document: '{ activeInstance { id name description path active workspace body } }',
      }, withSession ? { instances: session } : {});
      expect(result.errors).toBeUndefined();
      const loaded = store.getInstance()!;
      expect(result.data!.activeInstance).toEqual({
        id: loaded.manifest.id, name: loaded.manifest.name, description: loaded.manifest.description, path, active: true, workspace: false,
        body: loaded.body,
      });
      expect(readFileSync(file, 'utf8')).toContain('External name');
    } finally { store.close(); }
  });

  it('patches grouped settings, returns effective defaults, and preserves omitted settings', async () => {
    const path = root(); init(path, {name: 'Settings', description: 'Settings', body: 'Instructions'});
    const store = new Store(path);
    const mutate = (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('update_instance');
      handleUpdateInstance(store, args);
      return {};
    };
    const document = 'mutation($input: UpdateInstanceInput!) { updateInstance(input: $input) { instance { body settings { scheduledEventTitlePrefix doneEventTitlePrefix } } } }';
    try {
      const updated = await executeGraphQL(store, 'mutation', {document, variables: {input: {settings: {scheduledEventTitlePrefix: 'Now: ', doneEventTitlePrefix: ''}}}}, {mutate});
      expect(updated.errors).toBeUndefined();
      expect((updated.data!.updateInstance as any).instance).toEqual({body: 'Instructions', settings: {scheduledEventTitlePrefix: 'Now: ', doneEventTitlePrefix: ''}});
      const restored = await executeGraphQL(store, 'mutation', {document, variables: {input: {settings: {scheduledEventTitlePrefix: null}}}}, {mutate});
      expect(restored.errors).toBeUndefined();
      expect((restored.data!.updateInstance as any).instance.settings).toEqual({scheduledEventTitlePrefix: '▢ ', doneEventTitlePrefix: ''});
      const original = readFileSync(join(path, 'aside.md'), 'utf8');
      const rejected = await executeGraphQL(store, 'mutation', {document, variables: {input: {settings: {recurrenceLookaheadDays: null}}}}, {mutate});
      expect(rejected.errors).toHaveLength(1); expect(rejected.extensions!.mutations).toEqual([]);
      expect(readFileSync(join(path, 'aside.md'), 'utf8')).toBe(original);
    } finally {store.close();}
  });

  it.each([true, false])('keeps mixed metadata and records coherent regardless of field order (metadata first: %s)', async metadataFirst => {
    const path = root();
    const manifest = join(path, 'aside.md');
    const projects = join(path, 'projects', '2026');
    mkdirSync(projects, { recursive: true });
    writeFileSync(manifest, '---\nid: snapshot-audit\nname: Before\n---\n\nBefore instructions.\n');
    const project = join(projects, '2026-10-10-project.md');
    writeFileSync(project, '---\nname: Before project\ncreated: 2026-10-10T09:00\n---\n');
    const store = new Store(path);
    const registry = new InstanceRegistry([path]); registry.activate(path);
    const backend: InstanceBackend = {
      knownInstances: async () => [path],
      issues: vi.fn(async () => []),
    };
    const session = new InstanceSession(registry, lifecycleOperationsFixture(backend), [], false);
    const source = vi.fn(() => store);
    const metadata = 'activeInstance { name body }';
    const record = 'project(id: "2026-10-10-project") { name }';
    const args = {
      document: `{ ${metadataFirst ? `${metadata} ${record}` : `${record} ${metadata}`} }`,
    };
    try {
      // The disk metadata has moved ahead of the provided loaded Store. A mixed
      // request must use one snapshot, including when metadata is selected first.
      writeFileSync(manifest, readFileSync(manifest, 'utf8').replaceAll('Before', 'After'));
      writeFileSync(project, readFileSync(project, 'utf8').replaceAll('Before', 'After'));
      const before = await executeGraphQL(source, 'query', args, { instances: session });
      expect(before.errors).toBeUndefined();
      expect(before.data).toEqual({
        activeInstance: { name: 'Before', body: 'Before instructions.' },
        project: { name: 'Before project' },
      });
      expect(source).toHaveBeenCalledTimes(1);
      expect(backend.issues).not.toHaveBeenCalled();
      store.rebuild();
      const after = await executeGraphQL(source, 'query', args, { instances: session });
      expect(after.errors).toBeUndefined();
      expect(after.data).toEqual({
        activeInstance: { name: 'After', body: 'After instructions.' },
        project: { name: 'After project' },
      });
      expect(source).toHaveBeenCalledTimes(2);
    } finally { store.close(); }
  });

  it('retains files, recovery errors, and the previous selection after creation registration fails', async () => {
    const dir = root(), previous = join(dir, 'previous'), created = join(dir, 'created');
    init(previous, { name: 'Previous', description: 'Previous destination' });
    const registry = new InstanceRegistry([previous]); registry.activate(previous);
    const metadata = metadataFixture([previous]);
    const backend: InstanceBackend = { knownInstances: async () => [previous], instanceRecord: metadata.instanceRecord,
      issues: async () => { throw new Error('Registration failed'); } };
    const session = new InstanceSession(registry, lifecycleOperationsFixture(backend), [], false);
    const source = vi.fn(noRecords);
    const result = await executeGraphQL(source, 'mutation', {
      document: `mutation($path: String!) {
        createInstance(input: {path: $path, name: "Created", description: "Created destination"}) { instance { path } }
        capture(input: {content: "Must not write to previous instance", description: "Failed creation"}) { error }
      }`, variables: { path: created },
    }, { instances: session, loadedInstance: metadata.loadedInstance });
    expect(result.data).toMatchObject({createInstance: {instance: {path: created}}, capture: null});
    expect(result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Later mutation fields were skipped')})]);
    const outcomes = result.extensions!.mutations as any[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({operation: 'createInstance', error: expect.stringContaining('Registration failed'),
      changes: [expect.objectContaining({kind: 'instance', effect: 'CREATED', path: join(created, 'aside.md'), fields: ['manifest']})]});
    expect(outcomes[0].error).toContain('do not repeat createInstance');
    expect(outcomes[0].error).toContain('selectInstance');
    expect(existsSync(join(created, 'aside.md'))).toBe(true);
    expect(registry.activeInstance).toBe(previous);
    expect(source).not.toHaveBeenCalled();
    backend.issues = async path => {metadata.publish(path); return [];};
    const recovered = await executeGraphQL(noRecords, 'mutation', { document: 'mutation($path: String!) { selectInstance(path: $path) { instance { path active workspace } } }', variables: { path: created } }, { instances: session, loadedInstance: metadata.loadedInstance });
    expect(recovered.errors).toBeUndefined();
    expect(recovered.data).toEqual({ selectInstance: { instance: { path: created, active: true, workspace: false } } });
  });

  it('preserves configuration and duplicate-identity diagnostics in structured results', async () => {
    const dir = root(), a = join(dir, 'a'), b = join(dir, 'b');
    init(a, { name: 'Same', description: 'First' }); init(b, { name: 'Same', description: 'Second' });
    const configIssue = { severity: 'warning' as const, code: 'config_test', file: '.aside', message: 'Configuration could not be applied' };
    const metadata = metadataFixture([a, b]);
    const session = new InstanceSession(new InstanceRegistry([a]), lifecycleOperationsFixture({ knownInstances: async () => [a, b], issues: async () => [] }), [configIssue], false);
    const result = await executeGraphQL(noRecords, 'query', { document: '{ instances { id path workspace active } }' }, { instances: session, loadedInstance: metadata.loadedInstance });
    expect(result.errors).toBeUndefined();
    expect(result.data!.instances).toEqual([{ id: 'same', path: a, workspace: true, active: false }, { id: 'same', path: b, workspace: false, active: false }]);
    expect(result.extensions).toMatchObject({ complete: false, diagnostics: expect.arrayContaining([configIssue, expect.objectContaining({ code: 'instance_id_conflict' })]) });
    expect((result.extensions!.diagnostics as any[]).find(issue => issue.code === 'instance_id_conflict').message).toContain(b);
  });

  it('retains an earlier successful selection and error when a later selection stops the document', async () => {
    const dir = root(), existing = join(dir, 'existing'), missing = join(dir, 'missing'), created = join(dir, 'created');
    init(existing, { name: 'Existing', description: 'Existing destination' });
    const registry = new InstanceRegistry();
    const metadata = metadataFixture([existing]);
    const session = new InstanceSession(registry, lifecycleOperationsFixture({ knownInstances: async () => [existing], issues: async () => [], instanceRecord: metadata.instanceRecord }), [], false);
    const result = await executeGraphQL(noRecords, 'mutation', {
      document: `mutation($existing: String!, $missing: String!, $created: String!) {
        first: selectInstance(path: $existing) { error }
        failed: selectInstance(path: $missing) { error }
        createInstance(input: {path: $created, name: "Created", description: "Must not be created"}) { error }
      }`, variables: { existing, missing, created },
    }, { instances: session, loadedInstance: metadata.loadedInstance });
    expect(result.data).toEqual({first: {error: null}, failed: null, createInstance: null});
    expect(result.errors).toHaveLength(2);
    expect(result.extensions!.mutations).toEqual([{operation: 'selectInstance', error: null, changes: []}]);
    expect(registry.activeInstance).toBe(existing);
    expect(existsSync(created)).toBe(false);
  });

  it('validates the entire document and creation inputs before saving files', async () => {
    const path = join(root(), 'created');
    const session = new InstanceSession(new InstanceRegistry(), lifecycleOperationsFixture({ knownInstances: async () => [], issues: async () => [], instanceRecord: async () => undefined }), [], false);
    const document = 'mutation($path: String!) { createInstance(input: {path: $path, name: "Created", description: "Destination"}) { error } nonexistent }';
    const invalid = await executeGraphQL(noRecords, 'mutation', { document, variables: { path } }, { instances: session });
    expect(invalid.errors).toBeDefined(); expect(existsSync(path)).toBe(false);
    const emptyName = await executeGraphQL(noRecords, 'mutation', { document: 'mutation($path: String!) { createInstance(input: {path: $path, name: "", description: "Destination"}) { error } }', variables: { path } }, { instances: session });
    expect(emptyName.errors).toBeDefined(); expect(existsSync(path)).toBe(false);
  });
});
