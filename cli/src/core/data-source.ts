// A file's content plus the version that identifies this revision — the
// server's ETag, else its Last-Modified, else a hash of the content itself.
// The tier prefix tells revalidate() how to check for a newer revision.
export interface FileRead {
  text: string;
  version: string;
}

// Abstract interface for reading files
export interface DataSource {
  // Read a file as text. Path is relative to the data root (e.g., "notes/2026/index.yaml").
  // Resolves to null when the file does not exist; throws on other failures.
  read(path: string): Promise<FileRead | null>;

  // Check a previously read file against the server: 'unchanged', the new
  // revision, or null when the file no longer exists. Throws on other
  // failures — a network error means "unknown", never "deleted".
  revalidate(path: string, version: string): Promise<FileRead | 'unchanged' | null>;

  // Absolute URL for an asset's bytes, usable directly as an <img>/<video>/<iframe>
  // src, or null when the source has no addressable URL (content must be read).
  assetUrl(path: string): string | null;

  // Check media metadata without reading its bytes. Undefined means this
  // source cannot check it; null means the file is missing.
  assetVersion?(path: string): Promise<string | null | undefined>;

  // List year subdirectories available in the data root
  listYears(): Promise<string[]>;

  // Subscribe to server-published change notifications: onChange receives
  // root-relative paths (possibly empty, meaning "something changed").
  // Best-effort — a source may not support it, and a subscription may never
  // deliver (server without the feature); polling remains the baseline.
  // Returns an unsubscribe function.
  watch?(onChange: (paths: string[]) => void): () => void;
}

// Years are discovered by probing each recent year's entity indexes — the data has
// no manifest; this is how far back to look.
const PROBE_YEARS = 5;

// FNV-1a over the text — the version of last resort, for servers that emit no
// validators. Content-derived, so it can never miss a change.
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// The strongest version this response supports: ETag, else Last-Modified,
// else a content hash. Cross-origin, unexposed validator headers read as
// absent, which lands in the hash tier — still correct, just full-GET checks.
function versionOf(response: Response, text: string): string {
  const etag = response.headers.get('ETag');
  if (etag) return `etag:${etag}`;
  const lastModified = response.headers.get('Last-Modified');
  if (lastModified) return `lm:${lastModified}`;
  return `hash:${fnv1a(text)}`;
}

// Percent-encode a root-relative path per segment, keeping the slashes: a
// data-derived name containing '#', '?', or a stray '%' must address the same
// resource, not truncate the URL. Both servers decode before resolving.
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

// URL-based data source — fetches files from a base URL
export class UrlDataSource implements DataSource {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly years?: readonly string[]) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async read(path: string): Promise<FileRead | null> {
    const url = `${this.baseUrl}/${encodePath(path)}`;
    // no-cache: revalidate with the origin instead of trusting the browser's
    // HTTP cache — a heuristically cached copy would hide changes from the
    // version tracking that catch-up checks depend on.
    const response = await fetch(url, { cache: 'no-cache' });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    return { text, version: versionOf(response, text) };
  }

  async revalidate(path: string, version: string): Promise<FileRead | 'unchanged' | null> {
    const url = `${this.baseUrl}/${encodePath(path)}`;
    const headers: Record<string, string> = {};
    if (version.startsWith('etag:')) headers['If-None-Match'] = version.slice(5);
    else if (version.startsWith('lm:')) headers['If-Modified-Since'] = version.slice(3);

    let response: Response;
    try {
      response = await fetch(url, { cache: 'no-cache', headers });
    } catch (err) {
      // Conditional headers aren't CORS-safelisted; a host that exposes ETags
      // but rejects the preflight fails here. Retry as a plain GET — the
      // version comparison below still detects the change.
      if (!Object.keys(headers).length) throw err;
      response = await fetch(url, { cache: 'no-cache' });
    }
    if (response.status === 304) return 'unchanged';
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    const next = versionOf(response, text);
    // Covers the hash tier and a server that answered 200 to an unchanged
    // conditional request alike.
    if (next === version) return 'unchanged';
    return { text, version: next };
  }

  assetUrl(path: string): string {
    return `${this.baseUrl}/${encodePath(path)}`;
  }

  async assetVersion(path: string): Promise<string | null | undefined> {
    const response = await fetch(`${this.baseUrl}/${encodePath(path)}`, { method: 'HEAD', cache: 'no-cache' });
    if (response.status === 404) return null;
    if (response.status === 405 || response.status === 501) return undefined;
    if (!response.ok) throw new Error(`Failed to check ${this.assetUrl(path)}: ${response.status} ${response.statusText}`);
    const etag = response.headers.get('ETag');
    if (etag) return `etag:${etag}`;
    const lastModified = response.headers.get('Last-Modified');
    return lastModified ? `lm:${lastModified}` : 'available';
  }

  // The server's change stream: SSE at `<data root>/.watch` publishing
  // coalesced root-relative paths (see dev-server.mjs). A server without the
  // endpoint fails the EventSource fatally (non-200 or wrong MIME) — one
  // wasted request, no retries, and the app just polls.
  watch(onChange: (paths: string[]) => void): () => void {
    if (typeof EventSource === 'undefined') return () => {};
    const events = new EventSource(`${this.baseUrl}/.watch`);
    events.onmessage = (e) => {
      let paths: string[] = [];
      try {
        const parsed: unknown = JSON.parse(e.data);
        if (Array.isArray(parsed)) paths = parsed.filter((p): p is string => typeof p === 'string');
      } catch {
        // Malformed event — treat as "something changed".
      }
      onChange(paths);
    };
    return () => events.close();
  }

  async listYears(): Promise<string[]> {
    if (this.years) return [...this.years].sort();
    const currentYear = new Date().getFullYear();
    const candidates = Array.from({ length: PROBE_YEARS }, (_, i) => String(currentYear - i));
    const results: string[] = [];
    for (const year of candidates) {
      // One retry: a year mistaken for absent stays invisible all session (the
      // periodic checks only revisit known years), so don't give up on the
      // first transient error.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const indexes = await Promise.allSettled(
            ['notes', 'projects', 'actions', 'artifacts'].map(kind => this.read(`${kind}/${year}/index.yaml`)),
          );
          if (indexes.some(result => result.status === 'fulfilled' && result.value != null)) {
            results.push(year);
            break;
          }
          if (indexes.some(result => result.status === 'rejected')) continue;
          break;
        } catch {
          // transient error probing this year — retry once, then treat as
          // absent rather than failing discovery
        }
      }
    }
    return results.sort();
  }
}
