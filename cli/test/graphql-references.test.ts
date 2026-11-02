import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildReferenceGraph, buildProjectRelations, type ReferenceRecords } from '../src/graphql/references.js';
import type { Kind, RecordNode } from '../src/graphql/query.js';
import { validate } from '../src/core/validator.js';

const plan = '2026-10-02-plan';
const guide = '2026-10-02-guide';
const project = '2026-10-02-project';
const action = '2026-10-02-action';
const entry = '2026-10-02T10:00';

describe('direct GraphQL content reference graph', () => {
  let root: string;
  let records: ReferenceRecords;
  const handles = (nodes: readonly { handle: string }[]) => nodes.map(node => node.handle);
  function write(path: string, content: string | Uint8Array): void {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  function node(kind: Kind, id: string, body = '', metadata: Record<string, unknown> = {}): RecordNode {
    const record = kind === 'entry'
      ? { meta: { created: id, ...metadata }, content: body, weekFile: '2026-09-28' }
      : { frontMatter: { name: id, created: '2026-10-02T10:00', ...metadata }, body };
    const result = { kind, id, description: null, handle: `#${kind}/${id}`, record, projected: false,
      filePath: join(root, kind === 'entry' ? 'notes/2026/2026-09-28.md' : `${kind}s/2026/${id}.md`) };
    (records[kind] as Map<string, RecordNode>).set(id, result);
    return result;
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aside-graphql-references-'));
    records = { entry: new Map(), project: new Map(), action: new Map(), artifact: new Map() };
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('resolves each concrete type and exact attachment targets, before pagination', () => {
    const source = node('entry', entry, `#project/${project} #action/${action} #artifact/${plan}\n[File](#artifact/${guide}/notes%20v2.md) #project/${project}\n#action/2026-10-02-missing`);
    node('project', project); node('action', action); node('artifact', plan);
    node('artifact', guide, '', { attachments: ['notes v2.md'] });
    write(`artifacts/2026/${guide}/notes v2.md`, `#entry/${entry}`);
    const graph = buildReferenceGraph(root, records);
    expect(graph.page(source, 'links', 1, 2)).toMatchObject({ offset: 1, count: 2, totalCount: 3 });
    expect(handles(graph.links(source))).toEqual([`#action/${action}`, `#artifact/${plan}`, `#project/${project}`]);
    expect(graph.attachmentLinks(source)[0]).toMatchObject({ __typename: 'Attachment', filename: 'notes v2.md', filePath: realpathSync(join(root, `artifacts/2026/${guide}/notes v2.md`)) });
    expect(graph.backlinks(`#artifact/${guide}`)).toEqual([]);
    expect(handles(graph.backlinks(`#artifact/${guide}/notes%20v2.md`))).toEqual([source.handle]);
    expect(graph.backlinks(source)).toEqual([]);
    expect(graph.page(source, 'attachmentLinks')).toMatchObject({ offset: 0, count: 1, totalCount: 1 });
    expect(graph.issues).toEqual([expect.objectContaining({ file: join(root, 'notes/2026/2026-09-28.md'), message: 'Missing action reference: #action/2026-10-02-missing' })]);
    expect(graph.page(source, 'links', 9, 1)).toMatchObject({ nodes: [], offset: 9, count: 0, totalCount: 3 });
  });

  it('uses only direct authored content, excluding contextual tags, code, self and external links', () => {
    const source = node('entry', entry, [
      `#project/${project}`, `\`#action/${action}\``,
      `~~~md\n#action/${action}\n~~~`, `\\#action/${action}`,
      `[Label #action/${action}](https://example.com/#action/${action})`,
      `https://example.com/?target=#action/${action}`,
      'https://example.com/?target=#artifact/2026-10-02-missing',
      `#entry/${entry}`,
    ].join('\n\n'), { actions: [action], projects: [project] });
    node('project', project); node('action', action);
    const graph = buildReferenceGraph(root, records);
    expect(handles(graph.links(source))).toEqual([`#project/${project}`]);
    expect(graph.issues).toEqual([]);
  });

  it('never derives links or diagnostics from attachment bytes', () => {
    node('project', project);
    node('artifact', plan, '', { attachments: ['unreferenced.MARKDOWN', 'binary.pdf'] });
    write(`artifacts/2026/${plan}/unreferenced.MARKDOWN`, `---\ntarget: '#action/missing'\n---\n\n#project/${project}`);
    write(`artifacts/2026/${plan}/binary.pdf`, new Uint8Array([255, 0, 128]));
    const graph = buildReferenceGraph(root, records);
    expect(graph.backlinks(`#project/${project}`)).toEqual([]);
    expect(graph.issues).toEqual([]);
  });

  it('keeps colons inside attachment handles distinct from standalone URI schemes', () => {
    const source = node('entry', entry, `#artifact/${plan}/note:copy.md https://example.com/?target=#action/missing`);
    node('artifact', plan, '', {attachments: ['note:copy.md']});
    write(`artifacts/2026/${plan}/note:copy.md`, 'Notes');
    const graph = buildReferenceGraph(root, records);
    expect(graph.links(source)).toEqual([]);
    expect(handles(graph.attachmentLinks(source))).toEqual([`#artifact/${plan}/note%3Acopy.md`]);
    expect(graph.issues).toEqual([]);
  });

  it('uses only artifact record bodies for links even when primary content is a file', () => {
    const target = node('project', project);
    const implicit = node('artifact', plan, '  \n', { attachments: ['content.md'] });
    write(`artifacts/2026/${plan}/content.md`, `#project/${project}`);
    const body = node('artifact', guide, `#action/${action}`, { attachments: ['support.md'] });
    write(`artifacts/2026/${guide}/support.md`, `#project/${project}`);
    node('action', action);
    const multi = node('artifact', '2026-10-02-multi', '', { attachments: ['one.md', 'two.md'] });
    write('artifacts/2026/2026-10-02-multi/one.md', `#project/${project}`);
    write('artifacts/2026/2026-10-02-multi/two.md', `#action/${action}`);
    const empty = node('artifact', '2026-10-02-empty');
    const graph = buildReferenceGraph(root, records);
    expect(graph.links(implicit)).toEqual([]);
    expect(graph.links(implicit)).toEqual(graph.links(`#artifact/${plan}/content.md`));
    expect(handles(graph.links(body))).toEqual([`#action/${action}`]);
    expect(graph.links(multi)).toEqual([]);
    expect(graph.links(empty)).toEqual([]);
    expect(graph.backlinks(target)).toEqual([]);
  });

  it('allows an artifact to reference its own attachment while keeping backlinks exact', () => {
    const owner = node('artifact', plan, `[Own](#artifact/${plan}/self.md)`, { attachments: ['self.md'] });
    const other = node('artifact', guide, `[Other](#artifact/${plan}/self.md)`);
    write(`artifacts/2026/${plan}/self.md`, `#artifact/${plan}\n[Self](#artifact/${plan}/self.md)`);
    const graph = buildReferenceGraph(root, records);
    expect(graph.links(owner)).toEqual([]);
    expect(handles(graph.attachmentLinks(owner))).toEqual([`#artifact/${plan}/self.md`]);
    expect(graph.links(`#artifact/${plan}/self.md`)).toEqual([]);
    expect(graph.backlinks(owner)).toEqual([]);
    expect(handles(graph.backlinks(`#artifact/${plan}/self.md`))).toEqual([other.handle, owner.handle]);
  });

  it('resolves internal record file links and entry fragments using their actual file paths', () => {
    const source = node('artifact', plan, `[Project](../../projects/2026/${project}.md)\n[Entry](../../notes/2026/2026-09-28.md#entry/${entry})\n[Wrong year](../../projects/2025/${project}.md)\n[Weekly container](../../notes/2026/2026-09-28.md)`);
    node('project', project); node('entry', entry);
    const graph = buildReferenceGraph(root, records);
    expect(handles(graph.links(source))).toEqual([`#entry/${entry}`, `#project/${project}`]);
    expect(graph.issues).toEqual([expect.objectContaining({ message: expect.stringContaining(`Missing project reference: #project/${project} (projects/2025/${project}.md)`) })]);
  });

  it('uses the copied record filepath when resolving relative links', () => {
    const source = node('artifact', plan, `[Project](../../projects/2026/${project}.md)`);
    Object.assign(source, { filePath: join(root, `artifacts/2025/${plan}.md`) });
    const target = node('project', project);
    Object.assign(target, { filePath: join(root, `projects/2026/${project}.md`) });
    expect(handles(buildReferenceGraph(root, records).links(source))).toEqual([target.handle]);
  });

  it('resolves absolute internal file destinations and reports internal missing targets while ignoring outside paths and URLs', () => {
    const rootAlias = realpathSync(root);
    const source = node('entry', entry, [
      `[Project](${join(root, `projects/2026/${project}.md`)})`,
      `[Attachment](<${join(rootAlias, `artifacts/2026/${plan}/notes v2.md`)}>)`,
      `[Missing](${join(rootAlias, 'actions/2026/2026-10-02-missing.md')})`,
      `[Outside](${join(dirname(root), `projects/2026/${project}.md`)})`,
      `[Escape](${root}/../projects/2026/${project}.md)`,
      `[External](https://example.com${root}/projects/2026/${project}.md)`,
      `[File URL](file://${root}/projects/2026/${project}.md)`,
    ].join('\n'));
    node('project', project);
    node('artifact', plan, '', { attachments: ['notes v2.md'] });
    write(`artifacts/2026/${plan}/notes v2.md`, `#entry/${entry}`);
    const graph = buildReferenceGraph(root, records);
    expect(handles(graph.links(source))).toEqual([`#project/${project}`]);
    expect(handles(graph.attachmentLinks(source))).toEqual([`#artifact/${plan}/notes%20v2.md`]);
    expect(graph.issues).toEqual([expect.objectContaining({ file: join(root, 'notes/2026/2026-09-28.md'), message: 'Missing action reference: #action/2026-10-02-missing (actions/2026/2026-10-02-missing.md)' })]);
  });

  it('keeps projected forward content without creating persistent backlink sources', () => {
    const template = node('action', action, `#artifact/${plan}`, { recurrence: [{}] });
    const projection = node('action', '~projection', template.record.body, { occurrence: { template: action } });
    projection.projected = true;
    node('artifact', plan);
    const graph = buildReferenceGraph(root, records);
    expect(handles(graph.links(projection))).toEqual([`#artifact/${plan}`]);
    expect(handles(graph.backlinks(`#artifact/${plan}`))).toEqual([template.handle]);
  });

  it('omits missing or symlinked attachments and reports problems with their source and target', () => {
    const source = node('entry', entry, `[Missing](#artifact/${plan}/missing.md) [Symlink](#artifact/${plan}/linked.md)`);
    node('artifact', plan, '', { attachments: ['missing.md', 'linked.md'] });
    write('outside.md', `#project/${project}`);
    mkdirSync(join(root, `artifacts/2026/${plan}`), { recursive: true });
    symlinkSync(join(root, 'outside.md'), join(root, `artifacts/2026/${plan}/linked.md`));
    const graph = buildReferenceGraph(root, records);
    expect(graph.page(source, 'attachmentLinks')).toMatchObject({ nodes: [], count: 0, totalCount: 0 });
    expect(graph.issues.some(issue => issue.file === join(root, 'notes/2026/2026-09-28.md') && issue.message.includes('missing.md'))).toBe(true);
    expect(graph.issues.some(issue => issue.message.includes('linked.md') && issue.message.includes('Symlinks are not allowed'))).toBe(true);
    expect(graph.backlinks(`#project/${project}`)).toEqual([]);
  });

  it('resolves invalid UTF-8 and large files as attachments without reading their contents', () => {
    const source = node('entry', entry, `#artifact/${plan}/invalid.md #artifact/${plan}/huge.md`);
    node('artifact', plan, '', { attachments: ['invalid.md', 'huge.md'] });
    write(`artifacts/2026/${plan}/invalid.md`, new Uint8Array([255]));
    write(`artifacts/2026/${plan}/huge.md`, new Uint8Array(8 * 1024 * 1024 + 1));
    const graph = buildReferenceGraph(root, records);
    expect(graph.attachmentLinks(source)).toHaveLength(2);
    expect(graph.issues).toEqual([]);
  });

  it('respects cancellation and collection page bounds', () => {
    node('entry', entry);
    const controller = new AbortController(); controller.abort();
    expect(() => buildReferenceGraph(root, records, controller.signal)).toThrow('cancelled');
    const graph = buildReferenceGraph(root, records);
    expect(() => graph.page(`#entry/${entry}`, 'links', -1, 20)).toThrow('offset');
    expect(() => graph.page(`#entry/${entry}`, 'links', 0, 101)).toThrow('limit');
  });

  it('merges reciprocal project declarations while retaining each description and excluding missing/self targets', () => {
    const first = node('project', project, '', { related_projects: [
      { project: guide, description: 'Discovers detail' }, { project: project, description: 'Self' }, { project: 'missing', description: 'Missing' },
    ] });
    const second = node('project', guide, '', { related_projects: [{ project, description: 'Related overview' }] });
    const third = node('project', plan, '', { related_projects: [{ project, description: 'One way' }] });
    const relations = buildProjectRelations(records.project);
    expect(relations.get(project)).toEqual([
      { project: second, direction: 'bidirectional', outgoingDescription: 'Discovers detail', incomingDescription: 'Related overview' },
      { project: third, direction: 'incoming', outgoingDescription: null, incomingDescription: 'One way' },
    ]);
    expect(relations.get(plan)).toEqual([{ project: first, direction: 'outgoing', outgoingDescription: 'One way', incomingDescription: null }]);
  });

  it('validates missing content/metadata references with source file, entity type, and ID', () => {
    write('aside.md', '---\nid: test\nname: Test\n---\n');
    write(`projects/2026/${project}.md`, `---\nname: Project\ncreated: 2026-10-02T10:00\nrelated_projects:\n  - project: 2026-10-02-missing-related\n    description: Missing\n---\n#action/2026-10-02-missing-action\n#entry/2026-10-02T09:00\n[Missing absolute](${join(root, 'actions/2026/2026-10-02-missing-absolute.md')})`);
    write('notes/2026/2026-09-28.md', '---\nweek: 40\nweek_start: 2026-09-28\nweek_end: 2026-10-04\n---\n\n---\n```entry\ncreated: 2026-10-02T10:00\nprojects: [2026-10-02-missing-tag]\n```\n\nText\n');
    write(`artifacts/2026/${plan}.md`, `---\nname: Plan\ncreated: 2026-10-02T10:00\nattachments: [notes.md]\n---\n`);
    write(`artifacts/2026/${plan}/notes.md`, '#project/2026-10-02-missing-attachment');
    const checks = validate(root).checks;
    const inline = checks.find(check => check.name === 'Inline mentions reference existing entities')!;
    expect(inline.passed).toBe(false);
    expect(inline.details).toEqual(expect.arrayContaining([
      expect.stringContaining(`projects/2026/${project}.md: #project/${project} references missing action #action/2026-10-02-missing-action`),
      expect.stringContaining(`projects/2026/${project}.md: #project/${project} references missing entry #entry/2026-10-02T09:00`),
      expect.stringContaining(`projects/2026/${project}.md: #project/${project} references missing action #action/2026-10-02-missing-absolute (actions/2026/2026-10-02-missing-absolute.md)`),
    ]));
    expect(inline.details?.some(detail => detail.includes('missing-attachment'))).toBe(false);
    expect(checks.find(check => check.name === 'Referenced projects have files')?.details).toContain('notes/2026/2026-09-28.md: #entry/2026-10-02T10:00 references missing project 2026-10-02-missing-tag');
    expect(checks.find(check => check.name === 'Related projects reference existing projects')?.details).toContain(`projects/2026/${project}.md: related project '2026-10-02-missing-related' not found`);
  });
});
