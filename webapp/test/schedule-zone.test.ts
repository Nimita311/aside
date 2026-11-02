// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actionMarks, actionPills, groupOpenActions, relativeDate, timelineWindow, waiting } from '../src/instance';
import { formatScheduledStamp, renderActionSummary, renderActionDetail, renderInstanceSummary, type RenderOptions } from '../src/render';
import type { Action, ActionFrontMatter } from '../lib/types';

const previousZone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });
const fm = (fields: Partial<ActionFrontMatter>): ActionFrontMatter => ({ name: 'Review', created: '2026-10-02T09:00', calendar: 'Work', ...fields });
const opts = (date = new Date('2026-10-03T00:00:00Z')): RenderOptions => ({ now: '2026-10-02T17:00', nowDate: date, timeFormat: '24h', expandProjects: false, expandActions: false, activeFilter: null, resolveName: (_type, id) => id, onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(), routeHref: route => '/work/' + route, refMarks: () => [] });
const action = (fields: Partial<ActionFrontMatter>): Action => ({ frontMatter: fm(fields), body: '' });

describe('browser action schedule zones', () => {
  it('shows the local clock plus the original date and zone across a day boundary', () => {
    expect(formatScheduledStamp('2026-10-03T10:00', 'Asia/Tokyo', '24h')).toBe('Oct 2, 2026, 18:00 (Oct 3, 2026, 10:00 Asia/Tokyo)');
    expect(formatScheduledStamp('2026-10-03T10:00', 'Asia/Tokyo', '12h')).toBe('Oct 2, 2026, 6:00 PM (Oct 3, 2026, 10:00 AM Asia/Tokyo)');
    expect(formatScheduledStamp('2026-10-02T18:00', 'America/Los_Angeles', '24h')).toBe('Oct 2, 2026, 18:00 (18:00 America/Los_Angeles)');
    expect(formatScheduledStamp('2026-10-03T10:00', undefined, '24h')).toBe('Oct 3, 2026, 10:00');
    expect(formatScheduledStamp('2026-10-03', 'Asia/Tokyo', '24h')).toBe('Oct 3, 2026');
  });
  it('keeps invalid dates and named-zone gaps visible without NaN labels', () => {
    const now = new Date('2026-03-08T09:00:00Z');
    for (const fields of [{ scheduled: '2026-02-31T10:00' }, { scheduled: '2026-03-08T02:30', timezone: 'America/Los_Angeles' }, { scheduled: '2026-03-08T10:00', timezone: 'Mars/Olympus' }]) {
      expect(relativeDate(fields.scheduled, now, fields.timezone)).toBe('unknown time');
      expect(actionPills(fm(fields), now)[0].label).toBe('Scheduled time unavailable');
      expect(formatScheduledStamp(fields.scheduled, fields.timezone, '24h')).toContain(fields.scheduled.slice(11));
    }
  });
  it('uses normal local resolution for an accepted floating gap while displaying its recorded clock until Calendar confirms it', () => {
    const fields = fm({ scheduled: '2026-03-08T02:30' }), now = new Date('2026-03-08T09:00:00Z');
    expect(relativeDate(fields.scheduled!, now)).toBe('in 2h');
    expect(actionPills(fields, now)[0].label).toBe('Scheduled in 2h');
    expect(formatScheduledStamp(fields.scheduled!, undefined, '24h')).toBe('Mar 8, 2026, 02:30');
    expect(waiting(fields, new Date('2026-03-08T10:59:00Z'))).toBe(false);
    expect(waiting(fields, new Date('2026-03-08T11:00:00Z'))).toBe(true);
  });
  it('counts down and marks elapsed schedules by their actual instant', () => {
    const fields = fm({ scheduled: '2026-10-03T10:00', timezone: 'Asia/Tokyo' });
    const now = new Date('2026-10-03T00:00:00Z');
    expect(relativeDate(fields.scheduled!, now, fields.timezone)).toBe('in 1h');
    expect(actionPills(fields, now)[0].label).toBe('Scheduled in 1h');
    expect(waiting(fields, now)).toBe(false);
    expect(actionMarks(fields, new Date('2026-10-03T01:30:00Z'))).toEqual(['slipped']);
  });
  it('does not reconstruct actual now into the first repeated-hour occurrence', () => {
    const fields = fm({ scheduled: '2026-11-01T01:30', timezone: 'America/Los_Angeles', duration: 'PT30M' });
    expect(waiting(fields, new Date('2026-11-01T08:45:00Z'))).toBe(false);
    expect(waiting(fields, new Date('2026-11-01T09:15:00Z'))).toBe(true);
    expect(relativeDate(fields.scheduled!, new Date('2026-11-01T09:30:00Z'), fields.timezone)).toBe('1h');
  });
  it('shares whole-minute seconds and fixed elapsed days with calendar duration', () => {
    expect(waiting(fm({ scheduled: '2026-10-03T10:00', timezone: 'Asia/Tokyo', duration: 'PT3600S' }), new Date('2026-10-03T01:45:00Z'))).toBe(false);
    expect(waiting(fm({ scheduled: '2026-03-07T10:00', timezone: 'America/Los_Angeles', duration: 'P1D' }), new Date('2026-03-08T17:30:00Z'))).toBe(false);
    expect(waiting(fm({ scheduled: '2026-03-07T10:00', timezone: 'America/Los_Angeles', duration: 'P1D' }), new Date('2026-03-08T18:00:00Z'))).toBe(true);
    expect(actionPills(fm({ scheduled: '2026-10-03T10:00', timezone: 'Asia/Tokyo', duration: 'PT3600S' }), opts().nowDate)[0].hover?.suffix).toBe(' · 1h');
  });
  it('keeps deadlines floating and all-day schedule status date-based', () => {
    expect(actionMarks(fm({ scheduled: '2026-10-03T10:00', timezone: 'Asia/Tokyo', deadline: '2026-10-02T18:30' }), new Date('2026-10-03T01:00:00Z'))).toEqual(['due']);
    expect(waiting(fm({ scheduled: '2026-10-02', timezone: 'Asia/Tokyo' }), new Date('2026-10-03T01:00:00Z'))).toBe(false);
    expect(waiting(fm({ scheduled: '2026-10-02', timezone: 'Asia/Tokyo' }), new Date('2026-10-03T07:00:00Z'))).toBe(true);
  });
  it('sorts and places the now tick by zoned instants, with visible annotations in summaries and details', () => {
    const tokyo = action({ scheduled: '2026-10-03T10:00', timezone: 'Asia/Tokyo' });
    const local = action({ scheduled: '2026-10-02T19:00' });
    const groups = groupOpenActions([{ id: 'tokyo', action: tokyo }, { id: 'local', action: local }], () => undefined);
    expect(groups.scheduled.map(row => row.id)).toEqual(['tokyo', 'local']);
    const options = opts(new Date('2026-10-03T01:30:00Z'));
    const summary = renderActionSummary(tokyo, undefined, options, { projects: [], assets: [], stats: { entries: 0 } }, vi.fn());
    expect(summary.querySelector('.schedule-time')?.textContent).toBe('Oct 2, 2026, 18:00 (Oct 3, 2026, 10:00 Asia/Tokyo)');
    const detail = renderActionDetail('tokyo', tokyo, undefined, options, []);
    expect(detail.textContent).toContain('Oct 2, 2026, 18:00 (Oct 3, 2026, 10:00 Asia/Tokyo)');
    const instance = renderInstanceSummary({ name: 'Work', id: 'work' }, options, { projects: [], actions: groups, assets: [], stats: { entries: 0 } }, vi.fn());
    const items = [...instance.querySelectorAll('.timeline-list > li')];
    expect(items.map(row => row.classList.contains('timeline-now') ? 'now' : row.querySelector('.tag-text')?.textContent)).toEqual(['tokyo', 'now', 'local']);
    expect(items[2].classList.contains('timeline-future')).toBe(true);
    expect(instance.querySelector('.schedule-time')).not.toBeNull();
  });
  it('windows by converted local dates and instants rather than authored date ordering', () => {
    const stamps = Array.from({ length: 10 }, (_, i) => ({ stamp: `2026-10-${String(i + 1).padStart(2, '0')}T10:00`, timezone: 'Asia/Tokyo' }));
    expect(timelineWindow(stamps, new Date('2026-10-03T01:30:00Z'))).toEqual({ from: 0, to: 10 });
  });
});
