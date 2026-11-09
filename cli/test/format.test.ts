import { describe, it, expect } from 'vitest';
import {formatPagination, formatArtifactFull, formatArtifactMeta, formatArtifactIndex, formatAttachmentFiles, formatIssueSummary} from '../src/mcp/format.js';
import {formatInstanceLine, formatScalar} from '../src/core/text.js';
import type { Artifact } from '../src/core/types.js';

describe('formatInstanceLine', () => {
  it('leads with name and description, trailing the path', () => {
    expect(formatInstanceLine('/d', { name: 'Work', description: 'My work log.' }))
      .toBe('Work — My work log.  (/d)');
  });

  it('omits absent parts', () => {
    expect(formatInstanceLine('/d', {})).toBe('/d');
    expect(formatInstanceLine('/d', { name: 'Work' })).toBe('Work  (/d)');
    expect(formatInstanceLine('/d', { description: 'desc' })).toBe('desc  (/d)');
  });

  it('collapses newlines so each instance stays on one line', () => {
    const line = formatInstanceLine('/d', { description: 'line one\nline two' });
    expect(line).toBe('line one line two  (/d)');
    expect(line).not.toContain('\n');
  });

  it('drops whitespace-only fields, falling back to the path', () => {
    expect(formatInstanceLine('/d', { name: '  ', description: '\n\t' })).toBe('/d');
  });
});

describe('formatPagination', () => {
  it('formats showing/total', () => {
    expect(formatPagination(5, 20, 0, 5)).toBe('5 of 20\noffset: 0\nlimit: 5\nnext_offset: 5');
  });

  it('handles equal counts', () => {
    expect(formatPagination(10, 10)).toBe('10 of 10\noffset: 0\nlimit: 20\nnext_offset: null');
  });

  it('handles zero', () => {
    expect(formatPagination(0, 0)).toBe('0 of 0\noffset: 0\nlimit: 20\nnext_offset: null');
  });

  it('ends pagination on a partial final page and beyond the end', () => {
    expect(formatPagination(1, 21, 20, 20)).toContain('next_offset: null');
    expect(formatPagination(0, 21, 40, 20)).toContain('next_offset: null');
  });
});

describe('formatArtifactIndex', () => {
  it('formats the handle and description with em dash', () => {
    expect(formatArtifactIndex({ id: '2026-05-05-plan', description: 'A test artifact' })).toBe('#artifact/2026-05-05-plan — A test artifact');
  });
});

describe('formatArtifactFull', () => {
  const baseArtifact: Artifact = {
    frontMatter: { name: 'Plan', created: '2026-05-05T14:00' },
    body: 'Artifact details here.',
  };

  it('includes id, handle, name, created', () => {
    const result = formatArtifactFull('2026-05-05-plan', baseArtifact, [], [], []);
    expect(result).toContain('id: 2026-05-05-plan');
    expect(result).toContain('handle: #artifact/2026-05-05-plan');
    expect(result).toContain('name: Plan');
    expect(result).toContain('created: 2026-05-05T14:00');
  });

  it('frames the authored body as an indented block', () => {
    const result = formatArtifactFull('2026-05-05-plan', baseArtifact, [], [], []);
    expect(result).toContain('\nbody: |\n  Artifact details here.');
  });

  it('includes each association list when present', () => {
    const result = formatArtifactFull('2026-05-05-plan', baseArtifact, ['proj-a', 'proj-b'], ['action-x'], ['#entry/2026-05-05T14:00']);
    expect(result).toContain('projects: [proj-a, proj-b]');
    expect(result).toContain('actions: [action-x]');
    expect(result).toContain('backlinks: [#entry/2026-05-05T14:00]');
  });

  it('omits each association line when empty', () => {
    const result = formatArtifactFull('2026-05-05-plan', baseArtifact, [], [], []);
    expect(result).not.toContain('projects:');
    expect(result).not.toContain('actions:');
    expect(result).not.toContain('backlinks:');
  });

  it('includes a description only when present, on one line', () => {
    expect(formatArtifactMeta('2026-05-05-plan', baseArtifact, [], [], [])).not.toContain('description:');
    expect(formatArtifactMeta('2026-05-05-plan', baseArtifact, [], [], [], 'Line one\nLine two')).toContain('description: Line one Line two');
  });
});

describe('formatAttachmentFiles', () => {
  it('omits the block for an artifact without attachments', () => {
    expect(formatAttachmentFiles(undefined, 'plan', [])).toEqual([]);
  });

  it('lists each file with its observed handle, path, or error', () => {
    const files = [{ filename: 'a.pdf', handle: '#artifact/plan/a.pdf', path: '/data/a.pdf' }, { filename: 'b.pdf', error: 'Missing file' }];
    expect(formatAttachmentFiles(files, 'plan', ['a.pdf', 'b.pdf'])).toEqual([
      'attachment_files:', '  - filename: a.pdf', '    handle: #artifact/plan/a.pdf', '    path: /data/a.pdf', '  - filename: b.pdf', '    error: Missing file',
    ]);
  });
});

describe('formatIssueSummary', () => {
  const issue = (file?: string) => ({ severity: 'error' as const, code: 'bad_value', message: 'Bad value', ...(file ? { file } : {}) });

  it('returns null when there is nothing to report', () => {
    expect(formatIssueSummary([])).toBeNull();
  });

  it('counts issues and distinct files with singular and plural grammar', () => {
    expect(formatIssueSummary([issue()], 5, 'note')).toBe('⚠ 1 parsing issue (note):\n  Bad value');
    expect(formatIssueSummary([issue('/a.md'), issue('/a.md'), issue('/b.md')], 5, 'note')!.split('\n')[0]).toBe('⚠ 3 parsing issues in 2 files (note):');
    expect(formatIssueSummary([issue('/a.md')], 5, 'note')).toBe('⚠ 1 parsing issue in 1 file (note):\n  /a.md: Bad value');
  });

  it('truncates past the row limit and names the remainder', () => {
    const lines = formatIssueSummary([issue(), issue(), issue()], 2, 'note')!.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toBe('  … (+1 more)');
  });
});

describe('canonical fields and record framing', () => {
  it('returns artifact timestamps verbatim', () => {
    const artifact = { frontMatter: { name: 'Plan', created: '2026-05-05T14:00' }, body: '' };
    expect(formatArtifactMeta('2026-05-05-plan', artifact, [], [], []).match(/^created: (.+)$/m)?.[1]).toBe(artifact.frontMatter.created);
  });

  it('keeps record-like body text and nested code inside the authored block', () => {
    const body = 'First line\n\nid: fake-record\nfile: fake.md\n```yaml\nid: nested\n```\n';
    const result = formatArtifactFull('2026-05-05-plan', { frontMatter: { name: 'Plan', created: '2026-05-05T14:00' }, body }, [], [], []);
    expect(result.match(/^id:/gm)).toHaveLength(1);
    expect(result).toContain('  id: fake-record\n  file: fake.md');
    const restored = result.split('body: |\n')[1].split('\n').map(line => line.slice(2)).join('\n');
    expect(restored).toBe(body);
  });
});

describe('lossless scalar framing', () => {
  const injected = 'original\nid: forged\rfile: forged\t\u001b[2J\u0085next\u009b0m\u2028line\u2029paragraph\u007f';
  const readScalar = (output: string, key: string) => JSON.parse(output.split('\n').find(line => line.startsWith(`${key}: `))!.slice(key.length + 2));
  const expectSafe = (output: string) => {
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(output).not.toContain('\nid: forged');
    expect(output).not.toContain('\nfile: forged');
  };

  it('preserves multiline display names', () => {
    const name = 'Plan\n\n  Preserve indentation\n';
    const result = formatArtifactMeta('artifact', { frontMatter: { name, created: '2026-10-03T09:00' }, body: '' }, [], [], []);
    expect(readScalar(result, 'name')).toBe(name);
    expect(result.match(/^id: /gm)).toHaveLength(1);
  });

  it('distinguishes multiline names from literal quoted escape representations', () => {
    const multiline = 'Plan\nreview';
    const quoted = JSON.stringify(multiline);
    const names = [multiline, quoted, JSON.stringify(quoted), '  "Keep these spaces"  ', '"Quoted name"'];
    const format = (name: string) => formatArtifactMeta('artifact', { frontMatter: { name, created: '2026-10-03T09:00' }, body: '' }, [], [], []);
    const encoded = names.map(name => format(name).match(/^name: (.+)$/m)![1]);
    expect(new Set(encoded).size).toBe(names.length);
    expect(encoded.map(value => JSON.parse(value))).toEqual(names);
    for (const name of ['Plain name', 'null', '2026-10-03T09:00', '"An unfinished quote', 'Work: "iCloud"']) {
      expect(formatScalar(name)).toBe(name);
    }
  });

  it('distinguishes one punctuated list ID from multiple IDs while retaining canonical handles', () => {
    const artifact = { frontMatter: { name: 'Plan', created: '2026-10-03T09:00' }, body: '' };
    const combined = formatArtifactMeta('2026-10-03-plan', artifact, ['literal, id'], [], []);
    const separate = formatArtifactMeta('2026-10-03-plan', artifact, ['literal', 'id'], [], []);
    expect(combined).toContain('projects: ["literal, id"]');
    expect(separate).toContain('projects: [literal, id]');
    expect(combined).not.toBe(separate);
    const punctuated = ['literal]', '[literal', '{literal}', '  literal  ', '"unfinished'];
    const encoded = formatArtifactMeta('2026-10-03-plan', artifact, [], punctuated, []);
    expect(JSON.parse(encoded.match(/^actions: (.+)$/m)![1])).toEqual(punctuated);
    expect(formatArtifactMeta('2026-10-03-plan', artifact, [], [], ['#entry/2026-10-03T09:00', '#project/2026-10-03-work']))
      .toContain('backlinks: [#entry/2026-10-03T09:00, #project/2026-10-03-work]');
  });

  it('quotes an index ID containing the row separator without quoting ordinary descriptions', () => {
    const id = '2026-a — b';
    const combined = formatArtifactIndex({ id, description: 'c' });
    const ordinary = formatArtifactIndex({ id: '2026-a', description: 'b — c' });
    expect(combined).not.toBe(ordinary);
    const fields = combined.match(/^("(?:[^"\\]|\\.)*") — (.*)$/)!;
    expect(JSON.parse(fields[1])).toBe(`#artifact/${id}`);
    expect(fields[2]).toBe('c');
    expect(ordinary).toBe('#artifact/2026-a — b — c');
    expect(formatArtifactIndex({ id: '2026-10-03-plan', description: 'Plan, draft — review' }))
      .toBe('#artifact/2026-10-03-plan — Plan, draft — review');
  });

  it('escapes artifact scalars, attachment filenames, and all association lists', () => {
    const artifact = { frontMatter: { name: injected, created: injected, attachments: [injected] }, body: '' };
    const result = formatArtifactMeta(injected, artifact, [injected], [injected], [injected], undefined,
      [{filename: injected, error: 'Invalid attachment fixture'}]);
    expectSafe(result);
    expect(readScalar(result, 'id')).toBe(injected);
    expect(readScalar(result, 'handle')).toBe(`#artifact/${injected}`);
    expect(readScalar(result, 'name')).toBe(injected);
    expect(readScalar(result, 'created')).toBe(injected);
    expect(result.match(/^id: /gm)).toHaveLength(1);
    for (const key of ['attachments', 'projects', 'actions', 'backlinks']) {
      expect(JSON.parse(result.match(new RegExp(`^${key}: (.+)$`, 'm'))![1])).toEqual([injected]);
    }
    const valid = formatArtifactMeta('2026-10-03-plan', { frontMatter: { name: 'Plan', created: '2026-10-03T09:00', attachments: ['final % draft.pdf'] }, body: '' }, [], [], [], undefined,
      [{filename: 'final % draft.pdf', handle: '#artifact/2026-10-03-plan/final%20%25%20draft.pdf', path: '/fixture/final % draft.pdf'}]);
    expect(valid).toContain('attachments: [final % draft.pdf]');
    expect(valid).toContain('target: #artifact/2026-10-03-plan/final%20%25%20draft.pdf');
  });

  it('escapes attachment file rows without forging records', () => {
    const lines = formatAttachmentFiles([{filename: injected, handle: injected, path: injected, error: injected}], 'plan', [injected]);
    expectSafe(lines.join('\n'));
    expect(lines).toHaveLength(5);
    for (const [index, key] of ['filename', 'handle', 'path', 'error'].entries()) {
      expect(JSON.parse(lines[index + 1].split(`${key}: `)[1])).toBe(injected);
    }
  });

  it('keeps every index item on one row and preserves the one-line description rule', () => {
    const result = formatArtifactIndex({ id: injected, description: 'Line one\r\nLine two\rLine three\u001b[0m\u2028four' });
    expectSafe(result);
    expect(result.split('\n')).toHaveLength(1);
    const [id, description] = result.split(' — ');
    expect(JSON.parse(id)).toBe(`#artifact/${injected}`);
    expect(JSON.parse(description)).toBe('Line one Line two Line three\u001b[0m\u2028four');
  });

  it('keeps ordinary scalar values and intentional spaces unchanged', () => {
    const artifact = { frontMatter: { name: '  Exact display name  ', created: '2026-10-03T09:00' }, body: '' };
    expect(formatArtifactMeta('2026-10-03-plan', artifact, ['project-a'], [], [], 'Plain description')).toBe([
      'id: 2026-10-03-plan', 'handle: #artifact/2026-10-03-plan', 'name:   Exact display name  ', 'created: 2026-10-03T09:00', 'description: Plain description', 'projects: [project-a]',
    ].join('\n'));
  });

  it('protects instance paths and issue diagnostics while keeping manifest label collapse', () => {
    const instance = formatInstanceLine(injected, { name: 'Work\nlabel', description: 'Summary\u001b[0m' });
    expectSafe(instance);
    expect(instance).toContain('Work label');
    expect(instance).toContain(`(${JSON.stringify(injected).replace(/[\u007f-\u009f\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)})`);
    const summary = formatIssueSummary([{ severity: 'error', code: 'bad_value', file: injected, message: injected }], 5, injected)!;
    expectSafe(summary);
    expect(summary.split('\n')).toHaveLength(2);
  });
});
