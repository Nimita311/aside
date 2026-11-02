import { validWebQueryRequest, webQueryBytes, WEB_QUERY_MAX_BYTES, type WebQueryRequest, type WebQueryResult } from '../../cli/src/core/web-query';
import { IFRAME_CONNECT, IFRAME_TOKEN, type HostMessage } from './iframe-protocol';
import { webpageSource } from './webpage';

interface QueryContext {
  instance: string;
  fileUrl(path: string): string | null;
  isCurrent(): boolean;
  query(request: WebQueryRequest, signal: AbortSignal): Promise<WebQueryResult>;
}
interface Connection {
  frame: HTMLIFrameElement;
  context: QueryContext;
  token: string;
  src: string;
  used: boolean;
  revoked: boolean;
  epoch: number;
  loaded: boolean;
  port?: MessagePort;
  pending: Map<number, AbortController>;
  load(): void;
}

export function createIframeQueryBridge(host: Window = window) {
  const connections = new Map<HTMLIFrameElement, Connection>();
  // Rendering can discard a prepared view before mounting it. Keep those
  // frames weakly registered instead of retaining the discarded document.
  const prepared = new WeakMap<HTMLIFrameElement, Connection>();
  let epoch = 0;
  let inFlight = 0;
  const current = (entry: Connection) => !entry.revoked && entry.epoch === epoch && entry.context.isCurrent() && entry.frame.isConnected
    && !entry.frame.closest('[hidden], [inert]') && entry.frame.src === entry.src
    && entry.frame.getAttribute('sandbox') === 'allow-scripts' && !entry.frame.hasAttribute('srcdoc');
  const send = (entry: Connection, message: HostMessage) => { try { entry.port?.postMessage(message); } catch { /* The document may have gone away. */ } };
  const revoke = (entry: Connection) => {
    entry.revoked = true;
    connections.delete(entry.frame); entry.frame.removeEventListener('load', entry.load);
    send(entry, { type: 'closed', message: 'The webpage query connection was closed. Reopen the preview to reconnect.' });
    entry.port?.close();
    for (const controller of entry.pending.values()) controller.abort();
    entry.pending.clear();
  };
  const receive = (entry: Connection, value: unknown) => {
    if (!current(entry)) { revoke(entry); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { revoke(entry); return; }
    const message = value as Record<string, unknown>;
    if (message.type === 'close') { revoke(entry); return; }
    const id = message.id;
    if (!Number.isSafeInteger(id) || (id as number) < 1) { revoke(entry); return; }
    if (message.type === 'cancel') { entry.pending.get(id as number)?.abort(); return; }
    if (message.type !== 'query' || Object.keys(message).some(key => !['type', 'id', 'request'].includes(key))
      || entry.pending.has(id as number)) { revoke(entry); return; }
    try {
      if (!validWebQueryRequest(message.request) || webQueryBytes(message.request) > WEB_QUERY_MAX_BYTES) {
        send(entry, { type: 'error', id: id as number, message: 'Invalid or oversized GraphQL request.' }); return;
      }
    } catch { send(entry, { type: 'error', id: id as number, message: 'Invalid GraphQL request.' }); return; }
    if (entry.pending.size >= 4 || inFlight >= 8) {
      send(entry, { type: 'error', id: id as number, message: 'Too many pending queries. Wait for a query to finish.' }); return;
    }
    const controller = new AbortController();
    entry.pending.set(id as number, controller); inFlight++;
    void Promise.resolve().then(() => {
      if (controller.signal.aborted || connections.get(entry.frame) !== entry || !current(entry)) throw new Error('The query connection was closed.');
      return entry.context.query(message.request as WebQueryRequest, controller.signal);
    }).then(result => {
      if (connections.get(entry.frame) === entry && current(entry) && !controller.signal.aborted) send(entry, { type: 'result', id: id as number, result });
    }, error => {
      if (connections.get(entry.frame) === entry && current(entry) && !controller.signal.aborted) {
        send(entry, { type: 'error', id: id as number, message: error instanceof Error ? error.message : 'GraphQL request failed.' });
      }
    }).finally(() => { inFlight--; entry.pending.delete(id as number); });
  };
  const connect = (event: MessageEvent) => {
    if (event.data?.type !== IFRAME_CONNECT) return;
    const port = event.ports[0];
    const frame = event.source && Array.from(host.document.querySelectorAll('iframe')).find(value => value.contentWindow === event.source);
    const entry = frame && prepared.get(frame);
    if (!port || event.ports.length !== 1 || !entry || entry.used || !current(entry)
      || event.origin !== 'null' || event.data.version !== 1 || event.data.token !== entry.token
      || Object.keys(event.data).some(key => !['type', 'version', 'token'].includes(key))) {
      for (const rejected of event.ports) rejected.close(); return;
    }
    // The iframe transfers its own port: a queued handshake can never send
    // query access into a replacement document through its WindowProxy.
    entry.used = true; entry.port = port; connections.set(entry.frame, entry);
    port.onmessage = message => receive(entry, message.data);
    port.onmessageerror = () => revoke(entry);
    port.start(); send(entry, { type: 'ready' });
  };
  host.addEventListener('message', connect);
  const observer = new MutationObserver(() => {
    for (const frame of host.document.querySelectorAll('iframe')) {
      const entry = prepared.get(frame);
      if (entry && !entry.revoked && entry.epoch === epoch) connections.set(frame, entry);
    }
    for (const entry of connections.values()) {
      if (!current(entry)) revoke(entry);
    }
  });
  observer.observe(host.document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcdoc', 'sandbox', 'hidden', 'inert'] });
  return {
    register(frame: HTMLIFrameElement, context: QueryContext): boolean {
      const source = webpageSource(frame);
      if (!source?.artifactId || !source.path || !/\.html?$/i.test(source.path) || frame.hasAttribute('srcdoc')) return false;
      const url = new URL(frame.src, host.location.href);
      const expected = context.fileUrl(source.path);
      if (!expected) return false;
      const file = new URL(expected, host.location.href);
      if (url.origin !== host.location.origin || file.origin !== host.location.origin || url.pathname !== file.pathname || url.search !== file.search) return false;
      const previous = prepared.get(frame);
      if (previous) revoke(previous);
      const token = crypto.randomUUID();
      url.hash = `${url.hash.slice(1)}${url.hash ? '&' : ''}${IFRAME_TOKEN}=${token}`;
      frame.src = url.href;
      const entry: Connection = { frame, context, token, src: frame.src, used: false, revoked: false, epoch, loaded: false,
        pending: new Map(), load: () => { if (entry.loaded) revoke(entry); else entry.loaded = true; } };
      frame.addEventListener('load', entry.load); prepared.set(frame, entry);
      if (frame.isConnected) connections.set(frame, entry);
      return true;
    },
    clear() { epoch++; for (const entry of connections.values()) revoke(entry); },
    dispose() { this.clear(); observer.disconnect(); host.removeEventListener('message', connect); },
  };
}
