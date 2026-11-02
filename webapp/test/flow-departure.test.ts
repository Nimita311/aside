// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { animateFlow, snapshotFlow } from '../src/flip';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function fixture(reduced = false) {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: reduced } as MediaQueryList);
  document.body.innerHTML = '<h1 class="app-title"><a href="/">Aside</a></h1><button class="filter-pill-label">Expand selected project</button><div id="pane"><article class="entry-card" data-entry-id="2026-10-04T10:00"><a href="/work/project/example">Project</a></article></div>';
  const pane = document.querySelector<HTMLElement>('#pane')!, card = pane.querySelector<HTMLElement>('.entry-card')!;
  const rect = { top: 0, bottom: 100, left: 0, right: 500, width: 500, height: 100 } as DOMRect;
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(rect);
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(rect);
  const scope = document.querySelector<HTMLButtonElement>('.filter-pill-label')!;
  const home = document.querySelector<HTMLAnchorElement>('.app-title a')!;
  vi.spyOn(scope, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList);
  vi.spyOn(home, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList);
  const link = card.querySelector<HTMLAnchorElement>('a')!;
  return { pane, scope, home, link };
}

describe('departing flow content', () => {
  it.each([false, true])('moves focus to the visible scope before discarding a focused record (reduced=%s)', reduced => {
    const { pane, scope, link } = fixture(reduced);
    link.focus(); snapshotFlow(pane); pane.replaceChildren();
    expect(document.activeElement).toBe(scope);
  });

  it('skips an inactive scope and leaves an intentional focus destination alone', () => {
    const { pane, scope, home, link } = fixture();
    scope.inert = true; link.focus(); snapshotFlow(pane);
    expect(document.activeElement).toBe(home);
    scope.inert = false; scope.focus(); snapshotFlow(pane);
    expect(document.activeElement).toBe(scope);
  });

  it('excludes departed links from interaction and accessibility throughout their visual flight', async () => {
    const { pane } = fixture();
    const snapshot = snapshotFlow(pane)!;
    pane.replaceChildren();
    let finish!: () => void;
    vi.spyOn(snapshot[0].el, 'animate').mockReturnValue({ finished: new Promise<void>(resolve => { finish = resolve; }) } as unknown as Animation);
    const departing = animateFlow(pane, snapshot);
    const overlay = document.querySelector<HTMLElement>('.flow-ghosts')!;
    expect(overlay.querySelector('a')).not.toBeNull();
    expect(overlay.inert).toBe(true); expect(overlay.getAttribute('aria-hidden')).toBe('true');
    finish(); await departing;
    expect(document.querySelector('.flow-ghosts')).toBeNull();
  });
});
