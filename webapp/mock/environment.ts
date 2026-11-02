import type { MockAction, Scenario } from './scenarios';
import { settlePreview } from './settle';
import { preserveSessionNavigation } from './session-navigation';
import { deferPreviewFocus } from './preview-focus';

export interface MockConfig { id: string; scenario: Scenario; theme?: 'light' | 'dark' }
const preferences = ['darkMode', 'timeFormat', 'dateFormat', 'timeStyle', 'expandProjects', 'expandActions', 'searchShortcutEnabled', 'panelCollapsed', 'panelWidth', 'animSpeed'] as const;
let stagingRevision = 0;
let activatePreview: () => Promise<void> = async () => {};

function isolateStorage(): void {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key: string) { return values.get(String(key)) ?? null; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    removeItem(key: string) { values.delete(String(key)); },
    setItem(key: string, value: string) { values.set(String(key), String(value)); },
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
}

/** Freeze wall time only in the mock app frame; preserve date construction and parsing. */
function freezeClock(now: string): void {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error('The mock scenario has an invalid clock.');
  const NativeDate = globalThis.Date;
  globalThis.Date = new Proxy(NativeDate, {
    construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [timestamp], newTarget); },
    apply() { return new NativeDate(timestamp).toString(); },
    get(target, property, receiver) { return property === 'now' ? () => timestamp : Reflect.get(target, property, receiver); },
  });
}

function visible(element: HTMLElement): boolean {
  return !element.hidden && !element.closest('[hidden]') && getComputedStyle(element).display !== 'none' && element.getClientRects().length > 0;
}

async function waitFor(selector: string, timeout = 15_000): Promise<HTMLElement> {
  const deadline = performance.now() + timeout;
  do {
    const element = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(visible);
    if (element) return element;
    await new Promise<void>(resolve => setTimeout(resolve, 40));
  } while (performance.now() < deadline);
  throw new Error(`Scenario did not reach ${selector}`);
}

async function perform(action: MockAction): Promise<void> {
  const element = await waitFor(action.selector);
  if (action.kind === 'wait') return;
  if (action.kind === 'click') { element.click(); return; }
  if (action.kind === 'focus') {
    // A focus-dependent state needs real focus, so reveal its settled base
    // page before the action rather than focusing an invisible control.
    await settlePreview(element);
    await activatePreview();
    element.focus(); return;
  }
  if (action.kind === 'hover') { element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return; }
  if (action.kind === 'key') {
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: action.value ?? 'Enter', bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key: action.value ?? 'Enter', bubbles: true }));
    return;
  }
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    throw new Error(`The input action requires a form field: ${action.selector}`);
  }
  element.focus();
  element.value = action.value ?? '';
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function stage(session: MockConfig): Promise<void> {
  const revision = ++stagingRevision;
  try {
    // App init is a later DOMContentLoaded listener. Waiting one task allows it
    // to attach its handlers; selectors then follow real asynchronous rendering.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (session.scenario.actions?.length && session.scenario.route !== '/') await settlePreview(await waitFor('#flow .entry-card'));
    for (const action of session.scenario.actions ?? []) await perform(action);
    if (session.scenario.ready) await settlePreview(await waitFor(session.scenario.ready));
    if (revision !== stagingRevision) return;
    document.documentElement.dataset.mockReady = session.scenario.id;
    window.parent.postMessage({ type: 'aside:mock:ready', session: session.id, scenario: session.scenario.id }, location.origin);
  } catch (error) {
    if (revision !== stagingRevision) return;
    const message = error instanceof Error ? error.message : String(error);
    document.documentElement.dataset.mockError = message;
    window.parent.postMessage({ type: 'aside:mock:error', session: session.id, message }, location.origin);
    console.error('Mock scenario staging failed:', error);
  }
}

async function recover(session: MockConfig): Promise<void> {
  stagingRevision++;
  localStorage.setItem('aside.webToken', `mock:${session.id}`);
  window.dispatchEvent(new StorageEvent('storage', { key: 'aside.webToken' }));
  window.dispatchEvent(new Event('focus'));
  // These are ordinary app retry controls. No application state is exported
  // or rewritten by the gallery, including during recovery demonstrations.
  const retries = ['#btn-retry-instances', '#flow .notice-action', '#doc-body .notice-action', '.search-index-progress .history-retry', '#connection-status'];
  for (const selector of retries) {
    const button = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(visible);
    button?.click();
  }
  window.parent.postMessage({ type: 'aside:mock:recovered', session: session.id }, location.origin);
}

/** Called by the mock HTML shell before importing the unchanged production app. */
export async function bootstrap(config?: MockConfig): Promise<void> {
  const id = new URL(location.href).searchParams.get('mockSession');
  if (!id) throw new Error('A mock session is required. Open the scenario gallery at /__mock/.');
  const nativeFetch = window.fetch.bind(window);
  let session = config;
  if (!session) {
    const response = await nativeFetch(`/__mock/session/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('The mock session is unavailable. Reset this preview in the gallery.');
    session = await response.json() as MockConfig;
  }
  if (session.id !== id || !session.scenario) throw new Error('The mock server returned an invalid session.');

  isolateStorage();
  preserveSessionNavigation(id);
  if (window.parent !== window) {
    const releaseFocus = deferPreviewFocus();
    let active = false;
    const activated = new Promise<void>(resolve => {
      const onActivate = (event: MessageEvent) => {
        if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'aside:mock:activated' || event.data?.session !== id) return;
        window.removeEventListener('message', onActivate);
        active = true; releaseFocus(); resolve();
      };
      window.addEventListener('message', onActivate);
    });
    activatePreview = () => {
      if (!active) window.parent.postMessage({ type: 'aside:mock:activate', session: id }, location.origin);
      return activated;
    };
  }
  for (const key of preferences) localStorage.removeItem(key);
  const defaults = { darkMode: String(session.theme === 'dark'), panelCollapsed: 'false' };
  for (const [key, value] of Object.entries({ ...defaults, ...session.scenario.preferences })) localStorage.setItem(key, value);
  if (session.scenario.faults?.auth === 'required') localStorage.removeItem('aside.webToken');
  else localStorage.setItem('aside.webToken', `mock:${id}`);
  freezeClock(session.scenario.now);

  window.fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin) return nativeFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set('X-Aside-Mock-Session', id);
    return nativeFetch(input, { ...init, headers });
  };

  const currentSession = session;
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === window.parent && event.data?.type === 'aside:mock:recover' && event.data?.session === id) void recover(currentSession);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void stage(session); }, { once: true });
  else void stage(session);
}
