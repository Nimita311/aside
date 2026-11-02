import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { Store } from '../src/mcp/store.js';
import { handleUpdateAction, handleUpdateEntry, handleUpdateProject } from '../src/mcp/tools/update.js';
import { handleUpdateArtifact } from '../src/mcp/tools/artifact.js';
import { parseActionFile, parseArtifactFile, parseProjectFile, parseWeeklyFile, splitFrontMatter } from '../src/core/parser.js';
import { artifactAttachmentPath } from '../src/core/artifact.js';
import { readRecurrenceHistory, recurrenceHistoryPath } from '../src/mcp/recurrence-history.js';

describe('writes with external metadata edits before watcher rebuild', () => {
  let dir: string;
  let store: Store;
  const actionId = '2026-10-10-task';
  const projectId = '2026-10-10-project';
  const otherProjectId = '2026-10-10-other';
  const artifactId = '2026-10-10-material';
  const entryId = '2026-10-10T09:00';
  let actionFile: string;
  let projectFile: string;
  let weekFile: string;
  let artifactFile: string;

  const record = (name: string, metadata = '') => `---\nname: ${name}\ncreated: 2026-10-10T09:00${metadata}\n---\n\nOriginal body.\n`;
  const weekly = (projects: string[]) => `---\nweek: 41\nweek_start: 2026-10-05\nweek_end: 2026-10-11\n---\n\n---\n\`\`\`entry\ncreated: ${entryId}\nprojects: [${projects.join(', ')}]\nactions: [${actionId}]\n\`\`\`\n\nOriginal entry.\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aside-store-merged-state-'));
    actionFile = join(dir, 'actions', '2026', `${actionId}.md`);
    projectFile = join(dir, 'projects', '2026', `${projectId}.md`);
    weekFile = join(dir, 'notes', '2026', '2026-10-05.md');
    artifactFile = join(dir, 'artifacts', '2026', `${artifactId}.md`);
    for (const file of [actionFile, projectFile, weekFile, artifactFile]) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(join(dir, 'aside.md'), '---\nid: merged-state-test\n---\n');
    writeFileSync(actionFile, record('Task', '\nscheduled: 2026-10-11T09:00'));
    writeFileSync(projectFile, record('Project'));
    writeFileSync(join(dirname(projectFile), `${otherProjectId}.md`), record('Other'));
    writeFileSync(weekFile, weekly([projectId]));
    writeFileSync(artifactFile, record('Material'));
    store = new Store(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the preserved action metadata for immediate reads and update receipts', () => {
    writeFileSync(actionFile, record('External task', '\nscheduled: 2026-10-12T15:00'));
    const response = handleUpdateAction(store, { id: actionId, body: 'Revised body.' });
    const persisted = parseActionFile(readFileSync(actionFile, 'utf8')).value;
    expect(persisted.frontMatter).toMatchObject({ name: 'External task', scheduled: '2026-10-12T15:00' });
    expect(store.getAction(actionId)).toEqual(persisted);
    expect(response).toContain('name: External task');
    expect(response).toContain('scheduled: 2026-10-12T15:00');
    store.rebuild();
    expect(store.getAction(actionId)).toEqual(persisted);
  });

  it('uses preserved project metadata for immediate reads and update receipts', () => {
    writeFileSync(projectFile, record('External project', '\nended: 2026-10-10T11:00'));
    const response = handleUpdateProject(store, { id: projectId, body: 'Revised project.' });
    const persisted = parseProjectFile(readFileSync(projectFile, 'utf8')).value;
    expect(persisted.frontMatter).toMatchObject({ name: 'External project', ended: '2026-10-10T11:00' });
    expect(store.getProject(projectId)).toEqual(persisted);
    expect(response).toContain('name: External project');
    expect(response).toContain('ended: 2026-10-10T11:00');
  });

  it('preserves a newer action body when an update changes only metadata', () => {
    writeFileSync(actionFile, readFileSync(actionFile, 'utf8').replace('Original body.', 'External action context.'));
    handleUpdateAction(store, { id: actionId, name: 'Renamed task' });
    expect(store.getAction(actionId)!.body).toBe('External action context.');
    expect(parseActionFile(readFileSync(actionFile, 'utf8')).value).toEqual(store.getAction(actionId));
  });

  it('preserves a newer project body when an update changes only metadata', () => {
    writeFileSync(projectFile, readFileSync(projectFile, 'utf8').replace('Original body.', 'External project context.'));
    handleUpdateProject(store, { id: projectId, name: 'Renamed project' });
    expect(store.getProject(projectId)!.body).toBe('External project context.');
    expect(parseProjectFile(readFileSync(projectFile, 'utf8')).value).toEqual(store.getProject(projectId));
  });

  it('preserves newer entry content when an update changes only links', () => {
    writeFileSync(weekFile, readFileSync(weekFile, 'utf8').replace('Original entry.', 'External entry context.'));
    handleUpdateEntry(store, { id: entryId, projects: [otherProjectId] });
    const persisted = parseWeeklyFile(readFileSync(weekFile, 'utf8'), basename(weekFile)).value.entries[0];
    expect(persisted.content).toBe('External entry context.');
    expect(store.getEntries().find(entry => entry.meta.created === entryId)).toEqual(persisted);
  });

  it('derives entry links, relationships, and receipts from the rendered metadata', () => {
    writeFileSync(weekFile, weekly([otherProjectId]));
    const response = handleUpdateEntry(store, { id: entryId, content: 'Revised entry.' });
    const persisted = parseWeeklyFile(readFileSync(weekFile, 'utf8'), basename(weekFile)).value.entries[0];
    expect(persisted.meta.projects).toEqual([otherProjectId]);
    expect(store.getEntries().find(entry => entry.meta.created === entryId)).toEqual(persisted);
    expect(store.getProjectsForAction(actionId)).toEqual([otherProjectId]);
    expect(store.getActionsForProject(projectId)).toEqual([]);
    expect(response.text).toContain(otherProjectId);
    expect(response.text).not.toContain(projectId);
  });

  it('upserts the merged artifact rather than the stale save input', () => {
    const stale = store.getArtifact(artifactId)!;
    writeFileSync(artifactFile, record('External material'));
    store.saveArtifact(artifactId, { ...stale.frontMatter }, 'Revised material.', artifactFile, []);
    const persisted = parseArtifactFile(readFileSync(artifactFile, 'utf8')).value;
    expect(persisted.frontMatter.name).toBe('External material');
    expect(store.getArtifact(artifactId)).toEqual(persisted);
  });

  it('refreshes persisted name, body, relations, and receipt after a files-only artifact edit', () => {
    const linkedId = '2026-10-10-guide';
    const linkedFile = join(dirname(artifactFile), `${linkedId}.md`);
    store.saveArtifact(linkedId, { name: 'Guide', created: '2026-10-10T09:00' }, 'Guide context.', linkedFile);
    const externalBody = `External material refers to #artifact/${linkedId}.`;
    writeFileSync(artifactFile, record('External material').replace('Original body.', externalBody));
    const source = join(dir, 'source.txt');
    writeFileSync(source, 'Imported bytes');
    const response = handleUpdateArtifact(store, { id: artifactId, files: [{ source }] });
    const persisted = parseArtifactFile(readFileSync(artifactFile, 'utf8')).value;
    expect(persisted).toMatchObject({ frontMatter: { name: 'External material', attachments: ['source.txt'] }, body: externalBody });
    expect(store.getArtifact(artifactId)).toEqual(persisted);
    expect(store.getArtifactBacklinks(linkedId)).toEqual([`#artifact/${artifactId}`]);
    expect(response).toContain('name: External material');
    expect(response).toContain('attachments: [source.txt]');
  });

  it('accepts and records the recurrence actually retained from disk', () => {
    writeFileSync(actionFile, record('Task', '\nrecurrence: []'));
    store.rebuild();
    const recurrence = [{ dtstart: '2099-10-10', rrule: 'FREQ=DAILY' }];
    writeFileSync(actionFile, record('Task', '\nrecurrence:\n  - dtstart: 2099-10-10\n    rrule: FREQ=DAILY'));
    handleUpdateAction(store, { id: actionId, body: 'Revised template.' });
    expect(store.getAction(actionId)!.frontMatter.recurrence).toEqual(recurrence);
    expect(readRecurrenceHistory(recurrenceHistoryPath(dir, 'merged-state-test')).get(actionId)).toEqual(recurrence);
    expect(store.getAction(actionId)).toEqual(parseActionFile(readFileSync(actionFile, 'utf8')).value);
  });

  it('rejects external recurrence history rewrites before changing the record or history', () => {
    writeFileSync(actionFile, record('Task', '\nrecurrence: []'));
    store.rebuild();
    const external = record('Task', '\nrecurrence:\n  - dtstart: 2020-10-10\n    rrule: FREQ=DAILY');
    writeFileSync(actionFile, external);
    const historyFile = recurrenceHistoryPath(dir, 'merged-state-test');
    const history = readFileSync(historyFile, 'utf8');
    expect(() => handleUpdateAction(store, { id: actionId, body: 'Cannot be saved.' })).toThrow('time before now');
    expect(readFileSync(actionFile, 'utf8')).toBe(external);
    expect(readFileSync(historyFile, 'utf8')).toBe(history);
    expect(store.getAction(actionId)!.frontMatter.recurrence).toEqual([]);
  });

  it('rejects invalid scheduling retained from an external edit before writing', () => {
    const external = record('Task', '\nscheduled: 2026-99-10T09:00');
    writeFileSync(actionFile, external);
    expect(() => handleUpdateAction(store, { id: actionId, body: 'Cannot be saved.' })).toThrow('scheduled');
    expect(readFileSync(actionFile, 'utf8')).toBe(external);
    expect(store.getAction(actionId)!.frontMatter.scheduled).toBe('2026-10-11T09:00');
  });

  it('rejects wrong-typed scheduling that the tolerant parser would otherwise omit', () => {
    const external = record('Task', '\nscheduled: 123');
    writeFileSync(actionFile, external);
    expect(() => handleUpdateAction(store, { id: actionId, body: 'Cannot be saved.' })).toThrow('scheduled');
    expect(readFileSync(actionFile, 'utf8')).toBe(external);
    expect(store.getAction(actionId)!.frontMatter.scheduled).toBe('2026-10-11T09:00');
  });

  it('rejects malformed preserved declarations before changing the record or accepted history', () => {
    writeFileSync(actionFile, record('Task', '\nrecurrence: []'));
    store.rebuild();
    const external = record('Task', '\nrecurrence: {dtstart: 2099-10-10, rrule: FREQ=DAILY}');
    writeFileSync(actionFile, external);
    const historyFile = recurrenceHistoryPath(dir, 'merged-state-test');
    const history = readFileSync(historyFile, 'utf8');
    expect(() => handleUpdateAction(store, { id: actionId, body: 'Cannot be saved.' })).toThrow('ordered list');
    expect(readFileSync(actionFile, 'utf8')).toBe(external);
    expect(readFileSync(historyFile, 'utf8')).toBe(history);
  });

  it('rejects preserved external changes to immutable occurrence provenance', () => {
    const templateId = '2026-10-10-template';
    writeFileSync(join(dirname(actionFile), `${templateId}.md`), record('Template', '\nrecurrence:\n  - dtstart: 2099-10-10\n    rrule: FREQ=DAILY'));
    writeFileSync(actionFile, record('Task', `\noccurrence: {template: ${templateId}, original: 2099-10-10}`));
    store.rebuild();
    const external = record('Task', `\noccurrence: {template: ${templateId}, original: 2099-10-11}`);
    writeFileSync(actionFile, external);
    expect(() => handleUpdateAction(store, { id: actionId, body: 'Cannot be saved.' })).toThrow('immutable');
    expect(readFileSync(actionFile, 'utf8')).toBe(external);
    expect(store.getAction(actionId)!.frontMatter.occurrence!.original).toBe('2099-10-10');
  });

  it.each(['\n', '\r\n'])('preserves trailing block-scalar newlines and exact body bytes during attachment reconciliation with %j line endings', newline => {
    const body = '\n\n  Body with trailing spaces.  \n\n'.replace(/\n/g, newline);
    const original = `---\nname: Material\ncreated: 2026-10-10T09:00\ncustom: |+\n  Keep this line.\n\n\n---`.replace(/\n/g, newline) + body;
    writeFileSync(artifactFile, original);
    const before = parseDocument(splitFrontMatter(original).yaml).toJS().custom;
    const attachment = artifactAttachmentPath(dir, artifactId, 'file.txt');
    mkdirSync(dirname(attachment), { recursive: true });
    writeFileSync(attachment, 'Attachment');
    store.refreshArtifactAttachments(artifactId);
    const output = readFileSync(artifactFile, 'utf8');
    expect(parseDocument(splitFrontMatter(output).yaml).toJS().custom).toBe(before);
    expect(output.endsWith(body)).toBe(true);
    expect(store.getArtifact(artifactId)!.frontMatter.attachments).toEqual(['file.txt']);
  });
});
