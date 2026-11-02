import type { EntityRef, EntityType } from '../lib/types';
import { safeDecode } from '../lib/types';
import { isEntryTimestamp } from './entity-reference';
import { assertArtifactId, assertAttachmentFilename } from '../../cli/src/core/artifact-reference';
import { dateHandle, parseDateHandle, type DateReference } from './date-reference';

// URL route <-> view-state mapping, kept DOM-free so it can be unit-tested.
//
// The route carries the complete view state so browser back/forward walks the
// user's whole navigation trail:
//
//   (empty)                       unfiltered flow — the URL root
//   <entry-id>                    flow scrolled to an entry (jump)
//   project/<id>                  filtered flow + detail panel
//   project/<id>/detail           …with its detail open in the reader
//   project/<id>/asset/<path>     …with an asset open in the reader
//   project/<id>/<entry-id>       …with the flow scrolled to an entry
//   action/<id>[...]              same as project
//   entry/<id>                    entry detail page
//   artifact/<id>[/<filename>]    artifact reader over the unfiltered flow
//   asset/<path>                  asset reader over the unfiltered flow
//   detail                        instance detail over the unfiltered flow
//   date/<start>[/<end>]           calendar jump (also within project/action)
//
// Entry ids are timestamps (`2026-05-22T15:30`), which no route head or
// entity id can look like (entity ids date-code as `2026-05-22-name`), so a
// leading or trailing entry-id segment is unambiguous.
//
// The daemon origin uses /<instance-id>/<route>; global resources live
// under /-/. The outer instance identity is independent of view grammar.
//
// Entity ids and asset paths can contain non-ASCII characters. Browsers
// percent-encode non-ASCII in `location` on assignment but report it
// inconsistently on read, so ids and path segments are encodeURIComponent-ed
// to guarantee a stable round-trip — except ':', kept raw so entry-id
// timestamps read clean. Asset paths keep their slashes real
// (encoding each segment separately): some servers reject `%2F` in a request
// path outright, and an asset path is always the route's tail, so raw slashes
// stay unambiguous.

// A document open in the reader: the filtered entity's detail (its complete
// record), an artifact handle, or an asset file identified by its root-relative path.
export type DocRef = { kind: 'detail' } | { kind: 'asset'; path: string } | { kind: 'artifact'; id: string; filename?: string };

export interface ViewState {
  filter: EntityRef | null;
  doc: DocRef | null;
  // Entry id the flow is scrolled to. Exclusive with doc; composes with a
  // project/action filter (a jump within the filtered flow).
  jump?: string | null;
  // A calendar target, distinct from an exact entry ID; exclusive with doc/jump.
  date?: DateReference;
}

// An entry id: the entry's creation timestamp, optionally with seconds.
function isEntryId(segment: string): boolean {
  return isEntryTimestamp(safeDecode(segment));
}

const ENTITY_TYPES = new Set<string>(['project', 'action', 'entry']);

// A route segment: encoded, but with ':' kept raw — legal in a path segment
// and in a fragment (RFC 3986 pchar), so entry-id timestamps stay readable.
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':');
}

// An asset path as route segments: each segment encoded, slashes kept real.
function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/');
}

export function buildRoute(state: ViewState): string {
  const parts: string[] = [];
  if (state.filter) parts.push(state.filter.type, encodeSegment(state.filter.id));
  if (state.date) {
    if (!parseDateHandle(dateHandle(state.date))) throw new Error('Invalid date reference');
    parts.push('date', encodePath(dateHandle(state.date).slice(6)));
  } else if (state.jump) parts.push(encodeSegment(state.jump));
  else if (state.doc?.kind === 'detail') parts.push('detail');
  else if (state.doc?.kind === 'asset') parts.push('asset', encodePath(state.doc.path));
  else if (state.doc?.kind === 'artifact') {
    assertArtifactId(state.doc.id);
    parts.push('artifact', encodeSegment(state.doc.id));
    if (state.doc.filename !== undefined) {
      assertAttachmentFilename(state.doc.filename);
      parts.push(encodeSegment(state.doc.filename));
    }
  }
  return parts.join('/');
}

// An asset doc from its trailing path segments. A hand-edited URL may leave the
// path's slashes unencoded, so the segments are rejoined before decoding.
function assetDoc(segments: string[]): DocRef {
  return { kind: 'asset', path: safeDecode(segments.join('/')) };
}

function artifactDoc(segments: string[]): DocRef | null {
  if (segments.length < 1 || segments.length > 2) return null;
  const id = safeDecode(segments[0]);
  const filename = segments.length === 2 ? safeDecode(segments[1]) : undefined;
  try {
    assertArtifactId(id);
    if (filename !== undefined) assertAttachmentFilename(filename);
    return { kind: 'artifact', id, ...(filename !== undefined ? { filename } : {}) };
  } catch { return null; }
}

// Unrecognized or malformed routes parse as the plain flow.
export function parseRoute(route: string): ViewState {
  const flow: ViewState = { filter: null, doc: null };
  if (!route) return flow;

  const parts = route.split('/');
  if (parts[0] === 'date') {
    const date = parseDateHandle(`#date/${parts.slice(1).map(safeDecode).join('/')}`);
    return date ? { filter: null, doc: null, date } : flow;
  }
  if (isEntryId(parts[0])) {
    if (parts.length === 1) return { filter: null, doc: null, jump: safeDecode(parts[0]) };
    return flow;
  }
  if (parts[0] === 'artifact') {
    const doc = artifactDoc(parts.slice(1));
    return doc ? { filter: null, doc } : flow;
  }
  if (parts[0] === 'asset') {
    if (parts.length >= 2) return { filter: null, doc: assetDoc(parts.slice(1)) };
    return flow;
  }
  if (parts[0] === 'detail') {
    if (parts.length === 1) return { filter: null, doc: { kind: 'detail' } };
    return flow;
  }

  if (!ENTITY_TYPES.has(parts[0]) || parts.length < 2 || !parts[1]) return flow;
  const filter: EntityRef = { type: parts[0] as EntityType, id: safeDecode(parts[1]) };
  const rest = parts.slice(2);

  if (rest.length === 0) return { filter, doc: null };

  const filterHasDetail = filter.type === 'project' || filter.type === 'action';
  if (rest[0] === 'date' && filterHasDetail) {
    const date = parseDateHandle(`#date/${rest.slice(1).map(safeDecode).join('/')}`);
    return date ? { filter, doc: null, date } : flow;
  }
  if (rest[0] === 'detail' && rest.length === 1 && filterHasDetail) {
    return { filter, doc: { kind: 'detail' } };
  }
  if (rest[0] === 'artifact') {
    const doc = artifactDoc(rest.slice(1));
    return doc ? { filter, doc } : flow;
  }
  if (rest[0] === 'asset' && rest.length >= 2) {
    return { filter, doc: assetDoc(rest.slice(1)) };
  }
  if (isEntryId(rest[0]) && rest.length === 1 && filterHasDetail) {
    return { filter, doc: null, jump: safeDecode(rest[0]) };
  }
  return flow;
}

export function instanceUrl(instanceId: string, route: string): string {
  return `/${encodeURIComponent(instanceId)}/${route}`;
}

export function readInstanceLocation(pathname: string): { instanceId: string | null; route: string } {
  const parts = pathname.replace(/^\/+/, '').split('/');
  if (!parts[0]) return { instanceId: null, route: '' };
  return { instanceId: safeDecode(parts[0]), route: parts.slice(1).join('/') };
}
