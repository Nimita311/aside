import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { init } from '../src/commands/init.js';
import { readManifest } from '../src/core/instance.js';
import { validate } from '../src/core/validator.js';
import { VERSION } from '../src/version.js';

function makeTmpDir(): string {
  return join(tmpdir(), `aside-test-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const NAME = 'Work Log';
const DESC = 'My professional notes';

describe('init', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  describe('default (empty instance)', () => {
    it('writes only the manifest, no data scaffold', () => {
      const result = init(tmpDir, { name: NAME, description: DESC });
      expect(existsSync(join(tmpDir, 'aside.md'))).toBe(true);
      expect(result.created).toEqual(['aside.md']);
      expect(result.tutorial).toBeUndefined();
      expect(existsSync(join(tmpDir, 'notes'))).toBe(false);
      expect(existsSync(join(tmpDir, 'projects'))).toBe(false);
      expect(existsSync(join(tmpDir, 'actions'))).toBe(false);
    });

    it('writes name and description and pins the version', () => {
      init(tmpDir, { name: NAME, description: DESC });
      const manifest = readManifest(tmpDir);
      expect(manifest.name).toBe(NAME);
      expect(manifest.description).toBe(DESC);
      expect(manifest.version).toBe(VERSION);
    });

    it('derives a stable id slug from the name', () => {
      init(tmpDir, { name: NAME, description: DESC });
      expect(readManifest(tmpDir).id).toBe('work-log');
    });

    it('produces a valid instance that passes validation', () => {
      init(tmpDir, { name: NAME, description: DESC });
      const result = validate(tmpDir);
      const failures = result.checks.filter((c) => !c.passed);
      if (failures.length > 0) {
        console.log('Failing checks:', failures.map((f) => `${f.name}: ${f.details?.join(', ')}`));
      }
      expect(result.passed).toBe(true);
    });
  });

  describe('manifest fields', () => {
    it('writes the body below the front matter', () => {
      init(tmpDir, { name: NAME, description: DESC, body: 'Always tag entries to the active sprint.' });
      const content = readFileSync(join(tmpDir, 'aside.md'), 'utf-8');
      // Body lives after the closing front-matter fence.
      const afterFrontMatter = content.split(/\n---\s*\n/).slice(1).join('\n');
      expect(afterFrontMatter).toContain('Always tag entries to the active sprint.');
    });

    it('YAML-escapes values that would otherwise break the parse', () => {
      init(tmpDir, { name: 'A: tricky #name', description: 'has: a colon' });
      const manifest = readManifest(tmpDir);
      expect(manifest.name).toBe('A: tricky #name');
      expect(manifest.description).toBe('has: a colon');
    });

    it('trims surrounding whitespace from name and description', () => {
      init(tmpDir, { name: '  Spaced  ', description: '  padded desc  ' });
      const manifest = readManifest(tmpDir);
      expect(manifest.name).toBe('Spaced');
      expect(manifest.description).toBe('padded desc');
    });
  });

  describe('tutorial', () => {
    it('lays down the guided-tour scaffold and returns the project id', () => {
      const result = init(tmpDir, { name: NAME, description: DESC, tutorial: true });
      const year = String(new Date().getFullYear());
      expect(existsSync(join(tmpDir, 'notes', year))).toBe(true);
      expect(existsSync(join(tmpDir, 'projects', year))).toBe(true);
      expect(existsSync(join(tmpDir, 'actions', year))).toBe(true);
      expect(existsSync(join(tmpDir, 'notes', year, 'index.yaml'))).toBe(true);
      expect(result.created.length).toBeGreaterThanOrEqual(9);
      expect(result.tutorial?.projectId).toMatch(/^\d{4}-\d{2}-\d{2}-meet-aside$/);
    });

    it('creates a weekly file named after Monday', () => {
      init(tmpDir, { name: NAME, description: DESC, tutorial: true });
      const year = String(new Date().getFullYear());
      const files = readdirSync(join(tmpDir, 'notes', year)).filter((f) => f.endsWith('.md'));
      expect(files).toHaveLength(1);
      const dateStr = files[0].replace('.md', '');
      const d = new Date(dateStr + 'T00:00:00');
      expect(d.getDay()).toBe(1); // Monday
    });

    it('creates the meet-aside project file', () => {
      const result = init(tmpDir, { name: NAME, description: DESC, tutorial: true });
      const year = String(new Date().getFullYear());
      expect(existsSync(join(tmpDir, 'projects', year, `${result.tutorial!.projectId}.md`))).toBe(true);
    });

    it('produces a valid dataset that passes validation', () => {
      init(tmpDir, { name: NAME, description: DESC, tutorial: true });
      const result = validate(tmpDir);
      const failures = result.checks.filter((c) => !c.passed);
      if (failures.length > 0) {
        console.log('Failing checks:', failures.map((f) => `${f.name}: ${f.details?.join(', ')}`));
      }
      expect(result.passed).toBe(true);
    });

    it('keys the weekly file and notes index by the Monday year in a New Year week', () => {
      // Friday 2027-01-01: the week's Monday is 2026-12-28, so notes land under
      // 2026 (the same rule capture uses) while project/action files, keyed by
      // today, land under 2027.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2027-01-01T12:00:00'));
      try {
        init(tmpDir, { name: NAME, description: DESC, tutorial: true });
        expect(existsSync(join(tmpDir, 'notes', '2026', '2026-12-28.md'))).toBe(true);
        expect(existsSync(join(tmpDir, 'notes', '2026', 'index.yaml'))).toBe(true);
        expect(existsSync(join(tmpDir, 'notes', '2027'))).toBe(false);
        expect(existsSync(join(tmpDir, 'projects', '2027', '2027-01-01-meet-aside.md'))).toBe(true);
        expect(existsSync(join(tmpDir, 'actions', '2027', '2027-01-01-make-a-first-aside.md'))).toBe(true);

        const result = validate(tmpDir);
        const failures = result.checks.filter((c) => !c.passed);
        if (failures.length > 0) {
          console.log('Failing checks:', failures.map((f) => `${f.name}: ${f.details?.join(', ')}`));
        }
        expect(result.passed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('guards', () => {
    it('throws if directory is not empty', () => {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(join(tmpDir, 'existing.txt'), 'hello');
      expect(() => init(tmpDir, { name: NAME, description: DESC })).toThrow(/already exists and is not empty/);
    });

    it('succeeds if directory exists but is empty', () => {
      mkdirSync(tmpDir, { recursive: true });
      const result = init(tmpDir, { name: NAME, description: DESC });
      expect(result.created.length).toBeGreaterThan(0);
    });
  });
});
