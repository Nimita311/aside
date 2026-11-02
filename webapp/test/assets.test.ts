import { describe, it, expect } from 'vitest';
import { resolveRelativePath, extractAssetLinks, assetDisplayName, assetMediaKind, looksBinary } from '../lib/types';
import { Store } from '../lib/store';
import type { DataSource, FileRead } from '../lib/io';

const WEEK = 'notes/2026/2026-05-18.md';

describe('resolveRelativePath', () => {
  it('resolves ../ links from a weekly file into the data root', () => {
    expect(resolveRelativePath(WEEK, '../../assets/2026-05-02-migration/2026-05-10-review.md'))
      .toBe('assets/2026-05-02-migration/2026-05-10-review.md');
  });

  it('resolves sibling and ./ links', () => {
    expect(resolveRelativePath(WEEK, '2026-05-11.md')).toBe('notes/2026/2026-05-11.md');
    expect(resolveRelativePath(WEEK, './2026-05-11.md')).toBe('notes/2026/2026-05-11.md');
  });

  it('rejects links that are not plain relative paths', () => {
    expect(resolveRelativePath(WEEK, 'https://example.com/doc.md')).toBeNull();
    expect(resolveRelativePath(WEEK, 'mailto:a@b.c')).toBeNull();
    expect(resolveRelativePath(WEEK, '/absolute/path.md')).toBeNull();
    expect(resolveRelativePath(WEEK, '#section')).toBeNull();
    expect(resolveRelativePath(WEEK, '')).toBeNull();
  });

  it('rejects links that escape the data root', () => {
    expect(resolveRelativePath(WEEK, '../../../outside.md')).toBeNull();
  });

  it('ignores fragments and decodes percent-encoding', () => {
    expect(resolveRelativePath(WEEK, '../../assets/p/file.md#heading')).toBe('assets/p/file.md');
    expect(resolveRelativePath(WEEK, '../../assets/p/my%20file.md')).toBe('assets/p/my file.md');
  });
});

describe('extractAssetLinks', () => {
  it('collects relative markdown links with their titles', () => {
    const md = 'See [load test results](../../assets/2026-05-02-migration/2026-05-22-results.md) '
      + 'and [the site](https://example.com) plus #project/2026-05-02-migration.';
    expect(extractAssetLinks(md, WEEK)).toEqual([
      { path: 'assets/2026-05-02-migration/2026-05-22-results.md', title: 'load test results' },
    ]);
  });

  it('falls back to the file name when the link text is empty', () => {
    const md = '[](../../assets/p/2026-05-22-results.md)';
    expect(extractAssetLinks(md, WEEK)).toEqual([
      { path: 'assets/p/2026-05-22-results.md', title: '2026-05-22-results' },
    ]);
  });

  it('ignores image embeds and links quoted in code', () => {
    const md = [
      '![diagram](../../assets/p/diagram.png)',
      'Inline code: `[x](../../assets/p/fake.md)`',
      '```',
      '[y](../../assets/p/fenced.md)',
      '```',
      'A real [link](../../assets/p/real.md).',
    ].join('\n');
    expect(extractAssetLinks(md, WEEK)).toEqual([
      { path: 'assets/p/real.md', title: 'link' },
    ]);
  });
});

describe('assetDisplayName', () => {
  it('strips directory and extension', () => {
    expect(assetDisplayName('assets/p/2026-05-22-results.md')).toBe('2026-05-22-results');
    expect(assetDisplayName('assets/p/trace.log')).toBe('trace');
    expect(assetDisplayName('assets/p/no-extension')).toBe('no-extension');
  });
});

describe('assetMediaKind', () => {
  it('treats markdown and extensionless files as markdown', () => {
    expect(assetMediaKind('assets/p/notes.md')).toBe('markdown');
    expect(assetMediaKind('assets/p/notes.MARKDOWN')).toBe('markdown');
    expect(assetMediaKind('assets/p/no-extension')).toBe('markdown');
  });

  it('classifies media by extension, case-insensitively', () => {
    expect(assetMediaKind('a/dashboard.HTML')).toBe('webpage');
    expect(assetMediaKind('a/index.htm')).toBe('webpage');
    expect(assetMediaKind('a/diagram.PNG')).toBe('image');
    expect(assetMediaKind('a/logo.svg')).toBe('image');
    expect(assetMediaKind('a/report.pdf')).toBe('pdf');
    expect(assetMediaKind('a/clip.mp4')).toBe('video');
    expect(assetMediaKind('a/voice.m4a')).toBe('audio');
  });

  it('falls back to other for unknown extensions', () => {
    expect(assetMediaKind('a/data.json')).toBe('other');
    expect(assetMediaKind('a/trace.log')).toBe('other');
  });
});

describe('looksBinary', () => {
  it('accepts ordinary text', () => {
    expect(looksBinary('{"ok": true}\nplain text\n')).toBe(false);
    expect(looksBinary('')).toBe(false);
  });

  it('flags NUL bytes and a scatter of replacement chars', () => {
    expect(looksBinary('abc\u0000def')).toBe(true);
    expect(looksBinary('\uFFFD'.repeat(50) + 'x'.repeat(50))).toBe(true);
  });
});

// A minimal in-memory instance: two entries co-occurring across one project and
// one action, one asset link, and an explicit related_projects declaration.
const FILES: Record<string, string> = {
  'notes/2026/index.yaml': [
    '- id: "2026-05-22T15:30"',
    '  description: "Load tested the pipeline."',
    '- id: "2026-05-19T14:15"',
    '  description: "Wrote the onboarding plan."',
  ].join('\n'),
  'projects/2026/index.yaml': [
    '- id: 2026-01-10-pipeline',
    '  description: "Pipeline work."',
    '- id: 2026-01-12-platform',
    '  description: "Platform work."',
  ].join('\n'),
  'actions/2026/index.yaml': [
    '- id: 2026-05-20-run-load-test',
    '  description: "Run the load test."',
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
    'actions: [2026-05-20-run-load-test]',
    '```',
    '',
    'Ran it. Full battery: [results](../../assets/2026-01-10-pipeline/2026-05-22-results.md)',
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
    'related_projects:',
    '  - project: 2026-01-12-platform',
    '    description: runs on it',
    '---',
    '',
    'Pipeline body.',
  ].join('\n'),
  'projects/2026/2026-01-12-platform.md': [
    '---',
    'name: platform',
    'created: 2026-01-12T09:00',
    '---',
    '',
    'Platform body.',
  ].join('\n'),
  'actions/2026/2026-05-20-run-load-test.md': [
    '---',
    'name: run load test',
    'created: 2026-05-20T09:00',
    '---',
    '',
    'Run the full battery.',
  ].join('\n'),
  'assets/2026-01-10-pipeline/2026-05-22-results.md': '# Results\n\nAll green.',
};

class MemorySource implements DataSource {
  async read(path: string): Promise<FileRead | null> {
    const text = FILES[path];
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
    return ['2026'];
  }
}

describe('store relations', () => {
  it('derives relationships from entries, bodies, and explicit links', async () => {
    const store = new Store(new MemorySource());
    await store.init();
    const rel = await store.getRelations();

    // co-occurrence in entry metadata
    expect(rel.actionsByProject.get('2026-01-10-pipeline')).toEqual(['2026-05-20-run-load-test']);
    expect(rel.projectsByAction.get('2026-05-20-run-load-test')).toEqual(['2026-01-10-pipeline']);

    // entries per entity, reverse chronological
    expect(rel.entriesByEntity.get('#project/2026-01-10-pipeline')).toEqual(['2026-05-22T15:30', '2026-05-19T14:15']);

    // asset links propagate to every tagged entity and index back to entries
    const asset = { path: 'assets/2026-01-10-pipeline/2026-05-22-results.md', title: 'results' };
    expect(rel.assetsByEntity.get('#project/2026-01-10-pipeline')).toEqual([asset]);
    expect(rel.assetsByEntity.get('#action/2026-05-20-run-load-test')).toEqual([asset]);
    expect(rel.entriesByAsset.get(asset.path)).toEqual(['2026-05-22T15:30']);

    // explicit related_projects, both directions
    expect(rel.relatedProjects.get('2026-01-10-pipeline')).toEqual([
      { id: '2026-01-12-platform', description: 'runs on it', reverse: false },
    ]);
    expect(rel.relatedProjects.get('2026-01-12-platform')).toEqual([
      { id: '2026-01-10-pipeline', description: 'runs on it', reverse: true },
    ]);
  });

  it('reads raw asset files', async () => {
    const store = new Store(new MemorySource());
    await store.init();
    await expect(store.getAsset('assets/2026-01-10-pipeline/2026-05-22-results.md'))
      .resolves.toContain('All green');
    await expect(store.getAsset('assets/nope.md')).rejects.toThrow('not found');
  });
});
