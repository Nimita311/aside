// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import { loadApp } from './app-harness';

interface App {
  state: { store: Store | null; instanceId: string | null; panelCollapsed: boolean };
  applyStoredPanelWidth(): void;
  setupPanelResize(): void;
  expandPanel(): void;
}
const resizeListeners: (() => void)[] = [];
const originalWidth = window.innerWidth;
function viewport(width: number) { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
afterEach(() => {
  for (const listener of resizeListeners.splice(0)) window.removeEventListener('resize', listener);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  document.body.replaceChildren(); document.documentElement.style.removeProperty('--side-panel-width');
  localStorage.clear(); viewport(originalWidth);
});

describe('keyboard panel sizing', () => {
  async function setup(saved = '400', width = 1024) {
    viewport(width); localStorage.setItem('panelWidth', saved);
    document.body.innerHTML = readFileSync('index.html', 'utf8').split('<body>')[1].split('</body>')[0]
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
    const store = new Store({
      async read(path) { return path === 'aside.md' ? { text: '---\nid: work\nname: Work\n---\n', version: '1' } : null; },
      async revalidate() { return 'unchanged'; }, async listYears() { return []; }, assetUrl() { return null; },
    });
    await store.init();
    const api = await loadApp<App>('state, applyStoredPanelWidth, setupPanelResize, expandPanel');
    api.state.store = store; api.state.instanceId = 'work'; api.state.panelCollapsed = false;
    api.applyStoredPanelWidth(); api.setupPanelResize(); resizeListeners.push(api.applyStoredPanelWidth);
    const panel = document.getElementById('side-panel')!, handle = document.getElementById('side-panel-resize')!;
    panel.hidden = false; panel.classList.add('is-open'); handle.focus();
    Object.defineProperty(panel, 'offsetWidth', { configurable: true, get: () => Number(handle.getAttribute('aria-valuenow')) });
    handle.setPointerCapture = vi.fn();
    vi.useFakeTimers();
    const key = (name: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
      handle.dispatchEvent(event); return event;
    };
    const assertWidth = (expected: number, persisted = String(expected)) => {
      expect(document.documentElement.style.getPropertyValue('--side-panel-width')).toBe(`${expected}px`);
      expect(handle.getAttribute('aria-valuenow')).toBe(String(expected));
      expect(handle.getAttribute('aria-valuetext')).toBe(`${expected} pixels wide`);
      expect(localStorage.getItem('panelWidth')).toBe(persisted);
    };
    return { api, handle, panel, key, assertWidth };
  }

  it('exposes the controlled pane, vertical orientation, accessible key help and valid size range', async () => {
    const { handle, assertWidth } = await setup();
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-controls')).toBe('side-panel');
    expect(handle.getAttribute('aria-label')).toBe('Details panel width');
    const help = document.getElementById(handle.getAttribute('aria-describedby')!)!;
    expect(help.textContent).toContain('Shift+Enter');
    expect(help.textContent).toContain('Home and End');
    expect(handle.getAttribute('aria-valuemin')).toBe('280');
    expect(handle.getAttribute('aria-valuemax')).toBe('720');
    assertWidth(400);
  });

  it('moves the left edge horizontally with arrows, preserves focus and persists the result', async () => {
    const { handle, key, assertWidth } = await setup();
    expect(key('ArrowLeft').defaultPrevented).toBe(true); assertWidth(410);
    key('ArrowRight'); assertWidth(400);
    key('ArrowRight', { shiftKey: true }); assertWidth(350);
    key('ArrowLeft', { shiftKey: true }); assertWidth(400);
    expect(document.activeElement).toBe(handle);
    expect(key('ArrowLeft', { metaKey: true }).defaultPrevented).toBe(false);
    expect(key('ArrowDown').defaultPrevented).toBe(false); assertWidth(400);
  });

  it('uses Home/End for bounded widths without retracting and updates viewport-dependent bounds', async () => {
    const { api, handle, key, assertWidth } = await setup();
    key('Home'); assertWidth(280); key('ArrowRight'); assertWidth(280);
    expect(api.state.panelCollapsed).toBe(false);
    key('End'); assertWidth(720); key('ArrowLeft'); assertWidth(720);
    viewport(400); window.dispatchEvent(new Event('resize'));
    assertWidth(360, '720'); expect(handle.getAttribute('aria-valuemax')).toBe('360');
    key('ArrowRight'); assertWidth(350);
    viewport(1024); window.dispatchEvent(new Event('resize')); assertWidth(350);
  });

  it('keeps min/current/max consistent when the viewport is narrower than the ordinary minimum', async () => {
    const { handle, key, assertWidth } = await setup('400', 300);
    assertWidth(270, '400');
    expect(handle.getAttribute('aria-valuemin')).toBe('270');
    expect(handle.getAttribute('aria-valuemax')).toBe('270');
    key('Home'); assertWidth(270); key('End'); assertWidth(270);
  });

  it('fits the margin with Shift+Enter using the same snap operation as double-click', async () => {
    const { panel, handle, key, assertWidth } = await setup();
    vi.spyOn(document.getElementById('flow')!, 'getBoundingClientRect').mockReturnValue({ right: 640 } as DOMRect);
    expect(key('Enter', { shiftKey: true }).defaultPrevented).toBe(true);
    assertWidth(384); expect(panel.classList.contains('is-snapping')).toBe(true);
    expect(document.activeElement).toBe(handle);
    await vi.advanceTimersByTimeAsync(250); expect(panel.classList.contains('is-snapping')).toBe(false);
    key('ArrowLeft'); assertWidth(394);
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); assertWidth(384);
  });

  it('retracts with Enter and hands focus to the named expand control, preserving the chosen width', async () => {
    const { api, panel, key, assertWidth } = await setup();
    expect(key('Enter').defaultPrevented).toBe(true);
    expect(api.state.panelCollapsed).toBe(true); expect(panel.inert).toBe(true);
    const expand = document.querySelector<HTMLElement>('.filter-pill-label')!;
    expect(document.activeElement).toBe(expand);
    expect(expand.getAttribute('aria-label')).toBe('Expand panel: Work'); assertWidth(400);
    await vi.advanceTimersByTimeAsync(250); expect(panel.hidden).toBe(true);
    expand.click(); await vi.advanceTimersByTimeAsync(250);
    expect(panel.inert).toBe(false); expect(panel.hidden).toBe(false); assertWidth(400);
    expect(document.activeElement).toBe(document.getElementById('btn-side-panel-collapse'));
  });

  it('updates the same values for pointer resizing and transfers focused handle on drag-to-fold', async () => {
    const { api, handle, assertWidth } = await setup();
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 574, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })); assertWidth(450);
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 2 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 800, pointerId: 2 }));
    handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }));
    expect(api.state.panelCollapsed).toBe(true); assertWidth(450);
    expect(document.activeElement).toBe(document.querySelector('.filter-pill-label'));
  });
});
