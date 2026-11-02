import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateEntry, handleUpdateProject } from '../src/mcp/tools/update.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import * as models from '../src/automation/models.js';

let dir: string, store: Store, host: InstanceHost, entry: string, projects: string[], actions: string[];
async function graph(field: string, input: unknown) {
  const type = field === 'updateEntry' ? 'UpdateEntryInput' : 'UpdateProjectInput';
  const id = field === 'updateEntry' ? entry : projects[0];
  const selection = field === 'updateEntry' ? 'entry { projects(limit: 100) { nodes { id } } actions(limit: 100) { nodes { id } } content } createdProjects { id } createdActions { id }' : 'project { relatedProjects { nodes { project { id } outgoingDescription } } body }';
  return JSON.parse((await host.tool(dir, 'mutate', {document: `mutation($input: ${type}!) { ${field}(id: "${id}", input: $input) { ${selection} } }`, variables: {input}})).text);
}
const ids = (page: {nodes: {id: string}[]}) => page.nodes.map(node => node.id).sort();
const relationships = (project: {relatedProjects: {nodes: {project: {id: string}; outgoingDescription: string | null}[]}}) => project.relatedProjects.nodes
  .map(link => ({project: link.project.id, description: link.outgoingDescription})).sort((a, b) => a.project.localeCompare(b.project));

beforeEach(() => {
  dir = mkdtempSync('/tmp/aside-link-edits-');
  init(dir, {name: 'Link edits', description: 'Link edits'});
  store = new Store(dir);
  const captured = handleCapture(store, {content: 'Start', description: 'Start',
    projects: ['A', 'B', 'C'].map(name => ({name, description: name})),
    actions: ['First', 'Second', 'Third'].map(name => ({name, description: name})),
  }, new Date(2026, 9, 8, 12));
  entry = captured.entryId; projects = captured.createdProjectIds; actions = captured.createdActionIds;
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(models, 'catalogFor').mockResolvedValue({models: [], diagnostics: [], revision: 'links'});
  host = new InstanceHost(new CalClient(null));
});
afterEach(async () => {await host.close(); store.close(); vi.restoreAllMocks(); rmSync(dir, {recursive: true, force: true});});

describe('GraphQL collection patches', () => {
  it('removes only specified tags and keeps unselected tags and content', async () => {
    const result = await graph('updateEntry', {projects: {remove: [projects[1]]}, actions: {remove: [actions[0]]}});
    expect(result.errors).toBeUndefined();
    const updated = result.data.updateEntry.entry;
    expect(updated.content).toBe('Start');
    expect(ids(updated.projects)).toEqual([projects[0], projects[2]].sort());
    expect(ids(updated.actions)).toEqual(actions.slice(1).sort());
  });

  it('can create and link records through patches, returning the saved IDs', async () => {
    const result = await graph('updateEntry', {projects: {add: [{create: {name: 'Added project', description: 'Added'}}]}, actions: {add: [{create: {name: 'Added action', description: 'Added'}}]}});
    expect(result.errors).toBeUndefined();
    const payload = result.data.updateEntry;
    expect(payload.createdProjects).toHaveLength(1); expect(payload.createdActions).toHaveLength(1);
    expect(ids(payload.entry.projects)).toEqual([...projects, payload.createdProjects[0].id].sort());
    expect(ids(payload.entry.actions)).toEqual([...actions, payload.createdActions[0].id].sort());
  });

  it('replaces tags through set while supporting creation and retaining unlinked records', async () => {
    const result = await graph('updateEntry', {
      projects: {set: [{existingId: projects[1]}, {create: {name: 'Replacement project', description: 'Replacement'}}]},
      actions: {set: [{create: {name: 'Replacement action', description: 'Replacement'}}]},
    });
    expect(result.errors).toBeUndefined();
    const payload = result.data.updateEntry;
    expect(payload.createdProjects).toHaveLength(1); expect(payload.createdActions).toHaveLength(1);
    expect(ids(payload.entry.projects)).toEqual([projects[1], payload.createdProjects[0].id].sort());
    expect(ids(payload.entry.actions)).toEqual([payload.createdActions[0].id]);
    const fresh = new Store(dir);
    try {
      for (const id of projects) expect(fresh.getProject(id)).toBeDefined();
      for (const id of actions) expect(fresh.getAction(id)).toBeDefined();
    } finally {fresh.close();}
  });

  it('preserves tags with null edit objects and clears them through an explicit empty set', async () => {
    const unchanged = await graph('updateEntry', {projects: null, actions: null});
    expect(unchanged.errors).toBeUndefined();
    expect(ids(unchanged.data.updateEntry.entry.projects)).toEqual([...projects].sort());
    expect(ids(unchanged.data.updateEntry.entry.actions)).toEqual([...actions].sort());
    const cleared = await graph('updateEntry', {projects: {set: []}, actions: {set: []}});
    expect(cleared.errors).toBeUndefined();
    expect(cleared.data.updateEntry.entry.projects.nodes).toEqual([]);
    expect(cleared.data.updateEntry.entry.actions.nodes).toEqual([]);
  });

  it('treats re-added saved tags and absent removals as harmless', async () => {
    const input = {projects: {add: [{existingId: projects[0]}], remove: ['missing']}, actions: {add: [{existingId: actions[0]}], remove: ['missing']}};
    const first = await graph('updateEntry', input), second = await graph('updateEntry', input);
    expect(first.errors).toBeUndefined(); expect(second.errors).toBeUndefined();
    expect(ids(second.data.updateEntry.entry.projects)).toEqual([...projects].sort());
    expect(ids(second.data.updateEntry.entry.actions)).toEqual([...actions].sort());
  });

  it('removes dangling tag IDs without requiring the target to exist', async () => {
    const file = store.getEntryFile(entry)!;
    writeFileSync(file, readFileSync(file, 'utf8').replace('projects:', 'projects: [missing]\nold_projects:'));
    const result = await graph('updateEntry', {projects: {remove: ['missing']}});
    expect(result.errors).toBeUndefined();
    expect(result.data.updateEntry.entry.projects.nodes).toEqual([]);
  });

  it('rejects removed raw ID arrays while preserving resolved relationship IDs', async () => {
    const result = JSON.parse((await host.tool(dir, 'query', {document: `query { entry(id: "${entry}") { projectIds actionIds } }`})).text);
    expect(result.errors.map((error: {message: string}) => error.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('Cannot query field "projectIds"'),
      expect.stringContaining('Cannot query field "actionIds"'),
    ]));
    const valid = JSON.parse((await host.tool(dir, 'query', {document: `query { entry(id: "${entry}") { projects { nodes { id } } actions { nodes { id } } } }`})).text);
    expect(valid.errors).toBeUndefined();
    expect(ids(valid.data.entry.projects)).toEqual([...projects].sort());
    expect(ids(valid.data.entry.actions)).toEqual([...actions].sort());
  });

  it('preserves tags from a newer disk edit before the watcher observes them', () => {
    const file = store.getEntryFile(entry)!;
    const source = readFileSync(file, 'utf8');
    writeFileSync(file, source.replace('projects: [', 'projects: [unobserved-project, ').replace('actions: [', 'actions: [unobserved-action, '));
    handleUpdateEntry(store, {id: entry, projectEdits: {remove: [projects[1]]}, actionEdits: {remove: [actions[1]]}});
    expect(store.getEntries().find(item => item.meta.created === entry)!.meta.projects).toEqual(['unobserved-project', projects[0], projects[2]]);
    expect(store.getEntries().find(item => item.meta.created === entry)!.meta.actions).toEqual(['unobserved-action', actions[0], actions[2]]);
  });

  it('refuses to discard malformed saved tags before creating linked records', () => {
    const file = store.getEntryFile(entry)!;
    const source = readFileSync(file, 'utf8').replace(/projects: \[[^\n]*\]/, `projects: [123, ${projects[0]}]`);
    writeFileSync(file, source);
    expect(() => handleUpdateEntry(store, {id: entry, projectEdits: {add: [{name: 'Must not create', description: 'No'}]}})).toThrow('list of text IDs');
    expect(readFileSync(file, 'utf8')).toBe(source); expect(store.getProjectIds()).toEqual(projects);
  });

  it.each([
    {projects: {set: null}},
    {projects: {set: [], add: []}},
    {actions: {set: [], remove: ['missing']}},
    {projects: {add: [{existingId: 'same'}, {existingId: 'same'}]}},
    {actions: {add: [{existingId: 'same'}], remove: ['same']}},
    {projects: {remove: ['same', 'same']}},
  ])('rejects collection conflicts before earlier mutation fields run (%j)', async input => {
    const original = readFileSync(join(dir, 'aside.md'), 'utf8');
    const result = JSON.parse((await host.tool(dir, 'mutate', {document: `mutation($input: UpdateEntryInput!) { first: updateInstance(input: {body: "Must not save"}) { error } second: updateEntry(id: "${entry}", input: $input) { error } }`, variables: {input}})).text);
    expect(result.errors).toBeDefined(); expect(result.extensions.mutations).toEqual([]);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toBe(original);
  });

  it('patches individual relationship descriptions and preserves unrelated YAML and exact omitted body', async () => {
    handleUpdateProject(store, {id: projects[0], related_projects: [
      {project: projects[1], description: 'Original B'}, {project: projects[2], description: 'Original C'},
    ]});
    const file = store.getProjectFile(projects[0])!;
    const body = '\n\n    indented code\n\n\n';
    writeFileSync(file, readFileSync(file, 'utf8').replace(/description: "?Original C"?/, 'description: "Original C" # retain\n    custom: 90071992547409931234').replace(/\n---\n[\s\S]*$/, `\n---${body}`));
    expect(readFileSync(file, 'utf8')).toContain('# retain');
    const result = await graph('updateProject', {relatedProjects: {upsert: [{project: projects[1], description: 'Updated B'}]}});
    expect(result.errors).toBeUndefined();
    expect(relationships(result.data.updateProject.project)).toEqual([{project: projects[1], description: 'Updated B'}, {project: projects[2], description: 'Original C'}]);
    expect(readFileSync(file, 'utf8')).toContain('# retain');
    expect(readFileSync(file, 'utf8')).toContain('90071992547409931234');
    expect(readFileSync(file, 'utf8').endsWith(body)).toBe(true);
  });

  it('upserts, removes, and replays relationship patches without duplicating links', async () => {
    const add = {relatedProjects: {upsert: [{project: projects[1], description: 'Supports B'}, {project: projects[2], description: 'Supports C'}]}};
    await graph('updateProject', add); const repeated = await graph('updateProject', add);
    expect(repeated.errors).toBeUndefined(); expect(repeated.data.updateProject.project.relatedProjects.nodes).toHaveLength(2);
    const remove = await graph('updateProject', {relatedProjects: {remove: [projects[1], 'missing']}});
    expect(remove.errors).toBeUndefined(); expect(relationships(remove.data.updateProject.project)).toEqual([{project: projects[2], description: 'Supports C'}]);
  });

  it('patches relationships whose metadata field key is a YAML alias', () => {
    const file = store.getProjectFile(projects[0])!;
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n---(?=\n)/, `\nkey: &linksKey related_projects\n*linksKey :\n  - project: ${projects[1]}\n    description: First\n---`));
    handleUpdateProject(store, {id: projects[0], relatedProjectEdits: {upsert: [{project: projects[2], description: 'Second'}]}});
    expect(store.getProject(projects[0])!.frontMatter.related_projects).toEqual([{project: projects[1], description: 'First'}, {project: projects[2], description: 'Second'}]);
    expect(readFileSync(file, 'utf8')).toContain('*linksKey');
    handleUpdateProject(store, {id: projects[0], relatedProjectEdits: {remove: [projects[1], projects[2]]}});
    expect(store.getProject(projects[0])!.frontMatter.related_projects).toBeUndefined();
  });

  it('validates all target additions before creating any new record', async () => {
    const before = store.getProjectIds();
    const result = await graph('updateEntry', {projects: {add: [{create: {name: 'Must not create', description: 'No'}}, {existingId: 'missing'}]}});
    expect(result.errors).toBeDefined();
    const fresh = new Store(dir); expect(fresh.getProjectIds()).toEqual(before); fresh.close();
  });
});
