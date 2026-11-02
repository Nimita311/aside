import { describe, expect, it } from 'vitest';
import { animationSpeed, dateFormat, timeStyle, timeFormat } from '../src/preferences';

describe('animation preferences', () => {
  it('retains supported speeds including Off and normalizes unsupported persisted values', () => {
    for (const [value, expected] of [['0', 0], ['0.5', 0.5], ['1', 1], ['2', 2]] as const) expect(animationSpeed(value)).toBe(expected);
    for (const value of [null, '', '5', '10', '-1', 'NaN', 'Infinity', 'broken']) expect(animationSpeed(value)).toBe(1);
  });
});

describe('date and time preferences', () => {
  it('defaults new users to localized medium dates, short times, and the locale clock', () => {
    expect(dateFormat(null)).toBe('medium');
    expect(timeStyle(null)).toBe('short');
    expect(timeFormat(null)).toBe('locale');
  });
  it('retains existing clock preferences and normalizes unsupported saved choices', () => {
    expect(timeFormat('12h')).toBe('12h');
    expect(timeFormat('24h')).toBe('24h');
    expect(dateFormat('iso')).toBe('iso');
    expect(timeStyle('full')).toBe('full');
    expect(dateFormat('broken')).toBe('medium');
    expect(timeStyle('broken')).toBe('short');
    expect(timeFormat('broken')).toBe('locale');
  });
});
