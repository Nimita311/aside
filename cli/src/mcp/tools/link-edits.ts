import { isAlias, isMap, isNode, isSeq } from 'yaml';
import { formatDate } from '../../core/date.js';
import { toKebabCase } from '../../core/slug.js';
import type { RelatedProject } from '../../core/types.js';
import type { NewAction, NewProject } from './capture.js';
import { cloneMetadataNode, mergeMetadata, parseMetadata } from './front-matter.js';

export interface LinkEdits<T> { add?: (string | T)[] | null; remove?: string[] | null }
export interface RelatedProjectEdits { upsert?: RelatedProject[] | null; remove?: string[] | null }

function assertRemovals(remove: unknown, context: string): asserts remove is string[] | null | undefined {
  if (remove != null && (!Array.isArray(remove) || remove.some(id => typeof id !== 'string' || !id.trim()))) throw new Error(`${context}.remove must contain nonblank IDs.`);
  if (remove && new Set(remove).size !== remove.length) throw new Error(`${context}.remove must not repeat an ID.`);
}

export function linkId(ref: string | NewProject | NewAction, now: Date): string {
  return typeof ref === 'string' ? ref : `${formatDate(now)}-${toKebabCase(ref.name)}`;
}

export function assertLinkEdits<T extends NewProject | NewAction>(edits: LinkEdits<T>, context: string, now: Date): void {
  assertRemovals(edits.remove, context);
  const ids = (edits.add ?? []).map(ref => linkId(ref, now));
  if (new Set(ids).size !== ids.length) throw new Error(`${context}.add must not repeat an ID.`);
  if (ids.some(id => edits.remove?.includes(id))) throw new Error(`${context} cannot both add and remove an ID.`);
}

// Preserve existing order and append genuinely new links. Re-adding a saved link
// and removing an absent link are harmless, so retries of tag-only edits are safe.
export function mergeLinkIds(current: readonly string[], added: readonly string[], removed: readonly string[] = []): string[] {
  return [...new Set([...current.filter(id => !removed.includes(id)), ...added])];
}

export function hasLinkEdits(edits: LinkEdits<unknown> | null | undefined): boolean {
  return !!(edits?.add?.length || edits?.remove?.length);
}

export function assertRelatedProjectEdits(edits: RelatedProjectEdits): void {
  assertRemovals(edits.remove, 'relatedProjectEdits');
  const ids = (edits.upsert ?? []).map(link => link.project);
  if (new Set(ids).size !== ids.length) throw new Error('relatedProjectEdits.upsert must not repeat a project ID.');
  if (ids.some(id => edits.remove?.includes(id))) throw new Error('relatedProjectEdits cannot both upsert and remove a project ID.');
}

export function hasRelatedProjectEdits(edits: RelatedProjectEdits | null | undefined): boolean {
  return !!(edits?.upsert?.length || edits?.remove?.length);
}

// Edit the current disk list by identity, retaining unrelated items, extension
// fields, comments and YAML precision rather than reconstructing it from Store.
export function applyRelatedProjectEditsToMetadata(source: string, edits: RelatedProjectEdits, context: string): string {
  assertRelatedProjectEdits(edits);
  if (!hasRelatedProjectEdits(edits)) return source;
  const document = parseMetadata(source, context);
  const pairs = isMap(document.contents) ? document.contents.items.filter(pair =>
    (isNode(pair.key) ? pair.key.toJS(document, {mapAsMap: true}) : pair.key) === 'related_projects') : [];
  if (pairs.length > 1) throw new Error(`Cannot update ${context}: repeated related_projects field. Repair it before retrying.`);
  let list = pairs[0]?.value;
  if (isAlias(list)) list = cloneMetadataNode(list, document, context);
  if (list != null && !isSeq(list)) throw new Error(`Cannot update ${context}: related_projects must be a YAML list. Repair it before retrying.`);
  const items = isSeq(list) ? list.items : [];
  const identity = (item: unknown): string => {
    const value = isNode(item) ? item.toJS(document) : item;
    if (!value || typeof value.project !== 'string') throw new Error(`Cannot update ${context}: related project items must have a text project ID. Repair them before retrying.`);
    return value.project;
  };
  const ids = items.map(identity);
  if (new Set(ids).size !== ids.length) throw new Error(`Cannot update ${context}: repeated related project IDs. Repair them before retrying.`);
  const retained = items.filter(item => !edits.remove?.includes(identity(item)));
  for (const link of edits.upsert ?? []) {
    const index = retained.findIndex(item => identity(item) === link.project);
    if (index < 0) retained.push(document.createNode(link));
    else {
      const existing = retained[index];
      const node = isAlias(existing) ? cloneMetadataNode(existing, document, context) : existing;
      if (!isMap(node)) throw new Error(`Cannot update ${context}: related project items must be YAML mappings.`);
      const descriptions = node.items.filter(pair => (isNode(pair.key) ? pair.key.toJS(document) : pair.key) === 'description');
      if (descriptions.length > 1) throw new Error(`Cannot update ${context}: repeated relationship description field.`);
      if (descriptions[0]) descriptions[0].value = document.createNode(link.description);
      else node.set('description', link.description);
      retained[index] = node;
    }
  }
  if (!retained.length) {
    if (pairs[0] && isMap(document.contents)) document.contents.items.splice(document.contents.items.indexOf(pairs[0]), 1);
  }
  else {
    if (!isSeq(list)) list = document.createNode([]);
    if (!isSeq(list)) throw new Error('Expected generated YAML list.');
    list.items = retained;
    if (pairs[0]) {
      pairs[0].value = list;
      // The desired document is looked up by literal field path by mergeMetadata.
      // Keep alias-key handling on the source side, where it preserves the key.
      pairs[0].key = document.createNode('related_projects');
    }
    else document.set('related_projects', list);
  }
  return mergeMetadata(source, document.toString(), ['related_projects'], context);
}
