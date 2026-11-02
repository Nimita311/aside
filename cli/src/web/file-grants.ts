import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  fileGrantAllows, fileGrantKeyBytes, fileGrantMessage, validFileGrantBase, validFileGrantPath,
} from '../core/web-file-grant.js';

export interface ParsedFileGrant { session: string; instance: string; scope: string; signature: string; path: string }

/** Parse the raw URL pathname before any decoding; each path segment decodes once. */
export function parseFileGrantPath(pathname: string): ParsedFileGrant | null {
  const match = /^\/-\/files\/([^/]+)\/([^/]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]{43})\/files\/(.+)$/.exec(pathname);
  if (!match || !validFileGrantBase(`/-/files/${match[1]}/${match[2]}`)) return null;
  try {
    const parts = match[5].split('/').map(decodeURIComponent);
    if (parts.some(part => part.includes('/'))) return null;
    const path = parts.join('/');
    if (!validFileGrantPath(path)) return null;
    return { session: match[1], instance: match[2], scope: match[3], signature: match[4], path };
  } catch { return null; }
}

/** The key must come from an active session bound to the canonical instance directory. */
export function verifyFileGrant(fileKey: string, scope: string, signature: string, path: string): boolean {
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(signature) || !fileGrantAllows(scope, path)) return false;
    const expected = createHmac('sha256', fileGrantKeyBytes(fileKey)).update(fileGrantMessage(scope)).digest();
    const actual = Buffer.from(signature, 'base64url');
    return actual.length === expected.length && actual.toString('base64url') === signature && timingSafeEqual(actual, expected);
  } catch { return false; }
}
