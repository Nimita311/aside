// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { dateJumpCard, quickJumpCard } from '../src/flow-navigation';
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

describe('quick period landing within the current view', () => {
  const ids = ['2026-06-03T12:00', '2024-02-02T09:00', '2023-01-01T10:00'];

  it('crosses gaps larger than the chosen period in both directions', () => {
    const host = flow(ids);
    expect(quickJumpCard(host, '2026-05-27T12:00:00', '2026-06-03', -1)?.dataset.entryId).toBe(ids[1]);
    expect(quickJumpCard(host, '2024-02-09T12:00:00', '2024-02-02', 1)?.dataset.entryId).toBe(ids[0]);
  });

  it('selects the entry closest to the target among dates in the step direction', () => {
    const host = flow(['2026-06-20T10:00', '2026-06-12T09:00', '2026-06-10T10:00', '2026-06-03T12:00']);
    expect(quickJumpCard(host, '2026-06-11T12:00:00', '2026-06-03', 1)?.dataset.entryId).toBe('2026-06-12T09:00');
    expect(quickJumpCard(host, '2026-06-11T12:00:00', '2026-06-20', -1)?.dataset.entryId).toBe('2026-06-12T09:00');
    expect(quickJumpCard(host, '2026-06-10T10:00', '2026-06-20', -1)?.dataset.entryId).toBe('2026-06-10T10:00');
  });

  it('avoids landing on another entry on the current day', () => {
    const host = flow(['2026-06-03T23:00', '2026-06-03T08:00', '2024-02-02T09:00']);
    expect(quickJumpCard(host, '2026-05-27T12:00:00', '2026-06-03', -1)?.dataset.entryId).toBe('2024-02-02T09:00');
    expect(quickJumpCard(host, '2026-06-10T12:00:00', '2026-06-03', 1)).toBeNull();
  });

  it('holds at either boundary and in empty views', () => {
    const host = flow(ids);
    expect(quickJumpCard(host, '2026-06-10T12:00:00', '2026-06-03', 1)).toBeNull();
    expect(quickJumpCard(host, '2022-12-25T12:00:00', '2023-01-01', -1)).toBeNull();
    expect(quickJumpCard(flow([]), '2026-06-10T12:00:00', '2026-06-03', 1)).toBeNull();
  });
});
