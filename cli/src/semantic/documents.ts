import { createHash } from 'node:crypto';
import type { Store } from '../source/store.js';
import { entryEntityIds } from '../core/record-reference.js';

export type SemanticKind = 'entry' | 'project' | 'action' | 'artifact';
export interface SearchDocument {
  kind: SemanticKind; id: string; handle: string; name: string; description: string;
  content: string; created: string; projects: string[];
}
export interface SearchChunk extends Omit<SearchDocument, 'content' | 'projects'> {
  chunkId: string; hash: string; embeddingHash: string; text: string; snippet: string; projects: string;
}
export const CHUNKER_VERSION = 'headings-char1400-overlap160-context200-v2';
const PASSAGE_CHARS = 1400;
const OVERLAP_CHARS = 160;
const HEADING_CONTEXT_CHARS = 200;
export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

export function collectDocuments(store: Store): SearchDocument[] {
  const relations = store.getRelations();
  const docs: SearchDocument[] = store.getEntries().map(entry => ({
    kind: 'entry', id: entry.meta.created, handle: `#entry/${entry.meta.created}`, name: entry.meta.created,
    description: store.getIndexDescription('notes', entry.meta.created) ?? '', content: entry.content,
    created: entry.meta.created, projects: entryEntityIds(entry, 'project'),
  }));
  // Store collections contain saved records; unsaved projections are not indexed.
  for (const [kind, records, index] of [
    ['project', store.getProjects(), 'projects'], ['action', store.getActions(), 'actions'], ['artifact', store.getArtifacts(), 'artifacts'],
  ] as const) for (const [id, record] of records) docs.push({
    kind, id, handle: `#${kind}/${id}`, name: record.frontMatter.name,
    description: store.getIndexDescription(index, id) ?? '', content: record.body, created: record.frontMatter.created!,
    projects: kind === 'project' ? [id] : kind === 'action' ? relations.projectsByAction.get(id) ?? [] : relations.projectsByArtifact.get(id) ?? [],
  });
  return docs;
}

/** Preserve heading context, then bound every passage; entries never share chunks. */
export function chunkDocument(document: SearchDocument): SearchChunk[] {
  if (document.content.length > 2_000_000) throw new Error(`Semantic search document ${document.handle} exceeds 2 million characters.`);
  const sections: string[] = []; let current: string[] = []; let fence: { character: string; length: number } | undefined;
  for (const line of document.content.replace(/\r\n/g, '\n').split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (fence.character === marker[1][0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    }
    if (!fence && /^#{1,6}\s/.test(line) && current.length) { sections.push(current.join('\n')); current = []; }
    current.push(line);
  }
  if (current.length) sections.push(current.join('\n'));
  const prefix = `${document.kind}: ${document.name}\n${document.description}`.trim().slice(0, 2000);
  const passages: string[] = [];
  for (const section of sections) {
    const text = section.trim(); if (!text) continue;
    const heading = (text.match(/^#{1,6}\s+[^\n]+/)?.[0] ?? '').slice(0, HEADING_CONTEXT_CHARS);
    for (let start = 0; start < text.length;) {
      // Repeated context is part of the passage budget. A long authored
      // heading must not be copied in full into every continuation passage.
      const context = start > 0 && heading ? `${heading}\n` : '';
      const budget = PASSAGE_CHARS - context.length;
      let end = Math.min(start + budget, text.length);
      if (end < text.length) {
        const boundary = text.lastIndexOf(' ', end);
        if (boundary > start + 1000) end = boundary;
      }
      passages.push(`${context}${text.slice(start, end)}`);
      if (end === text.length) break;
      start = end - OVERLAP_CHARS;
    }
  }
  if (!passages.length) passages.push(prefix.slice(0, PASSAGE_CHARS));
  const metadata = JSON.stringify({ ...document, content: undefined, projects: [...document.projects].sort() });
  const hash = hashText(`${CHUNKER_VERSION}\n${metadata}\n${document.content}`);
  return passages.map((snippet, index) => ({
    kind: document.kind, id: document.id, handle: document.handle, name: document.name, description: document.description,
    created: document.created, projects: JSON.stringify(document.projects), hash,
    chunkId: hashText(`${document.handle}\n${hash}\n${index}`), embeddingHash: hashText(`${prefix}\n\n${snippet}`), text: `${prefix}\n\n${snippet}`, snippet,
  }));
}

/** Unicode words keep multilingual exact matches useful without language stopword lists. */
export function terms(text: string): string[] { return text.toLocaleLowerCase('und').match(/[\p{L}\p{N}_]+/gu) ?? []; }

export function lexicalRanking(chunks: SearchChunk[], query: string, limit: number): Array<{ chunkId: string; score: number }> {
  const wanted = [...new Set(terms(query))];
  if (!chunks.length || !wanted.length) return [];
  const tokenized = chunks.map(chunk => terms(chunk.text));
  const average = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / chunks.length || 1;
  const frequencies = new Map(wanted.map(term => [term, tokenized.filter(tokens => tokens.includes(term)).length]));
  return chunks.map((chunk, index) => {
    const tokens = tokenized[index]; const counts = new Map<string, number>();
    for (const token of tokens) if (frequencies.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const [term, count] of counts) {
      const df = frequencies.get(term)!;
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
      score += idf * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * tokens.length / average));
    }
    return { chunkId: chunk.chunkId, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)).slice(0, limit);
}
