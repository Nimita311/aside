// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatePicker } from '../src/datepicker';
import { createModal } from '../src/modal';

const pickers: ReturnType<typeof createDatePicker>[] = [];
const modals: ReturnType<typeof createModal>[] = [];
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  vi.useFakeTimers();
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(() => {
  for (const modal of modals.splice(0)) modal.close(0);
  for (const picker of pickers.splice(0)) { picker.close(); picker.close(); }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function frame(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(performance.now());
}

function chip(): HTMLElement {
  const element = document.createElement('div');
  element.className = 'date-latch-chip';
  element.setAttribute('role', 'button');
  element.tabIndex = 0;
  return element;
}

function fixture() {
  const title = document.createElement('h1'); title.className = 'app-title';
  const fallback = document.createElement('a'); fallback.href = '/'; title.append(fallback);
  const latch = document.createElement('div'); latch.id = 'date-latch'; latch.dataset.date = '2026-10-04';
  const trigger = chip(); latch.append(trigger);
  const outside = document.createElement('button');
  document.body.append(title, latch, outside);
  const deps = { jumpToDate: vi.fn(), jumpNear: vi.fn(async () => true) };
  const picker = createDatePicker(deps); pickers.push(picker);
  trigger.focus(); picker.toggle(); vi.advanceTimersByTime(0);
  const input = document.querySelector<HTMLInputElement>('.date-jump-input')!;
  return { picker, deps, trigger, latch, outside, fallback, input };
}

function escape(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function monthArrow(label: 'Previous month' | 'Next month'): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.cal-nav[aria-label="${label}"]`)!;
}

describe('date picker focus', () => {
  it.each(['Previous month', 'Next month'] as const)('retains the %s control across repeated calendar redraws', label => {
    const f = fixture();
    const original = monthArrow(label); original.focus(); original.click();
    const replacement = monthArrow(label);
    expect(replacement).not.toBe(original);
    expect(document.activeElement).toBe(replacement);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    replacement.click();
    expect(document.activeElement).toBe(monthArrow(label));
    expect(document.querySelector('.cal-title')?.textContent).toBe(label === 'Previous month' ? 'Aug 2026' : 'Dec 2026');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(f.picker.isOpen()).toBe(true);
  });

  it('does not move input or outside focus when an unfocused calendar control redraws', () => {
    const f = fixture();
    monthArrow('Next month').click(); expect(document.activeElement).toBe(f.input);
    f.outside.focus(); monthArrow('Previous month').click(); expect(document.activeElement).toBe(f.outside);
  });

  it('keeps the focused month arrow when the viewing date updates', async () => {
    const f = fixture(); monthArrow('Next month').focus();
    f.latch.dataset.date = '2026-12-04';
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.cal-title')?.textContent).toBe('Dec 2026');
    expect(document.activeElement).toBe(monthArrow('Next month'));
  });

  it('retains the focused calendar date across same-month timeline updates', async () => {
    const f = fixture();
    const original = document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!;
    original.focus();
    f.latch.dataset.date = '2026-10-05'; await vi.advanceTimersByTimeAsync(0);
    const replacement = document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!;
    expect(replacement).not.toBe(original);
    expect(document.activeElement).toBe(replacement);
    expect(document.querySelector('.cal-day.is-current')?.getAttribute('data-date')).toBe('2026-10-05');
  });

  it('keeps the focused date available when the timeline crosses a month boundary', async () => {
    const f = fixture();
    document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!.focus();
    f.latch.dataset.date = '2026-11-05'; await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.cal-title')?.textContent).toBe('Oct 2026');
    expect(document.activeElement).toBe(document.querySelector('.cal-day[data-date="2026-10-20"]'));
    expect(document.querySelector('.cal-day.is-current')).toBeNull();
    const next = monthArrow('Next month'); next.focus(); next.click();
    expect(document.querySelector('.cal-title')?.textContent).toBe('Nov 2026');
    expect(document.activeElement).toBe(monthArrow('Next month'));
    expect(document.querySelector('.cal-day.is-current')?.getAttribute('data-date')).toBe('2026-11-05');
  });

  it('still follows input and timeline month changes after focus leaves a calendar day', async () => {
    const f = fixture();
    document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!.focus();
    f.input.focus(); f.input.value = '2026-12-15'; f.input.dispatchEvent(new Event('input'));
    expect(document.querySelector('.cal-title')?.textContent).toBe('Dec 2026');
    expect(document.activeElement).toBe(f.input);
    f.input.value = ''; f.input.dispatchEvent(new Event('input'));
    f.outside.focus(); f.latch.dataset.date = '2027-01-05'; await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.cal-title')?.textContent).toBe('Jan 2027');
    expect(document.activeElement).toBe(f.outside);
  });

  it('Escape restores the trigger and dismisses only this navigation level', () => {
    const f = fixture(); const appEscape = vi.fn();
    document.addEventListener('keydown', appEscape);
    try {
      const event = escape(f.input);
      expect(event.defaultPrevented).toBe(true);
      expect(appEscape).not.toHaveBeenCalled();
      expect(f.picker.isOpen()).toBe(false);
      expect(document.activeElement).toBe(f.trigger);
    } finally { document.removeEventListener('keydown', appEscape); }
  });

  it.each(['field', 'calendar'])('returns focus after a completed %s date jump', source => {
    const f = fixture();
    if (source === 'field') {
      f.input.value = '2026-10-20';
      f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    } else {
      const day = document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-20"]')!;
      day.focus(); day.click();
    }
    expect(f.deps.jumpToDate).toHaveBeenCalledWith('2026-10-20');
    expect(f.picker.isOpen()).toBe(false);
    expect(document.activeElement).toBe(f.trigger);
  });

  it('uses the current equivalent trigger when the original has been replaced', () => {
    const f = fixture(); const replacement = chip(); f.trigger.replaceWith(replacement);
    escape(f.input); expect(document.activeElement).toBe(replacement);
  });

  it.each(['hidden', 'inert', 'disabled', 'display'])('falls back to the chooser when the trigger is %s', state => {
    const f = fixture();
    if (state === 'hidden') f.latch.hidden = true;
    if (state === 'inert') f.latch.inert = true;
    if (state === 'disabled') f.trigger.setAttribute('aria-disabled', 'true');
    if (state === 'display') f.latch.style.display = 'none';
    escape(f.input); expect(document.activeElement).toBe(f.fallback);
  });

  it('restores on programmatic dismissal only while the picker owns focus', () => {
    const f = fixture(); f.picker.close(); expect(document.activeElement).toBe(f.trigger);
    f.picker.toggle(); f.outside.focus(); f.picker.close();
    expect(document.activeElement).toBe(f.outside);
  });

  it('preserves outside pointer focus and allows an inside press to finish outside', () => {
    const f = fixture();
    f.input.dispatchEvent(new Event('pointerdown', { bubbles: true })); f.outside.click();
    expect(f.picker.isOpen()).toBe(true);
    f.outside.dispatchEvent(new Event('pointerdown', { bubbles: true })); f.outside.focus(); f.outside.click();
    expect(f.picker.isOpen()).toBe(false); expect(document.activeElement).toBe(f.outside);
    frame(); expect(document.activeElement).toBe(f.outside);
  });

  it('does not steal focus on a full outside pointer click on an unfocusable surface', () => {
    const f = fixture(); const surface = document.createElement('div'); document.body.append(surface);
    surface.dispatchEvent(new Event('pointerdown', { bubbles: true })); f.input.blur(); surface.click();
    expect(f.picker.isOpen()).toBe(false); expect(document.activeElement).toBe(document.body);
    frame(); expect(document.activeElement).toBe(document.body);
  });

  it('repairs focus when a flow rebuild replaces the restored trigger', () => {
    const f = fixture(); f.picker.close(); const replacement = chip(); f.trigger.replaceWith(replacement);
    expect(document.activeElement).toBe(document.body);
    frame(); expect(document.activeElement).toBe(replacement);
  });

  it('retains later meaningful focus, including a programmatically focused target outside the tab order', () => {
    const f = fixture(); f.picker.close(); f.trigger.remove();
    f.outside.tabIndex = -1; f.outside.focus(); frame();
    expect(document.activeElement).toBe(f.outside);
  });

  it('cancels deferred restoration when another pointer press begins', () => {
    const f = fixture(); f.picker.close(); f.trigger.remove();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); frame();
    expect(document.activeElement).toBe(document.body);
  });

  it('does not restore behind a newly opened modal', () => {
    const f = fixture(); f.picker.close(); f.trigger.remove();
    const dialog = document.createElement('dialog'); const button = document.createElement('button');
    dialog.append(button); document.body.append(dialog);
    const controller = createModal(dialog, { dismiss: () => controller.close(0), beforeOpen() {}, fallback: () => f.fallback, duration: () => 0 });
    modals.push(controller); controller.open(); frame();
    expect(document.activeElement).toBe(button);
  });

  it('cancels stale restoration on reopen and capture listener arming on same-tick close', () => {
    const f = fixture(); f.picker.close(); f.picker.toggle(); frame();
    expect(document.activeElement).toBe(document.querySelector('.date-jump-input'));
    f.picker.close(); vi.advanceTimersByTime(0);
    const event = escape(f.trigger); expect(event.defaultPrevented).toBe(false);
  });
});
