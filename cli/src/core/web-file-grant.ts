// Shared, browser-safe file grant wire format. Cryptography stays in each
// runtime: Node crypto verifies grants; the trusted UI signs scoped media URLs.
import { isInstanceAddress } from './identity.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Scope = ['file' | 'tree', string];

export function fileGrantBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 8192) throw new Error('Invalid Aside file grant.');
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  if (fileGrantBase64(bytes) !== value) throw new Error('Invalid Aside file grant.');
  return bytes;
}

export function fileGrantKeyBytes(key: string): Uint8Array {
  const bytes = fromBase64(key);
  if (bytes.length !== 32) throw new Error('Invalid Aside file access key.');
  return bytes;
}

export function validFileGrantPath(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && encoder.encode(path).length <= 4096 &&
    !/[\\\u0000-\u001f\u007f]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function readScope(value: string): Scope {
  const parsed: unknown = JSON.parse(decoder.decode(fromBase64(value)));
  if (!Array.isArray(parsed) || parsed.length !== 2 || (parsed[0] !== 'file' && parsed[0] !== 'tree') ||
      !validFileGrantPath(parsed[1]) || fileGrantBase64(encoder.encode(JSON.stringify(parsed))) !== value) {
    throw new Error('Invalid Aside file grant scope.');
  }
  return parsed as Scope;
}

/** HTML may load relative resources from its folder; other media gets one file. */
export function fileGrantScope(path: string): string {
  if (!validFileGrantPath(path)) throw new Error('Invalid Aside file path.');
  const slash = path.lastIndexOf('/');
  const scope: Scope = /\.html?$/i.test(path) && slash > 0 ? ['tree', path.slice(0, slash)] : ['file', path];
  return fileGrantBase64(encoder.encode(JSON.stringify(scope)));
}

export function fileGrantMessage(scope: string): string {
  readScope(scope);
  return `aside-file-grant-v1\0${scope}`;
}

export function fileGrantScopeKind(scope: string): Scope[0] {
  return readScope(scope)[0];
}

export function fileGrantAllows(scope: string, path: string): boolean {
  try {
    if (!validFileGrantPath(path)) return false;
    const [kind, root] = readScope(scope);
    return kind === 'file' ? path === root : path.startsWith(root + '/');
  } catch { return false; }
}

export function validFileGrantBase(base: string): boolean {
  const match = /^\/-\/files\/([^/]+)\/([^/]+)$/.exec(base);
  return !!match && SESSION.test(match[1]) && isInstanceAddress(match[2]);
}

export function buildFileGrantUrl(base: string, scope: string, signature: string, path: string): string {
  if (!validFileGrantBase(base) || !/^[A-Za-z0-9_-]{43}$/.test(signature) || !fileGrantAllows(scope, path)) {
    throw new Error('Invalid Aside file access URL.');
  }
  return `${base}/${scope}/${signature}/files/${path.split('/').map(encodeURIComponent).join('/')}`;
}
