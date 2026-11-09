// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderContextContent } from '../src/context-render';
import {
  renderActionDetail, renderActionSummary, renderArtifactDetail, renderInstanceDetail, renderInstanceSummary,
  renderProjectDetail, renderProjectSummary, type RenderOptions,
} from '../src/render';
import type { Action, Artifact, Manifest, Project } from '../lib/types';

const options: RenderOptions = {
  now: '2026-10-18T10:00', nowDate: new Date('2026-10-18T10:00'), timeFormat: '24h',
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, id) => id, refMarks: () => [], routeHref: route => `/work/${route}`,
  onTagClick() {}, onAssetClick() {}, onEntryTimeClick() {},
};

afterEach(() => document.body.replaceChildren());

describe('one context document for summary and expanded modes', () => {
  it('keeps the summary and complete record free of inline panel commands', () => {
    const project: Project = { frontMatter: { name: 'Launch', created: '2026-10-12' }, body: 'The **full** plan.' };
    const open = vi.fn();
    const summary = renderProjectSummary(project, 'Ship the launch.', options, {
      actions: { backlog: [], scheduled: [] }, related: ['2026-10-01-design'], assets: [],
      stats: { entries: 3, actions: { open: 0, total: 0 }, projects: { open: 1, total: 1 } },
    }, open);
    const related = summary.querySelector('.entity-related');
    const detail = renderProjectDetail('2026-10-12-launch', project, 'Ship the launch.', options, [], {
      actions: { open: [], done: [], cancelled: [] }, stats: [['Entries', '3']],
    });
    const root = renderContextContent(summary, detail);
    document.body.append(root);

    expect(root).toBe(summary);
    expect(root.querySelectorAll('.entity-title')).toHaveLength(1);
    expect(root.querySelectorAll('.summary-description')).toHaveLength(1);
    expect(root.querySelector('.title-open')).toBeNull();
    expect(root.querySelector('.entity-related')).toBe(related);
    expect(root.querySelector('[data-context-detail] .detail-fields')?.textContent).toContain('2026-10-12-launch');
    expect(Array.from(root.querySelectorAll('.detail-fields > dt')).map(node => node.textContent)).toEqual(['ID', 'Created']);
    expect(root.querySelectorAll('.status-pills')).toHaveLength(1);
    expect(root.querySelector('[data-context-detail] .detail-body strong')?.textContent).toBe('full');
    expect(Array.from(root.querySelectorAll('.detail-section > summary')).map(node => node.textContent)).not.toContain('Stats');
    expect(root.querySelector('.context-timeline-toggle, #btn-context-timeline')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('preserves a resolved action’s summary state, relationships and complete scheduling metadata', () => {
    const action: Action = {
      frontMatter: {
        name: 'Final review', created: '2026-10-12T09:00', scheduled: '2026-10-15T10:00',
        deadline: '2026-10-16', duration: 'PT30M', calendar: 'Work', resolution: 'done',
      },
      body: 'Completed with #project/2026-10-12-launch.',
    };
    const summary = renderActionSummary(action, 'Review the launch.', options, {
      projects: ['2026-10-12-launch'], assets: [], stats: { entries: 2, projects: { open: 1, total: 1 } },
    }, vi.fn());
    const facts = summary.querySelector('.summary-facts'), related = summary.querySelector('.entity-related');
    const root = renderContextContent(summary, renderActionDetail('2026-10-12-review', action, 'Review the launch.', options, [['Entries', '2']]));

    expect(root.querySelectorAll('.entity-title')).toHaveLength(1);
    expect(root.querySelectorAll('.summary-description')).toHaveLength(1);
    expect(root.querySelectorAll('.status-pills')).toHaveLength(1);
    expect(root.querySelector('.status-pill:not([hidden])')?.textContent).toContain('Done');
    expect(root.querySelector('.summary-facts')).toBe(facts);
    expect(root.querySelector('.entity-related')).toBe(related);
    expect(Array.from(root.querySelectorAll('.detail-fields > dt')).map(node => node.textContent)).toEqual(['ID', 'Created', 'Scheduled', 'Duration', 'Calendar', 'Deadline']);
    expect(root.querySelector('[data-context-detail] .detail-body a[data-ref-type="project"]')).not.toBeNull();
  });

  it('keeps the instance’s current work and adds the full census, config and body', () => {
    const manifest: Manifest = {
      id: 'work', name: 'Work', description: 'Team workspace.', version: '1', config: { doneEventTitlePrefix: 'Done ' },
    };
    const summary = renderInstanceSummary(manifest, options, {
      projects: [{ id: '2026-10-12-launch', updated: '2026-10-18T09:00' }], actions: { backlog: [], scheduled: [] }, assets: [],
      stats: { entries: 4, projects: { open: 1, total: 2 }, actions: { open: 0, total: 1 } },
    }, vi.fn());
    const related = summary.querySelector('.entity-related');
    const root = renderContextContent(summary, renderInstanceDetail(manifest, 'Instance **instructions**.', options, {
      projects: [], actions: { open: [], done: [{ id: '2026-10-12-review', description: 'Final review' }], cancelled: [] },
      stats: [['Entries', '4']],
    }));

    expect(root.querySelectorAll('.entity-title')).toHaveLength(1);
    expect(root.querySelectorAll('.summary-description')).toHaveLength(1);
    expect(root.querySelectorAll('.summary-facts')).toHaveLength(1);
    expect(root.querySelector('.entity-related')).toBe(related);
    expect(related?.textContent).toContain('Open projects');
    expect(Array.from(root.querySelectorAll('.detail-fields > dt')).map(node => node.textContent)).toEqual(['ID', 'Version', 'config.doneEventTitlePrefix']);
    expect(root.querySelector('[data-context-detail] .detail-body strong')?.textContent).toBe('instructions');
    const headings = Array.from(root.querySelectorAll('[data-context-detail] .detail-section > summary')).map(node => node.textContent);
    expect(headings).toContain('Done actions1');
    expect(headings).not.toContain('Stats');
  });

  it('splits an artifact into summary identity/relations and its expanded body', () => {
    const artifact: Artifact = {
      frontMatter: { name: 'Launch brief', created: '2026-10-12', attachments: [] }, body: 'A **careful** launch.',
    };
    const root = renderContextContent(renderArtifactDetail('2026-10-12-brief', artifact, 'Read the brief.', options, {
      projects: ['2026-10-12-launch'], actions: [], backlinks: [],
    }));
    expect(root.querySelector('.entity-title')?.textContent).toBe('Launch brief');
    expect(root.querySelector('.summary-description')?.textContent).toBe('Read the brief.');
    expect(root.querySelector('.asset-path')?.closest('[data-context-detail]')).toBeNull();
    expect(root.querySelector('.entity-related')?.closest('[data-context-detail]')).toBeNull();
    expect(root.querySelector('[data-context-detail] .detail-body strong')?.textContent).toBe('careful');
  });

  it('retains the exact HTML iframe while bringing its metadata into the same panel', () => {
    const onWebpageReady = vi.fn();
    const artifact: Artifact = {
      frontMatter: { name: 'Release dashboard', created: '2026-10-12', attachments: ['dashboard.html'] }, body: '',
    };
    const page = renderArtifactDetail('2026-10-12-dashboard', artifact, 'Live launch status.', { ...options, onWebpageReady },
      { projects: [], actions: [], backlinks: [] }, { kind: 'webpage', text: '<h1>Dashboard</h1>' });
    const iframe = page.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const root = renderContextContent(page);
    document.body.append(root);
    expect(root.dataset.contextPresentation).toBe('html');
    expect(root.querySelector('.entity-title')?.textContent).toBe('Release dashboard');
    expect(root.querySelector('.summary-description')?.textContent).toBe('Live launch status.');
    expect(root.querySelectorAll('iframe')).toHaveLength(1);
    expect(root.querySelector('[data-context-detail] iframe')).toBe(iframe);
    expect(onWebpageReady).toHaveBeenCalledOnce();
  });
});
