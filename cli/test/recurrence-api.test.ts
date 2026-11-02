import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { init } from '../src/commands/init.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync } from '../src/mcp/calendar/sync.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { validateToolArgs } from '../src/mcp/schemas.js';
import { recurrenceHistoryPath } from '../src/mcp/recurrence-history.js';
import { handleUpdateOccurrence } from '../src/mcp/tools/recurrence.js';

const initial = { dtstart: '2099-01-01', rrule: 'FREQ=DAILY' };
let dir: string, store: Store, host: InstanceHost, id: string;

beforeEach(() => {
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  dir = mkdtempSync('/private/tmp/aside-recurrence-api-');
  init(dir, { name: 'Recurrence API', description: 'Append-only authoring' });
  store = new Store(dir);
  id = handleCapture(store, { content: 'Reusable work', description: 'Template', actions: [
    { name: 'Routine', description: 'Routine', recurrence: [initial] },
  ] }).createdActionIds[0];
  host = new InstanceHost(new CalClient(null));
});

afterEach(async () => {
  await host.close();
  store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('action recurrence command API', () => {
  it('keeps initial history on creation and validates exactly one action-scoped command', () => {
    expect(validateToolArgs('capture', { content: 'Template', description: 'Template', actions: [
      { name: 'Template', description: 'Template', recurrence: [initial] },
    ] }).actions[0].recurrence).toEqual([initial]);
    expect(validateToolArgs('update_action', { id, recurrence: { append: initial } }).recurrence).toEqual({ append: initial });
    expect(validateToolArgs('update_action', { id, recurrence: { set_end: { schedule: { dtstart: initial.dtstart } } } }).recurrence).toEqual({ set_end: { schedule: { dtstart: initial.dtstart } } });
    expect(validateToolArgs('update_action', { id, recurrence: { remove: { dtstart: initial.dtstart } } }).recurrence).toEqual({ remove: { dtstart: initial.dtstart } });
    const minuteEnd = { set_end: { schedule: { dtstart: initial.dtstart }, at: '2099-01-01T09:00+00:00' } };
    expect(validateToolArgs('update_action', { id, recurrence: minuteEnd }).recurrence).toEqual(minuteEnd);
    for (const recurrence of [
      {}, { append: [initial] }, { append: initial, remove: { dtstart: initial.dtstart } },
      { append: { ...initial, rrule: 'FREQ=INVALID' } },
      { append: { dtstart: '2099-01-01T09:00:01', rrule: 'FREQ=DAILY' } },
      { remove: { dtstart: initial.dtstart, rrule: initial.rrule } },
      { set_end: {} }, { set_end: { schedule: { dtstart: initial.dtstart }, at: '2099-01-01T09:00' } },
      { set_end: { schedule: { dtstart: initial.dtstart }, at: '2099-02-29T09:00:00Z' } },
    ]) expect(() => validateToolArgs('update_action', { id, recurrence })).toThrow('Invalid update_action arguments');
    expect(() => validateToolArgs('update_action', { id, recurrence: [initial] })).toThrow('Invalid update_action arguments');
    expect(() => validateToolArgs('update_action', { id, recurrence: null })).toThrow('Invalid update_action arguments');
    for (const at of ['0000-01-01T09:00:00Z', '2099-02-30T09:00:00Z', '2099-01-01T09:00', '2099-01-01T09:00:00+0000', '2099-01-01T09:00:00.1234567890Z']) {
      expect(() => validateToolArgs('update_action', { id, recurrence: { set_end: { schedule: { dtstart: initial.dtstart }, at } } })).toThrow('Invalid update_action arguments');
    }
    expect(() => validateToolArgs('append_recurrence', { id, schedule: initial })).toThrow('Unknown operation');
    expect(() => validateToolArgs('update_occurrence', { template: id, original: initial.dtstart, recurrence: { append: initial } })).toThrow('Invalid update_occurrence arguments');
  });

  it('exposes one-of GraphQL commands and refuses history replacement before writing', async () => {
    const result = JSON.parse((await host.tool(dir, 'query', { document: `{
      update: __type(name: "UpdateActionInput") { inputFields { name } }
      create: __type(name: "CreateActionInput") { inputFields { name } }
      command: __type(name: "RecurrenceMutationInput") { isOneOf inputFields { name type { name } } }
      end: __type(name: "RecurrenceEndInput") { inputFields { name type { kind ofType { name } } } }
      mutation: __type(name: "Mutation") { fields { name } }
    }` })).text);
    expect(result.errors).toBeUndefined();
    expect(result.data.update.inputFields.map((field: any) => field.name)).toContain('recurrence');
    expect(result.data.create.inputFields.map((field: any) => field.name)).toContain('recurrence');
    expect(result.data.command).toEqual({ isOneOf: true, inputFields: [
      { name: 'append', type: { name: 'RecurrenceScheduleInput' } },
      { name: 'setEnd', type: { name: 'RecurrenceEndInput' } },
      { name: 'remove', type: { name: 'RecurrenceScheduleSelectorInput' } },
    ] });
    expect(result.data.end.inputFields.find((field: any) => field.name === 'schedule')).toEqual({ name: 'schedule', type: { kind: 'NON_NULL', ofType: { name: 'RecurrenceScheduleSelectorInput' } } });
    expect(result.data.mutation.fields.map((field: any) => field.name)).not.toContain('appendRecurrence');
    const file = store.getActionFile(id)!;
    const before = readFileSync(file, 'utf8');
    const rejected = JSON.parse((await host.tool(dir, 'mutate', { document: `mutation {
      updateAction(id: "${id}", input: {recurrence: [{dtstart: "2099-01-01", rrule: "FREQ=WEEKLY"}]}) { error }
    }` })).text);
    expect(rejected.errors?.[0].message).toMatch(/recurrence/i);
    expect(rejected.extensions.mutations).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('routes MCP and GraphQL appends to the same persisted template', async () => {
    const first = await host.tool(dir, 'update_action', { id, recurrence: { append: { dtstart: '2100-01-01', rrule: 'FREQ=WEEKLY' } } });
    expect(first.text).toContain(id);
    const next = JSON.parse((await host.tool(dir, 'mutate', { document: `mutation {
      updateAction(id: "${id}", input: {recurrence: {append: {dtstart: "2101-01-01", rrule: "FREQ=MONTHLY"}}}) {
        error action { id recurrence { dtstart rrule } }
      }
    }` })).text);
    expect(next.errors).toBeUndefined();
    expect(next.extensions.mutations).toHaveLength(1);
    expect(next.extensions.mutations[0].operation).toBe('updateAction');
    expect(next.data.updateAction.action.id).toBe(id);
    expect(next.data.updateAction.action.recurrence).toEqual([
      { dtstart: '2099-01-01', rrule: 'FREQ=DAILY;UNTIL=20991231' },
      { dtstart: '2100-01-01', rrule: 'FREQ=WEEKLY;UNTIL=21001231' },
      { dtstart: '2101-01-01', rrule: 'FREQ=MONTHLY' },
    ]);
    store.rebuild();
    expect(store.getAction(id)?.frontMatter.recurrence).toHaveLength(3);
    expect(store.getEntries()).toHaveLength(1);
  });

  it('queues the changed Calendar template and includes the normal sync receipt', async () => {
    const action = store.getAction(id)!;
    store.saveAction(id, { ...action.frontMatter, calendar: 'Work' }, action.body, store.getActionFile(id)!);
    await host.tool(dir, 'query_actions', { ids: [id] });
    const sync = vi.spyOn(CalSync.prototype, 'syncActions').mockResolvedValue([]);
    const result = await host.tool(dir, 'update_action', { id, recurrence: { append: { dtstart: '2100-01-01', rrule: 'FREQ=WEEKLY' } } });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0][0].id).toBe(id);
    expect(sync.mock.calls[0][0][0].frontMatter.recurrence).toHaveLength(2);
    expect(sync.mock.calls[0][1].some(action => action.id === id)).toBe(true);
    expect(result.text).toContain('calendar_sync:');
    sync.mockClear();
    await host.tool(dir, 'update_action', { id, recurrence: { remove: { dtstart: '2100-01-01' } } });
    sync.mockClear();
    const dormant = await host.tool(dir, 'update_action', { id, recurrence: { remove: { dtstart: initial.dtstart } } });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0][0].frontMatter.recurrence).toEqual([]);
    expect(sync.mock.calls[0][1].some(action => action.id === id)).toBe(true);
    expect(dormant.text).toContain('calendar_sync:');
  });

  it('leaves both record and accepted history untouched when an append is rejected', async () => {
    const file = store.getActionFile(id)!;
    const state = recurrenceHistoryPath(dir, store.getInstance()!.manifest.id!);
    const before = readFileSync(file, 'utf8'), accepted = readFileSync(state, 'utf8');
    for (const schedule of [
      { dtstart: '2026-01-01', rrule: 'FREQ=DAILY' },
      { dtstart: '2098-01-01', rrule: 'FREQ=WEEKLY' },
      { dtstart: '2099-01-01', rrule: 'FREQ=WEEKLY' },
      { dtstart: '2100-01-01T09:00', rrule: 'FREQ=WEEKLY' },
    ]) {
      await expect(host.tool(dir, 'update_action', { id, name: 'Should not save', body: 'Should not save', recurrence: { append: schedule } })).rejects.toThrow();
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readFileSync(state, 'utf8')).toBe(accepted);
    }
    const rejected = JSON.parse((await host.tool(dir, 'mutate', { document: `mutation {
      updateAction(id: "${id}", input: {recurrence: {append: {dtstart: "2026-01-01", rrule: "FREQ=DAILY"}}}) { error }
    }` })).text);
    expect(rejected.errors).toHaveLength(1);
    expect(rejected.extensions.mutations).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(state, 'utf8')).toBe(accepted);
  });

  it('starts recurrence on an ordinary generic action while preserving its metadata and associations', async () => {
    const result = handleCapture(store, { content: 'Reusable generic work', description: 'Define routine',
      projects: [{ name: 'Wellbeing', description: 'Wellbeing' }],
      actions: [{ name: 'Long walk', description: 'Custom summary', body: 'Follow these instructions.', duration: 'PT25M' }],
    });
    const actionId = result.createdActionIds[0], projectId = result.createdProjectIds[0];
    const before = store.getAction(actionId)!, file = store.getActionFile(actionId)!, entries = store.getEntries().length;
    await host.tool(dir, 'update_action', { id: actionId, recurrence: { append: initial } });
    store.rebuild();
    expect(store.getAction(actionId)).toEqual({ ...before, frontMatter: { ...before.frontMatter, recurrence: [initial] } });
    expect(store.getActionFile(actionId)).toBe(file);
    expect(store.getIndexDescription('actions', actionId)).toBe('Custom summary');
    expect(store.getProjectsForAction(actionId)).toEqual([projectId]);
    expect(store.getEntries()).toHaveLength(entries);
  });

  it('refuses scheduled, resolved, and materialized actions as recurrence templates', async () => {
    const scheduledId = handleCapture(store, { content: 'Scheduled work', description: 'Scheduled', actions: [
      { name: 'Appointment', description: 'Appointment', scheduled: '2099-01-01' },
    ] }).createdActionIds[0];
    const resolvedId = handleCapture(store, { content: 'Completed work', description: 'Completed', actions: [
      { name: 'Completed', description: 'Completed' },
    ] }).createdActionIds[0];
    const resolved = store.getAction(resolvedId)!;
    store.saveAction(resolvedId, { ...resolved.frontMatter, resolution: 'done' }, resolved.body, store.getActionFile(resolvedId)!);
    const materializedId = handleUpdateOccurrence(store, { template: id, original: initial.dtstart, name: 'Edited occurrence' }).id;
    for (const actionId of [scheduledId, resolvedId, materializedId]) {
      const file = store.getActionFile(actionId)!, before = readFileSync(file, 'utf8');
      await expect(host.tool(dir, 'update_action', { id: actionId, recurrence: { append: initial } })).rejects.toThrow('cannot also be scheduled, resolved, or an occurrence');
      expect(readFileSync(file, 'utf8')).toBe(before);
    }
  });

  it('preserves a future template and accepted history when direct source edits make recurrence malformed', async () => {
    const file = store.getActionFile(id)!, state = recurrenceHistoryPath(dir, store.getInstance()!.manifest.id!);
    const accepted = readFileSync(state, 'utf8');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/recurrence:\n(?:[ \t]+.*\n)+/, 'recurrence: null\n'));
    store.rebuild();
    expect(store.getIssues().some(issue => issue.code === 'recurrence_history_changed' && issue.message.includes('malformed'))).toBe(true);
    const malformed = readFileSync(file, 'utf8');
    await expect(host.tool(dir, 'update_action', { id, recurrence: { append: { dtstart: '2100-01-01', rrule: 'FREQ=WEEKLY' } } })).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(malformed);
    expect(readFileSync(state, 'utf8')).toBe(accepted);
  });

  it('accepts dormant templates at creation and appends their first schedule through GraphQL', async () => {
    const created = JSON.parse((await host.tool(dir, 'mutate', { document: `mutation {
      capture(input: {content: "Dormant work", description: "Dormant", actions: [{create: {
        name: "Dormant", description: "Dormant", recurrence: []
      }}]}) { createdActions { id recurrence { dtstart } } }
    }` })).text);
    expect(created.errors).toBeUndefined();
    const dormantId = created.data.capture.createdActions[0].id;
    expect(created.data.capture.createdActions[0].recurrence).toEqual([]);
    const appended = JSON.parse((await host.tool(dir, 'mutate', { document: `mutation {
      updateAction(id: "${dormantId}", input: {recurrence: {append: {dtstart: "2099-01-01", rrule: "FREQ=DAILY"}}}) {
        action { id recurrence { dtstart rrule } }
      }
    }` })).text);
    expect(appended.errors).toBeUndefined();
    expect(appended.data.updateAction.action.recurrence).toEqual([initial]);
  });

  it('preserves saved occurrences when shortening, extending covered history, and removing a past rule', async () => {
    const schedule = { dtstart: '2000-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY;COUNT=3' };
    const templateId = handleCapture(store, { content: 'Historical routine', description: 'Routine', actions: [
      { name: 'Historical routine', description: 'Routine', recurrence: [schedule] },
    ] }).createdActionIds[0];
    const originals = ['2000-01-01T09:00:00Z', '2000-01-02T09:00:00Z', '2000-01-03T09:00:00Z'];
    const saved = originals.map(original => handleUpdateOccurrence(store, { template: templateId, original, resolution: 'done' }).id);
    const files = saved.map(actionId => store.getActionFile(actionId)!);
    const contents = files.map(file => readFileSync(file, 'utf8'));
    await host.tool(dir, 'update_action', { id: templateId, recurrence: { set_end: { schedule: { dtstart: schedule.dtstart, timezone: 'UTC' }, at: '2000-01-02T09:00:00Z' } } });
    const extended = JSON.parse((await host.tool(dir, 'mutate', { document: `mutation {
      updateAction(id: "${templateId}", input: {recurrence: {setEnd: {
        schedule: {dtstart: "2000-01-01T09:00", timezone: "UTC"}, at: "2000-01-04T09:00:00Z"
      }}}) { action { recurrence { dtstart rrule timezone } } }
    }` })).text);
    expect(extended.errors).toBeUndefined();
    expect(extended.data.updateAction.action.recurrence).toEqual([{ ...schedule, rrule: 'FREQ=DAILY;UNTIL=20000103T090000Z' }]);
    await host.tool(dir, 'update_action', { id: templateId, recurrence: { remove: { dtstart: schedule.dtstart, timezone: 'UTC' } } });
    expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(contents);
    const planning = JSON.parse((await host.tool(dir, 'planning_actions', { from: '2000-01-01', to: '2000-01-03' })).text);
    expect(planning.nodes.map((row: any) => row.id).sort()).toEqual([...saved].sort());
    expect(planning.nodes.every((row: any) => row.projected === false)).toBe(true);
    const edited = await host.tool(dir, 'update_occurrence', { template: templateId, original: originals[0], resolution: 'cancelled' });
    expect(edited.text).toContain(saved[0]);
  });

  it('rejects an extension that would expose an unsaved past occurrence and matches selectors exactly', async () => {
    const schedule = { dtstart: '2000-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY;COUNT=1' };
    const templateId = handleCapture(store, { content: 'Finished routine', description: 'Routine', actions: [
      { name: 'Finished routine', description: 'Routine', recurrence: [schedule] },
    ] }).createdActionIds[0];
    const file = store.getActionFile(templateId)!, before = readFileSync(file, 'utf8');
    for (const recurrence of [
      { set_end: { schedule: { dtstart: schedule.dtstart, timezone: 'UTC' }, at: '2000-01-03T09:00:00Z' } },
      { set_end: { schedule: { dtstart: schedule.dtstart }, at: '2000-01-03T09:00:00Z' } },
      { remove: { dtstart: schedule.dtstart } },
    ]) {
      await expect(host.tool(dir, 'update_action', { id: templateId, recurrence })).rejects.toThrow();
      expect(readFileSync(file, 'utf8')).toBe(before);
    }
  });

  it('uses the server clock for an omitted set_end cutoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:34:56Z'));
    const schedule = { dtstart: '2000-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY' };
    const templateId = handleCapture(store, { content: 'Active routine', description: 'Routine', actions: [
      { name: 'Active routine', description: 'Routine', recurrence: [schedule] },
    ] }).createdActionIds[0];
    const stopped = JSON.parse((await host.tool(dir, 'mutate', { document: `mutation {
      updateAction(id: "${templateId}", input: {recurrence: {setEnd: {
        schedule: {dtstart: "2000-01-01T09:00", timezone: "UTC"}
      }}}) { action { recurrence { rrule } } }
    }` })).text);
    expect(stopped.errors).toBeUndefined();
    expect(stopped.data.updateAction.action.recurrence).toEqual([{ rrule: 'FREQ=DAILY;UNTIL=20261009T090000Z' }]);
  });
});
