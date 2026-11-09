import {afterEach, describe, expect, it, vi} from 'vitest';
import {lifecycleOperationsFixture} from './lifecycle-operations-fixture.js';
import {appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {parse} from 'graphql';
import {GraphQLUsageLog, queryShape, usageDirectory, usageBaseDirectory, legacyUsageDirectory, type UsageEvent} from '../src/graphql/usage.js';
import {executeGraphQLWithOwner as executeGraphQL} from './graphql-owner-fixture.js';
import {Store} from '../src/source/store.js';
import {InstanceSession} from '../src/mcp/instance-session.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {handleCapture} from '../src/mcp/tools/capture.js';
import {handleUpdateInstance} from '../src/mcp/tools/instance.js';
import {recordMutationChange, MutationWriteError} from '../src/source/mutation-result.js';
import {summarizeUsage, runUsage} from '../src/commands/usage.js';
import {parseCli} from '../src/commands/options.js';
import {InstanceHost, instanceKey} from '../src/daemon/host.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {lifecycleMetadataFixture} from './lifecycle-metadata-fixture.js';
import {hostGraphQL} from './support/graphql-host.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {...actual, realpathSync: vi.fn(actual.realpathSync)};
});

const roots: string[] = [], stores: Store[] = [], writers: GraphQLUsageLog[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/aside-usage-')); roots.push(root);
  writeFileSync(join(root, 'aside.md'), '---\nid: usage-fixture\nname: Usage fixture\n---\n');
  return root;
}
function store(root: string) { const value = new Store(root); stores.push(value); return value; }
function logger(options = {}) { const value = new GraphQLUsageLog(options); writers.push(value); return value; }
function events(root: string): UsageEvent[] {
  const directory = usageDirectory(root);
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort()
    .flatMap(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))) : [];
}
function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {schemaVersion: 1, timestamp: new Date().toISOString(), requestId: 'fixture', operation: 'query', shape: 'query{entries{count}}',
    shapeHash: 'shape', fields: ['entries', 'entries.count'], durationMs: 12, outcome: 'success', errorCategory: null, errorCount: 0,
    effects: {created: 0, updated: 0, removed: 0}, ...overrides};
}
afterEach(async () => {
  await Promise.all(writers.splice(0).map(value => value.flush()));
  stores.splice(0).forEach(value => value.close());
  roots.splice(0).forEach(root => {
    rmSync(usageDirectory(root), {recursive: true, force: true});
    rmSync(root, {recursive: true, force: true});
  });
  vi.restoreAllMocks();
});

describe('per-instance GraphQL usage', () => {
  it('keeps the captured request identity when the manifest changes before the log is appended', async () => {
    const root = fixture(), usageLog = logger();
    const request = usageLog.start('query');
    request.touch(root, 'published-identity');
    writeFileSync(join(root, 'aside.md'), '---\nid: unpublished-identity\n---\n');
    request.finish({data: {entries: {count: 0}}}, root, false);
    await usageLog.flush();
    expect(JSON.parse(readFileSync(join(usageDirectory(root), 'instance.json'), 'utf8'))).toEqual({schemaVersion: 1, path: root, id: 'published-identity'});
    expect(usageLog.status()).toMatchObject({dropped: 0, errors: 0});
  });

  it('appends captured usage without requiring a source manifest to remain readable', async () => {
    const root = fixture(), usageLog = logger();
    usageLog.record(root, event(), 'published-identity');
    rmSync(join(root, 'aside.md'));
    await usageLog.flush();
    expect(events(root)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(usageDirectory(root), 'instance.json'), 'utf8'))).toMatchObject({id: 'published-identity'});
    expect(usageLog.status()).toMatchObject({dropped: 0, errors: 0});
  });

  it('attributes showUrl without retaining its private file URL', async () => {
    const root = fixture(), usageLog = logger();
    const metadata = lifecycleMetadataFixture(root);
    const registry = new InstanceRegistry([root]); registry.activate(root);
    const instances = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [root], issues: async () => [], instanceRecord: metadata.instanceRecord}));
    const privateUrl = 'file:///private/aside-handoff-do-not-log.html';
    const result = await executeGraphQL(() => { throw new Error('No records needed'); }, 'mutation',
      {document: 'mutation { showUrl }'}, {instances, usageLog, loadedInstance: metadata.loadedInstance, showUrl: async () => privateUrl});
    expect(result.errors).toBeUndefined();
    expect(result.data!.showUrl).toBe(privateUrl);
    await usageLog.flush();
    expect(events(root)).toHaveLength(1);
    expect(events(root)[0]).toMatchObject({operation: 'mutation', fields: ['showUrl'], outcome: 'success', effects: {created: 0, updated: 0, removed: 0}});
    expect(JSON.stringify(events(root))).not.toContain(privateUrl);
  });

  it('logs reads and mutations through the real host, but no artifact tool or schema-resource reads', async () => {
    const root = fixture();
    const host = new InstanceHost(new CalClient(null));
    try {
      await hostGraphQL(host, root, 'query', {document: '{ entries { count } }'});
      await hostGraphQL(host, root, 'mutate', {document: 'mutation { capture(input:{content:"private content",description:"private description"}) { entry { id } error } }'});
      await host.tool(root, 'query_artifacts', {});
      const registry = new InstanceRegistry([root]); registry.activate(root);
      await host.graphqlSchema(new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [root], issues: async () => [],
        instanceRecord: async path => host.metadata(path)})));
    } finally { await host.close(); }
    const logged = events(root);
    expect(logged.map(value => value.operation)).toEqual(['query', 'mutation']);
    expect(logged.every(value => value.outcome === 'success')).toBe(true);
    expect(logged[1].effects.created).toBeGreaterThan(0);
    const text = JSON.stringify(logged);
    expect(text).not.toContain('private content'); expect(text).not.toContain('private description'); expect(text).not.toContain(root);
    expect(JSON.parse(readFileSync(join(usageDirectory(root), 'instance.json'), 'utf8'))).toEqual({schemaVersion: 1, path: root, id: 'usage-fixture'});
    expect(existsSync(join(root, '.aside-logs'))).toBe(false);
    expect(statSync(usageDirectory(root)).mode & 0o777).toBe(0o700);
    const file = join(usageDirectory(root), readdirSync(usageDirectory(root))[0]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('normalizes literals, variables, aliases, operation names and fragment names in the selected operation', () => {
    const first = queryShape(parse('query SecretName($private: ID!) { personal: entry(id:$private) {...SecretFragment} } fragment SecretFragment on Entry { id body } query Unused { __typename }'), 'SecretName');
    const second = queryShape(parse('query Other { entry(id:"secret record") {...OtherFragment} } fragment OtherFragment on Entry { id body }'), 'Other');
    expect(first).toEqual(second);
    expect(first!.fields).toEqual(['entry', 'entry.body', 'entry.id']);
    expect(JSON.stringify(first)).not.toMatch(/Secret|private|personal|Unused|secret record/);
  });

  it('isolates requests and attributes selection changes and confirmed writes to their actual instances', async () => {
    const a = fixture(), b = fixture(), aStore = store(a), bStore = store(b), usageLog = logger();
    const metadata = lifecycleMetadataFixture(a, b);
    const registry = new InstanceRegistry([a, b]); registry.activate(a);
    const instances = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [a, b], issues: async () => [], instanceRecord: metadata.instanceRecord}), [], false);
    const active = () => instances.requireInstance() === a ? aStore : bStore;
    await executeGraphQL(active, 'query', {document: '{entries {count}}'}, {instances, usageLog, loadedInstance: metadata.loadedInstance});
    const result = await executeGraphQL(active, 'mutation', {
      document: 'mutation($destination:String!) { first:capture(input:{content:"First secret",description:"First"}){error} selectInstance(path:$destination){error} second:updateInstance(input:{body:"Second secret"}){error} }',
      variables: {destination: b},
    }, {instances, usageLog, loadedInstance: metadata.loadedInstance,
      mutate: (operation, args: any) => {
        if (operation === 'capture') return handleCapture(active(), args);
        handleUpdateInstance(active(), args);
        return {};
      }});
    expect(result.errors).toBeUndefined();
    await usageLog.flush();
    expect(events(a)).toHaveLength(2); expect(events(b)).toHaveLength(1);
    const aEvent = events(a)[1], bEvent = events(b)[0];
    expect(aEvent.requestId).toBe(bEvent.requestId);
    expect(aEvent.effects.created).toBeGreaterThan(0); expect(aEvent.effects.updated).toBe(0);
    expect(bEvent.effects.created).toBe(0); expect(bEvent.effects.updated).toBeGreaterThan(0);
    expect(JSON.stringify([...events(a), ...events(b)])).not.toMatch(/First secret|Second secret/);
  });

  it('logs instance creation in the new instance instead of the previously active one', async () => {
    const a = fixture(), usageLog = logger();
    const b = join(a, 'new-instance');
    const metadata = lifecycleMetadataFixture(a);
    const registry = new InstanceRegistry([a]); registry.activate(a);
    const instances = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [a], issues: async () => [], instanceRecord: metadata.instanceRecord,
      created: async (path: string) => {metadata.publish(path); return [];}}), [], false);
    const result = await executeGraphQL(() => { throw new Error('Must stay passive'); }, 'mutation', {
      document: 'mutation($path:String!){createInstance(input:{path:$path,name:"New",description:"New"}){error}}', variables: {path: b},
    }, {instances, usageLog, loadedInstance: metadata.loadedInstance});
    expect(result.errors).toBeUndefined(); await usageLog.flush();
    expect(events(a)).toHaveLength(0); expect(events(b)).toHaveLength(1);
    expect(events(b)[0].effects.created).toBeGreaterThan(0);
  });

  it('leaves unscoped discovery and introspection unlogged without loading records', async () => {
    const root = fixture(), usageLog = logger();
    const metadata = lifecycleMetadataFixture(root);
    const instances = new InstanceSession(new InstanceRegistry([]), lifecycleOperationsFixture({knownInstances: async () => [root], issues: async () => [], instanceRecord: metadata.instanceRecord}), [], false);
    const result = await executeGraphQL(() => { throw new Error('Must stay passive'); }, 'query', {document: '{instances {id} __schema {queryType {name}}}'},
      {instances, usageLog, loadedInstance: metadata.loadedInstance});
    expect(result.errors).toBeUndefined(); await usageLog.flush(); expect(events(root)).toEqual([]);
  });

  it('captures validation, partial writes and cancellation without retaining error messages', async () => {
    const root = fixture(), value = store(root), usageLog = logger();
    await executeGraphQL(value, 'query', {document: '{ missingField }'}, {usageLog});
    await executeGraphQL(value, 'mutation', {document: 'mutation{updateInstance(input:{body:"secret"}){error}}'}, {usageLog, mutate: () => {
      const change = {kind: 'instance' as const, id: 'usage-fixture', effect: 'UPDATED' as const, path: join(root, 'aside.md')};
      recordMutationChange(value, change);
      throw new MutationWriteError(new Error('sensitive error message'), {status: 'PARTIAL', changes: [change], failures: [{message: 'sensitive error message'}]});
    }});
    const controller = new AbortController(); controller.abort();
    await executeGraphQL(value, 'query', {document: '{entries{count}}'}, {usageLog, signal: controller.signal});
    await usageLog.flush();
    expect(events(root).map(event => event.outcome)).toEqual(['failure', 'partial', 'cancelled']);
    expect(events(root)[0].errorCategory).toBe('validation');
    expect(events(root)[1].effects.updated).toBe(1);
    expect(JSON.stringify(events(root))).not.toContain('sensitive error message');
  });

  it('distinguishes query variable validation from instance-access failures', async () => {
    const root = fixture(), value = store(root), usageLog = logger();
    for (const variables of [{}, {id: {unexpected: 'secret'}}]) {
      const result = await executeGraphQL(value, 'query', {document: 'query($id:ID!){entry(id:$id){id}}', variables}, {usageLog});
      expect(result.errors).toBeDefined();
    }
    const metadata = lifecycleMetadataFixture(root);
    const registry = new InstanceRegistry([root]); registry.activate(root);
    const instances = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [root], issues: async () => [], instanceRecord: metadata.instanceRecord}));
    const unavailable = await executeGraphQL(() => { throw new Error('Instance unavailable'); }, 'query',
      {document: '{entries{count}}'}, {instances, usageLog, loadedInstance: () => ({value: value.getInstance()!, issues: []})});
    expect(unavailable.errors).toBeDefined();
    await usageLog.flush();
    expect(events(root).map(event => event.errorCategory)).toEqual(['validation', 'validation', 'execution']);
    expect(events(root).every(event => event.outcome === 'failure')).toBe(true);
  });

  it('does not invent log attribution for an unobserved passive selection', async () => {
    const root = fixture(), usageLog = logger();
    const metadata = lifecycleMetadataFixture();
    const registry = new InstanceRegistry([root]); registry.activate(root);
    const instances = new InstanceSession(registry, lifecycleOperationsFixture({knownInstances: async () => [root], issues: async () => [], instanceRecord: metadata.instanceRecord}));
    const source = vi.fn(() => {throw new Error('Static inspection must not activate a source');});
    const result = await executeGraphQL(source, 'query', {document: '{__typename}'}, {instances, usageLog, loadedInstance: metadata.loadedInstance});
    await usageLog.flush();
    expect(result.errors).toBeUndefined(); expect(source).not.toHaveBeenCalled();
    expect(events(root)).toEqual([]);
  });

  it('preserves the next completed event after a crash leaves an unterminated line', async () => {
    const root = fixture(), usageLog = logger();
    usageLog.record(root, event({requestId: 'before-crash'})); await usageLog.flush();
    const file = join(usageDirectory(root), readdirSync(usageDirectory(root)).find(name => name.endsWith('.jsonl'))!);
    appendFileSync(file, '{"requestId":"interrupted');
    usageLog.record(root, event({requestId: 'after-crash'})); await usageLog.flush();
    const summary = await summarizeUsage(root, new Date(Date.now() - 60_000));
    expect(summary).toMatchObject({total: 2, malformedLines: 1});
    expect(readFileSync(file, 'utf8').split('\n').filter(line => line.includes('after-crash')).map(line => JSON.parse(line).requestId)).toEqual(['after-crash']);
  });

  it('keeps GraphQL operational when logging is blocked and does not follow directory symlinks', async () => {
    const root = fixture(), outside = fixture(), value = store(root), usageLog = logger();
    mkdirSync(usageBaseDirectory(), {recursive: true});
    symlinkSync(outside, usageDirectory(root));
    const result = await executeGraphQL(value, 'query', {document: '{entries{count}}'}, {usageLog});
    expect(result.errors).toBeUndefined(); await usageLog.flush();
    expect(usageLog.status()).toMatchObject({errors: 1, dropped: 1, queuedBytes: 0});
    expect(readdirSync(outside)).toEqual(['aside.md']);
  });

  it('serializes concurrent appends, rotates and prunes each instance independently', async () => {
    const a = fixture(), b = fixture(), usageLog = logger({maxBytes: 1800, segmentBytes: 650});
    mkdirSync(usageDirectory(a), {recursive: true});
    writeFileSync(join(usageDirectory(a), '2000-01-01-001.jsonl'), JSON.stringify(event()) + '\n');
    usageLog.record(b, event({requestId: 'b'}));
    for (let i = 0; i < 10; i++) usageLog.record(a, event({requestId: `a-${i}`}));
    await usageLog.flush();
    const names = readdirSync(usageDirectory(a)).filter(name => name.endsWith('.jsonl'));
    expect(names).not.toContain('2000-01-01-001.jsonl');
    expect(names.length).toBeGreaterThan(1);
    expect(names.reduce((sum, name) => sum + statSync(join(usageDirectory(a), name)).size, 0)).toBeLessThanOrEqual(1800);
    expect(events(a).at(-1)!.requestId).toBe('a-9'); expect(events(b)[0].requestId).toBe('b');
    expect(usageLog.status()).toMatchObject({dropped: 0, errors: 0});
  });

  it('drops excess queued events instead of blocking and leaves the instance working tree untouched', async () => {
    const root = fixture(), usageLog = logger({queueBytes: 1});
    usageLog.record(root, event()); await usageLog.flush();
    expect(usageLog.status().dropped).toBe(1); expect(events(root)).toEqual([]);
    const working = logger(); working.record(root, event()); await working.flush();
    execFileSync('git', ['init', '-q', root]);
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], {encoding: 'utf8'})).toBe('?? aside.md\n');
  });

  it('summarizes offline with time filtering, percentiles and tolerant truncated-line handling', async () => {
    const root = fixture(), usageLog = logger();
    for (let i = 1; i <= 20; i++) usageLog.record(root, event({requestId: String(i), durationMs: i}));
    usageLog.record(root, event({timestamp: '2000-01-01T00:00:00Z', durationMs: 999}));
    await usageLog.flush();
    const file = join(usageDirectory(root), readdirSync(usageDirectory(root)).find(name => name.endsWith('.jsonl'))!);
    writeFileSync(file, readFileSync(file, 'utf8') + '{truncated\n{}\n');
    const summary = await summarizeUsage(root, new Date(Date.now() - 60_000));
    expect(summary).toMatchObject({total: 20, operations: {query: 20, mutation: 0}, latencyMs: {p50: 10, p95: 19}, malformedLines: 2});
    const outputs: string[] = [];
    await runUsage(['summary', '--dir', root, '--since', '7d', '--json'], root, text => outputs.push(text));
    expect(JSON.parse(outputs[0])).toMatchObject({ok: true, command: 'usage summary', data: {total: 20}});
    expect(() => parseCli(['usage', 'summary', '--since', '0d'])).toThrow(/positive day duration/);
    expect(events(fixture())).toEqual([]);
  });

  it.skipIf(!existsSync(join(__dirname, '../dist/main.js')))('ships an offline summary command without starting a daemon', async () => {
    const root = fixture(), daemonHome = join(root, 'offline-daemon'), usageLog = logger({logs: join(daemonHome, 'logs')});
    usageLog.record(root, event({operation: 'mutation', effects: {created: 2, updated: 1, removed: 0}}));
    await usageLog.flush();
    const text = execFileSync(process.execPath, [join(__dirname, '../dist/main.js'), 'usage', 'summary', '--since', '7d', '--json'],
      {cwd: root, encoding: 'utf8', env: {...process.env, ASIDE_DAEMON_HOME: daemonHome}});
    expect(JSON.parse(text)).toMatchObject({ok: true, command: 'usage summary', data: {total: 1, operations: {query: 0, mutation: 1}, effects: {created: 2, updated: 1, removed: 0}}});
    expect(existsSync(join(daemonHome, 'daemon.sock'))).toBe(false);
    expect(existsSync(join(daemonHome, 'known.json'))).toBe(false);
  });

  it('uses owner-normalized aliases for one bucket and keeps duplicate IDs in separate buckets', async () => {
    const a = fixture(), b = fixture(), usageLog = logger();
    const alias = join(b, 'alias'); symlinkSync(a, alias);
    const admittedAlias = instanceKey(alias);
    expect(admittedAlias).toBe(a);
    expect(usageDirectory(admittedAlias)).toBe(usageDirectory(a));
    expect(usageDirectory(b)).not.toBe(usageDirectory(a));
    usageLog.record(a, event(), 'usage-fixture'); usageLog.record(admittedAlias, event({requestId: 'alias'}), 'usage-fixture'); usageLog.record(b, event(), 'usage-fixture'); await usageLog.flush();
    expect(events(a)).toHaveLength(2);
    for (const root of [a, b]) expect(JSON.parse(readFileSync(join(usageDirectory(root), 'instance.json'), 'utf8'))).toMatchObject({path: root, id: 'usage-fixture'});
  });

  it('never probes an instance root after admission, including a removed root and retargeted alias', async () => {
    const a = fixture(), b = fixture(), usageLog = logger();
    const alias = join(b, 'alias'); symlinkSync(a, alias);
    const admittedRoot = instanceKey(alias);
    rmSync(a, {recursive: true}); rmSync(alias); symlinkSync(b, alias);
    const resolveSource = vi.mocked(realpathSync); resolveSource.mockClear();
    const request = usageLog.start('mutation');
    request.touch(admittedRoot, 'published-identity');
    request.changes(admittedRoot, [{kind: 'instance', id: 'published-identity', effect: 'UPDATED', path: join(admittedRoot, 'aside.md')}], 'published-identity');
    request.finish({data: {updateInstance: {error: null}}}, admittedRoot, false);
    usageLog.record(admittedRoot, event({requestId: 'direct'}), 'published-identity');
    await usageLog.flush();
    expect(resolveSource).not.toHaveBeenCalled();
    expect(events(admittedRoot)).toHaveLength(2); expect(events(b)).toEqual([]);
    expect(JSON.parse(readFileSync(join(usageDirectory(admittedRoot), 'instance.json'), 'utf8')))
      .toEqual({schemaVersion: 1, path: a, id: 'published-identity'});
    expect(usageLog.status()).toMatchObject({dropped: 0, errors: 0});
  });

  it('uses the daemon-configured log folder and reads legacy logs without moving them', async () => {
    const root = fixture(), logs = join(fixture(), 'custom-logs');
    const host = new InstanceHost(new CalClient(null)); host.configureUsage(logs);
    try { await hostGraphQL(host, root, 'query', {document: '{entries{count}}'}); } finally { await host.close(); }
    expect(existsSync(join(usageDirectory(root, logs), 'instance.json'))).toBe(true);
    expect(existsSync(usageDirectory(root))).toBe(false);
    mkdirSync(legacyUsageDirectory(root), {recursive: true});
    const legacy = join(legacyUsageDirectory(root), '2026-10-11-001.jsonl');
    const original = JSON.stringify(event({requestId: 'legacy'})) + '\n'; writeFileSync(legacy, original);
    const summary = await summarizeUsage(root, new Date(Date.now() - 60_000), new Date(), logs);
    expect(summary.total).toBe(2);
    expect(summary.directories).toEqual([usageDirectory(root, logs), legacyUsageDirectory(root)]);
    expect(readFileSync(legacy, 'utf8')).toBe(original);
  });
});
