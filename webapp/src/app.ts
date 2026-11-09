import type { StoreView as Store, HotSet, PendingUpdate } from '../../cli/src/core/data-snapshot';
import { daemonRequest, DaemonRequestError, loadDaemonInstance, queryDaemonInstance, type AvailableInstance } from './backend';
import { createIframeQueryBridge } from './iframe-bridge';
import { InstanceChooser } from './instance-chooser';
import { InstanceSwitcher } from './instance-switcher';
import { setupInstanceTooltips, WARNING_ICON } from './instance-catalogue';
import { showNotice, showDelayedLoading, delayLoading } from './notice';
import { showActionFailure, dismissActionToast } from './toast';
import { startRefresh } from './refresh';
import { startDisplayClock } from './clock';
import { refreshDisplay, preserveDisplayPosition, preserveReadingPosition, setDisplayContext, cancelDisplayMotion, bindDisplay, setDisplayText } from './display';
import { renderDiagrams } from './diagrams';
import { webpageSource, webpageSources } from './webpage';
import { MINUTE_MS } from '../../cli/src/core/system-config';
import { getMondayOfWeek, weekFilePath, toStampStr, entryReferences, entityKey, assetDisplayName, assetMediaKind, looksBinary, type EntityRef, type Entry } from '../lib/types';
import { renderEntry, renderDateMarker, formatStamp, renderProjectSummary, renderActionSummary, renderInstanceSummary, renderProjectDetail, renderActionDetail, renderInstanceDetail, renderEntryDetail, renderAssetDetail, renderArtifactDetail, readerDetails, applyRefStatus, RenderOptions, TimeFormat, type AssetContent } from './render';
import { artifactAttachmentRelativePath, artifactContentFilename, artifactHandle, parseArtifactHandle, type ArtifactReference } from '../../cli/src/core/artifact-reference';
import { buildProjectHierarchy } from './hierarchy';
import { actionMarks, projectMarks, actionPills, projectPills, type OpenActionGroups } from './instance';
import { buildRoute, parseRoute, instanceUrl, readInstanceLocation, ViewState, DocRef } from './route';
import { dateTimeAttribute, localDateStamp, type DateReference } from './date-reference';
import { snapshotFlow, animateFlow, animateEntryArrival, setSlideMs } from './flip';
import { REDUCED_MOTION, mountLatch, updateLatch, updateLatchNow, currentFlowDate, suppressLatch, resetLatchMarkers, addLatchMarker } from './latch';
import { createDatePicker } from './datepicker';
import { createCalendarCounts, type CalendarCounts } from './calendar-counts';
import { emptyFlowKind, renderEmptyFlow } from './onboarding';
import { documentFilePath, documentIsHtml, actionSourceId } from './document-path';
import { fileDiagnosticNotice } from './diagnostics';
import { createWeekView, type WeekView } from './week-view';
import { dateJumpCard, anchorFromSource, timeCursorAnchor, anchorForEntry, restoreAnchor, anchorShortfall, viewportGapBelow, quickJumpCard, entryWeek, flashJump, visibleTimelineDates, type VisibleTimelineDates, type FlowAnchor } from './flow-navigation';
import { projectSummaryData, actionSummaryData, projectDetailData, entryRelations, instanceSummaryData, instanceDetailData, indexDescription, planningSignature } from './panel-data';
import { setupRefCoHover } from './ref-hover';
import { createSidePanel, type PanelView } from './side-panel';
import { createSearchUi } from './search-ui';
import { createWorkspaceFrame } from './workspace-frame';
import { createReaderPage } from './reader-page';
import { createContextPanel, type ContextTimelineAction } from './context-panel';
import { renderContextContent } from './context-render';
import { renderContextEssentials, type ContextEssentials } from './context-essentials';
import { artifactIconState, dateIconState, fileIconState } from './entity-icons';
import { sidebarView, pinMatches, setViewPinned } from './view-pins';
import type { WebappSidebarSection, WebappSidebarItem } from '../../cli/src/core/types';
import { entrySourceReference } from './entry-source-reference';
import { withinTimestampRange, type TimestampRange } from '../../cli/src/core/timestamp-range';
import { matchesFlowSearch } from './flow-search';
import { parseEntrySource, sourceRequest, effectiveSourceOrder, type SourceDefinition } from './entry-source';
import { createQueryFlow } from './query-flow';
import { activeModal, createModal, usable, type ModalController } from './modal';
import { animationSpeed, dateFormat, timeStyle, timeFormat, weekStartsOn, type DateFormat, type DisplayStyle } from './preferences';
import { refreshDateTimeSettings, refreshTimelineGutter } from './date-time-settings';
import { clockSelection } from './date-display';
import { entityStats } from './entity-relations';
import { connectControl } from './control';
import { initializeAuth, RECONNECT_GUIDANCE, type AuthState } from './auth';
import { locationCopyText } from './location-copy';

interface AppState {
  store: Store | null;
  filter: EntityRef | null;
  search: string;
  source?: string;
  range?: TimestampRange;
  order?: 'CREATED_ASC' | 'CREATED_DESC';
  doc: DocRef | null;
  timeFormat: TimeFormat;
  dateFormat: DateFormat;
  timeStyle: DisplayStyle;
  weekStartsOn: number;
  expandProjects: boolean;
  expandActions: boolean;
  searchShortcutEnabled: boolean;
  instanceId: string | null;
  instance: AvailableInstance | null;
  // Traversed weeks, including failed slots; success is tracked per WeekView.
  loadedWeeks: number;
  darkMode: boolean;
  // Animation-speed multiplier over the base transition durations: 0 disables
  // motion, 1 is the default pace, >1 slows it. Scales the CSS --duration-*
  // vars, the FLIP slide, and the cleanup timers together.
  animSpeed: number;
}

const state: AppState = {
  store: null,
  filter: null,
  search: '',
  doc: null,
  timeFormat: timeFormat(localStorage.getItem('timeFormat')),
  dateFormat: dateFormat(localStorage.getItem('dateFormat')),
  timeStyle: timeStyle(localStorage.getItem('timeStyle')),
  weekStartsOn: weekStartsOn(localStorage.getItem('weekStartsOn')),
  expandProjects: localStorage.getItem('expandProjects') === 'true',
  expandActions: localStorage.getItem('expandActions') === 'true',
  searchShortcutEnabled: localStorage.getItem('searchShortcutEnabled') !== 'false',
  instanceId: readInstanceLocation(window.location.pathname).instanceId,
  instance: null,
  loadedWeeks: 0,
  darkMode: localStorage.getItem('darkMode') === 'true' ||
    (!localStorage.getItem('darkMode') && window.matchMedia('(prefers-color-scheme: dark)').matches),
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
  const containers = [$('#flow-scroll'), $('#side-panel-body'), $('#doc-body'), $('#instance-chooser'), $('#workspace-popover-body')].filter((node): node is HTMLElement => node !== null);
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
    resolveArtifact: id => store?.getCachedArtifact(id),
    artifactHref: (id, filename) => hrefFor(buildRoute({ ...flowContext(), filter, doc: { kind: 'artifact', id, filename } })),
    artifactFileUrl: (id, filename) => {
      const path = selectedArtifactPath(id, filename, store);
      return path ? store?.assetUrl(path) ?? null : null;
    },
    onEntryTimeClick: (id) => { void jumpToEntry(id, true, null, 'start'); },
    onDateClick: date => {
      if (contextPanel) void inspectContext({ ref: null, doc: null, date });
      else void navigateDate(date);
    },
    routeHref: route => {
      const target = parseRoute(route);
      const pill = !!target.filter && !target.doc && !target.jump && !target.date;
      const context = state.doc && target.date ? returnFlow?.view ?? flowContext() : flowContext();
      return hrefFor(buildRoute({ ...context, ...target,
        ...(state.doc && target.date ? { filter: context.filter } : {}),
        ...(state.doc && pill ? { source: undefined, order: undefined } : {}) }));
    },
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

let navigationSidebar: ReturnType<typeof createWorkspaceFrame> | undefined;
let navigationReady = false;
let summaryAvailable = false;
type ContextTarget = { ref: EntityRef | null; doc: DocRef | null; date?: DateReference };
type ContextVisit = { target: ContextTarget; view: PanelView | null };
let contextPanel: ReturnType<typeof createContextPanel> | undefined;
let contextTarget: ContextTarget | null = null;
const contextBack: ContextVisit[] = [], contextForward: ContextVisit[] = [];
let contextDismissed = false;
let contextAutomatic = false;
let contextControlsOpen = false;
let contextInteraction = 0;
let contextReadingRevision = 0;
let contextReadingConfiguration = '';

function clearContextRoute(): void {
  state.doc = null;
  returnFlow = null;
  if (parseRoute(locationRoute()).doc) {
    const route = buildRoute({ ...flowContext(), doc: null });
    appliedRoute = route;
    history.replaceState({ ...(history.state ?? {}), returnFlow: null }, '', urlFor(route));
  }
}

// Summary accompanies the timeline. Expanded context is the content selected
// by the sidebar, so highlighting and pinning must use that entity's identity.
function workspaceView(): ViewState {
  const presentation = contextPanel?.getState();
  const target = currentContext();
  if (presentation?.open && presentation.mode === 'expanded' && !target.date) {
    return { filter: target.ref, doc: target.doc ?? (target.ref?.type === 'entry' ? null : { kind: 'detail' }) };
  }
  return { ...flowContext(), doc: state.doc };
}

function syncContextWebpages(): void {
  const presentation = contextPanel?.getState();
  const suspended = !presentation?.open || presentation.mode === 'summary' || presentation.view !== 'content' || contextControlsOpen;
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('#side-panel-body iframe.asset-webpage')) {
    iframeQueries.setSuspended(frame, suspended);
  }
  if (suspended) for (const media of document.querySelectorAll<HTMLMediaElement>('#side-panel-body audio, #side-panel-body video')) media.pause();
}

function sameContext(a: ContextTarget | null, b: ContextTarget | null): boolean {
  return a === b || !!a && !!b && sameFilter(a.ref, b.ref) && sameDoc(a.doc, b.doc) && JSON.stringify(a.date) === JSON.stringify(b.date);
}

function currentContext(): ContextTarget {
  return contextTarget ?? { ref: state.filter, doc: null };
}

function updateContextControls(): void {
  const target = currentContext(), ref = target.ref, date = target.date;
  const timelineAction: ContextTimelineAction | undefined = target.doc ? undefined : date ? {
    label: date.end ? 'Filter timeline' : 'Go to date',
    active: date.end ? JSON.stringify(timelineContext().range) === JSON.stringify({ start: date.start, end: date.end }) : undefined,
    onClick: () => { void toggleContextRange(date); },
  } : ref?.type === 'entry' ? {
    label: 'Go to entry', onClick: () => { void jumpToEntry(ref.id); },
  } : ref ? {
    label: 'Filter timeline', active: sameFilter(timelineContext().filter, ref),
    onClick: () => { void toggleContextFilter(ref); },
  } : undefined;
  contextPanel?.update({ available: summaryAvailable, canBack: contextBack.length > 0, canForward: contextForward.length > 0, timelineAction });
}

async function inspectContext(target: ContextTarget, options: { history?: boolean; view?: PanelView | null; focus?: boolean; routed?: boolean } = {}): Promise<void> {
  if (!state.store) return;
  resumeDateCount = undefined;
  cancelTimelineDateCount();
  if (target.doc?.kind === 'detail') target = { ...target, doc: null };
  contextInteraction++;
  if (!options.routed) clearContextRoute();
  const store = state.store;
  const previous = currentContext();
  if (!sameContext(previous, target) && options.history !== false) {
    contextBack.push({ target: previous, view: panelSnapshot() });
    contextForward.length = 0;
  }
  contextTarget = target;
  contextDismissed = false;
  contextPanel?.update({ available: true, canBack: contextBack.length > 0, canForward: contextForward.length > 0 });
  contextPanel?.open({ focus: options.focus });
  await showSidePanel(options.view, true, options.view !== undefined);
  if (state.store !== store || !sameContext(currentContext(), target)) return;
  updateContextControls();
}

function travelContext(direction: 'back' | 'forward'): void {
  const from = direction === 'back' ? contextBack : contextForward;
  const to = direction === 'back' ? contextForward : contextBack;
  const visit = from.pop();
  if (!visit) return;
  to.push({ target: currentContext(), view: panelSnapshot() });
  void inspectContext(visit.target, { history: false, view: visit.view, focus: true });
}

function setupContextPanel(): void {
  const host = $('#side-panel'), body = $('#side-panel-body');
  if (!host || !body || !$('#btn-context-expand')) return;
  contextPanel = createContextPanel(host, body, {
    fallback: visibleInstanceControl,
    viewportWidth: () => $('#workspace-frame')?.clientWidth || window.innerWidth,
    gutterWidth: () => {
      const frame = $('#workspace-frame')?.getBoundingClientRect();
      const element = $('#flow');
      const flow = element?.getBoundingClientRect();
      const pad = element ? parseFloat(getComputedStyle(element).paddingRight) || 16 : 16;
      return frame && flow ? Math.max(0, frame.right - flow.right + pad) : 280;
    },
    beforeOpen: () => navigationSidebar?.closePopover(false),
    duration: jumpDuration,
    changed: presentation => {
      const configuration = `${presentation.mode}:${presentation.view}:${presentation.fullscreen}`;
      if (configuration !== contextReadingConfiguration) {
        contextReadingConfiguration = configuration;
        contextReadingRevision++;
      }
      if (presentation.open) resumeDateCount?.(); else cancelTimelineDateCount();
      syncContextWebpages(); syncNavigationSidebar();
    },
    onDismiss: () => { contextDismissed = true; contextInteraction++; clearContextRoute(); },
    onBack: () => travelContext('back'),
    onForward: () => travelContext('forward'),
    shouldDismiss: event => {
      const target = event.target;
      return target instanceof Element && !target.closest('#workspace-control-surface, #modal-backdrop');
    },
  });
  contextPanel.setup();
}
let documentDetails: HTMLElement | undefined;
let renderedSidebar: { instance: string | null; sections: WebappSidebarSection[] } = { instance: null, sections: [] };
let queryFlow: ReturnType<typeof createQueryFlow> | undefined;
let queryDefinition: SourceDefinition | undefined;
let queryProblem: Error | undefined;
let queryRendered = 0;
let sourceInspectionKey = '';
let sourceInspectionBody: HTMLElement | undefined;

function sourceInspection(): HTMLElement {
  let request: ReturnType<typeof sourceRequest> | undefined, constructionError: string | undefined;
  try {
    if (queryDefinition) request = sourceRequest(queryDefinition, { ...flowContext(), range: localRange(), offset: 0, limit: 50 });
  } catch (error) { constructionError = error instanceof Error ? error.message : String(error); }
  const error = (queryProblem ?? queryFlow?.error)?.message ?? constructionError;
  const key = JSON.stringify({ source: state.source, name: sourceName(), request, error });
  if (sourceInspectionBody && key === sourceInspectionKey) return sourceInspectionBody;
  sourceInspectionKey = key;
  const host = document.createElement('div');
  const title = document.createElement('h2'); title.textContent = sourceName(); host.append(title);
  const identity = document.createElement('p'); identity.textContent = state.source ?? ''; host.append(identity);
  if (error) { const message = document.createElement('p'); message.textContent = error; host.append(message); }
  if (request) {
    for (const [label, value] of [['GraphQL query', request.query], ['Variables', JSON.stringify(request.variables, null, 2)], ['Order', queryDefinition ? effectiveSourceOrder(queryDefinition, state.order) : 'CREATED_DESC']]) {
      const heading = document.createElement('h3'); heading.textContent = label;
      const code = document.createElement('pre'); code.textContent = value; host.append(heading, code);
    }
  }
  sourceInspectionBody = host;
  return host;
}

function sourcePath(source: string): string {
  const ref = entrySourceReference(source);
  return artifactAttachmentRelativePath(ref.id, ref.filename);
}

function localRange(): TimestampRange | undefined {
  return state.range && { start: localDateStamp(state.range.start), end: localDateStamp(state.range.end) };
}

function flowAscending(): boolean {
  return !!queryDefinition && effectiveSourceOrder(queryDefinition, state.order) === 'CREATED_ASC';
}

function flowContext(): Pick<ViewState, 'filter' | 'search' | 'source' | 'range' | 'order'> {
  return { filter: state.filter, search: state.search, source: state.source, range: state.range, order: state.order };
}

// Calendar and filter controls stay attached to the last timeline while the
// reader displays an entity or a full-page HTML artifact.
function timelineContext(): ReturnType<typeof flowContext> {
  return state.doc ? returnFlow?.view ?? flowContext() : flowContext();
}

async function navigateDate(date: DateReference): Promise<void> {
  const context = state.doc ? returnFlow?.view ?? flowContext() : flowContext();
  const store = state.store, interaction = contextInteraction;
  const navigating = applyView({ ...context, filter: context.filter?.type === 'entry' ? null : context.filter, doc: null,
    ...(date.end ? { range: { start: date.start, end: date.end } } : { date }) });
  const request = navigationGeneration;
  await navigating;
  if (contextPanel && store === state.store && request === navigationGeneration && interaction === contextInteraction) {
    contextDismissed = true; contextInteraction++; contextPanel.close({ restoreFocus: false });
  }
}

async function toggleContextRange(date: DateReference): Promise<void> {
  const active = date.end && JSON.stringify(timelineContext().range) === JSON.stringify({ start: date.start, end: date.end });
  if (!active) { await navigateDate(date); return; }
  const store = state.store, interaction = contextInteraction;
  const clearing = applyView({ ...timelineContext(), range: undefined, doc: null }, { preserveContext: true });
  const request = navigationGeneration;
  await clearing;
  if (state.store === store && request === navigationGeneration && interaction === contextInteraction) contextPanel?.open();
}

function sidebarSections(): WebappSidebarSection[] {
  return state.store?.getInstance()?.manifest.config?.webapp?.sidebar ?? [];
}

function sidebarItemLabel(item: WebappSidebarItem): string {
  if (item.label) return item.label;
  try {
    const view = sidebarView(item, state.instanceId!);
    if (view.source) return state.store?.getArtifactDisplayName(entrySourceReference(view.source).id) ?? view.source;
    if (view.doc?.kind === 'artifact') return state.store?.getArtifactDisplayName(view.doc.id) ?? view.doc.id;
    if (view.filter) return getRenderOpts().resolveName(view.filter.type, view.filter.id);
    if (view.search) return `“${view.search}”`;
    if (view.range) return `${view.range.start} – ${view.range.end}`;
    if (view.date) return view.date.start;
    return view.doc ? 'Overview' : 'Entries';
  } catch { return (item.timeline ?? item.entity)!; }
}

function sourceName(source = state.source): string {
  if (!source) return 'Entries';
  const item = sidebarSections().flatMap(section => section.items).find(item => item.timeline === source);
  return item?.label ?? state.store?.getCachedArtifact(entrySourceReference(source).id)?.frontMatter.name ?? source;
}

let pinSaving = false;
async function setCurrentPin(pinned: boolean): Promise<void> {
  if (pinSaving || !state.instanceId || !state.store) return;
  const instance = state.instanceId, store = state.store;
  const view = workspaceView();
  const label = view.doc || view.filter?.type === 'entry' ? currentPageLabel() : [state.source ? sourceName() : '',
    state.filter ? getRenderOpts().resolveName(state.filter.type, state.filter.id) : state.source ? '' : 'Entries',
    state.search ? `“${state.search}”` : '', state.range ? `${state.range.start} – ${state.range.end}` : ''].filter(Boolean).join(' · ');
  pinSaving = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      // Refresh before replacing the declaration, preserving newer agent sections.
      const pending = await store.check('full', currentHotSet(), ['aside.md']);
      if (state.store !== store || state.instanceId !== instance) return;
      if (pending) await applyDataUpdate(pending);
      if (state.store !== store || state.instanceId !== instance) return;
      const diagnostic = store.diagnosticsFor('aside.md');
      if (!store.getInstance() || diagnostic?.error || diagnostic?.issues.some(issue => issue.severity === 'error' && (issue.field?.startsWith('config.webapp') || !issue.field))) {
        throw new Error('The instance sidebar could not be read. Repair its settings before pinning a view.');
      }
      const expectedSidebar = structuredClone(sidebarSections());
      const alreadyPinned = expectedSidebar.some(section => section.items.some(item => pinMatches(item, instance, view)));
      if (alreadyPinned === pinned) { syncNavigationSidebar(); return; }
      const sidebar = setViewPinned(expectedSidebar, instance, view, label, pinned);
      try {
        await daemonRequest(`instances/${encodeURIComponent(state.instance?.alias ?? instance)}/sidebar`, { sidebar, expectedSidebar });
      } catch (error) {
        if (error instanceof DaemonRequestError && error.status === 409 && attempt < 2) continue;
        throw error;
      }
      if (state.store !== store) return;
      const updated = await store.check('full', currentHotSet(), ['aside.md']);
      if (state.store !== store) return;
      if (updated) await applyDataUpdate(updated);
      syncNavigationSidebar();
      return;
    }
  } catch (error) { showActionFailure(error instanceof Error ? error.message : 'Could not update pinned content.'); }
  finally { pinSaving = false; }
}

function clearSource(): void {
  void applyView({ ...timelineContext(), source: undefined, doc: null }, { anchor: state.doc ? returnFlow?.anchor : timeCursorAnchor() });
}

function updateSourcePill(): void {
  const host = $('#source-filter');
  if (!host) return;
  const focused = host.contains(document.activeElement);
  const context = timelineContext();
  host.hidden = (!context.source && !context.range) || !state.store;
  host.replaceChildren();
  if (host.hidden) {
    if (focused) visibleInstanceControl()?.focus({ preventScroll: true });
    return;
  }
  const chips: { name: string; inspect: string; clear: string; remove(): void }[] = [];
  if (context.source) chips.push({ name: sourceName(context.source), inspect: `Inspect entry source: ${sourceName(context.source)}`,
    clear: 'Clear entry source', remove: clearSource });
  if (context.range) chips.push({ name: `${context.range.start} – ${context.range.end}`, inspect: 'Inspect date range',
    clear: 'Clear date range', remove: () => { void applyView({ ...timelineContext(), range: undefined, doc: null }); } });
  for (const chip of chips) {
    const group = document.createElement('span'); group.className = 'context-filter-chip';
    const label = document.createElement('button'); label.type = 'button'; label.className = 'filter-pill-label tag';
    label.setAttribute('aria-label', chip.inspect);
    const text = document.createElement('span'); text.className = 'tag-text'; text.textContent = chip.name; label.append(text);
    label.addEventListener('click', () => withTimelineControl(() => navigationSidebar?.openInspection()));
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'filter-pill-clear'; clear.textContent = '×';
    clear.setAttribute('aria-label', chip.clear); clear.title = chip.clear; clear.addEventListener('click', chip.remove);
    group.append(label, clear); host.append(group);
  }
  if (focused) host.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
}

// Summary content and its reading state stay independent of responsive chrome.
// The frame docks the same body or places it in the pill's Summary popover.
const {
  showPanelElement, closeSidePanel,
  panelSnapshot, stampPanel, restorePanelView, holdPanelFocus, restorePanelFocus, isPanelRestoring,
} = createSidePanel({ state,
  setAvailable: available => {
    summaryAvailable = available;
    updateContextControls();
    if (!available) contextPanel?.close({ restoreFocus: false, animate: false });
    syncNavigationSidebar();
  },
  focusFallback: () => visibleInstanceControl(),
});

// The search dropdown; a chosen row navigates like the matching tag click.
const searchUi = createSearchUi({
  store: () => state.store,
  renderOpts: getRenderOpts,
  flowSearch: () => state.store && state.instance && !state.doc && state.filter?.type !== 'entry'
    ? { label: [state.source ? sourceName() : 'Entries', state.filter ? getRenderOpts().resolveName(state.filter.type, state.filter.id) : ''].filter(Boolean).join(' · '), term: state.search }
    : null,
  onFlowSearch: term => { void applyFlowSearch(term); },
  onRefresh: () => { if (state.store) refreshCalendarActivity(state.store); },
  query: (request, signal) => {
    const address = state.instance?.alias ?? state.instanceId;
    if (!address) return Promise.reject(new Error('Choose an Aside instance before searching.'));
    return queryDaemonInstance(address, request, signal);
  },
  onSelect: result => {
    navigationSidebar?.closePopover();
    if (result.type === 'date') {
      void navigateDate({ start: result.id });
    } else if (result.type === 'artifact') {
      openArtifact(result.id);
    } else if (result.type === 'entry') {
      void jumpToEntry(result.id, true, null, 'center', true, undefined, 'lookup');
    } else {
      handleTagClick({ type: result.type, id: result.id });
    }
  },
});
const { setupSearch, handleSearch, setSearchVisible, resetSearch } = searchUi;

function currentPageLabel(): string {
  if (contextPanel?.getState().open && contextPanel.getState().mode === 'expanded') {
    const target = currentContext();
    if (target.date) return target.date.end ? `${target.date.start} – ${target.date.end}` : formatStamp(target.date.start, state);
    if (target.doc?.kind === 'artifact') return state.store?.getArtifactDisplayName(target.doc.id) ?? target.doc.id;
    if (target.doc?.kind === 'asset') return target.doc.path.split('/').at(-1) ?? target.doc.path;
    if (target.ref) return getRenderOpts().resolveName(target.ref.type, target.ref.id);
    return state.store?.getInstance()?.manifest.name ?? 'Overview';
  }
  const doc = state.doc;
  if (!doc) return state.instance ? sourceName() : 'Aside';
  if (doc.kind === 'artifact') {
    const name = state.store?.getArtifactDisplayName(doc.id) ?? doc.id;
    return doc.filename ? `${doc.filename} · ${name}` : name;
  }
  if (doc.kind === 'asset') return doc.path.split('/').at(-1) ?? doc.path;
  return state.filter ? getRenderOpts().resolveName(state.filter.type, state.filter.id) : 'Overview';
}

function syncNavigationSidebar(): void {
  const available = navigationReady && !!state.store && !!state.instance;
  const route = buildRoute({ ...flowContext(), doc: state.doc });
  const sections = sidebarSections();
  renderedSidebar = { instance: state.instanceId, sections: structuredClone(sections) };
  const panelState = contextPanel?.getState();
  const fullscreen = panelState?.open && panelState.fullscreen;
  const selectedDoc = contextPanel ? currentContext().doc : state.doc;
  const artifact = selectedDoc?.kind === 'artifact' ? state.store?.getCachedArtifact(selectedDoc.id) : undefined;
  const html = documentIsHtml(selectedDoc, artifact);
  const currentLabel = currentPageLabel();
  const selectedView = workspaceView();
  navigationSidebar?.update({
    available,
    href: state.instanceId ? instanceUrl(state.instanceId, '') : '/',
    overviewHref: state.instanceId ? instanceUrl(state.instanceId, 'detail') : '/',
    currentLabel,
    overviewActive: selectedView.doc?.kind === 'detail' && !selectedView.filter,
    reader: (contextPanel ? fullscreen : state.doc) ? html ? 'html' : 'record' : available ? 'flow' : 'chooser',
    summaryAvailable,
    contextFullscreen: !!fullscreen,
    order: state.source && queryDefinition ? effectiveSourceOrder(queryDefinition, state.order) : undefined,
    sections: sections.map(section => ({ title: section.title, items: section.items.map(item => {
      let href = '#';
      try { href = instanceUrl(state.instanceId!, buildRoute(sidebarView(item, state.instanceId!))); } catch { /* An unavailable target stays visible for inspection. */ }
      return { label: sidebarItemLabel(item), href, active: pinMatches(item, state.instanceId!, selectedView) };
    }) })),
    entriesActive: !selectedView.doc && selectedView.filter?.type !== 'entry',
    pinned: sections.some(section => section.items.some(item => pinMatches(item, state.instanceId!, selectedView))),
    inspection: documentDetails ?? (state.source ? sourceInspection() : JSON.stringify({ instance: state.instanceId, page: currentLabel,
      source: state.doc ? 'Native content page' : 'All entries', filter: state.filter, search: state.search || null, range: state.range ?? null, order: state.order ?? null, route }, null, 2)),
  });
  refreshCalendarPosition();
}

function visibleInstanceControl(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('#control-pill button, #btn-instance-switch, .app-title a')].find(usable) ?? null;
}

function setupNavigationSidebar(): void {
  if (!$('#navigation-sidebar')) return;
  navigationSidebar ??= createWorkspaceFrame({
    beforeOpen: () => { datePicker.close(); setSearchVisible(false); instanceSwitcher?.close(); },
    preserveLayout: paint => {
      const containers = [$('#flow-scroll'), $('#doc-body')].filter((node): node is HTMLElement => !!node);
      preserveReadingPosition(containers, paint);
      updateLatch();
    },
    openSearch: () => { $<HTMLInputElement>('.search-input')?.focus({ preventScroll: true }); },
    // Arrival/flow animations suppress measurement until cards settle.
    onLayout: ({ panels, controlsOpen }) => {
      if (contextPanel) {
        contextControlsOpen = controlsOpen;
        syncContextWebpages();
        contextPanel.layout();
        if (panels && !contextAutomatic && summaryAvailable && !contextDismissed) contextPanel.open();
        if (!panels && contextAutomatic && contextPanel.getState().mode === 'summary') contextPanel.close({ restoreFocus: false });
        contextAutomatic = panels;
      }
      updateLatch(); refreshCalendarPosition();
    },
    onEntries: () => { void applyView({ filter: null, search: '', doc: null }, { dismissContext: true }); },
    onOverview: () => { if (contextPanel) void inspectContext({ ref: null, doc: null }, { focus: true });
      else void applyView({ ...flowContext(), filter: null, doc: { kind: 'detail' } }); },
    onSummary: contextPanel ? () => { contextDismissed = false; contextInteraction++; contextPanel?.open({ focus: true }); } : undefined,
    onSort: order => { void applyView({ ...flowContext(), order, doc: null }, { resetPosition: true }); },
    onPin: pinned => { void setCurrentPin(pinned); },
    onNavigateItem: (sectionIndex, itemIndex) => {
      const item = renderedSidebar.sections[sectionIndex]?.items[itemIndex];
      if (!item || !state.instanceId || renderedSidebar.instance !== state.instanceId) return;
      try {
        const target = sidebarView(item, state.instanceId);
        if (contextPanel && item.entity) void inspectContext({ ref: target.filter, doc: target.doc }, { focus: true });
        else void applyView(target, { dismissContext: !!contextPanel });
      }
      catch (error) { showActionFailure(error instanceof Error ? error.message : 'Could not open this view.'); }
    },
  });
  navigationSidebar.setup();
  const calendarHost = $('#timeline-calendar-inline');
  if (calendarHost) datePicker.mountInline(calendarHost);
  syncNavigationSidebar();
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
  bindSelect('#setting-week-start', String(state.weekStartsOn), v => {
    state.weekStartsOn = weekStartsOn(v);
    localStorage.setItem('weekStartsOn', String(state.weekStartsOn));
    refreshDateTimeSettings(state);
    datePicker.refresh();
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

  setupRefCoHover();
  setupInstanceTooltips();
  $('.app-title a')?.addEventListener('click', event => {
    const click = event as MouseEvent;
    if (click.button || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return;
    event.preventDefault(); stampReaderScroll(); history.pushState(null, '', '/'); void showInstanceChooser();
  });
  const switcher = $('#instance-switcher');
  if (switcher) instanceSwitcher = new InstanceSwitcher(switcher,
    instance => { void connectToInstance(instance.address ?? instance.id, instance); },
    () => { stampReaderScroll(); history.pushState(null, '', '/'); void showInstanceChooser(); }, undefined,
    instances => ensureInstanceChooser()?.setCatalogue(instances));

  $('#btn-theme-toggle')?.addEventListener('click', () => {
    state.darkMode = !state.darkMode;
    localStorage.setItem('darkMode', String(state.darkMode));
    applyTheme();
  });

  $('#btn-settings')?.addEventListener('click', () => showConfigModal());
  $('#btn-modal-close')?.addEventListener('click', () => hideConfigModal());
  setupContextPanel();
  if (!contextPanel) $('#btn-side-panel-close')?.addEventListener('click', () => clearFilter());
  $('#btn-doc-close')?.addEventListener('click', () => closeDoc());
  setupModals();
  setupNavigationSidebar();

  setupSearch();
  $('#btn-edit-flow-search')?.addEventListener('click', () => withTimelineControl(() => { navigationSidebar?.openSearch(); searchUi.editFlowSearch(state.search); }));
  $('#btn-clear-flow-search')?.addEventListener('click', () => { void applyFlowSearch(''); });

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
    latchFrame = requestAnimationFrame(() => { latchFrame = 0; updateLatch(); refreshCalendarPosition(); });
  }, { passive: true });
  window.addEventListener('resize', () => { updateLatch(); refreshCalendarPosition(); });
  window.matchMedia('(max-width: 768px)').addEventListener('change', refreshTimeDisplay);

  // Keep the current entry's panel state current the same way as its flow
  // anchor: stamp on scroll (debounced) and whenever a section is expanded,
  // so a later back/forward restores the panel where it was left.
  const panelBody = $('#side-panel-body');
  let panelStampTimer: ReturnType<typeof setTimeout>;
  panelBody?.addEventListener('scroll', () => {
    // The scroll a restore sets fires here too — skip it so it can't arm a
    // stamp that would overwrite the state being restored.
    if (isPanelRestoring() || navigationSidebar?.isMovingSummary()) return;
    if (!panelBody.closest('[hidden], [inert]')) panelBody.dataset.panelScroll = String(panelBody.scrollTop);
    clearTimeout(panelStampTimer);
    panelStampTimer = setTimeout(stampPanel, 400);
  }, { passive: true });
  panelBody?.addEventListener('click', (e) => {
    if (!navigationSidebar?.isMovingSummary() && (e.target as HTMLElement).closest('.related-more')) stampPanel();
  });
  let readerStamp: ReturnType<typeof setTimeout>;
  $('#doc-body')?.addEventListener('scroll', () => {
    const source = state.doc, instance = state.store, request = navigationGeneration;
    clearTimeout(readerStamp);
    readerStamp = setTimeout(() => {
      if (!source || !sameDoc(state.doc, source) || instance !== state.store || request !== navigationGeneration) return;
      stampReaderScroll();
    }, 200);
  }, { passive: true });
}

let readerModal: ModalController | undefined;
let settingsModal: ModalController | undefined;

function setupModals(): void {
  const prepareModal = () => { navigationSidebar?.closePopover(); datePicker.close(); setSearchVisible(false); };
  const fallback = visibleInstanceControl;
  const reader = $('#doc-backdrop'), body = $('#doc-body');
  if (reader && body) readerModal = createReaderPage(reader, body, {
    beforeOpen: prepareModal, fallback, changed: syncNavigationSidebar,
  });
  const settings = $<HTMLDialogElement>('#modal-backdrop');
  if (settings) settingsModal = createModal(settings, {
    dismiss: hideConfigModal, beforeOpen: prepareModal, fallback, duration: () => transitionMs,
  });
}

let statusSelection: AvailableInstance | undefined;
function showConfigModal(instance?: AvailableInstance) { statusSelection = instance; renderInstanceStatus(instance); settingsModal?.open(); if (!instance) void refreshInstanceMetadata(); }
function hideConfigModal() { settingsModal?.close(); statusSelection = undefined; }

function renderInstanceStatus(selection?: AvailableInstance): void {
  syncNavigationSidebar();
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
  resumeDateCount = undefined;
  cancelTimelineDateCount();
  navigationReady = false;
  invalidateCalendarActivity();
  calendarPosition = undefined;
  documentDetails = undefined;
  queryFlow?.dispose(); queryFlow = undefined; queryDefinition = undefined; queryProblem = undefined;
  sourceInspectionBody = undefined; sourceInspectionKey = '';
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
  datePicker.refresh({ invalidateCounts: true });
  resetLatchMarkers();
  state.filter = null;
  state.search = '';
  state.source = undefined;
  state.range = undefined;
  state.order = undefined;
  state.doc = null;
  returnFlow = null;
  syncNavigationSidebar();
  updateFlowSearch();
  updateSourcePill();
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
  if (selection) stampReaderScroll();
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
    stopSearchCorpus = searchUi.watchSearchCorpus(store);
    appliedRoute = selection ? '' : locationRoute();
    const view = parseRoute(appliedRoute);
    const canonical = buildRoute(view);
    if (!selection && canonicalLocation(canonical) !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      history.replaceState(history.state, '', canonicalLocation(canonical));
    }
    appliedRoute = canonical;
    const nav = selection ? null : history.state as NavState | null;
    if (view.jump) {
      const applying = applyView({ ...view, doc: null }, { push: false, forceFlow: true, userInitiated });
      const navigation = navigationGeneration;
      await applying;
      if (state.store !== store || navigation !== navigationGeneration) return;
      // A cold deep link opens at its target. The single entrance below then
      // reveals those cards; only an already open timeline scrolls to a jump.
      await jumpToEntry(view.jump, false, null, 'center', userInitiated, 0);
    } else if (view.date || view.filter || view.doc || view.search || view.source || view.range || view.order) {
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
      scroller.hidden = !!state.doc;
      navigationReady = true;
      syncNavigationSidebar();
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
        refreshCalendarPosition();
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
    history.replaceState({ ...nav, anchor: initialAnchor, engaged: nav?.engaged ?? null, returnFlow: state.doc ? returnFlow : null } satisfies NavState, '');
    if (pendingControlRoute !== null) {
      const route = pendingControlRoute;
      pendingControlRoute = null;
      navigateToRoute(route);
    }
  } catch (error) {
    if (generation !== connectGeneration) return;
    state.store = null;
    navigationReady = false;
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
      else { await store.reloadFile(diagnostic.path); refreshCalendarActivity(store); }
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
    (replacement ?? (host.hidden ? visibleInstanceControl() : summary))?.focus({ preventScroll: true });
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
  returnFlow?: ReturnFlow | null;
  readerScroll?: number;
}

interface ReturnFlow {
  view: ViewState;
  anchor: FlowAnchor | null;
  panel: PanelView | null;
  calendar?: { current: string; visibleRange?: VisibleTimelineDates };
}
let returnFlow: ReturnFlow | null = null;
let calendarPosition: { key: string; current: string; visibleRange?: VisibleTimelineDates } | undefined;
let calendarRefreshKey = '';
let calendarActivity: { key: string; collector?: CalendarCounts; pending?: Promise<CalendarCounts> } | undefined;

function calendarKey(): string {
  if (!navigationReady || !state.store || !state.instanceId) return '';
  const context = timelineContext();
  return JSON.stringify([state.instanceId, context.filter, context.search ?? '', context.source ?? null, context.range ?? null, context.order ?? null]);
}

function calendarContext(): { key: string; current: string; visibleRange?: VisibleTimelineDates; retained?: boolean } {
  const key = calendarKey();
  if (state.doc && returnFlow?.calendar) return { key, ...returnFlow.calendar, retained: true };
  if (!state.doc && !flowRestoring && !flowTransition) {
    const scroller = $('#flow-scroll');
    const visibleRange = scroller && !scroller.hidden ? visibleTimelineDates(scroller) : undefined;
    calendarPosition = { key, current: currentFlowDate(), visibleRange };
  }
  if (calendarPosition?.key === key) return calendarPosition;
  return { key, current: state.doc && returnFlow?.anchor ? returnFlow.anchor.entryId.slice(0, 10) : currentFlowDate() };
}

function refreshCalendarPosition(): void {
  // Rendering and FLIP transitions temporarily expose intermediate geometry.
  if (!state.doc && (flowRestoring || flowTransition)) return;
  const context = calendarContext();
  const controls = $('#workspace-timeline-controls');
  const visible = !!controls?.isConnected && !controls.closest('[hidden], [inert]');
  const signature = JSON.stringify([context, visible]);
  if (signature === calendarRefreshKey) return;
  calendarRefreshKey = signature;
  datePicker.refresh();
}

function invalidateCalendarActivity(): void {
  calendarActivity?.collector?.dispose();
  calendarActivity = undefined;
}

// Explicit recovery reads install new store data outside applyDataUpdate.
// Recount even when the timeline's selection and displayed month are unchanged.
function refreshCalendarActivity(store: Store): void {
  if (state.store !== store) return;
  invalidateCalendarActivity();
  datePicker.refresh({ invalidateCounts: true });
}

async function calendarDayCounts(from: string, to: string): Promise<ReadonlyMap<string, number>> {
  const store = state.store, key = calendarKey(), context = structuredClone(timelineContext());
  const address = state.instance?.alias ?? state.instanceId;
  if (!store || !key || !address) throw new Error('The timeline is not available.');
  if (calendarActivity?.key !== key) {
    invalidateCalendarActivity();
    calendarActivity = { key };
  }
  const activity = calendarActivity!;
  if (!activity.collector && !activity.pending) {
    activity.pending = (async () => {
      let definition: SourceDefinition | undefined;
      if (context.source) {
        const ref = entrySourceReference(context.source), artifact = await store.getArtifact(ref.id);
        if (!artifact.frontMatter.attachments?.includes(ref.filename)) throw new Error('The query attachment is no longer listed by this artifact.');
        definition = parseEntrySource(await store.getAsset(artifactAttachmentRelativePath(ref.id, ref.filename)));
      }
      if (calendarActivity !== activity || state.store !== store) throw new Error('The calendar timeline changed.');
      const range = context.range && { start: localDateStamp(context.range.start), end: localDateStamp(context.range.end) };
      return activity.collector = createCalendarCounts({ store, definition, filter: context.filter, search: context.search, range, order: context.order,
        query: (request, signal) => queryDaemonInstance(address, request, signal) });
    })().finally(() => { activity.pending = undefined; });
  }
  const collector = activity.collector ?? await activity.pending!;
  return collector.getDayCounts(from, to);
}

// The inspected date belongs to the retained timeline's full selection, not
// its loaded pages. Keep exact clock bounds for ranges; a lone date/clock
// represents the local calendar day containing the jump destination.
let dateCountRevision = 0;
let disposeDateCount: (() => void) | undefined;
let resumeDateCount: (() => void) | undefined;
function cancelTimelineDateCount(): void {
  dateCountRevision++;
  disposeDateCount?.();
  disposeDateCount = undefined;
}

async function timelineDateEntryCount(date: DateReference): Promise<number | undefined> {
  const revision = dateCountRevision;
  const store = state.store, key = calendarKey(), context = structuredClone(timelineContext());
  const address = state.instance?.alias ?? state.instanceId;
  if (!store || !key || !address) throw new Error('The timeline is not available.');
  const current = () => revision === dateCountRevision && state.store === store && calendarKey() === key;
  const start = localDateStamp(date.start), end = date.end && localDateStamp(date.end);
  const additionalRange = end ? { start, end } : { start: start.slice(0, 10), end: start.slice(0, 10) };
  let definition: SourceDefinition | undefined;
  if (context.source) {
    const ref = entrySourceReference(context.source), artifact = await store.getArtifact(ref.id);
    if (!current()) return;
    if (!artifact.frontMatter.attachments?.includes(ref.filename)) throw new Error('The query attachment is no longer listed by this artifact.');
    const text = await store.getAsset(artifactAttachmentRelativePath(ref.id, ref.filename));
    if (!current()) return;
    definition = parseEntrySource(text);
  }
  if (!current()) return;
  const range = context.range && { start: localDateStamp(context.range.start), end: localDateStamp(context.range.end) };
  const collector = createCalendarCounts({ store, definition, filter: context.filter, search: context.search, range,
    additionalRange, order: context.order, query: (request, signal) => queryDaemonInstance(address, request, signal) });
  const dispose = () => collector.dispose();
  disposeDateCount = dispose;
  try {
    const counts = await collector.getDayCounts(additionalRange.start.slice(0, 10), additionalRange.end.slice(0, 10));
    if (!current()) return;
    return [...counts.values()].reduce((total, count) => total + count, 0);
  } catch (error) {
    if (current()) throw error;
  } finally {
    dispose();
    if (disposeDateCount === dispose) disposeDateCount = undefined;
  }
}

function withTimelineControl(action: () => void): void {
  if (!state.doc) { action(); return; }
  const origin = returnFlow;
  const restoring = applyView({ ...timelineContext(), doc: null }, { anchor: origin?.anchor, panel: origin?.panel });
  const request = navigationGeneration;
  void restoring.then(() => { if (request === navigationGeneration && !state.doc) action(); });
}

function stampReaderScroll(): void {
  const host = $('#doc-backdrop'), body = $('#doc-body');
  if (!state.doc || !body || host?.hidden) return;
  history.replaceState({ ...(history.state ?? {}), readerScroll: body.scrollTop }, '');
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

function flowHasMore(): boolean {
  return state.source ? !!queryFlow?.hasMore && !queryFlow.error && !queryProblem : state.loadedWeeks < currentViewWeeks.length;
}

function flowComplete(): boolean {
  return state.source ? !!queryFlow?.complete && !queryFlow.error && !queryProblem
    : state.loadedWeeks >= currentViewWeeks.length && [...weekViews.values()].every(view => view.status() === 'loaded');
}

async function prepareQueryFlow(generation: number, store: Store): Promise<void> {
  const source = state.source;
  if (!source) return;
  try {
    const ref = entrySourceReference(source);
    const artifact = await store.getArtifact(ref.id);
    if (!artifact.frontMatter.attachments?.includes(ref.filename)) throw new Error('The query attachment is no longer listed by this artifact.');
    const text = await store.getAsset(artifactAttachmentRelativePath(ref.id, ref.filename));
    if (generation !== flowGeneration || state.store !== store || state.source !== source) return;
    queryDefinition = parseEntrySource(text);
    const address = state.instance?.alias ?? state.instanceId;
    if (!address) throw new Error('The source instance is unavailable.');
    queryFlow = createQueryFlow({ definition: queryDefinition, store, filter: state.filter, search: state.search, range: localRange(), order: state.order,
      query: (request, signal) => queryDaemonInstance(address, request, signal) });
  } catch (error) {
    if (generation !== flowGeneration || state.store !== store || state.source !== source) return;
    queryProblem = error instanceof Error ? error : new Error(String(error));
  }
  if (generation === flowGeneration) { syncNavigationSidebar(); renderQueryNotice(); }
}

function renderQueryNotice(): void {
  const flow = $('#flow');
  if (!flow) return;
  const old = $('#query-flow-notice');
  const focused = !!old?.contains(document.activeElement);
  old?.remove();
  const error = queryProblem ?? queryFlow?.error;
  if (!state.source || !error) {
    if (focused) visibleInstanceControl()?.focus({ preventScroll: true });
    return;
  }
  const notice = document.createElement('div'); notice.id = 'query-flow-notice'; notice.className = 'history-notice';
  const details = document.createElement('details');
  const title = document.createElement('summary');
  title.textContent = queryFlow?.incomplete ? 'The entry view could not be verified.' : `Could not load ${sourceName()}.`;
  const reason = document.createElement('p'); reason.textContent = error.message;
  details.append(title, reason);
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'history-retry notice-action'; retry.textContent = 'Retry';
  retry.addEventListener('click', () => {
    const store = state.store, source = state.source, navigation = navigationGeneration, anchor = timeCursorAnchor();
    if (!store || !source) return;
    const retainedFocus = notice.contains(document.activeElement);
    if (retainedFocus) title.focus({ preventScroll: true });
    retry.disabled = true;
    void (async () => {
      try {
        const pending = await store.check('full', currentHotSet(), [sourcePath(source)]);
        if (state.store !== store || navigationGeneration !== navigation || state.source !== source) return;
        pending?.apply();
        refreshCalendarActivity(store);
        await renderFlow(anchor, false, true);
        if (state.store === store && navigationGeneration === navigation && state.source === source) await showSidePanel(panelSnapshot());
      } catch (reason) {
        if (state.store !== store || navigationGeneration !== navigation || state.source !== source) return;
        queryProblem = reason instanceof Error ? reason : new Error(String(reason)); renderQueryNotice(); syncNavigationSidebar();
      } finally {
        if (retainedFocus && state.store === store && navigationGeneration === navigation && state.source === source
          && !usable(document.activeElement as HTMLElement | null)) {
          (document.querySelector<HTMLElement>('#query-flow-notice .history-retry') ?? visibleInstanceControl())?.focus({ preventScroll: true });
        }
      }
    })();
  });
  notice.append(details, retry); flow.insertBefore(notice, $('#scroll-sentinel'));
  if (focused) retry.focus({ preventScroll: true });
}

async function loadQueryEntries(userInitiated: boolean): Promise<void> {
  const session = queryFlow, store = state.store, flow = $('#flow');
  if (!session || !store || !flow) return;
  const generation = flowGeneration;
  const current = () => generation === flowGeneration && state.store === store && queryFlow === session;
  const sentinel = $('#scroll-sentinel');
  const cancel = delayLoading(() => { if (sentinel) sentinel.className = 'scroll-sentinel loading'; }, current);
  try {
    await session.loadMore();
    if (!current()) return;
    if (session.entries.length > queryRendered) {
      const host = document.createElement('div'); host.className = 'query-page';
      flow.insertBefore(host, sentinel);
      const opts = getRenderOpts();
      for (const entry of session.entries.slice(queryRendered)) {
        const date = entry.meta.created.slice(0, 10);
        const marker = date !== lastMarkerDate
          ? { date, prev: lastMarkerDate, weekStart: lastWeekFile !== null && entry.weekFile !== lastWeekFile } : undefined;
        const card = renderEntry(entry, opts, host, marker);
        lastMarkerDate = date; lastWeekFile = entry.weekFile;
        const dateMarker = card.querySelector<HTMLElement>('.date-marker'); if (dateMarker) addLatchMarker(dateMarker);
      }
      queryRendered = session.entries.length;
      await renderDiagrams(host, { current, commit: paint => preserveReadingPosition([$('#flow-scroll') ?? flow], paint) });
    }
    if (!current()) return;
    renderQueryNotice(); updateEmptyFlow(); updateLatch(); syncNavigationSidebar();
    if (session.error && userInitiated) showActionFailure('Could not load this entry view. Try again.');
  } finally {
    cancel();
    if (current() && sentinel) {
      sentinel.className = 'scroll-sentinel'; sentinel.textContent = '';
      if (flowHasMore() && scrollObserver) { scrollObserver.unobserve(sentinel); scrollObserver.observe(sentinel); }
    }
  }
}

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
  const generation = flowGeneration;
  requestAnimationFrame(() => {
    if (generation !== flowGeneration) return;
    flowRestoring = false;
    updateLatch();
    refreshCalendarPosition();
  });
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
  queryFlow?.dispose(); queryFlow = undefined; queryDefinition = undefined; queryProblem = undefined; queryRendered = 0;
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
  mountLatch(flow, undefined, () => state);
  if (state.source) {
    await prepareQueryFlow(generation, store);
    if (generation !== flowGeneration) return;
  }

  // The anchor's card must exist before the scroll can be restored — load
  // down to its week. Its entries are already cached (the card was on
  // screen), so this doesn't wait on the network.
  let count = 5;
  if (anchor) {
    const target = currentViewWeeks.indexOf(entryWeek(anchor.entryId));
    if (target >= 0) count = Math.max(count, target + 1);
  }
  await loadMoreWeeks(state.source ? 1 : count, userInitiated);
  if (generation !== flowGeneration) return;
  flowInitialized = true;
  setupInfiniteScroll();
  updateEmptyFlow();
  let resolved: FlowAnchor | null = null;
  if (anchor) {
    // Pinning the moment needs both of its neighbors — keep loading until
    // a card at-or-before it is rendered (the oldest rendered card, since
    // the flow is latest-first) or the timeline ends.
    while (flowHasMore()) {
      const cards = flow.querySelectorAll<HTMLElement>('[data-entry-id]');
      const oldest = cards[cards.length - 1]?.dataset.entryId;
      if (oldest && (flowAscending() ? oldest >= anchor.entryId : oldest <= anchor.entryId)) break;
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
        && flowHasMore()) {
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
      refreshCalendarPosition();
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
    refreshCalendarPosition();
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
  const weeks = state.filter ? store.filterWeeks(state.filter) ?? store.getWeeklyDates() : store.getWeeklyDates();
  const range = localRange();
  if (!range) return weeks;
  const fromWeek = entryWeek(range.start), toWeek = entryWeek(range.end);
  return weeks.filter(week => week >= fromWeek && week <= toWeek);
}

function loadMoreWeeks(count: number, userInitiated = false): Promise<void> {
  if (weeksLoad) return weeksLoad;
  const pending = (state.source ? loadQueryEntries(userInitiated) : doLoadWeeks(count, userInitiated))
    .finally(() => { if (weeksLoad === pending) weeksLoad = null; });
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
  // Share the index across this batch, then release it: the retained week
  // views must not each keep a complete copy of the note index alive.
  let descriptions = state.search ? new Map(store.getNoteIndex().map(item => [item.id, item.description])) : null;

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
          if (retrying) { await store.reloadFile(weekFilePath(monday)); refreshCalendarActivity(store); }
          return store.getWeekEntries(monday);
        },
        current: () => generation === flowGeneration && store === state.store,
        focusFallback: visibleInstanceControl,
        render: async (entries, host) => {
          const opts = getRenderOpts();
          const searchDescriptions = state.search && (!descriptions || retrying)
            ? new Map(store.getNoteIndex().map(item => [item.id, item.description])) : descriptions;
          const visible = entries.filter(entry => (!state.filter || entryReferences(entry, state.filter))
            && matchesFlowSearch(entry, state.search, searchDescriptions?.get(entry.meta.created)) && withinTimestampRange(entry.meta.created, localRange()));
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
          refreshCalendarPosition();
        },
      });
      weekViews.set(monday, view);
      flow.insertBefore(view.host, sentinel ?? null);
      await view.load(false, userInitiated);
      if (generation !== flowGeneration) return;
    }
    if (generation !== flowGeneration) return;
  } finally { cancelLoading(); descriptions = null; }

  state.loadedWeeks = end;

  if (sentinel) {
    flow.appendChild(sentinel);
    if (end >= weeks.length && !state.filter && !state.search && !state.range) {
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
  refreshCalendarPosition();
}

function refreshFlowMarkers(flow: HTMLElement): void {
  resetLatchMarkers();
  lastMarkerDate = null;
  lastWeekFile = null;
  for (const card of flow.querySelectorAll<HTMLElement>('.week-view > .entry-card, .query-page > .entry-card')) {
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
  if (state.source) return !!queryProblem || !!queryFlow?.error;
  const targetWeek = entryWeek(target);
  const candidateWeek = card ? entryWeek(card.dataset.entryId!) : null;
  return [...weekViews].some(([week, view]) => (view.status() !== 'loaded' || !!state.store?.diagnosticsFor(weekFilePath(week)))
    && (week === targetWeek || (!candidateWeek || week >= candidateWeek) && week <= targetWeek));
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
  if (!state.source && state.loadedWeeks >= currentViewWeeks.length && !state.filter && !state.search && !state.range) {
    sentinel.className = 'scroll-sentinel end'; sentinel.textContent = 'The End';
  }
  flow.appendChild(sentinel);

  scrollObserver?.disconnect();
  scrollObserver = new IntersectionObserver(
    (entries) => {
      // Records batch: a fast scroll can deliver [leave, enter] together, and
      // the newest record decides — reading only the first would drop the load.
      if (entries.some((e) => e.isIntersecting)) {
        if (flowHasMore()) void loadMoreWeeks(3);
      }
    },
    { root: $('#flow-scroll'), threshold: 0.1 }
  );
  scrollObserver.observe(sentinel);
}

function updateEmptyFlow(): void {
  const flow = $('#flow'), store = state.store, instance = state.instance;
  if (!flow || !store || !instance) return;
  const settled = flowInitialized && flowComplete();
  const kind = emptyFlowKind(store, state.filter, settled, !!flow.querySelector('[data-entry-id]'), state.search, !!state.source || !!state.range);
  const old = flow.querySelector<HTMLElement>('.flow-empty');
  if (old?.dataset.emptyKind === kind && old.dataset.instanceId === instance.id) return;
  old?.remove();
  if (!kind) return;
  const empty = renderEmptyFlow(kind, instance, {
    clearFilter: () => { void applyView({ ...flowContext(), filter: null, range: undefined, doc: null }); }, hasNotes: store.getNoteIndex().length > 0,
    clearSearch: state.search ? () => { void applyFlowSearch(''); } : undefined,
    hasFilter: !!state.filter || !!state.range,
    clearSource: state.source ? clearSource : undefined,
  });
  flow.insertBefore(empty, document.getElementById('scroll-sentinel'));
}

// The route the current view reflects. A duplicate hash event is ignored;
// a history traversal still restores its state even when the route is equal.
let appliedRoute: string | null = null;

// Every shareable view URL includes its instance identity.
function urlFor(route: string): string {
  return state.instanceId === null ? '/' : instanceUrl(state.instanceId, route);
}

// Browsing query parameters belong to view state. Other query parameters
// and fragments retain their existing lifetime during URL canonicalization.
function locationRoute(): string {
  const route = readInstanceLocation(window.location.pathname).route;
  const current = new URLSearchParams(window.location.search), browsing = new URLSearchParams();
  for (const key of ['source', 'search', 'range', 'order']) {
    const value = current.get(key)?.trim(); if (value) browsing.set(key, value);
  }
  return route + (browsing.size ? `?${browsing}` : '');
}

function canonicalLocation(route: string): string {
  const url = new URL(urlFor(route), window.location.origin);
  for (const [key, value] of new URLSearchParams(window.location.search)) {
    if (!['source', 'search', 'range', 'order'].includes(key)) url.searchParams.append(key, value);
  }
  return `${url.pathname}${url.search}${window.location.hash}`;
}

function updateFlowSearch(): void {
  const host = $('#flow-search');
  if (!host) return;
  const focused = host.contains(document.activeElement);
  const context = timelineContext();
  host.hidden = !context.search || context.filter?.type === 'entry' || !state.store;
  const input = $<HTMLInputElement>('.search-input');
  if (input) input.placeholder = host.hidden ? 'Search entries, projects, actions, artifacts...' : 'Search Aside…';
  if (host.hidden && focused && state.store && !state.doc) visibleInstanceControl()?.focus({ preventScroll: true });
  const edit = $<HTMLButtonElement>('#btn-edit-flow-search');
  if (edit) {
    edit.textContent = `“${context.search ?? ''}”`;
    edit.title = `Edit flow search: ${context.search ?? ''}`;
    edit.setAttribute('aria-label', edit.title);
  }
}

function updateFilterPill(): void {
  const host = $('#filter-pill');
  if (!host) return;
  const ref = timelineContext().filter;
  const hadFocus = host.contains(document.activeElement), wasClear = document.activeElement?.matches('.filter-pill-clear');
  host.hidden = !ref || !state.store;
  host.replaceChildren();
  if (host.hidden || !ref) {
    if (hadFocus) visibleInstanceControl()?.focus({ preventScroll: true });
    return;
  }
  const opts = getRenderOpts();
  const label = document.createElement('button'); label.type = 'button';
  label.className = `filter-pill-label tag tag-${ref.type}`;
  label.dataset.refType = ref.type; label.dataset.refId = ref.id;
  const text = document.createElement('span'); text.className = 'tag-text';
  text.textContent = opts.resolveName(ref.type, ref.id); label.append(text);
  const describe = (name: string) => { label.title = `Summary: ${name}`; label.setAttribute('aria-label', `Show summary for ${name}`); };
  describe(text.textContent);
  if (ref.type === 'entry') bindDisplay(text, opts, (node, current) => {
    const name = current.resolveName(ref.type, ref.id); setDisplayText(node, name); describe(name);
  });
  applyRefStatus(label, ref.type, ref.id, opts);
  label.addEventListener('click', () => withTimelineControl(() => {
    if (contextPanel) void inspectContext({ ref, doc: null }); else navigationSidebar?.openSummary();
  }));
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'filter-pill-clear';
  clear.textContent = '×'; clear.title = 'Clear filter'; clear.setAttribute('aria-label', 'Clear filter');
  clear.addEventListener('click', () => clearFilter());
  host.append(label, clear);
  if (hadFocus) (wasClear ? clear : label).focus({ preventScroll: true });
}

async function applyFlowSearch(term: string): Promise<void> {
  const context = timelineContext();
  if (!state.store || context.filter?.type === 'entry') return;
  await applyView({ ...context, search: term.trim(), doc: null });
}

function setRoute(view: ViewState, anchor: FlowAnchor | null = null) {
  const route = buildRoute(view);
  appliedRoute = route;
  if (locationRoute() !== route) {
    const nav: NavState = { anchor, engaged: engagedEntryId, returnFlow: view.doc ? returnFlow : null };
    history.pushState(nav, '', urlFor(route));
  }
}

// Move to a new view state: sync the URL, side panel, document reader, and
// flow. Every navigation goes through here so the URL always reflects the view.
async function applyView(
  next: ViewState,
  opts: { push?: boolean; forceFlow?: boolean; resetPosition?: boolean; anchor?: FlowAnchor | null; panel?: PanelView | null; userInitiated?: boolean; jumpDuration?: number; preserveContext?: boolean; dismissContext?: boolean } = {},
) {
  if (!state.store) return;
  if (!next.source && next.order) next = { ...next, order: undefined };
  if (next.date?.end) next = { ...next, range: { start: next.date.start, end: next.date.end }, date: undefined };
  navigationSidebar?.closePopover();
  const request = ++navigationGeneration;
  const store = state.store;
  const { push = true, forceFlow = false, userInitiated = true } = opts;
  if (push) stampReaderScroll();
  const previousCalendar = !state.doc && next.doc ? calendarContext() : undefined;
  if (next.doc) {
    const remembered = !push ? (history.state as NavState | null)?.returnFlow : null;
    if (remembered) returnFlow = remembered;
    else if (!state.doc) returnFlow = {
      view: { filter: navigationReady ? state.filter : next.filter, search: navigationReady ? state.search : next.search,
        source: navigationReady ? state.source : next.source, range: navigationReady ? state.range : next.range, order: navigationReady ? state.order : next.order, doc: null },
      anchor: navigationReady ? timeCursorAnchor() : opts.anchor ?? null,
      panel: navigationReady ? panelSnapshot() : opts.panel ?? null,
      calendar: previousCalendar && { current: previousCalendar.current, visibleRange: previousCalendar.visibleRange },
    };
  } else returnFlow = null;
  if (userInitiated) dismissActionToast();
  const filterChanged = !sameFilter(state.filter, next.filter);
  const sourceChanged = state.source !== next.source || state.order !== next.order
    || JSON.stringify(state.range) !== JSON.stringify(next.range);
  const search = next.filter?.type === 'entry' ? '' : next.search?.trim() ?? '';
  const searchChanged = state.search !== search;
  const contextChanged = !!contextPanel && !next.doc && !opts.preserveContext && !sameContext(currentContext(), { ref: next.filter, doc: null });
  // An anchor only means something across a filter re-render. Navigations
  // that don't carry one (side panel, search) anchor the time cursor: the
  // date readout holds its moment while the cards shared between the two
  // views slide to their new positions.
  const anchor = !opts.resetPosition && (filterChanged || searchChanged || sourceChanged)
    ? opts.anchor ?? timeCursorAnchor() : null;
  if (filterChanged) engagedEntryId = next.filter ? anchor?.entryId ?? null : null;
  state.filter = next.filter;
  state.search = search;
  state.source = next.source;
  state.range = next.range;
  state.order = next.order;
  if (sourceChanged) { queryDefinition = undefined; queryProblem = undefined; }
  state.doc = next.doc;
  if (contextPanel && !next.doc && !opts.preserveContext && (filterChanged || searchChanged || sourceChanged || forceFlow || contextChanged)) {
    contextTarget = { ref: next.filter, doc: null };
    if (userInitiated) contextDismissed = false;
  }
  if (contextPanel && opts.dismissContext) {
    contextDismissed = true; contextInteraction++;
    contextPanel.close({ restoreFocus: false });
  }
  documentDetails = undefined;
  syncNavigationSidebar();
  updateFilterPill();
  updateSourcePill();
  updateFlowSearch();
  resetSearch(true);

  if (push) setRoute({ ...next, search }, anchor);

  // Panel, reader, and flow touch independent DOM — run them concurrently,
  // and leave the panel alone when only the document changed (it keeps its
  // scroll position and doesn't flicker through a reload).
  const tasks: Promise<void>[] = [updateDoc(false, userInitiated)];
  if (filterChanged || searchChanged || (contextPanel && (sourceChanged || contextChanged)) || opts.panel !== undefined) {
    const panelView = opts.panel !== undefined ? opts.panel : filterChanged ? undefined : panelSnapshot();
    tasks.push(showSidePanel(panelView, userInitiated, opts.panel !== undefined));
  }
  if (filterChanged || searchChanged || sourceChanged || forceFlow) tasks.push(renderFlow(anchor, false, userInitiated));
  await Promise.all(tasks);
  if (next.date && request === navigationGeneration && store === state.store) {
    const stamp = localDateStamp(next.date.start);
    await jumpToDate(stamp.slice(0, 10), stamp.length === 10 ? undefined : stamp, userInitiated, opts.jumpDuration);
  }
}

function handleTagClick(ref: EntityRef, source?: HTMLElement) {
  if (contextPanel) {
    const target = currentContext();
    const inTimeline = !!source?.closest('#flow');
    if (inTimeline && contextPanel.getState().open && !target.doc && sameFilter(target.ref, ref)) {
      if (ref.type === 'entry') void jumpToEntry(ref.id, true, anchorFromSource(source));
      else void toggleContextFilter(ref, source);
    } else void inspectContext({ ref, doc: null });
    return;
  }
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
    applyView({ ...flowContext(), source: state.doc ? undefined : state.source, filter: null, doc: null }, { anchor: anchorFromSource(source) ?? dismissAnchor() });
    return;
  }
  applyView({ ...flowContext(), source: state.doc ? undefined : state.source, filter: ref, doc: null }, { anchor: anchorFromSource(source) });
}

async function toggleContextFilter(ref: EntityRef, source?: HTMLElement): Promise<void> {
  const active = sameFilter(timelineContext().filter, ref);
  const store = state.store, interaction = contextInteraction;
  contextPanel?.setMode(contextPanel.getState().mode);
  const filtering = applyView({ ...timelineContext(), filter: active ? null : ref, doc: null },
    { anchor: anchorFromSource(source) ?? dismissAnchor(), preserveContext: true });
  const request = navigationGeneration;
  await filtering;
  if (state.store !== store || navigationGeneration !== request || contextInteraction !== interaction) return;
  contextDismissed = false;
  contextPanel?.open();
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
  origin: 'reference' | 'lookup' = 'reference',
) {
  if (!state.store) return;
  if (contextPanel) { contextDismissed = true; contextPanel.close({ restoreFocus: false }); }
  navigationSidebar?.closePopover();
  if (push) stampReaderScroll();
  const store = state.store;
  let request = ++navigationGeneration;
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

  const excludedBySearch = !!state.search && !matchesFlowSearch(entry, state.search, indexDescription(store.getNoteIndex(), id));
  const excludedByRange = !withinTimestampRange(id, localRange());
  if (excludedBySearch || excludedByRange) {
    if (origin === 'lookup') {
      // Global lookup opens its result directly. Preparing the broader flow
      // does not add a visit; the final entry jump below owns that history step.
      const filter = state.filter && (state.filter.type === 'entry' || !entryReferences(entry, state.filter)) ? null : state.filter;
      const applying = applyView({ ...flowContext(), filter, search: excludedBySearch ? '' : state.search, range: excludedByRange ? undefined : state.range, doc: null }, { push: false, anchor: anchor ?? timeCursorAnchor(), userInitiated });
      request = navigationGeneration;
      await applying;
      if (!current()) return;
    } else {
      if (userInitiated) showActionFailure(state.range && !withinTimestampRange(id, localRange()) ? 'This entry is outside the date range.' : 'This entry is outside the flow search.', {
        label: 'Open in all entries',
        run: () => {
          void (async () => {
            const applying = applyView({ filter: null, doc: null }, { push: false });
            const opening = navigationGeneration;
            await applying;
            if (opening !== navigationGeneration || store !== state.store) return;
            const jumping = jumpToEntry(id);
            const destination = navigationGeneration;
            await jumping;
            if (destination === navigationGeneration && store === state.store && !activeModal()) {
              document.querySelector<HTMLElement>(`#flow [data-entry-id="${CSS.escape(id)}"] a.em-time`)?.focus({ preventScroll: true });
            }
          })();
        },
      });
      return;
    }
  }

  if (state.source) {
    const session = queryFlow;
    let included: boolean;
    try {
      if (!session || queryProblem) throw queryProblem ?? new Error('The entry source is not ready. Retry the view.');
      included = session.entries.some(candidate => candidate.meta.created === id) || await session.contains(id, { filter: null });
    } catch (error) {
      if (current() && userInitiated) showActionFailure(error instanceof Error ? error.message : 'Could not verify this entry view.');
      return;
    }
    if (!current()) return;
    if (!included) {
      if (origin === 'lookup') {
        const applying = applyView({ ...flowContext(), source: undefined, doc: null }, { push: false, userInitiated });
        request = navigationGeneration; await applying;
        if (!current()) return;
      } else {
        if (userInitiated) showActionFailure(`This entry is outside ${sourceName()}.`, {
          label: 'Open in all entries',
          run: () => { void (async () => {
            const applying = applyView({ filter: null, doc: null }, { push: false });
            const opening = navigationGeneration; await applying;
            if (opening === navigationGeneration && state.store === store) await jumpToEntry(id);
          })(); },
        });
        return;
      }
    }
  }

  if (state.doc) {
    state.doc = null;
    returnFlow = null;
    syncNavigationSidebar();
    updateFilterPill();
    updateSourcePill();
    updateFlowSearch();
    resetSearch(true);
    await updateDoc();
    if (!current()) return;
  }
  // An entry detail page is not a flow context worth preserving — jumps always
  // leave it; project/action filters are kept when the target is inside them.
  if (state.filter && (state.filter.type === 'entry' || !entryReferences(entry, state.filter))) {
    state.filter = null;
    updateFilterPill();
    syncNavigationSidebar();
    void showSidePanel(undefined, userInitiated);
    await renderFlow(anchor ?? timeCursorAnchor(), false, userInitiated);
    if (!current()) return;
  }

  // The kept filter rides along in the route so the URL restores this view.
  if (push) setRoute({ ...flowContext(), doc: null, jump: id });

  if (state.source) {
    const generation = flowGeneration;
    await loadQueryDownTo(id, () => current() && generation === flowGeneration, userInitiated);
    if (!current() || generation !== flowGeneration || queryFlow?.error || queryProblem) return;
    const card = document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`);
    if (card) flashJump(card, block, duration ?? jumpDuration());
    return;
  }
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
async function loadQueryDownTo(targetId: string, current: () => boolean, userInitiated: boolean): Promise<void> {
  while (current() && flowHasMore()) {
    const oldest = queryFlow?.entries.at(-1)?.meta.created;
    if (oldest && (flowAscending() ? oldest >= targetId : oldest <= targetId)) return;
    await loadMoreWeeks(1, userInitiated);
  }
}

async function loadDownToDate(flow: HTMLElement, dateStr: string, targetId = `${dateStr}T23:59:59`, current = () => true, userInitiated = true) {
  const store = state.store;
  if (!store) return;
  if (state.source) return loadQueryDownTo(targetId, current, userInitiated);
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
  const complete = state.source ? !!queryFlow && !queryFlow.error && !queryProblem
    : [...weekViews].every(([week, view]) => view.status() === 'loaded' && !state.store?.diagnosticsFor(weekFilePath(week)));
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

// Shared timeline calendar, mounted in the sidebar or the pill's calendar page.
const datePicker = createDatePicker({
  displayPreferences: () => state,
  getCalendarContext: calendarContext,
  getDayCounts: calendarDayCounts,
  jumpToDate: (dateStr) => { void navigateDate({ start: dateStr }); },
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
    && !queryFlow?.loading
    && !flowRestoring
    && !datePicker.isOpen()
    && !navigationSidebar?.isCalendarOpen()
    && performance.now() - lastActivity > QUIET_AFTER_MS;
}

// What's on screen — the files a light check revalidates beyond the indexes.
function currentHotSet(): HotSet {
  const entities: HotSet['entities'] = [];
  const timeline = timelineContext();
  for (const filter of [state.filter, timeline.filter, contextPanel ? currentContext().ref : null]) {
    if (!filter || filter.type === 'entry') continue;
    const id = filter.type === 'action' ? actionSourceId(filter.id) : filter.id;
    if (!entities.some(entity => entity.kind === filter.type && entity.id === id)) entities.push({ kind: filter.type, id });
  }
  const assets = new Set<string>();
  for (const source of new Set([state.source, timeline.source])) {
    if (!source) continue;
    const id = entrySourceReference(source).id;
    if (!entities.some(entity => entity.kind === 'artifact' && entity.id === id)) entities.push({ kind: 'artifact', id });
    assets.add(sourcePath(source));
  }
  if (state.doc?.kind === 'asset') assets.add(state.doc.path);
  if (state.doc?.kind === 'artifact') {
    entities.push({ kind: 'artifact', id: state.doc.id });
    const path = selectedArtifactPath(state.doc.id, state.doc.filename);
    if (path) assets.add(path);
  }
  const contextDoc = contextPanel ? currentContext().doc : null;
  if (contextDoc?.kind === 'asset') assets.add(contextDoc.path);
  if (contextDoc?.kind === 'artifact') {
    if (!entities.some(entity => entity.kind === 'artifact' && entity.id === contextDoc.id)) entities.push({ kind: 'artifact', id: contextDoc.id });
    const path = selectedArtifactPath(contextDoc.id, contextDoc.filename);
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
    weeks: state.source ? [...new Set(queryFlow?.entries.map(entry => entry.weekFile) ?? [])] : currentViewWeeks.slice(0, state.loadedWeeks),
    entities,
    assets: [...assets],
  };
}

// Land a check's findings and re-render the affected surfaces. The flow
// re-renders through the usual anchored FLIP pass grounded at the time
// cursor, so an external change animates like any other re-render.
async function applyDataUpdate(update: PendingUpdate): Promise<void> {
  const coverage = JSON.stringify([state.store?.getSearchProgress(), state.store?.getDiagnostics()]);
  update.apply();
  const { weeks, entities, assets, indexesChanged } = update.summary;
  const source = timelineContext().source;
  const activityChanged = weeks.size > 0 || entities.size > 0 || indexesChanged ||
    !!source && assets.has(sourcePath(source)) ||
    coverage !== JSON.stringify([state.store?.getSearchProgress(), state.store?.getDiagnostics()]);
  if (activityChanged) invalidateCalendarActivity();
  const flowAffected = weeks.size > 0 || entities.size > 0 || indexesChanged ||
    !!state.source && assets.has(sourcePath(state.source)) ||
    artifactImageFiles('#flow-scroll img[data-artifact-handle]').some(path => assets.has(path)) ||
    webpageFiles($('#flow-scroll')).some(path => assets.has(path));
  const target = currentContext(), ref = target.ref, doc = target.doc, interaction = contextInteraction;
  const recordPath = documentFilePath(doc ?? { kind: 'detail' }, ref);
  const attachmentPath = doc?.kind === 'asset' ? doc.path : doc?.kind === 'artifact' ? selectedArtifactPath(doc.id, doc.filename) : null;
  const contextRecordChanged = assets.has(recordPath) || !!attachmentPath && assets.has(attachmentPath) ||
    (doc?.kind === 'artifact' ? entities.has(entityKey('artifact', doc.id)) :
      ref?.type === 'entry' ? weeks.has(entryWeek(ref.id)) :
      ref ? entities.has(entityKey(ref.type, ref.type === 'action' ? actionSourceId(ref.id) : ref.id)) : !doc && indexesChanged) ||
    artifactImageFiles('#side-panel-body img[data-artifact-handle]').some(path => assets.has(path)) ||
    artifactImageIds('#side-panel-body img[data-artifact-handle]').some(id => entities.has(entityKey('artifact', id))) ||
    webpageFiles($('#side-panel-body')).some(path => assets.has(path));
  if (flowAffected) {
    await renderFlow(timeCursorAnchor());
    // The panel reads the relation map and the entity/instance state — both may
    // have moved; re-render it in place, keeping its scroll and expanded sections.
    if (!contextPanel || interaction === contextInteraction && sameContext(currentContext(), target)) {
      await showSidePanel(panelSnapshot(), false, false, !contextRecordChanged);
    }
    // The docked filter pill reads the same caches — its name and status marks
    // move with them.
    updateFilterPill();
    updateSourcePill();
  }
  if (contextPanel && !flowAffected) {
    if (contextRecordChanged) await showSidePanel(panelSnapshot(), false, false, false);
  }
  syncNavigationSidebar();
  updateSourcePill();
  // The reader re-renders only when its own document changed — yanking a
  // document mid-read is worse than a stale linked-from list.
  if (state.doc) {
    let docChanged: boolean;
    if (state.doc.kind === 'artifact') {
      const path = selectedArtifactPath(state.doc.id, state.doc.filename);
      docChanged = entities.has(entityKey('artifact', state.doc.id)) || indexesChanged ||
        (path !== null && assets.has(path));
    } else {
      docChanged = state.doc.kind === 'asset' ? assets.has(state.doc.path) : state.filter == null ? indexesChanged :
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
  datePicker.refresh({ invalidateCounts: activityChanged });
}

function openAsset(path: string) {
  if (contextPanel) { void inspectContext({ ref: null, doc: { kind: 'asset', path } }); return; }
  applyView({ ...flowContext(), doc: { kind: 'asset', path } });
}

function openArtifact(id: string, filename?: string) {
  if (contextPanel) { void inspectContext({ ref: null, doc: { kind: 'artifact', id, filename } }); return; }
  void applyView({ ...flowContext(), doc: { kind: 'artifact', id, filename } });
}

// Open the current scope's record in the reader: the filtered project/action,
// or the instance manifest on the unfiltered flow. Entries have no detail —
// they read in full in the flow.
function openDetail() {
  if (contextPanel) { contextPanel.setMode('expanded'); return; }
  if (state.filter?.type === 'entry') return;
  applyView({ ...flowContext(), doc: { kind: 'detail' } });
}

function closeDoc() {
  if (contextPanel && !state.doc) { contextDismissed = true; contextInteraction++; clearContextRoute(); contextPanel.close(); return; }
  const origin = returnFlow;
  const returning = applyView(origin?.view ?? { ...flowContext(), doc: null },
    { anchor: origin?.anchor, panel: origin?.panel });
  const request = navigationGeneration;
  void returning.then(() => {
    if (request === navigationGeneration && !state.doc && origin?.anchor) restoreFlowScroll(origin.anchor);
  });
}

function clearFilter() {
  applyView({ ...timelineContext(), filter: null, doc: null }, { anchor: state.doc ? returnFlow?.anchor : dismissAnchor() });
}

// Clear the view state, summary, and Reader without touching the URL or flow.
function resetFilterUi() {
  state.filter = null;
  state.doc = null;
  contextTarget = null;
  contextInteraction++;
  contextBack.length = contextForward.length = 0;
  contextDismissed = false;
  updateFilterPill();

  closeSidePanel();

  readerModal?.close(0);
}

// One context surface retains the summary and its expanded record together.
// Inspecting a reference changes this target independently of the flow filter.
let panelLoadGeneration = 0;
let renderedPanelScope: { store: Store; ref: EntityRef | null; doc?: DocRef | null; planning?: OpenActionGroups['planning'] } | null = null;
let planningRefresh: Promise<void> | undefined;
// Reuse the visible minute clock; a changed projection window refreshes the
// summary, preserving loaded history. Unchanged windows retain their DOM.
function refreshPlanningWindow(): Promise<void> {
  if (planningRefresh) return planningRefresh;
  const scope = renderedPanelScope;
  if (!scope?.planning || scope.store !== state.store || !sameFilter(scope.ref, contextPanel ? currentContext().ref : state.filter)) return Promise.resolve();
  planningRefresh = (async () => {
    const page = await scope.store.getPlanningActions(scope.ref?.type === 'project' ? scope.ref.id : undefined);
    if (scope !== renderedPanelScope || scope.store !== state.store || !sameFilter(scope.ref, contextPanel ? currentContext().ref : state.filter)) return;
    if (planningSignature(page) !== scope.planning!.signature) await showSidePanel(panelSnapshot());
  })().catch(error => console.error('Failed to refresh recurrence projections:', error)).finally(() => { planningRefresh = undefined; });
  return planningRefresh;
}

async function showSidePanel(panelView?: PanelView | null, userInitiated = false, restoreView = false, retainBody = true) {
  resumeDateCount = undefined;
  cancelTimelineDateCount();
  const generation = ++panelLoadGeneration;
  const body = $('#side-panel-body');
  const store = state.store;
  if (!store) { closeSidePanel(); return; }
  const opts = getRenderOpts();
  const selected = contextPanel ? currentContext() : { ref: state.filter, doc: null };
  const ref = selected.ref;

  // An unfiltered flow whose source has no manifest has no instance to
  // summarize — no panel, no pill.
  if (!ref && !selected.doc && !selected.date && !store.getInstance()) {
    closeSidePanel();
    return;
  }

  showPanelElement();
  $('#side-panel')?.classList.toggle('is-instance', !ref && !selected.doc);
  if (contextPanel && contextAutomatic && !contextDismissed) contextPanel.open();
  const refreshing = renderedPanelScope?.store === store && sameFilter(renderedPanelScope.ref, ref) && sameDoc(renderedPanelScope.doc ?? null, selected.doc) && !selected.date;
  if (body && !refreshing) {
    holdPanelFocus(body);
    body.replaceChildren();
    renderedPanelScope = null;
  }

  // Loads below can lose a race with a newer navigation; only the load for
  // the still-current filter may write the panel.
  const stale = () => generation !== panelLoadGeneration || state.store !== store ||
    (contextPanel ? !sameContext(currentContext(), selected) : !sameFilter(state.filter, ref));
  const sameRecord = () => state.store === store && (contextPanel ? sameContext(currentContext(), selected) : sameFilter(state.filter, ref));
  const cancelLoading = body && !refreshing
    ? showDelayedLoading(body, 'Loading summary…', () => !stale()) : () => {};
  let failurePath = documentFilePath(selected.doc ?? { kind: 'detail' }, ref);

  try {
    let detail: HTMLElement;
    let essentials: ContextEssentials;
    let planning: OpenActionGroups['planning'];
    const pages = refreshing && !restoreView ? renderedPanelScope?.planning?.pages ?? 1 : 1;
    let complete: HTMLElement | undefined;
    const paths = new Set<string>([documentFilePath(selected.doc ?? { kind: 'detail' }, ref)]);
    const retryFile = async (path: string) => {
      if (!sameRecord()) return;
      const request = panelLoadGeneration;
      await retryReadableFile(store, path);
      if (sameRecord() && request === panelLoadGeneration) await showSidePanel(panelSnapshot(), true, true, false);
      updateDiagnostics();
    };
    opts.onMediaError = (path, error, media) => {
      if (!sameRecord() || !body?.contains(media)) return;
      store.reportAssetFailure(path, error);
      media.replaceWith(fileDiagnosticNotice(store.diagnosticsFor(path)!, () => retryFile(path)));
      updateDiagnostics();
    };
    if (selected.date) {
      const date = selected.date;
      const display = (stamp: string, current: RenderOptions) => {
        const datetime = dateTimeAttribute(stamp);
        const instant = /(?:Z|[+-]\d{2}:\d{2})$/.test(datetime) ? Date.parse(datetime) : undefined;
        return formatStamp(localDateStamp(stamp), current, instant !== undefined && Number.isFinite(instant) ? { instant } : undefined);
      };
      essentials = { kind: date.end ? 'date-range' : 'date', icon: dateIconState(date), name: current => date.end
        ? `${display(date.start, current)} – ${display(date.end, current)}` : display(date.start, current) };
      detail = document.createElement('div'); detail.className = 'entity-view date-summary';
      const heading = document.createElement('h1'); heading.className = 'entity-title';
      heading.textContent = date.end ? `${display(date.start, opts)} – ${display(date.end, opts)}` : display(date.start, opts);
      detail.append(heading);
    } else if (selected.doc?.kind === 'artifact') {
      const requested = selected.doc;
      const [artifact, relations] = await Promise.all([store.getArtifact(requested.id), store.getRelations()]);
      essentials = requested.filename
        ? { kind: 'attachment', name: requested.filename, icon: fileIconState(requested.filename) }
        : { kind: 'artifact', name: artifact.frontMatter.name, description: indexDescription(store.getArtifactIndex(), requested.id),
          counts: { attachments: artifact.frontMatter.attachments?.length ?? 0 }, icon: artifactIconState(artifact) };
      const filename = requested.filename ?? artifactContentFilename(artifact);
      const attachment = filename === undefined ? undefined : artifactAttachmentRelativePath(requested.id, filename);
      if (attachment) { paths.add(attachment); failurePath = attachment; }
      const content = attachment === undefined ? undefined : await loadAssetContent(store, attachment);
      detail = renderArtifactDetail(requested.id, artifact, indexDescription(store.getArtifactIndex(), requested.id), opts, {
        projects: relations.projectsByArtifact.get(requested.id) ?? [],
        actions: relations.actionsByArtifact.get(requested.id) ?? [],
        backlinks: relations.artifactBacklinks.get(requested.id) ?? [],
      }, content, requested.filename);
    } else if (selected.doc?.kind === 'asset') {
      const path = selected.doc.path;
      essentials = { kind: 'file', name: assetDisplayName(path), path, icon: fileIconState(path) };
      const [content, relations] = await Promise.all([loadAssetContent(store, path), store.getRelations()]);
      const descriptions = new Map(store.getNoteIndex().map(item => [item.id, item.description]));
      detail = renderAssetDetail(path, content, opts, (relations.entriesByAsset.get(path) ?? []).map(id => ({ id, description: descriptions.get(id) })));
    } else if (!ref) {
      const data = await instanceSummaryData(store, pages);
      const manifest = store.getInstance()!.manifest;
      essentials = { kind: 'instance', name: manifest.name ?? manifest.id, description: manifest.description,
        counts: { ...data.stats, artifacts: store.getArtifactIndex().length }, updated: data.latest };
      planning = data.actions.planning;
      detail = renderInstanceSummary(store.getInstance()!.manifest, opts, data, openDetail);
      if (contextPanel) {
        const instance = store.getInstance()!;
        complete = renderInstanceDetail(instance.manifest, instance.body, opts, await instanceDetailData(store));
      }
    } else {
      const relations = await store.getRelations();
      if (ref.type === 'project') {
        const project = await store.getProject(ref.id);
        const description = indexDescription(store.getProjectIndex(), ref.id);
        const data = await projectSummaryData(ref.id, store, relations, pages);
        essentials = { kind: 'project', name: project.frontMatter.name, description, counts: data.stats, updated: data.updated,
          status: () => projectPills(project.frontMatter), marks: () => projectMarks(project.frontMatter) };
        planning = data.actions.planning;
        detail = renderProjectSummary(project, description, opts, data, openDetail);
        if (contextPanel) complete = renderProjectDetail(ref.id, project, description, opts,
          buildProjectHierarchy(ref.id, relations.relatedProjects), await projectDetailData(ref.id, store, relations));
      } else if (ref.type === 'action') {
        const action = await store.getAction(ref.id);
        const description = indexDescription(store.getActionIndex(), ref.id);
        const data = await actionSummaryData(ref.id, store, relations);
        essentials = { kind: 'action', name: action.frontMatter.name, description, counts: data.stats, updated: data.updated,
          status: current => [...(data.projected ? [{ label: 'Projected', marks: [] }] : []), ...actionPills(action.frontMatter, current.nowDate)],
          marks: current => actionMarks(action.frontMatter, current.nowDate) };
        detail = renderActionSummary(action, description, opts, data, openDetail);
        if (contextPanel) complete = renderActionDetail(ref.id, action, description, opts, entityStats('action', ref.id, relations));
      } else {
        const entry = await resolveEntry(store, ref.id);
        if (!entry) throw new Error(`Entry ${ref.id} not found`);
        essentials = { kind: 'entry', name: current => current.resolveName('entry', ref.id),
          counts: { projects: { total: new Set(entry.meta.projects ?? []).size }, actions: { total: new Set(entry.meta.actions ?? []).size } } };
        detail = renderEntryDetail(entry, opts, entryRelations(entry));
      }
    }
    if (stale()) return;
    const restoringView = refreshing && !restoreView ? panelSnapshot() : panelView;
    let retainedFocus: HTMLElement | null = null;
    if (contextPanel) {
      const retained = refreshing && retainBody ? body?.querySelector<HTMLElement>(':scope > .context-content') ?? undefined : undefined;
      if (retained && !(document.activeElement instanceof Element && document.activeElement.closest('[data-context-detail] > .detail-body'))) {
        retainedFocus = body ? holdPanelFocus(body) : null;
      }
      detail = renderContextContent(detail, complete, retained, renderContextEssentials(essentials, opts));
      if (retained && detail === retained) refreshDisplay(detail, opts, 0);
      documentDetails = readerDetails(complete ?? detail);
      for (const path of paths) {
        const diagnostic = store.diagnosticsFor(path);
        if (diagnostic) detail.prepend(fileDiagnosticNotice(diagnostic, () => retryFile(path)));
      }
    }
    if (body) {
      // A refresh keeps the old content usable during its fetch. Preserve any
      // expansion or scrolling the user performed while that work was pending.
      cancelLoading();
      const previousFocus = retainedFocus ?? (body.firstElementChild === detail ? null : holdPanelFocus(body));
      // Replacing even a retained iframe's ancestor reloads its browsing
      // context. Metadata-only refreshes return the still-mounted root.
      if (body.firstElementChild !== detail) body.replaceChildren(detail);
      renderedPanelScope = { store, ref, doc: selected.doc, planning };
      syncContextWebpages();
      contextPanel?.layout();
      // Select a restored view before diagrams begin hydrating. Later user
      // view/mode changes take precedence even when both scroll positions are 0.
      if (restoringView?.contextView) contextPanel?.setView(restoringView.contextView);
      const readingRevision = contextReadingRevision;
      const undisturbed = await renderDiagramsInPlace(body, detail, () => !stale() && body.contains(detail));
      if (stale() || !body.contains(detail)) return;
      const configurationUnchanged = readingRevision === contextReadingRevision;
      if (undisturbed && configurationUnchanged) restorePanelView(body, restoringView);
      if (configurationUnchanged) restorePanelFocus(body, previousFocus);
      updateContextControls();
      contextPanel?.ensureFocus();
      syncNavigationSidebar();
      if (contextPanel && selected.date) {
        // Identity stays usable while a complete count is loading. Replace
        // neither its focused heading nor the live body when the count arrives.
        // Closing cancels work; reopening the same panel resumes it without
        // rerendering the document or starting a second current request.
        const date = selected.date;
        let pendingRevision: number | undefined;
        resumeDateCount = () => {
          const header = detail.querySelector<HTMLElement>('.context-essentials');
          if (!contextPanel?.getState().open || stale() || !body.contains(detail) || !header || header.querySelector('.summary-facts') || pendingRevision === dateCountRevision) return;
          const countRevision = dateCountRevision;
          pendingRevision = countRevision;
          void timelineDateEntryCount(date).then(count => {
            if (count === undefined || stale() || !body.contains(detail)) return;
            const facts = renderContextEssentials({ ...essentials, counts: { entries: count } }, getRenderOpts()).querySelector('.summary-facts');
            if (facts) header.append(facts);
          }).catch(error => {
            // Missing coverage is unknown, never a verified zero. Keep the
            // identity and its navigation available even if counting fails.
            if (countRevision === dateCountRevision && !stale()) console.warn('Could not count entries for the inspected date:', error);
          }).finally(() => { if (pendingRevision === countRevision) pendingRevision = undefined; });
        };
        resumeDateCount();
      }
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
      if (!refreshing) {
        if (contextPanel) {
          const diagnostic = store.diagnosticsFor(failurePath) ?? { path: failurePath, issues: [], error: err instanceof Error ? err.message : String(err) };
          body.replaceChildren(fileDiagnosticNotice(diagnostic, async () => {
            if (stale()) return;
            try { await retryReadableFile(store, failurePath); }
            finally { if (!stale()) { await showSidePanel(undefined, true, false, false); updateDiagnostics(); } }
          }));
        } else body.replaceChildren(retry);
        renderedPanelScope = null;
      }
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
  refreshCalendarActivity(store);
}

// Render the active document as a normal Reader page.
let docLoadGeneration = 0;
async function updateDoc(preserveScroll = false, userInitiated = false) {
  if (contextPanel) {
    const requested = state.doc;
    if (requested) {
      await inspectContext({ ref: requested.kind === 'detail' ? state.filter : null,
        doc: requested.kind === 'detail' ? null : requested }, { history: !preserveScroll, view: preserveScroll ? panelSnapshot() : undefined, focus: userInitiated, routed: true });
      // The URL can identify a context on initial navigation. Its mounted panel
      // now owns that record; leaving it in the old Reader state would let an
      // unrelated refresh reopen the route over a newer inspection.
      if (state.doc === requested) { state.doc = null; returnFlow = null; syncNavigationSidebar(); }
    }
    return;
  }
  const backdrop = $('#doc-backdrop');
  const body = $('#doc-body');
  if (!backdrop || !body) return;

  // Only the latest load for this source, document, and scope may write.
  const generation = ++docLoadGeneration;
  const requested = state.doc;
  const requestedFilter = state.filter;
  const store = state.store!;
  const navigation = navigationGeneration;
  const readerScroll = preserveScroll ? body.scrollTop : (history.state as NavState | null)?.readerScroll ?? 0;
  const sameReader = () => navigation === navigationGeneration && store === state.store
    && sameDoc(state.doc, requested) && sameFilter(state.filter, requestedFilter);
  const stale = () => generation !== docLoadGeneration || !sameReader();

  if (!requested) {
    documentDetails = undefined;
    readerModal?.close();
    syncNavigationSidebar();
    return;
  }

  if (!preserveScroll) body.replaceChildren();
  const cancelLoading = !preserveScroll
    ? showDelayedLoading(body, 'Loading document…', () => !stale()) : () => {};
  if (!preserveScroll || backdrop.hidden) readerModal?.open();

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
    documentDetails = readerDetails(doc);
    syncNavigationSidebar();
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
      if (!sameFilter(state.filter, view.filter) || state.search !== (view.search ?? '') || state.source !== view.source || JSON.stringify(state.range) !== JSON.stringify(view.range) || state.order !== view.order) {
        const applying = applyView({ ...view, doc: null }, { push: false, userInitiated: false });
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
  const route = locationRoute();
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
    if (!sameFilter(state.filter, next.filter) || state.search !== (next.search ?? '') || state.source !== next.source || JSON.stringify(state.range) !== JSON.stringify(next.range) || state.order !== next.order) {
      const applying = applyView({ ...next, doc: null }, { push: false, panel: nav?.panel });
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
  if (sameFilter(state.filter, next.filter) && sameDoc(state.doc, next.doc) && state.search === (next.search ?? '') && state.source === next.source && JSON.stringify(state.range) === JSON.stringify(next.range) && state.order === next.order) {
    returnFlow = next.doc ? nav?.returnFlow ?? returnFlow : null;
    updateFilterPill(); updateSourcePill(); updateFlowSearch(); syncNavigationSidebar();
    if (nav?.anchor) restoreFlowScroll(nav.anchor);
    if (next.doc && nav?.readerScroll !== undefined) {
      const body = $('#doc-body'); if (body) body.scrollTop = nav.readerScroll;
    }
    if (nav?.panel !== undefined) await showSidePanel(nav.panel, false, true);
    return;
  }
  // The destination's own last-seen anchor and panel state restore the view as
  // it was left; entries without them (hand-edited hashes, history from before
  // a reload) fall back to a top-of-panel, time-cursor render.
  await applyView(next, { push: false, anchor: nav?.anchor, panel: nav?.panel });
}

document.addEventListener('DOMContentLoaded', init);

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || activeModal()) return;
  const focused = document.activeElement;
  const editing = focused instanceof HTMLElement && (focused.isContentEditable || focused.matches('input, textarea, select'));
  if (e.key === '/' && state.searchShortcutEnabled && !editing && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const searchInput = $<HTMLInputElement>('.search-input');
    if (searchInput && !searchInput.disabled && (navigationSidebar || !searchInput.closest('[hidden], [inert]'))) {
      e.preventDefault();
      if (navigationSidebar) navigationSidebar.openSearch(); else searchInput.focus();
    }
  }
  if (e.key === 'Escape') {
    searchUi.cancelPendingSearch();
    if (searchUi.isSearchVisible()) {
      e.preventDefault();
      setSearchVisible(false);
      return;
    }
    // A document returns to its flow. Escape never changes browsing filters.
    if (state.doc) {
      closeDoc();
      return;
    }
  }
});

document.addEventListener('copy', (e) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  if (range.collapsed) return;
  // Selecting only the visible label omits its enclosing anchor from
  // cloneContents(). Restore complete smart elements to their authored form;
  // partial label selections keep the browser's ordinary copy behavior.
  const ancestor = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const locationChip = ancestor?.closest<HTMLElement>('.inline-tag-location[data-location-handle]');
  const locationLabel = locationChip?.querySelector('.location-label');
  if (locationLabel && locationLabel.contains(range.startContainer) && locationLabel.contains(range.endContainer)
      && range.toString() === locationLabel.textContent) {
    e.clipboardData!.setData('text/plain', locationCopyText(locationChip!)!);
    e.preventDefault();
    return;
  }
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
    const location = locationCopyText(tag as HTMLElement);
    if (location !== null) {
      tag.replaceWith(location);
      continue;
    }
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
