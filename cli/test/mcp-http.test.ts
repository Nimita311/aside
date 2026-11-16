import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpMcp } from '../src/mcp/http.js';
import type { Backend } from '../src/mcp/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); });
async function fixture() {
  const backends: Array<Backend & {release(): void}> = [];
  const pool = new HttpMcp(() => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const backend: Backend & {release(): void} = {
      issues: async () => [], close: vi.fn(), release,
      graphql: vi.fn(async (session, _mode, args) => {
        if (args.document.includes('slow')) await gate;
        return {session, result: {data: {ok: true}}};
      }),
      graphqlSchema: async () => { throw new Error('Unexpected schema request'); },
    };
    backends.push(backend); return backend;
  }, 2);
  const server = http.createServer((req, res) => {
    void pool.handle(req, res, `http://${req.headers.host}`).catch(error => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`;
  cleanup.push(async () => {
    backends.forEach(backend => backend.release());
    await pool.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  let id = 0;
  const rpc = (method: string, params: unknown, session?: string) => fetch(url, {
    method:'POST', headers:{'Content-Type':'application/json', Accept:'application/json, text/event-stream',
      'Mcp-Protocol-Version':'2025-11-25', ...(session ? {'Mcp-Session-Id':session} : {})},
    body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(3000),
  });
  const initialize = async () => {
    const reply = await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'pool-test',version:'1'}});
    expect(reply.status).toBe(200); await reply.json();
    return reply.headers.get('Mcp-Session-Id')!;
  };
  return {backends,rpc,initialize};
}
it('reclaims the least recently used idle session at capacity and closes its backend', async () => {
  const f = await fixture();
  const first = await f.initialize(), second = await f.initialize();
  expect((await f.rpc('tools/list',{},first)).status).toBe(200);
  const third = await f.initialize();
  expect((await f.rpc('tools/list',{},second)).status).toBe(404);
  expect((await f.rpc('tools/list',{},first)).status).toBe(200);
  expect((await f.rpc('tools/list',{},third)).status).toBe(200);
  expect(f.backends[0].close).not.toHaveBeenCalled();
  expect(f.backends[1].close).toHaveBeenCalledOnce();
});
it('retains requests in progress and recovers capacity as they finish', async () => {
  const f = await fixture();
  const first = await f.initialize(), second = await f.initialize();
  const params = {name:'query',arguments:{document:'query slow { __typename }'}};
  const a = f.rpc('tools/call',params,first), b = f.rpc('tools/call',params,second);
  await vi.waitFor(()=>expect(f.backends.every(backend => vi.mocked(backend.graphql).mock.calls.length === 1)).toBe(true));
  expect((await f.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'busy',version:'1'}})).status).toBe(503);
  f.backends[1].release(); expect((await b).status).toBe(200);
  await f.initialize();
  expect(f.backends[0].close).not.toHaveBeenCalled();
  expect(f.backends[1].close).toHaveBeenCalledOnce();
  f.backends[0].release(); expect((await a).status).toBe(200);
});
