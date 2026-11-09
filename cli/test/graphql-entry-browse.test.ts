import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { init } from '../src/source/bootstrap.js';
import { Store } from '../src/source/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { executeGraphQL } from '../src/graphql/schema.js';

describe('GraphQL native entry browsing', () => {
  let dir: string, store: Store, project: string, action: string;
  let tagged: string, inline: string, code: string, prefix: string, description: string;
  const capture = (day: number, content: string, summary = 'Example') => handleCapture(store,
    { content, description: summary }, new Date(2026, 9, day, 10)).entryId;
  const query = async (where: unknown, offset = 0, limit = 100) => executeGraphQL(store, 'query', {
    document: `query($where: EntryWhere, $offset: Int!, $limit: Int!) {
      entries(where: $where, offset: $offset, limit: $limit, orderBy: CREATED_DESC) { nodes { id } offset count totalCount }
    }`, variables: { where, offset, limit },
  });
  const page = async (where: unknown, offset = 0, limit = 100) => {
    const result = await query(where, offset, limit);
    expect(result.errors).toBeUndefined();
    return result.data!.entries as { nodes: { id: string }[]; offset: number; count: number; totalCount: number };
  };

  beforeEach(() => {
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    dir = mkdtempSync('/private/tmp/aside-entry-browse-');
    init(dir, { name: 'Entry browsing', description: 'Native browsing fixture' });
    store = new Store(dir);
    const first = handleCapture(store, {
      content: 'Needle C++ [x].* in tagged context', description: 'Tagged',
      projects: [{ name: 'Project', description: 'Project' }],
      actions: [{ name: 'Task', description: 'Task' }],
    }, new Date(2026, 9, 1, 10));
    tagged = first.entryId; project = first.createdProjectIds[0]; action = first.createdActionIds[0];
    inline = capture(2, `NEEDLE c++ [x].* with [context](#project/${project}) and #action/${action}.`);
    code = capture(3, `Needle inside code: \`#project/${project}\` and \`#action/${action}\`.`);
    prefix = capture(4, `Needle unrelated #project/${project}-other and #action/${action}-other.`);
    description = capture(5, `#project/${project}`, 'Needle C++ [x].* exists only in the index');
  });
  afterEach(() => { store.close(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it('preserves native inline reference membership without changing explicit-tag filters', async () => {
    expect((await page({ browse: { project } })).nodes.map(node => node.id)).toEqual([description, inline, tagged]);
    expect((await page({ browse: { action } })).nodes.map(node => node.id)).toEqual([inline, tagged]);
    expect((await page({ projectIds: [project] })).nodes.map(node => node.id)).toEqual([tagged]);
    expect((await page({ browse: { project } })).nodes.map(node => node.id)).not.toContain(code);
    expect((await page({ browse: { project } })).nodes.map(node => node.id)).not.toContain(prefix);
  });

  it('matches a literal phrase including regex symbols, case, index descriptions, and IDs', async () => {
    expect((await page({ browse: { search: '  c++ [X].*  ' } })).nodes.map(node => node.id)).toEqual([description, inline, tagged]);
    expect((await page({ browse: { search: inline.slice(0, 10) } })).nodes.map(node => node.id)).toEqual([inline]);
    expect((await page({ browse: { search: '.*' } })).totalCount).toBe(3);
    expect((await page({ browse: { search: '[never' } })).totalCount).toBe(0);
    expect((await page({ browse: { search: '  ' } })).totalCount).toBe(5);
  });

  it('composes grouped agent predicates and native browsing before counting and pagination', async () => {
    const where = { and: [
      { or: [{ createdFrom: '2026-10-02' }, { ids: [tagged] }], not: { ids: [description] } },
      { browse: { project, search: 'needle' } },
    ] };
    expect(await page(where, 0, 1)).toEqual({ nodes: [{ id: inline }], offset: 0, count: 1, totalCount: 2 });
    expect(await page(where, 1, 1)).toEqual({ nodes: [{ id: tagged }], offset: 1, count: 1, totalCount: 2 });
    expect(await page(where, 2, 1)).toEqual({ nodes: [], offset: 2, count: 0, totalCount: 2 });
  });

  it('allows native browsing inside nested boolean conditions', async () => {
    const result = await page({ and: [{ not: { browse: { action } } }, { browse: { search: 'needle' } }] });
    expect(result.nodes.map(node => node.id)).toEqual([description, prefix, code]);
  });

  it('applies inclusive date/clock ranges before pagination and rejects invalid bounds', async () => {
    expect(await page({ browse: { createdFrom: '2026-10-02', createdTo: '2026-10-04' } }, 1, 1))
      .toEqual({ nodes: [{ id: code }], offset: 1, count: 1, totalCount: 3 });
    expect((await page({ browse: { createdFrom: inline, createdTo: inline } })).nodes.map(node => node.id)).toEqual([inline]);
    expect((await page({ browse: { createdFrom: `${inline}:00.000`, createdTo: `${inline}:00.001` } })).nodes.map(node => node.id)).toEqual([inline]);
    expect((await page({ browse: { createdFrom: '2026-10-02T10:01', createdTo: '2026-10-03T10:00' } })).nodes.map(node => node.id)).toEqual([code]);
    const invalid = await query({ browse: { createdFrom: '2026-02-30' } });
    expect(invalid.errors?.[0].message).toContain('Date range bounds');
    expect((await query({ browse: { createdFrom: '2026-10-05', createdTo: '2026-10-04' } })).errors?.[0].message).toContain('start must not follow');
  });

  it('rejects simultaneous project and action browsing instead of silently combining them', async () => {
    const result = await query({ browse: { project, action } });
    expect(result.errors?.[0].message).toContain('one project or action');
  });

  it('rechecks literal matches after index-only description edits', async () => {
    const where = { browse: { search: 'fresh summary' } };
    expect((await page(where)).totalCount).toBe(0);
    expect(store.setIndexEntry('notes', code, 'Fresh summary only in the index')).toBe(true);
    expect((await page(where)).nodes.map(node => node.id)).toEqual([code]);
  });
});
