import { describe, expect, it } from 'vitest';
import { parseRoute, readInstanceLocation } from '../../src/route';
import { FIXTURE_NAMES } from '../fixture-store';
import { scenarios, scenarioById } from '../scenarios';

describe('gallery scenario catalogue', () => {
  it('names every real page, overlay, reader, and operational state', () => {
    expect(new Set(scenarios.map(item => item.id)).size).toBe(scenarios.length);
    for (const id of [
      'elements',
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
    expect(state('date-range').date).toBeDefined();
    for (const id of ['image', 'pdf', 'audio', 'video', 'plain-text', 'binary']) {
      expect(state(id).doc).toMatchObject({ kind: 'artifact', filename: expect.any(String) });
    }
  });
});
