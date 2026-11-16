// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { addLatchMarker, mountLatch, resetLatchMarkers, suppressLatch, updateLatch, updateLatchNow } from '../src/latch';

afterEach(() => { suppressLatch(false); resetLatchMarkers(); document.body.replaceChildren(); });

function flowAtBaseline(offset: number) {
  document.body.innerHTML = '<div id="flow-scroll"><div id="flow"></div></div>';
  const flow = document.getElementById('flow')!;
  mountLatch(flow, () => ({ timeFormat: '24h' }));
  // The stylesheet supplies this durable, font-derived metadata position.
  flow.querySelector<HTMLElement>('.latch-date-row')!.style.paddingTop = '12.5px';
  const marker = document.createElement('div'); marker.dataset.date = '2026-10-18';
  flow.append(marker);
  flow.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  marker.getBoundingClientRect = () => ({ top: offset } as DOMRect);
  addLatchMarker(marker);
  return {
    pad: () => flow.querySelector<HTMLElement>('.latch-date-row')!.style.paddingTop,
    move(next: number) { offset = next; },
  };
}

describe('date readout baseline', () => {
  it('retains its configured position across changed markers and rebuilt flows', () => {
    resetLatchMarkers();
    const pills = flowAtBaseline(12.5);
    updateLatchNow(); expect(pills.pad()).toBe('12.5px');
    resetLatchMarkers();
    const heading = flowAtBaseline(30);
    updateLatchNow(); expect(heading.pad()).toBe('12.5px');
  });

  it('keeps its offset pinned while scrolling the same flow', () => {
    resetLatchMarkers();
    const view = flowAtBaseline(16);
    updateLatchNow();
    view.move(-100); updateLatchNow();
    expect(view.pad()).toBe('12.5px');
  });

  it('holds the date during entrance animation without changing its position', () => {
    resetLatchMarkers();
    const view = flowAtBaseline(53);
    suppressLatch(true); updateLatch();
    expect(document.getElementById('date-latch')!.hidden).toBe(true);
    view.move(13); suppressLatch(false); updateLatch();
    expect(document.getElementById('date-latch')!.hidden).toBe(false);
    expect(view.pad()).toBe('12.5px');
  });
});
