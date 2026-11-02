import { eventTimes, savedEvent } from './calendar-fixture.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CalClient, CalUnavailable, resolveCalBin } from '../src/mcp/calendar/client.js';
import { handleCalendarInfo } from '../src/mcp/calendar/info.js';
import { CalSync as BaseCalSync, storeAction, type SyncAction } from '../src/mcp/calendar/sync.js';
import { SyncLock } from '../src/mcp/calendar/lock.js';
import { Store } from '../src/mcp/store.js';
import { buildMarker } from '../src/mcp/calendar/markers.js';
import * as parser from '../src/core/parser.js';

interface FakeOpts {
  silent?: boolean; // read requests but never reply (drives the timeout path)
  exitOnRequest?: boolean; // exit without replying (drives the in-flight-death path)
  recordTo?: string; // append each received request (JSON per line) for assertions
  listDelayMs?: number; // delay list-events replies (to hold the sweep in flight)
  upsertDelayMs?: number; // delay upsert-event replies (to hold a forward op in flight)
  healFile?: string; // upsert fails transiently until this path exists (then R applies)
  signalAfter?: boolean; // emit an async {signal:changed} line after each reply
}

// A stand-in for aside-cal: a node script that answers each request line with a
// canned response keyed by command. `.cjs` + no local package.json makes node
// treat it as CommonJS regardless of the repo's "type": "module".
function writeFake(responses: Record<string, unknown>, opts: FakeOpts = {}): string {
  const timing = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(timing);
    if (!value || typeof value !== 'object') return value;
    const obj = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, timing(child)]));
    return typeof obj.url === 'string' && typeof obj.start === 'string' && typeof obj.end === 'string' ? eventTimes(obj as any) : obj;
  };
  responses = timing(responses) as Record<string, unknown>;
  const script = `#!/usr/bin/env node
const R = ${JSON.stringify(responses)};
const OPTS = ${JSON.stringify(opts)};
let confirmation;
const wall = date => [String(date.getFullYear()).padStart(4,'0'), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-') + 'T' + [date.getHours(),date.getMinutes()].map(n=>String(n).padStart(2,'0')).join(':');
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (OPTS.recordTo) require('fs').appendFileSync(OPTS.recordTo, JSON.stringify(msg) + '\\n');
  if (OPTS.exitOnRequest) process.exit(1); // die mid-request, no reply
  if (OPTS.silent) return;
  if (OPTS.healFile && msg.cmd === 'upsert-event' && !require('fs').existsSync(OPTS.healFile)) {
    process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: 'transient down' }) + '\\n');
    return;
  }
  // The first ID read after a successful floating save confirms the event that
  // was just written. Later reads remain the scripted Calendar-side gestures.
  let r;
  if (msg.cmd === 'get-events' && confirmation && msg.eventIds.includes(confirmation.id)) {
    r = { ok: true, result: { events: [confirmation] } }; confirmation = undefined;
  } else r = R[msg.cmd] || { ok: false, error: 'unknown command: ' + msg.cmd };
  if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0]; // sequential replies; last repeats
  if (msg.cmd === 'upsert-event' && r.ok && !msg.allDay && !msg.timezone) {
    const start = new Date(msg.start), end = new Date(start.getTime() + msg.durationMinutes*60000);
    confirmation = { id:r.result.eventId, calendar:msg.calendar, calendar_account:msg.calendar_account, title:msg.title, url:msg.marker, timezone:null,
      start:wall(start), end:wall(end), startInstant:start.getTime(), endInstant:end.getTime(), durationMinutes:msg.durationMinutes };
  }
  const out = JSON.stringify(Object.assign({ id: msg.id }, r)) + '\\n';
  if (OPTS.listDelayMs && msg.cmd === 'list-events') setTimeout(() => process.stdout.write(out), OPTS.listDelayMs);
  else if (OPTS.upsertDelayMs && msg.cmd === 'upsert-event') setTimeout(() => process.stdout.write(out), OPTS.upsertDelayMs);
  else process.stdout.write(out);
  if (OPTS.signalAfter) process.stdout.write(JSON.stringify({ signal: 'changed' }) + '\\n');
});
`;
  const p = join(tmpdir(), `fake-cal-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

const clients: CalClient[] = [];
const scripts: string[] = [];
const syncs: BaseCalSync[] = [];
// Track even inline-created syncers so their retry timers cannot outlive the
// helper scripts and instance directories owned by this test fixture.
class CalSync extends BaseCalSync {
  constructor(...args: ConstructorParameters<typeof BaseCalSync>) {
    super(...args);
    syncs.push(this);
  }
}

function client(responses: Record<string, unknown>, opts: FakeOpts = {}): CalClient {
  const p = writeFake({ 'list-calendars': { ok: true, result: { calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'local' }, { id: 'personal', name: 'Personal', account: 'iCloud', writable: true, type: 'local' }] } }, ...responses }, opts);
  scripts.push(p);
  const c = new CalClient(p);
  clients.push(c);
  return c;
}

// A temp path the fake records requests to; cleaned up with the rest.
function recordPath(): string {
  const p = join(tmpdir(), `cal-rec-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  scripts.push(p);
  return p;
}

function readRequests(p: string): Array<Record<string, any>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Temp instance dirs for reverse-reconcile tests (need real action files).
const tmpDirs: string[] = [];
function makeInstance(frontMatter: string, id = '2026-05-15-deploy'): { dir: string; id: string } {
  const dir = join(tmpdir(), `aside-rev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'actions', '2026'), { recursive: true });
  writeFileSync(join(dir, 'actions', '2026', `${id}.md`), `---\n${frontMatter}\n---\nbody\n`);
  tmpDirs.push(dir);
  return { dir, id };
}
function readActionFile(dir: string, id: string): string {
  return readFileSync(join(dir, 'actions', '2026', `${id}.md`), 'utf8');
}

// An in-session reconcile (a `changed` signal after the cache is warm): a first
// cold pass builds the cache from the sweep, a second warm pass sees the calendar
// edit via get-events. A single reconcile() is the cold/startup path.
async function reconcileInSession(sync: CalSync, scheduled: SyncAction[]): Promise<void> {
  await sync.reconcile(scheduled);
  await sync.reconcile(scheduled);
}

function cleanupFixtures(): void {
  for (const sync of syncs.splice(0)) {
    const retries = sync as unknown as {
      outboxRetry: ReturnType<typeof setTimeout> | null;
      lockRetry: ReturnType<typeof setTimeout> | null;
      outbox: Map<string, unknown>;
      pendingReconcile: SyncAction[] | null;
    };
    for (const key of ['outboxRetry', 'lockRetry'] as const) {
      if (retries[key] !== null) clearTimeout(retries[key]);
      retries[key] = null;
    }
    retries.outbox.clear();
    retries.pendingReconcile = null;
  }
  for (const c of clients.splice(0)) c.close();
  for (const p of scripts.splice(0)) rmSync(p, { force: true });
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

afterEach(cleanupFixtures);

describe('calendar test fixtures', () => {
  it('cancels pending forward and reverse retries before deleting their helper scripts', async () => {
    vi.useFakeTimers();
    const lock = vi.spyOn(SyncLock.prototype, 'tryAcquire').mockReturnValue(false);
    try {
      const c = client({});
      const auth = vi.spyOn(c, 'authStatus').mockResolvedValue({ status: 'denied' });
      const a: SyncAction = { id: '2026-05-15-deploy', frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work' }, body: 'body' };
      await new CalSync(c, 'work').syncActions([a], [a]); // authorization queues a 30s retry
      const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
      const reverseClient = client({});
      const reverseAuth = vi.spyOn(reverseClient, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
      await new CalSync(reverseClient, 'work', new Store(dir)).reconcile([a]); // held lock queues a 2s retry
      const helpers = [...scripts];
      expect(vi.getTimerCount()).toBe(2);
      cleanupFixtures();
      expect(helpers.every(path => !existsSync(path))).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(auth).toHaveBeenCalledOnce();
      expect(reverseAuth).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      lock.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('CalClient', () => {
  it('round-trips a request and response by id', async () => {
    const c = client({ 'auth-status': { ok: true, result: { status: 'fullAccess' } } });
    expect(c.available()).toBe(true);
    expect(await c.authStatus()).toEqual({ status: 'fullAccess' });
  });

  it('handles concurrent requests, matching each to its response', async () => {
    const c = client({
      'auth-status': { ok: true, result: { status: 'fullAccess' } },
      'list-calendars': { ok: true, result: { calendars: [{ id: 'c1', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] } },
    });
    const [auth, cals] = await Promise.all([c.authStatus(), c.listCalendars()]);
    expect(auth.status).toBe('fullAccess');
    expect(cals.calendars[0].name).toBe('Work');
  });

  it('rejects when the helper reports an error', async () => {
    const c = client({ 'auth-status': { ok: false, error: 'boom' } });
    await expect(c.authStatus()).rejects.toThrow('boom');
  });

  it('reuses one helper process across requests', async () => {
    const c = client({ 'auth-status': { ok: true, result: { status: 'fullAccess' } } });
    await c.authStatus();
    await c.authStatus();
    expect((await c.authStatus()).status).toBe('fullAccess');
  });

  it('reports unavailable and refuses requests when no binary is present', async () => {
    const c = new CalClient(null);
    expect(c.available()).toBe(false);
    await expect(c.authStatus()).rejects.toBeInstanceOf(CalUnavailable);
  });

  it('respawns a fresh helper once the previous one is gone', async () => {
    const c = client({ 'auth-status': { ok: true, result: { status: 'fullAccess' } } });
    expect((await c.authStatus()).status).toBe('fullAccess'); // spawns the helper
    c.close(); // kill it
    expect((await c.authStatus()).status).toBe('fullAccess'); // must respawn and work
  });

  it('rejects an in-flight request when the helper dies without replying', async () => {
    const c = client({}, { exitOnRequest: true });
    await expect(c.authStatus()).rejects.toThrow(/exited/);
  });

  it('dispatches the async changed signal to onChanged listeners', async () => {
    const c = client({ 'auth-status': { ok: true, result: { status: 'fullAccess' } } }, { signalAfter: true });
    let fired = 0;
    const off = c.onChanged(() => { fired++; });
    await c.authStatus(); // reply + a trailing {signal:changed}
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBeGreaterThan(0);
    off();
  });

  it('rejects a request that gets no response, after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const rec = recordPath();
      const c = client({}, { silent: true, recordTo: rec });
      const result = c.authStatus().catch(error => error);
      // Let the child load its script before a synthetic timeout lets teardown
      // delete it; spawning and loading the entrypoint happen asynchronously.
      await vi.waitFor(() => expect(readRequests(rec)).toHaveLength(1), { timeout: 5000 });
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await result;
      expect(error).toBeInstanceOf(CalUnavailable);
      expect(error.message).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});

describe('resolveCalBin', () => {
  it('honors ASIDE_CAL_BIN when the path exists', () => {
    const p = writeFake({});
    scripts.push(p);
    const prev = process.env.ASIDE_CAL_BIN;
    process.env.ASIDE_CAL_BIN = p;
    try {
      // Only meaningful on darwin; elsewhere calendar sync is unavailable.
      if (process.platform === 'darwin') expect(resolveCalBin()).toBe(p);
      else expect(resolveCalBin()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.ASIDE_CAL_BIN;
      else process.env.ASIDE_CAL_BIN = prev;
    }
  });
});

describe('calendar_info', () => {
  it('reports auth and calendars when full access is held', async () => {
    const c = client({
      'auth-status': { ok: true, result: { status: 'fullAccess' } },
      'list-calendars': { ok: true, result: { calendars: [
        { id: 'c1', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV', color: '#FF0000' },
        { id: 'c2', name: 'Birthdays', account: 'Other', writable: false, type: 'birthday' },
      ] } },
    });
    const out = await handleCalendarInfo(c);
    expect(out).toContain('auth: fullAccess');
    expect(out).toContain('Work (iCloud, writable)');
    expect(out).toContain('Birthdays (Other, read-only)');
  });

  it('auto-requests access when undecided and reports the granted state', async () => {
    const c = client({
      'auth-status': { ok: true, result: { status: 'notDetermined' } },
      'request-access': { ok: true, result: { granted: true, status: 'fullAccess' } },
      'list-calendars': { ok: true, result: { calendars: [{ id: 'c1', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] } },
    });
    const out = await handleCalendarInfo(c);
    expect(out).toContain('auth: fullAccess');
    expect(out).toContain('Work (iCloud, writable)');
  });

  it('explains an undecided authorization response without guessing why', async () => {
    const c = client({
      'auth-status': { ok: true, result: { status: 'notDetermined' } },
      'request-access': { ok: true, result: { granted: false, status: 'notDetermined' } },
    });
    const out = await handleCalendarInfo(c);
    expect(out).toContain('auth: notDetermined');
    expect(out).toContain('undecided');
    expect(out).not.toContain('no interactive session');
    expect(out).toContain('cause is unknown');
  });

  it('directs denied access to System Settings after auto-requesting', async () => {
    const c = client({
      'auth-status': { ok: true, result: { status: 'notDetermined' } },
      'request-access': { ok: true, result: { granted: false, status: 'denied' } },
    });
    const out = await handleCalendarInfo(c);
    expect(out).toContain('auth: denied');
    expect(out).toContain('System Settings');
  });

  it('distinguishes a list failure from genuinely-empty calendars', async () => {
    const c = client({
      'auth-status': { ok: true, result: { status: 'fullAccess' } },
      'list-calendars': { ok: false, error: 'kaboom' },
    });
    const out = await handleCalendarInfo(c);
    expect(out).toContain('calendars: (unavailable)');
    expect(out).not.toContain('(none)');
  });

  it('hints toward System Settings when access is denied', async () => {
    const c = client({ 'auth-status': { ok: true, result: { status: 'denied' } } });
    const out = await handleCalendarInfo(c);
    expect(out).toContain('auth: denied');
    expect(out).toContain('System Settings');
  });

  it('reports unavailable when the helper is missing', async () => {
    const out = await handleCalendarInfo(new CalClient(null));
    expect(out).toContain('auth: unavailable');
    expect(out).toContain('build.sh');
  });
});

describe('CalSync forward sync', () => {
  const INSTANCE = 'work';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const NO_EVENTS = { 'list-events': { ok: true, result: { events: [] } } };

  function action(over: Partial<SyncAction['frontMatter']> = {}): SyncAction {
    return {
      id: '2026-05-15-deploy',
      frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work', ...over },
      body: 'Body text',
    };
  }

  it('creates an event for a new scheduled action and caches its id', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { recordTo: rec });
    const a = action();
    const [res] = await new CalSync(c, INSTANCE).syncActions([a], [a]);
    expect(res.status).toBe('synced');
    expect(res.eventId).toBe('ev-1');
    const upsert = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(upsert.marker).toBe('aside://work/action/2026-05-15-deploy');
    expect(upsert.title).toBe('▢ Deploy');
    expect(upsert.start).toBe('2026-05-15T10:00');
    expect(upsert.end).toBe('2026-05-15T10:30'); // default 30m
    expect(upsert.eventId).toBeUndefined(); // create path
    expect(upsert.notes).toBe('Body text'); // full body, no deadline/description
    expect(upsert.notes).not.toContain('aside://'); // marker stays in url, not notes
  });

  it('notes carry the deadline, description, then body in order', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { recordTo: rec });
    const a: SyncAction = { ...action({ deadline: '2026-05-20T17:00' }), description: 'Ship the migration' };
    await new CalSync(c, INSTANCE).syncActions([a], [a]);
    const upsert = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(upsert.notes).toBe('Deadline: 2026-05-20T17:00\n\nDescription: Ship the migration\n\nBody text');
  });

  it('truncates an overlong body with an ellipsis', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { recordTo: rec });
    const a: SyncAction = { ...action(), body: 'x'.repeat(5000) };
    await new CalSync(c, INSTANCE).syncActions([a], [a]);
    const upsert = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect([...(upsert.notes as string)].length).toBe(4000);
    expect((upsert.notes as string).endsWith('…')).toBe(true);
  });

  // End-to-end: the description is sourced from the year index (not the action
  // file) and it reaches the event notes, distinct from the title/name.
  it('carries the index description (not the name) from disk into notes', async () => {
    const { dir, id } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    writeFileSync(join(dir, 'actions', '2026', 'index.yaml'), `- id: ${id}\n  description: Ship the migration\n`);

    const a = storeAction(new Store(dir), id)!;
    expect(a.description).toBe('Ship the migration');

    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { recordTo: rec });
    await new CalSync(c, INSTANCE).syncActions([a], [a]);
    const upsert = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(upsert.title).toBe('▢ Deploy'); // title is the name with the scheduled prefix
    expect(upsert.notes).toContain('Description: Ship the migration'); // notes carry the fuller description
  });

  it('storeAction returns a copy, so mutating it cannot corrupt the store', () => {
    const { dir, id } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const store = new Store(dir);
    const a = storeAction(store, id)!;
    a.frontMatter.scheduled = '2099-01-01'; // reverse sync mutates a working copy of fm
    delete a.frontMatter.calendar;
    expect(store.getAction(id)!.frontMatter.scheduled).toBe('2026-05-15T10:00'); // store untouched
    expect(store.getAction(id)!.frontMatter.calendar).toBe('Work');
  });

  it('uses the cached event id on the next sync (update, no duplicate)', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { recordTo: rec });
    const a = action();
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([a], [a]);
    await sync.syncActions([a], [a]);
    const upserts = readRequests(rec).filter((r) => r.cmd === 'upsert-event');
    expect(upserts).toHaveLength(2);
    expect(upserts[0].eventId).toBeUndefined();
    expect(upserts[1].eventId).toBe('ev-1'); // fast path from cache
  });

  it('adopts an existing marked event found by the sweep', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [
        { id: 'ev-existing', url: 'aside://work/action/2026-05-15-deploy', calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' },
      ] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-existing' } },
    }, { recordTo: rec });
    const a = action();
    await new CalSync(c, INSTANCE).syncActions([a], [a]);
    const upsert = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(upsert.eventId).toBe('ev-existing'); // matched by marker, not duplicated
  });

  it('ignores a sweep event whose marker is for another instance', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [
        { id: 'ev-other', url: 'aside://personal/action/2026-05-15-deploy', calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' },
      ] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-new' } },
    }, { recordTo: rec });
    const a = action();
    await new CalSync(c, INSTANCE).syncActions([a], [a]);
    const upsert = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(upsert.eventId).toBeUndefined(); // wrong instance => not adopted => create
  });

  it('marks a done action with a ✓ title and /done marker', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-2' } } }, { recordTo: rec });
    const a = action({ resolution: 'done' });
    await new CalSync(c, INSTANCE).syncActions([a], [a]);
    const upsert = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(upsert.title).toBe('✓ Deploy');
    expect(upsert.marker).toBe('aside://work/action/2026-05-15-deploy/done');
  });

  it('applies the manifest config active and done title prefixes', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { recordTo: rec });
    const cfg = { scheduledEventTitlePrefix: '▢ ', doneEventTitlePrefix: '✅ ' };
    await new CalSync(c, INSTANCE, undefined, cfg).syncActions([action()], [action()]);
    await new CalSync(c, INSTANCE, undefined, cfg).syncActions([action({ resolution: 'done' })], [action({ resolution: 'done' })]);
    const ups = readRequests(rec).filter((r) => r.cmd === 'upsert-event');
    expect(ups[0].title).toBe('▢ Deploy');
    expect(ups[1].title).toBe('✅ Deploy');
  });

  it('an explicit empty done prefix drops the ✓', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { recordTo: rec });
    const a = action({ resolution: 'done' });
    await new CalSync(c, INSTANCE, undefined, { doneEventTitlePrefix: '' }).syncActions([a], [a]);
    const up = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(up.title).toBe('Deploy'); // the default ✓ is overridden by the empty string
    expect(up.marker).toBe('aside://work/action/2026-05-15-deploy/done');
  });

  it('makes an all-day event for a date-only scheduled', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-3' } } }, { recordTo: rec });
    const a = action({ scheduled: '2026-05-15' });
    await new CalSync(c, INSTANCE).syncActions([a], [a]);
    const upsert = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(upsert.allDay).toBe(true);
    expect(upsert.start).toBe('2026-05-15T00:00');
  });

  it('skips an action with no calendar', async () => {
    const c = client({ ...FULL, ...NO_EVENTS });
    const a = action({ calendar: undefined });
    const [res] = await new CalSync(c, INSTANCE).syncActions([a], [a]);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no calendar');
  });

  it('skips everything when access is not fullAccess', async () => {
    const c = client({ 'auth-status': { ok: true, result: { status: 'denied' } } });
    const a = action();
    const [res] = await new CalSync(c, INSTANCE).syncActions([a], [a]);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no calendar access');
  });

  it('skips when the instance has no id, and surfaces it via report()', async () => {
    const c = client({ ...FULL, ...NO_EVENTS });
    const a = action();
    const sync = new CalSync(c, '');
    const [res] = await sync.syncActions([a], [a]);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('instance has no id');
    expect(sync.report()).toEqual([{ id: 'instance', reason: 'aside.md has no `id` — calendar sync is disabled' }]);
  });

  it('reports an error (not a throw) when the helper rejects the upsert', async () => {
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: false, error: 'calendar not found: Work' } });
    const a = action();
    const [res] = await new CalSync(c, INSTANCE).syncActions([a], [a]);
    expect(res.status).toBe('error');
    expect(res.reason).toContain('calendar not found');
  });
});

describe('CalSync robustness', () => {
  const INSTANCE = 'work';
  function action(): SyncAction {
    return {
      id: '2026-05-15-deploy',
      frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work' },
      body: 'x',
    };
  }
  const EXISTING = {
    id: 'ev-existing', url: 'aside://work/action/2026-05-15-deploy',
    calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30',
  };

  it('does not duplicate when two syncs race the same in-flight sweep', async () => {
    const rec = recordPath();
    const c = client({
      'auth-status': { ok: true, result: { status: 'fullAccess' } },
      'list-events': { ok: true, result: { events: [EXISTING] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-existing' } },
    }, { recordTo: rec, listDelayMs: 60 }); // hold the sweep in flight
    const sync = new CalSync(c, INSTANCE);
    const a = action();
    await Promise.all([sync.syncActions([a], [a]), sync.syncActions([a], [a])]);
    const upserts = readRequests(rec).filter((r) => r.cmd === 'upsert-event');
    // Both adopt the swept event; neither creates a duplicate (no missing eventId).
    expect(upserts.length).toBeGreaterThan(0);
    expect(upserts.every((u) => u.eventId === 'ev-existing')).toBe(true);
  });

  it('matches a non-ASCII action by marker in the sweep (no duplicate)', async () => {
    const INST = 'work';
    const id = '2026-05-15-部署';
    const marker = buildMarker(INST, id, 'active'); // canonical ASCII — what the helper stores
    const rec = recordPath();
    const c = client({
      'auth-status': { ok: true, result: { status: 'fullAccess' } },
      'list-events': { ok: true, result: { events: [
        { id: 'ev-cjk', url: marker, calendar: 'Work', title: '部署', start: '2026-05-15T10:00', end: '2026-05-15T10:30' },
      ] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-cjk' } },
    }, { recordTo: rec });
    const a: SyncAction = {
      id,
      frontMatter: { name: '部署', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work' },
      body: 'x',
    };
    await new CalSync(c, INST).syncActions([a], [a]);
    const upsert = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(upsert.eventId).toBe('ev-cjk'); // adopted via decoded-marker match
    expect(upsert.marker).toBe(marker); // re-sends the canonical ASCII marker
  });

  it('skips (and retries) without creating when the cache sweep fails', async () => {
    const rec = recordPath();
    const c = client({
      'auth-status': { ok: true, result: { status: 'fullAccess' } },
      'list-events': { ok: false, error: 'boom' },
      'upsert-event': { ok: true, result: { eventId: 'ev-x' } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE);
    const a = action();
    const [r1] = await sync.syncActions([a], [a]);
    expect(r1.status).toBe('skipped');
    expect(r1.reason).toContain('cache unavailable');
    const [r2] = await sync.syncActions([a], [a]); // not permanently poisoned
    expect(r2.status).toBe('skipped');
    const reqs = readRequests(rec);
    expect(reqs.filter((r) => r.cmd === 'list-events').length).toBeGreaterThanOrEqual(2); // retried
    expect(reqs.some((r) => r.cmd === 'upsert-event')).toBe(false); // never created on failure
  });
});

describe('CalSync transitions', () => {
  const INSTANCE = 'work';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const ID = '2026-05-15-deploy';

  function action(over: Partial<SyncAction['frontMatter']> = {}): SyncAction {
    return {
      id: ID,
      frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work', ...over },
      body: 'x',
    };
  }
  const EXISTING = {
    id: 'ev-x', url: buildMarker(INSTANCE, ID, 'active'),
    calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30',
  };

  it('deletes the event when an action is cancelled (cached via the sweep)', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [EXISTING] } }, // swept -> cached
      'delete-event': { ok: true, result: { deleted: true } },
    }, { recordTo: rec });
    const a = action({ resolution: 'cancelled' }); // still scheduled, but cancelled
    const [res] = await new CalSync(c, INSTANCE).syncActions([a], [a]);
    expect(res.status).toBe('deleted');
    const del = readRequests(rec).find((r) => r.cmd === 'delete-event')!;
    expect(del.eventId).toBe('ev-x');
    expect(del.marker).toBe(buildMarker(INSTANCE, ID, 'active')); // suffix-agnostic identity
  });

  it('deletes the event when an action is descheduled (in-session cache)', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
      'delete-event': { ok: true, result: { deleted: true } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE);
    const active = action();
    await sync.syncActions([active], [active]); // create -> caches ev-1
    const backlog = action({ scheduled: undefined }); // descheduled
    const [res] = await sync.syncActions([backlog], [backlog]);
    expect(res.status).toBe('deleted');
    expect(readRequests(rec).find((r) => r.cmd === 'delete-event')!.eventId).toBe('ev-1');
  });

  it('keeps the event but flips to ✓/done when an action is completed', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [EXISTING] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-x' } },
    }, { recordTo: rec });
    const a = action({ resolution: 'done' });
    const [res] = await new CalSync(c, INSTANCE).syncActions([a], [a]);
    expect(res.status).toBe('synced');
    const up = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(up.eventId).toBe('ev-x'); // updates the existing event in place
    expect(up.title).toBe('✓ Deploy');
    expect(up.marker).toBe(buildMarker(INSTANCE, ID, 'done'));
    expect(readRequests(rec).some((r) => r.cmd === 'delete-event')).toBe(false);
  });

  it('skips deletion when there is no tracked event', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } }, // nothing cached
      'delete-event': { ok: true, result: { deleted: true } },
    }, { recordTo: rec });
    const a = action({ resolution: 'cancelled' });
    const [res] = await new CalSync(c, INSTANCE).syncActions([a], [a]);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no event to remove');
    expect(readRequests(rec).some((r) => r.cmd === 'delete-event')).toBe(false);
  });
});

describe('CalSync transitions — reschedule / reactivate / unsync', () => {
  const INSTANCE = 'work';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const ID = '2026-05-15-deploy';
  const base = { name: 'Deploy', created: '2026-05-15T09:00', calendar: 'Work' };
  function act(over: Partial<SyncAction['frontMatter']>): SyncAction {
    return { id: ID, frontMatter: { ...base, scheduled: '2026-05-15T10:00', ...over }, body: 'x' };
  }
  const EXISTING = {
    id: 'ev-x', url: buildMarker(INSTANCE, ID, 'active'),
    calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30',
  };

  it('reschedule moves the same event (cached id, new time)', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([act({})], [act({})]); // create at 10:00 -> ev-1
    await sync.syncActions([act({ scheduled: '2026-05-15T14:00' })], [act({ scheduled: '2026-05-15T14:00' })]);
    const ups = readRequests(rec).filter((r) => r.cmd === 'upsert-event');
    expect(ups[1].eventId).toBe('ev-1'); // same event
    expect(ups[1].start).toBe('2026-05-15T14:00'); // moved
    expect(ups[1].end).toBe('2026-05-15T14:30');
  });

  it('reactivate (done → active) updates the same event back to bare marker / no ✓', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [EXISTING] } }, // swept -> ev-x
      'upsert-event': { ok: true, result: { eventId: 'ev-x' } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([act({ resolution: 'done' })], [act({ resolution: 'done' })]);
    const [res] = await sync.syncActions([act({})], [act({})]); // resolution cleared
    expect(res.status).toBe('synced');
    const last = readRequests(rec).filter((r) => r.cmd === 'upsert-event').at(-1)!;
    expect(last.eventId).toBe('ev-x');
    expect(last.title).toBe('▢ Deploy'); // ✓ → ▢ (back to the scheduled prefix)
    expect(last.marker).toBe(buildMarker(INSTANCE, ID, 'active'));
  });

  it('reactivate (cancelled → active) creates a fresh event after the cache was cleared', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [EXISTING] } }, // swept -> ev-x
      'delete-event': { ok: true, result: { deleted: true } },
      'upsert-event': { ok: true, result: { eventId: 'ev-new' } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE);
    const [cancelled] = await sync.syncActions([act({ resolution: 'cancelled' })], [act({ resolution: 'cancelled' })]);
    expect(cancelled.status).toBe('deleted'); // cache cleared
    const [reactivated] = await sync.syncActions([act({})], [act({})]);
    expect(reactivated.status).toBe('synced');
    const up = readRequests(rec).filter((r) => r.cmd === 'upsert-event').at(-1)!;
    expect(up.eventId).toBeUndefined(); // no cached id => create new
  });

  it('removing the calendar (stop syncing) deletes the cached event', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
      'delete-event': { ok: true, result: { deleted: true } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([act({})], [act({})]); // synced -> ev-1 cached
    const noCal: SyncAction = { id: ID, frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00' }, body: 'x' };
    const [res] = await sync.syncActions([noCal], [noCal]);
    expect(res.status).toBe('deleted');
    expect(readRequests(rec).find((r) => r.cmd === 'delete-event')!.eventId).toBe('ev-1');
  });

  it('reports an error (cache retained) when the delete fails', async () => {
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [EXISTING] } },
      'delete-event': { ok: false, error: 'remove failed' },
    }, { recordTo: recordPath() });
    const [res] = await new CalSync(c, INSTANCE).syncActions(
      [act({ resolution: 'cancelled' })],
      [act({ resolution: 'cancelled' })],
    );
    expect(res.status).toBe('error');
    expect(res.reason).toContain('remove failed');
  });
});

describe('CalSync issues + outbox', () => {
  const INSTANCE = 'work';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const NO_EVENTS = { 'list-events': { ok: true, result: { events: [] } } };
  function action(over: Partial<SyncAction['frontMatter']> = {}, id = '2026-05-15-deploy'): SyncAction {
    return { id, frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work', ...over }, body: 'x' };
  }

  it('records a scheduled action with no calendar as an issue', async () => {
    const c = client({ ...FULL, ...NO_EVENTS });
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([action({ calendar: undefined })], [action({ calendar: undefined })]);
    expect(sync.report()).toEqual([{ id: '2026-05-15-deploy', reason: 'no calendar' }]);
  });

  it('records a missing calendar (by error code) as an issue, not the outbox', async () => {
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: false, error: 'calendar not found: Ops', code: 'calendar-not-found' } });
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([action({ calendar: 'Ops' })], [action({ calendar: 'Ops' })]);
    expect(sync.report()).toEqual([{ id: '2026-05-15-deploy', reason: 'calendar not found: Ops' }]);
  });

  it('records a read-only calendar (by error code) as an issue', async () => {
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: false, error: 'calendar read-only: Work', code: 'calendar-read-only' } });
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([action()], [action()]);
    expect(sync.report()).toEqual([{ id: '2026-05-15-deploy', reason: 'calendar read-only: Work' }]);
  });

  it('classifies by the structured code, not the message: an uncoded error is transient', async () => {
    // The same English message without a code must land in the outbox (retry),
    // proving classification never parses the message.
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: false, error: 'calendar not found: Ops' } });
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([action()], [action()]);
    expect(sync.report()).toEqual([{ id: '2026-05-15-deploy', reason: 'sync failed, will retry: calendar not found: Ops' }]);
  });

  it('clears an issue once the action syncs cleanly', async () => {
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } });
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([action({ calendar: undefined })], [action({ calendar: undefined })]); // issue
    expect(sync.report()).toHaveLength(1);
    await sync.syncActions([action()], [action()]); // now has a calendar -> synced
    expect(sync.report()).toHaveLength(0);
  });

  it('queues a transient failure to the outbox and retries it on the next op', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: false, error: 'boom' } }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE);
    const A = action();
    const B = action({}, '2026-05-16-other');
    await sync.syncActions([A], [A]); // A fails transiently -> outbox
    expect(sync.report()).toEqual([{ id: '2026-05-15-deploy', reason: 'sync failed, will retry: boom' }]);
    await sync.syncActions([B], [B]); // B processed; A (not in batch) retried
    const aUpserts = readRequests(rec).filter((r) => r.cmd === 'upsert-event' && String(r.marker).includes('2026-05-15-deploy'));
    expect(aUpserts.length).toBe(2); // initial + retry
  });
});

describe('calendar_info issues', () => {
  it('lists the active instance unsynced actions', async () => {
    const c = client({
      'auth-status': { ok: true, result: { status: 'fullAccess' } },
      'list-calendars': { ok: true, result: { calendars: [{ id: 'c1', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] } },
      'list-events': { ok: true, result: { events: [] } },
      'upsert-event': { ok: false, error: 'calendar not found: Ops', code: 'calendar-not-found' },
    });
    const sync = new CalSync(c, 'work');
    const a: SyncAction = { id: '2026-05-15-deploy', frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Ops' }, body: 'x' };
    await sync.syncActions([a], [a]);
    const out = await handleCalendarInfo(c, sync);
    expect(out).toContain('auth: fullAccess');
    expect(out).toContain('issues:');
    expect(out).toContain('2026-05-15-deploy — calendar not found: Ops');
  });

  it('surfaces sync failures even when access is not fullAccess', async () => {
    // A failure like a missing instance id is real regardless of auth — it must
    // not be hidden behind the auth gate.
    const c = client({ 'auth-status': { ok: true, result: { status: 'denied' } } });
    const out = await handleCalendarInfo(c, new CalSync(c, '')); // no instance id
    expect(out).toContain('auth: denied');
    expect(out).toContain('issues:');
    expect(out).toContain('instance — aside.md has no `id`');
  });
});

describe('CalSync outbox — defer & drain', () => {
  const INSTANCE = 'work';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const NO_EVENTS = { 'list-events': { ok: true, result: { events: [] } } };
  function action(): SyncAction {
    return { id: '2026-05-15-deploy', frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work' }, body: 'x' };
  }

  it('queues an action captured before access is granted and surfaces it', async () => {
    const c = client({ 'auth-status': { ok: true, result: { status: 'notDetermined' } } });
    const sync = new CalSync(c, INSTANCE);
    const [res] = await sync.syncActions([action()], [action()]);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no calendar access');
    expect(sync.report()).toEqual([{ id: '2026-05-15-deploy', reason: 'no calendar access' }]);
  });

  it('drains the outbox when a retried op finally succeeds', async () => {
    const heal = recordPath(); // path that does not exist yet
    const c = client({ ...FULL, ...NO_EVENTS, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { healFile: heal });
    const sync = new CalSync(c, INSTANCE);
    await sync.syncActions([action()], [action()]); // upsert fails transiently -> outbox
    expect(sync.report()).toEqual([{ id: '2026-05-15-deploy', reason: 'sync failed, will retry: transient down' }]);
    writeFileSync(heal, 'ok'); // transient condition clears
    await sync.syncActions([], []); // retry-only pass -> succeeds -> drains
    expect(sync.report()).toEqual([]);
  });
});

describe('CalSync reverse reconcile', () => {
  const INSTANCE = 'work';
  const ID = '2026-05-15-deploy';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const MARKER = buildMarker(INSTANCE, ID, 'active');
  const SWEPT_EVENT = { id: 'ev-1', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' };
  // list-events seeds the cache (matched by marker); start/end here are irrelevant.
  const SWEPT = { 'list-events': { ok: true, result: { events: [SWEPT_EVENT] } } };
  // Sweep seeds the cache, then the reverse re-match (a second list-events) finds
  // nothing → a genuine deletion rather than a reassigned id.
  const SWEPT_THEN_GONE = { 'list-events': [
    { ok: true, result: { events: [SWEPT_EVENT] } },
    { ok: true, result: { events: [] } },
  ] };
  const scheduled: SyncAction = { id: ID, frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work' }, body: 'body' };
  const FM = 'name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work';
  // get-events returns the event's *current* state (what the user did to it).
  const got = (over: Record<string, unknown>) => ({ 'get-events': { ok: true, result: { events: [
    { id: 'ev-1', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30', allDay: false, ...over },
  ] } } });

  it('applies a move to the action scheduled time', async () => {
    const { dir } = makeInstance(FM);
    const c = client({ ...FULL, ...SWEPT, ...got({ start: '2026-05-15T14:00', end: '2026-05-15T14:30' }) });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    expect(readActionFile(dir, ID)).toContain('scheduled: "2026-05-15T14:00"');
    expect(sync.changesSinceStart()).toEqual([{ id: ID, summary: 'rescheduled 2026-05-15T10:00 -> 2026-05-15T14:00' }]);
  });

  it('applies a startup edit straight from the sweep (cold pass, no second fetch)', async () => {
    const { dir } = makeInstance(FM);
    const rec = recordPath();
    // The sweep returns the already-moved event; one cold reconcile applies it
    // without a separate get-events round-trip.
    const c = client({ ...FULL, 'list-events': { ok: true, result: { events: [
      { id: 'ev-1', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T14:00', end: '2026-05-15T14:30' },
    ] } } }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await sync.reconcile([scheduled]); // single cold pass
    expect(readActionFile(dir, ID)).toContain('scheduled: "2026-05-15T14:00"');
    expect(sync.changesSinceStart()).toEqual([{ id: ID, summary: 'rescheduled 2026-05-15T10:00 -> 2026-05-15T14:00' }]);
    expect(readRequests(rec).some((r) => r.cmd === 'get-events')).toBe(false); // diffed from the sweep
  });

  it('applies a resize to the action duration', async () => {
    const { dir } = makeInstance(FM);
    const c = client({ ...FULL, ...SWEPT, ...got({ start: '2026-05-15T10:00', end: '2026-05-15T11:00' }) });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    expect(readActionFile(dir, ID)).toContain('duration: PT1H');
    expect(sync.changesSinceStart()[0].summary).toBe('resized to PT1H');
  });

  it('applies a simultaneous move and resize in a single write', async () => {
    const { dir } = makeInstance(FM, ID);
    const rec = recordPath();
    const c = client({ ...FULL, ...SWEPT, ...got({ start: '2026-05-15T14:00', end: '2026-05-15T15:30' }) }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    const file = readActionFile(dir, ID);
    expect(file).toContain('scheduled: "2026-05-15T14:00"');
    expect(file).toContain('duration: PT1H30M');
    expect(sync.changesSinceStart().map((c) => c.summary)).toEqual([
      'rescheduled 2026-05-15T10:00 -> 2026-05-15T14:00',
      'resized to PT1H30M',
    ]);
  });

  it('imports a calendar re-pin back to the action (and does not revert it)', async () => {
    const { dir } = makeInstance(FM); // calendar: Work
    const rec = recordPath();
    const c = client({ ...FULL, ...SWEPT, ...got({ calendar: 'Personal' }), 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]); // user dragged the event to the Personal calendar
    expect(readActionFile(dir, ID)).toContain('calendar: Personal');
    expect(sync.changesSinceStart()).toEqual([{ id: ID, summary: 'moved to the Personal calendar' }]);
    // The action now names Personal, so the forward-diff agrees — no revert upsert.
    expect(readRequests(rec).some((r) => r.cmd === 'upsert-event')).toBe(false);
  });

  it('marks the action done and resyncs the event with a ✓ when the url gains /done', async () => {
    const { dir } = makeInstance(FM);
    const rec = recordPath();
    const c = client({ ...FULL, ...SWEPT, ...got({ url: buildMarker(INSTANCE, ID, 'done') }), 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    expect(readActionFile(dir, ID)).toContain('resolution: done');
    expect(sync.changesSinceStart()).toEqual([{ id: ID, summary: 'marked done' }]);
    // The action is now authoritative; forward sync re-derives the event with the
    // ✓ title and /done marker (the user only appended the url suffix).
    const up = readRequests(rec).filter((r) => r.cmd === 'upsert-event').at(-1);
    expect(up?.title).toBe('✓ Deploy');
    expect(up?.marker).toBe(buildMarker(INSTANCE, ID, 'done'));
  });

  it('backlogs the action and removes the event when the url gains /backlog', async () => {
    const { dir } = makeInstance(FM);
    const c = client({ ...FULL, ...SWEPT, ...got({ url: buildMarker(INSTANCE, ID, 'backlog') }), 'delete-event': { ok: true, result: { deleted: true } } });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    expect(readActionFile(dir, ID)).not.toContain('scheduled:');
    expect(sync.changesSinceStart()).toEqual([{ id: ID, summary: 'descheduled' }]);
  });

  it('backlogs the action when its event is deleted live', async () => {
    const { dir } = makeInstance(FM);
    const c = client({ ...FULL, ...SWEPT_THEN_GONE, 'get-events': { ok: true, result: { events: [] } } }); // gone by id and marker
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    expect(readActionFile(dir, ID)).not.toContain('scheduled:');
    expect(sync.changesSinceStart()).toEqual([{ id: ID, summary: 'descheduled (event deleted)' }]);
  });

  it('re-matches a reassigned event id by marker (reschedule, not deschedule) and refreshes the cache', async () => {
    const { dir } = makeInstance(FM);
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': [
        { ok: true, result: { events: [SWEPT_EVENT] } }, // sweep → caches ev-1
        { ok: true, result: { events: [ // re-match: same marker, new id, moved
          { id: 'ev-2', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T14:00', end: '2026-05-15T14:30' },
        ] } },
      ],
      'get-events': { ok: true, result: { events: [] } }, // ev-1 id no longer resolves
      'upsert-event': { ok: true, result: { eventId: 'ev-2' } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    expect(readActionFile(dir, ID)).toContain('scheduled: "2026-05-15T14:00"'); // rescheduled, not backlogged
    expect(readRequests(rec).some((r) => r.cmd === 'delete-event')).toBe(false);
    // Cache now points at ev-2: a follow-up forward sync updates it in place.
    await sync.syncActions([scheduled], [scheduled]);
    expect(readRequests(rec).filter((r) => r.cmd === 'upsert-event').at(-1)!.eventId).toBe('ev-2');
  });

  it('holds off descheduling when the marker re-match query fails', async () => {
    const { dir } = makeInstance(FM);
    const before = readActionFile(dir, ID);
    const c = client({
      ...FULL,
      'list-events': [
        { ok: true, result: { events: [SWEPT_EVENT] } }, // sweep
        { ok: false, error: 'boom' }, // re-match query fails → inconclusive
      ],
      'get-events': { ok: true, result: { events: [] } },
    });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    expect(readActionFile(dir, ID)).toBe(before); // not descheduled
    expect(sync.changesSinceStart()).toEqual([]);
  });

  it('deschedules a scheduled action whose event the sweep did not match (calendar authoritative)', async () => {
    const { dir } = makeInstance(FM); // on disk: scheduled + calendar
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } }, // sweep finds nothing → event is gone
      'upsert-event': { ok: true, result: { eventId: 'ev-new' } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await sync.reconcile([scheduled]); // single cold pass mirrors the live reverse path
    expect(readActionFile(dir, ID)).not.toContain('scheduled:'); // descheduled, not recreated
    expect(sync.changesSinceStart()).toEqual([{ id: ID, summary: 'descheduled (event deleted)' }]);
    expect(readRequests(rec).some((r) => r.cmd === 'upsert-event')).toBe(false);
  });

  it('does not re-create from a stale store entry when the action is backlog on disk', async () => {
    // On disk the action is backlog (no scheduled); the passed entry is stale.
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\ncalendar: Work');
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-new' } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await sync.reconcile([scheduled]); // scheduled = stale (still has scheduled)
    expect(readRequests(rec).some((r) => r.cmd === 'upsert-event')).toBe(false); // disk truth wins
  });

  it('does not re-create an event deleted live (it is descheduled instead)', async () => {
    const { dir } = makeInstance(FM);
    const rec = recordPath();
    const c = client({ ...FULL, ...SWEPT_THEN_GONE, 'get-events': { ok: true, result: { events: [] } }, 'upsert-event': { ok: true, result: { eventId: 'x' } } }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    expect(readActionFile(dir, ID)).not.toContain('scheduled:'); // descheduled
    expect(readRequests(rec).some((r) => r.cmd === 'upsert-event')).toBe(false); // not resurrected
  });

  it('reaps a lingering event for a backlog action without importing a phantom resize', async () => {
    // On disk the action is backlog (descheduled while the instance was not loaded); a stale
    // event of non-default length lingers. The event is removed, and no move/resize
    // is written onto the unscheduled action.
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\ncalendar: Work');
    const rec = recordPath();
    const lingering = { id: 'ev-1', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T11:00' }; // 60m ≠ default 30m
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [lingering] } }, // sweep caches it
      'delete-event': { ok: true, result: { deleted: true } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await sync.reconcile([scheduled]); // allScheduled is stale; disk truth is backlog
    expect(readRequests(rec).find((r) => r.cmd === 'delete-event')!.eventId).toBe('ev-1'); // reaped
    expect(readActionFile(dir, ID)).not.toContain('duration:'); // no phantom resize written
    expect(sync.changesSinceStart().some((c) => c.summary.startsWith('resized'))).toBe(false);
  });

  it('removes duplicate events sharing a marker, keeping one', async () => {
    const dup = (id: string) => ({ id, url: buildMarker(INSTANCE, ID, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' });
    const { dir } = makeInstance(FM);
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [dup('ev-1'), dup('ev-2')] } },
      'get-events': { ok: true, result: { events: [dup('ev-1')] } },
      'delete-event': { ok: true, result: { deleted: true } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await sync.reconcile([scheduled]);
    const del = readRequests(rec).find((r) => r.cmd === 'delete-event')!;
    expect(del.eventId).toBe('ev-2'); // the duplicate, not the kept one
    expect(sync.changesSinceStart().some((c) => c.summary === 'removed duplicate event')).toBe(true);
  });

  it('writes nothing when the event already matches the action (no loop)', async () => {
    const { dir } = makeInstance(FM);
    const before = readActionFile(dir, ID);
    const c = client({ ...FULL, ...SWEPT, ...got({ start: '2026-05-15T10:00', end: '2026-05-15T10:30' }) });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    expect(readActionFile(dir, ID)).toBe(before); // compare-before-write
    expect(sync.changesSinceStart()).toEqual([]);
  });

  it('surfaces a reverse-sync failure when the calendar read fails, then clears it on a clean pass', async () => {
    const { dir } = makeInstance(FM);
    const c = client({
      ...FULL,
      ...SWEPT, // cold pass: sweep caches ev-1
      'get-events': [
        { ok: false, error: 'helper busy' }, // warm pass 1: read fails
        { ok: true, result: { events: [{ id: 'ev-1', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30', allDay: false }] } }, // warm pass 2: ok
      ],
    });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await sync.reconcile([scheduled]); // cold (no failure)
    await sync.reconcile([scheduled]); // warm read fails -> failure recorded
    expect(sync.report()).toEqual([{ id: 'reverse sync', reason: 'could not read calendar state, will retry' }]);
    await sync.reconcile([scheduled]); // warm read ok -> failure cleared
    expect(sync.report()).toEqual([]);
  });

  it('surfaces a per-action reverse failure when removing a cancelled event fails', async () => {
    const { dir } = makeInstance(FM);
    const c = client({
      ...FULL,
      ...SWEPT, // cold pass: caches ev-1
      ...got({ url: buildMarker(INSTANCE, ID, 'cancelled') }), // warm: user appended /cancelled
      'delete-event': { ok: false, error: 'remove failed' },
    });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await reconcileInSession(sync, [scheduled]);
    // The edit applied (write succeeded) but the event removal failed — both true,
    // both surfaced: the change is recorded, and the failure reaches calendar_info.
    expect(readActionFile(dir, ID)).toContain('resolution: cancelled');
    expect(sync.report()).toEqual([{ id: ID, reason: 'reverse sync failed: remove failed', diagnostic: expect.objectContaining({ category: 'operation-failed', reason: 'remove failed' }) }]);
  });

  it('surfaces a duplicate it could not prune (and records no false change)', async () => {
    const dup = (id: string) => ({ id, url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' });
    const { dir } = makeInstance(FM);
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [dup('ev-1'), dup('ev-2')] } },
      'delete-event': { ok: false, error: 'remove failed' },
    });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await sync.reconcile([scheduled]); // cold sweep tries to prune ev-2 -> fails
    expect(sync.report()).toEqual([{ id: ID, reason: 'could not remove duplicate event: remove failed', diagnostic: expect.objectContaining({ category: 'helper-command-failed', command: 'delete-event', reason: 'remove failed' }) }]);
    expect(sync.changesSinceStart().some((c) => c.summary === 'removed duplicate event')).toBe(false);
  });

});

describe('CalSync cold deschedule cap', () => {
  const INSTANCE = 'work';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const IDS = ['2026-05-15-a1', '2026-05-15-a2', '2026-05-15-a3', '2026-05-15-a4', '2026-05-15-a5'];
  const FM = 'name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work';
  const ev = (id: string) => ({ id: `ev-${id}`, url: buildMarker(INSTANCE, id, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' });
  function makeMany(): string {
    const { dir } = makeInstance(FM, IDS[0]);
    for (const id of IDS.slice(1)) writeFileSync(join(dir, 'actions', '2026', `${id}.md`), `---\n${FM}\n---\nbody\n`);
    return dir;
  }
  const all = (store: Store) => IDS.map((id) => storeAction(store, id)!);

  it('defers a bulk cold deschedule (>3 and >25%), keeps retrying cold, and adopts the events when they return', async () => {
    // 5 scheduled+calendar actions; the sweep sees only one. 4 missing at once
    // is a bulk disappearance (offline account), not four user deletions.
    const dir = makeMany();
    const rec = recordPath();
    const c = client({
      ...FULL,
      // Pass 1 sweep (month window + the two widening rings), then the retry
      // pass's relocate, where the account is back and every event is found.
      'list-events': [
        { ok: true, result: { events: [ev(IDS[0])] } },
        { ok: true, result: { events: [] } },
        { ok: true, result: { events: [] } },
        { ok: true, result: { events: IDS.slice(1).map(ev) } },
      ],
      'get-events': { ok: true, result: { events: [ev(IDS[0])] } },
      'upsert-event': { ok: true, result: { eventId: `ev-${IDS[1]}` } },
    }, { recordTo: rec });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);

    await sync.reconcile(all(store)); // cold pass: 4 of 5 missing -> deferred
    for (const id of IDS) expect(readActionFile(dir, id)).toContain('scheduled:'); // none descheduled
    expect(sync.changesSinceStart()).toEqual([]);
    expect(sync.report()).toHaveLength(1);
    const [failure] = sync.report();
    expect(failure.id).toBe('reverse sync');
    expect(failure.reason).toContain('deferred descheduling 4 actions');
    for (const id of IDS.slice(1)) expect(failure.reason).toContain(id);

    await sync.reconcile(all(store)); // still cold: deferred candidates re-checked by marker
    expect(sync.report()).toEqual([]); // events found again -> clean pass
    for (const id of IDS) expect(readActionFile(dir, id)).toContain('scheduled:');
    // The re-found events were adopted: a forward op updates in place, no create.
    const a2 = storeAction(store, IDS[1])!;
    await sync.syncActions([a2], all(store));
    expect(readRequests(rec).filter((r) => r.cmd === 'upsert-event').at(-1)!.eventId).toBe(`ev-${IDS[1]}`);
  });

  it('executes cold deschedules at or below the cap (3 of 5)', async () => {
    const dir = makeMany();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [ev(IDS[0]), ev(IDS[1])] } },
    });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    await sync.reconcile(all(store)); // 3 missing: not > 3 -> normal deletion-import
    for (const id of IDS.slice(0, 2)) expect(readActionFile(dir, id)).toContain('scheduled:');
    for (const id of IDS.slice(2)) expect(readActionFile(dir, id)).not.toContain('scheduled:');
    expect(sync.changesSinceStart()).toEqual(IDS.slice(2).map((id) => ({ id, summary: 'descheduled (event deleted)' })));
    expect(sync.report()).toEqual([]);
  });
});

describe('CalSync forward/reverse races & stale snapshots', () => {
  const INSTANCE = 'work';
  const ID = '2026-05-15-deploy';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const MARKER = buildMarker(INSTANCE, ID, 'active');
  const FM = 'name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work';
  const SWEPT_EVENT = { id: 'ev-1', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' };

  it('does not import stale calendar state over an in-flight forward change', async () => {
    // The action was just rescheduled to 14:00 and the forward upsert is in
    // flight; the calendar (and thus the sweep) still shows 10:00. The racing
    // reconcile must not write the stale 10:00 back onto the action.
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T14:00\ncalendar: Work');
    const before = readActionFile(dir, ID);
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [SWEPT_EVENT] } }, // still at 10:00
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
    }, { upsertDelayMs: 80 });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const a = storeAction(store, ID)!;
    const forward = sync.syncActions([a], [a]); // registers the op before its first await
    const reverse = sync.reconcile([a]);
    await Promise.all([forward, reverse]);
    expect(readActionFile(dir, ID)).toBe(before); // 14:00 kept — not reverted to 10:00
    expect(sync.changesSinceStart()).toEqual([]);
  });

  it('keeps the in-flight guard while an overlapping second op on the same action is pending', async () => {
    // Two rapid updates overlap; the first op settling must not strip the guard
    // from the second (refcount, not a set). A reconcile running between the
    // two settlements must still skip the stale import.
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T14:00\ncalendar: Work');
    const before = readActionFile(dir, ID);
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [SWEPT_EVENT] } }, // still at 10:00
      'get-events': { ok: true, result: { events: [SWEPT_EVENT] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
    }, { upsertDelayMs: 150 });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const a = storeAction(store, ID)!;
    await c.authStatus(); // warm the helper up-front, so the stagger below is real
    const first = sync.syncActions([a], [a]);
    await new Promise((r) => setTimeout(r, 60)); // second op overlaps, settles later
    const second = sync.syncActions([a], [a]);
    await first;
    const reverse = sync.reconcile([a]); // second op still in flight
    await Promise.all([second, reverse]);
    expect(readActionFile(dir, ID)).toBe(before); // 14:00 kept — not reverted to 10:00
    expect(sync.changesSinceStart()).toEqual([]);
  });

  it('skips a reverse write when the action file changed on disk mid-pass (outside edit)', async () => {
    // Session A's pass snapshots the action at 10:00 and the calendar at 11:00
    // (a stale gesture). Session B rewrites the file to 14:00 while A's sweep is
    // in flight — a direct file write A's watcher hasn't seen. A must not import
    // the 11:00 gesture over B's edit.
    const { dir, id } = makeInstance(FM); // scheduled 10:00
    const file = join(dir, 'actions', '2026', `${id}.md`);
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [{ ...SWEPT_EVENT, start: '2026-05-15T11:00', end: '2026-05-15T11:30' }] } },
    }, { listDelayMs: 80 });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const pass = sync.reconcile([storeAction(store, ID)!]); // sweep held in flight
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(file, '---\nname: Deploy\ncreated: 2026-05-15T09:00\nscheduled: "2026-05-15T14:00"\ncalendar: Work\n---\nbody\n');
    await pass;
    expect(readActionFile(dir, ID)).toContain('scheduled: "2026-05-15T14:00"'); // not reverted to 11:00
    expect(sync.changesSinceStart()).toEqual([]); // and no change recorded
  });

  it('skips a reverse write when only the action BODY changed on disk mid-pass', async () => {
    // The reverse write rewrites the whole file, so the guard's compare surface
    // must cover everything it writes: a mid-pass foreign edit to the body (a
    // field forward sync does not read) must also block the import, or the
    // gesture write would silently revert it.
    const { dir, id } = makeInstance(FM); // scheduled 10:00
    const file = join(dir, 'actions', '2026', `${id}.md`);
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [{ ...SWEPT_EVENT, start: '2026-05-15T11:00', end: '2026-05-15T11:30' }] } },
    }, { listDelayMs: 80 });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const pass = sync.reconcile([storeAction(store, ID)!]); // sweep held in flight
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(file, `---\n${FM}\n---\nrevised notes from an outside edit\n`);
    await pass;
    expect(readActionFile(dir, id)).toContain('revised notes from an outside edit'); // body kept
    expect(sync.changesSinceStart()).toEqual([]);
  });

  it('retries the deletion-import when a cold-pass write fails', async () => {
    // Root can write anything, so the chmod trick is meaningless there (CI).
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    // The event is gone, so the cold pass must deschedule — but the write fails.
    // The deletion-import is only "done" after a clean pass: the next reconcile
    // must still run cold and retry, or the drift persists until restart.
    const { dir, id } = makeInstance(FM);
    const c = client({ ...FULL, 'list-events': { ok: true, result: { events: [] } } });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const a = storeAction(store, id)!;
    // Writes are crash-safe (temp file + rename), which needs directory write
    // permission — a read-only *file* alone would no longer fail the write.
    const yearDir = join(dir, 'actions', '2026');
    chmodSync(yearDir, 0o500);
    try {
      await sync.reconcile([a]); // cold pass: deschedule write fails
      expect(sync.report().length).toBeGreaterThan(0);
    } finally {
      chmodSync(yearDir, 0o700);
    }
    await sync.reconcile([a]); // still cold: retried and applied
    expect(readActionFile(dir, id)).not.toContain('scheduled:');
  });

  it('does not deschedule a just-captured action during the first cold reconcile', async () => {
    // Captured while the cold sweep is in flight: in neither cache nor calendar
    // yet. The cold pass must not read that as "event deleted" and strip
    // `scheduled` — the in-flight forward op owns the action.
    const { dir } = makeInstance(FM);
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } }, // nothing on the calendar yet
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
    }, { listDelayMs: 60, upsertDelayMs: 60 });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const a = storeAction(store, ID)!;
    const reverse = sync.reconcile([a]); // cold pass, sweep held in flight
    const forward = sync.syncActions([a], [a]); // the capture's forward sync joins it
    await Promise.all([reverse, forward]);
    expect(readActionFile(dir, ID)).toContain('scheduled:');
    expect(sync.changesSinceStart()).toEqual([]);
  });

  it('runs the startup deletion-import even when a capture completed the sweep first', async () => {
    // The sweep alone is not the cold reconcile: an event deleted while the MCP
    // was off must still deschedule its action on the first reconcile, however
    // the sweep got done.
    const { dir } = makeInstance(FM);
    const c = client({ ...FULL, 'list-events': { ok: true, result: { events: [] } } });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const a = storeAction(store, ID)!;
    await sync.syncActions([], [a]); // a capture's sweep, no forward ops
    await sync.reconcile([a]); // first reconcile must still run the cold pass
    expect(readActionFile(dir, ID)).not.toContain('scheduled:');
    expect(sync.changesSinceStart()).toEqual([{ id: ID, summary: 'descheduled (event deleted)' }]);
  });

  it('retries an outbox op against the action\'s current state, not the failure-time snapshot', async () => {
    const { dir } = makeInstance(FM); // scheduled 10:00
    const heal = recordPath();
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
    }, { healFile: heal, recordTo: rec });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const a = storeAction(store, ID)!;
    await sync.syncActions([a], [a]); // transient failure -> outbox holds a 10:00 snapshot
    // The action is rescheduled on disk while the op waits in the outbox.
    store.saveAction(ID, { ...store.getAction(ID)!.frontMatter, scheduled: '2026-05-15T16:00' }, 'body', store.getActionFile(ID)!);
    writeFileSync(heal, 'ok'); // transient condition clears
    await sync.syncActions([], []); // drain
    const up = readRequests(rec).filter((r) => r.cmd === 'upsert-event').at(-1)!;
    expect(up.start).toBe('2026-05-15T16:00'); // re-read at retry, not the snapshot
    expect(sync.report()).toEqual([]);
  });

  it('re-reads a missed action after relocate, preserving edits made during the query', async () => {
    const { dir } = makeInstance(FM);
    const store = new Store(dir);
    const c = client({
      ...FULL,
      'list-events': [
        { ok: true, result: { events: [SWEPT_EVENT] } }, // sweep caches ev-1
        { ok: true, result: { events: [ // relocate: same marker, new id, moved to 14:00
          { id: 'ev-2', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T14:00', end: '2026-05-15T14:30' },
        ] } },
      ],
      'get-events': { ok: true, result: { events: [] } }, // warm: ev-1 gone by id
    }, { listDelayMs: 60 });
    const sync = new CalSync(c, INSTANCE, store);
    await sync.reconcile([storeAction(store, ID)!]); // cold
    const warm = sync.reconcile([storeAction(store, ID)!]); // miss -> relocate held in flight
    await new Promise((r) => setTimeout(r, 20));
    // A deadline lands on the action while relocate's query is in flight.
    store.saveAction(ID, { ...store.getAction(ID)!.frontMatter, deadline: '2026-06-01' }, 'body', store.getActionFile(ID)!);
    await warm;
    const file = readActionFile(dir, ID);
    expect(file).toContain('deadline:'); // the mid-query edit survives
    expect(file).toContain('scheduled: "2026-05-15T14:00"'); // and the import applied
  });
});

describe('CalSync recurring events', () => {
  const INSTANCE = 'work';
  const ID = '2026-05-15-deploy';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const MARKER = buildMarker(INSTANCE, ID, 'active');
  const FM = 'name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work';
  const RECURRING = { id: 'ev-r', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-20T10:00', end: '2026-05-20T10:30', recurring: true };

  it('never imports from or forward-syncs onto a recurring event, and surfaces it', async () => {
    const { dir } = makeInstance(FM);
    const before = readActionFile(dir, ID);
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [RECURRING] } }, // moved AND recurring
      'get-events': { ok: true, result: { events: [RECURRING] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-r' } },
    }, { recordTo: rec });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    await sync.reconcile([storeAction(store, ID)!]);
    expect(readActionFile(dir, ID)).toBe(before); // the move was not imported
    expect(sync.changesSinceStart()).toEqual([]);
    expect(sync.report()).toEqual([{ id: ID, reason: expect.stringContaining('recurring') }]);
    // Forward sync skips it too: no upsert reaches the helper.
    const a = storeAction(store, ID)!;
    const [res] = await sync.syncActions([a], [a]);
    expect(res.status).toBe('skipped');
    expect(res.reason).toContain('recurring');
    expect(readRequests(rec).some((r) => r.cmd === 'upsert-event')).toBe(false);
  });

  it('never prunes a recurring event as a duplicate', async () => {
    // EventKit reports one entry per occurrence sharing the id/marker; pruning
    // them would dismantle a user's hand-made series occurrence by occurrence.
    const { dir } = makeInstance(FM);
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [
        { id: 'ev-1', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' },
        { ...RECURRING, id: 'ev-r' },
      ] } },
      'delete-event': { ok: true, result: { deleted: true } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE, new Store(dir));
    await sync.reconcile([storeAction(new Store(dir), ID)!]);
    expect(readRequests(rec).some((r) => r.cmd === 'delete-event')).toBe(false);
    expect(sync.changesSinceStart()).toEqual([]);
  });

  it('resumes sync once the recurrence is removed', async () => {
    const { dir } = makeInstance(FM);
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [{ ...RECURRING, start: '2026-05-15T10:00', end: '2026-05-15T10:30' }] } },
      // The user removed the recurrence and moved the event.
      'get-events': { ok: true, result: { events: [
        { id: 'ev-r', url: MARKER, calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T14:00', end: '2026-05-15T14:30' },
      ] } },
    });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    await sync.reconcile([storeAction(store, ID)!]); // cold: parked as recurring
    expect(sync.report()).toEqual([{ id: ID, reason: expect.stringContaining('recurring') }]);
    expect(sync.status(ID)?.status).toBe('failed');
    await sync.reconcile([storeAction(store, ID)!]); // warm: recurrence gone -> import
    expect(readActionFile(dir, ID)).toContain('scheduled: "2026-05-15T14:00"');
    expect(sync.report()).toEqual([]);
    expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-r' });
  });

  it('parks an action when the helper reports event-recurring on a forward op', async () => {
    const { dir } = makeInstance(FM);
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [{ ...RECURRING, recurring: undefined, start: '2026-05-15T10:00', end: '2026-05-15T10:30' }] } },
      'upsert-event': { ok: false, error: 'event is part of a recurring series', code: 'event-recurring' },
    });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const a = storeAction(store, ID)!;
    const [res] = await sync.syncActions([a], [a]);
    expect(res.status).toBe('error');
    expect(sync.report()).toEqual([{ id: ID, reason: expect.stringContaining('recurring') }]);
    // Parked, not retried: the next pass skips it instead of re-upserting.
    const [again] = await sync.syncActions([a], [a]);
    expect(again.status).toBe('skipped');
  });
});

describe('CalSync query chunking', () => {
  const INSTANCE = 'work';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const YEARS = 3.6 * 365.25 * 86_400_000; // just over the 3.5-year chunk size

  function at(id: string, scheduled: string): SyncAction {
    return { id, frontMatter: { name: 'A', created: '2026-01-01T09:00', scheduled, calendar: 'Work' }, body: 'x' };
  }

  it('splits a multi-year sweep into list-events queries EventKit can serve', async () => {
    const rec = recordPath();
    const c = client({ ...FULL, 'list-events': { ok: true, result: { events: [] } } }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE);
    const all = [at('2026-05-15-a', '2026-05-15T10:00'), at('2036-05-15-b', '2036-05-15T10:00')];
    await sync.syncActions([], all); // runs the sweep over a ~10-year span
    const lists = readRequests(rec).filter((r) => r.cmd === 'list-events');
    expect(lists.length).toBeGreaterThan(3); // the month window alone needs several chunks
    for (const l of lists) {
      expect(Date.parse(l.end as string) - Date.parse(l.start as string)).toBeLessThanOrEqual(YEARS);
    }
  });

  it('does not prune an event returned by two chunks as a duplicate', async () => {
    // Range predicates return every event overlapping the range, so an event
    // straddling a chunk boundary comes back from both adjacent chunks. Treating
    // the second appearance as a duplicate marker would delete the live event.
    const rec = recordPath();
    const ev = {
      id: 'ev-1', url: buildMarker(INSTANCE, '2026-05-15-a', 'active'), calendar: 'Work',
      title: '▢ A', start: '2026-05-15T10:00', end: '2026-05-15T10:30',
    };
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [ev] } }, // every chunk returns it
      'delete-event': { ok: true, result: { deleted: true } },
    }, { recordTo: rec });
    const sync = new CalSync(c, INSTANCE);
    const all = [at('2026-05-15-a', '2026-05-15T10:00'), at('2036-05-15-b', '2036-05-15T10:00')];
    await sync.syncActions([], all); // multi-chunk sweep
    expect(readRequests(rec).some((r) => r.cmd === 'delete-event')).toBe(false);
  });
});

// Cross-session serialization rides the darwin-only kernel flock (see lock.ts);
// on other platforms the lock is a no-op, so there is no behavior to pin.
describe('CalSync mutation lock', () => {
  const INSTANCE = 'work';
  const ID = '2026-05-15-deploy';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const FM = 'name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work';

  it('reconcile skips while another phase holds the lock, then retries once released', async () => {
    const { dir } = makeInstance(FM);
    const rec = recordPath();
    const c = client({ ...FULL, 'list-events': { ok: true, result: { events: [] } } }, { recordTo: rec });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    const holder = new SyncLock(dir); // another mutation phase on this instance
    expect(holder.tryAcquire()).toBe(true);
    await sync.reconcile([storeAction(store, ID)!]);
    // Skipped: the calendar was never read and nothing was written.
    expect(readRequests(rec).some((r) => r.cmd === 'list-events')).toBe(false);
    expect(readActionFile(dir, ID)).toContain('scheduled:');
    holder.release();
    // The single retry timer (~2s) re-runs the pass, which now finds no event
    // and imports the deletion.
    const until = Date.now() + 8000;
    while (Date.now() < until && readActionFile(dir, ID).includes('scheduled:')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(readActionFile(dir, ID)).not.toContain('scheduled:');
  }, 15_000);

  it('defers a forward batch to the outbox when the lock wait times out', async () => {
    const { dir } = makeInstance(FM);
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
    }, { recordTo: rec });
    const store = new Store(dir);
    const sync = new CalSync(c, INSTANCE, store);
    await sync.syncActions([], []); // warm up: access cached, sweep done
    const a = storeAction(store, ID)!;
    const holder = new SyncLock(dir);
    expect(holder.tryAcquire()).toBe(true);
    vi.useFakeTimers();
    try {
      const p = sync.syncActions([a], [a]);
      await vi.advanceTimersByTimeAsync(15_500); // past the 15s lock wait
      const [res] = await p;
      expect(res.status).toBe('skipped');
      expect(res.reason).toBe('calendar busy (another sync in progress), will retry');
      expect(sync.report()).toEqual([{ id: ID, reason: 'calendar busy (another sync in progress), will retry' }]);
    } finally {
      vi.useRealTimers();
    }
    expect(readRequests(rec).some((r) => r.cmd === 'upsert-event')).toBe(false); // nothing pushed while held
    holder.release();
    await sync.syncActions([], []); // next batch drains the outbox
    expect(sync.report()).toEqual([]);
    expect(readRequests(rec).filter((r) => r.cmd === 'upsert-event')).toHaveLength(1); // the retried op
  }, 15_000);
});

describe('CalSync manifest live-read', () => {
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const ID = '2026-05-15-deploy';
  const FM = 'name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work';

  it('picks up an `id` (and config) added to aside.md after construction', async () => {
    const { dir } = makeInstance(FM);
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
    }, { recordTo: rec });
    const store = new Store(dir);
    const sync = new CalSync(c, '', store); // no id anywhere yet — sync disabled
    const a = storeAction(store, ID)!;
    let [res] = await sync.syncActions([a], [a]);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('instance has no id');
    // The user adds the id and a title prefix; the store's watcher rebuilds.
    writeFileSync(join(dir, 'aside.md'), '---\nid: work\nname: Work\nconfig:\n  scheduledEventTitlePrefix: "► "\n---\n');
    store.rebuild();
    [res] = await sync.syncActions([a], [a]);
    expect(res.status).toBe('synced');
    const up = readRequests(rec).find((r) => r.cmd === 'upsert-event')!;
    expect(up.marker).toBe(buildMarker('work', ID, 'active'));
    expect(up.title).toBe('► Deploy');
  });
});

describe('calendar sync observability', () => {
  const ID = '2026-05-15-deploy';
  const FULL = { 'auth-status': { ok: true, result: { status: 'fullAccess' } } };
  const a: SyncAction = {
    id: ID,
    frontMatter: { name: 'Deploy', created: '2026-05-15T09:00', scheduled: '2026-05-15T10:00', calendar: 'Work' },
    body: 'Body',
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it('reports pending until a helper write settles, then exposes sync and removal completion', async () => {
    const c = client({ ...FULL, 'list-calendars': { ok: true, result: { calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'local' }] } } });
    const sync = new CalSync(c, 'work');
    await sync.syncActions([], []); // warm access and cache, isolating the write
    const created = deferred<{ eventId: string }>();
    const upsert = vi.spyOn(c, 'upsertEvent').mockReturnValueOnce(created.promise);
    vi.spyOn(c, 'getEvents').mockImplementation(async ({ eventIds }) => ({ events: [savedEvent(upsert.mock.calls[0][0], eventIds[0])] }));
    const forward = sync.syncActions([a], [a]);
    expect(sync.status(ID)?.status).toBe('pending'); // available synchronously to a receipt
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
    expect(await handleCalendarInfo(c, sync)).toContain(`- id: ${ID}\n    status: pending`);
    expect(await handleCalendarInfo(c, sync)).toContain('calendar_sync:');
    created.resolve({ eventId: 'ev-1' });
    await forward;
    expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-1' });
    expect(await handleCalendarInfo(c, sync)).toContain('status: synced');

    const deleted = deferred<{ deleted: boolean }>();
    const remove = vi.spyOn(c, 'deleteEvent').mockReturnValueOnce(deleted.promise);
    const removal = sync.syncActions([{ ...a, frontMatter: { ...a.frontMatter, scheduled: undefined } }], []);
    expect(sync.status(ID)?.status).toBe('pending');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    deleted.resolve({ deleted: true });
    await removal;
    expect(sync.status(ID)).toEqual({ id: ID, status: 'removed' });
    expect(await handleCalendarInfo(c, sync)).toContain('status: removed');
  });

  it('keeps an overlapping newer operation pending after an older operation completes', async () => {
    const c = client(FULL);
    const sync = new CalSync(c, 'work');
    await sync.syncActions([], []);
    const first = deferred<{ eventId: string }>();
    const second = deferred<{ eventId: string }>();
    const upsert = vi.spyOn(c, 'upsertEvent').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.spyOn(c, 'getEvents').mockImplementation(async ({ eventIds }) => ({ events: [savedEvent(upsert.mock.calls[eventIds[0] === 'ev-1' ? 0 : 1][0], eventIds[0])] }));
    const one = sync.syncActions([a], []);
    const two = sync.syncActions([{ ...a, frontMatter: { ...a.frontMatter, scheduled: '2026-05-15T14:00' } }], []);
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(2));
    first.resolve({ eventId: 'ev-1' });
    await one;
    expect(sync.status(ID)?.status).toBe('pending');
    second.resolve({ eventId: 'ev-2' });
    await two;
    expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-2' });
  });

  it('shows authorization-blocked work as pending retry until a grant allows completion', async () => {
    vi.useFakeTimers();
    try {
      const c = client({
        'auth-status': [
          { ok: true, result: { status: 'denied' } },
          { ok: true, result: { status: 'fullAccess' } },
        ],
        'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
      });
      const sync = new CalSync(c, 'work');
      await sync.syncActions([a], []);
      expect(sync.status(ID)).toMatchObject({ id: ID, status: 'pending', reason: 'no calendar access', retry: true });
      await sync.syncActions([], []); // rechecks authorization and drains the retry queue
      expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-1' });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('shows transient failures as pending retry and permanent calendar failures as failed', async () => {
    vi.useFakeTimers();
    try {
      const c = client({
        ...FULL,
        'upsert-event': [
          { ok: false, error: 'temporarily down' },
          { ok: false, error: 'Work was removed', code: 'calendar-not-found' },
        ],
      });
      const sync = new CalSync(c, 'work');
      await sync.syncActions([a], []);
      expect(sync.status(ID)).toMatchObject({ id: ID, status: 'pending', reason: 'sync failed, will retry: temporarily down', retry: true });
      await sync.syncActions([], []);
      expect(sync.status(ID)).toMatchObject({ id: ID, status: 'failed', reason: 'Work was removed' });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('updates a previous success after a reverse deletion instead of retaining a stale synced state', async () => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const marker = buildMarker('work', ID, 'active');
    const event = {
      id: 'ev-1', url: marker, calendar: 'Work', title: '▢ Deploy',
      start: '2026-05-15T10:00', end: '2026-05-15T10:30', notes: 'body',
    };
    const c = client({
      ...FULL,
      'list-events': [
        { ok: true, result: { events: [event] } },
        { ok: true, result: { events: [] } },
      ],
      'get-events': { ok: true, result: { events: [] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
    });
    const store = new Store(dir);
    const sync = new CalSync(c, 'work', store);
    await sync.reconcile([storeAction(store, ID)!]);
    expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-1' });
    await sync.reconcile([storeAction(store, ID)!]);
    expect(sync.status(ID)).toEqual({ id: ID, status: 'removed' });
    expect(readActionFile(dir, ID)).not.toContain('scheduled:');
  });

  it('keeps a reverse gesture pending until its derived helper update completes', async () => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const marker = buildMarker('work', ID, 'active');
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [{
        id: 'ev-1', url: marker, calendar: 'Work', title: '▢ Deploy',
        start: '2026-05-15T10:00', end: '2026-05-15T10:30', notes: 'body',
      }] } },
      'get-events': { ok: true, result: { events: [{
        id: 'ev-1', url: buildMarker('work', ID, 'done'), calendar: 'Work', title: '▢ Deploy',
        start: '2026-05-15T10:00', end: '2026-05-15T10:30', notes: 'body',
      }] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
    });
    const store = new Store(dir);
    const sync = new CalSync(c, 'work', store);
    await sync.reconcile([storeAction(store, ID)!]);
    const updated = deferred<{ eventId: string }>();
    const upsert = vi.spyOn(c, 'upsertEvent').mockReturnValueOnce(updated.promise);
    const reverse = sync.reconcile([storeAction(store, ID)!]);
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
    expect(readActionFile(dir, ID)).toContain('resolution: done');
    expect(sync.status(ID)?.status).toBe('pending');
    vi.spyOn(c, 'getEvents').mockImplementation(async ({ eventIds }) => ({ events: [savedEvent(upsert.mock.calls[0][0], eventIds[0])] }));
    updated.resolve({ eventId: 'ev-1' });
    await reverse;
    expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-1' });
  });

  it('records disabled attempts for a missing instance id or unavailable helper', async () => {
    const noId = new CalSync(client(FULL), '');
    const skipped = noId.syncActions([a], []);
    expect(noId.statuses()).toEqual([{ id: ID, status: 'disabled', reason: 'instance has no id' }]);
    await skipped;
    const unavailable = new CalSync(new CalClient(null), 'work');
    await unavailable.syncActions([a], []);
    expect(unavailable.statuses()).toMatchObject([{ id: ID, status: 'disabled', reason: 'calendar helper unavailable' }]);
  });

  it('does not infer completion for an unattempted scheduled action', () => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00');
    const store = new Store(dir);
    const sync = new CalSync(client(FULL), 'work', store);
    expect(sync.status(ID)).toEqual({ id: ID, status: 'disabled', reason: 'no calendar' });
    expect(sync.statuses()).toEqual([{ id: ID, status: 'disabled', reason: 'no calendar' }]);
    store.saveAction(ID, { ...a.frontMatter }, a.body, store.getActionFile(ID)!);
    expect(sync.status(ID)).toBeUndefined();
    expect(sync.statuses()).toEqual([]);
  });

  it('settles unexpected batch failures as failed rather than leaving an in-flight status', async () => {
    const sync = new CalSync(client(FULL), 'work');
    const lock = vi.spyOn(SyncLock.prototype, 'acquireWait').mockRejectedValueOnce(new Error('local lock failed'));
    try {
      const [result] = await sync.syncActions([a], []);
      expect(result.status).toBe('error');
      expect(sync.status(ID)).toMatchObject({ id: ID, status: 'failed', reason: 'calendar sync failed: local lock failed' });
    } finally {
      lock.mockRestore();
    }
  });

  it.each(['unavailable', 'error'])('preserves per-instance reporting when helper auth is %s', async (state) => {
    const c = state === 'unavailable' ? new CalClient(null) : client({ 'auth-status': { ok: false, error: 'helper down' } });
    const out = await handleCalendarInfo(c, {
      report: () => [{ id: 'instance', reason: 'missing instance id' }],
      changesSinceStart: () => [{ id: ID, summary: 'descheduled (event deleted)' }],
      statuses: () => [{ id: ID, status: 'pending', reason: 'waiting for helper', retry: true }],
    });
    expect(out).toContain(`auth: ${state}`);
    expect(out).toContain(`- id: ${ID}\n    status: pending`);
    expect(out).toContain('retry: true');
    expect(out).toContain('instance — missing instance id');
    expect(out).toContain(`${ID} — descheduled (event deleted)`);
  });

  it('omits a settled positive after a direct edit, and disables it after deletion', async () => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const store = new Store(dir);
    const c = client({ ...FULL, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } });
    const sync = new CalSync(c, 'work', store);
    await sync.syncActions([storeAction(store, ID)!], []);
    expect(sync.status(ID)?.status).toBe('synced');
    const file = store.getActionFile(ID)!;
    // Status sees the direct disk edit before the Store watcher rebuilds.
    writeFileSync(file, readFileSync(file, 'utf8').replace('2026-05-15T10:00', '2026-05-15T14:00'));
    expect(sync.status(ID)).toBeUndefined();
    expect(sync.statuses()).toEqual([]);
    store.rebuild();
    expect(sync.status(ID)).toBeUndefined();
    await sync.syncActions([storeAction(store, ID)!], []);
    expect(sync.status(ID)?.status).toBe('synced');
    rmSync(file);
    expect(sync.status(ID)).toEqual({ id: ID, status: 'disabled', reason: 'action no longer exists' });
    store.rebuild();
    expect(sync.status(ID)).toEqual({ id: ID, status: 'disabled', reason: 'action no longer exists' });
  });

  it('certifies the snapshot sent to a delayed helper rather than a newer direct edit', async () => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const store = new Store(dir);
    const c = client(FULL);
    const sync = new CalSync(c, 'work', store);
    await sync.syncActions([], []);
    const updated = deferred<{ eventId: string }>();
    const upsert = vi.spyOn(c, 'upsertEvent').mockReturnValueOnce(updated.promise);
    const old = storeAction(store, ID)!;
    vi.spyOn(c, 'getEvents').mockImplementation(async ({ eventIds }) => ({ events: [savedEvent(upsert.mock.calls[0][0], eventIds[0])] }));
    const forward = sync.syncActions([old], []);
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
    store.saveAction(ID, { ...old.frontMatter, scheduled: '2026-05-15T16:00' }, old.body, store.getActionFile(ID)!);
    updated.resolve({ eventId: 'ev-1' });
    await forward;
    expect(sync.status(ID)).toBeUndefined();
    expect(sync.statuses()).toEqual([]);
  });

  it.each([
    ['another action', buildMarker('work', 'another-action', 'active')],
    ['another instance', buildMarker('other', ID, 'active')],
    ['an invalid marker', 'aside://invalid'],
  ])('invalidates sync confirmation when the cached event belongs to %s', async (_label, foreignMarker) => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const store = new Store(dir);
    const owned = { id: 'ev-1', url: buildMarker('work', ID, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' };
    const rec = recordPath();
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [owned] } },
      'get-events': [
        { ok: true, result: { events: [{ ...owned, url: foreignMarker }] } },
        { ok: true, result: { events: [owned] } },
      ],
      'list-calendars': { ok: true, result: { calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'local' }] } },
    }, { recordTo: rec });
    const sync = new CalSync(c, 'work', store);
    await sync.reconcile([storeAction(store, ID)!]);
    expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-1' });
    const before = readActionFile(dir, ID);
    await sync.reconcile([storeAction(store, ID)!]);
    expect(sync.status(ID)).toBeUndefined();
    expect(sync.statuses()).toEqual([]);
    expect(await handleCalendarInfo(c, sync)).not.toContain('status: synced');
    expect(readActionFile(dir, ID)).toBe(before);
    expect(sync.changesSinceStart()).toEqual([]);
    expect(readRequests(rec).filter((r) => r.cmd === 'upsert-event' || r.cmd === 'delete-event')).toEqual([]);
    await sync.reconcile([storeAction(store, ID)!]); // ownership restored
    expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-1' });
  });

  it('parses each year index once per report and observes direct edits on the next report', async () => {
    const fm = 'name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work';
    const { dir } = makeInstance(fm);
    const ids = [ID, '2026-05-15-second', '2027-05-15-third'];
    const firstIndex = join(dir, 'actions', '2026', 'index.yaml');
    const secondIndex = join(dir, 'actions', '2027', 'index.yaml');
    writeFileSync(join(dir, 'actions', '2026', `${ids[1]}.md`), `---\n${fm}\n---\nbody\n`);
    mkdirSync(join(dir, 'actions', '2027'));
    writeFileSync(join(dir, 'actions', '2027', `${ids[2]}.md`), `---\n${fm}\n---\nbody\n`);
    const yearIndex = (items: string[]) => items.map(id => `- id: ${id}\n  description: Original notes\n`).join('');
    writeFileSync(firstIndex, yearIndex(ids.slice(0, 2)));
    writeFileSync(secondIndex, yearIndex(ids.slice(2)));
    const store = new Store(dir);
    const c = client({ ...FULL, 'upsert-event': { ok: true, result: { eventId: 'ev-1' } } });
    const sync = new CalSync(c, 'work', store);
    await sync.syncActions(ids.map(id => storeAction(store, id)!), []);
    const parse = vi.spyOn(parser, 'parseIndex');
    try {
      expect(sync.statuses().map(({ id }) => id)).toEqual(ids);
      expect(parse).toHaveBeenCalledTimes(2);
      // Both index notes and action contents must be read from disk, without
      // requiring the Store watcher to catch up between reports.
      writeFileSync(firstIndex, yearIndex(ids.slice(0, 2)).replace('Original notes', 'Edited notes'));
      const secondFile = store.getActionFile(ids[1])!;
      writeFileSync(secondFile, readFileSync(secondFile, 'utf8').replace('body', 'Changed body'));
      parse.mockClear();
      expect(sync.statuses()).toEqual([{ id: ids[2], status: 'synced', eventId: 'ev-1' }]);
      expect(parse).toHaveBeenCalledTimes(2);
      writeFileSync(secondIndex, yearIndex(ids.slice(2)).replace('Original notes', 'Edited third notes'));
      expect(sync.status(ids[2])).toBeUndefined();
    } finally {
      parse.mockRestore();
    }
  });

  it('does not recertify edited notes on a reverse pass that made no helper write', async () => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const store = new Store(dir);
    const c = client({
      ...FULL,
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
      'get-events': { ok: true, result: { events: [{ id: 'ev-1', url: buildMarker('work', ID, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' }] } },
    });
    const sync = new CalSync(c, 'work', store);
    await sync.syncActions([storeAction(store, ID)!], []);
    const old = store.getAction(ID)!;
    store.saveAction(ID, old.frontMatter, 'Changed event notes', store.getActionFile(ID)!);
    expect(sync.status(ID)).toBeUndefined();
    const upsert = vi.spyOn(c, 'upsertEvent');
    await sync.reconcile([storeAction(store, ID)!]);
    await sync.reconcile([storeAction(store, ID)!]); // repeated reads still cannot confirm notes
    expect(upsert).not.toHaveBeenCalled();
    expect(sync.status(ID)).toBeUndefined();
    await sync.syncActions([storeAction(store, ID)!], []);
    expect(sync.status(ID)?.status).toBe('synced');
  });

  it('sees a direct index-description edit before the watcher and leaves it unconfirmed after reverse reads', async () => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const index = join(dir, 'actions', '2026', 'index.yaml');
    writeFileSync(index, `- id: ${ID}\n  description: Original notes\n`);
    const store = new Store(dir);
    const c = client({
      ...FULL,
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
      'get-events': { ok: true, result: { events: [{ id: 'ev-1', url: buildMarker('work', ID, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' }] } },
    });
    const sync = new CalSync(c, 'work', store);
    await sync.syncActions([storeAction(store, ID)!], []);
    expect(sync.status(ID)?.status).toBe('synced');
    writeFileSync(index, `- id: ${ID}\n  description: Edited notes\n`);
    expect(sync.status(ID)).toBeUndefined();
    store.rebuild();
    await sync.reconcile([storeAction(store, ID)!]);
    expect(sync.status(ID)).toBeUndefined();
  });

  it('invalidates a removed observation if a direct edit schedules the action again', async () => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\ncalendar: Work');
    const store = new Store(dir);
    const sync = new CalSync(client(FULL), 'work', store);
    await sync.syncActions([storeAction(store, ID)!], []); // no tracked event, existing no-op removal contract
    expect(sync.status(ID)?.status).toBe('removed');
    const old = store.getAction(ID)!;
    store.saveAction(ID, { ...old.frontMatter, scheduled: '2026-05-15T16:00' }, old.body, store.getActionFile(ID)!);
    expect(sync.status(ID)).toBeUndefined();
  });

  it('clears an old forward issue when reverse reconciliation confirms the owned event', async () => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const store = new Store(dir);
    const event = { id: 'ev-1', url: buildMarker('work', ID, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' };
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [event] } },
      'get-events': { ok: true, result: { events: [event] } },
      'upsert-event': { ok: false, error: 'calendar read-only: Work', code: 'calendar-read-only' },
    });
    const sync = new CalSync(c, 'work', store);
    await sync.syncActions([storeAction(store, ID)!], [storeAction(store, ID)!]);
    expect(sync.status(ID)?.status).toBe('failed');
    await sync.reconcile([storeAction(store, ID)!]);
    expect(sync.report()).toEqual([]);
    expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-1' });
  });

  it.each(['foreign', 'absent', 'owned'])('does not report removal for a false delete with a %s confirmation', async (confirmation) => {
    const { dir } = makeInstance('name: Deploy\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work');
    const store = new Store(dir);
    const owned = { id: 'ev-1', url: buildMarker('work', ID, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' };
    const events = confirmation === 'absent' ? [] : [{ ...owned, url: confirmation === 'owned' ? owned.url : buildMarker('work', 'another-action', 'active') }];
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [owned] } },
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
      'delete-event': { ok: true, result: { deleted: false } },
      'get-events': { ok: true, result: { events } },
    });
    const sync = new CalSync(c, 'work', store);
    await sync.syncActions([storeAction(store, ID)!], [storeAction(store, ID)!]);
    const old = store.getAction(ID)!;
    store.saveAction(ID, { ...old.frontMatter, resolution: 'cancelled' }, old.body, store.getActionFile(ID)!);
    const [result] = await sync.syncActions([storeAction(store, ID)!], []);
    expect(result.status).toBe('error');
    expect(sync.status(ID)?.status).toBe('failed');
    expect(sync.report()[0].reason).toContain('removal');
    // A later reconcile cannot reinterpret missing/unmarked ownership as a
    // confirmed physical deletion and erase the standing uncertainty.
    await sync.reconcile([storeAction(store, ID)!]);
    expect(sync.status(ID)?.status).toBe('failed');
    expect(sync.report()[0].reason).toContain('removal');
  });

  it('clears a refused removal only after a successful new sync or confirmed deletion', async () => {
    const c = client({
      ...FULL,
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
      'delete-event': [
        { ok: true, result: { deleted: false } },
        { ok: true, result: { deleted: true } },
      ],
      'get-events': { ok: true, result: { events: [{ id: 'ev-1', url: buildMarker('work', ID, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' }] } },
    });
    const sync = new CalSync(c, 'work');
    await sync.syncActions([a], []);
    const cancelled = { ...a, frontMatter: { ...a.frontMatter, resolution: 'cancelled' as const } };
    await sync.syncActions([cancelled], []);
    expect(sync.status(ID)?.status).toBe('failed');
    await sync.syncActions([cancelled], []);
    expect(sync.status(ID)?.status).toBe('removed');
    expect(sync.report()).toEqual([]);
  });

  it('creates a new owned event after ambiguous ownership instead of overwriting the refused id', async () => {
    const rec = recordPath();
    const c = client({
      ...FULL,
      'upsert-event': [
        { ok: true, result: { eventId: 'ev-1' } },
        { ok: true, result: { eventId: 'ev-2' } },
      ],
      'delete-event': { ok: true, result: { deleted: false } },
      'get-events': { ok: true, result: { events: [] } },
    }, { recordTo: rec });
    const sync = new CalSync(c, 'work');
    await sync.syncActions([a], []);
    await sync.syncActions([{ ...a, frontMatter: { ...a.frontMatter, resolution: 'cancelled' } }], []);
    expect(sync.status(ID)?.status).toBe('failed');
    await sync.syncActions([a], []);
    expect(readRequests(rec).filter((r) => r.cmd === 'upsert-event').at(-1)!.eventId).toBeUndefined();
    expect(sync.status(ID)).toEqual({ id: ID, status: 'synced', eventId: 'ev-2' });
    expect(sync.report()).toEqual([]);
  });

  it('preserves an unconfirmed removal when the calendar is cleared repeatedly', async () => {
    const c = client({
      ...FULL,
      'upsert-event': { ok: true, result: { eventId: 'ev-1' } },
      'delete-event': { ok: true, result: { deleted: false } },
      'get-events': { ok: true, result: { events: [] } },
    });
    const sync = new CalSync(c, 'work');
    await sync.syncActions([a], []);
    const cleared = { ...a, frontMatter: { ...a.frontMatter, calendar: undefined } };
    await sync.syncActions([cleared], []);
    const refused = { id: ID, status: 'failed', reason: 'event missing or no longer owned; removal was not confirmed' };
    expect(sync.status(ID)).toEqual(refused);
    const [repeated] = await sync.syncActions([cleared], []);
    expect(repeated.status).toBe('error');
    expect(sync.status(ID)).toEqual(refused);
    expect(sync.report()).toEqual([{ id: ID, reason: refused.reason }]);
  });

  it('does not announce a duplicate removal when the helper returned false', async () => {
    const event = { id: 'ev-1', url: buildMarker('work', ID, 'active'), calendar: 'Work', title: '▢ Deploy', start: '2026-05-15T10:00', end: '2026-05-15T10:30' };
    const c = client({
      ...FULL,
      'list-events': { ok: true, result: { events: [event, { ...event, id: 'ev-2' }] } },
      'delete-event': { ok: true, result: { deleted: false } },
    });
    const sync = new CalSync(c, 'work');
    await sync.syncActions([], [a]);
    expect(sync.changesSinceStart()).toEqual([]);
    expect(sync.report()).toEqual([{ id: ID, reason: 'could not remove duplicate event: event removal was not confirmed', diagnostic: expect.objectContaining({ category: 'operation-failed', reason: 'event removal was not confirmed' }) }]);
  });

  it('keeps calendar names, helper errors and observations inside their original fields', async () => {
    const c = client({
      ...FULL,
      'list-calendars': { ok: true, result: { calendars: [{ name: 'Work\nauth: denied', account: 'Cloud\u0085service', writable: true }] } },
    });
    const out = await handleCalendarInfo(c, {
      report: () => [{ id: 'action\nchanges:', reason: 'failed\nauth: denied' }],
      changesSinceStart: () => [{ id: ID, summary: 'moved\u2028auth: denied' }],
      statuses: () => [{ id: 'action\nissues:', status: 'failed', reason: 'failed\u0085auth: denied', eventId: 'event\u2028next' }],
    });
    expect(out.match(/^auth:/gm)).toHaveLength(1);
    expect(out.match(/^issues:/gm)).toHaveLength(1);
    expect(out.match(/^changes:/gm)).toHaveLength(1);
    expect(out).toContain('Work\\nauth: denied');
    expect(out).toContain('Cloud\\u0085service');
    expect(out).not.toMatch(/[\u0085\u2028]/);
    expect(JSON.parse(out.match(/^    reason: (.+)$/m)![1])).toBe('failed\u0085auth: denied');
    const helperError = await handleCalendarInfo(client({ 'auth-status': { ok: false, error: 'down\nauth: fullAccess' } }));
    expect(helperError.match(/^auth:/gm)).toHaveLength(1);
    expect(helperError).toContain('down\\nauth: fullAccess');
  });
});
