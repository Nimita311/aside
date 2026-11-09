import { describe, expect, it } from 'vitest';
import { parseRoute, readInstanceLocation } from '../../src/route';
import { FIXTURE_NAMES } from '../fixture-store';
import { scenarios, scenarioById } from '../scenarios';

describe('gallery scenario catalogue', () => {
  it('names every real page, overlay, reader, and operational state', () => {
    expect(new Set(scenarios.map(item => item.id)).size).toBe(scenarios.length);
    for (const id of [
      'elements',
      'query-source', 'query-source-scoped', 'query-source-inspection', 'query-source-unavailable',
      'timeline', 'instance-summary', 'instance-detail', 'project', 'project-detail',
      'action', 'action-detail', 'entry-detail', 'entry-jump', 'date-jump', 'date-range',
      'project-date', 'search', 'search-empty', 'search-date', 'datepicker', 'datepicker-invalid',
      'settings', 'switcher', 'chooser', 'chooser-add', 'chooser-invalid', 'chooser-worktrees',
      'chooser-duplicates', 'chooser-tooltip', 'typography', 'typography-in-project', 'diagrams',
      'diagram-source', 'diagram-error', 'empty-artifact',
      'image', 'pdf', 'audio', 'video', 'markdown-attachment', 'plain-text', 'binary',
      'dashboard', 'raw-asset', 'chooser-loading', 'chooser-error', 'instance-loading',
      'instance-error', 'empty-instance', 'empty-project', 'empty-action', 'diagnostics',
      'missing-file', 'file-error', 'search-loading', 'search-incomplete', 'auth-checking',
      'auth-required', 'auth-offline', 'reconnecting', 'recurring-action',
    ]) expect(scenarioById(id), `${id} has a runnable scenario`).toBeDefined();
    expect(scenarioById('not-a-scenario')).toBeUndefined();
  });

  it('describes deterministic data and environment inputs for each preview', () => {
    for (const item of scenarios) {
      expect(item.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(item.label.trim()).not.toBe('');
      expect(item.group.trim()).not.toBe('');
      expect(item.description.trim()).not.toBe('');
      expect(FIXTURE_NAMES).toContain(item.fixture);
      expect(Number.isFinite(Date.parse(item.now))).toBe(true);
      expect(item.coverage.length).toBeGreaterThan(0);
      expect(item.ready?.trim()).not.toBe('');
      if (item.kind === 'elements') {
        expect(item.route).toBe('/__mock/elements/');
        expect(item.ready).toBe('#element-gallery[data-ready]');
      } else {
        expect(item.route).toMatch(/^\/(?:(?:showcase|empty|malformed)\/.*)?$/);
        if (item.route !== '/') expect(readInstanceLocation(item.route).instanceId).toBe(item.fixture);
      }
      for (const action of item.actions ?? []) {
        expect(action.selector.trim()).not.toBe('');
        if (['input', 'key'].includes(action.kind)) expect(typeof action.value).toBe('string');
      }
    }
  });

  it('uses production route grammar for full details, filtered readers, and file readers', () => {
    const state = (id: string) => parseRoute(readInstanceLocation(scenarioById(id)!.route).route);
    expect(state('instance-detail')).toMatchObject({ filter: null, doc: { kind: 'detail' } });
    expect(state('project-detail')).toMatchObject({ filter: { type: 'project' }, doc: { kind: 'detail' } });
    expect(state('action-detail')).toMatchObject({ filter: { type: 'action' }, doc: { kind: 'detail' } });
    expect(state('entry-detail')).toMatchObject({ filter: { type: 'entry', id: '2026-10-18T09:30' } });
    expect(state('typography-in-project')).toMatchObject({ filter: { type: 'project' }, doc: { kind: 'artifact' } });
    expect(state('raw-asset')).toMatchObject({ filter: null, doc: { kind: 'asset' } });
    const source = '#artifact/2026-10-12-recent-decisions/decisions.json';
    expect(state('query-source')).toMatchObject({ filter: null, doc: null, source });
    expect(state('query-source-scoped')).toMatchObject({ filter: { type: 'project' }, search: 'calmer', source });
    expect(state('date-range').date).toBeDefined();
    for (const id of ['image', 'pdf', 'audio', 'video', 'plain-text', 'binary']) {
      expect(state(id).doc).toMatchObject({ kind: 'artifact', filename: expect.any(String) });
    }
  });

  it('stages record and content previews in the expanded context panel', () => {
    const content = scenarios.filter(item => item.group === 'Content' ||
      ['instance-detail', 'project-detail', 'action-detail', 'entry-detail', 'diagram-error', 'missing-file', 'file-error', 'recurring-action'].includes(item.id));
    expect(content.length).toBeGreaterThan(15);
    for (const item of content) {
      expect(item.preferences?.contextPanelMode, `${item.id} reveals its record body`).toBe('expanded');
      expect(item.preferences?.contextPanelView, `${item.id} selects its content rather than Overview`).toBe('content');
      expect(item.ready, `${item.id} waits for the live context body`).toContain('#side-panel-body');
    }
    for (const item of scenarios) {
      expect(item.ready).not.toContain('#doc-body');
      for (const action of item.actions ?? []) expect(action.selector).not.toContain('#doc-body');
    }
    expect(scenarioById('instance-summary')?.preferences?.contextPanelMode).not.toBe('expanded');
    expect(scenarioById('panel-wide')?.preferences?.contextPanelMode).not.toBe('expanded');
  });
});
