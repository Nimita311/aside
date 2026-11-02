import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/mcp/store.js';
import { handleCreateArtifact, handleUpdateArtifact } from '../src/mcp/tools/artifact.js';
import { handleQueryArtifacts } from '../src/mcp/tools/query.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { artifactHandle } from '../src/core/artifact.js';
import { splitFrontMatter } from '../src/core/parser.js';
import { parseDocument } from 'yaml';

vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events');
  return { watch: vi.fn(() => {
    const watcher = new EventEmitter();
    return Object.assign(watcher, {
      add: vi.fn().mockReturnThis(), getWatched: vi.fn(() => ({})),
      close: vi.fn(() => watcher.removeAllListeners()),
    });
  }) };
});

const NOW = new Date(2026, 9, 2, 10, 0);
const ID = '2026-10-02-design-review';

function snapshot(dir: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  function visit(path: string, prefix: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        result[name + '/'] = null;
        visit(join(path, entry.name), name + '/');
      } else result[name] = readFileSync(join(path, entry.name)).toString('base64');
    }
  }
  visit(dir, '');
  return result;
}

describe('artifact writes', () => {
  let root: string;
  let data: string;
  let store: Store;
  const create = (extra = {}) => handleCreateArtifact(store, { name: 'Design review', description: 'Current design', ...extra }, NOW);
  const source = (name: string, bytes: string | Buffer) => {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aside-artifact-write-'));
    data = join(root, 'instance');
    mkdirSync(data);
    writeFileSync(join(data, 'aside.md'), '---\nid: artifact-test\nname: Artifact test\n---\n');
    store = new Store(data);
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  function unchanged(operation: () => unknown, message: RegExp): void {
    const before = snapshot(data);
    const ids = store.getArtifactIds();
    const artifacts = ids.map(id => store.getArtifact(id));
    const index = JSON.stringify(store.getArtifactIndex());
    expect(operation).toThrow(message);
    expect(snapshot(data)).toEqual(before);
    expect(store.getArtifactIds()).toEqual(ids);
    expect(ids.map(id => store.getArtifact(id))).toEqual(artifacts);
    expect(JSON.stringify(store.getArtifactIndex())).toBe(index);
  }

  it('creates a durable record from a Markdown payload and maintains the index only description', () => {
    const draft = source('draft.md', '---\nname: Payload\n---\n\n# Plan\nCafé ☕\n');
    const result = create({ body_file: draft, description: 'Current\ndesign' });
    expect(result).toContain(`artifact: #artifact/${ID}`);
    expect(result).not.toContain('file:');
    expect(store.getArtifact(ID)?.frontMatter).toEqual({ name: 'Design review', created: '2026-10-02T10:00' });
    expect(store.getArtifact(ID)?.body).toBe(readFileSync(draft, 'utf-8').trim());
    expect(store.getArtifactIndex()).toEqual([{ id: ID, description: 'Current design' }]);
    expect(readFileSync(store.getArtifactFile(ID)!, 'utf-8')).not.toContain('description:');
    const reloaded = new Store(data);
    expect(reloaded.getArtifact(ID)).toEqual(store.getArtifact(ID));
    expect(reloaded.getArtifactIndex()).toEqual(store.getArtifactIndex());
    reloaded.close();
  });

  it('preserves multiline display names in create, query, and update receipts without injecting fields', () => {
    const name = 'Design\nid: authored-label\n  Review';
    const result = create({ name });
    const id = result.match(/^artifact: #artifact\/(.+)$/m)![1];
    expect(result.match(/^id: /gm)).toBeNull();
    expect(JSON.parse(result.match(/^name: (.+)$/m)![1])).toBe(name);
    const query = handleQueryArtifacts(store, { ids: [id], detail: 'metadata' });
    expect(query.match(/^id: /gm)).toHaveLength(1);
    expect(JSON.parse(query.match(/^name: (.+)$/m)![1])).toBe(name);
    const replacement = 'Revised\rname\t\u001b[0m';
    const updated = handleUpdateArtifact(store, { id, name: replacement });
    expect(JSON.parse(updated.match(/^name: (.+)$/m)![1])).toBe(replacement);
    expect(updated).not.toContain('\r');
    expect(updated).not.toContain('\u001b');
    const reloaded = new Store(data);
    expect(reloaded.getArtifact(id)?.frontMatter.name).toBe(replacement);
    reloaded.close();
  });

  it('preserves a newer artifact body when an update changes only its name', () => {
    create({ body: 'Original context.' });
    const file = store.getArtifactFile(ID)!;
    writeFileSync(file, readFileSync(file, 'utf8').replace('Original context.', 'External context.'));

    handleUpdateArtifact(store, { id: ID, name: 'Renamed material' });

    expect(store.getArtifact(ID)?.body).toBe('External context.');
    expect(splitFrontMatter(readFileSync(file, 'utf8')).body.trim()).toBe('External context.');
  });

  it('preflights attachment removal against newer external body references', () => {
    create({ body: 'Original context.', files: [{ source: source('selected.txt', 'Saved content') }] });
    const file = store.getArtifactFile(ID)!;
    writeFileSync(file, readFileSync(file, 'utf8').replace('Original context.', `Read #artifact/${ID}/selected.txt`));

    unchanged(() => handleUpdateArtifact(store, { id: ID, remove_files: ['selected.txt'] }), /selected\.txt/);
  });

  it('replays distinct multiline and literal quoted names through metadata without changing them', () => {
    create();
    const multiline = 'Plan\nreview';
    const names = [multiline, JSON.stringify(multiline), JSON.stringify(JSON.stringify(multiline)), '  "Quoted literal"  '];
    const outputs: string[] = [];
    for (const name of names) {
      handleUpdateArtifact(store, { id: ID, name });
      const metadata = handleQueryArtifacts(store, { ids: [ID], detail: 'metadata' });
      outputs.push(metadata);
      const returnedName: string = JSON.parse(metadata.match(/^name: (.+)$/m)![1]);
      expect(returnedName).toBe(name);
      handleUpdateArtifact(store, { id: ID, name: returnedName });
      store.rebuild();
      expect(store.getArtifact(ID)?.frontMatter.name).toBe(name);
    }
    expect(new Set(outputs).size).toBe(names.length);
  });

  it('imports a gallery by exact filename and preserves source bytes', () => {
    const desktop = source('export.bin', Buffer.from([0, 1, 255, 10]));
    const mobile = source('mobile.png', Buffer.from([255, 2, 0]));
    const result = create({
      body: `![Desktop](#artifact/${ID}/desktop.png)\n![Mobile](#artifact/${ID}/mobile.png)`,
      files: [{ source: desktop, filename: 'desktop.png' }, { source: mobile }],
    });
    expect(result).toContain(`#artifact/${ID}/desktop.png`);
    expect(result).toContain(`#artifact/${ID}/mobile.png`);
    const dest = join(data, 'artifacts', '2026', ID);
    expect(readFileSync(join(dest, 'desktop.png'))).toEqual(readFileSync(desktop));
    expect(readFileSync(join(dest, 'mobile.png'))).toEqual(readFileSync(mobile));
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['desktop.png', 'mobile.png']);
    expect(readFileSync(store.getArtifactFile(ID)!, 'utf-8')).toContain('attachments: [desktop.png, mobile.png]');
  });

  it.each(['.12345678-1234-1234-1234-123456789abc.tmp', '.1790964000000-abcdef.tmp'])('rejects reserved staging filename %s before creating or updating records', filename => {
    const file = source(filename, 'source bytes');
    unchanged(() => create({ files: [{ source: file }] }), /reserved for artifact staging/);
    create({ body: '# Review' });
    unchanged(() => handleUpdateArtifact(store, { id: ID, files: [{ source: file, filename }] }), /reserved for artifact staging/);
    expect(readFileSync(file, 'utf8')).toBe('source bytes');
  });

  it('imports, indexes, replaces, and removes an ordinary authored dotfile', () => {
    const file = source('.notes.tmp', 'durable notes');
    const result = create({ files: [{ source: file }] });
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['.notes.tmp']);
    expect(result).toContain(`target: #artifact/${ID}/.notes.tmp`);
    expect(handleQueryArtifacts(store, { detail: 'metadata' })).toContain('attachments: [.notes.tmp]');
    const replacement = source('replacement.txt', 'updated notes');
    handleUpdateArtifact(store, { id: ID, files: [{ source: replacement, filename: '.notes.tmp' }] });
    store.rebuild();
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['.notes.tmp']);
    expect(readFileSync(join(data, 'artifacts', '2026', ID, '.notes.tmp'), 'utf8')).toBe('updated notes');
    handleUpdateArtifact(store, { id: ID, remove_files: ['.notes.tmp'] });
    expect(store.getArtifact(ID)!.frontMatter.attachments).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe('durable notes');
  });

  it('uses a single binary attachment as content and returns to Markdown without deleting files', () => {
    const first = source('brief.bin', Buffer.from([0, 255, 1]));
    create({ files: [{ source: first }] });
    expect(handleQueryArtifacts(store, { detail: 'full' })).toContain(`target: #artifact/${ID}/brief.bin`);
    expect(handleQueryArtifacts(store, { detail: 'full' })).not.toContain(readFileSync(first).toString('base64'));
    const originalCreated = store.getArtifact(ID)!.frontMatter.created;
    const second = source('second.bin', Buffer.from([4, 5, 255]));
    handleUpdateArtifact(store, { id: ID, name: 'Revised review', files: [{ source: second, filename: 'brief.bin' }, { source: first, filename: 'other.bin' }] });
    const dest = join(data, 'artifacts', '2026', ID);
    expect(readFileSync(join(dest, 'brief.bin'))).toEqual(readFileSync(second));
    expect(readFileSync(join(dest, 'other.bin'))).toEqual(readFileSync(first));
    expect(store.getArtifactIds()).toEqual([ID]);
    expect(store.getArtifact(ID)!.frontMatter.created).toBe(originalCreated);
    handleUpdateArtifact(store, { id: ID, body: '# Revised review', description: 'Updated summary' });
    expect(handleQueryArtifacts(store, { detail: 'metadata' })).not.toContain('target:');
    expect(store.getArtifactIndex()[0].description).toBe('Updated summary');
    expect(existsSync(join(dest, 'brief.bin'))).toBe(true);
    expect(existsSync(join(dest, 'other.bin'))).toBe(true);
    const reload = new Store(data);
    expect(reload.getArtifact(ID)).toEqual(store.getArtifact(ID));
    reload.close();
  });

  it('accepts an empty body without guessing a file target and ignores code examples', () => {
    create();
    handleUpdateArtifact(store, { id: ID, body: '`#artifact/2026-10-02-missing`\n\n```md\n#artifact/2026-10-02-missing/unknown.png\n```' });
    handleUpdateArtifact(store, { id: ID, body: '', files: [] });
    expect(store.getArtifact(ID)).toEqual({ frontMatter: { name: 'Design review', created: '2026-10-02T10:00' }, body: '' });
  });

  it('snapshots every source before replacing destinations during an attachment swap', () => {
    const a = source('a.bin', 'first');
    const b = source('b.bin', 'second');
    create({ files: [{ source: a }, { source: b }] });
    const folder = join(data, 'artifacts', '2026', ID);
    handleUpdateArtifact(store, { id: ID, files: [
      { source: join(folder, 'a.bin'), filename: 'b.bin' },
      { source: join(folder, 'b.bin'), filename: 'a.bin' },
    ] });
    expect(readFileSync(join(folder, 'a.bin'), 'utf-8')).toBe('second');
    expect(readFileSync(join(folder, 'b.bin'), 'utf-8')).toBe('first');
    expect(readdirSync(folder).sort()).toEqual(['a.bin', 'b.bin']);
  });

  it('preflights every import and body source before creating records, directories, or indexes', () => {
    const file = source('valid.bin', 'valid');
    unchanged(() => create({ files: [{ source: file }, { source: join(root, 'missing.bin') }] }), /Cannot import/);
    unchanged(() => create({ body: '', body_file: source('empty.md', ''), files: [{ source: file }] }), /not both/);
    unchanged(() => create({ files: [{ source: root }] }), /regular file/);
    unchanged(() => create({ files: [{ source: 'relative.bin' }] }), /absolute path/);
    unchanged(() => create({ files: [{ source: file, filename: 'one.bin' }, { source: file, filename: 'ONE.bin' }] }), /Duplicate/);
    for (const [first, second] of [['Σ.md', 'ς.md'], ['ß.md', 'SS.md'], ['ſ.md', 'S.md']]) {
      unchanged(() => create({ files: [{ source: file, filename: first }, { source: file, filename: second }] }), /Duplicate/);
    }
    unchanged(() => create({ files: [{ source: file, filename: '../outside.bin' }] }), /single filename/);
  });

  it('rejects ID collisions and empty names or descriptions without mutation', () => {
    create();
    unchanged(() => create({ name: 'Design + review' }), /already exists/);
    unchanged(() => create({ name: ' ' }), /name must not be empty/);
    unchanged(() => create({ description: ' ' }), /description must not be empty/);
    unchanged(() => handleUpdateArtifact(store, { id: ID, name: '' }), /name must not be empty/);
  });

  it('rejects invalid final references before replacing files or body', () => {
    const file = source('brief.pdf', 'original');
    create({ files: [{ source: file }] });
    const replacement = source('changed.pdf', 'replacement');
    unchanged(() => handleUpdateArtifact(store, { id: ID, body: `#artifact/${ID}/missing.pdf`, files: [{ source: replacement, filename: 'brief.pdf' }] }), /missing\.pdf/);
    unchanged(() => handleUpdateArtifact(store, { id: ID, body: '#artifact/2026-10-02-missing' }), /artifact not found/);
    unchanged(() => handleUpdateArtifact(store, { id: ID, body: `#artifact/${ID}/missing.png` }), /missing\.png/);
  });

  it('imports attachments as opaque bytes even when they contain invalid text or unresolved mentions', () => {
    const a = source('a.md', `See #artifact/${ID}/b.md`);
    const b = source('b.md', `See #artifact/${ID}/a.md`);
    create({ body: `#artifact/${ID}/a.md`, files: [{ source: a }, { source: b }] });
    const invalid = source('bad.md', Buffer.from([255]));
    handleUpdateArtifact(store, { id: ID, body: `#artifact/${ID}/bad.md`, files: [{ source: invalid }] });
    const missing = source('missing.md', '#artifact/2026-10-02-missing');
    handleUpdateArtifact(store, { id: ID, files: [{ source: missing, filename: 'b.md' }] });
    const markdown = source('missing.markdown', '#artifact/2026-10-02-missing');
    handleUpdateArtifact(store, { id: ID, body: `#artifact/${ID}/missing.markdown`, files: [{ source: markdown }] });
    expect(readFileSync(join(data, 'artifacts', '2026', ID, 'bad.md'))).toEqual(Buffer.from([255]));
    expect(store.getIssues()).toEqual([]);
  });

  it('does not follow a supporting directory symlink while importing', () => {
    create();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(data, 'artifacts', '2026', ID));
    const file = source('test.bin', 'test');
    expect(() => handleUpdateArtifact(store, { id: ID, files: [{ source: file }] })).toThrow(/Symlinks are not allowed/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('follows explicitly selected external import and body-file symlinks', () => {
    const original = source('original.md', 'External source body');
    const selected = join(root, 'selected.md');
    symlinkSync(original, selected);
    create({ body_file: selected, files: [{ source: selected, filename: 'copy.md' }] });
    expect(store.getArtifact(ID)!.body).toContain('External source body');
    expect(readFileSync(join(data, 'artifacts', '2026', ID, 'copy.md'), 'utf8')).toBe('External source body');
  });

  it('preserves opaque attachment imports when a different entity references the file', () => {
    const notes = source('notes.md', '# Review notes');
    create({ files: [{ source: notes }] });
    handleCapture(store, { content: `Read #artifact/${ID}/notes.md`, description: 'Read notes' }, NOW);
    const missing = source('external.md', '#artifact/2026-10-02-missing');
    handleUpdateArtifact(store, { id: ID, files: [{ source: missing, filename: 'notes.md' }] });
    const invalid = source('invalid.md', Buffer.from([255]));
    handleUpdateArtifact(store, { id: ID, files: [{ source: invalid, filename: 'notes.md' }] });
    expect(readFileSync(join(data, 'artifacts', '2026', ID, 'notes.md'))).toEqual(Buffer.from([255]));
    expect(store.getIssues()).toEqual([]);
  });

  it('validates replacements against the resulting attachment graph', () => {
    const notes = source('notes.md', '# Notes');
    create({ body: `#artifact/${ID}/notes.md`, files: [{ source: notes }] });
    const missing = source('missing.md', '#artifact/2026-10-02-missing');
    handleUpdateArtifact(store, { id: ID, body: '# Revised', files: [{ source: missing, filename: 'notes.md' }] });
    expect(store.getReferencedArtifactFiles()).toEqual([]);
    expect(store.getIssues()).toEqual([]);
    const invalid = source('invalid.md', Buffer.from([255]));
    handleUpdateArtifact(store, { id: ID, files: [{ source: invalid, filename: 'notes.md' }] });
    expect(readFileSync(join(data, 'artifacts', '2026', ID, 'notes.md'))).toEqual(Buffer.from([255]));
  });

  it('keeps attachment target presence independent of its contents and other references', () => {
    const notes = source('notes.md', '# Notes');
    create({ body: `#artifact/${ID}/notes.md`, files: [{ source: notes }] });
    handleCapture(store, { content: `#artifact/${ID}/notes.md`, description: 'Read notes' }, NOW);
    const missing = source('missing.md', '#artifact/2026-10-02-missing');
    handleUpdateArtifact(store, { id: ID, body: '', files: [{ source: missing, filename: 'notes.md' }] });
    handleUpdateArtifact(store, { id: ID, body: '```md\n', files: [{ source: missing, filename: 'notes.md' }] });
    expect(store.getIssues()).toEqual([]);
  });

  it('validates selections only from record content when attachments are replaced', () => {
    const a = source('a.md', `#artifact/${ID}/b.md`);
    const b = source('b.md', '# Notes');
    create({ body: `#artifact/${ID}/a.md`, files: [{ source: a }, { source: b }] });
    const invalid = source('invalid.md', Buffer.from([255]));
    const empty = source('empty.md', '');
    handleUpdateArtifact(store, { id: ID, files: [{ source: empty, filename: 'a.md' }, { source: invalid, filename: 'b.md' }] });
    expect(store.getReferencedArtifactFiles()).toEqual([`#artifact/${ID}/a.md`]);
    handleUpdateArtifact(store, { id: ID, files: [{ source: a, filename: 'a.md' }] });
    expect(store.getReferencedArtifactFiles()).toEqual([`#artifact/${ID}/a.md`]);
    expect(store.getIssues()).toEqual([]);
  });

  for (const [original, alias] of [['notes.md', 'Notes.md'], ['café.md', 'cafe\u0301.md'], ['Σ.md', 'ς.md']]) {
    it(`rejects filesystem aliases of referenced filename ${original}`, context => {
      const good = source('good.md', '# Notes');
      create({ body: '# Review', files: [{ source: good, filename: original }] });
      // Case-sensitive filesystems can store these as distinct ordinary files.
      if (!existsSync(join(data, 'artifacts', '2026', ID, alias))) context.skip();
      const invalid = source('invalid.md', Buffer.from([255]));
      unchanged(() => handleUpdateArtifact(store, {
        id: ID, body: '', files: [{ source: invalid, filename: alias }],
      }), /aliases referenced filename/);
      unchanged(() => handleUpdateArtifact(store, {
        id: ID, body: artifactHandle(ID, original), files: [{ source: invalid, filename: alias }],
      }), /aliases referenced filename/);
      handleUpdateArtifact(store, { id: ID, body: artifactHandle(ID, original) });
      unchanged(() => handleUpdateArtifact(store, {
        id: ID, body: '', files: [{ source: invalid, filename: alias }],
      }), /aliases referenced filename/);
      expect(store.getIssues()).toEqual([]);
      handleCapture(store, { content: artifactHandle(ID, alias), description: 'Aliased reference' }, NOW);
      unchanged(() => handleUpdateArtifact(store, { id: ID, body: '# Review', remove_files: [original] }), /target|file|ENOENT/i);
    });
  }

  it('replaces an exact indexed hardlink without changing the other attachment', () => {
    create({ body: '# Review', files: [{ source: source('original.pdf', 'original bytes'), filename: 'a.pdf' }] });
    const folder = join(data, 'artifacts', '2026', ID);
    linkSync(join(folder, 'a.pdf'), join(folder, 'b.pdf'));
    store.rebuild();
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['a.pdf', 'b.pdf']);
    handleUpdateArtifact(store, { id: ID, files: [{ source: source('replacement.pdf', 'new bytes'), filename: 'a.pdf' }] });
    expect(readFileSync(join(folder, 'a.pdf'), 'utf8')).toBe('new bytes');
    expect(readFileSync(join(folder, 'b.pdf'), 'utf8')).toBe('original bytes');
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['a.pdf', 'b.pdf']);
    expect(store.getIssues()).toEqual([]);
  });

  it('leaves imported attachment text and front matter outside reference validation', () => {
    const notes = source('notes.md', '---\nrelated: "#artifact/2026-10-02-missing"\n---\n\n# Notes');
    create({ files: [{ source: notes }], body: `#artifact/${ID}/notes.md` });
    expect(store.getIssues()).toEqual([]);
    handleCapture(store, { content: `#artifact/${ID}/notes.md`, description: 'Read notes' }, NOW);
    handleUpdateArtifact(store, { id: ID, body: '', files: [{ source: notes }] });
    expect(store.getIssues()).toEqual([]);
  });

  it('allows artifact writes while unrelated references need repair', () => {
    handleCapture(store, { content: '#artifact/2026-10-02-missing', description: 'Unresolved reference' }, NOW);
    create({ body: '# Current plan' });
    handleUpdateArtifact(store, { id: ID, body: '# Revised plan' });
    expect(store.getArtifact(ID)!.body).toBe('# Revised plan');
    expect(store.getIssues().map(issue => issue.code)).toEqual(['artifact_reference_missing']);
  });

  it('imports implicit content as opaque bytes', () => {
    create({ files: [{ source: source('bad.md', '#artifact/2026-10-02-missing') }] });
    handleUpdateArtifact(store, { id: ID, files: [{ source: source('invalid.md', Buffer.from([255])), filename: 'bad.md' }] });
    expect(readFileSync(join(data, 'artifacts', '2026', ID, 'bad.md'))).toEqual(Buffer.from([255]));
    expect(store.getIssues()).toEqual([]);
  });

  it('snapshots a source before removing it and selects the replacement filename', () => {
    create({ files: [{ source: source('old.pdf', 'original bytes') }] });
    const folder = join(data, 'artifacts', '2026', ID);
    const result = handleUpdateArtifact(store, {
      id: ID, files: [{ source: join(folder, 'old.pdf'), filename: 'new.pdf' }], remove_files: ['old.pdf'],
    });
    expect(existsSync(join(folder, 'old.pdf'))).toBe(false);
    expect(readFileSync(join(folder, 'new.pdf'), 'utf8')).toBe('original bytes');
    expect(result).toContain('attachments: [new.pdf]');
    expect(result).toContain(`target: #artifact/${ID}/new.pdf`);
    expect(result).toContain('files_removed:');
    handleUpdateArtifact(store, { id: ID, remove_files: ['new.pdf'] });
    expect(store.getArtifact(ID)!.frontMatter.attachments).toBeUndefined();
    expect(readFileSync(store.getArtifactFile(ID)!, 'utf8')).not.toContain('attachments:');
  });

  it('preflights removal conflicts, missing files, unsafe filenames, and remaining references', () => {
    const file = source('brief.pdf', 'bytes');
    create({ files: [{ source: file }], body: `Read #artifact/${ID}/brief.pdf` });
    unchanged(() => handleUpdateArtifact(store, { id: ID, files: [{ source: file }], remove_files: ['brief.pdf'] }), /import and remove/);
    unchanged(() => handleUpdateArtifact(store, { id: ID, remove_files: ['missing.pdf'] }), /does not exist/);
    unchanged(() => handleUpdateArtifact(store, { id: ID, remove_files: ['../brief.pdf'] }), /single filename/);
    unchanged(() => handleUpdateArtifact(store, { id: ID, remove_files: ['brief.pdf', 'brief.pdf'] }), /Duplicate/);
    unchanged(() => handleUpdateArtifact(store, { id: ID, remove_files: ['brief.pdf'] }), /brief\.pdf/);
    handleCapture(store, { content: `Read #artifact/${ID}/brief.pdf`, description: 'External reference' }, NOW);
    unchanged(() => handleUpdateArtifact(store, { id: ID, body: '', remove_files: ['brief.pdf'] }), /brief\.pdf/);
  });

  it('keeps remaining implicit content without parsing it when another attachment is removed', () => {
    create({ files: [{ source: source('bad.md', '#artifact/2026-10-02-missing') }, { source: source('other.pdf', 'bytes') }] });
    handleUpdateArtifact(store, { id: ID, remove_files: ['other.pdf'] });
    expect(store.getArtifact(ID)!.body).toBe('');
    expect(store.getIssues()).toEqual([]);
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['bad.md']);
  });

  it('reconciles filesystem additions and removals while preserving custom front matter and exact body bytes', () => {
    create({ body: '# Review' });
    const record = store.getArtifactFile(ID)!;
    const body = '\n\n# Review  \n\n  Keep these spaces.\n\n';
    writeFileSync(record, `---\nname: Design review\ncreated: 2026-10-02T10:00\ncustom: {nested: [one, two]} # Keep this comment\nattachments: {invalid: index}\n---${body}`);
    const folder = join(data, 'artifacts', '2026', ID);
    mkdirSync(folder);
    writeFileSync(join(folder, 'z.pdf'), 'bytes');
    writeFileSync(join(folder, 'a.png'), 'pixels');
    mkdirSync(join(folder, 'nested'));
    writeFileSync(join(folder, '.1234567890123-abcdef.tmp'), 'staging');
    symlinkSync(join(folder, 'z.pdf'), join(folder, 'alias.pdf'));
    store.rebuild();
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['a.png', 'z.pdf']);
    expect(store.getIssues()).toEqual([]);
    const updated = readFileSync(record, 'utf8');
    expect(updated).toContain('custom: { nested: [ one, two ] } # Keep this comment');
    expect(updated.endsWith(body)).toBe(true);
    handleUpdateArtifact(store, { id: ID, files: [{ source: source('new.txt', 'reference') }] });
    expect(readFileSync(record, 'utf8').endsWith(body)).toBe(true);
    expect(readFileSync(record, 'utf8')).toContain('custom:');
    rmSync(join(folder, 'z.pdf'));
    store.rebuild();
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['a.png', 'new.txt']);
  });

  it('detects external attachment additions and removals without walking nested files', async () => {
    create({ body: '# Review' });
    vi.useFakeTimers();
    store.watch();
    const folder = join(data, 'artifacts', '2026', ID);
    mkdirSync(folder);
    writeFileSync(join(folder, 'added.pdf'), 'bytes');
    await vi.advanceTimersByTimeAsync(650);
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['added.pdf']);
    rmSync(join(folder, 'added.pdf'));
    await vi.advanceTimersByTimeAsync(650);
    expect(store.getArtifact(ID)!.frontMatter.attachments).toBeUndefined();
    const record = store.getArtifactFile(ID)!;
    writeFileSync(record, readFileSync(record, 'utf8').replace('created: 2026-10-02T10:00', 'created: 2026-10-02T10:00\nattachments: [invented.pdf]'));
    store.rebuild();
    expect(readFileSync(record, 'utf8')).not.toContain('attachments:');
  });

  it('preserves custom aliases to the attachment index and its children during startup reconciliation', () => {
    create({ files: [{ source: source('old.pdf', 'old bytes') }] });
    const record = store.getArtifactFile(ID)!;
    const body = '\n\n  Keep this exact body.  \n\n';
    writeFileSync(record, `---\nname: Design review\ncreated: 2026-10-02T10:00\nattachments: &files [&first old.pdf]\nsaved_files: *files # historical files\nsaved_first: *first\nsettings: &settings {color: blue}\nsaved_settings: *settings # keep this alias\n---${body}`);
    const folder = join(data, 'artifacts', '2026', ID);
    rmSync(join(folder, 'old.pdf'));
    writeFileSync(join(folder, 'new.pdf'), 'new bytes');
    store.close();
    store = new Store(data);
    const output = readFileSync(record, 'utf8');
    const document = parseDocument(splitFrontMatter(output).yaml);
    expect(document.toJS()).toMatchObject({
      attachments: ['new.pdf'], saved_files: ['old.pdf'], saved_first: 'old.pdf',
      settings: { color: 'blue' }, saved_settings: { color: 'blue' },
    });
    expect(output).toContain('# historical files');
    expect(output).toContain('saved_settings: *settings # keep this alias');
    expect(output.endsWith(body)).toBe(true);
    expect(store.getArtifact(ID)!.frontMatter.attachments).toEqual(['new.pdf']);
    expect(store.getIssues()).toEqual([]);
  });

  it('completes file-only replacement and removal while retaining old aliased custom values', () => {
    create({ files: [{ source: source('old.pdf', 'original bytes') }] });
    const record = store.getArtifactFile(ID)!;
    const folder = join(data, 'artifacts', '2026', ID);
    const body = '\n\n# Review  \n';
    writeFileSync(record, `---\nname: Design review\ncreated: 2026-10-02T10:00\nattachments: &files [&first old.pdf]\nsaved_files: *files # historical files\nsaved_first: *first\n---${body}`);
    store.rebuild();
    expect(() => handleUpdateArtifact(store, {
      id: ID, files: [{ source: join(folder, 'old.pdf'), filename: 'new.pdf' }], remove_files: ['old.pdf'],
    })).not.toThrow();
    let output = readFileSync(record, 'utf8');
    expect(parseDocument(splitFrontMatter(output).yaml).toJS()).toMatchObject({
      attachments: ['new.pdf'], saved_files: ['old.pdf'], saved_first: 'old.pdf',
    });
    expect(readdirSync(folder)).toEqual(['new.pdf']);
    expect(readFileSync(join(folder, 'new.pdf'), 'utf8')).toBe('original bytes');
    expect(output.endsWith(body)).toBe(true);
    // An index that aliases an earlier custom node must leave that anchor and
    // its other aliases intact when the managed field is removed.
    writeFileSync(record, `---\nname: Design review\ncreated: 2026-10-02T10:00\nsaved_files: &files [new.pdf]\nattachments: *files\nsaved_again: *files # keep this alias\n---${body}`);
    store.rebuild();
    expect(() => handleUpdateArtifact(store, { id: ID, remove_files: ['new.pdf'] })).not.toThrow();
    output = readFileSync(record, 'utf8');
    const metadata = parseDocument(splitFrontMatter(output).yaml).toJS();
    expect(metadata.attachments).toBeUndefined();
    expect(metadata.saved_files).toEqual(['new.pdf']);
    expect(metadata.saved_again).toEqual(['new.pdf']);
    expect(output).toContain('saved_again: *files # keep this alias');
    expect(readdirSync(folder)).toEqual([]);
    expect(output.endsWith(body)).toBe(true);
    expect(store.getArtifact(ID)!.frontMatter.attachments).toBeUndefined();
    expect(store.getIssues()).toEqual([]);
  });

  it('removes an anchored attachment index without deleting its custom aliased values', () => {
    create({ files: [{ source: source('only.pdf', 'original bytes') }] });
    const record = store.getArtifactFile(ID)!;
    const body = '\n\n# Review  \n';
    writeFileSync(record, `---\nname: Design review\ncreated: 2026-10-02T10:00\nattachments: &files [&only only.pdf]\nsaved_files: *files # preserve the old list\nsaved_file: *only\n---${body}`);
    store.rebuild();
    expect(() => handleUpdateArtifact(store, { id: ID, remove_files: ['only.pdf'] })).not.toThrow();
    const output = readFileSync(record, 'utf8');
    const metadata = parseDocument(splitFrontMatter(output).yaml).toJS();
    expect(metadata.attachments).toBeUndefined();
    expect(metadata.saved_files).toEqual(['only.pdf']);
    expect(metadata.saved_file).toBe('only.pdf');
    expect(output).toContain('# preserve the old list');
    expect(output.endsWith(body)).toBe(true);
    expect(readdirSync(join(data, 'artifacts', '2026', ID))).toEqual([]);
    expect(store.getArtifact(ID)!.frontMatter.attachments).toBeUndefined();
    expect(store.getIssues()).toEqual([]);
  });
});
