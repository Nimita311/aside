import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { Store } from '../src/source/store.js';
import { handleUpdateAction, handleUpdateProject, handleUpdateEntry } from '../src/mcp/tools/update.js';
import { executeGraphQL } from '../src/graphql/schema.js';
import { splitWeekFile } from '../src/mcp/tools/entry-file.js';

function readFrontMatter(path: string): any {
  const content = readFileSync(path, 'utf-8');
  return parseYaml(content.match(/^---\n([\s\S]*?)\n---/m)![1]);
}

describe('update_action / update_project', () => {
  let tempDir: string;
  let store: Store;
  let actionFile: string;
  let projectFile: string;
  const read = async (document: string, variables?: Record<string, unknown>) => {
    const result = await executeGraphQL(store, 'query', { document, variables });
    expect(result.errors).toBeUndefined();
    return result.data as any;
  };

  beforeEach(() => {
    tempDir = join(tmpdir(), `aside-update-test-${Date.now()}`);
    mkdirSync(join(tempDir, 'notes', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'projects', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'actions', '2026'), { recursive: true });

    writeFileSync(
      join(tempDir, 'projects', '2026', 'index.yaml'),
      `- id: 2026-01-10-migration\n  description: "The migration project"\n- id: 2026-01-05-infra\n  description: "Infra work"\n`
    );
    projectFile = join(tempDir, 'projects', '2026', '2026-01-10-migration.md');
    writeFileSync(projectFile, `---\nname: Migration\ncreated: 2026-01-10T09:00\n---\n\nMigrate everything.\n`);
    writeFileSync(
      join(tempDir, 'projects', '2026', '2026-01-05-infra.md'),
      `---\nname: Infra\ncreated: 2026-01-05T09:00\n---\n\nPlatform work.\n`
    );

    writeFileSync(
      join(tempDir, 'actions', '2026', 'index.yaml'),
      `- id: 2026-01-15-deploy-db\n  description: "Deploy the database"\n`
    );
    actionFile = join(tempDir, 'actions', '2026', '2026-01-15-deploy-db.md');
    writeFileSync(
      actionFile,
      `---\nname: Deploy DB\ncreated: 2026-01-15T10:00\nscheduled: 2026-02-01T10:00\ndeadline: 2026-02-05T17:00\n---\n\nMigrate prod to the new schema.\n`
    );

    // An entry tying the action to the migration project (source of relationships).
    writeFileSync(
      join(tempDir, 'notes', '2026', 'index.yaml'),
      `- id: "2026-01-15T10:00"\n  description: "Kickoff"\n`
    );
    writeFileSync(
      join(tempDir, 'notes', '2026', '2026-01-12.md'),
      `---\nweek: 3\nweek_start: 2026-01-12\nweek_end: 2026-01-18\n---\n\n\`\`\`entry\ncreated: 2026-01-15T10:00\nprojects: [2026-01-10-migration]\nactions: [2026-01-15-deploy-db]\n\`\`\`\n\nKickoff\n`
    );

    store = new Store(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['action', 'project'] as const)('does not recreate a deleted %s from published state during an update', kind => {
    const file = kind === 'action' ? actionFile : projectFile;
    const id = kind === 'action' ? '2026-01-15-deploy-db' : '2026-01-10-migration';
    const update = kind === 'action' ? handleUpdateAction : handleUpdateProject;
    const index = join(tempDir, kind === 'action' ? 'actions' : 'projects', '2026', 'index.yaml');
    const before = readFileSync(index, 'utf8');
    rmSync(file);
    expect(() => update(store, {id, body: 'New body', description: 'New description'})).toThrow();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(index, 'utf8')).toBe(before);
  });

  it('renames action and project displays while preserving identity and relationships', () => {
    const actionId = '2026-01-15-deploy-db';
    const projectId = '2026-01-10-migration';
    expect(handleUpdateAction(store, { id: actionId, name: 'Deploy the new database' })).toBeUndefined();
    expect(handleUpdateProject(store, { id: projectId, name: 'Database migration' })).toBeUndefined();
    expect(store.getAction(actionId)?.frontMatter.name).toBe('Deploy the new database');
    expect(store.getProject(projectId)?.frontMatter.name).toBe('Database migration');
    expect(store.getActionFile(actionId)).toBe(actionFile);
    expect(store.getProjectFile(projectId)).toBe(projectFile);
    expect(readFrontMatter(actionFile).created).toBe('2026-01-15T10:00');
    expect(readFrontMatter(projectFile).created).toBe('2026-01-10T09:00');
    expect([...(store.getRelations().projectsByAction.get(actionId) ?? [])]).toContain(projectId);
    expect(store.getEntries()[0].meta.actions).toContain(actionId);
    expect(store.getEntries()[0].meta.projects).toContain(projectId);
    expect(store.getActionIds()).toEqual([actionId]);
    expect(store.getProjectIds()).toContain(projectId);
  });

  it.each(['', '  '])('rejects blank names before changing either record', name => {
    const beforeAction = readFileSync(actionFile, 'utf8');
    const beforeProject = readFileSync(projectFile, 'utf8');
    expect(() => handleUpdateAction(store, { id: '2026-01-15-deploy-db', name, description: 'changed' })).toThrow(/name/);
    expect(() => handleUpdateProject(store, { id: '2026-01-10-migration', name, description: 'changed' })).toThrow(/name/);
    expect(readFileSync(actionFile, 'utf8')).toBe(beforeAction);
    expect(readFileSync(projectFile, 'utf8')).toBe(beforeProject);
  });

  it('completes an action, preserving other fields', () => {
    expect(handleUpdateAction(store, { id: '2026-01-15-deploy-db', resolution: 'done' })).toBeUndefined();

    const fm = readFrontMatter(actionFile);
    expect(fm.resolution).toBe('done');
    expect(fm.scheduled).toBe('2026-02-01T10:00');
    expect(fm.deadline).toBe('2026-02-05T17:00');
    expect(fm.name).toBe('Deploy DB');
  });

  it('reads back the file path of the updated entity', async () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', resolution: 'done' });
    handleUpdateProject(store, { id: '2026-01-10-migration', ended: '2026-06-01T12:00' });
    const updated = await read('{ action(id: "2026-01-15-deploy-db") { filePath } project(id: "2026-01-10-migration") { filePath } }');
    expect(updated.action.filePath).toBe(actionFile);
    expect(updated.project.filePath).toBe(projectFile);
  });

  it.each(['2026-02-30T25:90', '2026-02-29T12:00', '2026-10-04', '2026-10-04T12:00Z', '', '0000-01-01T12:00'])('rejects invalid project closure %s without changing its file or index', ended => {
    const before = readFileSync(projectFile, 'utf8');
    const index = join(tempDir, 'projects', '2026', 'index.yaml');
    const beforeIndex = readFileSync(index, 'utf8');
    expect(() => handleUpdateProject(store, { id: '2026-01-10-migration', ended, description: 'Changed' })).toThrow(/ended/);
    expect(readFileSync(projectFile, 'utf8')).toBe(before);
    expect(readFileSync(index, 'utf8')).toBe(beforeIndex);
    expect(store.getProject('2026-01-10-migration')?.frontMatter.ended).toBeUndefined();
  });

  it.each(['actions', 'projects', 'notes'] as const)('reuses a tolerated multiline %s ID and warns on one line about an unsaved description', async (kind) => {
    const id = `2026-02-03-${kind}\nid: forged`;
    const year = join(tempDir, kind, '2026');
    const index = join(year, 'index.yaml');
    writeFileSync(index, readFileSync(index, 'utf8') + `- id: ${JSON.stringify(id)}\n  description: Initial summary\n`);
    if (kind === 'notes') {
      writeFileSync(join(year, '2026-02-02.md'), `---\nweek: 6\nweek_start: 2026-02-02\nweek_end: 2026-02-08\n---\n\n\`\`\`entry\ncreated: ${JSON.stringify(id)}\n\`\`\`\n\nAuthored note.\n`);
    } else {
      writeFileSync(join(year, `${id}.md`), '---\nname: Tolerated record\ncreated: 2026-02-03T10:00\n---\nAuthored body.\n');
    }
    store.rebuild();
    const root = kind === 'actions' ? 'actions' : kind === 'projects' ? 'projects' : 'entries';
    const lookup = async () => (await read(`query($ids: [ID!]) { ${root}(where: {ids: $ids}) { nodes { id description } } }`, { ids: [id] }))[root].nodes;
    const [{ id: returnedId }] = await lookup();
    expect(returnedId).toBe(id);
    const update = (description: string) => kind === 'actions'
      ? handleUpdateAction(store, { id: returnedId, description })
      : kind === 'projects' ? handleUpdateProject(store, { id: returnedId, description })
        : handleUpdateEntry(store, { id: returnedId, description }).warning;
    expect(update('Revised summary')).toBeUndefined();
    store.rebuild();
    expect(await lookup()).toEqual([{ id, description: 'Revised summary' }]);

    writeFileSync(index, '[]\n');
    store.rebuild();
    const warning = update('Unpersisted summary')!;
    expect(warning).toContain('Description not saved');
    expect(warning).toContain(`index entry for ${JSON.stringify(id)} could not be updated`);
    expect(warning.split('\n')).toHaveLength(1);
    expect(readFileSync(index, 'utf8')).toBe('[]\n');
    expect(await lookup()).toEqual([{ id, description: null }]);
  });

  it('cancels an action', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', resolution: 'cancelled' });
    expect(readFrontMatter(actionFile).resolution).toBe('cancelled');
  });

  it('sets and clears the calendar sync fields', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', calendar: 'Work', duration: 'PT1H', timezone: 'Asia/Tokyo' });
    let fm = readFrontMatter(actionFile);
    expect(fm.calendar).toBe('Work');
    expect(fm.duration).toBe('PT1H');
    expect(fm.timezone).toBe('Asia/Tokyo');
    expect(fm.scheduled).toBe('2026-02-01T10:00'); // untouched

    store.rebuild();
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', calendar: null, duration: null, timezone: null });
    fm = readFrontMatter(actionFile);
    expect(fm.calendar).toBeUndefined();
    expect(fm.duration).toBeUndefined();
    expect(fm.timezone).toBeUndefined();
    expect(fm.scheduled).toBe('2026-02-01T10:00'); // still untouched
  });

  it.each(['', '  '])('rejects blank calendar names before changing a routed action or its index', calendar => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', calendar: 'Work' });
    const before = readFileSync(actionFile, 'utf8');
    const index = join(tempDir, 'actions', '2026', 'index.yaml');
    const beforeIndex = readFileSync(index, 'utf8');
    expect(() => handleUpdateAction(store, { id: '2026-01-15-deploy-db', calendar, description: 'Changed' })).toThrow(/calendar.*null/);
    expect(readFileSync(actionFile, 'utf8')).toBe(before);
    expect(readFileSync(index, 'utf8')).toBe(beforeIndex);
    expect(store.getAction('2026-01-15-deploy-db')?.frontMatter.calendar).toBe('Work');
  });

  it('deschedules an action with null (back to backlog)', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', scheduled: null });
    const fm = readFrontMatter(actionFile);
    expect(fm.scheduled).toBeUndefined();
    expect(fm.deadline).toBe('2026-02-05T17:00');
  });

  it('reschedules an action', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', scheduled: '2026-03-01T09:00' });
    expect(readFrontMatter(actionFile).scheduled).toBe('2026-03-01T09:00');
  });

  it('reactivates a resolved action with null', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', resolution: 'done' });
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', resolution: null });
    expect(readFrontMatter(actionFile).resolution).toBeUndefined();
  });

  it('replaces the action body, keeping front matter', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', body: 'New plan: blue/green cutover.' });
    const content = readFileSync(actionFile, 'utf-8');
    expect(content).toContain('New plan: blue/green cutover.');
    expect(content).not.toContain('Migrate prod to the new schema.');
    expect(readFrontMatter(actionFile).scheduled).toBe('2026-02-01T10:00');
  });

  it('keeps derived projects on an updated action', async () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', resolution: 'done' });
    const { action } = await read('{ action(id: "2026-01-15-deploy-db") { projects { nodes { id } } } }');
    expect(action.projects.nodes).toEqual([{ id: '2026-01-10-migration' }]);
  });

  it('closes a project', async () => {
    expect(handleUpdateProject(store, { id: '2026-01-10-migration', ended: '2026-06-01T12:00' })).toBeUndefined();
    expect((await read('{ project(id: "2026-01-10-migration") { status } }')).project.status).toBe('CLOSED');
    expect(readFrontMatter(projectFile).ended).toBe('2026-06-01T12:00');
  });

  it('reopens a project with null', () => {
    handleUpdateProject(store, { id: '2026-01-10-migration', ended: '2026-06-01T12:00' });
    handleUpdateProject(store, { id: '2026-01-10-migration', ended: null });
    expect(readFrontMatter(projectFile).ended).toBeUndefined();
  });

  it('sets related_projects (replace) and validates references', () => {
    handleUpdateProject(store, {
      id: '2026-01-10-migration',
      related_projects: [{ project: '2026-01-05-infra', description: 'depends on infra' }],
    });
    const fm = readFrontMatter(projectFile);
    expect(fm.related_projects).toHaveLength(1);
    expect(fm.related_projects[0].project).toBe('2026-01-05-infra');
    expect(fm.related_projects[0].description).toBe('depends on infra');
  });

  it('clears related_projects with an empty array', () => {
    handleUpdateProject(store, {
      id: '2026-01-10-migration',
      related_projects: [{ project: '2026-01-05-infra', description: 'depends on infra' }],
    });
    handleUpdateProject(store, { id: '2026-01-10-migration', related_projects: [] });
    expect(readFrontMatter(projectFile).related_projects).toBeUndefined();
  });

  it('a description-only update does not rewrite the project file', () => {
    const spy = vi.spyOn(store, 'saveProject');
    expect(handleUpdateProject(store, { id: '2026-01-10-migration', description: 'Notion to text + tools' })).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    expect(store.getProjectIndex().find(i => i.id === '2026-01-10-migration')?.description).toBe('Notion to text + tools');
    spy.mockRestore();
  });

  it('updates the index description', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', description: 'Cut over prod database' });
    const index = readFileSync(join(tempDir, 'actions', '2026', 'index.yaml'), 'utf-8');
    expect(index).toContain('Cut over prod database');
    expect(index).not.toContain('Deploy the database');
  });

  it('returns saved action changes and a warning when a malformed index cannot save the description', () => {
    const index = join(tempDir, 'actions', '2026', 'index.yaml');
    const malformed = '- id: 2026-01-15-deploy-db\n  description: [unterminated\n';
    writeFileSync(index, malformed);
    const warning = handleUpdateAction(store, {
      id: '2026-01-15-deploy-db', scheduled: '2026-02-03T11:00', body: 'New action details', description: 'New headline',
    });
    expect(warning).toContain('Description not saved');
    expect(store.getAction('2026-01-15-deploy-db')?.frontMatter.scheduled).toBe('2026-02-03T11:00');
    expect(store.getAction('2026-01-15-deploy-db')?.body).toBe('New action details');
    expect(store.getActionIndex().find((item) => item.id === '2026-01-15-deploy-db')?.description).toBe('Deploy the database');
    expect(readFileSync(index, 'utf8')).toBe(malformed);
    store.rebuild();
    expect(store.getAction('2026-01-15-deploy-db')?.frontMatter.scheduled).toBe('2026-02-03T11:00');
    expect(store.getAction('2026-01-15-deploy-db')?.body).toBe('New action details');
  });

  it('warns and changes nothing when a description lands on an unindexed record', () => {
    const indexes = ['actions', 'projects', 'notes'].map(kind => join(tempDir, kind, '2026', 'index.yaml'));
    writeFileSync(join(tempDir, 'actions', '2026', '2026-01-16-unindexed.md'), '---\nname: Unindexed action\ncreated: 2026-01-16T10:00\n---\n\nAction body.\n');
    writeFileSync(join(tempDir, 'projects', '2026', '2026-01-16-unindexed.md'), '---\nname: Unindexed project\ncreated: 2026-01-16T10:00\n---\n\nProject body.\n');
    const week = join(tempDir, 'notes', '2026', '2026-01-12.md');
    writeFileSync(week, readFileSync(week, 'utf8') + '\n---\n```entry\ncreated: 2026-01-16T10:00\n```\n\nUnindexed entry.\n');
    store.rebuild();
    const files = [...indexes, week, store.getActionFile('2026-01-16-unindexed')!, store.getProjectFile('2026-01-16-unindexed')!];
    const before = files.map(file => readFileSync(file, 'utf8'));
    const warnings = [
      handleUpdateAction(store, { id: '2026-01-16-unindexed', description: 'Lost action summary' }),
      handleUpdateProject(store, { id: '2026-01-16-unindexed', description: 'Lost project summary' }),
      handleUpdateEntry(store, { id: '2026-01-16T10:00', description: 'Lost entry summary' }).warning,
    ];
    for (const warning of warnings) expect(warning).toContain('Description not saved');
    expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(before);
    expect(store.getIndexDescription('actions', '2026-01-16-unindexed')).toBeUndefined();
    expect(store.getIndexDescription('projects', '2026-01-16-unindexed')).toBeUndefined();
    expect(store.getIndexDescription('notes', '2026-01-16T10:00')).toBeUndefined();
    expect(store.getAction('2026-01-16-unindexed')?.body).toBe('Action body.');
    expect(store.getProject('2026-01-16-unindexed')?.body).toBe('Project body.');
    expect(store.getEntries().find(e => e.meta.created === '2026-01-16T10:00')?.content).toBe('Unindexed entry.');
  });

  it('a description-only update does not rewrite the action file', () => {
    const spy = vi.spyOn(store, 'saveAction');
    expect(handleUpdateAction(store, { id: '2026-01-15-deploy-db', description: 'Cut over prod database' })).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    expect(store.getActionIndex().find(i => i.id === '2026-01-15-deploy-db')?.description).toBe('Cut over prod database');
    spy.mockRestore();
  });

  it('matches only a list-item id line, not an id mentioned in a description', () => {
    // The first item's description ends with `id: <target>`; an unanchored match
    // would hit that line and silently skip the real item below it.
    writeFileSync(
      join(tempDir, 'actions', '2026', 'index.yaml'),
      `- id: 2026-01-14-note\n  description: "follow-up on id: 2026-01-15-deploy-db"\n- id: 2026-01-15-deploy-db\n  description: "Deploy the database"\n`
    );
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', description: 'Cut over prod' });
    const index = readFileSync(join(tempDir, 'actions', '2026', 'index.yaml'), 'utf-8');
    expect(index).toContain('Cut over prod');
    expect(index).not.toContain('Deploy the database');
    expect(index).toContain('follow-up on id: 2026-01-15-deploy-db'); // untouched
  });

  it('updates an indented list item — still valid YAML — preserving its indentation', () => {
    writeFileSync(
      join(tempDir, 'actions', '2026', 'index.yaml'),
      `  - id: 2026-01-15-deploy-db\n    description: "Deploy the database"\n`
    );
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', description: 'Cut over prod' });
    const index = readFileSync(join(tempDir, 'actions', '2026', 'index.yaml'), 'utf-8');
    expect(index).toContain('    description: Cut over prod');
    expect(index).not.toContain('Deploy the database');
  });

  it('collapses CR and CRLF in a description like LF (one-line index rule)', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', description: 'cut\r\nover\rprod' });
    const index = readFileSync(join(tempDir, 'actions', '2026', 'index.yaml'), 'utf-8');
    expect(index).toContain('cut over prod');
  });

  it('matches the index ID exactly (no superstring collision)', () => {
    // Add a second action whose ID is a superstring of the first.
    writeFileSync(
      join(tempDir, 'actions', '2026', 'index.yaml'),
      `- id: 2026-01-15-deploy-db\n  description: "Deploy the database"\n- id: 2026-01-15-deploy-db-staging\n  description: "Deploy staging"\n`
    );
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', description: 'Cut over prod' });
    const index = readFileSync(join(tempDir, 'actions', '2026', 'index.yaml'), 'utf-8');
    expect(index).toContain('Cut over prod');
    expect(index).toContain('Deploy staging'); // unchanged
  });

  it('survives a store rebuild (round-trips cleanly)', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', resolution: 'done', scheduled: null });
    store.rebuild();
    const action = store.getAction('2026-01-15-deploy-db');
    expect(action?.frontMatter.resolution).toBe('done');
    expect(action?.frontMatter.scheduled).toBeUndefined();
    expect(store.getIssues()).toHaveLength(0);
  });

  it('reflects the change in the same store synchronously (no rebuild)', () => {
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', resolution: 'done', description: 'Cut over prod' });
    // Same store instance, no rebuild() and no watcher: the update is already live.
    expect(store.getAction('2026-01-15-deploy-db')?.frontMatter.resolution).toBe('done');
    expect(store.getActionIndex().find(i => i.id === '2026-01-15-deploy-db')?.description).toBe('Cut over prod');
  });

  it('a later update on the same store composes on the earlier one (no lost field)', () => {
    // Each update reads the action from the store. Without synchronous updates the
    // second read would see pre-first-update state and drop the calendar field.
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', calendar: 'Work' });
    handleUpdateAction(store, { id: '2026-01-15-deploy-db', resolution: 'done' });
    const fm = readFrontMatter(actionFile);
    expect(fm.calendar).toBe('Work'); // preserved across the second update
    expect(fm.resolution).toBe('done');
  });

  it('throws on non-existent action', () => {
    expect(() => handleUpdateAction(store, { id: 'nope', resolution: 'done' }))
      .toThrow('Cannot update action "nope" — not found.');
  });

  it('throws on non-existent project', () => {
    expect(() => handleUpdateProject(store, { id: 'nope', ended: '2026-06-01T12:00' }))
      .toThrow('Cannot update project "nope" — not found.');
  });

  it('throws on a dangling related_projects reference', () => {
    expect(() => handleUpdateProject(store, {
      id: '2026-01-10-migration',
      related_projects: [{ project: 'does-not-exist', description: 'broken' }],
    })).toThrow('Related project "does-not-exist" not found');
  });

  // --- update_entry: edits an existing entry in its weekly file ---
  const ENTRY = '2026-01-15T10:00';

  it('edits entry content, keeping its links', () => {
    expect(handleUpdateEntry(store, { id: ENTRY, content: 'Revised kickoff notes' })).toEqual({ createdProjectIds: [], createdActionIds: [] });
    const entry = store.getEntries().find(e => e.meta.created === ENTRY)!;
    expect(entry.content).toBe('Revised kickoff notes');
    expect(entry.meta.projects).toEqual(['2026-01-10-migration']);
    expect(entry.meta.actions).toEqual(['2026-01-15-deploy-db']);
  });

  it('updates the entry index description', () => {
    handleUpdateEntry(store, { id: ENTRY, description: 'Project kickoff meeting' });
    const index = readFileSync(join(tempDir, 'notes', '2026', 'index.yaml'), 'utf-8');
    expect(index).toContain('Project kickoff meeting');
    expect(index).not.toContain('Kickoff');
    expect(store.getNoteIndex().find(i => i.id === ENTRY)?.description).toBe('Project kickoff meeting');
  });

  it('replaces the project links, leaving content and actions', () => {
    handleUpdateEntry(store, { id: ENTRY, projects: ['2026-01-05-infra'] });
    const entry = store.getEntries().find(e => e.meta.created === ENTRY)!;
    expect(entry.meta.projects).toEqual(['2026-01-05-infra']);
    expect(entry.content).toBe('Kickoff');
    expect(entry.meta.actions).toEqual(['2026-01-15-deploy-db']);
  });

  it('clears action links with [] and project links with null', () => {
    handleUpdateEntry(store, { id: ENTRY, actions: [] });
    expect(store.getEntries().find(e => e.meta.created === ENTRY)!.meta.actions ?? []).toEqual([]);
    handleUpdateEntry(store, { id: ENTRY, projects: null });
    expect(store.getEntries().find(e => e.meta.created === ENTRY)!.meta.projects ?? []).toEqual([]);
  });

  it('omits unchanged fields (merge-patch)', () => {
    handleUpdateEntry(store, { id: ENTRY, description: 'New headline' });
    const entry = store.getEntries().find(e => e.meta.created === ENTRY)!;
    expect(entry.content).toBe('Kickoff');
    expect(entry.meta.projects).toEqual(['2026-01-10-migration']);
    expect(entry.meta.actions).toEqual(['2026-01-15-deploy-db']);
  });

  it('survives a store rebuild', () => {
    handleUpdateEntry(store, { id: ENTRY, content: 'Rebuilt body', projects: ['2026-01-05-infra'] });
    store.rebuild();
    const entry = store.getEntries().find(e => e.meta.created === ENTRY)!;
    expect(entry.content).toBe('Rebuilt body');
    expect(entry.meta.projects).toEqual(['2026-01-05-infra']);
    expect(store.getIssues()).toHaveLength(0);
  });

  it('reads back the updated entry ID with its weekly-file path', async () => {
    handleUpdateEntry(store, { id: ENTRY, content: 'x' });
    const { entry } = await read(`{ entry(id: "${ENTRY}") { id filePath } }`);
    expect(entry.filePath).toBe(join(tempDir, 'notes', '2026', '2026-01-12.md'));
    expect(entry.id).toBe(ENTRY);
    handleUpdateEntry(store, { id: entry.id, description: 'Reusable ID' });
    expect((await read(`{ entry(id: "${ENTRY}") { description } }`)).entry.description).toBe('Reusable ID');
  });

  it.each([
    "created: '2026-01-15T10:00'",
    'created: "2026-01-15T10:00" # hand-edited timestamp',
    'created: "\\u0032026-01-15T10:00"',
    'created: |-\n  2026-01-15T10:00',
  ])('reuses a queried entry ID with supported YAML timestamp syntax (%j)', async (created) => {
    const week = join(tempDir, 'notes', '2026', '2026-01-12.md');
    const neighbour = '---\n```entry\ncreated: 2026-01-16T09:00\n```\n\nKeep this neighbouring entry.';
    writeFileSync(week, `---\nweek: 3\nweek_start: 2026-01-12\nweek_end: 2026-01-18\n---\n\n${neighbour}\n\n---\n\`\`\`entry\n${created}\nprojects: [2026-01-10-migration]\nactions: [2026-01-15-deploy-db]\n\`\`\`\n\nKickoff\n`);
    store.rebuild();
    expect(store.getIssues()).toEqual([]);
    const { entry: { id: returnedId } } = await read(`{ entry(id: "${ENTRY}") { id } }`);
    expect(returnedId).toBe(ENTRY);
    handleUpdateEntry(store, { id: returnedId, content: 'Revised kickoff', projects: ['2026-01-05-infra'] });
    expect(readFileSync(week, 'utf8')).toContain(neighbour);
    store.rebuild();
    expect(store.getEntries()).toHaveLength(2);
    const entry = store.getEntries().find(item => item.meta.created === ENTRY)!;
    expect(entry.content).toBe('Revised kickoff');
    expect(entry.meta.projects).toEqual(['2026-01-05-infra']);
    expect(entry.meta.actions).toEqual(['2026-01-15-deploy-db']);
    expect(store.getIssues()).toEqual([]);
  });

  it('preserves tolerated unusual entry and link IDs when rewriting parsed metadata', async () => {
    const id = '2026-01-15T10:00```literal\nid: literal';
    const projectId = 'project, [literal]\nid: quoted';
    const taggedProjectId = '!custom tagged';
    const actionId = 'action: note ] # reference ``` literal';
    writeFileSync(join(tempDir, 'projects', '2026', `${projectId}.md`), '---\nname: Tolerated project\ncreated: 2026-01-15T10:00\n---\n');
    writeFileSync(join(tempDir, 'projects', '2026', `${taggedProjectId}.md`), '---\nname: Tagged-looking project\ncreated: 2026-01-15T10:00\n---\n');
    writeFileSync(join(tempDir, 'actions', '2026', `${actionId}.md`), '---\nname: Tolerated action\ncreated: 2026-01-15T10:00\n---\n');
    const week = join(tempDir, 'notes', '2026', '2026-01-12.md');
    const sourceScalar = (value: string) => JSON.stringify(value).replace(/`/g, '\\u0060');
    writeFileSync(week, `---\nweek: 3\nweek_start: 2026-01-12\nweek_end: 2026-01-18\n---\n\n---\n\`\`\`entry\ncreated: ${sourceScalar(id)}\nprojects: [${sourceScalar(projectId)}, ${sourceScalar(taggedProjectId)}]\nactions: [${sourceScalar(actionId)}]\n\`\`\`\n\nOriginal note.\n`);
    store.rebuild();
    expect(store.getIssues()).toEqual([]);
    const { entries } = await read('query($ids: [ID!]) { entries(where: {ids: $ids}) { nodes { id } } }', { ids: [id] });
    const returnedId: string = entries.nodes[0].id;
    expect(returnedId).toBe(id);
    handleUpdateEntry(store, { id: returnedId, content: 'Rewritten note.', projects: [projectId, taggedProjectId], actions: [actionId] });
    expect(readFileSync(week, 'utf8')).not.toContain('```literal');
    store.rebuild();
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].meta).toEqual({ created: id, projects: [projectId, taggedProjectId], actions: [actionId] });
    expect(store.getEntries()[0].content).toBe('Rewritten note.');
    expect(store.getIssues()).toEqual([]);
  });

  it('replays one comma-containing relationship ID distinctly from two existing IDs', async () => {
    const combined = 'literal, id';
    for (const id of [combined, 'literal', 'id']) {
      writeFileSync(join(tempDir, 'projects', '2026', `${id}.md`), '---\nname: Existing project\ncreated: 2026-01-15T10:00\n---\n');
    }
    store.rebuild();
    for (const expected of [[combined], ['literal', 'id']]) {
      handleUpdateEntry(store, { id: ENTRY, projects: expected });
      store.rebuild();
      const { entry } = await read(`{ entry(id: "${ENTRY}") { projects { nodes { id } } } }`);
      const returnedIds: string[] = entry.projects.nodes.map((node: { id: string }) => node.id);
      expect(returnedIds).toEqual(expected);
      handleUpdateEntry(store, { id: ENTRY, projects: returnedIds, content: 'Replayed relationships.' });
      store.rebuild();
      expect(store.getEntries().find(entry => entry.meta.created === ENTRY)?.meta.projects).toEqual(expected);
      expect(store.getIssues()).toEqual([]);
    }
  });

  it('a description-only edit leaves the weekly file untouched', () => {
    const weekFile = join(tempDir, 'notes', '2026', '2026-01-12.md');
    const before = readFileSync(weekFile, 'utf-8');
    const spy = vi.spyOn(store, 'saveEntry');
    handleUpdateEntry(store, { id: ENTRY, description: 'Just the headline' });
    // The description lives only in the index — no weekly-file write, so the file
    // is byte-identical (no incidental re-canonicalization of neighbouring entries).
    expect(spy).not.toHaveBeenCalled();
    expect(readFileSync(weekFile, 'utf-8')).toBe(before);
    expect(store.getNoteIndex().find(i => i.id === ENTRY)?.description).toBe('Just the headline');
    spy.mockRestore();
  });

  it('leaves a neighbouring entry alone when its prose mentions the target id', () => {
    // Entry B's content contains `created: <A's id>` mid-line; an unanchored
    // match would replace B's block with A's and duplicate A in the file.
    writeFileSync(
      join(tempDir, 'notes', '2026', '2026-01-12.md'),
      `---\nweek: 3\nweek_start: 2026-01-12\nweek_end: 2026-01-18\n---\n\n---\n\`\`\`entry\ncreated: 2026-01-16T09:00\n\`\`\`\n\nTicket was created: 2026-01-15T10:00 by ops.\n\n---\n\`\`\`entry\ncreated: 2026-01-15T10:00\nprojects: [2026-01-10-migration]\nactions: [2026-01-15-deploy-db]\n\`\`\`\n\nKickoff\n`
    );
    store.rebuild();

    handleUpdateEntry(store, { id: '2026-01-15T10:00', content: 'Revised kickoff notes' });
    store.rebuild();

    const entries = store.getEntries();
    expect(entries.map(e => e.meta.created)).toEqual(['2026-01-16T09:00', '2026-01-15T10:00']);
    expect(entries.find(e => e.meta.created === '2026-01-16T09:00')?.content)
      .toBe('Ticket was created: 2026-01-15T10:00 by ops.');
    expect(entries.find(e => e.meta.created === '2026-01-15T10:00')?.content)
      .toBe('Revised kickoff notes');
  });

  it('never identifies a segment by a created: line in prose, even with a malformed fence', () => {
    // Entry A's fence has an empty `created:` (malformed) and its prose holds a
    // column-0 `created: <B's id>` line. Matching anywhere in the segment — even
    // line-anchored — would replace A with B's block and duplicate B; only the
    // segment's leading fence may identify it.
    writeFileSync(
      join(tempDir, 'notes', '2026', '2026-01-12.md'),
      `---\nweek: 3\nweek_start: 2026-01-12\nweek_end: 2026-01-18\n---\n\n---\n\`\`\`entry\ncreated:\n\`\`\`\n\nA broken block.\ncreated: 2026-01-15T10:00\n\n---\n\`\`\`entry\ncreated: 2026-01-15T10:00\n\`\`\`\n\nKickoff\n`
    );
    store.rebuild();

    handleUpdateEntry(store, { id: '2026-01-15T10:00', content: 'Revised' });

    const file = readFileSync(join(tempDir, 'notes', '2026', '2026-01-12.md'), 'utf-8');
    expect(file).toContain('A broken block.');
    expect(file.match(/Revised/g)).toHaveLength(1);
  });

  it('rejects content that embeds the entry preamble', () => {
    const embedded = 'See the format:\n\n---\n```entry\ncreated: 2020-01-01T00:00\n```\n\nfake';
    expect(() => handleUpdateEntry(store, { id: ENTRY, content: embedded }))
      .toThrow(/entry preamble/);
  });

  it('throws on a non-existent entry', () => {
    expect(() => handleUpdateEntry(store, { id: '2030-01-01T00:00', content: 'x' }))
      .toThrow('Cannot update entry "2030-01-01T00:00" — not found.');
  });

  it('throws on dangling project and action references', () => {
    expect(() => handleUpdateEntry(store, { id: ENTRY, projects: ['no-such-project'] }))
      .toThrow('Project "no-such-project" not found.');
    expect(() => handleUpdateEntry(store, { id: ENTRY, actions: ['no-such-action'] }))
      .toThrow('Action "no-such-action" not found.');
  });

  it('creates a new action from an object and links it', () => {
    const result = handleUpdateEntry(store, {
      id: ENTRY,
      actions: ['2026-01-15-deploy-db', { name: 'Write Runbook', description: 'Document the cutover steps', scheduled: '2026-02-03T09:00' }],
    }, new Date(2026, 0, 20, 12, 0));
    expect(result.createdActionIds).toEqual(['2026-01-20-write-runbook']);
    const entry = store.getEntries().find(e => e.meta.created === ENTRY)!;
    expect(entry.meta.actions).toEqual(['2026-01-15-deploy-db', '2026-01-20-write-runbook']);
    const fm = readFrontMatter(join(tempDir, 'actions', '2026', '2026-01-20-write-runbook.md'));
    expect(fm.name).toBe('Write Runbook');
    expect(fm.scheduled).toBe('2026-02-03T09:00');
    expect(store.getActionIndex().find(i => i.id === '2026-01-20-write-runbook')?.description).toBe('Document the cutover steps');
  });

  it('creates a new project from an object and links it', () => {
    const result = handleUpdateEntry(store, {
      id: ENTRY,
      projects: [{ name: 'Runbooks', description: 'Operational runbooks' }],
    }, new Date(2026, 0, 20, 12, 0));
    expect(result.createdProjectIds).toEqual(['2026-01-20-runbooks']);
    const entry = store.getEntries().find(e => e.meta.created === ENTRY)!;
    expect(entry.meta.projects).toEqual(['2026-01-20-runbooks']);
    expect(readFrontMatter(join(tempDir, 'projects', '2026', '2026-01-20-runbooks.md')).name).toBe('Runbooks');
  });

  it('entities created through update_entry survive a store rebuild', () => {
    handleUpdateEntry(store, {
      id: ENTRY,
      projects: ['2026-01-10-migration', { name: 'Runbooks', description: 'Operational runbooks' }],
      actions: [{ name: 'Write Runbook', description: 'Document the cutover steps' }],
    }, new Date(2026, 0, 20, 12, 0));
    store.rebuild();
    const entry = store.getEntries().find(e => e.meta.created === ENTRY)!;
    expect(entry.meta.projects).toEqual(['2026-01-10-migration', '2026-01-20-runbooks']);
    expect(entry.meta.actions).toEqual(['2026-01-20-write-runbook']);
    expect(store.getIssues()).toHaveLength(0);
  });

  it('rejects a new entity whose ID already exists', () => {
    // "Deploy DB" on 2026-01-15 derives the fixture action's ID.
    expect(() => handleUpdateEntry(store, {
      id: ENTRY,
      actions: [{ name: 'Deploy DB', description: 'Duplicate' }],
    }, new Date(2026, 0, 15, 12, 0))).toThrow('Action ID "2026-01-15-deploy-db" already exists');
  });

  it('creates no entities when the weekly file cannot be parsed', () => {
    // The segment lookup runs before entity creation, so a deterministic weekly-file
    // failure leaves no orphaned projects/actions behind.
    writeFileSync(join(tempDir, 'notes', '2026', '2026-01-12.md'), 'no front matter here\n');
    expect(() => handleUpdateEntry(store, {
      id: ENTRY,
      actions: [{ name: 'Write Runbook', description: 'Document the cutover steps' }],
    }, new Date(2026, 0, 20, 12, 0))).toThrow('could not parse weekly file');
    expect(existsSync(join(tempDir, 'actions', '2026', '2026-01-20-write-runbook.md'))).toBe(false);
  });
});

describe('splitWeekFile', () => {
  it('recognizes an empty front-matter block (still front matter, not "none")', () => {
    expect(splitWeekFile('---\n\n---\nbody\n')).toEqual({ frontMatter: '---\n\n---\n', body: 'body\n' });
  });

  it('returns null only when there is no front matter at all', () => {
    expect(splitWeekFile('just text\n')).toBeNull();
  });

  it('re-attaches fences in the file\'s own line-ending style (no CRLF/LF mixing)', () => {
    const r = splitWeekFile('---\r\nweek: 18\r\nweek_start: 2026-05-04\r\n---\r\nbody\r\n')!;
    expect(r.frontMatter).toBe('---\r\nweek: 18\r\nweek_start: 2026-05-04\r\n---\r\n');
    expect(r.body).toBe('body\r\n');
  });
});
