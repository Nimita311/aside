// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { renderContextContent } from '../src/context-render';
import { renderContextEssentials } from '../src/context-essentials';
import { renderArtifactDetail, renderAssetDetail, renderEntryDetail, type RenderOptions } from '../src/render';
import type { Artifact } from '../lib/types';

const options: RenderOptions = {
  now: '2026-10-18T10:00', nowDate: new Date('2026-10-18T10:00'), timeFormat: '24h',
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, id) => id, refMarks: () => [], routeHref: route => `/work/${route}`,
  onTagClick() {}, onAssetClick() {}, onEntryTimeClick() {},
};

afterEach(() => document.body.replaceChildren());

describe('context summary boundaries', () => {
  it.each([
    ['image', 'poster.png', 'img'],
    ['audio', 'recording.mp3', 'audio'],
    ['video', 'demo.mp4', 'video'],
    ['pdf', 'brief.pdf', 'iframe'],
  ] as const)('keeps %s previews in expanded content with their identity outside it', (kind, filename, selector) => {
    const detail = renderAssetDetail(`assets/${filename}`, { kind, url: `data:application/octet-stream,preview` }, options, []);
    const preview = detail.querySelector(selector)!;
    const root = renderContextContent(detail);
    expect(root.querySelector('[data-context-detail]')?.contains(preview)).toBe(true);
    expect(root.querySelectorAll(selector)).toHaveLength(1);
    expect(root.querySelector('.entity-title')?.closest('[data-context-detail]')).toBeNull();
    expect(root.querySelector('.asset-path')?.closest('[data-context-detail]')).toBeNull();
  });

  it('keeps an entry’s body in expanded content and its references in the summary', () => {
    const root = renderContextContent(renderEntryDetail({
      meta: { created: '2026-10-18T09:00', projects: ['2026-10-12-launch'] },
      content: 'The **complete** note.', weekFile: '2026-10-12',
    }, options, { projects: ['2026-10-12-launch'], actions: [], assets: [] }));
    expect(root.querySelector('[data-context-detail] strong')?.textContent).toBe('complete');
    expect(root.querySelector('.entity-related')?.closest('[data-context-detail]')).toBeNull();
    expect(root.querySelector('.context-timeline-toggle, #btn-context-timeline')).toBeNull();
  });

  it('refreshes surrounding HTML metadata without disconnecting its retained iframe or ancestors', () => {
    const artifact: Artifact = { frontMatter: { name: 'Dashboard', created: '2026-10-12', attachments: ['index.html'] }, body: '' };
    const render = (name: string, description: string) => renderArtifactDetail('2026-10-12-dashboard',
      { ...artifact, frontMatter: { ...artifact.frontMatter, name } }, description, options,
      { projects: [], actions: [], backlinks: [] }, { kind: 'webpage', text: '<h1>Dashboard</h1>' });
    const essentials = (name: string, description: string) => renderContextEssentials({
      kind: 'artifact', name, description, counts: { attachments: 1 },
    }, options);
    const root = renderContextContent(render('Dashboard', 'Original facts.'), undefined, undefined,
      essentials('Dashboard', 'Original facts.'));
    document.body.append(root);
    const frame = root.querySelector('iframe')!, record = frame.parentElement!;
    frame.dataset.localFilter = 'Done';
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true, subtree: true });

    const updated = renderContextContent(render('Renamed dashboard', 'Fresh facts.'), undefined, root,
      essentials('Renamed dashboard', 'Fresh facts.'));
    const removed = observer.takeRecords().flatMap(mutation => Array.from(mutation.removedNodes));
    observer.disconnect();
    expect(updated).toBe(root);
    expect(updated.querySelector('iframe')).toBe(frame);
    expect(updated.querySelector('[data-context-detail]')).toBe(record);
    expect(frame.dataset.localFilter).toBe('Done');
    expect(updated.querySelector('.entity-title')?.textContent).toBe('Renamed dashboard');
    expect(updated.querySelector('.summary-description')?.textContent).toBe('Fresh facts.');
    expect(removed.some(node => node === frame || node.contains(frame))).toBe(false);
  });

  it('keeps attachment identity in Essentials and moves handles and parent navigation into detailed context', () => {
    const artifact: Artifact = { frontMatter: { name: 'Launch brief', created: '2026-10-12', attachments: ['review.md'] }, body: '' };
    const page = renderArtifactDetail('2026-10-12-brief', artifact, 'The parent description.', options,
      { projects: [], actions: [], backlinks: [] }, { kind: 'markdown', text: 'The **review**.' }, 'review.md');
    const header = renderContextEssentials({ kind: 'attachment', name: 'review.md' }, options);
    const root = renderContextContent(page, undefined, undefined, header);

    expect(root.firstElementChild).toBe(header);
    expect(root.querySelectorAll('.entity-title')).toHaveLength(1);
    expect(header.querySelector('.summary-facts')).toBeNull();
    expect(header.querySelector('.artifact-parent, .asset-path')).toBeNull();
    expect(root.querySelector('[data-context-detail] .artifact-parent')?.textContent).toContain('Launch brief');
    expect(root.querySelector('[data-context-detail] .asset-path')?.textContent).toBe('#artifact/2026-10-12-brief/review.md');
    expect(root.querySelector('[data-context-detail] .detail-body strong')?.textContent).toBe('review');
  });

  it('shows a file path once as plain Essentials text without adding reference counts', () => {
    const path = 'assets/review-notes.md';
    const page = renderAssetDetail(path, { kind: 'text', text: 'Review notes.' }, options,
      [{ id: '2026-10-18T09:00' }]);
    const header = renderContextEssentials({ kind: 'file', name: 'review-notes.md', path }, options);
    const root = renderContextContent(page, undefined, undefined, header);

    expect(root.firstElementChild).toBe(header);
    expect(root.querySelectorAll('.asset-path')).toHaveLength(1);
    expect(header.textContent).toContain(path);
    expect(header.querySelector('a, .summary-facts')).toBeNull();
    expect(root.querySelector('.entity-related')?.textContent).toContain('Linked from');
    expect(root.querySelector('[data-context-detail] .detail-body')?.textContent).toBe('Review notes.');
  });
});
