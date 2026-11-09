import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/source/store.js';
import { executeGraphQL } from '../src/graphql/schema.js';

type Root = 'entries' | 'actions' | 'projects' | 'artifacts';
type Where = Record<string, unknown>;
const whereType = { entries: 'EntryWhere', actions: 'ActionWhere', projects: 'ProjectWhere', artifacts: 'ArtifactWhere' };
const roots = Object.keys(whereType) as Root[];
const record = (fields: string, body: string) => `---\n${fields}\n---\n\n${body}\n`;
const entry = (created: string, tags: string, content: string) => `---\n\`\`\`entry\ncreated: "${created}"\n${tags}\`\`\`\n\n${content}\n`;
const week = (week: number, start: string, end: string) => `---\nweek: ${week}\nweek_start: "${start}"\nweek_end: "${end}"\n---\n\n`;

// Entries tie action-one/two/three to projects; action-four/five stay untagged.
function writeFixture(dir: string): void {
  for (const kind of ['notes', 'projects', 'actions', 'artifacts']) mkdirSync(join(dir, kind, '2026'), { recursive: true });
  writeFileSync(join(dir, 'aside.md'), '---\nid: filter-fixture\nname: Filters\ndescription: Filter fixture\n---\n');
  writeFileSync(join(dir, 'notes', '2026', 'index.yaml'), '- id: "2026-04-28T10:00"\n  description: "Worked on project task"\n- id: "2026-04-29T14:00"\n  description: "Cross-project work"\n');
  writeFileSync(join(dir, 'notes', '2026', 'w18.md'), week(18, '2026-04-27', '2026-05-03') + [
    entry('2026-04-28T10:00', 'projects:\n  - proj-alpha\nactions:\n  - action-one\n', 'Worked on the alpha project task today.'),
    entry('2026-04-29T14:00', 'projects:\n  - proj-alpha\n  - proj-beta\nactions:\n  - action-two\n', 'Did some cross-project collaboration work.'),
    entry('2026-04-30T09:00', 'projects:\n  - proj-beta\nactions:\n  - action-one\n', 'Fixed a bug in the beta system.'),
  ].join('\n'));
  writeFileSync(join(dir, 'notes', '2026', 'w19.md'), week(19, '2026-05-04', '2026-05-10') + [
    entry('2026-05-05T11:00', 'projects:\n  - proj-alpha\nactions:\n  - action-three\n', 'Planning the next milestone for alpha.'),
    entry('2026-05-06T08:00', '', 'Untagged scratch note.'),
  ].join('\n'));
  writeFileSync(join(dir, 'projects', '2026', 'index.yaml'), '- id: proj-alpha\n  description: "Flagship project"\n- id: proj-beta\n  description: "Beta project"\n');
  writeFileSync(join(dir, 'projects', '2026', 'proj-alpha.md'), record('name: "Alpha Project"\ncreated: "2026-01-15"\nrelated_projects:\n  - project: proj-beta\n    description: "Sibling project"', 'The alpha project is our main initiative.'));
  writeFileSync(join(dir, 'projects', '2026', 'proj-beta.md'), record('name: "Beta Project"\ncreated: "2026-03-01"\nended: "2026-04-30T12:00"', 'The beta project has concluded.'));
  writeFileSync(join(dir, 'projects', '2026', 'proj-gamma.md'), record('name: "Gamma Project"\ncreated: "2026-04-10"', 'Gamma is a new experimental project.'));
  writeFileSync(join(dir, 'actions', '2026', 'index.yaml'), '- id: action-one\n  description: "First action item"\n- id: action-two\n  description: "Second action item"\n- id: action-three\n  description: "Third action item"\n');
  writeFileSync(join(dir, 'actions', '2026', 'action-one.md'), record('name: "Fix the widget"\ncreated: "2026-04-20"\nscheduled: "2026-04-25"', 'Need to fix the widget component thoroughly.'));
  writeFileSync(join(dir, 'actions', '2026', 'action-two.md'), record('name: "Review documents"\ncreated: "2026-04-22"\nscheduled: "2026-05-10"\ndeadline: "2026-05-15"', 'Review all pending documents for accuracy.'));
  writeFileSync(join(dir, 'actions', '2026', 'action-three.md'), record('name: "Plan milestone"\ncreated: "2026-05-01"', 'Plan the next project milestone deliverables.'));
  writeFileSync(join(dir, 'actions', '2026', 'action-four.md'), record('name: "Cancelled task"\ncreated: "2026-04-15"\nscheduled: "2026-04-20"\nresolution: cancelled', 'This was cancelled before it started.'));
  writeFileSync(join(dir, 'actions', '2026', 'action-five.md'), record('name: "Ship release notes"\ncreated: "2026-04-10"\nscheduled: "2026-04-12"\nresolution: done', 'Drafted and shipped the release notes.'));
  writeFileSync(join(dir, 'artifacts', '2026', 'index.yaml'), '- id: 2026-04-05-guide\n  description: "Reference handbook"\n');
  writeFileSync(join(dir, 'artifacts', '2026', '2026-04-05-guide.md'), record('name: "Field guide"\ncreated: "2026-04-05"', 'Keep the checklist current.'));
  writeFileSync(join(dir, 'artifacts', '2026', '2026-04-06-recipe.md'), record('name: "Deploy recipe"\ncreated: "2026-04-06"', 'Roll forward, never back.'));
}

describe('GraphQL record filters', () => {
  let dir: string;
  let store: Store;
  const run = (document: string, variables?: Record<string, unknown>, source = store) => executeGraphQL(source, 'query', { document, variables });
  const select = (root: Root, where?: Where, offset?: unknown, limit?: unknown) => run(
    `query($where: ${whereType[root]}, $offset: Int, $limit: Int) { ${root}(where: $where, offset: $offset, limit: $limit) { nodes { id } offset count totalCount } }`,
    { where, offset, limit },
  );
  const page = async (root: Root, where?: Where, offset?: unknown, limit?: unknown) => {
    const result = await select(root, where, offset, limit);
    expect(result.errors).toBeUndefined();
    return result.data![root] as { nodes: { id: string }[]; offset: number; count: number; totalCount: number };
  };
  const error = async (root: Root, where?: Where, offset?: unknown, limit?: unknown) => {
    const result = await select(root, where, offset, limit);
    expect(result.errors).toHaveLength(1);
    return (result.errors![0] as { message: string }).message;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aside-graphql-filters-'));
    writeFixture(dir);
    store = new Store(dir);
    expect(store.getIssues()).toEqual([]);
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ENTRIES = ['2026-05-06T08:00', '2026-05-05T11:00', '2026-04-30T09:00', '2026-04-29T14:00', '2026-04-28T10:00'];
  const ACTIONS = ['action-three', 'action-two', 'action-one', 'action-four', 'action-five'];
  const PROJECTS = ['proj-gamma', 'proj-beta', 'proj-alpha'];
  const ARTIFACTS = ['2026-04-06-recipe', '2026-04-05-guide'];

  it.each<[Root, string, Where | undefined, string[]]>([
    ['entries', 'no filter', undefined, ENTRIES],
    ['entries', 'project', { projectIds: ['proj-beta'] }, ['2026-04-30T09:00', '2026-04-29T14:00']],
    ['entries', 'action', { actionIds: ['action-one'] }, ['2026-04-30T09:00', '2026-04-28T10:00']],
    ['entries', 'created range', { createdFrom: '2026-04-29', createdTo: '2026-04-30' }, ['2026-04-30T09:00', '2026-04-29T14:00']],
    ['entries', 'content regex', { regex: 'bug' }, ['2026-04-30T09:00']],
    ['entries', 'case-insensitive regex', { regex: 'ALPHA' }, ['2026-05-05T11:00', '2026-04-28T10:00']],
    ['entries', 'description regex', { regex: 'Worked on project task' }, ['2026-04-28T10:00']],
    ['entries', 'an ID without an index row', { ids: ['2026-05-05T11:00'] }, ['2026-05-05T11:00']],
    ['entries', 'several IDs, newest first whatever the request order', { ids: ['2026-04-28T10:00', '2026-04-29T14:00'] }, ['2026-04-29T14:00', '2026-04-28T10:00']],
    ['entries', 'empty IDs', { ids: [] }, []],
    ['entries', 'no project relationship', { projectIds: [] }, ['2026-05-06T08:00']],
    ['entries', 'no action relationship', { actionIds: [] }, ['2026-05-06T08:00']],

    ['actions', 'no filter', undefined, ACTIONS],
    ['actions', 'ID', { ids: ['action-one'] }, ['action-one']],
    ['actions', 'project', { projectIds: ['proj-beta'] }, ['action-two', 'action-one']],
    ['actions', 'created range', { createdFrom: '2026-04-20', createdTo: '2026-04-22' }, ['action-two', 'action-one']],
    ['actions', 'scheduled range', { scheduledFrom: '2026-05-01', scheduledTo: '2026-05-15' }, ['action-two']],
    ['actions', 'inclusive scheduled bounds', { scheduledFrom: '2026-04-20', scheduledTo: '2026-04-25' }, ['action-one', 'action-four']],
    ['actions', 'deadline lower bound', { deadlineFrom: '2026-05-01' }, ['action-two']],
    ['actions', 'SCHEDULED status', { status: ['SCHEDULED'] }, ['action-two', 'action-one']],
    ['actions', 'BACKLOG status', { status: ['BACKLOG'] }, ['action-three']],
    ['actions', 'CANCELLED status', { status: ['CANCELLED'] }, ['action-four']],
    ['actions', 'DONE status', { status: ['DONE'] }, ['action-five']],
    ['actions', 'any listed status', { status: ['DONE', 'CANCELLED'] }, ['action-four', 'action-five']],
    ['actions', 'overdue as open status plus deadline bound', { status: ['SCHEDULED', 'BACKLOG'], deadlineTo: '2026-05-20' }, ['action-two']],
    ['actions', 'body regex', { regex: 'thoroughly' }, ['action-one']],
    ['actions', 'name regex', { regex: 'Fix the widget' }, ['action-one']],
    ['actions', 'description regex', { regex: 'Second action' }, ['action-two']],
    ['actions', 'case-insensitive regex', { regex: 'WIDGET' }, ['action-one']],
    ['actions', 'no project relationship', { projectIds: [] }, ['action-four', 'action-five']],
    ['actions', 'empty IDs', { ids: [] }, []],
    ['actions', 'empty status', { status: [] }, []],
    ['actions', 'empty IDs and status', { ids: [], status: [] }, []],

    ['projects', 'no filter', undefined, PROJECTS],
    ['projects', 'ID', { ids: ['proj-alpha'] }, ['proj-alpha']],
    ['projects', 'outgoing related project', { relatedTo: ['proj-beta'] }, ['proj-alpha']],
    ['projects', 'no outgoing related project', { relatedTo: [] }, ['proj-gamma', 'proj-beta']],
    ['projects', 'created range', { createdFrom: '2026-03-01', createdTo: '2026-04-01' }, ['proj-beta']],
    ['projects', 'ended range', { endedFrom: '2026-04-01', endedTo: '2026-05-01' }, ['proj-beta']],
    ['projects', 'OPEN status', { status: 'OPEN' }, ['proj-gamma', 'proj-alpha']],
    ['projects', 'CLOSED status', { status: 'CLOSED' }, ['proj-beta']],
    ['projects', 'body regex', { regex: 'experimental' }, ['proj-gamma']],
    ['projects', 'name regex', { regex: 'Gamma Project' }, ['proj-gamma']],
    ['projects', 'description regex', { regex: 'flagship' }, ['proj-alpha']],
    ['projects', 'empty IDs', { ids: [] }, []],

    ['artifacts', 'no filter', undefined, ARTIFACTS],
    ['artifacts', 'name regex', { regex: 'field guide' }, ['2026-04-05-guide']],
    ['artifacts', 'description regex', { regex: 'HANDBOOK' }, ['2026-04-05-guide']],
    ['artifacts', 'body regex', { regex: 'checklist' }, ['2026-04-05-guide']],
    ['artifacts', 'created range', { createdFrom: '2026-04-06', createdTo: '2026-04-06' }, ['2026-04-06-recipe']],
    ['artifacts', 'no project relationship', { projectIds: [] }, ARTIFACTS],
    ['artifacts', 'no action relationship', { actionIds: [] }, ARTIFACTS],
    ['artifacts', 'empty IDs', { ids: [] }, []],
  ])('%s by %s', async (root, _name, where, expected) => {
    const result = await page(root, where);
    expect(result.nodes.map(node => node.id)).toEqual(expected);
    expect(result).toMatchObject({ offset: 0, count: expected.length, totalCount: expected.length });
  });

  it('lets an omitted relationship filter differ from an empty one', async () => {
    expect((await page('actions', {})).totalCount).toBe(ACTIONS.length);
    expect((await page('actions', { projectIds: null })).totalCount).toBe(ACTIONS.length);
    expect((await page('actions', { projectIds: [] })).totalCount).toBe(2);
  });

  it('matches each searchable field separately', async () => {
    expect((await page('actions', { regex: '^Fix the widget$' })).nodes).toEqual([{ id: 'action-one' }]);
    expect((await page('actions', { regex: 'widget.*First action' })).totalCount).toBe(0);
  });

  it.each<[Root, string]>([
    ['entries', '*badregex'],
    ['actions', '(unclosed'],
    ['projects', '[invalid('],
    ['artifacts', '('],
  ])('rejects invalid regex for %s even when nothing would be searched', async (root, regex) => {
    expect(await error(root, { regex })).toBe(`Invalid regex: ${regex}`);
    expect(await error(root, { ids: [], regex })).toBe(`Invalid regex: ${regex}`);
  });

  it.each(roots)('rejects an over-long search pattern for %s', async root => {
    expect(await error(root, { regex: 'a'.repeat(300) })).toContain('Search pattern too long: 300 characters (max 256)');
    expect((await page(root, { regex: 'a'.repeat(256) })).totalCount).toBe(0);
  });

  it.each(roots)('rejects malformed, impossible, and reversed created dates for %s', async root => {
    for (const createdFrom of ['', 'today', '2026-2-01', '2026-02-29', '2026-04-31', '2026-13-01']) {
      expect(await error(root, { createdFrom })).toContain('Date must be a valid YYYY-MM-DD calendar date.');
    }
    expect((await page(root, { createdFrom: '2028-02-29' })).totalCount).toBe(0);
    expect(await error(root, { createdFrom: '2026-06-01', createdTo: '2026-05-01' })).toBe('createdFrom must be on or before createdTo.');
  });

  it('rejects impossible and reversed bounds on every optional date field', async () => {
    expect(await error('actions', { scheduledTo: '2026-02-30' })).toContain('Date must be a valid YYYY-MM-DD calendar date.');
    expect(await error('actions', { scheduledFrom: '2026-06-01', scheduledTo: '2026-05-01' })).toBe('scheduledFrom must be on or before scheduledTo.');
    expect(await error('actions', { deadlineFrom: '2026-06-01', deadlineTo: '2026-05-01' })).toBe('deadlineFrom must be on or before deadlineTo.');
    expect(await error('projects', { endedFrom: '2026-06-01', endedTo: '2026-05-01' })).toBe('endedFrom must be on or before endedTo.');
    const inline = await run('{ actions(where: {deadlineFrom: "2026-02-30"}) { totalCount } }');
    expect(JSON.stringify(inline.errors)).toContain('Date must be a valid YYYY-MM-DD calendar date.');
    const unquoted = await run('{ actions(where: {deadlineFrom: 2026}) { totalCount } }');
    expect(JSON.stringify(unquoted.errors)).toContain('Date must be a YYYY-MM-DD string.');
  });

  it.each(roots)('rejects invalid page bounds consistently for %s', async root => {
    for (const offset of [-1, -5]) expect(await error(root, undefined, offset)).toBe('offset must be a nonnegative integer.');
    for (const limit of [0, -1, 101, 200]) expect(await error(root, undefined, undefined, limit)).toBe('limit must be from 1 to 100.');
    for (const offset of [0.5, Infinity, NaN]) expect(await error(root, undefined, offset)).toMatch(/Int cannot represent/);
    for (const limit of [1.5, Infinity, NaN]) expect(await error(root, undefined, undefined, limit)).toMatch(/Int cannot represent/);
    expect((await page(root, undefined, undefined, 100)).offset).toBe(0);
  });

  it.each<[Root, number, number, string[], number]>([
    ['entries', 1, 2, ENTRIES.slice(1, 3), 5],
    ['actions', 2, 2, ACTIONS.slice(2, 4), 5],
    ['projects', 1, 1, PROJECTS.slice(1, 2), 3],
    ['artifacts', 1, 1, ARTIFACTS.slice(1), 2],
  ])('paginates %s newest first after filtering', async (root, offset, limit, expected, totalCount) => {
    expect(await page(root, undefined, offset, limit)).toEqual({ nodes: expected.map(id => ({ id })), offset, count: expected.length, totalCount });
  });

  it('continues from offset plus count across partial, final, and past-the-end pages', async () => {
    const first = await page('entries', undefined, 0, 3);
    expect(first).toMatchObject({ offset: 0, count: 3, totalCount: 5 });
    const last = await page('entries', undefined, first.offset + first.count, 3);
    expect(last).toMatchObject({ offset: 3, count: 2, totalCount: 5 });
    expect([...first.nodes, ...last.nodes].map(node => node.id)).toEqual(ENTRIES);
    expect(await page('entries', undefined, 99)).toEqual({ nodes: [], offset: 99, count: 0, totalCount: 5 });
  });

  it('returns an entry ID that can be reused verbatim', async () => {
    const [{ id }] = (await page('entries', undefined, 0, 1)).nodes;
    expect(id).toBe(store.getEntries()[0].meta.created);
    expect((await page('entries', { ids: [id] })).totalCount).toBe(1);
  });

  it('returns stored descriptions, and null for records without an index row', async () => {
    const { data } = await run(`{
      indexed: action(id: "action-one") { description } project(id: "proj-alpha") { description }
      entry(id: "2026-04-28T10:00") { description } artifact(id: "2026-04-05-guide") { description }
      unindexed: action(id: "action-four") { description name } plain: entry(id: "2026-05-05T11:00") { description content }
    }`);
    expect(data).toEqual({
      indexed: { description: 'First action item' }, project: { description: 'Flagship project' },
      entry: { description: 'Worked on project task' }, artifact: { description: 'Reference handbook' },
      unindexed: { description: null, name: 'Cancelled task' },
      plain: { description: null, content: 'Planning the next milestone for alpha.' },
    });
  });

  it('returns the authored fields of a filtered record', async () => {
    const { data } = await run(`{
      actions(where: {ids: ["action-two"]}) { nodes { id name created scheduled deadline status body } }
      projects(where: {ids: ["proj-alpha"]}) { nodes { id name status ended body relatedProjects { nodes { direction outgoingDescription project { id } } } } }
      entries(where: {ids: ["2026-05-05T11:00"]}) { nodes { id projects { nodes { id } } actions { nodes { id } } } }
    }`);
    expect(data).toEqual({
      actions: { nodes: [{ id: 'action-two', name: 'Review documents', created: '2026-04-22', scheduled: '2026-05-10', deadline: '2026-05-15', status: 'SCHEDULED', body: 'Review all pending documents for accuracy.' }] },
      projects: { nodes: [{ id: 'proj-alpha', name: 'Alpha Project', status: 'OPEN', ended: null, body: 'The alpha project is our main initiative.',
        relatedProjects: { nodes: [{ direction: 'OUTGOING', outgoingDescription: 'Sibling project', project: { id: 'proj-beta' } }] } }] },
      entries: { nodes: [{ id: '2026-05-05T11:00', projects: { nodes: [{ id: 'proj-alpha' }] }, actions: { nodes: [{ id: 'action-three' }] } }] },
    });
  });

  it.each(roots)('surfaces a recovered parse issue once through extensions for empty %s results', async root => {
    const fresh = new Store(dir);
    const issue = { severity: 'error' as const, code: 'bad_yaml', message: 'malformed YAML recovered', file: '/data/actions/bad.md' };
    vi.spyOn(fresh, 'getIssues').mockReturnValue([issue]);
    try {
      const result = await executeGraphQL(fresh, 'query', { document: `{ first: ${root}(where: {ids: []}) { totalCount } second: ${root}(where: {ids: []}) { totalCount } }` });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ first: { totalCount: 0 }, second: { totalCount: 0 } });
      expect(result.extensions).toMatchObject({ complete: false, diagnostics: [issue] });
      expect(result.extensions!.diagnostics).toHaveLength(1);
    } finally {
      fresh.close();
    }
  });
});
