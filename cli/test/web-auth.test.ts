import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WEB_AUTH_LEASE_MS, WebAuth } from '../src/web/auth.js';

const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aside-web-auth-'));
  dirs.push(root);
  const directory = join(root, 'state'), file = join(directory, 'web-auth.json');
  let now = Date.UTC(2026, 9, 14, 12);
  return { root, directory, file, clock: () => now, advance: (ms: number) => { now += ms; } };
}
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('WebAuth', () => {
  it('issues separate 256-bit credentials and saves only hashes in private atomic state', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock);
    const a = auth.issue(), b = auth.issue();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.token, 'base64url').length).toBe(32);
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
    expect(a.expiresAt).toBe(f.clock() + WEB_AUTH_LEASE_MS);
    expect(auth.authorize(a.token)).toEqual({ id: a.id, expiresAt: a.expiresAt });
    const text = readFileSync(f.file, 'utf8');
    expect(text).not.toContain(a.token);
    expect(text).not.toContain(b.token);
    expect(JSON.parse(text)).toEqual({ version: 1, sessions: [a, b].map(({ id, token, expiresAt }) => ({
      id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt,
    })) });
    expect(statSync(f.directory).mode & 0o7777).toBe(0o700);
    expect(statSync(f.file).mode & 0o7777).toBe(0o600);
    expect(readdirSync(f.directory)).toEqual(['web-auth.json']);
    for (const invalid of ['', a.token + 'a', '!' + a.token.slice(1), b.token.slice(1)]) expect(auth.authorize(invalid)).toBeNull();
  });

  it('preserves the absolute deadline across restarts and never renews through authorization', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), issued = auth.issue();
    const saved = readFileSync(f.file, 'utf8');
    f.advance(WEB_AUTH_LEASE_MS - 1);
    expect(auth.authorize(issued.token)).toEqual({ id: issued.id, expiresAt: issued.expiresAt });
    expect(auth.session(issued.id)).toEqual({ id: issued.id, expiresAt: issued.expiresAt });
    expect(new WebAuth(f.directory, f.clock).authorize(issued.token)).toEqual({ id: issued.id, expiresAt: issued.expiresAt });
    expect(readFileSync(f.file, 'utf8')).toBe(saved);
    f.advance(1);
    expect(auth.authorize(issued.token)).toBeNull();
    expect(auth.session(issued.id)).toBeNull();
    expect(new WebAuth(f.directory, f.clock).authorize(issued.token)).toBeNull();
    expect(readFileSync(f.file, 'utf8')).toBe(saved);
  });

  it('renews only the named valid browser without rotating its credential', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), a = auth.issue(), b = auth.issue();
    f.advance(10 * 86_400_000);
    expect(auth.renew(a.id)).toEqual({ id: a.id, expiresAt: f.clock() + WEB_AUTH_LEASE_MS });
    const reloaded = new WebAuth(f.directory, f.clock);
    expect(reloaded.authorize(a.token)?.expiresAt).toBe(f.clock() + WEB_AUTH_LEASE_MS);
    expect(reloaded.authorize(b.token)?.expiresAt).toBe(b.expiresAt);
    f.advance(20 * 86_400_000);
    const before = readFileSync(f.file, 'utf8');
    expect(auth.renew(b.id)).toBeNull();
    expect(auth.renew('unknown-session')).toBeNull();
    expect(readFileSync(f.file, 'utf8')).toBe(before);
    expect(auth.authorize(a.token)).not.toBeNull();
    expect(auth.authorize(b.token)).toBeNull();
  });

  it('revokes individual browsers or every browser across store instances', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), a = auth.issue(), b = auth.issue();
    const other = new WebAuth(f.directory, f.clock);
    other.revoke(a.id);
    expect(auth.authorize(a.token)).toBeNull();
    expect(auth.session(a.id)).toBeNull();
    expect(auth.authorize(b.token)).not.toBeNull();
    auth.revoke();
    expect(other.authorize(b.token)).toBeNull();
    expect(new WebAuth(f.directory, f.clock).authorize(b.token)).toBeNull();
  });

  it('derives private instance file keys that survive renewal and restart but stop at revocation or expiry', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), a = auth.issue(), b = auth.issue();
    const path = join(f.root, 'instance'), key = auth.fileKey(a.id, path)!;
    expect(Buffer.from(key, 'base64url').length).toBe(32);
    expect(key).not.toBe(a.token);
    expect(auth.fileKey(a.id, join(f.root, 'other-instance'))).not.toBe(key);
    expect(auth.fileKey(b.id, path)).not.toBe(key);
    expect(auth.fileKey(a.id, 'relative-instance')).toBeNull();
    f.advance(86_400_000);
    auth.renew(a.id);
    expect(new WebAuth(f.directory, f.clock).fileKey(a.id, path)).toBe(key);
    auth.revoke(a.id);
    expect(auth.fileKey(a.id, path)).toBeNull();
    f.advance(WEB_AUTH_LEASE_MS);
    expect(auth.fileKey(b.id, path)).toBeNull();
  });

  it('atomically replaces the registry while an open reader retains the previous complete state', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), issued = auth.issue();
    const before = readFileSync(f.file, 'utf8'), fd = openSync(f.file, 'r');
    try {
      f.advance(86_400_000);
      auth.renew(issued.id);
      expect(readFileSync(fd, 'utf8')).toBe(before);
      expect(JSON.parse(readFileSync(f.file, 'utf8')).sessions[0].expiresAt).toBe(f.clock() + WEB_AUTH_LEASE_MS);
      expect(readdirSync(f.directory)).toEqual(['web-auth.json']);
    } finally { closeSync(fd); }
  });

  it('fails closed when the process owner does not own the state directory', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), issued = auth.issue();
    const owner = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);
    try {
      expect(auth.authorize(issued.token)).toBeNull();
      expect(auth.session(issued.id)).toBeNull();
      expect(() => new WebAuth(f.directory, f.clock)).toThrow(/owner-only ordinary directory/);
    } finally { owner.mockRestore(); }
  });

  it('refuses permissive or symlink state directories without repairing their permissions', () => {
    const f = fixture();
    mkdirSync(f.directory, { mode: 0o755 });
    expect(() => new WebAuth(f.directory, f.clock)).toThrow(/owner-only ordinary directory/);
    expect(statSync(f.directory).mode & 0o7777).toBe(0o755);
    rmSync(f.directory, { recursive: true });
    const outside = join(f.root, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, f.directory);
    expect(() => new WebAuth(f.directory, f.clock)).toThrow(/owner-only ordinary directory/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('fails closed when registry permissions change after issue', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), issued = auth.issue();
    chmodSync(f.file, 0o644);
    expect(auth.authorize(issued.token)).toBeNull();
    expect(() => auth.renew(issued.id)).toThrow(/owner-only ordinary file/);
    expect(() => auth.issue()).toThrow(/owner-only ordinary file/);
    expect(() => new WebAuth(f.directory, f.clock)).toThrow(/owner-only ordinary file/);
    expect(statSync(f.file).mode & 0o7777).toBe(0o644);
  });

  it('rejects a symlinked or hardlinked registry and leaves its target unchanged', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), issued = auth.issue();
    const saved = readFileSync(f.file, 'utf8'), target = join(f.root, 'target.json');
    writeFileSync(target, saved, { mode: 0o600 });
    unlinkSync(f.file);
    symlinkSync(target, f.file);
    expect(auth.authorize(issued.token)).toBeNull();
    expect(() => auth.issue()).toThrow(/owner-only ordinary file/);
    expect(readFileSync(target, 'utf8')).toBe(saved);
    unlinkSync(f.file);
    linkSync(target, f.file);
    expect(auth.authorize(issued.token)).toBeNull();
    expect(() => new WebAuth(f.directory, f.clock)).toThrow(/owner-only ordinary file/);
  });

  it('rejects malformed, duplicate, or plaintext-credential registry state', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), issued = auth.issue();
    const valid = JSON.parse(readFileSync(f.file, 'utf8'));
    for (const invalid of ['{', JSON.stringify({ version: 2, sessions: [] }),
      JSON.stringify({ ...valid, sessions: [...valid.sessions, ...valid.sessions] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], token: issued.token }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], expiresAt: 'tomorrow' }] }),
      JSON.stringify({ ...valid, sessions: [{ ...valid.sessions[0], tokenHash: 'not-a-hash' }] })]) {
      writeFileSync(f.file, invalid);
      expect(auth.authorize(issued.token)).toBeNull();
      expect(() => auth.issue()).toThrow(/Unsafe web authentication state/);
      expect(readFileSync(f.file, 'utf8')).toBe(invalid);
    }
  });

  it('rejects directory replacement and unsafe directory modes during an active lease', () => {
    const f = fixture(), auth = new WebAuth(f.directory, f.clock), issued = auth.issue();
    chmodSync(f.directory, 0o755);
    expect(auth.authorize(issued.token)).toBeNull();
    expect(() => auth.renew(issued.id)).toThrow(/owner-only ordinary directory/);
    chmodSync(f.directory, 0o700);
    const saved = readFileSync(f.file, 'utf8');
    renameSync(f.directory, join(f.root, 'old-state'));
    mkdirSync(f.directory, { mode: 0o700 });
    writeFileSync(f.file, saved, { mode: 0o600 });
    expect(auth.authorize(issued.token)).toBeNull();
    expect(() => auth.issue()).toThrow(/state directory changed/);
  });
});
