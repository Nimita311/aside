import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { fileGrantAllows, fileGrantBase64, fileGrantMessage, fileGrantScope } from '../src/core/web-file-grant.js';
import { parseFileGrantPath, verifyFileGrant } from '../src/web/file-grants.js';
import { grantUrl } from '../../webapp/src/file-grants.js';

const key = Buffer.alloc(32, 7).toString('base64url');
const base = '/-/files/00000000-0000-4000-8000-000000000001/test-instance';
function parsed(file: string) { return parseFileGrantPath(grantUrl(base, key, file))!; }
function verifies(url: string, signingKey = key): boolean {
  const grant = parseFileGrantPath(new URL(url, 'http://localhost:24800').pathname);
  return !!grant && verifyFileGrant(signingKey, grant.scope, grant.signature, grant.path);
}

describe('scoped browser file grants', () => {
  it('uses standard HMAC-SHA256 interoperably in browser and Node', () => {
    const grant = parsed('assets/chart.svg');
    expect(grant.signature).toBe(createHmac('sha256', Buffer.from(key, 'base64url')).update(fileGrantMessage(grant.scope)).digest('base64url'));
    expect(verifyFileGrant(key, grant.scope, grant.signature, grant.path)).toBe(true);
    expect(verifyFileGrant(Buffer.alloc(32, 8).toString('base64url'), grant.scope, grant.signature, grant.path)).toBe(false);
  });

  it('limits SVG and other media URLs to their exact file', () => {
    const url = grantUrl(base, key, 'assets/chart.svg');
    expect(verifies(url)).toBe(true);
    for (const relative of ['private.md', '../aside.md', '../projects/2026/private.md']) expect(verifies(new URL(relative, `http://localhost:24800${url}`).href)).toBe(false);
    expect(verifies(url.replace('chart.svg', 'other.svg'))).toBe(false);
    expect(verifies(url.replace('test-instance', 'another-instance'), Buffer.alloc(32, 8).toString('base64url'))).toBe(false);
  });

  it('allows HTML relative resources only within its own subtree', () => {
    const url = grantUrl(base, key, 'artifacts/2026/report/index.HTML');
    for (const relative of ['chart.svg', 'images/chart.svg', 'images/../chart.svg']) expect(verifies(new URL(relative, `http://localhost:24800${url}`).href)).toBe(true);
    for (const relative of ['../private.md', '../../private.md', '../../../aside.md']) expect(verifies(new URL(relative, `http://localhost:24800${url}`).href)).toBe(false);
    expect(verifies(grantUrl(base, key, 'index.html').replace('files/index.html', 'files/aside.md'))).toBe(false);
    const grant = parsed('artifacts/2026/report/index.html');
    expect(fileGrantAllows(grant.scope, 'artifacts/2026/report-evil/private.md')).toBe(false);
    expect(fileGrantAllows(grant.scope, 'projects/2026/private.md')).toBe(false);
  });

  it('preserves literal filename punctuation, percent escapes, spaces, and Unicode', () => {
    const file = 'artifacts/2026/报告/100% done #1? %2F.png';
    const url = grantUrl(base, key, file);
    expect(parseFileGrantPath(url)?.path).toBe(file);
    expect(new URL(url, 'http://localhost:24800').search).toBe('');
    expect(new URL(url, 'http://localhost:24800').hash).toBe('');
    expect(verifies(url)).toBe(true);
  });

  it('rejects malformed paths, scopes, and tampered signatures', () => {
    for (const file of ['', '/aside.md', '../aside.md', 'assets/../aside.md', 'assets//a.svg', 'assets/./a.svg', 'assets\\a.svg', 'assets/a\0.svg']) {
      expect(() => grantUrl(base, key, file)).toThrow();
    }
    const url = grantUrl(base, key, 'assets/chart.svg');
    for (const path of ['assets/%2e%2e/aside.md', 'assets%2fchart.svg', 'assets/%5cchart.svg', 'assets/%00chart.svg', 'assets/%ZZ']) {
      expect(parseFileGrantPath(url.replace('assets/chart.svg', path))).toBeNull();
    }
    const grant = parsed('assets/chart.svg');
    expect(verifyFileGrant(key, grant.scope, 'a'.repeat(43), grant.path)).toBe(false);
    expect(verifyFileGrant(key, fileGrantScope('assets/other.svg'), grant.signature, 'assets/other.svg')).toBe(false);
    const wholeInstance = fileGrantBase64(new TextEncoder().encode(JSON.stringify(['tree', ''])));
    expect(fileGrantAllows(wholeInstance, 'aside.md')).toBe(false);
  });
});
