import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store, type HotSet } from '../lib/store';
import { UrlDataSource, type DataSource, type FileRead } from '../lib/io';

const A = '2026-10-02-guide';
const B = '2026-10-01-report';
const P = '2026-09-30-work';
const ACT = '2026-09-30-review';
const ENTRY = '2026-10-02T09:00';
const WEEK = '2026-09-28';
const COLD: HotSet = { weeks: [], entities: [], assets: [] };
const lateReadCases = [
  ['edit', 'before apply'], ['edit', 'after apply'],
  ['deletion', 'before apply'], ['deletion', 'after apply'],
] as const;
const record = (name: string, body = '', attachments?: string[]) =>
  `---\nname: ${name}\ncreated: 2026-10-02T09:00\n${attachments === undefined ? '' : `attachments: ${JSON.stringify(attachments)}\n`}---\n\n${body}`;
const attachment = (id: string, filename: string) => `artifacts/${id.slice(0, 4)}/${id}/${filename}`;

class Source implements DataSource {
  reads: string[] = [];
  mediaChecks: string[] = [];
  failing = new Set<string>();
  mediaVersions = new Map<string, string | null>();
  constructor(public files: Record<string, string>) {}
  async read(path: string): Promise<FileRead | null> {
    this.reads.push(path);
    if (this.failing.has(path)) throw new Error('offline');
    const text = this.files[path];
    return text === undefined ? null : { text, version: `v:${text}` };
  }
  async revalidate(path: string, version: string): Promise<FileRead | 'unchanged' | null> {
    const read = await this.read(path);
    return read?.version === version ? 'unchanged' : read;
  }
  assetUrl(path: string): string { return `https://host/data/${path}`; }
  async assetVersion(path: string): Promise<string | null | undefined> {
    this.mediaChecks.push(path);
    return this.mediaVersions.get(path);
  }
  async listYears(): Promise<string[]> {
    return [...new Set(Object.keys(this.files).flatMap(path => /^\w+\/(\d{4})\/index\.yaml$/.exec(path)?.[1] ?? []))].sort();
  }
}

function baseFiles(): Record<string, string> {
  return {
    'artifacts/2026/index.yaml': `- id: ${A}\n  description: Guide details\n- id: ${B}\n  description: Report details`,
    [`artifacts/2026/${A}.md`]: record('Guide', `Read #artifact/${B}.`),
    [`artifacts/2026/${B}.md`]: record('Report', 'Report content.'),
  };
}

async function load(files = baseFiles()) {
  const source = new Source(files);
  const store = new Store(source);
  await store.init();
  return { source, store };
}

describe('artifact browser store', () => {
  it('loads names and searchable bodies in a year with no entries', async () => {
    const { store } = await load();
    expect(store.getNoteIndex()).toEqual([]);
    expect(store.getArtifactIndex().map(item => item.id)).toEqual([A, B]);
    expect(store.getArtifactDisplayName(A)).toBe('Guide');
    expect(store.getCachedArtifact(A)?.body).toContain(`#artifact/${B}`);
    expect(store.getCachedArtifactContents().get(B)).toBe('Report content.');
    expect((await store.getRelations()).artifactBacklinks.get(B)).toEqual([`#artifact/${A}`]);
  });

  it('deduplicates inline references and derives context only from each source', async () => {
    const files = baseFiles();
    files[`projects/2026/${P}.md`] = record('Work', `#artifact/${A}/notes.md #artifact/${A}`);
    files['projects/2026/index.yaml'] = `- id: ${P}\n  description: Work`;
    files[`actions/2026/${ACT}.md`] = record('Review', `#artifact/${A}`);
    files['actions/2026/index.yaml'] = `- id: ${ACT}\n  description: Review`;
    files['notes/2026/index.yaml'] = `- id: ${ENTRY}\n  description: Captured`;
    files[`notes/2026/${WEEK}.md`] = `---\nweek: 40\nweek_start: ${WEEK}\nweek_end: 2026-10-04\n---\n\n---\n\x60\x60\x60entry\ncreated: ${ENTRY}\nprojects: [${P}]\nactions: [${ACT}]\n\x60\x60\x60\n\n#artifact/${A} [image](#artifact/${A}/desktop.png)`;
    files[attachment(A, 'notes.md')] = `---\nexample: '#artifact/${A}'\n---\n#artifact/${B} #artifact/${B}\n#artifact/${A}\n\x60#artifact/${A}\x60`;
    const { source, store } = await load(files);
    const rel = await store.getRelations();
    expect(rel.artifactBacklinks.get(A)).toEqual([`#project/${P}`, `#entry/${ENTRY}`, `#action/${ACT}`]);
    expect(rel.artifactBacklinks.get(B)).toEqual([`#artifact/${A}`]);
    expect(rel.projectsByArtifact.get(A)).toEqual([P]);
    expect(rel.actionsByArtifact.get(A)).toEqual([ACT]);
    expect(rel.projectsByArtifact.get(B)).toBeUndefined();
    expect(rel.artifactsByEntity.get(`#project/${P}`)).toEqual([A]);
    expect(source.reads).not.toContain(attachment(A, 'desktop.png'));
  });

  it('never reads sole-attachment or referenced file bytes to derive relationships', async () => {
    const files = baseFiles();
    files[`artifacts/2026/${A}.md`] = record('Guide', '', ['notes.md']);
    files[attachment(A, 'notes.md')] = `#artifact/${B}/report.markdown`;
    files[attachment(B, 'report.markdown')] = `#artifact/${A}/notes.md`;
    files[attachment(A, 'ignored.md')] = `#artifact/${B}`;
    const { store, source } = await load(files);
    const rel = await store.getRelations();
    expect(rel.artifactBacklinks.has(B)).toBe(false);
    expect(rel.artifactBacklinks.has(A)).toBe(false);
    expect(source.reads).not.toContain(attachment(A, 'notes.md'));
    expect(source.reads).not.toContain(attachment(B, 'report.markdown'));
    expect(source.reads).not.toContain(attachment(A, 'ignored.md'));
  });

  it('stages artifact metadata without reading its new primary file', async () => {
    const { source, store } = await load();
    await store.getRelations();
    source.files[`artifacts/2026/${A}.md`] = record('Renamed guide', '', ['notes.md']);
    source.files[attachment(A, 'notes.md')] = `#artifact/${B}`;
    const update = await store.check('light', { ...COLD, entities: [{ kind: 'artifact', id: A }] });
    expect(update?.summary.entities.has(`#artifact/${A}`)).toBe(true);
    expect(update?.summary.assets.has(attachment(A, 'notes.md'))).toBe(false);
    expect(store.getArtifactDisplayName(A)).toBe('Guide');
    expect((await store.getRelations()).artifactBacklinks.get(B)).toEqual([`#artifact/${A}`]);
    update!.apply();
    expect(store.getArtifactDisplayName(A)).toBe('Renamed guide');
    expect(store.getCachedArtifactContents().get(A)).toBe('');
    expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);
  });

  it('updates backlinks only from record body changes', async () => {
    const files = baseFiles();
    const path = `artifacts/2026/${A}.md`;
    files[path] = record('Guide', '', ['notes.md']);
    files[attachment(A, 'notes.md')] = `#artifact/${B}`;
    files[attachment(A, 'support.md')] = `#artifact/${B}`;
    const { store, source } = await load(files);
    expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);

    const change = async (body: string, filenames: string[]) => {
      source.files[path] = record('Guide', body, filenames);
      const update = await store.check('light', COLD, [path]);
      expect(update?.summary.entities.has(`#artifact/${A}`)).toBe(true);
      update!.apply();
      return (await store.getRelations()).artifactBacklinks.get(B);
    };

    expect(await change('', ['notes.md', 'support.md'])).toBeUndefined();
    expect(source.reads).not.toContain(attachment(A, 'support.md'));
    expect(await change('', ['support.md'])).toBeUndefined();
    expect(await change(`Current context #artifact/${B}.`, ['support.md'])).toEqual([`#artifact/${A}`]);
    expect(await change(' \n ', ['support.md'])).toBeUndefined();
    expect(await change('', [])).toBeUndefined();
  });

  it('does not fetch indexed attachments unless selected or referenced', async () => {
    const files = baseFiles();
    files[`artifacts/2026/${A}.md`] = record('Guide', '', ['notes.md', 'desktop.png']);
    files[attachment(A, 'notes.md')] = `#artifact/${B}`;
    files[attachment(A, 'desktop.png')] = 'binary image';
    const { source, store } = await load(files);
    const rel = await store.getRelations();
    expect(store.getCachedArtifact(A)?.frontMatter.attachments).toEqual(['notes.md', 'desktop.png']);
    expect(rel.artifactBacklinks.has(B)).toBe(false);
    await store.check('full', COLD);
    for (const filename of ['notes.md', 'desktop.png']) {
      expect(source.reads).not.toContain(attachment(A, filename));
      expect(source.mediaChecks).not.toContain(attachment(A, filename));
    }
  });

  it('does not load an attachment merely because a record references it', async () => {
    const files = baseFiles();
    files[`artifacts/2026/${A}.md`] = record('Guide', `Read #artifact/${A}/notes.md.`, ['notes.md', 'desktop.png']);
    files[attachment(A, 'notes.md')] = `#artifact/${B}`;
    const { store, source } = await load(files);
    expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);
    expect(source.reads).not.toContain(attachment(A, 'notes.md'));
    expect(source.reads).not.toContain(attachment(A, 'desktop.png'));
  });

  it('checks explicitly loaded supporting files when they are visible', async () => {
    const files = baseFiles();
    files[`artifacts/2026/${A}.md`] = record('Guide', '', ['notes.md']);
    files[attachment(A, 'notes.md')] = `#artifact/${B}`;
    const { store, source } = await load(files);
    await store.getAsset(attachment(A, 'notes.md'));
    source.files[attachment(A, 'notes.md')] = 'Updated without a reference.';
    const update = await store.check('light', { ...COLD, assets: [attachment(A, 'notes.md')] });
    expect(update?.summary.assets.has(attachment(A, 'notes.md'))).toBe(true);
    update!.apply();
    expect(await store.getAsset(attachment(A, 'notes.md'))).toBe('Updated without a reference.');
    expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);
  });

  it('keeps relationships independent of unavailable primary attachment text', async () => {
    const { store, source } = await load();
    await store.getRelations();
    const path = attachment(A, 'notes.md');
    source.files[`artifacts/2026/${A}.md`] = record('Guide', '', ['notes.md']);
    source.files[path] = `#artifact/${B}`;
    source.failing.add(path);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const update = await store.check('light', COLD, [`artifacts/2026/${A}.md`]);
      update!.apply();
      source.failing.delete(path);
      expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not wait for attachment reads while deriving relationships', async () => {
    const files = baseFiles();
    files[`artifacts/2026/${A}.md`] = record('Guide', `#artifact/${A}/first.md`);
    files[attachment(A, 'first.md')] = 'First attachment.';
    const { store, source } = await load(files);
    let release!: () => void;
    let began!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    const read = source.read.bind(source);
    source.read = async path => {
      if (path === attachment(A, 'first.md')) {
        began();
        await gate;
      }
      return read(path);
    };
    const loading = store.getAsset(attachment(A, 'first.md'));
    await started;
    const extra = '2026-10-02-extra';
    source.files[`artifacts/2026/${extra}.md`] = record('Extra', `#artifact/${B}`);
    await store.getArtifact(extra);
    expect((await store.getRelations()).artifactBacklinks.get(B)).toEqual([`#artifact/${extra}`]);
    release();
    expect(await loading).toBe('First attachment.');
  });

  it.each(lateReadCases)('keeps a catch-up %s when an older artifact request completes %s', async (mode, timing) => {
    const files = baseFiles();
    files['artifacts/2026/index.yaml'] = `- id: ${B}\n  description: Report`;
    const { store, source } = await load(files);
    await store.getRelations();
    const path = `artifacts/2026/${A}.md`;
    let release!: () => void;
    let began!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    const read = source.read.bind(source);
    let delayed = false;
    source.read = async currentPath => {
      if (currentPath !== path || delayed) return read(currentPath);
      delayed = true;
      const snapshot = await read(currentPath);
      began();
      await gate;
      return snapshot;
    };
    const loading = store.getArtifact(A);
    await started;
    if (mode === 'deletion') delete source.files[path];
    else {
      source.files[path] = record('Latest guide', `Updated #artifact/${B}.`);
      source.files['artifacts/2026/index.yaml'] += `\n- id: ${A}\n  description: Guide`;
    }
    const update = await store.check('light', COLD, [path]);
    expect(update?.summary.entities.has(`#artifact/${A}`)).toBe(true);
    if (timing === 'before apply') {
      release();
      expect((await loading).frontMatter.name).toBe('Guide');
      update!.apply();
    } else {
      update!.apply();
      release();
    }
    if (mode === 'deletion') {
      if (timing === 'after apply') await expect(loading).rejects.toThrow('artifact file not found');
      expect(store.getCachedArtifact(A)).toBeUndefined();
      expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);
    } else {
      if (timing === 'after apply') expect((await loading).frontMatter.name).toBe('Latest guide');
      expect(store.getArtifactDisplayName(A)).toBe('Latest guide');
      expect(store.getCachedArtifactContents().get(A)).toBe(`Updated #artifact/${B}.`);
      expect((await store.getRelations()).artifactBacklinks.get(B)).toEqual([`#artifact/${A}`]);
    }
    expect(await store.check('full', COLD)).toBeNull();
  });

  it.each(lateReadCases)('keeps a catch-up %s when an older attachment request completes %s', async (mode, timing) => {
    const files = baseFiles();
    files[`artifacts/2026/${A}.md`] = record('Guide', '', ['notes.md']);
    const path = attachment(A, 'notes.md');
    files[path] = `#artifact/${B}`;
    const { store, source } = await load(files);
    let release!: () => void;
    let began!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { began = resolve; });
    const read = source.read.bind(source);
    let delayed = false;
    source.read = async currentPath => {
      if (currentPath !== path || delayed) return read(currentPath);
      delayed = true;
      const snapshot = await read(currentPath);
      began();
      await gate;
      return snapshot;
    };
    const loading = store.getAsset(path);
    await started;
    if (mode === 'deletion') delete source.files[path];
    else source.files[path] = 'The reference was removed.';
    const update = await store.check('light', { ...COLD, assets: [path] }, [path]);
    expect(update).not.toBeNull();
    if (timing === 'before apply') {
      release();
      expect(await loading).toBe(`#artifact/${B}`);
      update!.apply();
    } else {
      update!.apply();
      release();
      if (mode === 'deletion') await expect(loading).rejects.toThrow('Asset file not found');
      else expect(await loading).toBe('The reference was removed.');
    }
    expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);
    if (mode === 'deletion') await expect(store.getAsset(path)).rejects.toThrow('Asset file not found');
    else expect(await store.getAsset(path)).toBe('The reference was removed.');
    expect(await store.check('light', COLD)).toBeNull();
  });

  it.each(['content', 'missing'] as const)('keeps a later artifact read of %s when a staged update applies', async result => {
    const files = baseFiles();
    const path = `artifacts/2026/${A}.md`;
    files['artifacts/2026/index.yaml'] = `- id: ${B}\n  description: Report`;
    const { store, source } = await load(files);
    await store.getRelations();
    source.files[path] = record('Staged guide', `#artifact/${B}`);
    source.files['artifacts/2026/index.yaml'] += `\n- id: ${A}\n  description: Guide`;
    const update = await store.check('light', COLD, [path]);
    expect(update).not.toBeNull();

    if (result === 'missing') delete source.files[path];
    else source.files[path] = record('Latest guide');
    const loading = store.getArtifact(A);
    if (result === 'missing') await expect(loading).rejects.toThrow('file not found');
    else await loading;
    update!.apply();

    if (result === 'missing') expect(store.getCachedArtifact(A)).toBeUndefined();
    else expect(store.getArtifactDisplayName(A)).toBe('Latest guide');
    expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);
  });

  it('detects deletion and reappearance of an explicitly read attachment', async () => {
    const files = baseFiles();
    files[`artifacts/2026/${A}.md`] = record('Guide', '', ['notes.md']);
    const path = attachment(A, 'notes.md');
    files[path] = `#artifact/${B}`;
    const { store, source } = await load(files);
    await store.getAsset(path);
    delete source.files[path];
    const deleted = await store.check('light', { ...COLD, assets: [path] }, [path]);
    deleted!.apply();
    await expect(store.getAsset(path)).rejects.toThrow('Asset file not found');
    expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);
    source.files[path] = `#artifact/${B}`;
    const restored = await store.check('light', { ...COLD, assets: [path] }, [path]);
    restored!.apply();
    expect(await store.getAsset(path)).toBe(`#artifact/${B}`);
    expect((await store.getRelations()).artifactBacklinks.has(B)).toBe(false);
  });

  it('adds and deletes artifact records from index changes', async () => {
    const { source, store } = await load();
    source.files['artifacts/2026/index.yaml'] += '\n- id: 2026-10-03-plan\n  description: Plan';
    source.files['artifacts/2026/2026-10-03-plan.md'] = record('Plan');
    const added = await store.check('light', COLD);
    added!.apply();
    expect(store.getArtifactDisplayName('2026-10-03-plan')).toBe('Plan');
    delete source.files[`artifacts/2026/${B}.md`];
    source.files['artifacts/2026/index.yaml'] = `- id: ${A}\n  description: Guide`;
    const deleted = await store.check('light', COLD);
    deleted!.apply();
    expect(store.getCachedArtifact(B)).toBeUndefined();
    expect(store.getCachedArtifactContents().has(B)).toBe(false);
  });

  it('refreshes selected media URLs from metadata without reading bytes', async () => {
    const { store, source } = await load();
    const path = attachment(A, 'desktop.png');
    const initial = store.assetUrl(path);
    source.mediaVersions.set(path, 'etag:first');
    const baseline = await store.check('light', { ...COLD, assets: [path] });
    baseline!.apply();
    const first = store.assetUrl(path);
    expect(first).not.toBe(initial);
    source.mediaVersions.set(path, 'etag:second');
    const update = await store.check('light', { ...COLD, assets: [path] });
    expect(update?.summary.assets.has(path)).toBe(true);
    expect(store.assetUrl(path)).toBe(first);
    update!.apply();
    expect(store.assetUrl(path)).not.toBe(first);
    expect(source.reads).not.toContain(path);
  });

  it('refreshes pushed media changes even without metadata support', async () => {
    const { store, source } = await load();
    const path = attachment(A, 'desktop.png');
    const initial = store.assetUrl(path);
    const update = await store.check('light', COLD, [path]);
    update!.apply();
    expect(store.assetUrl(path)).not.toBe(initial);
    expect(source.reads).not.toContain(path);
  });
});

describe('artifact URL data source', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('discovers artifact-only years by probing all entity indexes', async () => {
    const year = String(new Date().getFullYear());
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response('', {
      status: url.endsWith(`/artifacts/${year}/index.yaml`) ? 200 : 404,
    })));
    expect(await new UrlDataSource('https://host/data').listYears()).toEqual([year]);
  });

  it('uses HEAD validators to check media without decoding a response body', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200, headers: { ETag: '"media-v2"' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await new UrlDataSource('https://host/data').assetVersion('artifacts/2026/guide/desktop #1.png')).toBe('etag:"media-v2"');
    expect(fetch).toHaveBeenCalledWith('https://host/data/artifacts/2026/guide/desktop%20%231.png', { method: 'HEAD', cache: 'no-cache' });
  });
});
