import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, realpath, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, context } from 'esbuild';
import { buildOptions } from '../build-config.mjs';
import { iconCataloguePlugin } from './icon-catalogue.mjs';

const mockDir = path.dirname(fileURLToPath(import.meta.url));
const webappDir = path.dirname(mockDir);
const fixtureDir = path.join(mockDir, 'fixtures');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json',
  '.md': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};

async function containedFile(root, relative) {
  if (!relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep)) return null;
  try {
    const real = await realpath(filename);
    if (!real.startsWith(root + path.sep)) return null;
    return { filename: real, body: await readFile(real) };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return null;
    throw error;
  }
}

export async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    if ((bytes += chunk.length) > 65_536) throw Object.assign(new Error('Request exceeds 64 KiB.'), { status: 413 });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(body || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

// Share production's atomic publication and chunk retention so a running
// preview can still load its original lazy modules after a watch rebuild.
export const browserBuildOptions = {
  bundle: true, platform: 'browser', target: 'es2022', sourcemap: true, logLevel: 'silent',
  write: false, metafile: true, plugins: buildOptions.plugins,
};

function send(req, res, status, body = '', type = 'text/plain; charset=utf-8') {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}
function json(req, res, value, status = 200) { send(req, res, status, JSON.stringify(value), MIME['.json']); }
function fail(req, res, status, message) { json(req, res, { error: message }, status); }

function sendFile(req, res, filename, body) {
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 24)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  if (/\.(html?|svg)$/i.test(filename)) res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
  const type = MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
  if (type === 'application/octet-stream') res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filename).replace(/["\r\n]/g, '')}"`);
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, body.length - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start < 0 || start > end || start >= body.length) {
      res.setHeader('Content-Range', `bytes */${body.length}`); return send(req, res, 416, 'Range not satisfiable');
    }
    res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
    res.setHeader('Content-Length', end - start + 1);
    return send(req, res, 206, body.subarray(start, end + 1), type);
  }
  res.setHeader('Content-Length', body.length);
  send(req, res, 200, body, type);
}

/** Isolated fixture server. build:false skips browser bundles for transport tests. */
export async function createMockServer({ port = 24801, host = '127.0.0.1', watch = false, build: buildBrowser = true } = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('The mock server only listens on loopback.');
  const outputDir = path.join(mockDir, '.cache', randomUUID());
  await mkdir(outputDir, { recursive: true });
  const contexts = [];
  let server;
  const sessions = new Map();
  try {
    await build({
      entryPoints: [path.join(mockDir, 'runtime.mjs')], outfile: path.join(outputDir, 'runtime.mjs'),
      bundle: true, platform: 'node', format: 'esm', target: 'node22.12', logLevel: 'silent',
      loader: { '.md': 'text', '.yaml': 'text' },
      inject: [path.join(mockDir, 'node-clock.mjs')],
      banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(import.meta.url);" },
    });
    const runtime = await import(pathToFileURL(path.join(outputDir, 'runtime.mjs')).href);
    if (buildBrowser) {
      const builds = [
        { entryPoints: { app: path.join(webappDir, 'src/app.ts'), style: path.join(webappDir, 'style.css') }, outdir: path.join(outputDir, 'assets'), splitting: true, format: 'esm', chunkNames: 'chunks/[name]-[hash]' },
        { entryPoints: [path.join(webappDir, 'src/iframe-client.ts')], outfile: path.join(outputDir, 'assets/iframe-client.js'), format: 'iife' },
        { entryPoints: [path.join(mockDir, 'environment.ts')], outfile: path.join(outputDir, 'environment.js'), format: 'iife', globalName: 'AsideMock' },
        { entryPoints: [path.join(mockDir, 'gallery/app.ts')], outfile: path.join(outputDir, 'gallery.js'), format: 'esm' },
        { entryPoints: { elements: path.join(mockDir, 'elements/app.ts') }, outdir: path.join(outputDir, 'assets'), splitting: true, format: 'esm', chunkNames: 'chunks/[name]-[hash]', plugins: [iconCataloguePlugin()] },
      ];
      for (const options of builds) {
        const settings = { ...options, ...browserBuildOptions, plugins: [...browserBuildOptions.plugins, ...(options.plugins ?? [])] };
        if (watch) { const ctx = await context(settings); contexts.push(ctx); await ctx.rebuild(); await ctx.watch(); }
        else await build(settings);
      }
    }
    const fixture = name => runtime.loadFixture(name, { fixturesRoot: fixtureDir });
    const faultsFor = session => session.recovered ? {} : session.scenario.faults ?? {};
    const configFor = session => ({ id: session.id, scenario: { ...session.scenario, faults: faultsFor(session) }, theme: session.theme });
    const release = session => { for (const resolve of session.waiters) resolve(); session.waiters.clear(); };
    const hold = (session, res) => new Promise(resolve => {
      const done = () => { session.waiters.delete(done); res.off('close', done); resolve(); };
      session.waiters.add(done); res.once('close', done);
    });
    const catalogue = session => {
      if (faultsFor(session).catalogue === 'empty') return [];
      const rows = runtime.FIXTURE_NAMES.map(name => {
        const snapshot = session.fixtures[name].snapshot;
        const manifest = snapshot.instance?.manifest ?? { id: name, name };
        const projects = new Map(snapshot.projects), actions = new Map(snapshot.actions);
        const { indexes } = snapshot;
        return { id: name, name: manifest.name ?? name, description: manifest.description,
          path: session.fixtures[name].root, address: name,
          summary: { projects: { open: indexes.projects.filter(({ id }) => projects.has(id) && !projects.get(id).frontMatter.ended).length, total: indexes.projects.length },
            actions: { open: indexes.actions.filter(({ id }) => actions.has(id) && !actions.get(id).frontMatter.resolution).length, total: indexes.actions.length },
            entries: indexes.notes.length, latest: indexes.notes[0]?.id, lastEdited: session.scenario.now },
        };
      });
      const base = rows[0];
      const kind = faultsFor(session).catalogue;
      if (kind === 'duplicates') {
        const duplicatePaths = [base.path, '/mock/independent-copy'];
        base.address = `${base.id}~1111111111111111`; base.alias = base.address; base.duplicatePaths = duplicatePaths;
        rows.push({ ...base, name: 'Aurora · independent copy', path: duplicatePaths[1], address: `${base.id}~2222222222222222`, alias: `${base.id}~2222222222222222` });
      }
      if (kind === 'worktrees') {
        const worktree = { root: '/mock/aurora', commonDir: '/mock/aurora/.git', primaryPath: base.path, linked: false, label: 'main' };
        base.worktree = worktree;
        rows.push({ ...base, path: '/mock/aurora-preview', name: 'Aurora preview', address: `${base.id}~3333333333333333`, alias: `${base.id}~3333333333333333`, worktree: { ...worktree, linked: true, label: 'design/aurora-preview' } });
      }
      if (kind === 'warnings') base.calendarWarning = 'Calendar access is unavailable in this demonstration. Your records remain readable.';
      return rows.filter(row => !session.removed.has(row.path));
    };
    const resolveInstance = (session, address) => catalogue(session).find(row => [row.address, row.alias, row.id].includes(address));
    const snapshotFor = (session, name) => {
      const data = structuredClone(session.fixtures[name].snapshot);
      const faults = faultsFor(session);
      if (faults.search) data.searchProgress = { loaded: Math.max(0, data.searchProgress.total - 2), total: data.searchProgress.total, pending: faults.search === 'loading' ? 2 : 0, complete: false, failures: faults.search === 'incomplete' ? ['notes/2026/2026-10-05.md'] : [] };
      if (faults.diagnostics) data.diagnostics.push({ path: 'notes/2026/2026-10-05.md', issues: [], error: 'Demonstration: this week could not be read. Recover the scenario, then retry.' });
      return data;
    };
    const file = async (req, res, session, name, relative) => {
      const faults = faultsFor(session);
      if (relative === 'artifacts/2026/2026-10-12-media/notes.md' && faults.files) {
        return fail(req, res, faults.files === 'missing' ? 404 : 503, 'Demonstration: the selected attachment is unavailable. Recover the scenario, then Retry.');
      }
      const found = await containedFile(session.fixtures[name].root, relative);
      if (!found) return fail(req, res, 404, 'Fixture file not found.');
      return sendFile(req, res, found.filename, found.body);
    };
    const stream = (req, res, session, endpoint) => {
      if (faultsFor(session).connection) return fail(req, res, 503, 'Demonstration: event connection unavailable.');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: auth\ndata: ${JSON.stringify({ expiresAt: new Date(session.scenario.now).getTime() + 86_400_000 })}\n\n`);
      if (endpoint === 'control') res.write('data: {"tab":1}\n\n');
      else res.write('data: []\n\n');
      session.streams.add(res);
      const keepAlive = setInterval(() => { if (!res.destroyed) res.write(': mock heartbeat\n\n'); }, 15_000);
      req.once('close', () => { clearInterval(keepAlive); session.streams.delete(res); });
    };
    server = createServer(async (req, res) => {
      try {
        // No daemon, registry, arbitrary filesystem, or external network access.
        const base = `http://${req.headers.host}`;
        const url = new URL(req.url ?? '/', base);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return fail(req, res, 403, 'Loopback requests only.');
        if (req.headers.origin && req.headers.origin !== base && req.headers.origin !== 'null') return fail(req, res, 403, 'Cross-origin request rejected.');
        const pathname = url.pathname;
        if (pathname === '/favicon.ico') return send(req, res, 204);
        if (pathname === '/__mock/scenarios') return json(req, res, runtime.scenarios);
        if (pathname === '/__mock/session' && req.method === 'POST') {
          const input = await readJson(req);
          const scenario = runtime.scenarios.find(item => item.id === input.scenario);
          if (!scenario) return fail(req, res, 400, 'Unknown mock scenario.');
          if (sessions.size >= 128) {
            const oldest = sessions.values().next().value;
            oldest.recovered = true; release(oldest); for (const connection of oldest.streams) connection.end(); sessions.delete(oldest.id);
          }
          const id = randomUUID();
          const fixtures = Object.fromEntries(await Promise.all(runtime.FIXTURE_NAMES.map(async name => [name, await fixture(name)])));
          const session = { id, scenario, theme: input.theme === 'dark' ? 'dark' : 'light', fixtures, recovered: false,
            key: randomBytes(32).toString('base64url'), waiters: new Set(), streams: new Set(), removed: new Set() };
          sessions.set(id, session);
          const route = new URL(scenario.route, base); route.searchParams.set('mockSession', id);
          return json(req, res, { ...configFor(session), url: route.pathname + route.search });
        }
        const configMatch = /^\/__mock\/session\/([^/]+)(\/recover)?$/.exec(pathname);
        if (configMatch) {
          const session = sessions.get(configMatch[1]);
          if (!session) return fail(req, res, 404, 'Mock session expired. Reset the scenario.');
          if (configMatch[2]) {
            if (req.method !== 'POST') return fail(req, res, 405, 'Use POST.');
            session.recovered = true; release(session);
            for (const response of session.streams) response.write('data: []\n\n');
          }
          return json(req, res, configFor(session));
        }
        if (pathname === '/__mock' || pathname === '/__mock/') {
          return send(req, res, 200, await readFile(path.join(mockDir, 'gallery/index.html')), MIME['.html']);
        }
        if (pathname === '/__mock/style.css') return send(req, res, 200, await readFile(path.join(mockDir, 'gallery/style.css')), MIME['.css']);
        if (pathname === '/__mock/elements/style.css') return send(req, res, 200, await readFile(path.join(mockDir, 'elements/style.css')), MIME['.css']);
        if (pathname === '/__mock/elements/') {
          const session = sessions.get(url.searchParams.get('mockSession'));
          if (!session) { res.writeHead(302, { Location: '/__mock/' }); res.end(); return; }
          if (session.scenario.kind !== 'elements') return fail(req, res, 404, 'This session is not an elements preview.');
          const config = JSON.stringify(configFor(session)).replace(/</g, '\\u003c');
          const html = (await readFile(path.join(mockDir, 'elements/index.html'), 'utf8'))
            .replace('<!-- mock-config -->', `<script>AsideMock.bootstrap(${config});</script>`);
          return send(req, res, 200, html, MIME['.html']);
        }
        const generated = pathname.startsWith('/-/assets/') ? `assets/${pathname.slice(10)}`
          : pathname === '/__mock/environment.js' ? 'environment.js' : pathname === '/__mock/gallery.js' ? 'gallery.js' : null;
        if (generated) {
          const found = await containedFile(outputDir, generated);
          return found ? sendFile(req, res, found.filename, found.body) : fail(req, res, 404, 'Build asset not found.');
        }
        if (pathname.startsWith('/-/files/')) {
          const grant = runtime.parseFileGrantPath(pathname);
          const session = grant && sessions.get(grant.session);
          const instance = session && resolveInstance(session, grant.instance);
          if (!grant || !session || !instance || !runtime.verifyFileGrant(session.key, grant.scope, grant.signature, grant.path)) return fail(req, res, 401, 'Invalid mock file grant.');
          if (!['GET', 'HEAD'].includes(req.method)) return fail(req, res, 405, 'Use GET or HEAD.');
          return file(req, res, session, instance.id, grant.path);
        }
        if (pathname.startsWith('/-/api/')) {
          const headerId = req.headers['x-aside-mock-session'];
          const tokenId = req.headers.authorization?.replace(/^Bearer mock:/, '');
          const session = sessions.get(tokenId ?? headerId);
          if (!session || (tokenId && headerId && tokenId !== headerId)) return fail(req, res, 401, 'Unknown mock session.');
          if (!['GET', 'HEAD', 'POST'].includes(req.method)) return fail(req, res, 405, 'Method not allowed.');
          const faults = faultsFor(session);
          if (pathname === '/-/api/auth') {
            if (faults.auth === 'checking') await hold(session, res);
            if (res.destroyed) return;
            if (faultsFor(session).auth === 'required') return fail(req, res, 401, 'Mock authorization required.');
            if (faultsFor(session).auth === 'offline') return fail(req, res, 503, 'Mock server is unavailable.');
            return json(req, res, { expiresAt: new Date(session.scenario.now).getTime() + 86_400_000 });
          }
          if (pathname === '/-/api/instances') {
            if (faults.catalogue === 'loading') await hold(session, res);
            if (res.destroyed) return;
            if (faultsFor(session).catalogue === 'error') return fail(req, res, 503, 'Demonstration: instance discovery failed.');
            return json(req, res, catalogue(session));
          }
          if (pathname === '/-/api/instances/pick') return json(req, res, { path: session.fixtures.showcase.root });
          if (pathname === '/-/api/instances/register') {
            const input = await readJson(req);
            if (faults.operations === 'error' || !Object.values(session.fixtures).some(item => item.root === input.path)) return fail(req, res, 400, 'Choose one of the gallery fixture directories.');
            session.removed.delete(input.path);
            return json(req, res, { instance: catalogue(session).find(item => item.path === input.path) ?? null });
          }
          if (pathname === '/-/api/instances/remove') {
            const input = await readJson(req);
            if (faults.operations === 'error') return fail(req, res, 503, 'Demonstration: could not forget this instance.');
            session.removed.add(input.path); return json(req, res, { instances: catalogue(session) });
          }
          if (pathname === '/-/api/control') return req.method === 'POST' ? json(req, res, {}) : stream(req, res, session, 'control');
          const api = /^\/-\/api\/instances\/([^/]+)(?:\/(.*))?$/.exec(pathname);
          if (!api) return fail(req, res, 404, 'Unknown mock endpoint.');
          const address = decodeURIComponent(api[1]);
          const instance = resolveInstance(session, address);
          if (!instance) return fail(req, res, 404, 'Fixture instance not found.');
          const endpoint = api[2] ?? '';
          if (!endpoint) {
            if (faults.instance === 'loading') await hold(session, res);
            if (res.destroyed) return;
            if (faultsFor(session).instance === 'error') return fail(req, res, 503, 'Demonstration: the instance could not load. Recover, then Retry.');
            return json(req, res, instance);
          }
          if (endpoint === 'access') return json(req, res, { fileBase: `/-/files/${session.id}/${address}`, fileKey: session.key });
          if (endpoint === 'data') {
            const body = Buffer.from(JSON.stringify(snapshotFor(session, instance.id)));
            return sendFile(req, res, 'snapshot.json', body);
          }
          if (endpoint === 'years') return json(req, res, ['2026']);
          if (endpoint === 'control' || endpoint === 'watch') return req.method === 'POST' ? json(req, res, {}) : stream(req, res, session, endpoint);
          if (endpoint === 'graphql') {
            if (req.method !== 'POST') return fail(req, res, 405, 'Use POST.');
            return json(req, res, await runtime.queryFixture(session.fixtures[instance.id], await readJson(req), session.scenario.now));
          }
          if (endpoint.startsWith('files/')) {
            let relative;
            try { relative = endpoint.slice(6).split('/').map(decodeURIComponent).join('/'); } catch { return fail(req, res, 400, 'Invalid path.'); }
            return file(req, res, session, instance.id, relative);
          }
          return fail(req, res, 404, 'Unknown mock endpoint.');
        }
        // Cold loads use the actual shell and route grammar. Mock setup runs
        // synchronously before the unchanged app module registers its init.
        const session = sessions.get(url.searchParams.get('mockSession'));
        if (!session) { res.writeHead(302, { Location: '/__mock/' }); res.end(); return; }
        const config = JSON.stringify(configFor(session)).replace(/</g, '\\u003c');
        let html = await readFile(path.join(webappDir, 'index.html'), 'utf8');
        html = html.replace('<script type="module" src="/-/assets/app.js"></script>',
          `<script src="/__mock/environment.js"></script>\n<script>AsideMock.bootstrap(${config});</script>\n<script type="module" src="/-/assets/app.js"></script>`);
        send(req, res, 200, html, MIME['.html']);
      } catch (error) { fail(req, res, error.status ?? 500, error.message ?? 'Mock server error.'); }
    });
    server.requestTimeout = 15_000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    const boundPort = server.address().port;
    return {
      port: boundPort, url: `http://${host === '::1' ? '[::1]' : host}:${boundPort}`,
      async close() {
        for (const session of sessions.values()) { release(session); for (const response of session.streams) response.end(); }
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await Promise.all(contexts.map(ctx => ctx.dispose()));
        await rm(outputDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server?.closeAllConnections(); server?.close();
    await Promise.all(contexts.map(ctx => ctx.dispose()));
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf('--port');
  const port = portFlag === -1 ? 24801 : Number(process.argv[portFlag + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Pass --port with an integer from 0 to 65535.');
  const app = await createMockServer({ port, watch: !process.argv.includes('--no-watch') });
  console.log(`Aside Webapp Gallery: ${app.url}/__mock/`);
  console.log('Fixture content reloads on Reset; app and gallery sources rebuild on edits. Ctrl+C to stop.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
