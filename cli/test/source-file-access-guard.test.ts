import {sourceFileAccessGuard as guard} from './support/source-file-access-guard.js';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs, {closeSync, copyFileSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import promises, {readFile} from 'node:fs/promises';
import bareFs from 'fs';
import barePromises from 'fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

let root: string, source: string, sibling: string, attachment: string;
beforeEach(() => {
  root = mkdtempSync('/private/tmp/aside-source-access-');
  mkdirSync(join(root, 'projects', '2026'), {recursive: true});
  mkdirSync(join(root, 'artifacts', '2026', '2026-10-30-report'), {recursive: true});
  source = join(root, 'projects', '2026', '2026-10-30-project.md');
  sibling = join(root, 'projects', '2026', '2026-10-30-sibling.md');
  attachment = join(root, 'artifacts', '2026', '2026-10-30-report', 'report.txt');
  for (const path of [source, sibling, attachment, join(root, 'aside.md'), join(root, '.aside')]) writeFileSync(path, 'Published bytes');
});
afterEach(() => {guard.reset(); rmSync(root, {recursive: true, force: true});});

describe('shared source-file access guard', () => {
  it('intercepts imports captured before activation and records swallowed violations', () => {
    guard.protect([root]);
    try {readFileSync(source);} catch {}
    expect(guard.violations).toEqual([{method: 'readFile', operation: 'read', path: source}]);
    expect(() => fs.readFileSync(source)).toThrow('Lifecycle ownership violation');
    guard.reset();
    expect(readFileSync(source, 'utf8')).toBe('Published bytes');
  });

  it('protects metadata, config and source directory enumeration while allowing root canonicalization', () => {
    guard.protect([root]);
    for (const path of [source, join(root, 'aside.md'), join(root, '.aside')]) expect(() => statSync(path)).toThrow('Lifecycle ownership violation');
    expect(() => readdirSync(join(root, 'projects'))).toThrow('Lifecycle ownership violation');
    expect(() => readdirSync(root)).toThrow('Lifecycle ownership violation');
    expect(fs.realpathSync(root)).toBe(root);
    expect(fs.realpathSync.native(root)).toBe(root);
    expect(statSync(root).isDirectory()).toBe(true);
  });

  it('covers callbacks and every promises entry point, including URL and Buffer paths', async () => {
    guard.protect([root]);
    await expect(new Promise((resolve, reject) => fs.readFile(source, (error, value) => error ? reject(error) : resolve(value)))).rejects.toThrow('Lifecycle ownership violation');
    await expect(readFile(pathToFileURL(source))).rejects.toThrow('Lifecycle ownership violation');
    await expect(promises.readFile(Buffer.from(source))).rejects.toThrow('Lifecycle ownership violation');
    await expect(fs.promises.readFile(source)).rejects.toThrow('Lifecycle ownership violation');
    expect(guard.violations).toHaveLength(4);
  });

  it('covers both bare and node-prefixed filesystem imports', async () => {
    guard.protect([root]);
    expect(() => bareFs.readFileSync(source)).toThrow('Lifecycle ownership violation');
    await expect(barePromises.readFile(source)).rejects.toThrow('Lifecycle ownership violation');
    expect(guard.violations).toHaveLength(2);
  });

  it('keeps watch permissions separate from read permissions', async () => {
    guard.protect([root]);
    expect(() => promises.watch(source)).toThrow('attempted to watch');
    expect(() => fs.watch(source)).toThrow('attempted to watch');
    guard.allow({paths: [source], operations: ['read'], reason: 'Explicit byte read only'}, () => {
      expect(() => promises.watch(source)).toThrow('attempted to watch');
    });
    const watcher = guard.allow({paths: [source], operations: ['watch'], reason: 'Lifecycle source watcher'}, () => promises.watch(source));
    expect(typeof watcher[Symbol.asyncIterator]).toBe('function');
    await watcher.return?.();
    expect(() => promises.watch(source)).toThrow('attempted to watch');
  });

  it('checks cwd-relative glob enumeration and iterators created before activation', async () => {
    const earlier = promises.glob('projects/**/*.md', {cwd: root}), earlierWatch = promises.watch(source);
    guard.protect([root]);
    expect(() => promises.glob('projects/**/*.md', {cwd: root})).toThrow('Lifecycle ownership violation');
    expect(() => fs.globSync('**/*.md', {cwd: root})).toThrow('Lifecycle ownership violation');
    expect(() => promises.glob([join(root, 'projects', '*')])).toThrow('Lifecycle ownership violation');
    await expect(earlier.next()).rejects.toThrow('Lifecycle ownership violation');
    await expect(earlierWatch.next()).rejects.toThrow('Lifecycle ownership violation');
    await earlier.return?.();
    await earlierWatch.return?.();
  });

  it('preserves private watch and glob async-iterator APIs', async () => {
    const directory = join(root, '.aside-logs'); mkdirSync(directory);
    writeFileSync(join(directory, 'run.json'), '{}');
    guard.protect([root]);
    const watcher = promises.watch(directory), matches = promises.glob('*.json', {cwd: directory});
    expect(typeof watcher[Symbol.asyncIterator]).toBe('function');
    expect(typeof matches[Symbol.asyncIterator]).toBe('function');
    expect((watcher as unknown as {then?: unknown}).then).toBeUndefined();
    expect((matches as unknown as {then?: unknown}).then).toBeUndefined();
    const found: string[] = [];
    for await (const match of matches) found.push(match);
    expect(found).toEqual(['run.json']);
    await watcher.return?.();
    expect(guard.violations).toEqual([]);
  });

  it('tracks descriptors opened before activation', () => {
    const descriptor = openSync(source, 'r+');
    try {
      guard.protect([root]);
      expect(() => readSync(descriptor, Buffer.alloc(1), 0, 1, 0)).toThrow('Lifecycle ownership violation');
      expect(() => fstatSync(descriptor)).toThrow('Lifecycle ownership violation');
      expect(() => writeFileSync(descriptor, 'Changed')).toThrow('Lifecycle ownership violation');
      expect(() => fs.createReadStream(join(root, 'external'), {fd: descriptor})).toThrow('Lifecycle ownership violation');
    } finally {closeSync(descriptor);}
  });

  it('tracks callback-opened descriptors and promise FileHandles across activation', async () => {
    const descriptor = await new Promise<number>((resolve, reject) => fs.open(source, 'r', (error, fd) => error ? reject(error) : resolve(fd)));
    const handle = await promises.open(sibling, 'r+');
    try {
      guard.protect([root]);
      expect(() => readFileSync(descriptor)).toThrow('Lifecycle ownership violation');
      await expect(handle.readFile()).rejects.toThrow('Lifecycle ownership violation');
      await expect(handle.stat()).rejects.toThrow('Lifecycle ownership violation');
      await expect(handle.writeFile('Changed')).rejects.toThrow('Lifecycle ownership violation');
    } finally {closeSync(descriptor); await handle.close();}
  });

  it('checks FileHandles passed to generic promises read and write functions', async () => {
    const handle = await promises.open(source, 'r+');
    try {
      guard.protect([root]);
      await expect(promises.readFile(handle)).rejects.toThrow('attempted to read');
      await expect(promises.writeFile(handle, 'Overwrite')).rejects.toThrow('attempted to write');
      await expect(promises.appendFile(handle, 'Append')).rejects.toThrow('attempted to write');
      await guard.allow({paths: [source], operations: ['read'], reason: 'Read through an already-open selected file'}, async () => {
        // FileHandle arguments ignore open flags and do not reopen the path.
        expect(await promises.readFile(handle, {encoding: 'utf8', flag: 'w+'})).toBe('Published bytes');
        await expect(promises.writeFile(handle, 'Overwrite')).rejects.toThrow('attempted to write');
      });
    } finally {await handle.close();}
  });

  it('requires write permission for mutating flags on path-opening read APIs', async () => {
    guard.protect([root]);
    await guard.allow({paths: [source], operations: ['read'], reason: 'Read bytes without changing the source'}, async () => {
      expect(() => readFileSync(source, {flag: 'w+'})).toThrow('attempted to write');
      // Native fs accepts numeric flags even though the installed readFile
      // declarations expose only string flags.
      expect(() => readFileSync(source, {flag: fs.constants.O_RDONLY | fs.constants.O_TRUNC} as any)).toThrow('attempted to write');
      await expect(new Promise((resolve, reject) => fs.readFile(source, {flag: 'w+'}, (error, value) => error ? reject(error) : resolve(value)))).rejects.toThrow('attempted to write');
      await expect(promises.readFile(source, {flag: 'w+'})).rejects.toThrow('attempted to write');
      expect(() => fs.createReadStream(source, {flags: 'w+'})).toThrow('attempted to write');
      expect(readFileSync(source, 'utf8')).toBe('Published bytes');
    });
    expect(guard.violations.filter(violation => violation.operation === 'write')).toHaveLength(5);
  });

  it('preserves read-stream and readLines behavior on existing handles whose flags are ignored', async () => {
    const handle = await promises.open(source, 'r');
    try {
      guard.protect([root]);
      await guard.allow({paths: [source], operations: ['read'], reason: 'Read an existing selected file handle'}, async () => {
        const stream = handle.createReadStream({start: 0, autoClose: false, flags: 'w+'} as any);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk);
        expect(Buffer.concat(chunks).toString()).toBe('Published bytes');
        const lines: string[] = [];
        for await (const line of handle.readLines({start: 0, autoClose: false, flags: 'w+'} as any)) lines.push(line);
        expect(lines).toEqual(['Published bytes']);
        expect(readFileSync(source, 'utf8')).toBe('Published bytes');
      });
      expect(guard.violations).toEqual([]);
    } finally {await handle.close();}
  });

  it('uses stream descriptors instead of their ignored path arguments', async () => {
    const privateFile = join(root, 'private-output.txt');
    writeFileSync(privateFile, 'Private bytes');
    const privateDescriptor = openSync(privateFile, 'r+'), sourceDescriptor = openSync(source, 'r+');
    try {
      guard.protect([root]);
      const input = fs.createReadStream(source, {fd: privateDescriptor, start: 0, autoClose: false});
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('Private bytes');
      const output = fs.createWriteStream(source, {fd: privateDescriptor, start: 0, autoClose: false});
      await new Promise<void>((resolve, reject) => {output.once('error', reject); output.end('Updated cache', resolve);});
      expect(readFileSync(privateFile, 'utf8')).toBe('Updated cache');
      expect(guard.violations).toEqual([]);
      expect(() => fs.createWriteStream(privateFile, {fd: sourceDescriptor})).toThrow('attempted to write');
    } finally {closeSync(privateDescriptor); closeSync(sourceDescriptor);}
  });

  it('keeps private storage and unrelated asset bytes outside authored-source protection', async () => {
    const cache = join(root, '.aside-logs', 'run.json'), asset = join(root, 'assets', 'notes.txt');
    mkdirSync(join(root, '.aside-logs')); mkdirSync(join(root, 'assets'));
    writeFileSync(cache, 'Cached'); writeFileSync(asset, 'Asset');
    guard.protect([root]);
    expect(readFileSync(cache, 'utf8')).toBe('Cached');
    expect(await promises.readFile(asset, 'utf8')).toBe('Asset');
    writeFileSync(cache, 'Updated cache');
    expect(guard.violations).toEqual([]);
  });

  it('requires a reason and grants only exact paths and operations', () => {
    guard.protect([root]);
    expect(() => guard.allow({paths: [source], operations: ['read'], reason: ''}, () => readFileSync(source))).toThrow('require exact paths');
    guard.allow({paths: [source], operations: ['read'], reason: 'Explicit disk validation'}, () => {
      expect(readFileSync(source, 'utf8')).toBe('Published bytes');
      expect(() => readFileSync(sibling)).toThrow('Lifecycle ownership violation');
      expect(() => writeFileSync(source, 'Overwrite')).toThrow('Lifecycle ownership violation');
    });
    expect(() => readFileSync(source)).toThrow('Lifecycle ownership violation');
  });

  it('keeps attachment access explicit and does not grant its parent directory or siblings', () => {
    guard.protect([root]);
    expect(() => readFileSync(attachment)).toThrow('Lifecycle ownership violation');
    guard.allow({paths: [attachment], operations: ['read'], reason: 'Serve the selected attachment bytes'}, () => {
      expect(readFileSync(attachment, 'utf8')).toBe('Published bytes');
      expect(() => readdirSync(join(root, 'artifacts', '2026', '2026-10-30-report'))).toThrow('Lifecycle ownership violation');
    });
  });

  it('checks source and destination independently for copy and rename operations', () => {
    const external = join(root, 'incoming.txt'); writeFileSync(external, 'Import bytes');
    guard.protect([root]);
    expect(() => copyFileSync(external, source)).toThrow('attempted to write');
    expect(() => copyFileSync(source, external)).toThrow('attempted to read');
    expect(() => renameSync(external, source)).toThrow('attempted to write');
  });

  it('does not leak an asynchronous exception into concurrent or later work', async () => {
    guard.protect([root]);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => {release = resolve;});
    const scoped = guard.allow({paths: [source], operations: ['read'], reason: 'Explicit attachment-style byte read'}, async () => {
      await waiting;
      expect(await readFile(source, 'utf8')).toBe('Published bytes');
    });
    await expect(readFile(source)).rejects.toThrow('Lifecycle ownership violation');
    release(); await scoped;
    await expect(readFile(source)).rejects.toThrow('Lifecycle ownership violation');
  });

  it('revokes exceptions after failure and for detached work beyond the callback lifetime', async () => {
    guard.protect([root]);
    expect(() => guard.allow({paths: [source], operations: ['read'], reason: 'Failing explicit operation'}, () => {throw new Error('Failure');})).toThrow('Failure');
    expect(() => readFileSync(source)).toThrow('Lifecycle ownership violation');
    let release!: () => void, detached!: Promise<Buffer>;
    const waiting = new Promise<void>(resolve => {release = resolve;});
    guard.allow({paths: [source], operations: ['read'], reason: 'Only within the operation lifetime'}, () => {
      detached = waiting.then(() => readFile(source));
    });
    release();
    await expect(detached).rejects.toThrow('Lifecycle ownership violation');
  });
});
