import type { CanonicalCase } from './cases.js';
import { DAY, SINCE, type Fixture } from './fixture.js';

const sort = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
const named = (p: { id: string; name?: string }) => ({ id: p.id, name: p.name });
const args = '($limit: Int!, $offset: Int!)';
const page = 'limit: $limit, offset: $offset';
const next = 'offset count totalCount';
const batchIds = (f: Fixture) => f.actions.filter((_, i) => i % 2 === 0).map(a => a.id);
const batch = `query Batch($ids: [ID!]!, $limit: Int!, $offset: Int!) {
  actions(where: {ids: $ids, status: [BACKLOG, SCHEDULED]}, ${page}) { nodes { id name } ${next} }
}`;
const all = `query Index${args} { actions(${page}) { nodes { id description } ${next} } }`;
const history = `query History($id: ID!, $limit: Int!, $offset: Int!) {
  project(id: $id) { entries(${page}) { nodes { id content } ${next} } }
}`;
const regex = 'Progress [0-9]*0\\.';
const recent = `query Recent${args} {
  entries(where: {createdFrom: "${SINCE}", search: ${JSON.stringify(regex)}}, ${page}) { nodes { id content } ${next} }
}`;
const joined = `query Joined${args} {
  entries(where: {actions: {some: {projects: {some: {status: OPEN}}}}}, ${page}) { nodes { id } ${next} }
}`;
const related = `query Related${args} {
  projects(where: {relatedProjects: {some: {status: OPEN}}}, ${page}) { nodes { id name } ${next} }
}`;
const boolean = `query Boolean${args} {
  actions(where: {and: [{status: [BACKLOG, SCHEDULED]}, {or: [{deadlineTo: "${DAY}"}, {projects: {none: {}}}]}]}, ${page}) {
    nodes { id name } ${next}
  }
}`;
const counts = `query Counts {
  projects(where: {status: OPEN}) { totalCount }
  actions(where: {status: [BACKLOG, SCHEDULED]}) { totalCount }
  entries(where: {createdFrom: "${SINCE}"}) { totalCount }
  artifacts { totalCount }
}`;

export const EXTENDED_CASES: CanonicalCase[] = [
  {
    id: 'exact-project', question: 'Read the name of one project by exact ID.', document: 'query Exact($id: ID!) { project(id: $id) { id name } }',
    async graphql(ctx, f) { const p = (await ctx.graph(this.document, { id: f.focus })).project; return named({ id: p.id, name: p.name }); },
    expected(f) { return named(f.projects.find(p => p.id === f.focus)!); },
  },
  {
    id: 'action-id-batch', question: 'Read unfinished actions from an explicit batch containing half the action IDs.', document: batch,
    async graphql(ctx, f) { return sort((await ctx.graphAll(batch, 'actions', { ids: batchIds(f) })).map(a => named({ id: a.id, name: a.name }))); },
    expected(f) { const ids = new Set(batchIds(f)); return sort(f.actions.filter(a => ids.has(a.id) && a.unfinished).map(named)); },
  },
  {
    id: 'empty-result', question: 'Look up a nonexistent action using an exact collection filter.', document: '{ actions(where: {ids: ["missing-action"]}) { totalCount nodes { id } } }',
    async graphql(ctx) { return (await ctx.graph(this.document, {})).actions.nodes; },
    expected() { return []; },
  },
  {
    id: 'all-action-index', question: 'Enumerate every action ID and description, with exhaustive pagination.', document: all,
    async graphql(ctx) { return sort(await ctx.graphAll(all, 'actions')); },
    expected(f) { return sort(f.actions.map(a => ({ id: a.id, description: a.description }))); },
  },
  {
    id: 'project-entry-history', question: 'Read all tagged and inline-linked entries of one project, paginating its nested collection.', document: history,
    async graphql(ctx, f) { return sort(await ctx.graphAll(history, 'project', { id: f.focus }, d => d.project.entries)); },
    expected(f) { const ids = f.projectEntries.get(f.focus)!; return sort(f.entries.filter(e => ids.has(e.id)).map(e => ({ id: e.id, content: e.content }))); },
  },
  {
    id: 'recent-entry-regex', question: 'Search recent entries globally for progress numbers ending in zero, returning full content.', document: recent,
    async graphql(ctx) { return sort(await ctx.graphAll(recent, 'entries')); },
    expected(f) { const pattern = new RegExp(regex, 'i'); return sort(f.entries.filter(e => e.id.slice(0, 10) >= SINCE && pattern.test(e.content)).map(e => ({ id: e.id, content: e.content }))); },
  },
  {
    id: 'entries-via-open-work', question: 'Find entries whose tagged action is associated with any open project, through two relationship hops.', document: joined,
    async graphql(ctx) { return sort(await ctx.graphAll(joined, 'entries')); },
    expected(f) {
      const open = new Set(f.projects.filter(p => !p.closed).map(p => p.id));
      const actions = new Set(f.actions.filter(a => [...(f.actionProjects.get(a.id) ?? [])].some(id => open.has(id))).map(a => a.id));
      return sort(f.entries.filter(e => e.actions.some(id => actions.has(id))).map(e => ({ id: e.id })));
    },
  },
  {
    id: 'related-open-projects', question: 'Find projects with a declared or reverse link to an open project.', document: related,
    async graphql(ctx) { return sort((await ctx.graphAll(related, 'projects')).map(p => named({ id: p.id, name: p.name }))); },
    expected(f) { const open = new Set(f.projects.filter(p => !p.closed).map(p => p.id)); return sort(f.projects.filter(p => p.related.some(id => open.has(id)) || f.projects.some(other => open.has(other.id) && other.related.includes(p.id))).map(named)); },
  },
  {
    id: 'boolean-action-filter', question: 'Find unfinished actions that are overdue or have no project, using and/or/none.', document: boolean,
    async graphql(ctx) { return sort((await ctx.graphAll(boolean, 'actions')).map(a => named({ id: a.id, name: a.name }))); },
    expected(f) { return sort(f.actions.filter(a => a.unfinished && (a.deadline != null && a.deadline <= DAY || !f.actionProjects.get(a.id)?.size)).map(named)); },
  },
  {
    id: 'dashboard-counts', question: 'Count open projects, unfinished actions, recent entries, and artifacts in one dashboard.', document: counts,
    async graphql(ctx) { const d = await ctx.graph(counts, {}); return Object.fromEntries(Object.entries(d).map(([kind, c]: [string, any]) => [kind, c.totalCount])); },
    expected(f) { return { projects: f.projects.filter(p => !p.closed).length, actions: f.actions.filter(a => a.unfinished).length, entries: f.entries.filter(e => e.id.slice(0, 10) >= SINCE).length, artifacts: f.artifacts.length }; },
  },
];
