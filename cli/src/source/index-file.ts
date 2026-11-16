import {existsSync} from 'node:fs';
import {isAlias, isMap, isScalar, isSeq, parseDocument, visit} from 'yaml';
import {yamlQuote} from '../core/yaml.js';
import {assertManagedPath, readManagedText} from '../core/managed-path.js';
import {writeFileCrashSafe} from '../storage/atomic-file.js';

// Prepend an item to a year index (reverse chronological — newest first),
// creating the file if absent. `id` is quoted only when YAML needs it, so slug
// ids stay bare and timestamp ids (which contain a colon) get quoted. The caller
// passes the final description (already single-line and truncated as needed).
export function prependIndex(indexPath: string, id: string, description: string, managedRoot: string): void {
  indexPath = assertManagedPath(managedRoot, indexPath, 'file', true);
  let existing = existsSync(indexPath) ? readManagedText(managedRoot, indexPath) : '';
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  let doc = parseDocument(existing);
  // The parser misreads a BOM immediately before a block sequence indicator.
  // Keep the BOM at the start, on its own line, when the remaining list is valid.
  if (doc.errors.length && existing.startsWith('\ufeff')) {
    const withoutBom = parseDocument(existing.slice(1));
    if (!withoutBom.errors.length && isSeq(withoutBom.contents)) {
      existing = '\ufeff' + newline + existing.slice(1);
      doc = parseDocument(existing);
    }
  }
  const quote = !doc.errors.length && doc.directives?.yaml.version === '1.1' ? JSON.stringify : yamlQuote;
  const entry = `- id: ${quote(id)}\n  description: ${quote(description)}\n`;
  let updated = entry + existing;
  if (!doc.errors.length) {
    const sequence = doc.contents;
    if (isSeq(sequence) && sequence.range) {
      if (sequence.flow) {
        const start = sequence.range[0] + 1;
        const separator = sequence.items.length ? `,${/\s/.test(existing[start]) ? '' : ' '}` : '';
        const item = `{id: ${JSON.stringify(id)}, description: ${JSON.stringify(description)}}`;
        updated = `${existing.slice(0, start)}${item}${separator}${existing.slice(start)}`;
      } else {
        const start = sequence.range[0];
        const indent = existing.slice(existing.lastIndexOf('\n', start - 1) + 1, start);
        const item = `- id: ${quote(id)}${newline}${indent}  description: ${quote(description)}${newline}${indent}`;
        updated = existing.slice(0, start) + item + existing.slice(start);
      }
    } else if (isScalar(sequence) && sequence.value === null && sequence.range && sequence.range[0] === sequence.range[1]) {
      // An explicit empty document still needs its marker before the new list.
      const start = sequence.range[0];
      const before = existing.slice(0, start);
      updated = before + (before.endsWith('\n') ? '' : newline) + entry.replaceAll('\n', newline) + existing.slice(start);
    } else if (sequence === null && existing.startsWith('\ufeff')) {
      updated = existing + (existing.endsWith('\n') ? '' : newline) + entry.replaceAll('\n', newline);
    }
  }
  writeFileCrashSafe(indexPath, updated, managedRoot);
}

// Locate the item through YAML structure, then edit only the description's
// source range. Quotes, key order, comments, and unrelated formatting stay intact;
// replacing a block scalar consumes its body as well as its header.
// A true result means the description was saved on disk.
export function updateIndexDescription(indexPath: string, id: string, description: string, managedRoot: string): boolean {
  indexPath = assertManagedPath(managedRoot, indexPath, 'file', true);
  if (!existsSync(indexPath)) return false;
  const content = readManagedText(managedRoot, indexPath);
  const doc = parseDocument(content);
  if (doc.errors.length) return false;
  if (!isSeq(doc.contents)) return false;
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue;
    const itemId: unknown = item.get('id');
    if (itemId !== id) continue;
    const node = item.get('description', true);
    // Flow mappings reserve commas, and YAML 1.1 treats words such as "yes" as
    // booleans. Quoted strings retain their value in either context.
    const quotedDescription = item.flow || doc.directives?.yaml.version === '1.1'
      ? JSON.stringify(description) : yamlQuote(description);
    let updated: string;
    if (node === undefined && item.range) {
      const end = item.range[1];
      if (item.flow) {
        // Insert before the first field so trailing commas and comments keep
        // their original positions rather than becoming part of the new value.
        const start = item.range[0] + 1;
        const separator = /\s/.test(content[start]) ? '' : ' ';
        updated = `${content.slice(0, start)}description: ${quotedDescription},${separator}${content.slice(start)}`;
      } else {
        const key = item.items[0]?.key;
        if (!isScalar(key) || !key.range) return false;
        const indent = ' '.repeat(key.range[0] - (content.lastIndexOf('\n', key.range[0] - 1) + 1));
        const newline = content.includes('\r\n') ? '\r\n' : '\n';
        const before = content.slice(0, end);
        updated = `${before}${before.endsWith('\n') ? '' : newline}${indent}description: ${quotedDescription}${newline}${content.slice(end)}`;
      }
    } else {
      if ((!isScalar(node) && !isAlias(node)) || !node.range) return false;
      // Editing a shared anchor would also change unrelated descriptions on
      // disk. Leave it untouched so the caller can report that it was not saved.
      if (isScalar(node) && node.anchor) {
        let shared = false;
        visit(doc, { Alias: (_key, alias) => {
          if (alias.resolve(doc) === node) {
            shared = true;
            return visit.BREAK;
          }
        } });
        if (shared) return false;
      }
      const [start, end] = node.range;
      let value = quotedDescription;
      if (isScalar(node) && (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED')) {
        const original = content.slice(start, end);
        const comment = original.match(/^[|>][^\r\n]*?([ \t]+#[^\r\n]*)/)?.[1] ?? '';
        const newline = original.match(/\r?\n$/)?.[0] ?? '';
        value += comment + newline;
      } else if (start === end) {
        if (content[start - 1] && !/\s/.test(content[start - 1])) value = ' ' + value;
        if (content[end] === '#') value += ' ';
      }
      updated = content.slice(0, start) + value + content.slice(end);
    }
    const check = parseDocument(updated);
    if (check.errors.length) return false;
    const saved = isSeq(check.contents) ? check.contents.items.find((candidate) => {
      if (!isMap(candidate)) return false;
      const candidateId: unknown = candidate.get('id');
      return candidateId === id;
    }) : undefined;
    if (!isMap(saved)) return false;
    const savedDescription: unknown = saved.get('description');
    if (savedDescription !== description) return false;
    writeFileCrashSafe(indexPath, updated, managedRoot);
    return true;
  }
  return false;
}
