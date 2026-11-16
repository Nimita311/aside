import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentFiles } from '../src/mcp/attachments.js';
import {readAttachmentFiles} from '../src/core/attachment-metadata.js';
import { Store } from '../src/source/store.js';
import { createArtifact, handleUpdateArtifact } from '../src/mcp/tools/artifact.js';
import { handleQueryArtifacts } from '../src/mcp/tools/query.js';
import { artifactHandle } from '../src/core/artifact.js';

const ID = '2026-10-04-plan';
const NAME = 'final % (review).pdf';
describe('managed attachment retrieval paths', () => {
  let root: string, data: string, directory: string, file: string;
  let store: Store | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync('/tmp/aside-attachments-'));
    data = join(root, 'instance');
    directory = join(data, 'artifacts', '2026', ID);
    mkdirSync(directory, { recursive: true });
    file = join(directory, NAME);
    writeFileSync(file, 'Saved bytes');
  });
  afterEach(() => { access.reset(); store?.close(); store = undefined; rmSync(root, { recursive: true, force: true }); });
  it('returns the exact filename, escaped handle, and absolute managed saved-copy path', () => {
    expect(readAttachmentFiles(data, ID, [NAME])).toEqual([{ filename: NAME, handle: artifactHandle(ID, NAME), path: file }]);
  });
  it('canonicalizes an instance directory alias without exposing the alias or import source', () => {
    const alias = join(root, 'alias');
    symlinkSync(data, alias);
    expect(readAttachmentFiles(alias, ID, [NAME])[0].path).toBe(file);
  });
  it.each(['missing', 'directory', 'inside-symlink', 'outside-symlink'])('withholds a readable path for %s attachments', kind => {
    unlinkSync(file);
    if (kind === 'directory') mkdirSync(file);
    if (kind.endsWith('symlink')) {
      const target = kind === 'inside-symlink' ? join(directory, 'another.pdf') : join(root, 'outside.pdf');
      writeFileSync(target, 'Wrong bytes'); symlinkSync(target, file);
    }
    const result = readAttachmentFiles(data, ID, [NAME])[0];
    expect(result.path).toBeUndefined();
    expect(result.error).toMatch(/validate.*repair|reimport/);
  });
  it('rejects managed directory links even to an existing directory inside the instance', () => {
    const alternate = join(data, 'other'); mkdirSync(alternate); writeFileSync(join(alternate, NAME), 'Other bytes');
    rmSync(directory, { recursive: true }); symlinkSync(alternate, directory);
    expect(readAttachmentFiles(data, ID, [NAME])[0]).toMatchObject({ error: expect.stringMatching(/ordinary directory/) });
    expect(readAttachmentFiles(data, ID, [NAME])[0].path).toBeUndefined();
  });
  it('rejects escaping names, staging names, and case aliases of an indexed filename', () => {
    const staging = '.1234567890123-abcd.tmp'; writeFileSync(join(directory, staging), 'Staged');
    for (const name of ['../outside.pdf', staging, NAME.toUpperCase()]) {
      const result = readAttachmentFiles(data, ID, [name])[0];
      expect(result.path).toBeUndefined(); expect(result.error).toBeTruthy();
    }
  });
  it('requires published metadata and never reopens a captured attachment', () => {
    const published = readAttachmentFiles(data, ID, [NAME]);
    unlinkSync(file); access.protect([data]);
    expect(attachmentFiles(published, ID, [NAME])).toEqual([{filename: NAME, handle: artifactHandle(ID, NAME), path: file}]);
    expect(() => attachmentFiles(undefined, ID, [NAME])).toThrow('Lifecycle-provided attachment metadata is unavailable');
    expect(() => attachmentFiles([], ID, [NAME])).toThrow('Lifecycle-provided attachment metadata is unavailable');
    expect(access.violations).toEqual([]);
  });
  it('returns retrieval metadata in both query levels and every write receipt, excluding removals', () => {
    // Use a fresh artifact with imported files instead of the synthetic fixture.
    rmSync(directory, { recursive: true });
    writeFileSync(join(data, 'aside.md'), '---\nid: attachments\nname: Attachments\n---\n');
    store = new Store(data);
    const imported = join(root, 'import-source.pdf'); writeFileSync(imported, 'Imported bytes');
    const created = createArtifact(store, { name: 'Plan', description: 'Plan', files: [{ source: imported, filename: NAME }] }, new Date(2026, 9, 4, 10)).text;
    expect(created).toContain(`    path: ${file}`);
    expect(created).toContain(`    handle: ${artifactHandle(ID, NAME)}`);
    expect(created).not.toContain(imported);
    expect(readFileSync(file, 'utf8')).toBe('Imported bytes');
    for (const detail of ['metadata', 'full'] as const) expect(handleQueryArtifacts(store, { ids: [ID], detail })).toContain(`    path: ${file}`);
    expect(handleQueryArtifacts(store, { ids: [ID] })).not.toContain('attachment_files:');
    const updated = handleUpdateArtifact(store, { id: ID, description: 'Revised' });
    expect(updated).toContain(`    path: ${file}`);
    const record = readFileSync(store.getArtifactFile(ID)!, 'utf8');
    expect(record).not.toContain('attachment_files'); expect(record).not.toContain(file);
    const removed = handleUpdateArtifact(store, { id: ID, remove_files: [NAME] });
    expect(removed).toContain('files_removed:'); expect(removed).not.toContain('attachment_files:'); expect(removed).not.toContain(file);
  });
  it('keeps query metadata on the published observation until source reconciliation', () => {
    writeFileSync(join(data, 'aside.md'), '---\nid: attachments\nname: Attachments\n---\n');
    writeFileSync(join(data, 'artifacts', '2026', `${ID}.md`), '---\nname: Plan\ncreated: 2026-10-04T10:00\n---\n');
    writeFileSync(join(data, 'artifacts', '2026', 'index.yaml'), `- id: ${ID}\n  description: Plan\n`);
    store = new Store(data); unlinkSync(file);
    access.protect([data]);
    const result = handleQueryArtifacts(store, { ids: [ID], detail: 'metadata' });
    expect(result).toContain(`filename: ${NAME}`); expect(result).toContain(`    path: ${file}`);
    expect(access.violations).toEqual([]);
    access.reset(); store.rebuild(); access.protect([data]);
    const updated = handleQueryArtifacts(store, { ids: [ID], detail: 'metadata' });
    expect(updated).not.toContain('attachment_files:'); expect(updated).not.toContain(file);
    expect(access.violations).toEqual([]);
  });
});
