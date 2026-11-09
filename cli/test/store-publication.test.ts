import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../src/source/store.js';
import {publishReadonly} from '../src/source/publication.js';

const project = '2026-10-30-project', action = '2026-10-30-action', artifact = '2026-10-30-artifact';
describe('lifecycle publication ownership', () => {
  let root: string, store: Store;
  beforeEach(() => {
    root = mkdtempSync('/private/tmp/aside-publication-');
    for (const kind of ['notes', 'projects', 'actions', 'artifacts']) mkdirSync(join(root, kind, '2026'), {recursive: true});
    writeFileSync(join(root, 'aside.md'), '---\nid: publication\nname: Published\nconfig:\n  doneEventTitlePrefix: Done\nautomations:\n  malformed: {unexpected: true}\n---\nInstructions.\n');
    writeFileSync(join(root, '.aside'), 'execution:\n  models:\n    worker:\n      command: worker\n      args: [--published]\n');
    writeFileSync(join(root, 'notes/2026/2026-10-26.md'), `---\nweek: 44\nweek_start: 2026-10-26\nweek_end: 2026-11-01\n---\n\n\`\`\`entry\ncreated: 2026-10-30T09:00\nprojects: [${project}]\nactions: [${action}]\n\`\`\`\n\nPublished entry.\n`);
    writeFileSync(join(root, 'projects/2026', `${project}.md`), '---\nname: Published project\ncreated: 2026-10-30T09:00\n---\nPublished body.\n');
    writeFileSync(join(root, 'actions/2026', `${action}.md`), '---\nname: Published action\ncreated: 2026-10-30T09:00\n---\nPublished body.\n');
    writeFileSync(join(root, 'artifacts/2026', `${artifact}.md`), '---\nname: Published artifact\ncreated: 2026-10-30T09:00\n---\nPublished body.\n');
    for (const [kind, id] of [['projects', project], ['actions', action], ['artifacts', artifact]])
      writeFileSync(join(root, kind, '2026/index.yaml'), `- id: ${id}\n  description: Published description\n`);
    writeFileSync(join(root, 'notes/2026/index.yaml'), '- id: 2026-10-30T09:00\n  description: Published entry\n');
    const attachments = join(root, 'artifacts/2026', artifact);
    mkdirSync(attachments); writeFileSync(join(attachments, 'instructions.txt'), 'Published bytes.');
    store = new Store(root);
  });
  afterEach(() => {store?.close(); rmSync(root, {recursive: true, force: true});});

  it('rejects mutation through records, indexes, metadata, relationships and collection callbacks', () => {
    const version = store.getSourceVersion(), revision = store.getRevision();
    const projects = store.getProjects() as Map<string, unknown>;
    const entries = store.getEntries();
    const relations = store.getRelations();
    expect(store.getIssues().length).toBeGreaterThan(0);
    const attempts = [
      () => {store.getProject(project)!.body = 'Bypass';},
      () => {store.getAction(action)!.frontMatter.name = 'Bypass';},
      () => {store.getArtifact(artifact)!.frontMatter.attachments!.push('bypass.txt');},
      () => {entries[0].meta.projects!.push('bypass');},
      () => {entries.length = 0;},
      () => {store.getProjectIndex()[0].description = 'Bypass';},
      () => {store.getActionIndex().splice(0, 1);},
      () => {store.getManifest().config!.doneEventTitlePrefix = 'Bypass';},
      () => {store.getInstance()!.body = 'Bypass';},
      () => {store.getIssues()[0].message = 'Bypass';},
      () => {(store.getSourceMetadata().years as string[]).push('1900');},
      () => {(store.getReferenceRoots() as string[]).push('/bypass');},
      () => {store.getAttachmentFiles(artifact)[0].path = '/bypass';},
      () => {(store.getExecutionContext().config.models!.worker as {args: string[]}).args.push('--bypass');},
      () => {relations.actionsByProject.get(project)!.push('bypass');},
      () => {relations.actionsByProject.clear();},
      () => {store.getArtifactReferenceSources()[0].projects!.push('bypass');},
      () => {projects.set('bypass', {});},
      () => {projects.delete(project);},
      () => {projects.clear();},
      () => {Map.prototype.set.call(projects, 'bypass', {});},
      () => {Map.prototype.delete.call(projects, project);},
      () => {Map.prototype.clear.call(projects);},
      () => {projects.forEach((_record, _id, collection) => collection.clear());},
    ];
    for (const attempt of attempts) expect(attempt).toThrow(TypeError);
    expect(store.getSourceVersion()).toBe(version);
    expect(store.getRevision()).toBe(revision);
    expect(store.getProject(project)!.body).toBe('Published body.');
    expect(projects.has(project)).toBe(true);
    expect(projects.get(project)).toBe(store.getProject(project));
    expect(projects.valueOf()).toBe(projects);
    expect(() => (projects.valueOf() as Map<string, unknown>).clear()).toThrow(TypeError);
  });

  it('reuses published references and advances them only when the owner publishes', () => {
    const projectRecord = store.getProject(project), projects = store.getProjects();
    const metadata = store.getSourceMetadata(), context = store.getExecutionContext(), relations = store.getRelations();
    const index = store.getProjectIndex(), version = store.getSourceVersion();
    for (let read = 0; read < 100; read++) {
      expect(store.getProject(project)).toBe(projectRecord);
      expect(store.getProjects()).toBe(projects);
      expect(store.getSourceMetadata()).toBe(metadata);
      expect(store.getExecutionContext()).toBe(context);
      expect(store.getRelations()).toBe(relations);
      expect(store.getProjectIndex()).toBe(index);
      expect(store.getAttachmentFiles(artifact)).toBe(store.getAttachmentFiles(artifact));
    }
    store.saveProject(project, {...projectRecord!.frontMatter, name: 'Owner update'}, 'Updated body.', store.getProjectFile(project)!);
    expect(store.getSourceVersion()).not.toBe(version);
    expect(store.getProject(project)!.frontMatter.name).toBe('Owner update');
    expect(store.getProject(project)).not.toBe(projectRecord);
    expect(projectRecord!.frontMatter.name).toBe('Published project');
    expect(projects.get(project)).toBe(projectRecord);
    store.setIndexEntry('projects', project, 'Owner description');
    expect(index[0].description).toBe('Published description');
    expect(store.getProjectIndex()[0].description).toBe('Owner description');
  });

  it('keeps the cached transport snapshot immutable and structured-clone compatible', async () => {
    const pending = store.snapshot(), snapshot = await pending;
    expect(store.snapshot()).toBe(pending);
    expect(await store.snapshot()).toBe(snapshot);
    expect(() => {snapshot.projects[0][1].body = 'Bypass';}).toThrow(TypeError);
    expect(() => {snapshot.relations.actionsByProject[0][1].push('bypass');}).toThrow(TypeError);
    expect(structuredClone(snapshot)).toEqual(snapshot);
    store.setIndexEntry('projects', project, 'Updated description');
    expect(await store.snapshot()).not.toBe(snapshot);
    expect(snapshot.indexes.projects[0].description).toBe('Published description');
  });

  it('protects cyclic collection graphs, including the forEach collection argument', () => {
    const source = new Set<object>();
    const record = {source, list: ['Published']}; source.add(record);
    const view = publishReadonly(source);
    expect(view.has([...view][0])).toBe(true);
    expect((([...view][0] as typeof record).source)).toBe(view);
    expect(() => view.add({})).toThrow(TypeError);
    expect(() => view.delete([...view][0])).toThrow(TypeError);
    expect(() => view.clear()).toThrow(TypeError);
    expect(() => Set.prototype.add.call(view, {})).toThrow(TypeError);
    expect(() => view.forEach((_record, _sameRecord, collection) => collection.clear())).toThrow(TypeError);
    expect(view.valueOf()).toBe(view);
    record.list.push('Owner edit');
    expect(([...view][0] as typeof record).list).toEqual(['Published']);
  });

  it('preserves tagged YAML native values without exposing cached or owner state', async () => {
    const metadata = 'automations:\n  tagged:\n    timestamp: !!timestamp 2026-10-31\n    binary: !!binary AAE=\n    set: !!set {red, green}\n    map: !!omap [{first: value}]\n';
    writeFileSync(join(root, 'aside.md'), `---\nid: publication\nname: Tagged\n${metadata}---\nInstructions.\n`);
    writeFileSync(store.getProjectFile(project)!, `---\nname: Tagged project\ncreated: 2026-10-30T09:00\n${metadata}---\nBody.\n`);
    store.rebuild();
    const tagged = store.getManifest().automations!.tagged as any;
    const version = store.getSourceVersion(), serialized = JSON.stringify(store.getInstance());
    expect(tagged.timestamp).toBeInstanceOf(Date);
    expect(Buffer.isBuffer(tagged.binary)).toBe(true);
    expect(tagged.set).toBeInstanceOf(Set);
    expect(tagged.map).toBeInstanceOf(Map);
    tagged.timestamp.setTime(0);
    tagged.binary.fill(9);
    new Uint8Array(tagged.binary.buffer).fill(9);
    tagged.set.forEach((_item: unknown, _same: unknown, collection: Set<unknown>) => collection.clear());
    tagged.map.forEach((_value: unknown, _key: unknown, collection: Map<unknown, unknown>) => collection.clear());
    expect(tagged.timestamp.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect([...tagged.binary]).toEqual([0, 1]);
    expect([...tagged.set]).toEqual(['red', 'green']);
    expect([...tagged.map]).toEqual([['first', 'value']]);
    expect(store.getSourceVersion()).toBe(version);
    expect(JSON.stringify(store.getInstance())).toBe(serialized);
    const cloned = structuredClone(store.getInstance())!.manifest.automations!.tagged as any;
    expect(cloned.timestamp).toEqual(new Date('2026-10-31'));
    expect(cloned.binary).toEqual(new Uint8Array([0, 1]));
    expect(cloned.set).toEqual(new Set(['red', 'green']));
    expect(cloned.map).toEqual(new Map([['first', 'value']]));
    expect((structuredClone(store.getProject(project))!.frontMatter.automations!.tagged as any).set).toEqual(cloned.set);

    const snapshot = await store.snapshot(), transportTagged = snapshot.instance!.manifest.automations!.tagged as any;
    const transportJSON = JSON.stringify(snapshot);
    transportTagged.timestamp.setTime(0);
    new Uint8Array(transportTagged.binary.buffer).fill(9);
    transportTagged.set.clear(); transportTagged.map.clear();
    expect(JSON.stringify(snapshot)).toBe(transportJSON);
    expect(structuredClone(snapshot)).toEqual(snapshot);
    expect(await store.snapshot()).toBe(snapshot);
  });

  it('defensively copies native binary fields and their backing buffers', () => {
    const bytes = new Uint8Array([1, 2]);
    const original = {bytes, view: new DataView(bytes.buffer), buffer: bytes.buffer};
    const published = publishReadonly(original);
    published.bytes.fill(9);
    published.bytes.subarray(0).fill(9);
    published.bytes.forEach((_value, _index, array) => array.fill(9));
    new Uint8Array(published.bytes.buffer).fill(9);
    published.view.setUint8(0, 9);
    new Uint8Array(published.buffer).fill(9);
    expect([...published.bytes]).toEqual([1, 2]);
    expect(published.view.getUint8(0)).toBe(1);
    expect([...new Uint8Array(published.buffer)]).toEqual([1, 2]);
    bytes.fill(7);
    expect([...published.bytes]).toEqual([1, 2]);
    expect(structuredClone(published)).toEqual({bytes: new Uint8Array([1, 2]), view: new DataView(new Uint8Array([1, 2]).buffer), buffer: new Uint8Array([1, 2]).buffer});
  });
});
