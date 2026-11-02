import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store as DiskStore } from '../../cli/src/mcp/store';
import { loadStaticStore } from '../lib/static-store';
import { Store as BrowserStore } from '../lib/store';
import type { DataSource, FileRead } from '../lib/io';

const P = '2026-10-01-work';
const Q = '2026-10-01-related';
const A = '2026-10-01-review';
const FIRST = '2026-10-02-guide';
const SECOND = '2026-10-02-report';
const ENTRY = '2026-10-02T09:00';
const WEEK = '2026-09-28';
const attachment = `artifacts/2026/${FIRST}/notes.md`;
const record = (name: string, body: string, fields = '') =>
  `---\nname: ${name}\ncreated: 2026-10-02T09:00\n${fields}---\n\n${body}`;

// A static HTTP host can supply this same contract without daemon services.
class Files implements DataSource {
  readonly reads: string[] = [];
  constructor(readonly files: Record<string, string>) {}
  async read(path: string): Promise<FileRead | null> {
    this.reads.push(path);
    const text = this.files[path];
    return text === undefined ? null : { text, version: text };
  }
  async revalidate(path: string, version: string): Promise<FileRead | 'unchanged' | null> {
    const value = await this.read(path);
    return value?.version === version ? 'unchanged' : value;
  }
  assetUrl(path: string): string { return `https://example.test/data/${path}`; }
  async listYears(): Promise<string[]> { return [...new Set(Object.keys(this.files).flatMap(path => path.match(/^(?:notes|projects|actions|artifacts)\/(\d{4})\//)?.[1] ?? []))].sort(); }
}

function fixture(): Record<string, string> {
  return {
    'aside.md': '---\nid: portable\nname: Portable\n---\n',
    'notes/2026/index.yaml': `- id: ${ENTRY}\n  description: Capture`,
    [`notes/2026/${WEEK}.md`]: `---\nweek: 40\nweek_start: ${WEEK}\nweek_end: 2026-10-04\n---\n\n---\n\x60\x60\x60entry\ncreated: ${ENTRY}\nprojects: [${P}]\nactions: [${A}]\n\x60\x60\x60\n\nMention #project/${Q} and #artifact/${FIRST}. [Document](../../assets/brief.md)`,
    'projects/2026/index.yaml': `- id: ${P}\n  description: Work\n- id: ${Q}\n  description: Related`,
    [`projects/2026/${P}.md`]: record('Work', `#artifact/${FIRST}/notes.md`, `related_projects:\n  - project: ${Q}\n    description: Forward\n`),
    [`projects/2026/${Q}.md`]: record('Related', '[Document](../../assets/brief.md)', `related_projects:\n  - project: ${P}\n    description: Return\n`),
    'actions/2026/index.yaml': `- id: ${A}\n  description: Review`,
    [`actions/2026/${A}.md`]: record('Review', `#artifact/${FIRST}`),
    'artifacts/2026/index.yaml': `- id: ${FIRST}\n  description: Guide\n- id: ${SECOND}\n  description: Report`,
    [`artifacts/2026/${FIRST}.md`]: record('Guide', '', 'attachments: [notes.md]\n'),
    [`artifacts/2026/${SECOND}.md`]: record('Report', `#artifact/${FIRST}/notes.md`, 'attachments: [image.png]\n'),
    [attachment]: `---\nexample: '#artifact/${FIRST}'\n---\n#artifact/${SECOND}/image.png #artifact/${SECOND} \x60#artifact/${FIRST}\x60`,
    [`artifacts/2026/${SECOND}/image.png`]: 'binary placeholder',
  };
}

const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function load() {
  const files = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'aside-model-'));
  directories.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const disk = new DiskStore(dir);
  const source = new Files(files);
  const browser = new BrowserStore(source);
  await browser.init();
  return { files, dir, disk, source, browser };
}

describe('portable record model', () => {
  it('derives the same complete graph through disk and browser file adapters', async () => {
    const { disk, source, browser } = await load();
    const graph = await browser.getRelations();

    expect(graph).toEqual(disk.getRelations());
    expect(await browser.getWeekEntries(WEEK)).toEqual(disk.getEntries());
    expect(await browser.getProject(P)).toEqual(disk.getProject(P));
    expect(await browser.getAction(A)).toEqual(disk.getAction(A));
    expect(await browser.getArtifact(FIRST)).toEqual(disk.getArtifact(FIRST));
    expect(disk.getIssues()).toEqual([]);
    // Inline mentions participate in navigation, but never create co-occurrence.
    expect(graph.entriesByEntity.get(`#project/${Q}`)).toEqual([ENTRY]);
    expect(graph.actionsByProject.get(Q)).toBeUndefined();
    expect(graph.actionsByProject.get(P)).toEqual([A]);
    expect(graph.relatedProjects.get(P)).toEqual([
      { id: Q, description: 'Forward', reverse: false },
      { id: Q, description: 'Return', reverse: true },
    ]);
    // Attachment bytes never contribute record relationships.
    expect(graph.projectsByArtifact.get(SECOND)).toBeUndefined();
    expect(graph.artifactBacklinks.get(SECOND)).toBeUndefined();
    expect(graph.entriesByAsset.get('assets/brief.md')).toEqual([ENTRY]);
    expect(source.reads).not.toContain(attachment);
    expect(source.reads).not.toContain(`artifacts/2026/${SECOND}/image.png`);
  });

  it('keeps disk and static indexes newest-year first', async () => {
    const { files, dir, disk, source } = await load();
    const old = '2025-10-01-earlier';
    files['projects/2025/index.yaml'] = `- id: ${old}\n  description: Earlier`;
    files[`projects/2025/${old}.md`] = '---\nname: Earlier\ncreated: 2025-10-01T09:00\n---\n';
    mkdirSync(join(dir, 'projects/2025'), { recursive: true });
    for (const path of ['projects/2025/index.yaml', `projects/2025/${old}.md`]) writeFileSync(join(dir, path), files[path]);
    disk.rebuild();
    const browser = new BrowserStore(source); await browser.init();
    expect(browser.getProjectIndex()).toEqual(disk.getProjectIndex());
    expect(disk.getProjectIndex().at(-1)?.id).toBe(old);
  });

  it('keeps attachment ownership in entry context without adding an artifact backlink', async () => {
    const { dir, disk, browser, source } = await load();
    const weeklyPath = `notes/2026/${WEEK}.md`;
    const previous = disk.getEntries()[0];
    const content = `Read #artifact/${FIRST}/notes.md`;
    source.files[weeklyPath] = source.files[weeklyPath].replace(previous.content, content);
    disk.saveEntry(ENTRY, [P], [A], content, join(dir, weeklyPath), source.files[weeklyPath]);
    const update = await browser.check('full', {weeks: [], entities: [], assets: []}, [weeklyPath]);
    update!.apply();
    const graph = await browser.getRelations();
    expect(graph).toEqual(disk.getRelations());
    expect(graph.artifactsByEntity.get(`#entry/${ENTRY}`)).toEqual([FIRST]);
    expect(graph.artifactBacklinks.get(FIRST)).toEqual([`#action/${A}`]);
    expect(graph.projectsByArtifact.get(FIRST)).toEqual([P]);
    expect(source.reads).not.toContain(attachment);
  });

  it('omits unindexed attachment targets from browser contextual relationships', async () => {
    const { browser, source } = await load();
    const projectPath = `projects/2026/${Q}.md`;
    source.files[projectPath] = record('Work', `#artifact/${FIRST}/missing.md`);
    const update = await browser.check('full', {weeks: [], entities: [], assets: []}, [projectPath]);
    update!.apply();
    const graph = await browser.getRelations();
    expect(graph.artifactsByEntity.get(`#project/${Q}`)).toBeUndefined();
    expect(graph.projectsByArtifact.get(FIRST)).toEqual([P]);
    expect(source.reads).not.toContain(`artifacts/2026/${FIRST}/missing.md`);
  });

  it('runs the core against a plain static file server with no daemon routes', async () => {
    const { files, disk } = await load();
    const request = vi.fn(async (url: string) => {
      const path = decodeURIComponent(url.replace('https://example.test/archive/', ''));
      return files[path] === undefined ? new Response('', { status: 404 }) : new Response(files[path], { headers: { ETag: '"static"' } });
    });
    vi.stubGlobal('fetch', request);
    const { store } = await loadStaticStore('https://example.test/archive/', ['2026']);
    expect(await store.getRelations()).toEqual(disk.getRelations());
    expect(await store.getWeekEntries(WEEK)).toEqual(disk.getEntries());
    const snapshot = await store.snapshot();
    expect(new Map(snapshot.projects).get(P)).toEqual(disk.getProject(P));
    expect(snapshot.weeksByEntity).toContainEqual([`#project/${Q}`, [WEEK]]);
    expect(request.mock.calls.every(([url]) => url.startsWith('https://example.test/archive/'))).toBe(true);
    expect(request.mock.calls.some(([url]) => url.endsWith('/image.png'))).toBe(false);
  });

  it('rebuilds the same graph after an attachment edit and record write', async () => {
    const { files, dir, disk, browser } = await load();
    await browser.getRelations();

    files[attachment] = 'No references remain.';
    writeFileSync(join(dir, attachment), files[attachment]);
    disk.saveAction(A, { name: 'Review', created: '2026-10-02T09:00' }, '', join(dir, `actions/2026/${A}.md`));
    files[`actions/2026/${A}.md`] = record('Review', '');
    const previous = disk.getEntries()[0];
    const content = `${previous.content}\nRevised.`;
    const weeklyPath = `notes/2026/${WEEK}.md`;
    files[weeklyPath] = files[weeklyPath].replace(previous.content, content);
    disk.saveEntry(ENTRY, [P], [A], content, join(dir, weeklyPath), files[weeklyPath]);
    const update = await browser.check('full', { weeks: [], entities: [], assets: [] }, [attachment]);
    expect(update).not.toBeNull();
    update!.apply();
    const graph = await browser.getRelations();
    expect(graph).toEqual(disk.getRelations());
    expect(await browser.getWeekEntries(WEEK)).toEqual(disk.getEntries());
    disk.rebuild();
    expect(await browser.getWeekEntries(WEEK)).toEqual(disk.getEntries());
    expect(graph).toEqual(disk.getRelations());
    expect(graph.artifactBacklinks.has(SECOND)).toBe(false);
    expect(graph.actionsByArtifact.get(FIRST)).toEqual([A]); // Entry metadata still associates it.
  });
});
