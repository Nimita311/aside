import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Store } from '../src/mcp/store.js';
import { handleUpdateAction, handleUpdateEntry, handleUpdateProject } from '../src/mcp/tools/update.js';
import { handleUpdateArtifact } from '../src/mcp/tools/artifact.js';
import { splitFrontMatter } from '../src/core/parser.js';
import { recurrenceHistoryPath } from '../src/mcp/recurrence-history.js';
import { serializeAction, serializeProject } from '../src/mcp/tools/serialize.js';
import { parseActionFile, parseProjectFile } from '../src/core/parser.js';

describe('unmanaged record metadata', () => {
  let root: string;
  let instance: string;
  let store: Store | undefined;
  const id = '2026-10-10-fixture';
  const projectId = '2026-10-10-project';
  const entryId = '2026-10-10T09:00';
  const extensions = `custom: &data {nested: [one, two], flag: true} # custom comment\ncustom_copy: *data # alias comment\n`;

  beforeEach(() => {
    root = mkdtempSync('/tmp/aside-metadata-');
    instance = join(root, 'instance');
    mkdirSync(instance);
    writeFileSync(join(instance, 'aside.md'), '---\nid: metadata-preservation\n---\n');
  });

  afterEach(() => { store?.close(); store = undefined; rmSync(root, { recursive: true, force: true }); });

  function record(kind: 'actions' | 'projects' | 'artifacts', extra = '', recordId = id): string {
    const dir = join(instance, kind, '2026');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${recordId}.md`);
    writeFileSync(file, `---\nname: Fixture # name comment\ncreated: 2026-10-10T09:00\n${extra}${extensions}---\n\nOriginal body.\n`);
    writeFileSync(join(dir, 'index.yaml'), `- id: ${recordId}\n  description: Fixture\n`);
    return file;
  }

  function metadata(file: string): any { return parse(splitFrontMatter(readFileSync(file, 'utf8')).yaml); }

  it.each(['actions', 'projects', 'artifacts'] as const)('preserves nested custom data, comments and aliases when renaming and changing %s content', kind => {
    const file = record(kind);
    store = new Store(instance);
    const update = kind === 'actions' ? handleUpdateAction : kind === 'projects' ? handleUpdateProject : handleUpdateArtifact;
    update(store, { id, name: 'Renamed', body: 'New body.\n\n---\n\nMore context.' });
    const saved = readFileSync(file, 'utf8');
    expect(metadata(file)).toMatchObject({ name: 'Renamed', created: '2026-10-10T09:00', custom: { nested: ['one', 'two'], flag: true }, custom_copy: { nested: ['one', 'two'], flag: true } });
    expect(saved).toContain('&data');
    expect(saved).toContain('*data');
    expect(saved).toContain('# custom comment');
    expect(saved).toContain('# alias comment');
    expect(saved).toContain('# name comment');
    expect(splitFrontMatter(saved).body.trim()).toBe('New body.\n\n---\n\nMore context.');
  });

  for (const newline of ['\n', '\r\n']) it.each(['actions', 'projects', 'artifacts'] as const)('preserves omitted %s Markdown bytes on metadata patches with newline ' + JSON.stringify(newline), kind => {
    const file = record(kind);
    const tail = `${newline}${newline}    indented code${newline}    second code line${newline}${newline}\tmore code${newline}${newline}${newline}`;
    const metadata = splitFrontMatter(readFileSync(file, 'utf8')).yaml.replace(/\n/g, newline);
    writeFileSync(file, `---${newline}${metadata}${newline}---${tail}`);
    store = new Store(instance);
    const update = kind === 'actions' ? handleUpdateAction : kind === 'projects' ? handleUpdateProject : handleUpdateArtifact;
    update(store, {id, name: 'Renamed'});
    const saved = readFileSync(file, 'utf8');
    expect(saved.slice(saved.indexOf(`${newline}---`) + newline.length + 3)).toBe(tail);
    expect(saved).toContain('name: Renamed');
    // Explicit body replacement still owns the content.
    update(store, {id, body: 'Replacement body.'});
    expect(readFileSync(file, 'utf8')).toContain('Replacement body.');
    expect(readFileSync(file, 'utf8')).not.toContain('indented code');
  });

  it('changes and clears managed action fields while retaining aliases to their prior values', () => {
    const file = record('actions', `scheduled: &start 2026-10-11T09:00 # schedule comment\ncustom_start: *start\ncalendar: &route Work\ncustom_route: *route\nduration: &length PT1H\ncustom_length: *length\nresolution: done\ndeadline: 2026-10-12\n`);
    store = new Store(instance);
    handleUpdateAction(store, { id, scheduled: '2026-10-13T10:00', calendar: null, duration: null, deadline: null, resolution: null, body: '' });
    const saved = metadata(file);
    expect(saved).toMatchObject({ scheduled: '2026-10-13T10:00', custom_start: '2026-10-11T09:00', custom_route: 'Work', custom_length: 'PT1H', created: '2026-10-10T09:00' });
    for (const field of ['calendar', 'duration', 'deadline', 'resolution']) expect(saved).not.toHaveProperty(field);
    expect(readFileSync(file, 'utf8')).toContain('# schedule comment');
    expect(splitFrontMatter(readFileSync(file, 'utf8')).body.trim()).toBe('');
    expect(store.getAction(id)?.frontMatter).toEqual({ name: 'Fixture', created: '2026-10-10T09:00', scheduled: '2026-10-13T10:00' });
  });

  it('retains custom aliases into deleted project declarations and anchored mapping keys', () => {
    const file = record('projects', `ended: &closed 2026-10-10T10:00\ncustom_closed: *closed\n&jobs_key automations: &jobs\n  run:\n    schedule: {at: "2099-10-10T09:00:00Z"}\n    run: &command {script: echo, args: [hello]}\ncustom_jobs: *jobs\ncustom_command: *command\ncustom_key: *jobs_key\n`);
    store = new Store(instance);
    handleUpdateProject(store, { id, ended: null, automations: null });
    const saved = metadata(file);
    expect(saved).not.toHaveProperty('automations');
    expect(saved).not.toHaveProperty('ended');
    expect(saved.custom_closed).toBe('2026-10-10T10:00');
    expect(saved.custom_jobs.run.run).toEqual({ script: 'echo', args: ['hello'] });
    expect(saved.custom_command).toEqual({ script: 'echo', args: ['hello'] });
    expect(saved.custom_key).toBe('automations');
  });

  it('leaves a custom anchored value unchanged when a managed field aliases it', () => {
    const file = record('actions', `custom_clock: &clock 2026-10-11T09:00\nscheduled: *clock\n`);
    store = new Store(instance);
    handleUpdateAction(store, { id, scheduled: '2026-10-13T10:00' });
    expect(metadata(file)).toMatchObject({ custom_clock: '2026-10-11T09:00', scheduled: '2026-10-13T10:00' });
    expect(readFileSync(file, 'utf8')).toContain('&clock');
  });

  it('keeps nested relationship extensions on unrelated project edits, then honors explicit replacement and clearing', () => {
    const file = record('projects', `related_projects:\n  - project: ${projectId}\n    description: Supports\n    owner: Me # relationship extension\n`);
    record('projects', '', projectId);
    store = new Store(instance);
    handleUpdateProject(store, { id, body: 'Updated context.' });
    expect(metadata(file).related_projects[0].owner).toBe('Me');
    expect(readFileSync(file, 'utf8')).toContain('# relationship extension');
    const direct = serializeProject(parseProjectFile(readFileSync(file, 'utf8')).value.frontMatter, 'Direct body edit.', file);
    expect(direct).toContain('owner: Me');
    handleUpdateProject(store, { id, related_projects: [{ project: projectId, description: 'Supports' }] });
    expect(metadata(file).related_projects).toEqual([{ project: projectId, description: 'Supports' }]);
    handleUpdateProject(store, { id, related_projects: [] });
    expect(metadata(file)).not.toHaveProperty('related_projects');
  });

  it('keeps an unknown action resolution on unrelated edits, then honors explicit clearing and resolution', () => {
    const file = record('actions', 'resolution: deferred # user state\n');
    store = new Store(instance);
    handleUpdateAction(store, { id, name: 'Renamed', body: 'Updated context.' });
    expect(metadata(file).resolution).toBe('deferred');
    expect(readFileSync(file, 'utf8')).toContain('# user state');
    const direct = serializeAction(parseActionFile(readFileSync(file, 'utf8')).value.frontMatter, 'Direct body edit.', file);
    expect(direct).toContain('resolution: deferred');
    handleUpdateAction(store, { id, resolution: null });
    expect(metadata(file)).not.toHaveProperty('resolution');
    handleUpdateAction(store, { id, resolution: 'done' });
    expect(metadata(file).resolution).toBe('done');
  });

  it('rejects invalid YAML before changing an action or its accepted recurrence history', () => {
    const file = record('actions', 'recurrence:\n  - dtstart: "2099-10-10T09:00"\n    rrule: FREQ=DAILY\n');
    store = new Store(instance);
    const history = recurrenceHistoryPath(instance, 'metadata-preservation');
    const beforeHistory = readFileSync(history, 'utf8');
    const invalid = readFileSync(file, 'utf8').replace('custom: &data', 'broken: [\ncustom: &data');
    writeFileSync(file, invalid);
    expect(() => handleUpdateAction(store!, { id, recurrence: { append: { dtstart: '2099-10-12T09:00', rrule: 'FREQ=WEEKLY' } } })).toThrow(/valid YAML mapping/);
    expect(readFileSync(file, 'utf8')).toBe(invalid);
    expect(readFileSync(history, 'utf8')).toBe(beforeHistory);
    expect(store.getAction(id)?.frontMatter.recurrence).toHaveLength(1);
  });

  it.each(['projects', 'artifacts'] as const)('rejects unresolved aliases before updating %s metadata', kind => {
    const file = record(kind);
    store = new Store(instance);
    const invalid = readFileSync(file, 'utf8').replace('*data # alias', '*missing # alias');
    writeFileSync(file, invalid);
    const update = kind === 'projects' ? handleUpdateProject : handleUpdateArtifact;
    expect(() => update(store!, { id, name: 'Renamed' })).toThrow(/aliases cannot be resolved/);
    expect(readFileSync(file, 'utf8')).toBe(invalid);
  });

  it('preflights artifact metadata before replacing attachment bytes', () => {
    const file = record('artifacts');
    const attachments = join(instance, 'artifacts', '2026', id);
    mkdirSync(attachments);
    const attachment = join(attachments, 'source.txt');
    writeFileSync(attachment, 'Saved content');
    const source = join(root, 'source.txt');
    writeFileSync(source, 'Replacement content');
    store = new Store(instance);
    const invalid = readFileSync(file, 'utf8').replace('*data # alias', '*missing # alias');
    writeFileSync(file, invalid);
    expect(() => handleUpdateArtifact(store!, { id, name: 'Renamed', files: [{ source }] })).toThrow(/aliases cannot be resolved/);
    expect(readFileSync(file, 'utf8')).toBe(invalid);
    expect(readFileSync(attachment, 'utf8')).toBe('Saved content');
  });

  it('preflights a malformed attachment list before deleting its physical files', () => {
    const file = record('artifacts');
    const attachments = join(instance, 'artifacts', '2026', id);
    mkdirSync(attachments);
    const attachment = join(attachments, 'source.txt');
    writeFileSync(attachment, 'Saved content');
    store = new Store(instance);
    const original = `---\nname: Fixture\ncreated: 2026-10-10T09:00\nattachments: &files [*files]\ncustom_files: *files\n---\n\nOriginal body.\n`;
    writeFileSync(file, original);

    expect(() => handleUpdateArtifact(store!, { id, remove_files: ['source.txt'] })).toThrow(/cyclic metadata/);

    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(readFileSync(attachment, 'utf8')).toBe('Saved content');
  });

  function entry(metadataExtra: string): string {
    const notes = join(instance, 'notes', '2026');
    mkdirSync(notes, { recursive: true });
    const file = join(notes, '2026-10-05.md');
    writeFileSync(join(notes, 'index.yaml'), `- id: ${entryId}\n  description: Fixture\n`);
    writeFileSync(file, `---\nweek: 41\nweek_start: 2026-10-05\nweek_end: 2026-10-11\nweekly_custom: keep\n---\n\n---\n\`\`\`entry\ncreated: ${entryId}\n${metadataExtra}${extensions}\`\`\`\n\nOriginal entry.\n`);
    return file;
  }

  it.each(['\n', '\r\n'])('patches only entry metadata, preserving indented content and every weekly delimiter with newline %j', newline => {
    record('projects', '', projectId);
    const file = entry('');
    const beforeTarget = `\uFEFF${newline}---  ${newline}week: 41${newline}week_start: 2026-10-05${newline}week_end: 2026-10-11${newline}--- \t${newline}${newline}---${newline}${newline}\`\`\`entry${newline}created: 2026-10-10T10:00${newline}\`\`\`${newline}${newline}    Neighbor code${newline}${newline}${newline}--- \t${newline}${newline}\`\`\`entry${newline}`;
    const metadata = `created: ${entryId}${newline}custom: keep # metadata comment${newline}`;
    const afterTarget = `\`\`\` \t${newline}${newline}    Target code${newline}    second code line${newline}${newline}${newline}---${newline}\`\`\`entry${newline}created: 2026-10-09T09:00${newline}\`\`\`${newline}${newline}\tOther neighbor code${newline}${newline}${newline}`;
    writeFileSync(file, beforeTarget + metadata + afterTarget);
    store = new Store(instance);
    handleUpdateEntry(store, {id: entryId, projectEdits: {add: [projectId]}});
    const saved = readFileSync(file, 'utf8');
    expect(saved.startsWith(beforeTarget)).toBe(true);
    expect(saved.endsWith(afterTarget)).toBe(true);
    expect(saved.slice(beforeTarget.length, -afterTarget.length)).toContain(`projects: [ ${projectId} ]`);
    expect(saved).toContain('# metadata comment');
    expect(store.getEntries().find(entry => entry.meta.created === entryId)?.meta.projects).toEqual([projectId]);
    const beforeNoop = saved;
    handleUpdateEntry(store, {id: entryId, projectEdits: {remove: ['missing-project']}});
    expect(readFileSync(file, 'utf8')).toBe(beforeNoop);
  });

  it('preserves custom entry metadata and prior aliased tags while clearing managed tags', () => {
    record('projects', '', projectId);
    const file = entry(`projects: &tags [${projectId}]\ncustom_tags: *tags\n`);
    store = new Store(instance);
    handleUpdateEntry(store, { id: entryId, content: 'Amended entry.', projects: [] });
    const saved = readFileSync(file, 'utf8');
    const meta = parse(saved.match(/```entry\n([\s\S]*?)```/)![1]);
    expect(meta).not.toHaveProperty('projects');
    expect(meta).toMatchObject({ created: entryId, custom_tags: [projectId], custom: { nested: ['one', 'two'], flag: true }, custom_copy: { nested: ['one', 'two'], flag: true } });
    expect(saved).toContain('# custom comment');
    expect(saved).toContain('weekly_custom: keep');
    expect(store.getEntries()[0].content).toBe('Amended entry.');
    expect(store.getEntries()[0].meta.projects).toBeUndefined();
  });

  it('keeps tolerant entry tag values on content-only edits, then honors explicit clearing', () => {
    const file = entry('projects: [42, {owner: Me}] # extra tag values\nactions: [false]\n');
    store = new Store(instance);
    handleUpdateEntry(store, { id: entryId, content: 'Amended entry.' });
    const saved = readFileSync(file, 'utf8');
    const meta = parse(saved.match(/```entry\n([\s\S]*?)```/)![1]);
    expect(meta.projects).toEqual([42, { owner: 'Me' }]);
    expect(meta.actions).toEqual([false]);
    expect(saved).toContain('# extra tag values');
    handleUpdateEntry(store, { id: entryId, projects: [], actions: null });
    const cleared = parse(readFileSync(file, 'utf8').match(/```entry\n([\s\S]*?)```/)![1]);
    expect(cleared).not.toHaveProperty('projects');
    expect(cleared).not.toHaveProperty('actions');
  });

  it('rejects invalid entry metadata before creating linked records', () => {
    const file = entry('');
    store = new Store(instance);
    const invalid = readFileSync(file, 'utf8').replace('*data # alias', '*missing # alias');
    writeFileSync(file, invalid);
    expect(() => handleUpdateEntry(store!, { id: entryId, projects: [{ name: 'New project', description: 'Must not be saved' }] })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(invalid);
    expect(store.getProjects().size).toBe(0);
  });
});
