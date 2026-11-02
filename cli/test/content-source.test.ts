import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTextBlock } from './framed-output.js';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { resolveMarkdownSource } from '../src/mcp/tools/content-source.js';
import { handleUpdateAction, handleUpdateEntry, handleUpdateProject } from '../src/mcp/tools/update.js';
import { handleQueryActions, handleQueryEntries, handleQueryProjects } from '../src/mcp/tools/query.js';

const NOW = new Date(2026, 4, 6, 14, 30);

// Include directories as well as bytes, so failed preflight cannot leave a
// partly-created entity, index, or scaffold unnoticed.
function diskSnapshot(dir: string): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {};
  function visit(path: string, prefix: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        snapshot[name + '/'] = null;
        visit(join(path, entry.name), name + '/');
      } else {
        snapshot[name] = readFileSync(join(path, entry.name)).toString('base64');
      }
    }
  }
  visit(dir, '');
  return snapshot;
}

function memorySnapshot(store: Store): unknown {
  return JSON.parse(JSON.stringify({
    entries: store.getEntries(),
    projects: store.getProjectIds().sort().map(id => [id, store.getProject(id)]),
    actions: store.getActionIds().sort().map(id => [id, store.getAction(id)]),
    indexes: [store.getNoteIndex(), store.getProjectIndex(), store.getActionIndex()],
  }));
}

describe('Markdown file sources', () => {
  let root: string;
  let dataDir: string;
  let store: Store;
  let entryId: string;
  let projectId: string;
  let actionId: string;

  function draft(name: string, content: string | Buffer): string {
    const file = join(root, name);
    writeFileSync(file, content);
    return file;
  }

  function expectUnchanged(operation: () => unknown, message: RegExp): void {
    const disk = diskSnapshot(dataDir);
    const memory = memorySnapshot(store);
    expect(operation).toThrow(message);
    expect(diskSnapshot(dataDir)).toEqual(disk);
    expect(memorySnapshot(store)).toEqual(memory);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aside-content-source-'));
    dataDir = join(root, 'instance');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'aside.md'), '---\nname: Source test\ndescription: File imports\n---\n');
    store = new Store(dataDir);
    const created = handleCapture(store, {
      content: 'Original entry',
      description: 'Original entry summary',
      projects: [{ name: 'Original Project', description: 'Original project summary', body: 'Original project body' }],
      actions: [{ name: 'Original Action', description: 'Original action summary', body: 'Original action body' }],
    }, NOW);
    entryId = created.entryId;
    projectId = created.createdProjectIds[0];
    actionId = created.createdActionIds[0];
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('captures UTF-8 Markdown and nested file bodies without interpreting source metadata', () => {
    const markdown = '---\nname: Imported metadata\nresolution: cancelled\n---\n\n# Café ☕\n\n部署する\n\n- [ ] Run the checks\n';
    const source = draft('draft with spaces.md', markdown);
    const result = handleCapture(store, {
      content_file: source,
      description: 'File capture',
      projects: [{ name: 'File Project', description: 'Structured project summary', body_file: source }],
      actions: [{ name: 'File Action', description: 'Structured action summary', body_file: source, scheduled: '2026-05-07T09:00' }],
    }, NOW);
    const newProjectId = result.createdProjectIds[0];
    const newActionId = result.createdActionIds[0];

    expect(store.getEntries().find(e => e.meta.created === result.entryId)?.content).toBe(markdown.trim());
    expect(store.getProject(newProjectId)?.body).toBe(markdown.trim());
    expect(store.getAction(newActionId)?.body).toBe(markdown.trim());
    expect(store.getProject(newProjectId)?.frontMatter.name).toBe('File Project');
    expect(store.getAction(newActionId)?.frontMatter).toMatchObject({ name: 'File Action', scheduled: '2026-05-07T09:00' });
    expect(store.getAction(newActionId)?.frontMatter.resolution).toBeUndefined();
    expect(readTextBlock(handleQueryEntries(store, { ids: [result.entryId], detail: 'full' }))).toBe(markdown.trim());
    expect(readTextBlock(handleQueryProjects(store, { ids: [newProjectId], detail: 'full' }))).toBe(markdown.trim());
    expect(readTextBlock(handleQueryActions(store, { ids: [newActionId], detail: 'full' }))).toBe(markdown.trim());
    expect(memorySnapshot(new Store(dataDir))).toEqual(memorySnapshot(store));
    expect(readFileSync(source, 'utf-8')).toBe(markdown);
  });

  it('replaces entry, action, and project text from files and exposes fresh results immediately', () => {
    const source = draft('replacement.md', '# Replacement\n\nA new plan — from disk.\n');
    handleUpdateEntry(store, { id: entryId, content_file: source, description: 'Updated entry summary' });
    handleUpdateAction(store, { id: actionId, body_file: source, scheduled: '2026-05-08T11:00', description: 'Updated action summary' });
    handleUpdateProject(store, { id: projectId, body_file: source, ended: '2026-05-08T12:00', description: 'Updated project summary' });

    const text = '# Replacement\n\nA new plan — from disk.';
    const queries = [
      handleQueryEntries(store, { ids: [entryId], detail: 'full' }),
      handleQueryActions(store, { ids: [actionId], detail: 'full' }),
      handleQueryProjects(store, { ids: [projectId], detail: 'full' }),
    ];
    for (const query of queries) {
      expect(readTextBlock(query)).toBe(text);
      expect(query).not.toMatch(/Original (?:entry|action body|project body)/);
    }
    expect(store.getAction(actionId)?.frontMatter.scheduled).toBe('2026-05-08T11:00');
    expect(store.getProject(projectId)?.frontMatter.ended).toBe('2026-05-08T12:00');
    expect(memorySnapshot(new Store(dataDir))).toEqual(memorySnapshot(store));
  });

  it('creates nested entities from files during an entry update while preserving omitted content', () => {
    const source = draft('nested.md', 'Nested context');
    const result = handleUpdateEntry(store, {
      id: entryId,
      projects: [{ name: 'Update Project', description: 'New project', body_file: source }],
      actions: [{ name: 'Update Action', description: 'New action', body_file: source }],
    }, NOW);
    const entry = store.getEntries().find(e => e.meta.created === entryId)!;
    expect(entry.content).toBe('Original entry');
    expect(entry.meta.projects).toEqual(result.createdProjectIds);
    expect(entry.meta.actions).toEqual(result.createdActionIds);
    expect(store.getProject(result.createdProjectIds[0])?.body).toBe('Nested context');
    expect(store.getAction(result.createdActionIds[0])?.body).toBe('Nested context');
    expect(memorySnapshot(new Store(dataDir))).toEqual(memorySnapshot(store));
  });

  it('preserves omitted text and clears text when a provided source file is empty', () => {
    handleUpdateEntry(store, { id: entryId, description: 'Entry summary only' });
    handleUpdateAction(store, { id: actionId, description: 'Action summary only' });
    handleUpdateProject(store, { id: projectId, description: 'Project summary only' });
    expect(store.getEntries().find(e => e.meta.created === entryId)?.content).toBe('Original entry');
    expect(store.getAction(actionId)?.body).toBe('Original action body');
    expect(store.getProject(projectId)?.body).toBe('Original project body');

    const empty = draft('empty.md', '');
    handleUpdateEntry(store, { id: entryId, content_file: empty });
    handleUpdateAction(store, { id: actionId, body_file: empty });
    handleUpdateProject(store, { id: projectId, body_file: empty });
    const captured = handleCapture(store, { content_file: empty, description: 'Empty entry' }, NOW);
    expect(store.getEntries().find(e => e.meta.created === entryId)?.content).toBe('');
    expect(store.getEntries().find(e => e.meta.created === captured.entryId)?.content).toBe('');
    expect(store.getAction(actionId)?.body).toBe('');
    expect(store.getProject(projectId)?.body).toBe('');
    expect(memorySnapshot(new Store(dataDir))).toEqual(memorySnapshot(store));
  });

  it.each(['', 'same text'])('rejects simultaneous inline and file fields, including inline %j, before any edits', (inline) => {
    const source = draft('matching.md', inline);
    expectUnchanged(() => handleCapture(store, {
      content: inline, content_file: source, description: 'Rejected',
      projects: [{ name: 'Orphan Project', description: 'Must not exist' }],
    }, NOW), /Provide either content or content_file, not both/);
    expectUnchanged(() => handleUpdateEntry(store, {
      id: entryId, content: inline, content_file: source, description: 'Rejected',
      actions: [{ name: 'Orphan Action', description: 'Must not exist' }],
    }, NOW), /Provide either content or content_file, not both/);
    expectUnchanged(() => handleUpdateAction(store, {
      id: actionId, body: inline, body_file: source, scheduled: '2026-05-09T09:00', description: 'Rejected',
    }), /Provide either body or body_file, not both/);
    expectUnchanged(() => handleUpdateProject(store, {
      id: projectId, body: inline, body_file: source, ended: '2026-05-09T09:00', description: 'Rejected',
    }), /Provide either body or body_file, not both/);
  });

  it('requires a capture source before creating nested entities', () => {
    expectUnchanged(() => handleCapture(store, {
      description: 'Rejected',
      projects: [{ name: 'Orphan Project', description: 'Must not exist' }],
      actions: [{ name: 'Orphan Action', description: 'Must not exist' }],
    }, NOW), /Provide either content or content_file/);
  });

  it.each(['capture', 'update_entry'])('preflights later nested sources in %s before creating any entities', (tool) => {
    const source = draft('good.md', 'Valid draft');
    const args = {
      content_file: source,
      description: 'Rejected',
      projects: [{ name: 'Good Project', description: 'Must not exist', body_file: source }],
      actions: [
        { name: 'Good Action', description: 'Must not exist', body_file: source },
        { name: 'Bad Action', description: 'Missing source', body_file: join(root, 'missing.md') },
      ],
    };
    expectUnchanged(() => tool === 'capture'
      ? handleCapture(store, args, NOW)
      : handleUpdateEntry(store, { id: entryId, ...args }, NOW), /body_file/);
  });

  it.each(['capture', 'update_entry'])('rejects nested empty-string/file conflicts in %s before creating earlier entities', (tool) => {
    const source = draft('empty.md', '');
    const args = {
      content: 'Valid entry',
      description: 'Rejected',
      projects: [
        { name: 'Good Project', description: 'Must not exist', body_file: source },
        { name: 'Bad Project', description: 'Conflicting sources', body: '', body_file: source },
      ],
      actions: [{ name: 'Bad Action', description: 'Conflicting sources', body: '', body_file: source }],
    };
    expectUnchanged(() => tool === 'capture'
      ? handleCapture(store, args, NOW)
      : handleUpdateEntry(store, { id: entryId, ...args }, NOW), /Provide either body or body_file, not both/);
  });

  it.each(['capture', 'update_entry'])('validates entry content loaded from a file before nested writes in %s', (tool) => {
    const source = draft('invalid-entry.md', 'Draft\n\n---\n```entry\ncreated: 2026-05-06T16:00\n```\n\nPhantom entry');
    const args = {
      content_file: source,
      description: 'Rejected',
      projects: [{ name: 'Orphan Project', description: 'Must not exist' }],
      actions: [{ name: 'Orphan Action', description: 'Must not exist' }],
    };
    expectUnchanged(() => tool === 'capture'
      ? handleCapture(store, args, NOW)
      : handleUpdateEntry(store, { id: entryId, ...args }, NOW), /entry preamble/);
  });

  it('does not apply metadata or index patches when an update source cannot be read', () => {
    const missing = join(root, 'missing.md');
    expectUnchanged(() => handleUpdateAction(store, {
      id: actionId, body_file: missing, scheduled: '2026-05-09T09:00', description: 'Rejected',
    }), /body_file/);
    expectUnchanged(() => handleUpdateProject(store, {
      id: projectId, body_file: missing, ended: '2026-05-09T09:00', description: 'Rejected',
    }), /body_file/);
    expectUnchanged(() => handleUpdateEntry(store, {
      id: entryId, content_file: missing, description: 'Rejected',
      projects: [{ name: 'Orphan Project', description: 'Must not exist' }],
    }, NOW), /content_file/);
  });

  it('rejects relative paths, missing files, directories, and malformed UTF-8', () => {
    const malformed = draft('invalid-utf8.md', Buffer.from([0xc3, 0x28]));
    expect(() => resolveMarkdownSource(undefined, 'relative.md', 'content')).toThrow(/content_file must be an absolute path/);
    expect(() => resolveMarkdownSource(undefined, join(root, 'missing.md'), 'body')).toThrow(/body_file/);
    expect(() => resolveMarkdownSource(undefined, root, 'body')).toThrow(/regular file/);
    expect(() => resolveMarkdownSource(undefined, malformed, 'content')).toThrow(/utf-8/i);
  });
});
