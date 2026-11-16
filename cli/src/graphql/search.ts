import { scheduleInstant } from '../core/scheduling.js';
import type { Store } from '../source/store.js';
import type { SemanticSearchService } from '../semantic/search.js';
import { configuredEmbeddingModel, SemanticSetupError } from '../semantic/embedding.js';
import type { QueryView, RecordNode, Where } from './query.js';

export type SearchOrder = 'CREATED_ASC' | 'CREATED_DESC' | 'SCHEDULED_ASC' | 'SCHEDULED_DESC' | 'DEADLINE_ASC' | 'DEADLINE_DESC';
export interface UnifiedSearchInput {
  where?: {entries?: Where | null; projects?: Where | null; actions?: Where | null; artifacts?: Where | null} | null;
  rankBy?: {semantic?: string | null; order?: SearchOrder | null} | null;
  limit?: number | null;
  offset?: number | null;
}
const groups = [['entries', 'entry'], ['projects', 'project'], ['actions', 'action'], ['artifacts', 'artifact']] as const;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const metadata = (node: RecordNode) => node.record.meta ?? node.record.frontMatter;
const compareCreated = (a: RecordNode, b: RecordNode) => compareText(metadata(a).created, metadata(b).created)
  || compareText(a.id, b.id) || compareText(a.kind, b.kind);

function ordered(nodes: RecordNode[], order: SearchOrder): RecordNode[] {
  if (order.startsWith('CREATED_')) return nodes.sort((a, b) => (order === 'CREATED_ASC' ? 1 : -1) * compareCreated(a, b));
  const field = order.startsWith('SCHEDULED_') ? 'scheduled' : 'deadline';
  const direction = order.endsWith('_ASC') ? 1 : -1;
  const times = new Map(nodes.map(node => {
    const fm = node.kind === 'action' ? metadata(node) : undefined;
    return [node, fm?.[field] == null ? undefined : scheduleInstant(fm[field], field === 'scheduled' ? fm.timezone : undefined)] as const;
  }));
  return nodes.sort((a, b) => {
    const av = times.get(a), bv = times.get(b);
    if (av == null || bv == null) return av == null && bv == null ? compareCreated(a, b) : av == null ? 1 : -1;
    return direction * (av - bv) || compareCreated(a, b);
  });
}

function hit(node: RecordNode) {
  const content = node.kind === 'entry' ? node.record.content : node.record.body;
  return {kind: node.kind, id: node.id, handle: node.handle,
    name: node.kind === 'entry' ? node.id : node.record.frontMatter.name,
    description: node.description ?? '', snippet: content.trim().slice(0, 1400), score: null};
}

/** Membership, ranking, and pagination have separate, shared contracts. */
export async function unifiedSearch(
  view: QueryView, store: Store, input: UnifiedSearchInput,
  options: {semanticSearch?: SemanticSearchService['search']; semanticReconcile?: (store: Store, options: {signal?: AbortSignal}) => Promise<unknown>;
    signal?: AbortSignal; check: () => void; needsRanking?: boolean},
) {
  const limit = input.limit ?? 20, offset = input.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be from 1 to 100.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Search offset must be a nonnegative integer.');
  const rank = input.rankBy ?? {order: 'CREATED_DESC' as const};
  const semantic = rank.semantic;
  if (semantic != null && (typeof semantic !== 'string' || !semantic.trim() || semantic.length > 4000)) throw new Error('Semantic query must contain 1–4000 characters.');
  if (semantic != null && rank.order != null) throw new Error('Choose one ranking: semantic or order.');
  options.check();
  const selected = groups.filter(([group]) => input.where?.[group] != null);
  const nodes: RecordNode[] = [];
  for (const [group, kind] of selected.length ? selected : groups) {
    for (const node of await view.selectSaved(kind, input.where?.[group] ?? {})) nodes.push(node);
    options.check();
  }
  const totalCount = nodes.length;
  const page = {totalCount, count: Math.min(limit, Math.max(0, totalCount - offset)), offset};
  if (options.needsRanking === false) return {...page, model: null, indexedChunks: 0, hits: []};
  if (!page.count) {
    // An empty page can follow deletion of the entire corpus. Structural
    // membership needs no inference, but selected semantic results still need
    // the registered index reconciled rather than bypassing maintenance.
    if (semantic != null && options.semanticReconcile) {
      await options.semanticReconcile(store, {signal: options.signal});
      options.check();
    }
    return {...page, model: null, indexedChunks: 0, hits: []};
  }
  if (semantic != null) {
    if (!options.semanticSearch) throw new SemanticSetupError('Semantic ranking requires the Aside daemon and a local embedding model. Field ordering remains available through rankBy.order.', {
      reason: 'INDEX_UNAVAILABLE', recovery: 'Run this query through the Aside daemon.', model: configuredEmbeddingModel(),
    });
    const result = await options.semanticSearch(store, {query: semantic, first: limit},
      {signal: options.signal, allowedHandles: nodes.map(node => node.handle), offset});
    options.check();
    return {...page, count: result.hits.length, ...result};
  }
  return {...page, model: null, indexedChunks: 0, hits: ordered(nodes, rank.order ?? 'CREATED_DESC').slice(offset, offset + limit).map(hit)};
}
