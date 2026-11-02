import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import * as models from '../src/automation/models.js';
import { parseManifest, parseProjectFile } from '../src/core/parser.js';

let dir: string, store: Store, host: InstanceHost, project: string;
const namedTask = (name: string, script = name) => ({name, schedule: {at: '2099-01-01T00:00:00Z'}, run: {script}});
async function graph(document: string, variables?: Record<string, unknown>) {
  return JSON.parse((await host.tool(dir, 'mutate', {document, variables})).text);
}
function savedJobs(file: string, kind: string): Record<string, any> | undefined {
  const text = readFileSync(file, 'utf8');
  return kind === 'project' ? parseProjectFile(text).value.frontMatter.automations : parseManifest(text).value.automations;
}
beforeEach(() => {
  dir = mkdtempSync('/tmp/aside-gql-auto-edits-');
  init(dir, {name: 'GraphQL edits', description: 'Automation edits'});
  store = new Store(dir);
  project = handleCapture(store, {content: 'Start', description: 'Start', projects: [{name: 'Project', description: 'Project'}]}, new Date(2026, 9, 8, 12)).createdProjectIds[0];
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(models, 'catalogFor').mockResolvedValue({models: [
    {name: 'CODEX_GPT_6_1_SOL', label: 'GPT', builtin: true, engine: 'codex', model: 'gpt-6.1-sol', availability: 'AVAILABLE'},
  ], diagnostics: [], revision: 'automation-edits'});
  host = new InstanceHost(new CalClient(null));
});
afterEach(async () => {await host.close(); store.close(); vi.restoreAllMocks(); rmSync(dir, {recursive: true, force: true});});

describe('GraphQL individual automation edits', () => {
  it.each(['project', 'instance'])('patches an unavailable saved model on a %s job without copying its definition', async kind => {
    const file = kind === 'project' ? store.getProjectFile(project)! : join(dir, 'aside.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n---(?=\n)/, `\nautomations:
  retired:
    schedule: {cron: '0 9 * * *', timezone: UTC}
    run: {model: RETIRED_GPT_MODEL, prompt: "#artifact/2026-10-08-instructions"} # preserve unavailable choice
    enabled: true
  broken: {invalid: true}
---`));
    const field = kind === 'project' ? `updateProject(id: "${project}", input: $input)` : 'updateInstance(input: $input)';
    const selection = kind === 'project' ? 'project { id }' : 'instance { id }';
    const inputType = kind === 'project' ? 'UpdateProjectInput' : 'UpdateInstanceInput';
    const result = await graph(`mutation($input: ${inputType}!) { ${field} { ${selection} } }`, {input: {automations: {patch: [{name: 'retired', enabled: false, timeout: 'PT2M', schedule: {timezone: null}}]}}});
    expect(result.errors).toBeUndefined();
    const jobs = savedJobs(file, kind)!;
    expect(jobs.retired).toEqual({schedule: {cron: '0 9 * * *'}, run: {model: 'RETIRED_GPT_MODEL', prompt: '#artifact/2026-10-08-instructions'}, enabled: false, timeout: 'PT2M'});
    expect(jobs.broken).toEqual({invalid: true});
    expect(readFileSync(file, 'utf8')).toContain('# preserve unavailable choice');
  });

  it('can remove a saved model when the model catalog is empty', async () => {
    vi.mocked(models.catalogFor).mockResolvedValue({models: [], diagnostics: [], revision: 'empty-patch-catalog'});
    const file = join(dir, 'aside.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n---(?=\n)/, `\nautomations:
  retired:
    schedule: {at: '2099-01-01T00:00:00Z'}
    run: {model: RETIRED_GPT_MODEL, prompt: "#artifact/2026-10-08-instructions"}
---`));
    const result = await graph(`mutation {
      updateInstance(input: {automations: {patch: [{name: "retired", run: {model: null, prompt: null, script: "echo"}}]}}) { instance { id } }
    }`);
    expect(result.errors).toBeUndefined();
    expect(savedJobs(file, 'instance')!.retired).toEqual({schedule: {at: '2099-01-01T00:00:00Z'}, run: {script: 'echo'}});
  });

  it.each(['project', 'instance'])('edits %s jobs while leaving malformed declarations and absent model selections intact', async kind => {
    const file = kind === 'project' ? store.getProjectFile(project)! : join(dir, 'aside.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n---(?=\n)/, `\nautomations:
  broken: {invalid: true} # keep
  retired:
    schedule: {at: '2099-01-01T00:00:00Z'}
    run: {model: RETIRED_GPT_MODEL, prompt: "#artifact/2026-10-08-instructions"}
  remove_me: {invalid: true}
---`));
    const field = kind === 'project' ? `updateProject(id: "${project}", input: $input)` : 'updateInstance(input: $input)';
    const selection = kind === 'project' ? 'project { id }' : 'instance { id }';
    const inputType = kind === 'project' ? 'UpdateProjectInput' : 'UpdateInstanceInput';
    const result = await graph(`mutation($input: ${inputType}!) { ${field} { ${selection} } }`, {input: {automations: {
      upsert: [{name: 'new_model_job', schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: 'CODEX_GPT_6_1_SOL', prompt: {create: {name: 'Digest prompt', description: 'Instructions', body: 'Write a digest.'}}}}], remove: ['remove_me'],
    }}});
    expect(result.errors).toBeUndefined();
    const automations = savedJobs(file, kind)!;
    expect(automations.broken).toEqual({invalid: true});
    expect(automations.retired.run.model).toBe('RETIRED_GPT_MODEL');
    expect(automations.new_model_job.run.model).toBe('CODEX_GPT_6_1_SOL');
    expect(automations.remove_me).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toContain('# keep');
  });

  it.each([
    {automations: {set: [], patch: []}},
    {automations: {set: null}},
    {automations: {remove: ['duplicate', 'duplicate']}},
    {automations: {remove: [' ']}},
    {automations: {remove: ['x'], upsert: [namedTask('x')]}},
    {automations: {upsert: [namedTask('x'), namedTask('x')]}},
    {automations: {patch: [{name: 'x', enabled: false}, {name: 'x', timeout: 'PT2M'}]}},
    {automations: {patch: [{name: 'x', enabled: false}], upsert: [namedTask('x')]}},
    {automations: {patch: [{name: 'x', enabled: false}], remove: ['x']}},
    {automations: {patch: [{name: 'x', schedule: null}]}},
    {automations: {patch: [{name: 'x', run: null}]}},
    {automations: {patch: [{name: 'x', schedule: {cron: 'bad'}}]}},
    {automations: {upsert: [{name: 'invalid', schedule: {cron: 'bad'}, run: {script: 'echo'}}]}},
  ])('validates every input before any mutation in the document runs (%j)', async input => {
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    const result = await graph(`mutation($input: UpdateProjectInput!) {
      first: updateInstance(input: {body: "Must not save."}) { error }
      second: updateProject(id: "${project}", input: $input) { error }
    }`, {input});
    expect(result.errors).toBeDefined();
    expect(result.extensions.mutations).toEqual([]);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
  });

  it('rejects new upsert model selections absent from the catalog before any root mutation runs', async () => {
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    const result = await graph(`mutation {
      first: updateInstance(input: {body: "Must not save."}) { error }
      second: updateProject(id: "${project}", input: {automations: {upsert: [{name: "new", schedule: {at: "2099-01-01T00:00:00Z"}, run: {model: "CLAUDE_SONNET", prompt: {create: {name: "Prompt", description: "Instructions", body: "Write"}}}}]}}) { error }
    }`);
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toContain('CLAUDE_SONNET');
    expect(result.extensions.mutations).toEqual([]);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
  });

  it('rejects newly selected patch models before any root mutation runs', async () => {
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    const result = await graph(`mutation {
      first: updateInstance(input: {body: "Must not save."}) { error }
      second: updateProject(id: "${project}", input: {automations: {patch: [{name: "retired", run: {model: "CLAUDE_SONNET"}}]}}) { error }
    }`);
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toContain('CLAUDE_SONNET');
    expect(result.extensions.mutations).toEqual([]);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
  });

  it('rejects non-null patch model choices against an empty catalog', async () => {
    vi.mocked(models.catalogFor).mockResolvedValue({models: [], diagnostics: [], revision: 'empty-patch-catalog'});
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    const result = await graph(`mutation($input: UpdateInstanceInput!) {
      first: updateInstance(input: {body: "Must not save."}) { error }
      second: updateInstance(input: $input) { error }
    }`, {input: {automations: {patch: [{name: 'retired', run: {model: 'RETIRED_GPT_MODEL'}}]}}});
    expect(result.errors[0].message).toContain('not selectable');
    expect(result.extensions.mutations).toEqual([]);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
  });

  it('defines no-op, removal, and explicit complete replacement through one edit object', async () => {
    const file = join(dir, 'aside.md');
    const update = async (automations: unknown) => {
      const result = await graph('mutation($input: UpdateInstanceInput!) { updateInstance(input: $input) { instance { id } error } }', {input: {automations}});
      expect(result.errors).toBeUndefined();
      expect(result.data.updateInstance.error).toBeNull();
      return savedJobs(file, 'instance');
    };
    const created = await update({upsert: [namedTask('one')]});
    expect(await update({upsert: [], remove: []})).toEqual(created);
    expect(await update(null)).toEqual(created);
    expect(await update({remove: ['one']})).toBeUndefined();
    await update({upsert: [namedTask('again')]});
    expect(await update({set: []})).toBeUndefined();
  });
});
