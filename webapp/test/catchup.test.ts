import { describe, it, expect, vi, afterEach } from 'vitest';
import { Store, type HotSet } from '../lib/store';
import { UrlDataSource, type DataSource, type FileRead } from '../lib/io';

// --- Store catch-up checks against a mutable in-memory source ---

const WEEK = '2026-05-18';

function baseFiles(): Record<string, string> {
  return {
    'notes/2026/index.yaml': [
      '- id: 2026-05-22T15:30',
      '  description: "Ran the load test."',
      '- id: 2026-05-19T14:15',
      '  description: "Planning."',
    ].join('\n'),
    'projects/2026/index.yaml': [
      '- id: 2026-01-10-pipeline',
      '  description: "The pipeline."',
    ].join('\n'),
    'notes/2026/2026-05-18.md': [
      '---',
      'week: 21',
      'week_start: 2026-05-18',
      'week_end: 2026-05-24',
      '---',
      '',
      '---',
      '```entry',
      'created: 2026-05-22T15:30',
      'projects: [2026-01-10-pipeline]',
      '```',
      '',
      'Ran it.',
      '',
      '---',
      '```entry',
      'created: 2026-05-19T14:15',
      'projects: [2026-01-10-pipeline]',
      '```',
      '',
      'Planning only.',
    ].join('\n'),
    'projects/2026/2026-01-10-pipeline.md': [
      '---',
      'name: pipeline',
      'created: 2026-01-10T09:00',
      '---',
      '',
      'Pipeline body.',
    ].join('\n'),
  };
}

class FakeSource implements DataSource {
  files: Record<string, string>;
  failing = new Set<string>();
  constructor(files: Record<string, string>) {
    this.files = files;
  }
  async read(path: string): Promise<FileRead | null> {
    if (this.failing.has(path)) throw new Error(`network error: ${path}`);
    const text = this.files[path];
    return text == null ? null : { text, version: `v:${text}` };
  }
  async revalidate(path: string, version: string): Promise<FileRead | 'unchanged' | null> {
    const result = await this.read(path);
    if (result == null) return null;
    return result.version === version ? 'unchanged' : result;
  }
  assetUrl(): string | null {
    return null;
  }
  async listYears(): Promise<string[]> {
    const years = Object.keys(this.files)
      .map((p) => /^notes\/(\d{4})\/index\.yaml$/.exec(p)?.[1])
      .filter((y): y is string => y != null);
    return [...new Set(years)].sort();
  }
}

const COLD: HotSet = { weeks: [], entities: [], assets: [] };

async function warmStore(source: FakeSource): Promise<Store> {
  const store = new Store(source);
  await store.init();
  await store.getRelations(); // loads every week and builds the relation map
  return store;
}

describe('store catch-up checks', () => {
  it('discovers old and future years added after startup', async () => {
    const source = new FakeSource(baseFiles());
    const store = new Store(source);
    await store.init();
    source.files['notes/2010/index.yaml'] = '- id: "2010-06-03T10:00"\n  description: Imported history\n';
    source.files['notes/2037/index.yaml'] = '- id: "2037-06-03T10:00"\n  description: Future example\n';
    const update = await store.check('light', COLD);
    expect(update).not.toBeNull();
    update!.apply();
    expect(store.getNoteIndex().map(item => item.id)).toContain('2010-06-03T10:00');
    expect(store.getNoteIndex().map(item => item.id)).toContain('2037-06-03T10:00');
  });

  it('finds nothing when nothing changed', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);
    expect(await store.check('light', COLD)).toBeNull();
    expect(await store.check('full', COLD)).toBeNull();
  });

  it('stages a new entry via the index diff and applies it atomically', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);

    source.files['notes/2026/2026-05-18.md'] += [
      '', '---', '```entry', 'created: 2026-05-23T09:00',
      'projects: [2026-01-10-pipeline]', '```', '', 'A new entry.',
    ].join('\n');
    source.files['notes/2026/index.yaml'] =
      '- id: 2026-05-23T09:00\n  description: "A new entry."\n' + source.files['notes/2026/index.yaml'];

    const update = await store.check('light', COLD);
    expect(update).not.toBeNull();
    expect(update!.summary.indexesChanged).toBe(true);
    expect([...update!.summary.weeks]).toEqual([WEEK]);

    // Nothing lands before apply — reads keep serving the pre-check state.
    expect(await store.getWeekEntries(WEEK)).toHaveLength(2);
    expect(store.getNoteIndex()).toHaveLength(2);

    update!.apply();
    expect(await store.getWeekEntries(WEEK)).toHaveLength(3);
    expect(store.getNoteIndex()).toHaveLength(3);
    const relations = await store.getRelations();
    expect(relations.entriesByEntity.get('#project/2026-01-10-pipeline')).toContain('2026-05-23T09:00');
  });

  it('catches a body edit only when the week is hot or the sweep is full', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);

    source.files['notes/2026/2026-05-18.md'] =
      source.files['notes/2026/2026-05-18.md'].replace('Ran it.', 'Ran it twice.');

    // The indexes are identical, so a cold light check sees nothing.
    expect(await store.check('light', COLD)).toBeNull();

    // With the week on screen, the light check revalidates it.
    const hot = await store.check('light', { ...COLD, weeks: [WEEK] });
    expect([...hot!.summary.weeks]).toEqual([WEEK]);
    hot!.apply();
    const entries = await store.getWeekEntries(WEEK);
    expect(entries.find((e) => e.meta.created === '2026-05-22T15:30')!.content).toContain('Ran it twice.');

    // A full sweep catches the same edit with nothing hot.
    source.files['notes/2026/2026-05-18.md'] =
      source.files['notes/2026/2026-05-18.md'].replace('Planning only.', 'Planned more.');
    const full = await store.check('full', COLD);
    expect([...full!.summary.weeks]).toEqual([WEEK]);
  });

  it('discovers a new week through the index and extends the timeline', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);

    source.files['notes/2026/2026-05-25.md'] = [
      '---', 'week: 22', 'week_start: 2026-05-25', 'week_end: 2026-05-31', '---',
      '', '---', '```entry', 'created: 2026-05-26T10:00',
      'projects: [2026-01-10-pipeline]', '```', '', 'Next week.',
    ].join('\n');
    source.files['notes/2026/index.yaml'] =
      '- id: 2026-05-26T10:00\n  description: "Next week."\n' + source.files['notes/2026/index.yaml'];

    const memoBefore = store.filterWeeks({ type: 'project', id: '2026-01-10-pipeline' });
    expect(memoBefore).toEqual([WEEK]);

    const update = await store.check('light', COLD);
    update!.apply();

    expect(store.getWeeklyDates()).toEqual(['2026-05-25', WEEK]);
    expect(await store.getWeekEntries('2026-05-25')).toHaveLength(1);
    // The filter-week memo was recomputed against the new timeline.
    expect(store.filterWeeks({ type: 'project', id: '2026-01-10-pipeline' })).toEqual(['2026-05-25', WEEK]);
  });

  it('adds and removes entities through the index diff', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);

    source.files['projects/2026/2026-02-01-platform.md'] = [
      '---', 'name: platform', 'created: 2026-02-01T09:00', '---', '', 'Platform body.',
    ].join('\n');
    source.files['projects/2026/index.yaml'] += '\n- id: 2026-02-01-platform\n  description: "The platform."';

    const added = await store.check('light', COLD);
    expect(added!.summary.entities.has('#project/2026-02-01-platform')).toBe(true);
    added!.apply();
    expect(store.getDisplayName('project', '2026-02-01-platform')).toBe('platform');
    expect(store.getProjectIndex().map((p) => p.id)).toContain('2026-02-01-platform');

    delete source.files['projects/2026/2026-02-01-platform.md'];
    source.files['projects/2026/index.yaml'] = baseFiles()['projects/2026/index.yaml'];

    const removed = await store.check('light', COLD);
    expect(removed!.summary.entities.has('#project/2026-02-01-platform')).toBe(true);
    removed!.apply();
    // Evicted: the display name degrades to the raw id.
    expect(store.getDisplayName('project', '2026-02-01-platform')).toBe('2026-02-01-platform');
    expect(store.getProjectIndex().map((p) => p.id)).not.toContain('2026-02-01-platform');
  });

  it('renames land through a hot-entity check', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);

    source.files['projects/2026/2026-01-10-pipeline.md'] =
      source.files['projects/2026/2026-01-10-pipeline.md'].replace('name: pipeline', 'name: data pipeline');

    const update = await store.check('light', {
      ...COLD,
      entities: [{ kind: 'project', id: '2026-01-10-pipeline' }],
    });
    update!.apply();
    expect(store.getDisplayName('project', '2026-01-10-pipeline')).toBe('data pipeline');
  });

  it('a deleted weekly file reads as an empty week', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);

    delete source.files['notes/2026/2026-05-18.md'];
    const update = await store.check('full', COLD);
    update!.apply();
    expect(await store.getWeekEntries(WEEK)).toEqual([]);
  });

  it('never evicts on a network error', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);

    source.files['notes/2026/2026-05-18.md'] += '\nedited';
    source.failing.add('notes/2026/2026-05-18.md');
    // The week's check fails — it logs, stays cached, and reports no change.
    expect(await store.check('full', COLD)).toBeNull();
    expect(await store.getWeekEntries(WEEK)).toHaveLength(2);

    // Once the network recovers, the next sweep picks the edit up.
    source.failing.clear();
    const update = await store.check('full', COLD);
    expect([...update!.summary.weeks]).toEqual([WEEK]);
  });

  it('routes pushed paths: a cold week edit lands via a targeted light check', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);

    source.files['notes/2026/2026-05-18.md'] =
      source.files['notes/2026/2026-05-18.md'].replace('Ran it.', 'Ran it thrice.');

    // Cold and index-invisible — but the pushed path checks it directly.
    expect(await store.check('light', COLD)).toBeNull();
    const update = await store.check('light', COLD, ['notes/2026/2026-05-18.md']);
    expect([...update!.summary.weeks]).toEqual([WEEK]);
  });

  it('routes pushed entity paths and ignores unrecognized ones', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);

    source.files['projects/2026/2026-01-10-pipeline.md'] =
      source.files['projects/2026/2026-01-10-pipeline.md'].replace('name: pipeline', 'name: renamed pipeline');

    const update = await store.check('light', COLD, [
      'projects/2026/2026-01-10-pipeline.md',
      'some/unrelated/file.txt', // not a cached asset — ignored
    ]);
    expect(update!.summary.entities.has('#project/2026-01-10-pipeline')).toBe(true);
    update!.apply();
    expect(store.getDisplayName('project', '2026-01-10-pipeline')).toBe('renamed pipeline');
  });

  it('reports whether the source carries validators', async () => {
    const source = new FakeSource(baseFiles());
    const store = await warmStore(source);
    // FakeSource versions are `v:` strings — validator-tier, not `hash:`.
    expect(store.hasValidators()).toBe(true);
  });
});

// --- UrlDataSource revalidation tiers over a mocked fetch ---

type MockResponse = {
  status: number;
  ok: boolean;
  statusText: string;
  headers: Headers;
  text(): Promise<string>;
};

function response(status: number, body = '', headers: Record<string, string> = {}): MockResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    headers: new Headers(headers),
    text: async () => body,
  };
}

describe('UrlDataSource revalidation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(impl: (url: string, init?: RequestInit) => MockResponse | Promise<MockResponse>) {
    const mock = vi.fn(impl);
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('prefers the ETag tier and answers 304 as unchanged', async () => {
    const mock = stubFetch(() => response(200, 'body', { ETag: '"abc"' }));
    const source = new UrlDataSource('http://host/data');
    const read = await source.read('notes/2026/index.yaml');
    expect(read).toEqual({ text: 'body', version: 'etag:"abc"' });
    expect(mock).toHaveBeenCalledWith('http://host/data/notes/2026/index.yaml', { cache: 'no-cache' });

    stubFetch((_url, init) => {
      expect((init!.headers as Record<string, string>)['If-None-Match']).toBe('"abc"');
      return response(304);
    });
    expect(await source.revalidate('notes/2026/index.yaml', read!.version)).toBe('unchanged');

    stubFetch(() => response(200, 'body2', { ETag: '"def"' }));
    expect(await source.revalidate('notes/2026/index.yaml', read!.version))
      .toEqual({ text: 'body2', version: 'etag:"def"' });
  });

  it('falls back to Last-Modified when there is no ETag', async () => {
    stubFetch(() => response(200, 'body', { 'Last-Modified': 'Tue, 07 Jul 2026 10:00:00 GMT' }));
    const source = new UrlDataSource('http://host/data');
    const read = await source.read('a.md');
    expect(read!.version).toBe('lm:Tue, 07 Jul 2026 10:00:00 GMT');

    stubFetch((_url, init) => {
      expect((init!.headers as Record<string, string>)['If-Modified-Since']).toBe('Tue, 07 Jul 2026 10:00:00 GMT');
      return response(304);
    });
    expect(await source.revalidate('a.md', read!.version)).toBe('unchanged');
  });

  it('hash tier: compares content when the server has no validators', async () => {
    stubFetch(() => response(200, 'same'));
    const source = new UrlDataSource('http://host/data');
    const read = await source.read('a.md');
    expect(read!.version.startsWith('hash:')).toBe(true);

    // Unchanged content, full GET, no conditional headers.
    stubFetch((_url, init) => {
      expect(Object.keys((init!.headers as Record<string, string>) ?? {})).toHaveLength(0);
      return response(200, 'same');
    });
    expect(await source.revalidate('a.md', read!.version)).toBe('unchanged');

    stubFetch(() => response(200, 'different'));
    const changed = await source.revalidate('a.md', read!.version);
    expect(changed).not.toBe('unchanged');
    expect((changed as FileRead).text).toBe('different');
  });

  it('reads a 404 as deleted on revalidation', async () => {
    stubFetch(() => response(404));
    const source = new UrlDataSource('http://host/data');
    expect(await source.revalidate('a.md', 'etag:"x"')).toBeNull();
  });

  it('retries a rejected conditional request as a plain GET', async () => {
    let calls = 0;
    stubFetch((_url, init) => {
      calls++;
      if ((init?.headers as Record<string, string> | undefined)?.['If-None-Match']) {
        throw new TypeError('preflight rejected');
      }
      return response(200, 'same-but-no-validator');
    });
    const source = new UrlDataSource('http://host/data');
    const result = await source.revalidate('a.md', 'etag:"x"');
    expect(calls).toBe(2);
    // The retry's response carries no ETag, so the version moved tiers —
    // reported as a change, landing the same bytes; harmless and one-time.
    expect((result as FileRead).version.startsWith('hash:')).toBe(true);
  });
});
