import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import { handleUpdateOccurrence } from '../src/mcp/tools/recurrence.js';
import { executeGraphQL } from '../src/graphql/schema.js';
import { QueryView } from '../src/graphql/query.js';
import * as models from '../src/automation/models.js';

describe('GraphQL action ordering', () => {
  let dir: string, store: Store, project: string, originalZone: string | undefined;
  const query = async (document: string, variables?: Record<string, unknown>) => {
    const result = await executeGraphQL(store, 'query', { document, variables });
    expect(result.errors).toBeUndefined();
    return result.data as any;
  };
  const create = (actions: Parameters<typeof handleCapture>[1]['actions'], minute = 0) => handleCapture(store, {
    content: 'Ordering examples', description: 'Examples', projects: [project], actions,
  }, new Date(`2026-10-10T10:${String(minute).padStart(2, '0')}:00Z`)).createdActionIds;

  beforeEach(() => {
    originalZone = process.env.TZ; process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    vi.spyOn(models, 'catalogFor').mockResolvedValue({ models: [], diagnostics: [], revision: 'fixture' });
    dir = mkdtempSync('/private/tmp/aside-action-ordering-');
    init(dir, { name: 'Action ordering', description: 'Fixture' });
    store = new Store(dir);
    project = handleCapture(store, { content: 'Project', description: 'Project', projects: [{ name: 'Work', description: 'Work' }] }).createdProjectIds[0];
  });

  afterEach(() => {
    store.close(); vi.useRealTimers(); vi.restoreAllMocks();
    if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone;
    rmSync(dir, { recursive: true, force: true });
  });

  it('sorts missing schedules last in either direction with creation and ID tie-breakers', async () => {
    create([
      { name: 'Zulu', description: 'Tie', scheduled: '2026-10-12T12:00' },
      { name: 'Alpha', description: 'Tie', scheduled: '2026-10-12T12:00' },
    ]);
    create([{ name: 'Backlog', description: 'No schedule' }, { name: 'Template', description: 'No schedule', recurrence: [] }], 1);
    create([{ name: 'Earlier', description: 'Earlier', scheduled: '2026-10-11' },
      { name: 'Later', description: 'Later', scheduled: '2026-10-13T12:00' }], 2);
    const data = await query(`{
      asc: actions(orderBy: SCHEDULED_ASC) { nodes { name } }
      desc: actions(orderBy: SCHEDULED_DESC) { nodes { name } }
    }`);
    expect(data.asc.nodes.map((a: any) => a.name)).toEqual(['Earlier', 'Alpha', 'Zulu', 'Later', 'Backlog', 'Template']);
    expect(data.desc.nodes.map((a: any) => a.name)).toEqual(['Later', 'Alpha', 'Zulu', 'Earlier', 'Backlog', 'Template']);
  });

  it('paginates the sorted full matching set and applies the same ordering to nested actions', async () => {
    const ids = create([
      { name: 'Third', description: 'Third', scheduled: '2026-10-13' },
      { name: 'First', description: 'First', scheduled: '2026-10-11' },
      { name: 'Backlog', description: 'Backlog' },
      { name: 'Second', description: 'Second', scheduled: '2026-10-12' },
    ]);
    const first = await query(`query($order: ActionOrder!) {
      actions(where: {ids: ${JSON.stringify([...ids].reverse())}}, orderBy: $order, limit: 2) {
        totalCount nodes { name } offset count
      }
      project(id: "${project}") { actions(orderBy: $order, limit: 2, offset: 2) { nodes { name } } }
    }`, { order: 'SCHEDULED_ASC' });
    expect(first.actions).toEqual({ totalCount: 4, nodes: [{ name: 'First' }, { name: 'Second' }], offset: 0, count: 2 });
    expect(first.project.actions.nodes).toEqual([{ name: 'Third' }, { name: 'Backlog' }]);
    const next = await query(`{ actions(orderBy: SCHEDULED_ASC, limit: 2, offset: ${first.actions.offset + first.actions.count}) { nodes { name } offset count } }`);
    expect(next.actions).toEqual({ nodes: [{ name: 'Third' }, { name: 'Backlog' }], offset: 2, count: 2 });
  });

  it('compares named-zone scheduling instants with local floating clocks and all-day midnight', async () => {
    create([
      { name: 'Pacific', description: '07:00Z', scheduled: '2026-10-11T00:00', timezone: 'America/Los_Angeles' },
      { name: 'Tokyo', description: '04:00Z', scheduled: '2026-10-11T13:00', timezone: 'Asia/Tokyo' },
      { name: 'Floating', description: '02:00Z', scheduled: '2026-10-11T02:00' },
      { name: 'All day', description: '00:00Z', scheduled: '2026-10-11', timezone: 'Asia/Tokyo' },
    ]);
    const data = await query('{ actions(orderBy: SCHEDULED_ASC) { nodes { name } } }');
    expect(data.actions.nodes.map((a: any) => a.name)).toEqual(['All day', 'Floating', 'Tokyo', 'Pacific']);
  });

  it('resolves repeated named-zone scheduled clocks to the first instant', async () => {
    create([
      { name: 'Repeated Pacific', description: '08:30Z', scheduled: '2026-11-01T01:30', timezone: 'America/Los_Angeles' },
      { name: 'Between repeats', description: '09:00Z', scheduled: '2026-11-01T09:00' },
    ]);
    const data = await query('{ actions(orderBy: SCHEDULED_ASC) { nodes { name } } }');
    expect(data.actions.nodes.map((a: any) => a.name)).toEqual(['Repeated Pacific', 'Between repeats']);
  });

  it('keeps an unresolvable saved scheduling clock after known values', async () => {
    const [invalid] = create([
      { name: 'Gap', description: 'Hand edited gap', scheduled: '2026-03-08T01:30', timezone: 'America/Los_Angeles' },
      { name: 'Known', description: 'Known', scheduled: '2026-03-08T04:00', timezone: 'America/Los_Angeles' },
    ]);
    const file = store.getActionFile(invalid)!;
    writeFileSync(file, readFileSync(file, 'utf8').replace('2026-03-08T01:30', '2026-03-08T02:30'));
    store.rebuild();
    const result = await executeGraphQL(store, 'query', { document: '{ actions(orderBy: SCHEDULED_DESC) { nodes { name } } }' });
    expect(result.errors).toBeUndefined();
    expect((result.data as any).actions.nodes).toEqual([{ name: 'Known' }, { name: 'Gap' }]);
  });

  it('orders deadlines as local clocks independently of scheduling zones, with nulls last', async () => {
    create([
      { name: 'Pacific deadline', description: '01:00 local', deadline: '2026-10-11T01:00', timezone: 'America/Los_Angeles' },
      { name: 'Tokyo deadline', description: '13:00 local', deadline: '2026-10-11T13:00', timezone: 'Asia/Tokyo' },
      { name: 'All day deadline', description: 'Midnight local', deadline: '2026-10-11' },
      { name: 'No deadline', description: 'Missing' },
    ]);
    const data = await query(`{
      asc: actions(orderBy: DEADLINE_ASC) { nodes { name } }
      desc: actions(orderBy: DEADLINE_DESC) { nodes { name } }
    }`);
    expect(data.asc.nodes.map((a: any) => a.name)).toEqual(['All day deadline', 'Pacific deadline', 'Tokyo deadline', 'No deadline']);
    expect(data.desc.nodes.map((a: any) => a.name)).toEqual(['Tokyo deadline', 'Pacific deadline', 'All day deadline', 'No deadline']);
  });

  it('orders saved and projected occurrences together and filters exact recovery identity', async () => {
    const [template] = create([{ name: 'Daily', description: 'Daily', recurrence: [{ dtstart: '2026-10-11', rrule: 'FREQ=DAILY' }] }]);
    create([{ name: 'Between', description: 'Between', scheduled: '2026-10-11T12:00' }], 1);
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-12', scheduled: '2026-10-11T06:00' });
    const data = await query(`{
      actions(where: {status: [SCHEDULED]}, orderBy: SCHEDULED_ASC, limit: 4) { nodes { name scheduled occurrence { projected } } }
      recovered: actions(where: {occurrence: {template: "${template}", original: "2026-10-12", projected: false}}) { nodes { id } }
      wrong: actions(where: {occurrence: {template: "${template}", original: "2026-10-12", projected: true}}) { totalCount }
      projected: project(id: "${project}") { actions(where: {occurrence: {template: "${template}", original: "2026-10-13", projected: true}}) { nodes { scheduled } } }
    }`);
    expect(data.actions.nodes).toEqual([
      { name: 'Daily', scheduled: '2026-10-11', occurrence: { projected: true } },
      { name: 'Daily', scheduled: '2026-10-11T06:00', occurrence: { projected: false } },
      { name: 'Between', scheduled: '2026-10-11T12:00', occurrence: null },
      { name: 'Daily', scheduled: '2026-10-13', occurrence: { projected: true } },
    ]);
    expect(data.recovered.nodes).toEqual([{ id: saved.id }]);
    expect(data.wrong.totalCount).toBe(0);
    expect(data.projected.actions.nodes).toEqual([{ scheduled: '2026-10-13' }]);
  });

  it('reuses filter matches across order choices and invalidates ordering after writes', async () => {
    const [later, earlier] = create([
      { name: 'Later', description: 'Later', scheduled: '2026-10-13' },
      { name: 'Earlier', description: 'Earlier', scheduled: '2026-10-11' },
    ]);
    const compile = vi.spyOn(QueryView.prototype, 'compile');
    const document = 'query($order: ActionOrder!) { actions(orderBy: $order) { nodes { id } totalCount } }';
    expect((await query(document, { order: 'SCHEDULED_ASC' })).actions.nodes).toEqual([{ id: earlier }, { id: later }]);
    expect((await query(document, { order: 'DEADLINE_DESC' })).actions.totalCount).toBe(2);
    expect(compile).toHaveBeenCalledOnce();
    handleUpdateAction(store, { id: later, scheduled: '2026-10-10' });
    expect((await query(document, { order: 'SCHEDULED_ASC' })).actions.nodes).toEqual([{ id: later }, { id: earlier }]);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('keeps creation ordering available on all record kinds and documents action-specific ordering', async () => {
    const data = await query(`{
      actionOrder: __type(name: "ActionOrder") { description enumValues { name } }
      recordOrder: __type(name: "RecordOrder") { enumValues { name } }
      project(id: "${project}") { actions(orderBy: CREATED_ASC) { totalCount } }
      projects(orderBy: CREATED_DESC) { totalCount }
    }`);
    expect(data.actionOrder.enumValues.map((v: any) => v.name)).toEqual(['CREATED_DESC', 'CREATED_ASC', 'SCHEDULED_ASC', 'SCHEDULED_DESC', 'DEADLINE_ASC', 'DEADLINE_DESC']);
    expect(data.recordOrder.enumValues.map((v: any) => v.name)).toEqual(['CREATED_DESC', 'CREATED_ASC']);
    expect(data.actionOrder.description).toMatch(/Missing or unresolvable values are last/);
    expect(data.actionOrder.description).toMatch(/Deadlines always use the server's local zone/);
  });
});
