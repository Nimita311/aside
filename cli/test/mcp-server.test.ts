import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

// Drives the actual committed bundle as an MCP server over stdio, the way a real
// client would, so the create_instance / select_instance tool wiring (and the
// tutorial-instruction append) is exercised end to end rather than only init().
const BUNDLE = join(__dirname, '..', 'dist', 'main.js');

interface ToolReply {
  isError: boolean;
  text: string;
}

// Minimal newline-delimited JSON-RPC client over the server's stdio.
class McpClient {
  private proc: ChildProcess;
  private buf = '';
  private waiters = new Map<number, { resolve: (msg: any) => void; reject: (error: Error) => void }>();
  private id = 0;
  private diagnostics = '';
  private exited = false;

  constructor(cwd: string) {
    this.proc = spawn('node', [BUNDLE, 'mcp', '--legacy'], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    this.proc.stderr!.on('data', data => { this.diagnostics = (this.diagnostics + data.toString()).slice(-8000); });
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      const error = new Error(`MCP process exited (${code ?? signal}): ${this.diagnostics}`);
      for (const waiter of this.waiters.values()) waiter.reject(error);
      this.waiters.clear();
    });
    this.proc.stdout!.on('data', (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && this.waiters.has(msg.id)) {
          this.waiters.get(msg.id)!.resolve(msg);
          this.waiters.delete(msg.id);
        }
      }
    });
  }

  private rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      if (this.exited) { reject(new Error(`MCP process already exited: ${this.diagnostics}`)); return; }
      this.waiters.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async handshake(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  }

  async call(name: string, args: unknown): Promise<ToolReply> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    if (r.error) return { isError: true, text: r.error.message ?? JSON.stringify(r.error) };
    const text = (r.result?.content ?? []).map((c: any) => c.text).join('\n');
    return { isError: !!r.result?.isError, text };
  }

  async tools(): Promise<any[]> {
    const reply = await this.rpc('tools/list', {});
    return reply.result.tools;
  }

  close(): void {
    this.proc.kill();
  }
}

describe.skipIf(!existsSync(BUNDLE))('MCP server (create_instance / select_instance)', () => {
  let root: string;
  let client: McpClient;

  beforeAll(async () => {
    root = join(tmpdir(), `aside-test-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    client = new McpClient(root);
    await client.handshake();
  });

  afterAll(() => {
    client?.close();
    if (root && existsSync(root)) rmSync(root, { recursive: true });
  });

  it('rejects unsupported arguments in no-argument and creation tools', async () => {
    const empty = await client.call('list_instances', { extra: true });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/extra/);
    const dir = join(root, 'rejected-unknown');
    const create = await client.call('create_instance', { path: dir, name: 'Work', description: 'Work', created: '2026-10-04' });
    expect(create.isError).toBe(true);
    expect(create.text).toMatch(/created/);
    expect(existsSync(dir)).toBe(false);
  });

  it('create_instance creates an empty instance, activates it, and omits the file list', async () => {
    const dir = join(root, 'empty');
    const { isError, text } = await client.call('create_instance', { path: dir, name: 'Work Log', description: 'My notes' });
    expect(isError).toBe(false);
    expect(text).toContain('Created and activated');
    expect(text).toContain('Work Log');
    expect(text).toContain('My notes');
    expect(text).not.toContain('Created:');
    expect(text).not.toContain('Tutorial content');
    expect(existsSync(join(dir, 'aside.md'))).toBe(true);
    expect(existsSync(join(dir, 'notes'))).toBe(false);
  });

  it('create_instance --tutorial appends the walkthrough instruction with the project id', async () => {
    const dir = join(root, 'tut');
    const { isError, text } = await client.call('create_instance', { path: dir, name: 'Onboarding', description: 'A start', tutorial: true });
    expect(isError).toBe(false);
    expect(text).toContain('Tutorial content created');
    expect(text).toMatch(/getting-started project \(\d{4}-\d{2}-\d{2}-meet-aside\)/);
    expect(text).toContain('walk the user through it');
    expect(existsSync(join(dir, 'projects'))).toBe(true);
  });

  it('create_instance rejects a path that is already an instance', async () => {
    const dir = join(root, 'dup');
    await client.call('create_instance', { path: dir, name: 'A', description: 'B' });
    const { isError, text } = await client.call('create_instance', { path: dir, name: 'A', description: 'B' });
    expect(isError).toBe(true);
    expect(text).toContain('Already an aside instance');
    expect(text).toContain('Use select_instance');
  });

  it('create_instance rejects a non-empty directory with an actionable message', async () => {
    const dir = join(root, 'nonempty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'x');
    const { isError, text } = await client.call('create_instance', { path: dir, name: 'A', description: 'B' });
    expect(isError).toBe(true);
    expect(text).toContain('already exists and is not empty');
    expect(text).toContain('Choose a different path');
  });

  it('create_instance requires name and description', async () => {
    const { isError, text } = await client.call('create_instance', { path: join(root, 'missing') });
    expect(isError).toBe(true);
    expect(text).toMatch(/name/);
    expect(text).toMatch(/description/);
  });

  it('select_instance rejects a non-instance and points at create_instance', async () => {
    const dir = join(root, 'plain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'readme.md'), 'hi');
    const { isError, text } = await client.call('select_instance', { path: dir });
    expect(isError).toBe(true);
    expect(text).toContain('Not an aside instance');
    expect(text).toContain('Use create_instance');
  });
});

describe.skipIf(!existsSync(BUNDLE))('MCP server (artifacts)', () => {
  let root: string;
  let client: McpClient;

  beforeAll(async () => {
    root = join(tmpdir(), `aside-test-mcp-artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    client = new McpClient(root);
    await client.handshake();
    const created = await client.call('create_instance', {
      path: join(root, 'inst'), name: 'Artifacts', description: 'Durable content',
    });
    expect(created.isError).toBe(false);
  });

  afterAll(() => {
    client?.close();
    // The shared daemon can finish attachment reconciliation while this
    // fixture is removed. Retry transient ENOTEMPTY/EBUSY cleanup failures.
    if (root && existsSync(root)) rmSync(root, { recursive: true, maxRetries: 5, retryDelay: 50 });
  });

  it('registers artifact tools and artifact navigation without changing capture', async () => {
    const tools = await client.tools();
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['create_artifact', 'update_artifact', 'query_artifacts']));
    expect(tools.find(tool => tool.name === 'capture').inputSchema.properties.artifacts).toBeUndefined();
    expect(tools.find(tool => tool.name === 'show').inputSchema.properties.artifact.type).toBe('string');
    expect(tools.find(tool => tool.name === 'show').inputSchema.properties.filename.type).toBe('string');
    for (const name of ['create_artifact', 'update_artifact']) {
      const schema = tools.find(tool => tool.name === name).inputSchema.properties;
      expect(schema.proxy).toBeUndefined();
      expect(schema.attachments).toBeUndefined();
    }
    expect(tools.find(tool => tool.name === 'update_artifact').inputSchema.properties.remove_files.type).toBe('array');
  });

  it('creates, captures a handle inline, queries associations, and updates without changing identity', async () => {
    const source = join(root, 'draft.md');
    const image = join(root, 'desktop.png');
    writeFileSync(source, '# Design review\n\nCurrent proposal.\n');
    writeFileSync(image, Buffer.from([0, 255, 10]));
    const created = await client.call('create_artifact', {
      name: 'Design review', description: 'Current design', body_file: source,
      files: [{ source: image }],
    });
    expect(created.isError).toBe(false);
    const id = created.text.match(/^artifact: #artifact\/(.+)$/m)![1];
    expect(created.text).toContain(`#artifact/${id}/desktop.png`);
    expect(created.text).not.toContain('file:');
    const captured = await client.call('capture', {
      content: `Reviewed #artifact/${id}.`, description: 'Plan review',
      projects: [{ name: 'Design', description: 'Design work' }],
      actions: [{ name: 'Review plan', description: 'Review the design' }],
    });
    expect(captured.isError).toBe(false);
    const project = captured.text.match(/projects_created: \[([^\]]+)\]/)![1];
    const action = captured.text.match(/actions_created: \[([^\]]+)\]/)![1];
    const query = await client.call('query_artifacts', { projects: [project], actions: [action], detail: 'full' });
    expect(query.isError).toBe(false);
    expect(query.text).toContain(`handle: #artifact/${id}`);
    expect(query.text).toContain('# Design review');
    expect(query.text).toContain('backlinks:');
    const update = await client.call('update_artifact', {
      id, name: 'Revised design', description: 'Updated summary',
      body: `![Desktop](#artifact/${id}/desktop.png)`,
    });
    expect(update.isError).toBe(false);
    expect(update.text).toContain(`updated: #artifact/${id}`);
    const latest = await client.call('query_artifacts', { ids: [id], detail: 'full' });
    expect(latest.text).toContain('name: Revised design');
    expect(latest.text).toContain(`![Desktop](#artifact/${id}/desktop.png)`);
    const validation = await client.call('validate', {});
    expect(validation.isError).toBe(false);
    expect(validation.text).not.toContain('FAIL');
  });

  it('selects single binary attachment content and rejects invalid updates as MCP errors', async () => {
    const source = join(root, 'brief.bin');
    writeFileSync(source, Buffer.from([255, 0, 7]));
    const created = await client.call('create_artifact', {
      name: 'Binary brief', description: 'Review brief', files: [{ source }],
    });
    expect(created.isError).toBe(false);
    const id = created.text.match(/^artifact: #artifact\/(.+)$/m)![1];
    expect(created.text).toContain('attachments: [brief.bin]');
    expect(created.text).toContain(`target: #artifact/${id}/brief.bin`);
    const bad = await client.call('update_artifact', { id, remove_files: ['missing.bin'] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('does not exist');
    const restored = await client.call('update_artifact', { id, body: '# Brief' });
    expect(restored.isError).toBe(false);
    expect(existsSync(join(root, 'inst', 'artifacts', id.slice(0, 4), id, 'brief.bin'))).toBe(true);
    const invalid = await client.call('create_artifact', {
      name: 'Rejected imports', description: 'Invalid source', files: [{ source: 'relative.bin' }],
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain('absolute path');
  });
});

describe.skipIf(!existsSync(BUNDLE))('MCP server (Markdown file inputs)', () => {
  let root: string;
  let client: McpClient;

  beforeAll(async () => {
    root = join(tmpdir(), `aside-test-mcp-files-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    client = new McpClient(root);
    await client.handshake();
    const created = await client.call('create_instance', {
      path: join(root, 'inst'), name: 'File imports', description: 'Markdown sources',
    });
    expect(created.isError).toBe(false);
  });

  afterAll(() => {
    client?.close();
    if (root && existsSync(root)) rmSync(root, { recursive: true });
  });

  it('accepts file-only capture and nested sources, then updates all text through file arguments', async () => {
    const source = join(root, 'draft with spaces.md');
    const replacement = join(root, 'replacement.md');
    writeFileSync(source, '# Imported draft\n\nCafé ☕ context.\n');
    writeFileSync(replacement, '# Replacement draft\n\nUpdated from disk.\n');
    const captured = await client.call('capture', {
      content_file: source,
      description: 'Imported entry',
      projects: [{ name: 'Imported Project', description: 'Imported project', body_file: source }],
      actions: [{ name: 'Imported Action', description: 'Imported action', body_file: source }],
    });
    expect(captured.isError).toBe(false);
    const entryId = captured.text.match(/entry: (\S+)/)![1];
    const projectId = captured.text.match(/projects_created: \[(.+)\]/)![1];
    const actionId = captured.text.match(/actions_created: \[(.+)\]/)![1];
    for (const [name, id] of [['query_entries', entryId], ['query_projects', projectId], ['query_actions', actionId]]) {
      const query = await client.call(name, { ids: [id], detail: 'full' });
      expect(query.isError).toBe(false);
      expect(query.text).toContain('  # Imported draft\n  \n  Café ☕ context.');
    }

    const entryUpdate = await client.call('update_entry', {
      id: entryId,
      content_file: replacement,
      projects: [projectId, { name: 'Entry Update Project', description: 'Created in update', body_file: replacement }],
      actions: [actionId, { name: 'Entry Update Action', description: 'Created in update', body_file: replacement }],
    });
    expect(entryUpdate.isError).toBe(false);
    const newProjectId = entryUpdate.text.match(/projects_created: \[(.+)\]/)![1];
    const newActionId = entryUpdate.text.match(/actions_created: \[(.+)\]/)![1];
    expect((await client.call('update_action', { id: actionId, body_file: replacement })).isError).toBe(false);
    expect((await client.call('update_project', { id: projectId, body_file: replacement })).isError).toBe(false);
    for (const [name, ids] of [
      ['query_entries', [entryId]],
      ['query_projects', [projectId, newProjectId]],
      ['query_actions', [actionId, newActionId]],
    ] as const) {
      const query = await client.call(name, { ids, detail: 'full' });
      expect(query.isError).toBe(false);
      expect(query.text).toContain('  # Replacement draft\n  \n  Updated from disk.');
      expect(query.text).not.toContain('Café ☕ context.');
    }
  });

  it('reports omitted capture content and simultaneous source fields instead of creating entities', async () => {
    const source = join(root, 'empty.md');
    writeFileSync(source, '');
    const missing = await client.call('capture', { description: 'Missing source' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Provide either content or content_file');
    const conflict = await client.call('capture', {
      content: '', content_file: source, description: 'Conflicting sources',
      actions: [{ name: 'Conflict Orphan', description: 'Must not be created' }],
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain('Provide either content or content_file, not both');
    const nestedConflict = await client.call('capture', {
      content_file: source, description: 'Nested conflicting sources',
      actions: [{ name: 'Nested Conflict Orphan', description: 'Must not be created', body: '', body_file: source }],
    });
    expect(nestedConflict.isError).toBe(true);
    expect(nestedConflict.text).toContain('Provide either body or body_file, not both');
    const actions = await client.call('query_actions', { search: 'Conflict Orphan', detail: 'full' });
    expect(actions.text).toMatch(/^0 of 0/);
  });
});

describe.skipIf(!existsSync(BUNDLE))('MCP server (agent output contract)', () => {
  let root: string;
  let client: McpClient;

  beforeAll(async () => {
    root = join(tmpdir(), `aside-test-output-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    client = new McpClient(root);
    await client.handshake();
    await client.call('create_instance', { path: join(root, 'inst'), name: 'Output', description: 'Round trips' });
  });

  afterAll(() => {
    client?.close();
    if (root && existsSync(root)) rmSync(root, { recursive: true });
  });

  it('round-trips returned IDs, summaries, relationships, and authored metadata-like text', async () => {
    const capture = await client.call('capture', {
      content: 'A note.\n\nid: authored-example\nfile: authored-path', description: 'Entry summary',
      projects: [{ name: 'Parent output', description: 'Parent summary' }, { name: 'Child output', description: 'Child summary' }],
      actions: [{ name: 'Output action', description: 'Action summary' }],
    });
    expect(capture.isError).toBe(false);
    const entryId = capture.text.match(/^entry: (.+)$/m)![1];
    const projectIds = capture.text.match(/^projects_created: \[(.+)\]$/m)![1].split(', ');
    const actionId = capture.text.match(/^actions_created: \[(.+)\]$/m)![1];
    const entry = await client.call('query_entries', { ids: [entryId], detail: 'full' });
    const returnedId = entry.text.match(/^id: (.+)$/m)![1];
    expect(returnedId).toBe(entryId);
    expect(entry.text).toContain('content: |\n  A note.\n  \n  id: authored-example\n  file: authored-path');
    expect(entry.text.match(/^id: /gm)).toHaveLength(1);
    expect((await client.call('update_entry', { id: returnedId, description: 'Revised entry summary' })).isError).toBe(false);
    const relation = { project: projectIds[1], description: 'Delivery workstream under the parent' };
    const update = await client.call('update_project', { id: projectIds[0], related_projects: [relation], description: 'Revised parent summary' });
    expect(update.text).toContain('Revised parent summary');
    expect(update.text).toContain(relation.description);
    const project = await client.call('query_projects', { ids: [projectIds[0]], detail: 'full' });
    expect(project.text).toContain('Revised parent summary');
    expect(project.text).toContain(relation.project);
    expect(project.text).toContain(relation.description);
    const action = await client.call('update_action', { id: actionId, description: 'Revised action summary' });
    expect(action.text).toContain('Revised action summary');
    expect((await client.call('query_actions', { ids: [actionId], detail: 'full' })).text).toContain('Revised action summary');
  });

  it('returns an explicit next offset and stops on both the final and exhausted pages', async () => {
    const first = await client.call('query_projects', { limit: 1 });
    expect(first.text).toMatch(/^1 of 2/);
    expect(first.text).toMatch(/^next_offset: 1$/m);
    const last = await client.call('query_projects', { limit: 1, offset: 1 });
    expect(last.text).toMatch(/^1 of 2/);
    expect(last.text).toMatch(/^next_offset: null$/m);
    const exhausted = await client.call('query_projects', { limit: 1, offset: 2 });
    expect(exhausted.text).toMatch(/^0 of 2/);
    expect(exhausted.text).toMatch(/^next_offset: null$/m);
  });

  it('returns errors for malformed dates, reversed ranges, and noninteger pagination', async () => {
    for (const args of [
      { created_from: 'today' }, { created_to: '2026-02-30' },
      { created_from: '2026-05-02', created_to: '2026-05-01' },
      { offset: 0.5 }, { offset: -1 }, { limit: 1.5 }, { limit: 0 }, { limit: 101 },
    ]) {
      for (const tool of ['query_entries', 'query_actions', 'query_projects', 'query_artifacts']) {
        expect((await client.call(tool, args)).isError, `${tool}: ${JSON.stringify(args)}`).toBe(true);
      }
    }
  });
});

// The unsynced-action reminder is gated on the calendar helper being present, which
// resolveCalBin only honors on darwin. Point ASIDE_CAL_BIN at a fake helper that
// answers each request with a canned response and records it (JSON per line) for
// assertions, so both the reminder paths and the forward-sync wiring are testable.
const CAL_OK = process.platform === 'darwin' && existsSync(BUNDLE);
describe.skipIf(!CAL_OK)('MCP server (calendar wiring)', () => {
  let root: string;
  let stub: string;
  let rec: string;
  let prevBin: string | undefined;
  let prevHome: string | undefined;
  let client: McpClient;

  function calRequests(): Array<Record<string, any>> {
    if (!existsSync(rec)) return [];
    return readFileSync(rec, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  beforeAll(async () => {
    root = join(tmpdir(), `aside-test-cal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    rec = join(root, 'cal-requests.jsonl');
    stub = join(root, 'aside-cal-stub.cjs');
    buildSync({ stdin: { contents: `#!/usr/bin/env node
import { savedEvent } from ${JSON.stringify(join(__dirname, 'calendar-fixture.ts'))};
const R = {
  'auth-status': { ok: true, result: { status: 'fullAccess' } },
  'list-calendars': { ok: true, result: { calendars: [{ id: 'c1', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] } },
};
// Retain real saved definitions and stable IDs: forward confirmation, later
// sweeps, title updates and marker-guarded removals all see the same events.
const events = new Map();
let sequence = 0;
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  require('fs').appendFileSync(${JSON.stringify(rec)}, JSON.stringify(msg) + '\\n');
  let r;
  if (msg.cmd === 'upsert-event') {
    const eventId = msg.eventId || [...events.values()].find(event => event.url === msg.marker)?.id || 'ev-' + ++sequence;
    events.set(eventId, savedEvent({ ...msg, calendar_account: msg.calendar_account ?? 'iCloud' }, eventId));
    r = { ok: true, result: { eventId } };
  } else if (msg.cmd === 'get-events') {
    r = { ok: true, result: { events: msg.eventIds.flatMap(id => events.has(id) ? [events.get(id)] : []) } };
  } else if (msg.cmd === 'list-events') {
    r = { ok: true, result: { events: [...events.values()].filter(event =>
      (!msg.calendars || msg.calendars.includes(event.calendar)) &&
      event.startInstant < new Date(msg.end).getTime() && event.endInstant >= new Date(msg.start).getTime()) } };
  } else if (msg.cmd === 'delete-event') {
    r = { ok: true, result: { deleted: events.get(msg.eventId)?.url === msg.marker && events.delete(msg.eventId) } };
  } else r = R[msg.cmd] || { ok: false, error: 'unknown command: ' + msg.cmd };
  process.stdout.write(JSON.stringify(Object.assign({ id: msg.id }, r)) + '\\n');
});
`, loader: 'js', resolveDir: __dirname }, bundle: true, platform: 'node', format: 'cjs', outfile: stub });
    chmodSync(stub, 0o755);
    prevBin = process.env.ASIDE_CAL_BIN;
    prevHome = process.env.ASIDE_DAEMON_HOME;
    // The helper belongs to the daemon, so this suite runs its own daemon —
    // spawned by the server below, inheriting the stub — rather than the shared one.
    process.env.ASIDE_CAL_BIN = stub;
    process.env.ASIDE_DAEMON_HOME = mkdtempSync('/tmp/aside-test-cal-');
    client = new McpClient(root);
    await client.handshake();
    await client.call('create_instance', { path: join(root, 'inst'), name: 'Cal', description: 'Calendar wiring' });
  });

  afterAll(() => {
    client?.close();
    const home = process.env.ASIDE_DAEMON_HOME!;
    try { execFileSync('node', [BUNDLE, 'daemon', 'stop'], { stdio: 'ignore', timeout: 20_000 }); } catch {}
    rmSync(home, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.ASIDE_CAL_BIN;
    else process.env.ASIDE_CAL_BIN = prevBin;
    process.env.ASIDE_DAEMON_HOME = prevHome;
    if (root && existsSync(root)) rmSync(root, { recursive: true });
  });

  it('renames a calendar-linked action without changing its marker or saved identity', async () => {
    const created = await client.call('capture', {
      content: 'Title update', description: 'Title update',
      actions: [{ name: 'Rename calendar original', description: 'Title update', scheduled: '2026-05-15T09:00', calendar: 'Work' }],
    });
    expect(created.isError).toBe(false);
    const id = created.text.match(/actions_created: \[(.+)\]/)![1];
    const renamed = await client.call('update_action', { id, name: 'Renamed calendar title' });
    expect(renamed.isError).toBe(false);
    expect(renamed.text).toContain(`updated: ${id}`);
    expect(renamed.text).toContain('calendar_sync:');
    const deadline = Date.now() + 4000;
    while (!calRequests().some(r => r.cmd === 'upsert-event' && typeof r.title === 'string' && r.title.endsWith('Renamed calendar title')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const renamedRequest = calRequests().find(r => r.cmd === 'upsert-event' && typeof r.title === 'string' && r.title.endsWith('Renamed calendar title'));
    expect(renamedRequest).toBeDefined();
    expect(renamedRequest!.marker).toContain(`/action/${id}`);
    const queried = await client.call('query_actions', { ids: [id], detail: 'metadata' });
    expect(queried.text).toContain('name: Renamed calendar title');
    expect(queried.text).toContain(`/actions/${id.slice(0, 4)}/${id}.md`);
  });

  it('reminds when a captured action is scheduled with no calendar', async () => {
    const { isError, text } = await client.call('capture', {
      content: 'ship it',
      description: 'Shipping it',
      actions: [{ name: 'Deploy DB', description: 'Deploy the database', scheduled: '2026-05-15T10:00' }],
    });
    expect(isError).toBe(false);
    const id = text.match(/actions_created: \[(.+)\]/)![1];
    expect(text).toContain('Scheduled without a calendar (not synced):');
    expect(text).toContain(id);
  });

  it('does not remind when the scheduled action names a calendar', async () => {
    const { text } = await client.call('capture', {
      content: 'ship it',
      description: 'Shipping it',
      actions: [{ name: 'Deploy API', description: 'Deploy the API', scheduled: '2026-05-15T11:00', calendar: 'Work' }],
    });
    expect(text).not.toContain('Scheduled without a calendar');
    expect(text).toContain('calendar_sync:');
    expect(text).toContain('status: pending');
  });

  it('does not remind for a backlog action with no scheduled time', async () => {
    const { text } = await client.call('capture', {
      content: 'someday',
      description: 'Someday maybe',
      actions: [{ name: 'Refactor parser', description: 'Refactor the parser' }],
    });
    expect(text).not.toContain('Scheduled without a calendar');
  });

  it('reminds when an update_entry-created action is scheduled with no calendar', async () => {
    const cap = await client.call('capture', { content: 'kick off', description: 'Kicking off' });
    const entryId = cap.text.match(/entry: (\S+)/)![1];
    const { isError, text } = await client.call('update_entry', {
      id: entryId,
      actions: [{ name: 'Write Runbook', description: 'Document the steps', scheduled: '2026-05-16T10:00' }],
    });
    expect(isError).toBe(false);
    const id = text.match(/actions_created: \[(.+)\]/)![1];
    expect(text).toContain('Scheduled without a calendar (not synced):');
    expect(text).toContain(id);
  });

  it('forward-syncs an update_entry-created action that names a calendar', async () => {
    const source = join(root, 'cutover-notes.md');
    writeFileSync(source, 'Imported calendar notes from Markdown.');
    const cap = await client.call('capture', { content: 'plan the cutover', description: 'Cutover planning' });
    const entryId = cap.text.match(/entry: (\S+)/)![1];
    const { isError, text } = await client.call('update_entry', {
      id: entryId,
      actions: [{ name: 'Cutover Rehearsal', description: 'Dry-run the cutover', body_file: source, scheduled: '2026-05-18T10:00', calendar: 'Work' }],
    });
    expect(isError).toBe(false);
    const id = text.match(/actions_created: \[(.+)\]/)![1];
    expect(text).not.toContain('Scheduled without a calendar');
    // The sync is fire-and-forget: poll until the helper receives the upsert.
    let upsert: Record<string, any> | undefined;
    for (let i = 0; i < 50 && !upsert; i++) {
      upsert = calRequests().find((r) => r.cmd === 'upsert-event' && typeof r.marker === 'string' && r.marker.endsWith(`/action/${id}`));
      if (!upsert) await new Promise((r) => setTimeout(r, 100));
    }
    expect(upsert?.calendar).toBe('Work');
    expect(upsert?.start).toBe('2026-05-18T10:00');
    expect(upsert?.notes).toContain('Imported calendar notes from Markdown.');
    const synced = new RegExp(`id: ${id}\\n    status: synced`);
    let state = await client.call('calendar_info', {});
    for (let i = 0; i < 50 && !synced.test(state.text); i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      state = await client.call('calendar_info', {});
    }
    expect(state.text).toContain('calendar_sync:');
    expect(state.text).toContain(id);
    expect(state.text).toMatch(synced);

    writeFileSync(source, 'Updated calendar notes from Markdown.');
    const updated = await client.call('update_action', { id, body_file: source });
    expect(updated.isError).toBe(false);
    let updatedUpsert: Record<string, any> | undefined;
    for (let i = 0; i < 50 && !updatedUpsert; i++) {
      updatedUpsert = calRequests().find((r) => r.cmd === 'upsert-event'
        && typeof r.marker === 'string' && r.marker.endsWith(`/action/${id}`)
        && r.notes?.includes('Updated calendar notes from Markdown.'));
      if (!updatedUpsert) await new Promise((r) => setTimeout(r, 100));
    }
    expect(updatedUpsert?.notes).toContain('Updated calendar notes from Markdown.');
    expect(updatedUpsert?.notes).not.toContain('Imported calendar notes from Markdown.');
  });

  it('warns that calendar sync is disabled when the instance has no id', async () => {
    // A manifest with no `id` can't anchor markers — the failure must surface, not
    // be worked around. (Restores the active instance afterward.)
    const legacy = join(root, 'legacy');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'aside.md'), '---\nname: Legacy\ndescription: no id here\n---\n');
    await client.call('select_instance', { path: legacy });
    const { text } = await client.call('capture', {
      content: 'ship it',
      description: 'Shipping it',
      actions: [{ name: 'Deploy', description: 'Deploy it', scheduled: '2026-05-15T10:00', calendar: 'Work' }],
    });
    expect(text).toContain('Calendar sync is disabled');
    expect(text).toContain('no `id`');
    expect(text).toContain('status: disabled');
    await client.call('select_instance', { path: join(root, 'inst') });
  });

  it('escapes tolerated multiline action IDs in update and calendar receipts', async () => {
    const instance = join(root, 'multiline-id');
    const year = join(instance, 'actions', '2026');
    mkdirSync(year, { recursive: true });
    writeFileSync(join(instance, 'aside.md'), '---\nid: multiline-id-fixture\nname: Tolerated IDs\ndescription: Receipt framing\n---\n');
    const id = '2026-05-15-real\nid: forged';
    writeFileSync(join(year, `${id}.md`), '---\nname: Tolerated action\ncreated: 2026-05-15T10:00\nscheduled: 2026-05-15T10:00\n---\n');
    writeFileSync(join(year, 'index.yaml'), `- id: ${JSON.stringify(id)}\n  description: Initial summary\n`);
    try {
      expect((await client.call('select_instance', { path: instance })).isError).toBe(false);
      const metadata = await client.call('query_actions', { ids: [id], detail: 'metadata' });
      const returnedId: string = JSON.parse(metadata.text.match(/^id: (.+)$/m)![1]);
      expect(returnedId).toBe(id);
      const updated = await client.call('update_action', { id: returnedId, scheduled: '2026-05-16T10:00', description: 'Revised summary' });
      expect(updated.isError).toBe(false);
      expect(JSON.parse(updated.text.match(/^updated: (.+)$/m)![1])).toBe(id);
      expect(updated.text).toContain(`Scheduled without a calendar (not synced): ${JSON.stringify(id)}.`);
      expect(updated.text).toContain(`calendar_sync:\n  - id: ${JSON.stringify(id)}\n    status: disabled`);
      expect(updated.text.match(/^id: /gm)).toHaveLength(1);
      expect(updated.text).not.toContain('\nid: forged');
    } finally {
      await client.call('select_instance', { path: join(root, 'inst') });
    }
  });

  it('collects a removed active instance before listing without showing its former path', async () => {
    const dir = join(root, 'gc-listing');
    const created = await client.call('create_instance', { path: dir, name: 'GC listing', description: 'Temporary listing check' });
    expect(created.isError).toBe(false);
    const canonical = realpathSync(dir);
    try {
      rmSync(dir, { recursive: true });
      const listing = await client.call('list_instances', {});
      expect(listing.isError).toBe(false);
      expect(listing.text).toContain('No active aside instance');
      expect(listing.text).not.toContain(canonical);
      expect(listing.text).not.toContain('GC listing');
      const known = JSON.parse(readFileSync(join(process.env.ASIDE_DAEMON_HOME!, 'known.json'), 'utf8'));
      expect(known).not.toContain(canonical);
    } finally { await client.call('select_instance', { path: join(root, 'inst') }); }
  });

  it('collects cached instance registration when use fails without recreating the directory', async () => {
    const dir = join(root, 'gc-use');
    expect((await client.call('create_instance', { path: dir, name: 'GC use', description: 'Temporary use check' })).isError).toBe(false);
    const canonical = realpathSync(dir);
    try {
      rmSync(dir, { recursive: true });
      const failed = await client.call('capture', { content: 'Must not recreate this directory', description: 'Failed use' });
      expect(failed.isError).toBe(true);
      expect(existsSync(dir)).toBe(false);
      const known = JSON.parse(readFileSync(join(process.env.ASIDE_DAEMON_HOME!, 'known.json'), 'utf8'));
      expect(known).not.toContain(canonical);
      const listing = await client.call('list_instances', {});
      expect(listing.text).toContain('No active aside instance');
      expect(listing.text).not.toContain(canonical);
    } finally { await client.call('select_instance', { path: join(root, 'inst') }); }
  });

  it('reports pending event removal when clearing a calendar on a scheduled action', async () => {
    const capture = await client.call('capture', {
      content: 'Stop routing this action', description: 'Calendar routing',
      actions: [{ name: 'Calendar removal', description: 'Remove its event', scheduled: '2026-05-19T10:00', calendar: 'Work' }],
    });
    const id = capture.text.match(/actions_created: \[(.+)\]/)![1];
    const synced = new RegExp(`id: ${id}\\n    status: synced`);
    let info = '';
    for (let i = 0; i < 50; i++) {
      info = (await client.call('calendar_info', {})).text;
      if (synced.test(info)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(info).toMatch(synced);
    const updated = await client.call('update_action', { id, calendar: null });
    expect(updated.isError).toBe(false);
    expect(updated.text).toMatch(new RegExp(`id: ${id}\\n    status: pending`));
    const removed = new RegExp(`id: ${id}\\n    status: removed`);
    for (let i = 0; i < 50; i++) {
      info = (await client.call('calendar_info', {})).text;
      if (removed.test(info)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(info).toMatch(removed);
  });
});
