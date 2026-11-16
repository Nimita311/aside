// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFrame, type WorkspaceFrameView } from '../src/workspace-frame';
import { createIframeQueryBridge } from '../src/iframe-bridge';
import { IFRAME_CONNECT } from '../src/iframe-protocol';
import { webpageFrame } from '../src/webpage';

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
  localStorage.clear();
});

function fixture(initialWidth = 1600) {
  const source = readFileSync('index.html', 'utf8').replace(/<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  document.body.innerHTML = new DOMParser().parseFromString(source, 'text/html').body.innerHTML;
  let width = initialWidth;
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const shell = element('workspace-frame');
  Object.defineProperty(shell, 'clientWidth', { configurable: true, get: () => shell.dataset.reader === 'html' ? width : Math.min(1920, width) });
  Object.defineProperty(shell, 'clientHeight', { configurable: true, get: () => 900 });
  Object.defineProperty(document.body, 'clientWidth', { configurable: true, get: () => width });
  for (const id of ['flow-scroll', 'doc-body']) Object.defineProperty(element(id), 'clientWidth', { configurable: true, get: () => shell.clientWidth });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const beforeOpen = vi.fn();
  const onEntries = vi.fn(), onOverview = vi.fn(), onSummary = vi.fn(), onPin = vi.fn(), onNavigateItem = vi.fn(), onSort = vi.fn(), onLayout = vi.fn();
  const preserveLayout = vi.fn((paint: () => void) => paint());
  const openSearch = vi.fn(() => document.querySelector<HTMLInputElement>('.search-input')!.focus());
  const api = createWorkspaceFrame({ beforeOpen, preserveLayout, openSearch, onEntries, onOverview, onSummary, onPin, onNavigateItem, onSort, onLayout });
  disposals.push(() => { api.dispose(); while (frames.length) frames.shift()!(0); });
  let view: WorkspaceFrameView = {
    available: true, href: '/work/', overviewHref: '/work/detail', currentLabel: 'Entries', reader: 'flow', summaryAvailable: true,
    inspection: '{ "source": "All entries" }',
  };
  api.setup(); api.update(view);
  return {
    api, element, shell, beforeOpen, onEntries, onOverview, onSummary, onPin, onNavigateItem, onSort, onLayout, preserveLayout, openSearch,
    resize(next: number) { width = next; api.layout(); },
    update(next: Partial<WorkspaceFrameView>) { view = { ...view, ...next }; api.update(view); },
  };
}

describe('automatic workspace frame', () => {
  it('gives wide blocks only the spare space before a panel or viewport edge', () => {
    const f = fixture(1280);
    const extra = () => Number.parseFloat(f.shell.style.getPropertyValue('--wide-content-right'));
    const left = () => Number.parseFloat(f.shell.style.getPropertyValue('--wide-content-left'));
    expect(extra()).toBe(160);
    expect(left()).toBe(274);
    f.resize(1520);
    expect(f.shell.dataset.frame).toBe('expanded');
    expect(extra()).toBe(0); // minimum-width panels consume the spare margins
    expect(left()).toBe(114); // the timeline gutter can show panned content
    f.resize(1920);
    expect(extra()).toBe(120);
    expect(left()).toBe(234);
    f.update({ reader: 'record' });
    expect(extra()).toBe(177);
    expect(left()).toBe(177);
    f.update({ summaryAvailable: false });
    expect(extra()).toBe(537); // the unused context margin is available too
    f.resize(960);
    f.update({ reader: 'flow' });
    expect(extra()).toBe(0);
  });

  it('uses one shared panel fit threshold and keeps 1920px as a full-width desktop', () => {
    localStorage.setItem('panelCollapsed', 'true'); localStorage.setItem('navigationCollapsed', 'true');
    const f = fixture();
    expect(f.shell.dataset.frame).toBe('expanded');
    expect(f.element('navigation-sidebar-host').hidden).toBe(false);
    expect(f.onLayout).toHaveBeenLastCalledWith({ panels: true, reader: 'flow', controlsOpen: false });
    expect(f.element('control-pill').hidden).toBe(true);
    expect(f.shell.style.getPropertyValue('--workspace-panel-width')).toBe('320px');
    f.resize(1520);
    expect(f.shell.dataset.frame).toBe('expanded');
    expect(f.shell.style.getPropertyValue('--workspace-panel-width')).toBe('280px');
    f.resize(1519);
    expect(f.element('navigation-sidebar-host').hidden).toBe(true);
    expect(f.onLayout).toHaveBeenLastCalledWith({ panels: false, reader: 'flow', controlsOpen: false });
    expect(f.element('control-pill').hidden).toBe(false);
    f.resize(1920); expect(f.shell.dataset.bounded).toBe('false');
    f.resize(3440); expect(f.shell.clientWidth).toBe(1920); expect(f.shell.dataset.bounded).toBe('true');
    expect(document.querySelectorAll('#btn-navigation-toggle, #navigation-drawer, #btn-side-panel-collapse')).toHaveLength(0);
  });

  it('always gives full-page HTML the viewport and compact controls, then restores native layout', () => {
    const f = fixture(3440);
    f.update({ reader: 'html', currentLabel: 'Release dashboard', summaryAvailable: false });
    expect(f.shell.clientWidth).toBe(3440);
    expect(f.shell.dataset.bounded).toBe('false'); expect(f.shell.dataset.frame).toBe('compact');
    expect(f.onLayout).toHaveBeenLastCalledWith({ panels: false, reader: 'html', controlsOpen: false });
    expect(f.element('navigation-sidebar-host').hidden).toBe(true);
    expect(f.element('control-pill').hidden).toBe(false);
    for (const width of [1920, 390]) { f.resize(width); expect(f.shell.dataset.frame).toBe('compact'); }
    f.resize(1920); f.update({ reader: 'flow', currentLabel: 'Entries', summaryAvailable: true });
    expect(f.shell.dataset.frame).toBe('expanded');
    expect(f.onLayout).toHaveBeenLastCalledWith({ panels: true, reader: 'flow', controlsOpen: false });
  });

  it('opens its own view picker and retains native modified-click navigation', () => {
    const f = fixture(1120);
    f.element('btn-workspace-views').focus(); f.element('btn-workspace-views').click();
    expect(f.element('workspace-popover').hidden).toBe(false);
    expect(f.element('workspace-view-content').parentElement).toBe(f.element('workspace-popover-body'));
    expect(f.element('navigation-sidebar-host').hidden).toBe(true);
    expect(f.element('nav-entries').getAttribute('href')).toBe('/work/');
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    f.element('nav-entries').dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false); expect(f.onEntries).not.toHaveBeenCalled();
    f.element('nav-entries').click();
    expect(f.onEntries).toHaveBeenCalledOnce(); expect(f.element('workspace-popover').hidden).toBe(true);
  });

  it('preserves the live search draft, results, and focus across responsive transitions', () => {
    const f = fixture(1120);
    f.api.openSearch();
    const input = document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'launch words'; input.setAttribute('aria-activedescendant', 'chosen-result');
    const option = document.createElement('div'); option.id = 'chosen-result'; option.textContent = 'Launch words';
    f.element('search-listbox').append(option);
    const opens = f.beforeOpen.mock.calls.length;
    f.resize(1920); f.resize(1120);
    expect(f.element('workspace-popover').hidden).toBe(false); expect(f.element('workspace-popover').dataset.page).toBe('search');
    expect(document.querySelector('.search-input')).toBe(input);
    expect(input.value).toBe('launch words'); expect(input.getAttribute('aria-activedescendant')).toBe('chosen-result');
    expect(document.activeElement).toBe(input); expect(f.element('chosen-result')).toBe(option);
    expect(f.beforeOpen).toHaveBeenCalledTimes(opens);
    expect(document.querySelectorAll('.search-input')).toHaveLength(1);
  });

  it('leaves an externally owned context panel in place and delegates Summary through both control layouts', () => {
    const f = fixture(1120);
    const panel = f.element('side-panel'), body = f.element('side-panel-body');
    const reference = document.createElement('button'); reference.textContent = 'Open related project'; body.append(reference);
    panel.hidden = false; panel.inert = false; panel.classList.add('is-open');
    panel.dataset.detail = 'expanded'; panel.dataset.extent = 'expanded'; body.scrollTop = 80;
    const unchanged = () => {
      expect(body.parentElement).toBe(panel); expect(body.firstElementChild).toBe(reference);
      expect(panel.hidden).toBe(false); expect(panel.inert).toBe(false); expect(panel.classList.contains('is-open')).toBe(true);
      expect(panel.dataset.detail).toBe('expanded'); expect(panel.dataset.extent).toBe('expanded'); expect(body.scrollTop).toBe(80);
    };
    f.element('btn-pill-more').click(); f.element('btn-workspace-summary').click();
    expect(f.onSummary).toHaveBeenCalledOnce(); expect(f.element('workspace-popover').hidden).toBe(true); unchanged();
    f.resize(1920); unchanged();
    f.element('btn-navigation-more').click(); f.element('btn-workspace-summary').click();
    expect(f.onSummary).toHaveBeenCalledTimes(2); expect(f.element('workspace-popover').hidden).toBe(true); unchanged();
    f.resize(390); unchanged();
    // Availability and frame changes cannot reopen a panel dismissed by its owner.
    panel.hidden = true; panel.inert = true; panel.classList.remove('is-open');
    f.update({ summaryAvailable: false }); f.resize(1920);
    expect(body.parentElement).toBe(panel); expect(panel.hidden).toBe(true); expect(panel.inert).toBe(true);
    expect(panel.classList.contains('is-open')).toBe(false); expect(panel.dataset.detail).toBe('expanded');
    expect(panel.dataset.extent).toBe('expanded'); expect(f.element('workspace-popover').hidden).toBe(true);
  });

  it('dismisses the top popover with Escape and restores its visible launcher', () => {
    const f = fixture(1120);
    const more = f.element('btn-pill-more'); more.focus(); more.click();
    expect(f.element('flow-scroll').inert).toBe(true);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    f.element('btn-workspace-popover-close').dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true); expect(f.element('workspace-popover').hidden).toBe(true);
    expect(f.element('flow-scroll').inert).toBe(false); expect(document.activeElement).toBe(more);
    more.click(); f.element('workspace-popover-dismiss').click();
    expect(f.element('workspace-popover').hidden).toBe(true); expect(document.activeElement).toBe(more);
    expect(f.element('data-diagnostics').inert).toBe(false);
    f.resize(1600); f.element('btn-navigation-more').click();
    expect(f.element('data-diagnostics').inert).toBe(true);
    const close = f.element('btn-workspace-popover-close'); close.focus();
    const backwards = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    close.dispatchEvent(backwards);
    expect(backwards.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(f.element('btn-theme-toggle'));
    expect(f.element('workspace-popover-dismiss').tabIndex).toBe(-1);
  });

  it('keeps pin state and live inspection controls available through either interface', () => {
    const f = fixture();
    const inspection = document.createElement('button'); inspection.textContent = 'Open source';
    const source = vi.fn(); inspection.addEventListener('click', source);
    f.update({ sections: [{ items: [{ label: 'Launch brief', href: '/work/asset/brief.md', active: true }] }], pinned: true, inspection });
    expect(f.element('workspace-sections').hidden).toBe(false);
    expect(f.element('nav-entries').hasAttribute('aria-current')).toBe(false);
    f.element('btn-navigation-more').click(); f.element('btn-inspect-view').click();
    expect(f.element('workspace-inspection').firstElementChild).toBe(inspection);
    inspection.click(); expect(source).toHaveBeenCalledOnce();
    f.api.closePopover(); f.resize(1120);
    f.element('btn-pill-more').click();
    expect(f.element('btn-workspace-pin').textContent).toBe('Unpin this view');
    f.element('btn-workspace-pin').click(); expect(f.onPin).toHaveBeenCalledExactlyOnceWith(false);
    f.element('btn-workspace-views').click(); f.element('workspace-sections').querySelector<HTMLElement>('a')!.click();
    expect(f.onNavigateItem).toHaveBeenCalledWith(0, 0);
  });

  it('distinguishes the instance Overview from content with the same title', () => {
    const f = fixture();
    f.update({ reader: 'record', currentLabel: 'Overview', overviewActive: false });
    expect(f.element('nav-overview').hasAttribute('aria-current')).toBe(false);
    f.update({ overviewActive: true });
    expect(f.element('nav-overview').getAttribute('aria-current')).toBe('page');
    f.update({ reader: 'flow', currentLabel: 'Entries', overviewActive: false });
    expect(f.element('nav-overview').hasAttribute('aria-current')).toBe(false);
  });

  it('renders ordered titled and untitled sections through Navigation and the view picker', () => {
    const f = fixture();
    const sections = f.element('workspace-sections');
    expect(sections.hidden).toBe(true);
    f.update({ sections: [
      { items: [{ label: 'Launch decisions', href: '/work/?source=timeline', active: false }] },
      { title: 'Projects', items: [{ label: 'Aurora body', href: '/work/project/aurora/detail', active: false }] },
    ] });
    expect(sections.hidden).toBe(false);
    expect([...sections.querySelectorAll('h2')].map(node => node.textContent)).toEqual(['Projects']);
    expect([...sections.querySelectorAll('a')].map(node => node.textContent)).toEqual(['Launch decisions', 'Aurora body']);
    expect(sections.querySelectorAll('details')).toHaveLength(0);
    expect(document.querySelector('#workspace-pins, #workspace-sources')).toBeNull();
    expect(f.element('workspace-view-content').parentElement).toBe(f.element('navigation-sidebar'));
    const link = sections.querySelector<HTMLAnchorElement>('a')!;
    expect(link.getAttribute('href')).toBe('/work/?source=timeline');
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false); expect(f.onNavigateItem).not.toHaveBeenCalled();
    f.resize(1120); f.element('btn-workspace-views').click();
    expect(f.element('workspace-view-content').parentElement).toBe(f.element('workspace-popover-body'));
    expect(sections.querySelector('a')).toBe(link);
    const record = sections.querySelectorAll<HTMLAnchorElement>('a')[1]; record.click();
    expect(f.onNavigateItem).toHaveBeenCalledWith(1, 0); expect(f.element('workspace-popover').hidden).toBe(true);
  });

  it('uses explicit item activity and keeps builtins available without custom sections', () => {
    const f = fixture();
    f.update({ sections: [{ title: 'Focus', items: [{ label: 'Decisions', href: '/work/?source=timeline', active: true }] }] });
    expect(f.element('nav-entries').hasAttribute('aria-current')).toBe(false);
    expect(f.element('workspace-sections').querySelector('a')?.getAttribute('aria-current')).toBe('page');
    f.update({ reader: 'record', overviewActive: true });
    expect(f.element('nav-overview').hasAttribute('aria-current')).toBe(false);
    f.update({ sections: [], reader: 'flow', entriesActive: false, overviewActive: false });
    expect(f.element('workspace-sections').hidden).toBe(true);
    expect(f.element('nav-entries').hasAttribute('aria-current')).toBe(false);
    f.update({ entriesActive: true });
    expect(f.element('nav-entries').getAttribute('aria-current')).toBe('page');
    f.update({ reader: 'record', entriesActive: false, overviewActive: true });
    expect(f.element('nav-overview').getAttribute('aria-current')).toBe('page');
  });

  it('preserves equivalent item focus when an agent updates section contents', () => {
    const f = fixture();
    const item = { label: 'Launch brief', href: '/work/asset/brief.md', active: false };
    f.update({ sections: [{ title: 'Focus', items: [item] }] });
    f.element('workspace-sections').querySelector<HTMLElement>('a')!.focus();
    f.update({ sections: [{ title: 'Today', items: [{ label: 'Decisions', href: '/work/?source=timeline', active: false }, item] }] });
    expect((document.activeElement as HTMLAnchorElement).getAttribute('href')).toBe(item.href);
    expect((document.activeElement as HTMLElement).dataset.itemIndex).toBe('1');
  });

  it('keeps query-flow ordering in More and exposes the selected direction', () => {
    const f = fixture(1120);
    expect(f.element('workspace-sort').hidden).toBe(true);
    f.update({ order: 'CREATED_DESC' });
    f.element('btn-pill-more').click();
    expect(f.element('workspace-sort').hidden).toBe(false);
    expect(f.element('workspace-more-content').contains(f.element('workspace-sort'))).toBe(true);
    expect(f.element('btn-sort-newest').getAttribute('aria-pressed')).toBe('true');
    f.element('btn-sort-oldest').click();
    expect(f.onSort).toHaveBeenCalledWith('CREATED_ASC'); expect(f.element('workspace-popover').hidden).toBe(true);
    f.update({ order: 'CREATED_ASC' });
    expect(f.element('btn-sort-oldest').getAttribute('aria-pressed')).toBe('true');
    expect(f.element('btn-sort-newest').getAttribute('aria-pressed')).toBe('false');
    f.update({ reader: 'record' }); expect(f.element('workspace-sort').hidden).toBe(true);
    f.update({ reader: 'flow', order: undefined }); expect(f.element('workspace-sort').hidden).toBe(true);
  });

  it('dispatches the requested pin state from the displayed command', () => {
    const f = fixture(1120);
    f.element('btn-pill-more').click();
    expect(f.element('btn-workspace-pin').textContent).toBe('Pin this view');
    f.element('btn-workspace-pin').click();
    expect(f.onPin).toHaveBeenLastCalledWith(true);
    expect(f.element('workspace-popover').hidden).toBe(true);
    // The persisted state is supplied by the application; another activation
    // requests removal rather than an ambiguous toggle to repeat on retry.
    f.update({ pinned: true });
    f.element('btn-pill-more').click();
    expect(f.element('btn-workspace-pin').textContent).toBe('Unpin this view');
    f.element('btn-workspace-pin').click();
    expect(f.onPin).toHaveBeenLastCalledWith(false);
    expect(f.onPin).toHaveBeenCalledTimes(2);
  });

  it('inspects the source chip through existing View details and retains the independent filter group', () => {
    const f = fixture(1120);
    const source = f.element('source-filter'); source.hidden = false;
    const label = document.createElement('button'); label.textContent = 'Launch decisions'; source.append(label);
    const group = f.element('workspace-filter-group');
    expect(group.firstElementChild).toBe(source);
    f.element('btn-workspace-calendar').click();
    label.focus(); f.api.openInspection();
    expect(f.element('workspace-popover').dataset.page).toBe('inspect');
    expect(f.element('workspace-inspection-content').parentElement).toBe(f.element('workspace-popover-body'));
    f.api.closePopover(); expect(document.activeElement).toBe(f.element('btn-workspace-calendar'));
    f.resize(1920);
    expect(group.parentElement).toBe(f.element('navigation-filter-slot')); expect(source.hidden).toBe(false);
    f.resize(1120);
    expect(group.parentElement).toBe(f.element('navigation-filter-slot')); expect(group.firstElementChild).toBe(source);
    f.element('btn-workspace-calendar').click();
    expect(f.element('workspace-popover').dataset.page).toBe('calendar');
    expect(f.element('workspace-popover-body').contains(group)).toBe(true);
  });

  it('keeps a webpage query grant live behind controls while blocking background interaction', async () => {
    const f = fixture(3440);
    const stylesheet = document.createElement('style'); stylesheet.textContent = readFileSync('style.css', 'utf8');
    document.head.append(stylesheet); disposals.push(() => stylesheet.remove());
    f.update({ reader: 'html', currentLabel: 'Dashboard', summaryAvailable: false });
    const reader = f.element('doc-backdrop'); reader.hidden = false;
    reader.setAttribute('aria-hidden', 'false');
    const body = f.element('doc-body');
    const navigation = (window as unknown as { happyDOM: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM.settings.navigation;
    const previousNavigation = navigation.disableChildFrameNavigation;
    navigation.disableChildFrameNavigation = true;
    disposals.push(() => { navigation.disableChildFrameNavigation = previousNavigation; });
    const path = 'artifacts/2026/2026-10-12-dashboard/index.html';
    const fileUrl = (value: string) => `/-/files/fixture/work/files/${value}`;
    const webpage = webpageFrame('Dashboard', path);
    webpage.src = `${location.origin}${fileUrl(path)}`;
    const source = {} as Window;
    Object.defineProperty(webpage, 'contentWindow', { value: source });
    const background = document.createElement('button'); background.textContent = 'Dashboard action';
    body.append(background);
    vi.stubGlobal('IntersectionObserver', undefined);
    const bridge = createIframeQueryBridge(); disposals.push(() => bridge.dispose());
    let finish: ((result: { data: { actions: { totalCount: number } } }) => void) | undefined;
    const signals: AbortSignal[] = [];
    const query = vi.fn((_request: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1
        ? new Promise<{ data: { actions: { totalCount: number } } }>(resolve => { finish = resolve; })
        : Promise.resolve({ data: { actions: { totalCount: 3 } } });
    });
    expect(bridge.register(webpage, { fileUrl, resource: vi.fn(), isCurrent: () => true, query })).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>Dashboard</h1>')));
    body.append(webpage);
    await vi.waitFor(() => expect(webpage.srcdoc).toContain('data-aside-token'));
    class Port {
      peer!: Port;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      messages: unknown[] = [];
      closed = false;
      start() {}
      close() { this.closed = true; }
      postMessage(message: unknown) {
        if (this.closed) throw new Error('Port closed');
        this.messages.push(message);
        queueMicrotask(() => { if (!this.peer.closed) this.peer.onmessage?.({ data: message } as MessageEvent); });
      }
    }
    const client = new Port(), host = new Port(); client.peer = host; host.peer = client;
    window.dispatchEvent(new MessageEvent('message', { origin: 'null', source, ports: [host as unknown as MessagePort], data: {
      type: IFRAME_CONNECT, version: 1, token: webpage.srcdoc.match(/data-aside-token="([^"]+)"/)![1],
    } }));
    expect(host.messages).toContainEqual({ type: 'ready' });
    client.postMessage({ type: 'query', id: 1, request: { query: '{ actions { totalCount } }' } });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    background.focus(); f.api.openSearch();
    const input = document.querySelector<HTMLInputElement>('.search-input')!;
    expect(document.activeElement).toBe(input);
    expect(reader.inert).toBe(false); expect(reader.hidden).toBe(false);
    expect(reader.dataset.controlsObscured).toBe('true'); expect(reader.getAttribute('aria-hidden')).toBe('true');
    expect(getComputedStyle(reader).pointerEvents).toBe('none'); expect(getComputedStyle(background).pointerEvents).toBe('none');
    expect(webpage.closest('[hidden], [inert]')).toBeNull();
    background.focus(); expect(document.activeElement).toBe(input);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true); expect(f.element('workspace-control-surface').contains(document.activeElement)).toBe(true);
    finish!({ data: { actions: { totalCount: 3 } } });
    await vi.waitFor(() => expect(host.messages).toContainEqual({ type: 'result', id: 1, result: { data: { actions: { totalCount: 3 } } } }));
    expect(signals[0].aborted).toBe(false); expect(host.closed).toBe(false);
    f.api.closePopover();
    expect(reader.hasAttribute('data-controls-obscured')).toBe(false); expect(reader.getAttribute('aria-hidden')).toBe('false');
    reader.setAttribute('aria-hidden', 'true');
    f.element('btn-pill-more').click();
    client.postMessage({ type: 'query', id: 2, request: { query: '{ actions { totalCount } }' } });
    await vi.waitFor(() => expect(host.messages).toContainEqual({ type: 'result', id: 2, result: { data: { actions: { totalCount: 3 } } } }));
    f.api.closePopover();
    expect(reader.getAttribute('aria-hidden')).toBe('true');
    expect(host.closed).toBe(false); expect(webpage.getAttribute('sandbox')).toBe('allow-scripts');
  });
});
