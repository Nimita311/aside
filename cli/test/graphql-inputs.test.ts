import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateAction, handleUpdateEntry } from '../src/mcp/tools/update.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';
import { authoredAutomationModels, authoredAutomationPrompts, normalizeActionStatus, normalizeMutationArguments } from '../src/graphql/inputs.js';
import { executeGraphQL } from '../src/graphql/schema.js';

const now = new Date(2026, 9, 8, 12);
const job = (name = 'daily') => ({name, schedule: {cron: '0 9 * * *'}, run: {script: '/bin/true'}});
const update = (field: string, input: Record<string, unknown>, id = 'target') => normalizeMutationArguments(field,
  {input, ...(['updateEntry', 'updateProject', 'updateAction', 'updateArtifact'].includes(field) ? {id} : {})}, {now}).input;

function withStore(test: (store: Store, dir: string) => void): void {
  const dir = mkdtempSync('/tmp/aside-graphql-inputs-');
  init(dir, {name: 'Input normalization', description: 'Input normalization'});
  const store = new Store(dir);
  try {test(store, dir);} finally {store.close(); rmSync(dir, {recursive: true, force: true});}
}

describe('GraphQL mutation input normalization', () => {
  it('maps field names only in their known input contexts', () => {
    const source = {contentFile: '/tmp/content.md', description: 'Content',
      projects: [{create: {name: 'Project', description: 'Project', bodyFile: '/tmp/project.md', relatedProjects: [{project: 'other', description: 'Related'}],
        automations: [{name: 'agent', schedule: {at: '2026-11-01T00:00:00Z'}, run: {model: 'CUSTOM', prompt: {existingId: '2026-10-08-body-file'}}}],
      }}],
      actions: [{create: {name: 'Action', description: 'Action', calendarAccount: 'Work', bodyFile: '/tmp/action.md'}}],
    };
    const result = normalizeMutationArguments('capture', {input: source}).input;
    expect(result.content_file).toBe('/tmp/content.md');
    expect(result.projects[0]).toMatchObject({body_file: '/tmp/project.md', related_projects: [{project: 'other', description: 'Related'}]});
    expect(result.actions[0]).toMatchObject({calendar_account: 'Work', body_file: '/tmp/action.md'});
    expect(result.projects[0].automations.agent.run.prompt).toEqual('#artifact/2026-10-08-body-file');
    expect(source.projects[0].create).toHaveProperty('bodyFile');
    expect(update('updateArtifact', {bodyFile: '/tmp/body.md', attachments: [{source: '/tmp/context.md'}], removeAttachments: ['old.md']}))
      .toEqual({body_file: '/tmp/body.md', files: [{source: '/tmp/context.md'}], remove_files: ['old.md']});
  });

  it('retains inline contents verbatim instead of recursively renaming authored words', () => {
    const body = '{"bodyFile":"a", "model":"b", "setEnd":"c"}';
    expect(update('updateProject', {body})).toEqual({body});
    expect(authoredAutomationModels({input: {body, content: body}})).toEqual([]);
  });

  it('normalizes tag replacement, selected additions, and null preservation distinctly', () => {
    expect(update('updateEntry', {projects: {set: [{existingId: 'A'}]}, actions: {set: []}})).toEqual({projects: ['A'], actions: []});
    expect(update('updateEntry', {projects: {add: [{existingId: 'C'}], remove: ['B']}})).toEqual({projectEdits: {add: ['C'], remove: ['B']}});
    expect(update('updateEntry', {projects: null, actions: null, description: 'Keep tags'})).toEqual({description: 'Keep tags'});
  });

  it.each([
    {projects: {set: null}},
    {projects: {set: [], add: []}},
    {projects: {set: [], remove: null}},
    {projects: {add: [{existingId: 'A'}, {existingId: 'A'}]}},
    {actions: {add: [{existingId: 'A'}], remove: ['A']}},
    {projects: {set: [{create: {name: 'Same!', description: 'One'}}, {create: {name: 'Same', description: 'Two'}}]}},
    {projects: {add: [{existingId: 'A', create: {name: 'Also', description: 'Also'}}]}},
  ])('rejects ambiguous or conflicting tag edits during preflight: %j', input => {
    expect(() => update('updateEntry', input)).toThrow();
  });

  it('creates records and retains unrelated entry tags through incremental edits', () => withStore(store => {
    const captured = handleCapture(store, {content: 'Entry', description: 'Entry', projects: [{name: 'Original', description: 'Original'}]}, now);
    const normalized = update('updateEntry', {
      projects: {add: [{create: {name: 'Added', description: 'Added'}}]},
      actions: {add: [{create: {name: 'Task', description: 'Task', calendarAccount: 'Work'}}]},
    }, captured.entryId);
    const result = handleUpdateEntry(store, {id: captured.entryId, ...normalized}, now);
    const entry = store.getEntries().find(record => record.meta.created === captured.entryId)!;
    expect(entry.meta.projects).toEqual([...captured.createdProjectIds, ...result.createdProjectIds]);
    expect(entry.meta.actions).toEqual(result.createdActionIds);
    expect(store.getAction(result.createdActionIds[0])!.frontMatter.calendar_account).toBe('Work');

    const replacement = update('updateEntry', {projects: {set: []}}, captured.entryId);
    handleUpdateEntry(store, {id: captured.entryId, ...replacement}, now);
    expect(store.getEntries().find(record => record.meta.created === captured.entryId)!.meta.projects).toBeUndefined();
    expect(store.getProject(captured.createdProjectIds[0])).toBeDefined();
  }));

  it('puts replacement and partial related-project edits through the same public field', () => {
    const related = {project: 'B', description: 'Depends on'};
    expect(update('updateProject', {relatedProjects: {set: [related]}})).toEqual({related_projects: [related]});
    expect(update('updateProject', {relatedProjects: {upsert: [related], remove: ['C']}})).toEqual({relatedProjectEdits: {upsert: [related], remove: ['C']}});
    expect(() => update('updateProject', {relatedProjects: {set: [], upsert: []}})).toThrow('exclusive');
    expect(() => update('updateProject', {relatedProjects: {upsert: [related], remove: ['B']}})).toThrow('both');
    expect(() => update('updateProject', {relatedProjects: {set: [related, related]}})).toThrow('repeat');
  });

  it.each(['projects', 'actions'])('identifies the authored %s command in duplicate-tag errors', kind => {
    const links = [{existingId: 'A'}, {existingId: 'A'}];
    expect(() => update('updateEntry', {[kind]: {set: links}})).toThrow(`${kind}.set must not repeat an ID.`);
    expect(() => update('updateEntry', {[kind]: {add: links}})).toThrow(`${kind}.add must not repeat an ID.`);
  });

  it('identifies replacement and incremental public relationship paths', () => {
    const link = {project: 'A', description: 'Relationship'};
    expect(() => update('updateProject', {relatedProjects: {set: [link, link]}})).toThrow('relatedProjects.set must not repeat a project ID.');
    expect(() => update('updateProject', {relatedProjects: {upsert: [link, link]}})).toThrow('relatedProjects.upsert must not repeat a project ID.');
    expect(() => update('updateProject', {relatedProjects: {upsert: [link], remove: ['A']}})).toThrow('relatedProjects cannot both upsert and remove a project ID.');
  });

  it.each([
    ['updateAction', {bodyFile: null}, 'bodyFile'],
    ['updateEntry', {contentFile: null}, 'contentFile'],
    ['updateArtifact', {removeAttachments: null}, 'removeAttachments'],
    ['updateAction', {calendarAccount: 42}, 'calendarAccount'],
    ['updateAction', {recurrence: {setEnd: {schedule: {dtstart: '2030-01-01'}, at: null}}}, 'recurrence.setEnd.at'],
    ['updateInstance', {settings: {recurrenceLookaheadDays: null}}, 'settings.recurrenceLookaheadDays'],
    ['updateEntry', {projects: {set: [{create: {name: 'P', description: 'P', bodyFile: null}}]}}, 'projects.set.0.create.bodyFile'],
    ['updateEntry', {actions: {add: [{create: {name: 'A', description: 'A', calendarAccount: null}}]}}, 'actions.add.0.create.calendarAccount'],
  ] as const)('reports public typed paths for %s invalid inputs: %s', (field, input, path) => {
    expect(() => update(field, input)).toThrow(`Invalid ${field} arguments: ${path}:`);
  });

  it('reports nested capture creation paths without unused union alternatives', () => {
    const input = {content: 'Entry', description: 'Entry', projects: [{create: {name: 'P', description: 'P', bodyFile: null}}]};
    expect(() => normalizeMutationArguments('capture', {input})).toThrow('Invalid capture arguments: projects.0.create.bodyFile: Invalid input: expected string, received null');
  });

  it('preserves authored names when translating generated edit prefixes', () => {
    const name = 'body_file.relatedProjectEdits.content_file';
    expect(() => update('updateInstance', {automations: {patch: [{name, enabled: 'invalid'}]}}))
      .toThrow(`automations.patch.${name}: automation patch.enabled must be a boolean`);
    expect(() => update('updateInstance', {automations: {remove: [name, name]}}))
      .toThrow('automations.remove must not repeat an automation name.');
  });

  it('rejects a later malformed public input before an earlier mutation can write', async () => {
    const dir = mkdtempSync('/tmp/aside-graphql-validation-');
    init(dir, {name: 'Validation paths', description: 'Validation paths'});
    const store = new Store(dir);
    try {
      const captured = handleCapture(store, {content: 'Entry', description: 'Entry', actions: [{name: 'Task', description: 'Task'}]}, now);
      const id = captured.createdActionIds[0], file = store.getActionFile(id)!;
      const before = readFileSync(file, 'utf8');
      const mutate = vi.fn((operation, input) => handleUpdateAction(store, input));
      const result = await executeGraphQL(store, 'mutation', {document: `mutation {
        first: updateAction(id: "${id}", input: {body: "Authored body_file and content_file"}) { error }
        invalid: updateAction(id: "${id}", input: {bodyFile: null}) { error }
      }`}, {mutate});
      expect(result.errors).toEqual([expect.objectContaining({message: 'Invalid updateAction arguments: bodyFile: Invalid input: expected string, received null'})]);
      expect(mutate).not.toHaveBeenCalled();
      expect(readFileSync(file, 'utf8')).toBe(before);

      const authored = 'body_file; content_file; relatedProjectEdits.upsert; set_end';
      const failed = await executeGraphQL(store, 'mutation', {document: `mutation($body: String!) {
        updateAction(id: "${id}", input: {body: $body}) { error }
      }`, variables: {body: authored}}, {mutate: (_operation, input) => {
        expect(input.body).toBe(authored);
        throw new Error(`Authored name: "${authored}"`);
      }});
      expect(JSON.stringify(failed.errors)).toContain(`Authored name: \\"${authored}\\"`);
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {store.close(); rmSync(dir, {recursive: true, force: true});}
  });

  it('normalizes complete automation lists, named patch lists, and explicit clearing', () => {
    expect(update('updateInstance', {automations: {set: [job()]}}).automations).toEqual({daily: {schedule: {cron: '0 9 * * *'}, run: {script: '/bin/true'}}});
    expect(update('updateInstance', {automations: {set: []}}).automations).toEqual({});
    expect(update('updateInstance', {automations: null})).toEqual({});
    const normalized = update('updateProject', {automations: {patch: [{name: 'daily', timeout: null, run: {model: 'CUSTOM', prompt: {existingId: '2026-10-08-prompt'}}}], remove: ['old']}});
    expect(normalized.automationEdits).toMatchObject({patch: {daily: {timeout: null, run: {model: 'CUSTOM', prompt: '#artifact/2026-10-08-prompt'}}}, remove: ['old']});
    expect(authoredAutomationModels({input: normalized})).toEqual(['CUSTOM']);
  });

  it('normalizes artifact prompt links without persisting inline creation definitions', () => {
    const artifact = {name: 'Prompt bodyFile', description: 'Instructions', bodyFile: '/tmp/prompt.md', attachments: [{source: '/tmp/data.csv'}]};
    const args = normalizeMutationArguments('updateInstance', {input: {automations: {upsert: [{name: 'task', schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: 'CUSTOM', prompt: {create: artifact}}}]}}}, {now});
    expect(args.input.automationEdits.upsert.task.run.prompt).toEqual('#artifact/2026-10-08-prompt-bodyfile');
    expect(authoredAutomationPrompts(args)).toEqual([{id: '2026-10-08-prompt-bodyfile', now, create: {name: 'Prompt bodyFile', description: 'Instructions', body_file: '/tmp/prompt.md', files: [{source: '/tmp/data.csv'}]}}]);
    expect(artifact).toHaveProperty('bodyFile');
    expect(authoredAutomationPrompts({...args})).toEqual([]);
  });

  it.each(['Raw text', {artifact: '#artifact/2026-10-08-prompt'}, {existingId: '#artifact/2026-10-08-prompt'}, {existingId: '2026-10-08-prompt/file.md'}, {existingId: '2026-10-08-prompt', create: {name: 'Other', description: 'Other'}}])('rejects invalid prompt link %j', prompt => {
    expect(() => update('updateInstance', {automations: {upsert: [{name: 'task', schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: 'CUSTOM', prompt}}]}})).toThrow();
  });

  it.each([
    {set: null},
    {set: [], patch: []},
    {set: [], remove: null},
    {upsert: [job(), job()]},
    {patch: [{name: 'daily', enabled: true}, {name: 'daily', enabled: false}]},
    {upsert: [job()], remove: ['daily']},
    {patch: [{name: 'daily', schedule: null}]},
    {upsert: [{...job(), schedule: {cron: 'invalid'}}]},
  ])('rejects invalid automation edits before execution: %j', edit => {
    expect(() => update('updateInstance', {automations: edit})).toThrow();
  });

  it('patches automation YAML while retaining unrelated declarations', () => withStore(store => {
    handleUpdateInstance(store, update('updateInstance', {automations: {set: [job('first'), job('second')]}}));
    handleUpdateInstance(store, update('updateInstance', {automations: {patch: [{name: 'first', enabled: false}], remove: ['second']}}));
    expect(store.getInstance()!.manifest.automations).toEqual({first: {schedule: {cron: '0 9 * * *'}, run: {script: '/bin/true'}, enabled: false}});
    handleUpdateInstance(store, update('updateInstance', {automations: {set: []}}));
    expect(store.getInstance()!.manifest.automations).toBeUndefined();
  }));

  it('patches settings through the grouped input and preserves explicit default restoration', () => withStore(store => {
    const normalized = update('updateInstance', {settings: {recurrenceLookaheadDays: 45, scheduledEventTitlePrefix: 'Now: ', doneEventTitlePrefix: null}});
    expect(normalized).toEqual({recurrenceLookaheadDays: 45, scheduledEventTitlePrefix: 'Now: ', doneEventTitlePrefix: null});
    handleUpdateInstance(store, normalized);
    expect(store.getInstance()!.manifest.config).toMatchObject({recurrenceLookaheadDays: 45, scheduledEventTitlePrefix: 'Now: '});
    expect(store.getInstance()!.manifest.config).not.toHaveProperty('doneEventTitlePrefix');
    expect(() => update('updateInstance', {settings: {recurrenceLookaheadDays: null}})).toThrow();
  }));

  it('rejects conflicting content sources in top-level and newly created records', () => {
    expect(() => normalizeMutationArguments('capture', {input: {description: 'Missing content'}})).toThrow('Provide content');
    expect(() => update('updateProject', {body: '', bodyFile: '/tmp/body.md'})).toThrow('bodyFile');
    expect(() => update('updateEntry', {projects: {add: [{create: {name: 'P', description: 'P', body: '', bodyFile: '/tmp/body.md'}}]}})).toThrow('bodyFile');
    expect(() => update('updateOccurrence', {template: 'T', original: '2026-10-08'})).toThrow('edit is required');
  });

  it('copies bodyFile content when creating child projects through set', () => withStore((store, dir) => {
    const source = join(dir, 'source.md');
    writeFileSync(source, 'Project body from a file');
    const captured = handleCapture(store, {content: 'Entry', description: 'Entry'}, now);
    const normalized = update('updateEntry', {projects: {set: [{create: {name: 'From file', description: 'File', bodyFile: source}}]}}, captured.entryId);
    const result = handleUpdateEntry(store, {id: captured.entryId, ...normalized}, now);
    expect(store.getProject(result.createdProjectIds[0])!.body).toBe('Project body from a file');
    expect(readFileSync(source, 'utf8')).toBe('Project body from a file');
  }));
});

describe('GraphQL action status commands', () => {
  it('reactivates a saved scheduled action without inventing or replacing its time', () => {
    const input = update('updateAction', {status: 'scheduled'});
    expect(input).toEqual({status: 'scheduled'});
    expect(normalizeActionStatus(input, {scheduled: '2026-10-10T10:00'})).toEqual({resolution: null});
    expect(() => normalizeActionStatus(input, {})).toThrow('requires a scheduled time');
    expect(() => update('updateAction', {status: 'scheduled', scheduled: null})).toThrow('requires');
  });

  it('clears schedule and resolution together for BACKLOG and preserves timing for terminal statuses', () => {
    expect(normalizeActionStatus({status: 'backlog'}, {scheduled: '2026-10-10'})).toEqual({scheduled: null, resolution: null});
    expect(normalizeActionStatus({status: 'done'}, {scheduled: '2026-10-10'})).toEqual({resolution: 'done'});
    expect(normalizeActionStatus({status: 'cancelled', scheduled: '2026-10-11'}, {})).toEqual({resolution: 'cancelled', scheduled: '2026-10-11'});
    expect(() => update('updateAction', {status: 'backlog', scheduled: '2026-10-10'})).toThrow('cannot');
  });

  it('reserves null status for templates, including conversion and dormant templates', () => {
    expect(normalizeActionStatus({status: null}, {recurrence: []})).toEqual({scheduled: null, resolution: null});
    const append = {append: {dtstart: '2030-01-01', rrule: 'FREQ=DAILY'}};
    expect(normalizeActionStatus({status: null, recurrence: append}, {scheduled: '2026-10-10'})).toEqual({recurrence: append, scheduled: null, resolution: null});
    expect(() => normalizeActionStatus({status: null}, {})).toThrow('Only recurrence templates');
    expect(() => normalizeActionStatus({status: 'done'}, {recurrence: []})).toThrow('template');
    expect(() => normalizeActionStatus({status: null, recurrence: append}, {occurrence: {template: 'T', original: '2026-10-10'}})).toThrow('template action');
    expect(() => update('updateAction', {status: 'backlog', recurrence: append})).toThrow('template');
  });

  it('maps recurrence commands to stored names without changing schedule selectors', () => {
    const setEnd = {schedule: {dtstart: '2030-01-01T00:00', timezone: 'UTC'}, at: '2030-02-01T00:00:00Z'};
    expect(update('updateAction', {recurrence: {setEnd}})).toEqual({recurrence: {set_end: setEnd}});
  });

  it('persists lifecycle commands through storage resolution and scheduled fields', () => withStore(store => {
    const result = handleCapture(store, {content: 'Entry', description: 'Entry', actions: [{name: 'Task', description: 'Task', scheduled: '2026-10-10T10:00'}]}, now);
    const id = result.createdActionIds[0];
    const write = (input: Record<string, unknown>) => handleUpdateAction(store, {id, ...normalizeActionStatus(update('updateAction', input, id), store.getAction(id)!.frontMatter)});
    write({status: 'done'});
    expect(store.getAction(id)!.frontMatter).toMatchObject({resolution: 'done', scheduled: '2026-10-10T10:00'});
    write({status: 'scheduled'});
    expect(store.getAction(id)!.frontMatter.resolution).toBeUndefined();
    expect(store.getAction(id)!.frontMatter.scheduled).toBe('2026-10-10T10:00');
    write({status: 'backlog'});
    expect(store.getAction(id)!.frontMatter.resolution).toBeUndefined();
    expect(store.getAction(id)!.frontMatter.scheduled).toBeUndefined();
    expect(readFileSync(store.getActionFile(id)!, 'utf8')).not.toContain('status:');
  }));
});
