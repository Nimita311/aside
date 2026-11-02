import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { Store } from '../src/mcp/store.js';
import { handleCapture, type CaptureArgs } from '../src/mcp/tools/capture.js';
import { handleUpdateEntry } from '../src/mcp/tools/update.js';

// Capture with a default entry description, so tests that don't assert on the
// timeline headline stay terse. Pass `description` to override it.
function cap(
  s: Store,
  args: Omit<CaptureArgs, 'description'> & { description?: string },
  now?: Date,
) {
  const { description = 'Test summary', ...rest } = args;
  return handleCapture(s, { ...rest, description }, now);
}

describe('handleCapture', () => {
  let tempDir: string;
  let store: Store;

  it('returns a reusable quoted file path for instances with newline and control characters', () => {
    const unusualDir = join(tempDir, 'instance\nid: forged\t\u001b[0m');
    mkdirSync(unusualDir, { recursive: true });
    writeFileSync(join(unusualDir, 'aside.md'), '---\nid: unusual-path\nname: Unusual path\n---\n');
    const unusualStore = new Store(unusualDir);
    try {
      const result = cap(unusualStore, { content: 'Captured safely.' }, new Date(2026, 9, 3, 9, 0));
      expect(result.text).not.toContain('\nid: forged');
      expect(result.text).not.toContain('\t');
      expect(result.text).not.toContain('\u001b');
      const returnedPath = JSON.parse(result.text.match(/^file: (.+)$/m)![1]);
      expect(returnedPath).toBe(unusualStore.getEntryFile(result.entryId));
      expect(readFileSync(returnedPath, 'utf8')).toContain('Captured safely.');
      const updated = handleUpdateEntry(unusualStore, { id: result.entryId, description: 'Updated safely.' });
      expect(JSON.parse(updated.text.match(/^file: (.+)$/m)![1])).toBe(returnedPath);
    } finally {
      unusualStore.close();
    }
  });

  beforeEach(() => {
    tempDir = join(tmpdir(), `aside-capture-test-${Date.now()}`);

    // Create directory structure
    mkdirSync(join(tempDir, 'notes', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'projects', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'actions', '2026'), { recursive: true });

    // Create project index and file
    writeFileSync(
      join(tempDir, 'projects', '2026', 'index.yaml'),
      `- id: existing-project\n  description: "An existing project"\n`
    );
    writeFileSync(
      join(tempDir, 'projects', '2026', 'existing-project.md'),
      `---\nname: Existing Project\ncreated: 2026-01-10T09:00\n---\n\nA project that already exists.\n`
    );

    // Create action index and file
    writeFileSync(
      join(tempDir, 'actions', '2026', 'index.yaml'),
      `- id: existing-action\n  description: "An existing action"\n`
    );
    writeFileSync(
      join(tempDir, 'actions', '2026', 'existing-action.md'),
      `---\nname: Existing Action\ncreated: 2026-01-15T10:00\nscheduled: 2026-02-01\n---\n\nAn action that already exists.\n`
    );

    // Create weekly file with an existing entry
    writeFileSync(
      join(tempDir, 'notes', '2026', 'index.yaml'),
      `- id: "2026-05-04T10:00"\n  description: "Existing entry content"\n`
    );
    writeFileSync(
      join(tempDir, 'notes', '2026', '2026-05-04.md'),
      `---\nweek: 19\nweek_start: 2026-05-04\nweek_end: 2026-05-10\n---\n\n---\n\`\`\`entry\ncreated: 2026-05-04T10:00\nprojects: [existing-project]\nactions: [existing-action]\n\`\`\`\n\nExisting entry content\n`
    );

    store = new Store(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a new entry in the correct weekly file', () => {
    // Use a date in the same week as 2026-05-04 (Monday)
    const now = new Date(2026, 4, 6, 14, 30); // May 6, 2026 14:30
    const result = cap(store, {
      content: 'A brand new entry for today',
    }, now);

    expect(result.text).toContain('entry: 2026-05-06T14:30');

    // Should be in the same weekly file (Monday 2026-05-04)
    const weekFile = join(tempDir, 'notes', '2026', '2026-05-04.md');
    expect(existsSync(weekFile)).toBe(true);
    const content = readFileSync(weekFile, 'utf-8');
    expect(content).toContain('created: 2026-05-06T14:30');
    expect(content).toContain('A brand new entry for today');
  });

  it('rejects a blank calendar before creating any linked project, action or note', () => {
    const week = join(tempDir, 'notes', '2026', '2026-05-04.md');
    const before = readFileSync(week, 'utf8');
    expect(() => cap(store, {
      content: 'Must not be saved',
      projects: [{ name: 'New project', description: 'Project' }],
      actions: [{ name: 'New action', description: 'Action', calendar: '' }],
    }, new Date(2026, 4, 6, 14, 30))).toThrow(/calendar/);
    expect(existsSync(join(tempDir, 'projects', '2026', '2026-05-06-new-project.md'))).toBe(false);
    expect(existsSync(join(tempDir, 'actions', '2026', '2026-05-06-new-action.md'))).toBe(false);
    expect(readFileSync(week, 'utf8')).toBe(before);
  });

  it('returns the entry weekly-file path', () => {
    const now = new Date(2026, 4, 6, 14, 30); // same week as 2026-05-04
    const result = cap(store, { content: 'Path check' }, now);
    expect(result.text).toContain('file:');
    expect(result.text).toContain('notes/2026/2026-05-04.md');
  });

  it('creates a new weekly file if none exists for the current week', () => {
    // Use a date in a different week
    const now = new Date(2026, 4, 11, 9, 15); // May 11, 2026 (Monday of week 20)
    const result = cap(store, {
      content: 'Entry in a new week',
    }, now);

    expect(result.text).toContain('entry: 2026-05-11T09:15');

    const weekFile = join(tempDir, 'notes', '2026', '2026-05-11.md');
    expect(existsSync(weekFile)).toBe(true);
    const content = readFileSync(weekFile, 'utf-8');
    expect(content).toContain('week:');
    expect(content).toContain('week_start: 2026-05-11');
    expect(content).toContain('week_end: 2026-05-17');
    expect(content).toContain('Entry in a new week');
  });

  it('creates new project (file + index)', () => {
    const now = new Date(2026, 4, 8, 11, 0); // May 8, 2026
    const result = cap(store, {
      content: 'Started new project work',
      projects: [{ name: 'My New Project', description: 'A brand new project', body: 'Project details here' }],
    }, now);

    expect(result.text).toContain('projects_created: [2026-05-08-my-new-project]');

    // Check project file exists
    const projFile = join(tempDir, 'projects', '2026', '2026-05-08-my-new-project.md');
    expect(existsSync(projFile)).toBe(true);
    const projContent = readFileSync(projFile, 'utf-8');
    expect(projContent).toContain('name: My New Project');
    expect(projContent).toContain('created: 2026-05-08T11:00');
    expect(projContent).toContain('Project details here');

    // Check index was updated
    const indexContent = readFileSync(join(tempDir, 'projects', '2026', 'index.yaml'), 'utf-8');
    expect(indexContent).toContain('2026-05-08-my-new-project');
    expect(indexContent).toContain('A brand new project');
    // New (newest) entry is prepended above the existing one (reverse chronological)
    const newIdx = indexContent.indexOf('2026-05-08-my-new-project');
    const oldIdx = indexContent.indexOf('existing-project');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('creates new action (file + index)', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    const result = cap(store, {
      content: 'Need to do something',
      actions: [{ name: 'Fix Bug', description: 'Fix the login bug for real', body: 'Fix the login bug', scheduled: '2026-05-10', deadline: '2026-05-15' }],
    }, now);

    expect(result.text).toContain('actions_created: [2026-05-08-fix-bug]');

    // Check action file exists
    const actFile = join(tempDir, 'actions', '2026', '2026-05-08-fix-bug.md');
    expect(existsSync(actFile)).toBe(true);
    const actContent = readFileSync(actFile, 'utf-8');
    expect(actContent).toContain('name: Fix Bug');
    expect(actContent).toContain('created: 2026-05-08T11:00');
    expect(actContent).toContain('scheduled: 2026-05-10');
    expect(actContent).toContain('deadline: 2026-05-15');
    expect(actContent).toContain('Fix the login bug');

    // Check index was updated
    const indexContent = readFileSync(join(tempDir, 'actions', '2026', 'index.yaml'), 'utf-8');
    expect(indexContent).toContain('2026-05-08-fix-bug');
    expect(indexContent).toContain('description: Fix the login bug for real'); // the description, not the name
    expect(indexContent).not.toContain('description: Fix Bug'); // name is not reused as the description
    // New (newest) entry is prepended above the existing one (reverse chronological)
    const newIdx = indexContent.indexOf('2026-05-08-fix-bug');
    const oldIdx = indexContent.indexOf('existing-action');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('entry references both existing and new entities', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    const result = cap(store, {
      content: 'Working on both projects',
      projects: ['existing-project', { name: 'New Proj', description: 'desc' }],
      actions: ['existing-action', { name: 'New Act', description: 'A new action' }],
    }, now);

    expect(result.text).toContain('entry: 2026-05-08T11:00');
    expect(result.text).toContain('projects_created: [2026-05-08-new-proj]');
    expect(result.text).toContain('actions_created: [2026-05-08-new-act]');

    // Check the weekly file contains references to all entities
    const weekFile = join(tempDir, 'notes', '2026', '2026-05-04.md');
    const content = readFileSync(weekFile, 'utf-8');
    expect(content).toContain('existing-project');
    expect(content).toContain('2026-05-08-new-proj');
    expect(content).toContain('existing-action');
    expect(content).toContain('2026-05-08-new-act');
  });

  it('throws on invalid project reference', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    expect(() => cap(store, {
      content: 'Some content',
      projects: ['nonexistent-project'],
    }, now)).toThrow('Project "nonexistent-project" not found.');
  });

  it('throws on invalid action reference', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    expect(() => cap(store, {
      content: 'Some content',
      actions: ['nonexistent-action'],
    }, now)).toThrow('Action "nonexistent-action" not found.');
  });

  it('omits projects_created and actions_created lines when empty', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    const result = cap(store, {
      content: 'Simple entry with no new entities',
      projects: ['existing-project'],
      actions: ['existing-action'],
    }, now);

    expect(result.text).not.toContain('projects_created');
    expect(result.text).not.toContain('actions_created');
    expect(result.text).toContain('entry: 2026-05-08T11:00');
  });

  it('reflects new entry, project, and action in the same store synchronously', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    const result = cap(store, {
      content: 'Kickoff for the new effort',
      projects: [{ name: 'Fresh Proj', description: 'A fresh project' }],
      actions: [{ name: 'Fresh Action', description: 'A fresh action', scheduled: '2026-05-10T09:00' }],
    }, now);

    // Same store instance, no rebuild() and no watcher tick: everything is live.
    const [projectId] = result.createdProjectIds;
    const [actionId] = result.createdActionIds;
    expect(store.getProject(projectId)?.frontMatter.name).toBe('Fresh Proj');
    expect(store.getAction(actionId)?.frontMatter.scheduled).toBe('2026-05-10T09:00');
    expect(store.getEntries().some(e => e.meta.created === result.entryId)).toBe(true);
    // Indexes and derived relationships are live too.
    expect(store.getProjectIndex().find(i => i.id === projectId)?.description).toBe('A fresh project');
    expect(store.getActionIndex().find(i => i.id === actionId)?.description).toBe('A fresh action');
    expect(store.getActionsForProject(projectId)).toContain(actionId);
  });

  it('a later capture can reference an entity the previous one created (same store)', () => {
    const result = cap(store, {
      content: 'Stand up the project',
      projects: [{ name: 'Standup Proj', description: 'New project' }],
    }, new Date(2026, 4, 8, 9, 0));
    const [projectId] = result.createdProjectIds;

    // The reference resolves against the store, which the first capture updated.
    expect(() => cap(store, {
      content: 'Follow-up referencing it',
      projects: [projectId],
    }, new Date(2026, 4, 8, 9, 5))).not.toThrow();
  });

  it('creates project with related_projects', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    cap(store, {
      content: 'Related project work',
      projects: [{
        name: 'Related Proj',
        description: 'A related project',
        related_projects: [{ project: 'existing-project', description: 'parent project' }],
      }],
    }, now);

    const projFile = join(tempDir, 'projects', '2026', '2026-05-08-related-proj.md');
    const content = readFileSync(projFile, 'utf-8');
    expect(content).toContain('related_projects:');
    expect(content).toContain('project: existing-project');
    expect(content).toContain('description: parent project');
  });

  it('prepends new entry before existing entries', () => {
    const now = new Date(2026, 4, 6, 14, 30); // Same week as existing entry
    cap(store, {
      content: 'Newer entry',
    }, now);

    const weekFile = join(tempDir, 'notes', '2026', '2026-05-04.md');
    const content = readFileSync(weekFile, 'utf-8');
    // The new entry should appear before the existing entry
    const newerIdx = content.indexOf('Newer entry');
    const existingIdx = content.indexOf('Existing entry content');
    expect(newerIdx).toBeLessThan(existingIdx);
  });

  it('emits canonical spacing across repeated prepends', () => {
    const weekFile = join(tempDir, 'notes', '2026', '2026-05-04.md');
    // Several captures into the same week on one store — each updates it in-memory,
    // so the next capture sees the prior entries without a rebuild.
    for (let i = 0; i < 5; i++) {
      cap(store, { content: `Entry ${i}` }, new Date(2026, 4, 6, 10, i));
    }
    const content = readFileSync(weekFile, 'utf-8');
    // Exactly one blank line after the front matter, then the first entry's `---`
    // delimiter directly attached to its ```entry fence (no blank line between).
    expect(content).toMatch(/week_end: 2026-05-10\n---\n\n---\n```entry/);
    // No blank line ever sits between a `---` delimiter and its entry fence...
    expect(content).not.toMatch(/^---\n\n```entry/m);
    // ...and no run of 2+ blank lines anywhere.
    expect(content).not.toMatch(/\n[ \t]*\n[ \t]*\n/);
    // Every entry fence is preceded by exactly one `---` delimiter line: the
    // delimiter count equals the two front-matter fences plus one per entry.
    const fences = (content.match(/```entry/g) || []).length;
    const delimiters = (content.match(/^---$/gm) || []).length;
    expect(fences).toBe(6); // 5 new + 1 from beforeEach
    expect(delimiters).toBe(2 + fences); // 2 front-matter fences + 1 per entry
  });

  it('amend preserves the canonical delimiter on every entry', () => {
    // Prepend one entry, then amend the original — exercises the re-render path.
    cap(new Store(tempDir), { content: 'Second entry' }, new Date(2026, 4, 6, 14, 30));
    cap(new Store(tempDir), {
      id: '2026-05-04T10:00',
      content: 'Amended original',
    }, new Date(2026, 4, 6, 15, 0));

    const content = readFileSync(join(tempDir, 'notes', '2026', '2026-05-04.md'), 'utf-8');
    expect(content).toContain('Amended original');
    expect(content).not.toMatch(/^---\n\n```entry/m); // no blank between delimiter and fence
    expect(content).not.toMatch(/\n[ \t]*\n[ \t]*\n/);  // no blank-line runs
    const fences = (content.match(/```entry/g) || []).length;
    const delimiters = (content.match(/^---$/gm) || []).length;
    expect(delimiters).toBe(2 + fences); // 2 front-matter fences + 1 per entry, no doubles
  });

  it('separates consecutive entries with a blank line before the delimiter', () => {
    // Canonical inter-entry spacing: the
    // prior entry's content, one blank line, the `---` delimiter, then the fence.
    cap(new Store(tempDir), { content: 'Older body' }, new Date(2026, 4, 6, 9, 0));
    cap(new Store(tempDir), { content: 'Newer body' }, new Date(2026, 4, 6, 11, 0));

    const content = readFileSync(join(tempDir, 'notes', '2026', '2026-05-04.md'), 'utf-8');
    expect(content).toMatch(/Newer body\n\n---\n```entry/);
    expect(content).not.toMatch(/^---\n\n```entry/m); // delimiter stays tight to the fence
    expect(content).not.toMatch(/\n[ \t]*\n[ \t]*\n/);  // no 2-blank-line run
  });

  it('self-heals a legacy-format file (missing delimiters, padded separators)', () => {
    const weekFile = join(tempDir, 'notes', '2026', '2026-05-04.md');
    // Layout written by older buggy versions: a blank-line run after the front
    // matter, a top entry with no leading `---`, and blank-padded separators.
    writeFileSync(
      weekFile,
      '---\nweek: 19\nweek_start: 2026-05-04\nweek_end: 2026-05-10\n---\n\n\n\n\n```entry\n' +
        'created: 2026-05-04T10:00\n```\n\nOld top\n\n---\n\n```entry\n' +
        'created: 2026-05-04T08:00\n```\n\nOld bottom\n'
    );
    cap(new Store(tempDir), { content: 'Fresh' }, new Date(2026, 4, 6, 12, 0));

    // Every prior entry survives — none absorbed into the new one — and content is intact.
    const entries = new Store(tempDir).getEntries();
    expect(entries.map(e => e.meta.created)).toEqual([
      '2026-05-06T12:00',
      '2026-05-04T10:00',
      '2026-05-04T08:00',
    ]);
    expect(entries.find(e => e.meta.created === '2026-05-04T10:00')!.content).toBe('Old top');
    expect(entries.find(e => e.meta.created === '2026-05-04T08:00')!.content).toBe('Old bottom');

    // File is now canonical: no blank-line runs, delimiters tight, one `---` per entry.
    const content = readFileSync(weekFile, 'utf-8');
    expect(content).not.toMatch(/\n[ \t]*\n[ \t]*\n/);
    expect(content).not.toMatch(/^---\n\n```entry/m);
    const fences = (content.match(/```entry/g) || []).length;
    expect((content.match(/^---$/gm) || []).length).toBe(2 + fences);
  });

  it('preserves a bare --- in entry content through prepend and amend', () => {
    const weekFile = join(tempDir, 'notes', '2026', '2026-05-04.md');
    const withRule = 'Before the rule\n\n---\n\nAfter the rule';

    cap(new Store(tempDir), { content: withRule }, new Date(2026, 4, 6, 9, 0));
    // A later capture prepends and re-renders the rule-bearing entry.
    cap(new Store(tempDir), { content: 'Plain newer entry' }, new Date(2026, 4, 6, 11, 0));
    let entries = new Store(tempDir).getEntries();
    expect(entries.find(e => e.meta.created === '2026-05-06T09:00')!.content).toBe(withRule);

    // Amending an unrelated entry must not disturb the rule-bearing one.
    handleUpdateEntry(new Store(tempDir), { id: '2026-05-06T11:00', content: 'Amended newer' });
    entries = new Store(tempDir).getEntries();
    expect(entries.find(e => e.meta.created === '2026-05-06T09:00')!.content).toBe(withRule);
    expect(entries.find(e => e.meta.created === '2026-05-06T11:00')!.content).toBe('Amended newer');
    // The content's --- spawned no phantom entry: exactly the fixture + our two.
    expect(entries.map(e => e.meta.created).sort()).toEqual([
      '2026-05-04T10:00',
      '2026-05-06T09:00',
      '2026-05-06T11:00',
    ]);
  });

  it('rejects content that embeds the entry preamble, before any writes', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    // `---` directly followed by a ```entry fence is the one reserved sequence.
    const embedded = 'Documenting the format:\n\n---\n```entry\ncreated: 2020-01-01T00:00\n```\n\nfake';
    // Message both diagnoses the problem and tells the agent how to fix it.
    expect(() => cap(store, {
      content: embedded,
      projects: [{ name: 'Should Not Exist', description: 'x' }],
    }, now)).toThrow(/entry preamble[\s\S]*Hint:[\s\S]*try again/);
    // Fail-fast: the new project was not created before the throw.
    expect(existsSync(join(tempDir, 'projects', '2026', '2026-05-08-should-not-exist.md'))).toBe(false);

    // A bare horizontal rule (not followed by a fence) is still allowed.
    expect(() => cap(store, { content: 'fine\n\n---\n\nstill fine' }, now)).not.toThrow();
  });

  it('does not corrupt a CRLF weekly file when prepending', () => {
    const weekFile = join(tempDir, 'notes', '2026', '2026-05-04.md');
    writeFileSync(
      weekFile,
      '---\r\nweek: 19\r\nweek_start: 2026-05-04\r\nweek_end: 2026-05-10\r\n---\r\n\r\n---\r\n' +
        '```entry\r\ncreated: 2026-05-04T10:00\r\n```\r\n\r\nCRLF entry\r\n'
    );
    cap(new Store(tempDir), { content: 'New entry' }, new Date(2026, 4, 6, 12, 0));

    // Front matter is preserved (week still parses) rather than demoted into the body.
    const store = new Store(tempDir);
    expect(store.getEntries().map(e => e.meta.created)).toEqual(['2026-05-06T12:00', '2026-05-04T10:00']);
    expect(readFileSync(weekFile, 'utf-8')).toMatch(/^---\r?\nweek: 19/);
  });

  it('prepends entry to notes index', () => {
    const now = new Date(2026, 4, 6, 14, 30);
    cap(store, {
      content: 'Fresh content for index',
    }, now);

    const indexContent = readFileSync(join(tempDir, 'notes', '2026', 'index.yaml'), 'utf-8');
    // New entry should be at the top
    const newIdx = indexContent.indexOf('2026-05-06T14:30');
    const oldIdx = indexContent.indexOf('2026-05-04T10:00');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('indexes the authored description, not an excerpt of the content', () => {
    const now = new Date(2026, 4, 6, 14, 30);
    cap(store, {
      content: 'A long body that should not be the headline shown in the timeline index',
      description: 'Short authored headline',
    }, now);
    const item = store.getNoteIndex().find(i => i.id === '2026-05-06T14:30');
    expect(item?.description).toBe('Short authored headline');
  });

  it('omits metadata fields when no projects or actions', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    cap(store, {
      content: 'Bare entry',
    }, now);

    const weekFile = join(tempDir, 'notes', '2026', '2026-05-04.md');
    const content = readFileSync(weekFile, 'utf-8');
    // Find the new entry block
    const blocks = content.split('```entry');
    const newBlock = blocks.find(b => b.includes('2026-05-08T11:00'));
    expect(newBlock).toBeDefined();
    expect(newBlock).not.toContain('projects:');
    expect(newBlock).not.toContain('actions:');
  });

  it('increments timestamp on collision with existing entry', () => {
    // Use the same timestamp as the existing entry: 2026-05-04T10:00
    const now = new Date(2026, 4, 4, 10, 0);
    const result = cap(store, {
      content: 'Colliding entry',
    }, now);

    expect(result.text).toContain('entry: 2026-05-04T10:01');

    const weekFile = join(tempDir, 'notes', '2026', '2026-05-04.md');
    const content = readFileSync(weekFile, 'utf-8');
    expect(content).toContain('created: 2026-05-04T10:01');
    expect(content).toContain('Colliding entry');
  });

  it('escapes quotes in note index description', () => {
    const now = new Date(2026, 4, 8, 12, 0);
    cap(store, {
      content: 'A plain body',
      description: 'He said "hello" and it was: great',
    }, now);

    const indexContent = readFileSync(join(tempDir, 'notes', '2026', 'index.yaml'), 'utf-8');
    expect(indexContent).toContain('He said \\"hello\\" and it was');
    // Should still parse as valid YAML
    const parsed = parseYaml(indexContent);
    expect(Array.isArray(parsed)).toBe(true);
    const item = parsed.find((i: any) => i.id === '2026-05-08T12:00');
    expect(item).toBeDefined();
    expect(item.description).toContain('He said "hello"');
  });

  it('throws on a name with no letters or digits', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    expect(() => cap(store, {
      content: 'Content',
      projects: [{ name: '!!!', description: 'Bad name' }],
    }, now)).toThrow('Cannot derive ID from name');
  });

  it('throws on an emoji-only name', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    expect(() => cap(store, {
      content: 'Content',
      projects: [{ name: '🎉🚀', description: 'Bad name' }],
    }, now)).toThrow('Cannot derive ID from name');
  });

  it('throws on duplicate project ID', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    cap(store, {
      content: 'First',
      projects: [{ name: 'Unique Proj', description: 'First one' }],
    }, now);
    expect(() => cap(store, {
      content: 'Second',
      projects: [{ name: 'Unique Proj', description: 'Duplicate' }],
    }, now)).toThrow('already exists');
  });

  it('slugifies punctuation into single dashes without gluing or doubling', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    const today = '2026-05-08';
    cap(store, {
      content: 'Content',
      projects: [{ name: 'Buy eye + lower-face/teeth protection', description: 'desc' }],
    }, now);
    expect(existsSync(join(tempDir, 'projects', '2026', `${today}-buy-eye-lower-face-teeth-protection.md`))).toBe(true);
  });

  it('preserves accented Latin letters', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    const result = cap(store, { content: 'Content', projects: [{ name: 'Café résumé', description: 'desc' }] }, now);
    // Normalize both sides: accented letters survive, only punctuation/space become dashes.
    expect(result.text.normalize('NFC')).toContain('2026-05-08-café-résumé'.normalize('NFC'));
  });

  it('derives readable IDs from CJK names', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    const today = '2026-05-08';
    const cases: [string, string][] = [
      ['项目报告', `${today}-项目报告`],        // Chinese (Han) — run kept whole, no inner dashes
      ['会議メモ', `${today}-会議メモ`],          // Japanese (Kanji + Katakana)
      ['회의록', `${today}-회의록`],             // Korean (Hangul)
      ['Q3 報告', `${today}-q3-報告`],           // mixed ASCII + CJK, space -> dash
      ['Ｑ３テスト', `${today}-q3テスト`],        // fullwidth -> q3 (NFKC fold)
    ];
    for (const [name, expectedId] of cases) {
      const result = cap(store, { content: 'Content', projects: [{ name, description: 'desc' }] }, now);
      // Compare normalized so the assertion is independent of how the source literal
      // and the on-disk filename happen to be Unicode-normalized.
      expect(result.text.normalize('NFC')).toContain(expectedId.normalize('NFC'));
    }
  });

  it('round-trips a CJK-named project through an entry reference', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    const id = '2026-05-08-予算計画';
    cap(store, {
      content: 'Kicked off the budget plan',
      projects: [{ name: '予算計画', description: '予算' }],
    }, now);
    // Rebuild from disk and confirm the entry references the CJK id and the project resolves.
    const fresh = new Store(tempDir);
    const entry = fresh.getEntries().find(e => e.content.includes('budget plan'));
    expect(entry?.meta.projects).toContain(id);
    expect(fresh.getProject(id)).toBeDefined();
  });

  it('round-trips a non-CJK (Cyrillic) name through the store', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    const id = '2026-05-08-привет';
    cap(store, {
      content: 'Greeted in Russian',
      projects: [{ name: 'Привет', description: 'd' }],
    }, now);
    const fresh = new Store(tempDir);
    const entry = fresh.getEntries().find(e => e.content.includes('Russian'));
    expect(entry?.meta.projects).toContain(id);
    expect(fresh.getProject(id)).toBeDefined();
  });

  it('treats names differing only by case as the same ID', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    cap(store, { content: 'a', projects: [{ name: 'Road Map', description: 'd' }] }, now);
    expect(() => cap(store, {
      content: 'b',
      projects: [{ name: 'road map', description: 'd' }],
    }, now)).toThrow('already exists');
  });

  it('treats names differing only by Unicode normalization as the same ID', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    // Same text, two encodings: precomposed e-acute (NFC) vs 'e' + combining acute (NFD).
    const nfc = 'caf\u00e9';        // c, a, f, precomposed e-acute (NFC)
    const nfd = 'cafe\u0301';       // c, a, f, e, combining acute (NFD)
    expect(nfc).not.toBe(nfd);    // genuinely different code-unit sequences
    cap(store, { content: 'a', projects: [{ name: nfc, description: 'd' }] }, now);
    expect(() => cap(store, {
      content: 'b',
      projects: [{ name: nfd, description: 'd' }],
    }, now)).toThrow('already exists');
  });

  it('rejects two new projects in one call that derive the same ID, writing neither', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    expect(() => cap(store, {
      content: 'Content',
      projects: [
        { name: 'Eye + face', description: 'first' },
        { name: 'Eye face', description: 'collides' },
      ],
    }, now)).toThrow('derive the same ID');
    // Atomic: the first project must not have been left on disk.
    expect(existsSync(join(tempDir, 'projects', '2026', '2026-05-08-eye-face.md'))).toBe(false);
  });

  it('does not write a new project when a later action collides with an existing one', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    // Pre-create an action so the same-day slug collides.
    cap(store, {
      content: 'seed',
      actions: [{ name: 'Ship it', description: 'Ship the thing' }],
    }, now);
    expect(() => cap(store, {
      content: 'Content',
      projects: [{ name: 'Brand New Proj', description: 'desc' }],
      actions: [{ name: 'Ship it', description: 'Ship the thing' }],
    }, now)).toThrow('already exists');
    // The project derived before the colliding action must not have been written.
    expect(existsSync(join(tempDir, 'projects', '2026', '2026-05-08-brand-new-proj.md'))).toBe(false);
  });

  it('throws on dangling related_projects reference', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    expect(() => cap(store, {
      content: 'Content',
      projects: [{
        name: 'New Proj',
        description: 'desc',
        related_projects: [{ project: 'does-not-exist', description: 'broken ref' }],
      }],
    }, now)).toThrow('Related project "does-not-exist" not found');
  });

  it('quotes YAML indicator chars in descriptions', () => {
    const now = new Date(2026, 4, 8, 13, 0);
    cap(store, {
      content: '- list-like content',
      projects: [{ name: 'Dash Project', description: '- starts with dash' }],
    }, now);

    const indexContent = readFileSync(join(tempDir, 'projects', '2026', 'index.yaml'), 'utf-8');
    expect(indexContent).toContain('"- starts with dash"');
    const parsed = parseYaml(indexContent);
    expect(parsed.find((i: any) => i.description === '- starts with dash')).toBeDefined();
  });

  it('quotes scheduled and deadline values in action front matter', () => {
    const now = new Date(2026, 4, 8, 11, 0);
    cap(store, {
      content: 'Action with tricky dates',
      actions: [{
        name: 'Tricky Action',
        description: 'An action with tricky dates',
        scheduled: '2026-05-10T10:00',
        deadline: '2026-06-01',
      }],
    }, now);

    const actionFile = join(tempDir, 'actions', '2026', '2026-05-08-tricky-action.md');
    const content = readFileSync(actionFile, 'utf-8');
    const parsed = parseYaml(content.match(/^---\n([\s\S]*?)\n---/m)![1]);
    expect(parsed.scheduled).toBe('2026-05-10T10:00');
    expect(parsed.deadline).toBe('2026-06-01');
  });

  it('places weekly file in Monday year dir at year boundary', () => {
    // Jan 1 2025 is a Wednesday — Monday is Dec 30, 2024
    const now = new Date(2025, 0, 1, 10, 0);
    cap(store, {
      content: 'New year entry',
    }, now);

    // Should land in 2024 notes dir since the Monday is in 2024
    const weekFile = join(tempDir, 'notes', '2024', '2024-12-30.md');
    expect(existsSync(weekFile)).toBe(true);
  });

  // The synchronous in-memory updates must leave the store identical to what a
  // rebuild from disk produces — otherwise reads before/after the watcher's tick
  // would disagree. Exercises create, multi-entity, and amend in one go.
  it('the incremental store equals a rebuild from disk (parity)', () => {
    // Observable projection, order-normalized where consumers don't depend on it
    // (entity maps are keyed; index arrays are id→description lookups).
    const idxMap = (arr: { id: string; description: string }[]) =>
      Object.fromEntries(arr.map(i => [i.id, i.description]));
    const observable = (s: Store) => ({
      entries: s.getEntries(),
      projects: s.getProjectIds().sort().map(id => [id, s.getProject(id), s.getProjectFile(id)]),
      actions: s.getActionIds().sort().map(id => [id, s.getAction(id), s.getActionFile(id)]),
      noteIndex: idxMap(s.getNoteIndex()),
      projectIndex: idxMap(s.getProjectIndex()),
      actionIndex: idxMap(s.getActionIndex()),
      rels: s.getProjectIds().sort().map(id => [id, s.getActionsForProject(id).slice().sort()]),
      revRels: s.getActionIds().sort().map(id => [id, s.getProjectsForAction(id).slice().sort()]),
    });

    cap(store, {
      content: 'Spin up a workstream',
      projects: ['existing-project', { name: 'Net New', description: 'A brand-new project' }],
      actions: [{ name: 'Ship It', description: 'Ship the thing', scheduled: '2026-05-12T09:00', calendar: 'Work', deadline: '2026-05-20', body: '  trailing space body  ' }],
    }, new Date(2026, 4, 8, 9, 0));
    const created = cap(store, { content: 'Second note', actions: ['existing-action'] }, new Date(2026, 4, 8, 9, 5));
    // Amend the second entry — re-points its relationships.
    handleUpdateEntry(store, { id: created.entryId, content: 'Second note, amended', projects: ['existing-project'] });

    const incremental = observable(store);
    store.rebuild();
    const fromDisk = observable(store);
    expect(incremental).toEqual(fromDisk);
  });
});
