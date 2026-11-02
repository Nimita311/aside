import { describe, it, expect } from 'vitest';
import {
  buildMarker,
  parseMarker,
  durationMinutes,
  addMinutesWall,
  startFromScheduled,
} from '../src/mcp/calendar/markers.js';

describe('markers', () => {
  it('builds active (bare) and suffixed markers, with a hostname and encoded action IDs', () => {
    expect(buildMarker('work', '2026-05-15-deploy', 'active')).toBe('aside://work/action/2026-05-15-deploy');
    expect(buildMarker('work', '2026-05-15-deploy', 'done')).toBe('aside://work/action/2026-05-15-deploy/done');
    expect(buildMarker('work', '2026-05-15-deploy', 'backlog')).toBe('aside://work/action/2026-05-15-deploy/backlog');
  });

  it('round-trips bare and suffixed markers', () => {
    expect(parseMarker('aside://work/action/2026-05-15-deploy')).toEqual({
      instance: 'work',
      actionId: '2026-05-15-deploy',
      state: 'active',
    });
    expect(parseMarker('aside://work/action/x/done')).toEqual({ instance: 'work', actionId: 'x', state: 'done' });
  });

  // Action IDs remain percent-encoded; the instance is a canonical hostname.
  it('round-trips non-ASCII action ids through every state', () => {
    for (const [instance, actionId] of [
      ['work', '2026-05-15-部署'],
      ['cafe', 'tâche-écrite'],
      ['work', 'a/b spaced & odd'], // reserved chars in the id, incl. a slash
    ] as const) {
      for (const state of ['active', 'done', 'cancelled', 'backlog'] as const) {
        const marker = buildMarker(instance, actionId, state);
        expect(marker).toMatch(/^[\x20-\x7E]+$/); // pure ASCII => no host/punycode mangling
        expect(parseMarker(marker)).toEqual({ instance, actionId, state });
      }
    }
  });

  it('normalizes suffix aliases case-insensitively', () => {
    expect(parseMarker('aside://w/action/x/COMPLETE')?.state).toBe('done');
    expect(parseMarker('aside://w/action/x/deschedule')?.state).toBe('backlog');
    expect(parseMarker('aside://w/action/x/cancel')?.state).toBe('cancelled');
  });

  it('rejects non-aside URLs, hostless markers, unknown suffixes, and bad encoding', () => {
    expect(parseMarker('https://example.com/x')).toBeNull();
    expect(parseMarker('aside:///work/action/x')).toBeNull(); // no legacy runtime format
    expect(parseMarker('aside://w/action/x/bogus')).toBeNull(); // unknown suffix
    expect(parseMarker('aside://w/action/%E0%A4%A')).toBeNull(); // malformed percent-encoding
  });

  it('parses fixed ISO durations and defaults only when omitted', () => {
    expect(durationMinutes('PT1H')).toBe(60);
    expect(durationMinutes('PT1H30M')).toBe(90);
    expect(durationMinutes('PT45M')).toBe(45);
    expect(durationMinutes(undefined)).toBe(30);
    expect(durationMinutes('P1D')).toBe(1440);
    expect(() => durationMinutes('garbage')).toThrow('duration');
    expect(() => durationMinutes('PT0M')).toThrow('duration');
  });

  it('adds minutes across hour and day rollovers', () => {
    expect(addMinutesWall('2026-05-15T10:00', 30)).toBe('2026-05-15T10:30');
    expect(addMinutesWall('2026-05-15T23:50', 30)).toBe('2026-05-16T00:20');
    expect(addMinutesWall('2026-12-31T23:30', 60)).toBe('2027-01-01T00:30');
  });

  it('treats a date-only scheduled as all-day, a timed one as not', () => {
    expect(startFromScheduled('2026-05-15T10:00')).toEqual({ start: '2026-05-15T10:00', allDay: false });
    expect(() => startFromScheduled('2026-05-15T10:00:00')).toThrow('scheduled');
    expect(startFromScheduled('2026-05-15')).toEqual({ start: '2026-05-15T00:00', allDay: true });
  });
});
