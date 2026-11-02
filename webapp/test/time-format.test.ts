// @vitest-environment happy-dom
import { referenceLabel } from './reference-label';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindDisplay, refreshDisplay, setDisplayHtml } from '../src/display';
import { bindEntrySearchName } from '../src/search-label';
import { formatTime, renderEntry, renderEntryDetail, renderActionDetail, renderProjectDetail, type RenderOptions } from '../src/render';
const stamp = '2026-10-04T15:30';
function options(format: '24h' | '12h' = '24h'): RenderOptions {
  return { timeFormat: format, now: '2026-10-04T10:00', nowDate: new Date('2026-10-04T10:00'), expandProjects: false, expandActions: false, activeFilter: null,
    resolveName: (_type, id) => id.includes('T') ? `${id.slice(0, 10)} ${formatTime(id, format)}` : id, refMarks: () => [],
    onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(), routeHref: route => '/work' + route };
}
afterEach(() => document.body.replaceChildren());
describe('live time format preferences', () => {
  it('updates handles, generated entry names and reader title while preserving authored labels and IDs', () => {
    const entry = { meta: { created: stamp }, weekFile: '2026-09-28', content: `Authored 15:30. #entry/${stamp} and [**Earlier note**](#entry/${stamp}).` };
    const host = document.createElement('main'); document.body.append(host);
    const card = renderEntry(entry, options(), host), reader = renderEntryDetail(entry, options()); document.body.append(reader);
    const handle = card.querySelector<HTMLAnchorElement>('.em-time')!, bare = card.querySelector<HTMLAnchorElement>('a.inline-tag-entry')!;
    const labeled = card.querySelectorAll<HTMLAnchorElement>('a.inline-tag-entry')[1];
    const title = reader.querySelector('.entity-title-label')!;
    const body = reader.querySelector('.detail-body')!; const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!;
    const selection = window.getSelection()!; selection.setBaseAndExtent(text, 0, text, 7); handle.focus();
    const href = bare.getAttribute('href'); refreshDisplay(document.body, options('12h'));
    expect(handle.textContent).toBe('3:30 PM'); expect(referenceLabel(bare)).toBe('2026-10-04 3:30 PM'); expect(title.textContent).toBe('2026-10-04 3:30 PM');
    expect(card.querySelector('.em-time')).toBe(handle); expect(document.activeElement).toBe(handle); expect(reader.querySelector('.detail-body')).toBe(body);
    expect(selection.anchorNode).toBe(text); expect(selection.focusOffset).toBe(7);
    expect(bare.dataset.refId).toBe(stamp); expect(bare.getAttribute('href')).toBe(href);
    expect(referenceLabel(labeled)).toBe('Earlier note'); expect(labeled.querySelector('strong')).not.toBeNull(); expect(card.textContent).toContain('Authored 15:30.');
  });
  it('retains highlighted search name nodes, selection and row state when markup structure matches', () => {
    const input = document.createElement('input'); input.value = '2026'; document.body.append(input);
    const dropdown = document.createElement('div'), row = document.createElement('div'); row.dataset.key = `entry:${stamp}`; row.className = 'search-result-item active';
    const label = bindDisplay(document.createElement('div'), options(), (node, current) => setDisplayHtml(node, current.resolveName('entry', stamp).replace('2026', '<mark>2026</mark>')));
    row.append(label); dropdown.append(row); document.body.append(dropdown); input.focus();
    const mark = label.querySelector('mark')!, tail = label.lastChild!; const selection = window.getSelection()!;
    selection.setBaseAndExtent(tail, 10, tail, 6);
    refreshDisplay(document.body, options('12h'));
    expect(label.querySelector('mark')).toBe(mark); expect(label.lastChild).toBe(tail); expect(label.textContent).toBe('2026-10-04 3:30 PM');
    expect(selection.anchorNode).toBe(tail); expect(selection.anchorOffset).toBe(10); expect(selection.focusOffset).toBe(6);
    expect(document.activeElement).toBe(input); expect(input.value).toBe('2026'); expect(row.dataset.key).toBe(`entry:${stamp}`); expect(row.className).toBe('search-result-item active'); expect(dropdown.hidden).toBe(false);
  });
  it('preserves label-relative selection offsets when changing time format removes a highlighted match', () => {
    const label = bindDisplay(document.createElement('div'), options(), (node, current) => setDisplayHtml(node,
      current.resolveName('entry', stamp).replace('2026-10-04', '<mark>2026-10-04</mark>').replace('15:30', '<mark>15:30</mark>')));
    document.body.append(label); const old = label.querySelectorAll('mark')[1].firstChild!;
    const selection = window.getSelection()!; selection.setBaseAndExtent(old, 1, old, 4);
    refreshDisplay(document.body, options('12h'));
    expect(label.textContent).toBe('2026-10-04 3:30 PM'); expect(selection.toString()).toBe(':30');
    expect(selection.anchorNode).toBe(label.lastChild); expect(selection.anchorOffset).toBe(2); expect(selection.focusOffset).toBe(5);
  });
  it('shows the retained raw-ID highlight when a format change removes the generated name match', () => {
    const input = document.createElement('input'); input.value = '15:30';
    const dropdown = document.createElement('div'), row = document.createElement('div'), label = document.createElement('div');
    row.dataset.key = `entry:${stamp}`; row.className = 'search-result-item active'; row.append(label); dropdown.append(row);
    bindEntrySearchName(label, row, stamp, ['15:30'], options(), false);
    document.body.append(input, dropdown); input.focus();
    const fallback = row.querySelector<HTMLElement>('.search-result-id')!, idMark = fallback.querySelector('mark')!, idText = idMark.firstChild!;
    const rawHtml = fallback.innerHTML;
    expect(fallback.hidden).toBe(true); expect(fallback.style.display).toBe('none');
    const selection = window.getSelection()!, old = label.querySelector('mark')!.firstChild!;
    selection.setBaseAndExtent(old, 1, old, 4);
    refreshDisplay(document.body, options('12h'));
    expect(label.textContent).toBe('2026-10-04 3:30 PM'); expect(label.querySelector('mark')).toBeNull();
    expect(fallback.hidden).toBe(false); expect(fallback.style.display).toBe(''); expect(fallback.innerHTML).toBe(rawHtml);
    expect(fallback.querySelector('mark')).toBe(idMark); expect(selection.toString()).toBe(':30');
    expect(document.activeElement).toBe(input); expect(input.value).toBe('15:30'); expect(row.className).toBe('search-result-item active');
    expect(row.dataset.key).toBe(`entry:${stamp}`); expect(dropdown.hidden).toBe(false);
    selection.setBaseAndExtent(idText, 5, idText, 1);
    refreshDisplay(document.body, options());
    expect(label.querySelector('mark')?.textContent).toBe('15:30'); expect(fallback.hidden).toBe(true); expect(fallback.style.display).toBe('none');
    expect(row.querySelector('.search-result-id')).toBe(fallback); expect(idMark.firstChild).toBe(idText);
    expect(selection.anchorNode).toBe(idText); expect(selection.anchorOffset).toBe(5); expect(selection.focusNode).toBe(idText); expect(selection.focusOffset).toBe(1);
  });
  it('keeps the retained ID fallback hidden when the description or snippet already highlights the match', () => {
    const row = document.createElement('div'), label = document.createElement('div'); row.append(label);
    bindEntrySearchName(label, row, stamp, ['15:30'], options(), true); document.body.append(row);
    const fallback = row.querySelector<HTMLElement>('.search-result-id')!;
    refreshDisplay(document.body, options('12h'));
    expect(label.querySelector('mark')).toBeNull(); expect(fallback.hidden).toBe(true); expect(fallback.style.display).toBe('none');
    expect(fallback.querySelector('mark')?.textContent).toBe('15:30');
  });
  it('preserves element-based label selection through the outer display refresh', () => {
    const label = bindDisplay(document.createElement('div'), options(), (node, current) => setDisplayHtml(node,
      current.resolveName('entry', stamp).replace('2026-10-04', '<mark>2026-10-04</mark>').replace('15:30', '<mark>15:30</mark>')));
    const outside = document.createElement('p'); outside.textContent = 'Authored content'; document.body.append(label, outside);
    const selection = window.getSelection()!; selection.setBaseAndExtent(label, 3, outside.firstChild!, 4);
    refreshDisplay(document.body, options('12h'));
    expect(selection.anchorNode).toBe(label.lastChild); expect(selection.anchorOffset).toBe(6);
    expect(selection.focusNode).toBe(outside.firstChild); expect(selection.focusOffset).toBe(4);
  });
  it('clamps selection inside shortened generated markup and preserves its outside endpoint', () => {
    const label = document.createElement('div'), authored = document.createElement('p'); authored.textContent = 'Authored 15:30 stays';
    setDisplayHtml(label, '2026-10-04 <mark>3:30 PM</mark>'); document.body.append(label, authored);
    const selection = window.getSelection()!, outside = authored.firstChild!; selection.setBaseAndExtent(label.querySelector('mark')!.firstChild!, 7, outside, 4);
    setDisplayHtml(label, '2026-10-04 15:30');
    expect(selection.anchorNode).toBe(label.firstChild); expect(selection.anchorOffset).toBe(16); expect(selection.focusNode).toBe(outside); expect(selection.focusOffset).toBe(4);
    expect(authored.textContent).toBe('Authored 15:30 stays');
  });
  it('updates all open detail fields and stamped tooltips without losing folds or playing media', () => {
    const action = renderActionDetail('2026-10-04-review', { frontMatter: { name: 'Review', created: stamp, scheduled: stamp, timezone: 'UTC', duration: 'PT30M', deadline: stamp }, body: 'Unchanged prose' }, undefined, options(), []);
    const project = renderProjectDetail('2026-10-04-work', { frontMatter: { name: 'Work', created: stamp, ended: stamp }, body: '' }, undefined, options(), [], { actions: { open: [], done: [], cancelled: [] }, stats: [] });
    document.body.append(action, project);
    const field = (host: HTMLElement, name: string) => [...host.querySelectorAll('dt')].find(node => node.textContent === name)!.nextElementSibling!;
    const created = field(action, 'Created'), scheduled = field(action, 'Scheduled'), deadline = field(action, 'Deadline'), ended = field(project, 'Ended');
    const fold = project.querySelector('details')!; fold.open = true;
    const media = document.createElement('video'); media.currentTime = 42; action.append(media);
    refreshDisplay(document.body, options('12h'));
    for (const node of [created, deadline, ended]) expect(node.textContent).toContain('3:30 PM');
    expect(scheduled.textContent).toContain('3:30 PM UTC'); expect(field(action, 'Scheduled')).toBe(scheduled);
    expect([...action.querySelectorAll<HTMLElement>('.status-pill')].filter(node => node.title).every(node => node.title.includes('AM') || node.title.includes('PM'))).toBe(true);
    expect(field(action, 'ID').textContent).toBe('2026-10-04-review'); expect(fold.open).toBe(true); expect(media.currentTime).toBe(42);
    refreshDisplay(document.body, options()); expect(created.textContent).toContain('15:30'); expect(deadline.textContent).toContain('15:30');
  });
});
