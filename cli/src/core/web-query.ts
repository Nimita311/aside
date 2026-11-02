// Shared wire contract; this module has no GraphQL or daemon runtime imports.
export const WEB_QUERY_MAX_BYTES = 64 * 1024;
export const WEB_QUERY_TIMEOUT_MS = 10_000;
export const WEB_QUERY_MAX_RESPONSE_BYTES = 1024 * 1024;
export interface WebQueryRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}
export interface WebQueryResult {
  data?: Record<string, unknown> | null;
  errors?: readonly unknown[];
  extensions?: Record<string, unknown>;
}

export function validWebQueryRequest(value: unknown): value is WebQueryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).every(key => ['query', 'variables', 'operationName'].includes(key))
    && typeof input.query === 'string' && input.query.length > 0
    && (input.operationName === undefined || typeof input.operationName === 'string')
    && (input.variables === undefined || !!input.variables && typeof input.variables === 'object' && !Array.isArray(input.variables));
}

export function webQueryBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
