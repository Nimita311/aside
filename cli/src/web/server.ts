import { WEB_EVENT_HEARTBEAT_MS, WEB_CHANGE_DEBOUNCE_MS } from '../core/system-config.js';
// One localhost web server for the daemon, with instance-scoped data and tabs.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { constants, watch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DataSnapshot } from '../core/data-snapshot.js';
import { VERSION } from '../version.js';
import { isInstanceAddress } from '../core/identity.js';
import { MEDIA_TYPES } from '../core/media.js';
import { WEB_QUERY_TIMEOUT_MS, WEB_QUERY_MAX_RESPONSE_BYTES } from '../core/web-query.js';
import { prepareWebQuery } from './query.js';
import type { GraphQLArgs, GraphQLResult } from '../graphql/schema.js';
import { resolveInstanceAddress, type AvailableInstance, type InstanceCardSummary, type InstanceRegistration, type PickerKind } from './catalogue.js';
import { WebAuth, type WebSession } from './auth.js';
import { createWebHandoff, WEB_HANDOFF_LIFETIME_MS } from './handoff.js';
import { parseFileGrantPath, verifyFileGrant, type ParsedFileGrant } from './file-grants.js';
import { fileGrantAllows, fileGrantScopeKind } from '../core/web-file-grant.js';
import { assertManagedPath, isManagedInstancePath } from '../core/managed-path.js';

export interface WebServerOptions {
  auth: WebAuth;
  stateDirectory: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// The application shell runs scripts only from the daemon's own assets, so
// sanitizer-escaping record content cannot execute as the app. Authored media
// and embeds keep their http(s) destinations; previews are separate documents.
export const APP_SHELL_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:", "media-src 'self' https: http:", "frame-src 'self' https: http:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
export interface WebBackend {
  instances(): AvailableInstance[];
  summary?(path: string): InstanceCardSummary | undefined;
  register(selection: InstanceRegistration): Promise<AvailableInstance | null>;
  pick?(kind: PickerKind): Promise<string | null>;
  remove(path: string): void;
  load(path: string): void;
  data(path: string, refresh: boolean): Promise<DataSnapshot>;
  query?(path: string, args: GraphQLArgs, signal: AbortSignal): Promise<GraphQLResult>;
}
class WebError extends Error {
  constructor(readonly status: number, message: string, readonly paths?: string[]) { super(message); }
}
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  ...Object.fromEntries(Object.entries(MEDIA_TYPES).map(([ext, { mime }]) => [`.${ext}`, mime])),
};

async function tryFile(file: string, managedRoot?: string): Promise<Buffer | null> {
  try {
    if (managedRoot === undefined) return await fs.readFile(file);
    const checked = assertManagedPath(managedRoot, file, 'file');
    const handle = await fs.open(checked, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { return (await handle.stat()).isFile() ? await handle.readFile() : null; }
    finally { await handle.close(); }
  }
  catch (error) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}

function publicAssetFile(appDir: string, asset: string): string | null {
  const parts = asset.split('/');
  if (parts.some(part => !part || part.startsWith('.')) || /[\\\x00-\x1f\x7f]/.test(asset)) return null;
  const root = path.resolve(appDir, 'dist');
  const file = path.resolve(root, ...parts);
  return file.startsWith(root + path.sep) ? file : null;
}

interface Tab { id: number; res: ServerResponse; focusedAt: number; instance: string | null; session: string }
interface PendingHandoff { route: string; expires: number; cleanup: () => Promise<void> }

export class AsideWebServer {
  readonly port: number;
  private tabs: Tab[] = [];
  private nextTabId = 1;
  private watchers = new Set<FSWatcher>();
  private timers = new Set<ReturnType<typeof setInterval>>();
  private snapshots = new WeakMap<DataSnapshot, { body: Buffer; etag: string }>();
  private queryCount = 0;
  private queryInstances = new Map<string, number>();
  private queryRates = new Map<string, { start: number; count: number }>();
  private picking: Promise<unknown> | null = null;
  private sessions = new WeakMap<IncomingMessage, WebSession>();
  private streams = new Map<ServerResponse, string>();
  private handoffs = new Map<string, PendingHandoff>();
  onTabsChanged: (() => void) | undefined;

  private constructor(private readonly server: http.Server, port: number,
    private appDir: string, private readonly backend: WebBackend, private readonly options: WebServerOptions) {
    this.port = port;
    const expiry = setInterval(() => this.expire(), 1000);
    expiry.unref(); this.timers.add(expiry);
  }

  get origin(): string { return `http://localhost:${this.port}`; }

  static start(appDir: string, backend: WebBackend, port: number, options: WebServerOptions): Promise<AsideWebServer | null> {
    return new Promise((resolve, reject) => {
      const httpServer = http.createServer();
      let server: AsideWebServer;
      httpServer.on('request', (req, res) => {
        void server.handle(req, res).catch((error: unknown) => {
          if (res.destroyed) return;
          if (res.headersSent) { res.end(); return; }
          const e = error instanceof WebError ? error : new WebError(500, error instanceof Error ? error.message : 'Internal error');
          if (e.status === 401) return server.unauthorized(res);
          res.writeHead(e.status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: e.message, ...(e.paths ? { paths: e.paths } : {}) }));
        });
      });
      httpServer.once('error', (err: NodeJS.ErrnoException) => err.code === 'EADDRINUSE' ? resolve(null) : reject(err));
      httpServer.listen(port, '127.0.0.1', () => {
        server = new AsideWebServer(httpServer, (httpServer.address() as { port: number }).port, appDir, backend, options);
        resolve(server);
      });
    });
  }

  setAppDir(appDir: string): void { this.appDir = appDir; }

  // Every opening gets a fresh handoff for its chosen browser. A bookmark URL
  // does not grant access or change an existing browser's authorization.
  async show(instance: string | null, route: string, navigate = true): Promise<{ url: string; launchUrl?: string; tab: boolean }> {
    const url = `${this.origin}/${route}`;
    if (!navigate) return { url, tab: false };
    const code = crypto.randomBytes(32).toString('base64url');
    const file = await createWebHandoff(this.options.stateDirectory, this.origin, code);
    this.handoffs.set(code, { route, expires: Date.now() + WEB_HANDOFF_LIFETIME_MS, cleanup: file.cleanup });
    return { url, launchUrl: file.url, tab: false };
  }

  private broadcastAuth(id: string): void {
    const session = this.options.auth.session(id);
    if (session) for (const [res, owner] of this.streams) if (owner === id && !res.destroyed)
      res.write(`event: auth\ndata: ${JSON.stringify({ expiresAt: session.expiresAt })}\n\n`);
  }

  private expire(): void {
    for (const [res, id] of this.streams) if (!this.options.auth.session(id)) {
      if (!res.destroyed) res.end('event: auth-expired\ndata: {}\n\n');
      this.streams.delete(res);
    }
    for (const [code, value] of this.handoffs) if (value.expires <= Date.now()) {
      this.handoffs.delete(code); void value.cleanup().catch(() => {});
    }
  }

  private trackStream(req: IncomingMessage, res: ServerResponse): void {
    const session = this.sessions.get(req)!;
    this.streams.set(res, session.id);
    res.write(`event: auth\ndata: ${JSON.stringify({ expiresAt: session.expiresAt })}\n\n`);
    res.once('close', () => this.streams.delete(res));
  }

  // File metadata walks belong to discovery, not every data/media/control read.
  private catalogue(): AvailableInstance[] {
    return this.backend.instances().map(instance => ({ ...instance, summary: this.backend.summary?.(instance.path) ?? instance.summary }));
  }

  instance(id: string): AvailableInstance {
    if (!isInstanceAddress(id)) throw new WebError(400, 'Invalid instance address.');
    const instance = resolveInstanceAddress(this.backend.instances(), id);
    if (!instance) throw new WebError(404, `Instance "${id}" is unavailable. Return to the instance chooser to select an existing directory.`);
    if (instance.error) throw new WebError(422, instance.error);
    return instance;
  }

  routeFor(instancePath: string, route: string): string {
    const instance = this.backend.instances().find(i => i.path === instancePath);
    if (!instance) throw new WebError(404, 'Instance is not registered with the daemon.');
    if (!instance.id && instance.error) throw new WebError(422, instance.error);
    const address = instance.address ?? instance.id;
    this.instance(address);
    return `${address}/${route}`;
  }

  navigate(instancePath: string, route: string): boolean {
    const tab = this.tabs.filter(t => !t.res.destroyed && t.instance === instancePath && this.options.auth.session(t.session))
      .reduce<Tab | null>((best, t) => !best || t.focusedAt > best.focusedAt ? t : best, null);
    if (!tab) return false;
    tab.res.write(`data: ${JSON.stringify({ navigate: route })}\n\n`);
    return true;
  }
  get tabCount(): number { return this.tabs.filter(t => !t.res.destroyed).length; }
  tabsForPath(instancePath: string): number { return this.tabs.filter(t => !t.res.destroyed && t.instance === instancePath).length; }
  close(): void {
    for (const watcher of this.watchers) watcher.close();
    for (const timer of this.timers) clearInterval(timer);
    this.server.close();
    this.server.closeAllConnections();
    for (const handoff of this.handoffs.values()) void handoff.cleanup().catch(() => {});
    this.handoffs.clear();
  }

  private sameOrigin(req: IncomingMessage): boolean {
    if (req.headers.origin !== undefined) return req.headers.origin === `http://${req.headers.host}`;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: string | Buffer, type = 'text/plain') => {
      const session = this.sessions.get(req);
      if (session && !this.options.auth.session(session.id)) return this.unauthorized(res);
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const json = (body: unknown) => send(200, JSON.stringify(body), TYPES['.json']);
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(hostname)) return send(403, 'Forbidden');
    const url = new URL(req.url ?? '/', this.origin);
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { throw new WebError(400, 'Malformed URL.'); }
    let requestedRel: string | undefined;
    try {
      // Preserve dot segments and backslashes that URL parsing normalizes, so
      // asset requests cannot acquire a different path before validation.
      const requestedPath = (req.url ?? '/').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0];
      requestedRel = decodeURIComponent(requestedPath).replace(/^\/+/, '');
    } catch { /* Reject malformed asset paths below; other routes use URL parsing. */ }
    let rel = pathname.replace(/^\/+/, '');
    if ((requestedRel?.startsWith('-/assets/') || rel.startsWith('-/assets/')) && requestedRel !== rel)
      return send(404, 'Not found');
    if (rel === '-/auth/complete') return this.completeHandoff(req, res);
    if (rel === '-/auth/redeem') return this.redeemHandoff(req, res);
    let fileGrant: ParsedFileGrant | null = null;
    if (rel === '-/files' || rel.startsWith('-/files/')) {
      fileGrant = parseFileGrantPath(url.pathname);
      const session = fileGrant && this.options.auth.session(fileGrant.session);
      if (!fileGrant || !session || !['GET', 'HEAD'].includes(req.method ?? '')) return this.unauthorized(res);
      let instance: AvailableInstance;
      try { instance = this.instance(fileGrant.instance); } catch { return this.unauthorized(res); }
      const key = this.options.auth.fileKey(session.id, instance.path);
      if (!key || !verifyFileGrant(key, fileGrant.scope, fileGrant.signature, fileGrant.path)) return this.unauthorized(res);
      rel = `-/api/instances/${fileGrant.instance}/files/${fileGrant.path}`;
      this.sessions.set(req, session);
    } else if (rel === '-/api' || rel.startsWith('-/api/')) {
      const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
      const session = token && this.options.auth.authorize(token);
      if (!session) return this.unauthorized(res);
      this.sessions.set(req, session);
    }
    if (rel === '-/api/auth') {
      if (req.method !== 'GET') return send(405, 'Method not allowed');
      return json({ expiresAt: this.sessions.get(req)!.expiresAt });
    }
    const writable = req.method === 'POST';
    if (writable && (!this.sameOrigin(req) || req.headers['x-aside-control'] !== '1')) return send(403, 'Forbidden');
    if (rel === '-/api/instances/pick') {
      if (!writable) return send(405, 'Method not allowed');
      const msg = await this.readJson(req);
      if (msg.kind !== 'directory') throw new WebError(400, 'Choose an instance folder.');
      if (!this.backend.pick) throw new WebError(503, 'The folder picker is unavailable. Enter the instance path.');
      if (this.picking) throw new WebError(409, 'Another instance folder is being chosen.');
      const picking = this.backend.pick('directory'); this.picking = picking;
      try { return json({ path: await picking }); }
      finally { this.picking = null; }
    }
    if (rel === '-/api/instances/register') {
      if (!writable) return send(405, 'Method not allowed');
      const msg = await this.readJson(req);
      let selection: InstanceRegistration;
      if (msg.path !== undefined) {
        if (msg.kind !== undefined || typeof msg.path !== 'string' || !msg.path.trim()) throw new WebError(400, 'Enter an instance path.');
        const entered = msg.path.trim();
        if (!path.isAbsolute(entered) && entered !== '~' && !entered.startsWith('~/')) throw new WebError(400, 'Use a full path or a path beginning with ~/.');
        selection = { path: entered };
      } else {
        if (msg.kind !== 'directory' && msg.kind !== 'manifest') throw new WebError(400, 'Choose a file or enter a path.');
        selection = { kind: msg.kind };
      }
      if (this.picking) throw new WebError(409, 'Another instance is being added.');
      this.picking = this.backend.register(selection);
      try { return json({ instance: await this.picking }); }
      finally { this.picking = null; }
    }
    if (rel === '-/api/instances/remove') {
      if (!writable) return send(405, 'Method not allowed');
      const msg = await this.readJson(req);
      if (typeof msg.path !== 'string' || !path.isAbsolute(msg.path)) throw new WebError(400, 'An instance path is required.');
      // IDs may be duplicated; the canonical path identifies the registration
      // whose removal policy the daemon applies (a primary includes worktrees).
      if (!this.backend.instances().some(instance => instance.path === msg.path)) throw new WebError(404, 'This instance is no longer in the list.');
      this.backend.remove(msg.path);
      return json({ instances: this.catalogue() });
    }
    if (rel === '-/api/control') {
      if (!this.sameOrigin(req)) return send(403, 'Forbidden');
      return this.handleControl(null, req, res);
    }
    const match = rel.match(/^-\/api\/instances\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const instance = this.instance(match[1]);
      const endpoint = match[2] ?? '';
      if (endpoint === 'access') {
        if (req.method !== 'GET') return send(405, 'Method not allowed');
        const session = this.sessions.get(req)!;
        const fileKey = this.options.auth.fileKey(session.id, instance.path);
        if (!fileKey) return this.unauthorized(res);
        return json({ fileBase: `/-/files/${session.id}/${encodeURIComponent(match[1])}`, fileKey });
      }
      if (endpoint === 'graphql') {
        if (!writable) return send(405, 'Method not allowed');
        if (!this.backend.query) throw new WebError(503, 'GraphQL queries are unavailable.');
        const running = this.queryInstances.get(instance.path) ?? 0;
        const now = Date.now();
        let rate = this.queryRates.get(instance.path);
        if (!rate || now - rate.start >= 60_000) {
          rate = { start: now, count: 0 }; this.queryRates.set(instance.path, rate);
          for (const [key, value] of this.queryRates) if (now - value.start >= 60_000) this.queryRates.delete(key);
        }
        if (this.queryCount >= 8 || running >= 4 || rate.count >= 60) throw new WebError(429, 'GraphQL query limit reached. Try again shortly.');
        rate.count++; this.queryCount++; this.queryInstances.set(instance.path, running + 1);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        const closed = () => { if (!res.writableEnded) cancel(); };
        req.once('aborted', cancel); res.once('close', closed);
        const timeout = setTimeout(cancel, WEB_QUERY_TIMEOUT_MS);
        let rejectAborted!: (error: Error) => void;
        const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
        const abort = () => rejectAborted(new WebError(504, 'GraphQL query timed out or was cancelled.'));
        controller.signal.addEventListener('abort', abort, { once: true });
        try {
          const message = await Promise.race([this.readJson(req), aborted]);
          const prepared = prepareWebQuery(message);
          const result = 'result' in prepared ? prepared.result
            : await Promise.race([this.backend.query(instance.path, prepared.args, controller.signal), aborted]);
          const body = JSON.stringify(result);
          if (Buffer.byteLength(body) > WEB_QUERY_MAX_RESPONSE_BYTES) throw new WebError(413, 'GraphQL response exceeds 1 MiB. Select less data.');
          return send(200, body, TYPES['.json']);
        } finally {
          clearTimeout(timeout); controller.signal.removeEventListener('abort', abort);
          req.off('aborted', cancel); res.off('close', closed);
          this.queryCount--;
          const remaining = (this.queryInstances.get(instance.path) ?? 1) - 1;
          if (remaining) this.queryInstances.set(instance.path, remaining); else this.queryInstances.delete(instance.path);
          if (controller.signal.aborted && !req.complete) {
            // Flush the timeout response before closing an unfinished upload.
            res.shouldKeepAlive = false;
            res.once('finish', () => req.destroy());
            req.resume();
          }
        }
      }
      if (endpoint === 'control') {
        if (!this.sameOrigin(req)) return send(403, 'Forbidden');
        if (req.method === 'GET') this.backend.load(instance.path);
        return this.handleControl(instance.path, req, res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
      if (!endpoint) return json(instance);
      if (endpoint === 'data') {
        const data = await this.backend.data(instance.path, url.searchParams.get('refresh') === '1');
        let serialized = this.snapshots.get(data);
        if (!serialized) {
          const body = Buffer.from(JSON.stringify(data));
          serialized = { body, etag: this.etag(body) };
          this.snapshots.set(data, serialized);
        }
        return this.sendFile(req, res, 'data.json', serialized.body, serialized.etag);
      }
      if (endpoint === 'years') {
        const years = new Set<string>();
        for (const kind of ['notes', 'projects', 'actions', 'artifacts']) {
          try {
            const directory = assertManagedPath(instance.path, path.join(instance.path, kind), 'directory');
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
              if (entry.isDirectory() && /^\d{4}$/.test(entry.name)) years.add(entry.name);
            }
          } catch (error) { if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        }
        return json([...years].sort());
      }
      if (endpoint === 'watch') {
        if (req.method !== 'GET') return send(405, 'Method not allowed');
        if (!this.sameOrigin(req)) return send(403, 'Forbidden');
        return this.streamWatch(instance.path, req, res);
      }
      if (endpoint.startsWith('files/')) {
        const file = path.resolve(instance.path, endpoint.slice(6));
        if (!file.startsWith(instance.path + path.sep)) return send(404, 'Not found');
        let real: string;
        try { real = await fs.realpath(file); }
        catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return send(404, 'Not found'); throw error; }
        if (!real.startsWith(instance.path + path.sep)) return send(404, 'Not found');
        // Exact-file grants already select the requested path. Folder grants
        // must also keep resolved user references within their granted scope.
        if (fileGrant && fileGrantScopeKind(fileGrant.scope) === 'tree' &&
            !fileGrantAllows(fileGrant.scope, path.relative(instance.path, real).split(path.sep).join('/')))
          return this.unauthorized(res);
        const managed = isManagedInstancePath(path.relative(instance.path, file));
        const body = await tryFile(managed ? file : real, managed ? instance.path : undefined);
        if (body === null) return send(404, 'Not found');
        // HTML and SVG documents keep an opaque origin when opened directly,
        // preserving the app's sandboxed preview boundary.
        if (/\.(?:html?|svg)$/i.test(file)) res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
        return this.sendFile(req, res, file, body);
      }
      return send(404, 'Not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed');
    if (rel === '-/api') return json({ version: VERSION });
    if (rel === '-/api/instances') return json(this.catalogue());
    if (rel.startsWith('-/assets/')) {
      const file = publicAssetFile(this.appDir, rel.slice(9));
      if (!file) return send(404, 'Not found');
      // The selected app root may be an alias; dist and every component below
      // it must be ordinary directories/files, never symlinks.
      const body = await tryFile(file, this.appDir);
      if (body !== null) return this.sendFile(req, res, file, body);
      return send(404, 'Not found');
    }
    // Every safe first path segment is an instance address, including IDs
    // that are currently unavailable: the UI explains and offers recovery.
    if (!rel || isInstanceAddress(rel.split('/')[0])) {
      const body = await tryFile(path.join(this.appDir, 'index.html'));
      res.setHeader('Content-Security-Policy', APP_SHELL_CSP);
      res.setHeader('X-Frame-Options', 'DENY');
      if (body !== null) return send(200, body, TYPES['.html']);
    }
    send(404, 'Not found');
  }

  private unauthorized(res: ServerResponse): void {
    res.writeHead(401, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({ code: 'AUTH_REQUIRED', error: 'To reconnect, run aside show or ask your agent to show this in Aside.' }));
  }

  private async completeHandoff(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const pending = await this.readHandoff(req);
    if (!pending) return this.unauthorized(res);
    const nonce = crypto.randomBytes(18).toString('base64');
    // The private file cannot read this origin's local storage. This same-origin
    // bridge supplies its existing credential only when redeeming the code.
    const script = `(async()=>{try{const saved=localStorage.getItem('aside.webToken');const headers=new Headers({'Content-Type':'application/x-www-form-urlencoded','X-Aside-Control':'1'});if(saved)headers.set('Authorization','Bearer '+saved);const response=await fetch('/-/auth/redeem',{method:'POST',headers,body:new URLSearchParams({code:${JSON.stringify(pending.code)}}).toString(),cache:'no-store'});if(!response.ok)throw new Error();const {token,route}=await response.json();if(localStorage.getItem('aside.webToken')!==token)localStorage.setItem('aside.webToken',token);location.replace(route);}catch{document.getElementById('status').textContent='Could not open Aside. Run show again or request a new showUrl URL and open it immediately.';}})();`;
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`, 'X-Frame-Options': 'DENY' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Opening Aside</title><p id="status">Opening Aside…</p><script nonce="${nonce}">${script}</script>`);
  }

  private async readHandoff(req: IncomingMessage): Promise<{ code: string; handoff: PendingHandoff } | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 2048) { req.resume(); throw new WebError(413, 'Payload too large'); }
      chunks.push(chunk);
    }
    const code = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('code') ?? '';
    const handoff = this.handoffs.get(code);
    if (!handoff) return null;
    if (handoff.expires <= Date.now()) {
      this.handoffs.delete(code); await handoff.cleanup().catch(() => {});
      return null;
    }
    return { code, handoff };
  }

  private async redeemHandoff(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (req.headers.origin !== this.origin || req.headers['x-aside-control'] !== '1') {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const pending = await this.readHandoff(req);
    if (!pending) return this.unauthorized(res);
    const { code, handoff } = pending;
    // Consume before cleanup yields, so concurrent redemptions cannot both win.
    if (this.handoffs.get(code) !== handoff) return this.unauthorized(res);
    this.handoffs.delete(code);
    await handoff.cleanup().catch(() => {});
    if (handoff.expires <= Date.now()) return this.unauthorized(res);
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    const previous = token ? this.options.auth.authorize(token) : null;
    const renewed = previous ? this.options.auth.renew(previous.id) : null;
    const credential = token && renewed ? { ...renewed, token } : this.options.auth.issue();
    this.broadcastAuth(credential.id);
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ token: credential.token, route: '/' + handoff.route }));
  }

  private etag(body: Buffer): string { return `"${crypto.createHash('sha1').update(body).digest('base64url')}"`; }
  private sendFile(req: IncomingMessage, res: ServerResponse, file: string, body: Buffer, etag = this.etag(body)): void {
    const session = this.sessions.get(req);
    if (session && !this.options.auth.session(session.id)) return this.unauthorized(res);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 64 * 1024) { req.resume(); throw new WebError(413, 'Payload too large'); }
      chunks.push(chunk);
    }
    // Headers may have arrived before expiry or revocation. Check again before
    // the completed body can trigger a picker, registration, query, or control.
    const session = this.sessions.get(req);
    if (!session || !this.options.auth.session(session.id)) throw new WebError(401, 'Authentication required');
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new WebError(400, 'Malformed JSON'); }
  }

  private async handleControl(instance: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      const tab: Tab = { id: this.nextTabId++, res, focusedAt: Date.now(), instance, session: this.sessions.get(req)!.id };
      this.tabs.push(tab);
      this.onTabsChanged?.();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`retry: 3000\n\ndata: ${JSON.stringify({ tab: tab.id })}\n\n`);
      this.trackStream(req, res);
      res.on('error', () => {});
      const ping = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, WEB_EVENT_HEARTBEAT_MS);
      this.timers.add(ping);
      res.on('close', () => {
        clearInterval(ping); this.timers.delete(ping);
        this.tabs = this.tabs.filter(t => t !== tab);
        this.onTabsChanged?.();
      });
      return;
    }
    if (req.method !== 'POST') throw new WebError(405, 'Method not allowed');
    const msg = await this.readJson(req);
    if (typeof msg.focus === 'number') {
      const tab = this.tabs.find(t => t.id === msg.focus && t.instance === instance && t.session === this.sessions.get(req)!.id);
      if (tab) tab.focusedAt = Date.now();
      res.writeHead(204); res.end(); return;
    }
    if (instance && typeof msg.navigate === 'string') {
      res.writeHead(200, { 'Content-Type': TYPES['.json'] });
      res.end(JSON.stringify({ tab: this.navigate(instance, msg.navigate) })); return;
    }
    throw new WebError(400, 'Expected {focus}, or an instance-scoped {navigate}.');
  }
  private streamWatch(instanceDir: string, req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    this.trackStream(req, res);
    const emit = (chunk: string) => {
      if (!this.options.auth.session(this.sessions.get(req)!.id)) { res.end('event: auth-expired\ndata: {}\n\n'); return; }
      if (!res.destroyed) res.write(chunk);
    };
    res.on('error', () => {});

    const pending = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const watcher = watch(instanceDir, { recursive: true }, (_event, filename) => {
      // A null filename means "something changed" — forwarded as an empty
      // array; the app answers with a plain light check.
      if (filename != null) pending.add(filename.split(path.sep).join('/'));
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const paths = [...pending];
        pending.clear();
        emit(`data: ${JSON.stringify(paths)}\n\n`);
      }, WEB_CHANGE_DEBOUNCE_MS);
    });
    // FSWatcher 'error' (dir deleted, EMFILE) is an uncaught exception without
    // a listener — end this stream instead of taking down the process; the
    // client's authenticated stream retries when the directory returns.
    watcher.on('error', () => {
      watcher.close();
      this.watchers.delete(watcher);
      res.end();
    });
    this.watchers.add(watcher);
    const ping = setInterval(() => emit(': ping\n\n'), WEB_EVENT_HEARTBEAT_MS);
    this.timers.add(ping);
    res.on('close', () => {
      watcher.close();
      this.watchers.delete(watcher);
      clearInterval(ping);
      this.timers.delete(ping);
      if (flushTimer) clearTimeout(flushTimer);
    });
  }
}
