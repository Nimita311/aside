import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isPair, isSeq, parseDocument, visit, type Alias, type Document, type Node, type Pair, type YAMLMap } from 'yaml';

// Updates own the declared fields, not the rest of a user's YAML document.
// Parse before any write, including recurrence-history or newly linked records.
export function parseMetadata(source: string, context: string): Document {
  // Some fence captures exclude the separator LF but leave its CR.
  const document = parseDocument(source.replace(/\r(?=\n|$)/g, ''), { intAsBigInt: true });
  if (document.errors.length || !isMap(document.contents)) {
    throw new Error(`Cannot update ${context}: existing metadata must be a valid YAML mapping. Repair it before retrying.`);
  }
  try { document.toJS({ mapAsMap: true }); }
  catch {
    throw new Error(`Cannot update ${context}: existing YAML aliases cannot be resolved. Repair them before retrying.`);
  }
  return document;
}

// Clone YAML nodes rather than converting through JS, which loses explicit
// tags and scalar information. Resolve aliases against the original document
// before cloning, and remove copied anchors so they cannot shadow retained ones.
// Expanding a cyclic alias would change its topology, so fail before any write.
export function cloneMetadataNode(target: unknown, document: Document, context: string): Node {
  const active = new Set<unknown>();
  const clone = (node: unknown): unknown => {
    if (!isNode(node) && !isPair(node)) return node;
    if (active.has(node)) {
      throw new Error(`Cannot update ${context}: existing custom aliases reference cyclic metadata that would be replaced. Give those values independent anchors before retrying.`);
    }
    active.add(node);
    let copy;
    if (isAlias(node)) {
      copy = clone(node.resolve(document)) as Node;
      if (node.comment) copy.comment = [copy.comment, node.comment].filter(Boolean).join('\n');
      if (node.commentBefore) copy.commentBefore = [copy.commentBefore, node.commentBefore].filter(Boolean).join('\n');
      if (node.spaceBefore) copy.spaceBefore = true;
    } else {
      copy = node.clone();
      if ('anchor' in copy) delete copy.anchor;
      if (isMap(node) && isMap(copy)) copy.items = node.items.map(item => clone(item) as typeof item);
      else if (isSeq(node) && isSeq(copy)) copy.items = node.items.map(item => clone(item));
      else if (isPair(node) && isPair(copy)) { copy.key = clone(node.key); copy.value = clone(node.value); }
    }
    active.delete(node);
    return copy;
  };
  return clone(target) as Node;
}

// Canonical metadata supplies the same managed-value normalization used for new
// records. Unchanged nodes keep their comments and anchors. Before replacing an
// anchored managed node, preserve aliases' old values so custom fields do not
// silently change along with the field being edited.
export type MetadataField = string | readonly string[];

export function mergeMetadata(source: string, canonical: string, fields: readonly MetadataField[], context: string, entryFence = false): string {
  const document = parseMetadata(source, context);
  const desired = parseMetadata(canonical, 'generated metadata');
  // YAML mapping keys may themselves be aliases. String-key Document methods
  // do not find those pairs, even though the reader resolves them as fields.
  const locate = (path: readonly string[]): {parent?: YAMLMap; pair?: Pair; ancestors: Node[]} => {
    let parent = document.contents;
    const ancestors: Node[] = [];
    for (let index = 0; index < path.length; index++) {
      if (!isMap(parent)) throw new Error(`Cannot update ${context}: existing ${path.slice(0, index).join('.')} must be a YAML mapping. Repair it before retrying.`);
      ancestors.push(parent);
      const pairs = parent.items.filter(pair => (isNode(pair.key) ? pair.key.toJS(document, { mapAsMap: true }) : pair.key) === path[index]);
      if (pairs.length > 1) throw new Error(`Cannot update ${context}: existing metadata repeats ${path.slice(0, index + 1).join('.')} after resolving YAML aliases. Repair the duplicate field before retrying.`);
      if (index === path.length - 1) return {parent, pair: pairs[0], ancestors};
      if (!pairs[0]) return {parent: undefined, pair: undefined, ancestors};
      parent = pairs[0].value as typeof parent;
    }
    throw new Error('Metadata edit path must not be empty.');
  };
  const edits = fields.map(field => {
    const path = typeof field === 'string' ? [field] : field;
    const located = locate(path);
    const exists = desired.hasIn(path);
    const replacement = desired.getIn(path, true);
    const before = isNode(located.pair?.value) ? located.pair.value.toJS(document, {mapAsMap: true}) : located.pair?.value;
    const after = isNode(replacement) ? replacement.toJS(desired, {mapAsMap: true}) : replacement;
    return {path, ...located, exists, replacement, changed: !!located.pair !== exists || !isDeepStrictEqual(before, after)};
  });
  const changed = edits.filter(edit => edit.changed);
  if (!changed.length) return source.replace(/\r(?=\n|$)/g, '');
  const removedNodes = new Set<unknown>();
  const affectedAncestors = new Set<unknown>();
  for (const edit of changed) {
    for (const ancestor of edit.ancestors) affectedAncestors.add(ancestor);
    const old = edit.pair?.value;
    if (isNode(old)) visit(old, { Value: (_key, node) => { removedNodes.add(node); } });
    if (!edit.exists && edit.pair) removedNodes.add(edit.pair.key);
  }
  const replacements = new Map<Alias, Node>();
  visit(document, {
    Alias: (_key, node) => {
      if (removedNodes.has(node)) return;
      const target = node.resolve(document);
      if (!removedNodes.has(target) && !affectedAncestors.has(target)) return;
      replacements.set(node, cloneMetadataNode(node, document, context));
    },
  });
  visit(document, { Alias: (_key, node) => replacements.get(node) });
  for (const edit of changed) {
    const pair = edit.pair;
    if (!edit.exists) {
      if (pair && edit.parent) edit.parent.items.splice(edit.parent.items.indexOf(pair), 1);
      continue;
    }
    const old = pair?.value;
    // Canonical nodes also carry the serializer's scalar styles and list layout.
    // Detach any canonical aliases/anchors so they cannot shadow user anchors.
    const replacement = cloneMetadataNode(edit.replacement, desired, 'generated metadata');
    if (isNode(old)) {
      replacement.comment = old.comment;
      replacement.commentBefore = old.commentBefore;
      replacement.spaceBefore = old.spaceBefore;
    }
    if (pair) pair.value = replacement;
    else if (edit.parent) edit.parent.set(edit.path[edit.path.length - 1], replacement);
    else document.setIn(edit.path, replacement);
  }
  if (entryFence) {
    // The entry parser ends metadata at any literal triple-backtick, including
    // inside a YAML string. Keep unusual IDs and extension values representable.
    visit(document, { Scalar: (_key, node) => {
      if (typeof node.value === 'string' && node.value.includes('```')) node.type = 'QUOTE_DOUBLE';
    } });
  }
  // Keep the serializer's newlines: a retained |+ scalar can own all of them.
  // The caller supplies its enclosing fence separator independently.
  const rendered = document.toString();
  const yaml = entryFence ? rendered.replace(/```/g, '\\u0060\\u0060\\u0060') : rendered;
  // Also detect aliases inside retained managed nodes whose anchors disappeared.
  // Failing before persistence is preferable to saving an unreadable document.
  parseMetadata(yaml, context);
  return yaml;
}

const frontMatter = /^(\uFEFF?\s*---[ \t\r]*\n)(?:([\s\S]*?)\n)?(---[ \t\r]*)(\n[\s\S]*)?$/;

export function serializeExistingRecord(file: string, canonical: string, fields: readonly string[], normalize: (record: string) => object, touchedFields?: readonly string[], metadataEdit?: (metadata: string) => string, preserveBody = false): string {
  let original: string;
  try { original = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return canonical;
    throw error;
  }
  const existing = original.match(frontMatter);
  const desired = canonical.match(frontMatter);
  if (!existing || !desired) {
    throw new Error(`Cannot update ${file}: existing record must have YAML front matter. Repair it before retrying.`);
  }
  // Tolerant parsing intentionally omits unrecognized values and nested extension
  // keys. Compare normalized values to detect edits, rather than treating that
  // omission as a request to erase the original YAML. Explicit field updates
  // still replace/clear their owned value, even when parsing omitted it.
  const before = normalize(original) as Record<string, unknown>;
  const after = normalize(canonical) as Record<string, unknown>;
  const editedFields = touchedFields ?? fields.filter(key => !isDeepStrictEqual(before[key], after[key]));
  const newline = existing[1].endsWith('\r\n') ? '\r\n' : '\n';
  let metadata = mergeMetadata(existing[2] ?? '', desired[2] ?? '', editedFields, file);
  if (metadataEdit) metadata = metadataEdit(metadata);
  const yaml = metadata.replace(/\n/g, newline);
  return `${existing[1]}${yaml}${newline}${existing[3]}${(preserveBody ? existing[4] : desired[4]) ?? ''}`;
}
