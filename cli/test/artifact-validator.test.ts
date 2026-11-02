import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { validate } from '../src/core/validator.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync) };
});

const PLAN = '2026-10-02-plan';
const GUIDE = '2026-10-02-guide';

describe('artifact validation', () => {
  let dir: string;

  function write(path: string, content: string | Uint8Array): void {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  function artifact(id: string, body = '', attachments?: string[], year = id.slice(0, 4)): void {
    write(`artifacts/${year}/${id}.md`, `---\nname: ${id}\ncreated: ${id.slice(0, 10)}T10:00\n${attachments?.length ? `attachments: ${JSON.stringify(attachments)}\n` : ''}---\n\n${body}\n`);
  }

  function index(ids: string[], year = '2026'): void {
    write(`artifacts/${year}/index.yaml`, ids.map((id) => `- id: ${id}\n  description: ${id}\n`).join(''));
  }

  function entry(body: string): void {
    write('notes/2026/2026-09-28.md', `---\nweek: 40\nweek_start: 2026-09-28\nweek_end: 2026-10-04\n---\n\n---\n\`\`\`entry\ncreated: 2026-10-02T10:00\n\`\`\`\n\n${body}\n`);
    write('notes/2026/index.yaml', '- id: 2026-10-02T10:00\n  description: Review\n');
  }

  function check(name: string) {
    const result = validate(dir).checks.find((item) => item.name === name);
    expect(result, `Missing check ${name}`).toBeDefined();
    return result!;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aside-artifact-validator-'));
    write('aside.md', '---\nid: test\nname: Test\n---\n');
    vi.mocked(readdirSync).mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts existing instances without artifacts', () => {
    entry('An ordinary captured event.');
    expect(validate(dir).passed).toBe(true);
  });

  it('accepts an empty Markdown artifact and implicit binary content', () => {
    artifact(PLAN);
    artifact(GUIDE, '', ['brief.pdf']);
    index([PLAN, GUIDE]);
    write(`artifacts/2026/${GUIDE}/brief.pdf`, new Uint8Array([0, 255, 128, 10]));
    entry(`Plan: #artifact/${PLAN}. Brief: [Read](#artifact/${GUIDE}).`);
    expect(validate(dir).passed).toBe(true);
    expect(validate(relative(process.cwd(), dir))).toEqual(validate(dir));
  });

  it('validates referenced attachment targets without parsing their contents', () => {
    artifact(PLAN, `[Guide](#artifact/${GUIDE}/guide.md)`, ['appendix.MARKDOWN']);
    artifact(GUIDE, '', ['guide.md']);
    index([PLAN, GUIDE]);
    write(`artifacts/2026/${GUIDE}/guide.md`, `[Appendix](#artifact/${PLAN}/appendix.MARKDOWN)`);
    write(`artifacts/2026/${PLAN}/appendix.MARKDOWN`, `[Back](#artifact/${GUIDE}/guide.md)\n#artifact/${GUIDE}/missing.png`);
    const result = check('Artifact references and content files exist');
    expect(result.passed).toBe(true);
    expect(result.details).toEqual([]);
  });

  it('validates inline references in entries, projects, actions, and artifacts', () => {
    const ghost = '2026-10-02-missing';
    artifact(PLAN, `#artifact/${ghost}`);
    index([PLAN]);
    entry(`#artifact/${ghost}`);
    write('projects/2026/2026-10-02-review.md', `---\nname: Review\ncreated: 2026-10-02T10:00\n---\n#artifact/${ghost}`);
    write('actions/2026/2026-10-02-review.md', `---\nname: Review\ncreated: 2026-10-02T10:00\n---\n#artifact/${ghost}`);
    const result = check('Artifact references and content files exist');
    expect(result.passed).toBe(false);
    expect(result.details).toHaveLength(4);
  });

  it('checks an attachment filename exactly and requires a regular file', () => {
    artifact(PLAN, `![Image](#artifact/${PLAN}/desktop.png)\n#artifact/${PLAN}/directory.pdf`);
    index([PLAN]);
    write(`artifacts/2026/${PLAN}/desktop.jpg`, 'image');
    mkdirSync(join(dir, 'artifacts', '2026', PLAN, 'directory.pdf'));
    const result = check('Artifact references and content files exist');
    expect(result.passed).toBe(false);
    expect(result.details?.some((detail) => detail.includes('desktop.png'))).toBe(true);
    expect(result.details?.some((detail) => detail.includes('directory.pdf'))).toBe(true);
  });

  it('reports malformed references without resolving paths outside storage', () => {
    artifact(PLAN, `#artifact/../escape.png\n#artifact/${PLAN}/nested/image.png`);
    index([PLAN]);
    const result = check('Artifact references and content files exist');
    expect(result.passed).toBe(false);
    expect(result.details).toHaveLength(2);
  });

  it('keeps code handles literal and allows raw file links', () => {
    artifact(PLAN, '`#artifact/2026-10-02-missing`\n\n```md\n#artifact/../missing\n```\n\n[Raw](assets/2026/missing.pdf)');
    index([PLAN]);
    expect(validate(dir).passed).toBe(true);
  });

  it('leaves all indexed attachment contents outside reference validation', () => {
    artifact(PLAN, `![Desktop](#artifact/${PLAN}/desktop.png)`, ['desktop.png', 'ignored.md']);
    index([PLAN]);
    write(`artifacts/2026/${PLAN}/desktop.png`, new Uint8Array([255, 128]));
    write(`artifacts/2026/${PLAN}/ignored.md`, '#artifact/2026-10-02-missing');
    const validation = validate(dir);
    expect(validation.passed).toBe(true);
    expect(validation.checks.find(check => check.name === 'Inline mentions reference existing entities')?.details).toEqual([]);
    const calls = vi.mocked(readdirSync).mock.calls.map(([path]) => String(path));
    expect(calls).toContain(realpathSync(join(dir, 'artifacts', '2026', PLAN)));
  });

  it('reports indexed missing files and unindexed regular files by exact filename', () => {
    artifact(PLAN, 'Body', ['Desktop.png']);
    index([PLAN]);
    write(`artifacts/2026/${PLAN}/desktop.png`, 'image');
    const result = check('Artifact attachments index matches files');
    expect(result.passed).toBe(false);
    expect(result.details).toEqual([
      `artifacts/2026/${PLAN}.md: Attachment indexed but no regular file: Desktop.png`,
      `artifacts/2026/${PLAN}.md: Attachment file missing from attachments index: desktop.png`,
    ]);
  });

  it('allows a Markdown body with attachments, and empty bodies with multiple attachments', () => {
    artifact(PLAN, 'A body', ['brief.pdf']);
    artifact(GUIDE, '', ['one.pdf', 'two.pdf']);
    index([PLAN, GUIDE]);
    for (const [id, filenames] of [[PLAN, ['brief.pdf']], [GUIDE, ['one.pdf', 'two.pdf']]] as const) {
      for (const filename of filenames) write(`artifacts/2026/${id}/${filename}`, 'pdf');
    }
    expect(validate(dir).passed).toBe(true);
  });

  it('validates implicit content presence without inspecting references inside it', () => {
    artifact(PLAN, '', ['guide.md']);
    index([PLAN]);
    write(`artifacts/2026/${PLAN}/guide.md`, '#artifact/2026-10-02-missing');
    const result = check('Artifact references and content files exist');
    expect(result.passed).toBe(true);
    expect(result.details).toEqual([]);
  });

  it.each(['../brief.pdf', 'nested/brief.pdf'])('rejects unsafe indexed filename %s', (filename) => {
    artifact(PLAN, '', [filename]);
    index([PLAN]);
    expect(check('Artifact attachments index matches files').passed).toBe(false);
  });

  it('rejects duplicate attachment index entries', () => {
    artifact(PLAN, 'Body', ['brief.pdf', 'brief.pdf']);
    index([PLAN]);
    write(`artifacts/2026/${PLAN}/brief.pdf`, 'pdf');
    expect(check('Artifact attachments index matches files').details?.some(detail => detail.includes('Duplicate attachment'))).toBe(true);
  });

  it('indexes ordinary hidden files but ignores staging files, subdirectories, and symlinks', () => {
    artifact(PLAN, 'Body', ['.keep', '.notes.tmp', 'notes.tmp']);
    index([PLAN]);
    write(`artifacts/2026/${PLAN}/.keep`, 'kept');
    write(`artifacts/2026/${PLAN}/notes.tmp`, 'kept');
    write(`artifacts/2026/${PLAN}/.notes.tmp`, 'kept');
    write(`artifacts/2026/${PLAN}/.12345678-1234-1234-1234-123456789abc.tmp`, 'staging');
    write(`artifacts/2026/${PLAN}/.1790964000000-abcdef.tmp`, 'staging');
    write(`artifacts/2026/${PLAN}/nested/inside.md`, '#artifact/missing');
    symlinkSync('.keep', join(dir, 'artifacts', '2026', PLAN, 'linked.pdf'));
    expect(validate(dir).passed).toBe(true);
    artifact(PLAN, 'Body', ['.keep', '.notes.tmp', 'notes.tmp', 'linked.pdf']);
    expect(check('Artifact attachments index matches files').passed).toBe(false);
  });

  it('reports attachment directory read errors', () => {
    artifact(PLAN);
    index([PLAN]);
    write(`artifacts/2026/${PLAN}`, 'not a directory');
    expect(check('Artifact attachments index matches files').passed).toBe(false);
  });

  it('compares artifact indexes by year', () => {
    artifact(PLAN);
    index([PLAN], '2025');
    const result = check('Artifact index matches files');
    expect(result.passed).toBe(false);
    expect(result.details).toHaveLength(2);
  });

  it('rejects duplicate record and index IDs', () => {
    artifact(PLAN);
    artifact(PLAN, '', undefined, '2025');
    index([PLAN, PLAN]);
    const result = check('No duplicate artifact IDs');
    expect(result.passed).toBe(false);
    expect(result.details?.some((detail) => detail.includes('Duplicate record'))).toBe(true);
    expect(result.details?.some((detail) => detail.includes('Duplicate index item'))).toBe(true);
  });

  it('requires the file creation year, valid names, and real minute timestamps', () => {
    artifact(PLAN, '', undefined, '2025');
    write(`artifacts/2026/${GUIDE}.md`, '---\nname: " "\ncreated: 2026-02-31T25:10\n---\n');
    write('artifacts/2026/no-date.md', '---\nname: Missing date\ncreated: 2026-10-02T10:00\n---\n');
    const result = check('Artifact identities and storage are valid');
    expect(result.passed).toBe(false);
    for (const reason of ['creation year', 'name must not be empty', 'invalid created timestamp', 'no-date']) {
      expect(result.details?.some((detail) => detail.includes(reason)), reason).toBe(true);
    }
  });

  it('requires creation date to match the immutable ID', () => {
    write(`artifacts/2026/${PLAN}.md`, '---\nname: Renamed plan\ncreated: 2026-10-01T10:00\n---\n');
    expect(check('Artifact date codes match created dates').passed).toBe(false);
  });

  it('orders artifact indexes by the full creation timestamp', () => {
    artifact(PLAN);
    write(`artifacts/2026/${GUIDE}.md`, '---\nname: Guide\ncreated: 2026-10-02T11:00\n---\n');
    index([PLAN, GUIDE]);
    expect(check('Artifact index in reverse chronological order').passed).toBe(false);
    index([GUIDE, PLAN]);
    expect(check('Artifact index in reverse chronological order').passed).toBe(true);
  });

  it('reports malformed artifact YAML through the shared parser', () => {
    write(`artifacts/2026/${PLAN}.md`, '---\nname: [unterminated\ncreated: 2026-10-02T10:00\n---\n');
    expect(check('Files load without structural errors').passed).toBe(false);
  });
});
