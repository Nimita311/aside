import {afterEach, describe, expect, it, vi} from 'vitest';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../src/source/store.js';
import {InstanceReadCache, readInstanceData} from '../src/core/reader.js';
import * as parser from '../src/core/parser.js';
import {searchSourceVersion, assertSearchSourceReadable} from '../src/semantic/source-version.js';
import {handleUpdateInstance} from '../src/mcp/tools/instance.js';
import {executeGraphQL} from '../src/graphql/schema.js';
import * as history from '../src/source/recurrence-history.js';

const fixtures: Array<{root: string; store?: Store}> = [];
afterEach(() => {vi.restoreAllMocks(); for (const f of fixtures.splice(0)) {f.store?.close(); rmSync(f.root, {recursive: true, force: true});}});
function fixture(withStore = true) {
  const root = mkdtempSync('/private/tmp/aside-store-freshness-');
  mkdirSync(join(root, 'projects', '2026'), {recursive: true});
  writeFileSync(join(root, 'aside.md'), '---\nid: freshness\nname: Freshness\n---\n');
  const file = join(root, 'projects', '2026', 'item.md');
  const text = '---\nname: Original\ncreated: 2026-06-01\n---\nOriginal content.\n';
  writeFileSync(file, text);
  const value = {root, file, text, ...(withStore ? {store: new Store(root)} : {})};
  fixtures.push(value); return value;
}

describe('exact-byte source freshness reuse', () => {
  it('publishes the loaded content hash before notifying consumers and retrieves it without walking records', () => {
    const f = fixture(), store = f.store!;
    const original = store.getSourceVersion();
    const reads = vi.spyOn(store, 'getEntries').mockImplementation(() => {throw new Error('Retrieval must not hash records');});
    expect(searchSourceVersion(store)).toBe(original);
    expect(store.getSourceVersion()).toBe(original);
    reads.mockRestore();
    const published: string[] = [];
    store.onChange(() => published.push(store.getSourceVersion()));
    writeFileSync(f.file, f.text.replace('Original content.', 'Changed content.'));
    store.rebuild();
    expect(published).toEqual([store.getSourceVersion()]);
    expect(published[0]).not.toBe(original);
    writeFileSync(join(f.root, 'projects', '2026', 'index.yaml'), '- id: item\n  description: Original description\n');
    store.rebuild(); const indexed = store.getSourceVersion();
    expect(store.setIndexEntry('projects', 'item', 'Changed description')).toBe(true);
    expect(store.getSourceVersion()).not.toBe(indexed);
    expect(published.at(-1)).toBe(store.getSourceVersion());
  });

  it('publishes source refresh failures instead of allowing the previous hash to certify readable content', () => {
    const f = fixture(), store = f.store!, original = store.getSourceVersion();
    const changed = vi.fn(); store.onChange(changed);
    store.recordRebuildFailure(new Error('Temporary source read failure'));
    expect(store.getSourceVersion()).not.toBe(original);
    expect(() => assertSearchSourceReadable(store)).toThrow('rebuild_failed');
    store.recordRebuildFailure(new Error('Temporary source read failure'));
    expect(changed).toHaveBeenCalledOnce();
    store.rebuild();
    expect(store.getSourceVersion()).toBe(original);
    expect(() => assertSearchSourceReadable(store)).not.toThrow();
  });

  it('invalidates a previously published snapshot when durable instance changes fail readback', () => {
    const f = fixture(), store = f.store!, original = store.getSourceVersion();
    vi.spyOn((store as any).core, 'upsertInstance').mockImplementationOnce(() => {throw new Error('Readback unavailable');});
    expect(() => handleUpdateInstance(store, {body: 'Durably saved instructions'})).toThrow('Readback unavailable');
    expect(readFileSync(join(f.root, 'aside.md'), 'utf8')).toContain('Durably saved instructions');
    expect(store.getSourceVersion()).not.toBe(original);
    expect(() => assertSearchSourceReadable(store)).toThrow('rebuild_failed');
    store.rebuild();
    expect(store.getInstance()?.body).toBe('Durably saved instructions');
    expect(() => assertSearchSourceReadable(store)).not.toThrow();
  });

  it('publishes manifest edits without rereading the loaded content corpus', async () => {
    const f = fixture(), store = f.store!, original = store.getSourceVersion();
    const snapshot = await store.snapshot();
    writeFileSync(f.file, f.text.replace('Original content.', 'Unobserved external content.'));
    const rebuild = vi.spyOn(store, 'rebuild'), load = vi.spyOn(store as any, 'load');
    const changed = vi.fn(() => store.getSourceVersion()); store.onChange(changed);

    handleUpdateInstance(store, {body: 'Published instructions', doneEventTitlePrefix: 'Finished '});

    expect(store.getInstance()).toMatchObject({body: 'Published instructions', manifest: {config: {doneEventTitlePrefix: 'Finished '}}});
    expect(store.getSourceVersion()).not.toBe(original);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.results[0].value).toBe(store.getSourceVersion());
    expect(store.getProject('item')?.body).toBe('Original content.');
    expect(await store.snapshot()).not.toBe(snapshot);
    expect((await store.snapshot()).instance.body).toBe('Published instructions');
    expect(rebuild).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('retains unresolved full-source and other-file diagnostics after a manifest write', () => {
    const f = fixture(), store = f.store!;
    writeFileSync(f.file, '---\nname: [invalid\n---\nBody.');
    store.rebuild();
    const malformed = store.getIssues().find(issue => issue.code === 'invalid_yaml');
    expect(malformed).toBeDefined();
    store.recordRebuildFailure(new Error('Unresolved corpus read failure'));
    const failure = store.getIssues().find(issue => issue.code === 'rebuild_failed');

    handleUpdateInstance(store, {body: 'Saved manifest only'});

    expect(store.getIssues()).toContainEqual(malformed);
    expect(store.getIssues()).toContainEqual(failure);
    expect(() => assertSearchSourceReadable(store)).toThrow();
    writeFileSync(f.file, f.text); store.rebuild();
    expect(() => assertSearchSourceReadable(store)).not.toThrow();
  });

  it('requires owner reconciliation before recurrence writes after adopting an external manifest identity', () => {
    const readHistory = vi.spyOn(history, 'readRecurrenceHistory').mockImplementation(() => new Map());
    const f = fixture(), store = f.store!, previousHistoryFile = (store as any).recurrenceHistoryFile;
    writeFileSync(join(f.root, 'aside.md'), '---\nid: new-identity\nname: Freshness\n---\n');

    handleUpdateInstance(store, {body: 'Preserve the external identity'});

    expect(store.getManifest().id).toBe('new-identity');
    expect((store as any).recurrenceHistoryFile).toBe(previousHistoryFile);
    expect(() => store.assertRecurrenceChange('future-template', [])).toThrow('Instance identity changed');
    expect(() => assertSearchSourceReadable(store)).toThrow('rebuild_failed');
    store.rebuild();
    expect((store as any).recurrenceHistoryFile).not.toBe(previousHistoryFile);
    expect(readHistory).toHaveBeenLastCalledWith((store as any).recurrenceHistoryFile);
    expect(() => store.assertRecurrenceChange('future-template', [])).not.toThrow();
    expect(() => assertSearchSourceReadable(store)).not.toThrow();
  });

  it.each([
    ['mapping', 'delegation: &loop\n  run: *loop\n  timeout: 1m', 'delegation: &loop\n  run: *loop\n  timeout: 2m'],
    ['sequence', 'delegation: &loop\n  - *loop\n  - original', 'delegation: &loop\n  - *loop\n  - changed'],
  ])('keeps instances with cyclic %s declarations usable and hashes their changes', async (_kind, declaration, updated) => {
    const f = fixture(false), file = join(f.root, 'actions', '2026', 'item.md');
    mkdirSync(join(f.root, 'actions', '2026'), {recursive: true});
    const write = (metadata: string) => writeFileSync(file, `---\nname: Action\ncreated: 2026-06-01\n${metadata}\n---\nAction body.\n`);
    write(declaration);
    const store = new Store(f.root); fixtures.at(-1)!.store = store;
    expect(store.getAction('item')?.body).toBe('Action body.');
    expect(() => JSON.stringify(store.getInstance())).not.toThrow();
    const issue = store.getIssues().find(issue => issue.code === 'invalid_delegation');
    expect(issue).toBeDefined();
    const read = await executeGraphQL(store, 'query', {document: '{ action(id: "item") { body delegation { name } } }'});
    expect(read.errors).toBeUndefined();
    expect(read.data).toEqual({action: {body: 'Action body.', delegation: null}});
    expect(read.extensions?.diagnostics).toContainEqual(expect.objectContaining({code: 'invalid_delegation'}));
    const original = store.getSourceVersion();
    store.rebuild();
    expect(store.getSourceVersion()).toBe(original);
    write(updated); store.rebuild();
    expect(store.getSourceVersion()).not.toBe(original);
    expect(store.getIssues().find(issue => issue.code === 'invalid_delegation')).toEqual(issue);
    expect(store.getIssues().some(issue => issue.code === 'rebuild_failed')).toBe(false);
    write(''); store.rebuild();
    expect(store.getIssues().some(issue => issue.code === 'invalid_delegation')).toBe(false);
  });

  it('reuses parsing only after rereading identical bytes and isolates consumer mutations', () => {
    const f = fixture(false), cache = new InstanceReadCache();
    const parse = vi.spyOn(parser, 'parseProjectFile');
    const first = readInstanceData(f.root, cache);
    first.projects[0].value.frontMatter.name = 'Mutated in memory';
    first.projects[0].issues.push({code: 'read_error', severity: 'error', message: 'Not from disk'});
    const second = readInstanceData(f.root, cache);
    expect(second.projects[0].value.frontMatter.name).toBe('Original');
    expect(second.projects[0].issues).toEqual([]);
    expect(parse).toHaveBeenCalledOnce();
    writeFileSync(f.file, f.text.replace('Original content.', 'Modified content.'));
    expect(readInstanceData(f.root, cache).projects[0].value.body).toBe('Modified content.');
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('detects equal-length disk edits even when timestamps are restored', () => {
    const f = fixture(), store = f.store!, before = statSync(f.file), version = searchSourceVersion(store);
    writeFileSync(f.file, f.text.replace('Original content.', 'Modified content.'));
    utimesSync(f.file, before.atime, before.mtime);
    expect(statSync(f.file).size).toBe(before.size);
    store.rebuild();
    expect(store.getProject('item')?.body).toBe('Modified content.');
    expect(searchSourceVersion(store)).not.toBe(version);
    const updated = searchSourceVersion(store); store.rebuild();
    expect(searchSourceVersion(store)).toBe(updated);
  });

  it('discovers new files and indexes, evicts deleted parse entries, and rereads the manifest', () => {
    const f = fixture(false), cache = new InstanceReadCache(), parse = vi.spyOn(parser, 'parseProjectFile');
    readInstanceData(f.root, cache); unlinkSync(f.file);
    expect(readInstanceData(f.root, cache).projects).toEqual([]);
    writeFileSync(f.file, f.text); readInstanceData(f.root, cache);
    expect(parse).toHaveBeenCalledTimes(2);
    const store = new Store(f.root); fixtures.at(-1)!.store = store;
    mkdirSync(join(f.root, 'projects', '2027'));
    writeFileSync(join(f.root, 'projects', '2027', 'new.md'), '---\nname: New\ncreated: 2027-01-01\n---\nNew body.');
    writeFileSync(join(f.root, 'projects', '2027', 'index.yaml'), '- id: new\n  description: New description\n');
    writeFileSync(join(f.root, 'aside.md'), '---\nid: freshness\nname: Updated manifest\n---\nChanged instructions.\n');
    store.rebuild();
    expect(store.getProject('new')?.body).toBe('New body.');
    expect(store.getIndexDescription('projects', 'new')).toBe('New description');
    expect(store.getInstance()).toMatchObject({manifest: {name: 'Updated manifest'}, body: 'Changed instructions.'});
  });

  it('keeps malformed-source diagnostics current and clears them after repair', () => {
    const f = fixture(), store = f.store!;
    writeFileSync(f.file, '---\nname: [invalid\n---\nBody.');
    store.rebuild(); expect(() => assertSearchSourceReadable(store)).toThrow('invalid_yaml');
    store.rebuild(); expect(() => assertSearchSourceReadable(store)).toThrow('invalid_yaml');
    writeFileSync(f.file, f.text); store.rebuild();
    expect(() => assertSearchSourceReadable(store)).not.toThrow();
    expect(store.getProject('item')?.body).toBe('Original content.');
  });

  it('does not reuse a cached record through a substituted symlink', () => {
    const f = fixture(), store = f.store!, outside = join(f.root, 'outside.md');
    writeFileSync(outside, f.text.replace('Original content.', 'External content.'));
    unlinkSync(f.file); symlinkSync(outside, f.file);
    store.rebuild();
    expect(() => assertSearchSourceReadable(store)).toThrow('read_error');
    expect(store.getProject('item')?.body).not.toBe('External content.');
    unlinkSync(f.file); writeFileSync(f.file, f.text); store.rebuild();
    expect(() => assertSearchSourceReadable(store)).not.toThrow();
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('reports permissions lost after a cached read, then recovers', () => {
    const f = fixture(), store = f.store!;
    chmodSync(f.file, 0);
    try {store.rebuild(); expect(() => assertSearchSourceReadable(store)).toThrow('read_error');}
    finally {chmodSync(f.file, 0o600);}
    store.rebuild(); expect(() => assertSearchSourceReadable(store)).not.toThrow();
  });

  it('refreshes attachment inventory and references even when source bytes were cached', () => {
    const f = fixture(), store = f.store!, id = '2026-06-01-report';
    const directory = join(f.root, 'artifacts', '2026', id), file = join(f.root, 'artifacts', '2026', `${id}.md`);
    mkdirSync(directory, {recursive: true});
    writeFileSync(file, '---\nname: Report\ncreated: 2026-06-01\n---\nReport body.\n');
    writeFileSync(f.file, f.text.replace('Original content.', `See #artifact/${id}/report.txt`));
    store.rebuild(); store.rebuild();
    expect(store.getIssues().some(issue => issue.code === 'artifact_attachment_read_error')).toBe(true);
    writeFileSync(join(directory, 'report.txt'), 'New attachment'); store.rebuild();
    expect(store.getArtifact(id)?.frontMatter.attachments).toEqual(['report.txt']);
    expect(store.getIssues().some(issue => issue.code === 'artifact_attachment_read_error')).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain('report.txt');
    store.rebuild(); unlinkSync(join(directory, 'report.txt')); store.rebuild();
    expect(store.getIssues().some(issue => issue.code === 'artifact_attachment_read_error')).toBe(true);
    expect(store.getArtifact(id)?.frontMatter.attachments).toBeUndefined();
    expect(readFileSync(file, 'utf8')).not.toContain('attachments:');
    writeFileSync(file, '---\nname: Edited\ncreated: 2026-06-01\n---\nUpdated body.\n');
    store.rebuild(); expect(store.getArtifact(id)?.frontMatter.name).toBe('Edited');
    expect(store.getArtifact(id)?.body).toBe('Updated body.');
  });
});
