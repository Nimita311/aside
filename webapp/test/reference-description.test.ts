// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderEntry, type RenderOptions } from '../src/render';
import { actionMarks, type RefStatus } from '../src/instance';
import { refreshDisplay } from '../src/display';
import { referenceLabel } from './reference-label';
const project = '2026-10-04-project', action = '2026-10-04-action', stamp = '2026-10-04T09:00';
function options(now = '2026-10-04T09:59'): RenderOptions {
  const opts: RenderOptions = { now, nowDate: new Date(now), timeFormat: '24h', expandProjects: false, expandActions: false, activeFilter: null,
    resolveName: (type) => type === 'project' ? 'Archived program' : 'Publish website', refMarks: () => [],
    onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(), routeHref: route => '/work/' + route };
  opts.refMarks = (type) => type === 'project' ? ['ended'] : type === 'action'
    ? actionMarks({ name: 'Publish website', created: stamp, scheduled: '2026-10-04T09:30', deadline: '2026-10-04T10:00' }, opts.nowDate) : [];
  return opts;
}
function mount(opts: RenderOptions, content = `[**Earlier** note](#entry/${stamp}) #project/${project} [Authored **next step**](#action/${action})`): HTMLElement {
  const host = document.body.appendChild(document.createElement('main'));
  return renderEntry({ meta: { created: stamp, projects: [project], actions: [action] }, weekFile: '2026-09-28', content }, opts, host);
}
function description(node: HTMLElement): HTMLElement {
  const ids = node.getAttribute('aria-describedby')!.split(/\s+/);
  expect(ids).toHaveLength(1);
  const text = document.getElementById(ids[0])!;
  expect(text.hidden).toBe(true);
  return text;
}
afterEach(() => document.body.replaceChildren());
describe('reference type and lifecycle descriptions', () => {
  it('describes feed and inline states while preserving native link names and authored formatting', () => {
    const card = mount(options()); const links = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[data-ref-type]'));
    expect(links).toHaveLength(5);
    expect(links.map(referenceLabel)).toEqual(['Archived program', 'Publish website', 'Earlier note', 'Archived program', 'Authored next step']);
    expect(links.map(link => description(link).textContent)).toEqual(['Project; ended', 'Action; deadline due', 'Entry', 'Project; ended', 'Action; deadline due']);
    expect(links.every(link => !link.hasAttribute('aria-label'))).toBe(true);
    expect(new Set(links.map(link => link.getAttribute('aria-describedby'))).size).toBe(5);
    expect(links.at(-1)?.querySelector('strong')?.textContent).toBe('next step');
    expect(links.at(-1)?.getAttribute('href')).toBe(`/work/action/${action}`);
  });
  it('repaints clock-driven marks and description text without replacing label, focus or selection', () => {
    const card = mount(options()); const link = card.querySelector<HTMLAnchorElement>('a.tag-action')!, label = link.querySelector('.tag-text')!;
    const text = label.firstChild!, described = description(link), id = described.id;
    link.focus(); window.getSelection()!.setBaseAndExtent(text, 0, text, 7);
    refreshDisplay(card, options('2026-10-04T10:01'));
    expect(description(link)).toBe(described); expect(described.id).toBe(id);
    expect(described.textContent).toBe('Action; deadline overdue; schedule lapsed');
    expect(referenceLabel(link)).toBe('Publish website'); expect(document.activeElement).toBe(link);
    expect(window.getSelection()!.anchorNode).toBe(text); expect(window.getSelection()!.toString()).toBe('Publish');
    refreshDisplay(card, options('2026-10-04T10:02'));
    expect(link.querySelectorAll('.ref-description')).toHaveLength(1); expect(link.querySelectorAll('.ref-status')).toHaveLength(1);
  });
  it('keeps a folded active entity name and composed lifecycle information available on the bubble', () => {
    const opts = options(); opts.activeFilter = { type: 'action', id: action };
    const host = document.body.appendChild(document.createElement('main'));
    const card = renderEntry({ meta: { created: stamp, actions: ['2026-10-04-first', action] }, weekFile: '2026-09-28', content: '' }, opts, host);
    const bubble = card.querySelector<HTMLButtonElement>('.tag-bubble')!;
    expect(bubble.getAttribute('aria-label')).toBe('Show 1 more actions');
    expect(description(bubble).textContent).toBe('Hidden active action: Publish website. Action; deadline due');
    refreshDisplay(card, { ...options('2026-10-04T10:01'), activeFilter: opts.activeFilter });
    expect(description(bubble).textContent).toBe('Hidden active action: Publish website. Action; deadline overdue; schedule lapsed');
    expect(referenceLabel(bubble)).toBe('+1'); expect(bubble.getAttribute('aria-expanded')).toBe('false');
    bubble.click(); expect(card.querySelector('a[data-ref-id="2026-10-04-action"]')?.querySelector('.tag-text')?.textContent).toBe('Publish website');
  });
  it.each<{ marks: RefStatus[]; expected: string }>([
    { marks: ['done'], expected: 'Action; done' },
    { marks: ['cancelled'], expected: 'Action; cancelled' },
    { marks: ['overdue', 'backlog'], expected: 'Action; deadline overdue; unscheduled' },
  ])('exposes action lifecycle marks $marks', ({ marks, expected }) => {
    const opts = options(); opts.refMarks = () => [...marks]; const card = mount(opts, `#action/${action}`);
    const chip = card.querySelector<HTMLElement>('a.inline-tag-action')!;
    expect(description(chip).textContent).toBe(expected);
  });
});
