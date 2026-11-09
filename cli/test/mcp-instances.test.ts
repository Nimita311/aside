import { afterEach, describe, expect, it, vi } from 'vitest';
import {lifecycleOperationsFixture} from './lifecycle-operations-fixture.js';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveDataDir } from '../src/commands/mcp.js';
import {isAsideDir, readInstanceRecordResult} from '../src/core/instance.js';
import {checkoutInfo} from '../src/core/worktree.js';
import type {ParseIssue} from '../src/core/types.js';
import {instanceKey} from '../src/daemon/host.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceSession} from '../src/mcp/instance-session.js';
import {executeGraphQLWithOwner as executeGraphQL} from './graphql-owner-fixture.js';
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function instance(name: string, id = name) { const d = realpathSync(mkdtempSync('/tmp/aside-list-')); dirs.push(d); writeFileSync(join(d,'aside.md'),`---\nid: ${id}\nname: ${name}\n---\n`); return d; }
function backend(known: () => string[]) {
  const families = new Map<string, string>();
  const read = (path: string) => {
    const record = readInstanceRecordResult(path), info = checkoutInfo(path).worktree;
    families.set(path, info ? `${info.commonDir}\0${info.primaryPath}` : path);
    return record;
  };
  return lifecycleOperationsFixture({read, knownInstances: vi.fn(async () => known().map(instanceKey)), issues: vi.fn(async () => [] as ParseIssue[]),
    instanceRecord: async path => {
      const record = read(path);
      return isAsideDir(path) || record.issues.some(issue => issue.code === 'read_error') ? record : undefined;
    },
    family: path => families.get(path) ?? path});
}
// The daemon builds one session per request around the selection its client retains.
function sessions(dataDir: string | null, candidates: string[], b: ReturnType<typeof backend>, configIssues: ParseIssue[] = [], discovery = true) {
  const registry = new InstanceRegistry(dataDir ? [...candidates, dataDir] : candidates);
  if (dataDir) registry.activate(dataDir);
  const request = () => new InstanceSession(registry, b, configIssues, discovery);
  const list = async () => {
    const session = request(), rows = await session.instances(b.read);
    return {rows, messages: session.diagnostics.map(issue => issue.message).join('\n')};
  };
  return {registry, request, list};
}
const row = (name: string, path: string, active: boolean, workspace: boolean) => expect.objectContaining({name, path, active, workspace});
describe('merged instance listing', () => {
  it('surfaces unreadable workspace configuration in listings and selection without changing fallback rules', async () => {
    const local = instance('Local');
    mkdirSync(join(local, '.aside'));
    const resolution = resolveDataDir(local, []);
    expect(resolution.dataDir).toBe(local);
    expect(resolution.discovery).toBe(true);
    expect(resolution.configIssues[0]).toMatchObject({ code: 'read_error', file: '.aside' });
    const s = sessions(resolution.dataDir, resolution.candidates, backend(() => []), resolution.configIssues, resolution.discovery);
    const options = () => ({instances: s.request(), loadedInstance: readInstanceRecordResult});
    const results = [
      await executeGraphQL(() => { throw new Error('No store'); }, 'query', {document: '{ instances { path } }'}, options()),
      await executeGraphQL(() => { throw new Error('No store'); }, 'mutation', {document: 'mutation($path: String!) { selectInstance(path: $path) { error } }', variables: {path: local}}, options()),
    ];
    for (const result of results) {
      expect(result.errors).toBeUndefined();
      expect(result.extensions.complete).toBe(false);
      const text = result.extensions.diagnostics.map((issue: ParseIssue) => issue.message).join('\n');
      expect(text).toContain('Could not read .aside');
      expect(text).toContain('Configuration was not applied');
      expect(text).toContain('restart this agent session');
    }
    expect(s.request().requireInstance()).toBe(local);
    s.registry.restore({...s.registry.selection(), active: null});
    expect(() => s.request().requireInstance()).toThrow(/from the \.aside config[^]*Could not read \.aside[^]*restart this agent session/);
  });
  it('fetches the daemon catalog with no active instance and keeps global instances unselected', async () => {
    const other = instance('other'); let known = [other]; const b = backend(() => known), s = sessions(null, [], b, [], false);
    expect(await s.request().activeInstance(b.read)).toBeNull();
    expect((await s.list()).rows).toEqual([row('other', other, false, false)]);
    const added = instance('added'); known.push(added); expect((await s.list()).rows.map(info => info.path)).toEqual([other, added]); expect(b.knownInstances).toHaveBeenCalledTimes(2);
  });
  it('deduplicates symlinks by path and preserves distinct directories with duplicate IDs', async () => {
    const local = instance('Local', 'work'), other = instance('Other', 'work'); const alias = join(other,'alias'); symlinkSync(local, alias);
    const {rows, messages} = await sessions(local, [local, alias], backend(() => [alias, local, other])).list();
    expect(rows).toEqual([row('Local', local, true, true), row('Other', other, false, false)]);
    expect(messages).toContain('Duplicate instance ID detected: work');
  });
  it('does not report expected worktree copies as duplicate IDs', async () => {
    const primary = instance('Primary', 'work'), linked = `${primary}-linked`;
    dirs.push(linked);
    const git = (...args: string[]) => execFileSync('git', ['-C', primary, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'pipe' });
    git('init', '-b', 'main'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--no-gpg-sign', '-m', 'fixture');
    git('worktree', 'add', '--detach', linked);
    const {rows, messages} = await sessions(linked, [linked], backend(() => [primary, linked])).list();
    expect(rows.map(info => info.path).sort()).toEqual([primary, linked].sort());
    expect(messages).not.toContain('Duplicate instance ID');
  });
  it('selection is independent of source membership and catalog changes', async () => {
    const local = instance('Local'), other = instance('Other'); let known = [local, other]; const s = sessions(local, [local], backend(() => known));
    await s.request().selectInstance(other);
    const expected = [row('Local', local, false, true), row('Other', other, true, false)];
    expect((await s.list()).rows).toEqual(expected);
    known = []; expect((await s.list()).rows).toEqual(expected); expect(s.request().requireInstance()).toBe(other);
  });
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('omits unreadable registrations and preserves repair guidance on attempted selection', async () => {
    const workspace = instance('Workspace', 'work'), other = instance('Other', 'work'), alias = join(workspace, 'alias'); symlinkSync(other, alias);
    const b = backend(() => [workspace, alias, other]), s = sessions(null, [workspace], b);
    chmodSync(join(workspace, 'aside.md'), 0); chmodSync(join(other, 'aside.md'), 0);
    try {
      const {rows, messages} = await s.list();
      expect(rows).toEqual([]);
      expect(messages).toContain('EACCES'); expect(messages).toContain('preserving its existing id');
      expect(messages).not.toContain('Duplicate instance ID');
      await expect(s.request().selectInstance(other)).rejects.toThrow(/EACCES.*preserving its existing id/);
      expect(s.registry.activeInstance).toBeNull(); expect(b.issues).not.toHaveBeenCalled();
    } finally { chmodSync(join(workspace, 'aside.md'), 0o600); chmodSync(join(other, 'aside.md'), 0o600); }
    const repaired = await s.list(); expect(repaired.messages).toContain('Duplicate instance ID detected: work'); expect(repaired.messages).not.toContain('EACCES');
  });
  it('retains an active unreadable instance and reports repair guidance', async () => {
    const active = instance('Active', 'work'), b = backend(() => [active]), s = sessions(active, [active], b);
    rmSync(join(active, 'aside.md')); mkdirSync(join(active, 'aside.md'));
    const {rows, messages} = await s.list();
    expect(rows).toEqual([]); expect(messages).toContain('EISDIR'); expect(messages).toContain('preserving its existing id');
    expect(await s.request().activeInstance(b.read)).toMatchObject({path: active, active: true, workspace: true});
    expect(s.registry.activeInstance).toBe(active); expect(s.request().requireInstance()).toBe(active);
  });
  it('does not diagnose invalid IDs as duplicate valid identities', async () => {
    const a = instance('One', 'INVALID'), b = instance('Two', 'INVALID');
    const {rows, messages} = await sessions(null, [], backend(() => [a, b])).list();
    expect(rows.map(info => info.path)).toEqual([a, b]); expect(messages).not.toContain('Duplicate instance ID');
  });
});
