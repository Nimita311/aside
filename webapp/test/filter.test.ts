import { describe, it, expect } from 'vitest';
import { entryReferences } from '../lib/types';

// A filter includes an entry when the entity is a front-matter tag OR an
// inline body mention — the rule that keeps the entry a filter is engaged
// from in the flow (so it stays anchored and never jumps away).

const entry = (meta: { created?: string; projects?: string[]; actions?: string[] }, content = '') => ({
  meta: { created: '2026-03-20T10:00', ...meta },
  content,
});

describe('entryReferences', () => {
  it('matches a front-matter project or action tag', () => {
    expect(entryReferences(entry({ projects: ['2026-03-12-library-catalog'] }), { type: 'project', id: '2026-03-12-library-catalog' })).toBe(true);
    expect(entryReferences(entry({ actions: ['2026-03-18-check-shelf-labels'] }), { type: 'action', id: '2026-03-18-check-shelf-labels' })).toBe(true);
  });

  it('matches an inline body mention with no metadata tag', () => {
    const e = entry({}, 'Action item: #action/2026-03-18-check-shelf-labels must close before the library opens');
    expect(entryReferences(e, { type: 'action', id: '2026-03-18-check-shelf-labels' })).toBe(true);
  });

  it('matches an inline mention at the very end of the content', () => {
    const e = entry({}, 'Reading room plans for #project/2025-07-09-reading-room');
    expect(entryReferences(e, { type: 'project', id: '2025-07-09-reading-room' })).toBe(true);
  });

  it('does not match a longer id that the ref id merely prefixes', () => {
    const e = entry({}, 'see #action/2026-03-18-check-shelf-labels-v2 later');
    expect(entryReferences(e, { type: 'action', id: '2026-03-18-check-shelf-labels' })).toBe(false);
  });

  it('does not cross entity types', () => {
    const e = entry({}, 'mentions #project/2025-09-22-book-repairs inline');
    expect(entryReferences(e, { type: 'action', id: '2025-09-22-book-repairs' })).toBe(false);
  });

  it('matches an entry ref only by its own id', () => {
    expect(entryReferences(entry({ created: '2026-03-20T10:00' }), { type: 'entry', id: '2026-03-20T10:00' })).toBe(true);
    expect(entryReferences(entry({ created: '2026-03-20T10:00' }, '#entry/2026-03-19T09:00'), { type: 'entry', id: '2026-03-19T09:00' })).toBe(false);
  });
});
