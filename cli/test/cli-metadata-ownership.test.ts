import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import * as client from '../src/daemon/client.js';
import {runDaemon} from '../src/commands/daemon.js';
import {runInstance} from '../src/commands/instance.js';

const directories: string[] = [];
afterEach(() => {
  access.reset(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

function fixture() {
  const home = realpathSync(mkdtempSync('/private/tmp/aside-cli-owner-')); directories.push(home);
  const root = join(home, 'source'), alias = join(home, 'unresolved-alias'); mkdirSync(root);
  writeFileSync(join(root, 'aside.md'), '---\nid: disk-ahead\nname: Disk ahead\n---\n');
  vi.stubEnv('ASIDE_DAEMON_HOME', join(home, 'state'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const metadata = {id: 'published', name: 'Published name', description: 'Published description', version: 'fixture',
    config: {scheduledEventTitlePrefix: 'Plan '}, automations: {digest: {schedule: {at: '2099-01-01T00:00:00Z'}, run: {script: 'echo'}}}};
  const rows = [{path: root, id: 'published', name: 'Published name', description: 'Published description', manifest: metadata}];
  const request = vi.fn(async (method: string) => {
    if (method === 'instances') return rows;
    if (method === 'status') return {pid: 123, build: {version: 'fixture', builtAt: 0}, connections: 1, tabs: 0,
      known: [root], loaded: [root], sessions: {[root]: 1}};
    if (method === 'known.add' || method === 'known.forget') return {known: [root], requested: [root], changed: [root]};
    throw new Error(`Unexpected request ${method}`);
  });
  const close = vi.fn();
  vi.spyOn(client, 'tryConnect').mockResolvedValue({peer: {request, close}} as unknown as client.Connection);
  access.protect([root, alias]);
  return {root, alias, metadata, rows, request, close, output};
}

describe('live CLI metadata ownership', () => {
  it('lists daemon-published instance metadata without reopening manifests', async () => {
    const f = fixture();
    await runInstance(['list', '--json']);
    const result = JSON.parse(f.output.mock.calls.at(-1)![0]);
    expect(result.data.instances).toEqual([{path: f.root, ...f.metadata}]);
    expect(f.request).toHaveBeenCalledWith('instances', {manifests: true});
    expect(f.close).toHaveBeenCalled(); expect(access.violations).toEqual([]);
  });

  it('formats daemon status from its published catalogue', async () => {
    const f = fixture();
    await runDaemon(['status', '--json']);
    const result = JSON.parse(f.output.mock.calls.at(-1)![0]);
    expect(result.data.instances).toEqual([{path: f.root, id: 'published', name: 'Published name', loaded: true, sessions: 1}]);
    expect(f.request).toHaveBeenCalledWith('instances', {paths: [f.root]});
    expect(access.violations).toEqual([]);
  });

  it('uses owner-canonical paths in edit receipts without resolving the requested alias itself', async () => {
    const f = fixture();
    await runInstance(['add', '--dir', f.alias, '--json']);
    const result = JSON.parse(f.output.mock.calls.at(-1)![0]);
    expect(result.data.results).toEqual([{path: f.root, registered: true, changed: true}]);
    expect(result.data.instances).toEqual([{path: f.root, ...f.metadata}]);
    expect(f.request).toHaveBeenCalledWith('known.add', {paths: [f.alias]});
    expect(access.violations).toEqual([]);
  });

  it('fails explicitly when the daemon omits its canonical receipt', async () => {
    const f = fixture(); f.request.mockResolvedValueOnce({known: [f.root]} as never);
    await expect(runInstance(['add', '--dir', f.alias, '--json'])).rejects.toThrow('did not return canonical instance paths');
    expect(f.close).toHaveBeenCalled(); expect(access.violations).toEqual([]);
  });
});
