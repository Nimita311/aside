// Install the shared native-fs guard before importing production code. It stays
// inactive during loading; normal feature requests must then use published state.
import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Daemon} from '../src/daemon/daemon.js';
import {InstanceHost} from '../src/daemon/host.js';
import {daemonPaths} from '../src/daemon/paths.js';
import {Store} from '../src/source/store.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {runArtifact} from '../src/commands/artifact.js';
import * as instanceFiles from '../src/core/instance.js';
import {normalizeMutationArguments} from '../src/graphql/inputs.js';
import {prepareAutomationPrompts} from '../src/graphql/automation-prompts.js';
import {SemanticSearchService} from '../src/semantic/search.js';
import {AsideWebServer} from '../src/web/server.js';

const cleanup: Array<() => Promise<void>> = [];
const project = '2026-10-30-owner', artifact = '2026-10-30-instructions', action = '2026-10-30-scheduled';
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
});
afterEach(async () => {
  access.reset();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.useRealTimers();
});

async function fixture(semantic = false) {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-ownership-contract-'));
  const root = join(home, 'data'), manifest = join(root, 'aside.md');
  const projectFile = join(root, 'projects', '2026', `${project}.md`);
  const artifactFile = join(root, 'artifacts', '2026', `${artifact}.md`);
  const actionFile = join(root, 'actions', '2026', `${action}.md`);
  mkdirSync(join(root, 'projects', '2026'), {recursive: true});
  mkdirSync(join(root, 'artifacts', '2026'), {recursive: true});
  mkdirSync(join(root, 'actions', '2026'), {recursive: true});
  const write = (version: string) => {
    writeFileSync(manifest, `---\nid: ownership-contract\nname: ${version} instance\n---\n${version} instructions.\n`);
    writeFileSync(projectFile, `---\nname: ${version} project\ncreated: 2026-10-30T09:00\n---\n${version} project body.\n`);
    writeFileSync(artifactFile, `---\nname: ${version} artifact\ncreated: 2026-10-30T09:00\n---\n${version} artifact body.\n`);
    writeFileSync(actionFile, `---\nname: ${version} action\ncreated: 2026-10-30T09:00\nscheduled: 2099-01-01T09:00\n---\n${version} action body.\n`);
  };
  write('Published');
  writeFileSync(join(root, 'projects', '2026', 'index.yaml'), `- id: ${project}\n  description: Project description\n`);
  writeFileSync(join(root, 'artifacts', '2026', 'index.yaml'), `- id: ${artifact}\n  description: Artifact description\n`);
  writeFileSync(join(root, 'actions', '2026', 'index.yaml'), `- id: ${action}\n  description: Action description\n`);
  writeFileSync(join(root, '.aside'), '{}\n');
  const host = new InstanceHost(new CalClient(null));
  host.configureSources({debounceMs: 60_000, reconciliationIntervalMs: 0});
  const resolveGeneration = vi.fn(async () => ({model: 'ownership-fixture', identity: 'pinned-weights',
    embed: async (texts: string[]) => texts.map(() => [1, 0.5, 0.25]), embedQuery: async () => [1, 0.5, 0.25]}));
  if (semantic) host.configureSemantic({
    service: () => new SemanticSearchService({embedder: {model: 'ownership-fixture', resolveGeneration}, indexRoot: join(home, 'indexes')}),
    reconciliation: {debounceMs: 0, reconciliationIntervalMs: 0},
  });
  const daemon = new Daemon({host, paths: daemonPaths({ASIDE_DAEMON_HOME: join(home, 'daemon')})});
  (daemon as any).known = [root];
  const {store} = host.load(root);
  cleanup.push(async () => {await host.close(); rmSync(home, {recursive: true, force: true});});
  await (host as any).sources.flush();
  if (semantic) await (host as any).reconcileSemantic(store);
  resolveGeneration.mockClear();
  const state = {workspace: [root], encountered: [root], active: root,
    configIssues: [], discovery: false, cwd: home};
  const call = (method: string, params?: unknown) => (daemon as any).dispatch({}, method, params);
  const graphql = (document: string) => call('graphql', {mode: 'query', session: state, args: {document}});
  const rebuild = vi.spyOn(store, 'rebuild');
  const invalidate = vi.spyOn((host as any).sources, 'invalidate');
  const refresh = vi.spyOn((host as any).sources, 'refresh');
  write('Unobserved');
  writeFileSync(join(root, '.aside'), 'execution: [invalid]\n');
  access.protect([root]);
  return {home, root, manifest, projectFile, artifactFile, actionFile, host, store, state, call, graphql,
    rebuild, invalidate, refresh, resolveGeneration};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function expectReadOwnership(f: Fixture): void {
  expect(access.violations).toEqual([]);
  expect(f.rebuild).not.toHaveBeenCalled();
  // A query must not delegate a source scan to a timer or another lifecycle
  // entry point. Teardown would otherwise cancel the work and hide the bypass.
  expect(f.invalidate).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
}
async function attachmentFixture() {
  const f = await fixture();
  access.reset();
  const directory = join(f.root, 'artifacts', '2026', artifact), attachment = join(directory, 'instructions.txt');
  mkdirSync(directory);
  writeFileSync(attachment, 'Published attachment instructions.');
  writeFileSync(join(f.root, '.aside'), '{}\n');
  writeFileSync(f.artifactFile, '---\nname: File instructions\ncreated: 2026-10-30T09:00\n---\n');
  writeFileSync(f.projectFile, `---\nname: Owner project\ncreated: 2026-10-30T09:00\n---\n#artifact/${artifact}/instructions.txt\n`);
  await f.host.data(f.root, true);
  f.rebuild.mockClear(); f.refresh.mockClear(); f.invalidate.mockClear();
  return {...f, directory, attachment};
}
const routes: Array<{name: string; run(f: Fixture): Promise<void>}> = [
  {name: 'GraphQL metadata and record queries', run: async f => {
    const {result} = await f.graphql(`{activeInstance{id name body execution{cwd}} instances{id name} project(id:"${project}"){name body} actions{nodes{name body}}}`);
    expect(result.errors).toBeUndefined();
    expect(result.data).toMatchObject({activeInstance: {name: 'Published instance', body: 'Published instructions.', execution: {cwd: f.root}},
      instances: [{name: 'Published instance'}], project: {name: 'Published project', body: 'Published project body.'},
      actions: {nodes: [{name: 'Published action', body: 'Published action body.'}]}});
  }},
  {name: 'GraphQL regex filters and the artifact operation', run: async f => {
    const {result} = await f.graphql('{activeInstance{name body} projects(where:{regex:"Published"}){nodes{body}} actions(where:{regex:"Published"}){nodes{body}}}');
    const artifacts = await f.call('tool', {instance: f.root, name: 'query_artifacts', args: {detail: 'full', search: 'Published'}});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({activeInstance: {name: 'Published instance', body: 'Published instructions.'},
      projects: {nodes: [{body: 'Published project body.'}]}, actions: {nodes: [{body: 'Published action body.'}]}});
    expect(artifacts.text).toContain('Published artifact body.');
  }},
  {name: 'CLI admission followed by a daemon-backed query', run: async f => {
    // The CLI must verify its explicit --dir before contacting the daemon.
    // Grant that operation alone; the downstream query has no exception.
    const isAsideDir = instanceFiles.isAsideDir;
    const admission = vi.spyOn(instanceFiles, 'isAsideDir').mockImplementation(path => access.allow({
      paths: [f.manifest], operations: ['read'], reason: 'CLI explicit instance admission'}, () => isAsideDir(path)));
    const result = await runArtifact(['query', '--dir', f.root, '--detail', 'full'], f.home,
      (instance, name, args) => f.call('tool', {instance, name, args}));
    expect(result).toContain('Published artifact body.');
    expect(admission).toHaveBeenCalledExactlyOnceWith(f.root);
  }},
  {name: 'browser catalogue, summaries, years, snapshots, and record queries', run: async f => {
    expect(await f.call('instances')).toEqual([expect.objectContaining({name: 'Published instance'})]);
    expect(f.host.summary(f.root)?.projects).toEqual({open: 1, total: 1});
    expect(f.host.years(f.root)).toEqual(['2026']);
    expect(await f.host.data(f.root)).toBeDefined();
    const result = await f.host.webQuery(f.root, {document: `{project(id:"${project}"){name body}}`}, new AbortController().signal);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({project: {name: 'Published project', body: 'Published project body.'}});
  }},
  {name: 'Calendar status', run: async f => {
    const {result: query} = await f.graphql('{systemInfo{calendar{authorization}} activeInstance{calendarSync{syncStates{id status}}}}');
    expect(query.errors).toBeUndefined();
    expect(query.data.systemInfo.calendar.authorization).toBe('UNAVAILABLE');
    expect(query.data.activeInstance.calendarSync.syncStates).toEqual([{id: action, status: 'DISABLED'}]);
  }},
];

describe('shared source ownership contracts', () => {
  it.each(routes)('$name uses published state without source-file access', async ({run}) => {
    const f = await fixture();
    await run(f);
    expectReadOwnership(f);
  });

  it('detects a query that schedules a deferred source refresh even before it reads files', async () => {
    const f = await fixture(), metadata = f.host.metadata.bind(f.host);
    vi.spyOn(f.host, 'metadata').mockImplementationOnce(path => {
      (f.host as any).sources.invalidate(f.store);
      return metadata(path);
    });
    await f.graphql('{activeInstance{name}}');
    expect(access.violations).toEqual([]);
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(() => expectReadOwnership(f)).toThrow();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith(f.store);
  });

  it('keeps semantic retrieval on its published source and model generation without rediscovery', async () => {
    const f = await fixture(true);
    const {result} = await f.graphql('{search(rankBy:{semantic:"project instructions"}){hits{snippet}}}');
    expect(result.errors).toBeUndefined();
    expect(JSON.stringify(result.data)).toContain('Published');
    expect(JSON.stringify(result.data)).not.toContain('Unobserved');
    expect(f.resolveGeneration).not.toHaveBeenCalled();
    expectReadOwnership(f);
  });

  it('builds derived semantic state from published memory while allowing private cache writes', async () => {
    const f = await fixture();
    f.host.configureSemantic({
      service: () => new SemanticSearchService({embedder: {model: 'ownership-fixture', resolveGeneration: f.resolveGeneration},
        indexRoot: join(f.home, 'indexes')}),
      reconciliation: {debounceMs: 0, reconciliationIntervalMs: 0},
    });
    const indexed = await (f.host as any).reconcileSemantic(f.store);
    expect(indexed.sourceVersion).toBe(f.store.getSourceVersion());
    expect(indexed.indexedChunks).toBeGreaterThan(0);
    expect(f.resolveGeneration).toHaveBeenCalledOnce();
    expectReadOwnership(f);
    const {result} = await f.graphql('{search(rankBy:{semantic:"instructions"}){hits{snippet}}}');
    expect(result.errors).toBeUndefined();
    expect(JSON.stringify(result.data)).toContain('Published');
    expect(JSON.stringify(result.data)).not.toContain('Unobserved');
    expectReadOwnership(f);
  });

  it('enforces the same read contract through browser HTTP routes', async () => {
    const f = await fixture();
    vi.useRealTimers();
    const server = (await AsideWebServer.start(join(f.home, 'app'), {
      instances: () => f.host.availableInstances([f.root]), summary: path => f.host.summary(path),
      register: async () => null, remove: () => {}, load: path => {f.host.load(path);},
      years: path => f.host.years(path), data: (path, refresh) => f.host.data(path, refresh),
      query: (path, args, signal) => f.host.webQuery(path, args, signal),
    }, 0))!;
    try {
      const base = `http://127.0.0.1:${server.port}/-/api/instances`;
      for (const suffix of ['', '/ownership-contract', '/ownership-contract/years', '/ownership-contract/data']) {
        const response = await fetch(base + suffix, {});
        expect(response.status).toBe(200);
        const result = await response.json();
        if (!suffix) expect(result).toEqual([expect.objectContaining({name: 'Published instance'})]);
        if (suffix.endsWith('/years')) expect(result).toEqual(['2026']);
      }
      const response = await fetch(`${base}/ownership-contract/graphql`, {method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({query: `{project(id:"${project}"){body}}`}),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({data: {project: {body: 'Published project body.'}}});
      expectReadOwnership(f);
    } finally {server.close();}
  });

  it('adopts disk changes only after the owner refreshes, then returns to source-free reads', async () => {
    const f = await fixture();
    const document = `{activeInstance{name} project(id:"${project}"){body}}`;
    expect((await f.graphql(document)).result.data.activeInstance.name).toBe('Published instance');
    expectReadOwnership(f);
    access.reset();
    await f.host.data(f.root, true);
    expect(f.rebuild).toHaveBeenCalledOnce();
    f.rebuild.mockClear(); f.refresh.mockClear(); f.invalidate.mockClear();
    access.protect([f.root]);
    const {result} = await f.graphql(document);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({activeInstance: {name: 'Unobserved instance'}, project: {body: 'Unobserved project body.'}});
    expectReadOwnership(f);
  });

  it.each(['deleted', 'symlinked'] as const)('keeps attachment metadata and references published after an unobserved %s attachment', async change => {
    const f = await attachmentFixture();
    rmSync(f.attachment);
    if (change === 'symlinked') {
      const external = join(f.home, 'external-instructions.txt');
      writeFileSync(external, 'Unobserved external attachment bytes.');
      symlinkSync(external, f.attachment);
    }
    access.protect([f.root]);
    const document = `{
      artifact(id: "${artifact}") {
        content { ... on Attachment { filename filePath error backlinks { totalCount } } }
        attachments { filename filePath error backlinks { totalCount } }
      }
      project(id: "${project}") { attachmentLinks { totalCount nodes { filename filePath } } links { totalCount } }
    }`;
    const {result} = await f.graphql(document);
    expect(result.errors).toBeUndefined();
    const metadata = {filename: 'instructions.txt', filePath: f.attachment, error: null, backlinks: {totalCount: 1}};
    expect(result.data).toEqual({artifact: {content: metadata, attachments: [metadata]},
      project: {attachmentLinks: {totalCount: 1, nodes: [{filename: 'instructions.txt', filePath: f.attachment}]}, links: {totalCount: 0}}});
    const queried = await f.call('tool', {instance: f.root, name: 'query_artifacts', args: {ids: [artifact], detail: 'full'}});
    expect(queried.text).toContain(`    path: ${f.attachment}`);
    expectReadOwnership(f);
    access.reset(); await f.host.data(f.root, true);
    expect(f.rebuild).toHaveBeenCalledOnce();
    f.rebuild.mockClear(); f.refresh.mockClear(); f.invalidate.mockClear(); access.protect([f.root]);
    const {result: refreshed} = await f.graphql(document);
    expect(refreshed.errors).toBeUndefined();
    expect(refreshed.data).toEqual({artifact: {content: null, attachments: []},
      project: {attachmentLinks: {totalCount: 0, nodes: []}, links: {totalCount: 0}}});
    expect(refreshed.extensions.diagnostics).toContainEqual(expect.objectContaining({
      message: expect.stringContaining(`#artifact/${artifact}/instructions.txt`),
    }));
    expectReadOwnership(f);
  });

  it('allows only the requested raw attachment and its path checks when serving bytes', async () => {
    const f = await attachmentFixture();
    vi.useRealTimers();
    access.protect([f.root]);
    await access.allow({paths: [join(f.root, 'artifacts'), join(f.root, 'artifacts', '2026'), f.directory, f.attachment],
      operations: ['read'], reason: 'Serve the explicitly requested attachment bytes with managed-path checks'}, async () => {
      const server = (await AsideWebServer.start(join(f.home, 'app'), {
        instances: () => f.host.availableInstances([f.root]), summary: path => f.host.summary(path),
        register: async () => null, remove: () => {}, load: path => {f.host.load(path);},
        years: path => f.host.years(path), data: (path, refresh) => f.host.data(path, refresh),
        query: (path, args, signal) => f.host.webQuery(path, args, signal),
      }, 0))!;
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/-/api/instances/ownership-contract/files/artifacts/2026/${artifact}/instructions.txt`,
          {});
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('Published attachment instructions.');
      } finally {server.close();}
    });
    expectReadOwnership(f);
    const {result} = await f.graphql(`{artifact(id:"${artifact}"){attachments{filename filePath}}}`);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({artifact: {attachments: [{filename: 'instructions.txt', filePath: f.attachment}]}});
    expectReadOwnership(f);
  });

  it('allows an exact prompt attachment and its containment checks without allowing authored record reads', async () => {
    const f = await fixture();
    access.reset();
    const directory = join(f.root, 'artifacts', '2026', artifact), attachment = join(directory, 'prompt.txt');
    mkdirSync(directory);
    writeFileSync(attachment, 'Attachment instructions.');
    writeFileSync(f.artifactFile, '---\nname: File prompt\ncreated: 2026-10-30T09:00\nattachments: [prompt.txt]\n---\n');
    await f.host.data(f.root, true);
    const args = normalizeMutationArguments('updateInstance', {input: {automations: {upsert: [{name: 'digest',
      schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: 'CUSTOM', prompt: {existingId: artifact}}}]}}});
    access.protect([f.root]);
    access.allow({paths: [join(f.root, 'artifacts'), join(f.root, 'artifacts', '2026'), directory, attachment],
      operations: ['read'], reason: 'Read the selected prompt attachment and validate its managed ancestors'}, () => {
      expect(() => prepareAutomationPrompts(f.store, args)).not.toThrow();
    });
    expect(access.violations).toEqual([]);
  });

  it('allows persistence guards and one record write while retaining lifecycle effect delivery', async () => {
    const f = await fixture(), lifecycle = (f.host as any).sources;
    const mutated = vi.spyOn(lifecycle, 'mutated');
    const readPaths = [f.manifest, join(f.root, 'projects')], writePaths = [join(f.root, 'projects', '2026'), f.projectFile];
    await access.allow({paths: readPaths, operations: ['read'],
      reason: 'Project mutation admission and containment checks may read the manifest and parent directory'}, async () => {
      const before = readFileSync(f.manifest, 'utf8');
      await access.allow({paths: writePaths, operations: ['read', 'write'],
        reason: 'Preserve current project fields and atomically save only the selected record'}, () =>
        f.call('graphql', {mode: 'mutation', session: f.state, args: {document: `mutation{updateProject(id:"${project}",input:{body:"Saved through lifecycle."}){error}}`}}));
      expect(readFileSync(f.manifest, 'utf8')).toBe(before);
    });
    expect(mutated).toHaveBeenCalled();
    expect(f.store.getProject(project)?.body).toBe('Saved through lifecycle.');
    expect(f.rebuild).not.toHaveBeenCalled(); expect(access.violations).toEqual([]);
    // The write permission has ended; the following ordinary query is guarded.
    const {result} = await f.graphql(`{project(id:"${project}"){body}}`);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({project: {body: 'Saved through lifecycle.'}});
    expect(access.violations).toEqual([]);
  });

  it('requires an explicit exception for raw-disk validation without refreshing loaded state', async () => {
    const f = await fixture();
    const document = '{activeInstance{validation{passed checks{name passed}}}}';
    // Validation catches read failures itself. The shared violation log must
    // still expose that source access, even when no exception reaches GraphQL.
    await f.graphql(document);
    expect(access.violations.length).toBeGreaterThan(0);
    access.protect([f.root]);
    const paths = [f.manifest, join(f.root, '.aside'), ...['notes', 'actions', 'projects', 'artifacts'].map(kind => join(f.root, kind)),
      ...['projects', 'artifacts', 'actions'].flatMap(kind => [join(f.root, kind, '2026'), join(f.root, kind, '2026', 'index.yaml')]),
      f.projectFile, f.artifactFile, f.actionFile, join(f.root, 'artifacts', '2026', artifact)];
    const {result} = await access.allow({paths, operations: ['read'],
      reason: 'The requested validation deliberately checks the exact saved source files'}, () => f.graphql(document));
    expect(result.errors).toBeUndefined();
    expect(result.data.activeInstance.validation.checks.length).toBeGreaterThan(0);
    expect(f.store.getProject(project)?.body).toBe('Published project body.');
    expect(f.rebuild).not.toHaveBeenCalled(); expect(access.violations).toEqual([]);
  });
});
