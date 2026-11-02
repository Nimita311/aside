import { UrlDataSource } from '../lib/io';
import { RemoteStore } from '../lib/remote-store';
import type { DataSnapshot } from '../../cli/src/core/data-snapshot';
import { instanceUrl } from './route';
import type { WebQueryRequest, WebQueryResult } from '../../cli/src/core/web-query';
import type { FileRead } from '../lib/io';
import { authFetch, connectAuthenticatedEvents } from './auth';
import { grantUrl } from './file-grants';

export async function queryDaemonInstance(instance: string, request: WebQueryRequest, signal: AbortSignal): Promise<WebQueryResult> {
  const response = await authFetch(`/-/api/instances/${encodeURIComponent(instance)}/graphql`, {
    method: 'POST', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json', 'X-Aside-Control': '1' }, body: JSON.stringify(request),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `GraphQL request failed (${response.status}).`);
  return result;
}

import type { AvailableInstance } from '../../cli/src/web/catalogue';
export type { AvailableInstance };

export async function daemonRequest<T>(endpoint: string, body?: unknown): Promise<T> {
  const response = await authFetch(`/-/api/${endpoint}`, {
    cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Aside-Control': '1' }, body: JSON.stringify(body) }),
  });
  const value = await response.json() as T & { error?: string; paths?: string[] };
  if (!response.ok) throw new Error([value.error ?? `Aside request failed (${response.status}).`, ...(value.paths ?? [])].join('\n'));
  return value;
}

// Parsed data comes from the daemon core. Raw file URLs are used only for
// displayed supporting text and media. Every request carries the instance id.
export class DaemonDataSource extends UrlDataSource {
  constructor(readonly instanceId: string, private readonly fileBase: string, private readonly fileKey: string) {
    grantUrl(fileBase, fileKey, 'aside.md'); // Validate the capability before loading records.
    super(fileBase);
  }
  override assetUrl(path: string): string { return grantUrl(this.fileBase, this.fileKey, path); }
  private apiFileUrl(path: string): string {
    return `/-/api/instances/${encodeURIComponent(this.instanceId)}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  override async read(path: string): Promise<FileRead | null> {
    const response = await authFetch(this.apiFileUrl(path), { cache: 'no-cache' });
    return this.fileRead(response, path);
  }
  override async revalidate(path: string, version: string): Promise<FileRead | 'unchanged' | null> {
    const headers: Record<string, string> = {};
    if (version.startsWith('etag:')) headers['If-None-Match'] = version.slice(5);
    else if (version.startsWith('lm:')) headers['If-Modified-Since'] = version.slice(3);
    const response = await authFetch(this.apiFileUrl(path), { cache: 'no-cache', headers });
    if (response.status === 304) return 'unchanged';
    const file = await this.fileRead(response, path);
    return file?.version === version ? 'unchanged' : file;
  }
  private async fileRead(response: Response, path: string): Promise<FileRead | null> {
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Failed to fetch ${this.apiFileUrl(path)}: ${response.status} ${response.statusText}`);
    const text = await response.text();
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
    const etag = response.headers.get('ETag'), modified = response.headers.get('Last-Modified');
    return { text, version: etag ? `etag:${etag}` : modified ? `lm:${modified}` : `hash:${(hash >>> 0).toString(36)}` };
  }
  override async assetVersion(path: string): Promise<string | null | undefined> {
    const response = await authFetch(this.apiFileUrl(path), { method: 'HEAD', cache: 'no-cache' });
    if (response.status === 404) return null;
    if (response.status === 405 || response.status === 501) return undefined;
    if (!response.ok) throw new Error(`Failed to check ${this.apiFileUrl(path)}: ${response.status} ${response.statusText}`);
    const etag = response.headers.get('ETag'), modified = response.headers.get('Last-Modified');
    return etag ? `etag:${etag}` : modified ? `lm:${modified}` : 'available';
  }
  async snapshot(version?: string, refresh = false): Promise<{ value: DataSnapshot; version: string } | 'unchanged'> {
    const response = await authFetch(`/-/api/instances/${encodeURIComponent(this.instanceId)}/data${refresh ? '?refresh=1' : ''}`, {
      cache: 'no-store', ...(version ? { headers: { 'If-None-Match': version } } : {}),
    });
    if (response.status === 304) return 'unchanged';
    const value = await response.json();
    if (!response.ok) throw new Error([value.error ?? `Aside request failed (${response.status}).`, ...(value.paths ?? [])].join('\n'));
    return { value, version: response.headers.get('ETag') ?? JSON.stringify(value) };
  }
  override async listYears(): Promise<string[]> { return daemonRequest<string[]>(`instances/${encodeURIComponent(this.instanceId)}/years`); }
  override watch(onChange: (paths: string[]) => void): () => void {
    return connectAuthenticatedEvents(`/-/api/instances/${encodeURIComponent(this.instanceId)}/watch`, { message: data => {
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
  const access = await daemonRequest<{ fileBase: string; fileKey: string }>(`instances/${encodeURIComponent(address)}/access`);
  const source = new DaemonDataSource(address, access.fileBase, access.fileKey);
  const store = new RemoteStore(source);
  await store.init();
  // The identity can disappear or become ambiguous while records are loading.
  const current = await daemonRequest<AvailableInstance>(`instances/${encodeURIComponent(source.instanceId)}`);
  if (current.path !== instance.path) throw new Error('Instance directory changed while loading.');
  return { instance: current, source, store };
}

export function instanceLink(instance: AvailableInstance): string { return instanceUrl(instance.address ?? instance.id, ''); }
