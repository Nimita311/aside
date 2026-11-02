import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { splitFrontMatter } from '../src/core/parser.js';
import { Store } from '../src/mcp/store.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';

describe('manifest extension preservation', () => {
  let directory: string | undefined;
  let store: Store | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it.each([
    { label: 'automation clearing', patch: { automations: null }, eol: '\n' },
    { label: 'lookahead editing with CRLF', patch: { recurrenceLookaheadDays: 14 }, eol: '\r\n' },
  ])('retains significant custom block-scalar whitespace during $label', ({ patch, eol }) => {
    directory = mkdtempSync('/private/tmp/aside-manifest-preservation-');
    const file = join(directory, 'aside.md');
    const original = [
      '---',
      'id: manifest-preservation',
      'name: Fixture',
      'created: 2026-10-10T09:00',
      'automations:',
      '  task:',
      '    schedule: {at: "2099-10-10T09:00:00Z"}',
      '    run: {script: echo, args: [hello]}',
      'custom: |+',
      '  Keep these lines.',
      '', '',
      '---',
      '', 'Instructions with trailing whitespace.  ', '',
    ].join(eol);
    writeFileSync(file, original);
    store = new Store(directory);
    const before = splitFrontMatter(original);
    const metadata = (yaml: string) => parse(yaml.replace(/\r(?=\n|$)/g, ''));
    const custom = metadata(before.yaml).custom;
    expect(custom).toBe('Keep these lines.\n\n');

    handleUpdateInstance(store, patch);

    const after = splitFrontMatter(readFileSync(file, 'utf8'));
    expect(metadata(after.yaml).custom).toBe(custom);
    expect(after.body).toBe(before.body);
    if (patch.automations === null) expect(metadata(after.yaml)).not.toHaveProperty('automations');
    else expect(metadata(after.yaml).config.recurrenceLookaheadDays).toBe(14);
  });

  it('preserves exact custom large integers and their aliases during a manifest edit', () => {
    directory = mkdtempSync('/private/tmp/aside-manifest-preservation-');
    const file = join(directory, 'aside.md');
    writeFileSync(file, '---\nid: manifest-preservation\nname: Fixture\ncustom: &details {ticket: 9007199254740993, negative: -9007199254740995}\ncustom_copy: *details\n---\n\nInstance instructions.\n');
    store = new Store(directory);

    handleUpdateInstance(store, { recurrenceLookaheadDays: 14 });

    const saved = splitFrontMatter(readFileSync(file, 'utf8'));
    const metadata = parse(saved.yaml, { intAsBigInt: true });
    expect(metadata.custom).toEqual({ ticket: 9007199254740993n, negative: -9007199254740995n });
    expect(metadata.custom_copy).toEqual(metadata.custom);
    expect(metadata.config.recurrenceLookaheadDays).toBe(14n);
    expect(store.getManifest().config?.recurrenceLookaheadDays).toBe(14);
    expect(saved.body).toBe('\nInstance instructions.\n');
  });
});
