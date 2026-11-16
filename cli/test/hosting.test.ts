import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startWeb } from '../src/web/locate.js';
import type { AsideWebServer } from '../src/web/server.js';
import { requestOrigin, sameOrigin } from '../src/web/origin.js';

const servers: AsideWebServer[] = [];
afterEach(() => servers.splice(0).forEach(server => server.close()));
function request(headers: Record<string, string | string[]>) {
  return {headers, rawHeaders: Object.entries(headers).flatMap(([key, value]) => Array.isArray(value) ? value.flatMap(v => [key, v]) : [key, value])} as http.IncomingMessage;
}
describe('hosting boundary', () => {
  it('derives normalized request origins while keeping the backend host local', () => {
    expect(requestOrigin(request({host: '127.0.0.1:24800'}))).toBe('http://127.0.0.1:24800');
    expect(requestOrigin(request({host: '[::1]:24800'}))).toBe('http://[::1]:24800');
    expect(requestOrigin(request({host: 'localhost:24800', 'x-forwarded-host': 'Aside.example.com:443', 'x-forwarded-proto': 'https'}))).toBe('https://aside.example.com');
    expect(sameOrigin(request({origin: 'https://ASIDE.example.com:443'}), 'https://aside.example.com')).toBe(true);
  });
  it.each([
    {host: 'attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http'},
    {host: 'localhost:24800', 'x-forwarded-host': 'aside.example.com'},
    {host: 'localhost:24800', 'x-forwarded-proto': 'https'},
    {host: 'localhost:24800', 'x-forwarded-host': 'a.example,b.example', 'x-forwarded-proto': 'https'},
    {host: 'localhost:24800', 'x-forwarded-host': 'a.example/path', 'x-forwarded-proto': 'https'},
    {host: 'localhost:24800', 'x-forwarded-host': 'user@a.example', 'x-forwarded-proto': 'https'},
    {host: 'localhost:24800', 'x-forwarded-host': 'a.example', 'x-forwarded-proto': 'ftp'},
    {host: 'localhost:24800', 'x-forwarded-host': ['a.example','b.example'], 'x-forwarded-proto': 'https'},
  ])('rejects ambiguous forwarding or a non-loopback Host: %j', headers => expect(() => requestOrigin(request(headers))).toThrow());
  it.each(['null', 'https://other.example', 'https://aside.example/path', 'https://aside.example/'])('rejects invalid browser Origin %s', origin => {
    expect(sameOrigin(request({origin}), 'https://aside.example')).toBe(false);
  });
  it('serves direct and forwarded requests without Aside credentials and retains origin and POST protections', async () => {
    const server = await startWeb(fileURLToPath(new URL('../../webapp', import.meta.url)), {
      instances: () => [], register: async () => null, remove: () => {}, load: () => {}, data: async () => {throw new Error('No fixture');},
    }, 0); servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    const headers = {'X-Forwarded-Host':'aside.example.com','X-Forwarded-Proto':'https',Origin:'https://aside.example.com'};
    expect((await fetch(`${url}/-/api/instances`)).status).toBe(200);
    expect((await fetch(`${url}/-/api/instances`, {headers})).status).toBe(200);
    expect((await fetch(`${url}/-/api/instances`, {headers:{...headers,Origin:'https://other.example'}})).status).toBe(403);
    const rebound = await new Promise<number>((resolve, reject) => {
      http.get(`${url}/-/api/instances`, { headers: {...headers,Host:'attacker.example'} }, response => {
        response.resume(); resolve(response.statusCode!);
      }).on('error', reject);
    });
    expect(rebound).toBe(403);
    expect((await fetch(`${url}/-/api/instances/register`, {method:'POST',body:'{}',headers})).status).toBe(403);
    expect((await fetch(`${url}/-/api/instances/register`, {method:'POST',body:'{}',headers:{...headers,'Content-Type':'text/plain'}})).status).toBe(403);
    // Native clients need only JSON; browsers may supply a matching Origin.
    for (const requestHeaders of [{}, headers]) {
      const reply = await fetch(`${url}/-/api/instances/register`, {method:'POST',body:'{"path":"/tmp/hosting-fixture"}',
        headers:{...requestHeaders,'Content-Type':'application/json; charset=utf-8'}});
      expect(reply.status).toBe(200); expect(await reply.json()).toEqual({instance:null});
    }
    expect((await fetch(`${url}/`,{headers})).status).toBe(200);
    const shell = await fetch(`${url}/`);
    const html = await shell.text();
    const nonce = html.match(/name="aside-preview-nonce" content="([^"]+)"/)![1];
    expect(shell.headers.get('content-security-policy')).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(shell.headers.get('content-security-policy')).not.toContain("script-src 'unsafe-inline'");
  });
});
