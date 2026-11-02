import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseActionFile, splitFrontMatter } from '../src/core/parser.js';
import { splitWeekFile } from '../src/mcp/tools/entry-file.js';

describe('front-matter fence separators', () => {
  it.each(['\n', '\r\n'])('keeps significant block-scalar newlines while excluding the %j fence separator', eol => {
    const content = [
      '---', 'name: Fixture', 'created: 2026-10-10T09:00',
      'custom: |+', '  Keep these lines.', '', '', '---', '', 'Body.',
    ].join(eol);
    const split = splitFrontMatter(content);
    expect(split.present).toBe(true);
    expect(split.yaml.endsWith('\r')).toBe(false);
    expect(parse(split.yaml).custom).toBe('Keep these lines.\n\n');
    expect(parseActionFile(content).issues).toEqual([]);
    expect(split.body).toBe(`${eol}Body.`);
  });

  it.each(['week: 41', ''])('retains CRLF fences with a single or empty YAML line: %j', yaml => {
    const frontMatter = `---\r\n${yaml}\r\n---\r\n`;
    expect(splitWeekFile(`${frontMatter}Body.`)).toEqual({ frontMatter, body: 'Body.' });
  });
});
