import { validWebQueryRequest, webQueryBytes, WEB_QUERY_MAX_BYTES, WEB_QUERY_TIMEOUT_MS, type WebQueryRequest, type WebQueryResult } from '../../cli/src/core/web-query';
import { IFRAME_CONNECT, ARTIFACT_MAX_BYTES, type HostMessage } from './iframe-protocol';
import { webpageSource } from './webpage';
import { webFetch } from './connection';

interface QueryContext {
  fileUrl(path: string): string | null;
  isCurrent(): boolean;
  query(request: WebQueryRequest, signal: AbortSignal): Promise<WebQueryResult>;
  resource(reference: string, signal: AbortSignal): Promise<Blob>;
}
interface Connection {
  frame: HTMLIFrameElement;
  context: QueryContext;
  token: string;
  document?: string;
  started: boolean;
  visible: boolean;
  used: boolean;
  revoked: boolean;
  suspended: boolean;
  epoch: number;
  loaded: boolean;
  controller: AbortController;
  port?: MessagePort;
  pending: Map<number, AbortController>;
  load(): void;
}

/** Read bounded content through the parent's deployment-authenticated connection. */
export async function artifactBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await webFetch(url, { cache: 'no-store', signal });
  if (!response.ok || !response.body) throw new Error(`Could not read artifact resource (${response.status}).`);
  if (Number(response.headers.get('content-length')) > ARTIFACT_MAX_BYTES) {
    await response.body.cancel(); throw new Error('Artifact resource exceeds 16 MiB.');
  }
  const reader = response.body.getReader();
  const parts: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ARTIFACT_MAX_BYTES) throw new Error('Artifact resource exceeds 16 MiB.');
      parts.push(value.slice().buffer);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return new Blob(parts, { type: response.headers.get('content-type') ?? 'application/octet-stream' });
}

function previewDocument(host: Window, html: string, sdk: string, token: string): string {
  const nonce = host.document.querySelector<HTMLMetaElement>('meta[name="aside-preview-nonce"]')?.content ?? crypto.randomUUID();
  // Template contents are inert: authored resource tags must not load in the parent.
  const template = host.document.createElement('template');
  template.innerHTML = html;
  for (const script of template.content.querySelectorAll('script:not([src])')) script.setAttribute('nonce', nonce);
  const bootstrap = host.document.createElement('script');
  bootstrap.setAttribute('nonce', nonce);
  bootstrap.dataset.asideToken = token;
  bootstrap.dataset.asideOrigin = host.location.origin;
  bootstrap.textContent = sdk.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><meta charset="utf-8">${bootstrap.outerHTML}${template.innerHTML}`;
}

export function createIframeQueryBridge(host: Window = window) {
  const connections = new Map<HTMLIFrameElement, Connection>();
  const prepared = new WeakMap<HTMLIFrameElement, Connection>();
  let epoch = 0;
  let inFlight = 0;
  let visibility: IntersectionObserver | undefined;
  const valid = (entry: Connection) => !entry.revoked && entry.epoch === epoch && entry.context.isCurrent() && entry.frame.isConnected
    && !entry.frame.hasAttribute('src') && entry.frame.getAttribute('sandbox') === 'allow-scripts'
    && (entry.document === undefined ? !entry.frame.hasAttribute('srcdoc') : entry.frame.srcdoc === entry.document);
  const retained = (entry: Connection) => valid(entry) && (entry.suspended || !entry.frame.closest('[hidden], [inert]'));
  const current = (entry: Connection) => valid(entry) && !entry.suspended && !entry.frame.closest('[hidden], [inert]');
  const send = (entry: Connection, message: HostMessage) => { try { entry.port?.postMessage(message); } catch { /* The document may have gone away. */ } };
  const revoke = (entry: Connection) => {
    entry.revoked = true; connections.delete(entry.frame);
    visibility?.unobserve(entry.frame);
    entry.frame.removeEventListener('load', entry.load);
    entry.controller.abort();
    send(entry, { type: 'closed', message: 'The preview connection was closed. Reopen the preview to reconnect.' });
    entry.port?.close();
    for (const controller of entry.pending.values()) controller.abort();
    entry.pending.clear();
  };
  const receive = (entry: Connection, value: unknown) => {
    if (!retained(entry)) { revoke(entry); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { revoke(entry); return; }
    const message = value as Record<string, unknown>;
    if (message.type === 'close') { revoke(entry); return; }
    const id = message.id as number;
    if (!Number.isSafeInteger(id) || id < 1) { revoke(entry); return; }
    if (message.type === 'cancel') { entry.pending.get(id)?.abort(); return; }
    const query = message.type === 'query';
    if ((!query && message.type !== 'resource') || entry.pending.has(id)
      || Object.keys(message).some(key => !['type', 'id', query ? 'request' : 'reference'].includes(key))) { revoke(entry); return; }
    if (!current(entry)) { send(entry, { type: 'error', id, message: 'The webpage is not visible. Reopen the preview to run requests.' }); return; }
    try {
      if (query ? !validWebQueryRequest(message.request) || webQueryBytes(message.request) > WEB_QUERY_MAX_BYTES
        : typeof message.reference !== 'string' || !message.reference || message.reference.length > 4096) throw new Error();
    } catch { send(entry, { type: 'error', id, message: 'Invalid or oversized Aside request.' }); return; }
    if (entry.pending.size >= 4 || inFlight >= 8) { send(entry, { type: 'error', id, message: 'Too many pending requests.' }); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEB_QUERY_TIMEOUT_MS);
    entry.pending.set(id, controller); inFlight++;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted || !current(entry)) throw new Error('The preview connection was closed.');
      if (query) {
        const result = await entry.context.query(message.request as WebQueryRequest, controller.signal);
        if (!controller.signal.aborted && current(entry)) send(entry, { type: 'result', id, result });
      } else {
        const blob = await entry.context.resource(message.reference as string, controller.signal);
        if (blob.size > ARTIFACT_MAX_BYTES) throw new Error('Artifact resource exceeds 16 MiB.');
        const bytes = await blob.arrayBuffer();
        if (!controller.signal.aborted && current(entry)) send(entry, { type: 'resource', id, bytes, mediaType: blob.type });
      }
    }).catch(error => {
      if (current(entry) && !controller.signal.aborted) send(entry, { type: 'error', id, message: error instanceof Error ? error.message : 'Aside request failed.' });
    }).finally(() => { clearTimeout(timeout); inFlight--; if (entry.pending.get(id) === controller) entry.pending.delete(id); });
  };
  const connect = (event: MessageEvent) => {
    if (event.data?.type !== IFRAME_CONNECT) return;
    const port = event.ports[0];
    const frame = event.source && Array.from(host.document.querySelectorAll('iframe')).find(value => value.contentWindow === event.source);
    const entry = frame && prepared.get(frame);
    if (!port || event.ports.length !== 1 || !entry || entry.used || !entry.document || !retained(entry)
      || event.origin !== 'null' || event.data.version !== 1 || event.data.token !== entry.token
      || Object.keys(event.data).some(key => !['type', 'version', 'token'].includes(key))) {
      for (const rejected of event.ports) rejected.close(); return;
    }
    entry.used = true; entry.port = port;
    port.onmessage = message => receive(entry, message.data);
    port.onmessageerror = () => revoke(entry);
    port.start(); send(entry, { type: 'ready' });
  };
  const start = (entry: Connection) => {
    if (entry.started || entry.suspended || !entry.visible) return;
    entry.started = true;
    const source = webpageSource(entry.frame)!;
    const timeout = setTimeout(() => entry.controller.abort(), WEB_QUERY_TIMEOUT_MS);
    void Promise.all([
      artifactBlob(entry.context.fileUrl(source.path!)!, entry.controller.signal).then(blob => blob.text()),
      artifactBlob('/-/assets/iframe-client.js', entry.controller.signal).then(blob => blob.text()),
    ]).then(([html, sdk]) => {
      if (!retained(entry) || entry.controller.signal.aborted) { revoke(entry); return; }
      if (entry.suspended) { entry.started = false; return; }
      entry.document = previewDocument(host, html, sdk, entry.token);
      entry.frame.srcdoc = entry.document;
    }).catch(error => {
      if (valid(entry)) {
        entry.document = '<!doctype html><p>Could not load artifact preview.</p>';
        entry.frame.srcdoc = entry.document;
        entry.frame.dispatchEvent(new CustomEvent('aside-preview-error', { detail: error }));
      }
      revoke(entry);
    }).finally(() => clearTimeout(timeout));
  };
  const attach = (entry: Connection) => {
    if (!connections.has(entry.frame)) {
      connections.set(entry.frame, entry);
      visibility?.observe(entry.frame);
    }
    start(entry);
  };
  if (typeof IntersectionObserver !== 'undefined') visibility = new IntersectionObserver(entries => {
    for (const observed of entries) {
      const entry = prepared.get(observed.target as HTMLIFrameElement);
      if (!entry || !observed.isIntersecting) continue;
      visibility!.unobserve(entry.frame);
      entry.visible = true;
      if (valid(entry)) start(entry); else revoke(entry);
    }
  }, { rootMargin: '200px' });
  host.addEventListener('message', connect);
  const observer = new MutationObserver(() => {
    for (const frame of host.document.querySelectorAll('iframe')) {
      const entry = prepared.get(frame);
      if (entry && !entry.revoked && frame.isConnected) { if (valid(entry)) attach(entry); else revoke(entry); }
    }
    for (const entry of connections.values()) if (!retained(entry)) revoke(entry);
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
      frame.removeAttribute('src');
      const entry: Connection = { frame, context, token: crypto.randomUUID(), started: false, visible: !visibility, used: false, revoked: false,
        suspended: false, epoch, loaded: false, controller: new AbortController(), pending: new Map(),
        load: () => { if (!entry.document) return; if (entry.loaded) revoke(entry); else entry.loaded = true; } };
      frame.addEventListener('load', entry.load); prepared.set(frame, entry);
      if (frame.isConnected) attach(entry);
      return true;
    },
    setSuspended(frame: HTMLIFrameElement, suspended: boolean): boolean {
      const entry = prepared.get(frame);
      if (!entry || entry.revoked || entry.epoch !== epoch) return false;
      if (entry.suspended === suspended) return true;
      entry.suspended = suspended;
      if (suspended) {
        for (const [id, controller] of entry.pending) {
          controller.abort(); send(entry, { type: 'error', id, message: 'The webpage is not visible. Reopen the preview to run requests.' });
        }
        entry.pending.clear();
      }
      if (!suspended && valid(entry)) start(entry);
      return true;
    },
    clear() { epoch++; for (const entry of connections.values()) revoke(entry); },
    dispose() { this.clear(); visibility?.disconnect(); observer.disconnect(); host.removeEventListener('message', connect); },
  };
}
