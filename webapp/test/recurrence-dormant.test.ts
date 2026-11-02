import { expect, it, vi } from 'vitest';
import { RemoteStore, type SnapshotSource } from '../lib/remote-store';
import { instanceSummaryData, projectSummaryData } from '../src/panel-data';
import { snapshotFixture } from './snapshot-fixture';

it('keeps dormant templates out of backlog and timeline while showing their saved occurrences', async () => {
  const data = snapshotFixture(), project = data.projects[0][0], template = '2026-10-09-template';
  data.actions = [
    [template, { frontMatter: { name: 'Routine', created: '2026-10-09T09:00', recurrence: [] }, body: 'Reusable instructions' }],
    ['saved', { frontMatter: { name: 'Edited occurrence', created: '2026-10-09T10:00', scheduled: '2099-01-01', occurrence: { template, original: '2026-10-09' } }, body: '' }],
    ['ordinary', { frontMatter: { name: 'Ordinary work', created: '2026-10-09T11:00' }, body: '' }],
  ];
  data.indexes.actions = data.actions.map(([id]) => ({ id, description: id }));
  data.relations.actionsByProject = [[project, data.actions.map(([id]) => id)]];
  data.relations.projectsByAction = data.actions.map(([id]) => [id, [project]]);
  const source: SnapshotSource = { snapshot: async () => ({ value: data, version: '1' }), read: vi.fn(), revalidate: vi.fn(), assetUrl: p => p, assetVersion: vi.fn() };
  const store = new RemoteStore(source); await store.init();
  expect(await store.getPlanningActions()).toEqual({ nodes: [], next: null, issues: [] });
  for (const summary of [await instanceSummaryData(store), await projectSummaryData(project, store, await store.getRelations())]) {
    expect(summary.actions.backlog.map(row => row.id)).toEqual(['ordinary']);
    expect(summary.actions.scheduled.map(row => row.id)).toEqual(['saved']);
    expect(summary.actions.issues).toEqual([]);
    expect(summary.actions.loadMore).toBeUndefined();
    expect(summary.stats.actions).toEqual({ open: 3, total: 3 });
  }
  expect((await store.getAction(template)).frontMatter.recurrence).toEqual([]);
  expect(source.read).not.toHaveBeenCalled();
});
