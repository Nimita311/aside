import { UrlDataSource, conditionalHeaders, encodePath, validatorVersion, versionOf } from '../lib/io';
import { RemoteStore } from '../lib/remote-store';
import type { DataSnapshot } from '../../cli/src/core/data-snapshot';
import { instanceUrl } from './route';
import type { WebQueryRequest, WebQueryResult } from '../../cli/src/core/web-query';
import type { FileRead } from '../lib/io';
import { webFetch, connectEvents } from './connection';

export async function queryDaemonInstance(instance: string, request: WebQueryRequest, signal: AbortSignal): Promise<WebQueryResult> {
  const response = await webFetch(`/-/api/instances/${encodeURIComponent(instance)}/graphql`, {
    method: 'POST', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `GraphQL request failed (${response.status}).`);
  return result;
}

import type {AvailableInstance} from '../../cli/src/core/catalogue';
export type { AvailableInstance };

export class DaemonRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function daemonRequest<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await webFetch(`/-/api/${endpoint}`, {
    cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json() as T & { error?: string; paths?: string[] };
  if (!response.ok) throw new DaemonRequestError([value.error ?? `Aside request failed (${response.status}).`, ...(value.paths ?? [])].join('\n'), response.status);
  return value;
}

// Parsed data comes from the daemon core. Raw file URLs are used only for
// displayed supporting text and media. Every request carries the instance id.
export class DaemonDataSource extends UrlDataSource {
  constructor(readonly instanceId: string) {
    super(`/-/api/instances/${encodeURIComponent(instanceId)}/files`);
  }
  private apiFileUrl(path: string): string {
    return `/-/api/instances/${encodeURIComponent(this.instanceId)}/files/${encodePath(path)}`;
  }
  override async read(path: string): Promise<FileRead | null> {
    const response = await webFetch(this.apiFileUrl(path), { cache: 'no-cache' });
    return this.fileRead(response, path);
  }
  override async revalidate(path: string, version: string): Promise<FileRead | 'unchanged' | null> {
    const response = await webFetch(this.apiFileUrl(path), { cache: 'no-cache', headers: conditionalHeaders(version) });
    if (response.status === 304) return 'unchanged';
    const file = await this.fileRead(response, path);
    return file?.version === version ? 'unchanged' : file;
  }
  private async fileRead(response: Response, path: string): Promise<FileRead | null> {
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Failed to fetch ${this.apiFileUrl(path)}: ${response.status} ${response.statusText}`);
    const text = await response.text();
    return { text, version: versionOf(response, text) };
  }
  override async assetVersion(path: string): Promise<string | null | undefined> {
    const response = await webFetch(this.apiFileUrl(path), { method: 'HEAD', cache: 'no-cache' });
    if (response.status === 404) return null;
    if (response.status === 405 || response.status === 501) return undefined;
    if (!response.ok) throw new Error(`Failed to check ${this.apiFileUrl(path)}: ${response.status} ${response.statusText}`);
    return validatorVersion(response) ?? 'available';
  }
  async snapshot(version?: string, refresh = false): Promise<{ value: DataSnapshot; version: string } | 'unchanged'> {
    const response = await webFetch(`/-/api/instances/${encodeURIComponent(this.instanceId)}/data${refresh ? '?refresh=1' : ''}`, {
      cache: 'no-store', ...(version ? { headers: { 'If-None-Match': version } } : {}),
    });
    if (response.status === 304) return 'unchanged';
    const value = await response.json();
    if (!response.ok) throw new Error([value.error ?? `Aside request failed (${response.status}).`, ...(value.paths ?? [])].join('\n'));
    return { value, version: response.headers.get('ETag') ?? JSON.stringify(value) };
  }
  override async listYears(): Promise<string[]> { return daemonRequest<string[]>(`instances/${encodeURIComponent(this.instanceId)}/years`); }
  override watch(onChange: (paths: string[]) => void): () => void {
    return connectEvents(`/-/api/instances/${encodeURIComponent(this.instanceId)}/watch`, { message: data => {
      try {
        const paths: unknown = JSON.parse(data);
        onChange(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []);
      } catch { onChange([]); }
    } });
  }
}

// Instance availability is established by the daemon, independently of
// individual files. Store retains readable records and diagnoses file errors.
export async function loadDaemonInstance(instanceId: string): Promise<{ instance: AvailableInstance; source: DaemonDataSource; store: RemoteStore }> {
  const instance = await daemonRequest<AvailableInstance>(`instances/${encodeURIComponent(instanceId)}`);
  // Pin data and file requests to the exact directory even if its bare ID subsequently
  // becomes ambiguous. The address used for presentation can stay canonical.
  const address = instance.alias ?? instanceId;
  const source = new DaemonDataSource(address);
  const store = new RemoteStore(source);
  await store.init();
  // The identity can disappear or become ambiguous while records are loading.
  const current = await daemonRequest<AvailableInstance>(`instances/${encodeURIComponent(source.instanceId)}`);
  if (current.path !== instance.path) throw new Error('Instance directory changed while loading.');
  return { instance: current, source, store };
}

export function instanceLink(instance: AvailableInstance): string { return instanceUrl(instance.address ?? instance.id, ''); }
