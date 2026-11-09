// CLI links resolve to the same validated targets as the MCP show tool.
import { artifactHandle, assertArtifactId, assertAttachmentFilename, parseArtifactHandle } from '../core/artifact-reference.js';
import { isInstanceAddress } from '../core/identity.js';
import { isWallMinute } from '../core/scheduling.js';
import { parseMarker } from '../mcp/calendar/markers.js';
import type { ShowArgs } from '../mcp/tools/show.js';

export interface ShowTarget {
  instanceId?: string;
  args: ShowArgs;
}

function entryId(id: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::[0-5]\d)?$/.test(id) && isWallMinute(id.slice(0, 16));
}

export function parseShowSource(source: string): string {
  const target = parseArtifactHandle(source);
  if (!target?.filename) throw new Error('source must name an exact artifact attachment: #artifact/<id>/<filename>.');
  assertArtifactId(target.id); assertAttachmentFilename(target.filename);
  return artifactHandle(target.id, target.filename);
}

function targetArgs(parts: string[]): ShowArgs {
  const [kind, id, ...tail] = parts;
  if (kind === 'project' || kind === 'action') {
    if (!id || !/^[\p{L}\p{N}\p{M}_-]+$/u.test(id)) throw new Error('Invalid project or action handle.');
    if (tail.length === 0 || (tail.length === 1 && tail[0] === 'detail')) return { [kind]: id, detail: true };
    if (tail.length === 1 && entryId(tail[0])) return { [kind]: id, entry: tail[0] };
  }
  if (kind === 'entry' && id && entryId(id) && tail.length === 0) return { entry: id };
  if (kind === 'artifact' && id && tail.length <= 1) {
    assertArtifactId(id);
    if (tail.length) assertAttachmentFilename(tail[0]);
    return { artifact: id, ...(tail.length ? { filename: tail[0] } : {}) };
  }
  throw new Error('Expected a project, action, entry, or artifact handle, or an Aside URL for one of these objects.');
}

export function parseShowTarget(target: string): ShowTarget {
  if (target.startsWith('#')) {
    const parts = target.slice(1).split('/').map(decodeURIComponent);
    if (parts[0] !== 'artifact' && parts.length !== 2) throw new Error('Invalid object handle.');
    return { args: targetArgs(parts) };
  }
  const match = /^aside:\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/.exec(target);
  if (!match || !isInstanceAddress(match[1])) throw new Error('Expected aside://<instance-id>/… or an object handle beginning with #.');
  const instanceId = match[1];
  let source: string | undefined;
  let search: string | undefined;
  if (match[3] !== undefined) {
    const parameters = [...new URLSearchParams(match[3])];
    const names = new Set<string>();
    for (const [name, value] of parameters) {
      if (!['source', 'search'].includes(name) || names.has(name)) throw new Error('Aside show URLs accept source and search once each.');
      names.add(name);
      if (name === 'source') source = parseShowSource(value);
      else if (value.trim()) search = value.trim();
    }
  }
  const result = (args: ShowArgs): ShowTarget => ({ instanceId, args: { ...args,
    ...(source === undefined ? {} : { source }), ...(search === undefined ? {} : { search }) } });
  // Calendar lifecycle suffixes locate the action; showing a link never changes it.
  const marker = parseMarker(target.split('?')[0]);
  if (marker) return result(targetArgs(['action', marker.actionId]));
  const rawRoute = match[2] ?? '';
  const route = rawRoute === '/' ? rawRoute : rawRoute.replace(/\/$/, '');
  if (!route) return result({});
  const parts = route.split('/').map(decodeURIComponent);
  if (parts.length === 1 && entryId(parts[0])) return result({ entry: parts[0] });
  return result(targetArgs(parts));
}
