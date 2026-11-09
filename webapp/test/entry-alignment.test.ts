// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderEntry, type RenderOptions } from '../src/render';

const options: RenderOptions = {
  timeFormat: '24h', now: '2026-10-18T09:00', nowDate: new Date('2026-10-18T09:00'),
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, id) => id, refMarks: () => [], routeHref: route => route,
  onTagClick: () => {}, onAssetClick: () => {}, onEntryTimeClick: () => {},
};
function entry(content: string, projects: string[] = []) {
  return renderEntry({ meta: { created: options.now, projects }, weekFile: '2026-10-12', content }, options, document.createElement('main'));
}

describe('entry timestamp alignment mode', () => {
  it('protects metadata only when a wide block begins an untagged entry', () => {
    // Happy DOM drops a first top-level table during DOMPurify's import.
    // An intentionally hidden rule lets the real renderer retain the table.
    const table = '---\n\n| First | Second |\n| --- | --- |\n| A | B |';
    const leading = entry(table);
    expect(leading.querySelector('table')).not.toBeNull();
    expect(leading.classList.contains('entry-wide-start')).toBe(true);
    expect(entry(table, ['project']).classList.contains('entry-wide-start')).toBe(false);
    expect(entry(`A paragraph.\n\n${table}`).classList.contains('entry-wide-start')).toBe(false);
  });
});
