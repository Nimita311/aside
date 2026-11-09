// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatePicker, type CalendarContext } from '../src/datepicker';

let picker: ReturnType<typeof createDatePicker> | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T12:00:00')); });
afterEach(() => { picker?.dispose(); picker = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(getDayCounts = vi.fn(async (_from: string, _to: string) => new Map<string, number>())) {
  const host = document.createElement('div'); document.body.append(host);
  const context: CalendarContext = { key: 'entries:aurora', current: '2026-10-03', visibleRange: { start: '2026-10-01', end: '2026-10-03' } };
  picker = createDatePicker({ getCalendarContext: () => context, getDayCounts, jumpToDate: vi.fn() }); picker.mountInline(host);
  const day = (value: string) => host.querySelector<HTMLButtonElement>(`.cal-day[data-date="${value}"]`)!;
  return { host, context, getDayCounts, day };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('calendar activity feedback', () => {
  it('keeps unknown counts distinct from known empty dates while loading', async () => {
    const f = fixture();
    expect(f.host.querySelector('.cal-grid')?.getAttribute('aria-busy')).toBe('true');
    expect(f.day('2026-10-03').hasAttribute('data-count')).toBe(false);
    expect(f.day('2026-10-03').getAttribute('aria-label')).toContain('activity loading');
    await settle();
    expect(f.getDayCounts).toHaveBeenCalledWith('2026-09-28', '2026-11-08');
    expect(f.host.querySelector('.cal-grid')?.hasAttribute('aria-busy')).toBe(false);
    expect(f.day('2026-10-03').dataset.count).toBe('0');
    expect(f.day('2026-10-03').getAttribute('aria-label')).toContain('0 matching entries');
  });

  it('encodes activity counts without altering the range or today markers', async () => {
    const get = vi.fn(async (_from: string, _to: string) => new Map([['2026-10-02', 1], ['2026-10-03', 20], ['2026-10-04', 4]]));
    const f = fixture(get); await settle();
    expect(Number(f.day('2026-10-03').style.getPropertyValue('--cal-density')))
      .toBeGreaterThan(Number(f.day('2026-10-02').style.getPropertyValue('--cal-density')));
    expect(f.day('2026-10-03').classList.contains('range-end')).toBe(true);
    expect(f.day('2026-10-04').classList.contains('is-today')).toBe(true);
    expect(f.day('2026-10-04').getAttribute('aria-current')).toBe('date');
  });

  it('does not let a slower previous month replace the displayed month activity', async () => {
    let finishOctober!: (value: Map<string, number>) => void;
    let finishNovember!: (value: Map<string, number>) => void;
    const get = vi.fn(async (_from: string, _to: string) => new Map<string, number>())
      .mockReturnValueOnce(new Promise(resolve => { finishOctober = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { finishNovember = resolve; }));
    const f = fixture(get); await settle();
    f.host.querySelector<HTMLButtonElement>('[aria-label="Next month"]')!.click(); await settle();
    finishOctober(new Map([['2026-11-04', 99]])); await settle();
    expect(f.host.querySelector('.cal-title')?.textContent).toBe('Nov 2026');
    expect(f.day('2026-11-04').hasAttribute('data-count')).toBe(false);
    finishNovember(new Map([['2026-11-04', 5]])); await settle();
    expect(f.day('2026-11-04').dataset.count).toBe('5');
  });

  it('ignores an old timeline result after the selection context changes', async () => {
    let finishOld!: (value: Map<string, number>) => void;
    const get = vi.fn(async (_from: string, _to: string) => new Map([['2026-10-03', 2]]))
      .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    const f = fixture(get); await settle();
    f.context.key = 'entries:another-project'; picker!.refresh(); await settle();
    finishOld(new Map([['2026-10-03', 90]])); await settle();
    expect(f.day('2026-10-03').dataset.count).toBe('2');
  });

  it('reuses complete counts while scrolling and reloads after data invalidation', async () => {
    const f = fixture(); await settle();
    f.context.current = '2026-10-04'; picker!.refresh(); picker!.refresh(); await settle();
    expect(f.getDayCounts).toHaveBeenCalledOnce();
    picker!.refresh({ invalidateCounts: true }); await settle();
    expect(f.getDayCounts).toHaveBeenCalledTimes(2);
  });

  it('reports a recoverable count failure without presenting missing data as zero', async () => {
    const get = vi.fn(async (_from: string, _to: string) => new Map([['2026-10-03', 3]]))
      .mockRejectedValueOnce(new Error('offline'));
    const f = fixture(get); await settle();
    const status = f.host.querySelector<HTMLElement>('.date-jump-status')!;
    expect(status.hidden).toBe(false); expect(status.textContent).toContain('Activity unavailable.');
    expect(f.day('2026-10-03').hasAttribute('data-count')).toBe(false);
    f.host.querySelector<HTMLButtonElement>('.cal-retry')!.click(); await settle();
    expect(status.hidden).toBe(true); expect(f.day('2026-10-03').dataset.count).toBe('3');
  });

  it('does not fetch activity before an instance timeline is available', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const context = { key: '', current: '2026-10-03' };
    const getDayCounts = vi.fn(async () => new Map<string, number>());
    picker = createDatePicker({ getCalendarContext: () => context, getDayCounts, jumpToDate: vi.fn() }); picker.mountInline(host);
    await settle(); expect(getDayCounts).not.toHaveBeenCalled();
    expect(host.querySelector('.cal-grid')?.hasAttribute('aria-busy')).toBe(false);
    context.key = 'instance:ready'; picker.refresh(); await settle();
    expect(getDayCounts).toHaveBeenCalledOnce();
  });

  it('loads activity only when the persistent control is connected and visible', async () => {
    const host = document.createElement('div');
    const getDayCounts = vi.fn(async () => new Map<string, number>());
    picker = createDatePicker({ getCalendarContext: () => ({ key: 'entries:ready', current: '2026-10-03' }), getDayCounts, jumpToDate: vi.fn() });
    picker.mountInline(host); await settle();
    expect(getDayCounts).not.toHaveBeenCalled();
    host.hidden = true; document.body.append(host); picker.refresh(); await settle();
    expect(getDayCounts).not.toHaveBeenCalled();
    host.hidden = false; host.inert = true; picker.refresh(); await settle();
    expect(getDayCounts).not.toHaveBeenCalled();
    host.inert = false; picker.refresh(); await settle();
    expect(getDayCounts).toHaveBeenCalledOnce();
  });

  it('ignores pending responses after disposal', async () => {
    let finish!: (value: Map<string, number>) => void;
    const get = vi.fn(async (_from: string, _to: string) => new Map<string, number>())
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const f = fixture(get); await settle(); picker!.dispose();
    finish(new Map([['2026-10-03', 9]])); await settle();
    expect(f.host.childElementCount).toBe(0);
  });
});
