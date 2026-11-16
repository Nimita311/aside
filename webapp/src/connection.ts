export class DeploymentAccessError extends Error {
  constructor() { super('Access denied by deployment. Sign in and reload Aside.'); }
}

/** Internal webapp requests use only the current origin and its deployment session. */
export async function webFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const origin = typeof window === 'undefined' ? 'http://localhost:24800' : window.location.origin;
  if (new URL(url, origin).origin !== origin) throw new Error('Aside requests must use the current origin.');
  const response = await fetch(url, { ...init, credentials: 'same-origin', redirect: 'error' });
  if (response.status === 401 || response.status === 403) throw new DeploymentAccessError();
  return response;
}

interface EventHandlers {
  message(data: string): void;
  connection?(connected: boolean, retrying?: boolean): void;
}

/** Fetch-based SSE uses the same deployment credentials as ordinary requests. */
export function connectEvents(endpoint: string, handlers: EventHandlers): () => void {
  let active = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let backoff = 1_000;
  const stop = () => {
    active = false; clearTimeout(retry); controller?.abort();
  };
  const connect = async () => {
    controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await webFetch(endpoint, { cache: 'no-store', headers: { Accept: 'text/event-stream' }, signal: controller.signal });
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
        if ((!event || event === 'message') && data.length) handlers.message(data.join('\n'));
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
      if (error instanceof DeploymentAccessError) { stop(); handlers.connection?.(false, false); }
    } finally { await reader?.cancel().catch(() => {}); }
    if (!active) return;
    handlers.connection?.(false, true);
    retry = setTimeout(() => { void connect(); }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  void connect();
  return stop;
}
