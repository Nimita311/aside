import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutInfo, instanceFamily, withPrimaryInstances, withoutInstanceFamilies, worktreeCalendarReason } from '../src/core/worktree.js';
import { parseConfig } from '../src/core/parser.js';
import { availableInstances, resolveInstanceAddress } from '../src/web/catalogue.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { storeAction } from '../src/mcp/calendar/sync.js';
import { savedEvent } from './calendar-fixture.js';
import { instanceIdClashChecks } from '../src/commands/instance-checks.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });

function fixture(primaryName = 'primary', linkedName = 'linked') {
  const root = realpathSync(mkdtempSync('/tmp/aside-worktree-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const primaryRoot = join(root, primaryName), linkedRoot = join(root, linkedName);
  const primary = join(primaryRoot, 'data'), linked = join(linkedRoot, 'data');
  mkdirSync(primary, { recursive: true });
  writeFileSync(join(primary, 'aside.md'), '---\nid: shared\nname: Shared\n---\n');
  const id = '2026-05-15-action';
  mkdirSync(join(primary, 'actions', '2026'), { recursive: true });
  writeFileSync(join(primary, 'actions', '2026', `${id}.md`), '---\nname: Action\ncreated: 2026-05-15T09:00\nscheduled: 2026-05-15T10:00\ncalendar: Work\n---\nPrimary content\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', primaryRoot, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'pipe' });
  git('init', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--no-gpg-sign', '-m', 'fixture');
  git('worktree', 'add', '--detach', linkedRoot);
  return { root, primaryRoot, linkedRoot, primary, linked, id, git };
}

describe('Git worktree identity', () => {
  it('forgets a primary with its counterparts, but keeps siblings when forgetting a worktree', () => {
    const f = fixture(), other = join(f.root, 'independent'); mkdirSync(other);
    writeFileSync(join(other, 'aside.md'), readFileSync(join(f.primary, 'aside.md')));
    expect(withoutInstanceFamilies([f.primary, f.linked, other], [f.primary])).toEqual([other]);
    expect(withoutInstanceFamilies([f.primary, f.linked, other], [f.linked])).toEqual([f.primary, other]);
    writeFileSync(join(f.linked, 'aside.md'), '---\nid: separate\n---\n');
    expect(withoutInstanceFamilies([f.primary, f.linked], [f.primary])).toEqual([f.linked]);
  });
  it('detects nested, detached worktrees and reserves the bare address for primary', () => {
    const f = fixture();
    expect(checkoutInfo(f.linked).worktree).toMatchObject({ linked: true, primaryPath: f.primary, label: expect.stringContaining('Detached') });
    expect(instanceFamily(f.primary)).toBe(instanceFamily(f.linked));
    const rows = availableInstances(withPrimaryInstances([f.linked]));
    expect(rows).toHaveLength(2);
    const primary = rows.find(row => row.path === f.primary)!, linked = rows.find(row => row.path === f.linked)!;
    expect(primary.address).toBe('shared'); expect(linked.address).toBe(linked.alias);
    expect(resolveInstanceAddress(rows, 'shared')?.path).toBe(f.primary);
    expect(resolveInstanceAddress(rows, primary.alias!)?.path).toBe(f.primary);
    expect(resolveInstanceAddress(rows, linked.alias!)?.path).toBe(f.linked);
    expect(rows.every(row => !row.duplicatePaths && !row.error)).toBe(true);
    expect(instanceIdClashChecks(rows)).toEqual([]);
    const alias = join(f.root, 'alias'); symlinkSync(f.linked, alias);
    expect(availableInstances([alias])[0].alias).toBe(linked.alias);
  });

  it('retains real collisions and still gives every directory a browsable address', () => {
    const f = fixture(), other = join(f.root, 'independent'); mkdirSync(other);
    writeFileSync(join(other, 'aside.md'), readFileSync(join(f.primary, 'aside.md')));
    const rows = availableInstances([f.primary, f.linked, other]);
    expect(resolveInstanceAddress(rows, 'shared')).toBeUndefined();
    for (const row of rows) {
      expect(row.error).toBeUndefined(); expect(row.calendarWarning).toContain('Calendar sync is paused');
      expect(resolveInstanceAddress(rows, row.alias!)?.path).toBe(row.path);
    }
    expect(instanceIdClashChecks(rows)).toHaveLength(1);
  });

  it('preserves newlines and trailing spaces in checkout paths', () => {
    const f = fixture('primary\ncheckout ', 'linked\ncheckout ');
    expect(checkoutInfo(f.linked).worktree).toMatchObject({ root: f.linkedRoot, linked: true, primaryPath: f.primary });
    expect(instanceFamily(f.primary)).toBe(instanceFamily(f.linked));
  });

  it('reads policy from the primary repository root when its instance is a symlink', () => {
    const f = fixture(), target = join(f.root, 'external');
    mkdirSync(target); writeFileSync(join(target, 'aside.md'), readFileSync(join(f.primary, 'aside.md')));
    rmSync(f.primary, { recursive: true }); symlinkSync(target, f.primary);
    writeFileSync(join(f.primaryRoot, '.aside'), 'worktreeDetection: false\n');
    expect(checkoutInfo(f.linked)).toEqual({});
  });

  it('keeps a linked instance usable when its primary counterpart is absent without taking the bare ID', () => {
    const f = fixture(); rmSync(f.primary, { recursive: true });
    const rows = availableInstances([f.linked]);
    expect(rows).toHaveLength(1); expect(rows[0].error).toBeUndefined();
    expect(rows[0].address).toBe(rows[0].alias);
    expect(resolveInstanceAddress(rows, 'shared')).toBeUndefined();
    expect(resolveInstanceAddress(rows, rows[0].alias!)?.path).toBe(f.linked);
    expect(worktreeCalendarReason(f.linked)).toContain('primary checkout');
  });

  it('does not group different relative instance paths or manifests with different IDs', () => {
    const f = fixture(), other = join(f.linkedRoot, 'other'); mkdirSync(other);
    writeFileSync(join(other, 'aside.md'), '---\nid: shared\n---\n');
    expect(availableInstances([f.primary, other]).every(row => row.duplicatePaths)).toBe(true);
    writeFileSync(join(f.linked, 'aside.md'), '---\nid: different\n---\n');
    expect(availableInstances([f.primary, f.linked]).every(row => !row.duplicatePaths)).toBe(true);
    expect(worktreeCalendarReason(f.linked)).toContain('Git worktree');
  });

  it('does not group a nested repository with a copy belonging to its outer repository', () => {
    const f = fixture();
    execFileSync('git', ['-C', f.primary, 'init', '-b', 'nested'], { stdio: 'pipe' });
    expect(instanceFamily(f.primary)).not.toBe(instanceFamily(f.linked));
    expect(availableInstances([f.primary, f.linked]).every(row => row.duplicatePaths)).toBe(true);
  });

  it('reads the opt-out from primary .aside even when the linked copy disagrees', () => {
    const f = fixture();
    writeFileSync(join(f.linkedRoot, '.aside'), 'worktreeDetection: false\n');
    expect(checkoutInfo(f.linked).worktree?.linked).toBe(true);
    writeFileSync(join(f.primaryRoot, '.aside'), 'worktreeDetection: false\n');
    expect(checkoutInfo(f.linked)).toEqual({}); expect(worktreeCalendarReason(f.linked)).toBeNull();
    expect(availableInstances([f.primary, f.linked]).every(row => row.duplicatePaths)).toBe(true);
    expect(parseConfig('worktreeDetection: false').value.worktreeDetection).toBe(false);
    writeFileSync(join(f.primaryRoot, '.aside'), 'worktreeDetection: invalid\n');
    expect(worktreeCalendarReason(f.linked)).toContain('Invalid worktreeDetection');
    writeFileSync(join(f.primaryRoot, '.aside'), 'worktreeDetection: false\n  broken: [\n');
    expect(worktreeCalendarReason(f.linked)).toContain('Invalid worktreeDetection');
  });

  it('syncs primary only, including retries, deletes, reverse writes and independent collisions', async () => {
    const f = fixture(), cal = new CalClient(null);
    vi.spyOn(cal, 'available').mockReturnValue(true);
    vi.spyOn(cal, 'authStatus').mockResolvedValue({ status: 'fullAccess' });
    vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'work', name: 'Work', account: 'iCloud', writable: true, type: 'caldav' }] });
    let event = savedEvent({ marker: `aside://shared/action/${f.id}`, calendar: 'Work', title: '▢ Action', start: '2026-05-15T10:00', end: '2026-05-15T10:30', durationMinutes: 30 });
    vi.spyOn(cal, 'listEvents').mockImplementation(async () => ({ events: [event] }));
    const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => { event = savedEvent(args); return { eventId: 'event' }; });
    vi.spyOn(cal, 'getEvents').mockImplementation(async () => ({ events: event ? [event] : [] }));
    const remove = vi.spyOn(cal, 'deleteEvent').mockResolvedValue({ deleted: true });
    const host = new InstanceHost(cal); cleanup.push(() => host.close());
    let known = [f.primary, f.linked]; host.setKnownPaths(() => known);
    const linked = host.load(f.linked); await host.flush();
    const primary = host.load(f.primary), primaryAction = storeAction(primary.store, f.id)!;
    await primary.sync.syncActions([primaryAction], [primaryAction]);
    expect(primary.sync.status(f.id)).toMatchObject({ status: 'synced' });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0].marker).toBe(`aside://shared/action/${f.id}`);
    expect(host.issues(f.primary).some(issue => issue.code === 'instance_id_conflict')).toBe(false);
    const action = storeAction(linked.store, f.id)!;
    const original = readFileSync(join(f.linked, 'actions', '2026', `${f.id}.md`), 'utf8');
    upsert.mockClear(); remove.mockClear(); vi.mocked(cal.listEvents).mockClear();
    await linked.sync.syncActions([action], [action]);
    await linked.sync.syncActions([], [action]);
    await linked.sync.syncActions([{ ...action, frontMatter: { ...action.frontMatter, scheduled: undefined } }], []);
    await linked.sync.reconcile([action]); await host.flush();
    expect(upsert).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(cal.listEvents).not.toHaveBeenCalled();
    expect(linked.sync.status(f.id)).toMatchObject({ status: 'disabled', reason: expect.stringContaining('primary checkout') });
    expect(readFileSync(join(f.linked, 'actions', '2026', `${f.id}.md`), 'utf8')).toBe(original);
    const other = join(f.root, 'copy'); mkdirSync(other); writeFileSync(join(other, 'aside.md'), '---\nid: shared\n---\n');
    known.push(other); host.refreshIdentities(); await host.flush();
    expect(host.load(f.primary).sync.status(f.id)?.status).toBe('disabled'); expect(upsert).not.toHaveBeenCalled();
  });
});
