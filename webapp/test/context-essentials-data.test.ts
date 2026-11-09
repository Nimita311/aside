// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteStore, type SnapshotSource } from '../lib/remote-store';
import type { EntityRef } from '../lib/types';
import type { DocRef } from '../src/route';
import type { createContextPanel } from '../src/context-panel';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';

interface App {
  state: { store: RemoteStore | null; instanceId: string | null; filter: EntityRef | null; doc: DocRef | null };
  setupContextPanel(): void;
  inspectContext(target: { ref: EntityRef | null; doc: DocRef | null }): Promise<void>;
  clearInstanceView(): void;
  contextPanel?: ReturnType<typeof createContextPanel>;
  datePicker: { close(): void; dispose?(): void };
}

let app: App | undefined;
afterEach(() => {
  app?.datePicker.close(); app?.clearInstanceView(); app?.contextPanel?.destroy(); app?.datePicker.dispose?.(); app = undefined;
  vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear(); history.replaceState(null, '', '/');
});

async function setup() {
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  history.replaceState(null, '', '/work/');
  const data = snapshotFixture();
  const brief = '2026-10-01-brief', guide = '2026-10-02-guide', project = data.projects[0][0], action = data.actions[0][0];
  data.artifacts = [
    [brief, { frontMatter: { name: 'Launch brief', created: '2026-10-01', attachments: ['plan.md', 'budget.csv'] }, body: 'The launch plan.' }],
    [guide, { frontMatter: { name: 'Guide', created: '2026-10-02', attachments: ['guide.md'] }, body: '' }],
  ];
  data.indexes.artifacts = data.artifacts.map(([id]) => ({ id, description: id }));
  // Inferred references remain available in Overview but never inflate the
  // artifact's Essentials census or the file/attachment headers.
  data.relations.projectsByArtifact = [[brief, [project]], [guide, [project]]];
  data.relations.actionsByArtifact = [[brief, [action]]];
  data.relations.artifactBacklinks = [[brief, ['#entry/2026-10-04T10:00']]];
  data.relations.entriesByAsset = [['assets/plan.md', ['2026-10-04T10:00']]];
  data.weeks[0][1][0].meta.projects = [project, project];
  data.weeks[0][1][0].meta.actions = [action, action];
  data.weeks[0][1][0].content = 'An inline reference to #project/other is not an authored tag.';
  const source: SnapshotSource = {
    snapshot: async () => ({ value: data, version: '1' }),
    read: vi.fn(async () => ({ text: 'Supporting Markdown.', version: '1' })),
    revalidate: vi.fn(), assetUrl: () => null, assetVersion: vi.fn(),
  };
  const store = new RemoteStore(source); await store.init();
  app = await loadApp<App>('state, setupContextPanel, inspectContext, clearInstanceView, contextPanel, datePicker');
  app.state.store = store; app.state.instanceId = 'work'; app.setupContextPanel();
  return { api: app, brief, guide, project, action };
}

function counts() {
  return Array.from(document.querySelectorAll<HTMLElement>('#side-panel-body .context-essentials .summary-stat'))
    .map(node => [node.dataset.countKind, node.querySelector('.stat-count')?.textContent]);
}

describe('right panel Essentials data', () => {
  it('counts instance-owned artifacts and only an artifact’s own attachments', async () => {
    const { api, brief, guide } = await setup();
    await api.inspectContext({ ref: null, doc: null });
    expect(counts()).toEqual([['entries', '1'], ['projects', '1/1'], ['actions', '1/1'], ['artifacts', '2']]);

    await api.inspectContext({ ref: null, doc: { kind: 'artifact', id: brief } });
    expect(counts()).toEqual([['attachments', '2']]);
    expect(document.querySelector('.context-essentials')?.getAttribute('data-kind')).toBe('artifact');

    // A sole default attachment is still the artifact target, with the
    // artifact identity and its ownership count.
    await api.inspectContext({ ref: null, doc: { kind: 'artifact', id: guide } });
    expect(counts()).toEqual([['attachments', '1']]);
    expect(document.querySelector('.context-essentials .entity-title')?.textContent).toBe('Guide');
  });

  it('does not count references for a selected attachment or standalone file', async () => {
    const { api, guide } = await setup();
    await api.inspectContext({ ref: null, doc: { kind: 'artifact', id: guide, filename: 'guide.md' } });
    expect(document.querySelector('.context-essentials')?.getAttribute('data-kind')).toBe('attachment');
    expect(document.querySelector('.context-essentials .summary-facts')).toBeNull();

    await api.inspectContext({ ref: null, doc: { kind: 'asset', path: 'assets/plan.md' } });
    expect(document.querySelector('.context-essentials')?.getAttribute('data-kind')).toBe('file');
    expect(document.querySelector('.context-essentials .asset-path')?.textContent).toBe('assets/plan.md');
    expect(document.querySelector('.context-essentials .summary-facts')).toBeNull();
  });

  it('counts unique authored entry tags and leaves inline mentions out', async () => {
    const { api } = await setup();
    await api.inspectContext({ ref: { type: 'entry', id: '2026-10-04T10:00' }, doc: null });
    expect(counts()).toEqual([['projects', '1'], ['actions', '1']]);
  });
});
