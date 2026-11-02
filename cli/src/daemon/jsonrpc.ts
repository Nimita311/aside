// JSON-RPC 2.0 over a stream socket, one UTF-8 JSON message per line — the
// framing MCP uses over stdio. Either side may send requests and notifications.
import type { Socket } from 'node:net';
import { DAEMON_RPC_MAX_FRAME_CHARS } from '../core/system-config.js';

export interface RpcError {
  code: number;
  message: string;
}

// The request failed inside the handler (a tool error, invalid input).
const ERR_FAILED = -32000;
// The daemon is shutting down and did not run the request.
export const ERR_SHUTTING_DOWN = -32001;
export const ERR_METHOD_NOT_FOUND = -32601;

export class RpcFailure extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

// The connection closed before a request was answered.
export class RpcDisconnected extends Error {}

type Handler = (method: string, params: any) => unknown | Promise<unknown>;

export class Peer {
  private buf = '';
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closeListeners = new Set<() => void>();
  private notifyListeners = new Set<(method: string, params: any) => void>();
  closed = false;

  constructor(private socket: Socket, private onRequest?: Handler, private readonly maxFrameChars = DAEMON_RPC_MAX_FRAME_CHARS) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.read(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      this.closed = true;
      const error = new RpcDisconnected('connection closed');
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      for (const cb of this.closeListeners) cb();
    });
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcDisconnected('connection closed'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.send({ jsonrpc: '2.0', method, params });
  }

  onNotify(cb: (method: string, params: any) => void): void {
    this.notifyListeners.add(cb);
  }

  onClose(cb: () => void): void {
    this.closeListeners.add(cb);
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private send(message: unknown): void {
    if (this.closed) return;
    this.socket.write(JSON.stringify(message) + '\n');
  }

  private read(chunk: string): void {
    this.buf += chunk;
    // A peer that never ends its line must not grow this process without bound.
    if (this.buf.length > this.maxFrameChars) { this.buf = ''; this.close(); return; }
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: any): Promise<void> {
    if (typeof msg?.method === 'string') {
      if (msg.id === undefined || msg.id === null) {
        for (const cb of this.notifyListeners) cb(msg.method, msg.params);
        return;
      }
      try {
        if (!this.onRequest) throw new RpcFailure(`unknown method ${msg.method}`, ERR_METHOD_NOT_FOUND);
        const result = await this.onRequest(msg.method, msg.params ?? {});
        this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
      } catch (e) {
        const error: RpcError = {
          code: e instanceof RpcFailure ? e.code : ERR_FAILED,
          message: e instanceof Error ? e.message : String(e),
        };
        this.send({ jsonrpc: '2.0', id: msg.id, error });
      }
      return;
    }
    const waiter = this.pending.get(msg?.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new RpcFailure(String(msg.error.message ?? 'request failed'), Number(msg.error.code ?? ERR_FAILED)));
    else waiter.resolve(msg.result);
  }
}
