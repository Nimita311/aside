// @vitest-environment happy-dom
import { referenceLabel } from './reference-label';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderEntry, renderInstanceSummary, renderAssetDetail, type RenderOptions } from '../src/render';
import { parseRoute, readInstanceLocation, instanceUrl } from '../src/route';
import type { Entry } from '../lib/types';

const project = '2026-05-10-first';
const second = '2026-05-11-second';
const opts = (): RenderOptions => ({
  timeFormat: '24h', now: '2026-10-04T09:00', nowDate: new Date('2026-10-04T09:00'), expandProjects: false, expandActions: false,
  activeFilter: null, resolveName: (_type, id) => id, onTagClick: vi.fn(), onAssetClick: vi.fn(),
  onEntryTimeClick: vi.fn(), routeHref: route => instanceUrl('work', route), refMarks: () => [],
});
const entry: Entry = {
  meta: { created: '2026-05-22T15:30', projects: [project, second] },
  weekFile: '2026-05-18',
  content: `See #project/${second} and [notes](../../assets/notes.md).`,
};

afterEach(() => document.body.replaceChildren());

function mountEntry(options: RenderOptions): HTMLElement {
  const host = document.createElement('main');
  document.body.append(host);
  return renderEntry(entry, options, host);
}

// Capture whether the app intercepted before the test prevents the browser's
// navigation. This exercises rendered listeners without leaving the fixture.
function activate(anchor: HTMLAnchorElement, modifiers: MouseEventInit = {}): boolean {
  let intercepted = false;
  anchor.addEventListener('click', e => { intercepted = e.defaultPrevented; e.preventDefault(); }, { once: true });
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...modifiers }));
  return intercepted;
}

describe('native navigation controls', () => {
  it('preserves complete entry timestamps and filter context in copied and activated bare links', () => {
    const options = opts();
    options.activeFilter = { type: 'project', id: project };
    const host = document.createElement('main');
    const card = renderEntry({ ...entry, content: 'See #entry/2026-05-22T15:30. Legacy #entry/2026-05-22T15:30:22.' }, options, host);
    const link = card.querySelector<HTMLAnchorElement>('a.inline-tag-entry')!;
    expect(link.dataset.refId).toBe('2026-05-22T15:30');
    expect(card.querySelectorAll<HTMLAnchorElement>('a.inline-tag-entry')[1].getAttribute('href')).toBe(`/work/project/${project}/2026-05-22T15:30:22`);
    const location = readInstanceLocation(link.getAttribute('href')!);
    expect(location.instanceId).toBe('work');
    expect(parseRoute(location.route)).toEqual({ filter: options.activeFilter, doc: null, jump: '2026-05-22T15:30' });
    expect(activate(link, { metaKey: true })).toBe(false);
    expect(activate(link)).toBe(true);
    expect(options.onTagClick).toHaveBeenCalledWith({ type: 'entry', id: '2026-05-22T15:30' }, link);
  });

  it('keeps incomplete, invalid, extended, escaped and code entry handles literal', () => {
    const content = [
      '#entry/2026-05-22T15', '#entry/2026-05-22T15:3', '#entry/2026-05-22T15:300',
      '#entry/2026-05-22T15:30:99', '#entry/2026-05-22T25:30', '#entry/2026-02-30T15:30',
      '#entry/2026-05-22T15:30Z', '#entry/2026-05-22T15:30/extra',
      'word#entry/2026-05-22T15:30', '\\#entry/2026-05-22T15:30',
      '`#entry/2026-05-22T15:30`', '```\n#entry/2026-05-22T15:30\n```',
    ].join('\n\n');
    const host = document.createElement('main');
    const card = renderEntry({ ...entry, content }, opts(), host);
    expect(card.querySelectorAll('a.inline-tag-entry')).toHaveLength(0);
    expect(card.textContent).toContain('#entry/2026-05-22T15:30:99');
    const names = renderEntry({ ...entry, content: '#project/2026-05-22-café_项目 and #action/2026-05-22-งาน' }, opts(), host);
    expect(Array.from(names.querySelectorAll<HTMLElement>('a.inline-tag')).map(el => el.dataset.refId)).toEqual(['2026-05-22-café_项目', '2026-05-22-งาน']);
  });

  it('keeps Markdown labels and native behavior for complete entity destinations', () => {
    const options = opts();
    options.activeFilter = { type: 'project', id: project };
    const host = document.createElement('main');
    const card = renderEntry({ ...entry, content: `[**Earlier** note](#entry/2026-05-22T15:30) [Our project](#project/${second}) [Next step](#action/2026-05-22-ship)` }, options, host);
    const links = Array.from(card.querySelectorAll<HTMLAnchorElement>('a.inline-tag'));
    expect(links.map(a => referenceLabel(a))).toEqual(['Earlier note', 'Our project', 'Next step']);
    expect(links[0].querySelector('strong')?.textContent).toBe('Earlier');
    expect(links.map(a => a.getAttribute('href'))).toEqual([
      `/work/project/${project}/2026-05-22T15:30`, `/work/project/${second}`, '/work/action/2026-05-22-ship',
    ]);
    for (const link of links) {
      for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) expect(activate(link, modifiers)).toBe(false);
      expect(link.tabIndex).toBe(0);
      expect(activate(link)).toBe(true);
    }
    expect(options.onTagClick).toHaveBeenCalledTimes(3);
  });

  it('leaves malformed, escaped, code, unrelated fragments and external Markdown destinations alone', () => {
    const host = document.createElement('main');
    const content = '[Short](#entry/2026-05-22T15) [Bad date](#entry/2026-02-30T15:30) [Bad name](#project/name:part) [Section](#chapter) [External](https://example.com/#entry/2026-05-22T15:30) [Escaped](\\#project/name) `[#entry/2026-05-22T15:30](#entry/2026-05-22T15:30)`\n\n```\n[x](#project/name)\n```';
    const card = renderEntry({ ...entry, content }, opts(), host);
    expect(card.querySelectorAll('a.inline-tag')).toHaveLength(0);
    expect(Array.from(card.querySelectorAll('a')).map(a => a.getAttribute('href'))).toContain('#chapter');
    expect(card.querySelector('a[href="#project/name"]')?.textContent).toBe('Escaped');
    expect(card.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('https://example.com/#entry/2026-05-22T15:30');
  });

  it('renders feed tags and inline references as focusable links with instance URLs', () => {
    const options = opts();
    const card = mountEntry(options);
    const tag = card.querySelector<HTMLAnchorElement>('a.tag')!;
    const inline = card.querySelector<HTMLAnchorElement>('a.inline-tag')!;
    expect(tag.getAttribute('href')).toBe(`/work/project/${project}`);
    expect(inline.getAttribute('href')).toBe(`/work/project/${second}`);
    expect(tag.tabIndex).toBe(0);
    tag.focus();
    expect(document.activeElement).toBe(tag);
    expect(activate(tag)).toBe(true);
    expect(options.onTagClick).toHaveBeenCalledWith({ type: 'project', id: project }, tag);
    expect(activate(inline, { metaKey: true })).toBe(false);
    expect(options.onTagClick).toHaveBeenCalledTimes(1);
  });

  it('lets every modifier and middle-click retain native navigation for references and raw-file links', () => {
    const options = opts();
    options.activeFilter = { type: 'project', id: project };
    const card = mountEntry(options);
    const links = [card.querySelector<HTMLAnchorElement>('a.tag')!, card.querySelector<HTMLAnchorElement>('a.inline-tag')!, card.querySelector<HTMLAnchorElement>('a.asset-link')!];
    for (const link of links) {
      for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
        expect(activate(link, modifiers)).toBe(false);
      }
    }
    expect(options.onTagClick).not.toHaveBeenCalled();
    expect(options.onAssetClick).not.toHaveBeenCalled();
    const asset = links[2];
    expect(asset.getAttribute('href')).toBe(`/work/project/${project}/asset/assets/notes.md`);
    expect(activate(asset)).toBe(true);
    expect(options.onAssetClick).toHaveBeenCalledWith('assets/notes.md');
  });

  it('uses labeled buttons for tag expansion and keeps focus through both toggles', () => {
    const card = mountEntry(opts());
    let button = card.querySelector<HTMLButtonElement>('button.tag-bubble')!;
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Show 1 more projects');
    expect(document.getElementById(button.getAttribute('aria-controls')!)).toBe(button.parentElement);
    button.focus(); button.click();
    button = card.querySelector<HTMLButtonElement>('button.tag-bubble')!;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Collapse project tags');
    expect(document.activeElement).toBe(button);
    expect(card.querySelectorAll('a.tag')).toHaveLength(2);
    button.click();
    button = card.querySelector<HTMLButtonElement>('button.tag-bubble')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('gives panel titles and related assets native links, and focuses revealed rows after expansion', () => {
    const options = opts();
    const detail = vi.fn();
    const panel = renderInstanceSummary({ id: 'work', name: 'Work' }, options, {
      projects: Array.from({ length: 10 }, (_, i) => ({ id: `2026-05-10-project-${i}` })),
      actions: { scheduled: [], backlog: [] }, assets: [{ path: 'assets/report #1.md', updated: '2026-05-22T15:30' }],
      stats: { projects: { open: 10, total: 10 }, actions: { open: 0, total: 0 }, entries: 1 },
    }, detail);
    document.body.append(panel);
    const title = panel.querySelector<HTMLAnchorElement>('a.title-open')!;
    expect(title.getAttribute('href')).toBe('/work/detail');
    expect(activate(title, { ctrlKey: true })).toBe(false);
    expect(detail).not.toHaveBeenCalled();
    expect(activate(title)).toBe(true);
    expect(detail).toHaveBeenCalledTimes(1);
    const asset = panel.querySelector<HTMLAnchorElement>('a.asset-row')!;
    expect(asset.getAttribute('href')).toBe('/work/asset/assets/report%20%231.md');
    const more = panel.querySelector<HTMLButtonElement>('button.related-more')!;
    expect(more.getAttribute('aria-label')).toContain('Open projects');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.focus(); more.click();
    expect(document.activeElement?.getAttribute('href')).toBe('/work/project/2026-05-10-project-8');
  });

  it('moves keyboard focus into a revealed batch while its next expansion button remains available', () => {
    const options = opts();
    const panel = renderInstanceSummary({ id: 'work', name: 'Work' }, options, {
      projects: Array.from({ length: 35 }, (_, i) => ({ id: `2026-05-10-project-${i}` })),
      actions: { scheduled: [], backlog: [] }, assets: [],
      stats: { projects: { open: 35, total: 35 }, actions: { open: 0, total: 0 }, entries: 0 },
    }, () => {});
    document.body.append(panel);
    const more = panel.querySelector<HTMLButtonElement>('button.related-more')!;
    more.focus(); more.click();
    expect(document.activeElement?.getAttribute('href')).toBe('/work/project/2026-05-10-project-8');
    expect(panel.contains(more)).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(more.getAttribute('aria-label')).toContain('7 earlier remaining');
  });

  it('scopes relative image, audio, video, source, and poster URLs to each selected instance', () => {
    for (const instanceId of ['work', 'home']) {
      const options = opts();
      options.assetFileUrl = path => `/-/api/instances/${instanceId}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
      const mediaEntry = { ...entry, content: '![Photo](../../assets/image%20one.png)\n\n<audio src="../../assets/voice.m4a"></audio><video src="../../assets/clip.mp4" poster="../../assets/poster.png"><source src="../../assets/clip.webm"></video>' };
      const host = document.createElement('main');
      renderEntry(mediaEntry, options, host);
      expect(host.querySelector('img')?.getAttribute('src')).toBe(`/-/api/instances/${instanceId}/files/assets/image%20one.png`);
      expect(host.querySelector('audio')?.getAttribute('src')).toBe(`/-/api/instances/${instanceId}/files/assets/voice.m4a`);
      expect(host.querySelector('video')?.getAttribute('src')).toBe(`/-/api/instances/${instanceId}/files/assets/clip.mp4`);
      expect(host.querySelector('video')?.getAttribute('poster')).toBe(`/-/api/instances/${instanceId}/files/assets/poster.png`);
      expect(host.querySelector('source')?.getAttribute('src')).toBe(`/-/api/instances/${instanceId}/files/assets/clip.webm`);
    }
  });

  it('deep-links entry backlinks and gutter times from an entry detail to a valid unfiltered jump', () => {
    const options = opts();
    options.activeFilter = { type: 'entry', id: entry.meta.created };
    const card = mountEntry(options);
    expect(card.querySelector('a.em-time')?.getAttribute('href')).toBe('/work/2026-05-22T15:30');
    const reader = renderAssetDetail('assets/note.md', { kind: 'text', text: 'text' }, options, [{ id: entry.meta.created, description: 'Linked entry' }]);
    const backlink = reader.querySelector<HTMLAnchorElement>('a.tag-entry')!;
    expect(backlink.getAttribute('href')).toBe('/work/2026-05-22T15:30');
  });
});
