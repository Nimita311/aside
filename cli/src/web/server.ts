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
import {resolveInstanceAddress, type AvailableInstance, type InstanceCardSummary} from '../core/catalogue.js';
import {type InstanceRegistration, type PickerKind} from './picker.js';
import { requestOrigin, sameOrigin } from './origin.js';
import type { Backend } from '../mcp/server.js';
import { HttpMcp } from '../mcp/http.js';
import { assertManagedPath, isManagedInstancePath } from '../core/managed-path.js';
import { assertWebappSidebar, SidebarConflictError } from '../core/webapp-config.js';
import type { WebappSidebarSection } from '../core/types.js';
import { errorMessage } from '../core/error.js';

// The application shell runs scripts only from the daemon's own assets, so
// sanitizer-escaping record content cannot execute as the app. Authored media
// and embeds keep their http(s) destinations; previews are separate documents.
export const APP_SHELL_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:", "media-src 'self' blob: https: http:", "frame-src 'self' blob: https: http:",
  "connect-src 'self'", "font-src 'self' data: blob:", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
export interface WebBackend {
  instances(): AvailableInstance[];
  summary?(path: string): InstanceCardSummary | undefined;
  register(selection: InstanceRegistration): Promise<AvailableInstance | null>;
  pick?(kind: PickerKind): Promise<string | null>;
  remove(path: string, clearCache?: boolean): void | Promise<void>;
  load(path: string): void;
  data(path: string, refresh: boolean): Promise<DataSnapshot>;
  mcp?: () => Backend;
  query?(path: string, args: GraphQLArgs, signal: AbortSignal): Promise<GraphQLResult>;
  updateSidebar?(path: string, sidebar: WebappSidebarSection[], expectedSidebar: WebappSidebarSection[]): Promise<void>;
  years?(path: string): readonly string[];
  subscribe?(path: string, changed: () => void): () => void;
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

interface Tab { id: number; res: ServerResponse; focusedAt: number; instance: string | null }

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
  private mcp?: HttpMcp;
  onTabsChanged: (() => void) | undefined;

  private constructor(private readonly server: http.Server, port: number,
    private appDir: string, private readonly backend: WebBackend) {
    this.port = port;
    if (backend.mcp) this.mcp = new HttpMcp(backend.mcp);
  }

  get origin(): string { return `http://localhost:${this.port}`; }

  static start(appDir: string, backend: WebBackend, port: number): Promise<AsideWebServer | null> {
    return new Promise((resolve, reject) => {
      const httpServer = http.createServer();
      let server: AsideWebServer;
      httpServer.on('request', (req, res) => {
        void server.handle(req, res).catch((error: unknown) => {
          if (res.destroyed) return;
          if (res.headersSent) { res.end(); return; }
          const e = error instanceof WebError ? error : new WebError(500, error instanceof Error ? error.message : 'Internal error');
          res.writeHead(e.status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: e.message, ...(e.paths ? { paths: e.paths } : {}) }));
        });
      });
      httpServer.once('error', (err: NodeJS.ErrnoException) => err.code === 'EADDRINUSE' ? resolve(null) : reject(err));
      httpServer.listen(port, '127.0.0.1', () => {
        server = new AsideWebServer(httpServer, (httpServer.address() as { port: number }).port, appDir, backend);
        resolve(server);
      });
    });
  }

  setAppDir(appDir: string): void { this.appDir = appDir; }

  private openStream(_req: IncomingMessage, res: ServerResponse, first = ''): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 3000\n\n${first}`);
    res.on('error', () => {});
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
    const tab = this.tabs.filter(t => !t.res.destroyed && t.instance === instancePath)
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
    void this.mcp?.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status: number, body: string | Buffer, type = 'text/plain') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const json = (body: unknown) => send(200, JSON.stringify(body), TYPES['.json']);
    let origin: string;
    try { origin = requestOrigin(req); } catch { return send(403, 'Forbidden'); }
    if (!sameOrigin(req, origin)) return send(403, 'Forbidden');
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname === '/mcp' && this.mcp) return this.mcp.handle(req, res, origin);
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
    const writable = req.method === 'POST';
    if (writable && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return send(403, 'Forbidden');
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
      if (msg.clearCache !== undefined && typeof msg.clearCache !== 'boolean') throw new WebError(400, 'clearCache must be a boolean.');
      // IDs may be duplicated; the canonical path identifies the registration
      // whose removal policy the daemon applies (a primary includes worktrees).
      if (!this.backend.instances().some(instance => instance.path === msg.path)) throw new WebError(404, 'This instance is no longer in the list.');
      await this.backend.remove(msg.path, msg.clearCache);
      return json({ instances: this.catalogue() });
    }
    if (rel === '-/api/control') {
      return this.handleControl(null, req, res);
    }
    const match = rel.match(/^-\/api\/instances\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const instance = this.instance(match[1]);
      const endpoint = match[2] ?? '';
      if (endpoint === 'sidebar') {
        if (!writable) return send(405, 'Method not allowed');
        if (!this.backend.updateSidebar) throw new WebError(503, 'Sidebar updates are unavailable.');
        const input = await this.readJson(req);
        let sidebar: WebappSidebarSection[], expectedSidebar: WebappSidebarSection[];
        try {
          if (Object.keys(input).some(key => !['sidebar', 'expectedSidebar'].includes(key)) || !Object.hasOwn(input, 'sidebar')
            || !Object.hasOwn(input, 'expectedSidebar')) throw new Error('Provide sidebar and expectedSidebar declarations.');
          sidebar = assertWebappSidebar(input.sidebar);
          expectedSidebar = assertWebappSidebar(input.expectedSidebar);
        } catch (error) { throw new WebError(400, errorMessage(error)); }
        try { await this.backend.updateSidebar(instance.path, sidebar, expectedSidebar); }
        catch (error) { if (error instanceof SidebarConflictError) throw new WebError(409, error.message); throw error; }
        return json({ sidebar });
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
        if (!this.backend.years) throw new WebError(503, 'Source metadata is unavailable.');
        return json(this.backend.years(instance.path));
      }
      if (endpoint === 'watch') {
        if (req.method !== 'GET') return send(405, 'Method not allowed');
        return this.streamWatch(instance.path, req, res);
      }
      if (endpoint.startsWith('files/')) {
        const file = path.resolve(instance.path, endpoint.slice(6));
        if (!file.startsWith(instance.path + path.sep)) return send(404, 'Not found');
        let real: string;
        try { real = await fs.realpath(file); }
        catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return send(404, 'Not found'); throw error; }
        if (!real.startsWith(instance.path + path.sep)) return send(404, 'Not found');
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
      let body = await tryFile(path.join(this.appDir, 'index.html'));
      const nonce = crypto.randomBytes(24).toString('base64');
      if (body) body = Buffer.from(body.toString().replace('<head>', `<head><meta name="aside-preview-nonce" content="${nonce}">`));
      res.setHeader('Content-Security-Policy', APP_SHELL_CSP.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`));
      res.setHeader('X-Frame-Options', 'DENY');
      if (body !== null) return send(200, body, TYPES['.html']);
    }
    send(404, 'Not found');
  }

  private etag(body: Buffer): string { return `"${crypto.createHash('sha1').update(body).digest('base64url')}"`; }
  private sendFile(req: IncomingMessage, res: ServerResponse, file: string, body: Buffer, etag = this.etag(body)): void {
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  // A request body as text, refused once it exceeds the limit.
  private async readBody(req: IncomingMessage, limit: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) { req.resume(); throw new WebError(413, 'Payload too large'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const body = await this.readBody(req, 64 * 1024);
    try {
      const value: unknown = JSON.parse(body);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new WebError(400, 'Malformed JSON'); }
  }

  private async handleControl(instance: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      const tab: Tab = { id: this.nextTabId++, res, focusedAt: Date.now(), instance };
      this.tabs.push(tab);
      this.onTabsChanged?.();
      this.openStream(req, res, `data: ${JSON.stringify({ tab: tab.id })}\n\n`);
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
      const tab = this.tabs.find(t => t.id === msg.focus && t.instance === instance);
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
    this.openStream(req, res);
    const emit = (chunk: string) => {
      if (!res.destroyed) res.write(chunk);
    };

    const pending = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const changed = (filename?: string) => {
      if (filename !== undefined) pending.add(filename);
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const paths = [...pending]; pending.clear();
        emit(`data: ${JSON.stringify(paths)}\n\n`);
      }, WEB_CHANGE_DEBOUNCE_MS);
    };
    const unsubscribe = this.backend.subscribe?.(instanceDir, () => changed());
    let watcher: FSWatcher;
    try {
      watcher = watch(instanceDir, { recursive: true }, (_event, filename) => {
        // Authored records and root execution configuration are observed by the
        // instance owner. This watcher only refreshes explicitly served raw assets.
        // Managed attachments are still raw assets: retain their exact paths
        // so the browser also invalidates cached files that are off screen.
        if (filename != null && (filename.toLowerCase() === '.aside'
          || (isManagedInstancePath(filename) && filename.split(path.sep).length <= 3))) return;
        changed(filename?.split(path.sep).join('/'));
      });
    } catch (error) {unsubscribe?.(); throw error;}
    // FSWatcher 'error' (dir deleted, EMFILE) is an uncaught exception without
    // a listener — end this stream instead of taking down the process; the
    // client's event stream retries when the directory returns.
    watcher.on('error', () => {
      watcher.close();
      this.watchers.delete(watcher);
      res.end();
    });
    this.watchers.add(watcher);
    const ping = setInterval(() => emit(': ping\n\n'), WEB_EVENT_HEARTBEAT_MS);
    this.timers.add(ping);
    res.on('close', () => {
      unsubscribe?.();
      watcher.close();
      this.watchers.delete(watcher);
      clearInterval(ping);
      this.timers.delete(ping);
      if (flushTimer) clearTimeout(flushTimer);
    });
  }
}
