import { afterEach, describe, expect, it } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Peer, RpcDisconnected } from '../src/daemon/jsonrpc.js';

let dir: string, server: Server | undefined;
afterEach(async () => { if (server) { server.close(); server = undefined; } rmSync(dir, { recursive: true, force: true }); });

async function pair(limit: number): Promise<{ peer: Peer; client: Socket }> {
  dir = mkdtempSync('/tmp/aside-rpc-'); // Short path: Unix socket paths are length-limited.
  const path = join(dir, 'sock');
  let peer!: Peer;
  const accepted = new Promise<void>(resolve => {
    server = createServer(socket => { peer = new Peer(socket, async method => ({ echoed: method }), limit); resolve(); });
  });
  server!.listen(path);
  await once(server!, 'listening');
  const client = connect(path);
  await once(client, 'connect');
  await accepted;
  return { peer, client };
}

describe('JSON-RPC frame limit', () => {
  it('still answers complete frames within the limit', async () => {
    const { client } = await pair(1024);
    client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    const [reply] = await once(client, 'data');
    expect(JSON.parse(String(reply))).toEqual({ jsonrpc: '2.0', id: 1, result: { echoed: 'ping' } });
    client.destroy();
  });

  it('closes the connection when a line exceeds the limit and fails pending requests as disconnected', async () => {
    const { peer, client } = await pair(1024);
    const disconnected = expect(peer.request('status')).rejects.toBeInstanceOf(RpcDisconnected);
    client.resume(); // Observe EOF: an unread socket never reports the remote close.
    client.write('x'.repeat(2048));
    await once(client, 'close');
    expect(peer.closed).toBe(true);
    await disconnected;
  });
});
