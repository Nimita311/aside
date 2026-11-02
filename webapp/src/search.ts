import type { IndexItem } from '../lib/types';
import { parseLooseDate } from './dates';

export type SearchResultType = 'date' | 'project' | 'action' | 'artifact' | 'entry';

export interface SearchResult {
  type: SearchResultType;
  // Date results carry the YYYY-MM-DD to jump to; the rest their entity id.
  id: string;
  description?: string;
  // Context around a full-text match that is visible in neither the name nor
  // the description — the row's evidence for the hit.
  snippet?: string;
}

export interface SearchOutput {
  // Grouped dates → projects → actions → artifacts → entries, ranked within each group.
  results: SearchResult[];
  // The parsed free-text terms, for highlighting.
  terms: string[];
}

export interface SearchOptions {
  // Display-name lookup (front-matter names), matched alongside the id for
  // projects and actions. An entry's display name is derived from its id,
  // which is already matched.
  resolveName?: (type: 'project' | 'action', id: string) => string;
  // Full text of the entries already loaded into the browser, by entry id —
  // an entry absent here matches only by id and index description.
  entryContents?: Map<string, string>;
  artifactIndex?: IndexItem[];
  artifactContents?: Map<string, string>;
  resolveArtifactName?: (id: string) => string;
}

// Lowered copies of entry bodies, keyed by the contents map's identity — the
// store hands back the same map until a week load changes the cache, so each
// body is lowercased once, not on every keystroke.
const loweredContents = new WeakMap<Map<string, string>, Map<string, string>>();

type EntityKind = 'project' | 'action' | 'artifact' | 'entry';

// The query language: whitespace-separated tokens, every free-text term
// required to match (AND). `project:` / `action:` / `artifact:` / `entry:` (alias `note:`,
// plurals accepted) restrict the result types — text attached to the prefix
// is an ordinary term. `A..B` with ISO date prefixes (YYYY, YYYY-MM, or
// YYYY-MM-DD; either side omittable) keeps only items whose date falls in the
// inclusive range.
interface ParsedQuery {
  terms: string[];
  types: Set<EntityKind> | null;
  range: { from: string; to: string } | null;
}

const TYPE_PREFIX = /^(projects?|actions?|artifacts?|entry|entries|notes?):(.*)$/i;
const RANGE = /^(\d{4}(?:-\d{2}){0,2})?\.\.(\d{4}(?:-\d{2}){0,2})?$/;

function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  let types: Set<EntityKind> | null = null;
  let range: ParsedQuery['range'] = null;
  for (const token of query.split(/\s+/)) {
    const prefixed = token.match(TYPE_PREFIX);
    if (prefixed) {
      const head = prefixed[1].toLowerCase();
      const kind: EntityKind = head.startsWith('p') ? 'project' : head.startsWith('artifact') ? 'artifact' : head.startsWith('a') ? 'action' : 'entry';
      (types ??= new Set()).add(kind);
      if (prefixed[2]) terms.push(prefixed[2].toLowerCase());
      continue;
    }
    const r = token.match(RANGE);
    if (r && (r[1] || r[2])) {
      range = { from: r[1] ?? '', to: r[2] ?? '' };
      continue;
    }
    terms.push(token.toLowerCase());
  }
  return { terms, types, range };
}

// The item's calendar date — the leading YYYY-MM-DD of an entry timestamp or a
// date-coded entity id; null when the id carries none (a range then excludes it).
function datePart(id: string): string | null {
  const m = id.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

// Inclusive prefix comparison: "2025-01..2025-06" admits every date whose
// month falls in the window, whatever its day.
function inRange(id: string, range: { from: string; to: string }): boolean {
  const date = datePart(id);
  if (!date) return false;
  if (range.from && date < range.from) return false;
  if (range.to && date.slice(0, range.to.length) > range.to) return false;
  return true;
}

// ~100 characters of content around the first occurrence of `term`,
// whitespace collapsed, ellipsized at cut edges. Located case-insensitively on
// the raw text — an offset taken on a lowered copy can drift where lowercasing
// changes string length (İ → i̇).
function extractSnippet(content: string, term: string): string {
  const m = new RegExp(escapeRegExp(term), 'i').exec(content);
  const at = m?.index ?? 0;
  const start = Math.max(0, at - 30);
  const end = Math.min(content.length, at + (m?.[0].length ?? term.length) + 70);
  const clipped = content.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + clipped + (end < content.length ? '…' : '');
}

// Index rows every term matches (against display name, id, description, or —
// for cached entries and artifacts — full text), ranked: an exact name or id match first,
// then a name-prefix match, then by where the terms landed (name over id over
// description over content-only). Ties keep index order, which is reverse
// chronological — recency is the tie-break.
function matchIndex(
  items: IndexItem[],
  type: EntityKind,
  q: ParsedQuery,
  opts: SearchOptions,
): SearchResult[] {
  const joined = q.terms.join(' ');
  const scored: { result: SearchResult; score: number }[] = [];
  const contents = type === 'entry' ? opts.entryContents : type === 'artifact' ? opts.artifactContents : undefined;
  let lowered = contents && loweredContents.get(contents);
  if (contents && !lowered) loweredContents.set(contents, (lowered = new Map()));
  for (const item of items) {
    if (q.range && !inRange(item.id, q.range)) continue;
    const id = item.id.toLowerCase();
    const name = (type === 'entry' ? '' : (type === 'artifact' ? opts.resolveArtifactName?.(item.id) : opts.resolveName?.(type, item.id)) ?? '').toLowerCase();
    const desc = item.description.toLowerCase();
    const rawContent = contents?.get(item.id);
    let content = lowered?.get(item.id);
    if (rawContent != null && content === undefined) {
      content = rawContent.toLowerCase();
      lowered!.set(item.id, content);
    }

    let score = 0;
    let contentTerm: string | null = null;
    let matched = true;
    for (const term of q.terms) {
      if (name && name.includes(term)) score += 40;
      else if (id.includes(term)) score += 25;
      else if (desc.includes(term)) score += 15;
      else if (content && content.includes(term)) { score += 5; contentTerm ??= term; }
      else { matched = false; break; }
    }
    if (!matched) continue;
    if (joined) {
      if (name === joined || id === joined) score += 100;
      else if (name.startsWith(joined)) score += 60;
    }

    const result: SearchResult = { type, id: item.id, description: item.description || undefined };
    if (contentTerm && rawContent) result.snippet = extractSnippet(rawContent, contentTerm);
    scored.push({ result, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.result);
}

export function search(
  query: string,
  noteIndex: IndexItem[],
  projectIndex: IndexItem[],
  actionIndex: IndexItem[],
  opts: SearchOptions = {},
): SearchOutput {
  const trimmed = query.trim();
  if (!trimmed) return { results: [], terms: [] };

  const q = parseQuery(trimmed);
  const want = (k: EntityKind) => q.types === null || q.types.has(k);
  const results: SearchResult[] = [];

  // A query that reads as a date ("2026-05", "may 2026", "5/31") offers a flow
  // jump above the text matches — only untyped queries, and only past two
  // characters so a lone digit mid-typing doesn't read as a month number.
  const joined = q.terms.join(' ');
  if (q.types === null && joined.length >= 3) {
    const date = parseLooseDate(joined);
    if (date) results.push({ type: 'date', id: date });
  }

  if (want('project')) results.push(...matchIndex(projectIndex, 'project', q, opts));
  if (want('action')) results.push(...matchIndex(actionIndex, 'action', q, opts));
  if (want('artifact')) results.push(...matchIndex(opts.artifactIndex ?? [], 'artifact', q, opts));
  if (want('entry')) results.push(...matchIndex(noteIndex, 'entry', q, opts));
  return { results, terms: q.terms };
}

// HTML for a search-result label: the text escaped, with matches of any term
// wrapped in <mark>. Terms are tried longest-first so a shorter term never
// splits a longer one's mark. Matches against the raw text with each piece
// escaped separately — running the query over already-escaped text splits
// entities (a query of "amp" would tear `&amp;` into `&<mark>amp</mark>;`).
export function highlight(text: string, query: string | string[]): string {
  const needles = (Array.isArray(query) ? query : [query])
    .map((t) => t.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (needles.length === 0) return escapeHtml(text);
  const re = new RegExp(needles.join('|'), 'gi');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
