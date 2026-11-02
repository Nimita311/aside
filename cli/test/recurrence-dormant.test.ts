import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { init } from '../src/commands/init.js';
import { parseActionFile } from '../src/core/parser.js';
import { planningActions, recurrenceIssues } from '../src/core/recurrence.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateOccurrence } from '../src/mcp/tools/recurrence.js';
import { serializeAction } from '../src/mcp/tools/serialize.js';

let store: Store | undefined, dir: string | undefined;
afterEach(() => { store?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); store = undefined; dir = undefined; });

describe('dormant recurrence templates', () => {
  it('round-trips an empty schedule list as a template, without backlog or projections', () => {
    const parsed = parseActionFile(serializeAction({ name: 'Routine', created: '2026-10-09T09:00', recurrence: [] }, 'Reusable instructions'));
    expect(parsed.issues).toEqual([]);
    expect(parsed.value.frontMatter.recurrence).toEqual([]);
    expect(parsed.value.body).toBe('Reusable instructions');
    const actions = new Map([['template', parsed.value]]);
    expect(recurrenceIssues(actions)).toEqual([]);
    expect(planningActions(actions, { now: new Date('2026-10-09T12:00Z') })).toEqual({ nodes: [], next: null, issues: [] });
  });

  it('retains saved occurrences and inherited projects when the last schedule is removed', () => {
    dir = mkdtempSync('/private/tmp/aside-dormant-'); init(dir, { name: 'Dormant', description: 'Fixture' }); store = new Store(dir);
    const created = handleCapture(store, {
      content: 'Plan routine', description: 'Plan routine',
      projects: [{ name: 'Health', description: 'Health' }],
      actions: [{ name: 'Routine', description: 'Routine', recurrence: [{ dtstart: '2099-01-01', rrule: 'FREQ=DAILY;COUNT=2' }] }],
    });
    const template = created.createdActionIds[0], project = created.createdProjectIds[0];
    const saved = handleUpdateOccurrence(store, { template, original: '2099-01-01', scheduled: '2099-02-01' }).id;
    const occurrence = structuredClone(store.getAction(saved)!);
    const action = store.getAction(template)!;
    store.saveAction(template, { ...action.frontMatter, recurrence: [] }, action.body, store.getActionFile(template)!);
    expect(readFileSync(store.getActionFile(template)!, 'utf8')).toContain('recurrence: []');
    store.close(); store = new Store(dir);
    expect(store.getIssues()).toEqual([]);
    expect(store.getAction(template)!.frontMatter.recurrence).toEqual([]);
    expect(store.getAction(saved)).toEqual(occurrence);
    expect(store.getProjectsForAction(saved)).toContain(project);
    const planning = planningActions(store.getActions(), { now: new Date('2026-10-09T12:00Z') });
    expect(planning.nodes.map(row => [row.id, row.projected])).toEqual([[saved, false]]);
    expect(planning.issues).toEqual([]);
    const withoutTemplate = new Map(store.getActions()); withoutTemplate.delete(template);
    expect(recurrenceIssues(withoutTemplate)).toEqual([`${saved}: missing recurrence template ${template}.`]);
    expect(() => store!.saveAction(template, { ...action.frontMatter, recurrence: [], scheduled: '2099-01-01' }, action.body, store!.getActionFile(template)!)).toThrow('template cannot also be scheduled');
  });
});
