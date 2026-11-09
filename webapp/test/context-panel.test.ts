// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContextPanel, resolveContextResize, type ContextPanelMode } from '../src/context-panel';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren();
  localStorage.clear();
});

function setup() {
  document.body.innerHTML = '<button id="trigger">Inspect</button><div id="frame"><aside id="side-panel" hidden>' +
    '<button id="btn-context-back">Previous</button><button id="btn-context-forward">Next</button>' +
    '<button id="btn-context-timeline" class="btn-icon context-timeline-toggle context-panel-action" hidden>' +
    '<span class="context-filter-icon"></span><span class="context-jump-icon"></span></button>' +
    '<button id="btn-context-fullscreen">Full screen</button><button id="btn-context-expand">Expand</button>' +
    '<div id="context-panel-view" role="tablist" hidden><button id="btn-context-content" role="tab" aria-controls="side-panel-body">Content</button>' +
    '<button id="btn-context-overview" role="tab" aria-controls="side-panel-body">Overview</button></div>' +
    '<button id="btn-side-panel-close">Close</button><div id="side-panel-body"><h1>Release</h1></div>' +
    '<button id="side-panel-resize" role="separator">Resize</button></aside></div>' +
    '<button id="other">Other control</button><a id="reference" href="#release">Release reference</a>';
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const host = $('side-panel'), body = $('side-panel-body');
  let width = 1600, gutter = 400;
  Object.defineProperty(host, 'getBoundingClientRect', { value: () => ({ width: Number.parseFloat(host.style.getPropertyValue('--context-panel-width')), right: width }) });
  Object.defineProperty($('frame'), 'getBoundingClientRect', { value: () => ({ right: width }) });
  const changed = vi.fn(), onDismiss = vi.fn(), onBack = vi.fn(), onForward = vi.fn();
  const api = createContextPanel(host, body, {
    fallback: () => $('trigger'), gutterWidth: () => gutter, viewportWidth: () => width,
    changed, onDismiss, onBack, onForward, duration: () => 300,
    shouldDismiss: event => !(event.target instanceof Element && event.target.closest('a, #trigger')),
  });
  api.setup(); api.update({ available: true });
  cleanups.push(api.destroy);
  return { $, host, body, api, changed, onDismiss, onBack, onForward,
    resize: (next: number) => { width = next; api.layout(); },
    windowResize: (next: number) => { width = next; window.dispatchEvent(new Event('resize')); },
    dimensions: (next: number) => { width = next; },
    gutter: (next: number) => { gutter = next; api.layout(); },
  };
}

describe('context panel presentation', () => {
  it('keeps one body and remembers the expanded configuration after dismissal', () => {
    const f = setup();
    const heading = f.body.firstElementChild;
    f.api.open();
    f.$('btn-context-expand').click();
    expect(f.api.getState()).toMatchObject({ open: true, mode: 'expanded', width: 880 });
    expect(f.host.dataset.detail).toBe('expanded');
    expect(f.host.style.getPropertyValue('--context-content-width')).toBe('879px');
    f.api.close({ animate: false });
    f.api.open();
    expect(f.api.getState().mode).toBe('expanded');
    expect(f.body.firstElementChild).toBe(heading);
    expect(localStorage.getItem('contextPanelMode')).toBe('expanded');
    f.$('btn-context-expand').click();
    expect(f.api.getState().width).toBe(304);
  });

  it('enables full screen only in expanded mode and preserves the chosen width afterward', () => {
    const f = setup(); f.api.open();
    expect(f.$<HTMLButtonElement>('btn-context-fullscreen').disabled).toBe(true);
    f.api.toggleFullscreen();
    expect(f.api.getState().fullscreen).toBe(false);
    f.api.setMode('expanded');
    f.api.toggleFullscreen();
    expect(f.api.getState()).toMatchObject({ fullscreen: true, width: window.innerWidth });
    expect(f.host.dataset.extent).toBe('fullscreen');
    expect(f.$<HTMLButtonElement>('side-panel-resize').disabled).toBe(true);
    f.api.toggleFullscreen();
    expect(f.api.getState().width).toBe(880);
  });

  it('keeps hover titles in sync with the action shown by each control', () => {
    const f = setup(); f.api.open();
    expect(f.$('btn-context-expand').title).toBe('Expand details');
    f.api.setMode('expanded');
    expect(f.$('btn-context-expand').title).toBe('Contract to summary');
    f.api.toggleFullscreen();
    expect(f.$('btn-context-fullscreen').title).toBe('Exit full screen');
    f.api.toggleFullscreen();
    expect(f.$('btn-context-fullscreen').title).toBe('Full screen');
  });

  it('moves focus out of concealed details without pulling it back from another control', () => {
    const f = setup();
    f.body.insertAdjacentHTML('beforeend', '<section data-context-detail><a href="#record">Linked record</a></section>');
    f.api.open(); f.api.setMode('expanded');
    const reference = f.body.querySelector<HTMLElement>('a')!;
    reference.focus();
    f.api.setMode('summary');
    expect(document.activeElement).toBe(f.$('btn-context-expand'));
    f.api.setMode('expanded'); reference.focus(); f.$('other').focus();
    f.api.setMode('summary');
    expect(document.activeElement).toBe(f.$('other'));
  });

  it('focuses the visible HTML frame when fullscreen hides the native entity title', () => {
    const f = setup();
    f.body.querySelector('h1')!.className = 'entity-title';
    f.body.insertAdjacentHTML('beforeend', '<section data-context-detail><iframe class="asset-webpage" title="Dashboard"></iframe></section>');
    const style = document.createElement('style');
    style.textContent = '#side-panel[data-extent="fullscreen"] .entity-title { display: none; }';
    document.body.append(style);
    f.api.open(); f.api.setMode('expanded'); f.api.toggleFullscreen();
    f.api.open({ focus: true });
    expect(document.activeElement).toBe(f.body.querySelector('iframe'));
  });

  it('makes concealed details inert without replacing embedded content during mode changes', () => {
    const f = setup();
    f.body.insertAdjacentHTML('beforeend', '<section data-context-detail><iframe title="Dashboard"></iframe></section>');
    const detail = f.body.querySelector<HTMLElement>('[data-context-detail]')!, iframe = detail.firstElementChild;
    f.api.open(); expect(detail.inert).toBe(true);
    f.api.setMode('expanded'); expect(detail.inert).toBe(false);
    f.api.setMode('summary'); expect(detail.inert).toBe(true);
    expect(detail.firstElementChild).toBe(iframe);
    const fresh = document.createElement('section'); fresh.dataset.contextDetail = '';
    f.body.append(fresh); f.api.layout();
    expect(fresh.inert).toBe(true);
  });

  it('shows the selector only when expanded and starts each expansion on Overview', () => {
    const f = setup();
    f.body.innerHTML = '<div class="context-content"><h1 data-context-view="overview">Release</h1>' +
      '<div data-context-detail><div class="detail-body" data-context-view="content"><p>Release body.</p></div></div></div>';
    f.api.open();
    expect(f.$('context-panel-view').hidden).toBe(true);
    expect(f.api.getState().view).toBe('overview');
    f.api.setMode('expanded');
    expect(f.$('context-panel-view').hidden).toBe(false);
    expect(f.$<HTMLButtonElement>('btn-context-content').disabled).toBe(false);
    expect(f.$('btn-context-overview').getAttribute('aria-selected')).toBe('true');
    expect(f.body.getAttribute('role')).toBe('tabpanel');
    f.api.setView('content'); f.api.setMode('summary');
    expect(f.api.getState().view).toBe('overview');
    expect(f.body.hasAttribute('role')).toBe(false);
    f.api.setMode('expanded'); expect(f.api.getState().view).toBe('overview');
  });

  it('restores a saved expanded view after its content is mounted', () => {
    localStorage.setItem('contextPanelMode', 'expanded'); localStorage.setItem('contextPanelView', 'content');
    const f = setup();
    f.body.innerHTML = '<div class="context-content"><div data-context-detail><div class="detail-body" data-context-view="content">Saved body</div></div></div>';
    f.api.open();
    expect(f.api.getState()).toMatchObject({ mode: 'expanded', view: 'content' });
    expect(f.$('btn-context-content').getAttribute('aria-selected')).toBe('true');
  });

  it('switches views without resizing or remounting content and remembers each view’s scroll', () => {
    const f = setup();
    f.body.innerHTML = '<div class="context-content"><h1 data-context-view="overview">Release</h1>' +
      '<div data-context-detail><div class="detail-body" data-context-view="content"><iframe title="Dashboard"></iframe></div></div></div>';
    f.api.open(); f.api.setMode('expanded');
    const record = f.body.firstElementChild, iframe = f.body.querySelector('iframe');
    const width = f.host.style.getPropertyValue('--context-content-width');
    f.body.scrollTop = 64; f.$('btn-context-content').click();
    expect(f.api.getState().view).toBe('content'); expect(f.body.scrollTop).toBe(0);
    expect(f.host.style.getPropertyValue('--context-content-width')).toBe(width);
    expect(f.body.firstElementChild).toBe(record); expect(f.body.querySelector('iframe')).toBe(iframe);
    f.body.scrollTop = 123; f.$('btn-context-overview').click(); expect(f.body.scrollTop).toBe(64);
    f.$('btn-context-content').click(); expect(f.body.scrollTop).toBe(123);
    expect(localStorage.getItem('contextPanelView')).toBe('content');
    expect(f.host.dataset.toolbar).toBe('wide');
    f.resize(390); expect(f.host.dataset.toolbar).toBe('compact');
  });

  it('keeps Content across a loading target, then resets the scroll map for the new record', () => {
    const f = setup();
    const record = () => '<div class="context-content"><h1 data-context-view="overview">Record</h1>' +
      '<div data-context-detail><div class="detail-body" data-context-view="content"><p>Body</p></div></div></div>';
    f.body.innerHTML = record(); f.api.open(); f.api.setMode('expanded'); f.api.setView('content'); f.body.scrollTop = 123;
    f.body.replaceChildren(); f.api.layout();
    expect(f.api.getState().view).toBe('content');
    f.body.innerHTML = record(); f.api.layout();
    expect(f.api.getState().view).toBe('content'); expect(f.body.scrollTop).toBe(0);
    f.api.setView('overview'); expect(f.body.scrollTop).toBe(0);
    f.api.setView('content'); expect(f.body.scrollTop).toBe(0);
  });

  it('disables Content for empty records and ignores view annotations inside authored body content', () => {
    const f = setup();
    f.body.innerHTML = '<div class="context-content"><h1 data-context-view="overview">Empty</h1>' +
      '<div data-context-detail><div class="detail-body" data-context-view="content"></div></div></div>';
    f.api.open(); f.api.setMode('expanded'); f.api.setView('content');
    expect(f.$<HTMLButtonElement>('btn-context-content').disabled).toBe(true);
    expect(f.api.getState().view).toBe('overview');
    f.body.querySelector('.detail-body')!.innerHTML = '<p data-context-view="overview">Authored prose.</p>';
    f.api.layout(); f.api.setView('content');
    expect(f.body.querySelector<HTMLElement>('.detail-body p')!.inert).toBe(false);
    expect(f.api.getState().view).toBe('content');
  });

  it('supports roving tab focus and Arrow/Home/End navigation while skipping disabled Content', () => {
    const f = setup();
    f.body.innerHTML = '<div class="context-content"><div data-context-detail><div class="detail-body" data-context-view="content">Body</div></div></div>';
    f.api.open(); f.api.setMode('expanded');
    const content = f.$('btn-context-content'), overview = f.$('btn-context-overview');
    overview.focus(); overview.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(content); expect(content.tabIndex).toBe(0); expect(overview.tabIndex).toBe(-1);
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(overview); expect(f.api.getState().view).toBe('overview');
    overview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(content);
    f.body.querySelector('.detail-body')!.replaceChildren(); f.api.layout();
    expect(document.activeElement).toBe(overview);
    overview.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(overview);
  });

  it('makes inactive view regions inert and recovers focus to the selected tab or expansion control', () => {
    const f = setup();
    f.body.innerHTML = '<div class="context-content"><div data-context-view="overview"><button>Metadata action</button></div>' +
      '<div data-context-detail><div class="detail-body" data-context-view="content"><a href="#record">Body reference</a></div></div></div>';
    f.api.open(); f.api.setMode('expanded');
    const content = f.body.querySelector<HTMLElement>('.detail-body')!, overview = f.body.querySelector<HTMLElement>('[data-context-view="overview"]')!;
    overview.querySelector('button')!.focus(); f.api.setView('content');
    expect(overview.inert).toBe(true); expect(content.inert).toBe(false);
    expect(document.activeElement).toBe(f.$('btn-context-content'));
    content.querySelector('a')!.focus(); f.api.setView('overview');
    expect(content.inert).toBe(true); expect(overview.inert).toBe(false);
    expect(document.activeElement).toBe(f.$('btn-context-overview'));
    f.api.setMode('summary'); expect(document.activeElement).toBe(f.$('btn-context-expand'));
  });

  it('starts HTML fullscreen on Content and allows switching to Overview without resizing', () => {
    const f = setup();
    f.body.innerHTML = '<div class="context-content" data-context-presentation="html"><div data-context-view="overview">Dashboard metadata</div>' +
      '<div data-context-detail><iframe class="detail-body asset-webpage" data-context-view="content" title="Dashboard"></iframe></div></div>';
    f.api.open(); f.api.setMode('expanded');
    const iframe = f.body.querySelector<HTMLIFrameElement>('iframe')!;
    f.api.toggleFullscreen();
    expect(f.api.getState()).toMatchObject({ fullscreen: true, view: 'content' });
    expect(iframe.inert).toBe(false);
    const width = f.api.getState().width; f.api.setView('overview');
    expect(f.api.getState()).toMatchObject({ fullscreen: true, view: 'overview', width });
    expect(iframe.inert).toBe(true);
    f.api.setView('content'); expect(f.body.querySelector('iframe')).toBe(iframe); expect(iframe.inert).toBe(false);
  });

  it('resets Overview across resize mode boundaries and restores the chosen view when a drag is cancelled', () => {
    const f = setup();
    f.body.innerHTML = '<div class="context-content"><div data-context-detail><div class="detail-body" data-context-view="content">Body</div></div></div>';
    f.api.open(); f.api.setMode('expanded'); f.api.setView('content'); f.body.scrollTop = 93;
    const resizer = f.$('side-panel-resize');
    const pointer = (type: string, raw: number) => resizer.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: 1600 - raw, bubbles: true }));
    pointer('pointerdown', 880); pointer('pointermove', 375);
    expect(f.api.getState()).toMatchObject({ mode: 'summary', view: 'overview' });
    pointer('pointercancel', 375);
    expect(f.api.getState()).toMatchObject({ mode: 'expanded', view: 'content' }); expect(f.body.scrollTop).toBe(93);
    pointer('pointerdown', 880); pointer('pointermove', 375); pointer('pointerup', 375);
    expect(f.api.getState()).toMatchObject({ mode: 'summary', view: 'overview' });
    f.api.setMode('expanded'); expect(f.api.getState().view).toBe('overview');
  });

  it('forwards navigation without changing the chosen configuration', () => {
    const f = setup(); f.api.open(); f.api.setMode('expanded');
    f.api.update({ available: true, canBack: true });
    f.$('btn-context-back').click(); f.$('btn-context-forward').click();
    expect(f.onBack).toHaveBeenCalledOnce(); expect(f.onForward).not.toHaveBeenCalled();
    f.api.update({ available: true, canForward: true });
    f.$('btn-context-forward').click();
    expect(f.onForward).toHaveBeenCalledOnce();
    expect(f.api.getState().mode).toBe('expanded');
  });

  it('updates the fixed filter command without replacing its node or the record', () => {
    const f = setup(), original = vi.fn(), latest = vi.fn();
    const command = f.$<HTMLButtonElement>('btn-context-timeline');
    const filterIcon = command.querySelector('.context-filter-icon');
    const record = f.body.firstElementChild;
    expect(command.hidden).toBe(true);

    f.api.update({ available: true, timelineAction: { label: 'Filter timeline', active: false, onClick: original } });
    f.api.open();
    expect(command.hidden).toBe(false);
    expect(f.host.dataset.timelineAction).toBe('true');
    expect(command.dataset.command).toBe('filter');
    expect(command.getAttribute('aria-label')).toBe('Filter timeline');
    expect(command.title).toBe('Filter timeline');
    expect(command.getAttribute('aria-pressed')).toBe('false');
    command.click();
    expect(original).toHaveBeenCalledOnce();

    f.api.update({ available: true, timelineAction: { label: 'Filter timeline', active: true, onClick: latest } });
    f.api.setMode('expanded');
    command.click();
    expect(command.getAttribute('aria-pressed')).toBe('true');
    expect(latest).toHaveBeenCalledOnce();
    expect(original).toHaveBeenCalledOnce();
    expect(f.$('btn-context-timeline')).toBe(command);
    expect(command.querySelector('.context-filter-icon')).toBe(filterIcon);
    expect(f.body.firstElementChild).toBe(record);
    expect(f.body.querySelector('.context-timeline-toggle')).toBeNull();
  });

  it('changes a filter into one-shot navigation without a stale toggle state or callback', () => {
    const f = setup(), filter = vi.fn(), jump = vi.fn();
    const command = f.$<HTMLButtonElement>('btn-context-timeline');
    f.api.update({ available: true, timelineAction: { label: 'Filter timeline', active: true, onClick: filter } });
    f.api.open();
    expect(command.hasAttribute('aria-pressed')).toBe(true);

    f.api.update({ available: true, timelineAction: { label: 'Go to entry', onClick: jump } });
    expect(command.dataset.command).toBe('jump');
    expect(command.getAttribute('aria-label')).toBe('Go to entry');
    expect(command.title).toBe('Go to entry');
    expect(command.hasAttribute('aria-pressed')).toBe(false);
    command.click();
    expect(jump).toHaveBeenCalledOnce();
    expect(filter).not.toHaveBeenCalled();
  });

  it('hides unavailable contextual commands and moves their keyboard focus to a stable control', () => {
    const f = setup(), filter = vi.fn();
    const command = f.$<HTMLButtonElement>('btn-context-timeline');
    f.api.update({ available: true, timelineAction: { label: 'Filter timeline', active: true, onClick: filter } });
    f.api.open(); command.focus();
    expect(document.activeElement).toBe(command);

    // Instance, artifact and file contexts have no timeline command.
    f.api.update({ available: true });
    expect(command.hidden).toBe(true);
    expect(f.host.dataset.timelineAction).toBe('false');
    expect(command.hasAttribute('aria-pressed')).toBe(false);
    expect(document.activeElement).toBe(f.$('btn-context-expand'));
    command.click();
    expect(filter).not.toHaveBeenCalled();

    f.$('other').focus();
    f.api.update({ available: true });
    expect(document.activeElement).toBe(f.$('other'));
  });

  it('dismisses on an outside click while allowing reference and launcher handling', () => {
    const f = setup(); f.api.open();
    f.$('reference').click(); expect(f.api.getState().open).toBe(true);
    f.$('trigger').click(); expect(f.api.getState().open).toBe(true);
    f.body.click(); expect(f.api.getState().open).toBe(true);
    f.$('other').focus(); f.$('other').click();
    expect(f.api.getState().open).toBe(false);
    expect(f.onDismiss).toHaveBeenLastCalledWith('outside');
    expect(document.activeElement).toBe(f.$('other'));
  });

  it('makes closing content inert immediately and cancels stale animation cleanup on reopen', () => {
    vi.useFakeTimers();
    const f = setup(); f.$('trigger').focus(); f.api.open({ focus: true });
    vi.advanceTimersByTime(20);
    expect(f.host.classList.contains('is-open')).toBe(true);
    f.api.close();
    expect(f.host.hidden).toBe(false); expect(f.host.inert).toBe(true);
    expect(f.host.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(f.$('trigger'));
    f.api.open(); vi.advanceTimersByTime(400);
    expect(f.host.hidden).toBe(false); expect(f.host.inert).toBe(false);
    expect(f.host.classList.contains('is-open')).toBe(true);
  });

  it('reports user dismissal before a changed callback can trigger automatic frame opening', () => {
    const f = setup(); f.api.open();
    f.changed.mockClear(); f.onDismiss.mockClear();
    f.$('btn-side-panel-close').click();
    expect(f.onDismiss.mock.invocationCallOrder[0]).toBeLessThan(f.changed.mock.invocationCallOrder[0]);
  });

  it('clamps the destination canvas when viewport narrows without losing its width preference', () => {
    const f = setup(); f.api.open(); f.api.setMode('expanded');
    f.resize(390);
    expect(f.api.getState().width).toBe(390);
    expect(f.host.style.getPropertyValue('--context-content-width')).toBe('389px');
    f.resize(1600); expect(f.api.getState().width).toBe(880);
  });

  it('fits summary into a usable reader gutter and permits explicit overlays when the gutter is smaller', () => {
    const f = setup(); f.api.open();
    f.gutter(280); expect(f.api.getState().width).toBe(280);
    f.gutter(400); expect(f.api.getState().width).toBe(304);
    f.gutter(160); expect(f.api.getState().width).toBe(304);
    f.api.setMode('expanded'); f.gutter(280); expect(f.api.getState().width).toBe(880);
  });

  it('updates the destination canvas through compact viewport resizes without a frame state notification', () => {
    const f = setup(); f.windowResize(1088); f.api.open(); f.api.setMode('expanded');
    f.changed.mockClear();
    expect(f.host.style.getPropertyValue('--context-content-width')).toBe('879px');
    f.windowResize(390);
    expect(f.api.getState()).toMatchObject({ mode: 'expanded', width: 390 });
    expect(f.host.style.getPropertyValue('--context-content-width')).toBe('389px');
    expect(f.changed).not.toHaveBeenCalled();
    f.windowResize(1088);
    expect(f.host.style.getPropertyValue('--context-content-width')).toBe('879px');
  });

  it('tracks a fullscreen window resize and disposes its independent geometry listener', () => {
    let width = 1088;
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
    const f = setup(); f.api.open(); f.api.setMode('expanded'); f.api.toggleFullscreen();
    expect(f.api.getState().width).toBe(1088);
    width = 390; f.windowResize(390);
    expect(f.host.style.getPropertyValue('--context-content-width')).toBe('390px');
    f.api.destroy(); width = 500; f.windowResize(500);
    expect(f.host.style.getPropertyValue('--context-content-width')).toBe('390px');
  });

  it('observes the parent workspace when its geometry changes without a window resize', () => {
    let notify: (() => void) | undefined;
    const observe = vi.fn(), disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notify = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const f = setup(); f.api.open(); f.api.setMode('expanded');
    expect(observe).toHaveBeenCalledWith(f.$('frame'));
    f.dimensions(390); notify!();
    expect(f.host.style.getPropertyValue('--context-content-width')).toBe('389px');
    f.api.destroy(); expect(disconnect).toHaveBeenCalledOnce();
  });

  it('lets repeated keyboard steps pass the snap bands and dismiss below minimum', () => {
    const f = setup(); f.api.open();
    const resizer = f.$('side-panel-resize');
    for (let i = 0; i < 3; i++) resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(f.api.getState().open).toBe(false);
    expect(f.host.hidden).toBe(true);
    expect(f.onDismiss).toHaveBeenLastCalledWith('resize');
  });

  it('retains a resized width for the chosen mode and rolls a cancelled pointer drag back', () => {
    const f = setup(); f.api.open();
    const resizer = f.$('side-panel-resize');
    const pointer = (type: string, raw: number) => resizer.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: 1600 - raw, bubbles: true }));
    pointer('pointerdown', 304); pointer('pointermove', 350); pointer('pointerup', 350);
    expect(f.api.getState().width).toBe(350);
    f.api.setMode('expanded'); expect(f.api.getState().width).toBe(880);
    f.api.setMode('summary'); expect(f.api.getState().width).toBe(350);
    pointer('pointerdown', 350); pointer('pointermove', 450);
    expect(f.api.getState().mode).toBe('expanded');
    pointer('pointercancel', 450);
    expect(f.api.getState()).toMatchObject({ mode: 'summary', width: 350 });
  });
});

describe('magnetic resize boundaries', () => {
  function initial(mode: ContextPanelMode = 'summary') {
    return { raw: 350, gutter: 400, minimum: 280, folded: false, snap: null, mode, keyboard: false };
  }
  it('pins within 12 pixels and resists until 24 pixels beyond the gutter', () => {
    const near = resolveContextResize(initial(), 391);
    expect(near).toMatchObject({ width: 400, snap: 'gutter', mode: 'summary' });
    const pinned = resolveContextResize({ ...initial(), ...near }, 420);
    expect(pinned).toMatchObject({ width: 400, mode: 'summary' });
    const expanded = resolveContextResize({ ...initial(), ...pinned }, 425);
    expect(expanded).toMatchObject({ width: 425, snap: null, mode: 'expanded' });
    const reverse = resolveContextResize({ ...initial(), ...expanded }, 395);
    expect(reverse.mode).toBe('expanded');
    expect(resolveContextResize({ ...initial(), ...reverse }, 375).mode).toBe('summary');
  });
  it('holds the minimum and allows reopening during the same pointer gesture', () => {
    const near = resolveContextResize(initial(), 285);
    expect(near).toMatchObject({ width: 280, snap: 'min', folded: false });
    const held = resolveContextResize({ ...initial(), ...near }, 260);
    expect(held).toMatchObject({ width: 280, folded: false });
    const folded = resolveContextResize({ ...initial(), ...held }, 255);
    expect(folded).toMatchObject({ width: 0, folded: true });
    expect(resolveContextResize({ ...initial(), ...folded }, 279).folded).toBe(true);
    expect(resolveContextResize({ ...initial(), ...folded }, 280)).toMatchObject({ folded: false, width: 280 });
  });
  it('does not create overlapping minimum and gutter snap regions in a small margin', () => {
    const result = resolveContextResize({ ...initial(), gutter: 300 }, 298);
    expect(result.snap).toBeNull(); expect(result.width).toBe(298);
  });
});
