// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.documentElement.style.removeProperty('--timeline-time-offset');
  document.documentElement.style.removeProperty('--flow-gutter');
  delete document.documentElement.dataset.timelineLayout;
});

describe('standard metadata baseline', () => {
  it.each([[14.5, 14, 0.5], [14, 14.5, -0.5]])('uses the font baselines (%s / %s) independently of entries', async (pillBaseline, timeBaseline, expected) => {
    vi.resetModules();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      let top = 0;
      if (this.classList.contains('tag')) top = 40;
      else if (this.classList.contains('em-time')) top = 80;
      else if (this.classList.contains('metadata-baseline-marker')) top = this.closest('.tag') ? 40 + pillBaseline : 80 + timeBaseline;
      return { top, bottom: top + 20, width: 40, height: 20 } as DOMRect;
    });
    const { refreshTimelineGutter } = await import('../src/date-time-settings');
    refreshTimelineGutter({ timeFormat: '24h' });
    expect(document.documentElement.style.getPropertyValue('--timeline-time-offset')).toBe(`${expected}px`);
    expect(document.querySelector('.entry-card')).toBeNull();
    expect(document.body.children.length).toBe(0);
  });
});
