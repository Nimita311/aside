import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/source/store.js';
import { handleQueryArtifacts } from '../src/mcp/tools/query.js';

describe('handleQueryArtifacts', () => {
  let tempDir: string;
  let store: Store;
  const IDS = ['2026-05-04-delta', '2026-05-03-gamma', '2026-05-02-beta', '2026-05-01-alpha'];

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'aside-query-test-'));
    mkdirSync(join(tempDir, 'artifacts', '2026'), { recursive: true });
    for (const id of IDS) {
      writeFileSync(join(tempDir, 'artifacts', '2026', `${id}.md`), `---\nname: ${id.slice(11)}\ncreated: "${id.slice(0, 10)}"\n---\n\nBody of ${id}.\n`);
    }
    store = new Store(tempDir);
    expect(store.getIssues()).toEqual([]);
  });

  afterAll(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an artifact ID that can be reused without stripping display text', () => {
    const metadata = handleQueryArtifacts(store, { limit: 1, detail: 'metadata' }) as string;
    const id = metadata.match(/^id: (.+)$/m)![1];
    expect(id).toBe(IDS[0]);
    expect((handleQueryArtifacts(store, { ids: [id] }) as string).split('\n')[0]).toBe('1 of 1');
  });

  it('follows next_offset across partial and final pages', () => {
    const first = handleQueryArtifacts(store, { limit: 3 }) as string;
    expect(first).toContain('offset: 0\nlimit: 3\nnext_offset: 3');
    const nextOffset = Number(first.match(/^next_offset: (.+)$/m)![1]);
    const last = handleQueryArtifacts(store, { offset: nextOffset, limit: 3 }) as string;
    expect(last.split('\n')[0]).toBe('1 of 4');
    expect(last).toContain('next_offset: null');
    expect((handleQueryArtifacts(store, { offset: 99 }) as string).split('\n').slice(0, 4)).toEqual(['0 of 4', 'offset: 99', 'limit: 20', 'next_offset: null']);
  });

  it('rejects invalid page arguments', () => {
    for (const offset of [-1, 0.5, Infinity, NaN]) {
      expect(() => handleQueryArtifacts(store, { offset })).toThrow('offset must be a nonnegative integer');
    }
    for (const limit of [0, -1, 1.5, 101, Infinity, NaN]) {
      expect(() => handleQueryArtifacts(store, { limit })).toThrow('limit must be an integer from 1 to 100');
    }
  });

  it('rejects an over-long search pattern', () => {
    expect(() => handleQueryArtifacts(store, { search: 'a'.repeat(300) })).toThrow('Search pattern too long');
  });

  it('rejects malformed and impossible calendar dates instead of returning no matches', () => {
    for (const created_from of ['', 'today', '2026-2-01', '2026-02-29', '2026-04-31', '2026-13-01']) {
      expect(() => handleQueryArtifacts(store, { created_from })).toThrow('created_from must be a valid date in YYYY-MM-DD format');
    }
    expect(() => handleQueryArtifacts(store, { created_from: '2026-06-01', created_to: '2026-05-01' })).toThrow('created_from must be on or before created_to');
    expect(() => handleQueryArtifacts(store, { created_from: '2028-02-29' })).not.toThrow();
  });

  it('surfaces recovered parse issues once even for empty query results', () => {
    const issues = vi.spyOn(store, 'getIssues').mockReturnValue([{ severity: 'error', code: 'bad_yaml', message: 'malformed YAML recovered', file: '/data/actions/bad.md' }]);
    try {
      const result = handleQueryArtifacts(store, { ids: [] }) as string;
      expect(result.split('\n')[0]).toBe('0 of 0');
      expect(result.match(/1 parsing issue/g)).toHaveLength(1);
      expect(result).toContain('data loaded best-effort; run validate for detail');
      expect(result).toContain('/data/actions/bad.md: malformed YAML recovered');
    } finally {
      issues.mockRestore();
    }
  });
});
