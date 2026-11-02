import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { Store } from '../src/mcp/store.js';
import { handleUpdateAction, handleUpdateEntry, handleUpdateProject } from '../src/mcp/tools/update.js';
import { handleUpdateArtifact } from '../src/mcp/tools/artifact.js';
import { mergeMetadata } from '../src/mcp/tools/front-matter.js';
import { splitFrontMatter } from '../src/core/parser.js';

describe('metadata alias safety', () => {
  let root: string;
  let instance: string;
  let store: Store | undefined;
  const id = '2026-10-10-fixture';
  const entryId = '2026-10-10T09:00';

  beforeEach(() => {
    root = mkdtempSync('/tmp/aside-alias-safety-');
    instance = join(root, 'instance');
    mkdirSync(instance);
    writeFileSync(join(instance, 'aside.md'), '---\nid: alias-safety\n---\n');
  });

  afterEach(() => { store?.close(); store = undefined; rmSync(root, { recursive: true, force: true }); });

  function record(kind: 'actions' | 'projects' | 'artifacts', extra: string): string {
    const dir = join(instance, kind, '2026');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.md`);
    writeFileSync(file, `---\nname: Fixture\ncreated: 2026-10-10T09:00\n${extra}---\n\nOriginal body.\n`);
    writeFileSync(join(dir, 'index.yaml'), `- id: ${id}\n  description: Fixture\n`);
    return file;
  }

  function entry(extra: string): string {
    const dir = join(instance, 'notes', '2026');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '2026-10-05.md');
    writeFileSync(join(dir, 'index.yaml'), `- id: ${entryId}\n  description: Fixture\n`);
    writeFileSync(file, `---\nweek: 41\nweek_start: 2026-10-05\nweek_end: 2026-10-11\n---\n\n---\n\`\`\`entry\ncreated: ${entryId}\n${extra}\`\`\`\n\nOriginal entry.\n`);
    return file;
  }

  function metadata(file: string): any { return parse(splitFrontMatter(readFileSync(file, 'utf8')).yaml.replace(/\r(?=\n|$)/g, '')); }

  it('preserves untouched explicit tags and cyclic aliases during unrelated edits', () => {
    const file = record('projects', 'custom_tag: &tag !wall 2026-10-10T09:00\ncustom_copy: *tag\ncustom_cycle: &cycle {self: *cycle}\n');
    store = new Store(instance);
    handleUpdateProject(store, { id, name: 'Renamed', body: 'Updated context.' });
    const source = splitFrontMatter(readFileSync(file, 'utf8')).yaml;
    expect(parseDocument(source).get('custom_tag', true)).toHaveProperty('tag', '!wall');
    expect(source).toContain('custom_copy: *tag');
    const saved = metadata(file);
    expect(saved.custom_cycle.self === saved.custom_cycle).toBe(true);
  });

  it.each(['set', 'clear'] as const)('preserves tagged aliases when an owned anchor is %s', operation => {
    const file = record('actions', 'scheduled: &start !wall 2026-10-11T09:00\ncustom_start: *start\n');
    store = new Store(instance);
    handleUpdateAction(store, { id, scheduled: operation === 'set' ? '2026-10-12T09:00' : null });
    const saved = parseDocument(splitFrontMatter(readFileSync(file, 'utf8')).yaml);
    expect(saved.get('custom_start', true)).toHaveProperty('tag', '!wall');
    expect(saved.get('custom_start')).toBe('2026-10-11T09:00');
    expect(store.getAction(id)?.frontMatter.scheduled).toBe(operation === 'set' ? '2026-10-12T09:00' : undefined);
  });

  it('preserves aliased tags reached through another anchor', () => {
    const source = 'external: &tag !owner Me\nrelated_projects: &links [{project: related, description: Related, owner: *tag}]\ncustom_links: *links\n';
    const output = mergeMetadata(source, 'name: Fixture\n', ['related_projects'], 'fixture');
    const owner = (parseDocument(output).get('custom_links', true) as any).items[0].get('owner', true);
    expect(owner).toHaveProperty('tag', '!owner');
    expect(owner.value).toBe('Me');
    expect(parse(mergeMetadata('scheduled: &start !wall 2026-10-11T09:00\n', 'name: Fixture\n', ['scheduled'], 'fixture'))).toEqual({});
  });

  it('rejects a cyclic relationship alias before changing its graph topology', () => {
    const file = record('projects', 'related_projects: &links\n  - project: 2026-10-10-related\n    description: Related\n    all_links: *links\ncustom_links: *links\n');
    store = new Store(instance);
    handleUpdateProject(store, { id, body: 'Unrelated body edit.' });
    const original = readFileSync(file, 'utf8');
    const saved = metadata(file);
    expect(saved.custom_links[0].all_links === saved.custom_links).toBe(true);
    expect(() => handleUpdateProject(store!, { id, related_projects: [] })).toThrow(/cyclic metadata/);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('sets and clears a managed field whose mapping key is an alias', () => {
    const file = record('actions', 'schedule_key: &key scheduled\n? *key\n: &start 2026-10-11T09:00\ncustom_start: *start\n');
    store = new Store(instance);
    handleUpdateAction(store, { id, scheduled: '2026-10-12T09:00' });
    expect(metadata(file)).toMatchObject({ scheduled: '2026-10-12T09:00', custom_start: '2026-10-11T09:00', schedule_key: 'scheduled' });
    expect(store.getAction(id)?.frontMatter.scheduled).toBe('2026-10-12T09:00');
    handleUpdateAction(store, { id, scheduled: null });
    expect(metadata(file)).not.toHaveProperty('scheduled');
    expect(store.getAction(id)?.frontMatter).not.toHaveProperty('scheduled');
  });

  it('rejects ambiguous duplicate managed keys after resolving aliases', () => {
    const source = 'key: &key scheduled\nscheduled: 2026-10-11T09:00\n? *key\n: 2026-10-12T09:00\n';
    expect(() => mergeMetadata(source, 'scheduled: 2026-10-13T09:00\n', ['scheduled'], 'fixture')).toThrow(/repeats scheduled/);
  });

  it('resolves shadowed anchors against their original positions without copying anchors', () => {
    const source = 'scheduled: &clock 2026-10-11T09:00\ncustom_old: *clock\ncustom_new: &clock 2026-10-12T09:00\ncustom_latest: *clock\n';
    const output = mergeMetadata(source, 'scheduled: 2026-10-13T09:00\n', ['scheduled'], 'fixture');
    expect(parse(output)).toEqual({ scheduled: '2026-10-13T09:00', custom_old: '2026-10-11T09:00', custom_new: '2026-10-12T09:00', custom_latest: '2026-10-12T09:00' });
    expect(output.match(/&clock/g)).toHaveLength(1);
  });

  it('retains scalar styles and exact large integer values while detaching nested aliases', () => {
    const source = 'name: Fixture\nrelated_projects: &links\n  - project: related\n    description: Related\n    custom_number: 9007199254740993\n    custom_text: \'Quoted text\'\ncustom_links: *links\nuntouched_number: 9007199254740995\n';
    const output = mergeMetadata(source, 'name: Renamed\n', ['name', 'related_projects'], 'fixture');
    const saved = parseDocument(output, { intAsBigInt: true });
    const links = saved.get('custom_links', true) as any;
    expect(links.items[0].get('custom_number')).toBe(9007199254740993n);
    expect(links.items[0].get('custom_text', true)).toHaveProperty('type', 'QUOTE_SINGLE');
    expect(saved.get('untouched_number')).toBe(9007199254740995n);
    expect(output).not.toContain('&links');
  });

  it('applies canonical scalar styles without changing aliased custom values', () => {
    const source = 'scheduled: &start 2026-10-11T09:00 # schedule comment\ncustom_start: *start\n';
    const output = mergeMetadata(source, 'scheduled: "2026-10-12T09:00"\n', ['scheduled'], 'fixture');
    const saved = parseDocument(output);
    expect(saved.get('scheduled', true)).toHaveProperty('type', 'QUOTE_DOUBLE');
    expect(saved.get('scheduled')).toBe('2026-10-12T09:00');
    expect(saved.get('custom_start')).toBe('2026-10-11T09:00');
    expect(output).toContain('# schedule comment');
  });

  it.each(['LF', 'CRLF'] as const)('preserves significant trailing newlines and spaces in %s record block scalars', newline => {
    const file = record('projects', 'custom: |+\n  Keep these lines.  \n\n\n');
    if (newline === 'CRLF') writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    const original = metadata(file).custom;
    expect(original).toBe('Keep these lines.  \n\n');
    store = new Store(instance);
    handleUpdateProject(store, { id, name: 'Renamed', body: 'Updated context.' });
    expect(metadata(file).custom).toBe(original);
  });

  it.each(['LF', 'CRLF'] as const)('preserves significant trailing newlines and spaces in %s entry block scalars', newline => {
    record('actions', '');
    const file = entry('custom: |+\n  Keep these lines.  \n\n\n');
    if (newline === 'CRLF') writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
    const readMeta = () => parse(readFileSync(file, 'utf8').match(/```entry\r?\n([\s\S]*?)```/)![1]);
    const original = readMeta().custom;
    expect(original).toBe('Keep these lines.  \n\n\n');
    store = new Store(instance);
    handleUpdateEntry(store, { id: entryId, content: 'Amended entry.', actions: [id] });
    expect(readMeta().custom).toBe(original);
  });

  it('preserves tagged artifact aliases while replacing attachment bytes', () => {
    const file = record('artifacts', 'name_copy: *display\n');
    writeFileSync(file, readFileSync(file, 'utf8').replace('name: Fixture', 'name: &display !title Fixture'));
    const attachments = join(instance, 'artifacts', '2026', id);
    mkdirSync(attachments);
    const attachment = join(attachments, 'source.txt');
    writeFileSync(attachment, 'Saved content');
    const source = join(root, 'source.txt');
    writeFileSync(source, 'Replacement content');
    store = new Store(instance);
    handleUpdateArtifact(store, { id, name: 'Renamed', files: [{ source }] });
    expect(parseDocument(splitFrontMatter(readFileSync(file, 'utf8')).yaml).get('name_copy', true)).toHaveProperty('tag', '!title');
    expect(metadata(file).name_copy).toBe('Fixture');
    expect(readFileSync(attachment, 'utf8')).toBe('Replacement content');
  });

  it('rejects cyclic entry alias edits before creating linked records', () => {
    const file = entry('projects: &tags [*tags]\ncustom_tags: *tags\n');
    store = new Store(instance);
    const original = readFileSync(file, 'utf8');
    expect(() => handleUpdateEntry(store!, { id: entryId, projects: [{ name: 'New project', description: 'Must not be saved' }] })).toThrow(/cyclic metadata/);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(store.getProjects().size).toBe(0);
  });
});
