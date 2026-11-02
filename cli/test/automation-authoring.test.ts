import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateProject } from '../src/mcp/tools/update.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';
import { createArtifact } from '../src/mcp/tools/artifact.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { QueryView } from '../src/graphql/query.js';
import * as models from '../src/automation/models.js';

const jobs = {
  digest: { schedule: { cron: '0 8 * * 1-5', timezone: 'America/Los_Angeles' }, run: { model: 'CODEX_GPT_6_1_SOL', prompt: '#artifact/2026-10-08-digest-instructions' } },
  organize: { schedule: { at: '2099-01-01T00:00:00Z' }, run: { script: './organize', args: ['--recent'] } },
  weekly: { schedule: { rrule: 'FREQ=WEEKLY;BYDAY=MO', dtstart: '2026-10-12T09:00', timezone: 'UTC' }, run: { model: 'digest_model', prompt: '#artifact/2026-10-08-instructions' } },
  coding: { schedule: { at: '2099-01-02T00:00:00Z' }, run: { model: 'CODEX_GPT_6_1_SOL', prompt: '#artifact/2026-10-08-coding-instructions' } },
  writing: { schedule: { at: '2099-01-03T00:00:00Z' }, run: { model: 'CLAUDE_SONNET', prompt: '#artifact/2026-10-08-writing-instructions' } },
  editing: { schedule: { at: '2099-01-04T00:00:00Z' }, run: { model: 'CLAUDE_SONNET', prompt: '#artifact/2026-10-08-instructions' } },
};
const graphJobs = Object.fromEntries(Object.entries(jobs).map(([name, definition]) => [name,
  {...definition, run: 'model' in definition.run ? {...definition.run, prompt: {existingId: definition.run.prompt.slice('#artifact/'.length)}} : definition.run},
]));
const artifactJobs = Object.fromEntries(Object.entries(graphJobs).map(([name, definition]) => [name,
  {...definition, run: 'model' in definition.run ? {...definition.run, prompt: `#artifact/${definition.run.prompt.existingId}`} : definition.run},
]));
const invalidModelSelections = [
  ['empty model', ''], ['blank model', '  '], ['NUL model', 'model\0name'],
  ['nontext model', 1], ['null model', null], ['object selector', {engine: 'codex'}],
  ['array selector', ['CODEX_GPT_6_1_SOL']], ['reserved name', '__private'],
  ['enum keyword', 'true'], ['vendor identifier', 'gpt-6.1-sol'],
] as const;
const namedJobs = (value: Record<string, unknown>) => Object.entries(value).map(([name, definition]) => ({name, ...definition as object}));
let dir: string, store: Store, host: InstanceHost, project: string;
async function graph(document: string, variables?: Record<string, unknown>, mode = 'mutate') {
  return JSON.parse((await host.tool(dir, mode, { document, variables })).text);
}
const automationFields = 'automations { nodes { name schedule { cron rrule dtstart timezone at } run { script args model prompt { id } } } }';
const projectWrite = `mutation($id: ID!, $jobs: [CreateAutomationInput!]!) { updateProject(id: $id, input: {automations: {set: $jobs}}) { error project { id ${automationFields} } } }`;
const instanceWrite = `mutation($jobs: [CreateAutomationInput!]!) { updateInstance(input: {automations: {set: $jobs}}) { error instance { path id ${automationFields} body } } }`;
function declarations(page: any): Record<string, unknown> {
  const present = (value: Record<string, unknown> | null) => value === null ? null
    : Object.fromEntries(Object.entries(value).filter(([, value]) => value !== null));
  return Object.fromEntries(page.nodes.map(({name, schedule, run}: any) => [name, {schedule: present(schedule), run: present(run && {...run,
    ...(run.prompt ? {prompt: `#artifact/${run.prompt.id}`} : {}),
  })}]));
}

beforeEach(() => {
  dir = mkdtempSync('/tmp/aside-auto-author-'); init(dir, { name: 'Authoring', description: 'Automation fixture' });
  store = new Store(dir);
  createArtifact(store, {name: 'Instructions', description: 'Instructions', body: 'Weekly instructions.'}, new Date(2026, 9, 8, 12));
  for (const [name, definition] of Object.entries(jobs)) if ('model' in definition.run && definition.run.prompt !== '#artifact/2026-10-08-instructions') {
    createArtifact(store, {name: `${name} instructions`, description: 'Instructions', body: `Instructions for ${name}.`}, new Date(2026, 9, 8, 12));
  }
  project = handleCapture(store, { content: 'Start', description: 'Start', projects: [{ name: 'Notes', description: 'Notes', body: 'Keep this body.' }] }, new Date(2026, 9, 8, 12)).createdProjectIds[0];
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(models, 'catalogFor').mockResolvedValue({
    models: [
      {name: 'CODEX_GPT_6_1_SOL', label: 'GPT', builtin: true, engine: 'codex', model: 'gpt-6.1-sol', availability: 'AVAILABLE'},
      {name: 'CLAUDE_SONNET', label: 'Sonnet', builtin: true, engine: 'claude', model: 'sonnet', availability: 'AVAILABLE'},
      {name: 'digest_model', label: 'digest_model', builtin: false, availability: 'AVAILABLE'},
    ], diagnostics: [], revision: 'authoring',
  });
  host = new InstanceHost(new CalClient(null));
});
afterEach(async () => { await host.close(); store.close(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

describe('automation authoring', () => {
  it('round trips all schedules through GraphQL artifact prompts and uses the same direct artifact handles in legacy inputs', async () => {
    expect(existsSync(join(dir, '.aside'))).toBe(false);
    const result = await graph(projectWrite, { id: project, jobs: namedJobs(graphJobs) });
    expect(result.errors).toBeUndefined();
    expect(declarations(result.data.updateProject.project.automations)).toEqual(artifactJobs);
    expect(result.extensions.mutations[0]).toMatchObject({operation: 'updateProject', error: null, changes: expect.any(Array)});
    const legacy = await host.tool(dir, 'query_projects', { ids: [project], detail: 'metadata' });
    expect(legacy.text).toContain('prompt: "#artifact/2026-10-08-instructions"');
    const instance = await host.tool(dir, 'update_instance', { automations: jobs });
    expect(instance.text).toContain('updated: instance');
    expect(JSON.parse((await host.tool(dir, 'query_instance', {})).text).manifest.automations).toEqual(jobs);
    const queried = await graph(`{ activeInstance { ${automationFields} } project(id: "${project}") { ${automationFields} } }`, undefined, 'query');
    expect(declarations(queried.data.activeInstance.automations)).toEqual(jobs);
    expect(declarations(queried.data.project.automations)).toEqual(artifactJobs);
  });

  it('accepts built-in and named string selections in GraphQL literals', async () => {
    const result = await graph(`mutation {
      updateInstance(input: {automations: {set: [
        {name: "coding", schedule: {at: "2099-01-01T00:00:00Z"}, run: {model: "CODEX_GPT_6_1_SOL", prompt: {existingId: "2026-10-08-coding-instructions"}}}
        {name: "writing", schedule: {at: "2099-01-02T00:00:00Z"}, run: {model: "CLAUDE_SONNET", prompt: {existingId: "2026-10-08-instructions"}}}
        {name: "named", schedule: {at: "2099-01-03T00:00:00Z"}, run: {model: "digest_model", prompt: {existingId: "2026-10-08-digest-instructions"}}}
      ]}}) { instance { ${automationFields} } }
    }`);
    expect(result.errors).toBeUndefined();
    expect(declarations(result.data.updateInstance.instance.automations)).toEqual({
      coding: {schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: 'CODEX_GPT_6_1_SOL', prompt: '#artifact/2026-10-08-coding-instructions'}},
      writing: {schedule: {at: '2099-01-02T00:00:00Z'}, run: {model: 'CLAUDE_SONNET', prompt: '#artifact/2026-10-08-instructions'}},
      named: {schedule: {at: '2099-01-03T00:00:00Z'}, run: {model: 'digest_model', prompt: '#artifact/2026-10-08-digest-instructions'}},
    });
  });

  it.each(invalidModelSelections)('rejects %s before any MCP authoring write', (label, model) => {
    const instanceFile = join(dir, 'aside.md');
    const projectFile = store.getProjectFile(project)!;
    const originalInstance = readFileSync(instanceFile, 'utf8');
    const originalProject = readFileSync(projectFile, 'utf8');
    const count = store.getEntries().length;
    const automations = { bad: { schedule: { at: '2099-01-01T00:00:00Z' }, run: { model, prompt: '#artifact/2026-10-08-writing-instructions' } } };
    expect(() => handleUpdateInstance(store, { automations })).toThrow('automations.bad');
    expect(() => handleUpdateProject(store, { id: project, automations, body: 'Do not save this body.' })).toThrow('automations.bad');
    expect(() => handleCapture(store, {
      content: 'Do not create records', description: 'Do not create records',
      projects: [{ name: 'New project', description: 'New project', automations }],
      actions: [{ name: 'Task', description: 'Task' }],
    }, new Date(2026, 9, 8, 13))).toThrow('automations.bad');
    expect(readFileSync(instanceFile, 'utf8')).toBe(originalInstance);
    expect(readFileSync(projectFile, 'utf8')).toBe(originalProject);
    expect(store.getEntries()).toHaveLength(count);
    expect(existsSync(join(dir, 'projects', '2026', '2026-10-08-new-project.md'))).toBe(false);
    expect(existsSync(join(dir, 'actions', '2026', '2026-10-08-task.md'))).toBe(false);
  });

  it.each(invalidModelSelections)('rejects %s before any GraphQL variable mutation runs', async (label, model) => {
    const instanceFile = join(dir, 'aside.md');
    const projectFile = store.getProjectFile(project)!;
    const originalInstance = readFileSync(instanceFile, 'utf8');
    const originalProject = readFileSync(projectFile, 'utf8');
    const result = await graph(`mutation($bad: [CreateAutomationInput!]!) {
      first: updateInstance(input: {automations: {set: [{name: "ok", schedule: {at: "2099-01-01T00:00Z"}, run: {model: "CLAUDE_SONNET", prompt: {existingId: "2026-10-08-instructions"}}}]}}) { error }
      second: updateProject(id: "${project}", input: {automations: {set: $bad}}) { error }
    }`, { bad: [{ name: 'bad', schedule: { at: '2099-01-01T00:00:00Z' }, run: { model, prompt: {existingId: '2026-10-08-instructions'} } }] });
    expect(result.errors).not.toHaveLength(0);
    expect(result.extensions.mutations).toEqual([]);
    expect(readFileSync(instanceFile, 'utf8')).toBe(originalInstance);
    expect(readFileSync(projectFile, 'utf8')).toBe(originalProject);
  });

  it('rejects unavailable selections, unquoted selectors and custom command fields before writing', async () => {
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    for (const run of ['{model: "CODEX_UNKNOWN", prompt: {existingId: "2026-10-08-instructions"}}', '{model: CLAUDE_SONNET, prompt: {existingId: "2026-10-08-instructions"}}', '{model: "CLAUDE_SONNET", command: "custom-cli", prompt: {existingId: "2026-10-08-instructions"}}']) {
      const result = await graph(`mutation { updateInstance(input: {automations: {set: [{name: "bad", schedule: {at: "2099-01-01T00:00:00Z"}, run: ${run}}]}}) { error } }`);
      expect(result.errors).not.toHaveLength(0);
      expect(result.extensions.mutations).toEqual([]);
      expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
    }
  });

  it('replaces, preserves and clears maps on projects and instances', async () => {
    for (const kind of ['project', 'instance']) {
      const write = kind === 'project' ? projectWrite : instanceWrite;
      const values = kind === 'project' ? { id: project } : {};
      const map = (result: any) => declarations(kind === 'project' ? result.data.updateProject.project.automations : result.data.updateInstance.instance.automations);
      expect(map(await graph(write, { ...values, jobs: namedJobs(graphJobs) }))).toEqual(artifactJobs);
      const preserved = await graph(kind === 'project'
        ? `mutation { updateProject(id: "${project}", input: {body: "Changed body."}) { project { ${automationFields} } } }`
        : `mutation { updateInstance(input: {}) { instance { ${automationFields} } } }`);
      expect(map(preserved)).toEqual(artifactJobs);
      expect(map(await graph(write, { ...values, jobs: namedJobs({ digest: graphJobs.digest }) }))).toEqual({ digest: artifactJobs.digest });
      expect(map(await graph(write, {...values, jobs: []}))).toEqual({});
      await graph(write, {...values, jobs: namedJobs(graphJobs)});
      const unchanged = await graph(kind === 'project'
        ? `mutation { updateProject(id: "${project}", input: {automations: null}) { project { ${automationFields} } } }`
        : `mutation { updateInstance(input: {automations: null}) { instance { ${automationFields} } } }`);
      expect(map(unchanged)).toEqual(artifactJobs);
      const rejected = await graph(write, {...values, jobs: null});
      expect(rejected.errors).toBeDefined();
      expect(rejected.extensions.mutations).toEqual([]);
    }
  });

  it('validates variables before any GraphQL write and rejects invalid inline declarations', async () => {
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    const invalid = { bad: { ...graphJobs.digest, schedule: { cron: 'not cron' } } };
    const result = await graph(`mutation($bad: [CreateAutomationInput!]!) {
      first: updateInstance(input: {automations: {set: [{name: "ok", schedule: {at: "2099-01-01T00:00Z"}, run: {script: "echo"}}]}}) { error }
      second: updateProject(id: "${project}", input: {automations: {set: $bad}}) { error }
    }`, { bad: namedJobs(invalid) });
    expect(result.errors[0].message).toContain('automations.bad');
    expect(result.extensions.mutations).toEqual([]);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
    const inline = await graph('mutation { updateInstance(input: {automations: {set: [{name: "bad", schedule: {at: "2026-10-08T09:00"}, run: {script: "echo"}}]}}) { error } }');
    expect(inline.errors).toBeDefined();
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
    const normalized = await graph(instanceWrite, { jobs: [{ name: 'bad', schedule: { rrule: 'FREQ=DAILY;BYMINUTE=60', dtstart: '2026-10-08T08:00', timezone: 'UTC' }, run: { script: 'echo' } }] });
    expect(normalized.errors[0].message).toContain('BYMINUTE');
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
  });

  it('preflights every new project automation before creating records', () => {
    const count = store.getEntries().length;
    expect(() => handleCapture(store, {
      content: 'Create both', description: 'Create both',
      projects: [{ name: 'First', description: 'First', automations: jobs }, { name: 'Second', description: 'Second', automations: { bad: { ...jobs.digest, schedule: { cron: 'bad' } } } }],
      actions: [{ name: 'Task', description: 'Task' }],
    }, new Date(2026, 9, 8, 13))).toThrow('automations.bad');
    expect(store.getEntries()).toHaveLength(count);
    expect(existsSync(join(dir, 'projects', '2026', '2026-10-08-first.md'))).toBe(false);
    expect(existsSync(join(dir, 'actions', '2026', '2026-10-08-task.md'))).toBe(false);
  });

  it('creates projects with automations through capture and updateEntry', async () => {
    const created = await graph(`mutation($jobs: [CreateAutomationInput!]!) { capture(input: {content: "Setup", description: "Setup", projects: [{create: {name: "Automated", description: "Automated", automations: $jobs}}]}) { entry { id } createdProjects { id ${automationFields} } } }`, { jobs: namedJobs(graphJobs) });
    expect(created.errors).toBeUndefined();
    expect(declarations(created.data.capture.createdProjects[0].automations)).toEqual(artifactJobs);
    const entry = created.data.capture.entry.id;
    const updated = await graph(`mutation($entry: ID!, $jobs: [CreateAutomationInput!]!) { updateEntry(id: $entry, input: {projects: {add: [{create: {name: "More automation", description: "More", automations: $jobs}}]}}) { createdProjects { ${automationFields} } } }`, { entry, jobs: namedJobs(graphJobs) });
    expect(updated.errors).toBeUndefined();
    expect(declarations(updated.data.updateEntry.createdProjects[0].automations)).toEqual(artifactJobs);
  });

  it('preserves instance identity, custom YAML fields, comments and exact instruction body', () => {
    const file = join(dir, 'aside.md');
    const body = '\r\n# Instructions\r\nKeep literal $HOME and ---\r\n';
    writeFileSync(file, `---\r\nid: authoring\r\nname: Authoring # keep comment\r\ncustom: &value {a: 1}\r\ncopy: *value\r\nconfig: {doneEventTitlePrefix: Done}\r\n---${body}`);
    store.rebuild();
    handleUpdateInstance(store, { automations: jobs });
    const saved = readFileSync(file, 'utf8');
    expect(saved.slice(saved.indexOf('\r\n---\r\n') + 7)).toBe(body.slice(2));
    expect(saved).toContain('# keep comment');
    const manifest = parse(saved.split('---')[1]);
    expect(manifest).toMatchObject({ id: 'authoring', custom: { a: 1 }, copy: { a: 1 }, config: { doneEventTitlePrefix: 'Done' }, automations: jobs });
    const original = readFileSync(file, 'utf8');
    expect(() => handleUpdateInstance(store, { automations: { invalid: { ...jobs.digest, timeout: 'P1M' } } })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('reads malformed direct-file declarations for repair and isolates nested query snapshots', async () => {
    handleUpdateProject(store, { id: project, automations: jobs });
    const old = new QueryView(store);
    store.getProject(project)!.frontMatter.automations!.digest = { broken: true };
    expect(old.records.project.get(project)!.record.frontMatter.automations).toEqual(jobs);
    // Save the malformed declaration as a user file edit, then query through the host.
    const file = store.getProjectFile(project)!;
    const saved = readFileSync(file, 'utf8');
    const metadata = parse(saved.match(/^---\n([\s\S]*?)\n---/)![1]);
    metadata.automations.digest = { broken: true };
    writeFileSync(file, `---\n${stringify(metadata)}---\n\n${store.getProject(project)!.body}\n`);
    store.rebuild();
    handleUpdateProject(store, { id: project, body: 'Keep malformed map readable.' });
    const result = await graph(`{ project(id: "${project}") { ${automationFields} } }`, undefined, 'query');
    expect(result.errors).toBeUndefined();
    expect(declarations(result.data.project.automations).digest).toEqual({schedule: null, run: null});
    expect(result.extensions).toMatchObject({complete: false, diagnostics: expect.arrayContaining([
      expect.objectContaining({code: 'invalid_automation', field: 'automations.digest', file: realpathSync(file)}),
    ])});
    expect(result.extensions.diagnostics.filter((issue: any) => issue.code === 'invalid_automation'
      && issue.field === 'automations.digest' && issue.file === realpathSync(file))).toHaveLength(1);
    const repaired = await graph(projectWrite, { id: project, jobs: namedJobs(graphJobs) });
    expect(repaired.errors).toBeUndefined();
    expect(declarations(repaired.data.updateProject.project.automations)).toEqual(artifactJobs);
  });
});
