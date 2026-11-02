import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { isAsideDir, readManifest, readManifestResult, readConfig } from '../src/core/instance.js';
import { validate } from '../src/core/validator.js';

function makeRoot(): string {
  const d = join(tmpdir(), `aside-instance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe('isAsideDir', () => {
  let root: string;
  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('is true when aside.md is present', () => {
    writeFileSync(join(root, 'aside.md'), '---\n---\n');
    expect(isAsideDir(root)).toBe(true);
  });

  it('accepts relative and aliased instance roots while requiring an ordinary manifest', () => {
    writeFileSync(join(root, 'aside.md'), '---\nid: ordinary\n---\n');
    const alias = join(root, 'alias'); symlinkSync(root, alias);
    for (const directory of [relative(process.cwd(), root), alias]) {
      expect(isAsideDir(directory)).toBe(true);
      expect(readManifest(directory).id).toBe('ordinary');
    }
  });

  it('is false without aside.md — even with a .aside config present', () => {
    writeFileSync(join(root, '.aside'), 'pointers: [/x]');
    expect(isAsideDir(root)).toBe(false);
  });

  it('is false when aside.md is prose without front matter', () => {
    writeFileSync(join(root, 'aside.md'), '# Notes\nJust prose, no front matter.\n');
    expect(isAsideDir(root)).toBe(false);
  });

  it.each(['ordinary', 'missing'])('rejects a manifest symlink to an %s target and records a read error', targetKind => {
    const target = join(root, 'target.md');
    if (targetKind === 'ordinary') writeFileSync(target, '---\nid: linked\n---\n');
    symlinkSync(target, join(root, 'aside.md'));
    expect(isAsideDir(root)).toBe(false);
    expect(readManifestResult(root)).toEqual({ value: { id: '' }, issues: [expect.objectContaining({ code: 'read_error', file: 'aside.md', message: expect.stringContaining('Symlinks') })] });
    expect(validate(root)).toMatchObject({ passed: false, dataChecksRun: false, checks: [{ details: [expect.stringContaining('Symlinks')] }] });
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO manifest without waiting for a writer', () => {
    execFileSync('mkfifo', [join(root, 'aside.md')]);
    expect(isAsideDir(root)).toBe(false);
    expect(readManifestResult(root).issues[0]).toMatchObject({ code: 'read_error', file: 'aside.md', message: expect.stringContaining('not a regular file') });
  });
});

describe('readManifest', () => {
  let root: string;
  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('reads manifest fields', () => {
    writeFileSync(join(root, 'aside.md'), '---\nid: work\nversion: 0.1.0\nname: Work\ndescription: d\n---\nbody');
    expect(readManifest(root)).toEqual({ id: 'work', version: '0.1.0', name: 'Work', description: 'd' });
  });

  it('returns an empty manifest when absent', () => {
    expect(readManifest(root)).toEqual({ id: '' });
  });
});

describe('readConfig', () => {
  let root: string;
  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns an empty config when absent', () => {
    expect(readConfig(root)).toEqual({ value: {}, issues: [] });
  });

  it('continues to support symlinks for user-owned configuration', () => {
    const source = join(root, 'config.yaml'); writeFileSync(source, 'discovery: false\n');
    symlinkSync(source, join(root, '.aside'));
    expect(readConfig(root)).toEqual({ value: { discovery: false }, issues: [] });
  });

  it('reports an unreadable config instead of treating it as absent', () => {
    mkdirSync(join(root, '.aside'));
    const result = readConfig(root);
    expect(result.value).toEqual({});
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'error', code: 'read_error', file: '.aside' })]);
    expect(result.issues[0].message).toContain('EISDIR');
    expect(result.issues[0].message).toContain('Configuration was not applied');
    expect(result.issues[0].message).toContain('restart this agent session');
    rmSync(join(root, '.aside'), { recursive: true });
    writeFileSync(join(root, '.aside'), 'discovery: false\n');
    expect(readConfig(root)).toEqual({ value: { discovery: false }, issues: [] });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a config permission failure and recovers after repair', () => {
    const file = join(root, '.aside');
    writeFileSync(file, 'discovery: false\n');
    chmodSync(file, 0);
    try {
      const result = readConfig(root);
      expect(result.value).toEqual({});
      expect(result.issues[0]).toMatchObject({ severity: 'error', code: 'read_error', file: '.aside' });
      expect(result.issues[0].message).toContain('EACCES');
    } finally { chmodSync(file, 0o600); }
    expect(readConfig(root)).toEqual({ value: { discovery: false }, issues: [] });
  });

  it('resolves relative pointers against the config dir, keeps absolute, expands ~', () => {
    writeFileSync(
      join(root, '.aside'),
      `default: ~/inbox\npointers:\n  - ./work\n  - /abs/personal\n`,
    );
    const cfg = readConfig(root).value;
    expect(cfg.pointers).toEqual([join(root, 'work'), '/abs/personal']);
    expect(cfg.default).toBe(join(homedir(), 'inbox'));
  });

  it('reports pointers and a default that are not valid instances', () => {
    writeFileSync(
      join(root, '.aside'),
      `default: ${join(root, 'ghost')}\npointers:\n  - ${join(root, 'nope')}\n`,
    );
    const { issues } = readConfig(root);
    expect(issues.some((i) => i.code === 'broken_pointer')).toBe(true);
    expect(issues.some((i) => i.code === 'broken_default')).toBe(true);
  });

  it('reads the discovery toggle, omitting it when absent', () => {
    writeFileSync(join(root, '.aside'), `discovery: false\n`);
    expect(readConfig(root).value.discovery).toBe(false);
    writeFileSync(join(root, '.aside'), `pointers: []\n`);
    expect(readConfig(root).value.discovery).toBeUndefined();
  });

  it('flags a non-boolean discovery value', () => {
    writeFileSync(join(root, '.aside'), `discovery: nope\n`);
    const { value, issues } = readConfig(root);
    expect(value.discovery).toBeUndefined();
    expect(issues.some((i) => i.code === 'wrong_type')).toBe(true);
  });

  it('flags an unknown config key so typos are not silently ignored', () => {
    writeFileSync(join(root, '.aside'), `discvoery: false\n`); // misspelled
    const { issues } = readConfig(root);
    const unknown = issues.find((i) => i.code === 'unknown_field');
    expect(unknown?.message).toContain('discvoery');
    expect(unknown?.file).toBe('.aside');
  });
});
