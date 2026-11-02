import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dateHandle, dateMentions, dateTimeAttribute, localDateStamp, parseDateHandle } from '../src/date-reference';
import { buildRoute, parseRoute } from '../src/route';

const previousZone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });

describe('ISO date references', () => {
  it.each([
    '0001-01-01', '2024-02-29', '2026-10-15T09:30', '2026-10-15T09:30:12.125',
    '2026-10-15T09:30:00-07:00', '2026-10-15T16:30:00Z', '2026-10-15T09:30+02:00',
    '2026-10-15/2026-10-18', '2026-10-15T09:30/2026-10-15T10:30',
    '2026-10-15T09:30:00/2026-10-15T09:30',
    '2026-10-15T09:30:00/2026-10-15T09:30:00.125',
    // Authored clocks reverse, but the instants are in chronological order.
    '2026-10-15T10:00+02:00/2026-10-15T09:00Z',
    '2026-10-15T09:30[America/Los_Angeles]', '2026-10-15T09:30:12.125[Asia/Tokyo]',
    '2026-10-15T09:30:00-07:00[America/Los_Angeles]', '2026-10-15T16:30Z[America/Los_Angeles]',
    '2026-10-15T09:30[America/Argentina/Buenos_Aires]',
    '2026-10-15T09:30[UTC]', '2026-10-15T09:30[Etc/GMT+8]',
    '2026-10-15T09:30[America/Los_Angeles]/2026-10-15T10:30[America/Los_Angeles]',
    '2026-10-15T09:30[Asia/Tokyo]/2026-10-15T09:30[America/Los_Angeles]',
  ])('round-trips a complete value: %s', value => {
    const handle = `#date/${value}`;
    const ref = parseDateHandle(handle)!;
    expect(ref).not.toBeNull();
    expect(dateHandle(ref)).toBe(handle);
    for (const filter of [null, { type: 'project' as const, id: '2026-10-04-test' }, { type: 'action' as const, id: '2026-10-04-test' }]) {
      const state = { filter, doc: null, date: ref };
      expect(parseRoute(buildRoute(state))).toEqual(state);
    }
  });

  it.each([
    '', 'today', '2026-10', '0000-01-01', '2026-02-29', '2026-02-31', '2026-13-01',
    '2026-10-15T24:00', '2026-10-15T09:60', '2026-10-15T09:30:60',
    '2026-10-15T09:30:00.1234', '2026-10-15T09:30+24:00', '2026-10-15T09:30-00:00',
    '2026-10-15T09:30@America/Los_Angeles', '2026-10-15[America/Los_Angeles]',
    '2026-10-15T09:30[Mars/Olympus]', '2026-10-15T09:30[]', '2026-10-15T09:30[Asia/Tokyo',
    '2026-10-15T09:30[Asia/Tokyo]garbage', '2026-10-15T09:30[[Asia/Tokyo]]',
    '2026-10-15T09:30[Asia/Tokyo][u-ca=hebrew]', '2026-10-15T09:30[+09:00]',
    '2026-10-15T09:30[America/../Los_Angeles]', '2026-10-15T09:30[America/Los_Angeles]]',
    '2026-03-08T02:30[America/Los_Angeles]', '2026-10-15T09:30-08:00[America/Los_Angeles]',
    '2026-10-15T09:30[America/Los_Angeles]/2026-10-15T09:30[Asia/Tokyo]',
    '2026-10-15/', '2026-10-15/2026-10-14', '2026-10-15/2026-10-16/2026-10-17',
    '2026-10-15T10:00/2026-10-15T09:00', '2026-10-15/2026-10-15T10:00',
    '2026-10-15T09:30/2026-10-15T10:30Z', '2026-10-15..2026-10-18',
    '2026-10-15T09:00Z/2026-10-15T10:00+02:00', '2026-10-15/P3D',
    '9999-12-31T23:59-23:59', '0001-01-01T00:00+23:59',
    // Kolkata's historical offset has seconds; a rounded offset is inconsistent.
    '1900-01-01T10:00+05:21[Asia/Kolkata]',
  ])('rejects unsupported or invalid values without partial rendering: %s', value => {
    expect(parseDateHandle(`#date/${value}`)).toBeNull();
    expect(dateMentions(`(${`#date/${value}`})`)).toEqual([]);
    expect(parseRoute(`date/${value}`)).toEqual({ filter: null, doc: null });
  });

  it('extracts bare dates surrounded by prose and punctuation with complete offsets and intervals', () => {
    const content = 'Meet Thursday (#date/2026-10-15T09:30). From #date/2026-10-15/2026-10-18, then #date/2026-10-19T09:30+02:00!';
    const mentions = dateMentions(content);
    expect(mentions.map(({ ref }) => dateHandle(ref))).toEqual([
      '#date/2026-10-15T09:30', '#date/2026-10-15/2026-10-18', '#date/2026-10-19T09:30+02:00',
    ]);
    for (const mention of mentions) expect(content.slice(mention.index, mention.index + mention.length)).toBe(dateHandle(mention.ref));
    expect(dateMentions('word#date/2026-10-15 path/#date/2026-10-15 \\#date/2026-10-15 #date/2026-10-15garbage')).toEqual([]);
  });

  it('keeps dates and floating clocks while converting offset timestamps across days and DST', () => {
    expect(localDateStamp('2026-10-15')).toBe('2026-10-15');
    expect(localDateStamp('2026-10-15T09:30')).toBe('2026-10-15T09:30');
    expect(localDateStamp('2026-10-15T01:30:12.125+09:00')).toBe('2026-10-14T09:30:12.125');
    expect(localDateStamp('2026-11-01T09:30:00Z')).toBe('2026-11-01T01:30:00');
  });

  it('derives named-zone offsets by date and retains seconds and fractions across day boundaries', () => {
    expect(localDateStamp('2026-10-15T09:30[Asia/Tokyo]')).toBe('2026-10-14T17:30');
    expect(localDateStamp('2026-01-15T09:30[Asia/Tokyo]')).toBe('2026-01-14T16:30');
    expect(localDateStamp('2026-10-15T09:30:12.125[Asia/Kathmandu]')).toBe('2026-10-14T20:45:12.125');
    expect(dateTimeAttribute('2026-10-15T09:30[America/Los_Angeles]')).toBe('2026-10-15T16:30:00.000Z');
    expect(dateTimeAttribute('2026-01-15T09:30[America/Los_Angeles]')).toBe('2026-01-15T17:30:00.000Z');
  });

  it('uses the first repeated clock by default and allows a matching offset to select the second', () => {
    expect(dateTimeAttribute('2026-11-01T01:30[America/Los_Angeles]')).toBe('2026-11-01T08:30:00.000Z');
    expect(dateTimeAttribute('2026-11-01T01:30-08:00[America/Los_Angeles]')).toBe('2026-11-01T09:30:00.000Z');
  });

  it('consumes complete bracketed timezone and interval handles in natural prose', () => {
    const handle = '#date/2026-10-15T09:30[America/Los_Angeles]';
    const interval = `${handle}/2026-10-15T10:30[America/Los_Angeles]`;
    const source = `Meet (${handle}). Window ${interval}!`;
    const mentions = dateMentions(source);
    expect(mentions.map(({ ref }) => dateHandle(ref))).toEqual([handle, interval]);
    for (const mention of mentions) expect(source.slice(mention.index, mention.index + mention.length)).toBe(dateHandle(mention.ref));
  });
});
