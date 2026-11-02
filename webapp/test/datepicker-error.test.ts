// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatePicker } from '../src/datepicker';

const pickers: ReturnType<typeof createDatePicker>[] = [];
afterEach(() => {
  for (const picker of pickers.splice(0)) { picker.close(); picker.close(); }
  document.body.replaceChildren();
});

function fixture() {
  const latch = document.createElement('div'); latch.id = 'date-latch'; latch.dataset.date = '2026-10-04';
  const trigger = document.createElement('button'); trigger.className = 'date-latch-chip'; latch.append(trigger);
  document.body.append(latch);
  const deps = { jumpToDate: vi.fn(), jumpNear: vi.fn(async () => true) };
  const picker = createDatePicker(deps); pickers.push(picker); picker.toggle();
  const input = document.querySelector<HTMLInputElement>('.date-jump-input')!;
  const error = document.getElementById('date-jump-error')!;
  return { picker, deps, trigger, input, error };
}

function enter(input: HTMLInputElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}

describe('date picker input errors', () => {
  it('opens with no visible or associated error', () => {
    const f = fixture();
    expect(f.error.hidden).toBe(true); expect(f.error.textContent).toBe('');
    expect(f.input.hasAttribute('aria-invalid')).toBe(false);
    expect(f.input.hasAttribute('aria-describedby')).toBe(false);
  });

  it.each(['not a date', '2026-02-30', ''])('identifies rejected input %j in text and accessibility attributes', value => {
    const f = fixture(); f.input.value = value;
    expect(enter(f.input).defaultPrevented).toBe(true);
    expect(f.input.value).toBe(value);
    expect(f.input.getAttribute('aria-invalid')).toBe('true');
    expect(f.input.classList.contains('is-invalid')).toBe(true);
    expect(document.getElementById(f.input.getAttribute('aria-describedby')!)).toBe(f.error);
    expect(f.error.hidden).toBe(false);
    expect(f.error.textContent).toBe('Enter a valid date, such as 2026-10-04.');
    expect(f.error.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(f.input);
    expect(f.picker.isOpen()).toBe(true); expect(f.deps.jumpToDate).not.toHaveBeenCalled();
  });

  it.each(['still wrong', '', 'October 20, 2026'])('clears stale errors while editing to %j', value => {
    const f = fixture(); f.input.value = 'invalid'; enter(f.input);
    f.input.value = value; f.input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(f.input.classList.contains('is-invalid')).toBe(false);
    expect(f.input.hasAttribute('aria-invalid')).toBe(false);
    expect(f.input.hasAttribute('aria-describedby')).toBe(false);
    expect(f.error.hidden).toBe(true); expect(f.error.textContent).toBe('');
    expect(document.activeElement).toBe(f.input); expect(f.deps.jumpToDate).not.toHaveBeenCalled();
  });

  it('can reject again after editing and then accept a corrected free-form date', () => {
    const f = fixture(); f.input.value = 'invalid'; enter(f.input);
    f.input.value = '2026-02-30'; f.input.dispatchEvent(new Event('input')); enter(f.input);
    expect(f.input.getAttribute('aria-invalid')).toBe('true'); expect(f.error.hidden).toBe(false);
    f.input.value = 'October 20, 2026'; f.input.dispatchEvent(new Event('input')); enter(f.input);
    expect(f.deps.jumpToDate).toHaveBeenCalledOnce(); expect(f.deps.jumpToDate).toHaveBeenCalledWith('2026-10-20');
    expect(f.picker.isOpen()).toBe(false); expect(document.activeElement).toBe(f.trigger);
    f.picker.toggle();
    expect(document.querySelectorAll('#date-jump-error')).toHaveLength(1);
    expect(document.getElementById('date-jump-error')?.hidden).toBe(true);
    expect(document.querySelector('.date-jump-input')?.hasAttribute('aria-invalid')).toBe(false);
  });

  it('does not turn month navigation into a field commit or clear an unresolved error', () => {
    const f = fixture(); f.input.value = 'invalid'; enter(f.input);
    const next = document.querySelector<HTMLButtonElement>('.cal-nav[aria-label="Next month"]')!;
    next.focus(); next.click();
    expect(f.input.getAttribute('aria-invalid')).toBe('true'); expect(f.error.hidden).toBe(false);
    expect(f.deps.jumpToDate).not.toHaveBeenCalled(); expect(f.picker.isOpen()).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.cal-nav[aria-label="Next month"]'));
  });
});
