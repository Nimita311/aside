import { describe, it, expect, vi } from 'vitest';
import { assertRecurrence, assertRecurrenceUpdate, assertOccurrence, CompiledRecurrence, planningActions, occurrenceKey, projectionId, resolveProjection } from '../src/core/recurrence.js';
import { parseActionFile } from '../src/core/parser.js';
import { serializeAction } from '../src/mcp/tools/serialize.js';
import { scheduleInstant } from '../src/core/scheduling.js';
import type { Action } from '../src/core/types.js';
const weekly = { dtstart: '2026-10-02T09:00', timezone: 'America/Los_Angeles', rrule: 'FREQ=WEEKLY;BYDAY=FR' };
const now = new Date('2026-10-09T18:00:00Z');
// An independent oracle visits anchored frequency ticks and then applies BY
// filters. The upstream RRULE iterator changes the phase when it skips hours.
function anchoredTicks(dtstart: string, rule: string, from: string, count: number): string[] {
  const parts = Object.fromEntries(rule.split(';').map(part => part.split('=')));
  const start = Date.parse(dtstart + ':00Z'), lower = Date.parse(from + ':00Z');
  const step = (parts.FREQ === 'HOURLY' ? 3600000 : parts.FREQ === 'MINUTELY' ? 60000 : 1000) * Number(parts.INTERVAL ?? 1);
  const hours = parts.BYHOUR?.split(',').map(Number), minutes = parts.BYMINUTE?.split(',').map(Number), days = parts.BYDAY?.split(',');
  const rows: string[] = [];
  for (let tick = start; rows.length < count; tick += step) {
    const date = new Date(tick);
    if (hours && !hours.includes(date.getUTCHours()) || days && !days.includes(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][date.getUTCDay()])) continue;
    if (parts.FREQ !== 'HOURLY' && minutes && !minutes.includes(date.getUTCMinutes())) continue;
    const candidates = parts.FREQ === 'HOURLY' ? (minutes ?? [date.getUTCMinutes()]).map(minute => tick + (minute - date.getUTCMinutes()) * 60000) : [tick];
    for (const candidate of candidates.sort((a, b) => a - b)) if (candidate >= lower && candidate >= start && rows.length < count) rows.push(new Date(candidate).toISOString().slice(0, 16));
  }
  return rows;
}
describe('recurrence identity and history', () => {
  it('uses original UTC identity for named zones and skips DST gaps', () => {
    const rule = new CompiledRecurrence({ dtstart: '2026-03-07T02:30', timezone: weekly.timezone, rrule: 'FREQ=DAILY;COUNT=3' });
    expect([...rule.occurrences('t')].map(o => o.identity.original)).toEqual(['2026-03-07T10:30:00Z', '2026-03-09T09:30:00Z', '2026-03-10T09:30:00Z']);
  });
  it('preserves UTC offset seconds for historical wall-minute occurrences', () => {
    const schedule = { dtstart: '1971-01-01T09:00', timezone: 'Africa/Monrovia', rrule: 'FREQ=DAILY;COUNT=1' };
    expect(assertRecurrence([schedule])).toEqual([schedule]);
    const rule = new CompiledRecurrence(schedule), occurrence = rule.occurrences('t').next().value!;
    expect(occurrence.identity.original).toBe('1971-01-01T09:44:30Z');
    expect(rule.contains('t', occurrence.identity.original)).toEqual(occurrence);
    expect(assertOccurrence(occurrence.identity)).toEqual(occurrence.identity);
    expect(rule.contains('t', '1971-01-01T09:44:31Z')).toBeUndefined();
    expect(() => assertOccurrence({ ...occurrence.identity, original: '1971-01-01T09:44:30.001Z' })).toThrow();
  });
  it('keeps all-day identities as dates', () => {
    expect([...new CompiledRecurrence({ dtstart: '2026-10-02', rrule: 'FREQ=DAILY;COUNT=2' }).occurrences('t')].map(o => o.identity.original)).toEqual(['2026-10-02', '2026-10-03']);
  });
  it('accepts second-frequency rules only when starts are whole minutes', () => {
    expect(() => assertRecurrence([{ dtstart: '2026-10-02T09:00', rrule: 'FREQ=SECONDLY;INTERVAL=60' }])).not.toThrow();
    expect(() => assertRecurrence([{ dtstart: '2026-10-02T09:00', rrule: 'FREQ=SECONDLY;INTERVAL=10' }])).toThrow(/whole-minute/);
    expect(() => assertRecurrence([{ dtstart: '2026-10-02T09:00', rrule: 'FREQ=MINUTELY;BYSECOND=30' }])).toThrow();
  });
  it('rejects overlapping schedules and incompatible UNTIL types', () => {
    expect(() => assertRecurrence([weekly, { ...weekly, dtstart: '2026-10-16T09:00' }])).toThrow(/nonoverlapping/);
    expect(() => assertRecurrence([{ ...weekly, rrule: weekly.rrule + ';UNTIL=20261030' }])).toThrow(/UNTIL/);
  });
  it.each(['WKST=XX', 'WKST=MO,TU', 'WKST=', 'BYDAY=', 'INTERVAL=1.5', 'COUNT=2x'])('rejects malformed rule parts instead of coercing %s', part => {
    expect(() => assertRecurrence([{ dtstart: '2026-01-01', rrule: `FREQ=DAILY;${part}` }])).toThrow();
  });
  it('can close a rule and append a future pattern, but cannot rewrite past slots', () => {
    const closed = { ...weekly, rrule: weekly.rrule + ';UNTIL=20261030T160000Z' };
    const future = { ...weekly, dtstart: '2026-11-02T09:00', rrule: 'FREQ=MONTHLY;BYDAY=1MO' };
    expect(() => assertRecurrence([closed, future])).not.toThrow();
    expect(() => assertRecurrenceUpdate([weekly], [closed, future], now)).not.toThrow();
    expect(() => assertRecurrenceUpdate([weekly], [{ ...weekly, rrule: 'FREQ=WEEKLY;BYDAY=MO' }], now)).toThrow(/before now/);
    expect(() => assertRecurrenceUpdate([weekly], [{ ...weekly, rrule: weekly.rrule + ';COUNT=1' }], now)).not.toThrow();
  });
  it('seeks decades of minute recurrence without scanning historical ticks', () => {
    const rule = new CompiledRecurrence({ dtstart: '2000-01-01T09:00', rrule: 'FREQ=MINUTELY;INTERVAL=2' });
    expect(rule.occurrences('t', '2026-10-09T09:01', '2026-10-09T09:05').next().value?.scheduled).toBe('2026-10-09T09:02');
  });
  it.each([
    'FREQ=MINUTELY;INTERVAL=11;BYHOUR=9,17;BYMINUTE=5,19,47',
    'FREQ=SECONDLY;INTERVAL=660;BYHOUR=9,17;BYMINUTE=5,19,47',
    'FREQ=HOURLY;INTERVAL=5;BYHOUR=9,17;BYMINUTE=5,47',
    'FREQ=MINUTELY;INTERVAL=7;BYDAY=MO,WE,FR;BYHOUR=9,17',
  ])('preserves anchored filtered interval phase while seeking %s', rrule => {
    const rule = new CompiledRecurrence({ dtstart: '2026-01-02T09:05', rrule });
    const from = '2026-10-09T09:05';
    const expected = anchoredTicks('2026-01-02T09:05', rrule, from, 1)[0];
    expect(rule.occurrences('t', from).next().value?.scheduled).toBe(expected);
  });
  it('seeks a large zoned COUNT tail without examining preceding minute ticks', () => {
    const rule = new CompiledRecurrence({ dtstart: '2000-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=MINUTELY;INTERVAL=2;COUNT=10000000' });
    expect([...rule.occurrences('t', '2026-10-09T09:01', '2026-10-09T09:05')].map(n => n.scheduled)).toEqual(['2026-10-09T09:02', '2026-10-09T09:04']);
    expect(rule.contains('t', '2026-10-09T09:02:00Z')).toBeTruthy();
    const end = new Date(Date.parse('2000-01-01T09:00:00Z') + 9999999 * 120000).toISOString().slice(0, 16);
    expect(rule.lastInstant()).toBe(scheduleInstant(end, 'UTC'));
    expect(rule.previous('t', '2050-01-01T00:00')?.scheduled).toBe(end);
    expect(rule.contains('t', '2050-01-01T00:00:00Z')).toBeUndefined();
  });
  it('keeps valid daily COUNT occurrences past the old computation cap accessible', () => {
    const rule = new CompiledRecurrence({ dtstart: '1600-01-01', rrule: 'FREQ=DAILY;COUNT=100005' });
    const end = new Date(Date.parse('1600-01-01T00:00:00Z') + 100004 * 86400000).toISOString().slice(0, 10);
    expect(rule.contains('t', end)?.identity.original).toBe(end);
    expect(rule.previous('t', '2026-10-09')?.scheduled).toBe(end);
    expect(rule.lastInstant()).toBe(scheduleInstant(end));
  });
  it('aggregates filtered minute COUNT history while retaining exact original identities', () => {
    const rule = new CompiledRecurrence({ dtstart: '2000-01-03T09:00', timezone: 'UTC', rrule: 'FREQ=MINUTELY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,17;COUNT=2000000' });
    expect([...rule.occurrences('t', '2026-10-09T09:00', '2026-10-09T09:02')].map(n => n.identity.original)).toEqual(['2026-10-09T09:00:00Z', '2026-10-09T09:01:00Z', '2026-10-09T09:02:00Z']);
    expect(rule.contains('t', '2026-10-10T09:00:00Z')).toBeUndefined();
  });
  it('deduplicates singleton BYSETPOS selections before consuming COUNT', () => {
    const rule = new CompiledRecurrence({ dtstart: '2026-01-01T09:00', rrule: 'FREQ=DAILY;BYSETPOS=1,-1;COUNT=3' });
    expect([...rule.occurrences('t')].map(n => n.scheduled)).toEqual(['2026-01-01T09:00', '2026-01-02T09:00', '2026-01-03T09:00']);
    expect(rule.previous('t', '2026-02-01T09:00')?.scheduled).toBe('2026-01-03T09:00');
  });
  it.each([
    ['2026-01-01T09:00', 'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1,15,31;BYHOUR=9,17;BYMINUTE=0,30'],
    ['2026-01-30T09:00', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'],
    ['2026-01-05T09:00', 'FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO,WE,FR;BYHOUR=9,17;BYMINUTE=0,30'],
    ['2026-01-01T09:00', 'FREQ=DAILY;INTERVAL=3;BYMONTHDAY=1,3,5;BYHOUR=9,17'],
    ['2024-02-29T09:00', 'FREQ=YEARLY;BYYEARDAY=60,365'],
    ['2026-03-02T09:00', 'FREQ=YEARLY;BYMONTH=3,10;BYDAY=1MO,-1FR;BYSETPOS=1,2'],
  ])('indexes COUNT consistently with anchored expansion for %s %s', (dtstart, rrule) => {
    const rule = new CompiledRecurrence({ dtstart, rrule: rrule + ';COUNT=30' });
    const expected: string[] = [];
    rule.rule.all(date => {
      const wall = date.toISOString().slice(0, 16);
      if (expected.at(-1) !== wall) expected.push(wall);
      return expected.length <= 30;
    });
    const actual = [...rule.occurrences('t')].map(n => n.scheduled);
    expect(actual).toEqual(expected.slice(0, 30));
    expect(rule.previous('t', actual.at(-1)!)?.scheduled).toBe(actual.at(-1));
    expect(rule.lastInstant()).toBe(scheduleInstant(actual.at(-1)!));
  });
  it('counts high-frequency filtered schedules from the original anchored ticks', () => {
    const dtstart = '2026-01-02T09:05', rrule = 'FREQ=MINUTELY;INTERVAL=7;BYDAY=MO,WE,FR;BYHOUR=9,17';
    const rule = new CompiledRecurrence({ dtstart, rrule: rrule + ';COUNT=30' });
    const expected = anchoredTicks(dtstart, rrule, dtstart, 30);
    expect([...rule.occurrences('t')].map(n => n.scheduled)).toEqual(expected);
    expect(rule.lastInstant()).toBe(scheduleInstant(expected.at(-1)!));
  });
  it('rejects incompatible subdaily anchor patterns without hanging RRULE validation', () => {
    expect(() => assertRecurrence([{ dtstart: '2026-03-01T08:15', rrule: 'FREQ=MINUTELY;INTERVAL=7;BYHOUR=9,17;BYDAY=MO,TU,WE,TH,FR' }])).toThrow(/dtstart must match/);
  });
  it.each([
    [{ dtstart: '2026-10-03T02:15', timezone: 'Australia/Lord_Howe', rrule: 'FREQ=DAILY;COUNT=3' }, ['2026-10-03T02:15', '2026-10-05T02:15', '2026-10-06T02:15']],
    [{ dtstart: '2026-10-04T01:15', timezone: 'Australia/Lord_Howe', rrule: 'FREQ=HOURLY;COUNT=3' }, ['2026-10-04T01:15', '2026-10-04T03:15', '2026-10-04T04:15']],
    [{ dtstart: '2011-12-29T09:00', timezone: 'Pacific/Apia', rrule: 'FREQ=DAILY;COUNT=3' }, ['2011-12-29T09:00', '2011-12-31T09:00', '2012-01-01T09:00']],
    [{ dtstart: '2026-11-01T01:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY;COUNT=2' }, ['2026-11-01T01:30', '2026-11-02T01:30']],
  ])('counts gaps and repeated clocks once for %j', (schedule, expected) => {
    const rule = new CompiledRecurrence(schedule);
    expect([...rule.occurrences('t')].map(n => n.scheduled)).toEqual(expected);
    expect(rule.lastInstant()).toBe(scheduleInstant(expected.at(-1)!, schedule.timezone));
    expect(rule.previous('t', '2030-01-01T00:00')?.scheduled).toBe(expected.at(-1));
  });
  it('checks historical and segment boundaries without resolving distant COUNT endpoints', () => {
    const schedule = { dtstart: '2026-01-01T09:00', rrule: 'FREQ=MINUTELY;BYHOUR=9,17;COUNT=1000000000' };
    const endpoint = vi.spyOn(CompiledRecurrence.prototype, 'lastInstant').mockImplementation(() => { throw new Error('A full endpoint is unnecessary'); });
    try {
      expect(() => assertRecurrenceUpdate([schedule], [{ ...schedule, rrule: 'FREQ=MINUTELY;BYHOUR=9,17;COUNT=2000000000' }], now)).not.toThrow();
      expect(() => assertRecurrence([schedule, { dtstart: '2030-01-01T09:00', rrule: 'FREQ=DAILY' }])).toThrow(/nonoverlapping/);
      expect(endpoint).not.toHaveBeenCalled();
    } finally { endpoint.mockRestore(); }
  });
  it('preserves first-fold history while the current clock is in the second repeated hour', () => {
    const schedule = { dtstart: '2026-10-31T01:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY' };
    const repeatedNow = new Date('2026-11-01T09:15:00Z');
    const rule = new CompiledRecurrence(schedule);
    expect(rule.lastBefore(repeatedNow)).toBe(Date.parse('2026-11-01T08:30:00Z'));
    expect(() => assertRecurrenceUpdate([schedule], [{ ...schedule, rrule: 'FREQ=DAILY;UNTIL=20261101T081500Z' }], repeatedNow)).not.toThrow();
    const page = planningActions(new Map([['t', { frontMatter: { name: 'Repeat', created: '2026-10-31T09:00', recurrence: [schedule] }, body: '' }]]), { now: repeatedNow });
    expect(page.nodes.some(row => row.occurrence?.original === '2026-11-01T08:30:00Z')).toBe(true);
  });
  it('includes first-fold future occurrences before a horizon ending in the second fold', () => {
    const schedule = { dtstart: '2026-10-25T01:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY' };
    const page = planningActions(new Map([['t', { frontMatter: { name: 'Repeat', created: '2026-10-25T09:00', recurrence: [schedule] }, body: '' }]]), { now: new Date('2026-10-25T09:15:00Z'), lookaheadDays: 7 });
    expect(page.nodes.some(row => row.occurrence?.original === '2026-11-01T08:30:00Z')).toBe(true);
    expect(page.nodes.some(row => row.occurrence?.original === '2026-11-02T09:30:00Z')).toBe(false);
  });
  it('keeps the UTC UNTIL boundary exact when it falls in the second repeated hour', () => {
    const rule = new CompiledRecurrence({ dtstart: '2026-10-31T01:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY;UNTIL=20261101T091500Z' });
    expect([...rule.occurrences('t')].map(row => row.identity.original)).toEqual(['2026-10-31T08:30:00Z', '2026-11-01T08:30:00Z']);
    expect(rule.lastInstant()).toBe(Date.parse('2026-11-01T08:30:00Z'));
  });
  it.each([undefined, 'America/Los_Angeles'])('excludes times beyond a fold horizon for timezone %s', timezone => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const schedule = { dtstart: '2026-10-25T01:00', timezone, rrule: 'FREQ=DAILY;BYHOUR=1,2;BYMINUTE=0,30' };
      const page = planningActions(new Map([['t', { frontMatter: { name: 'Repeat', created: '2026-10-25T09:00', recurrence: [schedule] }, body: '' }]]), { now: new Date('2026-10-25T09:15:00Z'), lookaheadDays: 7 });
      expect(page.issues).toEqual([]);
      expect(page.nodes.some(row => row.action.frontMatter.scheduled === '2026-11-01T01:30')).toBe(true);
      expect(page.nodes.some(row => row.action.frontMatter.scheduled === '2026-11-01T02:00')).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
  it('preserves floating first-fold history without changing its authored identity', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const schedule = { dtstart: '2026-10-31T01:30', rrule: 'FREQ=DAILY;COUNT=2' };
      const repeatedNow = new Date('2026-11-01T09:15:00Z'), rule = new CompiledRecurrence(schedule);
      expect(rule.lastBefore(repeatedNow)).toBe(Date.parse('2026-11-01T08:30:00Z'));
      expect(() => assertRecurrenceUpdate([schedule], [{ ...schedule, rrule: 'FREQ=DAILY;UNTIL=20261101T011500' }], repeatedNow)).not.toThrow();
      const actions = new Map([
        ['floating', { frontMatter: { name: 'Past', created: '2026-10-31T09:00', recurrence: [schedule] }, body: '' }],
        ['future', { frontMatter: { name: 'Future', created: '2026-10-31T09:00', recurrence: [{ dtstart: '2026-11-01T02:00', rrule: 'FREQ=DAILY;COUNT=1' }] }, body: '' }],
      ]);
      const page = planningActions(actions, { now: repeatedNow, lookaheadDays: 0 });
      expect(page.issues).toEqual([]);
      expect(page.nodes.map(row => [row.occurrence?.template, row.occurrence?.original])).toEqual([
        ['future', '2026-11-01T02:00'], ['floating', '2026-11-01T01:30'], ['floating', '2026-10-31T01:30'],
      ]);
    } finally { vi.unstubAllEnvs(); }
  });
  it('serializes recurrence and provenance losslessly', () => {
    const fm = { name: 'Review', created: '2026-10-09T09:00', recurrence: [weekly] };
    expect(parseActionFile(serializeAction(fm, 'Body')).value.frontMatter).toEqual(fm);
  });
  it('suppresses only exact materialized identities, even outside lookahead', () => {
    const occurrence = { template: 't', original: '2026-10-09T16:00:00Z', timezone: weekly.timezone };
    const actions = new Map([['t', { frontMatter: { name: 'Review', created: '2026-10-01T09:00', recurrence: [weekly] }, body: '' }], ['saved', { frontMatter: { name: 'Moved', created: '2026-10-09T09:00', scheduled: '2027-01-01T09:00', occurrence }, body: '' }]]);
    const page = planningActions(actions, { now });
    expect(page.nodes.find(r => r.id === 'saved')).toBeTruthy();
    expect(page.nodes.filter(r => r.projected).some(r => occurrenceKey(r.occurrence!) === occurrenceKey(occurrence))).toBe(false);
    expect(actions.size).toBe(2);
  });
  it('stops resolving a projection handle when its exact occurrence is materialized', () => {
    const occurrence = { template: 't', original: '2026-10-09T16:00:00Z', timezone: weekly.timezone };
    const actions = new Map<string, Action>([['t', { frontMatter: { name: 'Review', created: '2026-10-01T09:00', recurrence: [weekly] }, body: '' }]]);
    expect(resolveProjection(actions, projectionId(occurrence))?.frontMatter.scheduled).toBe('2026-10-09T09:00');
    actions.set('saved', { frontMatter: { name: 'Moved', created: '2026-10-09T09:00', scheduled: '2027-01-01T09:00', resolution: 'done', occurrence }, body: '' });
    expect(resolveProjection(actions, projectionId(occurrence))).toBeUndefined();
    expect(resolveProjection(actions, projectionId({ ...occurrence, original: '2026-10-16T16:00:00Z' }))).toBeDefined();
  });
});


describe('planning projection boundaries and pages', () => {
  const action = (recurrence: { dtstart: string; rrule: string; timezone?: string }[]) => ({ frontMatter: { name: 'Repeat', created: '2026-01-01T09:00', recurrence }, body: '' });
  it('keeps a floating gap clock as its original identity while projecting history', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const actions = new Map([['t', action([{ dtstart: '2026-03-07T02:30', rrule: 'FREQ=DAILY;COUNT=3' }])]]);
      const page = planningActions(actions, { now: new Date('2026-03-10T18:00:00Z') });
      expect(page.issues).toEqual([]);
      expect(page.nodes.map(n => [n.action.frontMatter.scheduled, n.occurrence?.original])).toContainEqual(['2026-03-08T02:30', '2026-03-08T02:30']);
      expect(page.nodes.map(n => n.occurrence?.original)).not.toContain('2026-03-08T03:30');
    } finally { vi.unstubAllEnvs(); }
  });
  it('ends an all-day lookahead on the configured date', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const page = planningActions(new Map([['t', action([{ dtstart: '2026-10-09', rrule: 'FREQ=DAILY' }])]]), { now: new Date('2026-10-09T18:00:00Z'), lookaheadDays: 7 });
      expect(page.nodes.map(n => n.occurrence?.original).sort()).toEqual(['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
    } finally { vi.unstubAllEnvs(); }
  });
  it('adds all-day lookahead as calendar days across spring-forward', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const page = planningActions(new Map([['t', action([{ dtstart: '2026-03-07', rrule: 'FREQ=DAILY' }])]]), { now: new Date('2026-03-08T07:30:00Z'), lookaheadDays: 7 });
      expect(page.nodes.map(n => n.occurrence?.original).sort().at(-1)).toBe('2026-03-14');
    } finally { vi.unstubAllEnvs(); }
  });
  it('includes one future occurrence when it falls beyond lookahead', () => {
    const page = planningActions(new Map([['t', action([{ dtstart: '2026-12-01', rrule: 'FREQ=YEARLY;COUNT=2' }])]]), { now });
    expect(page.nodes.map(n => n.occurrence?.original)).toEqual(['2026-12-01']);
  });
  it('orders upcoming work before another template’s history and pages every identity once', () => {
    const actions = new Map([
      ['a', action([{ dtstart: '2026-10-10', rrule: 'FREQ=DAILY;COUNT=2' }])],
      ['z', action([{ dtstart: '2026-01-01', rrule: 'FREQ=DAILY;UNTIL=20261008' }])],
    ]);
    const first = planningActions(actions, { now, limit: 2 });
    expect(first.nodes.map(n => n.occurrence?.template)).toEqual(['a', 'a']);
    const ids = new Set(first.nodes.map(n => n.id));
    let after = first.next;
    while (after) {
      const page = planningActions(actions, { now: new Date('2028-01-01T00:00:00Z'), after, limit: 17 });
      expect(page.issues).toEqual([]);
      for (const row of page.nodes) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); }
      after = page.next;
    }
    expect(ids.size).toBe(283);
  });
  it('does not skip history when a rule zone is a whole day ahead of the viewer', () => {
    vi.stubEnv('TZ', 'Pacific/Honolulu');
    try {
      const schedule = { dtstart: '2026-10-01T09:00', timezone: 'Pacific/Kiritimati', rrule: 'FREQ=DAILY;BYHOUR=9,18;COUNT=20' };
      const actions = new Map([['t', action([schedule])]]), expected = [...new CompiledRecurrence(schedule).occurrences('t')].map(n => n.identity.original).sort();
      const originals: string[] = []; let after: string | undefined;
      do {
        const page = planningActions(actions, { now: new Date('2026-10-12T00:00:00Z'), after, limit: 2 });
        expect(page.issues).toEqual([]); originals.push(...page.nodes.map(n => n.occurrence!.original)); after = page.next ?? undefined;
      } while (after);
      expect(originals.sort()).toEqual(expected);
    } finally { vi.unstubAllEnvs(); }
  });
  it('pages complete history across zones without changing floating or named identities', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      const actions = new Map([
        ['floating', action([{ dtstart: '2026-03-06T02:30', rrule: 'FREQ=DAILY;COUNT=5' }])],
        ['zoned', action([{ dtstart: '2026-03-06T02:30', timezone: 'America/Los_Angeles', rrule: 'FREQ=DAILY;COUNT=5' }])],
        ['tokyo', action([{ dtstart: '2026-03-06T02:30', timezone: 'Asia/Tokyo', rrule: 'FREQ=DAILY;COUNT=5' }])],
      ]);
      const ids = new Set<string>(); let after: string | undefined;
      do {
        const page = planningActions(actions, { now: new Date('2026-03-12T18:00:00Z'), after, limit: 2 });
        expect(page.issues).toEqual([]);
        for (const row of page.nodes) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); }
        after = page.next ?? undefined;
      } while (after);
      expect(ids.size).toBe(15);
      expect([...ids].some(id => id.includes(encodeURIComponent('2026-03-08T02:30')))).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
});
