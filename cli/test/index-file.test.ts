import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseIndex } from '../src/core/parser.js';
import { prependIndex, updateIndexDescription } from '../src/mcp/tools/index-file.js';

describe('index description edits', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aside-index-edit-'));
    file = join(dir, 'index.yaml');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('keeps canonical block prepending unchanged', () => {
    const existing = '- id: old\n  description: Keep\n';
    writeFileSync(file, existing);
    prependIndex(file, '2026-05-05T09:00', 'New: ready');
    expect(readFileSync(file, 'utf8')).toBe('- id: "2026-05-05T09:00"\n  description: "New: ready"\n' + existing);
  });

  it.each([
    { name: 'flow sequence', content: '[{id: old, description: Keep}]\n' },
    { name: 'empty flow sequence', content: '[]\n' },
    { name: 'flow sequence comments and trailing comma', content: '[ # heading\n  {id: old, description: Keep}, # tail\n]\n' },
    { name: 'empty flow sequence with comments', content: '[ # empty\n]\n' },
    { name: 'explicit document', content: '---\n- id: old\n  description: Keep\n...\n' },
    { name: 'empty explicit document', content: '--- # empty\n...\n' },
    { name: 'indented block sequence', content: '  - id: old\n    description: Keep\n' },
    { name: 'document header and comments', content: '%YAML 1.2\n---\n# heading\n- id: old\n  description: Keep\n' },
    { name: 'BOM document', content: '\ufeff---\n- id: old\n  description: Keep\n' },
    { name: 'BOM block sequence', content: '\ufeff- id: old\n  description: Keep\n' },
    { name: 'BOM flow sequence', content: '\ufeff[{id: old, description: Keep}]\n' },
    { name: 'BOM empty file', content: '\ufeff' },
    { name: 'CRLF and an anchored sequence', content: '&items\r\n  - id: old\r\n    description: Keep\r\n' },
  ])('prepends inside $name without losing existing items or comments', ({ content }) => {
    writeFileSync(file, content);
    prependIndex(file, 'new', 'New, ready');
    const updated = readFileSync(file, 'utf8');
    const before = parseIndex(content.replace(/^\ufeff/, ''));
    const parsed = parseIndex(updated);
    expect(parsed.issues).toEqual([]);
    expect(parsed.value).toEqual([{ id: 'new', description: 'New, ready' }, ...before.value]);
    for (const comment of content.match(/#[^\r\n]*/g) ?? []) expect(updated).toContain(comment);
    if (content.startsWith('\ufeff')) expect(updated.startsWith('\ufeff')).toBe(true);
    if (content.includes('description: Keep')) expect(updated).toContain('description: Keep');
    if (content.includes('\r\n')) expect(updated.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('preserves string types when prepending to a YAML 1.1 document', () => {
    writeFileSync(file, '%YAML 1.1\n---\n- id: old\n  description: Keep\n');
    prependIndex(file, 'new', 'yes');
    const parsed = parseIndex(readFileSync(file, 'utf8'));
    expect(parsed.issues).toEqual([]);
    expect(parsed.value).toEqual([{ id: 'new', description: 'yes' }, { id: 'old', description: 'Keep' }]);
  });

  it('preserves string types when replacing a YAML 1.1 description', () => {
    writeFileSync(file, '%YAML 1.1\n---\n- id: target\n  description: Old\n');
    expect(updateIndexDescription(file, 'target', 'yes')).toBe(true);
    expect(parseIndex(readFileSync(file, 'utf8')).value[0].description).toBe('yes');
  });

  it('preserves indentation, comments, quote style, and other items', () => {
    const untouched = "  - id: other\n    description: 'A reference to id: target'\n";
    writeFileSync(file, "# Heading\n  - description: |- # summary\n      Old\n      content\n    id: 'target' # identity\n" + untouched);
    expect(updateIndexDescription(file, 'target', 'New: ready #1')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe("# Heading\n  - description: \"New: ready #1\" # summary\n    id: 'target' # identity\n" + untouched);
    expect(parseIndex(readFileSync(file, 'utf8')).value[0]).toEqual({ id: 'target', description: 'New: ready #1' });
  });

  it.each([
    '- id: target\n  description: |-\n    Old\n    content',
    '- id: target\r\n  description: >-\r\n    Old\r\n    content\r\n- id: other\r\n  description: Keep\r\n',
    '- {id: target, description: "Old\\ncontent"}\n',
    '- id: target\n  description:\n',
    '- id: target\n  description: # comment\n',
  ])('replaces an entire description value without leftover authored lines (%j)', (content) => {
    writeFileSync(file, content);
    expect(updateIndexDescription(file, 'target', 'Replacement')).toBe(true);
    const updated = readFileSync(file, 'utf8');
    expect(updated).not.toContain('Old');
    expect(updated).not.toContain('content');
    const parsed = parseIndex(updated);
    expect(parsed.issues).toEqual([]);
    expect(parsed.value[0].description).toBe('Replacement');
  });

  it.each([
    '- id: target\n- id: other\n  description: Keep\n',
    '  - id: target # identity\n# tail\n',
    '- {id: target}\n',
    '- {id: target,}\n',
    '- id: target',
  ])('adds an omitted description to the exact mapping (%j)', (content) => {
    writeFileSync(file, content);
    expect(updateIndexDescription(file, 'target', 'Replacement')).toBe(true);
    const parsed = parseIndex(readFileSync(file, 'utf8'));
    expect(parsed.issues).toEqual([]);
    expect(parsed.value[0]).toEqual({ id: 'target', description: 'Replacement' });
  });

  it.each([
    '- {id: target, description: Old,} # record\n',
    '- {description: Old, # summary\n  id: target # identity\n}\n',
    '[{id: target, description: Old}, {id: other, description: Keep}]\n',
  ])('quotes commas when replacing a flow-map description without changing surrounding text (%j)', (content) => {
    const description = 'Planning, build, review';
    writeFileSync(file, content);
    expect(updateIndexDescription(file, 'target', description)).toBe(true);
    const updated = readFileSync(file, 'utf8');
    expect(updated).toBe(content.replace('description: Old', 'description: "Planning, build, review"'));
    const parsed = parseIndex(updated);
    expect(parsed.issues).toEqual([]);
    expect(parsed.value[0].description).toBe(description);
  });

  it.each([
    { before: '- {id: target}\n', after: '- {description: "Planning, build, review", id: target}\n' },
    { before: '- {id: target,}\n', after: '- {description: "Planning, build, review", id: target,}\n' },
    { before: '- {id: target, # identity\n} # record\n', after: '- {description: "Planning, build, review", id: target, # identity\n} # record\n' },
    { before: '- {id: target # identity\n}\n', after: '- {description: "Planning, build, review", id: target # identity\n}\n' },
    { before: '- { # heading\n  id: target\n}\n', after: '- {description: "Planning, build, review", # heading\n  id: target\n}\n' },
    { before: '- {\r\n  id: target, # identity\r\n}\r\n', after: '- {description: "Planning, build, review",\r\n  id: target, # identity\r\n}\r\n' },
  ])('adds a flow-map description while preserving existing comments and separators ($before)', ({ before, after }) => {
    const untouched = '- {id: other, description: Keep}\n';
    writeFileSync(file, before + untouched);
    expect(updateIndexDescription(file, 'target', 'Planning, build, review')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(after + untouched);
    const parsed = parseIndex(readFileSync(file, 'utf8'));
    expect(parsed.issues).toEqual([]);
    expect(parsed.value).toEqual([
      { id: 'target', description: 'Planning, build, review' },
      { id: 'other', description: 'Keep' },
    ]);
  });

  it('returns false when the file or exact item is absent', () => {
    expect(updateIndexDescription(file, 'target', 'Replacement')).toBe(false);
    const content = '- id: target-2\n  description: Keep\n';
    writeFileSync(file, content);
    expect(updateIndexDescription(file, 'target', 'Replacement')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it('replaces a description alias without changing its anchor or other references', () => {
    const shared = '- id: source\n  description: &summary Old description\n';
    const untouched = '- id: other\n  description: *summary\n';
    writeFileSync(file, shared + '- id: target\n  description: *summary # target only\n' + untouched);
    expect(updateIndexDescription(file, 'target', 'Replacement')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(shared + '- id: target\n  description: Replacement # target only\n' + untouched);
    expect(parseIndex(readFileSync(file, 'utf8')).value.map((item) => item.description))
      .toEqual(['Old description', 'Replacement', 'Old description']);
  });

  it('declines a shared anchor edit without changing other descriptions', () => {
    const content = '- id: target\n  description: &summary Old description\n- id: other\n  description: *summary\n';
    writeFileSync(file, content);
    expect(updateIndexDescription(file, 'target', 'Replacement')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(parseIndex(readFileSync(file, 'utf8')).value.map((item) => item.description))
      .toEqual(['Old description', 'Old description']);
  });

  it('updates an unshared description anchor', () => {
    writeFileSync(file, '- id: target\n  description: &summary Old description\n');
    expect(updateIndexDescription(file, 'target', 'Replacement')).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('description: &summary Replacement');
    expect(parseIndex(readFileSync(file, 'utf8')).value[0].description).toBe('Replacement');
  });
});
