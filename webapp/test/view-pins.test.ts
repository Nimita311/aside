import { describe, expect, it } from 'vitest';
import { pinMatches, setViewPinned, sidebarView, toggleViewPin, viewPin } from '../src/view-pins';
import type { WebappSidebarSection } from '../../cli/src/core/types';

const instance = 'work';
const project = '#project/2026-10-04-review';
const source = '#artifact/2026-10-04-decisions/query.json';
const empty = { filter: null, doc: null } as const;

describe('explicit sidebar navigation', () => {
  it('distinguishes timeline focus from the same entity body', () => {
    expect(sidebarView({ timeline: project }, instance)).toEqual({ filter: { type: 'project', id: '2026-10-04-review' }, doc: null });
    expect(sidebarView({ entity: project }, instance)).toEqual({ filter: { type: 'project', id: '2026-10-04-review' }, doc: { kind: 'detail' } });
    expect(sidebarView({ entity: '#artifact/2026-10-04-dashboard/index.html' }, instance).doc).toEqual({ kind: 'artifact', id: '2026-10-04-dashboard', filename: 'index.html' });
  });
  it('supports smart dates, literal strings and explicit query attachments', () => {
    expect(sidebarView({ timeline: '#date/2026-10-04' }, instance)).toEqual({ ...empty, date: { start: '2026-10-04' } });
    expect(sidebarView({ timeline: '#date/2026-10-04/2026-10-09' }, instance)).toEqual({ ...empty, range: { start: '2026-10-04', end: '2026-10-09' } });
    expect(sidebarView({ timeline: 'a literal (phrase)' }, instance)).toEqual({ ...empty, search: 'a literal (phrase)' });
    expect(sidebarView({ timeline: source }, instance)).toEqual({ ...empty, source });
    expect(() => sidebarView({ timeline: '#artifact/2026-10-04-decisions' }, instance)).toThrow('attachment');
    expect(() => sidebarView({ timeline: '#artifact/2026-10-04-decisions/../file' }, instance)).toThrow();
  });

  it('treats attachment filename punctuation as content, not browsing query parameters', () => {
    for (const filename of ['questions?.md', 'brief?search=wrong.md', 'résumé #1?.html']) {
      const doc = { kind: 'artifact', id: '2026-10-04-review', filename };
      expect(sidebarView({ entity: `#artifact/2026-10-04-review/${filename}` }, instance)).toEqual({ ...empty, doc });
      expect(sidebarView(viewPin(instance, { ...empty, doc: { ...doc, kind: 'artifact' } }, 'Brief'), instance)).toEqual({ ...empty, doc });
    }
    expect(() => sidebarView({ entity: '#artifact/2026-10-04-review?search=wrong' }, instance)).toThrow('Invalid artifact id');
  });
  it('captures composed browsing state as a native navigation target without extra fields', () => {
    const view = { filter: { type: 'project' as const, id: '2026-10-04-review' }, doc: null, source, search: 'calmer', order: 'CREATED_ASC' as const };
    const pin = viewPin(instance, view, 'Calmer review');
    expect(Object.keys(pin)).toEqual(['label', 'timeline']);
    expect(sidebarView(pin, instance)).toEqual(view);
    const changed = { ...view, search: 'another phrase' };
    expect(pinMatches(pin, instance, changed)).toBe(false);
    expect(sidebarView(pin, instance).search).toBe('calmer');
    for (const search of ['#project/2026-10-04-review', '#date/2026-10-04', source, '#future', 'aside://work/']) {
      const literal = { ...empty, search };
      expect(sidebarView(viewPin(instance, literal, search), instance)).toEqual(literal);
    }
  });
  it('preserves agent sections and appends/removes pins from the same declaration', () => {
    const sections: WebappSidebarSection[] = [{ title: 'Focus', items: [{ label: 'Decisions', timeline: source }] }];
    const pin = { ...empty, search: 'calmer' };
    const added = toggleViewPin(sections, instance, pin, 'Calmer');
    expect(added).toEqual([...sections, { items: [{ label: 'Calmer', timeline: 'calmer' }] }]);
    expect(sections).toHaveLength(1);
    expect(toggleViewPin(added, instance, pin, 'Ignored rename')).toEqual(sections);
    expect(toggleViewPin(sections, instance, { ...empty, source }, '')).toEqual([{ title: 'Focus', items: [] }]);
  });
  it('reapplies Pin and Unpin intentions idempotently after concurrent changes', () => {
    const view = { ...empty, search: 'calmer' };
    const pinned = setViewPinned([], instance, view, 'Calmer', true);
    expect(setViewPinned(pinned, instance, view, 'Do not rename', true)).toEqual(pinned);
    const unpinned = setViewPinned(pinned, instance, view, 'Calmer', false);
    expect(unpinned).toEqual([]);
    expect(setViewPinned(unpinned, instance, view, 'Calmer', false)).toEqual([]);
  });
  it('restores projected action bodies and filters using their existing native routes', () => {
    const filter = { type: 'action' as const, id: '~2026-10-04-check-in@2026-10-30T09%3A00%3A00Z' };
    for (const doc of [null, { kind: 'detail' as const }]) {
      const view = { filter, doc };
      const pin = viewPin(instance, view, 'Morning check-in');
      expect(pin.timeline ?? pin.entity).toMatch(/^aside:\/\/work\/action\//);
      expect(sidebarView(pin, instance)).toEqual(view);
      expect(pinMatches(pin, instance, view)).toBe(true);
      expect(setViewPinned([{ items: [pin] }], instance, view, '', false)).toEqual([]);
    }
  });
  it('matches entity pins independently of the flow to return to', () => {
    const item = { entity: project };
    expect(pinMatches(item, instance, { ...sidebarView(item, instance), source, search: 'calmer' })).toBe(true);
    const artifact = { entity: '#artifact/2026-10-04-review/brief.md' };
    const context = { ...sidebarView(artifact, instance), filter: { type: 'project' as const, id: '2026-10-04-review' }, source };
    expect(pinMatches(artifact, instance, context)).toBe(true);
    expect(pinMatches(viewPin(instance, { ...context, doc: { kind: 'asset', path: 'assets/brief.md' } }, 'Brief'), instance, { ...context, doc: { kind: 'asset', path: 'assets/brief.md' } })).toBe(true);
    const native = { entity: `aside://work/project/2026-10-04-review/detail?search=calmer` };
    expect(pinMatches(native, instance, { ...sidebarView(native, instance), search: 'changed' })).toBe(true);
  });
  it('rejects cross-instance, external and malformed native targets', () => {
    expect(() => sidebarView({ timeline: 'aside://personal/' }, instance)).toThrow('another instance');
    expect(() => sidebarView({ entity: 'https://example.com/' }, instance)).toThrow();
    expect(() => sidebarView({ timeline: 'aside://work/?token=secret' }, instance)).toThrow();
    expect(() => sidebarView({ timeline: 'aside://work/detail' }, instance)).toThrow('flow');
    expect(() => sidebarView({ entity: 'aside://work/?search=calmer' }, instance)).toThrow('content');
  });
});
