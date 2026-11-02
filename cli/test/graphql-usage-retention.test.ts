import {afterEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GraphQLUsageLog, usageBaseDirectory, usageDirectory, type UsageEvent} from '../src/graphql/usage.js';

const temporary: string[] = [];
const writers: GraphQLUsageLog[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aside-usage-retention-')));
  temporary.push(root);
  writeFileSync(join(root, 'aside.md'), '---\nid: retention-fixture\nname: Retention fixture\n---\n');
  return root;
}
function writer(logs: string, options = {}) {
  const value = new GraphQLUsageLog({logs, ...options}); writers.push(value); return value;
}
function event(requestId = 'fixture'): UsageEvent {
  return {schemaVersion: 1, timestamp: new Date(Date.now()).toISOString(), requestId, operation: 'query',
    shape: 'query{entries{count}}', shapeHash: 'shape', fields: ['entries', 'entries.count'], durationMs: 1,
    outcome: 'success', errorCategory: null, errorCount: 0, effects: {created: 0, updated: 0, removed: 0}};
}
function seed(root: string, logs: string, files: Record<string, string>) {
  const directory = usageDirectory(root, logs); mkdirSync(directory, {recursive: true});
  writeFileSync(join(directory, 'instance.json'), JSON.stringify({schemaVersion: 1, path: root, id: 'retention-fixture'}));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body);
  return directory;
}
afterEach(async () => {
  await Promise.all(writers.splice(0).map(value => value.flush()));
  vi.restoreAllMocks();
  temporary.splice(0).forEach(root => rmSync(root, {recursive: true, force: true}));
});

describe('GraphQL diagnostic cleanup', () => {
  it('does not create directories when there are no collections', async () => {
    const logs = join(fixture(), 'logs'), value = writer(logs);
    expect(await value.cleanup()).toEqual({files: 0, collections: 0});
    expect(await value.purge()).toEqual({files: 0, collections: 0});
    expect(existsSync(logs)).toBe(false);
  });

  it('expires inactive and deleted instances at the age cutoff and removes their association metadata', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-01T00:00:00Z'));
    const a = fixture(), b = fixture(), logs = join(fixture(), 'logs'), value = writer(logs, {retentionDays: 2});
    value.record(a, event('old')); await value.flush();
    const oldDirectory = usageDirectory(a, logs);
    rmSync(a, {recursive: true});
    now.mockReturnValue(Date.parse('2026-10-02T00:00:00Z'));
    value.record(b, event('fresh')); await value.flush();
    now.mockReturnValue(Date.parse('2026-10-02T23:59:59.999Z'));
    expect(await value.cleanup()).toEqual({files: 0, collections: 0});
    now.mockReturnValue(Date.parse('2026-10-03T00:00:00Z'));
    expect(await value.cleanup()).toEqual({files: 1, collections: 1});
    expect(existsSync(oldDirectory)).toBe(false);
    expect(readdirSync(usageDirectory(b, logs))).toEqual(['2026-10-02-001.jsonl', 'instance.json']);
  });

  it('enforces the byte cap without reserving append bytes and deletes the oldest segments first', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-17T12:00:00Z'));
    const logs = join(fixture(), 'logs'), root = join(fixture(), 'removed-instance');
    const directory = seed(root, logs, {'2026-10-15-001.jsonl': 'a'.repeat(400), '2026-10-16-001.jsonl': 'b'.repeat(400), '2026-10-17-001.jsonl': 'c'.repeat(200)});
    const value = writer(logs, {maxBytes: 1000});
    expect(await value.cleanup()).toEqual({files: 0, collections: 0});
    writeFileSync(join(directory, '2026-10-17-002.jsonl'), 'd');
    expect(await value.cleanup()).toEqual({files: 1, collections: 0});
    expect(readdirSync(directory)).toEqual(['2026-10-16-001.jsonl', '2026-10-17-001.jsonl', '2026-10-17-002.jsonl', 'instance.json']);
  });

  it('purges a canonical alias or a deleted instance path without touching another instance', async () => {
    const a = fixture(), b = fixture(), logs = join(fixture(), 'logs'), value = writer(logs);
    value.record(a, event()); value.record(b, event()); await value.flush();
    const alias = join(fixture(), 'alias'); symlinkSync(a, alias);
    expect(await value.purge(alias)).toEqual({files: 1, collections: 1});
    expect(existsSync(usageDirectory(b, logs))).toBe(true);
    rmSync(b, {recursive: true});
    expect(await value.purge(b)).toEqual({files: 1, collections: 1});
    expect(await value.purge(a)).toEqual({files: 0, collections: 0});
  });

  it('serializes a purge between queued appends without orphaning or discarding the later append', async () => {
    const root = fixture(), logs = join(fixture(), 'logs'), value = writer(logs);
    value.record(root, event('before'));
    const purge = value.purge(root);
    value.record(root, event('after'));
    expect(await purge).toEqual({files: 1, collections: 1});
    await value.flush();
    const directory = usageDirectory(root, logs);
    const data = readdirSync(directory).filter(name => name.endsWith('.jsonl')).map(name => readFileSync(join(directory, name), 'utf8')).join('');
    expect(data).toContain('"requestId":"after"');
    expect(data).not.toContain('"requestId":"before"');
    expect(value.status()).toEqual({queuedBytes: 0, dropped: 0, errors: 0});
  });

  it('sweeps all collections and removes metadata-only buckets', async () => {
    const logs = join(fixture(), 'logs'), roots = [fixture(), fixture(), fixture()], value = writer(logs);
    roots.forEach(root => value.record(root, event())); await value.flush();
    const empty = seed(join(fixture(), 'removed'), logs, {});
    expect(await value.purge()).toEqual({files: 3, collections: 4});
    expect(existsSync(empty)).toBe(false);
    expect(readdirSync(usageBaseDirectory(logs))).toEqual([]);
  });

  it.each(['cleanup', 'purge'] as const)('awaits every bucket before reporting a %s failure', async operation => {
    const logs = join(fixture(), 'logs'), value = writer(logs);
    const failing = seed(fixture(), logs, {'2000-01-01-001.jsonl': 'expired'});
    const slow = seed(fixture(), logs, {'2000-01-01-001.jsonl': 'expired'});
    const internal = value as unknown as {prune(directory: string, purge: boolean, reservedBytes: number): Promise<{files: unknown[]; removed: number}>};
    const prune = internal.prune.bind(value);
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => {release = resolve;});
    const entered = new Promise<void>(resolve => {started = resolve;});
    vi.spyOn(internal, 'prune').mockImplementation(async (directory, purge, reservedBytes) => {
      if (directory === failing) throw new Error('Synthetic bucket failure');
      if (directory === slow) {started(); await blocked;}
      return prune(directory, purge, reservedBytes);
    });
    const result = value[operation]();
    let settled = false;
    void result.then(() => {settled = true;}, () => {settled = true;});
    try {
      await entered;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {release();}
    await expect(result).rejects.toThrow('Synthetic bucket failure');
    expect(existsSync(slow)).toBe(false);
    expect(existsSync(failing)).toBe(true);
  });

  it('never follows log-root or base-directory symlinks', async () => {
    const outside = fixture(), parent = fixture(), logs = join(parent, 'logs');
    writeFileSync(join(outside, '2000-01-01-001.jsonl'), 'outside');
    symlinkSync(outside, logs);
    await expect(writer(logs).purge()).rejects.toThrow('Invalid log directory');
    rmSync(logs); mkdirSync(logs); symlinkSync(outside, usageBaseDirectory(logs));
    await expect(writer(logs).cleanup()).rejects.toThrow('Invalid log directory');
    expect(readFileSync(join(outside, '2000-01-01-001.jsonl'), 'utf8')).toBe('outside');
  });

  it('leaves symlink buckets, symlink segments, foreign files and non-regular metadata intact', async () => {
    const logs = join(fixture(), 'logs'), outside = fixture(), a = fixture(), b = fixture(), c = fixture(), value = writer(logs);
    const marker = join(outside, '2000-01-01-001.jsonl'); writeFileSync(marker, 'outside');
    const aDirectory = seed(a, logs, {'2000-01-01-001.jsonl': 'expired', 'foreign.txt': 'foreign'});
    symlinkSync(marker, join(aDirectory, '2000-01-01-002.jsonl'));
    symlinkSync(outside, usageDirectory(b, logs));
    const cDirectory = seed(c, logs, {}); rmSync(join(cDirectory, 'instance.json'));
    symlinkSync(marker, join(cDirectory, 'instance.json'));
    expect(await value.cleanup()).toEqual({files: 1, collections: 0});
    expect(await value.purge()).toEqual({files: 0, collections: 0});
    expect(readFileSync(marker, 'utf8')).toBe('outside');
    expect(readFileSync(join(aDirectory, 'foreign.txt'), 'utf8')).toBe('foreign');
    expect(existsSync(join(aDirectory, 'instance.json'))).toBe(true);
    expect(existsSync(join(cDirectory, 'instance.json'))).toBe(true);
  });
});
