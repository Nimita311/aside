import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutomationView, executionView, type AutomationNode, type AutomationOwner } from '../src/graphql/automations.js';
import type { AutomationJobRuntime, AutomationRunRuntime, AutomationRuntimeSnapshot } from '../src/graphql/automation-runtime.js';
import type { ParseIssue } from '../src/core/types.js';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';
import { executeGraphQL } from '../src/graphql/schema.js';

const root = '/instance';
const definition = { schedule: { cron: '0 8 * * *', timezone: 'UTC' }, run: { script: 'echo', args: ['hello'] } };
const scriptOwner: AutomationOwner = { declarations: { daily: definition }, filePath: join(root, 'aside.md') };
function job(name: string, projectId?: string, overrides: Partial<AutomationJobRuntime> = {}): AutomationJobRuntime {
  const definedIn = projectId ? `#project/${projectId}` : 'instance fixture';
  return { name, key: JSON.stringify([root, definedIn, name]), definedIn,
    scope: projectId ? 'project' : 'instance', ...(projectId ? { projectId } : {}), running: false, warnings: [], ...overrides };
}
function run(id: string, name = 'daily', projectId?: string, overrides: Partial<AutomationRunRuntime> = {}): AutomationRunRuntime {
  return { ...job(name, projectId), id, status: 'succeeded', occurrence: '2026-10-10T08:00:00.000Z',
    started: '2026-10-10T08:00:00.000Z', finished: '2026-10-10T08:00:01.000Z', latenessMs: 0,
    stdoutLog: `/runs/bucket/${id}/stdout.log`, stderrLog: `/runs/bucket/${id}/stderr.log`, ...overrides };
}
function fixture(snapshot: Partial<AutomationRuntimeSnapshot> = {}) {
  const diagnostics: ParseIssue[] = [];
  const runtime = vi.fn(async () => ({ available: true, jobs: [], runs: [], ...snapshot }));
  const output = vi.fn(async () => null);
  return { diagnostics, runtime, output, view: new AutomationView(root, { runtime, output, diagnostics }) };
}
async function observed(node: AutomationNode) {
  const [next, running] = await Promise.all([node.next(), node.running()]);
  return {...node, next, running};
}

describe('owner-scoped automation declarations', () => {
  it('keeps instance and project jobs independent when names match', async () => {
    const { view } = fixture({ jobs: [job('daily', undefined, { running: true, next: 'instance-next' }),
      job('daily', 'first', { running: false, next: 'first-next' }), job('daily', 'second', { next: 'second-next' })] });
    expect(await observed((await view.list(scriptOwner)).nodes[0])).toMatchObject({ name: 'daily', running: true, next: 'instance-next' });
    expect(await observed((await view.list({ ...scriptOwner, projectId: 'first' })).nodes[0])).toMatchObject({ running: false, next: 'first-next' });
    expect(await observed((await view.list({ ...scriptOwner, projectId: 'second' })).nodes[0])).toMatchObject({ next: 'second-next' });
  });

  it('returns only persisted declarations, with defaults, rather than retained scheduler jobs', async () => {
    const { view } = fixture({ jobs: [job('daily'), job('removed')] });
    const page = await view.list(scriptOwner);
    expect(page).toMatchObject({ offset: 0, count: 1, totalCount: 1 });
    expect(await observed(page.nodes[0])).toMatchObject({ schedule: definition.schedule, run: definition.run,
      enabled: true, timeout: 'PT30M', overlap: 'latest', running: false, next: null });
    expect(Object.keys(page.nodes[0]).sort()).toEqual(['enabled', 'log', 'name', 'next', 'overlap', 'run', 'running', 'schedule', 'timeout']);
    expect(await view.list({ declarations: {} })).toEqual({ nodes: [], offset: 0, count: 0, totalCount: 0 });
  });

  it('keeps persisted enabled independent of effective scheduler restrictions', async () => {
    const { view } = fixture({ jobs: [job('daily', 'closed', { enabled: false, blocked: true })] });
    expect(await observed((await view.list({ ...scriptOwner, projectId: 'closed' })).nodes[0])).toMatchObject({ enabled: true, running: false });
    expect((await view.list({ declarations: { daily: { ...definition, enabled: false, timeout: 'PT10M', overlap: 'skip' } } })).nodes[0])
      .toMatchObject({ enabled: false, timeout: 'PT10M', overlap: 'skip' });
  });

  it('distinguishes unavailable observations from observed idle state', async () => {
    expect(await observed((await fixture({ available: false, jobs: [job('daily', undefined, { running: true, next: 'stale' })] }).view.list(scriptOwner)).nodes[0]))
      .toMatchObject({ next: null, running: null, enabled: true });
    expect(await observed((await fixture().view.list(scriptOwner)).nodes[0])).toMatchObject({ next: null, running: null });
  });

  it('retains malformed declarations for repair and reports source diagnostics', async () => {
    const { view, diagnostics, runtime } = fixture();
    const page = await view.list({ declarations: { malformed: { schedule: { cron: 'invalid' }, run: { script: 'echo' } }, null: null }, filePath: '/project.md' });
    expect(page).toMatchObject({ count: 2, totalCount: 2 });
    expect(page.nodes[0]).toMatchObject({ name: 'malformed', schedule: null, run: null, enabled: null, timeout: null, overlap: null });
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'invalid_automation', field: 'automations.malformed', file: '/project.md' }),
      expect.objectContaining({ severity: 'error', code: 'invalid_automation', field: 'automations.null', file: '/project.md' }),
    ]);
    expect(runtime).not.toHaveBeenCalled();
  });

  it('keeps saved model selections readable while resolving instruction artifacts only when selected', async () => {
    const artifact = {kind: 'artifact', id: 'context'};
    const resolveArtifactPrompt = vi.fn(() => artifact);
    const owner = { declarations: { digest: { schedule: { at: '2026-11-01T12:00:00Z' },
      run: { model: 'RETIRED_SELECTION', prompt: '#artifact/2026-10-08-context' } } }, projectId: 'owner', filePath: '/owner.md' };
    const view = new AutomationView(root, {runtime: async () => ({available: true, jobs: [], runs: []}), diagnostics: [], resolveArtifactPrompt});
    const page = await view.list(owner);
    expect(resolveArtifactPrompt).not.toHaveBeenCalled();
    const execution = page.nodes[0].run;
    expect(execution).toMatchObject({model: 'RETIRED_SELECTION'});
    if (!execution || !('prompt' in execution)) throw new Error('Expected model execution');
    expect(execution.prompt()).toBe(artifact);
    expect(execution.prompt()).toBe(artifact);
    expect(resolveArtifactPrompt).toHaveBeenCalledOnce();
    expect(resolveArtifactPrompt).toHaveBeenCalledWith('#artifact/2026-10-08-context', owner, 'digest');
    expect(owner.declarations.digest.run.prompt).toEqual('#artifact/2026-10-08-context');
  });

  it('diagnoses invalid saved prompts without resolving them or exposing configuration', async () => {
    const resolveArtifactPrompt = vi.fn(() => null);
    const diagnostics: ParseIssue[] = [];
    const view = new AutomationView(root, {runtime: async () => ({available: true, jobs: [], runs: []}), diagnostics, resolveArtifactPrompt});
    const page = await view.list({declarations: {legacy: {schedule: definition.schedule, run: {model: 'RETIRED_SELECTION', prompt: 'Saved instructions'}}}});
    expect(page.nodes[0]).toMatchObject({run: null, schedule: null, timeout: null});
    expect(resolveArtifactPrompt).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([expect.objectContaining({code: 'invalid_automation', field: 'automations.legacy'})]);
  });

  it('observes next and running only when requested, sharing one observation for the node', async () => {
    const {view, runtime} = fixture({jobs: [job('daily', undefined, {next: '2026-10-11T08:00:00Z', running: true})]});
    const node = (await view.list(scriptOwner)).nodes[0];
    expect(runtime).not.toHaveBeenCalled();
    expect(await observed(node)).toMatchObject({next: '2026-10-11T08:00:00Z', running: true});
    expect(runtime).toHaveBeenCalledTimes(1);
  });

  it('orders names consistently, filters before counts, and reports actual page size', async () => {
    const { view } = fixture();
    const owner = { declarations: { z: definition, a: definition, m: definition } };
    expect((await view.list(owner, { offset: 1, limit: 1 })).nodes.map(node => node.name)).toEqual(['m']);
    expect(await view.list(owner, { where: { name: 'z' }, limit: 100 })).toMatchObject({ count: 1, totalCount: 1, nodes: [{ name: 'z' }] });
    expect(await view.list(owner, { offset: 8, limit: 2 })).toEqual({ offset: 8, count: 0, totalCount: 3, nodes: [] });
  });

  it('rejects invalid ranges before runtime inspection and observes cancellation', async () => {
    const { view, runtime } = fixture();
    await expect(view.list(scriptOwner, { offset: -1 })).rejects.toThrow('offset');
    await expect(view.list(scriptOwner, { limit: 101 })).rejects.toThrow('limit');
    expect(runtime).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    const cancelled = new AutomationView(root, { runtime, diagnostics: [], signal: controller.signal });
    await expect(cancelled.list(scriptOwner)).rejects.toThrow('cancelled');
  });
});

describe('retained automation history', () => {
  it('keeps instance, project, and job histories within their owner', async () => {
    const { view } = fixture({ runs: [run('instance'), run('first', 'daily', 'first'), run('other-name', 'other', 'first'), run('second', 'daily', 'second')] });
    expect((await view.log()).totalCount).toBe(1);
    expect((await view.log({ projectId: 'first' })).totalCount).toBe(2);
    expect((await view.log({})).nodes.map(node => node.id)).toEqual(['instance']);
    const automation = (await view.list({ ...scriptOwner, projectId: 'first' })).nodes[0];
    expect((await automation.log({})).nodes.map(node => node.id)).toEqual(['first']);
  });

  it('retains names and file paths after declaration removal without public ownership metadata', async () => {
    const { view } = fixture({ runs: [run('deleted', 'removed', 'deleted-project')] });
    const retained = (await view.log({ projectId: 'deleted-project' })).nodes[0];
    expect(retained).toMatchObject({ name: 'removed', filePath: '/runs/bucket/deleted/run.json' });
    expect(await retained.automation()).toBeNull();
    expect(retained).not.toHaveProperty('key'); expect(retained).not.toHaveProperty('definedIn'); expect(retained).not.toHaveProperty('projectId');
    expect(retained).not.toHaveProperty('scope'); expect(retained).not.toHaveProperty('projectIdAtLaunch'); expect(retained).not.toHaveProperty('project');
    expect((await view.log()).totalCount).toBe(0);
    expect((await view.log({ projectId: 'deleted-project' })).totalCount).toBe(1);
  });

  it('resolves only a current declaration with the matching owner', async () => {
    const owner = { ...scriptOwner, projectId: 'current' };
    const view = new AutomationView(root, { diagnostics: [], runtime: async () => ({ available: true, jobs: [], runs: [run('project', 'daily', 'current'), run('instance')] }),
      projectOwner: id => id === 'current' ? owner : null, instanceOwner: () => scriptOwner });
    const first = (await view.log({projectId: 'current'})).nodes[0];
    const second = (await view.log()).nodes[0];
    expect((await first.automation())?.name).toBe('daily');
    expect((await second.automation())?.name).toBe('daily');
    owner.declarations = {};
    expect(await first.automation()).toBeNull();
  });

  it('filters before pagination and deterministically orders newest timestamps and IDs', async () => {
    const { view } = fixture({ runs: [run('a'), run('z'), run('older', 'daily', undefined, { started: '2026-10-09T00:00:00Z' }),
      run('failed', 'other', undefined, { status: 'failed' })] });
    const page = await view.log(undefined, { where: { name: 'daily', status: ['succeeded'] }, offset: 1, limit: 1 });
    expect(page).toMatchObject({ offset: 1, count: 1, totalCount: 3, nodes: [{ id: 'a' }] });
    expect((await view.log(undefined, { where: { id: 'failed', status: ['failed', 'timed_out'] } })).nodes.map(node => node.id)).toEqual(['failed']);
    expect((await view.log(undefined, { where: { status: [] } })).totalCount).toBe(0);
  });

  it('rejects foreign or inconsistent immutable job identities', async () => {
    const foreign = run('foreign', 'daily', undefined, { key: JSON.stringify(['/other', 'instance fixture', 'daily']) });
    const malformed = run('malformed', 'daily', undefined, { key: 'not-json' });
    const mismatched = run('mismatched', 'daily', undefined, { key: JSON.stringify([root, 'instance fixture', 'other']) });
    const { view } = fixture({ runs: [foreign, malformed, mismatched, run('valid')], jobs: [job('daily', undefined, { key: foreign.key, running: true })] });
    expect((await view.log()).nodes.map(node => node.id)).toEqual(['valid']);
    expect(await (await view.list(scriptOwner)).nodes[0].running()).toBeNull();
  });

  it('keeps history readable while scheduling observation is unavailable', async () => {
    const { view } = fixture({ available: false, warning: 'daemon stopped', runs: [run('retained')] });
    expect((await view.log()).nodes.map(node => node.id)).toEqual(['retained']);
  });

  it('delegates bounded output ranges to the selected instance adapter', async () => {
    const { view, output } = fixture({ runs: [run('one')] });
    const node = (await view.log()).nodes[0];
    expect(await node.output({ stream: 'stdout' })).toBeNull();
    expect(output).toHaveBeenCalledWith('one', 'stdout', 0, 16384);
    await node.output({ stream: 'stderr', offset: 10, limit: 4 });
    expect(output).toHaveBeenLastCalledWith('one', 'stderr', 10, 4);
    expect(() => node.output({ stream: 'stdout', limit: 65537 })).toThrow('limit');
    expect(() => node.output({ stream: 'stdout', offset: -1 })).toThrow('offset');
    expect(() => node.output({ stream: '../private' as any })).toThrow('stream');
    expect(output).toHaveBeenCalledTimes(2);
  });
});

describe('instance execution view', () => {
  let temporary: string | undefined;
  afterEach(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); temporary = undefined; });

  it('discovers models only when selected, forwarding refresh and diagnostic messages', async () => {
    temporary = realpathSync(mkdtempSync('/tmp/aside-graphql-automations-'));
    mkdirSync(join(temporary, 'work'));
    writeFileSync(join(temporary, '.aside'), 'execution:\n  cwd: work\n');
    const diagnostics: ParseIssue[] = [];
    const models = [{ name: 'custom', label: 'Custom', builtin: false, availability: 'AVAILABLE' as const }];
    const catalog = vi.fn(async () => ({ models, diagnostics: ['Model discovery delayed'], revision: '1' }));
    const execution = executionView(temporary, { diagnostics, catalog });
    expect(execution.filePath).toBe(join(temporary, '.aside'));
    expect(execution.cwd()).toBe(join(temporary, 'work'));
    expect(catalog).not.toHaveBeenCalled();
    expect(await execution.models()).toEqual(models);
    expect(await execution.models({ refresh: true })).toEqual(models);
    expect(catalog.mock.calls).toEqual([[false], [true]]);
    expect(diagnostics[0]).toMatchObject({ code: 'model_discovery', file: execution.filePath, message: 'Model discovery delayed' });
  });

  it('reports execution config errors without losing the expected repair path', () => {
    temporary = realpathSync(mkdtempSync('/tmp/aside-graphql-automations-'));
    writeFileSync(join(temporary, '.aside'), 'execution:\n  cwd: missing\n');
    const diagnostics: ParseIssue[] = [];
    const execution = executionView(temporary, { diagnostics });
    expect(execution.cwd()).toBeNull();
    expect(diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'execution_config', file: execution.filePath })]);
  });
});

describe('GraphQL automation owner relationships', () => {
  it('reads model declarations without loading records or resolving prompt artifacts', async () => {
    const temporary = realpathSync(mkdtempSync('/tmp/aside-graphql-automation-model-metadata-'));
    init(temporary, {name: 'Owner', description: 'Fixture'});
    const store = new Store(temporary);
    try {
      handleUpdateInstance(store, {automations: {digest: {schedule: definition.schedule,
        run: {model: 'RETIRED_SELECTION', prompt: '#artifact/2026-10-10-instructions'}}}});
      const registry = new InstanceRegistry([temporary]); registry.activate(temporary);
      const session = new InstanceSession(registry, {knownInstances: async () => [temporary], issues: async () => []}, [], false, true);
      const load = vi.fn((): Store => {throw new Error('Declaration metadata must not load records');});
      const runtime = vi.fn(async (): Promise<AutomationRuntimeSnapshot> => {throw new Error('Declaration metadata must not observe runtime');});
      const result = await executeGraphQL(load, 'query', {document: '{activeInstance {automations {totalCount nodes {name run {model}}}}}'},
        {instances: session, automationRuntime: runtime});
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({activeInstance: {automations: {totalCount: 1, nodes: [{name: 'digest', run: {model: 'RETIRED_SELECTION'}}]}}});
      expect(result.extensions).toMatchObject({complete: true, diagnostics: []});
      expect(load).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled();
    } finally {store.close(); rmSync(temporary, {recursive: true, force: true});}
  });

  it('keeps declarations and counts independent of runtime, then shares observations across selected fields', async () => {
    const temporary = realpathSync(mkdtempSync('/tmp/aside-graphql-automation-lazy-'));
    init(temporary, {name: 'Owner', description: 'Fixture'});
    const store = new Store(temporary);
    const runtime = vi.fn(async (): Promise<AutomationRuntimeSnapshot> => { throw new Error('Observation unavailable'); });
    try {
      handleUpdateInstance(store, {automations: {daily: definition}});
      const projectId = handleCapture(store, {content: 'Context', description: 'Context', projects: [{
        name: 'Project', description: 'Project', automations: {daily: definition},
      }]}, new Date('2026-10-10T08:00:00Z')).createdProjectIds[0];
      const declarations = await executeGraphQL(store, 'query', {document: `query($id: ID!) {
        activeInstance {
          counts: automations { totalCount count offset }
          declarations: automations { nodes { name enabled timeout overlap schedule { cron } run { script } } }
        }
        project(id: $id) { automations { totalCount nodes { name run { script } } } }
      }`, variables: {id: projectId}}, {automationRuntime: runtime});
      expect(declarations.errors).toBeUndefined();
      expect(declarations.data?.activeInstance).toEqual({counts: {totalCount: 1, count: 1, offset: 0},
        declarations: {nodes: [{name: 'daily', enabled: true, timeout: 'PT30M', overlap: 'LATEST',
          schedule: {cron: definition.schedule.cron}, run: {script: 'echo'}}]},
      });
      expect(declarations.data?.project).toEqual({automations: {totalCount: 1, nodes: [{name: 'daily', run: {script: 'echo'}}]}});
      expect(declarations.extensions).toMatchObject({complete: true, diagnostics: []});
      expect(runtime).not.toHaveBeenCalled();

      const instanceJob = job('daily', undefined, {next: '2026-10-11T08:00:00Z', running: true});
      const projectJob = job('daily', projectId, {next: '2026-10-12T08:00:00Z'});
      const retained = run('retained');
      runtime.mockResolvedValue({available: true,
        jobs: [instanceJob, projectJob].map(value => ({...value, key: JSON.stringify([temporary, value.definedIn, value.name])})),
        runs: [{...retained, key: JSON.stringify([temporary, retained.definedIn, retained.name])}],
      });
      const observations = await executeGraphQL(store, 'query', {document: `query($id: ID!) {
        activeInstance {
          first: automations { nodes { next running log { totalCount } } }
          second: automations { nodes { next running } }
          automationLog { totalCount }
        }
        project(id: $id) { automations { nodes { next running log { totalCount } } } }
      }`, variables: {id: projectId}}, {automationRuntime: runtime});
      expect(observations.errors).toBeUndefined();
      expect(observations.data?.activeInstance).toEqual({
        first: {nodes: [{next: '2026-10-11T08:00:00Z', running: true, log: {totalCount: 1}}]},
        second: {nodes: [{next: '2026-10-11T08:00:00Z', running: true}]}, automationLog: {totalCount: 1},
      });
      expect(observations.data?.project).toEqual({automations: {nodes: [{next: '2026-10-12T08:00:00Z', running: false, log: {totalCount: 0}}]}});
      expect(runtime).toHaveBeenCalledTimes(1);
    } finally {
      store.close(); rmSync(temporary, {recursive: true, force: true});
    }
  });

  it('keeps identical runtime warnings attributed to each instance instead of collapsing them', async () => {
    const temporary = realpathSync(mkdtempSync('/tmp/aside-graphql-automation-warnings-'));
    const first = join(temporary, 'first'), second = join(temporary, 'second');
    init(first, {name: 'First', description: 'First owner'});
    init(second, {name: 'Second', description: 'Second owner'});
    try {
      const registry = new InstanceRegistry([first, second]);
      const session = new InstanceSession(registry, {knownInstances: async () => [first, second], issues: async () => []}, [], false, true);
      const runtime = vi.fn(async (): Promise<AutomationRuntimeSnapshot> => ({available: false,
        warning: 'Scheduler observation unavailable', jobs: [], runs: [],
      }));
      const result = await executeGraphQL(() => {throw new Error('History inspection must not load records');}, 'query', {
        document: '{ instances { path first: automationLog { totalCount } second: automationLog { totalCount } } }',
      }, {instances: session, automationRuntime: runtime});
      expect(result.errors).toBeUndefined();
      expect(result.data?.instances).toEqual([
        {path: first, first: {totalCount: 0}, second: {totalCount: 0}},
        {path: second, first: {totalCount: 0}, second: {totalCount: 0}},
      ]);
      expect(result.extensions).toMatchObject({complete: false});
      const warnings = result.extensions?.diagnostics as ParseIssue[];
      expect(warnings).toHaveLength(2);
      expect(warnings.map(value => value.file).sort()).toEqual([join(first, 'aside.md'), join(second, 'aside.md')].sort());
      expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({
        severity: 'warning', code: 'automation_runtime', message: 'Scheduler observation unavailable',
      })]));
      expect(runtime).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(temporary, {recursive: true, force: true});
    }
  });

  it('keeps instance histories and current declarations scoped when inspecting another known instance', async () => {
    const temporary = realpathSync(mkdtempSync('/tmp/aside-graphql-automation-owners-'));
    const selected = join(temporary, 'selected'), other = join(temporary, 'other');
    init(selected, {name: 'Selected', description: 'First owner'});
    init(other, {name: 'Other', description: 'Second owner'});
    const selectedStore = new Store(selected), otherStore = new Store(other);
    try {
      const create = (store: Store, name: string, script: string) => handleCapture(store, {
        content: 'Context', description: 'Context', projects: [{name, description: name,
          automations: {daily: {...definition, run: {script}}}}],
      }, new Date('2026-10-10T08:00:00Z')).createdProjectIds[0];
      const selectedProject = create(selectedStore, 'Selected project', 'selected-script');
      const otherProject = create(otherStore, 'Other project', 'other-script');
      handleUpdateInstance(selectedStore, {automations: {daily: {...definition, run: {script: 'selected-script'}}}});
      handleUpdateInstance(otherStore, {automations: {daily: {...definition, run: {script: 'other-script'}}}});
      const registry = new InstanceRegistry([selected, other]); registry.activate(selected);
      const session = new InstanceSession(registry, {knownInstances: async () => [selected, other], issues: async () => []}, [], false, true);
      const runtime = vi.fn(async (path: string): Promise<AutomationRuntimeSnapshot> => {
        const projectId = path === selected ? selectedProject : otherProject;
        const definedIn = `#project/${projectId}`;
        const instanceRun = run('retained');
        return {available: true, jobs: [], runs: [
          {...instanceRun, key: JSON.stringify([path, instanceRun.definedIn, 'daily'])},
          {...run('project-run', 'daily', projectId), key: JSON.stringify([path, definedIn, 'daily']), definedIn},
        ]};
      });
      const result = await executeGraphQL(selectedStore, 'query', {document: `{
        instances { path automationLog { totalCount nodes {
          id name
          automation { name run { script } }
        } } }
      }`}, {instances: session, automationRuntime: runtime});
      expect(result.errors).toBeUndefined();
      const instances = result.data?.instances as any[];
      for (const [path, script] of [
        [selected, 'selected-script'],
        [other, 'other-script'],
      ] as const) {
        const history = instances.find(instance => instance.path === path).automationLog;
        expect(history).toEqual({totalCount: 1, nodes: [{id: 'retained', name: 'daily', automation: {name: 'daily', run: {script}}}]});
      }
      expect(runtime.mock.calls.map(([path]) => path).sort()).toEqual([selected, other].sort());
    } finally {
      selectedStore.close(); otherStore.close(); rmSync(temporary, {recursive: true, force: true});
    }
  });
});
