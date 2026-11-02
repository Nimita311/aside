import { describe, expect, it } from 'vitest';
import { scheduleInstant, wallTimeAt } from '../src/core/scheduling.js';

describe('named schedule instants', () => {
  it('converts across a day boundary without modifying the authored wall time', () => {
    expect(scheduleInstant('2026-10-03T10:00', 'Asia/Tokyo')).toBe(Date.parse('2026-10-03T01:00:00Z'));
    expect(wallTimeAt(Date.parse('2026-10-03T01:00:00Z'), 'America/Los_Angeles')).toBe('2026-10-02T18:00');
  });
  it('uses the first repeated-hour occurrence and rejects nonexistent and invalid zones', () => {
    expect(scheduleInstant('2026-11-01T01:30', 'America/Los_Angeles')).toBe(Date.parse('2026-11-01T08:30:00Z'));
    expect(scheduleInstant('2026-03-08T02:30', 'America/Los_Angeles')).toBeUndefined();
    expect(scheduleInstant('2026-10-03T10:00', 'Mars/Olympus')).toBeUndefined();
  });
  it('handles half-hour DST transitions as well as one-hour transitions', () => {
    expect(scheduleInstant('2026-04-05T01:45', 'Australia/Lord_Howe')).toBe(Date.parse('2026-04-04T14:45:00Z'));
    expect(scheduleInstant('2026-10-04T02:15', 'Australia/Lord_Howe')).toBeUndefined();
  });
  it('keeps dates zone-independent and supports early Gregorian years', () => {
    expect(scheduleInstant('2026-10-03', 'Asia/Tokyo')).toBe(scheduleInstant('2026-10-03'));
    expect(wallTimeAt(scheduleInstant('0001-01-03T10:00', 'UTC')!, 'UTC')).toBe('0001-01-03T10:00');
  });
});
