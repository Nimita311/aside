import { parse as parseYaml } from 'yaml';
import { entryEntityIds } from '../src/core/record-reference.js';
import { DAY, SINCE, type Fixture } from './fixture.js';
import { EXTENDED_CASES } from './extended-cases.js';

export interface Reply { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
export type Caller = (name: string, args: Record<string, unknown>) => Promise<Reply>;
export class QueryLimitError extends Error {}
const queryLimit = /^(?:GraphQL (?:query work|response (?:field|text)|selection) limit exceeded|GraphQL request is too large|GraphQL variables are too deeply nested or too large|GraphQL filter nesting exceeds 12 levels|Too many root fields in one GraphQL operation|Regex search snapshot (?:is too large|has too many records)|Syntax Error: Document contains more than 5000 tokens\.)/;

function limitMessage(text: string): string | undefined {
  let result;
  try { result = JSON.parse(text); } catch { return queryLimit.test(text) ? text : undefined; }
  // A capacity error must not hide a separate invalid query or diagnostic.
  if (result?.extensions?.complete === false || !Array.isArray(result?.errors) || !result.errors.length) return;
  const messages: unknown[] = result.errors.map((error: unknown) =>
    error && typeof error === 'object' && 'message' in error ? error.message : undefined);
  return messages.every((message): message is string => typeof message === 'string' && queryLimit.test(message))
    ? messages.join('; ') : undefined;
}
export interface Metrics { calls: number; rounds: number; requestBytes: number; responseBytes: number; responseTextBytes: number; callMs: number }
export interface LegacyRow {
  id: string; name?: string; description?: string; deadline?: string; ended?: string; body?: string; content?: string;
  projects?: string[]; actions?: string[]; related_projects?: { project: string; description: string }[];
}
export const sorted = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
const idName = (row: { id: string; name?: string }) => ({ id: row.id, name: row.name });
const artifactRow = (row: { id: string; description?: string }) => ({ id: row.id, description: row.description });
const actionRow = (row: { id: string; name?: string; deadline?: string | null }) => ({ ...idName(row), deadline: row.deadline ?? null });
const page = 'limit: $limit offset: $offset';
const params = '($limit: Int!, $offset: Int!)';
const unfinished = 'status: [BACKLOG, SCHEDULED]';

export class Context {
  readonly metrics: Metrics = { calls: 0, rounds: 0, requestBytes: 0, responseBytes: 0, responseTextBytes: 0, callMs: 0 };
  constructor(private caller: Caller, readonly pageSize: number) {}
  async parallel<T>(calls: Promise<T>[]): Promise<T[]> {
    const results = await Promise.allSettled(calls);
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
    return results.map(r => (r as PromiseFulfilledResult<T>).value);
  }
  async call(name: string, args: Record<string, unknown>, round: number): Promise<Reply> {
    this.metrics.calls++; this.metrics.rounds = Math.max(this.metrics.rounds, round);
    this.metrics.requestBytes += Buffer.byteLength(JSON.stringify({ name, arguments: args }));
    const start = performance.now();
    let reply: Reply;
    try { reply = await this.caller(name, args); }
    catch (error) {
      if (error instanceof Error && queryLimit.test(error.message)) throw new QueryLimitError(error.message);
      throw error;
    } finally { this.metrics.callMs += performance.now() - start; }
    this.metrics.responseBytes += Buffer.byteLength(JSON.stringify(reply));
    this.metrics.responseTextBytes += reply.content.reduce((n, block) => n + Buffer.byteLength(block.text ?? ''), 0);
    if (reply.isError) {
      const text = reply.content.find(block => block.type === 'text')?.text ?? JSON.stringify(reply);
      const message = limitMessage(text);
      if (message) throw new QueryLimitError(message);
      throw new Error(JSON.stringify(reply));
    }
    return reply;
  }
  async graph(document: string, variables: Record<string, unknown>, round = 1): Promise<any> {
    const reply = await this.call('query', { document, variables }, round);
    const result = JSON.parse(reply.content.find(block => block.type === 'text')!.text!);
    if (result.errors?.length || result.extensions?.complete !== true) throw new Error(`Incomplete GraphQL benchmark result: ${JSON.stringify(result)}`);
    return result.data;
  }
  async graphAll(document: string, root: string, variables: Record<string, unknown> = {}, pageAt = (data: any) => data[root]): Promise<any[]> {
    const rows: any[] = [];
    let offset = 0, round = 1;
    do {
      const data = await this.graph(document, { ...variables, limit: this.pageSize, offset }, round++);
      const result = pageAt(data);
      if (result.offset !== offset || result.count !== result.nodes.length) throw new Error('Invalid GraphQL page metadata.');
      rows.push(...result.nodes);
      const nextOffset = result.offset + result.count;
      if (nextOffset >= result.totalCount) break;
      if (nextOffset <= offset) throw new Error('GraphQL pagination did not advance.');
      offset = nextOffset;
    } while (true);
    return rows;
  }
  async legacyCount(kind: string, args: Record<string, unknown> = {}): Promise<number> {
    const reply = await this.call(`query_${kind}`, { ...args, detail: 'index', limit: 1 }, 1);
    const text = reply.content.find(block => block.type === 'text')!.text!;
    const match = /^\d+ of (\d+)\n/.exec(text);
    if (!match || text.includes('⚠')) throw new Error('Incomplete legacy count result.');
    return Number(match[1]);
  }
  async legacy(kind: string, args: Record<string, unknown> = {}, detail = 'metadata', startRound = 1, limit = this.pageSize, maxRows?: number): Promise<LegacyRow[]> {
    const rows: LegacyRow[] = [];
    let offset = 0, round = startRound;
    do {
      const reply = await this.call(`query_${kind}`, { ...args, detail, offset, limit }, round++);
      const text = reply.content.find(block => block.type === 'text')!.text!;
      if (text.includes('⚠')) throw new Error(`Incomplete legacy benchmark result: ${text}`);
      const match = /^(\d+) of (\d+)\noffset: \d+\nlimit: \d+\nnext_offset: (null|\d+)\n\n([\s\S]*)$/.exec(text);
      if (!match) throw new Error('Unexpected legacy pagination response.');
      const count = Number(match[1]);
      const body = match[4];
      if (detail === 'index') {
        for (const line of body.split('\n').slice(0, count)) {
          const separator = line.indexOf(' — ');
          if (separator < 0) throw new Error('Unexpected legacy index record.');
          rows.push({ id: line.slice(0, separator).replace(/^#artifact\//, ''), description: line.slice(separator + 3) });
        }
      } else {
        const chunks = body.split(/(?=^id: )/m).filter(chunk => chunk.startsWith('id: '));
        if (chunks.length !== count) throw new Error('Unexpected legacy record framing.');
        for (const chunk of chunks) {
          const row = parseYaml(chunk) as LegacyRow;
          if (typeof row.id !== 'string') throw new Error('Legacy record has no string ID.');
          if (row.body !== undefined) row.body = row.body.trimEnd();
          if (row.content !== undefined) row.content = row.content.trimEnd();
          rows.push(row);
        }
      }
      if (maxRows !== undefined && rows.length >= maxRows) return rows.slice(0, maxRows);
      if (match[3] === 'null') break;
      const next = Number(match[3]);
      if (next <= offset) throw new Error('Legacy pagination did not advance.');
      offset = next;
    } while (true);
    return rows;
  }
}

export interface CanonicalCase {
  id: string; question: string; document: string;
  graphql(ctx: Context, fixture: Fixture): Promise<unknown>;
  legacy(ctx: Context, fixture: Fixture): Promise<unknown>;
  expected(fixture: Fixture): unknown;
}
const unfinishedActions = (f: Fixture) => new Set(f.actions.filter(a => a.unfinished).map(a => a.id));
const hasAny = (values: Set<string> | undefined, ids: Set<string>) => [...(values ?? [])].some(id => ids.has(id));
const connectedEntries = (rows: LegacyRow[], project: string) => rows.filter(row => entryEntityIds({
  meta: { created: row.id, projects: row.projects, actions: row.actions }, content: row.content ?? '',
}, 'project').includes(project));
const latest = (rows: { id: string; content?: string }[]) => rows.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 3).map(row => ({ id: row.id, content: row.content }));

const catchUpDocument = `query CatchUp($id: ID!) {
  project(id: $id) {
    id name body
    actions(where: {${unfinished}}, limit: 100) { nodes { id name deadline } }
    entries(limit: 3) { nodes { id content } }
    artifacts(limit: 100) { nodes { id description } }
    relatedProjects(limit: 100) { nodes { project { id name } } }
  }
}`;
const overdueDocument = `query Overdue${params} {
  actions(where: {${unfinished}, deadlineTo: "${DAY}", projects: {some: {status: OPEN}}}, ${page}) {
    nodes { id name deadline projects(where: {status: OPEN}, limit: 100) { nodes { id name } } }
    offset count totalCount
  }
}`;
const unassignedDocument = `query Unassigned${params} {
  actions(where: {projects: {none: {}}}, ${page}) { nodes { id name } offset count totalCount }
}`;
const artifactsDocument = (indirect: boolean) => `query ${indirect ? 'Indirect' : 'Direct'}Artifacts${params} {
  artifacts(where: {${indirect ? `projects: {some: {actions: {some: {${unfinished}}}}}` : `actions: {some: {${unfinished}}}`}}, ${page}) {
    nodes { id description } offset count totalCount
  }
}`;
const stalledDocument = `query Stalled${params} {
  projects(where: {status: OPEN, actions: {some: {${unfinished}}}, entries: {none: {createdFrom: "${SINCE}"}}}, ${page}) {
    nodes { id name } offset count totalCount
  }
}`;
const searchDocument = `query SearchContext($id: ID!) {
  project(id: $id) { actions(where: {${unfinished}, search: "review|migration"}, limit: 100) { nodes { id name deadline } } }
}`;

export const CASES: CanonicalCase[] = [
  {
    id: 'project-catch-up', question: 'Catch up on one project: body, unfinished actions, latest three entries, artifacts, and related projects.', document: catchUpDocument,
    async graphql(ctx, f) {
      const p = (await ctx.graph(catchUpDocument, { id: f.focus })).project;
      return { ...idName({ id: p.id, name: p.name }), body: p.body,
        actions: sorted(p.actions.nodes.map((a: any) => actionRow(a))),
        entries: latest(p.entries.nodes), artifacts: sorted(p.artifacts.nodes.map(artifactRow)),
        related: sorted(p.relatedProjects.nodes.map((relation: any) => idName({ id: relation.project.id, name: relation.project.name }))),
      };
    },
    async legacy(ctx, f) {
      const [projects, actions, tagged, mentioned, artifacts, reverse] = await ctx.parallel([
        ctx.legacy('projects', { ids: [f.focus] }, 'full', 1, 100),
        ctx.legacy('actions', { projects: [f.focus], status: ['backlog', 'scheduled'] }, 'metadata', 1, 100),
        ctx.legacy('entries', { projects: [f.focus] }, 'full', 1, 3, 3),
        ctx.legacy('entries', { search: `#project/${f.focus}(?![\\w-])` }, 'full', 1, 100),
        ctx.legacy('artifacts', { projects: [f.focus] }, 'index', 1, 100),
        ctx.legacy('projects', { related_to: [f.focus] }, 'metadata', 1, 100),
      ]);
      const relatedIds = [...new Set([...(projects[0].related_projects ?? []).map(link => link.project), ...reverse.map(p => p.id)])];
      const related = relatedIds.length ? await ctx.legacy('projects', { ids: relatedIds }, 'metadata', ctx.metrics.rounds + 1, 100) : [];
      const entries = [...new Map([...tagged, ...connectedEntries(mentioned, f.focus)].map(entry => [entry.id, entry])).values()];
      return { ...idName(projects[0]), body: projects[0].body, actions: sorted(actions.map(actionRow)), entries: latest(entries), artifacts: sorted(artifacts.map(artifactRow)), related: sorted(related.map(idName)) };
    },
    expected(f) {
      const project = f.projects.find(p => p.id === f.focus)!;
      const actions = f.projectActions.get(f.focus) ?? new Set();
      const entries = f.projectEntries.get(f.focus) ?? new Set();
      return { ...idName(project), body: project.body,
        actions: sorted(f.actions.filter(a => actions.has(a.id) && a.unfinished).map(actionRow)),
        entries: latest(f.entries.filter(e => entries.has(e.id))),
        artifacts: sorted(f.artifacts.filter(a => f.artifactProjects.get(a.id)?.has(f.focus)).map(artifactRow)),
        related: sorted(f.projects.filter(p => project.related.includes(p.id) || p.related.includes(f.focus)).map(idName)),
      };
    },
  },
  {
    id: 'overdue-open-projects', question: 'Which unfinished actions are overdue and associated with an open project?', document: overdueDocument,
    async graphql(ctx) {
      return sorted((await ctx.graphAll(overdueDocument, 'actions')).map(a => ({ ...actionRow(a), projects: sorted(a.projects.nodes.map((p: any) => idName({ id: p.id, name: p.name }))) })));
    },
    async legacy(ctx) {
      const projects = await ctx.legacy('projects', { status: 'open' });
      if (!projects.length) return [];
      const open = new Map(projects.map(p => [p.id, p]));
      const actions = await ctx.legacy('actions', { status: ['backlog', 'scheduled'], deadline_to: DAY, projects: [...open.keys()] }, 'metadata', ctx.metrics.rounds + 1);
      return sorted(actions.map(a => ({ ...actionRow(a), projects: sorted((a.projects ?? []).filter(id => open.has(id)).map(id => idName(open.get(id)!))) })));
    },
    expected(f) {
      const open = new Map(f.projects.filter(p => !p.closed).map(p => [p.id, p]));
      return sorted(f.actions.filter(a => a.unfinished && a.deadline != null && a.deadline <= DAY && hasAny(f.actionProjects.get(a.id), new Set(open.keys())))
        .map(a => ({ ...actionRow(a), projects: sorted([...(f.actionProjects.get(a.id) ?? [])].filter(id => open.has(id)).map(id => idName(open.get(id)!))) })));
    },
  },
  {
    id: 'unassigned-actions', question: 'Which actions have no associated project?', document: unassignedDocument,
    async graphql(ctx) { return sorted((await ctx.graphAll(unassignedDocument, 'actions')).map(a => idName({ id: a.id, name: a.name }))); },
    async legacy(ctx) { return sorted((await ctx.legacy('actions', { projects: [] })).map(idName)); },
    expected(f) { return sorted(f.actions.filter(a => !f.actionProjects.get(a.id)?.size).map(idName)); },
  },
  ...[false, true].map((indirect): CanonicalCase => ({
    id: indirect ? 'artifacts-via-project-work' : 'artifacts-for-unfinished-actions',
    question: indirect ? 'Which artifacts belong to projects that have unfinished actions?' : 'Which artifacts are directly associated with unfinished actions?',
    document: artifactsDocument(indirect),
    async graphql(ctx) { return sorted((await ctx.graphAll(artifactsDocument(indirect), 'artifacts')).map(artifactRow)); },
    async legacy(ctx) {
      const actions = await ctx.legacy('actions', { status: ['backlog', 'scheduled'] }, indirect ? 'metadata' : 'index');
      const ids = indirect ? [...new Set(actions.flatMap(a => a.projects ?? []))] : actions.map(a => a.id);
      if (!ids.length) return [];
      return sorted((await ctx.legacy('artifacts', { [indirect ? 'projects' : 'actions']: ids }, 'index', ctx.metrics.rounds + 1)).map(artifactRow));
    },
    expected(f) {
      const actions = unfinishedActions(f);
      const projects = new Set(f.projects.filter(p => hasAny(f.projectActions.get(p.id), actions)).map(p => p.id));
      return sorted(f.artifacts.filter(a => hasAny((indirect ? f.artifactProjects : f.artifactActions).get(a.id), indirect ? projects : actions)).map(artifactRow));
    },
  })),
  {
    id: 'stalled-projects', question: 'Which open projects have unfinished actions and no entry since the cutoff?', document: stalledDocument,
    async graphql(ctx) { return sorted((await ctx.graphAll(stalledDocument, 'projects')).map(p => idName({ id: p.id, name: p.name }))); },
    async legacy(ctx) {
      const [projects, actions, entries] = await ctx.parallel([
        ctx.legacy('projects', { status: 'open' }), ctx.legacy('actions', { status: ['backlog', 'scheduled'] }),
        ctx.legacy('entries', { created_from: SINCE }, 'full'),
      ]);
      const active = new Set(actions.flatMap(a => a.projects ?? []));
      const recent = new Set(entries.flatMap(e => entryEntityIds({ meta: { created: e.id, projects: e.projects, actions: e.actions }, content: e.content ?? '' }, 'project')));
      return sorted(projects.filter(p => active.has(p.id) && !recent.has(p.id)).map(idName));
    },
    expected(f) {
      const unfinished = unfinishedActions(f);
      const recent = new Set(f.entries.filter(e => e.id.slice(0, 10) >= SINCE).flatMap(e => [...e.projects, ...e.mentionedProjects]));
      return sorted(f.projects.filter(p => !p.closed && hasAny(f.projectActions.get(p.id), unfinished) && !recent.has(p.id)).map(idName));
    },
  },
  {
    id: 'project-action-regex', question: 'Find unfinished review or migration actions within one project.', document: searchDocument,
    async graphql(ctx, f) {
      const data = await ctx.graph(searchDocument, { id: f.focus });
      return sorted(data.project.actions.nodes.map((a: any) => actionRow(a)));
    },
    async legacy(ctx, f) { return sorted((await ctx.legacy('actions', { projects: [f.focus], status: ['backlog', 'scheduled'], search: 'review|migration' }, 'metadata', 1, 100)).map(actionRow)); },
    expected(f) { return sorted(f.actions.filter(a => a.unfinished && f.projectActions.get(f.focus)?.has(a.id) && /review|migration/i.test(a.name + '\n' + a.body)).map(actionRow)); },
  },
  ...EXTENDED_CASES,
];
