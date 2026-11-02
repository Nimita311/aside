import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { artifactFilePath } from '../src/core/artifact.js';
import { createArtifact } from '../src/mcp/tools/artifact.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateEntry, handleUpdateProject } from '../src/mcp/tools/update.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';
import { beforeMutationWrite, persistMutationWrite, trackMutation } from '../src/mcp/tools/mutation-result.js';
import { normalizeMutationArguments } from '../src/graphql/inputs.js';
import { prepareAutomationPrompts } from '../src/graphql/automation-prompts.js';
import { executeGraphQL } from '../src/graphql/schema.js';
import { resolvePrompt } from '../src/automation/execution.js';
import * as models from '../src/automation/models.js';

const now = new Date(2026, 9, 8, 12);
const schedule = {at: '2099-01-01T00:00:00Z'};
let dir: string, store: Store, project: string;
const input = (prompt: unknown, name = 'task') => ({automations: {upsert: [{name, schedule, run: {model: 'CUSTOM', prompt}}]}});
function executeOwner(field: string, raw: Record<string, any>, id?: string) {
  const args = normalizeMutationArguments(field, {input: raw, ...(field === 'updateProject' ? {id} : {})}, {now});
  const commit = prepareAutomationPrompts(store, args);
  return trackMutation(store, () => {
    const release = commit ? beforeMutationWrite(store, commit) : () => {};
    try {
      const value = field === 'updateInstance' ? handleUpdateInstance(store, args.input) : handleUpdateProject(store, {...args.input, id: id!});
      commit?.();
      return value;
    } finally {release();}
  });
}
beforeEach(() => {
  dir = mkdtempSync('/tmp/aside-gql-prompts-');
  init(dir, {name: 'Prompts', description: 'Prompts'});
  store = new Store(dir);
  project = handleCapture(store, {content: 'Context', description: 'Context', projects: [{name: 'Project', description: 'Project'}]}, now).createdProjectIds[0];
  vi.spyOn(models, 'catalogFor').mockResolvedValue({models: [{name: 'CUSTOM', label: 'Custom', builtin: false, availability: 'AVAILABLE'}], diagnostics: [], revision: 'prompts'});
});
afterEach(() => {store.close(); vi.restoreAllMocks(); rmSync(dir, {recursive: true, force: true});});

describe('artifact-only automation prompts', () => {
  it.each(['updateInstance', 'updateProject'])('links an existing artifact on %s and validates its readable primary content', field => {
    const artifact = createArtifact(store, {name: 'Instructions', description: 'Instructions', body: 'Write a digest.'}, now);
    const outcome = executeOwner(field, input({existingId: artifact.id}), project);
    expect(outcome.result.status).toBe('SUCCEEDED');
    const jobs = field === 'updateInstance' ? store.getManifest().automations : store.getProject(project)!.frontMatter.automations;
    expect((jobs!.task as any).run.prompt).toEqual(`#artifact/${artifact.id}`);
    expect(resolvePrompt(dir, (jobs!.task as any).run.prompt)).toBe('Write a digest.');
    expect(outcome.result.changes.some(change => change.kind === 'artifact')).toBe(false);
  });

  it.each(['updateInstance', 'updateProject'])('creates a prompt artifact with %s inside the owner journal', field => {
    const outcome = executeOwner(field, input({create: {name: 'Instructions', description: 'Instructions', body: 'Write a digest.'}}), project);
    expect(outcome.result.status).toBe('SUCCEEDED');
    expect(outcome.result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: 'artifact', id: '2026-10-08-instructions', effect: 'CREATED'}),
      expect.objectContaining({kind: field === 'updateInstance' ? 'instance' : 'project', effect: 'UPDATED'}),
    ]));
    expect(store.getArtifact('2026-10-08-instructions')!.body).toBe('Write a digest.');
  });

  it.each(['updateInstance', 'updateProject'])('repairs an already-saved prompt reference on %s without rewriting the owner', field => {
    const saved = {automations: {task: {schedule, run: {model: 'CUSTOM', prompt: '#artifact/2026-10-08-instructions'}}}};
    if (field === 'updateInstance') handleUpdateInstance(store, saved);
    else handleUpdateProject(store, {...saved, id: project});
    const file = field === 'updateInstance' ? join(dir, 'aside.md') : store.getProjectFile(project)!;
    const original = readFileSync(file, 'utf8');
    const outcome = executeOwner(field, input({create: {name: 'Instructions', description: 'Instructions', body: 'Write a digest.'}}), project);
    expect(store.getArtifact('2026-10-08-instructions')!.body).toBe('Write a digest.');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(outcome.result.changes.some(change => change.kind === 'artifact')).toBe(true);
    expect(outcome.result.changes.some(change => change.kind === (field === 'updateInstance' ? 'instance' : 'project'))).toBe(false);
  });

  it('accepts a single imported primary text attachment without scanning its links', () => {
    const source = join(dir, 'prompt.txt');
    writeFileSync(source, 'Write a digest. #artifact/2026-10-08-missing');
    executeOwner('updateInstance', input({create: {name: 'File prompt', description: 'Instructions', attachments: [{source}]}}));
    expect(resolvePrompt(dir, '#artifact/2026-10-08-file-prompt')).toBe('Write a digest. #artifact/2026-10-08-missing');
  });

  it.each([
    {existingId: '2026-10-08-missing'},
    {create: {name: 'Empty', description: 'Instructions'}},
    {create: {name: 'Missing source', description: 'Instructions', attachments: [{source: '/tmp/aside-missing-prompt-source'}]}},
  ])('rejects an unusable prompt before any artifact or owner write: %j', prompt => {
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    const artifactsDirectoryExists = existsSync(join(dir, 'artifacts'));
    expect(() => executeOwner('updateInstance', input(prompt))).toThrow();
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
    expect(store.getArtifacts().size).toBe(0);
    expect(existsSync(join(dir, 'artifacts'))).toBe(artifactsDirectoryExists);
  });

  it('preflights every prompt create before committing an earlier valid definition', () => {
    const raw = {automations: {upsert: [
      {name: 'one', schedule, run: {model: 'CUSTOM', prompt: {create: {name: 'First', description: 'Instructions', body: 'Write.'}}}},
      {name: 'two', schedule, run: {model: 'CUSTOM', prompt: {create: {name: 'Second', description: 'Instructions', attachments: [{source: '/tmp/aside-missing-prompt-source'}]}}}},
    ]}};
    expect(() => executeOwner('updateInstance', raw)).toThrow('Cannot import');
    expect(store.getArtifacts().size).toBe(0);
  });

  it('rejects an existing primary attachment under an in-root managed-directory symlink before any owner or inline artifact write', () => {
    const source = join(dir, 'prompt.txt');
    writeFileSync(source, 'Existing instructions.');
    const existing = createArtifact(store, {name: 'Existing prompt', description: 'Instructions', files: [{source}]}, now);
    const managed = join(dir, 'artifacts', '2026', existing.id);
    const actual = join(dir, 'actual-prompt-files');
    renameSync(managed, actual);
    symlinkSync(actual, managed, 'dir');
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    const raw = {automations: {upsert: [
      {name: 'new', schedule, run: {model: 'CUSTOM', prompt: {create: {name: 'New prompt', description: 'Instructions', body: 'New instructions.'}}}},
      {name: 'existing', schedule, run: {model: 'CUSTOM', prompt: {existingId: existing.id}}},
    ]}};
    expect(() => executeOwner('updateInstance', raw)).toThrow(/Symlinks are not allowed/);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
    expect(store.getArtifacts().size).toBe(1);
    expect(existsSync(artifactFilePath(dir, '2026-10-08-new-prompt'))).toBe(false);
    expect(() => resolvePrompt(dir, `#artifact/${existing.id}`)).toThrow(/Symlinks are not allowed/);
  });

  it('rejects duplicate inline artifact IDs before writes', () => {
    const raw = {automations: {upsert: ['one', 'two'].map(name => ({name, schedule, run: {model: 'CUSTOM', prompt: {create: {name: 'Same prompt', description: 'Instructions', body: 'Write.'}}}}))}};
    expect(() => executeOwner('updateInstance', raw)).toThrow('same ID');
    expect(store.getArtifacts().size).toBe(0);
  });

  it.each(['missing owner', 'missing patch', 'invalid saved YAML'])('does not create an inline artifact when owner preflight fails: %s', failure => {
    const draft = {create: {name: 'Instructions', description: 'Instructions', body: 'Write.'}};
    let raw: Record<string, any> = input(draft), target = project;
    if (failure === 'missing owner') target = 'missing-project';
    if (failure === 'missing patch') raw = {automations: {patch: [{name: 'absent', run: {prompt: draft}}]}};
    if (failure === 'invalid saved YAML') writeFileSync(store.getProjectFile(project)!, '---\nname: [invalid\n---\n');
    expect(() => executeOwner('updateProject', raw, target)).toThrow();
    expect(store.getArtifacts().size).toBe(0);
    expect(() => readFileSync(artifactFilePath(dir, '2026-10-08-instructions'))).toThrow();
  });

  it('reports a saved inline artifact as partial if the subsequent owner write fails', () => {
    const args = normalizeMutationArguments('updateInstance', {input: input({create: {name: 'Instructions', description: 'Instructions', body: 'Write.'}})}, {now});
    const commit = prepareAutomationPrompts(store, args)!;
    expect(() => trackMutation(store, () => {
      const release = beforeMutationWrite(store, commit);
      try {persistMutationWrite(store, {kind: 'instance', id: store.getManifest().id, effect: 'UPDATED'}, () => {throw new Error('Owner disk failure');});}
      finally {release();}
    })).toThrow(expect.objectContaining({partialResult: expect.objectContaining({status: 'PARTIAL', changes: expect.arrayContaining([expect.objectContaining({kind: 'artifact', id: '2026-10-08-instructions'})])})}));
    expect(store.getArtifact('2026-10-08-instructions')!.body).toBe('Write.');
    expect(store.getManifest().automations).toBeUndefined();
  });

  it('creates and resolves a prompt artifact through GraphQL', async () => {
    const result = await executeGraphQL(store, 'mutation', {document: `mutation {
      updateProject(id: "${project}", input: {automations: {upsert: [{name: "digest", schedule: {at: "2099-01-01T00:00:00Z"}, run: {model: "CUSTOM", prompt: {create: {name: "Instructions", description: "Instructions", body: "Write a digest."}}}}]}}) {
        project { automations { nodes { run { prompt { id name content { ... on MarkdownContent { text } } } } } } } error
      }
    }`}, {mutate: (_operation, args) => ({id: args.id, text: handleUpdateProject(store, args)})});
    expect(result.errors).toBeUndefined();
    expect((result.data as any).updateProject).toMatchObject({error: null, project: {automations: {nodes: [{run: {prompt: {name: 'Instructions', content: {text: 'Write a digest.'}}}}]}}});
    expect(result.extensions!.mutations![0].changes).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'artifact', effect: 'CREATED'})]));
  });

  it.each(['capture', 'updateEntry'])('creates a project prompt through %s without persisting the inline definition', async field => {
    const entry = handleCapture(store, {content: 'Existing entry', description: 'Context'}, now).entryId;
    const projectDefinition = {create: {name: 'Created project', description: 'Context', automations: [{name: 'task', schedule, run: {model: 'CUSTOM', prompt: {create: {name: 'Instructions', description: 'Instructions', body: 'Write a digest.'}}}}]}};
    const variables = {input: field === 'capture' ? {content: 'New entry', description: 'Context', projects: [projectDefinition]} : {projects: {add: [projectDefinition]}}};
    const result = await executeGraphQL(store, 'mutation', {document: `mutation($input: ${field === 'capture' ? 'CaptureInput' : 'UpdateEntryInput'}!) {
      ${field}(${field === 'updateEntry' ? `id: "${entry}", ` : ''}input: $input) {createdProjects {id automations {nodes {run {prompt {id name}}}}} error}
    }`, variables}, {mutate: (_operation, args) => field === 'capture' ? handleCapture(store, args) : handleUpdateEntry(store, args)});
    expect(result.errors).toBeUndefined();
    expect((result.data as any)[field].createdProjects[0].automations.nodes[0].run.prompt).toMatchObject({name: 'Instructions'});
    expect(result.extensions!.mutations![0].changes).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'artifact', effect: 'CREATED'}), expect.objectContaining({kind: 'project', effect: 'CREATED'})]));
    const savedProject = store.getProject((result.data as any)[field].createdProjects[0].id)!;
    expect((savedProject.frontMatter.automations!.task as any).run.prompt).toEqual(`#artifact/${(result.data as any)[field].createdProjects[0].automations.nodes[0].run.prompt.id}`);
  });

  it.each(['capture', 'updateEntry'])('keeps prompt drafts unwritten when %s cannot resolve another entity reference', async field => {
    const entry = handleCapture(store, {content: 'Existing entry', description: 'Context'}, now).entryId;
    const projectDefinition = {create: {name: 'Created project', description: 'Context', automations: [{name: 'task', schedule, run: {model: 'CUSTOM', prompt: {create: {name: 'Instructions', description: 'Instructions', body: 'Write.'}}}}]}};
    const projects = [projectDefinition, {existingId: 'missing-project'}];
    const variables = {input: field === 'capture' ? {content: 'New entry', description: 'Context', projects} : {projects: {add: projects}}};
    const result = await executeGraphQL(store, 'mutation', {document: `mutation($input: ${field === 'capture' ? 'CaptureInput' : 'UpdateEntryInput'}!) {${field}(${field === 'updateEntry' ? `id: "${entry}", ` : ''}input: $input) {error}}`, variables},
      {mutate: (_operation, args) => field === 'capture' ? handleCapture(store, args) : handleUpdateEntry(store, args)});
    expect(result.errors?.[0].message).toContain('missing-project');
    expect(store.getArtifacts().size).toBe(0);
    expect(store.getProjects().size).toBe(1);
    expect(result.extensions!.mutations).toEqual([]);
  });

  it('keeps prompt drafts unwritten when a new linked action body cannot be read', async () => {
    const variables = {input: {content: 'Context', description: 'Context',
      projects: [{create: {name: 'Created project', description: 'Context', automations: [{name: 'task', schedule, run: {model: 'CUSTOM', prompt: {create: {name: 'Instructions', description: 'Instructions', body: 'Write.'}}}}]}}],
      actions: [{create: {name: 'Unreadable task', description: 'Task', bodyFile: '/tmp/aside-missing-action-source'}}],
    }};
    const result = await executeGraphQL(store, 'mutation', {document: 'mutation($input: CaptureInput!) {capture(input: $input) {error}}', variables}, {mutate: (_operation, args) => handleCapture(store, args)});
    expect(result.errors?.[0].message).toContain('aside-missing-action-source');
    expect(store.getArtifacts().size).toBe(0);
    expect(store.getProjects().size).toBe(1);
    expect(result.extensions!.mutations).toEqual([]);
  });

  it('validates a later malformed ArtifactLinkInput before an earlier root mutation writes', async () => {
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    const mutate = vi.fn((_operation, args) => ({text: handleUpdateInstance(store, args)}));
    const result = await executeGraphQL(store, 'mutation', {document: `mutation {
      first: updateInstance(input: {body: "Must not save."}) {error}
      second: updateInstance(input: {automations: {upsert: [{name: "task", schedule: {at: "2099-01-01T00:00:00Z"}, run: {model: "CUSTOM", prompt: {create: {name: "Instructions", description: "Instructions", body: "Write.", bodyFile: "/tmp/other"}}}}]}}) {error}
    }`}, {mutate});
    expect(result.errors?.[0].message).toContain('bodyFile');
    expect(mutate).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
    expect(store.getArtifacts().size).toBe(0);
  });

  it('rejects raw text and attachment handles using native GraphQL input validation', async () => {
    for (const prompt of ['"Write."', '{existingId: "#artifact/2026-10-08-prompt/file.md"}']) {
      const mutate = vi.fn();
      const result = await executeGraphQL(store, 'mutation', {document: `mutation {updateInstance(input: {automations: {upsert: [{name: "task", schedule: {at: "2099-01-01T00:00:00Z"}, run: {model: "CUSTOM", prompt: ${prompt}}}]}}) {error}}`}, {mutate});
      expect(result.errors).toBeDefined();
      expect(mutate).not.toHaveBeenCalled();
      expect(store.getArtifacts().size).toBe(0);
    }
  });

  it.each(['Saved literal instructions', {artifact: '#artifact/2026-10-08-instructions'}, '#artifact/2026-10-08-instructions/alternate.txt'])('diagnoses an invalid saved prompt without rewriting it: %j', async prompt => {
    const file = join(dir, 'aside.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n---(?=\n)/, `\nautomations: ${JSON.stringify({legacy: {schedule, run: {model: 'CUSTOM', prompt}}})}\n---`));
    store.rebuild();
    const original = readFileSync(file, 'utf8');
    const metadata = await executeGraphQL(store, 'query', {document: 'query {activeInstance {automations {nodes {name run {model}}}}}'});
    expect(metadata.errors).toBeUndefined();
    expect((metadata.data as any).activeInstance.automations.nodes).toEqual([{name: 'legacy', run: null}]);
    expect(metadata.extensions!.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code: 'invalid_automation', file, field: 'automations.legacy'})]));
    handleUpdateInstance(store, {body: 'Updated context.'});
    expect((store.getManifest().automations!.legacy as any).run.prompt).toEqual(prompt);
    expect(readFileSync(file, 'utf8').split('---')[1]).toBe(original.split('---')[1]);
    executeOwner('updateInstance', {automations: {patch: [{name: 'legacy', run: {prompt: {create: {name: 'Repaired instructions', description: 'Instructions', body: 'Do the work.'}}}}]}});
    expect((store.getManifest().automations!.legacy as any).run.prompt).toBe('#artifact/2026-10-08-repaired-instructions');
  });
});

describe('deferred linked mutation writes', () => {
  it('fires once before the first write and permits nested writes', () => {
    const effects: string[] = [];
    trackMutation(store, () => {
      const release = beforeMutationWrite(store, () => {effects.push('create'); persistMutationWrite(store, {kind: 'artifact', id: 'prompt', effect: 'CREATED'}, () => effects.push('artifact'));});
      try {
        persistMutationWrite(store, {kind: 'project', id: project, effect: 'UPDATED'}, () => effects.push('owner'));
        persistMutationWrite(store, {kind: 'index', id: project, effect: 'UPDATED'}, () => effects.push('index'));
      } finally {release();}
    });
    expect(effects).toEqual(['create', 'artifact', 'owner', 'index']);
  });

  it('cleans an unused hook without creating anything and requires an active journal', () => {
    const action = vi.fn();
    trackMutation(store, () => {const release = beforeMutationWrite(store, action); release(); persistMutationWrite(store, {kind: 'project', id: project, effect: 'UPDATED'}, () => {});});
    expect(action).not.toHaveBeenCalled();
    expect(() => beforeMutationWrite(store, action)).toThrow('active mutation journal');
  });
});
