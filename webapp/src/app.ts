import type { StoreView as Store, HotSet, PendingUpdate } from '../../cli/src/core/data-snapshot';
import { daemonRequest, loadDaemonInstance, queryDaemonInstance, type AvailableInstance } from './backend';
import { createIframeQueryBridge } from './iframe-bridge';
import { InstanceChooser } from './instance-chooser';
import { InstanceSwitcher } from './instance-switcher';
import { setupInstanceTooltips, WARNING_ICON } from './instance-catalogue';
import { showNotice, showDelayedLoading, delayLoading } from './notice';
import { showActionFailure, dismissActionToast } from './toast';
import { startRefresh } from './refresh';
import { startDisplayClock } from './clock';
import { refreshDisplay, preserveDisplayPosition, preserveReadingPosition, setDisplayContext, cancelDisplayMotion } from './display';
import { renderDiagrams } from './diagrams';
import { webpageSource, webpageSources } from './webpage';
import { MINUTE_MS } from '../../cli/src/core/system-config';
import { getMondayOfWeek, weekFilePath, toStampStr, entryReferences, entityKey, assetMediaKind, looksBinary, type EntityRef, type Entry } from '../lib/types';
import { renderEntry, renderDateMarker, formatStamp, renderProjectSummary, renderActionSummary, renderInstanceSummary, renderProjectDetail, renderActionDetail, renderInstanceDetail, renderEntryDetail, renderAssetDetail, renderArtifactDetail, RenderOptions, TimeFormat, type AssetContent } from './render';
import { artifactAttachmentRelativePath, artifactContentFilename, artifactHandle, parseArtifactHandle, type ArtifactReference } from '../../cli/src/core/artifact-reference';
import { buildProjectHierarchy } from './hierarchy';
import { actionMarks, projectMarks, type OpenActionGroups } from './instance';
import { buildRoute, parseRoute, instanceUrl, readInstanceLocation, ViewState, DocRef } from './route';
import { localDateStamp } from './date-reference';
import { snapshotFlow, animateFlow, animateEntryArrival, setSlideMs } from './flip';
import { REDUCED_MOTION, mountLatch, updateLatch, updateLatchNow, suppressLatch, resetLatchMarkers, addLatchMarker, resetReadoutPad } from './latch';
import { createDatePicker } from './datepicker';
import { watchActiveSearch } from './search-progress';
import { emptyFlowKind, renderEmptyFlow } from './onboarding';
import { documentFilePath, actionSourceId } from './document-path';
import { fileDiagnosticNotice } from './diagnostics';
import { createWeekView, type WeekView } from './week-view';
import { dateJumpCard, anchorFromSource, timeCursorAnchor, anchorForEntry, restoreAnchor, anchorShortfall, viewportGapBelow, quickJumpCard, entryWeek, flashJump, type FlowAnchor } from './flow-navigation';
import { projectSummaryData, actionSummaryData, projectDetailData, entryRelations, instanceSummaryData, instanceDetailData, indexDescription, planningSignature } from './panel-data';
import { applyStoredPanelWidth, bindPanelResize } from './panel-resize';
import { setupRefCoHover } from './ref-hover';
import { createSidePanel, type PanelView } from './side-panel';
import { createSearchUi } from './search-ui';
import { activeModal, createModal, type ModalController } from './modal';
import { animationSpeed, dateFormat, timeStyle, timeFormat, type DateFormat, type DisplayStyle } from './preferences';
import { refreshDateTimeSettings, refreshTimelineGutter } from './date-time-settings';
import { clockSelection } from './date-display';
import { entityStats } from './entity-relations';
import { connectControl } from './control';
import { initializeAuth, RECONNECT_GUIDANCE, type AuthState } from './auth';

interface AppState {
  store: Store | null;
  filter: EntityRef | null;
  doc: DocRef | null;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  timeStyle: DisplayStyle;
  expandProjects: boolean;
  expandActions: boolean;
  searchShortcutEnabled: boolean;
  instanceId: string | null;
  instance: AvailableInstance | null;
  // Traversed weeks, including failed slots; success is tracked per WeekView.
  loadedWeeks: number;
  darkMode: boolean;
  // Panel retracted to the docked filter pill — a user preference, not view
  // state; it survives navigation and reloads.
  panelCollapsed: boolean;
  // Animation-speed multiplier over the base transition durations: 0 disables
  // motion, 1 is the default pace, >1 slows it. Scales the CSS --duration-*
  // vars, the FLIP slide, and the cleanup timers together.
  animSpeed: number;
}

const state: AppState = {
  store: null,
  filter: null,
  doc: null,
  timeFormat: timeFormat(localStorage.getItem('timeFormat')),
  dateFormat: dateFormat(localStorage.getItem('dateFormat')),
  timeStyle: timeStyle(localStorage.getItem('timeStyle')),
  expandProjects: localStorage.getItem('expandProjects') === 'true',
  expandActions: localStorage.getItem('expandActions') === 'true',
  searchShortcutEnabled: localStorage.getItem('searchShortcutEnabled') !== 'false',
  instanceId: readInstanceLocation(window.location.pathname).instanceId,
  instance: null,
  loadedWeeks: 0,
  darkMode: localStorage.getItem('darkMode') === 'true' ||
    (!localStorage.getItem('darkMode') && window.matchMedia('(prefers-color-scheme: dark)').matches),
  panelCollapsed: localStorage.getItem('panelCollapsed') === 'true',
  animSpeed: animationSpeed(localStorage.getItem('animSpeed')),
};
const iframeQueries = createIframeQueryBridge();

if (localStorage.getItem('animSpeed') !== null) localStorage.setItem('animSpeed', String(state.animSpeed));

// The base transition durations (ms) at 1× speed; --duration-normal drives the
// slide/fade length, matched here for the JS-side cleanup timers. The
// animation-speed setting scales these — see applyAnimSpeed.
const BASE_DURATIONS = { fast: 150, normal: 200, slow: 300 };
let transitionMs = BASE_DURATIONS.normal;
// A jump's scroll glide, scaled like the transitions — instant when motion is
// Off or reduced.
const jumpDuration = () => REDUCED_MOTION.matches ? 0 : BASE_DURATIONS.slow * state.animSpeed;

// Scale every transition duration by the animation-speed setting: the CSS
// --duration-* vars (driving CSS transitions), the FLIP slide, and the JS
// cleanup timers, so they always stay in lockstep. Under prefers-reduced-motion
// the CSS media query zeroes the vars itself, so leave them unset (an inline
// override would defeat it) and only sync the JS timers.
function applyAnimSpeed(): void {
  const mult = state.animSpeed;
  const root = document.documentElement;
  if (REDUCED_MOTION.matches) {
    root.style.removeProperty('--duration-fast');
    root.style.removeProperty('--duration-normal');
    root.style.removeProperty('--duration-slow');
  } else {
    root.style.setProperty('--duration-fast', `${BASE_DURATIONS.fast * mult}ms`);
    root.style.setProperty('--duration-normal', `${BASE_DURATIONS.normal * mult}ms`);
    root.style.setProperty('--duration-slow', `${BASE_DURATIONS.slow * mult}ms`);
  }
  transitionMs = REDUCED_MOTION.matches ? 0 : BASE_DURATIONS.normal * mult;
  if (!transitionMs) cancelDisplayMotion();
  setSlideMs(transitionMs);
}

function sameFilter(a: EntityRef | null, b: EntityRef | null): boolean {
  return a === b || (!!a && !!b && a.type === b.type && a.id === b.id);
}

function sameDoc(a: DocRef | null, b: DocRef | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'asset' && b.kind === 'asset') return a.path === b.path;
  if (a.kind === 'artifact' && b.kind === 'artifact') return a.id === b.id && a.filename === b.filename;
  return true;
}

function selectedArtifactPath(id: string, filename?: string, store: Store | null = state.store): string | null {
  const artifact = store?.getCachedArtifact(id);
  const selected = filename ?? (artifact && artifactContentFilename(artifact));
  if (selected === undefined) return null;
  try { return artifactAttachmentRelativePath(id, selected); }
  catch { return null; }
}

// The artifact references behind the embedded images a selector matches.
function artifactImageRefs(selector: string): ArtifactReference[] {
  return Array.from(document.querySelectorAll<HTMLImageElement>(selector)).flatMap(image => {
    const ref = parseArtifactHandle(image.dataset.artifactHandle ?? '');
    return ref ? [ref] : [];
  });
}

function artifactImageFiles(selector: string): string[] {
  return artifactImageRefs(selector).flatMap(ref => {
    const path = selectedArtifactPath(ref.id, ref.filename);
    return path ? [path] : [];
  });
}

function artifactImageIds(selector: string): string[] {
  return artifactImageRefs(selector).map(ref => ref.id);
}

function webpageFiles(root: ParentNode | null): string[] {
  const paths = new Set<string>();
  for (const source of webpageSources(root)) {
    if (source.path) paths.add(source.path);
    if (!source.artifactId) continue;
    const artifact = state.store?.getCachedArtifact(source.artifactId);
    for (const filename of artifact?.frontMatter.attachments ?? []) {
      paths.add(artifactAttachmentRelativePath(source.artifactId, filename));
    }
  }
  // Register sibling resources for metadata checks without reading their bytes.
  for (const path of paths) state.store?.assetUrl(path);
  return [...paths];
}

let stopDisplayClock: (() => void) | undefined;
function refreshTimeDisplay(): void {
  refreshDateTimeSettings(state);
  const containers = [$('#flow-scroll'), $('#side-panel-body'), $('#doc-body'), $('#instance-chooser')].filter((node): node is HTMLElement => node !== null);
  preserveDisplayPosition(containers, () => {
    refreshTimelineGutter(state);
    if (!$('#instance-chooser')?.hidden) instanceChooser?.redraw();
    if (state.store) {
      refreshDisplay(document.body, { ...getRenderOpts(), liveDurationMs: transitionMs }, transitionMs);
      updateLatch();
    }
  });
  if (!state.store) return;
  datePicker.refresh();
  void refreshPlanningWindow();
}

function getRenderOpts(): RenderOptions {
  const nowDate = new Date();
  const now = toStampStr(nowDate);
  const store = state.store;
  const filter = state.filter;
  const instanceId = state.instanceId;
  const instance = state.instance;
  const hrefFor = (route: string) => instanceId === null ? '/' : instanceUrl(instanceId, route);
  return {
    timeFormat: state.timeFormat,
    dateFormat: state.dateFormat,
    timeStyle: state.timeStyle,
    now,
    nowDate,
    expandProjects: state.expandProjects,
    expandActions: state.expandActions,
    activeFilter: filter,
    onAssetClick: openAsset,
    assetFileUrl: path => store?.assetUrl(path) ?? null,
    onWebpageReady: frame => {
      if (!instance || !store) return;
      const source = webpageSource(frame);
      const artifact = source?.artifactId ? store.getCachedArtifact(source.artifactId) : undefined;
      const filename = source?.path?.split('/').at(-1);
      if (!filename || !artifact?.frontMatter.attachments?.includes(filename)) return;
      const address = instance.alias ?? instanceId;
      if (!address) return;
      iframeQueries.register(frame, {
        instance: address,
        fileUrl: path => store.assetUrl(path),
        isCurrent: () => state.store === store && state.instance?.path === instance.path,
        query: (request, signal) => queryDaemonInstance(address, request, signal),
      });
    },
    onArtifactClick: openArtifact,
    resolveArtifactName: id => store?.getArtifactDisplayName(id) ?? id,
    artifactHref: (id, filename) => hrefFor(buildRoute({ filter: filter, doc: { kind: 'artifact', id, filename } })),
    artifactFileUrl: (id, filename) => {
      const path = selectedArtifactPath(id, filename, store);
      return path ? store?.assetUrl(path) ?? null : null;
    },
    onEntryTimeClick: (id) => { void jumpToEntry(id, true, null, 'start'); },
    onDateClick: date => {
      void applyView({ filter: state.filter?.type === 'entry' ? null : state.filter, doc: null, date });
    },
    routeHref: (route) => hrefFor(route),
    resolveName: (type, id) => {
      if (type !== 'entry') return store?.getDisplayName(type, id) ?? id;
      // An entry id (an ISO timestamp) reads as its date plus formatted time.
      if (isNaN(new Date(id).getTime())) return id;
      return formatStamp(id, state);
    },
    refMarks: (type, id) => {
      if (type === 'project') {
        const project = store?.getCachedProject(id);
        return project ? projectMarks(project.frontMatter) : [];
      }
      if (type === 'action') {
        const action = store?.getCachedAction(id);
        return action ? actionMarks(action.frontMatter, nowDate) : [];
      }
      return [];
    },
    onTagClick: handleTagClick,
  };
}

function $<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

// The side panel's chrome (show/hide, the docked pill, history restores, focus
// bookkeeping); what it shows is showSidePanel below.
const {
  hidePanelElement, showPanelElement, closeSidePanel, collapsePanel, expandPanel, updateFilterPill,
  panelSnapshot, stampPanel, restorePanelView, holdPanelFocus, restorePanelFocus, isPanelRestoring,
} = createSidePanel({ state, transitionMs: () => transitionMs, renderOpts: getRenderOpts, showSidePanel: () => showSidePanel(undefined, true), clearFilter });

// The search dropdown; a chosen row navigates like the matching tag click.
const searchUi = createSearchUi({
  store: () => state.store,
  renderOpts: getRenderOpts,
  onSelect: result => {
    if (result.type === 'date') {
      // Match entity navigation: a selection always leaves the reader.
      if (state.doc) closeDoc();
      void jumpToDate(result.id);
    } else if (result.type === 'artifact') {
      openArtifact(result.id);
    } else {
      handleTagClick({ type: result.type, id: result.id });
    }
  },
});
const { setupSearch, handleSearch, setSearchVisible, resetSearch } = searchUi;

function setupPanelResize(): void {
  bindPanelResize({ collapse: collapsePanel, expand: expandPanel, transitionMs: () => transitionMs });
}

// Wire a settings control: seed it from the persisted state, then apply and
// persist on every change.
function bindSelect(selector: string, value: string, apply: (v: string) => void): void {
  const el = $<HTMLSelectElement>(selector);
  if (!el) return;
  el.value = value;
  el.addEventListener('change', () => apply(el.value));
}

function bindCheckbox(selector: string, value: boolean, apply: (v: boolean) => void): void {
  const el = $<HTMLInputElement>(selector);
  if (!el) return;
  el.checked = value;
  el.addEventListener('change', () => apply(el.checked));
}

let diagramThemeRevision = 0;
async function refreshDiagramTheme(): Promise<void> {
  const revision = ++diagramThemeRevision;
  const store = state.store;
  if (!store) return;
  const current = () => revision === diagramThemeRevision && store === state.store;
  // A theme change may arrive during a rebuild or flight. Its replacement
  // SVGs must not change the geometry those operations have already measured.
  while (weeksLoad || flowTransition || flowRestoring) {
    await (weeksLoad ?? flowTransition ?? new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    if (!current()) return;
  }
  const flowVersion = flowGeneration;
  const docVersion = docLoadGeneration;
  const roots = [$('#flow'), $('#side-panel-body'), $('#doc-body')].filter((root): root is HTMLElement => root !== null);
  await Promise.all(roots.map(root => renderDiagrams(root, {
    current: () => current() && (root.id !== 'flow' || flowVersion === flowGeneration)
      && (root.id !== 'doc-body' || docVersion === docLoadGeneration),
    commit: paint => {
      const container = root.id === 'flow' ? $('#flow-scroll') ?? root : root;
      preserveReadingPosition([container], paint);
      if (root.id === 'flow') updateLatch();
    },
  })));
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.darkMode ? 'dark' : 'light');
  $('#btn-theme-toggle')?.setAttribute('aria-pressed', String(state.darkMode));
  void refreshDiagramTheme();
}

function setupDateTimeSettings(): void {
  bindSelect('#setting-time-format', clockSelection(state.timeFormat), (v) => {
    state.timeFormat = timeFormat(v);
    localStorage.setItem('timeFormat', state.timeFormat);
    refreshTimeDisplay();
  });

  bindSelect('#setting-date-format', state.dateFormat, v => {
    state.dateFormat = dateFormat(v);
    localStorage.setItem('dateFormat', state.dateFormat);
    refreshTimeDisplay();
  });
  bindSelect('#setting-time-style', state.timeStyle, v => {
    state.timeStyle = timeStyle(v);
    localStorage.setItem('timeStyle', state.timeStyle);
    refreshTimeDisplay();
  });
  refreshDateTimeSettings(state);
  refreshTimelineGutter(state);
}

function init() {
  setDisplayContext(getRenderOpts);
  applyTheme();
  applyAnimSpeed();
  // Re-sync when the OS reduced-motion preference flips mid-session, so the
  // scaled durations give way to (or return from) the media query's zeros.
  REDUCED_MOTION.addEventListener('change', applyAnimSpeed);

  applyStoredPanelWidth();
  setupPanelResize();
  setupRefCoHover();
  setupInstanceTooltips();
  $('.app-title a')?.addEventListener('click', event => {
    const click = event as MouseEvent;
    if (click.button || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    event.preventDefault(); history.pushState(null, '', '/'); void showInstanceChooser();
  });
  const switcher = $('#instance-switcher');
  if (switcher) instanceSwitcher = new InstanceSwitcher(switcher,
    instance => { void connectToInstance(instance.address ?? instance.id, instance); },
    () => { history.pushState(null, '', '/'); void showInstanceChooser(); }, undefined,
    instances => ensureInstanceChooser()?.setCatalogue(instances));
  $('#btn-side-panel-collapse')?.addEventListener('click', () => collapsePanel());

  $('#btn-theme-toggle')?.addEventListener('click', () => {
    state.darkMode = !state.darkMode;
    localStorage.setItem('darkMode', String(state.darkMode));
    applyTheme();
  });

  $('#btn-settings')?.addEventListener('click', () => showConfigModal());
  $('#btn-modal-close')?.addEventListener('click', () => hideConfigModal());
  $('#btn-side-panel-close')?.addEventListener('click', () => clearFilter());
  $('#btn-doc-close')?.addEventListener('click', () => closeDoc());
  setupModals();

  setupSearch();

  setupDateTimeSettings();

  bindCheckbox('#setting-expand-projects', state.expandProjects, (v) => {
    state.expandProjects = v;
    localStorage.setItem('expandProjects', String(v));
    void renderFlow(timeCursorAnchor(), false, true);
  });

  bindCheckbox('#setting-expand-actions', state.expandActions, (v) => {
    state.expandActions = v;
    localStorage.setItem('expandActions', String(v));
    void renderFlow(timeCursorAnchor(), false, true);
  });

  bindSelect('#setting-anim-speed', String(state.animSpeed), (v) => {
    state.animSpeed = animationSpeed(v);
    localStorage.setItem('animSpeed', String(state.animSpeed));
    applyAnimSpeed();
  });

  bindCheckbox('#setting-search-shortcut', state.searchShortcutEnabled, (enabled) => {
    state.searchShortcutEnabled = enabled;
    localStorage.setItem('searchShortcutEnabled', String(enabled));
  });

  initializeAuth(authenticationChanged);

  // popstate covers back/forward over pushState entries, hashchange covers
  // hand-edited fragments; the shared handler dedupes the overlap.
  window.addEventListener('popstate', handleLocationChange);
  window.addEventListener('hashchange', handleLocationChange);

  // Any interaction resets the quiet gap a staged catch-up update waits for.
  // Capture-phase so pane scrolls (which don't bubble) count too.
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'scroll'] as const) {
    window.addEventListener(ev, bumpActivity, { passive: true, capture: true });
  }

  // Refresh the current history entry's anchor as the user scrolls, so
  // back/forward restores the view as it was left, not as first entered.
  // Debounced: scroll fires continuously and replaceState is rate-limited
  // in some browsers.
  let stampTimer: ReturnType<typeof setTimeout>;
  $('#flow-scroll')?.addEventListener('scroll', () => {
    // The scroll a restore drives fires here too — skip it so it can't stamp a
    // transient mid-restore position over the entry being restored.
    if (flowRestoring) return;
    clearTimeout(stampTimer);
    stampTimer = setTimeout(() => {
      // Re-check: a navigation inside the debounce window may have started a
      // restore whose fresh history entry this stamp would overwrite.
      if (flowRestoring) return;
      const nav = (history.state ?? {}) as NavState;
      history.replaceState({ ...nav, anchor: timeCursorAnchor() }, '');
    }, 400);
  }, { passive: true });

  // The latched date readout tracks the top edge on every scroll frame — the
  // anchor stamp above is debounced, this must not be.
  let latchFrame = 0;
  $('#flow-scroll')?.addEventListener('scroll', () => {
    if (latchFrame) return;
    latchFrame = requestAnimationFrame(() => { latchFrame = 0; updateLatch(); });
  }, { passive: true });
  window.addEventListener('resize', () => { resetReadoutPad(); updateLatch(); });
  window.matchMedia('(max-width: 768px)').addEventListener('change', refreshTimeDisplay);

  // Keep the current entry's panel state current the same way as its flow
  // anchor: stamp on scroll (debounced) and whenever a section is expanded,
  // so a later back/forward restores the panel where it was left.
  const panelBody = $('#side-panel-body');
  let panelStampTimer: ReturnType<typeof setTimeout>;
  panelBody?.addEventListener('scroll', () => {
    // The scroll a restore sets fires here too — skip it so it can't arm a
    // stamp that would overwrite the state being restored.
    if (isPanelRestoring()) return;
    clearTimeout(panelStampTimer);
    panelStampTimer = setTimeout(stampPanel, 400);
  }, { passive: true });
  panelBody?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.related-more')) stampPanel();
  });
}

let readerModal: ModalController | undefined;
let settingsModal: ModalController | undefined;

function setupModals(): void {
  const prepareModal = () => { datePicker.close(); setSearchVisible(false); };
  const fallback = () => document.querySelector<HTMLElement>('.app-title a');
  readerModal = createModal($<HTMLDialogElement>('#doc-backdrop')!, {
    dismiss: closeDoc, beforeOpen: prepareModal, fallback, duration: () => transitionMs,
  });
  settingsModal = createModal($<HTMLDialogElement>('#modal-backdrop')!, {
    dismiss: hideConfigModal, beforeOpen: prepareModal, fallback, duration: () => transitionMs,
  });
}

let statusSelection: AvailableInstance | undefined;
function showConfigModal(instance?: AvailableInstance) { statusSelection = instance; renderInstanceStatus(instance); settingsModal?.open(); if (!instance) void refreshInstanceMetadata(); }
function hideConfigModal() { settingsModal?.close(); statusSelection = undefined; }

function renderInstanceStatus(selection?: AvailableInstance): void {
  const instance = selection ?? statusSelection ?? state.instance;
  instanceSwitcher?.setActive(state.instance);
  const host = $('#setting-instance-status');
  if (!host) return;
  host.replaceChildren();
  host.hidden = !instance?.calendarWarning && !instance?.worktree?.linked && !instance?.duplicatePaths?.length;
  if (host.hidden || !instance) return;
  const heading = document.createElement('h3');
  heading.className = 'settings-heading'; heading.textContent = `${instance.name || instance.id} calendar sync`;
  host.append(heading);
  const message = (text: string, warning = false) => {
    const p = document.createElement('p');
    p.className = `instance-status-message${warning ? ' instance-status-warning' : ''}`;
    p.textContent = text; host.append(p);
  };
  if (instance.duplicatePaths?.length) {
    const warning = document.createElement('p'); warning.className = 'instance-status-message instance-status-warning'; warning.innerHTML = WARNING_ICON;
    warning.append(' Duplicated ID '); const id = document.createElement('code'); id.textContent = instance.id;
    warning.append(id, '. Calendar sync is paused for primary instances.'); host.append(warning);
    message(`Conflicting instance paths:\n${instance.duplicatePaths.join('\n')}`);
    message('Give distinct instances unique IDs in aside.md. Worktrees of the same instance keep the same ID.');
  } else if (instance.calendarWarning) message(instance.calendarWarning, true);
  const path = document.createElement('p'); path.className = 'instance-status-message';
  const code = document.createElement('code'); code.textContent = instance.path; path.append(code); host.append(path);
  if (instance.worktree?.linked) message(`Calendar sync is disabled for Git worktrees. Move these changes into the primary checkout for calendar sync.\nPrimary instance: ${instance.worktree.primaryPath}`);
}

async function refreshInstanceMetadata(): Promise<void> {
  const instance = state.instance;
  if (!instance) return;
  try {
    const current = await daemonRequest<AvailableInstance>(`instances/${encodeURIComponent(instance.alias ?? state.instanceId!)}`);
    if (state.instance !== instance || current.path !== instance.path) return;
    state.instance = current;
    const address = current.address ?? current.id;
    if (state.instanceId !== address) {
      state.instanceId = address;
      const route = readInstanceLocation(window.location.pathname).route;
      history.replaceState(history.state, '', `${instanceUrl(address, route)}${window.location.search}${window.location.hash}`);
    }
    renderInstanceStatus();
  } catch { /* Existing data checks expose unavailable instances and retry. */ }
}

// Bumped per connect attempt: a slower, older connect resolving after a newer
// one must not install its store, stop the newer refresh loop, or reopen the
// config modal — completion order is not initiation order.
let connectGeneration = 0;
// Navigation intent, independent of flow rebuilds. A document change or a
// newer jump can supersede a cold note lookup without rebuilding the flow.
let navigationGeneration = 0;

let stopSearchCorpus: (() => void) | undefined;
let stopDiagnostics: (() => void) | undefined;

let stopControl: (() => void) | undefined;
let authentication: AuthState | undefined;

function authenticationChanged(next: AuthState): void {
  authentication = next;
  const switchButton = $<HTMLButtonElement>('#btn-instance-switch');
  if (switchButton) switchButton.disabled = next !== 'authorized';
  if (next === 'authorized') { void openCurrentLocation(); return; }
  ++connectGeneration;
  stopControl?.(); stopControl = undefined;
  settingsModal?.close(0); statusSelection = undefined;
  clearInstanceView();
  instanceChooser?.dispose(); instanceChooser = undefined;
  instanceSwitcher?.close(); instanceSwitcher?.setCatalogue([]);
  state.instanceId = readInstanceLocation(window.location.pathname).instanceId;
  for (const selector of ['#flow', '#side-panel-body', '#doc-body', '#instance-list', '#instance-switch-list', '#search-listbox', '#data-diagnostics-files', '#setting-instance-status']) {
    $(selector)?.replaceChildren();
  }
  weekViews.clear(); currentViewWeeks = [];
  const instancePath = $<HTMLInputElement>('#instance-add-path'); if (instancePath) instancePath.value = '';
  const chooser = $('#instance-chooser'); if (chooser) chooser.hidden = true;
  const scroller = $('#flow-scroll'); if (scroller) scroller.hidden = false;
  const indicator = $<HTMLButtonElement>('#connection-status');
  if (indicator) { indicator.hidden = true; indicator.onclick = null; }
  const flow = $('#flow');
  if (flow) showNotice(flow, next === 'checking'
    ? { kind: 'loading', message: 'Connecting to Aside…' }
    : next === 'offline' ? { kind: 'error', message: 'Could not connect to Aside. Reopen this tab after the daemon is available.', description: RECONNECT_GUIDANCE }
      : { kind: 'warning', message: RECONNECT_GUIDANCE });
}

function controlFor(instanceId: string | null, userInitiated = false): void {
  stopControl?.();
  if (authentication !== undefined && authentication !== 'authorized') return;
  let lastState: string | undefined;
  let reportFailure = userInitiated;
  const indicator = $<HTMLButtonElement>('#connection-status');
  if (indicator) indicator.onclick = () => controlFor(instanceId, true);
  stopControl = connectControl(instanceId, navigateToRoute, (connected, retrying = true) => {
    const connectionState = connected ? 'connected' : retrying ? 'retrying' : 'unavailable';
    if (!indicator || connectionState === lastState) return;
    lastState = connectionState;
    indicator.hidden = connected;
    indicator.dataset.connection = connectionState;
    indicator.setAttribute('aria-label', connected ? 'Connected' : retrying ? 'Offline, reconnecting' : 'Offline, reconnect');
    indicator.title = retrying ? 'Offline. Reconnecting automatically. Click to retry.' : 'Offline. Click to reconnect.';
    if (!connected && reportFailure) showActionFailure('Could not reconnect. Try again.');
    reportFailure = false;
  });
}

let cancelEntryArrival: (() => void) | undefined;

function clearInstanceView(): void {
  iframeQueries.clear();
  dismissActionToast();
  $('#flow-scroll')?.querySelectorAll(':scope > .instance-startup-notice').forEach(notice => notice.remove());
  cancelEntryArrival?.(); cancelEntryArrival = undefined;
  navigationGeneration++;
  cancelDisplayMotion();
  stopDisplayClock?.();
  stopDisplayClock = undefined;
  stopRefresh?.();
  stopRefresh = null;
  state.store = null;
  state.instance = null;
  renderInstanceStatus();
  flowInitialized = false;
  stopDiagnostics?.(); stopDiagnostics = undefined;
  stopSearchCorpus?.(); stopSearchCorpus = undefined;
  const diagnostics = $('#data-diagnostics'); if (diagnostics) diagnostics.hidden = true;
  flowGeneration++;
  // A different instance owns independent reads; its startup must not drain
  // a slow read from the instance the user just left.
  weeksLoad = null;
  docLoadGeneration++;
  datePicker.close();
  resetLatchMarkers();
  state.filter = null;
  state.doc = null;
  pendingControlRoute = null;
  appliedRoute = null;
  resetFilterUi();
  resetSearch(true);
  closeSidePanel();
  readerModal?.close(0);
  searchUi.setSearchEnabled(false);
}

let instanceChooser: InstanceChooser | undefined;
let instanceSwitcher: InstanceSwitcher | undefined;

function ensureInstanceChooser(): InstanceChooser | undefined {
  const chooser = $('#instance-chooser');
  if (!chooser) return undefined;
  return instanceChooser ??= new InstanceChooser(chooser, undefined, instance => { void connectToInstance(instance.address ?? instance.id, instance); }, {
    renderOptions: getRenderOpts, onCatalogue: instances => instanceSwitcher?.setCatalogue(instances), onStatus: showConfigModal,
  });
}

async function showInstanceChooser(): Promise<void> {
  if (authentication !== undefined && authentication !== 'authorized') return;
  instanceSwitcher?.close();
  ++connectGeneration;
  clearInstanceView();
  state.instanceId = null;
  controlFor(null);
  const chooser = $('#instance-chooser');
  const scroller = $('#flow-scroll');
  if (chooser) chooser.hidden = false;
  if (scroller) scroller.hidden = true;
  if (!chooser) return;
  ensureInstanceChooser();
  if (!instanceChooser) return;
  instanceChooser.resetOpening();
  await instanceChooser.refresh();
}

async function openCurrentLocation(): Promise<void> {
  if (authentication !== undefined && authentication !== 'authorized') return;
  const { instanceId } = readInstanceLocation(window.location.pathname);
  if (instanceId === null) return showInstanceChooser();
  return connectToInstance(instanceId);
}

async function connectToInstance(instanceId: string, selection?: AvailableInstance, userInitiated = !!selection): Promise<void> {
  if (authentication !== undefined && authentication !== 'authorized') return;
  const generation = ++connectGeneration;
  clearInstanceView();
  state.instanceId = instanceId;
  // The chooser channel keeps the daemon alive while an instance connects or
  // displays a recoverable error, without loading any other instance.
  controlFor(null);
  const chooser = $('#instance-chooser');
  const scroller = $('#flow-scroll');
  const selectionHadFocus = !!selection && (!!chooser?.contains(document.activeElement) || !!$('#instance-switcher')?.contains(document.activeElement));
  if (chooser) chooser.hidden = !selection;
  if (scroller) scroller.hidden = !!selection;
  if (!selection) instanceChooser?.resetOpening();
  const opening = selection ? instanceChooser?.showOpening(selection) : undefined;
  const flow = $('#flow');
  flow?.replaceChildren();
  const startupNotice = !selection && scroller ? document.createElement('div') : undefined;
  if (startupNotice) {
    startupNotice.className = 'instance-startup-notice';
    scroller!.prepend(startupNotice);
  }
  const cancelLoading = startupNotice
    ? showDelayedLoading(startupNotice, 'Loading instance…', () => generation === connectGeneration)
    : () => {};
  try {
    const { instance, source, store } = await loadDaemonInstance(instanceId);
    if (generation !== connectGeneration) return;
    state.store = store;
    state.instance = instance;
    state.instanceId = instance.address ?? instanceId;
    renderInstanceStatus();
    stopDiagnostics = store.subscribeDiagnostics(updateDiagnostics);
    updateDiagnostics();
    stopSearchCorpus = watchActiveSearch(store, {
      query: () => $<HTMLInputElement>('.search-input')?.value ?? '',
      activeQuery: searchUi.searchLastQuery,
      visible: () => state.store === store && searchUi.isSearchVisible(),
      refresh: handleSearch,
    });
    appliedRoute = selection ? '' : readInstanceLocation(window.location.pathname).route;
    const view = parseRoute(appliedRoute);
    const canonical = buildRoute(view);
    if (!selection && urlFor(canonical) !== window.location.pathname) history.replaceState(history.state, '', `${urlFor(canonical)}${window.location.search}${window.location.hash}`);
    appliedRoute = canonical;
    const nav = selection ? null : history.state as NavState | null;
    if (view.jump) {
      const applying = applyView({ filter: view.filter, doc: null }, { push: false, forceFlow: true, userInitiated });
      const navigation = navigationGeneration;
      await applying;
      if (state.store !== store || navigation !== navigationGeneration) return;
      // A cold deep link opens at its target. The single entrance below then
      // reveals those cards; only an already open timeline scrolls to a jump.
      await jumpToEntry(view.jump, false, null, 'center', userInitiated, 0);
    } else if (view.date || view.filter || view.doc) {
      await applyView(view, { push: false, forceFlow: true, anchor: nav?.anchor, panel: nav?.panel, userInitiated, jumpDuration: 0 });
    } else {
      await renderFlow(nav?.anchor, true, userInitiated);
    }
    if (generation !== connectGeneration) return;
    cancelLoading(); startupNotice?.remove();
    opening?.finish();
    if (chooser) chooser.hidden = true;
    let initialAnchor: FlowAnchor | null = null;
    if (scroller) {
      scroller.hidden = false;
      initialAnchor = timeCursorAnchor();
      updateLatchNow();
      const arrival = animateEntryArrival(scroller);
      cancelEntryArrival = arrival.cancel;
      flowTransition = arrival.finished;
      suppressLatch(true);
      void arrival.finished.then(() => {
        if (flowTransition === arrival.finished) flowTransition = null;
        if (generation !== connectGeneration || cancelEntryArrival !== arrival.cancel) return;
        cancelEntryArrival = undefined;
        updateLatchNow(); suppressLatch(false);
      });
    }
    if (selection) {
      history.pushState(null, '', urlFor(canonical));
      if (scroller && (chooser?.contains(document.activeElement) || (selectionHadFocus && (document.activeElement === document.body || $('#instance-switcher')?.contains(document.activeElement))))) {
        scroller.tabIndex = -1; scroller.focus({ preventScroll: true });
      }
    }
    stopDisplayClock = startDisplayClock(refreshTimeDisplay, MINUTE_MS);
    searchUi.setSearchEnabled(true);
    controlFor(instance.alias ?? state.instanceId);
    stopRefresh = startRefresh({
      check: async (scope, changedPaths) => { await refreshInstanceMetadata(); return store.check(scope, currentHotSet(), changedPaths); },
      isQuiet,
      apply: update => { if (state.store === store) return applyDataUpdate(update); },
      hasValidators: () => store.hasValidators(),
      watch: source.watch.bind(source),
    });
    // History indexing starts after the visible timeline is ready.
    void store.warmSearch();
    if (!state.filter) void showSidePanel();
    history.replaceState({ ...nav, anchor: initialAnchor, engaged: nav?.engaged ?? null } satisfies NavState, '');
    if (pendingControlRoute !== null) {
      const route = pendingControlRoute;
      pendingControlRoute = null;
      navigateToRoute(route);
    }
  } catch (error) {
    if (generation !== connectGeneration) return;
    state.store = null;
    stopDisplayClock?.();
    stopDisplayClock = undefined;
    state.instance = null;
    renderInstanceStatus();
    stopRefresh?.();
    controlFor(null);
    if (selection) {
      clearInstanceView();
      state.instanceId = null;
      opening?.fail(error);
    } else if (flow) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => void connectToInstance(instanceId, undefined, true));
      const choose = document.createElement('a');
      choose.href = '/';
      choose.textContent = 'Choose an instance';
      const recovery = document.createElement('div'); recovery.className = 'instance-recovery';
      retry.className = choose.className = 'notice-action';
      recovery.append(retry, choose); flow.replaceChildren(recovery);
      if (userInitiated) showActionFailure('Could not open this instance. Try again.');
    }
  } finally { cancelLoading(); startupNotice?.remove(); }
}

function updateDiagnostics(): void {
  const store = state.store;
  const host = $('#data-diagnostics'), summary = $('#data-diagnostics-summary'), files = $('#data-diagnostics-files');
  if (!host || !summary || !files) return;
  const diagnostics = store?.getDiagnostics() ?? [];
  const opened = new Set(Array.from(files.querySelectorAll<HTMLElement>('.data-file-notice')).filter(notice => notice.querySelector<HTMLDetailsElement>('details')?.open).map(notice => notice.dataset.path));
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.data-file-notice')?.dataset.path;
  const scroll = files.scrollTop;
  host.hidden = diagnostics.length === 0;
  summary.textContent = `${diagnostics.length} file${diagnostics.length === 1 ? ' needs' : 's need'} attention · some records may be missing`;
  files.replaceChildren();
  if (!store) return;
  for (const diagnostic of diagnostics) files.append(fileDiagnosticNotice(diagnostic, async () => {
    if (store !== state.store) return;
    if (/^notes\/\d{4}\/\d{4}-\d{2}-\d{2}\.md$/.test(diagnostic.path)) {
      const view = weekViews.get(diagnostic.path.split('/').at(-1)!.slice(0, 10));
      if (view) await view.load(true);
      else await store.reloadFile(diagnostic.path);
    } else {
      await retryReadableFile(store, diagnostic.path);
      if (store !== state.store) return;
      await renderFlow(timeCursorAnchor());
      await showSidePanel(panelSnapshot());
      if (state.doc) await updateDoc(true);
    }
    updateDiagnostics();
  }));
  for (const notice of files.querySelectorAll<HTMLElement>('.data-file-notice')) {
    if (opened.has(notice.dataset.path)) notice.querySelector<HTMLDetailsElement>('details')!.open = true;
  }
  files.scrollTop = scroll;
  if (focused && !activeModal()) {
    const replacement = Array.from(files.querySelectorAll<HTMLElement>('.data-file-notice')).find(notice => notice.dataset.path === focused)?.querySelector<HTMLButtonElement>('button');
    (replacement ?? (host.hidden ? document.querySelector<HTMLElement>('.app-title a') : summary))?.focus({ preventScroll: true });
  }
  updateEmptyFlow();
}

// The entry the active filter was engaged from (the card whose tag was
// clicked), carried in each history entry's state so it survives
// back/forward. Dismissing the filter re-anchors it when still on screen —
// the round trip returns exactly the view the filter came from.
let engagedEntryId: string | null = null;

function dismissAnchor(): FlowAnchor | null {
  return (engagedEntryId && anchorForEntry(engagedEntryId)) || timeCursorAnchor();
}

// What a history entry's state carries: the view's last-seen position anchor
// (stamped on creation, refreshed as the user scrolls), the engaged entry, and
// the side panel's last-seen state.
interface NavState {
  anchor?: FlowAnchor | null;
  engaged?: string | null;
  panel?: PanelView | null;
}

// Incremented whenever the flow is reset; in-flight week loads check it after
// each await and stop appending once stale.
let flowGeneration = 0;
let weeksLoad: Promise<void> | null = null;
// The date and week of the last rendered entry — the next appended entry
// compares against them to decide whether a day boundary (and which units)
// or a week seam was crossed.
let lastMarkerDate: string | null = null;
let lastWeekFile: string | null = null;
// True while renderFlow drives the flow's scroll (the anchor restore and the
// week loads it chains). The programmatic scroll fires the same events a user
// scroll does; without this guard the stamp handler would overwrite the entry
// being restored with a transient mid-restore position, so back/forward would
// drift. Mirrors panelRestoring for the side panel.
let flowRestoring = false;
let flowTransition: Promise<void> | null = null;

// Restore a stored anchor onto the existing flow, no rebuild — a back/forward
// that lands on the same filter and document (returning from a jump) only needs
// the scroll it was left at. The guard keeps this programmatic scroll from
// re-stamping the entry. Falls back to a full render when the anchor's card
// isn't loaded (a jump that grew the flow past where it sat).
function restoreFlowScroll(anchor: FlowAnchor) {
  const flow = $('#flow');
  const scroller = $('#flow-scroll');
  if (!flow || !scroller) return;
  if (!flow.querySelector(`[data-entry-id="${CSS.escape(anchor.entryId)}"]`)) {
    void renderFlow(anchor, false, true);
    return;
  }
  flowRestoring = true;
  restoreAnchor(scroller, flow, anchor);
  requestAnimationFrame(() => { flowRestoring = false; });
}

async function renderFlow(anchor: FlowAnchor | null = null, initial = false, userInitiated = false) {
  const flow = $('#flow');
  const scroller = $('#flow-scroll');
  if (!state.store || !flow || !scroller) return;
  // A rebuild and its flights hold off any staged catch-up update.
  bumpActivity();

  // First half of the FLIP pass: capture the outgoing cards' positions while
  // they still have layout. Anchored navigations play the full FLIP;
  // unanchored ones degrade to a crossfade of the old view into the new
  // timeline's top.
  const snapshot = initial ? null : snapshotFlow(scroller);
  cancelEntryArrival?.(); cancelEntryArrival = undefined;
  // The chip the picker anchors to is recreated below — dismiss it first so it
  // can't linger over a stale position.
  datePicker.close();
  // Hold the readout for the whole rebuild+transition — progressive week
  // loads and stepped scroll restores would otherwise flicker it through
  // wrong dates. Cleared once the geometry settles, below.
  suppressLatch(true);
  flowRestoring = true;
  // Without an anchor — the first render, or a reset from an empty view —
  // the flow reads from the top, latest entry first.
  if (!anchor) scroller.scrollTo(0, 0);

  const rebuilding = ++flowGeneration;
  const store = state.store;
  flowInitialized = false;
  // Clear right away so stale content never lingers while loads drain —
  // the generation bump above stops in-flight loads from appending here.
  flow.innerHTML = '';
  // Drain any in-flight loads — they notice the new generation and stop.
  while (weeksLoad) {
    await weeksLoad;
    if (rebuilding !== flowGeneration || state.store !== store) return;
  }
  // Invalidate loads started while draining; from here to starting the new
  // load below is synchronous, so nothing else can slip in.
  flowGeneration++;
  const generation = flowGeneration;

  flow.innerHTML = '';
  state.loadedWeeks = 0;
  weekViews.clear();
  currentViewWeeks = computeViewWeeks();
  lastMarkerDate = null;
  lastWeekFile = null;
  resetLatchMarkers();
  mountLatch(flow, datePicker.toggle, () => state);

  // The anchor's card must exist before the scroll can be restored — load
  // down to its week. Its entries are already cached (the card was on
  // screen), so this doesn't wait on the network.
  let count = 5;
  if (anchor) {
    const target = currentViewWeeks.indexOf(entryWeek(anchor.entryId));
    if (target >= 0) count = Math.max(count, target + 1);
  }
  await loadMoreWeeks(count, userInitiated);
  if (generation !== flowGeneration) return;
  flowInitialized = true;
  setupInfiniteScroll();
  updateEmptyFlow();
  let resolved: FlowAnchor | null = null;
  if (anchor) {
    // Pinning the moment needs both of its neighbors — keep loading until
    // a card at-or-before it is rendered (the oldest rendered card, since
    // the flow is latest-first) or the timeline ends.
    while (state.loadedWeeks < currentViewWeeks.length) {
      const cards = flow.querySelectorAll<HTMLElement>('[data-entry-id]');
      const oldest = cards[cards.length - 1]?.dataset.entryId;
      if (oldest && oldest <= anchor.entryId) break;
      await loadMoreWeeks(3, userInitiated);
      if (generation !== flowGeneration) return;
    }
    resolved = restoreAnchor(scroller, flow, anchor);
    // Keep loading until both the anchor reaches its remembered offset and the
    // pane below it is built out to the viewport's bottom, so the flight runs
    // against a full page. Weeks load latest-first, so above the anchor the
    // flow is always complete; only below needs filling. The restore clamps
    // two ways, each needing more loaded below: an anchor that sank (too little
    // beneath it) shows as anchorShortfall; an anchor forced to the top (the
    // newest match, nothing above to seat it lower) sits fine but leaves a pane
    // of blank below — shown by viewportGapBelow.
    while (resolved
        && (anchorShortfall(scroller, resolved) > 1 || viewportGapBelow(scroller) > 1)
        && state.loadedWeeks < currentViewWeeks.length) {
      await loadMoreWeeks(3, userInitiated);
      if (generation !== flowGeneration) return;
      restoreAnchor(scroller, flow, anchor);
    }
  }
  // The readout swaps once here, on settled geometry — the single update for
  // the whole rebuild. It stays suppressed through the flights (card rects
  // carry in-flight transforms) and is refreshed and released only when they
  // settle. A superseded render leaves the flag for its successor to own.
  updateLatchNow();
  if (snapshot) {
    const transition = animateFlow(scroller, snapshot);
    flowTransition = transition;
    void transition.then(() => {
      if (flowTransition === transition) flowTransition = null;
      if (generation !== flowGeneration) return;
      updateLatchNow();
      suppressLatch(false);
    });
  } else {
    suppressLatch(false);
  }
  // Release the stamp guard one frame on, after the restore's scroll events
  // have dispatched — but only if this render is still current, so a newer
  // render that took over keeps its own guard until it settles.
  requestAnimationFrame(() => {
    if (generation !== flowGeneration) return;
    flowRestoring = false;
    readerModal?.ensureFocus();
  });
}

// The week list the current view loads from — set at the start of each render
// and held stable through that render's chained loads and the scroll sentinel,
// so state.loadedWeeks stays a valid index even if background warming finishes
// mid-session. A filtered flow lists only the weeks holding a match, skipping
// the empty ones the raw stream would fetch and walk; unfiltered, it's every
// week; and it falls back to every week until the store is warmed enough to
// know the matches from memory.
let currentViewWeeks: string[] = [];
let flowInitialized = false;
const weekViews = new Map<string, WeekView>();
function computeViewWeeks(): string[] {
  const store = state.store!;
  if (state.filter) {
    const matching = store.filterWeeks(state.filter);
    if (matching) return matching;
  }
  return store.getWeeklyDates();
}

function loadMoreWeeks(count: number, userInitiated = false): Promise<void> {
  if (weeksLoad) return weeksLoad;
  const pending = doLoadWeeks(count, userInitiated).finally(() => { if (weeksLoad === pending) weeksLoad = null; });
  weeksLoad = pending;
  return weeksLoad;
}

async function doLoadWeeks(count: number, userInitiated = false) {
  const generation = flowGeneration;
  const store = state.store!;
  const weeks = currentViewWeeks;
  const start = state.loadedWeeks;
  const end = Math.min(start + count, weeks.length);
  const flow = $('#flow');
  if (!flow) return;
  if (start >= weeks.length) return;

  const sentinel = document.getElementById('scroll-sentinel');
  const cancelLoading = delayLoading(() => { if (sentinel) sentinel.className = 'scroll-sentinel loading'; },
    () => generation === flowGeneration && store === state.store);

  try {
    for (let i = start; i < end; i++) {
      const monday = weeks[i];
      let retryAnchor: FlowAnchor | null = null;
      let attempts = 0;
      let retrying = false;
      const view = createWeekView(monday, {
        renderOpts: getRenderOpts,
        read: async () => {
          retrying = attempts++ > 0; retryAnchor = timeCursorAnchor();
          if (retrying) await store.reloadFile(weekFilePath(monday));
          return store.getWeekEntries(monday);
        },
        current: () => generation === flowGeneration && store === state.store,
        focusFallback: () => $('.app-title a'),
        render: async (entries, host) => {
          const opts = getRenderOpts();
          const visible = state.filter ? filterEntries(entries, state.filter) : entries;
          for (const entry of visible) {
            const date = entry.meta.created.slice(0, 10);
            const marker = !retrying && date !== lastMarkerDate
              ? { date, prev: lastMarkerDate, weekStart: lastWeekFile !== null && entry.weekFile !== lastWeekFile }
              : undefined;
            const card = renderEntry(entry, opts, host, marker);
            if (!retrying) { lastMarkerDate = date; lastWeekFile = entry.weekFile; }
            const markerNode = card.querySelector<HTMLElement>('.date-marker');
            if (markerNode) addLatchMarker(markerNode);
          }
          const diagnostic = store.diagnosticsFor(weekFilePath(monday));
          if (diagnostic) host.append(fileDiagnosticNotice(diagnostic, () => view.load(true)));
          await renderDiagrams(host, {
            current: () => generation === flowGeneration && store === state.store && flow.contains(host),
            commit: paint => preserveReadingPosition([$('#flow-scroll') ?? flow], paint),
          });
        },
        settled: retry => {
          if (retry) refreshFlowMarkers(flow);
          if (retry && retryAnchor) {
            const scroller = $('#flow-scroll');
            if (scroller) restoreAnchor(scroller, flow, retryAnchor);
          }
          updateEmptyFlow();
          updateLatch();
        },
      });
      weekViews.set(monday, view);
      flow.insertBefore(view.host, sentinel ?? null);
      await view.load(false, userInitiated);
      if (generation !== flowGeneration) return;
    }
    if (generation !== flowGeneration) return;
  } finally { cancelLoading(); }

  state.loadedWeeks = end;

  if (sentinel) {
    flow.appendChild(sentinel);
    if (end >= weeks.length && !state.filter) {
      // Only the unfiltered timeline gets the closing marker — a filtered
      // view is an excerpt, not the whole story, so it just stops.
      sentinel.className = 'scroll-sentinel end';
      sentinel.textContent = 'The End';
    } else {
      sentinel.className = 'scroll-sentinel';
      sentinel.textContent = '';
      // A filtered view is sparse — a batch of loaded weeks can contribute no
      // cards and add no height, leaving the sentinel still in view. The
      // observer is edge-triggered and won't re-fire for an unchanged
      // intersection, so re-arm it: re-observing re-delivers the current state
      // and chains the next load until the sentinel is pushed off-screen or the
      // timeline ends. Unfiltered loads add height and settle after one pass.
      if (end < weeks.length && scrollObserver) {
        scrollObserver.unobserve(sentinel);
        scrollObserver.observe(sentinel);
      }
    }
  }

  updateEmptyFlow();

  // Appends can happen without a scroll event (the observer fires while the
  // user is stationary) — refresh the readout so new markers and seams in
  // its active zones take effect immediately.
  updateLatch();
}

function refreshFlowMarkers(flow: HTMLElement): void {
  resetLatchMarkers();
  lastMarkerDate = null;
  lastWeekFile = null;
  for (const card of flow.querySelectorAll<HTMLElement>('.week-view > .entry-card')) {
    const id = card.dataset.entryId!;
    const date = id.slice(0, 10), week = entryWeek(id);
    const margin = card.querySelector<HTMLElement>('.entry-margin');
    margin?.querySelector('.date-marker')?.remove();
    card.classList.toggle('week-start', lastWeekFile !== null && lastWeekFile !== week);
    if (margin && date !== lastMarkerDate) {
      const marker = renderDateMarker(date, lastMarkerDate, getRenderOpts());
      margin.prepend(marker); addLatchMarker(marker);
    }
    lastMarkerDate = date; lastWeekFile = week;
  }
}

function dateLandingBlocked(target: string, card: HTMLElement | null): boolean {
  const targetWeek = entryWeek(target);
  const candidateWeek = card ? entryWeek(card.dataset.entryId!) : null;
  return [...weekViews].some(([week, view]) => (view.status() !== 'loaded' || !!state.store?.diagnosticsFor(weekFilePath(week)))
    && (week === targetWeek || (!candidateWeek || week >= candidateWeek) && week <= targetWeek));
}

function filterEntries(entries: Entry[], ref: EntityRef): Entry[] {
  return entries.filter(entry => entryReferences(entry, ref));
}

async function resolveEntry(store: Store, entryId: string): Promise<Entry | null> {
  const entries = await store.getWeekEntries(entryWeek(entryId));
  return entries.find(e => e.meta.created === entryId) ?? null;
}

let scrollObserver: IntersectionObserver | null = null;

function setupInfiniteScroll() {
  const flow = $('#flow');
  if (!flow) return;

  const old = document.getElementById('scroll-sentinel');
  old?.remove();

  const sentinel = document.createElement('div');
  sentinel.id = 'scroll-sentinel';
  sentinel.className = 'scroll-sentinel';
  if (state.loadedWeeks >= currentViewWeeks.length && !state.filter) {
    sentinel.className = 'scroll-sentinel end'; sentinel.textContent = 'The End';
  }
  flow.appendChild(sentinel);

  scrollObserver?.disconnect();
  scrollObserver = new IntersectionObserver(
    (entries) => {
      // Records batch: a fast scroll can deliver [leave, enter] together, and
      // the newest record decides — reading only the first would drop the load.
      if (entries.some((e) => e.isIntersecting)) {
        loadMoreWeeks(3);
      }
    },
    { root: $('#flow-scroll'), threshold: 0.1 }
  );
  scrollObserver.observe(sentinel);
}

function updateEmptyFlow(): void {
  const flow = $('#flow'), store = state.store, instance = state.instance;
  if (!flow || !store || !instance) return;
  const settled = flowInitialized && state.loadedWeeks >= currentViewWeeks.length
    && [...weekViews.values()].every(view => view.status() === 'loaded');
  const kind = emptyFlowKind(store, state.filter, settled, !!flow.querySelector('[data-entry-id]'));
  const old = flow.querySelector<HTMLElement>('.flow-empty');
  if (old?.dataset.emptyKind === kind && old.dataset.instanceId === instance.id) return;
  old?.remove();
  if (!kind) return;
  const empty = renderEmptyFlow(kind, instance, { clearFilter, hasNotes: store.getNoteIndex().length > 0 });
  flow.insertBefore(empty, document.getElementById('scroll-sentinel'));
}

// The route the current view reflects. A duplicate hash event is ignored;
// a history traversal still restores its state even when the route is equal.
let appliedRoute: string | null = null;

// Every shareable view URL includes its instance identity.
function urlFor(route: string): string {
  return state.instanceId === null ? '/' : instanceUrl(state.instanceId, route);
}

function setRoute(view: ViewState, anchor: FlowAnchor | null = null) {
  const route = buildRoute(view);
  appliedRoute = route;
  if (readInstanceLocation(window.location.pathname).route !== route) {
    const nav: NavState = { anchor, engaged: engagedEntryId };
    history.pushState(nav, '', urlFor(route));
  }
}

// Move to a new view state: sync the URL, side panel, document reader, and
// flow. Every navigation goes through here so the URL always reflects the view.
async function applyView(
  next: ViewState,
  opts: { push?: boolean; forceFlow?: boolean; anchor?: FlowAnchor | null; panel?: PanelView | null; userInitiated?: boolean; jumpDuration?: number } = {},
) {
  if (!state.store) return;
  const request = ++navigationGeneration;
  const store = state.store;
  const { push = true, forceFlow = false, userInitiated = true } = opts;
  if (userInitiated) dismissActionToast();
  const filterChanged = !sameFilter(state.filter, next.filter);
  // An anchor only means something across a filter re-render. Navigations
  // that don't carry one (side panel, search) anchor the time cursor: the
  // date readout holds its moment while the cards shared between the two
  // views slide to their new positions.
  const anchor = filterChanged ? opts.anchor ?? timeCursorAnchor() : null;
  if (filterChanged) engagedEntryId = next.filter ? anchor?.entryId ?? null : null;
  state.filter = next.filter;
  state.doc = next.doc;

  if (push) setRoute(next, anchor);

  // Panel, reader, and flow touch independent DOM — run them concurrently,
  // and leave the panel alone when only the document changed (it keeps its
  // scroll position and doesn't flicker through a reload).
  const tasks: Promise<void>[] = [updateDoc(false, userInitiated)];
  if (filterChanged) tasks.push(showSidePanel(opts.panel, userInitiated));
  if (filterChanged || forceFlow) tasks.push(renderFlow(anchor, false, userInitiated));
  await Promise.all(tasks);
  if (next.date && request === navigationGeneration && store === state.store) {
    const stamp = localDateStamp(next.date.start);
    await jumpToDate(stamp.slice(0, 10), stamp.length === 10 ? undefined : stamp, userInitiated, opts.jumpDuration);
  }
}

function handleTagClick(ref: EntityRef, source?: HTMLElement) {
  // Entry references jump to their place in the flow rather than filtering;
  // the entry detail page stays reachable via the entry/<id> route.
  if (ref.type === 'entry') {
    jumpToEntry(ref.id, true, anchorFromSource(source));
    return;
  }
  // The active entity's own tag toggles the filter off, anchored on the
  // clicked card (falling back to the dismiss anchor for clicks elsewhere).
  // Only real tag clicks toggle — a search result for the active entity is
  // a "go to", not a dismissal, and just closes any open document.
  if (sameFilter(state.filter, ref) && source) {
    applyView({ filter: null, doc: null }, { anchor: anchorFromSource(source) ?? dismissAnchor() });
    return;
  }
  applyView({ filter: ref, doc: null }, { anchor: anchorFromSource(source) });
}

// Scroll the flow to an entry's card, loading weeks down to it as needed.
// Closes any open document; clears the filter when the entry isn't part of
// the current filtered flow — `anchor` (the clicked card, when the jump came
// from one) grounds that expand before the scroll moves off toward the target.
async function jumpToEntry(
  id: string,
  push = true,
  anchor: FlowAnchor | null = null,
  block: ScrollLogicalPosition = 'center',
  userInitiated = push,
  duration?: number,
) {
  if (!state.store) return;
  const store = state.store;
  const request = ++navigationGeneration;
  const current = () => request === navigationGeneration && store === state.store;
  // Callers float this promise — a failed week fetch logs instead of
  // surfacing as an unhandled rejection.
  let entry: Entry | null;
  try {
    entry = await resolveEntry(store, id);
  } catch (err) {
    console.error(`Jump to ${id} failed:`, err);
    if (current() && userInitiated) showActionFailure('Could not open this entry. Try again.');
    return;
  }
  if (!current()) return;
  if (!entry) {
    console.warn(`Entry not found: ${id}`);
    if (userInitiated) showActionFailure('This entry is unavailable.');
    return;
  }

  if (state.doc) {
    state.doc = null;
    await updateDoc();
    if (!current()) return;
  }
  // An entry detail page is not a flow context worth preserving — jumps always
  // leave it; project/action filters are kept when the target is inside them.
  if (state.filter && (state.filter.type === 'entry' || !entryReferences(entry, state.filter))) {
    state.filter = null;
    void showSidePanel(undefined, userInitiated);
    await renderFlow(anchor ?? timeCursorAnchor(), false, userInitiated);
    if (!current()) return;
  }

  // The kept filter rides along in the route so the URL restores this view.
  if (push) setRoute({ filter: state.filter, doc: null, jump: id });

  const weeks = currentViewWeeks;
  const target = weeks.indexOf(entry.weekFile);
  if (target === -1) return;
  // Warm the cache in parallel — the render loop below then hits cache
  // instead of one fetch per week.
  void Promise.all(weeks.slice(state.loadedWeeks, target + 1).map((w) => store.getWeekEntries(w).catch(() => [])));
  // Bail if the flow is reset out from under us (a filter change or nav while
  // we await): `target` indexes the pre-reset week list, and doLoadWeeks then
  // stops advancing loadedWeeks — the loop would spin with no progress.
  const generation = flowGeneration;
  while (state.loadedWeeks <= target) {
    if (!current() || flowGeneration !== generation) return;
    await loadMoreWeeks(target + 1 - state.loadedWeeks, userInitiated);
  }
  if (!current() || generation !== flowGeneration) return;

  const view = weekViews.get(entry.weekFile);
  if (view?.status() === 'failed') await view.load(true, userInitiated);
  if (!current() || generation !== flowGeneration) return;
  const card = document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`);
  if (card) flashJump(card, block, duration ?? jumpDuration());
}

// Load older weeks (latest-first) until an entry at-or-before the target
// instant (the day's end by default) is rendered or the timeline ends,
// warming the cache to the target week first.
// Shared by every date jump so the nearest-entry search then sees both sides
// of the target.
async function loadDownToDate(flow: HTMLElement, dateStr: string, targetId = `${dateStr}T23:59:59`, current = () => true, userInitiated = true) {
  const store = state.store;
  if (!store) return;
  const targetWeek = getMondayOfWeek(new Date(dateStr + 'T00:00:00'));

  let target = currentViewWeeks.findIndex((w) => w <= targetWeek);
  if (target < 0) target = currentViewWeeks.length - 1;
  void Promise.all(currentViewWeeks.slice(state.loadedWeeks, target + 1)
    .map((w) => store.getWeekEntries(w).catch(() => [])));

  // Bail if the flow is reset out from under us (a filter change or nav while
  // we await): doLoadWeeks then stops advancing loadedWeeks, which would spin
  // this loop with no progress.
  const generation = flowGeneration;
  while (state.loadedWeeks < currentViewWeeks.length) {
    if (flowGeneration !== generation || !current()) return;
    const cards = flow.querySelectorAll<HTMLElement>('[data-entry-id]');
    const oldest = cards[cards.length - 1]?.dataset.entryId;
    if (oldest && oldest <= targetId) break;
    await loadMoreWeeks(3, userInitiated);
  }
}

// Scroll the flow to a calendar date, pinning that day's entry (or the most
// recent one before it) to the pane top so the latch reads the target day.
// Unlike jumpToEntry there may be no entry on the exact date, so it lands on
// the nearest at-or-before, loading older weeks until one is rendered.
async function jumpToDate(dateStr: string, target = `${dateStr}T23:59:59`, userInitiated = true, duration?: number) {
  const flow = $('#flow');
  if (!state.store || !flow) return;
  // Minute clocks denote :00 seconds, including when entries retain seconds.
  if (target.length === 16) target += ':00';
  const request = ++navigationGeneration;
  const store = state.store;
  const generation = flowGeneration;
  const current = () => request === navigationGeneration && store === state.store && generation === flowGeneration;
  await loadDownToDate(flow, dateStr, target, current, userInitiated);
  if (!current()) return;
  const complete = [...weekViews].every(([week, view]) => view.status() === 'loaded' && !state.store?.diagnosticsFor(weekFilePath(week)));
  const card = dateJumpCard(flow, target, complete);
  if (dateLandingBlocked(target, card)) return;
  if (card) flashJump(card, 'start', duration ?? jumpDuration());
}

// Load both sides of the target instant and land on the closest available
// entry in the step direction. Empty views and timeline boundaries hold.
async function jumpNearDate(targetIso: string, baseDate: string, dir: number): Promise<boolean> {
  const flow = $('#flow');
  if (!state.store || !flow) return false;
  const request = ++navigationGeneration;
  const store = state.store;
  const generation = flowGeneration;
  await loadDownToDate(flow, targetIso.slice(0, 10), targetIso);
  if (request !== navigationGeneration || store !== state.store || generation !== flowGeneration) return false;
  const card = quickJumpCard(flow, targetIso, baseDate, dir);
  if (!card || dateLandingBlocked(targetIso, card)) return false;
  flashJump(card, 'start', jumpDuration());
  return true;
}

// The jump-to-date popover, opened from the latched readout's chip.
const datePicker = createDatePicker({
  displayPreferences: () => state,
  jumpToDate: (dateStr) => { void jumpToDate(dateStr); },
  jumpNear: jumpNearDate,
});

// --- Catch-up (see "Catch-up" in spec.md): refresh.ts schedules checks, the
// store stages what changed, and the staged update lands here once the app is
// quiet — re-rendering only what the change touched.

// Stops the active source's refresh loop; a source switch starts a new one.
let stopRefresh: (() => void) | null = null;

// Last user interaction (or render start) — an update only lands after a
// quiet gap, so it never fights a scroll, a flight, or an open popover.
let lastActivity = 0;
const QUIET_AFTER_MS = 750;
const bumpActivity = () => { lastActivity = performance.now(); };

function isQuiet(): boolean {
  return !document.hidden
    && !weeksLoad
    && !flowRestoring
    && !datePicker.isOpen()
    && performance.now() - lastActivity > QUIET_AFTER_MS;
}

// What's on screen — the files a light check revalidates beyond the indexes.
function currentHotSet(): HotSet {
  const entities: HotSet['entities'] = [];
  if (state.filter && state.filter.type !== 'entry') {
    entities.push({ kind: state.filter.type, id: state.filter.type === 'action' ? actionSourceId(state.filter.id) : state.filter.id });
  }
  const assets = new Set<string>();
  if (state.doc?.kind === 'asset') assets.add(state.doc.path);
  if (state.doc?.kind === 'artifact') {
    entities.push({ kind: 'artifact', id: state.doc.id });
    const path = selectedArtifactPath(state.doc.id, state.doc.filename);
    if (path) assets.add(path);
  }
  // Embedded files currently rendered in either pane are part of the hot set.
  for (const path of artifactImageFiles('img[data-artifact-handle]')) assets.add(path);
  for (const path of webpageFiles(document)) assets.add(path);
  // A handle-only image can switch files when its artifact's content changes.
  for (const id of new Set(artifactImageIds('img[data-artifact-handle]'))) {
    if (!entities.some(entity => entity.kind === 'artifact' && entity.id === id)) {
      entities.push({ kind: 'artifact', id });
    }
  }
  for (const source of webpageSources(document)) {
    if (source.artifactId && !entities.some(entity => entity.kind === 'artifact' && entity.id === source.artifactId)) {
      entities.push({ kind: 'artifact', id: source.artifactId });
    }
  }
  return {
    weeks: currentViewWeeks.slice(0, state.loadedWeeks),
    entities,
    assets: [...assets],
  };
}

// Land a check's findings and re-render the affected surfaces. The flow
// re-renders through the usual anchored FLIP pass grounded at the time
// cursor, so an external change animates like any other re-render.
async function applyDataUpdate(update: PendingUpdate): Promise<void> {
  update.apply();
  const { weeks, entities, assets, indexesChanged } = update.summary;
  const flowAffected = weeks.size > 0 || entities.size > 0 || indexesChanged ||
    artifactImageFiles('#flow-scroll img[data-artifact-handle]').some(path => assets.has(path)) ||
    webpageFiles($('#flow-scroll')).some(path => assets.has(path));
  if (flowAffected) {
    await renderFlow(timeCursorAnchor());
    // The panel reads the relation map and the entity/instance state — both may
    // have moved; re-render it in place, keeping its scroll and expanded sections.
    await showSidePanel(panelSnapshot());
    // The docked filter pill reads the same caches — its name and status marks
    // move with them.
    updateFilterPill();
  }
  // The reader re-renders only when its own document changed — yanking a
  // document mid-read is worse than a stale linked-from list.
  if (state.doc) {
    let docChanged: boolean;
    if (state.doc.kind === 'artifact') {
      const path = selectedArtifactPath(state.doc.id, state.doc.filename);
      docChanged = entities.has(entityKey('artifact', state.doc.id)) || indexesChanged ||
        (path !== null && assets.has(path));
    } else {
      docChanged = state.doc.kind === 'asset' ? assets.has(state.doc.path) : state.filter != null &&
        (entities.has(entityKey(state.filter.type, state.filter.type === 'action' ? actionSourceId(state.filter.id) : state.filter.id)) ||
          state.filter.type === 'action' && state.filter.id.startsWith('~') && [...entities].some(id => id.startsWith('#action/')) && !state.store?.getCachedAction(state.filter.id));
    }
    // An embedded image changes independently of its containing document.
    docChanged ||= artifactImageFiles('#doc-body img[data-artifact-handle]').some(path => assets.has(path))
      || artifactImageIds('#doc-body img[data-artifact-handle]').some(id => entities.has(entityKey('artifact', id)))
      || webpageFiles($('#doc-body')).some(path => assets.has(path))
      || webpageSources($('#doc-body')).some(source => source.artifactId && entities.has(entityKey('artifact', source.artifactId)));
    if (docChanged) await updateDoc(true);
  }
  // An open search re-runs over the updated indexes.
  searchUi.rerunOpenSearch();
}

function openAsset(path: string) {
  applyView({ filter: state.filter, doc: { kind: 'asset', path } });
}

function openArtifact(id: string, filename?: string) {
  void applyView({ filter: state.filter, doc: { kind: 'artifact', id, filename } });
}

// Open the current scope's record in the reader: the filtered project/action,
// or the instance manifest on the unfiltered flow. Entries have no detail —
// they read in full in the flow.
function openDetail() {
  if (state.filter?.type === 'entry') return;
  applyView({ filter: state.filter, doc: { kind: 'detail' } });
}

function closeDoc() {
  applyView({ filter: state.filter, doc: null });
}

function clearFilter() {
  applyView({ filter: null, doc: null }, { anchor: dismissAnchor() });
}

// Clear the view state, side panel, and document overlay without touching
// the URL or flow. The side panel is the only indicator of the active filter.
function resetFilterUi() {
  state.filter = null;
  state.doc = null;

  closeSidePanel();

  readerModal?.close(0);
}

// Render the side panel: a summary of the current scope — the filtered
// entity, or the instance itself on the unfiltered flow (identity,
// description, links). Documents never render here; they open in the overlay.
let panelLoadGeneration = 0;
let renderedPanelScope: { store: Store; ref: EntityRef | null; planning?: OpenActionGroups['planning'] } | null = null;
let planningRefresh: Promise<void> | undefined;
// Reuse the visible minute clock; a changed projection window refreshes the
// summary, preserving loaded history. Unchanged windows retain their DOM.
function refreshPlanningWindow(): Promise<void> {
  if (planningRefresh) return planningRefresh;
  const scope = renderedPanelScope;
  if (!scope?.planning || state.panelCollapsed || scope.store !== state.store || !sameFilter(scope.ref, state.filter)) return Promise.resolve();
  planningRefresh = (async () => {
    const page = await scope.store.getPlanningActions(scope.ref?.type === 'project' ? scope.ref.id : undefined);
    if (scope !== renderedPanelScope || state.panelCollapsed || scope.store !== state.store || !sameFilter(scope.ref, state.filter)) return;
    if (planningSignature(page) !== scope.planning!.signature) await showSidePanel(panelSnapshot());
  })().catch(error => console.error('Failed to refresh recurrence projections:', error)).finally(() => { planningRefresh = undefined; });
  return planningRefresh;
}

async function showSidePanel(panelView?: PanelView | null, userInitiated = false) {
  const generation = ++panelLoadGeneration;
  const body = $('#side-panel-body');
  const store = state.store!;
  const opts = getRenderOpts();
  const ref = state.filter;

  // An unfiltered flow whose source has no manifest has no instance to
  // summarize — no panel, no pill.
  if (!ref && !store.getInstance()) {
    closeSidePanel();
    return;
  }

  // Retracted: the docked pill indicates the scope; the summary renders
  // when the user expands.
  if (state.panelCollapsed) {
    updateFilterPill();
    hidePanelElement();
    return;
  }

  showPanelElement();
  updateFilterPill();
  const refreshing = renderedPanelScope?.store === store && sameFilter(renderedPanelScope.ref, ref);
  if (body && !refreshing) {
    holdPanelFocus(body);
    body.replaceChildren();
    renderedPanelScope = null;
  }

  // Loads below can lose a race with a newer navigation; only the load for
  // the still-current filter may write the panel.
  const stale = () => generation !== panelLoadGeneration || state.store !== store || !sameFilter(state.filter, ref);
  const cancelLoading = body && !refreshing
    ? showDelayedLoading(body, 'Loading summary…', () => !stale() && !state.panelCollapsed) : () => {};

  try {
    let detail: HTMLElement;
    let planning: OpenActionGroups['planning'];
    const pages = refreshing ? renderedPanelScope?.planning?.pages ?? 1 : 1;
    if (!ref) {
      const data = await instanceSummaryData(store, pages);
      planning = data.actions.planning;
      detail = renderInstanceSummary(store.getInstance()!.manifest, opts, data, openDetail);
    } else {
      const relations = await store.getRelations();
      if (ref.type === 'project') {
        const project = await store.getProject(ref.id);
        const description = indexDescription(store.getProjectIndex(), ref.id);
        const data = await projectSummaryData(ref.id, store, relations, pages);
        planning = data.actions.planning;
        detail = renderProjectSummary(project, description, opts, data, openDetail);
      } else if (ref.type === 'action') {
        const action = await store.getAction(ref.id);
        const description = indexDescription(store.getActionIndex(), ref.id);
        detail = renderActionSummary(action, description, opts, await actionSummaryData(ref.id, store, relations), openDetail);
      } else {
        const entry = await resolveEntry(store, ref.id);
        if (!entry) throw new Error(`Entry ${ref.id} not found`);
        detail = renderEntryDetail(entry, opts, entryRelations(entry));
      }
    }
    if (stale()) return;
    if (body) {
      // A refresh keeps the old content usable during its fetch. Preserve any
      // expansion or scrolling the user performed while that work was pending.
      const restoringView = refreshing ? panelSnapshot() : panelView;
      cancelLoading();
      const previousFocus = holdPanelFocus(body);
      body.innerHTML = '';
      body.appendChild(detail);
      renderedPanelScope = { store, ref, planning };
      const undisturbed = await renderDiagramsInPlace(body, detail, () => !stale() && !state.panelCollapsed && body.contains(detail));
      if (stale() || !body.contains(detail)) return;
      if (undisturbed) restorePanelView(body, restoringView);
      restorePanelFocus(body, previousFocus);
    }
  } catch (err) {
    cancelLoading();
    const what = ref ? `${ref.type} ${ref.id}` : 'instance';
    console.error(`Failed to load ${what}:`, err);
    if (stale()) return;
    if (body) {
      const previousFocus = holdPanelFocus(body);
      const retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = 'Retry';
      retry.className = 'notice-action';
      retry.addEventListener('click', () => { if (!stale()) void showSidePanel(undefined, true); });
      if (!refreshing) { body.replaceChildren(retry); renderedPanelScope = null; }
      if (userInitiated) showActionFailure(`Could not load this ${ref?.type ?? 'summary'}. Try again.`);
      restorePanelFocus(body, previousFocus);
    }
  } finally { cancelLoading(); }
}

// Hydrate a mounted view's diagrams while keeping the reader's place in
// `body`. Resolves to whether the user left the scroll alone meanwhile, so a
// stored position is restored only when it would not yank them away.
async function renderDiagramsInPlace(body: HTMLElement, root: HTMLElement, current: () => boolean): Promise<boolean> {
  let expectedScroll = body.scrollTop;
  let readingMoved = false;
  await renderDiagrams(root, {
    current,
    commit: paint => {
      readingMoved ||= body.scrollTop !== expectedScroll;
      preserveReadingPosition([body], paint);
      expectedScroll = body.scrollTop;
    },
  });
  return !readingMoved && body.scrollTop === expectedScroll;
}

// Resolve an asset into a reader payload. Media and webpages embed by URL without
// reading the bytes; markdown reads and renders the content; unknown types read
// the content and show it verbatim, falling back to a download when it isn't text.
async function loadAssetContent(store: Store, path: string): Promise<AssetContent> {
  const kind = assetMediaKind(path);
  if (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video' || kind === 'webpage') {
    const url = await store.prepareAssetUrl(path);
    if (url) return { kind, url };
    // No addressable URL — fall through to reading the bytes.
  }
  const text = await store.getAsset(path);
  if (looksBinary(text)) return { kind: 'binary', url: store.assetUrl(path) };
  if (kind === 'markdown') return { kind: 'markdown', text };
  if (kind === 'webpage') return { kind: 'webpage', text };
  return { kind: 'text', text };
}

async function retryReadableFile(store: Store, path: string): Promise<void> {
  if (['image', 'pdf', 'audio', 'video', 'webpage'].includes(assetMediaKind(path)) && await store.prepareAssetUrl(path, true) !== null) return;
  await store.reloadFile(path);
}

// Render the document overlay for the current doc state.
let docLoadGeneration = 0;
async function updateDoc(preserveScroll = false, userInitiated = false) {
  const backdrop = $('#doc-backdrop');
  const body = $('#doc-body');
  if (!backdrop || !body) return;

  // Only the latest load for this source, document, and scope may write.
  const generation = ++docLoadGeneration;
  const requested = state.doc;
  const requestedFilter = state.filter;
  const store = state.store!;
  const navigation = navigationGeneration;
  const readerScroll = preserveScroll ? body.scrollTop : 0;
  const sameReader = () => navigation === navigationGeneration && store === state.store
    && sameDoc(state.doc, requested) && sameFilter(state.filter, requestedFilter);
  const stale = () => generation !== docLoadGeneration || !sameReader();

  if (!requested) {
    readerModal?.close();
    return;
  }

  if (!preserveScroll) body.replaceChildren();
  const cancelLoading = !preserveScroll
    ? showDelayedLoading(body, 'Loading document…', () => !stale()) : () => {};
  readerModal?.open();

  const opts = getRenderOpts();
  const recordPath = documentFilePath(requested, requestedFilter);
  let attachmentPath: string | undefined;
  const retryFile = async (path: string) => {
    if (!sameReader()) return;
    // Retained controls survive background refreshes, but a retry only owns
    // the read generation that was current when the user pressed it.
    const retryRequest = docLoadGeneration;
    const retryStale = () => !sameReader() || retryRequest !== docLoadGeneration;
    readerModal?.ensureFocus();
    // A failed reload retains cached/recovered content and its diagnostic.
    // Repaint only if this exact reader is still the current request.
    try { await retryReadableFile(store, path); }
    catch (error) {
      if (retryStale()) return;
      updateDiagnostics();
      throw error;
    }
    if (retryStale()) return;
    const updating = updateDoc(true, true);
    const retryGeneration = docLoadGeneration;
    await updating;
    if (retryGeneration === docLoadGeneration && state.store === store && sameDoc(state.doc, requested) && sameFilter(state.filter, requestedFilter)) updateDiagnostics();
  };
  opts.onMediaError = (path, error, media) => {
    if (!sameReader() || !body.contains(media)) return;
    store.reportAssetFailure(path, error);
    if (userInitiated) showActionFailure('Could not load this media. Try again.');
    const notice = fileDiagnosticNotice(store.diagnosticsFor(path)!, () => retryFile(path));
    media.replaceWith(notice);
    updateDiagnostics();
    readerModal?.ensureFocus();
  };

  try {
    let doc: HTMLElement;
    if (requested.kind === 'artifact') {
      const [artifact, relations] = await Promise.all([store.getArtifact(requested.id), store.getRelations()]);
      const filename = requested.filename ?? artifactContentFilename(artifact);
      attachmentPath = filename === undefined ? undefined : artifactAttachmentRelativePath(requested.id, filename);
      const content = attachmentPath === undefined ? undefined : await loadAssetContent(store, attachmentPath);
      const description = indexDescription(store.getArtifactIndex(), requested.id);
      doc = renderArtifactDetail(requested.id, artifact, description, opts, {
        projects: relations.projectsByArtifact.get(requested.id) ?? [],
        actions: relations.actionsByArtifact.get(requested.id) ?? [],
        backlinks: relations.artifactBacklinks.get(requested.id) ?? [],
      }, content, requested.filename);
    } else if (requested.kind === 'asset') {
      const path = requested.path;
      const [content, relations] = await Promise.all([loadAssetContent(store, path), store.getRelations()]);
      const descriptions = new Map(store.getNoteIndex().map((i) => [i.id, i.description]));
      const linkedFrom = (relations.entriesByAsset.get(path) ?? [])
        .map((id) => ({ id, description: descriptions.get(id) }));
      doc = renderAssetDetail(path, content, opts, linkedFrom);
    } else if (!state.filter) {
      const instance = store.getInstance();
      if (!instance) throw new Error('No instance manifest (aside.md)');
      doc = renderInstanceDetail(instance.manifest, instance.body, opts, await instanceDetailData(store));
    } else {
      const ref = state.filter;
      if (ref.type === 'project') {
        const [project, relations] = await Promise.all([store.getProject(ref.id), store.getRelations()]);
        const description = indexDescription(store.getProjectIndex(), ref.id);
        doc = renderProjectDetail(ref.id, project, description, opts,
          buildProjectHierarchy(ref.id, relations.relatedProjects), await projectDetailData(ref.id, store, relations));
      } else {
        const [action, relations] = await Promise.all([store.getAction(ref.id), store.getRelations()]);
        const description = indexDescription(store.getActionIndex(), ref.id);
        doc = renderActionDetail(ref.id, action, description, opts, entityStats('action', ref.id, relations));
      }
    }
    if (stale()) return;
    cancelLoading();
    body.innerHTML = '';
    body.appendChild(doc);
    for (const path of new Set([recordPath, ...(attachmentPath ? [attachmentPath] : [])])) {
      const diagnostic = store.diagnosticsFor(path);
      if (diagnostic) body.prepend(fileDiagnosticNotice(diagnostic, () => retryFile(path)));
    }
    const mountedFocus = document.activeElement;
    const undisturbed = await renderDiagramsInPlace(body, doc, () => !stale() && body.contains(doc));
    if (stale() || !body.contains(doc)) return;
    // The source remains readable while Mermaid loads. Keep any reading or
    // focus movement the user makes during that wait.
    if (undisturbed) body.scrollTop = readerScroll;
    if (document.activeElement === mountedFocus) readerModal?.ensureFocus();
  } catch (err) {
    cancelLoading();
    const what = requested.kind === 'artifact' ? artifactHandle(requested.id, requested.filename)
      : requested.kind === 'asset' ? requested.path
      : requestedFilter ? `${requestedFilter.type}: ${requestedFilter.id}` : 'instance detail';
    console.error(`Failed to load ${what}:`, err);
    if (stale()) return;
    if (userInitiated) showActionFailure('Could not load this document. Try again.');
    const path = attachmentPath ?? recordPath;
    const diagnostic = store.diagnosticsFor(path) ?? { path, issues: [], error: err instanceof Error ? err.message : String(err) };
    if (!preserveScroll) body.replaceChildren(fileDiagnosticNotice(diagnostic, () => retryFile(path)));
    body.scrollTop = readerScroll;
    readerModal?.ensureFocus();
  } finally { cancelLoading(); }
}

// A route pushed over the control channel (the MCP show tool). It applies
// exactly as a user navigation — pushState plus the usual transitions — so
// Back returns to the previous view. A push racing the initial store load
// waits for it; only the latest pending route applies.
let pendingControlRoute: string | null = null;

function navigateToRoute(route: string) {
  if (!state.store) {
    pendingControlRoute = route;
    return;
  }
  const view = parseRoute(route.replace(/^\/+/, ''));
  if (view.jump) {
    void (async () => {
      const store = state.store;
      let request = ++navigationGeneration;
      // The jump's own push carries the filter, so the filter switch doesn't
      // push — one history entry per pushed route, like a deep link.
      if (!sameFilter(state.filter, view.filter)) {
        const applying = applyView({ filter: view.filter, doc: null }, { push: false, userInitiated: false });
        request = navigationGeneration;
        await applying;
      }
      if (store !== state.store || request !== navigationGeneration) return;
      await jumpToEntry(view.jump!, true, null, 'center', false);
    })();
  } else {
    void applyView(view, { userInitiated: false });
  }
}

async function handleLocationChange(event?: Event) {
  const location = readInstanceLocation(window.location.pathname);
  if (location.instanceId !== state.instanceId) { await openCurrentLocation(); return; }
  if (!state.store) return;
  const route = readInstanceLocation(window.location.pathname).route;
  // A same-route popstate can carry a different anchor and supersedes pending
  // navigation. An echoed hashchange after it must not cancel its new jump.
  if (route === appliedRoute && event?.type !== 'popstate') return;
  appliedRoute = route;
  const store = state.store;
  let request = ++navigationGeneration;

  const nav = history.state as NavState | null;
  engagedEntryId = nav?.engaged ?? null;

  const next = parseRoute(route);
  if (next.date) {
    await applyView(next, { push: false, anchor: nav?.anchor, panel: nav?.panel });
    return;
  }
  if (next.jump) {
    if (!sameFilter(state.filter, next.filter)) {
      const applying = applyView({ filter: next.filter, doc: null }, { push: false, panel: nav?.panel });
      request = navigationGeneration;
      await applying;
    }
    if (store !== state.store || request !== navigationGeneration) return;
    jumpToEntry(next.jump, false, null, 'center', true);
    return;
  }
  // Same filter and document — the flow needn't rebuild, but back/forward still
  // lands on the position the destination was left at (e.g. returning from a
  // jump), so restore its stored anchor onto the standing flow.
  if (sameFilter(state.filter, next.filter) && sameDoc(state.doc, next.doc)) {
    if (nav?.anchor) restoreFlowScroll(nav.anchor);
    return;
  }
  // The destination's own last-seen anchor and panel state restore the view as
  // it was left; entries without them (hand-edited hashes, history from before
  // a reload) fall back to a top-of-panel, time-cursor render.
  applyView(next, { push: false, anchor: nav?.anchor, panel: nav?.panel });
}

document.addEventListener('DOMContentLoaded', init);

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || activeModal()) return;
  const focused = document.activeElement;
  const editing = focused instanceof HTMLElement && (focused.isContentEditable || focused.matches('input, textarea, select'));
  if (e.key === '/' && state.searchShortcutEnabled && !editing && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const searchInput = $<HTMLInputElement>('.search-input');
    if (searchInput && !searchInput.disabled && !searchInput.closest('[hidden], [inert]')) {
      e.preventDefault();
      searchInput.focus();
    }
  }
  if (e.key === 'Escape') {
    searchUi.cancelPendingSearch();
    if (searchUi.isSearchVisible()) {
      e.preventDefault();
      setSearchVisible(false);
      return;
    }
    // Step back one level: document overlay → summary, summary → flow.
    if (state.doc) {
      closeDoc();
      return;
    }
    // Clears the filter whether the panel is expanded or retracted to the pill.
    if (state.filter) {
      clearFilter();
    }
  }
});

document.addEventListener('copy', (e) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  // Selecting only the visible label omits its enclosing anchor from
  // cloneContents(). Preserve a complete selected date as its authored handle;
  // partial label selections keep the browser's ordinary copy behavior.
  const ancestor = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const dateChip = ancestor?.closest<HTMLElement>('.inline-tag-date[data-date-handle]');
  const dateLabel = dateChip?.querySelector('time');
  if (dateLabel && dateLabel.contains(range.startContainer) && dateLabel.contains(range.endContainer)
      && range.toString() === dateLabel.textContent) {
    e.clipboardData!.setData('text/plain', dateChip!.dataset.dateHandle!);
    e.preventDefault();
    return;
  }
  const fragment = range.cloneContents();
  const inlineTags = fragment.querySelectorAll('.inline-tag');
  if (inlineTags.length === 0) return;

  for (const tag of inlineTags) {
    const date = (tag as HTMLElement).dataset.dateHandle;
    if (date) {
      tag.replaceWith(date);
      continue;
    }
    const type = (tag as HTMLElement).dataset.refType;
    const id = (tag as HTMLElement).dataset.refId;
    if (type && id) {
      tag.replaceWith(`#${type}/${id}`);
    }
  }

  const tempDiv = document.createElement('div');
  tempDiv.appendChild(fragment);
  e.clipboardData!.setData('text/plain', tempDiv.textContent || '');
  e.preventDefault();
});
