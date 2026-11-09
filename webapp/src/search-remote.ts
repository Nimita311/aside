import type { WebQueryRequest, WebQueryResult } from '../../cli/src/core/web-query';
import type { SearchOutput, SearchResult } from './search';

export type RemoteSearchMode = 'regex' | 'semantic';
export type SearchQuery = (request: WebQueryRequest, signal: AbortSignal) => Promise<WebQueryResult>;
export interface RemoteSearchOutput extends SearchOutput { detail: string }

const SEMANTIC_QUERY = `query SearchByMeaning($query: String!) {
  search(rankBy: {semantic: $query}, limit: 20) {
    model indexedChunks totalCount count offset hits { kind id name description snippet }
  }
}`;
const REGEX_QUERY = `query SearchByRegex($pattern: String!) {
  search(where: {
    entries: {regex: $pattern}, projects: {regex: $pattern},
    actions: {regex: $pattern}, artifacts: {regex: $pattern}
  }, rankBy: {order: CREATED_DESC}, limit: 20) {
    model indexedChunks totalCount count offset hits { kind id name description snippet }
  }
}`;

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : 'Search request failed.';
}

// The selected mode determines the wire operation. Text query syntax is never
// parsed here, and a failed semantic request never becomes a regex request.
export async function remoteSearch(mode: RemoteSearchMode, text: string, query: SearchQuery, signal: AbortSignal): Promise<RemoteSearchOutput> {
  const response = await query({
    query: mode === 'semantic' ? SEMANTIC_QUERY : REGEX_QUERY,
    variables: mode === 'semantic' ? { query: text } : { pattern: text },
  }, signal);
  if (response.errors?.length) throw new Error(response.errors.map(errorMessage).join('\n'));
  const data = response.data;
  if (!data) throw new Error('Search returned no data.');
  const result = data.search as {
    model: string | null; indexedChunks: number; totalCount: number; count: number; offset: number;
    hits: { kind: string; id: string; name?: string | null; description?: string | null; snippet?: string | null }[];
  } | undefined;
  if (!result || !Array.isArray(result.hits)) throw new Error('Search returned an invalid result.');
  const kinds: Record<string, SearchResult['type']> = { ENTRY: 'entry', PROJECT: 'project', ACTION: 'action', ARTIFACT: 'artifact' };
  const results = result.hits.map(hit => {
    const type = kinds[hit.kind];
    if (!type || typeof hit.id !== 'string') throw new Error('Search returned an invalid hit.');
    return { type, id: hit.id, name: hit.name ?? undefined, description: hit.description ?? undefined, snippet: hit.snippet ?? undefined };
  });
  const detail = mode === 'semantic'
    ? `Ranked by meaning${result.model ? ` · ${result.model} · ${result.indexedChunks} indexed chunks` : ''}`
    : 'Newest matches across all types · up to 20 · attachment contents excluded';
  return { results, terms: [], detail };
}
