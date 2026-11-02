import type { Scenario } from '../scenarios';
import { catalogue as catalogueTree, filterCatalogue, type CatalogueNode } from './catalogue';

type Theme = 'light' | 'dark';
type Viewport = 'desktop' | 'tablet' | 'mobile';
interface Session { id: string; url: string; scenario: Scenario | string }
const viewportWidths = { tablet: 768, mobile: 390 };
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Gallery element is missing: ${selector}`);
  return element;
};
let scenarios: Scenario[] = [];
let navigationOrder: Scenario[] = [];
let selected: Scenario;
let session: Session | undefined;
let generation = 0;
let frame: HTMLIFrameElement | undefined;
let pendingFrame: HTMLIFrameElement | undefined;
let request: AbortController | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
const initial = new URL(location.href).searchParams;
let appTheme: Theme = initial.get('theme') === 'dark' ? 'dark' : 'light';
let viewport: Viewport = initial.get('viewport') === 'tablet' ? 'tablet' : initial.get('viewport') === 'mobile' ? 'mobile' : 'desktop';
const narrowWindow = window.matchMedia('(max-width: 700px)');
let sidebarCollapsed = narrowWindow.matches || localStorage.getItem('aside.mock.sidebarCollapsed') === 'true';
const expandedBranches = new Set<string>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem('aside.mock.expandedPages') ?? '[]');
  if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') expandedBranches.add(id);
} catch { /* A stale browser preference does not prevent opening previews. */ }

function scenarioIds(nodes: readonly CatalogueNode[]): string[] {
  return nodes.flatMap(node => 'children' in node ? scenarioIds(node.children) : [node.scenarioId]);
}

function revealScenario(nodes: readonly CatalogueNode[], id: string): boolean {
  let found = false;
  for (const node of nodes) {
    if ('children' in node) {
      if (revealScenario(node.children, id)) { expandedBranches.add(node.id); found = true; }
    } else if (node.scenarioId === id) found = true;
  }
  return found;
}

function setStatus(state: 'loading' | 'ready' | 'error', message: string): void {
  const host = $('#preview-state');
  host.dataset.state = state;
  host.textContent = message;
  $('#preview-stage').setAttribute('aria-busy', String(state === 'loading'));
  $<HTMLButtonElement>('#btn-recover').disabled = state !== 'ready';
  $('#preview-start').hidden = state !== 'loading';
}

function shareUrl(): string {
  const url = new URL('/__mock/', location.origin);
  url.searchParams.set('scenario', selected.id);
  url.searchParams.set('theme', appTheme);
  url.searchParams.set('viewport', viewport);
  return url.href;
}

function updateUrl(): void { history.replaceState({ scenario: selected.id }, '', shareUrl()); }

function fitPreview(): void {
  const stage = $('#preview-stage');
  const width = viewport === 'desktop' ? stage.clientWidth : viewportWidths[viewport];
  const height = stage.clientHeight;
  const preview = $('#preview-viewport');
  preview.style.width = `${width}px`;
  preview.style.height = `${height}px`;
  stage.dataset.viewport = viewport;
  for (const previewFrame of [frame, pendingFrame]) {
    if (!previewFrame) continue;
    previewFrame.width = String(width); previewFrame.height = String(height);
  }
  $<HTMLSelectElement>('#viewport').value = viewport;
}

function updateSidebar(): void {
  const sidebar = $('#scenario-catalogue');
  const restoreFocus = sidebar.contains(document.activeElement);
  const drawerOpen = narrowWindow.matches && !sidebarCollapsed;
  $('.workspace').inert = drawerOpen;
  document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  sidebar.hidden = sidebarCollapsed;
  $('#sidebar-scrim').hidden = !drawerOpen;
  if (drawerOpen) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
  else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); }
  const toggle = $('#btn-sidebar');
  toggle.setAttribute('aria-expanded', String(!sidebarCollapsed));
  toggle.setAttribute('aria-label', sidebarCollapsed ? 'Show previews' : 'Hide previews');
  toggle.title = sidebarCollapsed ? 'Show previews' : 'Hide previews';
  if (sidebarCollapsed && restoreFocus) toggle.focus();
  else if (drawerOpen && !sidebar.contains(document.activeElement)) $<HTMLInputElement>('#scenario-filter').focus();
}

function toggleSidebar(): void {
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem('aside.mock.sidebarCollapsed', String(sidebarCollapsed));
  updateSidebar();
}

function updateTheme(): void {
  document.documentElement.dataset.theme = appTheme;
  const toggle = $('#btn-theme');
  const label = appTheme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
}

function renderCatalogue(): void {
  const query = $<HTMLInputElement>('#scenario-filter').value.trim().toLowerCase();
  const visible = filterCatalogue(catalogueTree, query, scenarios);
  const list = $('#scenario-list');
  const restoreFocus = list.contains(document.activeElement);
  const scrollTop = list.scrollTop;
  const byId = new Map(scenarios.map(item => [item.id, item]));
  const render = (nodes: readonly CatalogueNode[], parents: string[] = []): HTMLUListElement => {
    const children = document.createElement('ul'); children.className = 'catalogue-children';
    for (const node of nodes) {
      const row = document.createElement('li');
      children.append(row);
      if ('children' in node) {
        const details = document.createElement('details'); details.className = 'catalogue-branch'; details.dataset.branch = node.id;
        details.open = !!query || expandedBranches.has(node.id);
        if (scenarioIds(node.children).includes(selected.id)) details.classList.add('has-current');
        const summary = document.createElement('summary'); summary.textContent = node.label;
        details.append(summary, render(node.children, [...parents, node.label]));
        details.addEventListener('toggle', () => {
          if (!details.isConnected || query) return;
          if (details.open) expandedBranches.add(node.id); else expandedBranches.delete(node.id);
          localStorage.setItem('aside.mock.expandedPages', JSON.stringify([...expandedBranches]));
        });
        row.append(details);
        continue;
      }
      const item = byId.get(node.scenarioId);
      if (!item) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'scenario-item'; button.dataset.scenario = item.id;
      if (selected?.id === item.id) button.setAttribute('aria-current', 'page');
      button.title = item.description;
      button.textContent = node.label;
      button.setAttribute('aria-label', [...parents, node.label].join(' / '));
      button.addEventListener('click', () => { void selectScenario(item); });
      row.append(button);
    }
    return children;
  };
  list.replaceChildren(render(visible));
  if (!visible.length) { const empty = document.createElement('p'); empty.className = 'catalogue-empty'; empty.textContent = 'No previews match. Try a page or state.'; list.append(empty); }
  list.scrollTop = scrollTop;
  if (restoreFocus && !sidebarCollapsed) list.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true });
}

function updateHeading(): void {
  $('#scenario-title').textContent = selected.label;
  $('#scenario-title').title = selected.description;
  $('#btn-recover').hidden = !selected.faults || !Object.keys(selected.faults).length;
  const index = navigationOrder.indexOf(selected);
  $<HTMLButtonElement>('#btn-previous').disabled = index === 0;
  $<HTMLButtonElement>('#btn-next').disabled = index === navigationOrder.length - 1;
  document.title = `${selected.label} · Aside interface gallery`;
}

async function selectScenario(item: Scenario): Promise<void> {
  selected = item;
  revealScenario(catalogueTree, item.id);
  if (narrowWindow.matches) { sidebarCollapsed = true; updateSidebar(); }
  updateHeading(); renderCatalogue(); updateUrl();
  await loadPreview();
}

async function loadPreview(): Promise<void> {
  const current = ++generation;
  request?.abort(); request = new AbortController();
  clearTimeout(statusTimer);
  pendingFrame?.remove(); pendingFrame = undefined;
  session = undefined;
  $('#btn-recover').hidden = !selected.faults || !Object.keys(selected.faults).length;
  setStatus('loading', 'Loading preview…');
  $('#gallery-error').hidden = true;
  const openPreview = $('#open-preview');
  openPreview.classList.add('loading-disabled');
  openPreview.removeAttribute('href');
  openPreview.setAttribute('aria-disabled', 'true');
  openPreview.tabIndex = -1;
  updateTheme();
  try {
    const response = await fetch('/__mock/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: selected.id, theme: appTheme }), signal: request.signal });
    if (!response.ok) throw new Error(`Could not create the preview (${response.status}).`);
    const value = await response.json() as Session;
    if (!value.id || !value.url) throw new Error('The mock server returned an invalid preview.');
    if (current !== generation) return;
    session = value;
    pendingFrame = document.createElement('iframe'); pendingFrame.title = `${selected.label} — live Aside interface`;
    pendingFrame.dataset.session = value.id;
    pendingFrame.className = 'is-staging';
    pendingFrame.tabIndex = -1;
    pendingFrame.setAttribute('aria-hidden', 'true');
    fitPreview();
    pendingFrame.src = value.url;
    $('#preview-viewport').append(pendingFrame);
    statusTimer = setTimeout(() => {
      if (current === generation && $('#preview-state').dataset.state === 'loading') {
        pendingFrame?.remove(); pendingFrame = undefined;
        const message = 'Preview is taking longer than expected. Reset to retry.';
        setStatus('error', message);
        $('#gallery-error').textContent = message; $('#gallery-error').hidden = false;
      }
    }, 22_000);
  } catch (error) {
    if (current !== generation || request.signal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    $('#preview-start').hidden = true;
    setStatus('error', 'Preview unavailable');
    $('#gallery-error').textContent = message; $('#gallery-error').hidden = false;
  }
}

function move(direction: number): void {
  const next = navigationOrder[navigationOrder.indexOf(selected) + direction];
  if (next) void selectScenario(next);
}

async function copyLink(): Promise<void> {
  const button = $('#btn-copy');
  try {
    await navigator.clipboard.writeText(shareUrl());
    button.setAttribute('aria-label', 'Link copied'); button.title = 'Link copied';
    setTimeout(() => { button.setAttribute('aria-label', 'Copy preview link'); button.title = 'Copy preview link'; }, 1800);
  } catch {
    const field = document.createElement('input'); field.value = shareUrl(); field.className = 'copy-fallback';
    field.setAttribute('aria-label', 'Scenario link to copy');
    const error = $('#gallery-error'); error.textContent = 'Copy this scenario link: '; error.append(field); error.hidden = false;
    field.focus(); field.select();
  }
}

async function recoverPreview(): Promise<void> {
  if (!session || !frame || pendingFrame) return;
  const current = session;
  setStatus('loading', 'Restoring the connection and retrying…');
  try {
    const response = await fetch(`/__mock/session/${encodeURIComponent(current.id)}/recover`, { method: 'POST' });
    if (!response.ok) throw new Error('The simulated fault could not be cleared.');
    if (session !== current) return;
    frame.contentWindow?.postMessage({ type: 'aside:mock:recover', session: current.id }, location.origin);
    $('#btn-recover').hidden = true;
  } catch (error) {
    if (session !== current) return;
    setStatus('error', error instanceof Error ? error.message : String(error));
  }
}

function revealPreview(): void {
  if (!session) return;
  if (pendingFrame) {
    frame?.remove();
    frame = pendingFrame; pendingFrame = undefined;
    frame.classList.remove('is-staging');
    frame.removeAttribute('tabindex'); frame.removeAttribute('aria-hidden');
    const openPreview = $<HTMLAnchorElement>('#open-preview');
    openPreview.href = session.url;
    openPreview.classList.remove('loading-disabled');
    openPreview.removeAttribute('aria-disabled');
    openPreview.removeAttribute('tabindex');
  }
  // A native reload keeps the iframe but bootstraps a fresh document.
  frame?.contentWindow?.postMessage({ type: 'aside:mock:activated', session: session.id }, location.origin);
}

window.addEventListener('message', event => {
  if (event.origin !== location.origin || !session || event.data?.session !== session.id) return;
  const sender = pendingFrame ?? frame;
  if (event.source !== sender?.contentWindow) return;
  if (event.data.type === 'aside:mock:activate') { revealPreview(); return; }
  if (event.data.type === 'aside:mock:ready' || event.data.type === 'aside:mock:recovered') {
    revealPreview();
    clearTimeout(statusTimer); $('#preview-start').hidden = true;
    $('#gallery-error').hidden = true;
    setStatus('ready', event.data.type === 'aside:mock:recovered' ? 'Preview recovered' : 'Preview ready');
  } else if (event.data.type === 'aside:mock:error') {
    pendingFrame?.remove(); pendingFrame = undefined;
    clearTimeout(statusTimer); $('#preview-start').hidden = true;
    setStatus('error', 'Preview setup could not finish');
    $('#gallery-error').textContent = String(event.data.message ?? 'The scenario did not reach its initial state.'); $('#gallery-error').hidden = false;
  }
});

$('#scenario-filter').addEventListener('input', renderCatalogue);
$('#btn-previous').addEventListener('click', () => move(-1));
$('#btn-next').addEventListener('click', () => move(1));
$('#btn-reset').addEventListener('click', () => { void loadPreview(); });
$('#btn-recover').addEventListener('click', () => { void recoverPreview(); });
$('#btn-copy').addEventListener('click', () => { void copyLink(); });
$('#viewport').addEventListener('change', () => {
  viewport = $<HTMLSelectElement>('#viewport').value as Viewport; fitPreview(); updateUrl();
});
$('#btn-theme').addEventListener('click', () => {
  appTheme = appTheme === 'light' ? 'dark' : 'light'; updateUrl(); void loadPreview();
});
$('#btn-sidebar').addEventListener('click', toggleSidebar);
$('#sidebar-scrim').addEventListener('click', toggleSidebar);
narrowWindow.addEventListener('change', () => { if (narrowWindow.matches) sidebarCollapsed = true; updateSidebar(); });
updateSidebar();
document.addEventListener('keydown', event => {
  if (narrowWindow.matches && !sidebarCollapsed) {
    if (event.key === 'Escape') { event.preventDefault(); sidebarCollapsed = true; updateSidebar(); $('#btn-sidebar').focus(); return; }
    if (event.key === 'Tab') {
      const controls = Array.from($('#scenario-catalogue').querySelectorAll<HTMLElement>('a[href], button, input, summary'))
        .filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  if (event.key === '/' && !event.metaKey && !event.ctrlKey) {
    event.preventDefault(); sidebarCollapsed = false; updateSidebar(); $<HTMLInputElement>('#scenario-filter').focus();
  }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
  if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); move(1); }
});
window.addEventListener('popstate', () => {
  const params = new URL(location.href).searchParams;
  const item = scenarios.find(candidate => candidate.id === params.get('scenario'));
  if (item) {
    appTheme = params.get('theme') === 'dark' ? 'dark' : 'light';
    viewport = params.get('viewport') === 'tablet' ? 'tablet' : params.get('viewport') === 'mobile' ? 'mobile' : 'desktop';
    void selectScenario(item);
  }
});
new ResizeObserver(fitPreview).observe($('#preview-stage'));

try {
  const response = await fetch('/__mock/scenarios', { cache: 'no-store' });
  if (!response.ok) throw new Error('The scenario catalogue could not be loaded.');
  scenarios = await response.json() as Scenario[];
  if (!Array.isArray(scenarios) || !scenarios.length) throw new Error('The scenario catalogue is empty.');
  const byId = new Map(scenarios.map(item => [item.id, item]));
  navigationOrder = scenarioIds(catalogueTree).flatMap(id => byId.get(id) ?? []);
  selected = scenarios.find(item => item.id === initial.get('scenario')) ?? scenarios[0];
  await selectScenario(selected);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  $('#preview-start').hidden = true; setStatus('error', 'Gallery unavailable');
  $('#gallery-error').textContent = message; $('#gallery-error').hidden = false;
}
