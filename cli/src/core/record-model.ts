// The shared, I/O-free record model. Loaders own discovery and completeness;
// these derivations operate only on authored record content and metadata.
import type { Entry, Project, Action, Artifact } from './types.js';
import { entityKey, entryEntityIds, weekFilePath, entityFilePath, extractAssetLinks, type AssetLink } from './record-reference.js';
import { artifactHandle, parseArtifactHandle, extractArtifactReferences, type ArtifactReferenceSource } from './artifact-reference.js';

export interface RecordCollection {
  entries: readonly Entry[];
  projects: ReadonlyMap<string, Project>;
  actions: ReadonlyMap<string, Action>;
  artifacts: ReadonlyMap<string, Artifact>;
}

export function artifactReferenceSources(records: RecordCollection): ArtifactReferenceSource[] {
  return [
    ...records.entries.map(entry => ({
      handle: `#entry/${entry.meta.created}`, markdown: entry.content,
      projects: entry.meta.projects, actions: entry.meta.actions,
    })),
    ...[...records.projects].map(([id, project]) => ({ handle: `#project/${id}`, markdown: project.body, projects: [id] })),
    ...[...records.actions].map(([id, action]) => ({ handle: `#action/${id}`, markdown: action.body, actions: [id] })),
    ...[...records.artifacts].map(([id, artifact]) => ({ handle: `#artifact/${id}`, markdown: artifact.body })),
  ];
}

export interface Relations {
  entriesByEntity: Map<string, string[]>;   // #project/id or #action/id → entry ids
  actionsByProject: Map<string, string[]>;  // co-occurrence in entries
  projectsByAction: Map<string, string[]>;  // co-occurrence in entries
  // Explicit related_projects, both directions; reverse links carry the
  // description declared on the other project.
  relatedProjects: Map<string, { id: string; description: string; reverse: boolean }[]>;
  assetsByEntity: Map<string, AssetLink[]>; // complete entity handle → links from its entries or body
  entriesByAsset: Map<string, string[]>;    // asset path → entry ids linking it
  artifactBacklinks: Map<string, string[]>; // artifact id → source handles
  projectsByArtifact: Map<string, string[]>;
  actionsByArtifact: Map<string, string[]>;
  artifactsByEntity: Map<string, string[]>; // record handle → contextually associated artifact ids
}

export function buildRelations(records: RecordCollection, sources: readonly ArtifactReferenceSource[], availableAttachments?: ReadonlySet<string>): Relations {
  const rel: Relations = {
    entriesByEntity: new Map(),
    actionsByProject: new Map(),
    projectsByAction: new Map(),
    relatedProjects: new Map(),
    assetsByEntity: new Map(),
    entriesByAsset: new Map(),
    artifactBacklinks: new Map(),
    projectsByArtifact: new Map(),
    actionsByArtifact: new Map(),
    artifactsByEntity: new Map(),
  };

  const pushUnique = <T>(map: Map<string, T[]>, key: string, value: T, eq: (a: T, b: T) => boolean) => {
    const list = map.get(key) ?? [];
    if (!list.some((v) => eq(v, value))) list.push(value);
    map.set(key, list);
  };
  const memberships = new Map<string[], Set<string>>();
  const add = (map: Map<string, string[]>, key: string, value: string) => {
    let list = map.get(key);
    if (!list) { list = []; map.set(key, list); memberships.set(list, new Set()); }
    const seen = memberships.get(list)!;
    if (!seen.has(value)) { seen.add(value); list.push(value); }
  };
  const addAsset = (key: string, asset: AssetLink) =>
    pushUnique(rel.assetsByEntity, key, asset, (a, b) => a.path === b.path);

  // Every entity mentioned anywhere — front matter or inline body — so a
  // filtered flow and its entry count include the entries a filter can be
  // engaged from. Co-occurrence and asset links stay metadata-only: those
  // read "tagged together", the design's source of truth for relations.
  for (const entry of [...records.entries].sort((a, b) => descending(a.meta.created, b.meta.created))) {
    const { created, projects = [], actions = [] } = entry.meta;
    const allProjects = entryEntityIds(entry, 'project');
    const allActions = entryEntityIds(entry, 'action');
    for (const id of allProjects) add(rel.entriesByEntity, entityKey('project', id), created);
    for (const id of allActions) add(rel.entriesByEntity, entityKey('action', id), created);
    for (const p of projects) for (const a of actions) {
      add(rel.actionsByProject, p, a);
      add(rel.projectsByAction, a, p);
    }
    const assets = extractAssetLinks(entry.content, weekFilePath(entry.weekFile));
    for (const asset of assets) {
      for (const id of projects) addAsset(entityKey('project', id), asset);
      for (const id of actions) addAsset(entityKey('action', id), asset);
      add(rel.entriesByAsset, asset.path, created);
    }
  }

  // Explicit project links, plus assets referenced from entity bodies.
  for (const [id, action] of records.actions) {
    const template = action.frontMatter.occurrence?.template;
    if (!template || !records.actions.get(template)?.frontMatter.recurrence) continue;
    for (const project of rel.projectsByAction.get(template) ?? []) {
      add(rel.projectsByAction, id, project);
      add(rel.actionsByProject, project, id);
    }
  }
  for (const [id, project] of [...records.projects].sort(([a], [b]) => descending(a, b))) {
    for (const r of project.frontMatter.related_projects ?? []) {
      // `reverse` is part of the identity: two projects declaring each other
      // must keep both directions, not drop whichever lands second (which
      // direction that is depends on fetch completion order).
      pushUnique(rel.relatedProjects, id, { id: r.project, description: r.description, reverse: false }, (a, b) => a.id === b.id && a.reverse === b.reverse);
      pushUnique(rel.relatedProjects, r.project, { id, description: r.description, reverse: true }, (a, b) => a.id === b.id && a.reverse === b.reverse);
    }
    for (const asset of extractAssetLinks(project.body, entityFilePath('project', id))) {
      addAsset(entityKey('project', id), asset);
    }
  }
  for (const [id, action] of [...records.actions].sort(([a], [b]) => descending(a, b))) {
    for (const asset of extractAssetLinks(action.body, entityFilePath('action', id))) {
      addAsset(entityKey('action', id), asset);
    }
  }

  for (const source of sources) {
    const sourceArtifact = parseArtifactHandle(source.handle);
    if (sourceArtifact?.filename !== undefined) continue;
    const own = sourceArtifact?.id;
    for (const ref of extractArtifactReferences(source.markdown)) {
      if (ref.id === own || !records.artifacts.has(ref.id)) continue;
      // Invalid references remain visible in prose but never create a
      // relationship or a filesystem request.
      let handle: string;
      try { handle = artifactHandle(ref.id, ref.filename); }
      catch { continue; }
      if (ref.filename !== undefined && !(availableAttachments?.has(handle)
        ?? records.artifacts.get(ref.id)!.frontMatter.attachments?.includes(ref.filename))) continue;
      if (ref.filename === undefined) add(rel.artifactBacklinks, ref.id, source.handle);
      if (source.handle.startsWith('#entry/')) add(rel.artifactsByEntity, source.handle, ref.id);
      for (const project of source.projects ?? []) {
        add(rel.projectsByArtifact, ref.id, project);
        add(rel.artifactsByEntity, entityKey('project', project), ref.id);
      }
      for (const action of source.actions ?? []) {
        add(rel.actionsByArtifact, ref.id, action);
        add(rel.artifactsByEntity, entityKey('action', action), ref.id);
      }
    }
  }

  for (const map of [rel.entriesByEntity, rel.actionsByProject, rel.projectsByAction, rel.entriesByAsset, rel.artifactBacklinks, rel.projectsByArtifact, rel.actionsByArtifact, rel.artifactsByEntity]) {
    for (const list of map.values()) list.sort().reverse();
  }
  for (const list of rel.assetsByEntity.values()) {
    list.sort((a, b) => descending(a.path, b.path));
  }
  for (const list of rel.relatedProjects.values()) {
    list.sort((a, b) => descending(a.id, b.id) || Number(a.reverse) - Number(b.reverse));
  }

  return rel;
}

function descending(a: string, b: string): number { return a < b ? 1 : a > b ? -1 : 0; }
