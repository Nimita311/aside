import { join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { artifactHandle, artifactAttachmentRelativePath, assertArtifactId, assertAttachmentFilename } from '../core/artifact-reference.js';
import { contentAttachmentPath } from '../core/content-attachment.js';
import { extractContentReferences, type ContentReference } from '../core/content-reference.js';
import { entityFilePath, weekFilePath } from '../core/record-reference.js';
import type { ParseIssue } from '../core/types.js';
import type { Kind, RecordNode } from './query.js';

export type ReferenceRecords = Record<Kind, ReadonlyMap<string, RecordNode>>;
export interface AttachmentNode {
  __typename: 'Attachment';
  filename: string;
  handle: string;
  filePath: string;
}
type ReferenceTarget = RecordNode | AttachmentNode;
export interface ReferencePage {
  nodes: ReferenceTarget[];
  offset: number;
  count: number;
  totalCount: number;
}
export interface ReferenceGraph {
  issues: ParseIssue[];
  links(source: ReferenceTarget | string): readonly RecordNode[];
  attachmentLinks(source: ReferenceTarget | string): readonly AttachmentNode[];
  backlinks(target: ReferenceTarget | string): readonly RecordNode[];
  page(source: ReferenceTarget | string, direction: 'links' | 'attachmentLinks' | 'backlinks', offset?: number, limit?: number): ReferencePage;
}

export function referenceFilePath(root: string, node: RecordNode): string | null {
  if (node.projected) return null;
  const existing = (node as RecordNode & { filePath?: string | null }).filePath;
  return existing === undefined ? join(root, node.kind === 'entry' ? weekFilePath(node.record.weekFile) : entityFilePath(node.kind, node.id)) : existing;
}

// Snapshot-owned record Markdown and metadata. Attachments are targets only:
// validate their paths, but never inspect bytes to discover references.
// No Store reload, housekeeping, scheduling, or record write occurs here.
export function buildReferenceGraph(root: string, records: ReferenceRecords, signal?: AbortSignal): ReferenceGraph {
  const targets = new Map<string, ReferenceTarget>();
  const targetPaths = new Map<string, string>();
  const forward = new Map<string, Set<string>>();
  const attachmentForward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const issues: ParseIssue[] = [];
  const sources: { node: RecordNode; markdown: string; filePath: string; baseFile: string; projected: boolean }[] = [];
  const missing = new Set<string>();
  const check = () => { if (signal?.aborted) throw new Error('GraphQL request cancelled.'); };
  const add = (map: Map<string, Set<string>>, key: string, value: string) => {
    const values = map.get(key) ?? new Set();
    values.add(value); map.set(key, values);
  };
  const report = (file: string, message: string, code = 'content_reference_missing') => {
    const key = `${file}\0${message}`;
    if (missing.has(key)) return;
    missing.add(key);
    issues.push({ severity: 'error', code, file, message });
  };
  const roots = [...new Set([resolve(root), realpathSync(root)])];
  for (const kind of Object.keys(records) as Kind[]) for (const node of records[kind].values()) {
    check();
    targets.set(node.handle, node);
    const filePath = referenceFilePath(root, node);
    if (filePath !== null) targetPaths.set(node.handle, relative(resolve(root), resolve(filePath)).split('\\').join('/'));
    const body = kind === 'entry' ? node.record.content : node.record.body;
    const template = node.projected ? records.action.get(node.record.frontMatter.occurrence?.template) : undefined;
    const sourcePath = filePath ?? (template && referenceFilePath(root, template)) ?? join(root, 'actions');
    sources.push({ node, markdown: body, filePath: sourcePath, baseFile: relative(root, sourcePath).split('\\').join('/'), projected: node.projected });
  }
  for (const artifact of records.artifact.values()) {
    for (const filename of [...new Set<string>(artifact.record.frontMatter.attachments ?? [])].sort()) {
      check();
      let handle: string;
      try { handle = artifactHandle(artifact.id, filename); }
      catch (error) {
        report(referenceFilePath(root, artifact)!, `Artifact ${artifact.id} has an invalid attachment ${filename}: ${(error as Error).message}`, 'content_reference_invalid');
        continue;
      }
      let path: string;
      try { path = contentAttachmentPath(root, artifact.id, filename); }
      catch (error) {
        report(referenceFilePath(root, artifact)!, `Attachment ${handle} cannot be resolved: ${(error as Error).message}`, 'content_reference_attachment');
        continue;
      }
      const node: AttachmentNode = { __typename: 'Attachment', filename, handle, filePath: path };
      const baseFile = artifactAttachmentRelativePath(artifact.id, filename);
      targets.set(handle, node); targetPaths.set(handle, baseFile);
    }
  }
  function targetHandle(ref: ContentReference): string | undefined {
    if (ref.kind !== 'artifact') return `#${ref.kind}/${ref.id}`;
    try { assertArtifactId(ref.id); if (ref.filename !== undefined) assertAttachmentFilename(ref.filename); return artifactHandle(ref.id, ref.filename); }
    catch { return undefined; }
  }
  for (const source of sources) {
    check();
    for (const ref of extractContentReferences(source.markdown, source.baseFile, roots)) {
      check();
      const handle = targetHandle(ref);
      if (handle === undefined) {
        report(source.filePath, `Invalid ${ref.kind} reference: ${ref.id}${ref.filename === undefined ? '' : `/${ref.filename}`}`, 'content_reference_invalid');
        continue;
      }
      const target = targets.get(handle);
      if (target === undefined || (ref.filePath !== undefined && targetPaths.get(handle) !== ref.filePath)) {
        report(source.filePath, `Missing ${ref.filename === undefined ? ref.kind : 'attachment'} reference: ${handle}${ref.filePath === undefined ? '' : ` (${ref.filePath})`}`);
        continue;
      }
      if (source.node.handle === handle) continue;
      add('__typename' in target ? attachmentForward : forward, source.node.handle, handle);
      if (!source.projected) {
        add(reverse, handle, source.node.handle);
      }
    }
  }
  const handleOf = (node: ReferenceTarget | string) => typeof node === 'string' ? node : node.handle;
  const rows = (map: Map<string, Set<string>>, node: ReferenceTarget | string) => [...(map.get(handleOf(node)) ?? [])]
    .sort().map(handle => targets.get(handle)!).filter(Boolean);
  const graph: ReferenceGraph = {
    issues,
    links: source => rows(forward, source) as RecordNode[],
    attachmentLinks: source => rows(attachmentForward, source) as AttachmentNode[],
    backlinks: target => rows(reverse, target) as RecordNode[],
    page(source, direction, offset = 0, limit = 20) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Link offset must be a nonnegative integer.');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Link limit must be between 1 and 100.');
      const all = graph[direction](source);
      const nodes = all.slice(offset, offset + limit);
      return { nodes, offset, count: nodes.length, totalCount: all.length };
    },
  };
  return graph;
}

export interface ProjectRelationNode {
  project: RecordNode;
  direction: 'outgoing' | 'incoming' | 'bidirectional';
  outgoingDescription: string | null;
  incomingDescription: string | null;
}

export function buildProjectRelations(projects: ReadonlyMap<string, RecordNode>): Map<string, ProjectRelationNode[]> {
  const pairs = new Map<string, Map<string, ProjectRelationNode>>();
  const relation = (source: string, target: string) => {
    const links = pairs.get(source) ?? new Map();
    let link = links.get(target);
    if (!link) {
      link = { project: projects.get(target)!, direction: 'outgoing', outgoingDescription: null, incomingDescription: null };
      links.set(target, link); pairs.set(source, links);
    }
    return link;
  };
  for (const [id, project] of projects) {
    for (const declaration of project.record.frontMatter.related_projects ?? []) {
      if (declaration.project === id || !projects.has(declaration.project)) continue;
      relation(id, declaration.project).outgoingDescription = declaration.description;
      relation(declaration.project, id).incomingDescription = declaration.description;
    }
  }
  return new Map([...pairs].map(([id, links]) => [id, [...links.values()].map(link => ({ ...link,
    direction: link.outgoingDescription === null ? 'incoming' : link.incomingDescription === null ? 'outgoing' : 'bidirectional',
  } as ProjectRelationNode)).sort((a, b) => a.project.id < b.project.id ? -1 : a.project.id > b.project.id ? 1 : 0)]));
}
