// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatePicker } from '../src/datepicker';
import { currentFlowDate } from '../src/latch';

const pickers: ReturnType<typeof createDatePicker>[] = [];

afterEach(() => {
  for (const picker of pickers.splice(0)) picker.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture() {
  const latch = document.createElement('div'); latch.id = 'date-latch'; latch.dataset.date = '2026-10-04';
  const host = document.createElement('div');
  const outside = document.createElement('button');
  document.body.append(latch, host, outside);
  const deps = { getCalendarContext: () => ({ key: 'timeline', current: currentFlowDate() }), jumpToDate: vi.fn() };
  const picker = createDatePicker(deps); pickers.push(picker);
  picker.mountInline(host);
  const input = host.querySelector<HTMLInputElement>('.date-jump-input')!;
  // The viewing date reaches the mounted calendar through a refresh.
  const view = (date: string) => { latch.dataset.date = date; picker.refresh(); };
  return { picker, deps, outside, input, view };
}

function monthArrow(label: 'Previous month' | 'Next month'): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.cal-nav[aria-label="${label}"]`)!;
}

describe('date picker focus', () => {
  it.each(['Previous month', 'Next month'] as const)('retains the %s control across repeated calendar redraws', label => {
    fixture();
    const original = monthArrow(label); original.focus(); original.click();
    const replacement = monthArrow(label);
    expect(replacement).not.toBe(original);
    expect(document.activeElement).toBe(replacement);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    replacement.click();
    expect(document.activeElement).toBe(monthArrow(label));
    expect(document.querySelector('.cal-title')?.textContent).toBe(label === 'Previous month' ? 'Aug 2026' : 'Dec 2026');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('does not move input or outside focus when an unfocused calendar control redraws', () => {
    const f = fixture(); f.input.focus();
    monthArrow('Next month').click(); expect(document.activeElement).toBe(f.input);
    f.outside.focus(); monthArrow('Previous month').click(); expect(document.activeElement).toBe(f.outside);
  });

  it('keeps the focused month arrow when the viewing date updates', () => {
    const f = fixture(); monthArrow('Next month').focus();
    f.view('2026-12-04');
    expect(document.querySelector('.cal-title')?.textContent).toBe('Dec 2026');
    expect(document.activeElement).toBe(monthArrow('Next month'));
  });

  it('retains the focused calendar date across same-month timeline updates', () => {
    const f = fixture();
    const original = document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!;
    original.focus();
    f.view('2026-10-05');
    const replacement = document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!;
    expect(replacement).toBe(original);
    expect(document.activeElement).toBe(replacement);
    expect(document.querySelector('.cal-day.is-current')?.getAttribute('data-date')).toBe('2026-10-05');
  });

  it('keeps the focused date available when the timeline crosses a month boundary', () => {
    const f = fixture();
    document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!.focus();
    f.view('2026-11-05');
    expect(document.querySelector('.cal-title')?.textContent).toBe('Oct 2026');
    expect(document.activeElement).toBe(document.querySelector('.cal-day[data-date="2026-10-20"]'));
    expect(document.querySelector('.cal-day.is-current')?.getAttribute('data-date')).toBe('2026-11-05');
    expect(document.querySelector('.cal-day.is-current')?.classList.contains('is-adjacent')).toBe(true);
    const next = monthArrow('Next month'); next.focus(); next.click();
    expect(document.querySelector('.cal-title')?.textContent).toBe('Nov 2026');
    expect(document.activeElement).toBe(monthArrow('Next month'));
    expect(document.querySelector('.cal-day.is-current')?.getAttribute('data-date')).toBe('2026-11-05');
  });

  it('still follows input and timeline month changes after focus leaves a calendar day', () => {
    const f = fixture();
    document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!.focus();
    f.input.focus(); f.input.value = '2026-12-15'; f.input.dispatchEvent(new Event('input'));
    expect(document.querySelector('.cal-title')?.textContent).toBe('Dec 2026');
    expect(document.activeElement).toBe(f.input);
    f.input.value = ''; f.input.dispatchEvent(new Event('input'));
    f.outside.focus(); f.view('2027-01-05');
    expect(document.querySelector('.cal-title')?.textContent).toBe('Jan 2027');
    expect(document.activeElement).toBe(f.outside);
  });

  it.each(['field', 'calendar'])('keeps focus on the committing control after a completed %s date jump', source => {
    const f = fixture();
    const control = source === 'field' ? f.input : document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!;
    control.focus();
    if (source === 'field') {
      f.input.value = '2026-10-20';
      f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    } else control.click();
    expect(f.deps.jumpToDate).toHaveBeenCalledWith('2026-10-20');
    expect(document.activeElement).toBe(control);
  });
});
