// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatePicker } from '../src/datepicker';
import { addLatchMarker, mountLatch, resetLatchMarkers, resetReadoutPad, updateLatchNow, REDUCED_MOTION } from '../src/latch';

let picker: ReturnType<typeof createDatePicker> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T12:00:00'));
});

afterEach(() => {
  picker?.close(); picker?.close(); picker = undefined;
  resetLatchMarkers(); resetReadoutPad();
  delete document.documentElement.dataset.timelineLayout;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  const scroller = document.createElement('div'); scroller.id = 'flow-scroll';
  const flow = scroller.appendChild(document.createElement('div')); flow.id = 'flow';
  document.body.append(scroller);
  mountLatch(flow, () => picker!.toggle());
  const latch = document.getElementById('date-latch')!;
  const chip = latch.querySelector<HTMLElement>('.date-latch-chip')!;
  const marker = flow.appendChild(document.createElement('div')); marker.dataset.date = '2026-10-03';
  addLatchMarker(marker); updateLatchNow();
  picker = createDatePicker({ jumpToDate: vi.fn(), jumpNear: vi.fn(async () => true) });
  return { latch, chip, marker };
}

function day(date: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.cal-day[data-date="${date}"]`)!;
}

function typeDate(value: string): void {
  const input = document.querySelector<HTMLInputElement>('.date-jump-input')!;
  input.value = value; input.dispatchEvent(new Event('input'));
}

describe('date picker semantics', () => {
  it('includes the configured date in the launcher name and follows date changes', () => {
    const f = fixture();
    expect(f.chip.getAttribute('aria-label')).toBe('Jump to date: Oct 3, 2026');
    f.marker.dataset.date = '2026-11-15'; updateLatchNow();
    expect(f.chip.getAttribute('aria-label')).toBe('Jump to date: Nov 15, 2026');
    resetLatchMarkers(); updateLatchNow();
    expect(f.latch.hidden).toBe(true);
    expect(f.chip.getAttribute('aria-label')).toBe('Jump to date');
  });

  it('measures the readout offset after a hidden timeline becomes visible', () => {
    const f = fixture();
    const scroller = document.getElementById('flow-scroll')!;
    vi.spyOn(f.marker, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, scroller.hidden ? 0 : 13.5, 100, 20));
    scroller.hidden = true;
    resetReadoutPad(); updateLatchNow();
    scroller.hidden = false; updateLatchNow();
    expect(f.chip.querySelector<HTMLElement>('.latch-date-row')!.style.paddingTop).toBe('13.5px');
  });

  it('tracks the top timestamp date with reduced motion in the stacked layout', () => {
    document.documentElement.dataset.timelineLayout = 'stacked';
    vi.spyOn(REDUCED_MOTION, 'matches', 'get').mockReturnValue(true);
    const f = fixture();
    const row = f.chip.querySelector<HTMLElement>('.latch-date-row')!;
    vi.spyOn(f.chip, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 16, 20));
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 16, 20));
    const next = document.createElement('div'); next.dataset.date = '2026-10-02';
    f.marker.parentElement!.append(next); addLatchMarker(next);
    let top = 10;
    vi.spyOn(next, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, top, 100, 20));
    updateLatchNow();
    expect(f.latch.dataset.date).toBe('2026-10-03');
    top = 0; updateLatchNow();
    expect(f.latch.dataset.date).toBe('2026-10-02');
    expect(f.chip.title).toBe('Jump to date: Oct 2, 2026');
  });

  it('exposes whether the launcher is expanded and associates only the existing popover', () => {
    const f = fixture();
    expect(f.chip.getAttribute('aria-expanded')).toBe('false');
    expect(f.chip.hasAttribute('aria-controls')).toBe(false);
    picker!.toggle();
    expect(f.chip.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(f.chip.getAttribute('aria-controls')!)?.className).toBe('date-jump');
    picker!.close();
    expect(f.chip.getAttribute('aria-expanded')).toBe('false');
    expect(f.chip.hasAttribute('aria-controls')).toBe(false);
  });

  it('distinguishes today, the timeline date, and the date selected in the field', () => {
    fixture(); picker!.toggle(); typeDate('2026-10-20');
    expect(day('2026-10-04').getAttribute('aria-current')).toBe('date');
    expect(day('2026-10-04').getAttribute('aria-label')).toBe('Oct 4, 2026');
    expect(day('2026-10-03').getAttribute('aria-label')).toBe('Oct 3, 2026, currently shown in timeline');
    expect(day('2026-10-20').getAttribute('aria-label')).toBe('Oct 20, 2026, selected');
    expect(day('2026-10-03').hasAttribute('aria-current')).toBe(false);
    expect(day('2026-10-20').hasAttribute('aria-current')).toBe(false);
    expect(document.querySelector('.date-jump-cal')?.getAttribute('aria-label')).toBe('Oct 2026');
  });

  it('combines coincident states and clears obsolete selected and timeline states after edits and scrolls', async () => {
    const f = fixture(); picker!.toggle(); typeDate('2026-10-04');
    f.latch.dataset.date = '2026-10-04'; await vi.advanceTimersByTimeAsync(0);
    expect(day('2026-10-04').getAttribute('aria-label')).toBe('Oct 4, 2026, selected, currently shown in timeline');
    expect(day('2026-10-04').getAttribute('aria-current')).toBe('date');
    expect(day('2026-10-03').getAttribute('aria-label')).toBe('Oct 3, 2026');
    typeDate('');
    expect(day('2026-10-04').getAttribute('aria-label')).toBe('Oct 4, 2026, currently shown in timeline');
  });

  it('moves the programmatic today marker at midnight while retaining the other date states', () => {
    fixture(); picker!.toggle(); typeDate('2026-10-04');
    vi.setSystemTime(new Date('2026-10-05T00:01:00')); picker!.refresh();
    expect(day('2026-10-04').hasAttribute('aria-current')).toBe(false);
    expect(day('2026-10-04').getAttribute('aria-label')).toBe('Oct 4, 2026, selected');
    expect(day('2026-10-05').getAttribute('aria-current')).toBe('date');
    expect(day('2026-10-03').getAttribute('aria-label')).toBe('Oct 3, 2026, currently shown in timeline');
  });
});
