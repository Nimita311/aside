import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';
import { handleUpdateOccurrence } from '../src/mcp/tools/recurrence.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import { createArtifact } from '../src/mcp/tools/artifact.js';
import { executeGraphQL } from '../src/graphql/schema.js';
import { QueryView } from '../src/graphql/query.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import * as models from '../src/automation/models.js';

describe('one GraphQL action collection', () => {
  let dir: string, store: Store, host: InstanceHost | undefined;
  let template: string, project: string, entry: string, artifact: string;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    vi.spyOn(models, 'catalogFor').mockResolvedValue({ models: [], diagnostics: [], revision: 'fixture' });
    dir = mkdtempSync('/private/tmp/aside-unified-actions-');
    init(dir, { name: 'Unified actions', description: 'Fixture' });
    store = new Store(dir);
    artifact = createArtifact(store, { name: 'Instructions', description: 'Context', body: 'Follow these instructions.' }).id;
    const created = handleCapture(store, {
      content: `Define a routine with #artifact/${artifact}.`, description: 'Routine context',
      projects: [{ name: 'Finance', description: 'Finance' }],
      actions: [{ name: 'Review finances', description: 'Weekly review', body: `Read #artifact/${artifact}.`,
        recurrence: [{ dtstart: '2026-10-11', rrule: 'FREQ=DAILY' }] }],
    });
    template = created.createdActionIds[0]; project = created.createdProjectIds[0]; entry = created.entryId;
  });

  afterEach(async () => {
    await host?.close(); host = undefined;
    store.close(); vi.useRealTimers(); vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const query = async (document: string, variables?: Record<string, unknown>) => {
    const result = await executeGraphQL(store, 'query', { document, variables });
    expect(result.errors).toBeUndefined();
    return result as any;
  };
  const projections = async () => (await query(`{ actions(where: {occurrence: {projected: true}}, limit: 100, orderBy: CREATED_ASC) {
    totalCount nodes { id name filePath scheduled recurrence { dtstart } occurrence { template { id } original timezone projected } }
  } }`)).data.actions;
  const tool = async (mode: 'query' | 'mutate', document: string, variables?: Record<string, unknown>) => {
    host ??= new InstanceHost(new CalClient(null));
    return JSON.parse((await host.tool(dir, mode, { document, variables })).text);
  };

  it.each(['missing', 'ordinary', 'invalid'])('omits a %s occurrence template target and reports the inconsistency', async kind => {
    const target = '2026-10-10-broken-template';
    if (kind !== 'missing') writeFileSync(join(dir, 'actions', '2026', `${target}.md`),
      `---
name: Broken template
created: 2026-10-10T10:00
${kind === 'invalid' ? 'recurrence: [{dtstart: 2026-10-11, rrule: NOT-A-RULE}]\n' : ''}---
`);
    const id = '2026-10-10-saved-occurrence';
    writeFileSync(join(dir, 'actions', '2026', `${id}.md`),
      `---
name: Saved occurrence
created: 2026-10-10T10:00
occurrence: {template: ${target}, original: 2026-10-11}
---
`);
    store.rebuild();
    const result = await query(`{ action(id: "${id}") { occurrence { template { id } original projected } } }`);
    expect(result.data.action.occurrence).toEqual({template: null, original: '2026-10-11', projected: false});
    expect(result.extensions.complete).toBe(false);
    expect(result.extensions.diagnostics).toContainEqual(expect.objectContaining({code: 'occurrence_template', message: expect.stringContaining(target)}));
    expect(store.getAction(id)!.frontMatter.occurrence!.template).toBe(target);
  });

  it('exposes domain fields directly with one occurrence metadata object', async () => {
    const { data } = await query(`{
      entry(id: "${entry}") { created filePath projects { nodes { id } } actions { totalCount } }
      project(id: "${project}") { name created ended relatedProjects { nodes { project { id } } } }
      action(id: "${template}") { name created scheduled status recurrence { dtstart rrule timezone } occurrence { projected } }
      artifact(id: "${artifact}") { name created content { ... on MarkdownContent { text } } attachments { filename } }
      queryType: __type(name: "Query") { fields { name } }
      oldFrontMatter: __type(name: "ActionFrontMatter") { name }
      oldPlanning: __type(name: "PlanningAction") { name }
      oldEntryMeta: __type(name: "EntryMeta") { name }
    }`);
    expect(data.entry).toEqual({ created: entry, filePath: store.getEntryFile(entry), projects: { nodes: [{ id: project }] }, actions: { totalCount: 1 } });
    expect(data.project).toMatchObject({ name: 'Finance', ended: null, relatedProjects: {nodes: []} });
    expect(data.action).toMatchObject({ name: 'Review finances', scheduled: null, status: null, occurrence: null,
      recurrence: [{ dtstart: '2026-10-11', rrule: 'FREQ=DAILY', timezone: null }] });
    expect(data.artifact).toMatchObject({ name: 'Instructions', content: { text: 'Follow these instructions.' }, attachments: [] });
    expect(data.queryType.fields.map((field: any) => field.name)).not.toContain('planningActions');
    expect(data.oldFrontMatter).toBeNull(); expect(data.oldPlanning).toBeNull(); expect(data.oldEntryMeta).toBeNull();
  });

  it('includes templates and only future occurrences inside the default lookahead', async () => {
    handleCapture(store, { content: 'Distant repeat', description: 'Distant', actions: [{ name: 'Distant repeat', description: 'Distant',
      recurrence: [{ dtstart: '2026-10-20', rrule: 'FREQ=DAILY' }] }] });
    const before = store.getActions().size;
    const rows = await projections();
    expect(rows.totalCount).toBe(7);
    expect(rows.nodes.map((action: any) => action.scheduled)).toEqual([
      '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17',
    ]);
    for (const action of rows.nodes) {
      expect(action.recurrence).toBeNull();
      expect(action.occurrence).toEqual({ template: {id: template}, original: action.scheduled, timezone: null, projected: true });
      expect(action.filePath).toBeNull();
    }
    expect((await query('{ actions { totalCount } }')).data.actions.totalCount).toBe(before + 7);
    expect(store.getActions().size).toBe(before);
    expect((await query('{ actions(where: {not: {occurrence: {}}}) { totalCount } }')).data.actions.totalCount).toBe(before);
  });

  it('keeps active and dormant templates outside action lifecycle statuses', async () => {
    const created = handleCapture(store, { content: 'Lifecycle examples', description: 'Examples', projects: [project], actions: [
      { name: 'Dormant routine', description: 'Dormant', recurrence: [] },
      { name: 'Backlog task', description: 'Backlog' },
      { name: 'Scheduled task', description: 'Scheduled', scheduled: '2026-10-12' },
      { name: 'Finished task', description: 'Finished' },
      { name: 'Cancelled task', description: 'Cancelled' },
    ] });
    const [dormant, backlog, scheduled, finished, cancelled] = created.createdActionIds;
    handleUpdateAction(store, { id: finished, resolution: 'done' });
    handleUpdateAction(store, { id: cancelled, resolution: 'cancelled' });
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-11', resolution: 'done' }).id;
    const { data } = await query(`{
      template: action(id: "${template}") { status recurrence { dtstart } }
      dormant: action(id: "${dormant}") { status recurrence { dtstart } }
      backlog: action(id: "${backlog}") { status }
      scheduled: action(id: "${scheduled}") { status }
      finished: action(id: "${finished}") { status }
      cancelled: action(id: "${cancelled}") { status }
      saved: action(id: "${saved}") { status occurrence { projected } }
      all: actions(limit: 100) { totalCount nodes { id status } }
      templates: actions(where: {recurrenceExists: true}, limit: 100) { totalCount nodes { id status } }
      tasks: actions(where: {recurrenceExists: false}, limit: 100) { totalCount nodes { id status } }
      nullFilter: actions(where: {recurrenceExists: null}) { totalCount }
      nullStatus: actions(where: {status: null}) { totalCount }
      statuses: actions(where: {status: [BACKLOG, SCHEDULED, DONE, CANCELLED]}, limit: 100) { totalCount nodes { id status } }
      notDone: actions(where: {not: {status: [DONE]}}, limit: 100) { totalCount nodes { id status } }
      tasksNotDone: actions(where: {recurrenceExists: false, not: {status: [DONE]}}, limit: 100) { totalCount nodes { id status } }
      projected: actions(where: {occurrence: {projected: true}}, limit: 100) { nodes { status } }
    }`);
    expect(data.template).toEqual({ status: null, recurrence: [{ dtstart: '2026-10-11' }] });
    expect(data.dormant).toEqual({ status: null, recurrence: [] });
    expect(data.backlog.status).toBe('BACKLOG'); expect(data.scheduled.status).toBe('SCHEDULED');
    expect(data.finished.status).toBe('DONE'); expect(data.cancelled.status).toBe('CANCELLED');
    expect(data.saved).toEqual({ status: 'DONE', occurrence: { projected: false } });
    expect(data.templates.totalCount).toBe(2);
    expect(data.templates.nodes.map((row: any) => row.id).sort()).toEqual([template, dormant].sort());
    expect(data.templates.nodes.every((row: any) => row.status === null)).toBe(true);
    expect(data.all.totalCount).toBe(store.getActions().size + 6);
    expect(data.nullFilter.totalCount).toBe(data.all.totalCount);
    expect(data.nullStatus.totalCount).toBe(data.all.totalCount);
    expect(data.tasks.totalCount).toBe(data.all.totalCount - 2);
    expect(data.statuses).toEqual(data.tasks);
    expect(data.notDone.totalCount).toBe(data.all.totalCount - 2);
    expect(data.notDone.nodes.filter((row: any) => row.status === null).map((row: any) => row.id).sort()).toEqual([template, dormant].sort());
    expect(data.notDone.nodes.every((row: any) => row.status !== 'DONE')).toBe(true);
    expect(data.tasksNotDone.totalCount).toBe(data.notDone.totalCount - 2);
    expect(data.tasksNotDone.nodes).toEqual(data.notDone.nodes.filter((row: any) => row.id !== template && row.id !== dormant));
    expect(data.projected.nodes).toHaveLength(6);
    expect(data.projected.nodes.every((row: any) => row.status === 'SCHEDULED')).toBe(true);
  });

  it('filters templates through roots, relationships, Boolean predicates, and search before pagination', async () => {
    const dormant = handleCapture(store, { content: 'Dormant context', description: 'Context', projects: [project], actions: [
      { name: 'Dormant review', description: 'Dormant review', recurrence: [] },
    ] }).createdActionIds[0];
    const backlog = handleCapture(store, { content: 'Checklist context', description: 'Context', projects: [project], actions: [
      { name: 'Review checklist', description: 'Checklist' },
    ] }).createdActionIds[0];
    const other = handleCapture(store, { content: 'Another routine', description: 'Other context', projects: [
      { name: 'Other project', description: 'Other' },
    ], actions: [{ name: 'Unrelated routine', description: 'Other', recurrence: [] }] }).createdProjectIds[0];
    const { data } = await query(`{
      root: actions(where: {recurrenceExists: true, projectIds: ["${project}"]}, limit: 1, orderBy: CREATED_ASC) {
        totalCount nodes { id status } offset count
      }
      project(id: "${project}") { actions(where: {recurrenceExists: true}, limit: 1, orderBy: CREATED_ASC) {
        totalCount nodes { id status } offset count
      } }
      mixed: actions(where: {projectIds: ["${project}"], or: [{recurrenceExists: true}, {status: [BACKLOG]}]}, limit: 100) { nodes { id } }
      inverse: actions(where: {projectIds: ["${project}"], not: {recurrenceExists: false}}, limit: 100) { nodes { id } }
      templateOnlyProjects: projects(where: {actions: {some: {recurrenceExists: true}, none: {recurrenceExists: false}}}) { nodes { id } }
      withBacklog: projects(where: {actions: {some: {status: [BACKLOG]}}}) { nodes { id } }
    }`);
    expect(data.root).toEqual(data.project.actions);
    expect(data.root.totalCount).toBe(2); expect(data.root.nodes).toHaveLength(1);
    expect(data.root.nodes[0].status).toBeNull();
    expect(data.root).toMatchObject({offset: 0, count: 1});
    const next = (await query(`{ actions(where: {recurrenceExists: true, projectIds: ["${project}"]}, limit: 1, offset: 1, orderBy: CREATED_ASC) { nodes { id } } }`)).data.actions;
    expect([data.root.nodes[0].id, next.nodes[0].id].sort()).toEqual([template, dormant].sort());
    expect(data.mixed.nodes.map((row: any) => row.id).sort()).toEqual([template, dormant, backlog].sort());
    expect(data.inverse.nodes.map((row: any) => row.id).sort()).toEqual([template, dormant].sort());
    expect(data.templateOnlyProjects.nodes).toEqual([{ id: other }]);
    expect(data.withBacklog.nodes).toEqual([{ id: project }]);
    const match = vi.fn(async (_pattern: string, texts: string[][]) => {
      expect(texts).toHaveLength(2);
      expect(texts.map(fields => fields[0]).sort()).toEqual(['Dormant review', 'Review finances']);
      return texts.flatMap((fields, index) => fields[0] === 'Dormant review' ? [index] : []);
    });
    const searched = await executeGraphQL(store, 'query', {
      document: `{ project(id: "${project}") { actions(where: {recurrenceExists: true, search: "review"}, limit: 1) { totalCount nodes { id status } } } }`,
    }, { matcher: { match } });
    expect(searched.errors).toBeUndefined();
    expect((searched.data!.project as any).actions).toEqual({ totalCount: 1, nodes: [{ id: dormant, status: null }] });
    expect(match).toHaveBeenCalledOnce();
  });

  it('returns null status when templates are created, converted, or made dormant through GraphQL', async () => {
    const created = await tool('mutate', `mutation {
      capture(input: {content: "Create action forms", description: "Forms", actions: [
        {create: {name: "Ordinary", description: "Ordinary", body: "Keep instructions."}},
        {create: {name: "Dormant", description: "Dormant", recurrence: []}},
        {create: {name: "Recurring", description: "Recurring", recurrence: [{dtstart: "2026-10-11", rrule: "FREQ=DAILY"}]}}
      ]}) { createdActions { id status recurrence { dtstart } } }
    }`);
    expect(created.errors).toBeUndefined();
    const [ordinary, dormant, recurring] = created.data.capture.createdActions;
    expect(ordinary).toMatchObject({ status: 'BACKLOG', recurrence: null });
    expect(dormant).toMatchObject({ status: null, recurrence: [] });
    expect(recurring).toMatchObject({ status: null, recurrence: [{ dtstart: '2026-10-11' }] });
    const converted = await tool('mutate', `mutation($id: ID!) {
      updateAction(id: $id, input: {recurrence: {append: {dtstart: "2026-10-11", rrule: "FREQ=DAILY"}}}) {
        action { id status body recurrence { dtstart } }
      }
    }`, { id: ordinary.id });
    expect(converted.errors).toBeUndefined();
    expect(converted.data.updateAction.action).toEqual({ id: ordinary.id, status: null, body: 'Keep instructions.', recurrence: [{ dtstart: '2026-10-11' }] });
    const stopped = await tool('mutate', `mutation($id: ID!) {
      updateAction(id: $id, input: {recurrence: {remove: {dtstart: "2026-10-11"}}}) { action { id status recurrence { dtstart } } }
    }`, { id: ordinary.id });
    expect(stopped.errors).toBeUndefined();
    expect(stopped.data.updateAction.action).toEqual({ id: ordinary.id, status: null, recurrence: [] });
    const result = await tool('query', `query($id: ID!) {
      template: actions(where: {ids: [$id], recurrenceExists: true}) { totalCount }
      backlog: actions(where: {ids: [$id], status: [BACKLOG]}) { totalCount }
    }`, { id: ordinary.id });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ template: { totalCount: 1 }, backlog: { totalCount: 0 } });
  });

  it('converts scheduled and resolved tasks only when their lifecycle metadata is cleared in the same edit', async () => {
    const created = await tool('mutate', `mutation {
      capture(input: {content: "Prepare conversions", description: "Conversions", actions: [
        {create: {name: "Scheduled conversion", description: "Scheduled", scheduled: "2026-10-12"}},
        {create: {name: "Completed conversion", description: "Completed"}}
      ]}) { createdActions { id } }
    }`);
    expect(created.errors).toBeUndefined();
    const [scheduled, resolved] = created.data.capture.createdActions;
    const finished = await tool('mutate', 'mutation($id: ID!) { updateAction(id: $id, input: {status: DONE}) { action { status } } }', { id: resolved.id });
    expect(finished.errors).toBeUndefined(); expect(finished.data.updateAction.action.status).toBe('DONE');
    for (const id of [scheduled.id, resolved.id]) {
      const rejected = await tool('mutate', `mutation($id: ID!) {
        updateAction(id: $id, input: {recurrence: {append: {dtstart: "2026-10-11", rrule: "FREQ=DAILY"}}}) { action { id } }
      }`, { id });
      expect(rejected.errors).toHaveLength(1); expect(rejected.extensions.mutations).toEqual([]);
    }
    const converted = await tool('mutate', `mutation($scheduled: ID!, $resolved: ID!) {
      scheduled: updateAction(id: $scheduled, input: {status: null, recurrence: {append: {dtstart: "2026-10-11", rrule: "FREQ=DAILY"}}}) {
        action { id status scheduled recurrence { dtstart } }
      }
      resolved: updateAction(id: $resolved, input: {status: null, recurrence: {append: {dtstart: "2026-10-11", rrule: "FREQ=DAILY"}}}) {
        action { id status scheduled recurrence { dtstart } }
      }
    }`, { scheduled: scheduled.id, resolved: resolved.id });
    expect(converted.errors).toBeUndefined();
    for (const [field, id] of [['scheduled', scheduled.id], ['resolved', resolved.id]]) {
      expect(converted.data[field].action).toEqual({ id, status: null, scheduled: null, recurrence: [{ dtstart: '2026-10-11' }] });
    }
    const saved = await tool('mutate', `mutation($template: ID!) {
      updateOccurrence(input: {template: $template, original: "2026-10-11", status: DONE}) { action { id occurrence { projected } } }
    }`, { template });
    expect(saved.errors).toBeUndefined();
    const occurrence = saved.data.updateOccurrence.action;
    const rejectedOccurrence = await tool('mutate', `mutation($id: ID!) {
      updateAction(id: $id, input: {status: null, recurrence: {append: {dtstart: "2026-10-11", rrule: "FREQ=DAILY"}}}) { action { id } }
    }`, { id: occurrence.id });
    expect(rejectedOccurrence.errors).toHaveLength(1); expect(rejectedOccurrence.extensions.mutations).toEqual([]);
    const persisted = await tool('query', 'query($id: ID!) { action(id: $id) { status occurrence { projected } } }', { id: occurrence.id });
    expect(persisted.data.action).toEqual({ status: 'DONE', occurrence: { projected: false } });
  });

  it('uses status commands to complete and reactivate tasks while retaining or clearing schedules explicitly', async () => {
    const task = handleCapture(store, {content: 'Scheduled task', description: 'Task', actions: [
      {name: 'Status transitions', description: 'Transitions', scheduled: '2026-10-12T09:00', body: 'Keep these instructions.'},
    ]}).createdActionIds[0];
    const completed = await tool('mutate', `mutation { updateAction(id: "${task}", input: {status: DONE}) { action { status scheduled body } } }`);
    expect(completed.errors).toBeUndefined();
    expect(completed.data.updateAction.action).toEqual({status: 'DONE', scheduled: '2026-10-12T09:00', body: 'Keep these instructions.'});
    const reactivated = await tool('mutate', `mutation { updateAction(id: "${task}", input: {status: SCHEDULED}) { action { status scheduled } } }`);
    expect(reactivated.errors).toBeUndefined();
    expect(reactivated.data.updateAction.action).toEqual({status: 'SCHEDULED', scheduled: '2026-10-12T09:00'});
    const backlog = await tool('mutate', `mutation { updateAction(id: "${task}", input: {status: BACKLOG}) { action { status scheduled } } }`);
    expect(backlog.errors).toBeUndefined();
    expect(backlog.data.updateAction.action).toEqual({status: 'BACKLOG', scheduled: null});
    const invalid = await tool('mutate', `mutation { updateAction(id: "${task}", input: {status: SCHEDULED}) { error } }`);
    expect(invalid.errors).toHaveLength(1); expect(invalid.extensions.mutations).toEqual([]);
    const nullStatus = await tool('mutate', `mutation { updateAction(id: "${task}", input: {status: null}) { error } }`);
    expect(nullStatus.errors).toHaveLength(1); expect(nullStatus.extensions.mutations).toEqual([]);
    store.rebuild();
    expect(store.getAction(task)!.frontMatter).not.toHaveProperty('scheduled');
    expect(store.getAction(task)!.frontMatter).not.toHaveProperty('resolution');
    expect(store.getAction(task)!.body).toBe('Keep these instructions.');
  });

  it('rejects authored lifecycle contradictions before any mutation writes', async () => {
    const original = readFileSync(`${dir}/aside.md`, 'utf8');
    const result = await tool('mutate', `mutation {
      first: updateInstance(input: {body: "Must not save"}) { error }
      second: updateAction(id: "${template}", input: {status: BACKLOG, scheduled: "2026-10-12"}) { error }
    }`);
    expect(result.errors).toHaveLength(1); expect(result.extensions.mutations).toEqual([]);
    expect(readFileSync(`${dir}/aside.md`, 'utf8')).toBe(original);
  });

  it('omits missing tag targets from relationships and diagnoses them', async () => {
    const metadata = store.getEntries().find(record => record.meta.created === entry)!.meta;
    metadata.projects!.push('missing-project'); metadata.actions!.push('missing-action');
    const result = await query(`{ entry(id: "${entry}") {
      projects { nodes { id } } actions { nodes { id } }
    } }`);
    expect(result.data.entry).toEqual({ projects: { nodes: [{ id: project }] }, actions: { nodes: [{ id: template }] } });
    expect(result.extensions.complete).toBe(false);
    expect(result.extensions.diagnostics.map((issue: any) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('missing-project'), expect.stringContaining('missing-action'),
    ]));
  });

  it('uses changed lookahead settings immediately and does not force a distant occurrence', async () => {
    expect((await projections()).totalCount).toBe(7);
    handleUpdateInstance(store, { recurrenceLookaheadDays: 2 });
    expect((await projections()).nodes.map((row: any) => row.scheduled)).toEqual(['2026-10-11', '2026-10-12']);
    handleUpdateInstance(store, { recurrenceLookaheadDays: 0 });
    expect((await projections()).totalCount).toBe(0);
    handleUpdateInstance(store, { recurrenceLookaheadDays: 4 });
    expect((await projections()).totalCount).toBe(4);
  });

  it('filters projections before both root and nested pagination', async () => {
    handleCapture(store, { content: 'Unrelated', description: 'Unrelated',
      projects: [{ name: 'Other', description: 'Other' }],
      actions: [{ name: 'Unrelated', description: 'Other work', recurrence: [{ dtstart: '2026-10-11', rrule: 'FREQ=DAILY' }] }],
    });
    const { data } = await query(`{
      actions(where: {projectIds: ["${project}"], occurrence: {projected: true}}, limit: 1, orderBy: CREATED_ASC) {
        totalCount nodes { id occurrence { template { id } } } offset count
      }
      project(id: "${project}") { actions(where: {occurrence: {projected: true}}, limit: 1, orderBy: CREATED_ASC) {
        totalCount nodes { id occurrence { template { id } } } offset count
      } }
    }`);
    expect(data.actions).toEqual(data.project.actions);
    expect(data.actions.totalCount).toBe(7); expect(data.actions.nodes).toHaveLength(1);
    expect(data.actions.nodes[0].occurrence.template.id).toBe(template);
    expect(data.actions).toMatchObject({offset: 0, count: 1});
    const next = (await query(`{ actions(where: {projects: {some: {ids: ["${project}"]}}, occurrence: {template: "${template}", projected: true}},
      limit: 1, offset: 1, orderBy: CREATED_ASC) { totalCount nodes { id } } }`)).data.actions;
    expect(next.totalCount).toBe(7); expect(next.nodes[0].id).not.toBe(data.actions.nodes[0].id);
  });

  it('includes projections in relation predicates and artifact context without creating backlinks', async () => {
    const { data } = await query(`{
      projects(where: {actions: {some: {occurrence: {projected: true}, search: "Weekly review"}}}) { nodes { id } }
      artifact(id: "${artifact}") { backlinks { nodes { ... on Action { handle } ... on Entry { handle } } } actions(where: {occurrence: {projected: true}}, limit: 100) { totalCount } }
      actions(where: {occurrence: {projected: true}, search: "Weekly review"}, limit: 100) {
        totalCount nodes { projects { totalCount } entries { totalCount } artifacts { nodes { id } } }
      }
    }`);
    expect(data.projects.nodes).toEqual([{ id: project }]);
    expect(data.artifact.actions.totalCount).toBe(7);
    expect(data.artifact.backlinks.nodes.map((node: any) => node.handle)).toEqual(expect.arrayContaining([`#action/${template}`, `#entry/${entry}`]));
    expect(data.artifact.backlinks.nodes).toHaveLength(2);
    expect(data.actions.totalCount).toBe(7);
    for (const action of data.actions.nodes) {
      expect(action.projects.totalCount).toBe(1); expect(action.entries.totalCount).toBe(0);
      expect(action.artifacts.nodes).toEqual([{ id: artifact }]);
    }
  });

  it('suppresses the original projection even when a saved occurrence is moved outside the horizon', async () => {
    const saved = handleUpdateOccurrence(store, { template, original: '2026-10-11', scheduled: '2099-01-01', resolution: 'done' }).id;
    const { data } = await query(`{ actions(limit: 100) { totalCount nodes { id scheduled occurrence { original projected } } } }`);
    expect(data.actions.totalCount).toBe(8);
    expect(data.actions.nodes.filter((row: any) => row.occurrence?.original === '2026-10-11')).toEqual([
      { id: saved, scheduled: '2099-01-01', occurrence: { original: '2026-10-11', projected: false } },
    ]);
    expect((await query('{ actions(where: {occurrence: {projected: false}}) { totalCount } }')).data.actions.totalCount).toBe(1);
  });

  it('looks up and edits a projected action through the ordinary action operations', async () => {
    const listed = await tool('query', `{ actions(where: {occurrence: {projected: true}, scheduledTo: "2026-10-11"}) {
      nodes { id occurrence { template { id } original projected } }
    } }`);
    expect(listed.errors).toBeUndefined();
    const projection = listed.data.actions.nodes[0];
    const lookedUp = await tool('query', 'query($id: ID!) { action(id: $id) { id occurrence { projected } } }', { id: projection.id });
    expect(lookedUp.data.action).toEqual({ id: projection.id, occurrence: { projected: true } });
    const edited = await tool('mutate', `mutation($id: ID!) { updateAction(id: $id, input: {name: "Specific review", status: DONE}) {
      error action { id name status occurrence { template { id } original projected } }
    } }`, { id: projection.id });
    expect(edited.errors).toBeUndefined();
    const saved = edited.data.updateAction.action;
    expect(saved.id).not.toBe(projection.id);
    expect(saved).toMatchObject({ name: 'Specific review', status: 'DONE', occurrence: { template: {id: template}, original: '2026-10-11', projected: false } });
    expect(edited.extensions.mutations).toHaveLength(1);
    expect(edited.extensions.mutations[0].operation).toBe('updateAction');
    const repeated = await tool('mutate', `mutation($template: ID!) { updateOccurrence(input: {template: $template, original: "2026-10-11", name: "Edited again"}) {
      action { id occurrence { projected } }
    } }`, { template });
    expect(repeated.data.updateOccurrence.action).toEqual({ id: saved.id, occurrence: { projected: false } });
    store.rebuild();
    expect(store.getActions().size).toBe(2);
    expect(readFileSync(store.getActionFile(saved.id)!, 'utf8')).not.toContain('projected:');
    expect((await projections()).totalCount).toBe(6);
  });

  it('rejects empty edits and recurrence commands on projections without saving anything', async () => {
    const id = (await projections()).nodes[0].id;
    for (const input of [{}, { recurrence: { remove: { dtstart: '2026-10-11' } } }]) {
      const result = await tool('mutate', 'mutation($id: ID!, $input: UpdateActionInput!) { updateAction(id: $id, input: $input) { error } }', { id, input });
      expect(result.errors).toHaveLength(1); expect(result.extensions.mutations).toEqual([]);
    }
    store.rebuild(); expect(store.getActions().size).toBe(1);
  });

  it('refreshes the projection clock without changing an in-flight query snapshot', async () => {
    handleUpdateInstance(store, { recurrenceLookaheadDays: 1 });
    let release!: (indices: number[]) => void;
    const matcher = { match: vi.fn(() => new Promise<number[]>(resolve => { release = resolve; })) };
    const pending = executeGraphQL(store, 'query', { document: `{ actions(where: {occurrence: {projected: true}, search: "Review"}) { nodes { scheduled } } }` }, { matcher });
    await vi.waitFor(() => expect(matcher.match).toHaveBeenCalledOnce());
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    expect((await projections()).nodes.map((row: any) => row.scheduled)).toEqual(['2026-10-11', '2026-10-12']);
    release([0]);
    const result = await pending;
    expect(result.errors).toBeUndefined();
    expect(result.data!.actions).toEqual({ nodes: [{ scheduled: '2026-10-11' }] });
  });

  it('puts recurrence expansion failures into common response completeness', async () => {
    // Simulate an externally malformed declaration already loaded into a Store.
    store.getAction(template)!.frontMatter.recurrence![0].rrule = 'FREQ=INVALID';
    const result = await query('{ actions { totalCount } }');
    expect(result.extensions.complete).toBe(false);
    expect(result.extensions.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'graphql_recurrence_projection', message: expect.stringContaining(template) }),
    ]));
    expect(new QueryView(store).issues.some(issue => issue.code === 'graphql_recurrence_projection')).toBe(true);
  });
});
