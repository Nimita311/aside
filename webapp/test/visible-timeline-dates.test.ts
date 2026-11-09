// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleTimelineDates } from '../src/flow-navigation';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function timeline(records: [string, number, number][]) {
  const scroller = document.createElement('div'); document.body.append(scroller);
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 700, 500));
  for (const [id, top, bottom] of records) {
    const card = document.createElement('article'); card.className = 'entry-card'; card.dataset.entryId = id;
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 700, bottom - top));
    scroller.append(card);
  }
  return scroller;
}

describe('visible timeline calendar dates', () => {
  it.each([false, true])('marks only intersecting entries independently of ascending order (%s)', ascending => {
    const dates = ['2026-10-20T09:00', '2026-10-19T09:00', '2026-10-18T09:00', '2026-10-17T09:00'];
    if (ascending) dates.reverse();
    const scroller = timeline(dates.map((id, i) => [id, i * 200 - 100, i * 200 + 100]));
    expect(visibleTimelineDates(scroller)).toEqual(ascending ? { start: '2026-10-18', end: '2026-10-20' } : { start: '2026-10-17', end: '2026-10-19' });
  });

  it('includes partially visible long entries and excludes offscreen loaded pages and ghosts', () => {
    const scroller = timeline([['2026-11-02T09:00', -900, 150], ['2026-10-31T09:00', 150, 700], ['2026-10-29T09:00', 700, 900]]);
    const ghost = document.createElement('article'); ghost.className = 'entry-card flow-ghost'; ghost.dataset.entryId = '2026-01-01T09:00';
    vi.spyOn(ghost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 200, 700, 100)); scroller.append(ghost);
    expect(visibleTimelineDates(scroller)).toEqual({ start: '2026-10-31', end: '2026-11-02' });
  });

  it('does not infer a visible range from an empty or unmeasured reader', () => {
    const scroller = timeline([]); expect(visibleTimelineDates(scroller)).toBeUndefined();
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect());
    expect(visibleTimelineDates(scroller)).toBeUndefined();
  });

  it('ignores zero-height cards even when their empty rectangles interrupt physical ordering', () => {
    const scroller = timeline([
      ['2026-10-22T09:00', -200, 0],
      ['2026-10-21T09:00', 0, 0],
      ['2026-10-20T09:00', 0, 150],
      ['2026-10-19T09:00', 0, 0],
      ['2026-10-18T09:00', 150, 500],
      ['2026-10-17T09:00', 500, 500],
      ['2026-10-16T09:00', 500, 800],
      ['2026-10-15T09:00', 0, 0],
      ['2026-10-14T09:00', 800, 1000],
    ]);
    expect(visibleTimelineDates(scroller)).toEqual({ start: '2026-10-16', end: '2026-10-20' });
    for (const card of scroller.children) vi.mocked(card.getBoundingClientRect).mockReturnValue(new DOMRect());
    expect(visibleTimelineDates(scroller)).toBeUndefined();
  });

  it('bounds geometry reads to the visible cards and a logarithmic search through loaded history', () => {
    const records: [string, number, number][] = Array.from({ length: 4096 }, (_, index) => [
      // Deliberately non-chronological: geometry, not dates, locates the window.
      index % 2 ? '2026-10-21T09:00' : '2026-10-03T09:00',
      (index - 3000) * 100, (index - 3000 + 1) * 100,
    ]);
    const scroller = timeline(records);
    expect(visibleTimelineDates(scroller)).toEqual({ start: '2026-10-03', end: '2026-10-21' });
    const reads = [...scroller.children].reduce((total, card) => total + vi.mocked(card.getBoundingClientRect).mock.calls.length, 0);
    expect(reads).toBeLessThanOrEqual(20);
  });
});
