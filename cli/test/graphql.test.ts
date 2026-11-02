import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { createArtifact } from '../src/mcp/tools/artifact.js';
import { handleUpdateAction, handleUpdateProject } from '../src/mcp/tools/update.js';
import { executeGraphQL } from '../src/graphql/schema.js';
import * as models from '../src/automation/models.js';
import * as indexFile from '../src/mcp/tools/index-file.js';
import { QueryView } from '../src/graphql/query.js';
import { getIntrospectionQuery } from 'graphql';
import { InstanceHost, READ_TOOLS } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync } from '../src/mcp/calendar/sync.js';
import { artifactAttachmentPath } from '../src/core/artifact.js';
import { formatUtcTimestamp } from '../src/core/date.js';

describe('GraphQL over existing Aside records', () => {
  let dir: string;
  let store: Store;
  let host: InstanceHost | undefined;
  let open: string, quiet: string, closed: string, overdue: string, finished: string, orphan: string, artifact: string;
  const query = async (document: string, variables?: Record<string, unknown>) => executeGraphQL(store, 'query', { document, variables });
  const data = (result: any) => { expect(result.errors).toBeUndefined(); return result.data; };
  const ids = (connection: any) => connection.nodes.map((node: any) => node.id);
  const tool = async (document: string, variables?: Record<string, unknown>, name = 'mutate', operationName?: string) => {
    host ??= new InstanceHost(new CalClient(null));
    return JSON.parse((await host.tool(dir, name, { document, variables, operationName })).text);
  };

  beforeEach(() => {
    vi.spyOn(models, 'catalogFor').mockResolvedValue({models: [], diagnostics: [], revision: 'fixture'});
    dir = mkdtempSync('/tmp/aside-graphql-');
    init(dir, { name: 'GraphQL fixture', description: 'Existing record model' });
    store = new Store(dir);
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    artifact = createArtifact(store, { name: 'Plan', description: 'Current plan', body: '# Plan' }, new Date(2026, 5, 1, 8)).id;
    let result = handleCapture(store, {
      content: `Kickoff #artifact/${artifact}`, description: 'Kickoff',
      projects: [{ name: 'Open', description: 'Open project' }],
      actions: [{ name: 'Review', description: 'Review the plan', deadline: '2026-06-05T17:00' }],
    }, new Date(2026, 5, 1, 10));
    open = result.createdProjectIds[0]; overdue = result.createdActionIds[0];
    result = handleCapture(store, {
      content: 'Old activity', description: 'Quiet project kickoff',
      projects: [{ name: 'Quiet', description: 'Quiet project' }],
      actions: [{ name: 'Quiet task', description: 'Unfinished work' }],
    }, new Date(2026, 5, 2, 10));
    quiet = result.createdProjectIds[0];
    result = handleCapture(store, {
      content: 'Closed work', description: 'Closed project',
      projects: [{ name: 'Closed', description: 'Closed project' }],
      actions: [{ name: 'Closed task', description: 'Old task', deadline: '2026-06-04' }],
    }, new Date(2026, 5, 3, 10));
    closed = result.createdProjectIds[0];
    handleUpdateProject(store, { id: closed, ended: '2026-06-04T10:00' });
    handleUpdateProject(store, { id: open, related_projects: [{ project: quiet, description: 'Supports quiet work' }] });
    result = handleCapture(store, {
      content: 'Delivered', description: 'Finished work', projects: [open],
      actions: [{ name: 'Finished', description: 'Delivered task', deadline: '2026-06-05' }],
    }, new Date(2026, 5, 4, 10));
    finished = result.createdActionIds[0];
    handleUpdateAction(store, { id: finished, resolution: 'done' });
    result = handleCapture(store, {
      content: 'Ungrouped', description: 'Standalone task',
      actions: [{ name: 'Orphan', description: 'No project' }],
    }, new Date(2026, 5, 5, 10));
    orphan = result.createdActionIds[0];
    handleCapture(store, { content: 'Recent progress', description: 'Progress update', projects: [open] }, new Date(2026, 5, 10, 10));
    expect(store.getIssues()).toEqual([]);
  });

  afterEach(async () => {
    await host?.close(); host = undefined;
    store.close(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true });
  });

  it('filters related project directions before pagination and counts', async () => {
    handleUpdateProject(store, {id: quiet, related_projects: [{project: open, description: 'Reciprocal'}]});
    handleUpdateProject(store, {id: closed, related_projects: [{project: open, description: 'Incoming'}]});
    const result = data(await query(`{ project(id: "${open}") {
      reciprocal: relatedProjects(direction: [BIDIRECTIONAL], limit: 1) { totalCount count nodes { direction project { id } } }
      incoming: relatedProjects(direction: [INCOMING, BIDIRECTIONAL], offset: 1, limit: 1) { totalCount count nodes { project { id } } }
      outgoing: relatedProjects(direction: [OUTGOING]) { totalCount }
      empty: relatedProjects(direction: []) { totalCount count }
      narrowed: relatedProjects(direction: [INCOMING], where: {status: OPEN}) { totalCount }
    } }`)).project;
    expect(result.reciprocal).toEqual({totalCount: 1, count: 1, nodes: [{direction: 'BIDIRECTIONAL', project: {id: quiet}}]});
    expect(result.incoming.totalCount).toBe(2);
    expect(result.incoming.count).toBe(1);
    expect(result.outgoing.totalCount).toBe(0);
    expect(result.empty).toEqual({totalCount: 0, count: 0});
    expect(result.narrowed.totalCount).toBe(0);
  });

  it('fetches a project and selected connected context in one request', async () => {
    const result = await query(`query CatchUp($id: ID!) {
      project(id: $id) {
        id name body
        actions(where: {status: [BACKLOG, SCHEDULED]}) { nodes { id deadline } }
        entries(orderBy: CREATED_DESC, limit: 1) { totalCount nodes { content created } offset count }
        artifacts { nodes { id description } }
        relatedProjects { nodes { direction outgoingDescription incomingDescription project { id } } }
      }
    }`, { id: open });
    const project = data(result).project;
    expect(ids(project.actions)).toEqual([overdue]);
    expect(project.entries.nodes).toEqual([{ content: 'Recent progress', created: '2026-06-10T10:00' }]);
    expect(project.entries.totalCount).toBe(3);
    expect(project.entries).toMatchObject({offset: 0, count: 1});
    expect(ids(project.artifacts)).toEqual([artifact]);
    expect(project.relatedProjects.nodes).toEqual([{ direction: 'OUTGOING', outgoingDescription: 'Supports quiet work', incomingDescription: null, project: { id: quiet } }]);
    expect(result.extensions).toMatchObject({ complete: true, diagnostics: [] });
  });

  it('filters overdue actions by open associated projects, before pagination', async () => {
    const result = data(await query(`query($day: Date!) {
      actions(where: { status: [BACKLOG, SCHEDULED], deadlineTo: $day, projects: {some: {status: OPEN}} }, limit: 1) {
        totalCount nodes { id projects(where: {status: OPEN}) { nodes { id } } }
      }
    }`, { day: '2026-06-09' }));
    expect(ids(result.actions)).toEqual([overdue]);
    expect(result.actions.totalCount).toBe(1);
    expect(ids(result.actions.nodes[0].projects)).toEqual([open]);
  });

  it('finds actions with no project and preserves legacy empty-ID semantics', async () => {
    const result = data(await query(`{
      unassigned: actions(where: {projects: {none: {}}}) { nodes { id } }
      legacy: actions(where: {projectIds: []}) { nodes { id } }
      empty: actions(where: {ids: []}) { totalCount }
      emptyStatus: actions(where: {status: []}) { totalCount }
    }`));
    expect(ids(result.unassigned)).toEqual([orphan]);
    expect(ids(result.legacy)).toEqual([orphan]);
    expect(result.empty.totalCount).toBe(0);
    expect(result.emptyStatus.totalCount).toBe(0);
  });

  it('selects artifacts through direct and multiple-hop unfinished-work associations', async () => {
    const result = data(await query(`{
      direct: artifacts(where: {actions: {some: {status: [BACKLOG, SCHEDULED]}}}) {
        nodes { id backlinks { nodes { ... on Entry { handle } } } actions(where: {status: [BACKLOG, SCHEDULED]}) { nodes { id } } }
      }
      indirect: artifacts(where: {projects: {some: {actions: {some: {status: [BACKLOG, SCHEDULED]}}}}}) { nodes { id } }
    }`));
    expect(ids(result.direct)).toEqual([artifact]);
    expect(ids(result.indirect)).toEqual([artifact]);
    expect(ids(result.direct.nodes[0].actions)).toEqual([overdue]);
    expect(result.direct.nodes[0].backlinks.nodes).toContainEqual({handle: '#entry/2026-06-01T10:00'});
  });

  it('finds open projects with unfinished actions and no recent entries', async () => {
    const result = data(await query(`query($since: Date!) {
      projects(where: {status: OPEN, actions: {some: {status: [BACKLOG, SCHEDULED]}}, entries: {none: {createdFrom: $since}}}) {
        nodes { id entries(limit: 1) { nodes { created } } }
      }
    }`, { since: '2026-06-09' }));
    expect(ids(result.projects)).toEqual([quiet]);
    expect(result.projects.nodes[0].entries.nodes[0].created).toBe('2026-06-02T10:00');
  });

  it('supports Boolean composition, safe regex search, ascending order, and offset pagination', async () => {
    const result = data(await query(`{
      projects(where: {and: [{status: OPEN}, {or: [{search: "quiet"}, {ids: ["${open}"]}]}], not: {ids: ["${closed}"]}}, orderBy: CREATED_ASC, limit: 1) {
        totalCount nodes { id } offset count
      }
    }`));
    expect(ids(result.projects)).toEqual([open]);
    expect(result.projects.totalCount).toBe(2);
    const next = data(await query(`query($offset: Int!) {
      projects(where: {status: OPEN}, orderBy: CREATED_ASC, limit: 1, offset: $offset) { nodes { id } offset count }
    }`, { offset: result.projects.offset + result.projects.count }));
    expect(ids(next.projects)).toEqual([quiet]);
    expect(next.projects).toMatchObject({offset: 1, count: 1});
  });

  it('exposes types and inputs through standard introspection', async () => {
    const result = data(await query('{ __type(name: "ActionWhere") { inputFields { name } } }'));
    expect(result.__type.inputFields.map((field: any) => field.name)).toEqual(expect.arrayContaining(['projects', 'deadlineTo', 'and']));
    expect(data(await query(getIntrospectionQuery())).__schema.mutationType.name).toBe('Mutation');
  });

  it('returns page counts and offsets even when record nodes are not selected', async () => {
    const result = data(await query(`{
      partial: actions(offset: 2, limit: 2) { offset count totalCount }
      exhausted: actions(offset: 8, limit: 2) { offset count totalCount nodes { id } }
    }`));
    expect(result.partial).toEqual({offset: 2, count: 2, totalCount: 5});
    expect(result.exhausted).toEqual({offset: 8, count: 0, totalCount: 5, nodes: []});
  });

  it('returns actual record file paths and the shared containing file for entries', async () => {
    const first = store.getEntries().find(record => record.content.startsWith('Kickoff'))!.meta.created;
    const second = store.getEntries().find(record => record.content === 'Old activity')!.meta.created;
    const result = data(await query(`{
      first: entry(id: "${first}") { filePath }
      second: entry(id: "${second}") { filePath }
      project(id: "${open}") { filePath }
      action(id: "${overdue}") { filePath }
      artifact(id: "${artifact}") { filePath }
    }`));
    expect(result).toEqual({first: {filePath: store.getEntryFile(first)}, second: {filePath: store.getEntryFile(second)},
      project: {filePath: store.getProjectFile(open)}, action: {filePath: store.getActionFile(overdue)}, artifact: {filePath: store.getArtifactFile(artifact)}});
    expect(result.first.filePath).toBe(result.second.filePath);
  });

  it('returns absolute file paths when the Store root was relative', async () => {
    const relativeStore = new Store(relative(process.cwd(), dir));
    try {
      const result = data(await executeGraphQL(relativeStore, 'query', {document: `{ project(id: "${open}") { filePath } }`}));
      expect(result.project.filePath).toBe(resolve(store.getProjectFile(open)!));
    } finally { relativeStore.close(); }
  });

  it('narrows regex snapshots with relationship filters before searching', async () => {
    const match = vi.fn(async (_pattern: string, texts: string[][]) => {
      expect(texts).toHaveLength(3);
      expect(texts.map(fields => fields[0])).toEqual(expect.arrayContaining(['Review', 'Quiet task', 'Finished']));
      return [0];
    });
    const result = await executeGraphQL(store, 'query', {
      document: '{ actions(where: {projects: {some: {status: OPEN}}, search: "Review"}) { nodes { id } } }',
    }, { matcher: { match } });
    expect(ids(data(result).actions)).toEqual([overdue]);
    expect(match).toHaveBeenCalledOnce();
  });

  it('scopes nested regex searches through Boolean and relationship predicates', async () => {
    const match = vi.fn(async (pattern: string, texts: string[][]) => {
      // A small related collection remains searchable even when the unrelated
      // records would exceed the worker's snapshot capacity.
      if (texts.length > 2) throw new Error('Regex snapshot capacity exceeded');
      const regex = new RegExp(pattern, 'i');
      return texts.flatMap((fields, index) => fields.some(text => regex.test(text)) ? [index] : []);
    });
    const result = await executeGraphQL(store, 'query', {
      document: `{
        project(id: "${open}") {
          actions(where: {or: [{search: "Review"}]}) { nodes { id } }
          entries(where: {actions: {some: {search: "Finished"}}}) { nodes { id } }
        }
        quiet: project(id: "${quiet}") { actions(where: {search: "Review"}) { nodes { id } } }
        exact: actions(where: {ids: ["${overdue}"], and: [{search: "Review"}], projects: {some: {search: "Open"}}}) { nodes { id } }
      }`,
    }, { matcher: { match } });
    const resultData = data(result);
    expect(ids(resultData.project.actions)).toEqual([overdue]);
    expect(ids(resultData.project.entries)).toEqual(['2026-06-04T10:00']);
    expect(ids(resultData.quiet.actions)).toEqual([]);
    expect(ids(resultData.exact)).toEqual([overdue]);
  });

  it('requires an operation name when ambiguous and executes only the selected operation', async () => {
    const result = await executeGraphQL(store, 'query', {
      document: 'query A { projects { totalCount } } query B { actions { totalCount } }', operationName: 'B',
    });
    expect(data(result)).toEqual({ actions: { totalCount: 5 } });
  });

  it('bounds deeply nested selections, variable filters, and root mutations before writes', async () => {
    let selection = 'id';
    for (let n = 0; n < 20; n++) selection = `relatedProjects { nodes { project { ${selection} } } }`;
    expect(JSON.stringify((await query(`{ projects { nodes { ${selection} } } }`)).errors)).toMatch(/selection limit/);
    let where: any = {};
    for (let n = 0; n < 30; n++) where = { not: where };
    expect(JSON.stringify((await query('query($where: ProjectWhere) { projects(where: $where) { totalCount } }', { where })).errors)).toMatch(/too deeply nested/);
    const many = Array.from({ length: 21 }, (_, n) => `a${n}: updateAction(id: "${overdue}", input: {status: DONE}) { action { id } }`).join('\n');
    const result = await tool(`mutation { ${many} }`);
    expect(JSON.stringify(result.errors)).toMatch(/Too many root fields/);
    expect(result.extensions.mutations).toEqual([]);
  });

  it('bounds expanded fragments, including unselected operations, before writes', async () => {
    const fragments = Array.from({ length: 11 }, (_, n) => `fragment F${n} on Action { ${n ? `...F${n - 1} ...F${n - 1}` : 'id'} }`).join('\n');
    const result = await tool(`
      mutation Save { updateAction(id: "${overdue}", input: {status: DONE}) { action { id } } }
      query Huge { actions { nodes { ...F10 } } }
      ${fragments}
    `, undefined, 'mutate', 'Save');
    expect(JSON.stringify(result.errors)).toMatch(/selection limit/);
    expect(result.extensions.mutations).toEqual([]);
    expect(store.getAction(overdue)!.frontMatter.resolution).toBeUndefined();
  });

  it('rejects cyclic and unknown fragments and executes valid fragments', async () => {
    expect(JSON.stringify((await query('{ actions { nodes { ...Loop } } } fragment Loop on Action { ...Loop }')).errors)).toMatch(/Fragment cycle/);
    expect(JSON.stringify((await query('{ actions { nodes { ...Missing } } }')).errors)).toMatch(/Unknown fragment/);
    const result = data(await query(`{ action(id: "${overdue}") { ...Details } } fragment Details on Action { id status }`));
    expect(result.action).toEqual({ id: overdue, status: 'BACKLOG' });
  });

  it('does not treat dangling relationship targets as proven absence', async () => {
    data(await query('{ projects(where: {actions: {none: {}}}) { nodes { id } } }'));
    const record = store.getProject(open)!;
    store.saveProject(open, { ...record.frontMatter, related_projects: [{ project: 'missing', description: 'Dangling' }] }, record.body, store.getProjectFile(open)!);
    // Query the dangling parent itself: relation IDs are checked even when no
    // matching loaded target exists.
    const absence = await query(`{ projects(where: {ids: ["${open}"], relatedProjects: {none: {}}}) { totalCount } }`);
    expect(JSON.stringify(absence.errors)).toMatch(/absence is unconfirmed/);
    expect(absence.extensions?.complete).toBe(false);
  });

  it.each([
    ['{ actions(where: {createdFrom: "2026-02-30"}) { totalCount } }', /calendar date/],
    ['{ actions(where: {createdFrom: "2026-06-10", createdTo: "2026-06-01"}) { totalCount } }', /on or before/],
    ['{ actions(limit: 0) { totalCount } }', /limit/],
    ['{ actions(offset: -1) { totalCount } }', /offset/],
    ['{ actions(limit: 101) { totalCount } }', /limit/],
    ['{ actions(where: {search: "["}) { totalCount } }', /regex/],
    ['{ actions { nodes { nonexistent } } }', /Cannot query field/],
    ['query A { actions { totalCount } } query B { projects { totalCount } }', /operationName/],
  ])('reports invalid requests without changing files: %s', async (document, pattern) => {
    const before = readFileSync(store.getActionFile(overdue)!, 'utf8');
    const result = await query(document);
    expect(JSON.stringify(result.errors)).toMatch(pattern);
    expect(readFileSync(store.getActionFile(overdue)!, 'utf8')).toBe(before);
  });

  it('reports parsing diagnostics and refuses to assert absence over incomplete data', async () => {
    expect((await query('{ projects { totalCount } }')).extensions?.complete).toBe(true);
    writeFileSync(store.getProjectFile(open)!, '---\nname: [invalid\n---\n');
    store.rebuild();
    const result = await query('{ actions { totalCount } }');
    expect(result.extensions?.complete).toBe(false);
    expect((result.extensions?.diagnostics as any[]).length).toBeGreaterThan(0);
    const absence = await query('{ actions(where: {projects: {none: {}}}) { totalCount } }');
    expect(JSON.stringify(absence.errors)).toMatch(/absence is unconfirmed/);
  });

  it('keeps a read view stable after a store update', async () => {
    const view = new QueryView(store);
    expect(new QueryView(store).records).toBe(view.records);
    handleUpdateAction(store, { id: overdue, resolution: 'done' });
    expect(new QueryView(store).records).not.toBe(view.records);
    expect((await view.list('action', { where: { status: ['backlog'] } })).nodes.map(node => node.id)).toContain(overdue);
    expect(ids(data(await query('{ actions(where: {status: [DONE]}) { nodes { id } } }')).actions)).toContain(overdue);
    const savedMetadata = view.records.artifact.get(artifact)!.record.frontMatter;
    store.getArtifact(artifact)!.frontMatter.attachments = ['external.txt'];
    expect(savedMetadata.attachments).toBeUndefined();
  });

  it('refreshes cached descriptions and newly captured relationships without altering an older view', async () => {
    const view = new QueryView(store);
    handleUpdateAction(store, { id: overdue, description: 'Cache invalidation marker' });
    expect(view.records.action.get(overdue)!.description).toBe('Review the plan');
    expect(ids(data(await query('{ actions(where: {search: "Cache invalidation marker"}) { nodes { id description } } }')).actions)).toEqual([overdue]);
    handleCapture(store, {
      content: 'Added context', description: 'Added context', projects: [quiet], actions: [orphan],
    }, new Date(2026, 5, 11, 10));
    expect((await view.list('project', {}, view.records.action.get(orphan), 'projects')).totalCount).toBe(0);
    expect(ids(data(await query(`{ action(id: "${orphan}") { projects { nodes { id } } } }`)).action.projects)).toEqual([quiet]);
    expect(data(await query('{ entry(id: "2026-06-11T10:00") { description content } }')).entry).toEqual({ description: 'Added context', content: 'Added context' });
  });

  it('invalidates cached attachment metadata even when reconciliation fails after changing memory', async () => {
    const view = new QueryView(store);
    const attachment = artifactAttachmentPath(dir, artifact, 'extra.txt');
    mkdirSync(dirname(attachment), { recursive: true });
    writeFileSync(attachment, 'Additional material');
    store.refreshArtifactAttachments(artifact);
    const refreshed = new QueryView(store);
    expect(refreshed.records.artifact.get(artifact)!.record.frontMatter.attachments).toEqual(['extra.txt']);
    expect(view.records.artifact.get(artifact)!.record.frontMatter.attachments).toBeUndefined();
    rmSync(attachment);
    // Fail the write after the safe record read and in-memory inventory update.
    vi.spyOn(indexFile, 'writeFileCrashSafe').mockImplementationOnce(() => { throw new Error('Reconciliation write failed'); });
    expect(() => store.refreshArtifactAttachments(artifact)).toThrow('Reconciliation write failed');
    expect(new QueryView(store).records.artifact.get(artifact)!.record.frontMatter.attachments).toBeUndefined();
    expect(refreshed.records.artifact.get(artifact)!.record.frontMatter.attachments).toEqual(['extra.txt']);
  });

  it('keeps asynchronous searches on their original snapshot and cancellation local to each request', async () => {
    let started!: () => void;
    const searching = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const pending = executeGraphQL(store, 'query', {
      document: `{ actions(where: {ids: ["${overdue}"], search: "Review"}) { nodes { id name } } }`,
    }, { matcher: { match: async () => { started(); await paused; return [0]; } } });
    await searching;
    handleUpdateAction(store, { id: overdue, name: 'Renamed during search' });
    release();
    expect(data(await pending).actions.nodes).toEqual([{ id: overdue, name: 'Review' }]);
    expect(data(await query(`{ action(id: "${overdue}") { name } }`)).action.name).toBe('Renamed during search');
    const controller = new AbortController(); controller.abort();
    data(await query('{ actions { nodes { id } } }'));
    const cancelled = await executeGraphQL(store, 'query', { document: '{ actions { totalCount } }' }, { signal: controller.signal });
    expect(JSON.stringify(cancelled.errors)).toMatch(/cancelled/);
    expect(data(await query('{ actions { totalCount } }')).actions.totalCount).toBe(5);
  });

  it('reuses bounded complete root results across ordering and pagination, then invalidates after writes', async () => {
    const compile = vi.spyOn(QueryView.prototype, 'compile');
    const document = `query($ascending: ActionOrder!, $offset: Int!) { actions(orderBy: $ascending, offset: $offset, limit: 2) { nodes { id } totalCount offset count } }`;
    const expected = [...store.getActions()].sort((a, b) => a[1].frontMatter.created.localeCompare(b[1].frontMatter.created) || a[0].localeCompare(b[0])).map(([id]) => id);
    expect(ids(data(await query(document, { ascending: 'CREATED_ASC', offset: 0 })).actions)).toEqual(expected.slice(0, 2));
    expect(ids(data(await query(document, { ascending: 'CREATED_DESC', offset: 2 })).actions)).toEqual([...expected].reverse().slice(2, 4));
    expect(compile).toHaveBeenCalledOnce();
    const older = new QueryView(store);
    handleUpdateAction(store, { id: overdue, description: 'Description after cached results' });
    const described = data(await query('{ actions { nodes { id description } } }')).actions.nodes.find((a: any) => a.id === overdue);
    expect(described.description).toBe('Description after cached results');
    expect(older.records.action.get(overdue)!.description).toBe('Review the plan');
    expect(compile).toHaveBeenCalledOnce();
    // Counts and fragments must stay correct when served from the same result.
    expect(data(await query('{ actions { ...Page } } fragment Page on ActionPage { totalCount nodes { id } }')).actions.totalCount).toBe(5);
    handleUpdateAction(store, { id: overdue, name: 'Updated after cached results' });
    expect(data(await query('{ actions { nodes { id name } } }')).actions.nodes.find((a: any) => a.id === overdue).name).toBe('Updated after cached results');
    expect(compile).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 33; i++) data(await query(`{ actions(where: {ids: ["missing-${i}"]}) { nodes { id } } }`));
    const before = compile.mock.calls.length;
    data(await query(document, { ascending: 'CREATED_ASC', offset: 0 }));
    expect(compile.mock.calls.length).toBe(before + 1);
  });

  it('never caches scoped regex results across requests or hides work-limit failures', async () => {
    const document = `{ project(id: "${open}") { actions(where: {and: [{search: "Review"}]}) { nodes { id } } } }`;
    const match = vi.fn().mockResolvedValueOnce([0]).mockResolvedValueOnce([]);
    const first = data(await executeGraphQL(store, 'query', { document }, { matcher: { match } }));
    expect(first.project.actions.nodes).toHaveLength(1);
    expect(data(await executeGraphQL(store, 'query', { document }, { matcher: { match } })).project.actions.nodes).toEqual([]);
    expect(match).toHaveBeenCalledTimes(2);
    vi.spyOn(store, 'getEntries').mockReturnValue(Array.from({ length: 50_001 }, (_, i) => ({
      meta: { created: formatUtcTimestamp(new Date(Date.UTC(2026, 0, 1, 0, i))) }, content: 'Synthetic capacity probe', weekFile: '2026-01-05',
    })));
    // Rebuild invalidates the snapshot, and the getter supplies the probe rows.
    store.rebuild();
    for (let i = 0; i < 2; i++) expect(JSON.stringify((await query('{ entries { nodes { id } } }')).errors)).toMatch(/work limit/);
    expect(data(await query('{ entries(where: {ids: ["2026-01-01T00:00"]}) { nodes { id } } }')).entries.nodes).toEqual([{ id: '2026-01-01T00:00' }]);
  });

  it('short-circuits pure relationship predicates instead of spending work budget on an eager scope', async () => {
    const original = store.getEntries();
    const expected = original.filter(e => (e.meta.projects ?? []).some(id => store.getProject(id)?.frontMatter.ended == null)).length;
    const entries = Array.from({ length: 1_000 }, (_, i) => ({
      meta: { created: formatUtcTimestamp(new Date(Date.UTC(2026, 0, 1, 0, i))), projects: Array<string>(200).fill(open) },
      content: 'Repeated project tags in authored metadata', weekFile: '2026-01-05',
    }));
    vi.spyOn(store, 'getEntries').mockReturnValue([...original, ...entries]);
    const result = await query('{ entries(where: {projects: {some: {status: OPEN}}}) { totalCount } }');
    expect(data(result).entries.totalCount).toBe(expected + entries.length);
    expect(result.extensions?.complete).toBe(true);
    const view = new QueryView(store);
    await view.compile('action', { not: { not: {} } });
    await expect(view.compile('action', { not: { not: {} } }, 12)).rejects.toThrow(/filter nesting/);
  });

  it.each(['and', 'or'])('settles every %s filter branch when an earlier branch exhausts its budget', async operator => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 12; depth++) nested = {not: nested};
    const match = vi.fn().mockResolvedValue([]);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const result = await executeGraphQL(store, 'query', {
        document: 'query($where: ActionWhere) { actions(where: $where) { totalCount } }',
        variables: {where: {[operator]: [nested, {search: 'Review'}]}},
      }, {matcher: {match}});
      expect(JSON.stringify(result.errors)).toMatch(/filter nesting/);
      expect(result.data).toBeUndefined();
      expect(match).not.toHaveBeenCalled();
      // Rejections from started branches must be observed even when a later
      // branch sees the abort before the encompassing Promise.all is created.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('rejects mutations in the read tool and queries/subscriptions in the mutation tool', async () => {
    const update = `mutation { updateAction(id: "${overdue}", input: {status: DONE}) { action { id } } }`;
    expect(JSON.stringify((await tool(update, undefined, 'query')).errors)).toMatch(/only query/);
    expect(store.getAction(overdue)!.frontMatter.resolution).toBeUndefined();
    expect(JSON.stringify((await tool('{ actions { totalCount } }')).errors)).toMatch(/only mutation/);
    expect(READ_TOOLS.has('query')).toBe(true);
    expect(READ_TOOLS.has('mutate')).toBe(false);
  });

  it('runs existing writes, distinguishes omission from null, and refreshes relationship results', async () => {
    const created = data(await tool(`mutation {
      capture(input: {content: "New context", description: "Context", projects: [{existingId: "${open}"}], actions: [{create: {name: "GraphQL task", description: "New work", scheduled: "2026-06-12T10:00"}}]}) {
        error entry { id projects { nodes { id } } } createdActions { id scheduled projects { nodes { id } } }
      }
    }`)).capture;
    const actionId = created.createdActions[0].id;
    expect(ids(created.createdActions[0].projects)).toEqual([open]);
    expect(created.error).toBeNull();
    const update = data(await tool(`mutation {
      keep: updateAction(id: "${actionId}", input: {name: "Renamed"}) { action { name scheduled } }
      clear: updateAction(id: "${actionId}", input: {scheduled: null}) { action { status scheduled } }
    }`));
    expect(update.keep.action).toEqual({ name: 'Renamed', scheduled: '2026-06-12T10:00' });
    expect(update.clear.action.status).toBe('BACKLOG');
    expect(update.clear.action.scheduled).toBeNull();
    const reloaded = new Store(dir);
    expect(reloaded.getAction(actionId)!.frontMatter.name).toBe('Renamed');
    expect(reloaded.getProjectsForAction(actionId)).toEqual([open]);
    reloaded.close();
  });

  it('preserves calendar sync through the host and reports problems even when error is unselected', async () => {
    const sync = vi.spyOn(CalSync.prototype, 'syncActions').mockResolvedValue([]);
    const result = await tool(`mutation { updateAction(id: "${overdue}", input: {scheduled: "2026-06-12T10:00", calendar: "Work"}) { action { id } } }`);
    data(result);
    expect(sync).toHaveBeenCalled();
    expect(result.extensions.mutations[0].error).toContain('Calendar sync');
  });

  it('keeps successful mutation outcomes if a later mutation fails', async () => {
    const result = await tool(`mutation {
      first: updateAction(id: "${overdue}", input: {status: DONE}) { action { status } }
      second: updateAction(id: "missing", input: {status: DONE}) { action { id } }
    }`);
    expect(result.data.first.action.status).toBe('DONE');
    expect(result.data.second).toBeNull();
    expect(result.errors).toBeDefined();
    expect(result.extensions.mutations).toHaveLength(1);
    expect(result.extensions.mutations[0].operation).toBe('updateAction');
    const reloaded = new Store(dir);
    expect(reloaded.getAction(overdue)!.frontMatter.resolution).toBe('done');
    reloaded.close();
  });

  it('names every record and instance outcome after its public mutation field, regardless of aliases', async () => {
    const result = await tool(`mutation {
      settings: updateInstance(input: {body: "Use user-authored instructions."}) { instance { body } }
      project: updateProject(id: "${open}", input: {body: "Project context"}) { project { id } }
      action: updateAction(id: "${overdue}", input: {name: "Updated review"}) { action { id } }
      entry: updateEntry(id: "2026-06-01T10:00", input: {description: "Updated kickoff"}) { entry { id } }
      artifact: updateArtifact(id: "${artifact}", input: {body: "Current plan"}) { artifact { id } }
      created: createArtifact(input: {name: "Another plan", description: "Supporting context", body: "Draft"}) { artifact { id } }
      captured: capture(input: {content: "Recorded progress", description: "Progress"}) { entry { id } }
    }`);
    data(result);
    expect(result.extensions.mutations.map((outcome: any) => outcome.operation)).toEqual([
      'updateInstance', 'updateProject', 'updateAction', 'updateEntry', 'updateArtifact', 'createArtifact', 'capture',
    ]);
    expect(result.extensions.mutations.every((outcome: any) => outcome.error === null && outcome.changes.length > 0)).toBe(true);
  });

  it('rejects invalid mutation variables before any root writes', async () => {
    const result = await tool(`mutation($input: UpdateActionInput!) {
      first: updateAction(id: "${overdue}", input: {status: DONE}) { action { id } }
      second: updateAction(id: "${finished}", input: $input) { action { id } }
    }`, { input: { status: 'INVALID' } });
    expect(result.errors).toBeDefined();
    expect(result.extensions.mutations).toEqual([]);
    expect(store.getAction(overdue)!.frontMatter.resolution).toBeUndefined();
  });

  it('preserves successful outcomes and stops later writes after response budget exhaustion', async () => {
    const bodyFile = join(dir, 'large-body.md');
    writeFileSync(bodyFile, 'x'.repeat(8 * 1024 * 1024 + 1));
    const result = await tool(`mutation($path: String!) {
      first: updateAction(id: "${overdue}", input: {bodyFile: $path}) { action { body } }
      second: updateAction(id: "${finished}", input: {status: BACKLOG}) { action { id } }
    }`, { path: bodyFile });
    expect(JSON.stringify(result.errors)).toMatch(/response text limit/);
    expect(result.data).toBeUndefined();
    expect(result.extensions.mutations).toHaveLength(1);
    const reloaded = new Store(dir);
    expect(reloaded.getAction(overdue)!.body).toHaveLength(8 * 1024 * 1024 + 1);
    expect(reloaded.getAction(finished)!.frontMatter.resolution).toBe('done');
    reloaded.close();
  });

  it('validates oneOf links and domain inputs before the corresponding write', async () => {
    const invalid = await tool(`mutation { capture(input: {content: "Rejected", description: "Rejected", projects: [{existingId: "${open}", create: {name: "Bad", description: "Bad"}}]}) { entry { id } } }`);
    expect(invalid.errors).toBeDefined();
    expect(invalid.extensions.mutations).toEqual([]);
    const badSchedule = await tool(`mutation { updateAction(id: "${overdue}", input: {scheduled: "2026-02-30T10:00"}) { action { id } } }`);
    expect(badSchedule.errors).toBeDefined();
    expect(badSchedule.extensions.mutations).toEqual([]);
  });

  it('updates project lifecycle and entry links with the same persistence rules', async () => {
    const project = data(await tool(`mutation {
      updateProject(id: "${quiet}", input: {ended: "2026-06-15T10:00"}) { project { id status } }
    }`)).updateProject.project;
    expect(project.status).toBe('CLOSED');
    const entryId = '2026-06-05T10:00';
    const result = data(await tool(`mutation {
      updateEntry(id: "${entryId}", input: {projects: {set: [{existingId: "${open}"}, {create: {name: "Linked project", description: "New project"}}]}}) {
        entry { projects { nodes { id } } actions { nodes { id projects { nodes { id } } } } }
        createdProjects { id }
      }
    }`)).updateEntry;
    expect(ids(result.entry.projects).sort()).toEqual([open, result.createdProjects[0].id].sort());
    expect(result.entry.actions.nodes[0].id).toBe(orphan);
    expect(ids(result.entry.actions.nodes[0].projects)).toEqual(expect.arrayContaining([open, result.createdProjects[0].id]));
    const cleared = data(await tool(`mutation {
      updateEntry(id: "${entryId}", input: {projects: {set: []}}) { entry { projects { nodes { id } } } }
      updateProject(id: "${quiet}", input: {ended: null}) { project { status } }
    }`));
    expect(ids(cleared.updateEntry.entry.projects)).toEqual([]);
    expect(cleared.updateProject.project.status).toBe('OPEN');
  });

  it('creates and updates artifacts with attachment paths from the existing validator', async () => {
    const source = join(dir, 'draft.txt'); writeFileSync(source, 'Supporting file');
    const created = data(await tool(`mutation($path: String!) {
      createArtifact(input: {name: "GraphQL artifact", description: "New artifact", attachments: [{source: $path}]}) {
        artifact { id attachments { filename handle filePath error } content { __typename ... on Attachment { filename handle filePath error } } }
      }
    }`, { path: source })).createArtifact.artifact;
    expect(created.attachments[0].filePath).toContain(created.id);
    expect(created.attachments[0].error).toBeNull();
    expect(created.content).toEqual({__typename: 'Attachment', ...created.attachments[0]});
    const updated = data(await tool(`mutation { updateArtifact(id: "${created.id}", input: {body: "# Revised"}) {
      artifact { content { __typename ... on MarkdownContent { text } } attachments { filename } }
    } }`));
    expect(updated.updateArtifact.artifact.content).toEqual({__typename: 'MarkdownContent', text: '# Revised'});
    expect(updated.updateArtifact.artifact.attachments).toEqual([{filename: 'draft.txt'}]);
    const cleared = data(await tool(`mutation { updateArtifact(id: "${created.id}", input: {body: ""}) {
      artifact { content { __typename ... on Attachment { filename } } }
    } }`));
    expect(cleared.updateArtifact.artifact.content).toEqual({__typename: 'Attachment', filename: 'draft.txt'});
  });

  it('distinguishes primary Markdown, single-file content, and artifacts without primary content', async () => {
    const first = join(dir, 'first.txt'), second = join(dir, 'second.txt');
    writeFileSync(first, 'First'); writeFileSync(second, 'Second');
    const empty = createArtifact(store, {name: 'Empty', description: 'Empty', body: ' \t\n'}).id;
    const collection = createArtifact(store, {name: 'Collection', description: 'Collection', files: [{source: first}, {source: second}]}).id;
    const single = createArtifact(store, {name: 'Single', description: 'Single', body: ' \t\n', files: [{source: first}]}).id;
    const markdown = createArtifact(store, {name: 'Markdown', description: 'Markdown', body: '# Notes\n\nSupporting file.', files: [{source: first}]}).id;
    const result = data(await query(`{
      empty: artifact(id: "${empty}") { ...Content }
      collection: artifact(id: "${collection}") { ...Content }
      single: artifact(id: "${single}") { ...Content }
      markdown: artifact(id: "${markdown}") { ...Content }
    }
    fragment Content on Artifact {
      content { __typename ... on MarkdownContent { text } ... on Attachment { filename } }
      attachments { filename }
    }`));
    expect(result.empty).toEqual({content: null, attachments: []});
    expect(result.collection).toEqual({content: null, attachments: [{filename: 'first.txt'}, {filename: 'second.txt'}]});
    expect(result.single).toEqual({content: {__typename: 'Attachment', filename: 'first.txt'}, attachments: [{filename: 'first.txt'}]});
    expect(result.markdown).toEqual({content: {__typename: 'MarkdownContent', text: '# Notes\n\nSupporting file.'}, attachments: [{filename: 'first.txt'}]});
  });

  it('reports unavailable primary attachment retrieval without exposing a path', async () => {
    const source = join(dir, 'missing.txt'); writeFileSync(source, 'File content');
    const id = createArtifact(store, {name: 'Missing file', description: 'Missing', files: [{source}]}).id;
    rmSync(artifactAttachmentPath(dir, id, 'missing.txt'));
    const result = data(await query(`{ artifact(id: "${id}") {
      content { __typename ... on Attachment { filename filePath error } }
      attachments { filename filePath error }
    } }`)).artifact;
    expect(result.content).toEqual({__typename: 'Attachment', ...result.attachments[0]});
    expect(result.content).toMatchObject({filename: 'missing.txt', filePath: null, error: expect.stringContaining('indexed attachment is missing')});
  });

  it('budgets selected Markdown content while allowing type-only inspection of large artifacts', async () => {
    const record = store.getArtifact(artifact)!;
    store.saveArtifact(artifact, record.frontMatter, 'x'.repeat(8 * 1024 * 1024 + 1), store.getArtifactFile(artifact)!);
    expect(data(await query(`{ artifact(id: "${artifact}") { content { __typename } } }`)).artifact.content)
      .toEqual({__typename: 'MarkdownContent'});
    const result = await query(`{ artifact(id: "${artifact}") { content { ... on MarkdownContent { text } } } }`);
    expect(JSON.stringify(result.errors)).toMatch(/response text limit/);
    expect(result.data).toBeUndefined();
    expect(result.extensions).toMatchObject({complete: false});
  });
});
