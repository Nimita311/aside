import { activeModal, usable } from './modal';
import { entityIcon, isModifiedClick } from './render';
import { ICON_SIZE } from './entity-icons';
import { alignWideBlocks } from './wide-content';

export type WorkspaceReader = 'chooser' | 'flow' | 'record' | 'html';
export type WorkspaceEntryOrder = 'CREATED_ASC' | 'CREATED_DESC';
export interface WorkspaceSidebarSection {
  title?: string;
  items: { label: string; href: string; active: boolean }[];
}
export interface WorkspaceFrameView {
  available: boolean;
  href: string;
  overviewHref: string;
  currentLabel: string;
  entriesActive?: boolean;
  order?: WorkspaceEntryOrder;
  overviewActive?: boolean;
  reader: WorkspaceReader;
  summaryAvailable: boolean;
  contextFullscreen?: boolean;
  sections?: WorkspaceSidebarSection[];
  pinned?: boolean;
  inspection?: string | HTMLElement;
}
export interface WorkspaceFrameOptions {
  beforeOpen(): void;
  preserveLayout(paint: () => void): void;
  openSearch(): void;
  onLayout(layout: { panels: boolean; reader: WorkspaceReader; controlsOpen: boolean }): void;
  onEntries(): void;
  onOverview(): void;
  onSummary(): void;
  onPin?(pinned: boolean): void;
  onNavigateItem?(sectionIndex: number, itemIndex: number): void;
  onSort?(order: WorkspaceEntryOrder): void;
}

type Page = 'views' | 'search' | 'calendar' | 'more' | 'inspect';
const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex]';

// Layout owns presentation only. The live search/instance roots move
// between hosts, retaining their content, event handlers and browsing state.
export function createWorkspaceFrame(options: WorkspaceFrameOptions) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const frame = $('workspace-frame');
  const sidebarHost = $('navigation-sidebar-host');
  const sidebar = $('navigation-sidebar');
  const panel = $('side-panel');
  const pill = $('control-pill');
  const surface = $('workspace-control-surface');
  const popover = $('workspace-popover');
  const popoverBody = $('workspace-popover-body');
  const parking = $('workspace-parking');
  const views = $('workspace-view-content');
  const search = document.querySelector<HTMLElement>('.search-wrapper')!;
  const more = $('workspace-more-content');
  const inspect = $('workspace-inspection-content');
  const filters = $('workspace-filter-group');
  const timeline = $('workspace-timeline-controls');
  const connection = $('connection-status');
  const dismiss = $('workspace-popover-dismiss');
  const entries = $<HTMLAnchorElement>('nav-entries');
  const overview = $<HTMLAnchorElement>('nav-overview');
  let view: WorkspaceFrameView = { available: false, href: '/', overviewHref: '/', currentLabel: 'Aside', reader: 'chooser', summaryAvailable: false };
  let page: Page | null = null;
  let launcher: HTMLElement | null = null;
  let panels = false;
  let started = false;
  let queued = false;
  let notifying = '';
  let sectionsSignature = '';
  let inspectionValue: WorkspaceFrameView['inspection'];
  let observer: ResizeObserver | undefined;
  let resizeHandler: (() => void) | undefined;
  const obscuredReaders = new Map<HTMLElement, string | null>();

  const pillViews = $('btn-workspace-views');
  const searchTrigger = () => $(panels ? 'btn-navigation-search' : 'btn-pill-search');
  const moreTrigger = () => $(panels ? 'btn-navigation-more' : 'btn-pill-more');
  const fallback = () => panels ? $('btn-instance-switch') : pillViews;
  // Native readers stop at the workspace cap; full-page HTML has none.
  const frameWidth = () => frame.clientWidth || Math.min(window.innerWidth, view.reader === 'html' ? Infinity : 1920);
  const focusDateInput = () => timeline?.querySelector<HTMLInputElement>('.date-jump-input')?.focus({ preventScroll: true });

  function notify(): void {
    const key = `${panels}:${page ?? ''}:${view.reader}:${view.summaryAvailable}`;
    if (key === notifying) return;
    notifying = key;
    options.onLayout({ panels, reader: view.reader, controlsOpen: !!page });
  }

  function mountPage(): void {
    // Park all inactive controls so they cannot create duplicate tab stops.
    const current = page === 'views' ? views : page === 'search' ? search : page === 'calendar' ? timeline : page === 'more' ? more : page === 'inspect' ? inspect : null;
    for (const node of [views, search, more, inspect, timeline].filter((node): node is HTMLElement => !!node)) {
      const destination = node === current ? popoverBody : node === views && panels ? sidebar : node === timeline && panels ? $('navigation-timeline-slot') : parking;
      if (node.parentElement !== destination) destination.append(node);
    }
    const title = page === 'views' ? 'Views' : page === 'search' ? 'Search' : page === 'calendar' ? 'Timeline calendar' : page === 'more' ? 'More' : page === 'inspect' ? 'View details' : 'Summary';
    $('workspace-popover-title').textContent = title;
  }

  function restoreReaderAccessibility(reader: HTMLElement): void {
    if (!obscuredReaders.has(reader)) return;
    const previous = obscuredReaders.get(reader);
    if (previous === null) reader.removeAttribute('aria-hidden');
    else reader.setAttribute('aria-hidden', previous!);
    reader.removeAttribute('data-controls-obscured');
    obscuredReaders.delete(reader);
  }

  function updateReaderInteraction(): void {
    for (const id of ['flow-scroll', 'doc-backdrop', 'instance-chooser', 'side-panel']) {
      const reader = $(id);
      if (page && reader.querySelector('iframe.asset-webpage')) {
        // `inert`/`hidden` intentionally revoke a webpage's query grant.
        // A temporary controls popup does not navigate or hide that page:
        // leave its browsing context live while blocking reader interaction.
        if (!obscuredReaders.has(reader)) obscuredReaders.set(reader, reader.getAttribute('aria-hidden'));
        if (reader.contains(document.activeElement)) focusPage();
        reader.inert = false;
        reader.dataset.controlsObscured = 'true';
        reader.setAttribute('aria-hidden', 'true');
      } else {
        restoreReaderAccessibility(reader);
        reader.inert = !!page || (id === 'flow-scroll' && !!view.contextFullscreen) || (id === 'side-panel' && (reader.hidden || reader.getAttribute('aria-hidden') === 'true'));
      }
    }
  }

  function guardBackgroundFocus(event?: FocusEvent): void {
    if (!page || activeModal()) return;
    const target = event?.target instanceof Node ? event.target : document.activeElement;
    if (target && [...obscuredReaders.keys()].some(reader => reader.contains(target))) focusPage();
  }

  function guardFrameFocus(): void {
    if (page) requestAnimationFrame(() => guardBackgroundFocus());
  }

  function paint(): void {
    frame.dataset.frame = panels ? 'expanded' : 'compact';
    frame.dataset.reader = view.reader;
    sidebarHost.hidden = !panels;
    sidebarHost.inert = !panels || !!page;
    sidebar.hidden = false;
    $('data-diagnostics').inert = !!page;
    pill.hidden = panels;
    pill.inert = panels;
    $('workspace-core-views').hidden = !view.available;
    const filterSlot = $('navigation-filter-slot');
    if (filters.parentElement !== filterSlot) filterSlot.append(filters);
    const connectionSlot = panels ? $('workspace-current-label') : pill.querySelector('.control-pill-actions')!;
    if (panels && connection.parentElement !== connectionSlot.parentElement) connectionSlot.after(connection);
    else if (!panels && connection.parentElement !== connectionSlot) connectionSlot.append(connection);
    mountPage();
    popover.hidden = !page;
    popover.dataset.page = page ?? '';
    dismiss.hidden = !page;
    $('btn-workspace-summary').hidden = !view.summaryAvailable;
    surface.setAttribute('role', page ? 'dialog' : 'group');
    if (page) {
      surface.setAttribute('aria-modal', 'true');
      surface.setAttribute('aria-labelledby', 'workspace-popover-title');
    } else {
      surface.removeAttribute('aria-modal'); surface.removeAttribute('aria-labelledby');
    }
    updateReaderInteraction();
    const active = page === 'views' ? pillViews : page === 'search' ? searchTrigger() : page === 'calendar' ? $('btn-workspace-calendar') : page ? moreTrigger() : null;
    for (const id of ['btn-workspace-views', 'btn-workspace-calendar', 'btn-pill-search', 'btn-pill-more', 'btn-navigation-search', 'btn-navigation-more']) {
      $(id)?.setAttribute('aria-expanded', String(!!page && $(id) === active));
    }
    const width = frameWidth();
    const maximumWidth = panels ? Math.max(240, parseFloat(frame.style.getPropertyValue('--workspace-panel-width')) - 24) : width - 24;
    popover.style.width = `${Math.min(page === 'calendar' ? 340 : 400, maximumWidth)}px`;
    frame.style.setProperty('--workspace-popover-height', `${Math.max(100, (frame.clientHeight || window.innerHeight) - (panels ? 88 : pill.offsetHeight + 48))}px`);
    frame.style.setProperty('--workspace-pill-height', `${pill.offsetHeight || 44}px`);
    notify();
  }

  function layout(): void {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ownedFocus = !!active && (sidebarHost.contains(active) || surface.contains(active) || panel.contains(active));
    const wasPanels = panels;
    // Set this before measuring, so HTML bypasses the workspace width cap.
    frame.dataset.reader = view.reader;
    const width = frameWidth();
    const css = getComputedStyle(document.documentElement);
    const value = (name: string, initial: number) => parseFloat(css.getPropertyValue(name)) || initial;
    const flow = value('--flow-max-width', 960);
    const record = flow - value('--flow-gutter', 130) - value('--flow-pad-x', 16) + 2 * value('--doc-pad-x', 48);
    const scroller = $(view.reader === 'record' ? 'doc-body' : 'flow-scroll');
    const available = scroller.clientWidth || width;
    const footprint = view.reader === 'record' ? record : flow;
    const minimumPanel = value('--workspace-panel-min-width', 280);
    panels = view.available && !view.contextFullscreen && view.reader !== 'html' && available >= footprint + 2 * minimumPanel;
    const panelWidth = Math.max(minimumPanel, Math.min(360, Math.floor((available - footprint) / 2)));
    frame.style.setProperty('--workspace-panel-width', `${panelWidth}px`);
    // Prose keeps its centered measure. Wide-block scroll viewports can use
    // both spare margins, stopping 16px before a panel or scroller edge.
    const prose = view.reader === 'record' ? scroller : $('flow');
    const proseStyle = getComputedStyle(prose);
    const leadingPadding = parseFloat(proseStyle.paddingLeft) ||
      value(view.reader === 'record' ? '--doc-pad-x' : '--flow-gutter', view.reader === 'record' ? 48 : 130);
    const trailingPadding = parseFloat(proseStyle.paddingRight) ||
      value(view.reader === 'record' ? '--doc-pad-x' : '--flow-pad-x', view.reader === 'record' ? 48 : 16);
    const proseLeft = (available - Math.min(available, footprint)) / 2 + leadingPadding;
    const proseRight = (available + Math.min(available, footprint)) / 2 - trailingPadding;
    const leftEdge = (panels ? panelWidth : 0) + 16;
    const rightEdge = Math.min(available, width - (panels && view.summaryAvailable ? panelWidth : 0)) - 16;
    const wideLeft = Math.max(0, proseLeft - leftEdge);
    const wideRight = Math.max(0, rightEdge - proseRight);
    frame.dataset.bounded = String(view.reader !== 'html' && (document.body.clientWidth || window.innerWidth) > width);
    if (panels && !wasPanels && (page === 'views' || page === 'calendar')) page = null;
    const apply = () => {
      frame.style.setProperty('--wide-content-left', `${wideLeft}px`);
      frame.style.setProperty('--wide-content-right', `${wideRight}px`);
      paint();
      alignWideBlocks(frame);
    };
    if (wasPanels !== panels) options.preserveLayout(apply);
    else apply();
    if (ownedFocus && !activeModal()) {
      if (usable(active)) active!.focus({ preventScroll: true });
      else if (page) focusPage();
      else fallback()?.focus({ preventScroll: true });
    }
  }

  function focusPage(): void {
    if (page === 'search') { options.openSearch(); return; }
    if (page === 'calendar') { focusDateInput(); return; }
    const first = Array.from(popover.querySelectorAll<HTMLElement>(FOCUSABLE)).find(node => node.tabIndex >= 0 && usable(node));
    (first ?? popover).focus({ preventScroll: true });
  }

  function closePopover(restoreFocus = true): void {
    if (!page) return;
    if (page === 'search') options.beforeOpen();
    const target = launcher;
    page = null; paint();
    if (restoreFocus && !activeModal()) (usable(target) ? target : fallback())?.focus({ preventScroll: true });
    launcher = null;
  }

  function open(next: Page, trigger?: HTMLElement): void {
    if (activeModal() || ((next === 'search' || next === 'calendar') && !view.available)) return;
    options.beforeOpen();
    if (!page) launcher = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : fallback());
    page = next; paint(); focusPage();
  }

  function toggle(next: Page, trigger: HTMLElement): void {
    if (page === next) closePopover(); else open(next, trigger);
  }

  function update(next: WorkspaceFrameView): void {
    view = next;
    $('workspace-pill-label').textContent = next.currentLabel;
    $('workspace-current-label').textContent = next.currentLabel;
    if (next.available) { entries.href = next.href; overview.href = next.overviewHref; }
    else { entries.removeAttribute('href'); overview.removeAttribute('href'); }
    const sections = next.sections ?? [];
    const itemActive = sections.some(section => section.items.some(item => item.active));
    if (!itemActive && (next.entriesActive ?? next.reader === 'flow')) entries.setAttribute('aria-current', 'page'); else entries.removeAttribute('aria-current');
    if (!itemActive && next.overviewActive) overview.setAttribute('aria-current', 'page'); else overview.removeAttribute('aria-current');
    const sectionHost = $('workspace-sections');
    const signature = JSON.stringify(sections);
    let restoreItemFocus: HTMLElement | undefined;
    if (signature !== sectionsSignature) {
      sectionsSignature = signature;
      const focused = sectionHost.contains(document.activeElement) ? document.activeElement as HTMLAnchorElement : null;
      const focusedHref = focused?.getAttribute('href'), focusedLabel = focused?.textContent;
      sectionHost.replaceChildren();
      sections.forEach((section, sectionIndex) => {
        if (!section.items.length) return;
        const group = document.createElement('section'); group.className = 'workspace-sidebar-section';
        if (section.title) {
          const heading = document.createElement('h2'); heading.className = 'workspace-section-label'; heading.textContent = section.title; group.append(heading);
        }
        const list = document.createElement('nav'); list.setAttribute('aria-label', section.title || 'View shortcuts');
        section.items.forEach((item, itemIndex) => {
          const link = document.createElement('a'); link.className = 'navigation-link'; link.href = item.href; link.textContent = item.label;
          link.dataset.sectionIndex = String(sectionIndex); link.dataset.itemIndex = String(itemIndex);
          if (item.active) link.setAttribute('aria-current', 'page');
          link.addEventListener('click', event => {
            if (isModifiedClick(event) || !options.onNavigateItem) return;
            event.preventDefault(); closePopover(); options.onNavigateItem(sectionIndex, itemIndex);
          });
          list.append(link);
          if (focusedHref === item.href && focusedLabel === item.label && !restoreItemFocus) restoreItemFocus = link;
        });
        group.append(list); sectionHost.append(group);
      });
      if (focused && !restoreItemFocus) restoreItemFocus = fallback();
    }
    sectionHost.hidden = !next.available || !sections.some(section => section.items.length);
    $<HTMLButtonElement>('btn-workspace-pin').disabled = !next.available || !options.onPin;
    $('btn-workspace-pin').textContent = next.pinned ? 'Unpin this view' : 'Pin this view';
    $('workspace-sort').hidden = !next.order || !options.onSort || next.reader !== 'flow';
    $('btn-sort-newest').setAttribute('aria-pressed', String(next.order === 'CREATED_DESC'));
    $('btn-sort-oldest').setAttribute('aria-pressed', String(next.order === 'CREATED_ASC'));
    $('btn-workspace-summary').hidden = !next.summaryAvailable;
    $('btn-workspace-back').hidden = next.reader !== 'record' && next.reader !== 'html';
    $<HTMLButtonElement>('btn-inspect-view').disabled = !next.available;
    for (const id of ['btn-navigation-search', 'btn-pill-search', 'btn-workspace-calendar']) { const button = $<HTMLButtonElement>(id); if (button) button.disabled = !next.available; }
    if (timeline) timeline.hidden = !next.available;
    if (inspectionValue !== next.inspection) {
      inspectionValue = next.inspection;
      const host = $('workspace-inspection');
      if (next.inspection instanceof HTMLElement) host.replaceChildren(next.inspection);
      else { const pre = document.createElement('pre'); pre.textContent = next.inspection ?? ''; host.replaceChildren(pre); }
    }
    if (!next.available && (page === 'search' || page === 'calendar')) page = null;
    layout();
    if (usable(restoreItemFocus ?? null)) restoreItemFocus!.focus({ preventScroll: true });
  }

  function setup(): void {
    if (started) return; started = true;
    const icon = entries.querySelector('.navigation-entry-icon'); if (icon) icon.innerHTML = entityIcon('entry', undefined, ICON_SIZE.list);
    for (const [id, next] of [['btn-workspace-views', 'views'], ['btn-workspace-calendar', 'calendar'], ['btn-pill-search', 'search'], ['btn-navigation-search', 'search'], ['btn-pill-more', 'more'], ['btn-navigation-more', 'more']] as const) {
      $(id)?.addEventListener('click', () => toggle(next, $(id)));
    }
    $('btn-workspace-popover-close').addEventListener('click', () => closePopover());
    dismiss.addEventListener('click', () => closePopover());
    $('btn-inspect-view').addEventListener('click', () => open('inspect', moreTrigger()));
    $('btn-workspace-inspection-back').addEventListener('click', () => open('more', moreTrigger()));
    $('btn-workspace-summary').addEventListener('click', event => {
      event.preventDefault();
      if (activeModal() || !view.summaryAvailable) return;
      closePopover(false); options.onSummary();
    });
    $('btn-workspace-pin').addEventListener('click', () => { const pinned = !view.pinned; closePopover(); options.onPin?.(pinned); });
    for (const [id, order] of [['btn-sort-newest', 'CREATED_DESC'], ['btn-sort-oldest', 'CREATED_ASC']] as const) {
      $(id).addEventListener('click', () => { closePopover(); options.onSort?.(order); });
    }
    $('btn-workspace-back').addEventListener('click', () => { closePopover(); $('btn-doc-close').click(); });
    $('btn-settings').addEventListener('click', () => closePopover(false));
    $('btn-theme-toggle').addEventListener('click', () => closePopover());
    for (const [link, navigate] of [[entries, options.onEntries], [overview, options.onOverview]] as const) link.addEventListener('click', event => {
      if (isModifiedClick(event)) return;
      event.preventDefault(); if (!view.available) return; closePopover(); navigate();
    });
    frame.addEventListener('keydown', event => {
      if (!page || activeModal()) return;
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault(); event.stopPropagation(); closePopover(); return;
      }
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      const stops = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(node => node.tabIndex >= 0 && usable(node));
      const first = stops[0], last = stops.at(-1);
      if (!first) { event.preventDefault(); popover.focus(); return; }
      const active = document.activeElement;
      if (!surface.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault(); (event.shiftKey ? last! : first).focus({ preventScroll: true });
      }
    });
    document.addEventListener('focusin', guardBackgroundFocus, true);
    window.addEventListener('blur', guardFrameFocus);
    const queue = () => { if (queued || !frame.isConnected) return; queued = true; requestAnimationFrame(() => { queued = false; if (frame.isConnected) layout(); }); };
    resizeHandler = queue;
    window.addEventListener('resize', queue);
    if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(queue); observer.observe(frame); observer.observe(document.body); }
    layout();
  }

  return {
    setup, update, layout, closePopover,
    openSearch: () => open('search', searchTrigger()),
    isCalendarOpen: () => page === 'calendar',
    openInspection: () => open('inspect'),
    dispose: () => {
      closePopover(false);
      for (const reader of [...obscuredReaders.keys()]) restoreReaderAccessibility(reader);
      document.removeEventListener('focusin', guardBackgroundFocus, true);
      window.removeEventListener('blur', guardFrameFocus);
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      observer?.disconnect();
    },
  };
}
