// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ICON_SIZE, actionIconState, artifactIconState, dateIconState, fileIconState, iconMarkup, iconStates, locationIconState, projectIconState, setEntityIcon, type IconKind } from '../src/entity-icons';

const KINDS: IconKind[] = ['instance', 'entry', 'project', 'action', 'content', 'date', 'location'];
const parse = (markup: string) => {
  const template = document.createElement('template');
  template.innerHTML = markup;
  return template.content.firstElementChild as SVGSVGElement;
};
const shape = (svg: Element) => [svg, ...svg.querySelectorAll('*')].map(node => `${node.tagName}:${node.getAttribute('d') ?? ''}`).join('|');

describe('entity icons', () => {
  it('draws every state of a drawing with the same elements, so states morph in place', () => {
    for (const kind of KINDS) {
      for (const size of [ICON_SIZE.pill, ICON_SIZE.title]) {
        const [first, ...rest] = iconStates(kind).map(state => parse(iconMarkup(kind, state, size)));
        for (const svg of rest) expect(shape(svg), `${kind} at ${size}px`).toBe(shape(first));
      }
    }
  });

  it('swaps to the pill drawing at pill size where an icon has one, and keeps one drawing otherwise', () => {
    const pill = parse(iconMarkup('instance', 'worktree', ICON_SIZE.pill));
    const full = parse(iconMarkup('instance', 'worktree', ICON_SIZE.title));
    expect(shape(pill)).not.toBe(shape(full));
    expect(pill.getAttribute('width')).toBe('10');
    expect(shape(parse(iconMarkup('content', 'image', ICON_SIZE.pill)))).toBe(shape(parse(iconMarkup('content', 'image', ICON_SIZE.title))));
  });

  it('masks only the layers that hide, knock out or cut through something', () => {
    const page = parse(iconMarkup('content', 'pdf', ICON_SIZE.title));
    expect(page.querySelectorAll('.lay')).toHaveLength(7);
    expect(page.querySelectorAll('mask')).toHaveLength(2);
    expect(page.querySelectorAll('.lay[mask]')).toHaveLength(2);
  });

  it('falls back to the resting state and gives each icon its own masks', () => {
    const a = parse(iconMarkup('action', 'unknown', ICON_SIZE.pill));
    const b = parse(iconMarkup('action', 'done', ICON_SIZE.pill));
    expect(a.dataset.state).toBe('scheduled');
    expect(a.querySelector('mask')!.id).not.toBe(b.querySelector('mask')!.id);
    expect(b.classList.contains('filled')).toBe(true);
  });

  it('morphs an existing icon by attributes alone and leaves a same-state repaint untouched', () => {
    const host = document.createElement('span');
    setEntityIcon(host, 'action', 'scheduled', ICON_SIZE.pill);
    const svg = host.querySelector('svg')!;
    const mask = svg.querySelector('mask')!.id;
    setEntityIcon(host, 'action', 'done', ICON_SIZE.pill);
    expect(host.querySelector('svg')).toBe(svg);
    expect(svg.dataset.state).toBe('done');
    expect(svg.querySelector('mask')!.id).toBe(mask);
    const markup = host.innerHTML;
    setEntityIcon(host, 'action', 'done', ICON_SIZE.pill);
    expect(host.innerHTML).toBe(markup);
    setEntityIcon(host, 'action', 'done', ICON_SIZE.title);
    expect(host.querySelectorAll('svg')).toHaveLength(1);
    expect(host.querySelector('svg')).not.toBe(svg);
  });

  it('reads the lifecycle from chip marks', () => {
    expect(actionIconState(['overdue', 'slipped'])).toBe('slipped');
    expect(actionIconState(['due', 'backlog'])).toBe('backlog');
    expect(actionIconState(['due'])).toBe('scheduled');
    expect(actionIconState(['recurring'])).toBe('recurring');
    expect(actionIconState(['cancelled'])).toBe('cancelled');
    expect(projectIconState(['ended'])).toBe('ended');
    expect(projectIconState([])).toBe('live');
  });

  it('keys pages by how the reader renders them', () => {
    expect(fileIconState('notes.md')).toBe('text');
    expect(fileIconState('notes')).toBe('text');
    expect(fileIconState('readme.txt')).toBe('text');
    expect(fileIconState('brief.pdf')).toBe('pdf');
    expect(fileIconState('aurora.svg')).toBe('image');
    expect(fileIconState('index.html')).toBe('webpage');
    expect(fileIconState('chime.wav')).toBe('audio');
    expect(fileIconState('orbit.mp4')).toBe('video');
    expect(fileIconState('archive.zip')).toBe('file');
    const artifact = (body: string, attachments?: string[]) => ({ frontMatter: { name: 'a', created: '2026-10-01T09:00', attachments }, body });
    expect(artifactIconState(artifact('# Notes'))).toBe('text');
    expect(artifactIconState(artifact('', ['brief.pdf']))).toBe('pdf');
    expect(artifactIconState(artifact('', ['a.png', 'b.png']))).toBe('collection');
    expect(artifactIconState(artifact('# Notes', ['a.png', 'b.png']))).toBe('text');
    expect(artifactIconState(undefined, 'orbit.mp4')).toBe('video');
  });

  it('keys smart elements by their value: a date by day, range or clock time, a location by saved coordinates', () => {
    expect(dateIconState({ start: '2026-10-15' })).toBe('day');
    expect(dateIconState({ start: '2026-10-15', end: '2026-10-18' })).toBe('range');
    expect(dateIconState({ start: '2026-10-15T09:30' })).toBe('time');
    expect(dateIconState({ start: '2026-10-15T09:30[Asia/Tokyo]' })).toBe('time');
    expect(dateIconState({ start: '2026-10-15T09:30', end: '2026-10-15T10:30' })).toBe('time');
    expect(locationIconState({ geo: { latitude: 51.5034, longitude: -0.1276 } })).toBe('geo');
    expect(locationIconState({ geo: { latitude: 51.5034, longitude: -0.1276 }, postal: ['London'] })).toBe('geo');
    expect(locationIconState({ postal: ['London'] })).toBe('postal');
    // A postal pin pends: its edge dashes and its point is gone.
    const style = (state: string, selector: string) =>
      parse(iconMarkup('location', state, ICON_SIZE.pill)).querySelector(`.lay ${selector}`)!.getAttribute('style') ?? '';
    expect(style('geo', '.body')).toContain('stroke-dasharray:60 0');
    expect(style('postal', '.body')).not.toContain('stroke-dasharray:60 0');
    expect(style('geo', '.m')).toContain('--icon-on:1');
    expect(style('postal', '.m')).not.toContain('--icon-on');
  });
});
