import { afterEach, describe, expect, it } from 'vitest';
import {lifecycleOperationsFixture} from './lifecycle-operations-fixture.js';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/source/bootstrap.js';
import { hasGraphQLProblems } from '../src/graphql/results.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';
import {executeGraphQLWithOwner as executeGraphQL} from './graphql-owner-fixture.js';
import {lifecycleMetadataFixture} from './lifecycle-metadata-fixture.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('instance creation recovery', () => {
  it.each([false, true])('reports saved files and preserves active selection after daemon failure (active=%s)', async active => {
    const root = realpathSync(mkdtempSync('/tmp/aside-create-recovery-')); dirs.push(root);
    const previous = active ? join(root, 'previous') : null;
    if (previous) init(previous, { name: 'Previous', description: 'Previous destination' });
    let fail = true;
    const metadata = lifecycleMetadataFixture(...(previous ? [previous] : []));
    const admit = async (path: string) => {
      if ((!previous || realpathSync(path) !== realpathSync(previous)) && fail) throw new Error('Daemon connection failed');
      metadata.publish(path); return [];
    };
    const backend = lifecycleOperationsFixture({
      knownInstances: async () => previous ? [previous] : [],
      instanceRecord: metadata.instanceRecord, issues: admit, created: admit,
    });
    const registry = new InstanceRegistry(previous ? [previous] : []);
    if (previous) registry.activate(previous);
    const request = (mode: 'query' | 'mutation', document: string, variables?: Record<string, unknown>) =>
      executeGraphQL(() => { throw new Error('Unused'); }, mode, {document, variables}, {instances: new InstanceSession(registry, backend, [], false), loadedInstance: metadata.loadedInstance});
    const path = join(root, 'new-instance');
    const result = await request('mutation', 'mutation($input: CreateInstanceInput!) { createInstance(input: $input) { error instance { name path active } } }',
      { input: { path, name: 'New', description: 'New destination' } });
    expect(result.errors).toBeUndefined();
    expect(hasGraphQLProblems(result)).toBe(true);
    const { error: text, instance } = result.data.createInstance;
    expect(instance).toEqual({ name: 'New', path, active: false });
    expect(text).toContain('Created:');
    expect(text).toContain('unconfirmed');
    expect(text).toContain('Daemon connection failed');
    expect(text).toContain(`Active selection: ${previous ?? 'none'}.`);
    expect(text).toContain(`Recover with selectInstance using path: ${path}.`);
    expect(text).toContain('do not repeat createInstance');
    expect(text).not.toContain('Cannot create instance');
    expect(result.extensions.mutations[0].error).toBe(text);
    expect(existsSync(join(path, 'aside.md'))).toBe(true);
    expect((await request('query', '{ activeInstance { name } }')).data.activeInstance).toEqual(previous ? { name: 'Previous' } : null);
    fail = false;
    const selected = await request('mutation', 'mutation($path: String!) { selectInstance(path: $path) { error instance { name path active } } }', { path });
    expect(selected.data.selectInstance).toEqual({ error: null, instance: { name: 'New', path, active: true } });
    expect((await request('query', '{ activeInstance { name } }')).data.activeInstance).toEqual({ name: 'New' });
  });
});
