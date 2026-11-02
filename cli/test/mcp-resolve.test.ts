import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDataDir } from '../src/commands/mcp.js';

function makeRoot(): string {
  const d = join(tmpdir(), `aside-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return realpathSync(d);
}

// An aside instance is a directory with an aside.md manifest.
function makeInstance(parent: string, name: string): string {
  const d = join(parent, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'aside.md'), `---\nname: ${name}\n---\n`);
  return d;
}

function writeConfig(dir: string, content: string): void {
  writeFileSync(join(dir, '.aside'), content);
}

describe('resolveDataDir', () => {
  let root: string;
  const extra: string[] = [];
  beforeEach(() => { root = makeRoot(); });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    while (extra.length) rmSync(extra.pop()!, { recursive: true, force: true });
  });

  // --- structural discovery ---

  it('leaves none active when multiple instances are discovered', () => {
    const a = makeInstance(root, 'a');
    const b = makeInstance(root, 'b');
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBeNull();
    expect([...r.candidates].sort()).toEqual([a, b].sort());
  });

  it('auto-selects $PWD itself when it is an instance, even with child instances', () => {
    writeFileSync(join(root, 'aside.md'), '---\nname: root\n---\n');
    const child = makeInstance(root, 'child');
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBe(root);
    expect(r.candidates).toContain(root);
    expect(r.candidates).toContain(child);
  });

  it('auto-selects the sole discovered instance', () => {
    const a = makeInstance(root, 'a');
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBe(a);
    expect(r.candidates).toEqual([a]);
  });

  it('returns nothing active when no instances are found', () => {
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBeNull();
    expect(r.candidates).toEqual([]);
  });

  it('auto-selects one canonical instance referenced by several config spellings', () => {
    const elsewhere = makeRoot(); extra.push(elsewhere);
    const a = makeInstance(elsewhere, 'work');
    const alias = join(elsewhere, 'alias'); symlinkSync(a, alias);
    writeConfig(root, `discovery: false\npointers:\n  - ${a}\n  - ${alias}\n  - ${alias}/../work\n`);
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBe(a);
    expect(r.candidates).toEqual([a]);
    expect(r.discovery).toBe(false);
  });

  it('deduplicates a structurally discovered instance and a symlink pointer before auto-selection', () => {
    const a = makeInstance(root, 'work');
    const alias = join(root, 'alias'); symlinkSync(a, alias);
    writeConfig(root, `pointers:\n  - ${alias}\n`);
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBe(a);
    expect(r.candidates).toEqual([a]);
  });

  it('keeps distinct directories with the same manifest ID as separate candidates', () => {
    const a = makeInstance(root, 'work'), b = makeInstance(root, 'copy');
    for (const path of [a, b]) writeFileSync(join(path, 'aside.md'), '---\nid: work\nname: Work\n---\n');
    const alias = join(root, 'alias'); symlinkSync(a, alias);
    writeConfig(root, `pointers:\n  - ${alias}\n`);
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBeNull();
    expect([...r.candidates].sort()).toEqual([a, b].sort());
  });

  it('canonicalizes a symlinked working directory without changing its precedence over children', () => {
    const a = makeInstance(root, 'work'), child = makeInstance(a, 'child');
    const alias = join(root, 'alias'); symlinkSync(a, alias);
    const r = resolveDataDir(alias, []);
    expect(r.dataDir).toBe(a);
    expect(r.candidates).toEqual([a, child]);
  });

  // --- --dir ---

  it('rejects positional paths, unknown options, and duplicate directory options', () => {
    const instance = makeInstance(root, 'work');
    expect(() => resolveDataDir(root, [instance])).toThrow(/too many arguments/);
    expect(() => resolveDataDir(root, ['--unknown'])).toThrow(/unknown option/);
    expect(() => resolveDataDir(root, ['--dir', instance, '--dir', instance])).toThrow(/duplicate option --dir/);
  });

  it('reports a missing --dir value instead of selecting a discovered instance', () => {
    makeInstance(root, 'work');
    for (const args of [['--dir'], ['--dir', '']]) {
      expect(() => resolveDataDir(root, args)).toThrow(/argument missing|requires a nonempty value/);
    }
  });

  it('treats a dash-leading required option argument as a value, following Commander', () => {
    expect(resolveDataDir(root, ['--dir', '--unknown']).invalidDir).toBe(join(root, '--unknown'));
  });

  it('auto-selects --dir and still tracks the other candidates', () => {
    const a = makeInstance(root, 'a');
    const b = makeInstance(root, 'b');
    const r = resolveDataDir(root, ['--dir', b]);
    expect(r.dataDir).toBe(b);
    expect([...r.candidates].sort()).toEqual([a, b].sort());
  });

  it('prefers --dir over $PWD being an instance', () => {
    writeFileSync(join(root, 'aside.md'), '---\nname: root\n---\n');
    const other = makeInstance(root, 'other');
    const r = resolveDataDir(root, ['--dir', other]);
    expect(r.dataDir).toBe(other);
  });

  it('canonicalizes an explicit alias while preserving its precedence over default and working directory', () => {
    writeFileSync(join(root, 'aside.md'), '---\nname: root\n---\n');
    const a = makeInstance(root, 'work'), b = makeInstance(root, 'default');
    const alias = join(root, 'alias'); symlinkSync(a, alias);
    writeConfig(root, `default: ${b}\npointers:\n  - ${alias}\n`);
    const r = resolveDataDir(root, ['--dir', alias]);
    expect(r.dataDir).toBe(a);
    expect([...r.candidates].sort()).toEqual([root, a, b].sort());
  });

  it('flags an invalid --dir (no aside.md manifest)', () => {
    const bad = join(root, 'nope');
    mkdirSync(bad);
    const r = resolveDataDir(root, ['--dir', bad]);
    expect(r.dataDir).toBeNull();
    expect(r.invalidDir).toBe(bad);
  });

  // --- .aside config ---

  it('treats config pointers as candidates', () => {
    const elsewhere = makeRoot(); extra.push(elsewhere);
    const a = makeInstance(elsewhere, 'work');
    const b = makeInstance(elsewhere, 'personal');
    writeConfig(root, `pointers:\n  - ${a}\n  - ${b}\n`);
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBeNull(); // multiple, no default
    expect([...r.candidates].sort()).toEqual([a, b].sort());
  });

  it('auto-selects the config default', () => {
    const elsewhere = makeRoot(); extra.push(elsewhere);
    const a = makeInstance(elsewhere, 'work');
    const b = makeInstance(elsewhere, 'personal');
    writeConfig(root, `default: ${a}\npointers:\n  - ${a}\n  - ${b}\n`);
    expect(resolveDataDir(root, []).dataDir).toBe(a);
  });

  it('honors a default that is not among the pointers', () => {
    const elsewhere = makeRoot(); extra.push(elsewhere);
    const def = makeInstance(elsewhere, 'default-only');
    const a = makeInstance(elsewhere, 'work');
    writeConfig(root, `default: ${def}\npointers:\n  - ${a}\n`);
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBe(def);
    expect(r.candidates).toContain(def);
    expect(r.candidates).toContain(a);
  });

  it('ignores a default that is not a valid instance, falling through', () => {
    const elsewhere = makeRoot(); extra.push(elsewhere);
    const a = makeInstance(elsewhere, 'work');
    writeConfig(root, `default: ${join(elsewhere, 'ghost')}\npointers:\n  - ${a}\n`);
    expect(resolveDataDir(root, []).dataDir).toBe(a); // sole valid candidate
  });

  it('the config default wins over $PWD being an instance', () => {
    writeFileSync(join(root, 'aside.md'), '---\nname: root\n---\n');
    const elsewhere = makeRoot(); extra.push(elsewhere);
    const def = makeInstance(elsewhere, 'default');
    writeConfig(root, `default: ${def}\n`);
    expect(resolveDataDir(root, []).dataDir).toBe(def);
  });

  it('canonicalizes a configured default alias while preserving its precedence over working directory', () => {
    writeFileSync(join(root, 'aside.md'), '---\nname: root\n---\n');
    const a = makeInstance(root, 'work');
    const alias = join(root, 'alias'); symlinkSync(a, alias);
    writeConfig(root, `default: ${alias}\npointers:\n  - ${a}\n`);
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBe(a);
    expect([...r.candidates].sort()).toEqual([root, a].sort());
  });

  it('surfaces a broken config pointer in configIssues', () => {
    writeConfig(root, `pointers:\n  - ${join(root, 'ghost')}\n`);
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBeNull();
    expect(r.configIssues.some((i) => i.code === 'broken_pointer')).toBe(true);
  });

  // --- discovery toggle ---

  it('discovery: false ignores structurally discovered children', () => {
    const a = makeInstance(root, 'a');
    makeInstance(root, 'b');
    writeConfig(root, `discovery: false\npointers:\n  - ${a}\n`);
    const r = resolveDataDir(root, []);
    expect(r.candidates).toEqual([a]); // only the pointer, not the scanned children
    expect(r.dataDir).toBe(a); // sole candidate
    expect(r.discovery).toBe(false); // threaded to the server for messaging
  });

  it('discovery: false skips the $PWD-is-an-instance auto-select', () => {
    writeFileSync(join(root, 'aside.md'), '---\nname: root\n---\n');
    const elsewhere = makeRoot(); extra.push(elsewhere);
    const a = makeInstance(elsewhere, 'work');
    const b = makeInstance(elsewhere, 'personal');
    writeConfig(root, `discovery: false\npointers:\n  - ${a}\n  - ${b}\n`);
    const r = resolveDataDir(root, []);
    expect(r.dataDir).toBeNull(); // $PWD not auto-selected; two pointers, no default
    expect(r.candidates).not.toContain(root);
    expect([...r.candidates].sort()).toEqual([a, b].sort());
  });

  it('discovery: false still honors the config default', () => {
    const elsewhere = makeRoot(); extra.push(elsewhere);
    const a = makeInstance(elsewhere, 'work');
    const b = makeInstance(elsewhere, 'personal');
    writeConfig(root, `discovery: false\ndefault: ${a}\npointers:\n  - ${a}\n  - ${b}\n`);
    expect(resolveDataDir(root, []).dataDir).toBe(a);
  });

  it('discovery: false still honors an explicit --dir', () => {
    const a = makeInstance(root, 'a');
    writeConfig(root, `discovery: false\n`);
    const r = resolveDataDir(root, ['--dir', a]);
    expect(r.dataDir).toBe(a);
  });

  it('discovery defaults to on when a config omits the flag', () => {
    const child = makeInstance(root, 'a');
    const elsewhere = makeRoot(); extra.push(elsewhere);
    const ptr = makeInstance(elsewhere, 'work');
    writeConfig(root, `pointers:\n  - ${ptr}\n`); // config present, no discovery key
    const r = resolveDataDir(root, []);
    expect(r.candidates).toContain(child); // child still structurally discovered
    expect(r.candidates).toContain(ptr);
    expect(r.discovery).toBe(true);
  });
});
