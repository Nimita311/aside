// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderEntry, renderEntryDetail, type RenderOptions } from '../src/render';
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
    expect(link.querySelectorAll('.ref-description')).toHaveLength(1); expect(link.querySelectorAll('svg.entity-icon')).toHaveLength(1);
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

describe('reference forms', () => {
  it('keeps authored entity, artifact and file labels intact inside the shared inline form', () => {
    const opts = options();
    const artifact = '2026-10-04-checklist';
    const openArtifact = vi.fn();
    opts.resolveArtifactName = () => 'Checklist';
    opts.artifactHref = id => `/work/artifact/${id}`;
    opts.onArtifactClick = openArtifact;
    const card = mount(opts, `[**Program**](#project/${project}) [*Document*](#artifact/${artifact}) #artifact/${artifact} [**Notes**](../../assets/notes.md) #date/2026-10-04 #location/?postal=Office/`);
    const prose = card.querySelector('.rendered-content')!;
    expect(prose.querySelector('.tag')).toBeNull();
    expect(card.querySelectorAll('.entry-tag-row .tag')).toHaveLength(2);
    const program = prose.querySelector<HTMLAnchorElement>('.inline-tag-project')!;
    const document = prose.querySelector<HTMLAnchorElement>('.inline-tag-artifact')!;
    const file = prose.querySelector<HTMLAnchorElement>('.inline-tag-asset')!;
    for (const link of [program, document, file]) {
      expect(link.querySelectorAll(':scope > svg.entity-icon')).toHaveLength(1);
      expect(link.querySelector(':scope > .tag-text')).not.toBeNull();
    }
    expect(program.querySelector('.tag-text strong')?.textContent).toBe('Program');
    expect(document.querySelector('.tag-text em')?.textContent).toBe('Document');
    expect(file.querySelector('.tag-text strong')?.textContent).toBe('Notes');
    expect(Array.from(prose.querySelectorAll<HTMLAnchorElement>('.inline-tag-artifact'), link => link.dataset.refHover)).toEqual([
      `artifact:#artifact/${artifact}`, `artifact:#artifact/${artifact}`,
    ]);
    expect(file.dataset.refHover).toBe('asset:assets/notes.md');
    expect(prose.querySelector<HTMLElement>('.inline-tag-date')?.dataset.refHover).toBe('date:#date/2026-10-04');
    const postal = prose.querySelector<HTMLElement>('.inline-tag-location')!;
    expect(postal.tagName).toBe('SPAN');
    expect(postal.hasAttribute('href')).toBe(false);
    expect(postal.dataset.refHover).toBeUndefined();
    expect(postal.querySelector<HTMLElement>('.ref-explanation')?.hidden).toBe(false);
    expect(postal.querySelector('.ref-explanation')?.textContent).toContain('Coordinates unavailable');
    document.click();
    expect(openArtifact).toHaveBeenCalledWith(artifact, undefined);
    file.click();
    expect(opts.onAssetClick).toHaveBeenCalledWith('assets/notes.md');
  });

  it('keeps row destinations, selection, labels and clock-driven descriptions stable', () => {
    const opts = options();
    opts.activeFilter = { type: 'action', id: action };
    const clicked = vi.fn();
    opts.onTagClick = clicked;
    const view = renderEntryDetail({ meta: { created: stamp }, content: '', weekFile: '2026-09-28' }, opts, {
      projects: [project], actions: [action], assets: [{ path: 'assets/notes.md', title: 'Notes' }],
    });
    document.body.append(view);
    expect(view.querySelector('.tag')).toBeNull();
    expect(view.querySelectorAll('a.ref-row')).toHaveLength(3);
    const row = view.querySelector<HTMLAnchorElement>('.ref-row-action')!;
    const label = row.querySelector('.tag-text')!, text = label.firstChild!;
    const described = description(row);
    expect(row.classList.contains('is-active')).toBe(true);
    expect(row.getAttribute('href')).toBe(`/work/action/${action}`);
    row.focus();
    window.getSelection()!.setBaseAndExtent(text, 0, text, 7);
    refreshDisplay(view, { ...options('2026-10-04T10:01'), activeFilter: opts.activeFilter });
    expect(description(row)).toBe(described);
    expect(described.textContent).toBe('Action; deadline overdue; schedule lapsed');
    expect(row.querySelector('.tag-text')).toBe(label);
    expect(window.getSelection()!.anchorNode).toBe(text);
    expect(document.activeElement).toBe(row);
    expect(row.querySelector<SVGElement>('svg')?.dataset.state).toBe('slipped');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    expect(clicked).not.toHaveBeenCalled();
    row.click();
    expect(clicked).toHaveBeenCalledWith({ type: 'action', id: action }, row);
    expect(view.querySelector<HTMLElement>('.ref-row-asset')?.dataset.refHover).toBe('asset:assets/notes.md');
  });
});
