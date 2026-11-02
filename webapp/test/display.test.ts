// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindDisplay, refreshDisplay, setDisplayText, cancelDisplayMotion, moveDisplayNode, preserveDisplayPosition, preserveReadingPosition, setDisplayContext } from '../src/display';
import { startDisplayClock } from '../src/clock';
import { renderActionSummary, renderInstanceSummary, type RenderOptions } from '../src/render';
import { actionMarks } from '../src/instance';
let restoreAnimate: (() => void) | undefined;
function fakeAnimations() {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  const records: { node: HTMLElement; animation: Animation; finish: () => void }[] = [];
  const animate = vi.fn(function(this: HTMLElement) {
    let finish!: () => void, reject!: (error: Error) => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const animation = { finished, cancel: vi.fn(() => reject(new Error('Animation cancelled'))) } as unknown as Animation;
    records.push({ node: this, animation, finish });
    return animation;
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  restoreAnimate = () => { if (descriptor) Object.defineProperty(HTMLElement.prototype, 'animate', descriptor); else delete (HTMLElement.prototype as { animate?: unknown }).animate; };
  return { animate, records };
}
function rect(top = 10): DOMRect { return { top, bottom: top + 20, left: 10, right: 110, width: 100, height: 20, x: 10, y: top, toJSON: () => ({}) }; }
const settleMotion = async () => { await Promise.resolve(); await Promise.resolve(); };
const opts = (now = '2026-10-04T09:59'): RenderOptions => ({ now, nowDate: new Date(now), timeFormat: '24h', expandProjects: false, expandActions: false,
  activeFilter: null, resolveName: (_type, id) => id, onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(), routeHref: route => route, refMarks: () => [] });
afterEach(() => { cancelDisplayMotion(); setDisplayContext(undefined); restoreAnimate?.(); restoreAnimate = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); document.body.replaceChildren(); });
describe('clock-driven display', () => {
  it('paints on minute boundaries and catches up once after hidden time', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T09:59:45Z'));
    let hidden = false; vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const paint = vi.fn(); const stop = startDisplayClock(paint, 60_000);
    vi.advanceTimersByTime(14_999); expect(paint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(paint).toHaveBeenCalledTimes(1);
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(360_000); expect(paint).toHaveBeenCalledTimes(1);
    hidden = false; document.dispatchEvent(new Event('visibilitychange')); expect(paint).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000); expect(paint).toHaveBeenCalledTimes(3);
    stop(); window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(60_000); expect(paint).toHaveBeenCalledTimes(3);
  });
  it('refreshes on focus and realigns after a clock change', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T23:59:59Z')); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const paint = vi.fn(); const stop = startDisplayClock(paint, 60_000);
    vi.advanceTimersByTime(1_000); expect(paint).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-05T12:00:20Z')); window.dispatchEvent(new Event('focus')); expect(paint).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(40_000); expect(paint).toHaveBeenCalledTimes(3); stop();
  });
  it('preserves the existing link, text selection, open fold and media while repainting', () => {
    const reader = document.createElement('section'); const details = document.createElement('details'); details.open = true;
    const link = document.createElement('a'); link.href = '/work/action/a';
    const label = bindDisplay(document.createElement('span'), opts(), (node, context) => setDisplayText(node, context.now));
    link.append(label); details.append(link); reader.append(details);
    const video = document.createElement('video'); video.currentTime = 17; reader.append(video); document.body.append(reader); link.focus();
    const text = label.firstChild!; const selection = window.getSelection()!; const range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 4); selection.addRange(range);
    refreshDisplay(document.body, opts('2026-10-04T10:00'));
    expect(label.textContent).toBe('2026-10-04T10:00'); expect(label.firstChild).toBe(text); expect(selection.anchorNode).toBe(text); expect(selection.anchorOffset).toBe(0); expect(selection.focusOffset).toBe(4);
    expect(document.activeElement).toBe(link); expect(details.open).toBe(true); expect(reader.querySelector('video')).toBe(video); expect(video.currentTime).toBe(17);
  });
  it('ignores unregistered authored nodes', () => {
    const literal = document.createElement('p'); literal.dataset.liveDisplay = ''; literal.textContent = 'Authored 14:30'; document.body.append(literal);
    refreshDisplay(document.body, opts()); expect(literal.textContent).toBe('Authored 14:30');
  });
});

describe('rendered time presentation', () => {
  it('uses the actual current instant for activity age in the second DST hour', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const current = opts('2026-11-01T01:30'); current.nowDate = new Date('2026-11-01T06:30:00Z');
    const panel = renderInstanceSummary({ id: 'work' }, current, { projects: [], actions: { scheduled: [], backlog: [] }, assets: [], stats: { entries: 0 }, latest: '2026-11-01T00:30' }, vi.fn());
    expect(panel.querySelector('.facts-updated')?.textContent).toBe('updated 2h ago');
  });
  it('updates due and slipped labels and reference glyphs without replacing a focused action link', () => {
    const fm = { name: 'Review', created: '2026-10-04T09:00', scheduled: '2026-10-04T09:30', duration: 'PT30M', deadline: '2026-10-04T10:00', calendar: 'Work' };
    const options = opts(); options.refMarks = () => actionMarks(fm, options.nowDate);
    const panel = renderActionSummary({ frontMatter: fm, body: '' }, undefined, options, { projects: [], assets: [], stats: { entries: 0 } }, vi.fn());
    const timeline = renderInstanceSummary({ id: 'work' }, options, { projects: [], actions: { scheduled: [{ id: 'review', scheduled: fm.scheduled }], backlog: [] }, assets: [], stats: { entries: 0 } }, vi.fn());
    document.body.append(panel, timeline);
    const link = timeline.querySelector<HTMLAnchorElement>('a.tag')!; link.focus();
    const labels = () => Array.from(panel.querySelectorAll<HTMLElement>('.status-pill')).filter(n => !n.hidden).map(n => n.textContent);
    expect(labels()).toEqual(['Due in 1m', 'Scheduled 29m ago']);
    const current = opts('2026-10-04T10:01'); current.refMarks = () => actionMarks(fm, current.nowDate);
    refreshDisplay(document.body, current);
    expect(labels()).toEqual(['Overdue 1m', 'Slipped 31m']);
    expect(document.activeElement).toBe(link); expect(link.classList.contains('tag-status-overdue')).toBe(true);
    expect(link.classList.contains('tag-status-slipped')).toBe(true); expect(link.querySelectorAll('.ref-status')).toHaveLength(1);
    refreshDisplay(document.body, current);
    expect(link.querySelectorAll('.ref-status')).toHaveLength(1);
  });
  it('moves the timeline now marker while retaining focused rows and expanded ends', () => {
    const options = opts('2026-10-04T09:59');
    const timeline = renderInstanceSummary({ id: 'work' }, options, { projects: [], actions: { scheduled: [{ id: 'first', scheduled: '2026-10-04T10:00' }, { id: 'second', scheduled: '2026-10-04T10:02' }], backlog: [] }, assets: [], stats: { entries: 0 } }, vi.fn());
    document.body.append(timeline);
    const list = timeline.querySelector<HTMLElement>('.timeline-list')!;
    const order = () => Array.from(list.children).map(row => row.classList.contains('timeline-now') ? 'now' : row.querySelector('.tag-text')?.textContent);
    const link = timeline.querySelector<HTMLAnchorElement>('a.tag')!; link.focus();
    expect(order()).toEqual(['now', 'first', 'second']);
    refreshDisplay(document.body, opts('2026-10-04T10:01'));
    expect(order()).toEqual(['first', 'now', 'second']); expect(document.activeElement).toBe(link);
    expect(link.closest('li')!.classList.contains('timeline-future')).toBe(false);
  });
  it.each([
    { dir: 'future', before: '2026-10-04T23:59', after: '2026-10-05T00:00', date: '2026-10-12', revealed: 'item-3' },
    { dir: 'past', before: '2026-10-04T00:00', after: '2026-10-03T00:00', date: '2026-10-03', revealed: 'item-0' },
  ])('hands focus from a disappearing $dir clock fold to its first revealed action', ({ dir, before, after, date, revealed }) => {
    const scheduled = Array.from({ length: 5 }, (_, i) => ({ id: `item-${i}`, scheduled: `${date}T0${i}:00` }));
    const timeline = renderInstanceSummary({ id: 'work' }, opts(before), { projects: [], actions: { scheduled, backlog: [] }, assets: [], stats: { entries: 0 } }, vi.fn());
    document.body.append(timeline);
    const more = timeline.querySelector<HTMLButtonElement>(`button[data-dir="${dir}"]`)!;
    expect(more.hidden).toBe(false); more.focus();
    refreshDisplay(timeline, opts(after));
    expect(more.hidden).toBe(true);
    expect(document.activeElement).toBe(timeline.querySelector(`a[data-ref-id="${revealed}"]`));
    expect(document.activeElement?.closest('li')?.parentElement).toBe(timeline.querySelector('.timeline-list'));
  });
  it('preserves focus outside the timeline when the clock removes an expansion control', () => {
    const timeline = renderInstanceSummary({ id: 'work' }, opts('2026-10-04T23:59'), { projects: [], actions: {
      scheduled: Array.from({ length: 5 }, (_, i) => ({ id: `item-${i}`, scheduled: `2026-10-12T0${i}:00` })), backlog: [],
    }, assets: [], stats: { entries: 0 } }, vi.fn());
    const search = document.createElement('input'); document.body.append(timeline, search); search.focus();
    refreshDisplay(timeline, opts('2026-10-05T00:00'));
    expect(timeline.querySelector<HTMLButtonElement>('button[data-dir="future"]')?.hidden).toBe(true);
    expect(document.activeElement).toBe(search);
  });
});


describe('display motion', () => {
  function label() {
    const node = bindDisplay(document.createElement('span'), opts(), (target, current) => setDisplayText(target, current.now));
    document.body.append(node);
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(rect());
    return node;
  }
  it('does not clone or animate unchanged paints or zero-duration changes', () => {
    const { animate } = fakeAnimations(); const node = label(); const clone = vi.spyOn(node, 'cloneNode');
    refreshDisplay(document.body, opts(), 200);
    expect(clone).not.toHaveBeenCalled(); expect(animate).not.toHaveBeenCalled();
    refreshDisplay(document.body, opts('2026-10-04T10:00'), 0);
    expect(node.textContent).toBe('2026-10-04T10:00'); expect(clone).not.toHaveBeenCalled(); expect(animate).not.toHaveBeenCalled();
  });
  it('updates invisible date anchors without making their outgoing text visible in a fade copy', () => {
    const { animate } = fakeAnimations(); const node = label();
    const wrapper = document.createElement('div'); wrapper.style.visibility = 'hidden';
    document.body.append(wrapper); wrapper.append(node);
    const clone = vi.spyOn(node, 'cloneNode');
    refreshDisplay(document.body, opts('2026-10-04T10:00'), 200);
    expect(node.textContent).toBe('2026-10-04T10:00');
    expect(clone).not.toHaveBeenCalled(); expect(animate).not.toHaveBeenCalled();
  });
  it('retains embedded playing media without cloning it when a reference mark changes', () => {
    const { animate } = fakeAnimations(); const node = bindDisplay(document.createElement('a'), opts(), (target, current) => target.classList.toggle('tag-status-due', current.now.includes('10:00')));
    const video = document.createElement('video'); video.autoplay = true; video.currentTime = 17; node.append(video); document.body.append(node);
    const clone = vi.spyOn(node, 'cloneNode'); refreshDisplay(document.body, opts('2026-10-04T10:00'), 200);
    expect(node.classList.contains('tag-status-due')).toBe(true); expect(node.querySelector('video')).toBe(video); expect(video.currentTime).toBe(17);
    expect(clone).not.toHaveBeenCalled(); expect(animate).not.toHaveBeenCalled();
  });
  it('keeps old visual copies inert and inaccessible, without identities, and removes them on completion', async () => {
    const { records } = fakeAnimations(); const node = label();
    node.id = 'live-label'; node.dataset.refId = 'work';
    node.innerHTML = '<b id="label-child" data-ref-type="action">old label</b>';
    refreshDisplay(document.body, opts('2026-10-04T10:00'), 200);
    expect(records).toHaveLength(2);
    const copy = records[1].node;
    expect(copy.textContent).toBe('old label'); expect(copy.inert).toBe(true); expect(copy.getAttribute('aria-hidden')).toBe('true');
    for (const element of [copy, ...copy.querySelectorAll('*')]) expect(Array.from(element.attributes).some(attr => attr.name === 'id' || attr.name.startsWith('data-'))).toBe(false);
    records.forEach(record => record.finish()); await settleMotion();
    expect(copy.isConnected).toBe(false); expect(node.isConnected).toBe(true);
  });
  it('cancels both fade halves and removes replaced or interrupted copies immediately', async () => {
    const { records } = fakeAnimations(); const node = label();
    refreshDisplay(document.body, opts('2026-10-04T10:00'), 200); const first = records[1].node;
    refreshDisplay(document.body, opts('2026-10-04T10:01'), 200); const second = records[3].node;
    expect(first.isConnected).toBe(false); expect(records[0].animation.cancel).toHaveBeenCalledOnce(); expect(records[1].animation.cancel).toHaveBeenCalledOnce();
    records[3].animation.cancel(); await settleMotion();
    expect(second.isConnected).toBe(false); expect(records[2].animation.cancel).toHaveBeenCalledOnce(); expect(node.isConnected).toBe(true);
  });
  it('removes running dialog overlays and tick motion when Off or reduced motion cancels display motion', () => {
    const { records } = fakeAnimations(); const node = label(); const dialog = document.createElement('dialog'); dialog.open = true; dialog.append(node); document.body.append(dialog);
    refreshDisplay(document.body, opts('2026-10-04T10:00'), 200); const copy = records[1].node;
    expect(copy.parentElement).toBe(dialog);
    const list = document.createElement('ul'); const tick = document.createElement('li'); const row = document.createElement('li'); list.append(tick, row); document.body.append(list);
    vi.spyOn(tick, 'getBoundingClientRect').mockReturnValueOnce(rect(20)).mockReturnValueOnce(rect(40));
    moveDisplayNode(tick, null, list, 200); expect(records).toHaveLength(3);
    cancelDisplayMotion(); expect(copy.isConnected).toBe(false); records.forEach(record => expect(record.animation.cancel).toHaveBeenCalledOnce());
  });
  it('cancels an existing fade on a zero-duration repaint or a detached view', () => {
    const { records } = fakeAnimations(); const node = label();
    refreshDisplay(document.body, opts('2026-10-04T10:00'), 200); const first = records[1].node;
    refreshDisplay(document.body, opts('2026-10-04T10:01'), 0); expect(first.isConnected).toBe(false); expect(records).toHaveLength(2);
    refreshDisplay(document.body, opts('2026-10-04T10:02'), 200); const second = records[3].node;
    node.remove(); refreshDisplay(document.body, opts('2026-10-04T10:03'), 200); expect(second.isConnected).toBe(false);
  });
});

describe('display reveal and position', () => {
  it('repaints newly revealed folded rows with the current clock and marks', () => {
    const timeline = renderInstanceSummary({ id: 'work' }, opts(), { projects: Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, updated: i === 8 ? '2026-10-04T23:00' : '2026-10-04T09:00' })), actions: { scheduled: [], backlog: [] }, assets: [], stats: { entries: 0 } }, vi.fn());
    document.body.append(timeline);
    const current = opts('2026-10-05T09:59'); current.refMarks = () => ['ended']; setDisplayContext(() => current);
    refreshDisplay(document.body, current);
    const more = timeline.querySelector<HTMLButtonElement>('.related-more')!; more.focus(); more.click();
    const last = timeline.querySelector<HTMLAnchorElement>('a[data-ref-id="p8"]')!;
    expect(last.classList.contains('tag-status-ended')).toBe(true); expect(document.activeElement).toBe(last);
    expect(last.closest('li')!.querySelector('.row-when')?.textContent).toBe('11h');
  });
  it('preserves the visible reading anchor when presentation changes shift it', () => {
    const container = document.createElement('section'); const anchor = document.createElement('a'); container.append(anchor); document.body.append(container); container.scrollTop = 60;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ ...rect(0), height: 100, bottom: 100 });
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValueOnce(rect(20)).mockReturnValueOnce(rect(20)).mockReturnValueOnce(rect(50));
    preserveDisplayPosition([container], () => {}); expect(container.scrollTop).toBe(90);
  });
  it.each(['detail-body', 'entry-card'])('anchors visible text inside a long %s when an earlier diagram resizes', className => {
    const container = document.createElement('section');
    container.innerHTML = `<div class="date-latch">Sticky date</div><article class="${className}" data-entry-id="entry"><div class="mermaid-diagram"><details open><pre>Diagram source</pre></details></div><p>Reading below the diagram</p></article>`;
    document.body.append(container); container.scrollTop = 300;
    const body = container.querySelector('article')!, paragraph = container.querySelector('p')!;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ ...rect(0), height: 100, bottom: 100 });
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ ...rect(-300), height: 1000, bottom: 700 });
    let top = 20;
    vi.spyOn(paragraph, 'getBoundingClientRect').mockImplementation(() => rect(top));
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function(this: Range) {
      return [rect(this.startContainer.parentElement === paragraph ? top : 0)] as unknown as DOMRectList;
    });
    preserveReadingPosition([container], () => { top = 80; });
    expect(container.scrollTop).toBe(360);
  });
  it('keeps media below a resized diagram visible when there is no text anchor', () => {
    const container = document.createElement('section');
    container.innerHTML = '<article data-entry-id="entry"><div class="mermaid-diagram"></div><img alt="Example"></article>';
    document.body.append(container); container.scrollTop = 200;
    const body = container.firstElementChild!, media = container.querySelector('img')!;
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ ...rect(0), height: 100, bottom: 100 });
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ ...rect(-200), height: 1000, bottom: 800 });
    let top = 20;
    vi.spyOn(media, 'getBoundingClientRect').mockImplementation(() => rect(top));
    preserveReadingPosition([container], () => { top = 70; });
    expect(container.scrollTop).toBe(250);
  });
});
