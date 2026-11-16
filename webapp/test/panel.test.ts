// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSidePanel, type PanelView, type SidePanelState } from '../src/side-panel';
import { createModal } from '../src/modal';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  localStorage.clear();
});

function setup() {
  document.body.innerHTML = '<button id="summary-trigger">Summary</button>' +
    '<aside id="side-panel" hidden inert><div id="side-panel-body"></div></aside>' +
    '<div id="pill-summary"></div><input id="other">';
  const state: SidePanelState = { filter: null };
  const setAvailable = vi.fn();
  const fallback = document.getElementById('summary-trigger')!;
  const panel = document.getElementById('side-panel')!;
  const body = document.getElementById('side-panel-body')!;
  const api = createSidePanel({ state, setAvailable, focusFallback: () => fallback });
  return { state, setAvailable, fallback, panel, body, api };
}

describe('automatic summary availability and retained state', () => {
  it('reports availability without opening a panel or saving a manual preference', () => {
    const { state, setAvailable, panel, body, api } = setup();
    body.innerHTML = '<h2 class="entity-title">Existing instance summary</h2>';
    const summary = body.firstElementChild;
    localStorage.setItem('panelCollapsed', 'true');
    localStorage.setItem('panelWidth', '620');

    api.showPanelElement();
    expect(setAvailable).toHaveBeenLastCalledWith(true);
    expect(panel.hidden).toBe(true);
    expect(panel.inert).toBe(true);
    expect(panel.classList.contains('is-instance')).toBe(true);
    expect(body.firstElementChild).toBe(summary);

    state.filter = { type: 'project', id: 'project' };
    api.showPanelElement();
    expect(panel.classList.contains('is-instance')).toBe(false);
    api.closeSidePanel();
    expect(setAvailable).toHaveBeenLastCalledWith(false);
    expect(localStorage.getItem('panelCollapsed')).toBe('true');
    expect(localStorage.getItem('panelWidth')).toBe('620');
  });

  it('retains one summary body and its history state when moved into the pill', () => {
    const { body, api } = setup();
    body.innerHTML = '<h3 class="related-heading" data-section="Projects" data-expanded="2">Projects</h3>' +
      '<h3 class="related-heading" data-section="Scheduled" data-expanded="past future">Scheduled</h3>';
    body.scrollTop = 84;
    const expected: PanelView = { scrollTop: 84, expanded: ['Projects', 'Projects', 'Scheduled::past', 'Scheduled::future'] };
    expect(api.panelSnapshot()).toEqual(expected);

    document.getElementById('pill-summary')!.append(body);
    expect(api.panelSnapshot()).toEqual(expected);
    history.replaceState({ search: 'release', anchor: { id: 'entry' } }, '', '/work/');
    api.stampPanel();
    expect(history.state).toMatchObject({ search: 'release', anchor: { id: 'entry' }, panel: expected });
  });

  it('restores folded sections and scroll before accepting a new history snapshot', async () => {
    const { body, api } = setup();
    document.getElementById('pill-summary')!.append(body);
    body.innerHTML = '<h3 class="related-heading" data-section="Projects">Projects</h3>' +
      '<button class="related-more" data-section="Projects">More</button>';
    const heading = body.querySelector<HTMLElement>('.related-heading')!;
    body.querySelector('button')!.addEventListener('click', () => {
      heading.dataset.expanded = String(Number(heading.dataset.expanded ?? 0) + 1);
    });
    history.replaceState({ panel: 'before' }, '', '/work/');
    api.restorePanelView(body, { expanded: ['Projects', 'Projects'], scrollTop: 120 });
    expect(heading.dataset.expanded).toBe('2');
    expect(body.scrollTop).toBe(120);
    api.stampPanel();
    expect(history.state.panel).toBe('before');
    await vi.waitFor(() => expect(api.isPanelRestoring()).toBe(false));
    api.stampPanel();
    expect(history.state.panel).toEqual({ scrollTop: 120, expanded: ['Projects', 'Projects'] });
  });

  it('restores an equivalent focused link after the mounted summary is refreshed', () => {
    const { body, api } = setup();
    document.getElementById('pill-summary')!.append(body);
    body.innerHTML = '<a href="/work/project/release">Release</a>';
    body.querySelector<HTMLElement>('a')!.focus();
    const previous = api.holdPanelFocus(body);
    expect(document.activeElement).toBe(body);
    body.innerHTML = '<h2 class="entity-title">Work</h2><a href="/work/project/release">Renamed release</a>';
    api.restorePanelFocus(body, previous);
    expect(document.activeElement).toBe(body.querySelector('a'));
  });

  it('keeps restored scroll while the retained body is hidden, then records visible scrolling', async () => {
    const { body, api } = setup();
    api.restorePanelView(body, { scrollTop: 120, expanded: [] });
    // Browsers can report zero when a retained body is under display:none.
    body.scrollTop = 0;
    expect(api.panelSnapshot()?.scrollTop).toBe(120);
    await vi.waitFor(() => expect(api.isPanelRestoring()).toBe(false));
    api.stampPanel();
    expect(history.state.panel.scrollTop).toBe(120);
    document.getElementById('pill-summary')!.append(body);
    body.scrollTop = 72;
    expect(api.panelSnapshot()?.scrollTop).toBe(72);
    expect(body.dataset.panelScroll).toBe('72');
  });

  it('falls back to the active frame control without removing its native tab stop', () => {
    const { fallback, body, api } = setup();
    document.getElementById('pill-summary')!.append(body);
    body.innerHTML = '<a href="/work/project/release">Release</a>';
    body.querySelector<HTMLElement>('a')!.focus();
    const previous = api.holdPanelFocus(body);
    body.replaceChildren();
    api.restorePanelFocus(body, previous);
    expect(document.activeElement).toBe(fallback);
    expect(fallback.tabIndex).toBe(0);
  });

  it('leaves intentional outside focus and an unrelated settings modal alone', () => {
    const { fallback, body, api } = setup();
    document.getElementById('pill-summary')!.append(body);
    body.innerHTML = '<a href="/work/project/release">Release</a>';
    body.querySelector<HTMLElement>('a')!.focus();
    const previous = api.holdPanelFocus(body);
    document.getElementById('other')!.focus();
    api.restorePanelFocus(body, previous);
    expect(document.activeElement).toBe(document.getElementById('other'));

    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<button>Settings</button>';
    document.body.append(dialog);
    const modal = createModal(dialog, { dismiss: () => modal.close(0), beforeOpen() {}, fallback: () => fallback, duration: () => 0 });
    modal.open();
    const modalFocus = document.activeElement;
    expect(api.holdPanelFocus(body)).toBeNull();
    api.restorePanelFocus(body, previous);
    expect(document.activeElement).toBe(modalFocus);
    modal.close(0);
  });
});
