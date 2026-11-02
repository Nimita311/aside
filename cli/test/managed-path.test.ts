import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertManagedPath, isManagedInstancePath, managedInstancePathKind, readManagedText } from '../src/core/managed-path.js';

describe('managed instance paths', () => {
  let fixture: string, root: string;
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'aside-managed-path-'));
    root = join(fixture, 'instance'); mkdirSync(root);
  });
  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  it('accepts an aliased selected root and returns canonical paths', () => {
    const alias = join(fixture, 'alias'); symlinkSync(root, alias);
    writeFileSync(join(root, 'aside.md'), 'manifest');
    expect(readManagedText(alias, join(alias, 'aside.md'))).toBe('manifest');
    expect(assertManagedPath(alias, join(realpathSync(root), 'aside.md'), 'file')).toBe(join(realpathSync(root), 'aside.md'));
    expect(assertManagedPath(alias, 'projects/2026/new.md', 'file', true)).toBe(join(realpathSync(root), 'projects/2026/new.md'));
  });

  it.each(['inside', 'outside', 'dangling'])('rejects a %s symlink even when missing destinations are allowed', destination => {
    const target = destination === 'inside' ? join(root, 'target') : join(fixture, destination);
    if (destination !== 'dangling') mkdirSync(target);
    symlinkSync(target, join(root, 'projects'));
    expect(() => assertManagedPath(root, join(root, 'projects/new.md'), 'file', true)).toThrow(/ELOOP.*Symlinks/);
    expect(() => assertManagedPath(root, join(root, 'projects'), 'directory', true)).toThrow(/ELOOP.*Symlinks/);
  });

  it('rejects a symlink leaf and lexical escape before opening a file', () => {
    writeFileSync(join(fixture, 'external.md'), 'private');
    symlinkSync(join(fixture, 'external.md'), join(root, 'aside.md'));
    expect(() => readManagedText(root, join(root, 'aside.md'))).toThrow(/ELOOP/);
    expect(() => assertManagedPath(root, '../external.md', 'file')).toThrow(/outside the instance/);
  });

  it('checks existing ancestor types and leaf types for both reads and destinations', () => {
    writeFileSync(join(root, 'projects'), 'ordinary');
    expect(() => assertManagedPath(root, 'projects/new.md', 'file', true)).toThrow(/ENOTDIR/);
    expect(() => readManagedText(root, root)).toThrow(/EISDIR/);
    expect(() => assertManagedPath(root, 'missing.md', 'file')).toThrow(/ENOENT/);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', () => {
    const path = join(root, 'aside.md'); execFileSync('mkfifo', [path]);
    expect(() => readManagedText(root, path)).toThrow(/not a regular file/);
    expect(() => assertManagedPath(root, path, 'file', true)).toThrow(/not a regular file/);
  });

  it('classifies owned records and attachments without classifying user configuration or referenced assets', () => {
    for (const path of ['aside.md', 'notes', 'notes/2026', 'projects/2026/record.md', 'actions/2026/index.yaml', 'artifacts/2026/2026-10-02-plan', 'artifacts/2026/2026-10-02-plan/attachment.pdf']) {
      expect(isManagedInstancePath(path)).toBe(true);
    }
    for (const path of ['.aside', 'assets/image.png', 'aside.md.backup', '../projects/file.md',
      'projects/reference/logo.svg', 'projects/2026/support/file.pdf', 'projects/2026/readme.txt',
      'artifacts/report/index.html', 'artifacts/2026/id/attachment.pdf', 'artifacts/2025/2026-10-02-plan/file.pdf',
      'artifacts/2026/2026-10-02-plan/images/chart.svg', 'artifacts/2026/2026-02-30-invalid/file.pdf']) {
      expect(isManagedInstancePath(path), path).toBe(false);
    }
  });

  it('reserves case variants of managed names', () => {
    for (const path of ['ASIDE.MD', 'Aside.md', 'NOTES', 'Projects/2026/record.MD', 'ACTIONS/2026/INDEX.YAML', 'ARTIFACTS/2026/2026-10-02-PLAN/attachment.pdf', 'ARTIFACTS/2026/2026-10-02-CAFE\u0301/attachment.pdf']) {
      expect(isManagedInstancePath(path)).toBe(true);
    }
    for (const path of ['.ASIDE', 'ASSETS/image.png', 'ASIDE.MD.backup', '../PROJECTS/file.md']) expect(isManagedInstancePath(path)).toBe(false);
  });

  it('distinguishes managed directory nodes from files without inspecting their contents', () => {
    for (const path of ['projects', 'projects/2026', 'artifacts/2026/2026-10-02-plan']) expect(managedInstancePathKind(path)).toBe('directory');
    for (const path of ['aside.md', 'projects/2026/record.md', 'actions/2026/index.yaml', 'artifacts/2026/2026-10-02-plan/file.pdf']) expect(managedInstancePathKind(path)).toBe('file');
    expect(managedInstancePathKind('projects/2026/record.md/nested.md')).toBeUndefined();
  });
});
