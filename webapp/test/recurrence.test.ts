import { describe, expect, it, vi } from 'vitest';
import { RemoteStore, type SnapshotSource } from '../lib/remote-store';
import { snapshotFixture } from './snapshot-fixture';
import { instanceSummaryData, projectSummaryData } from '../src/panel-data';

it('pages projections without adding records or inflating counts and includes saved future exceptions', async () => {
  const data = snapshotFixture();
  const template = '2026-01-01-repeat', project = data.projects[0][0];
  data.actions = [[template, { frontMatter: { name: 'Review', created: '2026-01-01T09:00', recurrence: [{ dtstart: '2026-01-01', rrule: 'FREQ=DAILY' }] }, body: 'Instructions' }], ['saved', { frontMatter: { name: 'Moved', created: '2026-10-09T09:00', scheduled: '2099-01-01', occurrence: { template, original: '2026-10-09' } }, body: '' }]];
  data.indexes.actions = data.actions.map(([id]) => ({ id, description: id }));
  data.relations.actionsByProject = [[project, [template, 'saved']]];
  data.relations.projectsByAction = [[template, [project]], ['saved', [project]]];
  const source: SnapshotSource = { snapshot: async () => ({ value: data, version: '1' }), read: vi.fn(), revalidate: vi.fn(), assetUrl: p => p, assetVersion: vi.fn() };
  const store = new RemoteStore(source); await store.init();
  const summary = await instanceSummaryData(store);
  expect(summary.stats.actions).toEqual({ open: 2, total: 2 });
  expect(summary.actions.scheduled.some(a => a.id === 'saved')).toBe(true);
  expect(summary.actions.backlog).toEqual([]);
  expect(summary.actions.loadMore).toBeDefined();
  const next = await summary.actions.loadMore!();
  expect(next.scheduled.length).toBeGreaterThan(summary.actions.scheduled.length);
  const projection = summary.actions.scheduled.find(a => a.id.startsWith('~'))!;
  expect((await store.getAction(projection.id)).body).toBe('Instructions');
  expect(store.getActionIndex()).toHaveLength(2); expect(source.read).not.toHaveBeenCalled();
  expect((await projectSummaryData(project, store, await store.getRelations())).actions.scheduled.length).toBeGreaterThan(1);
});

it('shows upcoming work from every template before paging through long history', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
  try {
    const data = snapshotFixture();
    data.actions = [
      ['a-new', { frontMatter: { name: 'Upcoming', created: '2026-10-09T09:00', recurrence: [{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY;COUNT=3' }] }, body: '' }],
      ['z-old', { frontMatter: { name: 'Long history', created: '2000-01-01T09:00', recurrence: [{ dtstart: '2000-01-01', rrule: 'FREQ=DAILY' }] }, body: '' }],
      ['ordinary', { frontMatter: { name: 'Ordinary', created: '2026-10-09T09:00', scheduled: '2099-01-01' }, body: '' }],
    ];
    data.indexes.actions = data.actions.map(([id]) => ({ id, description: id }));
    const source: SnapshotSource = { snapshot: async () => ({ value: data, version: '1' }), read: vi.fn(), revalidate: vi.fn(), assetUrl: p => p, assetVersion: vi.fn() };
    const store = new RemoteStore(source); await store.init();
    const summary = await instanceSummaryData(store);
    expect(summary.actions.scheduled.some(a => a.id.startsWith('~a-new@'))).toBe(true);
    expect(summary.actions.scheduled.some(a => a.id === 'ordinary')).toBe(true);
    expect(summary.actions.loadMore).toBeDefined();
    const before = new Set(summary.actions.scheduled.map(a => a.id));
    const next = await summary.actions.loadMore!();
    expect(next.scheduled.length).toBeGreaterThan(before.size);
    expect(new Set(next.scheduled.map(a => a.id)).size).toBe(next.scheduled.length);
    expect(store.getActionIndex()).toHaveLength(3);
  } finally { vi.useRealTimers(); }
});
