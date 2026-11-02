import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjectFile } from '../src/core/parser.js';
import { validate } from '../src/core/validator.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('project closure timestamps', () => {
  it.each(['2026-02-30T25:90', '2026-02-29T12:00', '2026-10-04', '2026-10-04T12:00Z', ''])('preserves and diagnoses invalid direct-file ended %s', ended => {
    const content = `---\nname: Work\ncreated: 2026-10-04T12:00\nended: ${JSON.stringify(ended)}\n---\nProject body.\n`;
    const parsed = parseProjectFile(content);
    expect(parsed.value.body).toContain('Project body.');
    expect(parsed.value.frontMatter.ended).toBe(ended || undefined);
    expect(parsed.issues).toContainEqual(expect.objectContaining({ code: 'invalid_timestamp', field: 'ended' }));
    const dir = mkdtempSync('/tmp/aside-closure-'); dirs.push(dir);
    mkdirSync(join(dir, 'projects', '2026'), { recursive: true });
    writeFileSync(join(dir, 'aside.md'), '---\nid: closure-test\nname: Closure test\n---\n');
    writeFileSync(join(dir, 'projects', '2026', 'index.yaml'), '- id: 2026-10-04-work\n  description: Work\n');
    writeFileSync(join(dir, 'projects', '2026', '2026-10-04-work.md'), content);
    const result = validate(dir);
    expect(result.checks.some(check => !check.passed && check.details.some(detail => detail.includes('ended')))).toBe(true);
  });

  it.each(['2024-02-29T12:00', '2026-03-08T02:30', '0001-01-01T00:00'])('accepts a real civil closure %s', ended => {
    const parsed = parseProjectFile(`---\nname: Work\ncreated: 2026-10-04T12:00\nended: ${ended}\n---\n`);
    expect(parsed.issues.filter(issue => issue.field === 'ended')).toEqual([]);
  });
});
