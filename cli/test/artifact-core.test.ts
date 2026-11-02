import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  artifactHandle, artifactFilePath, artifactAttachmentPath,
  assertArtifactId, assertAttachmentFilename, extractArtifactReferences,
  artifactContentFilename, collectArtifactReferenceSources, listArtifactAttachments,
} from '../src/core/artifact.js';
import { parseArtifactFile } from '../src/core/parser.js';
import { readInstanceData } from '../src/core/reader.js';
import { contentAttachmentPath } from '../src/core/content-attachment.js';
import { Store } from '../src/mcp/store.js';
import { handleQueryArtifacts } from '../src/mcp/tools/query.js';
import type { Artifact } from '../src/core/types.js';

const plan = '2026-10-02-plan';
const guide = '2026-10-01-guide';
const record = (name: string, created: string, body = '', attachments?: string[]): Artifact => ({ frontMatter: { name, created, ...(attachments?.length ? { attachments } : {}) }, body });

describe('artifact handles', () => {
  it('derives enforced storage and accepts Unicode IDs', () => {
    expect(artifactFilePath('/data', plan)).toBe('/data/artifacts/2026/2026-10-02-plan.md');
    expect(artifactAttachmentPath('/data', plan, 'Desktop 2.png')).toBe('/data/artifacts/2026/2026-10-02-plan/Desktop 2.png');
    expect(artifactHandle('2026-10-02-设计', '图.png')).toBe('#artifact/2026-10-02-设计/%E5%9B%BE.png');
  });

  it('selects file content only for an empty body and one indexed attachment', () => {
    expect(artifactContentFilename(record('Plan', '2026-10-02T10:00', '', ['brief.pdf']))).toBe('brief.pdf');
    expect(artifactContentFilename(record('Plan', '2026-10-02T10:00', '  \n', ['Desktop 2.png']))).toBe('Desktop 2.png');
    for (const artifact of [
      record('Plan', '2026-10-02T10:00'),
      record('Plan', '2026-10-02T10:00', '', []),
      record('Plan', '2026-10-02T10:00', '', ['brief.pdf', 'notes.md']),
      record('Plan', '2026-10-02T10:00', 'Content', ['brief.pdf']),
    ]) expect(artifactContentFilename(artifact)).toBeUndefined();
  });

  it('round-trips every canonical filename through bare and Markdown handles', () => {
    for (const filename of ['Screenshot (1).png', 'rate%20.png', 'quote\'".txt', '图.png', 'file..', 'symbols!*.png', 'foo#bar?.txt', 'angle<>.pdf', 'x[]{}.txt']) {
      const handle = artifactHandle(plan, filename);
      expect(extractArtifactReferences(handle)).toEqual([{ id: plan, filename }]);
      expect(extractArtifactReferences(`[File](${handle})`)).toEqual([{ id: plan, filename }]);
    }
  });

  it('rejects traversal, unsafe filenames and invalid dates', () => {
    for (const id of ['../plan', '2026-02-30-plan', '2026-10-02-Plan', '2026-10-02-a/b']) expect(() => assertArtifactId(id)).toThrow();
    for (const file of ['', '.', '..', '../x', 'nested/x', 'nested\\x', 'x\0y', 'x\ny']) expect(() => assertAttachmentFilename(file)).toThrow();
  });

  it('extracts bare, link and image targets with exact filenames', () => {
    expect(extractArtifactReferences(`See #artifact/${plan}. [Plan](#artifact/${guide}) ![Shot](#artifact/${plan}/Desktop(2).png) [PDF](<#artifact/${plan}/final draft.pdf>) [Encoded](#artifact/${plan}/hello%20world.pdf) [Punctuation](#artifact/${plan}/report!.pdf)`)).toEqual([
      { id: guide },
      { id: plan, filename: 'Desktop(2).png' },
      { id: plan, filename: 'final draft.pdf' },
      { id: plan, filename: 'hello world.pdf' },
      { id: plan, filename: 'report!.pdf' },
      { id: plan },
    ]);
  });

  it('ignores code, escaped mentions and external URL fragments', () => {
    const md = [
      `\`#artifact/${plan}\``,
      `\`\`literal \` #artifact/${plan}\`\``,
      '```md', `#artifact/${plan}`, '```',
      '~~~~', `#artifact/${plan}`, '~~~~',
      '> ```md', `> #artifact/${plan}`, '> ```',
      '- ```md', `  #artifact/${plan}`, '  ```',
      `\`\`literal \` #artifact/${plan} \`\``,
      '', // Indented code cannot interrupt the preceding paragraph.
      `    #artifact/${plan}`,
      `\\#artifact/${plan}`,
      `[external](https://example.com/#artifact/${plan})`,
      `https://example.com/#artifact/${plan}`,
      `#artifact/${guide}`,
    ].join('\n');
    expect(extractArtifactReferences(md)).toEqual([{ id: guide }]);
  });

  it('retains malformed candidates for validation', () => {
    expect(extractArtifactReferences('#artifact/../x [Nested](#artifact/2026-10-02-plan/a/b)')).toEqual([
      { id: plan, filename: 'a/b' }, { id: '..', filename: 'x' },
    ]);
  });

  it('ends code fences with their containers and masks HTML code', () => {
    for (const code of [
      '> ```md\n> code\n',
      '- ```md\n  code\n',
      '- Item\n\n  ```md\n  code\n',
      '- Item\n  - Nested\n\n    ```md\n    code\n',
    ]) expect(extractArtifactReferences(`${code}\n#artifact/${plan}`)).toEqual([{ id: plan }]);
    expect(extractArtifactReferences(`<code>#artifact/${plan}</code>\n<pre class="sample">#artifact/${plan}</pre>\n#artifact/${guide}`)).toEqual([{ id: guide }]);
  });
});

describe('artifact reading and relationships', () => {
  let dir: string;
  let store: Store | undefined;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aside-artifact-core-')); });
  afterEach(() => { store?.close(); store = undefined; rmSync(dir, { recursive: true, force: true }); });
  const write = (path: string, content: string | Uint8Array) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

  it('parses malformed records tolerantly and trims body content', () => {
    const parsed = parseArtifactFile('---\ncreated: 2026-10-02T10:00\nattachments: 7\n---\n  body  ');
    expect(parsed.value.body).toBe('body');
    expect(parsed.value.frontMatter.name).toBe('');
    expect(parsed.issues.map(issue => issue.field)).toEqual(expect.arrayContaining(['name', 'attachments']));
  });

  it('preserves exact attachment names and omits an empty index when parsing', () => {
    const parsed = parseArtifactFile('---\nname: Plan\ncreated: 2026-10-02T10:00\nattachments: ["Desktop 2.png", "图.png"]\n---\n');
    expect(parsed.value.frontMatter.attachments).toEqual(['Desktop 2.png', '图.png']);
    expect(parsed.issues).toEqual([]);
    const invalid = parseArtifactFile('---\nname: Plan\ncreated: 2026-10-02T10:00\nattachments: ["../escape", "nested/file", "brief.pdf"]\n---\n');
    expect(invalid.value.frontMatter.attachments).toEqual(['brief.pdf']);
    expect(invalid.issues.map(issue => issue.code)).toEqual(['invalid_attachment_filename', 'invalid_attachment_filename']);
    expect(parseArtifactFile('---\nname: Plan\ncreated: 2026-10-02T10:00\nattachments: []\n---\n').value.frontMatter.attachments).toBeUndefined();
  });

  it('lists exact immediate regular filenames, excluding symlinks and staging files', () => {
    for (const filename of ['b.png', 'a.md', '.keep', '.notes.tmp', '.12345678-1234-1234-1234-123456789abc.tmp', '.1790964000000-abcdef.tmp', 'ordinary.tmp', 'nested/inside.pdf']) {
      write(join(dirname(artifactAttachmentPath(dir, plan, 'a.md')), filename), 'content');
    }
    symlinkSync('a.md', artifactAttachmentPath(dir, plan, 'linked.md'));
    expect(listArtifactAttachments(dir, plan)).toEqual(['.keep', '.notes.tmp', 'a.md', 'b.png', 'ordinary.tmp']);
    expect(listArtifactAttachments(dir, guide)).toEqual([]);
    expect(() => listArtifactAttachments(dir, '../escape')).toThrow('Invalid artifact id');
  });

  it('resolves attachments from relative instance roots and still rejects linked managed directories', () => {
    const path = artifactAttachmentPath(dir, plan, 'notes.md'); write(path, 'content');
    const root = relative(process.cwd(), dir);
    expect(listArtifactAttachments(root, plan)).toEqual(['notes.md']);
    expect(contentAttachmentPath(root, plan, 'notes.md')).toBe(realpathSync(path));
    const alias = artifactAttachmentPath(dir, guide, 'notes.md');
    symlinkSync(dirname(path), dirname(alias));
    expect(() => listArtifactAttachments(root, guide)).toThrow(/Symlinks/);
    expect(() => contentAttachmentPath(root, guide, 'notes.md')).toThrow(/Symlinks/);
  });

  it('surfaces attachment directory errors and prevents directory escapes', () => {
    const directory = dirname(artifactAttachmentPath(dir, plan, 'file.pdf'));
    mkdirSync(dirname(directory), { recursive: true });
    writeFileSync(directory, 'not a directory');
    expect(() => listArtifactAttachments(dir, plan)).toThrow();
    unlinkSync(directory);
    const outside = mkdtempSync(join(tmpdir(), 'aside-artifact-outside-'));
    try {
      symlinkSync(outside, directory);
      expect(() => listArtifactAttachments(dir, plan)).toThrow(/Symlinks are not allowed/);
      unlinkSync(directory);
      symlinkSync(join(outside, 'missing'), directory);
      expect(() => listArtifactAttachments(dir, plan)).toThrow(/Symlinks are not allowed/);
      unlinkSync(directory);
      rmSync(join(dir, 'artifacts'), { recursive: true });
      symlinkSync(outside, join(dir, 'artifacts'));
      expect(() => listArtifactAttachments(dir, plan)).toThrow(/Symlinks are not allowed/);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('rejects an in-instance symlink in every attachment-directory ancestor, including missing targets', () => {
    const real = join(dir, 'ordinary');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'artifacts'));
    expect(() => listArtifactAttachments(dir, plan)).toThrow(/Symlinks are not allowed/);
    unlinkSync(join(dir, 'artifacts'));
    mkdirSync(join(dir, 'artifacts'));
    symlinkSync(real, join(dir, 'artifacts', '2026'));
    expect(() => listArtifactAttachments(dir, plan)).toThrow(/Symlinks are not allowed/);
  });

  it('reads only top-level records and indexes, without treating attachments as entities', () => {
    write(artifactFilePath(dir, plan), '---\nname: Plan\ncreated: 2026-10-02T10:00\n---\nLatest plan');
    write(artifactAttachmentPath(dir, plan, 'notes.md'), 'plain supporting content');
    write(join(dir, 'artifacts', '2026', 'index.yaml'), `- id: ${plan}\n  description: Current plan\n`);
    const data = readInstanceData(dir);
    expect(data.artifacts.map(file => file.name)).toEqual([`${plan}.md`]);
    expect(data.artifactIndexes[0].value).toEqual([{ id: plan, description: 'Current plan' }]);
  });

  it('rejects symlink records and non-file Markdown entries for every managed entity', () => {
    const original = join(dir, 'original.md');
    write(original, '---\nname: Linked\ncreated: 2026-10-02T10:00\n---\nContent');
    for (const kind of ['projects', 'actions', 'artifacts']) {
      const folder = join(dir, kind, '2026');
      mkdirSync(folder, { recursive: true });
      symlinkSync(original, join(folder, `${plan}.md`));
    }
    mkdirSync(join(dir, 'artifacts', '2026', 'folder.md'));
    const data = readInstanceData(dir);
    expect(data.projects).toHaveLength(0);
    expect(data.actions).toHaveLength(0);
    expect(data.artifacts).toHaveLength(0);
    expect(data.errors.map(error => error.file)).toEqual([
      `projects/2026/${plan}.md`, `actions/2026/${plan}.md`, `artifacts/2026/${plan}.md`, 'artifacts/2026/folder.md',
    ]);
    expect(data.errors.every(error => error.code === 'read_error')).toBe(true);
  });

  it('validates selected file presence without traversing attachment content', () => {
    const artifacts = new Map([
      [plan, record('Plan', '2026-10-02T10:00', '', ['notes.md'])],
      [guide, record('Guide', '2026-10-01T10:00')],
      ['2026-10-01-unrelated', record('Other', '2026-10-01T10:00', '', ['missing.md'])],
    ]);
    write(artifactAttachmentPath(dir, plan, 'notes.md'), `[Guide](#artifact/${guide}/more.md)`);
    write(artifactAttachmentPath(dir, guide, 'more.md'), `#artifact/${plan}/notes.md`);
    write(artifactAttachmentPath(dir, guide, 'unreferenced.md'), '#artifact/missing');
    const result = collectArtifactReferenceSources(dir, [{ handle: `#entry/2026-10-02T11:00`, markdown: `#artifact/${plan}` }], artifacts);
    expect(result.issues).toEqual([]);
    expect(result.sources.map(source => source.handle)).toEqual(['#entry/2026-10-02T11:00']);
    expect(result.attachments).toEqual([artifactHandle(plan, 'notes.md')]);
  });

  it('supports opaque preflight imports and reports missing files and symlinks', () => {
    const artifacts = new Map([[plan, record('Plan', '2026-10-02T10:00')]]);
    const sources = [{ handle: `#artifact/${plan}`, markdown: `[Notes](#artifact/${plan}/notes.md)` }];
    const overlay = new Map<string, Uint8Array | null>([[artifactHandle(plan, 'notes.md'), new TextEncoder().encode('Latest text')]]);
    expect(collectArtifactReferenceSources(dir, sources, artifacts, overlay).issues).toEqual([]);
    expect(collectArtifactReferenceSources(dir, sources, artifacts).issues).toHaveLength(1);
    overlay.set(artifactHandle(plan, 'notes.md'), new Uint8Array([0xff]));
    expect(collectArtifactReferenceSources(dir, sources, artifacts, overlay).issues).toEqual([]);
    write(artifactAttachmentPath(dir, plan, 'notes.md'), 'Previous content');
    overlay.set(artifactHandle(plan, 'notes.md'), null);
    expect(collectArtifactReferenceSources(dir, sources, artifacts, overlay).issues[0].message).toContain('removed');
    unlinkSync(artifactAttachmentPath(dir, plan, 'notes.md'));
    write(artifactAttachmentPath(dir, plan, 'actual.md'), 'body');
    symlinkSync('actual.md', artifactAttachmentPath(dir, plan, 'notes.md'));
    expect(collectArtifactReferenceSources(dir, sources, artifacts).issues[0].message).toContain('Symlinks are not allowed');
  });

  it('keeps disk and imported attachment contents out of record relationships', () => {
    const artifacts = new Map([
      [plan, record('Plan', '2026-10-02T10:00')],
      [guide, record('Guide', '2026-10-01T10:00')],
    ]);
    const handle = artifactHandle(plan, 'notes.md');
    const markdown = `---\nrelated: "#artifact/2026-10-02-missing"\n---\n\n#artifact/${guide}`;
    const sources = [{ handle: artifactHandle(plan), markdown: `[Notes](${handle})` }];
    write(artifactAttachmentPath(dir, plan, 'notes.md'), markdown);
    const overlay = new Map([[handle, new TextEncoder().encode(markdown)]]);
    for (const imported of [undefined, overlay]) {
      const result = collectArtifactReferenceSources(dir, sources, artifacts, imported);
      expect(result.issues).toEqual([]);
      expect(result.sources).toEqual(sources);
    }

    store = new Store(dir);
    store.saveArtifact(guide, { name: 'Guide', created: '2026-10-01T10:00' }, '', artifactFilePath(dir, guide));
    store.saveArtifact(plan, { name: 'Plan', created: '2026-10-02T10:00' }, handle, artifactFilePath(dir, plan));
    expect(store.getArtifactBacklinks(guide)).toEqual([]);
    expect(store.getIssues().some(issue => issue.code === 'artifact_reference_missing')).toBe(false);
  });

  it('does not treat the attachment index as authored references', () => {
    write(artifactAttachmentPath(dir, plan, 'notes.md'), artifactHandle(guide));
    store = new Store(dir);
    store.saveArtifact(guide, { name: 'Guide', created: '2026-10-01T10:00' }, '', artifactFilePath(dir, guide));
    store.saveArtifact(plan, { name: 'Plan', created: '2026-10-02T10:00', attachments: ['notes.md', 'brief.pdf'] }, 'Plan body', artifactFilePath(dir, plan));
    expect(store.getArtifactBacklinks(guide)).toEqual([]);
    expect(store.getReferencedArtifactFiles()).toEqual([]);
    store.saveArtifact(plan, { name: 'Plan', created: '2026-10-02T10:00', attachments: ['notes.md'] }, '', artifactFilePath(dir, plan));
    expect(store.getArtifactBacklinks(guide)).toEqual([]);
    expect(store.getArtifactBacklinks(plan)).toEqual([]);
  });

  it('omits unavailable attachment targets from contextual relationships while tracking them for repair', () => {
    store = new Store(dir);
    store.saveArtifact(plan, {name: 'Plan', created: '2026-10-02T10:00'}, 'Plan', artifactFilePath(dir, plan));
    const projectId = '2026-10-02-project';
    const entryId = '2026-10-02T11:00';
    const content = `#artifact/${plan}/missing.pdf`;
    store.saveProject(projectId, {name: 'Project', created: '2026-10-02T10:00'}, content, join(dir, 'projects/2026', `${projectId}.md`));
    const weekly = `---\nweek: 40\nweek_start: 2026-09-28\nweek_end: 2026-10-04\n---\n\n---\n\x60\x60\x60entry\ncreated: ${entryId}\nprojects: [${projectId}]\n\x60\x60\x60\n\n${content}\n`;
    store.saveEntry(entryId, [projectId], [], content, join(dir, 'notes/2026/2026-09-28.md'), weekly);
    expect(store.getRelations().artifactsByEntity.get(`#entry/${entryId}`)).toBeUndefined();
    expect(store.getRelations().artifactsByEntity.get(`#project/${projectId}`)).toBeUndefined();
    expect(store.getProjectsForArtifact(plan)).toEqual([]);
    expect(store.getArtifactBacklinks(plan)).toEqual([]);
    expect(store.getReferencedArtifactFiles()).toEqual([artifactHandle(plan, 'missing.pdf')]);
    expect(store.getIssues().some(issue => issue.code === 'artifact_attachment_read_error' && issue.message.includes('missing.pdf'))).toBe(true);
    write(artifactAttachmentPath(dir, plan, 'missing.pdf'), new Uint8Array([255]));
    store.rebuild();
    expect(store.getRelations().artifactsByEntity.get(`#entry/${entryId}`)).toEqual([plan]);
    expect(store.getProjectsForArtifact(plan)).toEqual([projectId]);
    expect(store.getArtifactBacklinks(plan)).toEqual([]);
    expect(store.getIssues()).toEqual([]);
  });

  it('refreshes backlinks and project/action associations immediately on all entity writes', () => {
    store = new Store(dir);
    store.saveArtifact(plan, { name: 'Plan', created: '2026-10-02T10:00' }, `#artifact/${plan}`, artifactFilePath(dir, plan));
    store.addIndexEntry('artifacts', artifactFilePath(dir, plan), plan, 'Current plan');
    store.saveProject('project', { name: 'Project', created: '2026-10-02T09:00' }, `#artifact/${plan} #artifact/${plan}`, join(dir, 'projects', '2026', 'project.md'));
    store.saveAction('action', { name: 'Action', created: '2026-10-02T09:00' }, `#artifact/${plan}`, join(dir, 'actions', '2026', 'action.md'));
    const content = `#artifact/${plan}`;
    const weekly = `---\nweek: 40\nweek_start: 2026-09-28\nweek_end: 2026-10-04\n---\n\n---\n\`\`\`entry\ncreated: 2026-10-02T11:00\nprojects: [tagged-project]\nactions: [tagged-action]\n\`\`\`\n\n${content}\n`;
    store.saveEntry('2026-10-02T11:00', ['tagged-project'], ['tagged-action'], content, join(dir, 'notes', '2026', '2026-09-28.md'), weekly);
    expect(store.getProjectsForArtifact(plan)).toEqual(['tagged-project', 'project']);
    expect(store.getActionsForArtifact(plan)).toEqual(['tagged-action', 'action']);
    expect(store.getArtifactBacklinks(plan)).toEqual(['#project/project', '#entry/2026-10-02T11:00', '#action/action']);
    store.saveProject('project', { name: 'Project', created: '2026-10-02T09:00' }, '', join(dir, 'projects', '2026', 'project.md'));
    expect(store.getProjectsForArtifact(plan)).toEqual(['tagged-project']);
    store.rebuild();
    expect(store.getArtifactBacklinks(plan)).toEqual(['#entry/2026-10-02T11:00', '#action/action']);
    expect(store.getArtifactIndex()).toEqual([{ id: plan, description: 'Current plan' }]);
  });

  it('queries latest records, indexes, relationships, date bounds and common empty filters', async () => {
    write(artifactAttachmentPath(dir, guide, 'brief.pdf'), new Uint8Array([1, 2, 3]));
    store = new Store(dir);
    store.saveArtifact(guide, { name: 'Guide', created: '2026-10-01T10:00', attachments: ['brief.pdf'] }, '', artifactFilePath(dir, guide));
    store.saveArtifact(plan, { name: 'Plan', created: '2026-10-02T10:00' }, `Current Markdown body\n[Missing](#artifact/${plan}/missing.pdf)`, artifactFilePath(dir, plan));
    store.addIndexEntry('artifacts', artifactFilePath(dir, guide), guide, 'Helpful guide');
    store.addIndexEntry('artifacts', artifactFilePath(dir, plan), plan, 'Latest roadmap');
    store.saveProject('project', { name: 'Project', created: '2026-10-02T09:00' }, `#artifact/${plan}`, join(dir, 'projects', '2026', 'project.md'));
    const index = handleQueryArtifacts(store, {});
    expect(index.split('\n').slice(0, 7)).toEqual([
      '2 of 2', 'offset: 0', 'limit: 20', 'next_offset: null', '',
      `#artifact/${plan} — Latest roadmap`, `#artifact/${guide} — Helpful guide`,
    ]);
    expect(index).toContain('1 parsing issue');
    expect(index).toContain('data loaded best-effort; run validate for detail');
    expect(index).toContain('missing.pdf');
    expect((await handleQueryArtifacts(store, { projects: ['project'], search: 'roadmap', detail: 'full' }))).toContain('Current Markdown body');
    expect(handleQueryArtifacts(store, { projects: [], detail: 'metadata' })).toContain(`target: #artifact/${guide}/brief.pdf`);
    expect(handleQueryArtifacts(store, { created_from: '2026-10-02', created_to: '2026-10-02' })).toContain('1 of 1');
    expect(handleQueryArtifacts(store, { ids: [] })).toContain('ids was an empty list, which matches nothing');
    expect(handleQueryArtifacts(store, { offset: 1, limit: 1 })).toContain('1 of 2');
    expect(() => handleQueryArtifacts(store!, { search: '(' })).toThrow('Invalid regex');
    store.setIndexEntry('artifacts', plan, 'Maintained roadmap');
    expect(handleQueryArtifacts(store, { ids: [plan] })).toContain('Maintained roadmap');
  });

  it('tracks selected filenames even when their artifact has not been created', () => {
    store = new Store(dir);
    store.saveProject('project', { name: 'Project', created: '2026-10-02T09:00' }, `[Future](#artifact/${plan}/notes%20v2.md)`, join(dir, 'projects', '2026', 'project.md'));
    expect(store.getReferencedArtifactFiles()).toEqual([artifactHandle(plan, 'notes v2.md')]);
    const returned = store.getReferencedArtifactFiles();
    returned.length = 0;
    expect(store.getReferencedArtifactFiles()).toHaveLength(1);
  });

  it('watches selected target files for availability without discovering references from bytes', async () => {
    const notes = artifactAttachmentPath(dir, plan, 'notes v2.md');
    write(notes, 'Original content');
    write(artifactAttachmentPath(dir, plan, 'unreferenced.md'), '#artifact/2026-10-02-missing');
    write(artifactAttachmentPath(dir, plan, 'large.bin'), new Uint8Array([1, 2, 3]));
    store = new Store(dir);
    store.saveArtifact(guide, { name: 'Guide', created: '2026-10-01T10:00' }, '', artifactFilePath(dir, guide));
    store.saveArtifact(plan, { name: 'Plan', created: '2026-10-02T10:00' }, artifactHandle(plan, 'notes v2.md'), artifactFilePath(dir, plan));
    store.watch();
    const internals = store as unknown as {
      watcher: { once(event: string, listener: () => void): void; getWatched(): Record<string, string[]> };
      attachmentWatches: Map<string, unknown>;
    };
    await new Promise<void>(resolve => internals.watcher.once('ready', resolve));
    expect(Object.keys(internals.watcher.getWatched())).not.toContain(dirname(notes));
    expect(Array.from(internals.attachmentWatches.keys())).toEqual([notes, dirname(artifactAttachmentPath(dir, guide, 'file')), dirname(notes)]);
    const revision = store.getRevision();
    write(notes, artifactHandle(guide));
    await expect.poll(() => store!.getRevision(), { timeout: 3000 }).toBeGreaterThan(revision);
    expect(store.getArtifactBacklinks(guide)).toEqual([]);
    unlinkSync(notes);
    await expect.poll(() => store!.getIssues().some(issue => issue.code === 'artifact_attachment_read_error'), { timeout: 3000 }).toBe(true);
    write(notes, 'Restored');
    await expect.poll(() => store!.getIssues().some(issue => issue.code === 'artifact_attachment_read_error'), { timeout: 3000 }).toBe(false);
    store.saveArtifact(plan, { name: 'Plan', created: '2026-10-02T10:00' }, '', artifactFilePath(dir, plan));
    expect(Array.from(internals.attachmentWatches.keys())).toEqual([dirname(artifactAttachmentPath(dir, guide, 'file')), dirname(notes)]);
  });

  it('refreshes implicit binary content as attachment counts change externally', async () => {
    const pdf = artifactAttachmentPath(dir, plan, 'brief.pdf');
    const other = artifactAttachmentPath(dir, plan, 'other.bin');
    write(pdf, new Uint8Array([4, 5, 6]));
    store = new Store(dir);
    store.saveArtifact(plan, { name: 'Plan', created: '2026-10-02T10:00' }, '', artifactFilePath(dir, plan));
    const contentFilename = () => artifactContentFilename(store!.getArtifact(plan)!);
    expect(contentFilename()).toBe('brief.pdf');
    store.watch();
    const internals = store as unknown as {
      watcher: { once(event: string, listener: () => void): void; getWatched(): Record<string, string[]> };
      attachmentWatches: Map<string, unknown>;
    };
    await new Promise<void>(resolve => internals.watcher.once('ready', resolve));
    expect(Object.keys(internals.watcher.getWatched())).not.toContain(dirname(pdf));
    expect(Array.from(internals.attachmentWatches.keys())).toEqual([pdf, dirname(pdf)]);
    write(other, new Uint8Array([1, 2, 3]));
    await expect.poll(contentFilename, { timeout: 3000 }).toBeUndefined();
    expect(store.getArtifact(plan)!.frontMatter.attachments).toEqual(['brief.pdf', 'other.bin']);
    unlinkSync(other);
    await expect.poll(contentFilename, { timeout: 3000 }).toBe('brief.pdf');
    unlinkSync(pdf);
    await expect.poll(() => store!.getArtifact(plan)!.frontMatter.attachments, { timeout: 3000 }).toBeUndefined();
    expect(store.getIssues().some(issue => issue.code === 'artifact_attachment_read_error')).toBe(false);

    // A record refresh can observe a brief creation before the attachment poll
    // runs. Its baseline must still notice the immediately following deletion.
    write(pdf, new Uint8Array([7, 8, 9]));
    store.rebuild();
    expect(contentFilename()).toBe('brief.pdf');
    unlinkSync(pdf);
    await expect.poll(contentFilename, { timeout: 3000 }).toBeUndefined();
  });
});
