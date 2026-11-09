// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatePicker, type CalendarContext } from '../src/datepicker';

let picker: ReturnType<typeof createDatePicker> | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T12:00:00')); });
afterEach(() => { picker?.dispose(); picker = undefined; document.body.replaceChildren(); vi.useRealTimers(); });

function fixture(weekStartsOn = 1) {
  const host = document.createElement('div'); document.body.append(host);
  const context: CalendarContext = { key: 'entries:project', current: '2026-10-20', visibleRange: { start: '2026-10-15', end: '2026-10-20' } };
  const preferences = { timeFormat: 'locale' as const, weekStartsOn };
  const jumpToDate = vi.fn();
  picker = createDatePicker({ getCalendarContext: () => context, displayPreferences: () => preferences, jumpToDate });
  picker.mountInline(host);
  return { host, context, preferences, jumpToDate };
}

describe('persistent timeline calendar', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])('fills six complete weeks beginning with weekday %s', start => {
    const f = fixture(start);
    const days = [...f.host.querySelectorAll<HTMLButtonElement>('.cal-day')];
    expect(days).toHaveLength(42);
    expect(new Date(days[0].dataset.date! + 'T12:00:00').getDay()).toBe(start);
    expect(f.host.querySelector('.cal-weekdays')?.firstElementChild?.getAttribute('title'))
      .toBe(new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(days[0].dataset.date! + 'T12:00:00')));
    const inRange = days.filter(day => day.classList.contains('is-in-range'));
    expect(inRange.map(day => day.dataset.date)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']);
    for (const [index, day] of days.entries()) {
      if (!day.classList.contains('is-in-range')) continue;
      expect(day.classList.contains('range-start')).toBe(index % 7 === 0 || day.dataset.date === '2026-10-15');
      expect(day.classList.contains('range-end')).toBe(index % 7 === 6 || day.dataset.date === '2026-10-20');
    }
    expect(days.filter(day => day.classList.contains('is-adjacent')).length).toBeGreaterThan(0);
    expect(f.host.querySelector('.date-jump-nav')).toBeNull();
    expect(f.host.querySelector('.date-jump-units')).toBeNull();
  });

  it('groups month controls after the month label and keeps adjacent today identifiable', () => {
    const f = fixture(6);
    const header = f.host.querySelector('.cal-header')!;
    expect(header.firstElementChild?.className).toBe('cal-title');
    expect([...header.querySelectorAll('button')].map(button => button.getAttribute('aria-label')))
      .toEqual(['Previous month', 'Next month', 'Jump to today']);
    f.host.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click();
    const today = f.host.querySelector<HTMLElement>('[data-date="2026-10-31"]')!;
    expect(today.classList.contains('is-today')).toBe(true);
    expect(today.classList.contains('is-adjacent')).toBe(true);
    expect(today.getAttribute('aria-current')).toBe('date');
  });

  it('keeps a manually browsed month while the retained timeline moves or opens elsewhere', () => {
    const f = fixture();
    f.host.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click();
    f.context.current = '2026-12-15'; f.context.retained = true; picker!.refresh();
    expect(f.host.querySelector('.cal-title')?.textContent).toBe('Nov 2026');
    f.preferences.weekStartsOn = 0; picker!.refresh();
    expect(f.host.querySelector('.cal-title')?.textContent).toBe('Nov 2026');
    expect(f.jumpToDate).not.toHaveBeenCalled();
    f.context.key = 'entries:new-selection'; picker!.refresh();
    expect(f.host.querySelector('.cal-title')?.textContent).toBe('Dec 2026');
  });

  it('uses the existing loose parser inline, commits only on Enter, and stays mounted', () => {
    const f = fixture();
    const input = f.host.querySelector<HTMLInputElement>('.date-jump-input')!;
    input.value = 'October 12, 2026'; input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    expect(f.jumpToDate).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(f.jumpToDate).toHaveBeenCalledWith('2026-10-12');
    expect(f.host.querySelector('.timeline-calendar')?.isConnected).toBe(true);
    expect(input.value).toBe('');
    f.host.querySelector<HTMLButtonElement>('.cal-today')!.click();
    expect(f.jumpToDate).toHaveBeenLastCalledWith('2026-10-31');
  });

  it('shares the draft and month when the persistent control is moved between hosts', () => {
    const f = fixture();
    const input = f.host.querySelector<HTMLInputElement>('.date-jump-input')!;
    input.value = 'November 15, 2026'; input.dispatchEvent(new Event('input'));
    const destination = document.createElement('div'); document.body.append(destination);
    picker!.mountInline(destination); picker!.mountInline(destination);
    expect(f.host.childElementCount).toBe(0);
    expect(destination.querySelectorAll('.timeline-calendar')).toHaveLength(1);
    expect(destination.querySelector('.date-jump-input')).toBe(input);
    expect(input.value).toBe('November 15, 2026');
    expect(destination.querySelector('.cal-title')?.textContent).toBe('Nov 2026');
  });

  it.each([false, true])('preserves the first date edit before the available context has refreshed (input event: %s)', withInput => {
    const host = document.createElement('div'); document.body.append(host);
    const context = { key: '', current: '2026-10-20' };
    const jumpToDate = vi.fn();
    picker = createDatePicker({ getCalendarContext: () => context, jumpToDate }); picker.mountInline(host);
    const input = host.querySelector<HTMLInputElement>('.date-jump-input')!;
    context.key = 'instance:ready';
    input.value = 'November 15, 2026';
    if (withInput) {
      input.dispatchEvent(new Event('input'));
      expect(input.value).toBe('November 15, 2026');
      expect(host.querySelector('.cal-title')?.textContent).toBe('Nov 2026');
      expect(jumpToDate).not.toHaveBeenCalled();
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(jumpToDate).toHaveBeenCalledOnce();
    expect(jumpToDate).toHaveBeenCalledWith('2026-11-15');
  });

  it('keeps the first month navigation before the available context has refreshed', () => {
    const host = document.createElement('div'); document.body.append(host);
    const context = { key: '', current: '2026-10-20' };
    picker = createDatePicker({ getCalendarContext: () => context, jumpToDate: vi.fn() }); picker.mountInline(host);
    context.key = 'instance:ready';
    host.querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!.click();
    expect(host.querySelector('.cal-title')?.textContent).toBe('Sep 2026');
  });
});
