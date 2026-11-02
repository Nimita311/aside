export const WEB_TOKEN_KEY = 'aside.webToken';
export const RECONNECT_GUIDANCE = 'To reconnect, run aside show or ask your agent to show this in Aside.';
export type AuthState = 'checking' | 'authorized' | 'required' | 'offline';

export class AuthenticationRequiredError extends Error {
  constructor() { super(RECONNECT_GUIDANCE); this.name = 'AuthenticationRequiredError'; }
}

let token: string | null = null;
let expiresAt: number | undefined;
let expirationTimer: ReturnType<typeof setTimeout> | undefined;
let session = new AbortController();
let state: AuthState = 'checking';
let revision = 0;
const listeners = new Set<(state: AuthState) => void>();
const streams = new Set<() => void>();

function savedToken(): string | null { return localStorage.getItem(WEB_TOKEN_KEY); }
function publish(next: AuthState): void { state = next; for (const listener of listeners) listener(next); }
function stopProtectedRequests(): void {
  session.abort(); session = new AbortController();
  for (const stop of [...streams]) stop();
  clearTimeout(expirationTimer); expirationTimer = undefined;
}

function requireAuthentication(expected: string | null = token): void {
  // A response from the old session must not revoke a newer handoff.
  if (savedToken() !== expected) return;
  stopProtectedRequests(); expiresAt = undefined;
  if (expected) localStorage.removeItem(WEB_TOKEN_KEY);
  token = null;
  publish('required');
}

function authenticationDeadline(value: unknown): number {
  const deadline = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(deadline)) throw new Error('Aside returned an invalid authentication deadline.');
  return deadline;
}

function updateExpiration(value: unknown, expected: string): void {
  if (savedToken() !== expected || token !== expected) return;
  const deadline = authenticationDeadline(value);
  // Multiple streams can deliver an older heartbeat after a renewal.
  expiresAt = Math.max(expiresAt ?? deadline, deadline);
  clearTimeout(expirationTimer);
  const check = () => {
    if (token !== expected || savedToken() !== expected || expiresAt === undefined) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) void checkAuthorization();
    else expirationTimer = setTimeout(check, Math.min(remaining, 2_147_483_647));
  };
  check();
}

/** Only the app's own origin may receive its browser credential. */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const current = savedToken();
  if (!current) {
    requireAuthentication(current);
    throw new AuthenticationRequiredError();
  }
  if (current === token && expiresAt !== undefined && expiresAt <= Date.now()) {
    void checkAuthorization();
    throw new AuthenticationRequiredError();
  }
  const origin = typeof window === 'undefined' ? 'http://localhost:24800' : window.location.origin;
  if (new URL(url, origin).origin !== origin) throw new Error('Aside credentials cannot be sent to another origin.');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${current}`);
  const signal = init.signal ? AbortSignal.any([init.signal, session.signal]) : session.signal;
  const response = await fetch(url, { ...init, headers, signal });
  if (response.status === 401) {
    requireAuthentication(current);
    throw new AuthenticationRequiredError();
  }
  return response;
}

// A disconnected tab can miss another tab's renewal. Hide private content and
// verify with the daemon before deleting a token on a locally inferred expiry.
async function checkAuthorization(): Promise<void> {
  const generation = ++revision;
  stopProtectedRequests();
  token = savedToken(); expiresAt = undefined;
  if (!token) { publish('required'); return; }
  const expected = token;
  publish('checking');
  try {
    const response = await authFetch('/-/api/auth', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not check Aside access (${response.status}).`);
    const value = await response.json();
    if (generation !== revision || savedToken() !== expected) return;
    const deadline = authenticationDeadline(value.expiresAt);
    if (deadline <= Date.now()) { requireAuthentication(expected); return; }
    updateExpiration(deadline, expected);
    if (token === expected) publish('authorized');
  } catch (error) {
    if (generation !== revision || savedToken() !== expected || error instanceof AuthenticationRequiredError) return;
    publish('offline');
  }
}

/** Check stored credentials before opening protected views; storage handoffs reload them. */
export function initializeAuth(onState: (state: AuthState) => void): () => void {
  listeners.add(onState);
  const changed = (event: StorageEvent) => {
    if (event.key === WEB_TOKEN_KEY || event.key === null) void checkAuthorization();
  };
  const focused = () => {
    if (savedToken() !== token || state === 'offline' || (expiresAt !== undefined && expiresAt <= Date.now())) void checkAuthorization();
  };
  window.addEventListener('storage', changed);
  window.addEventListener('focus', focused);
  void checkAuthorization();
  return () => {
    listeners.delete(onState);
    window.removeEventListener('storage', changed); window.removeEventListener('focus', focused);
    if (!listeners.size) { revision++; stopProtectedRequests(); }
  };
}

interface EventHandlers {
  message(data: string): void;
  connection?(connected: boolean, retrying?: boolean): void;
}

/** Fetch-based SSE keeps the bearer out of URLs and stops reconnecting on expiry. */
export function connectAuthenticatedEvents(endpoint: string, handlers: EventHandlers): () => void {
  let active = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let backoff = 1_000;
  const stop = () => {
    active = false; clearTimeout(retry); controller?.abort(); streams.delete(stop);
  };
  streams.add(stop);
  const connect = async () => {
    controller = new AbortController();
    const expected = savedToken();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await authFetch(endpoint, { cache: 'no-store', headers: { Accept: 'text/event-stream' }, signal: controller.signal });
      if (!response.ok || !response.body || !response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
        throw new Error('Aside event stream is unavailable.');
      }
      if (!active) { await response.body.cancel().catch(() => {}); return; }
      backoff = 1_000; handlers.connection?.(true);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', event = '', data: string[] = [], eventBytes = 0;
      const dispatch = () => {
        if (!active) return;
        if (event === 'auth-expired') { requireAuthentication(expected); return; }
        if (event === 'auth' && expected) {
          updateExpiration(JSON.parse(data.join('\n')).expiresAt, expected);
        } else if ((!event || event === 'message') && data.length) handlers.message(data.join('\n'));
        event = ''; data = []; eventBytes = 0;
      };
      while (active) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error('Aside event stream message is too large.');
        let newline: number;
        while (active && (newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
          if (!line) dispatch();
          else if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
          else if (line.startsWith('data:')) {
            eventBytes += line.length;
            if (eventBytes > 1024 * 1024) throw new Error('Aside event stream message is too large.');
            data.push(line.slice(5).replace(/^ /, ''));
          }
        }
      }
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) { stop(); handlers.connection?.(false, false); }
    } finally { await reader?.cancel().catch(() => {}); }
    if (!active) return;
    handlers.connection?.(false, true);
    retry = setTimeout(() => { void connect(); }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  void connect();
  return stop;
}
