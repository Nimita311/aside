import { validWebQueryRequest, webQueryBytes, WEB_QUERY_MAX_BYTES, WEB_QUERY_TIMEOUT_MS, type WebQueryRequest, type WebQueryResult } from '../../cli/src/core/web-query';
import { IFRAME_CONNECT, type HostMessage, type ClientMessage } from './iframe-protocol';

export interface IframeQueryClient {
  resource(reference: string): Promise<Blob>;
  query(query: string, variables?: Record<string, unknown>, options?: { operationName?: string }): Promise<WebQueryResult>;
}

export function createIframeQueryClient(target: Window = window, config?: { token: string; parentOrigin: string }): IframeQueryClient {
  let port: MessagePort | undefined;
  let connection: Promise<MessagePort> | undefined;
  let closed = false, nextId = 0;
  const pending = new Map<number, { resolve(value: WebQueryResult | Blob): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let rejectConnection: ((error: Error) => void) | undefined;
  const close = (message: string) => {
    closed = true; rejectConnection?.(new Error(message));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    pending.clear(); port?.close();
  };
  const post = (message: ClientMessage) => port?.postMessage(message);
  target.addEventListener('pagehide', () => {
    try { post({ type: 'close' }); } catch { /* The host may already have revoked the connection. */ }
    close('The webpage navigated away.');
  }, { once: true });
  const connect = (): Promise<MessagePort> => {
    if (closed) return Promise.reject(new Error('The query connection is closed. Reopen the preview to reconnect.'));
    if (connection) return connection;
    connection = new Promise<MessagePort>((resolve, reject) => {
      rejectConnection = reject;
      const token = config?.token;
      if (!token || target.parent === target) { closed = true; reject(new Error('The SDK is available only inside an Aside HTML artifact preview.')); return; }
      const channel = new MessageChannel(); port = channel.port1;
      const timeout = setTimeout(() => close('Aside did not accept the webpage query connection.'), 5_000);
      rejectConnection = error => { clearTimeout(timeout); reject(error); };
      port.onmessage = (event: MessageEvent<HostMessage>) => {
        const message = event.data;
        if (message?.type === 'ready') { clearTimeout(timeout); rejectConnection = undefined; resolve(port!); return; }
        if (message?.type === 'closed') { clearTimeout(timeout); close(message.message); return; }
        if (message?.type !== 'result' && message?.type !== 'resource' && message?.type !== 'error') return;
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(message.id);
        if (message.type === 'error') entry.reject(new Error(message.message)); else if (message.type === 'resource') entry.resolve(new Blob([message.bytes], { type: message.mediaType })); else entry.resolve(message.result);
      };
      port.onmessageerror = () => { clearTimeout(timeout); close('The webpage query connection failed.'); };
      port.start();
      try {
        target.parent.postMessage({ type: IFRAME_CONNECT, version: 1, token }, config!.parentOrigin, [channel.port2]);
      } catch { clearTimeout(timeout); close('The webpage could not connect to Aside.'); }
    });
    return connection;
  };
  async function request(message: { type: 'query'; request: WebQueryRequest } | { type: 'resource'; reference: string }): Promise<WebQueryResult | Blob> {
    await connect();
    if (closed) throw new Error('The preview connection is closed.');
    if (pending.size >= 4) throw new Error('Too many pending requests. Wait for a request to finish.');
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        try { post({ type: 'cancel', id }); } catch { /* The channel may have closed. */ }
        reject(new Error('Aside request timed out.'));
      }, WEB_QUERY_TIMEOUT_MS + 2_000);
      pending.set(id, { resolve, reject, timer });
      try { post({ ...message, id }); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error('The preview connection is closed.')); }
    });
  }
  return {
    async query(query, variables, options) {
      const value: WebQueryRequest = { query, ...(variables === undefined ? {} : { variables }), ...(options?.operationName === undefined ? {} : { operationName: options.operationName }) };
      if (!validWebQueryRequest(value) || webQueryBytes(value) > WEB_QUERY_MAX_BYTES) throw new Error('Invalid or oversized GraphQL request.');
      return request({ type: 'query', request: value }) as Promise<WebQueryResult>;
    },
    async resource(reference) {
      if (typeof reference !== 'string' || !reference || reference.length > 4096) throw new Error('Invalid resource reference.');
      return request({ type: 'resource', reference }) as Promise<Blob>;
    },
  };
}
