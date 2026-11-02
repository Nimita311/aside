// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissActionToast } from '../src/toast';
import { createDatePicker } from '../src/datepicker';

let picker: ReturnType<typeof createDatePicker> | undefined;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  dismissActionToast();
  picker?.close(); picker?.close(); picker = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  const latch = document.createElement('div'); latch.id = 'date-latch'; latch.dataset.date = '2026-10-04';
  const chip = document.createElement('button'); chip.className = 'date-latch-chip'; latch.append(chip);
  document.body.append(latch);
  const jumpNear = vi.fn(async () => false);
  picker = createDatePicker({ jumpToDate: vi.fn(), jumpNear }); picker.toggle();
  const status = document.querySelector<HTMLElement>('.date-jump-status')!;
  const nav = document.querySelector<HTMLElement>('.date-jump-nav')!;
  const newer = document.querySelector<HTMLButtonElement>('.date-jump-step[title="Newer"]')!;
  const older = document.querySelector<HTMLButtonElement>('.date-jump-step[title="Older"]')!;
  return { jumpNear, status, nav, newer, older };
}

describe('date picker navigation feedback', () => {
  it.each(['newer', 'older'] as const)('keeps a %s boundary quiet while retaining focus', async direction => {
    const f = fixture();
    expect(f.status.textContent).toBe('');
    expect(f.status.getAttribute('role')).toBe('status');
    expect(f.status.getAttribute('aria-atomic')).toBe('true');
    f[direction].focus(); f[direction].click();
    expect(f.nav.getAttribute('aria-busy')).toBe('true');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.jumpNear).toHaveBeenCalledWith(
      direction === 'newer' ? '2026-10-11T12:00:00' : '2026-09-27T12:00:00',
      '2026-10-04', direction === 'newer' ? 1 : -1,
    );
    expect(f.status.textContent).toBe('');
    expect(f.nav.classList.contains('is-shaking')).toBe(false);
    expect(f.nav.hasAttribute('aria-busy')).toBe(false);
    expect(document.activeElement).toBe(f[direction]);
    expect(picker!.isOpen()).toBe(true);
  });

  it('clears an obsolete failure at the start of a successful retry', async () => {
    const f = fixture(); f.jumpNear.mockRejectedValueOnce(new Error('offline'));
    f.newer.click(); await vi.advanceTimersByTimeAsync(0);
    expect(f.status.textContent).toBe('');
    expect(document.querySelector('#action-toast')?.textContent).toBe('Unable to jump to that date. Try again.');
    let complete!: (found: boolean) => void;
    f.jumpNear.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    f.newer.click();
    expect(document.querySelector<HTMLElement>('#action-toast')?.hidden).toBe(true);
    expect(f.status.textContent).toBe('');
    complete(true); await vi.advanceTimersByTimeAsync(0);
    expect(f.status.textContent).toBe('');
  });

  it('clears a stale message on period change and passes the new target date', async () => {
    const f = fixture(); f.jumpNear.mockRejectedValueOnce(new Error('offline'));
    f.newer.click(); await vi.advanceTimersByTimeAsync(0);
    document.querySelector<HTMLButtonElement>('.date-jump-unit[data-unit="month"]')!.click();
    expect(f.status.textContent).toBe('');
    f.newer.click(); await vi.advanceTimersByTimeAsync(0);
    expect(f.jumpNear).toHaveBeenLastCalledWith('2026-11-04T12:00:00', '2026-10-04', 1);
    expect(f.status.textContent).toBe('');
  });

  it('rebases a subsequent step on the landed date across a large gap', async () => {
    const f = fixture();
    f.jumpNear.mockImplementationOnce(async () => {
      document.getElementById('date-latch')!.dataset.date = '2025-03-01';
      return true;
    });
    f.older.click(); await vi.advanceTimersByTimeAsync(0);
    f.older.click(); await vi.advanceTimersByTimeAsync(0);
    expect(f.jumpNear).toHaveBeenLastCalledWith('2025-02-22T12:00:00', '2025-03-01', -1);
  });

  it('reports a recoverable error and allows another attempt', async () => {
    const f = fixture(); f.jumpNear.mockRejectedValueOnce(new Error('offline'));
    f.newer.click(); await vi.advanceTimersByTimeAsync(0);
    expect(f.status.textContent).toBe('');
    expect(document.querySelector('#action-toast')?.textContent).toBe('Unable to jump to that date. Try again.');
    expect(f.nav.hasAttribute('aria-busy')).toBe(false);
    f.jumpNear.mockResolvedValueOnce(true); f.newer.click(); await vi.advanceTimersByTimeAsync(0);
    expect(f.jumpNear).toHaveBeenCalledTimes(2);
    expect(f.status.textContent).toBe('');
  });

  it.each(['miss', 'error'] as const)('does not leak an old %s into a reopened picker', async result => {
    const f = fixture();
    let complete!: (found: boolean) => void;
    let fail!: (error: Error) => void;
    f.jumpNear.mockReturnValueOnce(new Promise((resolve, reject) => { complete = resolve; fail = reject; }));
    f.newer.click(); picker!.close(); picker!.toggle();
    if (result === 'miss') complete(false);
    else fail(new Error('offline'));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.date-jump-status')!.textContent).toBe('');
    expect(document.querySelector('#action-toast')).toBeNull();
    expect(document.querySelector('.date-jump-nav')!.classList.contains('is-shaking')).toBe(false);
    document.querySelector<HTMLButtonElement>('.date-jump-step[title="Newer"]')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.date-jump-status')!.textContent).toBe('');
    expect(f.jumpNear).toHaveBeenCalledTimes(2);
  });

  it('continues to suppress overlapping requests while waiting for a result', async () => {
    const f = fixture(); let complete!: (found: boolean) => void;
    f.jumpNear.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    f.newer.click(); f.older.click();
    expect(f.jumpNear).toHaveBeenCalledOnce();
    complete(false); await vi.advanceTimersByTimeAsync(0);
    expect(f.status.textContent).toBe('');
    expect(f.nav.hasAttribute('aria-busy')).toBe(false);
  });
});
