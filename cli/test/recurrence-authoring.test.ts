import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateOccurrence, handlePlanningActions } from '../src/mcp/tools/recurrence.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import type { RecurrenceSchedule } from '../src/core/recurrence.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { InstanceHost } from '../src/daemon/host.js';
import { recurrenceHistoryPath } from '../src/mcp/recurrence-history.js';
import { serializeAction } from '../src/mcp/tools/serialize.js';
import * as indexFiles from '../src/mcp/tools/index-file.js';

let dir: string, store: Store, template: string, project: string;
const recurrence = [{ dtstart: '2026-01-01', rrule: 'FREQ=DAILY' }];
// Direct record writes exercise the storage guard independently of the
// bounded authoring API, including repairs to malformed source files.
function saveRecurrence(id: string, schedules?: RecurrenceSchedule[]): void {
  const action = store.getAction(id)!;
  const fm = { ...action.frontMatter, recurrence: schedules };
  if (schedules === undefined) delete fm.recurrence;
  store.saveAction(id, fm, action.body, store.getActionFile(id)!);
}
beforeEach(() => {
  dir = mkdtempSync('/private/tmp/aside-recur-author-'); init(dir, { name: 'Recurrence', description: 'Fixture' }); store = new Store(dir);
  const result = handleCapture(store, { content: 'Create reusable work', description: 'Start', projects: [{ name: 'Health', description: 'Health' }], actions: [{ name: 'Exercise', description: 'Exercise', recurrence, body: 'Follow the routine.' }] }, new Date(2026, 0, 1, 10));
  template = result.createdActionIds[0]; project = result.createdProjectIds[0];
});
afterEach(() => { store.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('recurrence authoring', () => {
  it('allocates IDs using materialization date and edited names without making entries', () => {
    const entryCount = store.getEntries().length;
    const now = new Date(2026, 9, 9, 12, 30);
    const first = handleUpdateOccurrence(store, { template, original: '2026-12-01', name: 'Long walk', resolution: 'done' }, now);
    const second = handleUpdateOccurrence(store, { template, original: '2026-12-02', name: 'Long walk', resolution: 'cancelled' }, now);
    expect(first.id).toBe('2026-10-09-long-walk'); expect(second.id).toBe('2026-10-09-long-walk-2');
    expect(store.getAction(first.id)?.frontMatter.created).toBe('2026-10-09T12:30');
    expect(store.getProjectsForAction(first.id)).toContain(project);
    expect(store.getEntries()).toHaveLength(entryCount);
    expect(handleUpdateOccurrence(store, { template, original: '2026-12-01', name: 'Renamed' }, now).id).toBe(first.id);
    store.rebuild(); expect(store.getProjectsForAction(first.id)).toContain(project);
  });
  it('rejects no-op materialization, immutable provenance changes, and history rewrites', () => {
    expect(() => handleUpdateOccurrence(store, { template, original: '2026-12-01' })).toThrow('edit is required');
    const { id } = handleUpdateOccurrence(store, { template, original: '2026-12-01', resolution: 'done' });
    const action = store.getAction(id)!;
    expect(() => store.saveAction(id, { ...action.frontMatter, occurrence: { template, original: '2026-12-02' } }, action.body, store.getActionFile(id)!)).toThrow('immutable');
    expect(() => saveRecurrence(template, [{ ...recurrence[0], rrule: 'FREQ=WEEKLY' }])).toThrow('governing time before now');
    const future = handleCapture(store, { content: 'Future template', description: 'Future', actions: [{ name: 'Future', description: 'Future', recurrence: [{ dtstart: '2099-01-01', rrule: 'FREQ=DAILY;COUNT=2' }] }] }).createdActionIds[0];
    handleUpdateOccurrence(store, { template: future, original: '2099-01-01', name: 'Edited future' });
    expect(() => saveRecurrence(future)).toThrow('referenced template');
  });
  it('keeps direct-file history diagnostics across rebuilds and permits repair', () => {
    const file = store.getActionFile(template)!;
    const original = readFileSync(file, 'utf8'); writeFileSync(file, original.replace('FREQ=DAILY', 'FREQ=WEEKLY'));
    store.rebuild(); store.rebuild(); expect(store.getIssues().some(i => i.code === 'recurrence_history_changed')).toBe(true);
    saveRecurrence(template, recurrence); store.rebuild();
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed')).toBe(false);
  });
  it('retains accepted history across restart, including edits made while stopped', () => {
    const file = store.getActionFile(template)!;
    const original = readFileSync(file, 'utf8');
    store.close();
    writeFileSync(file, original.replace('FREQ=DAILY', 'FREQ=WEEKLY'));
    store = new Store(dir);
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed')).toBe(true);
    expect(() => saveRecurrence(template, [{ ...recurrence[0], rrule: 'FREQ=WEEKLY' }])).toThrow('governing time before now');
    saveRecurrence(template, recurrence);
    store.close(); store = new Store(dir);
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed')).toBe(false);
  });
  it('durably accepts future changes without weakening the historical guard', () => {
    const updated = [
      { ...recurrence[0], rrule: 'FREQ=DAILY;UNTIL=20981231' },
      { dtstart: '2099-01-01', rrule: 'FREQ=WEEKLY' },
    ];
    handleUpdateAction(store, { id: template, recurrence: { append: updated[1] } });
    store.close(); store = new Store(dir);
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed')).toBe(false);
    expect(store.getAction(template)?.frontMatter.recurrence).toEqual(updated);
    expect(() => saveRecurrence(template, [{ ...recurrence[0], rrule: 'FREQ=WEEKLY' }])).toThrow('governing time before now');
  });
  it('retains saved actions and durable history when shortening, extending covered history, and removing a schedule', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const saved = handleUpdateOccurrence(store, { template, original: '2026-01-03', resolution: 'done' }).id;
    const future = handleUpdateOccurrence(store, { template, original: '2099-01-03', name: 'Saved future work' }).id;
    const selector = { dtstart: recurrence[0].dtstart };
    handleUpdateAction(store, { id: template, recurrence: { set_end: { schedule: selector, at: '2026-01-03T00:00:00-08:00' } } });
    expect(store.getAction(template)?.frontMatter.recurrence).toEqual([{ ...recurrence[0], rrule: 'FREQ=DAILY;UNTIL=20260102' }]);
    store.close(); store = new Store(dir);
    handleUpdateAction(store, { id: template, recurrence: { set_end: { schedule: selector, at: '2026-01-04T00:00:00-08:00' } } });
    store.close(); store = new Store(dir);
    expect(store.getIssues().some(issue => issue.code === 'recurrence_history_changed')).toBe(false);
    handleUpdateAction(store, { id: template, recurrence: { remove: selector } });
    store.close(); store = new Store(dir);
    expect(store.getAction(template)?.frontMatter.recurrence).toEqual([]);
    expect(store.getProjectsForAction(saved)).toContain(project);
    expect(store.getProjectsForAction(future)).toContain(project);
    const page = JSON.parse(handlePlanningActions(store, { from: '2026-01-01', to: '2099-01-04' }));
    expect(page.nodes.map((row: { id: string }) => row.id).sort()).toEqual([saved, future].sort());
    expect(page.nodes.every((row: { projected: boolean }) => !row.projected)).toBe(true);
    expect(handleUpdateOccurrence(store, { template, original: '2026-01-03', name: 'Renamed saved work' }).id).toBe(saved);
    handleUpdateAction(store, { id: template, recurrence: { append: { dtstart: '2099-01-01', rrule: 'FREQ=WEEKLY' } } });
    expect(store.getAction(template)?.frontMatter.recurrence).toHaveLength(1);
  });
  it('rejects uncovered historical extensions without changing content or accepted history', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    const selector = { dtstart: recurrence[0].dtstart };
    handleUpdateAction(store, { id: template, recurrence: { set_end: { schedule: selector, at: '2026-01-02T00:00:00-08:00' } } });
    const file = store.getActionFile(template)!, state = recurrenceHistoryPath(dir, store.getInstance()!.manifest.id!);
    const before = readFileSync(file, 'utf8'), accepted = readFileSync(state, 'utf8');
    expect(() => handleUpdateAction(store, { id: template, name: 'Uncommitted edit', recurrence: { set_end: { schedule: selector, at: '2026-01-04T00:00:00-08:00' } } })).toThrow(/past projection/i);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(state, 'utf8')).toBe(accepted);
    store.close(); store = new Store(dir);
    expect(store.getIssues().some(issue => issue.code === 'recurrence_history_changed')).toBe(false);
    // Direct file edits use the same guard across watcher rebuilds/restarts.
    writeFileSync(file, before.replace('UNTIL=20260101', 'UNTIL=20260103'));
    store.rebuild();
    expect(store.getIssues().some(issue => issue.code === 'recurrence_history_changed')).toBe(true);
    expect(readFileSync(state, 'utf8')).toBe(accepted);
  });
  it('reports corrupt history state and permits repair without accepting a new baseline', () => {
    const state = recurrenceHistoryPath(dir, store.getInstance()!.manifest.id!);
    const accepted = readFileSync(state, 'utf8');
    store.close(); writeFileSync(state, '{broken'); store = new Store(dir);
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed' && i.message.includes('Cannot read'))).toBe(true);
    expect(() => handleUpdateAction(store, { id: template, recurrence: { append: { dtstart: '2099-01-01', rrule: 'FREQ=WEEKLY' } } })).toThrow('Cannot read accepted recurrence history');
    expect(readFileSync(state, 'utf8')).toBe('{broken');
    writeFileSync(state, accepted); store.rebuild();
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed')).toBe(false);
  });
  it('retains a missing-template diagnostic across restart', () => {
    const file = store.getActionFile(template)!;
    const original = readFileSync(file, 'utf8');
    store.close(); rmSync(file); store = new Store(dir);
    expect(store.getIssues().some(i => i.code === 'invalid_recurrence_relationship' && i.message.startsWith(template + ':'))).toBe(true);
    writeFileSync(file, original); store.rebuild();
    expect(store.getIssues().some(i => i.code === 'invalid_recurrence_relationship')).toBe(false);
  });
  it('preserves the baseline when a referenced future template is malformed by direct edit', () => {
    const future = handleCapture(store, { content: 'Future template', description: 'Future', actions: [{ name: 'Future', description: 'Future', recurrence: [{ dtstart: '2099-01-01', rrule: 'FREQ=DAILY;COUNT=2' }] }] }).createdActionIds[0];
    handleUpdateOccurrence(store, { template: future, original: '2099-01-01', name: 'Future edit' });
    const action = store.getAction(future)!, state = recurrenceHistoryPath(dir, store.getInstance()!.manifest.id!);
    const accepted = readFileSync(state, 'utf8');
    writeFileSync(store.getActionFile(future)!, serializeAction({ ...action.frontMatter, recurrence: undefined }, action.body));
    store.rebuild(); store.close(); store = new Store(dir);
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed' && i.message.includes('referenced template'))).toBe(true);
    expect(readFileSync(state, 'utf8')).toBe(accepted);
  });
  it('blocks recurrence changes when both the record write and history rollback fail', () => {
    const file = store.getActionFile(template)!, state = recurrenceHistoryPath(dir, store.getInstance()!.manifest.id!);
    const record = readFileSync(file, 'utf8'), write = indexFiles.writeFileCrashSafe;
    let historyWrites = 0;
    vi.spyOn(indexFiles, 'writeFileCrashSafe').mockImplementation((path, text) => {
      if (path === file) throw new Error('Record write failed');
      if (path === state && ++historyWrites === 2) throw new Error('History rollback failed');
      write(path, text);
    });
    expect(() => handleUpdateAction(store, { id: template, recurrence: { append: { dtstart: '2099-01-01', rrule: 'FREQ=WEEKLY' } } })).toThrow('Record write failed. Cannot restore accepted recurrence history');
    expect(readFileSync(file, 'utf8')).toBe(record);
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed' && i.message.includes('rollback failed'))).toBe(true);
    expect(() => handleUpdateAction(store, { id: template, recurrence: { append: { dtstart: '2100-01-01', rrule: 'FREQ=WEEKLY' } } })).toThrow('Cannot restore accepted recurrence history');
  });
  it('establishes history only for a valid template definition', () => {
    const id = handleCapture(store, { content: 'Ordinary action', description: 'Ordinary', actions: [{ name: 'Ordinary', description: 'Ordinary', scheduled: '2026-01-01' }] }).createdActionIds[0];
    const action = store.getAction(id)!, file = store.getActionFile(id)!;
    writeFileSync(file, serializeAction({ ...action.frontMatter, recurrence }, action.body));
    store.rebuild();
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed' && i.file === file)).toBe(true);
    const state = JSON.parse(readFileSync(recurrenceHistoryPath(dir, store.getInstance()!.manifest.id!), 'utf8'));
    expect(state.schedules.some(([key]: [string, unknown]) => key === id)).toBe(false);
    writeFileSync(file, serializeAction({ ...action.frontMatter, scheduled: undefined, recurrence: [{ ...recurrence[0], rrule: 'FREQ=WEEKLY' }] }, action.body));
    store.rebuild();
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed' && i.file === file)).toBe(false);
  });
  it('does not forget a future baseline when malformed recurrence parses to null', () => {
    const future = handleCapture(store, { content: 'Future template', description: 'Future', actions: [{ name: 'Future', description: 'Future', recurrence: [{ dtstart: '2099-01-01', rrule: 'FREQ=DAILY' }] }] }).createdActionIds[0];
    const file = store.getActionFile(future)!, state = recurrenceHistoryPath(dir, store.getInstance()!.manifest.id!);
    const accepted = readFileSync(state, 'utf8');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/recurrence:\n(?:[ \t]+.*\n)+/, 'recurrence: null\n'));
    store.rebuild();
    expect(store.getIssues().some(i => i.code === 'recurrence_history_changed' && i.message.includes('malformed'))).toBe(true);
    expect(readFileSync(state, 'utf8')).toBe(accepted);
  });
  it('paginates all history and filters projects before selecting a page', () => {
    const count = store.getActions().size;
    const ids = new Set<string>(); let after: string | undefined;
    do { const page = JSON.parse(handlePlanningActions(store, { projects: [project], from: '2026-01-01', to: '2026-12-31', limit: 17, after })); for (const row of page.nodes) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); } after = page.next ?? undefined; } while (after);
    expect(ids.size).toBe(365); expect(store.getActions().size).toBe(count);
    handleUpdateInstance(store, { recurrenceLookaheadDays: 30 }); expect(store.getInstance()?.manifest.config?.recurrenceLookaheadDays).toBe(30);
  });
  it('exposes typed recurrence and projected occurrences through the ordinary action query', async () => {
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    const host = new InstanceHost(new CalClient(null));
    try {
      const query = JSON.parse((await host.tool(dir, 'query', { document: '{ saved: actions(where: {not: {occurrence: {projected: true}}}) { totalCount } actions(where: {occurrence: {projected: true}}, limit: 2) { nodes { occurrence { template { id } original projected } scheduled projects { nodes { id } } } offset count totalCount } }' })).text);
      expect(query.errors).toBeUndefined(); expect(query.data.saved.totalCount).toBe(1);
      expect(query.data.actions).toMatchObject({offset: 0, count: 2});
      expect(query.data.actions.nodes).toHaveLength(2);
      expect(query.data.actions.totalCount).toBeGreaterThanOrEqual(2);
      expect(query.data.actions.nodes[0].occurrence.projected).toBe(true);
      expect(query.data.actions.nodes[0].projects.nodes[0].id).toBe(project);
      const result = JSON.parse((await host.tool(dir, 'mutate', { document: `mutation { updateOccurrence(input: {template: "${template}", original: "2026-12-01", status: DONE}) { action { id occurrence { original projected } } } }` })).text);
      expect(result.errors).toBeUndefined(); expect(result.data.updateOccurrence.action.occurrence).toEqual({original: '2026-12-01', projected: false});
    } finally { await host.close(); }
  });
});
