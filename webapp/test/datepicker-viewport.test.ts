// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatePicker } from '../src/datepicker';

let picker: ReturnType<typeof createDatePicker> | undefined;
let chipRect: DOMRect;
let naturalHeight: number;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('innerWidth', 1024);
  vi.stubGlobal('innerHeight', 768);
  chipRect = new DOMRect(80, 60, 100, 32);
  naturalHeight = 340;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('date-latch-chip')) return chipRect;
    if (this.classList.contains('date-jump')) {
      return new DOMRect(
        parseFloat(this.style.left) || 0,
        parseFloat(this.style.top) || 0,
        Math.min(232, parseFloat(this.style.maxWidth) || Infinity),
        Math.min(naturalHeight, parseFloat(this.style.maxHeight) || Infinity),
      );
    }
    return new DOMRect();
  });
});

afterEach(() => {
  picker?.close(); picker?.close(); picker = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function open(): HTMLElement {
  const latch = document.createElement('div'); latch.id = 'date-latch'; latch.dataset.date = '2026-10-04';
  const chip = document.createElement('button'); chip.className = 'date-latch-chip'; latch.append(chip);
  document.body.append(latch);
  picker = createDatePicker({ jumpToDate: vi.fn(), jumpNear: vi.fn(async () => true) });
  picker.toggle();
  return document.querySelector<HTMLElement>('.date-jump')!;
}

function within(pop: HTMLElement, viewport: { left: number; top: number; width: number; height: number }): void {
  const rect = pop.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(viewport.left + 8);
  expect(rect.top).toBeGreaterThanOrEqual(viewport.top + 8);
  expect(rect.right).toBeLessThanOrEqual(viewport.left + viewport.width - 8);
  expect(rect.bottom).toBeLessThanOrEqual(viewport.top + viewport.height - 8);
}

describe('date picker viewport', () => {
  it('preserves alignment below the chip when it fits', () => {
    chipRect = new DOMRect(200, 60, 100, 32);
    const pop = open();
    expect(pop.style.top).toBe('96px');
    expect(pop.style.left).toBe('68px');
  });

  it('fits a 320 by 256 zoom viewport, including a trigger below its bottom edge', () => {
    vi.stubGlobal('innerWidth', 320); vi.stubGlobal('innerHeight', 256);
    chipRect = new DOMRect(500, 280, 100, 32);
    const pop = open();
    expect(pop.style.maxHeight).toBe('240px');
    within(pop, { left: 0, top: 0, width: 320, height: 256 });
  });

  it('repositions and constrains an already open picker when the viewport shrinks', () => {
    const pop = open();
    vi.stubGlobal('innerWidth', 220); vi.stubGlobal('innerHeight', 180);
    window.dispatchEvent(new Event('resize'));
    expect(pop.style.maxWidth).toBe('204px');
    expect(pop.style.maxHeight).toBe('164px');
    within(pop, { left: 0, top: 0, width: 220, height: 180 });
  });

  it('tracks the visible viewport while a keyboard or pinch zoom changes its size and offset', () => {
    const viewport = Object.assign(new EventTarget(), { width: 320, height: 256, offsetLeft: 25, offsetTop: 100 });
    vi.stubGlobal('visualViewport', viewport);
    const pop = open();
    within(pop, { left: 25, top: 100, width: 320, height: 256 });
    viewport.height = 180; viewport.dispatchEvent(new Event('resize'));
    within(pop, { left: 25, top: 100, width: 320, height: 180 });
    viewport.offsetTop = 140; viewport.dispatchEvent(new Event('scroll'));
    within(pop, { left: 25, top: 140, width: 320, height: 180 });
  });

  it('repositions after a larger calendar month or date input error increases height', () => {
    vi.stubGlobal('innerHeight', 480);
    const pop = open();
    naturalHeight = 400;
    document.querySelector<HTMLButtonElement>('.cal-nav')!.click();
    within(pop, { left: 0, top: 0, width: 1024, height: 480 });
    naturalHeight = 450;
    document.querySelector<HTMLInputElement>('.date-jump-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    within(pop, { left: 0, top: 0, width: 1024, height: 480 });
  });

  it('detaches viewport listeners on close and recreates them on the next open', () => {
    const viewport = Object.assign(new EventTarget(), { width: 320, height: 256, offsetLeft: 0, offsetTop: 0 });
    vi.stubGlobal('visualViewport', viewport);
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const removeViewport = vi.spyOn(viewport, 'removeEventListener');
    open(); picker!.close();
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeViewport).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeViewport).toHaveBeenCalledWith('scroll', expect.any(Function));
    picker!.toggle();
    viewport.height = 180; viewport.dispatchEvent(new Event('resize'));
    within(document.querySelector<HTMLElement>('.date-jump')!, { left: 0, top: 0, width: 320, height: 180 });
  });
});
