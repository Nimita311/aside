// The show tool's route building: validate the target against the store and
// the webapp's route grammar, and emit the route the webapp navigates by.
// Mirrors webapp/src/route.ts (buildRoute): segments are
// encodeURIComponent-ed with ':' kept raw so entry-id timestamps read clean,
// and asset paths keep their slashes real (encoded per segment).
import { realpathSync, statSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';
import { assertArtifactId } from '../../core/artifact.js';
import { contentAttachmentPath } from '../../core/content-attachment.js';
import { assertManagedPath, isManagedInstancePath } from '../../core/managed-path.js';
import type { Store } from '../store.js';

export interface ShowArgs {
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
  outcome: 'OPENED' | 'UNAVAILABLE';
  receipt: string;
}

export async function finishShow(
  { route, port, url: requestedUrl, launchUrl }: { route: string; port: number; url?: string; launchUrl?: string },
  open: (url: string) => Promise<boolean>,
): Promise<ShowPayload> {
  const url = requestedUrl ?? `http://localhost:${port}/${route}`;
  const outcome = await open(launchUrl ?? url) ? 'OPENED' : 'UNAVAILABLE';
  const description = {
    OPENED: 'opened browser',
    UNAVAILABLE: 'no browser available — run aside show locally to authorize a browser',
  }[outcome];
  return { route: `/${route}`, url, outcome, receipt: `showing: /${route}\nurl: ${url}\ntab: ${description}` };
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':');
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

  const parts: string[] = [];
  if (args.project) {
    if (!store.getProject(args.project)) {
      throw new Error(`project "${args.project}" not found.\nHint: use query_projects to find the correct ID.`);
    }
    parts.push('project', encodeSegment(args.project));
  }
  if (args.action) {
    if (!store.getAction(args.action)) {
      throw new Error(`action "${args.action}" not found.\nHint: use query_actions to find the correct ID.`);
    }
    parts.push('action', encodeSegment(args.action));
  }
  if (args.entry) {
    if (!store.getEntryFile(args.entry)) {
      throw new Error(`entry "${args.entry}" not found.\nHint: use query_entries to find the correct ID (the entry's created timestamp).`);
    }
    parts.push(encodeSegment(args.entry));
  } else if (args.detail) {
    parts.push('detail');
  } else if (args.artifact) {
    assertArtifactId(args.artifact);
    if (!store.getArtifact(args.artifact)) {
      throw new Error(`artifact "${args.artifact}" not found.\nHint: use query_artifacts to find the correct ID.`);
    }
    parts.push('artifact', encodeSegment(args.artifact));
    if (args.filename !== undefined) {
      try {
        contentAttachmentPath(store.getDataDir(), args.artifact, args.filename);
      } catch {
        throw new Error(`artifact attachment "${args.filename}" not found.\nHint: filename must name a supporting file stored with this artifact.`);
      }
      parts.push(encodeSegment(args.filename));
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
    parts.push('asset', assetPath.split('/').map(encodeSegment).join('/'));
  }
  return parts.join('/');
}
