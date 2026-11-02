import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {Store} from '../src/mcp/store.js';
import {handleCapture} from '../src/mcp/tools/capture.js';
import {handleUpdateAction, handleUpdateEntry, handleUpdateProject} from '../src/mcp/tools/update.js';
import {createArtifact, handleUpdateArtifact} from '../src/mcp/tools/artifact.js';
import {handleUpdateOccurrence} from '../src/mcp/tools/recurrence.js';
import {handleUpdateInstance} from '../src/mcp/tools/instance.js';
import {executeGraphQL, type MutationRunner} from '../src/graphql/schema.js';
import {MutationWriteError, trackMutation} from '../src/mcp/tools/mutation-result.js';
import * as history from '../src/mcp/recurrence-history.js';
import {InstanceSession} from '../src/mcp/instance-session.js';
import {InstanceRegistry} from '../src/mcp/instance-registry.js';
import {InstanceHost} from '../src/daemon/host.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {CalSync} from '../src/mcp/calendar/sync.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {...actual, renameSync: vi.fn(actual.renameSync), unlinkSync: vi.fn(actual.unlinkSync)};
});
const NOW = new Date(2026, 9, 2, 10);
const nativeRename = vi.mocked(renameSync).getMockImplementation()!;
const nativeUnlink = vi.mocked(unlinkSync).getMockImplementation()!;

describe('confirmed results when a mutation only partly persists', () => {
  let dir: string, store: Store;
  const mutate: MutationRunner = (operation, args: any) => {
    switch (operation) {
      case 'capture': return handleCapture(store, args, NOW);
      case 'update_entry': return {...handleUpdateEntry(store, args, NOW), entryId: args.id};
      case 'update_action': return {id: args.id, text: handleUpdateAction(store, args, NOW)};
      case 'update_project': return {id: args.id, text: handleUpdateProject(store, args)};
      case 'update_instance': return {text: handleUpdateInstance(store, args)};
      case 'create_artifact': return createArtifact(store, args, NOW);
      case 'update_artifact': return {id: args.id, text: handleUpdateArtifact(store, args)};
      case 'update_occurrence': return handleUpdateOccurrence(store, args, NOW);
      default: throw new Error(`Unexpected ${operation}`);
    }
  };
  const graph = (document: string, variables?: Record<string, unknown>) => executeGraphQL(store, 'mutation', {document, variables}, {mutate});
  const partial = (result: any, operation: string) => {
    expect(result.errors).toBeUndefined();
    expect(result.extensions.mutations).toHaveLength(1);
    const marker = result.extensions.mutations[0];
    const payload = Object.values(result.data)[0] as any;
    expect(payload).not.toBeNull();
    expect(marker).toMatchObject({operation, error: expect.stringContaining('Partial failure')});
    expect(payload.error).toBe(marker.error);
    expect(marker.error).toContain('Recovery:');
    for (const field of ['receipt', 'status', 'failures', 'recovery']) expect(marker).not.toHaveProperty(field);
    return marker;
  };
  const failWrite = (target: string) => {
    vi.mocked(renameSync).mockImplementation((source, destination) => {
      if (destination === target) throw new Error('Injected write failure');
      nativeRename(source, destination);
    });
  };

  beforeEach(() => {
    vi.mocked(renameSync).mockImplementation(nativeRename);
    vi.mocked(unlinkSync).mockImplementation(nativeUnlink);
    dir = realpathSync(mkdtempSync('/tmp/aside-partial-mutations-'));
    writeFileSync(join(dir, 'aside.md'), '---\nid: partial-fixture\nname: Partial fixture\n---\n\nInstructions\n');
    store = new Store(dir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(dir, {recursive: true, force: true});
  });

  it('reports a project saved before its index failed, without claiming an entry or action was created', async () => {
    failWrite(join(dir, 'projects', '2026', 'index.yaml'));
    const result = await graph('mutation { capture(input: {content: "Context", description: "Context", projects: [{create: {name: "Saved", description: "Saved"}}], actions: [{create: {name: "Later", description: "Later"}}]}) { error entry { id } createdProjects { id } createdActions { id } } }');
    const marker = partial(result, 'capture');
    expect(marker.changes).toEqual([{kind: 'project', id: '2026-10-02-saved', effect: 'CREATED', path: join(dir, 'projects', '2026', '2026-10-02-saved.md')}]);
    expect(marker.error).toContain('index "2026-10-02-saved" [description]');
    expect(marker.error).toContain('Injected write failure');
    expect((result.data!.capture as any).entry).toBeNull();
    expect((result.data!.capture as any).createdProjects).toEqual([{id: '2026-10-02-saved'}]);
    expect((result.data!.capture as any).createdActions).toEqual([]);
    expect(store.getProject('2026-10-02-saved')).toBeDefined();
    expect(store.getActionIds()).toEqual([]);
    expect(store.getEntries()).toEqual([]);
  });

  it('reports earlier linked creates when a later record write fails', async () => {
    failWrite(join(dir, 'projects', '2026', '2026-10-02-second.md'));
    const marker = partial(await graph('mutation { capture(input: {content: "Context", description: "Context", projects: [{create: {name: "First", description: "First"}}, {create: {name: "Second", description: "Second"}}]}) { error } }'), 'capture');
    expect(marker.changes.map((item: any) => [item.kind, item.id])).toEqual([['project', '2026-10-02-first'], ['index', '2026-10-02-first']]);
    expect(existsSync(join(dir, 'projects', '2026', '2026-10-02-second.md'))).toBe(false);
  });

  it('retains the error and saved IDs in extensions when the payload error field is unselected', async () => {
    failWrite(join(dir, 'projects', '2026', 'index.yaml'));
    const result: any = await graph('mutation { capture(input: {content: "Context", description: "Context", projects: [{create: {name: "Saved", description: "Saved"}}]}) { createdProjects { id } entry { id } } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.capture).toEqual({createdProjects: [{id: '2026-10-02-saved'}], entry: null});
    expect(result.extensions.mutations).toEqual([expect.objectContaining({operation: 'capture', error: expect.stringContaining('Injected write failure'), changes: [expect.objectContaining({kind: 'project', id: '2026-10-02-saved'})]})]);
  });

  it('reports the saved entry ID when its final description write fails', async () => {
    failWrite(join(dir, 'notes', '2026', 'index.yaml'));
    const result = await graph('mutation { capture(input: {content: "Saved context", description: "Context"}) { error entry { id } } }');
    const marker = partial(result, 'capture');
    expect(marker.changes).toEqual([expect.objectContaining({kind: 'entry', id: '2026-10-02T10:00', effect: 'CREATED'})]);
    expect(store.getEntries().map(entry => entry.meta.created)).toEqual(['2026-10-02T10:00']);
    expect((result.data!.capture as any).entry).toEqual({id: '2026-10-02T10:00'});
  });

  it('retains IDs from updateEntry linked creates when the entry rewrite fails', async () => {
    const entry = handleCapture(store, {content: 'Original', description: 'Original'}, NOW);
    failWrite(store.getEntryFile(entry.entryId)!);
    const marker = partial(await graph('mutation($id: ID!) { updateEntry(id: $id, input: {content: "Replacement", actions: {add: [{create: {name: "Saved work", description: "Work"}}]}}) { error } }', {id: entry.entryId}), 'updateEntry');
    expect(marker.changes.map((item: any) => [item.kind, item.id])).toEqual([['action', '2026-10-02-saved-work'], ['index', '2026-10-02-saved-work']]);
    expect(store.getEntries()[0].content).toBe('Original');
    expect(store.getEntries()[0].meta.actions).toBeUndefined();
  });

  it.each(['action', 'project'] as const)('reports a saved %s update when its description fails', async kind => {
    const captured = handleCapture(store, {content: 'Context', description: 'Context', [kind === 'action' ? 'actions' : 'projects']: [{name: 'Original', description: 'Original'}]}, NOW);
    const id = kind === 'action' ? captured.createdActionIds[0] : captured.createdProjectIds[0];
    failWrite(join(dir, kind + 's', '2026', 'index.yaml'));
    const marker = partial(await graph(`mutation($id: ID!) { update${kind === 'action' ? 'Action' : 'Project'}(id: $id, input: {name: "Saved rename", description: "Failed description"}) { error } }`, {id}), kind === 'action' ? 'updateAction' : 'updateProject');
    expect(marker.changes).toEqual([expect.objectContaining({kind, id, effect: 'UPDATED'})]);
    expect((kind === 'action' ? store.getAction(id) : store.getProject(id))!.frontMatter.name).toBe('Saved rename');
    expect(store.getIndexDescription(kind + 's' as 'actions' | 'projects', id)).toBe('Original');
  });

  it('returns the saved action and an error when an unindexed action changes but its requested description cannot save', async () => {
    const id = '2026-10-02-hand-created', file = join(dir, 'actions', '2026', id + '.md');
    mkdirSync(dirname(file), {recursive: true});
    store.saveAction(id, {name: 'Original', created: '2026-10-02T10:00'}, '', file);
    const result: any = await graph('mutation($id: ID!) { updateAction(id: $id, input: {name: "Renamed", description: "Requested description"}) { error action { name } } }', {id});
    expect(result.errors).toBeUndefined();
    expect(result.data.updateAction.action.name).toBe('Renamed');
    const marker = partial(result, 'updateAction');
    expect(marker.changes).toEqual([expect.objectContaining({kind: 'action', id})]);
    expect(marker.error).toContain('index');
    expect(marker.error).toContain('description');
  });

  it('returns no payload when a handler reports an unsaved description without throwing', async () => {
    const id = '2026-10-02-unindexed', file = join(dir, 'actions', '2026', id + '.md');
    mkdirSync(dirname(file), {recursive: true});
    store.saveAction(id, {name: 'Original', created: '2026-10-02T10:00'}, 'Keep the content', file);
    const original = readFileSync(file, 'utf8');
    const result: any = await graph('mutation($id: ID!) { updateAction(id: $id, input: {description: "Unsaved description"}) { error action { id } } }', {id});
    expect(result.errors).toHaveLength(1);
    expect(result.data.updateAction).toBeNull();
    expect(result.errors[0].message).toContain('description');
    expect(result.extensions.mutations).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(store.getIndexDescription('actions', id)).toBeUndefined();
  });

  it('uses the complete journal when a runner returns an earlier failure snapshot before later writes', async () => {
    const id = '2026-10-02-intermediate', file = join(dir, 'actions', '2026', id + '.md');
    mkdirSync(dirname(file), {recursive: true});
    store.saveAction(id, {name: 'Original', created: '2026-10-02T10:00'}, '', file);
    const result: any = await executeGraphQL(store, 'mutation', {
      document: 'mutation($id: ID!) { updateAction(id: $id, input: {name: "Saved rename"}) { error action { id name } } }', variables: {id},
    }, {mutate: (_operation, args: any) => {
      const earlier = trackMutation(store, () => handleUpdateAction(store, {id, description: 'Unsaved description'}, NOW));
      const text = handleUpdateAction(store, args, NOW);
      return {id, text, mutationResult: earlier.result};
    }});
    const marker = partial(result, 'updateAction');
    expect(result.data.updateAction.action).toEqual({id, name: 'Saved rename'});
    expect(marker.changes).toEqual([expect.objectContaining({kind: 'action', id, effect: 'UPDATED'})]);
    expect(readFileSync(file, 'utf8')).toContain('Saved rename');
  });

  it('reports committed artifact imports before a later import rename fails', async () => {
    const first = join(dir, 'first.txt'), second = join(dir, 'second.txt');
    writeFileSync(first, 'first'); writeFileSync(second, 'second');
    const destination = join(dir, 'artifacts', '2026', '2026-10-02-files', 'second.txt');
    const original = vi.mocked(renameSync).getMockImplementation()!;
    vi.mocked(renameSync).mockImplementation((source, target) => {
      if (target === destination) throw new Error('Second import failed');
      original(source, target);
    });
    const marker = partial(await graph('mutation($first: String!, $second: String!) { createArtifact(input: {name: "Files", description: "Files", attachments: [{source: $first}, {source: $second}]}) { error } }', {first, second}), 'createArtifact');
    expect(marker.changes).toEqual([expect.objectContaining({kind: 'attachment', id: '#artifact/2026-10-02-files/first.txt', effect: 'CREATED'})]);
    expect(marker.error).toContain('#artifact/2026-10-02-files/second.txt');
    expect(marker.error).toContain('Second import failed');
    expect(readdirSync(dirname(destination))).toEqual(['first.txt']);
    expect(store.getArtifactIds()).toEqual([]);
  });

  it('reports completed removals when a later artifact attachment removal fails', async () => {
    const first = join(dir, 'first.txt'), second = join(dir, 'second.txt');
    writeFileSync(first, 'first'); writeFileSync(second, 'second');
    const artifact = createArtifact(store, {name: 'Files', description: 'Files', files: [{source: first}, {source: second}]}, NOW);
    const destination = join(dir, 'artifacts', '2026', artifact.id, 'second.txt');
    const original = vi.mocked(unlinkSync).getMockImplementation()!;
    vi.mocked(unlinkSync).mockImplementation(path => {
      if (path === destination) throw new Error('Second removal failed');
      original(path);
    });
    const marker = partial(await graph('mutation($id: ID!) { updateArtifact(id: $id, input: {removeAttachments: ["first.txt", "second.txt"]}) { error } }', {id: artifact.id}), 'updateArtifact');
    expect(marker.changes).toEqual([expect.objectContaining({kind: 'attachment', id: `#artifact/${artifact.id}/first.txt`, effect: 'REMOVED'})]);
    expect(existsSync(destination)).toBe(true);
    expect(store.getArtifact(artifact.id)!.frontMatter.attachments).toEqual(['second.txt']);
  });

  it('reports saved artifact metadata when the description index fails', async () => {
    failWrite(join(dir, 'artifacts', '2026', 'index.yaml'));
    const marker = partial(await graph('mutation { createArtifact(input: {name: "Saved artifact", description: "Description", body: "Saved content"}) { error } }'), 'createArtifact');
    expect(marker.changes).toEqual([expect.objectContaining({kind: 'artifact', id: '2026-10-02-saved-artifact', effect: 'CREATED'})]);
    expect(store.getArtifact('2026-10-02-saved-artifact')!.body).toBe('Saved content');
  });

  it('reports an instance setting write even if the subsequent Store reload fails', async () => {
    vi.spyOn(store, 'rebuild').mockImplementationOnce(() => {throw new Error('Reload failed');});
    const marker = partial(await graph('mutation { updateInstance(input: {body: "Saved instructions"}) { error } }'), 'updateInstance');
    expect(marker.changes).toEqual([expect.objectContaining({kind: 'instance', id: 'partial-fixture', effect: 'UPDATED', fields: ['body']})]);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toContain('Saved instructions');
    expect(store.getInstance()!.body).toBe('Saved instructions');
  });

  it('retains saved file facts without returning stale instance content when readback keeps failing', async () => {
    vi.spyOn(store, 'rebuild').mockImplementation(() => {throw new Error('Repeated readback failure');});
    const result: any = await graph('mutation { updateInstance(input: {body: "Saved despite unavailable readback"}) { error instance { body } } }');
    const marker = partial(result, 'updateInstance');
    expect(result.data.updateInstance.instance).toBeNull();
    expect(marker.error).toContain('Repeated readback failure');
    expect(marker.changes).toEqual([expect.objectContaining({kind: 'instance', id: 'partial-fixture', path: join(dir, 'aside.md')})]);
    expect(readFileSync(join(dir, 'aside.md'), 'utf8')).toContain('Saved despite unavailable readback');
  });

  it('reports a materialized occurrence ID when its index cannot save', async () => {
    const template = handleCapture(store, {content: 'Context', description: 'Context', actions: [{name: 'Routine', description: 'Routine', recurrence: [{dtstart: '2099-01-01', rrule: 'FREQ=DAILY;COUNT=2'}]}]}, NOW).createdActionIds[0];
    failWrite(join(dir, 'actions', '2026', 'index.yaml'));
    const result = await graph('mutation($template: ID!) { updateOccurrence(input: {template: $template, original: "2099-01-01", status: DONE}) { error action { id occurrence { projected } } } }', {template});
    const marker = partial(result, 'updateOccurrence');
    const saved = marker.changes[0];
    expect(saved).toMatchObject({kind: 'action', effect: 'CREATED'});
    expect(store.getAction(saved.id)!.frontMatter.occurrence).toEqual({template, original: '2099-01-01'});
    expect((result.data!.updateOccurrence as any).action).toEqual({id: saved.id, occurrence: {projected: false}});
  });

  it('reports the accepted recurrence history when record persistence and history rollback both fail', async () => {
    const id = handleCapture(store, {content: 'Context', description: 'Context', actions: [{name: 'Routine', description: 'Routine', recurrence: []}]}, NOW).createdActionIds[0];
    const original = history.writeRecurrenceHistory;
    let writes = 0;
    vi.spyOn(history, 'writeRecurrenceHistory').mockImplementation((path, schedules) => {
      if (++writes === 2) throw new Error('History rollback failed');
      original(path, schedules);
    });
    failWrite(store.getActionFile(id)!);
    let error: MutationWriteError | undefined;
    try {handleUpdateAction(store, {id, recurrence: {append: {dtstart: '2099-01-01', rrule: 'FREQ=DAILY'}}}, NOW);}
    catch (caught) {error = caught as MutationWriteError;}
    expect(error).toBeInstanceOf(MutationWriteError);
    expect(error!.partialResult).toMatchObject({status: 'PARTIAL', changes: [expect.objectContaining({kind: 'recurrenceHistory', id, effect: 'UPDATED'})], failures: [expect.objectContaining({kind: 'action', id}), expect.objectContaining({kind: 'recurrenceHistory', id, message: 'History rollback failed'})]});
    expect(readFileSync(store.getActionFile(id)!, 'utf8')).toContain('recurrence: []');
    expect(readFileSync(error!.partialResult.changes[0].path!, 'utf8')).toContain('2099-01-01');
  });

  it('does not issue a mutation marker when the first durable write fails', async () => {
    failWrite(join(dir, 'projects', '2026', '2026-10-02-never-saved.md'));
    const result: any = await graph('mutation { capture(input: {content: "Context", description: "Context", projects: [{create: {name: "Never saved", description: "Never saved"}}]}) { error } }');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('No changes were saved.');
    expect(result.errors[0].message).toContain('Injected write failure');
    expect(result.data.capture).toBeNull();
    expect(result.extensions.mutations).toEqual([]);
    expect(store.getProjectIds()).toEqual([]);
    expect(store.getEntries()).toEqual([]);
  });

  it('cleans staged imports when the first attachment write fails and leaves no artifact content', async () => {
    const source = join(dir, 'source.txt'); writeFileSync(source, 'Original source');
    const destination = join(dir, 'artifacts', '2026', '2026-10-02-never-created', 'source.txt');
    failWrite(destination);
    const result: any = await graph('mutation($source: String!) { createArtifact(input: {name: "Never created", description: "Unchanged", attachments: [{source: $source}]}) { error artifact { id } } }', {source});
    expect(result.errors).toHaveLength(1);
    expect(result.data.createArtifact).toBeNull();
    expect(result.extensions.mutations).toEqual([]);
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(dirname(destination))).toEqual([]);
    expect(store.getArtifactIds()).toEqual([]);
    expect(readFileSync(source, 'utf8')).toBe('Original source');
  });

  it('lists only the confirmed instance and tutorial files when initialization stops partway', async () => {
    const path = join(dir, 'created'), year = String(new Date().getFullYear());
    failWrite(join(path, 'projects', year, 'index.yaml'));
    const backend = {knownInstances: async () => [dir], issues: vi.fn(async () => [])};
    const registry = new InstanceRegistry([dir]); registry.activate(dir);
    const session = new InstanceSession(registry, backend, [], false, true);
    const result: any = await executeGraphQL(store, 'mutation', {
      document: 'mutation($path: String!) { createInstance(input: {path: $path, name: "Created", description: "Created", tutorial: true}) { error } }', variables: {path},
    }, {instances: session});
    expect(result.errors).toBeUndefined();
    const marker = result.extensions.mutations[0];
    expect(marker).toMatchObject({operation: 'createInstance', error: expect.stringContaining('Partial failure')});
    expect(result.data.createInstance.error).toBe(marker.error);
    expect(marker.changes).toHaveLength(3);
    expect(marker.changes[0]).toMatchObject({kind: 'instance', id: 'created', path: join(path, 'aside.md'), fields: ['manifest']});
    expect(marker.changes[1]).toMatchObject({kind: 'index'});
    expect(marker.changes[2]).toMatchObject({kind: 'file'});
    expect(marker.changes.every((change: any) => existsSync(change.path))).toBe(true);
    expect(existsSync(join(path, 'projects', year, 'index.yaml'))).toBe(false);
    expect(backend.issues).not.toHaveBeenCalled();
    expect(registry.activeInstance).toBe(dir);
  });

  it('keeps a saved create marker when Calendar scheduling fails after record persistence', async () => {
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    vi.spyOn(CalSync.prototype, 'syncActions').mockImplementation(actions => {
      if (actions.length) throw new Error('Calendar scheduling failed');
      return Promise.resolve([]);
    });
    const host = new InstanceHost(new CalClient(null));
    try {
      const result: any = JSON.parse((await host.tool(dir, 'mutate', {document: 'mutation { saved: capture(input: {content: "Context", description: "Context", actions: [{create: {name: "Saved work", description: "Work", scheduled: "2099-01-01", calendar: "Work"}}]}) { error } }'})).text);
      const marker = partial(result, 'capture');
      expect(result.data.saved.error).toContain('Calendar scheduling failed');
      expect(marker.changes.map((change: any) => change.kind)).toEqual(['action', 'index', 'entry', 'index']);
      expect(marker.changes.find((change: any) => change.kind === 'action').effect).toBe('CREATED');
    } finally {await host.close();}
  });

  it.each(['failed', 'pending', 'synced'] as const)('reports Calendar %s state through generated metadata and preserves authored warning text', async status => {
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    vi.spyOn(CalSync.prototype, 'syncActions').mockResolvedValue([]);
    vi.spyOn(CalSync.prototype, 'status').mockImplementation(id => ({id, status, ...(status === 'failed' ? {reason: 'Calendar authorization failed'} : {})}));
    const host = new InstanceHost(new CalClient(null));
    try {
      const result: any = JSON.parse((await host.tool(dir, 'mutate', {document: 'mutation { capture(input: {content: "warning: this is authored content", description: "Context", actions: [{create: {name: "Calendar warning text", description: "Work", scheduled: "2099-01-01", calendar: "Work", body: "warning: this is authored content"}}]}) { error entry { content } } }'})).text);
      expect(result.errors).toBeUndefined();
      expect(result.data.capture.entry.content).toBe('warning: this is authored content');
      if (status === 'failed') {
        expect(result.data.capture.error).toContain('Calendar authorization failed');
        expect(result.data.capture.error).toContain('calendarInfo');
      } else expect(result.data.capture.error).toBeNull();
    } finally {await host.close();}
  });
});
