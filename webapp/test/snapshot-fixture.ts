import type { DataSnapshot } from '../../cli/src/core/data-snapshot';

export function snapshotFixture(id = 'work', content = 'Good note body.'): DataSnapshot {
  return {
    instance: { manifest: { id, name: id }, body: '' },
    indexes: {
      notes: [{ id: '2026-10-04T10:00', description: 'Good note' }],
      projects: [{ id: '2026-10-04-program', description: 'Good project' }],
      actions: [{ id: '2026-10-04-task', description: 'Task' }], artifacts: [],
    },
    weeklyDates: ['2026-09-28'],
    weeks: [['2026-09-28', [{ meta: { created: '2026-10-04T10:00' }, content, weekFile: '2026-09-28' }]]],
    projects: [['2026-10-04-program', { frontMatter: { name: 'Good program', created: '2026-10-04T09:00' }, body: '' }]],
    actions: [['2026-10-04-task', { frontMatter: { name: 'Good task', created: '2026-10-04T09:00' }, body: '' }]], artifacts: [],
    relations: {
      entriesByEntity: [], actionsByProject: [], projectsByAction: [], relatedProjects: [], assetsByEntity: [], entriesByAsset: [],
      artifactBacklinks: [], projectsByArtifact: [], actionsByArtifact: [], artifactsByEntity: [],
    },
    weeksByEntity: [['#entry/2026-10-04T10:00', ['2026-09-28']]],
    diagnostics: [], searchProgress: { loaded: 3, total: 3, pending: 0, complete: true, failures: [] },
  };
}
