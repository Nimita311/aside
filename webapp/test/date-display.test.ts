// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatClock, formatStamp, formatTime, formatMonth, dateColumns } from '../src/date-display';
import { renderEntry, renderEntryDetail, renderActionDetail, renderDateMarker, scrubLatchDate, type RenderOptions } from '../src/render';
import { refreshDisplay } from '../src/display';
import { entityKey } from '../lib/types';
import { entityStats } from '../src/entity-relations';
import { loadApp } from './app-harness';
import type { DateTimePreferences } from '../src/preferences';
import { createSearchUi } from '../src/search-ui';
import { createDatePicker } from '../src/datepicker';
import type { StoreView } from '../lib/store';
import { createWeekView } from '../src/week-view';
import { refreshTimelineGutter } from '../src/date-time-settings';

const previousZone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });
beforeEach(() => vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US']));
afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.timelineLayout;
  document.documentElement.style.removeProperty('--flow-gutter');
  vi.restoreAllMocks();
});
const stamp = '2026-10-15T14:30:05';
function options(): RenderOptions {
  return { timeFormat: '24h', dateFormat: 'medium', timeStyle: 'short', now: stamp, nowDate: new Date(stamp),
    expandProjects: false, expandActions: false, activeFilter: null, resolveName: (_type, id) => id,
    onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(), refMarks: () => [], routeHref: route => route };
}

describe('locale date and time display', () => {
  it('moves wide timestamps above entries and restores the compact gutter when labels fit', () => {
    let wide = true;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, this.classList.contains('date-marker') ? wide ? 192 : 80 : this.classList.contains('em-time') ? wide ? 198 : 40 : 0, 20);
    });
    const prefs = { ...options(), dateFormat: 'full' as const, timeStyle: 'full' as const };
    refreshTimelineGutter(prefs);
    expect(document.documentElement.dataset.timelineLayout).toBe('stacked');
    expect(document.documentElement.style.getPropertyValue('--flow-gutter')).toBe('16px');
    const entries = ['2026-10-15T14:30:05', '2026-10-15T13:00:00', '2026-10-14T09:00:00'];
    for (const [index, created] of entries.entries()) {
      const card = renderEntry({ meta: { created }, weekFile: '2026-10-12', content: 'Entry' }, prefs, document.body,
        index === 1 ? undefined : { date: created.slice(0, 10), prev: index ? '2026-10-15' : null });
      expect(card.querySelector('.em-time')?.textContent).toBe(formatStamp(created, prefs));
    }
    wide = false; refreshTimelineGutter({ ...prefs, dateFormat: 'medium', timeStyle: 'short' });
    expect(document.documentElement.dataset.timelineLayout).toBe('gutter');
    expect(document.documentElement.style.getPropertyValue('--flow-gutter')).toBe('130px');
    refreshDisplay(document.body, options());
    expect([...document.querySelectorAll('.em-time')].map(node => node.textContent)).toEqual(['14:30', '13:00', '09:00']);
    expect(renderDateMarker('2026-10-14', '2026-10-15', options()).textContent).toBe('14');
  });

  it('uses complete date-time labels above entries on narrow screens with compact formats', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    refreshTimelineGutter(options());
    expect(document.documentElement.dataset.timelineLayout).toBe('stacked');
    const card = renderEntry({ meta: { created: stamp }, weekFile: '2026-10-12', content: 'Entry' }, options(), document.body);
    expect(card.querySelector('.em-time')?.textContent).toBe('Oct 15, 2026, 14:30');
  });

  it.each(['short', 'medium', 'long', 'full', 'iso'] as const)('uses %s date patterns in markers and the rolling readout', dateFormat => {
    for (const locale of ['en-US', 'en-GB', 'ja-JP']) {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue([locale]);
      const prefs = { ...options(), dateFormat };
      const marker = renderDateMarker('2026-10-15', null, prefs);
      expect(marker.textContent).toBe(formatDate('2026-10-15', dateFormat));
      const chip = document.createElement('div'); chip.innerHTML = '<div class="latch-date-row"></div>';
      scrubLatchDate(chip, '2026-10-15', '2026-10-14', 50, prefs);
      const visible = [...chip.querySelectorAll('.latch-unit > span:first-child')].map(node => node.textContent).join('');
      expect(visible).toBe(formatDate('2026-10-15', dateFormat));
    }
  });

  it('keeps separators between visible parts when intermediate date columns are omitted', () => {
    const marker = renderDateMarker('2026-10-14', '2026-10-15', { ...options(), dateFormat: 'full' });
    expect(marker.textContent).toBe('Wednesday, 14');
  });

  it('formats actual application entry names, IDs as labels, smart elements, clocks and markers together', async () => {
    const app = await loadApp<{ state: DateTimePreferences; getRenderOpts(): RenderOptions }>('state, getRenderOpts');
    Object.assign(app.state, { dateFormat: 'iso', timeStyle: 'medium', timeFormat: '24h' });
    const entry = { meta: { created: stamp }, weekFile: '2026-10-12', content: `#entry/${stamp} #date/${stamp} [Authored label](#entry/${stamp})` };
    const card = renderEntry(entry, app.getRenderOpts(), document.body, { date: '2026-10-15', prev: null });
    const reader = renderEntryDetail(entry, app.getRenderOpts()); document.body.append(reader);
    expect(card.querySelector('.inline-tag-entry .tag-text')?.textContent).toBe('2026-10-15 14:30:05');
    expect(reader.querySelector('.entity-title-label')?.textContent).toBe('2026-10-15 14:30:05');
    expect(card.querySelector('.em-time')?.textContent).toBe('14:30:05');
    expect(card.querySelector('.date-marker')?.textContent).toBe('2026-10-15');
    Object.assign(app.state, { dateFormat: 'long', timeStyle: 'short', timeFormat: '12h' });
    refreshDisplay(document.body, app.getRenderOpts());
    expect(card.querySelector('.inline-tag-entry .tag-text')?.textContent).toBe('October 15, 2026 at 2:30 PM');
    expect(card.querySelector('.inline-tag-date time')?.textContent).toBe('October 15, 2026 at 2:30 PM');
    expect(card.querySelector('.em-time')?.textContent).toBe('2:30 PM');
    expect(card.querySelector('.date-marker')?.textContent).toBe('October 15, 2026');
    expect(card.querySelector('.inline-tag-entry')?.getAttribute('data-ref-id')).toBe(stamp);
    expect(card.textContent).toContain('Authored label');
  });

  it('formats recurrence starts and original occurrences with their own zones and live preferences', () => {
    const opts = { ...options(), dateFormat: 'iso' as const, timeStyle: 'medium' as const };
    const original = '2026-10-15T14:30';
    const detail = renderActionDetail('2026-10-15-review', { frontMatter: {
      name: 'Review', created: original, timezone: 'America/Los_Angeles', scheduled: original,
      occurrence: { template: '2026-10-15-template', original, timezone: 'UTC' },
      recurrence: [{ dtstart: original, timezone: 'UTC', rrule: 'FREQ=DAILY' }],
    }, body: '' }, undefined, opts, []);
    document.body.append(detail);
    const field = (name: string) => [...detail.querySelectorAll('dt')].find(node => node.textContent === name)!.nextElementSibling!;
    const occurrence = field('Original occurrence'), recurrence = field('Recurrence');
    expect(occurrence.textContent).toBe('2026-10-15 07:30:00 (14:30:00 UTC)');
    expect(recurrence.textContent).toBe('2026-10-15 07:30:00 (14:30:00 UTC) · FREQ=DAILY');
    refreshDisplay(document.body, { ...opts, dateFormat: 'long', timeStyle: 'short', timeFormat: '12h' });
    expect(occurrence.textContent).toContain('October 15, 2026 at 7:30 AM');
    expect(recurrence.textContent).toContain('FREQ=DAILY');
    expect(field('Original occurrence')).toBe(occurrence);
    expect(field('ID').textContent).toBe('2026-10-15-review');
  });

  it('formats search date jumps live while navigation keeps the ISO date', () => {
    document.body.innerHTML = '<input class="search-input"><div id="search-results" hidden></div>';
    let prefs: RenderOptions = { ...options(), dateFormat: 'long' };
    const store = {
      getNoteIndex: () => [], getProjectIndex: () => [], getActionIndex: () => [], getArtifactIndex: () => [],
      getCachedEntryContents: () => new Map(), getCachedArtifactContents: () => new Map(),
      getSearchProgress: () => ({ complete: true }),
    } as unknown as StoreView;
    const onSelect = vi.fn();
    const search = createSearchUi({ store: () => store, renderOpts: () => prefs, onSelect });
    search.handleSearch('2026-10-15');
    const label = document.querySelector('.search-result-name')!;
    expect(label.textContent).toBe('Jump to October 15, 2026');
    prefs = { ...prefs, dateFormat: 'iso' }; refreshDisplay(document.body, prefs);
    expect(label.textContent).toBe('Jump to 2026-10-15');
    document.querySelector<HTMLElement>('.search-result-item[data-key="date:2026-10-15"]')!.click();
    expect(onSelect).toHaveBeenCalledWith({ type: 'date', id: '2026-10-15' });
  });

  it('formats week failure headings and retry labels while preserving error details', async () => {
    const prefs = { ...options(), dateFormat: 'long' as const };
    const week = createWeekView('2026-10-12', {
      renderOpts: () => prefs, read: async () => { throw new Error('Source notes/2026/2026-10-12.md'); },
      render: vi.fn(), current: () => true, settled: vi.fn(),
    });
    document.body.append(week.host); await week.load();
    const heading = week.host.querySelector('summary')!, retry = week.host.querySelector('button')!;
    expect(heading.textContent).toBe('Week of October 12, 2026 could not load');
    refreshDisplay(document.body, { ...prefs, dateFormat: 'iso' });
    expect(heading.textContent).toBe('Week of 2026-10-12 could not load');
    expect(retry.getAttribute('aria-label')).toBe('Retry week of 2026-10-12');
    expect(week.host.textContent).toContain('Source notes/2026/2026-10-12.md');
    expect(week.host.querySelector('button')).toBe(retry);
  });

  it('updates calendar date labels and month headings without replacing focused days', () => {
    document.body.innerHTML = '<div id="date-latch" data-date="2026-10-15"><button class="date-latch-chip">Date</button></div>';
    let prefs: DateTimePreferences = { timeFormat: '24h', dateFormat: 'long' };
    const picker = createDatePicker({ displayPreferences: () => prefs, jumpToDate: vi.fn(), jumpNear: vi.fn(async () => true) });
    try {
      picker.toggle();
      const day = document.querySelector<HTMLButtonElement>('.cal-day[data-date="2026-10-15"]')!;
      expect(day.getAttribute('aria-label')).toContain('October 15, 2026');
      day.focus(); prefs = { ...prefs, dateFormat: 'iso' }; picker.refresh();
      expect(day.getAttribute('aria-label')).toContain('2026-10-15');
      expect(document.querySelector('.cal-title')?.textContent).toBe('2026-10');
      expect(document.querySelector('.cal-day[data-date="2026-10-01"]')?.textContent).toBe('01');
      expect(document.activeElement).toBe(day);
    } finally { picker.close(); }
  });

  it('converts offset timestamps consistently in generic date, clock and date-time labels', () => {
    const prefs = { ...options(), dateFormat: 'iso' as const, timeStyle: 'medium' as const };
    expect(formatStamp('2026-10-15T00:30:05Z', prefs)).toBe('2026-10-14 17:30:05');
    expect(formatDate('2026-10-15T00:30:05Z', 'iso')).toBe('2026-10-14');
    expect(formatTime('2026-10-15T00:30:05Z', prefs)).toBe('17:30:05');
  });
  it.each([
    ['short', '10/15/26'], ['medium', 'Oct 15, 2026'], ['long', 'October 15, 2026'],
    ['full', 'Thursday, October 15, 2026'], ['iso', '2026-10-15'],
  ] as const)('formats %s dates without adding a clock', (style, expected) => {
    expect(formatStamp('2026-10-15', { timeFormat: 'locale', dateFormat: style, timeStyle: 'full' })).toBe(expected);
  });

  it.each([
    ['short', '2:30 PM'], ['medium', '2:30:05 PM'], ['long', '2:30:05 PM PDT'],
    ['full', '2:30:05 PM Pacific Daylight Time'],
  ] as const)('formats %s times with the browser zone', (style, expected) => {
    expect(formatClock(stamp, { timeFormat: 'locale', timeStyle: style })).toBe(expected);
  });

  it('uses the browser locale and allows a clock override independently of date style', () => {
    expect(formatStamp(stamp, { timeFormat: 'locale' })).toBe('Oct 15, 2026, 2:30 PM');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-GB']);
    expect(formatStamp(stamp, { timeFormat: 'locale' })).toBe('15 Oct 2026, 14:30');
    expect(formatStamp(stamp, { timeFormat: '12h', dateFormat: 'iso' })).toBe('2026-10-15 02:30 pm');
    expect(dateColumns(stamp, { timeFormat: 'locale' }).map(part => part.value).join('')).toBe('15 Oct 2026');
    expect(formatMonth('2026-10-15', { timeFormat: 'locale', dateFormat: 'short' })).toBe('10/2026');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR']);
    expect(formatDate(stamp, 'long')).toBe('15 octobre 2026');
  });

  it('preserves date-only and floating clock fields across DST gaps and early years', () => {
    expect(formatStamp('2026-03-08T02:30', { timeFormat: '24h', timeStyle: 'medium' })).toBe('Mar 8, 2026, 02:30:00');
    expect(formatDate('0001-01-01', 'iso')).toBe('0001-01-01');
    expect(formatDate('0001-01-01', 'long')).toBe('January 1, 1');
    expect(formatTime(stamp, { timeFormat: '24h', timeStyle: 'full' })).toBe('14:30:05 Pacific Daylight Time');
    expect(formatTime('2026-10-15T00:30', '24h')).toBe('00:30');
  });

  it.each(['2026-02-31T10:00', '2026-02-31T10:00Z', '2026-10-15T25:30', '2026-10-15T09:60',
    '2026-10-15T10:00+25:00', '2026-10-15T10:00+01:60', '2026-10-15T10:00-00:00',
    '0001-01-01T00:00Z', '0000-01-01', 'bad-date'])('retains malformed or unrepresentable values verbatim: %s', value => {
    for (const dateFormat of ['medium', 'iso'] as const) {
      expect(formatStamp(value, { timeFormat: '24h', dateFormat, timeStyle: 'full' })).toBe(value);
      expect(formatDate(value, dateFormat)).toBe(value);
      if (value.includes('T')) expect(formatTime(value, { timeFormat: '24h', timeStyle: 'full' })).toBe(value);
    }
  });

  it('shows the correct timezone name for both occurrences of a repeated clock', () => {
    const card = renderEntry({ meta: { created: stamp }, weekFile: '2026-10-12', content:
      '#date/2026-11-01T08:30Z #date/2026-11-01T09:30Z' }, { ...options(), timeStyle: 'long' }, document.body);
    const labels = [...card.querySelectorAll('.inline-tag-date time')].map(node => node.textContent);
    expect(labels).toEqual(['Nov 1, 2026, 01:30:00 PDT', 'Nov 1, 2026, 01:30:00 PST']);
  });

  it('updates chips, detail dates, and latest-entry stats in place with the chosen styles', () => {
    const opts = options();
    const card = renderEntry({ meta: { created: stamp }, weekFile: '2026-10-12', content: `Due #date/${stamp}.` }, opts, document.body);
    const relations = { entriesByEntity: new Map([[entityKey('action', '2026-10-15-review'), [stamp]]]) } as Parameters<typeof entityStats>[2];
    const detail = renderActionDetail('2026-10-15-review', { frontMatter: { name: 'Review', created: stamp }, body: '' }, undefined, opts,
      entityStats('action', '2026-10-15-review', relations));
    document.body.append(detail);
    const chip = card.querySelector<HTMLAnchorElement>('.inline-tag-date')!;
    const label = chip.querySelector('time')!; chip.focus();
    refreshDisplay(document.body, { ...opts, dateFormat: 'iso', timeStyle: 'medium', timeFormat: '12h' });
    expect(label.textContent).toBe('2026-10-15 2:30:05 PM');
    expect(detail.textContent).toContain('1 · latest 2026-10-15');
    expect(detail.textContent).toContain('2026-10-15 2:30:05 PM');
    expect(document.activeElement).toBe(chip);
    expect(chip.querySelector('time')).toBe(label);
    expect(chip.dataset.dateHandle).toBe(`#date/${stamp}`);
    expect(card.querySelector('.em-time')?.textContent).toBe('2:30:05 PM');
  });
});
