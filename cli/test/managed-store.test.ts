import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/mcp/store.js';

let base: string, root: string, store: Store;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aside-managed-store-'));
  root = join(base, 'instance');
  mkdirSync(root);
  writeFileSync(join(root, 'aside.md'), '---\nid: managed-test\n---\n');
  vi.stubEnv('ASIDE_DAEMON_HOME', join(base, 'state'));
  store = new Store(root);
});
afterEach(() => { store.close(); vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

const id = '2026-10-14-record';
const frontMatter = { name: 'Record', created: '2026-10-14T12:00:00' };
function save(kind: string, path: string): void {
  if (kind === 'projects') store.saveProject(id, frontMatter, 'new body', path);
  else if (kind === 'actions') store.saveAction(id, frontMatter, 'new body', path);
  else if (kind === 'artifacts') store.saveArtifact(id, frontMatter, 'new body', path);
  else store.saveEntry(frontMatter.created, [], [], 'new body', path,
    '---\nweek: 42\nweek_start: 2026-10-12\nweek_end: 2026-10-18\n---\n\n```entry\ncreated: 2026-10-14T12:00:00\n```\n\nnew body\n');
}

describe('managed Store writes', () => {
  it('watches edits through a selected instance root alias', async () => {
    const file = join(root, 'projects', '2026', `${id}.md`);
    save('projects', file);
    store.close();
    const alias = join(base, 'selected-instance');
    symlinkSync(root, alias);
    store = new Store(alias);
    store.watch();
    await new Promise<void>(resolve => store['watcher']!.once('ready', resolve));
    writeFileSync(file, readFileSync(file, 'utf8').replace('new body', 'external edit'));
    await vi.waitFor(() => expect(store.getProject(id)?.body).toContain('external edit'), { timeout: 3000 });
    expect(store.getDataDir()).toBe(alias);
  });

  it.each(['', 'notes', join('notes', '2026')])('watches records created between scanning and watching %j', async gap => {
    const canonicalRoot = realpathSync(root);
    const directory = join(canonicalRoot, gap);
    mkdirSync(directory, { recursive: true });
    const file = join(canonicalRoot, 'notes', '2026', '2026-10-12.md');
    store.watch();
    const watcher = store['watcher']!;
    const handler = (watcher as unknown as {
      _nodeFsHandler: { _watchWithNodeFs(path: string, ...args: unknown[]): unknown };
    })._nodeFsHandler;
    const original = handler._watchWithNodeFs;
    let injected = false;
    const watch = vi.spyOn(handler, '_watchWithNodeFs').mockImplementation((path, ...args) => {
      if (path === directory && !injected) {
        injected = true;
        save('notes', file);
      }
      return original.call(handler, path, ...args);
    });
    try {
      await new Promise<void>(resolve => watcher.once('ready', resolve));
      expect(injected).toBe(true);
      await vi.waitFor(() => expect(watch.mock.calls.some(([path]) => path === file)).toBe(true), { timeout: 3000 });
      writeFileSync(file, readFileSync(file, 'utf8').replace('new body', 'external edit'));
      await vi.waitFor(() => expect(store.getEntries()[0]?.content).toContain('external edit'), { timeout: 3000 });
    } finally { watch.mockRestore(); }
  }, 15_000);

  it('watches collection, manifest, and index case aliases on case-insensitive filesystems', async ({ skip }) => {
    if (!existsSync(join(root, 'ASIDE.MD'))) skip();
    const originalFile = join(root, 'projects', '2026', `${id}.md`);
    save('projects', originalFile);
    store.addIndexEntry('projects', originalFile, id, 'original description');
    store.close();
    renameSync(join(root, 'projects'), join(root, 'Projects'));
    renameSync(join(root, 'aside.md'), join(root, 'ASIDE.MD'));
    const year = join(root, 'Projects', '2026');
    renameSync(join(year, 'index.yaml'), join(year, 'INDEX.YAML'));
    store = new Store(root);
    expect(store.getProject(id)?.body).toBe('new body');
    expect(store.getIndexDescription('projects', id)).toBe('original description');
    const rebuild = vi.spyOn(store, 'rebuild');
    store.watch();
    await new Promise<void>(resolve => store['watcher']!.once('ready', resolve));
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledOnce());

    const file = join(year, `${id}.md`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('new body', 'case alias edit'));
    await vi.waitFor(() => expect(store.getProject(id)?.body).toBe('case alias edit'), { timeout: 3000 });

    writeFileSync(join(year, 'INDEX.YAML'), `- id: ${id}\n  description: changed description\n`);
    await vi.waitFor(() => expect(store.getIndexDescription('projects', id)).toBe('changed description'), { timeout: 3000 });

    writeFileSync(join(root, 'ASIDE.MD'), '---\nid: managed-test\nname: Changed manifest\n---\n');
    await vi.waitFor(() => expect(store.getManifest().name).toBe('Changed manifest'), { timeout: 3000 });
  });

  it('watches managed records without traversing or rebuilding for unrelated user files', async () => {
    const file = join(root, 'projects', '2026', `${id}.md`);
    save('projects', file);
    const userDirectories = [
      join(root, 'my files', 'nested'),
      join(root, 'projects', 'archive'),
      join(root, 'projects', '2026', 'support'),
    ];
    for (const directory of userDirectories) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'notes.md'), 'user content');
    }
    const rebuild = vi.spyOn(store, 'rebuild');
    store.watch();
    await new Promise<void>(resolve => store['watcher']!.once('ready', resolve));
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalledOnce());
    rebuild.mockClear();

    const watched = Object.keys(store['watcher']!.getWatched());
    for (const directory of userDirectories) expect(watched).not.toContain(realpathSync(directory));
    for (const directory of userDirectories) writeFileSync(join(directory, 'notes.md'), 'user edit');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(rebuild).not.toHaveBeenCalled();

    writeFileSync(file, readFileSync(file, 'utf8').replace('new body', 'managed edit'));
    await vi.waitFor(() => expect(store.getProject(id)?.body).toContain('managed edit'), { timeout: 3000 });
    expect(rebuild).toHaveBeenCalled();
  });

  it.each(['projects', 'actions', 'artifacts', 'notes'])('rejects a %s record symlink before serializing or writing', kind => {
    const directory = join(root, kind, '2026');
    mkdirSync(directory, { recursive: true });
    const target = join(base, 'outside.md'), file = join(directory, `${id}.md`);
    writeFileSync(target, 'private outside contents');
    symlinkSync(target, file);
    expect(() => save(kind, file)).toThrow(/symlink/i);
    expect(readFileSync(target, 'utf8')).toBe('private outside contents');
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it.each(['projects', 'actions', 'artifacts', 'notes'])('rejects a %s parent symlink before creating year directories', kind => {
    const target = join(base, 'outside');
    mkdirSync(target);
    symlinkSync(target, join(root, kind));
    expect(() => save(kind, join(root, kind, '2026', `${id}.md`))).toThrow(/symlink/i);
    expect(existsSync(join(target, '2026'))).toBe(false);
  });

  it('rejects an in-instance symlink and a dangling destination', () => {
    const directory = join(root, 'projects', '2026');
    mkdirSync(directory, { recursive: true });
    const target = join(root, 'target.md'), file = join(directory, `${id}.md`);
    writeFileSync(target, 'same instance');
    symlinkSync(target, file);
    expect(() => save('projects', file)).toThrow(/symlink/i);
    rmSync(file); rmSync(target); symlinkSync(target, file);
    expect(() => save('projects', file)).toThrow(/symlink/i);
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it('rejects index replacement after loading without changing its target or cached description', () => {
    const directory = join(root, 'projects', '2026'), file = join(directory, `${id}.md`);
    save('projects', file);
    store.addIndexEntry('projects', file, id, 'original');
    const index = join(directory, 'index.yaml'), outside = join(base, 'outside-index.yaml');
    const original = readFileSync(index, 'utf8');
    writeFileSync(outside, original);
    rmSync(index); symlinkSync(outside, index);
    expect(() => store.setIndexEntry('projects', id, 'replacement')).toThrow(/symlink/i);
    expect(() => store.addIndexEntry('projects', file, 'another', 'addition')).toThrow(/symlink/i);
    expect(readFileSync(outside, 'utf8')).toBe(original);
    expect(store.getIndexDescription('projects', id)).toBe('original');
  });
});
