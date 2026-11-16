import type { WebQueryRequest, WebQueryResult } from '../../cli/src/core/web-query';

export const IFRAME_CONNECT = 'aside:query-connect';
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export type ClientMessage = { type: 'query'; id: number; request: WebQueryRequest }
  | { type: 'resource'; id: number; reference: string }
  | { type: 'cancel'; id: number } | { type: 'close' };
export type HostMessage = { type: 'ready' } | { type: 'closed'; message: string }
  | { type: 'result'; id: number; result: WebQueryResult }
  | { type: 'resource'; id: number; bytes: ArrayBuffer; mediaType: string }
  | { type: 'error'; id: number; message: string };
