// Browser credentials are created and renewed only by private handoffs from
// trusted local operations. Ordinary HTTP authorization never extends a lease.
// Raw credentials are
// returned once to the caller; only their SHA-256 hashes reach private state.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const WEB_AUTH_LEASE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_STATE_BYTES = 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface WebSession { id: string; expiresAt: number }
export interface WebCredential extends WebSession { token: string }
interface SavedSession extends WebSession { tokenHash: string }

function unsafe(reason: string): Error {
  return new Error(`Unsafe web authentication state: ${reason}`);
}

function privateMetadata(stat: Stats, directory: boolean): void {
  const uid = process.getuid?.();
  if (uid === undefined) throw unsafe('owner-only Unix permissions are unavailable.');
  if (!(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== uid
    || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) || !directory && stat.nlink !== 1) {
    throw unsafe(`expected an owner-only ordinary ${directory ? 'directory (0700)' : 'file (0600)'}.`);
  }
}

function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactFields(value: Record<string, unknown>, fields: string): boolean {
  return Object.keys(value).sort().join(',') === fields;
}

export class WebAuth {
  private readonly directory: string;
  private readonly path: string;
  private readonly directoryStat: Stats;

  constructor(stateDirectory: string, private readonly clock: () => number = Date.now) {
    this.directory = resolve(stateDirectory);
    this.path = join(this.directory, 'web-auth.json');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.directoryStat = lstatSync(this.directory);
    privateMetadata(this.directoryStat, true);
    this.read();
  }

  issue(): WebCredential {
    const sessions = this.read(), now = this.now();
    const credential = { id: randomUUID(), token: randomBytes(32).toString('base64url'), expiresAt: this.deadline(now) };
    const saved = { id: credential.id, tokenHash: createHash('sha256').update(credential.token).digest('hex'), expiresAt: credential.expiresAt };
    this.write([...sessions.filter(session => session.expiresAt > now), saved]);
    return credential;
  }

  authorize(token: string): WebSession | null {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    try {
      const candidate = createHash('sha256').update(token).digest(), now = this.now();
      const saved = this.read().find(session => timingSafeEqual(candidate, Buffer.from(session.tokenHash, 'hex')));
      return saved && saved.expiresAt > now ? { id: saved.id, expiresAt: saved.expiresAt } : null;
    } catch { return null; }
  }

  /** Observe an already authenticated stream/grant's lease without renewing. */
  session(id: string): WebSession | null {
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return null;
    try {
      const now = this.now(), saved = this.read().find(session => session.id === id);
      return saved && saved.expiresAt > now ? { id: saved.id, expiresAt: saved.expiresAt } : null;
    } catch { return null; }
  }

  /** An authenticated parent receives only this instance's file-signing key. */
  fileKey(id: string, instanceCanonicalPath: string): string | null {
    if (typeof id !== 'string' || !SESSION_ID.test(id) || typeof instanceCanonicalPath !== 'string' || !isAbsolute(instanceCanonicalPath)) return null;
    try {
      const now = this.now(), saved = this.read().find(session => session.id === id);
      if (!saved || saved.expiresAt <= now) return null;
      return createHmac('sha256', Buffer.from(saved.tokenHash, 'hex'))
        .update(JSON.stringify(['aside-file-grants', instanceCanonicalPath])).digest('base64url');
    } catch { return null; }
  }

  /** A redeemed private handoff may extend a live lease. Expired credentials require reissue. */
  renew(id: string): WebSession | null {
    const sessions = this.read(), now = this.now();
    const saved = sessions.find(session => session.id === id);
    if (!saved || saved.expiresAt <= now) return null;
    saved.expiresAt = this.deadline(now);
    this.write(sessions);
    return { id: saved.id, expiresAt: saved.expiresAt };
  }

  revoke(id?: string): void {
    const sessions = this.read();
    this.write(id === undefined ? [] : sessions.filter(session => session.id !== id));
  }

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw unsafe('invalid lease clock.');
    return now;
  }

  private deadline(now: number): number {
    const deadline = now + WEB_AUTH_LEASE_MS;
    if (!Number.isSafeInteger(deadline)) throw unsafe('lease exceeds the supported clock range.');
    return deadline;
  }

  private validateDirectory(): void {
    const stat = lstatSync(this.directory);
    privateMetadata(stat, true);
    if (!sameFile(stat, this.directoryStat)) throw unsafe('state directory changed.');
  }

  private fileMetadata(): Stats | null {
    try {
      const stat = lstatSync(this.path);
      privateMetadata(stat, false);
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private read(): SavedSession[] {
    this.validateDirectory();
    const expected = this.fileMetadata();
    if (!expected) return [];
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      privateMetadata(stat, false);
      if (!sameFile(stat, expected)) throw unsafe('state file changed while opening.');
      if (stat.size > MAX_STATE_BYTES) throw unsafe('state file exceeds its size limit.');
      this.validateDirectory();
      let value: unknown;
      try { value = JSON.parse(readFileSync(fd, 'utf8')); }
      catch { throw unsafe('invalid registry JSON.'); }
      if (!object(value) || !exactFields(value, 'sessions,version') || value.version !== 1 || !Array.isArray(value.sessions)) {
        throw unsafe('invalid registry shape.');
      }
      const ids = new Set<string>(), hashes = new Set<string>();
      return value.sessions.map((session: unknown) => {
        if (!object(session) || !exactFields(session, 'expiresAt,id,tokenHash')
          || typeof session.id !== 'string' || !SESSION_ID.test(session.id)
          || typeof session.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(session.tokenHash)
          || typeof session.expiresAt !== 'number' || !Number.isSafeInteger(session.expiresAt) || session.expiresAt < 0
          || ids.has(session.id) || hashes.has(session.tokenHash)) throw unsafe('invalid registry session.');
        ids.add(session.id); hashes.add(session.tokenHash);
        return { id: session.id, tokenHash: session.tokenHash, expiresAt: session.expiresAt };
      });
    } finally { closeSync(fd); }
  }

  private write(sessions: SavedSession[]): void {
    this.validateDirectory();
    this.fileMetadata();
    const body = JSON.stringify({ version: 1, sessions }) + '\n';
    if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw unsafe('registry exceeds its size limit.');
    const temp = join(this.directory, `.web-auth-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      privateMetadata(fstatSync(fd), false);
      writeFileSync(fd, body);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      this.validateDirectory();
      this.fileMetadata();
      renameSync(temp, this.path);
      const parent = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
