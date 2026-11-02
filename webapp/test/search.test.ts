import { describe, it, expect } from 'vitest';
import { search, SearchOptions } from '../src/search';

// Small library records exercise names, descriptions, dates, and full text.
const projectIndex = [
  {
    id: '2025-11-06-reading-room-refresh',
    description:
      'Refresh the reading room with new chairs, better lighting, and an updated library catalog.',
  },
  {
    id: '2024-08-13-book-restoration',
    description:
      'Book restoration work repairs torn pages and worn bindings so older books can return to circulation.',
  },
];

const actionIndex = [
  {
    id: '2026-04-16-write-catalog-guide',
    description:
      'Write a library blog post about the catalog: shelves, book labels, and checkout rules.',
  },
  {
    id: '2024-10-23-survey-book-restoration',
    description:
      'Survey book restoration methods and summarize safe ways to mend paper and bindings.',
  },
];

const noteIndex = [
  { id: '2026-04-16T14:30', description: 'Wrote the catalog guide for the library blog.' },
  { id: '2025-11-20T09:30', description: 'Reviewed the room layout and agreed on the remaining furniture choices.' },
  { id: '2024-10-23T14:30', description: 'Survey of book restoration techniques' },
];

const names: Record<string, string> = {
  '2025-11-06-reading-room-refresh': 'Reading Room Refresh',
  '2024-08-13-book-restoration': 'Book Restoration',
  '2026-04-16-write-catalog-guide': 'Write catalog guide',
  '2024-10-23-survey-book-restoration': 'Survey book restoration',
};

const opts: SearchOptions = { resolveName: (_type, id) => names[id] ?? id };

function run(query: string, o: SearchOptions = opts) {
  return search(query, noteIndex, projectIndex, actionIndex, o);
}

describe('search', () => {
  it('returns nothing for an empty query', () => {
    expect(run('   ')).toEqual({ results: [], terms: [] });
  });

  it('matches the display name, spaces and case included', () => {
    const { results } = run('Reading Room Refresh');
    expect(results[0]).toMatchObject({ type: 'project', id: '2025-11-06-reading-room-refresh' });
  });

  it('requires every term to match (AND)', () => {
    const { results, terms } = run('catalog blog');
    expect(terms).toEqual(['catalog', 'blog']);
    expect(results.map((r) => r.id)).toEqual([
      '2026-04-16-write-catalog-guide',
      '2026-04-16T14:30',
    ]);
    expect(run('catalog nonexistent').results).toEqual([]);
  });

  it('restricts result types with project:/action:/note: prefixes, plurals included', () => {
    expect(run('project:restoration').results.map((r) => r.type)).toEqual(['project']);
    expect(run('action:restoration').results.map((r) => r.type)).toEqual(['action']);
    expect(run('note:survey').results.map((r) => r.type)).toEqual(['entry']);
    expect(run('entries:survey').results.map((r) => r.type)).toEqual(['entry']);
    expect(run('projects:restoration').results.map((r) => r.type)).toEqual(['project']);
  });

  it('lists a whole type for a bare prefix', () => {
    expect(run('project:').results.map((r) => r.id)).toEqual(projectIndex.map((p) => p.id));
  });

  it('filters by inclusive date range, on entries and date-coded entity ids alike', () => {
    const { results } = run('2025-01..2025-11');
    expect(results.map((r) => r.id)).toEqual([
      '2025-11-06-reading-room-refresh',
      '2025-11-20T09:30',
    ]);
  });

  it('supports open-ended ranges and composes them with terms', () => {
    expect(run('..2024-10').results.map((r) => r.id)).toEqual([
      '2024-08-13-book-restoration',
      '2024-10-23-survey-book-restoration',
      '2024-10-23T14:30',
    ]);
    expect(run('2026-01.. catalog').results.map((r) => r.id)).toEqual([
      '2026-04-16-write-catalog-guide',
      '2026-04-16T14:30',
    ]);
  });

  it('offers a date jump for date-shaped queries, above the text matches', () => {
    expect(run('2026-04').results[0]).toMatchObject({ type: 'date', id: '2026-04-01' });
    expect(run('apr 2026').results[0]).toMatchObject({ type: 'date', id: '2026-04-01' });
  });

  it('offers no date jump under a type prefix', () => {
    expect(run('project:2026-04').results.every((r) => r.type === 'project')).toBe(true);
  });

  it('ranks an exact id match first', () => {
    const { results } = run('2024-08-13-book-restoration');
    expect(results[0]).toMatchObject({ type: 'project', id: '2024-08-13-book-restoration' });
  });

  it('ranks description matches above content-only matches, which carry a snippet', () => {
    const withContent: SearchOptions = {
      ...opts,
      entryContents: new Map([
        [
          '2025-11-20T09:30',
          'Walked through the remaining feedback items.\n\nDiscussed the restoration follow-up work for next quarter.',
        ],
      ]),
    };
    const { results } = run('restoration', withContent);
    const entries = results.filter((r) => r.type === 'entry');
    expect(entries.map((r) => r.id)).toEqual(['2024-10-23T14:30', '2025-11-20T09:30']);
    expect(entries[0].snippet).toBeUndefined();
    expect(entries[1].snippet).toContain('restoration follow-up');
  });

  it('keeps index (reverse-chronological) order between equal scores', () => {
    const { results } = run('note:');
    expect(results.map((r) => r.id)).toEqual(noteIndex.map((n) => n.id));
  });
});

describe('artifact search', () => {
  const artifactIndex = [
    { id: '2026-09-03-report', description: 'Current library rules' },
    { id: '2025-07-21-guide', description: 'Reference for lending' },
  ];
  const artifactOpts: SearchOptions = {
    ...opts,
    artifactIndex,
    resolveArtifactName: id => id.endsWith('report') ? 'Catalog review' : 'Launch guide',
    artifactContents: new Map([['2025-07-21-guide', 'Keep the catalog shelf labels current.']]),
  };

  it('finds names, descriptions, and content without mixing artifact/action prefixes', () => {
    expect(run('artifacts:', artifactOpts).results.map(result => result.id)).toEqual(artifactIndex.map(item => item.id));
    expect(run('artifact:current library', artifactOpts).results.map(result => result.id)).toEqual(['2026-09-03-report']);
    const results = run('artifact:catalog', artifactOpts).results;
    expect(results.map(result => result.id)).toEqual(artifactIndex.map(item => item.id));
    expect(results[1].snippet).toContain('shelf labels');
    expect(run('action:catalog', artifactOpts).results.every(result => result.type === 'action')).toBe(true);
  });

  it('includes artifacts in general search and uses their creation date for ranges', () => {
    const types = run('catalog', artifactOpts).results.map(result => result.type);
    expect(types).toEqual(['project', 'action', 'artifact', 'artifact', 'entry']);
    expect(run('artifact: 2026..', artifactOpts).results.map(result => result.id)).toEqual(['2026-09-03-report']);
  });

  it('refreshes full-text matches when the contents map is replaced', () => {
    expect(run('artifact:labels', artifactOpts).results).toHaveLength(1);
    expect(run('artifact:labels', { ...artifactOpts, artifactContents: new Map([['2025-07-21-guide', 'Updated lending plan.']]) }).results).toEqual([]);
  });
});
