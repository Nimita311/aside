import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import {DaemonClient} from '../src/daemon/client.js';
import {daemonPaths} from '../src/daemon/paths.js';

// Drives the actual committed bundle as an MCP server over stdio, the way a real
// client would, so the createInstance / selectInstance mutations (and the
// tutorial project) are exercised end to end rather than only init().
const BUNDLE = join(__dirname, '..', 'dist', 'main.js');

interface ToolReply {
  isError: boolean;
  text: string;
}

interface GraphQLReply extends ToolReply {
  data: any;
  errors?: Array<{message: string}>;
  extensions: any;
}

// Minimal newline-delimited JSON-RPC client over the server's stdio.
class McpClient {
  private proc: ChildProcess;
  private buf = '';
  private waiters = new Map<number, { resolve: (msg: any) => void; reject: (error: Error) => void }>();
  private id = 0;
  private diagnostics = '';
  private exited = false;

  constructor(cwd: string, env?: NodeJS.ProcessEnv) {
    this.proc = spawn('node', [BUNDLE, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd, env });
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

  private async graphql(name: 'query' | 'mutate', document: string, variables?: Record<string, unknown>): Promise<GraphQLReply> {
    const reply = await this.call(name, { document, ...(variables ? { variables } : {}) });
    return { ...reply, ...JSON.parse(reply.text) };
  }

  query(document: string, variables?: Record<string, unknown>): Promise<GraphQLReply> {
    return this.graphql('query', document, variables);
  }

  mutate(document: string, variables?: Record<string, unknown>): Promise<GraphQLReply> {
    return this.graphql('mutate', document, variables);
  }

  close(): void {
    this.proc.kill();
  }
}

const CREATE_INSTANCE = 'mutation($input: CreateInstanceInput!) { createInstance(input: $input) { error tutorialProjectId instance { name description path active } } }';
const SELECT_INSTANCE = 'mutation($path: String!) { selectInstance(path: $path) { error instance { path } } }';
const CAPTURE = 'mutation($input: CaptureInput!) { capture(input: $input) { error entry { id } createdProjects { id } createdActions { id } } }';
const UPDATE_ENTRY = 'mutation($id: ID!, $input: UpdateEntryInput!) { updateEntry(id: $id, input: $input) { error createdProjects { id } createdActions { id } } }';
const UPDATE_ACTION = 'mutation($id: ID!, $input: UpdateActionInput!) { updateAction(id: $id, input: $input) { error action { id name description } } }';
const UPDATE_PROJECT = 'mutation($id: ID!, $input: UpdateProjectInput!) { updateProject(id: $id, input: $input) { error project { id description } } }';
const CREATE_ARTIFACT = 'mutation($input: CreateArtifactInput!) { createArtifact(input: $input) { error artifact { id handle content { ... on Attachment { filename handle } } attachments { filename handle } } } }';
const UPDATE_ARTIFACT = 'mutation($id: ID!, $input: UpdateArtifactInput!) { updateArtifact(id: $id, input: $input) { error artifact { id handle } } }';

describe.skipIf(!existsSync(BUNDLE))('MCP passive worktree discovery', () => {
  it('uses owner-observed families for unregistered candidates without activating them', async () => {
    const root = realpathSync(mkdtempSync('/tmp/aside-mcp-passive-worktrees-'));
    const primary = join(root, 'primary'), linked = join(root, 'linked'), independent = join(root, 'independent');
    const home = mkdtempSync('/tmp/aside-mcp-passive-daemon-');
    const env = {...process.env, ASIDE_DAEMON_HOME: home, ASIDE_CAL_BIN: '/nonexistent/aside-cal'};
    mkdirSync(primary);
    writeFileSync(join(primary, 'aside.md'), '---\nid: shared-worktree\nname: Worktree fixture\n---\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', primary, '-c', 'core.hooksPath=/dev/null', ...args], {stdio: 'pipe'});
    let client: McpClient | undefined;
    try {
      git('init', '-b', 'main'); git('add', '.');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--no-gpg-sign', '-m', 'fixture');
      git('worktree', 'add', '--detach', linked);
      client = new McpClient(root, env);
      await client.handshake();
      const listing = await client.query('{ activeInstance { path } instances { path } }');
      expect(listing.isError).toBe(false);
      expect(listing.data.activeInstance).toBeNull();
      expect(listing.data.instances.map((instance: {path: string}) => instance.path).sort()).toEqual([primary, linked].sort());
      expect(listing.text).not.toContain('Duplicate instance ID');
      const owner = new DaemonClient({paths: daemonPaths({ASIDE_DAEMON_HOME: home})});
      let status: {loaded: string[]; known: string[]};
      try {status = await owner.request('status', undefined, {read: true});} finally {owner.close();}
      expect(status.loaded).toEqual([]);
      expect(status.known).toEqual([]);

      // A genuinely independent copy must still receive the conflict warning.
      client.close(); client = undefined;
      mkdirSync(independent);
      writeFileSync(join(independent, 'aside.md'), '---\nid: shared-worktree\nname: Independent fixture\n---\n');
      client = new McpClient(root, env); await client.handshake();
      const conflict = await client.query('{ instances { path } }');
      expect(conflict.isError).toBe(false);
      expect(conflict.extensions.diagnostics).toContainEqual(expect.objectContaining({code: 'instance_id_conflict',
        message: expect.stringContaining('Duplicate instance ID detected: shared-worktree')}));
    } finally {
      client?.close();
      try {execFileSync('node', [BUNDLE, 'daemon', 'stop', '--force'], {env, stdio: 'ignore', timeout: 20_000});} catch {}
      rmSync(root, {recursive: true, force: true}); rmSync(home, {recursive: true, force: true});
    }
  });
});

describe.skipIf(!existsSync(BUNDLE))('MCP server (createInstance / selectInstance)', () => {
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

  it('rejects unsupported tool arguments and creation fields', async () => {
    const empty = await client.call('query', { document: '{ instances { path } }', extra: true });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/extra/);
    const dir = join(root, 'rejected-unknown');
    const create = await client.mutate('mutation($path: String!) { createInstance(input: {path: $path, name: "Work", description: "Work", created: "2026-10-04"}) { error } }', { path: dir });
    expect(create.isError).toBe(true);
    expect(create.errors![0].message).toMatch(/created/);
    expect(existsSync(dir)).toBe(false);
  });

  it('createInstance creates an empty instance, activates it, and adds no tutorial records', async () => {
    const dir = join(root, 'empty');
    const created = await client.mutate(CREATE_INSTANCE, { input: { path: dir, name: 'Work Log', description: 'My notes' } });
    expect(created.isError).toBe(false);
    expect(created.data.createInstance).toEqual({ error: null, tutorialProjectId: null,
      instance: { name: 'Work Log', description: 'My notes', path: realpathSync(dir), active: true } });
    expect(created.extensions.mutations[0].changes.map((change: {path: string}) => change.path)).toEqual([join(dir, 'aside.md')]);
    expect((await client.query('{ activeInstance { name } projects { totalCount } }')).data).toEqual({ activeInstance: { name: 'Work Log' }, projects: { totalCount: 0 } });
    expect(existsSync(join(dir, 'aside.md'))).toBe(true);
    expect(existsSync(join(dir, 'notes'))).toBe(false);
  });

  it('createInstance with tutorial returns the walkthrough project id', async () => {
    const dir = join(root, 'tut');
    const created = await client.mutate(CREATE_INSTANCE, { input: { path: dir, name: 'Onboarding', description: 'A start', tutorial: true } });
    expect(created.isError).toBe(false);
    const id = created.data.createInstance.tutorialProjectId;
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-meet-aside$/);
    expect((await client.query('query($id: ID!) { project(id: $id) { id } }', { id })).data.project).toEqual({ id });
    expect(existsSync(join(dir, 'projects'))).toBe(true);
  });

  it('createInstance rejects a path that is already an instance', async () => {
    const dir = join(root, 'dup');
    await client.mutate(CREATE_INSTANCE, { input: { path: dir, name: 'A', description: 'B' } });
    const { isError, errors } = await client.mutate(CREATE_INSTANCE, { input: { path: dir, name: 'A', description: 'B' } });
    expect(isError).toBe(true);
    expect(errors![0].message).toContain('Already an aside instance');
    expect(errors![0].message).toContain('Use selectInstance');
  });

  it('createInstance rejects a non-empty directory with an actionable message', async () => {
    const dir = join(root, 'nonempty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'x');
    const { isError, errors } = await client.mutate(CREATE_INSTANCE, { input: { path: dir, name: 'A', description: 'B' } });
    expect(isError).toBe(true);
    expect(errors![0].message).toContain('already exists and is not empty');
    expect(errors![0].message).toContain('Choose a different path');
  });

  it('createInstance requires name and description', async () => {
    const { isError, text } = await client.mutate(CREATE_INSTANCE, { input: { path: join(root, 'missing') } });
    expect(isError).toBe(true);
    expect(text).toMatch(/name/);
    expect(text).toMatch(/description/);
    expect(existsSync(join(root, 'missing'))).toBe(false);
  });

  it('selectInstance rejects a non-instance and points at createInstance', async () => {
    const dir = join(root, 'plain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'readme.md'), 'hi');
    const { isError, errors } = await client.mutate(SELECT_INSTANCE, { path: dir });
    expect(isError).toBe(true);
    expect(errors![0].message).toContain('Not an aside instance');
    expect(errors![0].message).toContain('Use createInstance');
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
    const created = await client.mutate(CREATE_INSTANCE, { input: {
      path: join(root, 'inst'), name: 'Artifacts', description: 'Durable content',
    } });
    expect(created.isError).toBe(false);
  });

  afterAll(() => {
    client?.close();
    // The shared daemon can finish attachment reconciliation while this
    // fixture is removed. Retry transient ENOTEMPTY/EBUSY cleanup failures.
    if (root && existsSync(root)) rmSync(root, { recursive: true, maxRetries: 5, retryDelay: 50 });
  });

  it('exposes artifact operations and artifact navigation without changing capture', async () => {
    const field = (name: string) => `${name}: __type(name: "${name}") { fields { name } inputFields { name type { name kind ofType { name } } } }`;
    const { data } = await client.query(`{ ${['Mutation', 'Query', 'CaptureInput', 'ShowInput', 'CreateArtifactInput', 'UpdateArtifactInput'].map(field).join(' ')} }`);
    const names = (type: {fields: Array<{name: string}>}) => type.fields.map(item => item.name);
    const input = (type: {inputFields: Array<{name: string; type: any}>}, name: string) => type.inputFields.find(item => item.name === name)?.type;
    expect(names(data.Mutation)).toEqual(expect.arrayContaining(['createArtifact', 'updateArtifact']));
    expect(names(data.Query)).toEqual(expect.arrayContaining(['artifact', 'artifacts']));
    expect(input(data.CaptureInput, 'artifacts')).toBeUndefined();
    expect(input(data.ShowInput, 'artifact').name).toBe('ID');
    expect(input(data.ShowInput, 'filename').name).toBe('String');
    for (const type of [data.CreateArtifactInput, data.UpdateArtifactInput]) {
      expect(input(type, 'proxy')).toBeUndefined();
      expect(input(type, 'files')).toBeUndefined();
    }
    expect(input(data.UpdateArtifactInput, 'removeAttachments').kind).toBe('LIST');
  });

  it('creates, captures a handle inline, queries associations, and updates without changing identity', async () => {
    const source = join(root, 'draft.md');
    const image = join(root, 'desktop.png');
    writeFileSync(source, '# Design review\n\nCurrent proposal.\n');
    writeFileSync(image, Buffer.from([0, 255, 10]));
    const created = await client.mutate(CREATE_ARTIFACT, { input: {
      name: 'Design review', description: 'Current design', bodyFile: source,
      attachments: [{ source: image }],
    } });
    expect(created.isError).toBe(false);
    const { id, handle, attachments } = created.data.createArtifact.artifact;
    expect(handle).toBe(`#artifact/${id}`);
    expect(attachments).toEqual([{ filename: 'desktop.png', handle: `#artifact/${id}/desktop.png` }]);
    const captured = await client.mutate(CAPTURE, { input: {
      content: `Reviewed #artifact/${id}.`, description: 'Plan review',
      projects: [{ create: { name: 'Design', description: 'Design work' } }],
      actions: [{ create: { name: 'Review plan', description: 'Review the design' } }],
    } });
    expect(captured.isError).toBe(false);
    const project = captured.data.capture.createdProjects[0].id;
    const action = captured.data.capture.createdActions[0].id;
    const entry = captured.data.capture.entry.id;
    const query = await client.query(`query($project: ID!, $action: ID!) {
      artifacts(where: {projectIds: [$project], actionIds: [$action]}) { nodes { handle content { ... on MarkdownContent { text } } backlinks { nodes { ... on Entry { id } } } } }
    }`, { project, action });
    expect(query.isError).toBe(false);
    expect(query.data.artifacts.nodes).toEqual([{ handle, content: { text: expect.stringContaining('# Design review') }, backlinks: { nodes: [{ id: entry }] } }]);
    const update = await client.mutate(UPDATE_ARTIFACT, { id, input: {
      name: 'Revised design', description: 'Updated summary',
      body: `![Desktop](#artifact/${id}/desktop.png)`,
    } });
    expect(update.isError).toBe(false);
    expect(update.data.updateArtifact.artifact).toEqual({ id, handle });
    const latest = await client.query('query($id: ID!) { artifact(id: $id) { name content { ... on MarkdownContent { text } } } }', { id });
    expect(latest.data.artifact).toEqual({ name: 'Revised design', content: { text: `![Desktop](#artifact/${id}/desktop.png)` } });
    const validation = await client.query('{ activeInstance { validation { passed dataChecksRun } } }');
    expect(validation.isError).toBe(false);
    expect(validation.data.activeInstance.validation).toEqual({ passed: true, dataChecksRun: true });
  });

  it('selects single binary attachment content and rejects invalid updates as MCP errors', async () => {
    const source = join(root, 'brief.bin');
    writeFileSync(source, Buffer.from([255, 0, 7]));
    const created = await client.mutate(CREATE_ARTIFACT, { input: {
      name: 'Binary brief', description: 'Review brief', attachments: [{ source }],
    } });
    expect(created.isError).toBe(false);
    const { id, content, attachments } = created.data.createArtifact.artifact;
    expect(attachments).toEqual([{ filename: 'brief.bin', handle: `#artifact/${id}/brief.bin` }]);
    expect(content).toEqual({ filename: 'brief.bin', handle: `#artifact/${id}/brief.bin` });
    const bad = await client.mutate(UPDATE_ARTIFACT, { id, input: { removeAttachments: ['missing.bin'] } });
    expect(bad.isError).toBe(true);
    expect(bad.errors![0].message).toContain('does not exist');
    const restored = await client.mutate(UPDATE_ARTIFACT, { id, input: { body: '# Brief' } });
    expect(restored.isError).toBe(false);
    expect(existsSync(join(root, 'inst', 'artifacts', id.slice(0, 4), id, 'brief.bin'))).toBe(true);
    const invalid = await client.mutate(CREATE_ARTIFACT, { input: {
      name: 'Rejected imports', description: 'Invalid source', attachments: [{ source: 'relative.bin' }],
    } });
    expect(invalid.isError).toBe(true);
    expect(invalid.errors![0].message).toContain('absolute path');
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
    const created = await client.mutate(CREATE_INSTANCE, { input: {
      path: join(root, 'inst'), name: 'File imports', description: 'Markdown sources',
    } });
    expect(created.isError).toBe(false);
  });

  afterAll(() => {
    client?.close();
    if (root && existsSync(root)) rmSync(root, { recursive: true });
  });

  it('accepts file-only capture and nested sources, then updates all text through file arguments', async () => {
    const source = join(root, 'draft with spaces.md');
    const replacement = join(root, 'replacement.md');
    const imported = '# Imported draft\n\nCafé ☕ context.\n', replaced = '# Replacement draft\n\nUpdated from disk.\n';
    writeFileSync(source, imported);
    writeFileSync(replacement, replaced);
    const captured = await client.mutate(CAPTURE, { input: {
      contentFile: source,
      description: 'Imported entry',
      projects: [{ create: { name: 'Imported Project', description: 'Imported project', bodyFile: source } }],
      actions: [{ create: { name: 'Imported Action', description: 'Imported action', bodyFile: source } }],
    } });
    expect(captured.isError).toBe(false);
    const entryId = captured.data.capture.entry.id;
    const projectId = captured.data.capture.createdProjects[0].id;
    const actionId = captured.data.capture.createdActions[0].id;
    const text = async (entries: string[], projects: string[], actions: string[]) => {
      const query = await client.query(`query($entries: [ID!], $projects: [ID!], $actions: [ID!]) {
        entries(where: {ids: $entries}) { nodes { content } }
        projects(where: {ids: $projects}) { nodes { body } }
        actions(where: {ids: $actions}) { nodes { body } }
      }`, { entries, projects, actions });
      expect(query.isError).toBe(false);
      return [...query.data.entries.nodes.map((node: {content: string}) => node.content),
        ...[...query.data.projects.nodes, ...query.data.actions.nodes].map((node: {body: string}) => node.body)];
    };
    expect(await text([entryId], [projectId], [actionId])).toEqual(Array(3).fill(imported.trimEnd()));

    const entryUpdate = await client.mutate(UPDATE_ENTRY, { id: entryId, input: {
      contentFile: replacement,
      projects: { set: [{ existingId: projectId }, { create: { name: 'Entry Update Project', description: 'Created in update', bodyFile: replacement } }] },
      actions: { set: [{ existingId: actionId }, { create: { name: 'Entry Update Action', description: 'Created in update', bodyFile: replacement } }] },
    } });
    expect(entryUpdate.isError).toBe(false);
    const newProjectId = entryUpdate.data.updateEntry.createdProjects[0].id;
    const newActionId = entryUpdate.data.updateEntry.createdActions[0].id;
    expect((await client.mutate(UPDATE_ACTION, { id: actionId, input: { bodyFile: replacement } })).isError).toBe(false);
    expect((await client.mutate(UPDATE_PROJECT, { id: projectId, input: { bodyFile: replacement } })).isError).toBe(false);
    expect(await text([entryId], [projectId, newProjectId], [actionId, newActionId])).toEqual(Array(5).fill(replaced.trimEnd()));
  });

  it('reports omitted capture content and simultaneous source fields instead of creating entities', async () => {
    const source = join(root, 'empty.md');
    writeFileSync(source, '');
    const missing = await client.mutate(CAPTURE, { input: { description: 'Missing source' } });
    expect(missing.isError).toBe(true);
    expect(missing.errors![0].message).toContain('Provide content or contentFile');
    const conflict = await client.mutate(CAPTURE, { input: {
      content: '', contentFile: source, description: 'Conflicting sources',
      actions: [{ create: { name: 'Conflict Orphan', description: 'Must not be created' } }],
    } });
    expect(conflict.isError).toBe(true);
    expect(conflict.errors![0].message).toContain('Provide either content or contentFile, not both');
    const nestedConflict = await client.mutate(CAPTURE, { input: {
      contentFile: source, description: 'Nested conflicting sources',
      actions: [{ create: { name: 'Nested Conflict Orphan', description: 'Must not be created', body: '', bodyFile: source } }],
    } });
    expect(nestedConflict.isError).toBe(true);
    expect(nestedConflict.errors![0].message).toContain('Provide either body or bodyFile, not both');
    const actions = await client.query('{ actions(where: {regex: "Conflict Orphan"}) { totalCount } }');
    expect(actions.data.actions.totalCount).toBe(0);
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
    await client.mutate(CREATE_INSTANCE, { input: { path: join(root, 'inst'), name: 'Output', description: 'Round trips' } });
  });

  afterAll(() => {
    client?.close();
    if (root && existsSync(root)) rmSync(root, { recursive: true });
  });

  it('round-trips returned IDs, summaries, relationships, and authored metadata-like text', async () => {
    const authored = 'A note.\n\nid: authored-example\nfile: authored-path';
    const capture = await client.mutate(CAPTURE, { input: {
      content: authored, description: 'Entry summary',
      projects: [{ create: { name: 'Parent output', description: 'Parent summary' } }, { create: { name: 'Child output', description: 'Child summary' } }],
      actions: [{ create: { name: 'Output action', description: 'Action summary' } }],
    } });
    expect(capture.isError).toBe(false);
    const entryId = capture.data.capture.entry.id;
    const projectIds = capture.data.capture.createdProjects.map((project: {id: string}) => project.id);
    const actionId = capture.data.capture.createdActions[0].id;
    const entry = await client.query('query($id: ID!) { entry(id: $id) { id content description } }', { id: entryId });
    expect(entry.data.entry).toEqual({ id: entryId, content: authored, description: 'Entry summary' });
    const revised = await client.mutate(UPDATE_ENTRY.replace('error createdProjects { id } createdActions { id }', 'error entry { id description }'), { id: entry.data.entry.id, input: { description: 'Revised entry summary' } });
    expect(revised.isError).toBe(false);
    expect(revised.data.updateEntry.entry).toEqual({ id: entryId, description: 'Revised entry summary' });
    const relation = { project: projectIds[1], description: 'Delivery workstream under the parent' };
    const update = await client.mutate(UPDATE_PROJECT, { id: projectIds[0], input: { relatedProjects: { upsert: [relation] }, description: 'Revised parent summary' } });
    expect(update.data.updateProject.project).toEqual({ id: projectIds[0], description: 'Revised parent summary' });
    const project = await client.query(`query($id: ID!) {
      project(id: $id) { description relatedProjects { nodes { project { id } outgoingDescription } } }
    }`, { id: projectIds[0] });
    expect(project.data.project).toEqual({ description: 'Revised parent summary',
      relatedProjects: { nodes: [{ project: { id: relation.project }, outgoingDescription: relation.description }] } });
    const action = await client.mutate(UPDATE_ACTION, { id: actionId, input: { description: 'Revised action summary' } });
    expect(action.data.updateAction.action).toMatchObject({ id: actionId, description: 'Revised action summary' });
    expect((await client.query('query($id: ID!) { action(id: $id) { description } }', { id: actionId })).data.action.description).toBe('Revised action summary');
  });

  it('reports the page position and stops on both the final and exhausted pages', async () => {
    const pages = await client.query(`{
      first: projects(limit: 1) { count offset totalCount }
      last: projects(limit: 1, offset: 1) { count offset totalCount }
      exhausted: projects(limit: 1, offset: 2) { count offset totalCount nodes { id } }
    }`);
    expect(pages.data).toEqual({
      first: { count: 1, offset: 0, totalCount: 2 },
      last: { count: 1, offset: 1, totalCount: 2 },
      exhausted: { count: 0, offset: 2, totalCount: 2, nodes: [] },
    });
  });

  it('returns errors for malformed dates, reversed ranges, and noninteger pagination', async () => {
    for (const args of [
      'where: {createdFrom: "today"}', 'where: {createdTo: "2026-02-30"}',
      'where: {createdFrom: "2026-05-02", createdTo: "2026-05-01"}',
      'offset: 0.5', 'offset: -1', 'limit: 1.5', 'limit: 0', 'limit: 101',
    ]) {
      for (const field of ['entries', 'actions', 'projects', 'artifacts']) {
        expect((await client.query(`{ ${field}(${args}) { totalCount } }`)).isError, `${field}: ${args}`).toBe(true);
      }
    }
  });
});

// Forward sync is gated on the calendar helper being present, which resolveCalBin
// only honors on darwin. Point ASIDE_CAL_BIN at a fake helper that answers each
// request with a canned response and records it (JSON per line) for assertions.
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

  const syncState = async (id: string): Promise<{id: string; status: string; reason: string | null} | undefined> =>
    (await client.query('{ activeInstance { calendarSync { syncStates { id status reason } } } }')).data.activeInstance.calendarSync.syncStates.find((state: {id: string}) => state.id === id);
  async function waitForSyncState(id: string, status: string): Promise<string | undefined> {
    let state = await syncState(id);
    for (let i = 0; i < 50 && state?.status !== status; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      state = await syncState(id);
    }
    return state?.status;
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
    await client.mutate(CREATE_INSTANCE, { input: { path: join(root, 'inst'), name: 'Cal', description: 'Calendar wiring' } });
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
    const created = await client.mutate(CAPTURE, { input: {
      content: 'Title update', description: 'Title update',
      actions: [{ create: { name: 'Rename calendar original', description: 'Title update', scheduled: '2026-05-15T09:00', calendar: 'Work' } }],
    } });
    expect(created.isError).toBe(false);
    const id = created.data.capture.createdActions[0].id;
    const renamed = await client.mutate(UPDATE_ACTION, { id, input: { name: 'Renamed calendar title' } });
    expect(renamed.isError).toBe(false);
    expect(renamed.data.updateAction.action).toMatchObject({ id, name: 'Renamed calendar title' });
    const deadline = Date.now() + 4000;
    while (!calRequests().some(r => r.cmd === 'upsert-event' && typeof r.title === 'string' && r.title.endsWith('Renamed calendar title')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const renamedRequest = calRequests().find(r => r.cmd === 'upsert-event' && typeof r.title === 'string' && r.title.endsWith('Renamed calendar title'));
    expect(renamedRequest).toBeDefined();
    expect(renamedRequest!.marker).toContain(`/action/${id}`);
    const queried = await client.query('query($id: ID!) { action(id: $id) { name filePath } }', { id });
    expect(queried.data.action.name).toBe('Renamed calendar title');
    expect(queried.data.action.filePath).toContain(`/actions/${id.slice(0, 4)}/${id}.md`);
  });

  it('reports a scheduled action with no calendar as unsynced without a mutation warning', async () => {
    const captured = await client.mutate(CAPTURE, { input: {
      content: 'ship it',
      description: 'Shipping it',
      actions: [{ create: { name: 'Deploy DB', description: 'Deploy the database', scheduled: '2026-05-15T10:00' } }],
    } });
    expect(captured.isError).toBe(false);
    expect(await syncState(captured.data.capture.createdActions[0].id)).toMatchObject({ status: 'DISABLED', reason: 'no calendar' });
    const entry = await client.mutate(CAPTURE, { input: { content: 'kick off', description: 'Kicking off' } });
    const updated = await client.mutate(UPDATE_ENTRY, { id: entry.data.capture.entry.id, input: {
      actions: { add: [{ create: { name: 'Write Runbook', description: 'Document the steps', scheduled: '2026-05-16T10:00' } }] },
    } });
    expect(updated.isError).toBe(false);
    expect(await syncState(updated.data.updateEntry.createdActions[0].id)).toMatchObject({ status: 'DISABLED', reason: 'no calendar' });
  });

  it('tracks a scheduled action that names a calendar', async () => {
    const { isError, data } = await client.mutate(CAPTURE, { input: {
      content: 'ship it',
      description: 'Shipping it',
      actions: [{ create: { name: 'Deploy API', description: 'Deploy the API', scheduled: '2026-05-15T11:00', calendar: 'Work' } }],
    } });
    expect(isError).toBe(false);
    expect(data.capture.error).toBeNull();
    expect(await waitForSyncState(data.capture.createdActions[0].id, 'SYNCED')).toBe('SYNCED');
  });

  it('does not track a backlog action with no scheduled time', async () => {
    const { isError, data } = await client.mutate(CAPTURE, { input: {
      content: 'someday',
      description: 'Someday maybe',
      actions: [{ create: { name: 'Refactor parser', description: 'Refactor the parser' } }],
    } });
    expect(isError).toBe(false);
    expect(await syncState(data.capture.createdActions[0].id)).toBeUndefined();
  });

  it('forward-syncs an updateEntry-created action that names a calendar', async () => {
    const source = join(root, 'cutover-notes.md');
    writeFileSync(source, 'Imported calendar notes from Markdown.');
    const cap = await client.mutate(CAPTURE, { input: { content: 'plan the cutover', description: 'Cutover planning' } });
    const { isError, data } = await client.mutate(UPDATE_ENTRY, { id: cap.data.capture.entry.id, input: {
      actions: { add: [{ create: { name: 'Cutover Rehearsal', description: 'Dry-run the cutover', bodyFile: source, scheduled: '2026-05-18T10:00', calendar: 'Work' } }] },
    } });
    expect(isError).toBe(false);
    const id = data.updateEntry.createdActions[0].id;
    // The sync is fire-and-forget: poll until the helper receives the upsert.
    let upsert: Record<string, any> | undefined;
    for (let i = 0; i < 50 && !upsert; i++) {
      upsert = calRequests().find((r) => r.cmd === 'upsert-event' && typeof r.marker === 'string' && r.marker.endsWith(`/action/${id}`));
      if (!upsert) await new Promise((r) => setTimeout(r, 100));
    }
    expect(upsert?.calendar).toBe('Work');
    expect(upsert?.start).toBe('2026-05-18T10:00');
    expect(upsert?.notes).toContain('Imported calendar notes from Markdown.');
    expect(await waitForSyncState(id, 'SYNCED')).toBe('SYNCED');

    writeFileSync(source, 'Updated calendar notes from Markdown.');
    const updated = await client.mutate(UPDATE_ACTION, { id, input: { bodyFile: source } });
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
    const unidentified = join(root, 'unidentified');
    mkdirSync(unidentified, { recursive: true });
    writeFileSync(join(unidentified, 'aside.md'), '---\nname: Unidentified\ndescription: no id here\n---\n');
    await client.mutate(SELECT_INSTANCE, { path: unidentified });
    try {
      const { data } = await client.mutate(CAPTURE, { input: {
        content: 'ship it',
        description: 'Shipping it',
        actions: [{ create: { name: 'Deploy', description: 'Deploy it', scheduled: '2026-05-15T10:00', calendar: 'Work' } }],
      } });
      const id = data.capture.createdActions[0].id;
      expect(data.capture.error).toContain(`Calendar sync for ${JSON.stringify(id)} is disabled: instance has no id`);
      expect(await waitForSyncState(id, 'DISABLED')).toBe('DISABLED');
      expect((await syncState(id))?.reason).toBe('instance has no id');
      const { issues } = (await client.query('{ activeInstance { calendarSync { issues { id reason } } } }')).data.activeInstance.calendarSync;
      expect(issues).toContainEqual({ id: 'instance', reason: expect.stringContaining('aside.md has no `id` — calendar sync is disabled') });
    } finally {
      await client.mutate(SELECT_INSTANCE, { path: join(root, 'inst') });
    }
  });

  it('preserves tolerated multiline action IDs through updates and calendar state', async () => {
    const instance = join(root, 'multiline-id');
    const year = join(instance, 'actions', '2026');
    mkdirSync(year, { recursive: true });
    writeFileSync(join(instance, 'aside.md'), '---\nid: multiline-id-fixture\nname: Tolerated IDs\ndescription: ID framing\n---\n');
    const id = '2026-05-15-real\nid: forged';
    writeFileSync(join(year, `${id}.md`), '---\nname: Tolerated action\ncreated: 2026-05-15T10:00\nscheduled: 2026-05-15T10:00\n---\n');
    writeFileSync(join(year, 'index.yaml'), `- id: ${JSON.stringify(id)}\n  description: Initial summary\n`);
    try {
      expect((await client.mutate(SELECT_INSTANCE, { path: instance })).isError).toBe(false);
      const metadata = await client.query('query($id: ID!) { action(id: $id) { id } }', { id });
      const returnedId: string = metadata.data.action.id;
      expect(returnedId).toBe(id);
      const updated = await client.mutate(UPDATE_ACTION, { id: returnedId, input: { scheduled: '2026-05-16T10:00', description: 'Revised summary' } });
      expect(updated.isError).toBe(false);
      expect(updated.data.updateAction.action).toMatchObject({ id, description: 'Revised summary' });
      expect(updated.extensions.mutations[0].changes.map((change: {id: string}) => change.id)).toContain(id);
      expect(await syncState(id)).toMatchObject({ id, status: 'DISABLED', reason: 'no calendar' });
    } finally {
      await client.mutate(SELECT_INSTANCE, { path: join(root, 'inst') });
    }
  });

  it('uses registry-owner reconciliation without showing the former active path', async () => {
    const dir = join(root, 'gc-listing');
    const created = await client.mutate(CREATE_INSTANCE, { input: { path: dir, name: 'GC listing', description: 'Temporary listing check' } });
    expect(created.isError).toBe(false);
    const canonical = realpathSync(dir);
    try {
      rmSync(dir, { recursive: true });
      const owner = new DaemonClient();
      try {await owner.request('known.add', {paths: [join(root, 'inst')]});} finally {owner.close();}
      const listing = await client.query('{ activeInstance { path } instances { path name } }');
      expect(listing.isError).toBe(false);
      expect(listing.data.activeInstance).toBeNull();
      expect(listing.text).not.toContain(canonical);
      expect(listing.text).not.toContain('GC listing');
      const known = JSON.parse(readFileSync(join(process.env.ASIDE_DAEMON_HOME!, 'known.json'), 'utf8'));
      expect(known).not.toContain(canonical);
    } finally { await client.mutate(SELECT_INSTANCE, { path: join(root, 'inst') }); }
  });

  it('collects cached instance registration when use fails without recreating the directory', async () => {
    const dir = join(root, 'gc-use');
    expect((await client.mutate(CREATE_INSTANCE, { input: { path: dir, name: 'GC use', description: 'Temporary use check' } })).isError).toBe(false);
    const canonical = realpathSync(dir);
    try {
      rmSync(dir, { recursive: true });
      const failed = await client.mutate(CAPTURE, { input: { content: 'Must not recreate this directory', description: 'Failed use' } });
      expect(failed.isError).toBe(true);
      expect(existsSync(dir)).toBe(false);
      const knownFile = join(process.env.ASIDE_DAEMON_HOME!, 'known.json');
      // Failed use queues owner repair independently of later inspection.
      for (let attempt = 0; attempt < 150 && JSON.parse(readFileSync(knownFile, 'utf8')).includes(canonical); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const known = JSON.parse(readFileSync(knownFile, 'utf8'));
      expect(known).not.toContain(canonical);
      const listing = await client.query('{ activeInstance { path } instances { path } }');
      expect(listing.data.activeInstance).toBeNull();
      expect(listing.text).not.toContain(canonical);
    } finally { await client.mutate(SELECT_INSTANCE, { path: join(root, 'inst') }); }
  });

  it('reports event removal when clearing a calendar on a scheduled action', async () => {
    const capture = await client.mutate(CAPTURE, { input: {
      content: 'Stop routing this action', description: 'Calendar routing',
      actions: [{ create: { name: 'Calendar removal', description: 'Remove its event', scheduled: '2026-05-19T10:00', calendar: 'Work' } }],
    } });
    const id = capture.data.capture.createdActions[0].id;
    expect(await waitForSyncState(id, 'SYNCED')).toBe('SYNCED');
    const updated = await client.mutate(UPDATE_ACTION, { id, input: { calendar: null } });
    expect(updated.isError).toBe(false);
    expect((await syncState(id))?.status).toMatch(/^(PENDING|REMOVED)$/);
    expect(await waitForSyncState(id, 'REMOVED')).toBe('REMOVED');
    expect(calRequests().some(r => r.cmd === 'delete-event' && typeof r.marker === 'string' && r.marker.endsWith(`/action/${id}`))).toBe(true);
  });
});
