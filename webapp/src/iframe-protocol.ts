import type { WebQueryRequest, WebQueryResult } from '../../cli/src/core/web-query';

export const IFRAME_CONNECT = 'aside:query-connect';
export const IFRAME_TOKEN = '__aside_query';
export type ClientMessage = { type: 'query'; id: number; request: WebQueryRequest }
  | { type: 'cancel'; id: number } | { type: 'close' };
export type HostMessage = { type: 'ready' } | { type: 'closed'; message: string }
  | { type: 'result'; id: number; result: WebQueryResult } | { type: 'error'; id: number; message: string };
