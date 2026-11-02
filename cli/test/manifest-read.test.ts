import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readManifestResult } from '../src/core/instance.js';
import { validate } from '../src/core/validator.js';
import { Store } from '../src/mcp/store.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync, storeAction } from '../src/mcp/calendar/sync.js';
import { savedEvent } from './calendar-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));

function fixture() {
  const root = mkdtempSync('/tmp/aside-manifest-read-'); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, 'aside.md'), original = '---\nid: retained-id\nname: Retained instance\n---\n';
  writeFileSync(manifest, original);
  const id = '2026-05-15-action'; mkdirSync(join(root, 'actions', '2026'), { recursive: true });
  writeFileSync(join(root, 'actions', '2026', `${id}.md`), '---\nname: Action\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work\n---\n');
  const store = new Store(root); cleanup.push(() => store.close());
  const cal = new CalClient(null); cleanup.push(() => cal.close());
  vi.spyOn(cal, 'available').mockReturnValue(true);
  const auth = vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
  const calendars = vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'local' }] });
  const list = vi.spyOn(cal, 'listEvents').mockResolvedValue({ events: [] });
  const get = vi.spyOn(cal, 'getEvents').mockResolvedValue({ events: [] });
  const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => { get.mockResolvedValue({ events: [savedEvent(args, 'retained-event')] }); return { eventId: 'retained-event' }; });
  const remove = vi.spyOn(cal, 'deleteEvent').mockResolvedValue({ deleted: true });
  const sync = new CalSync(cal, '', store); cleanup.push(() => sync.dispose());
  return { root, manifest, original, id, store, cal, sync, calls: [auth, calendars, list, get, upsert, remove], upsert, action: () => storeAction(store, id)! };
}

function manifestCheck(root: string) { return validate(root).checks.find(check => check.name === 'Instance has an aside.md manifest')!; }

describe('manifest read failures', () => {
  it('retains the established absent-manifest behavior', () => {
    const f = fixture(); rmSync(f.manifest);
    expect(readManifestResult(f.root)).toEqual({ value: { id: '' }, issues: [] });
    expect(manifestCheck(f.root)).toMatchObject({ passed: false, details: ['aside.md not found'] });
    expect(f.sync.status(f.id)).toMatchObject({ status: 'disabled', reason: 'instance has no id' });
  });

  it('reports a directory in place of the manifest with original EISDIR cause and recovers', async () => {
    const f = fixture(); rmSync(f.manifest); mkdirSync(f.manifest);
    assertReadFailure(f, 'EISDIR');
    await f.sync.syncActions([f.action()], [f.action()]); await f.sync.reconcile([f.action()]);
    for (const call of f.calls) expect(call).not.toHaveBeenCalled();
    rmSync(f.manifest, { recursive: true }); writeFileSync(f.manifest, f.original); f.store.rebuild();
    await f.sync.syncActions([], [f.action()]);
    expect(f.sync.status(f.id)).toMatchObject({ status: 'synced', eventId: 'retained-event' });
    expect(f.upsert.mock.calls[0][0].marker).toBe(`aside://retained-id/action/${f.id}`);
    expect(f.sync.failureDiagnostics()).toEqual([]); expect(f.store.getIssues()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('exposes real EACCES through Store, host, validation and sync without helper calls', async () => {
    const f = fixture();
    // A cached Store must not allow use after the manifest loses access.
    vi.mocked(f.cal.available).mockReturnValue(false);
    const host = new InstanceHost(f.cal); cleanup.push(() => host.close()); host.load(f.root);
    vi.mocked(f.cal.available).mockReturnValue(true);
    chmodSync(f.manifest, 0);
    try {
      expect(() => readFileSync(f.manifest)).toThrow(/EACCES/);
      assertReadFailure(f, 'EACCES');
      expect(() => host.load(f.root)).toThrow(/EACCES.*preserving its existing id/);
      expect(() => host.issues(f.root)).toThrow(/EACCES/);
      await f.sync.syncActions([f.action()], [f.action()]); await f.sync.reconcile([f.action()]);
      for (const call of f.calls) expect(call).not.toHaveBeenCalled();
    } finally { chmodSync(f.manifest, 0o600); }
    f.store.rebuild(); await f.sync.syncActions([], [f.action()]);
    expect(f.sync.status(f.id)).toMatchObject({ status: 'synced', eventId: 'retained-event' });
    expect(readFileSync(f.manifest, 'utf8')).toBe(f.original);
    expect(f.upsert.mock.calls[0][0].marker).toBe(`aside://retained-id/action/${f.id}`);
    expect(manifestCheck(f.root).passed).toBe(true); expect(f.sync.failureDiagnostics()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves a confirmed event identity across a transient read failure and same-id repair', async () => {
    const f = fixture(); await f.sync.syncActions([f.action()], [f.action()]);
    expect(f.sync.status(f.id)?.status).toBe('synced');
    for (const call of f.calls) call.mockClear();
    chmodSync(f.manifest, 0);
    try {
      await f.sync.syncActions([f.action()], [f.action()]); await f.sync.reconcile([f.action()]);
      expect(f.sync.status(f.id)?.reason).toContain('EACCES');
      for (const call of f.calls) expect(call).not.toHaveBeenCalled();
    } finally { chmodSync(f.manifest, 0o600); }
    await f.sync.syncActions([], [f.action()]);
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.upsert.mock.calls[0][0]).toMatchObject({ eventId: 'retained-event', marker: `aside://retained-id/action/${f.id}` });
    expect(f.sync.status(f.id)).toMatchObject({ status: 'synced', eventId: 'retained-event' });
    expect(f.sync.report()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('retries saved-event confirmation without another upsert after a readback-time manifest failure', async () => {
    const f = fixture(), get = vi.mocked(f.cal.getEvents);
    get.mockImplementationOnce(async args => {
      const result = await get.getMockImplementation()!(args);
      chmodSync(f.manifest, 0);
      return result;
    });
    try {
      await f.sync.syncActions([f.action()], [f.action()]);
      expect(f.upsert).toHaveBeenCalledOnce();
      expect(f.sync.status(f.id)).toMatchObject({ status: 'disabled', reason: expect.stringContaining('EACCES') });
    } finally { chmodSync(f.manifest, 0o600); }
    await f.sync.syncActions([], [f.action()]);
    expect(f.upsert).toHaveBeenCalledOnce(); expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1][0]).toEqual({ eventIds: ['retained-event'] });
    expect(f.sync.status(f.id)).toMatchObject({ status: 'synced', eventId: 'retained-event' });
    expect(readFileSync(f.manifest, 'utf8')).toBe(f.original);
  });

  it.each(['capture', 'update_action', 'update_entry'] as const)('%s rejects a cached instance with an unreadable manifest before writing records', async method => {
    const f = fixture(), h = await receiptHost(f, method);
    const actions = h.loaded.store.getActionIds();
    const entries = h.loaded.store.getEntries().map(entry => entry.meta.created);
    const originalAction = readFileSync(join(f.root, 'actions', '2026', `${f.id}.md`), 'utf8');
    rmSync(f.manifest); mkdirSync(f.manifest);
    await expect(h.mutate(true)).rejects.toThrow(/EISDIR.*preserving its existing id/);
    expect(h.loaded.store.getActionIds()).toEqual(actions);
    expect(h.loaded.store.getEntries().map(entry => entry.meta.created)).toEqual(entries);
    expect(readFileSync(join(f.root, 'actions', '2026', `${f.id}.md`), 'utf8')).toBe(originalAction);
    for (const call of f.calls) expect(call).not.toHaveBeenCalled();
    rmSync(f.manifest, { recursive: true }); writeFileSync(f.manifest, f.original);
    const result = await h.mutate(true);
    expect(result.text).toContain(method === 'capture' ? 'actions_created:' : 'updated:');
    expect(readFileSync(f.manifest, 'utf8')).toBe(f.original);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects an EACCES mutation and resumes with the original identity after repair', async () => {
    const f = fixture(), h = await receiptHost(f, 'update_action'); chmodSync(f.manifest, 0);
    try {
      await expect(h.mutate(true)).rejects.toThrow(/EACCES.*preserving its existing id/);
      for (const call of f.calls) expect(call).not.toHaveBeenCalled();
    } finally { chmodSync(f.manifest, 0o600); }
    expect((await h.mutate(true)).text).toContain('updated:');
    await h.host.flush();
    expect(f.upsert.mock.calls[0][0].marker).toBe(`aside://retained-id/action/${f.id}`);
    expect(readFileSync(f.manifest, 'utf8')).toBe(f.original);
  });

  it('does not repeat a missing-ID hint after the live manifest is repaired ahead of its Store snapshot', async () => {
    const f = fixture(), h = await receiptHost(f, 'update_action');
    rmSync(f.manifest); mkdirSync(f.manifest); h.loaded.store.rebuild(); expect(h.loaded.store.getManifest().id).toBe('');
    rmSync(f.manifest, { recursive: true }); writeFileSync(f.manifest, f.original);
    const result = await h.mutate(false);
    expect(result.text).toContain('updated:'); expect(result.text).not.toContain('has no `id`'); expect(result.text).not.toContain('Add an `id`');
    await h.host.flush(); expect(h.loaded.sync.status(f.id)?.status).toBe('synced');
    expect(f.upsert.mock.calls[0][0].marker).toBe(`aside://retained-id/action/${f.id}`);
  });

  it('retains missing-ID guidance when the readable manifest actually has no identity', async () => {
    const f = fixture(), h = await receiptHost(f, 'update_action'); writeFileSync(f.manifest, '---\nname: Legacy\n---\n');
    const result = await h.mutate(true);
    expect(result.text).toContain('has no `id`'); expect(result.text).toContain('Add an `id`'); expect(result.text).toContain('reason: "instance has no id"');
    for (const call of f.calls) expect(call).not.toHaveBeenCalled();
  });
});

async function receiptHost(f: ReturnType<typeof fixture>, method: 'capture' | 'update_action' | 'update_entry') {
  vi.mocked(f.cal.available).mockReturnValue(false);
  const host = new InstanceHost(f.cal); cleanup.push(() => host.close()); const loaded = host.load(f.root);
  let entryId = '';
  if (method === 'update_entry') {
    const seed = await host.tool(f.root, 'capture', { content: 'Seed content', description: 'Seed summary' });
    entryId = seed.text.match(/^entry: (.+)$/m)![1];
  }
  await host.flush(); vi.mocked(f.cal.available).mockReturnValue(true);
  const action = { name: 'Receipt action', description: 'Receipt summary', scheduled: '2026-05-15T11:00', calendar: 'Work' };
  const args = method === 'update_action' ? { id: f.id, name: action.name }
    : method === 'capture' ? { content: 'Saved content', description: 'Saved summary', actions: [action] }
    : { id: entryId, content: 'Revised content', actions: [action] };
  return { host, loaded, mutate: (issues: boolean) => host.tool(f.root, method, args, issues) };
}

function assertReadFailure(f: ReturnType<typeof fixture>, code: string): void {
  const result = readManifestResult(f.root);
  expect(result.value).toEqual({ id: '' });
  expect(result.issues).toEqual([expect.objectContaining({ severity: 'error', code: 'read_error', file: 'aside.md' })]);
  expect(result.issues[0].message).toContain(code); expect(result.issues[0].message).toContain(f.manifest);
  expect(result.issues[0].message).toContain('preserving its existing id');
  f.store.rebuild(); expect(f.store.getIssues()).toContainEqual(result.issues[0]);
  expect(manifestCheck(f.root)).toMatchObject({ passed: false, details: [result.issues[0].message] });
  expect(f.sync.status(f.id)).toMatchObject({ status: 'disabled', reason: result.issues[0].message, diagnostic: { category: 'instance-manifest-read-error' } });
  expect(f.sync.report()).toContainEqual({ id: 'instance', reason: result.issues[0].message });
  expect(f.sync.failureDiagnostics()).toContainEqual({ id: 'instance', diagnostic: expect.objectContaining({ category: 'instance-manifest-read-error', reason: result.issues[0].message }) });
}
