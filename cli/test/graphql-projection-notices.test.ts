import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {init} from '../src/source/bootstrap.js';
import {Store} from '../src/source/store.js';
import {handleCapture} from '../src/mcp/tools/capture.js';
import {executeGraphQL} from '../src/graphql/schema.js';
import {projectionId} from '../src/core/recurrence.js';

describe('GraphQL projection notice eligibility', () => {
  let root: string, store: Store, template: string;

  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    root = mkdtempSync('/private/tmp/aside-projection-notices-');
    init(root, {name: 'Projection notices', description: 'Isolated notice fixture'});
    store = new Store(root);
    template = handleCapture(store, {
      content: 'Annual review context.', description: 'Review context',
      projects: [{name: 'Team', description: 'Team'}],
      actions: [{name: 'Annual review', description: 'Annual',
        recurrence: [{dtstart: '2020-01-01', rrule: 'FREQ=YEARLY'}]}],
    }).createdActionIds[0];
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(root, {recursive: true, force: true});
  });

  const query = async (document: string) => {
    const result = await executeGraphQL(store, 'query', {document});
    expect(result.errors).toBeUndefined();
    return result as any;
  };

  it('reports the default when an exact-ID exclusion removes only the first occurrence', async () => {
    const first = projectionId({template, original: '2020-01-01'});
    const result = await query(`{ actions(where: {
      occurrence: {projected: true}, not: {ids: ["${first}"]}
    }) { totalCount } }`);
    expect(result.data.actions.totalCount).toBe(7);
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({
      path: 'actions', scheduledTo: '2027-10-10', templates: [template],
    })]);
  });

  it('preserves distinct default ends in different Boolean relation-filter branches', async () => {
    const result = await query(`{ teams: projects(where: {or: [
      {actions: {some: {occurrence: {projected: true}, scheduledFrom: "2030-01-01"}}},
      {actions: {some: {occurrence: {projected: true}, scheduledFrom: "2040-01-01"}}}
    ]}) { totalCount } }`);
    expect(result.data.teams.totalCount).toBe(1);
    const notices = result.extensions.defaultProjectionRanges;
    expect(notices).toEqual([
      expect.objectContaining({path: 'teams.where.or.0.actions.some', scheduledTo: '2031-01-01', templates: [template]}),
      expect.objectContaining({path: 'teams.where.or.1.actions.some', scheduledTo: '2041-01-01', templates: [template]}),
    ]);
  });

  it('omits notices when a negated lower bound already excludes every date beyond the default', async () => {
    const result = await query(`{ actions(where: {
      occurrence: {projected: true}, not: {scheduledFrom: "2027-01-01"}
    }) { totalCount } }`);
    expect(result.data.actions.totalCount).toBe(7);
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('reports a default that excludes every occurrence selected by a later negated end', async () => {
    const result = await query(`{ actions(where: {
      occurrence: {projected: true}, not: {scheduledTo: "2030-12-31"}
    }) { totalCount } }`);
    expect(result.data.actions.totalCount).toBe(0);
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({
      path: 'actions', scheduledTo: '2027-10-10', templates: [template],
    })]);
  });

  it('reports the default for an exact original occurrence beyond its boundary', async () => {
    const result = await query(`{ actions(where: {
      occurrence: {projected: true, template: "${template}", original: "2040-01-01"}
    }) { totalCount } }`);
    expect(result.data.actions.totalCount).toBe(0);
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({
      path: 'actions', scheduledTo: '2027-10-10', templates: [template],
    })]);
  });

  it('reports the default when the first omitted occurrence is explicitly excluded but later ones remain', async () => {
    const firstOmitted = projectionId({template, original: '2028-01-01'});
    const result = await query(`{ actions(where: {
      occurrence: {projected: true}, not: {ids: ["${firstOmitted}"]}
    }) { totalCount } }`);
    expect(result.data.actions.totalCount).toBe(8);
    expect(result.extensions.defaultProjectionRanges).toEqual([expect.objectContaining({
      path: 'actions', scheduledTo: '2027-10-10', templates: [template],
    })]);
  });

  it('omits a notice when the only occurrence beyond the default is explicitly excluded', async () => {
    const finite = handleCapture(store, {
      content: 'Finite review context.', description: 'Finite context',
      actions: [{name: 'Finite review', description: 'Finite',
        recurrence: [{dtstart: '2027-01-01', rrule: 'FREQ=YEARLY;COUNT=2'}]}],
    }).createdActionIds[0];
    const omitted = projectionId({template: finite, original: '2028-01-01'});
    const result = await query(`{ actions(where: {
      occurrence: {projected: true, template: "${finite}"}, not: {ids: ["${omitted}"]}
    }) { totalCount } }`);
    expect(result.data.actions.totalCount).toBe(1);
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });

  it('omits a notice when an exact-ID OR branch already includes the selected far-future occurrence', async () => {
    const backlog = handleCapture(store, {
      content: 'Backlog context.', description: 'Backlog context',
      actions: [{name: 'Backlog task', description: 'Backlog'}],
    }).createdActionIds[0];
    const exact = projectionId({template, original: '2040-01-01'});
    const result = await query(`{ actions(where: {or: [
      {ids: ["${exact}"]}, {status: [BACKLOG]}
    ]}, orderBy: SCHEDULED_ASC) { totalCount nodes { id } } }`);
    expect(result.data.actions).toEqual({totalCount: 2, nodes: [{id: exact}, {id: backlog}]});
    expect(result.extensions.defaultProjectionRanges).toEqual([]);
  });
});
