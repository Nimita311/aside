import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {RecurrenceMirror} from '../src/mcp/calendar/recurrence-state.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {...actual, realpathSync: vi.fn(actual.realpathSync)};
});

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('Calendar recurrence mirror ownership', () => {
  it('uses the owner-canonical root for aliases and keeps different roots separate', () => {
    const home = realpathSync(mkdtempSync('/private/tmp/aside-mirror-owner-')); directories.push(home);
    const first = join(home, 'first'), second = join(home, 'second'), alias = join(home, 'alias');
    mkdirSync(first); mkdirSync(second); symlinkSync(first, alias);
    vi.stubEnv('ASIDE_DAEMON_HOME', join(home, 'state'));
    const admittedAlias = realpathSync(alias), initial = new RecurrenceMirror(first, 'shared-id');
    initial.ordinaryEvents.set('saved', 'event'); initial.save();

    expect(new RecurrenceMirror(admittedAlias, 'shared-id').ordinaryEvents.get('saved')).toBe('event');
    expect(new RecurrenceMirror(second, 'shared-id').ordinaryEvents.size).toBe(0);
  });

  it('does not probe removed source or follow a retargeted admission alias', () => {
    const home = realpathSync(mkdtempSync('/private/tmp/aside-mirror-owner-')); directories.push(home);
    const first = join(home, 'first'), second = join(home, 'second'), alias = join(home, 'alias');
    mkdirSync(first); mkdirSync(second); symlinkSync(first, alias);
    vi.stubEnv('ASIDE_DAEMON_HOME', join(home, 'state'));
    const admittedRoot = realpathSync(alias), initial = new RecurrenceMirror(admittedRoot, 'published-id');
    initial.ordinaryEvents.set('saved', 'original-event'); initial.save();
    rmSync(first, {recursive: true}); rmSync(alias); symlinkSync(second, alias);
    const sourceProbe = vi.mocked(realpathSync); sourceProbe.mockClear();

    const restored = new RecurrenceMirror(admittedRoot, 'published-id');

    expect(restored.ordinaryEvents.get('saved')).toBe('original-event');
    expect(new RecurrenceMirror(second, 'published-id').ordinaryEvents.size).toBe(0);
    expect(sourceProbe).not.toHaveBeenCalled();
  });
});
