import type { IncomingMessage } from 'node:http';

function header(req: IncomingMessage, name: string): string | undefined {
  const occurrences = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length;
  const value = req.headers[name];
  if (occurrences > 1 || Array.isArray(value) || value?.includes(',')) throw new Error(`Invalid ${name} header.`);
  return value;
}

function authority(value: string, scheme: string): URL {
  if (!value || /[\s\\/?#@]/.test(value)) throw new Error('Invalid host authority.');
  const url = new URL(`${scheme}://${value}`);
  if (!url.hostname || url.username || url.password) throw new Error('Invalid host authority.');
  return url;
}

/** Backend Host is checked independently of client-controlled forwarding metadata. */
export function requestOrigin(req: IncomingMessage): string {
  const host = header(req, 'host');
  if (!host) throw new Error('Missing Host header.');
  const backend = authority(host, 'http');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(backend.hostname)) throw new Error('Backend Host must identify loopback.');
  const forwardedHost = header(req, 'x-forwarded-host');
  const scheme = header(req, 'x-forwarded-proto');
  if (forwardedHost === undefined && scheme === undefined) return backend.origin;
  if (forwardedHost === undefined || (scheme !== 'http' && scheme !== 'https')) throw new Error('Invalid forwarded origin.');
  return authority(forwardedHost, scheme).origin;
}

export function sameOrigin(req: IncomingMessage, destination: string): boolean {
  try {
    const value = header(req, 'origin');
    if (value !== undefined) {
      const match = /^(https?):\/\/([^/?#\\]+)$/i.exec(value);
      return !!match && authority(match[2], match[1].toLowerCase()).origin === destination;
    }
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  } catch { return false; }
}
