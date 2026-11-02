import type { StoreView as Store, Relations } from '../../cli/src/core/data-snapshot';
import { entityKey, extractAssetLinks, weekFilePath, type Entry, type IndexItem } from '../lib/types';
import { groupOpenActions, orderByActivity, type OpenActionGroups } from './instance';
import { entityAssets, entityStats } from './entity-relations';
import { buildProjectForest } from './hierarchy';
import {
  formatStamp,
  type ActionCensus, type ActionSummaryData, type EntityRelations, type InstanceDetailData,
  type InstanceSummaryData, type ProjectDetailData, type ProjectSummaryData, type FieldValue,
} from './render';

// The derived records behind the side panel and the reader: each scope's
// summary and detail data, computed from the store's caches and relation map.

// The cached action records for a set of ids — init's eager load has them.
async function loadActions(store: Store, ids: string[]) {
  return (await Promise.all(ids.map(async (id) => {
    const action = await store.getAction(id).catch(() => null);
    return action && { id, action };
  }))).filter((a) => !!a);
}

// Projection pages stay outside saved record counts and indexes.
export function planningSignature(page: Awaited<ReturnType<Store['getPlanningActions']>>): string {
  return JSON.stringify([page.nodes.map(row => row.id), page.issues]);
}

async function planningGroups(store: Store, saved: Awaited<ReturnType<typeof loadActions>>, relations: Relations, project?: string, pages = 1): Promise<OpenActionGroups> {
  const rows = [...saved];
  const page = await store.getPlanningActions(project);
  const planning = saved.some(row => row.action.frontMatter.recurrence) ? { pages: 0, signature: planningSignature(page) } : undefined;
  const append = (page: Awaited<ReturnType<Store['getPlanningActions']>>): OpenActionGroups => {
    rows.push(...page.nodes);
    const groups = groupOpenActions(rows, id => latestEntry(relations, 'action', id));
    groups.issues = page.issues;
    if (planning) { planning.pages++; groups.planning = planning; }
    if (page.next) groups.loadMore = async () => append(await store.getPlanningActions(project, page.next!));
    return groups;
  };
  let groups = append(page);
  for (let i = 1; i < pages && groups.loadMore; i++) groups = await groups.loadMore();
  return groups;
}

// How many of the given projects are open — ended ones counted out. The
// records are cached by init's eager load.
async function countOpenProjects(store: Store, ids: string[]): Promise<number> {
  const records = await Promise.all(ids.map((pid) => store.getProject(pid).catch(() => null)));
  return records.filter((p) => p && !p.frontMatter.ended).length;
}

// The newest entry mentioning an entity — the relation lists are reverse
// chronological, so it heads the list.
function latestEntry(relations: Relations, type: 'project' | 'action', id: string): string | undefined {
  return relations.entriesByEntity.get(entityKey(type, id))?.[0];
}

// An indexed entity's one-line description.
export function indexDescription(items: IndexItem[], id: string): string | undefined {
  return items.find((item) => item.id === id)?.description;
}

// Actions by state, in index order with index descriptions — the census the
// project and instance details share; `ids` scopes it to one project's actions.
async function actionCensus(store: Store, ids?: Set<string>): Promise<ActionCensus> {
  const census: ActionCensus = { open: [], done: [], cancelled: [] };
  const states = await Promise.all(store.getActionIndex().filter((item) => !ids || ids.has(item.id)).map(async (item) => {
    const action = await store.getAction(item.id).catch(() => null);
    return action && { item, state: action.frontMatter.resolution ?? ('open' as const) };
  }));
  for (const s of states) if (s) census[s.state].push({ id: s.item.id, description: s.item.description });
  return census;
}

// A project's panel data: the instance's live-state sections scoped by
// co-occurrence, its explicit related projects by recent activity, its
// linked assets, and its stats.
export async function projectSummaryData(id: string, store: Store, relations: Relations, pages = 1): Promise<ProjectSummaryData> {
  const actionIds = relations.actionsByProject.get(id) ?? [];
  const actions = await loadActions(store, actionIds);
  const groups = await planningGroups(store, actions, relations, id, pages);
  const related = orderByActivity(relations.relatedProjects.get(id) ?? [], eid => latestEntry(relations, 'project', eid)).map((r) => r.id);
  return {
    actions: groups,
    related,
    assets: entityAssets('project', id, relations),
    updated: latestEntry(relations, 'project', id),
    stats: {
      // Totals count the record set — an action whose file fails to load
      // still counts.
      projects: { open: await countOpenProjects(store, related), total: related.length },
      actions: { open: actions.filter(a => !a.action.frontMatter.resolution).length, total: actionIds.length },
      entries: (relations.entriesByEntity.get(entityKey('project', id)) ?? []).length,
    },
  };
}

// An action's panel data: its co-occurring projects by recent activity, its
// linked assets, and its stats.
export async function actionSummaryData(id: string, store: Store, relations: Relations): Promise<ActionSummaryData> {
  const entries = relations.entriesByEntity.get(entityKey('action', id)) ?? [];
  const projects = orderByActivity((relations.projectsByAction.get(id.startsWith('~') ? store.getCachedAction(id)?.frontMatter.occurrence?.template ?? id : id) ?? []).map((p) => ({ id: p })), eid => latestEntry(relations, 'project', eid))
    .map((p) => p.id);
  return {
    projected: id.startsWith('~'),
    projects,
    assets: entityAssets('action', id, relations),
    updated: entries[0],
    stats: {
      projects: { open: await countOpenProjects(store, projects), total: projects.length },
      entries: entries.length,
    },
  };
}

// The project detail's derived record: its actions by state (index order,
// with index descriptions) and its stats.
export async function projectDetailData(id: string, store: Store, relations: Relations): Promise<ProjectDetailData> {
  const actions = await actionCensus(store, new Set(relations.actionsByProject.get(id) ?? []));
  return { actions, stats: entityStats('project', id, relations) };
}

// The links shown with an entry's detail — its tagged projects and actions
// and the assets its content links.
export function entryRelations(entry: Entry): EntityRelations {
  return {
    projects: entry.meta.projects ?? [],
    actions: entry.meta.actions ?? [],
    assets: extractAssetLinks(entry.content, weekFilePath(entry.weekFile)),
  };
}

// The open (not ended) project index items, in index order. The records are
// already cached by init's eager load.
async function openProjectItems(store: Store): Promise<IndexItem[]> {
  return (await Promise.all(store.getProjectIndex().map(async (item) => {
    const project = await store.getProject(item.id).catch(() => null);
    return project && !project.frontMatter.ended ? item : null;
  }))).filter((p) => p !== null);
}

// The instance summary's data: the open work — projects by last activity,
// actions grouped by date kind — and the linked assets, dated by their
// latest linking entry (entriesByAsset lists are reverse-sorted, so the
// latest is the head).
export async function instanceSummaryData(store: Store, pages = 1): Promise<InstanceSummaryData> {
  const relations = await store.getRelations();
  const projects = orderByActivity(await openProjectItems(store), id => latestEntry(relations, 'project', id))
    .map((item) => ({ id: item.id, updated: latestEntry(relations, 'project', item.id) }));
  const actions = await loadActions(store, store.getActionIndex().map((item) => item.id));
  const groups = await planningGroups(store, actions, relations, undefined, pages);
  const assets = [...relations.entriesByAsset].map(([path, entries]) => ({ path, updated: entries[0] }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
  return {
    projects,
    actions: groups,
    assets,
    latest: store.getNoteIndex()[0]?.id,
    stats: {
      projects: { open: projects.length, total: store.getProjectIndex().length },
      actions: { open: actions.filter(a => !a.action.frontMatter.resolution).length, total: store.getActionIndex().length },
      entries: store.getNoteIndex().length,
    },
  };
}

// The instance detail's census: everything there is — the whole project
// forest, every action by state, and the instance-wide numbers.
export async function instanceDetailData(store: Store): Promise<InstanceDetailData> {
  const relations = await store.getRelations();
  const projectIndex = store.getProjectIndex();
  const projects = buildProjectForest(projectIndex, relations.relatedProjects);
  const actions = await actionCensus(store);

  const noteIndex = store.getNoteIndex();
  const openProjects = (await openProjectItems(store)).length;
  const totalActions = actions.open.length + actions.done.length + actions.cancelled.length;
  const stats: [string, FieldValue][] = [
    ['Entries', noteIndex.length ? current => `${noteIndex.length} · latest ${formatStamp(noteIndex[0].id.slice(0, 10), current)}` : '0'],
    ['Projects', `${projectIndex.length} · ${openProjects} open`],
    ['Actions', `${totalActions} · ${actions.open.length} open · ${actions.done.length} done · ${actions.cancelled.length} cancelled`],
  ];
  return { projects, actions, stats };
}
