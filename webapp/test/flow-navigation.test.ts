// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { dateJumpCard } from '../src/flow-navigation';
function flow(ids: string[]) {
  const host = document.createElement('main');
  for (const id of ids) { const card = document.createElement('article'); card.dataset.entryId = id; host.append(card); }
  return host;
}
describe('calendar-date landing within the current view', () => {
  it('clamps before-oldest to oldest, after-newest to newest, and otherwise to nearest earlier', () => {
    const host = flow(['2026-06-03T12:00', '2024-02-02T09:00', '2023-01-01T10:00']);
    expect(dateJumpCard(host, '2020-01-01T23:59:59')?.dataset.entryId).toBe('2023-01-01T10:00');
    expect(dateJumpCard(host, '2030-01-01T23:59:59')?.dataset.entryId).toBe('2026-06-03T12:00');
    expect(dateJumpCard(host, '2025-01-01T23:59:59')?.dataset.entryId).toBe('2024-02-02T09:00');
    expect(dateJumpCard(host, '2024-02-02T23:59:59')?.dataset.entryId).toBe('2024-02-02T09:00');
  });
  it('uses only filtered cards, leaves empty views alone, and avoids asserting an incomplete oldest bound', () => {
    const filtered = flow(['2025-06-02T09:00', '2024-06-02T09:00']);
    expect(dateJumpCard(filtered, '2020-01-01T23:59:59')?.dataset.entryId).toBe('2024-06-02T09:00');
    expect(dateJumpCard(flow([]), '2020-01-01T23:59:59')).toBeNull();
    expect(dateJumpCard(filtered, '2020-01-01T23:59:59', false)).toBeNull();
  });
});

describe('oldest-first query navigation', () => {
  const ids = ['2023-01-01T10:00', '2024-02-02T09:00', '2026-06-03T12:00'];
  it('uses chronological date landing independently of displayed order', () => {
    const host = flow(ids);
    expect(dateJumpCard(host, '2025-01-01T23:59:59')?.dataset.entryId).toBe(ids[1]);
    expect(dateJumpCard(host, '2030-01-01T23:59:59')?.dataset.entryId).toBe(ids[2]);
    expect(dateJumpCard(host, '2020-01-01T23:59:59')?.dataset.entryId).toBe(ids[0]);
  });
});
