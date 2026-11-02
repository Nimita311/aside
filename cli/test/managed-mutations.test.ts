import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateAction, handleUpdateEntry, handleUpdateProject } from '../src/mcp/tools/update.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';
import { handleUpdateOccurrence } from '../src/mcp/tools/recurrence.js';
import { writeFileCrashSafe } from '../src/mcp/tools/index-file.js';
import { MutationWriteError } from '../src/mcp/tools/mutation-result.js';

describe('managed mutation paths', () => {
  let directory: string;
  let dataDir: string;
  let store: Store;
  const now = new Date(2026, 4, 6, 14, 30);
  const projectId = '2026-05-06-project';
  const actionId = '2026-05-06-action';
  const week = 'notes/2026/2026-05-04.md';
  const capture = () => handleCapture(store, { content: 'Captured content', description: 'Note',
    projects: [{ name: 'Project', description: 'Project' }], actions: [{ name: 'Action', description: 'Action' }] }, now);

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aside-managed-mutations-'));
    dataDir = join(directory, 'instance');
    init(dataDir, { name: 'Managed files', description: 'Fixture' });
    store = new Store(dataDir);
  });
  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function expectRejectedBeforeWrites(action: () => unknown): void {
    let error: unknown;
    try { action(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(MutationWriteError);
    expect((error as Error).message).toMatch(/Symlinks are not allowed/);
    expect((error as MutationWriteError).partialResult.changes).toEqual([]);
  }

  const capturePaths = [
    ['notes', 'directory'], ['notes/2026', 'directory'], [week, 'file'], ['notes/2026/index.yaml', 'file'],
    ['projects', 'directory'], ['projects/2026', 'directory'], [`projects/2026/${projectId}.md`, 'file'], ['projects/2026/index.yaml', 'file'],
    ['actions', 'directory'], ['actions/2026', 'directory'], [`actions/2026/${actionId}.md`, 'file'], ['actions/2026/index.yaml', 'file'],
  ] as const;

  for (const location of ['inside', 'outside', 'dangling'] as const) {
    it.each(capturePaths)(`rejects a ${location} symlink at %s before capture creates any records`, (relativePath, kind) => {
      const target = join(location === 'inside' ? dataDir : directory, 'reference');
      if (location !== 'dangling') {
        if (kind === 'directory') mkdirSync(target);
        else writeFileSync(target, 'Referenced content must stay untouched.');
      }
      const link = join(dataDir, relativePath);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
      expectRejectedBeforeWrites(capture);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      if (location === 'dangling') expect(existsSync(target)).toBe(false);
      else if (kind === 'directory') expect(readdirSync(target)).toEqual([]);
      else expect(readFileSync(target, 'utf8')).toBe('Referenced content must stay untouched.');
      expect(store.getProjectIds()).toEqual([]);
      expect(store.getActionIds()).toEqual([]);
      expect(store.getEntries()).toEqual([]);
    });
  }

  it.each(['project', 'action', 'entry'] as const)('rejects a replaced cached %s file before updating or creating links', kind => {
    const created = capture();
    const relativePath = kind === 'project' ? `projects/2026/${projectId}.md` : kind === 'action' ? `actions/2026/${actionId}.md` : week;
    const file = join(dataDir, relativePath);
    const original = readFileSync(file, 'utf8');
    const target = join(directory, 'reference.md');
    writeFileSync(target, original);
    rmSync(file);
    symlinkSync(target, file);
    const update = () => kind === 'project' ? handleUpdateProject(store, { id: projectId, body: 'Replacement', description: 'Changed' })
      : kind === 'action' ? handleUpdateAction(store, { id: actionId, body: 'Replacement', description: 'Changed' })
      : handleUpdateEntry(store, { id: created.entryId, content: 'Replacement', projects: [{ name: 'Orphan', description: 'Must not be created' }] }, now);
    expectRejectedBeforeWrites(update);
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(store.getProjectIds()).toEqual([projectId]);
  });

  it.each(['projects', 'actions', 'notes'] as const)('rejects a replaced %s index before changing the record body', kind => {
    const created = capture();
    const record = join(dataDir, kind === 'projects' ? `projects/2026/${projectId}.md` : kind === 'actions' ? `actions/2026/${actionId}.md` : week);
    const original = readFileSync(record, 'utf8');
    const index = join(dataDir, kind, '2026', 'index.yaml');
    const target = join(directory, 'reference.yaml');
    const originalIndex = readFileSync(index, 'utf8');
    writeFileSync(target, originalIndex);
    rmSync(index);
    symlinkSync(target, index);
    const update = () => kind === 'projects' ? handleUpdateProject(store, { id: projectId, body: 'Replacement', description: 'Changed' })
      : kind === 'actions' ? handleUpdateAction(store, { id: actionId, body: 'Replacement', description: 'Changed' })
      : handleUpdateEntry(store, { id: created.entryId, content: 'Replacement', description: 'Changed' });
    expectRejectedBeforeWrites(update);
    expect(readFileSync(record, 'utf8')).toBe(original);
    expect(readFileSync(target, 'utf8')).toBe(originalIndex);
  });

  it('rejects a manifest replaced with a symlink after the instance was loaded', () => {
    const manifest = join(dataDir, 'aside.md');
    const original = readFileSync(manifest, 'utf8');
    const target = join(directory, 'reference.md');
    writeFileSync(target, original);
    rmSync(manifest);
    symlinkSync(target, manifest);
    expectRejectedBeforeWrites(() => handleUpdateInstance(store, { body: 'Replacement' }));
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it.each(['inside', 'outside', 'dangling'] as const)('rejects a %s index symlink before materializing an occurrence', location => {
    const template = handleCapture(store, { content: 'Routine', description: 'Routine', actions: [
      { name: 'Routine', description: 'Routine', recurrence: [{ dtstart: '2026-05-06', rrule: 'FREQ=DAILY;COUNT=2' }] },
    ] }, now).createdActionIds[0];
    const index = join(dataDir, 'actions', '2026', 'index.yaml');
    const original = readFileSync(index, 'utf8');
    const target = join(location === 'inside' ? dataDir : directory, 'reference.yaml');
    if (location !== 'dangling') writeFileSync(target, original);
    rmSync(index);
    symlinkSync(target, index);

    expectRejectedBeforeWrites(() => handleUpdateOccurrence(store, {
      template, original: '2026-05-06', name: 'Edited occurrence', description: 'Edited occurrence',
    }, now));
    expect(store.getActionIds()).toEqual([template]);
    expect(readdirSync(dirname(index)).sort()).toEqual([`${template}.md`, 'index.yaml']);
    expect(lstatSync(index).isSymbolicLink()).toBe(true);
    if (location === 'dangling') expect(existsSync(target)).toBe(false);
    else expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('rejects a symlinked occurrence candidate instead of skipping it as an ID collision', () => {
    const template = handleCapture(store, { content: 'Routine', description: 'Routine', actions: [
      { name: 'Routine', description: 'Routine', recurrence: [{ dtstart: '2026-05-06', rrule: 'FREQ=DAILY;COUNT=2' }] },
    ] }, now).createdActionIds[0];
    const candidate = join(dataDir, 'actions', '2026', '2026-05-06-edited-occurrence.md');
    const target = join(directory, 'reference.md');
    writeFileSync(target, 'Preserve the source.');
    symlinkSync(target, candidate);

    expectRejectedBeforeWrites(() => handleUpdateOccurrence(store, {
      template, original: '2026-05-06', name: 'Edited occurrence',
    }, now));
    expect(store.getActionIds()).toEqual([template]);
    expect(existsSync(join(dirname(candidate), '2026-05-06-edited-occurrence-2.md'))).toBe(false);
    expect(lstatSync(candidate).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('Preserve the source.');
  });

  it('accepts symlinked external Markdown input for capture and updates', () => {
    const source = join(directory, 'source.md');
    const link = join(directory, 'source-link.md');
    writeFileSync(source, 'Explicitly selected external content.');
    symlinkSync(source, link);
    const captured = handleCapture(store, { content_file: link, description: 'Note',
      projects: [{ name: 'Project', description: 'Project', body_file: link }] }, now);
    expect(readFileSync(join(dataDir, week), 'utf8')).toContain('Explicitly selected external content.');
    expect(readFileSync(join(dataDir, `projects/2026/${projectId}.md`), 'utf8')).toContain('Explicitly selected external content.');
    writeFileSync(source, 'Updated external content.');
    handleUpdateProject(store, { id: projectId, body_file: link });
    handleUpdateEntry(store, { id: captured.entryId, content_file: link });
    expect(readFileSync(join(dataDir, week), 'utf8')).toContain('Updated external content.');
    expect(readFileSync(join(dataDir, `projects/2026/${projectId}.md`), 'utf8')).toContain('Updated external content.');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('allows a user-selected instance root alias', () => {
    const actual = join(directory, 'actual');
    const alias = join(directory, 'alias');
    mkdirSync(actual);
    symlinkSync(actual, alias);
    expect(init(alias, { name: 'Alias', description: 'Fixture', tutorial: true }).created.length).toBe(9);
    expect(readFileSync(join(actual, 'aside.md'), 'utf8')).toContain('name: Alias');
  });

  it('initializes a relative instance path', () => {
    const fresh = join(directory, 'relative');
    const result = init(relative(process.cwd(), fresh), { name: 'Relative', description: 'Fixture', tutorial: true });
    expect(result.dataDir).toBe(fresh);
    expect(readFileSync(join(fresh, 'aside.md'), 'utf8')).toContain('name: Relative');
  });

  it('does not follow a managed directory introduced during initialization', () => {
    const target = join(directory, 'external');
    const fresh = join(directory, 'fresh');
    mkdirSync(target);
    expect(() => init(fresh, { name: 'Fixture', description: 'Fixture', tutorial: true }, name => {
      if (name === 'aside.md') symlinkSync(target, join(fresh, 'projects'));
    })).toThrow(/Symlinks are not allowed/);
    expect(readdirSync(target)).toEqual([]);
  });

  it('never overwrites or removes a preexisting temporary-file symlink', () => {
    const target = join(directory, 'external');
    writeFileSync(target, 'Keep external content.');
    vi.spyOn(Date, 'now').mockReturnValue(1);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const temp = join(dataDir, `.1-${(0.5).toString(36).slice(2)}.tmp`);
    symlinkSync(target, temp);
    expect(() => writeFileCrashSafe(join(dataDir, 'aside.md'), 'Replacement', dataDir)).toThrow(/EEXIST/);
    expect(readFileSync(target, 'utf8')).toBe('Keep external content.');
    expect(lstatSync(temp).isSymbolicLink()).toBe(true);
  });
});
