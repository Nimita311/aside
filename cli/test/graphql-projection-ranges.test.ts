import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { init } from '../src/source/bootstrap.js';
import { Store } from '../src/source/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateOccurrence } from '../src/mcp/tools/recurrence.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import { executeGraphQL } from '../src/graphql/schema.js';
import { projectionId } from '../src/core/recurrence.js';
import { QueryView } from '../src/graphql/query.js';

describe('GraphQL action projection ranges', () => {
  let dir: string, store: Store;
  let monthly: string, annual: string, saved: string, future: string;
  let projects: string[];

  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    dir = mkdtempSync('/private/tmp/aside-projection-ranges-');
    init(dir, {name: 'Projection ranges', description: 'Fixture'});
    store = new Store(dir);
    const recurring = handleCapture(store, {
      content: 'Recurring work shared by two projects.', description: 'Routine context',
      projects: [{name: 'Finance', description: 'Finance'}, {name: 'Home', description: 'Home'}],
      actions: [
        {name: 'Monthly review', description: 'Monthly', recurrence: [{dtstart: '2026-08-15', rrule: 'FREQ=MONTHLY'}]},
        {name: 'Annual review', description: 'Annual', recurrence: [{dtstart: '2026-11-20', rrule: 'FREQ=YEARLY'}]},
      ],
    });
    [monthly, annual] = recurring.createdActionIds;
    projects = recurring.createdProjectIds;
    saved = handleUpdateOccurrence(store, {template: monthly, original: '2026-10-15', description: 'Saved review'}).id;
    future = handleCapture(store, {
      content: 'Saved work stays visible.', description: 'Saved work',
      actions: [
        {name: 'Distant task', description: 'Future', scheduled: '2035-01-01'},
        {name: 'Old task', description: 'Past', scheduled: '2024-01-01'},
        {name: 'Backlog task', description: 'Backlog'},
      ],
    }).createdActionIds[0];
    expect(store.getIssues()).toEqual([]);
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, {recursive: true, force: true});
  });

  const query = async (document: string) => {
    const result = await executeGraphQL(store, 'query', {document});
    expect(result.errors).toBeUndefined();
    return result as any;
  };

  const addDenseTemplate = () => handleCapture(store, {
    content: 'Unrelated high-frequency history.', description: 'Dense context',
    projects: [{name: 'Monitoring', description: 'Unrelated monitoring'}],
    actions: [{name: 'Minute sample', description: 'Dense recurrence',
      recurrence: [{dtstart: '2000-01-01T00:00', rrule: 'FREQ=MINUTELY'}]}],
  }).createdActionIds[0];

  it('defaults only unsaved expansion to one calendar year and retains all saved work', async () => {
    const result = await query(`{ actions(limit: 100, orderBy: SCHEDULED_ASC) {
      totalCount nodes { id created scheduled occurrence { template { id } original projected } }
    } }`);
    const rows = result.data.actions.nodes;
    const projections = rows.filter((row: any) => row.occurrence?.projected);
    expect(projections.map((row: any) => row.scheduled)).toContain('2026-08-15');
    expect(projections.map((row: any) => row.scheduled)).toContain('2027-09-15');
    expect(projections.map((row: any) => row.scheduled)).not.toContain('2027-10-15');
    expect(projections).toContainEqual(expect.objectContaining({scheduled: '2026-11-20', occurrence: {
      template: {id: annual}, original: '2026-11-20', projected: true,
    }}));
    expect(projections.every((row: any) => row.created === null)).toBe(true);
    expect(rows).toContainEqual(expect.objectContaining({id: future, scheduled: '2035-01-01'}));
    expect(rows.some((row: any) => row.scheduled === '2024-01-01')).toBe(true);
    expect(rows.filter((row: any) => row.scheduled === '2026-10-15').map((row: any) => row.id)).toEqual([saved]);
    expect(rows.some((row: any) => row.scheduled === null)).toBe(true);
    expect(result.extensions.complete).toBe(true);
    expect(result.extensions.diagnostics).toEqual([]);
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({
      path: 'actions', scheduledTo: '2027-10-10', templates: [monthly, annual].sort(),
      message: expect.stringContaining('scheduledTo'),
    })]);
  });

  it.each([
    ['2026-08-01', '2026-09-30', ['2026-08-15', '2026-09-15']],
    ['2030-01-01', '2030-03-31', ['2030-01-15', '2030-02-15', '2030-03-15']],
  ])('expands explicit dates from %s through %s without a default notice', async (from, to, expected) => {
    const result = await query(`{ actions(where: {scheduledFrom: "${from}", scheduledTo: "${to}"}, orderBy: SCHEDULED_ASC, limit: 100) {
      nodes { scheduled occurrence { projected } }
    } }`);
    expect(result.data.actions.nodes.map((row: any) => row.scheduled)).toEqual(expected);
    expect(result.data.actions.nodes.every((row: any) => row.occurrence.projected)).toBe(true);
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('uses an explicit end to expand recurrence history and applies explicit dates to saved rows', async () => {
    const result = await query(`{ actions(where: {scheduledTo: "2026-09-30"}, orderBy: SCHEDULED_ASC) {
      nodes { scheduled }
    } }`);
    expect(result.data.actions.nodes.map((row: any) => row.scheduled)).toEqual(['2024-01-01', '2026-08-15', '2026-09-15']);
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it.each([
    ['2026-01-01', '2027-10-10'],
    ['2030-01-01', '2031-01-01'],
  ])('defaults from-only queries at %s through %s', async (from, to) => {
    const result = await query(`{ work: actions(where: {scheduledFrom: "${from}"}, orderBy: SCHEDULED_ASC, limit: 100) {
      nodes { id scheduled }
    } }`);
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({path: 'work', scheduledTo: to})]);
    expect(result.data.work.nodes).toContainEqual({id: future, scheduled: '2035-01-01'});
  });

  it('reports alias-aware nested count-only defaults once per path, including cached queries', async () => {
    const document = `{
      work: actions(where: {occurrence: {projected: true}}) { totalCount }
      teams: projects(where: {ids: ${JSON.stringify(projects)}}) { nodes {
        tasks: actions(where: {occurrence: {projected: true}}) { totalCount }
      } }
      explicit: actions(where: {scheduledTo: "2027-10-10"}) { totalCount }
    }`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await query(document);
      expect(result.data.teams.nodes).toHaveLength(2);
      expect(result.extensions.defaultProjectionRanges).toEqual([
        expect.objectContaining({path: 'teams.nodes.*.tasks', scheduledTo: '2027-10-10', templates: [monthly, annual].sort()}),
        expect.objectContaining({path: 'work', scheduledTo: '2027-10-10', templates: [monthly, annual].sort()}),
      ]);
      expect(result.data.teams.nodes.every((row: any) => row.tasks.totalCount === result.data.work.totalCount)).toBe(true);
    }
  });

  it('omits default notices for saved-only selections and explicit IDs', async () => {
    const result = await query(`{
      exact: actions(where: {ids: ["${saved}"]}) { nodes { id } }
      created: actions(where: {createdFrom: "2026-10-01"}) { nodes { created } }
      templates: actions(where: {recurrenceExists: true}) { totalCount }
      saved: actions(where: {occurrence: {projected: false}}) { totalCount }
    }`);
    expect(result.data.exact.nodes).toEqual([{id: saved}]);
    expect(result.data.created.nodes.every((row: any) => row.created !== null)).toBe(true);
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('reports defaults applied inside relation predicates at their filter paths', async () => {
    const result = await query(`{ teams: projects(where: {actions: {some: {
      occurrence: {projected: true}, scheduledFrom: "2030-01-01"
    }}}) { nodes { id } } }`);
    expect(result.data.teams.nodes.map((row: any) => row.id).sort()).toEqual([...projects].sort());
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({
      path: 'teams.where.actions.some', scheduledTo: '2031-01-01', templates: [monthly, annual].sort(),
    })]);
  });

  it('combines AND and OR schedule bounds before expanding projections', async () => {
    const result = await query(`{
      intersection: actions(where: {and: [{scheduledFrom: "2030-05-01"}, {scheduledTo: "2030-05-31"}]}, orderBy: SCHEDULED_ASC) {
        nodes { scheduled }
      }
      branches: actions(where: {or: [
        {scheduledFrom: "2030-01-01", scheduledTo: "2030-01-31"},
        {scheduledFrom: "2030-03-01", scheduledTo: "2030-03-31"}
      ]}, orderBy: SCHEDULED_ASC) { nodes { scheduled } }
    }`);
    expect(result.data.intersection.nodes).toEqual([{scheduled: '2030-05-15'}]);
    expect(result.data.branches.nodes).toEqual([{scheduled: '2030-01-15'}, {scheduled: '2030-03-15'}]);
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('retains past projections in an unbounded projected OR branch', async () => {
    const result = await query(`{ actions(where: {or: [
      {scheduledFrom: "2030-01-01"}, {occurrence: {projected: true, template: "${monthly}"}}
    ]}, orderBy: SCHEDULED_ASC, limit: 100) { nodes { scheduled } } }`);
    const dates = result.data.actions.nodes.map((row: any) => row.scheduled);
    expect(dates).toContain('2026-08-15');
    expect(dates).toContain('2030-12-15');
    expect(dates).not.toContain('2031-01-15');
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({scheduledTo: '2031-01-01'})]);
  });

  it('includes backlog selected by an OR branch alongside explicit schedule dates', async () => {
    const result = await query(`{ actions(where: {or: [
      {scheduledFrom: "2030-01-01", scheduledTo: "2030-03-31"}, {status: [BACKLOG]}
    ]}, orderBy: SCHEDULED_ASC) { nodes { name scheduled } } }`);
    expect(result.data.actions.nodes).toEqual([
      {name: 'Monthly review', scheduled: '2030-01-15'},
      {name: 'Monthly review', scheduled: '2030-02-15'},
      {name: 'Monthly review', scheduled: '2030-03-15'},
      {name: 'Backlog task', scheduled: null},
    ]);
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('does not use dates inside not as the projection end', async () => {
    const result = await query(`{ actions(where: {
      occurrence: {projected: true, template: "${monthly}"}, not: {scheduledTo: "2026-12-31"}
    }, orderBy: SCHEDULED_ASC, limit: 100) { nodes { scheduled } } }`);
    expect(result.data.actions.nodes.map((row: any) => row.scheduled)).toEqual([
      '2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15',
      '2027-06-15', '2027-07-15', '2027-08-15', '2027-09-15',
    ]);
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({
      scheduledTo: '2027-10-10', templates: [monthly],
    })]);
  });

  it('keeps independent projection ranges for differently dated aliases in one request', async () => {
    const result = await query(`{
      early: actions(where: {scheduledFrom: "2030-01-01", occurrence: {projected: true}}, orderBy: SCHEDULED_ASC, limit: 100) { nodes { scheduled } }
      late: actions(where: {scheduledFrom: "2040-01-01", occurrence: {projected: true}}, orderBy: SCHEDULED_ASC, limit: 100) { nodes { scheduled } }
      past: actions(where: {scheduledFrom: "2026-08-01", scheduledTo: "2026-09-30"}, orderBy: SCHEDULED_ASC) { nodes { scheduled } }
    }`);
    expect(result.data.early.nodes[0].scheduled).toBe('2030-01-15');
    expect(result.data.early.nodes.at(-1).scheduled).toBe('2030-12-15');
    expect(result.data.late.nodes[0].scheduled).toBe('2040-01-15');
    expect(result.data.late.nodes.at(-1).scheduled).toBe('2040-12-15');
    expect(result.data.past.nodes).toEqual([{scheduled: '2026-08-15'}, {scheduled: '2026-09-15'}]);
    expect(result.extensions.defaultProjectionRanges).toEqual([
      expect.objectContaining({path: 'early', scheduledTo: '2031-01-01'}),
      expect.objectContaining({path: 'late', scheduledTo: '2041-01-01'}),
    ]);
  });

  it('resolves exact far-future projection IDs and retains their identity after materialization', async () => {
    const original = '2040-02-15', id = projectionId({template: monthly, original});
    const document = `{
      exact: actions(where: {ids: ["${id}"]}) { nodes { id handle scheduled occurrence { original projected } } }
      action(id: "${id}") { id handle scheduled occurrence { original projected } }
    }`;
    const projected = await query(document);
    expect(projected.data.exact.nodes).toEqual([{id, handle: `#action/${id}`, scheduled: original,
      occurrence: {original, projected: true}}]);
    expect(projected.data.action).toEqual(projected.data.exact.nodes[0]);
    expect(projected.extensions.defaultProjectionRanges).toEqual([]);
    const materialized = handleUpdateOccurrence(store, {template: monthly, original, scheduled: '2041-12-31'}).id;
    const persisted = await query(document);
    expect(persisted.data.exact.nodes).toEqual([{id: materialized, handle: `#action/${materialized}`, scheduled: '2041-12-31',
      occurrence: {original, projected: false}}]);
    expect(persisted.data.action).toEqual(persisted.data.exact.nodes[0]);
    expect(persisted.extensions.defaultProjectionRanges).toEqual([]);
    const siblings = await query(`{ actions(where: {scheduledFrom: "2040-02-01", scheduledTo: "2040-02-28"}) { totalCount } }`);
    expect(siblings.data.actions.totalCount).toBe(0);
  });

  it('refreshes exact projection list descriptions after an index-only template update', async () => {
    const id = projectionId({template: monthly, original: '2040-02-15'});
    const document = `{ actions(where: {ids: ["${id}"]}) { count totalCount nodes { id description } } }`;
    expect((await query(document)).data.actions).toEqual({count: 1, totalCount: 1, nodes: [{id, description: 'Monthly'}]});
    handleUpdateAction(store, {id: monthly, description: 'Updated monthly summary'});
    expect((await query(document)).data.actions).toEqual({count: 1, totalCount: 1,
      nodes: [{id, description: 'Updated monthly summary'}]});
  });

  it('counts a saved occurrence only once when both its saved and projected IDs are requested', async () => {
    const alias = projectionId({template: monthly, original: '2026-10-15'});
    const result = await query(`{ actions(where: {ids: ["${saved}", "${alias}"]}) { count totalCount nodes { id } } }`);
    expect(result.data.actions).toEqual({count: 1, totalCount: 1, nodes: [{id: saved}]});
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('keeps notice probes from replacing an exact saved occurrence alias with a projection', async () => {
    const original = '2026-08-15';
    const materialized = handleUpdateOccurrence(store, {template: monthly, original, description: 'Saved first occurrence'}).id;
    const view = new QueryView(store);
    await view.list('action', {});
    expect(view.action(projectionId({template: monthly, original}))).toMatchObject({id: materialized, projected: false});
  });

  it('resolves a far-future exact projection ID inside an AND predicate', async () => {
    const id = projectionId({template: monthly, original: '2040-02-15'});
    const result = await query(`{ actions(where: {and: [
      {ids: ["${id}"]}, {occurrence: {projected: true}}
    ]}) { count totalCount nodes { id scheduled } } }`);
    expect(result.data.actions).toEqual({count: 1, totalCount: 1, nodes: [{id, scheduled: '2040-02-15'}]});
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('resolves finite OR branches containing different exact projection IDs', async () => {
    const first = projectionId({template: monthly, original: '2040-02-15'});
    const second = projectionId({template: monthly, original: '2050-03-15'});
    const result = await query(`{ actions(where: {or: [{ids: ["${first}"]}, {ids: ["${second}"]}]}, orderBy: SCHEDULED_ASC) {
      count totalCount nodes { id scheduled }
    } }`);
    expect(result.data.actions).toEqual({count: 2, totalCount: 2,
      nodes: [{id: first, scheduled: '2040-02-15'}, {id: second, scheduled: '2050-03-15'}]});
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('includes an exact projection beyond the default in an unbounded OR with backlog', async () => {
    const id = projectionId({template: monthly, original: '2040-02-15'});
    const result = await query(`{ actions(where: {or: [{ids: ["${id}"]}, {status: [BACKLOG]}]}, orderBy: SCHEDULED_ASC) {
      count totalCount nodes { id name scheduled }
    } }`);
    expect(result.data.actions).toMatchObject({count: 2, totalCount: 2, nodes: [
      {id, name: 'Monthly review', scheduled: '2040-02-15'},
      {name: 'Backlog task', scheduled: null},
    ]});
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('matches saved and projected aliases for one materialized occurrence across AND predicates', async () => {
    const original = '2040-02-15', alias = projectionId({template: monthly, original});
    const materialized = handleUpdateOccurrence(store, {template: monthly, original, scheduled: '2041-12-31'}).id;
    const result = await query(`{ actions(where: {and: [{ids: ["${materialized}"]}, {ids: ["${alias}"]}]}) {
      count totalCount nodes { id scheduled occurrence { projected } }
    } }`);
    expect(result.data.actions).toEqual({count: 1, totalCount: 1, nodes: [
      {id: materialized, scheduled: '2041-12-31', occurrence: {projected: false}},
    ]});
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('reports only active eligible templates, excluding dormant, ended, and unrelated recurrences', async () => {
    handleCapture(store, {content: 'Finite and dormant work.', description: 'Past routines', projects, actions: [
      {name: 'Ended routine', description: 'Ended', recurrence: [{dtstart: '2024-01-01', rrule: 'FREQ=MONTHLY;COUNT=2'}]},
      {name: 'Dormant routine', description: 'Dormant', recurrence: []},
    ]});
    handleCapture(store, {content: 'Other routine.', description: 'Other', projects: [{name: 'Other', description: 'Other'}],
      actions: [{name: 'Other routine', description: 'Other', recurrence: [{dtstart: '2026-11-01', rrule: 'FREQ=MONTHLY'}]}]});
    const result = await query(`{
      scoped: actions(where: {projectIds: ["${projects[0]}"]}, limit: 100) { totalCount }
      annual: actions(where: {occurrence: {template: "${annual}"}}) { totalCount }
      text: actions(where: {regex: "^Annual review$"}) { totalCount }
    }`);
    expect(result.extensions.defaultProjectionRanges).toEqual([
      expect.objectContaining({path: 'annual', templates: [annual]}),
      expect.objectContaining({path: 'scoped', templates: [monthly, annual].sort()}),
      expect.objectContaining({path: 'text', templates: [annual]}),
    ]);
  });

  it.each(['project', 'and', 'or', 'orBacklog', 'template', 'nested'] as const)('avoids expanding unrelated dense history for a narrow %s selection', async selection => {
    const dense = addDenseTemplate();
    const where = {
      project: `{projectIds: ["${projects[0]}"]}`,
      and: `{and: [{projectIds: ["${projects[0]}"]}, {occurrence: {projected: true}}]}`,
      or: `{or: [{projectIds: ["${projects[0]}"]}, {occurrence: {template: "${monthly}"}}]}`,
      orBacklog: `{or: [{projectIds: ["${projects[0]}"]}, {status: [BACKLOG]}]}`,
      template: `{occurrence: {template: "${monthly}"}}`,
      nested: '{}',
    }[selection];
    const result = await query(selection === 'nested'
      ? `{ project(id: "${projects[0]}") { actions(limit: 100) { totalCount nodes { name } } } }`
      : `{ actions(where: ${where}, limit: 100) { totalCount nodes { name } } }`);
    const actions = selection === 'nested' ? result.data.project.actions : result.data.actions;
    expect(actions.totalCount).toBeGreaterThan(0);
    expect(actions.nodes.every((row: any) => row.name !== 'Minute sample')).toBe(true);
    expect(result.extensions.complete).toBe(true);
    expect(result.extensions.defaultProjectionRanges[0].templates).not.toContain(dense);
  });

  it('fails excessive projection work without partial data or default notices, then accepts a narrow range', async () => {
    const dense = addDenseTemplate();
    const result = await executeGraphQL(store, 'query', {document: `{
      small: actions(where: {occurrence: {template: "${monthly}"}}) { totalCount }
      huge: actions { totalCount }
    }`});
    expect(result.errors).toEqual([expect.objectContaining({message: expect.stringMatching(/work limit.*narrow/i)})]);
    expect(result.data).toBeUndefined();
    expect(result.extensions).toMatchObject({complete: false, defaultProjectionRanges: []});
    const narrowed = await query(`{ actions(where: {
      occurrence: {template: "${dense}"}, scheduledFrom: "2000-01-01", scheduledTo: "2000-01-01"
    }, limit: 1) { count totalCount } }`);
    expect(narrowed.data.actions).toEqual({count: 1, totalCount: 1440});
    expect(narrowed.extensions.defaultProjectionRanges).toEqual([]);
  }, 20_000);

  it('uses calendar-year arithmetic when today is a leap day', async () => {
    vi.setSystemTime(new Date('2028-02-29T12:00:00Z'));
    const result = await query('{ actions { totalCount } }');
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({scheduledTo: '2029-02-28'})]);
  });

  it.each(['CREATED_ASC', 'CREATED_DESC'])('puts unsaved occurrences after saved rows in %s pages', async orderBy => {
    const full = await query(`{ actions(orderBy: ${orderBy}, limit: 100) { totalCount nodes { id created } } }`);
    const rows = full.data.actions.nodes;
    const firstProjection = rows.findIndex((row: any) => row.created === null);
    expect(firstProjection).toBe(store.getActions().size);
    expect(rows.slice(firstProjection).every((row: any) => row.created === null)).toBe(true);
    const paged = await query(`{ actions(orderBy: ${orderBy}, offset: ${firstProjection - 1}, limit: 2) {
      totalCount nodes { id created }
    } }`);
    expect(paged.data.actions.nodes).toEqual(rows.slice(firstProjection - 1, firstProjection + 1));
    expect(paged.data.actions.totalCount).toBe(full.data.actions.totalCount);
  });

  it('returns an empty informational range array when a response budget discards query data', async () => {
    const result = await executeGraphQL(store, 'query', {document: '{ actions { totalCount } }'}, {maxFields: 1});
    expect(result.errors).toEqual([expect.objectContaining({message: expect.stringContaining('limit exceeded')})]);
    expect(result.data).toBeUndefined();
    expect(result.extensions).toMatchObject({complete: false, defaultProjectionRanges: []});
  });

  it('keeps nullable creation limited to actions and link targets', async () => {
    const result = await query(`{
      action: __type(name: "Action") { fields { name type { kind name } } }
      link: __type(name: "LinkTarget") { fields { name type { kind name } } }
      project: __type(name: "Project") { fields { name type { kind ofType { name } } } }
      entry: __type(name: "Entry") { fields { name type { kind ofType { name } } } }
      artifact: __type(name: "Artifact") { fields { name type { kind ofType { name } } } }
    }`);
    for (const kind of ['action', 'link']) expect(result.data[kind].fields.find((field: any) => field.name === 'created').type)
      .toEqual({kind: 'SCALAR', name: 'String'});
    for (const kind of ['project', 'entry', 'artifact']) expect(result.data[kind].fields.find((field: any) => field.name === 'created').type)
      .toEqual({kind: 'NON_NULL', ofType: {name: 'String'}});
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });
});
