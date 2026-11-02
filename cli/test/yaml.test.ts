import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { yamlQuote } from '../src/mcp/tools/yaml.js';
import { serializeAction, serializeProject } from '../src/mcp/tools/serialize.js';

function frontMatter(fileContent: string): any {
  return parseYaml(fileContent.match(/^---\n([\s\S]*?)\n---/m)![1]);
}

describe('yamlQuote', () => {
  it('leaves plain strings bare', () => {
    expect(yamlQuote('hello world')).toBe('hello world');
    expect(yamlQuote('deploy-db')).toBe('deploy-db');
  });

  it('quotes structural characters', () => {
    expect(yamlQuote('a: b')).toBe('"a: b"');
    expect(yamlQuote('- starts with dash')).toBe('"- starts with dash"');
  });

  it('quotes YAML-typed scalars so they round-trip as strings', () => {
    for (const v of ['null', '~', 'true', 'false', 'True', 'NO', '007', '1e3', '3.14', '-12', '0x1F', '.inf', '.NaN', '']) {
      expect(parseYaml(`k: ${yamlQuote(v)}`).k).toBe(v);
    }
  });

  it('round-trips arbitrary scalars as mapping values', () => {
    for (const v of ['plain text', ' leading space', 'trailing space ', 'a\nb', 'he said "hi"', '#comment-like', '[not, a, list]', '2026-05-05T14:30']) {
      expect(parseYaml(`k: ${yamlQuote(v)}`).k).toBe(v);
    }
  });
});

describe('serialize round-trips through YAML', () => {
  it('serializeAction quotes values YAML would mistype', () => {
    const out = serializeAction(
      { name: 'true', created: '2026-01-15T10:00', scheduled: '2026-02-01T10:00', duration: 'PT1H' },
      'body',
    );
    const fm = frontMatter(out);
    expect(fm.name).toBe('true');
    expect(fm.scheduled).toBe('2026-02-01T10:00');
    expect(fm.duration).toBe('PT1H');
  });

  it('serializeProject quotes the related project id', () => {
    const out = serializeProject(
      {
        name: 'P',
        created: '2026-01-01T10:00',
        related_projects: [{ project: 'null', description: 'depends: on it' }],
      },
      'body',
    );
    const fm = frontMatter(out);
    expect(fm.related_projects[0].project).toBe('null');
    expect(fm.related_projects[0].description).toBe('depends: on it');
  });
});
