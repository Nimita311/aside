// Show route building: validate the target against the store and
// the webapp's route grammar, and emit the route the webapp navigates by.
// Mirrors webapp/src/route.ts (buildRoute) and shares its segment encoding.
import { realpathSync, statSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';
import { assertArtifactId } from '../../core/artifact.js';
import { artifactHandle, assertAttachmentFilename, parseArtifactHandle } from '../../core/artifact-reference.js';
import { contentAttachmentPath } from '../../core/content-attachment.js';
import { assertManagedPath, isManagedInstancePath } from '../../core/managed-path.js';
import { encodeRoutePath, encodeRouteSegment } from '../../core/record-reference.js';
import type { Store } from '../../source/store.js';

export interface ShowArgs {
  source?: string;
  search?: string;
  project?: string;
  action?: string;
  entry?: string;
  asset?: string;
  artifact?: string;
  filename?: string;
  detail?: boolean;
}

export interface ShowPayload {
  route: string;
  url: string;
  outcome: 'OPENED' | 'UNAVAILABLE' | 'RETURNED';
}

export async function finishShow(
  { route, port, url: requestedUrl }: { route: string; port: number; url?: string },
  open: (url: string) => Promise<boolean>,
): Promise<ShowPayload> {
  const url = requestedUrl ?? `http://localhost:${port}/${route}`;
  return { route: `/${route}`, url, outcome: await open(url) ? 'OPENED' : 'UNAVAILABLE' };
}

// Build the route for a show target, or throw the tool error explaining what
// can't be shown. Empty route = the plain flow.
export function buildShowRoute(store: Store, args: ShowArgs): string {
  if (args.project && args.action) {
    throw new Error('Pass project or action, not both — the flow filters to one entity.');
  }
  if ([args.entry, args.asset, args.artifact, args.detail].filter(Boolean).length > 1) {
    throw new Error('entry, asset, artifact, and detail are mutually exclusive — the view shows one of them.');
  }
  if (args.filename !== undefined && !args.artifact) {
    throw new Error('filename selects an artifact attachment — pass artifact with it.');
  }
  if (args.detail && !args.project && !args.action) {
    throw new Error('detail opens a project or action record — pass project or action with it.');
  }

  let source: string | undefined;
  if (args.source !== undefined) {
    const target = parseArtifactHandle(args.source);
    if (!target?.filename) throw new Error('source must name an exact artifact attachment: #artifact/<id>/<filename>.');
    assertArtifactId(target.id); assertAttachmentFilename(target.filename);
    const record = store.getArtifact(target.id);
    if (!record) throw new Error(`source artifact "${target.id}" not found.\nHint: query artifacts to find the correct ID.`);
    if (!record.frontMatter.attachments?.includes(target.filename)) {
      throw new Error(`source attachment "${args.source}" is not indexed by its artifact.`);
    }
    try { contentAttachmentPath(store.getDataDir(), target.id, target.filename); }
    catch { throw new Error(`source attachment "${args.source}" not found or unavailable.`); }
    source = artifactHandle(target.id, target.filename);
  }

  const parts: string[] = [];
  if (args.project) {
    if (!store.getProject(args.project)) {
      throw new Error(`project "${args.project}" not found.\nHint: query projects to find the correct ID.`);
    }
    parts.push('project', encodeRouteSegment(args.project));
  }
  if (args.action) {
    if (!store.getAction(args.action)) {
      throw new Error(`action "${args.action}" not found.\nHint: query actions to find the correct ID.`);
    }
    parts.push('action', encodeRouteSegment(args.action));
  }
  if (args.entry) {
    if (!store.getEntryFile(args.entry)) {
      throw new Error(`entry "${args.entry}" not found.\nHint: query entries to find the correct ID (the entry's created timestamp).`);
    }
    parts.push(encodeRouteSegment(args.entry));
  } else if (args.detail) {
    parts.push('detail');
  } else if (args.artifact) {
    assertArtifactId(args.artifact);
    if (!store.getArtifact(args.artifact)) {
      throw new Error(`artifact "${args.artifact}" not found.\nHint: query artifacts to find the correct ID.`);
    }
    parts.push('artifact', encodeRouteSegment(args.artifact));
    if (args.filename !== undefined) {
      try {
        contentAttachmentPath(store.getDataDir(), args.artifact, args.filename);
      } catch {
        throw new Error(`artifact attachment "${args.filename}" not found.\nHint: filename must name a supporting file stored with this artifact.`);
      }
      parts.push(encodeRouteSegment(args.filename));
    }
  } else if (args.asset) {
    const assetPath = args.asset.replace(/^\/+/, '');
    const file = normalize(join(store.getDataDir(), assetPath));
    try {
      const root = realpathSync(store.getDataDir()), real = realpathSync(file);
      if (!file.startsWith(store.getDataDir() + sep) || !statSync(file).isFile() ||
        !real.startsWith(root + sep)) throw new Error();
      if (isManagedInstancePath(relative(store.getDataDir(), file))) assertManagedPath(store.getDataDir(), file, 'file');
    } catch {
      throw new Error(`asset "${args.asset}" not found or unavailable.\nHint: choose a regular file inside this instance (e.g. report.pdf); asset paths are relative to the instance root.`);
    }
    parts.push('asset', encodeRoutePath(assetPath));
  }
  const query = new URLSearchParams();
  if (source !== undefined) query.set('source', source);
  if (args.search?.trim()) query.set('search', args.search.trim());
  return parts.join('/') + (query.size ? `?${query}` : '');
}
