import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type Backend } from './server.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  requests: number;
  close(): Promise<void>;
}

/** Each transport owns its MCP selection. Authentication belongs to deployment. */
export class HttpMcp {
  // Insertion order is least recently used first. Requests in progress are retained.
  private sessions = new Map<string, Session>();
  private initializing = 0;
  private origin = new AsyncLocalStorage<string>();
  constructor(private createBackend: () => Backend, private capacity = 256) {}

  async handle(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
    const reply = (status: number, message: string) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
    };
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return reply(405, 'Method not allowed.');
    }
    const id = req.headers['mcp-session-id'];
    if (Array.isArray(id)) return reply(400, 'Invalid MCP session.');
    if (id) {
      const session = this.sessions.get(id);
      if (!session) return reply(404, 'MCP session unavailable. Initialize a new session.');
      this.sessions.delete(id); this.sessions.set(id, session);
      session.requests++;
      try { await this.origin.run(origin, () => session.transport.handleRequest(req, res)); }
      finally { session.requests--; }
      return;
    }
    if (req.method !== 'POST') return reply(400, 'Initialize an MCP session first.');
    const full = this.sessions.size + this.initializing >= this.capacity;
    const unused = full ? [...this.sessions].find(([, session]) => session.requests === 0) : undefined;
    if (full && !unused) return reply(503, 'Too many active MCP sessions. Retry after a request completes.');
    this.initializing++;
    try {
      if (unused) { this.sessions.delete(unused[0]); await unused[1].close(); }
      const backend = this.createBackend();
      const server = createMcpServer(null, [], [], false, backend, () => this.origin.getStore());
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        maxRequestBodySize: 1024 * 1024,
        onsessioninitialized: sessionId => { this.sessions.set(sessionId, session); },
      });
      const session: Session = { transport, requests: 1, close: () => server.close() };
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId);
        backend.close();
      };
      try {
        await server.connect(transport);
        await this.origin.run(origin, () => transport.handleRequest(req, res));
      } finally {
        session.requests--;
        if (!transport.sessionId) await server.close();
      }
    } finally { this.initializing--; }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => session.close()));
    this.sessions.clear();
  }
}
