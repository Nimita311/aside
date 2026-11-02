import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { readInstanceData } from '../src/core/reader.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aside-test-reader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeWeek(dir: string, name: string, created: string): void {
  mkdirSync(join(dir, 'notes', '2026'), { recursive: true });
  writeFileSync(
    join(dir, 'notes', '2026', name),
    `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: ${created}
\`\`\`

Entry.
`,
  );
}

describe('readInstanceData', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('returns empty collections for a directory with no data', () => {
    const data = readInstanceData(tmpDir);
    expect(data.weeks).toEqual([]);
    expect(data.projects).toEqual([]);
    expect(data.actions).toEqual([]);
    expect(data.noteIndexes).toEqual([]);
    expect(data.projectIndexes).toEqual([]);
    expect(data.actionIndexes).toEqual([]);
  });

  it('reads a missing index as an empty index, not an error (no index = no entry)', () => {
    // The crux of validator/Store parity: an absent index.yaml contributes no
    // InstanceFile, so the flattened index is empty rather than a special case.
    writeWeek(tmpDir, '2026-05-04.md', '2026-05-05T14:00');
    const data = readInstanceData(tmpDir);
    expect(data.weeks).toHaveLength(1);
    expect(data.noteIndexes).toEqual([]);
    expect(data.noteIndexes.flatMap((f) => f.value)).toEqual([]);
  });

  it('loads an index file when present', () => {
    writeWeek(tmpDir, '2026-05-04.md', '2026-05-05T14:00');
    writeFileSync(
      join(tmpDir, 'notes', '2026', 'index.yaml'),
      `- id: 2026-05-05T14:00
  description: Entry
`,
    );
    const data = readInstanceData(tmpDir);
    expect(data.noteIndexes).toHaveLength(1);
    expect(data.noteIndexes[0].relPath).toBe('notes/2026/index.yaml');
    expect(data.noteIndexes.flatMap((f) => f.value).map((i) => i.id)).toEqual(['2026-05-05T14:00']);
  });

  it('counts every .md file, not only date-named ones', () => {
    // The Store names weekly files w18.md etc.; the reader must not impose the
    // validator's stricter date-pattern filter or those files would vanish.
    writeWeek(tmpDir, 'w18.md', '2026-05-05T14:00');
    const data = readInstanceData(tmpDir);
    expect(data.weeks.map((w) => w.name)).toEqual(['w18.md']);
    expect(data.weeks[0].value.entries).toHaveLength(1);
  });

  it('retains raw content and tags each file with a relative path', () => {
    writeWeek(tmpDir, '2026-05-04.md', '2026-05-05T14:00');
    const wf = readInstanceData(tmpDir).weeks[0];
    expect(wf.relPath).toBe('notes/2026/2026-05-04.md');
    expect(wf.name).toBe('2026-05-04.md');
    expect(wf.content).toContain('```entry');
    expect(readInstanceData(relative(process.cwd(), tmpDir)).weeks).toEqual([wf]);
  });

  it('skips an unreadable file and records a read error instead of throwing', () => {
    // Root can read anything, so the chmod trick is meaningless there (CI).
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    writeWeek(tmpDir, '2026-05-04.md', '2026-05-05T14:00');
    writeWeek(tmpDir, '2026-05-11.md', '2026-05-11T09:00');
    const blocked = join(tmpDir, 'notes', '2026', '2026-05-04.md');
    chmodSync(blocked, 0o000);
    try {
      let data!: ReturnType<typeof readInstanceData>;
      expect(() => { data = readInstanceData(tmpDir); }).not.toThrow();
      expect(data.weeks.map((w) => w.name)).toEqual(['2026-05-11.md']);
      expect(data.errors).toHaveLength(1);
      expect(data.errors[0]).toMatchObject({
        severity: 'error',
        code: 'read_error',
        file: 'notes/2026/2026-05-04.md',
      });
    } finally {
      chmodSync(blocked, 0o644);
    }
  });

  it('sorts year directories and files deterministically', () => {
    writeWeek(tmpDir, '2026-05-11.md', '2026-05-11T09:00');
    writeWeek(tmpDir, '2026-05-04.md', '2026-05-05T14:00');
    mkdirSync(join(tmpDir, 'notes', '2025'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'notes', '2025', '2025-12-29.md'),
      `---
week: 1
week_start: 2025-12-29
week_end: 2026-01-04
---
`,
    );
    const names = readInstanceData(tmpDir).weeks.map((w) => w.relPath);
    expect(names).toEqual([
      'notes/2025/2025-12-29.md',
      'notes/2026/2026-05-04.md',
      'notes/2026/2026-05-11.md',
    ]);
  });

  it.each(['notes', 'projects', 'actions', 'artifacts'])('reports symlinked %s directories instead of reading their targets', subDir => {
    const target = join(tmpDir, 'target');
    mkdirSync(join(target, '2026'), { recursive: true });
    writeFileSync(join(target, '2026', 'private.md'), 'private content');
    symlinkSync(target, join(tmpDir, subDir));
    const data = readInstanceData(tmpDir);
    expect(data.errors).toEqual([expect.objectContaining({ code: 'read_error', file: subDir, message: expect.stringContaining('Symlinks') })]);
    expect([...data.weeks, ...data.projects, ...data.actions, ...data.artifacts]).toEqual([]);
  });

  it('reports symlinked years, record leaves and dangling indexes without reading linked content', () => {
    writeWeek(tmpDir, 'ordinary.md', '2026-05-05T14:00');
    const year = join(tmpDir, 'notes', '2026');
    symlinkSync(year, join(tmpDir, 'notes', '2027'));
    symlinkSync(join(year, 'ordinary.md'), join(year, 'linked.md'));
    symlinkSync(join(tmpDir, 'missing-index'), join(year, 'index.yaml'));
    const data = readInstanceData(tmpDir);
    expect(data.weeks.map(week => week.name)).toEqual(['ordinary.md']);
    expect(data.noteIndexes).toEqual([]);
    expect(data.errors.map(error => error.file)).toEqual(['notes/2027', 'notes/2026/linked.md', 'notes/2026/index.yaml']);
    expect(data.errors.every(error => error.code === 'read_error' && error.message.includes('Symlinks'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reports special-file records and indexes without blocking the instance walk', () => {
    writeWeek(tmpDir, 'ordinary.md', '2026-05-05T14:00');
    for (const name of ['pipe.md', 'index.yaml']) execFileSync('mkfifo', [join(tmpDir, 'notes', '2026', name)]);
    const data = readInstanceData(tmpDir);
    expect(data.weeks.map(week => week.name)).toEqual(['ordinary.md']);
    expect(data.noteIndexes).toEqual([]);
    expect(data.errors.map(error => error.file)).toEqual(['notes/2026/pipe.md', 'notes/2026/index.yaml']);
    expect(data.errors.every(error => error.message.includes('not a regular file'))).toBe(true);
  });
});
