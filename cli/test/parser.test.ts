import { describe, it, expect } from 'vitest';
import {
  extractEntryBlocks,
  parseEntryBlock,
  parseWeeklyFile,
  splitFrontMatter,
  parseProjectFile,
  parseActionFile,
  parseManifest,
  parseConfig,
  parseIndex,
} from '../src/core/parser.js';

describe('extractEntryBlocks', () => {
  it('extracts entry blocks from weekly file content', () => {
    const content = `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [my-project]
\`\`\`

Some content here.

---
\`\`\`entry
created: 2026-05-04T09:00
\`\`\`

Earlier entry.
`;
    const blocks = extractEntryBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('created: 2026-05-05T14:00');
    expect(blocks[1]).toContain('created: 2026-05-04T09:00');
  });

  it('returns empty array when no entries', () => {
    const content = `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---
`;
    expect(extractEntryBlocks(content)).toEqual([]);
  });

  it('ignores a quoted entry example after a bare --- rule (no phantom block)', () => {
    // A bare `---` is a horizontal rule, not an entry boundary; the indented
    // ```entry example after it is content, not a metadata block.
    const content = `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
\`\`\`

Above the rule.

---

Here is what an entry looks like:

    \`\`\`entry
    created: 2020-01-01T00:00
    \`\`\`

Below the example.
`;
    const blocks = extractEntryBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('created: 2026-05-05T14:00');
  });
});

describe('parseEntryBlock', () => {
  it('parses all metadata fields', () => {
    const block = `created: 2026-05-05T14:00
projects: [proj-a, proj-b]
actions: [act-1]
`;
    const meta = parseEntryBlock(block).value;
    expect(meta.created).toBe('2026-05-05T14:00');
    expect(meta.projects).toEqual(['proj-a', 'proj-b']);
    expect(meta.actions).toEqual(['act-1']);
  });

  it('handles created-only entry', () => {
    const block = 'created: 2026-05-05T14:00\n';
    const meta = parseEntryBlock(block).value;
    expect(meta.created).toBe('2026-05-05T14:00');
    expect(meta.projects).toBeUndefined();
    expect(meta.actions).toBeUndefined();
    expect(meta.entries).toBeUndefined();
  });

  it('tolerates a scalar where a list is expected', () => {
    // Hand-edited file with `projects: my-project` instead of `[my-project]`.
    const block = 'created: 2026-05-05T14:00\nprojects: my-project\n';
    const meta = parseEntryBlock(block).value;
    expect(meta.projects).toEqual(['my-project']);
  });

  it('drops null items in a metadata list', () => {
    const block = 'created: 2026-05-05T14:00\nprojects: [proj-a, null, proj-b]\n';
    const meta = parseEntryBlock(block).value;
    expect(meta.projects).toEqual(['proj-a', 'proj-b']);
  });
});

describe('parseWeeklyFile', () => {
  it('parses a complete weekly file', () => {
    const content = `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [proj-a]
\`\`\`

Meeting notes about project A.

---
\`\`\`entry
created: 2026-05-04T09:00
\`\`\`

Morning standup.
`;
    const result = parseWeeklyFile(content, "2026-05-04.md").value;
    expect(result.meta.week).toBe(18);
    expect(result.meta.week_start).toBe('2026-05-04');
    expect(result.meta.week_end).toBe('2026-05-10');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].meta.created).toBe('2026-05-05T14:00');
    expect(result.entries[0].meta.projects).toEqual(['proj-a']);
    expect(result.entries[0].content).toBe('Meeting notes about project A.');
    expect(result.entries[0].weekFile).toBe('2026-05-04');
    expect(result.entries[1].meta.created).toBe('2026-05-04T09:00');
    expect(result.entries[1].content).toBe('Morning standup.');
  });

  it('keeps a bare --- horizontal rule inside entry content', () => {
    // Only `---` directly followed by ```entry is a delimiter; a horizontal rule
    // (and a --- inside a code fence) must stay part of the content.
    const body = [
      'Above the rule.',
      '',
      '---',
      '',
      '```yaml',
      'foo: bar',
      '---',
      'baz: qux',
      '```',
      '',
      'Below the rule.',
    ].join('\n');
    const content = `---\nweek: 18\nweek_start: 2026-05-04\nweek_end: 2026-05-10\n---\n\n` +
      `---\n\`\`\`entry\ncreated: 2026-05-05T14:00\n\`\`\`\n\n${body}\n\n` +
      `---\n\`\`\`entry\ncreated: 2026-05-04T09:00\n\`\`\`\n\nSecond entry.\n`;

    const result = parseWeeklyFile(content, '2026-05-04.md').value;
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].content).toBe(body);
    expect(result.entries[1].content).toBe('Second entry.');
  });
});

describe('parseProjectFile', () => {
  it('parses a project with all fields', () => {
    const content = `---
name: Migration
created: 2026-05-02T14:30
related_projects:
  - project: 2026-04-15-infra
    description: Migration depends on infra
---

## Goals

- Complete migration by Q3
`;
    const project = parseProjectFile(content).value;
    expect(project.frontMatter.name).toBe('Migration');
    expect(project.frontMatter.created).toBe('2026-05-02T14:30');
    expect(project.frontMatter.related_projects).toHaveLength(1);
    expect(project.frontMatter.related_projects![0].project).toBe('2026-04-15-infra');
    expect(project.body).toContain('Complete migration by Q3');
  });

  it('parses a minimal project', () => {
    const content = `---
name: Test
created: 2026-05-02T10:00
---

Simple project.
`;
    const project = parseProjectFile(content).value;
    expect(project.frontMatter.name).toBe('Test');
    expect(project.frontMatter.created).toBe('2026-05-02T10:00');
    expect(project.frontMatter.related_projects).toBeUndefined();
  });

  it('drops malformed related_projects entries instead of crashing', () => {
    // An item missing the `project` key, a bare string, and a null — all malformed.
    const content = `---
name: Migration
created: 2026-05-02T14:30
related_projects:
  - description: no project key
  - 2026-04-15-infra
  - null
  - project: 2026-04-10-db
    description: depends on db
---
body`;
    const project = parseProjectFile(content).value;
    expect(project.frontMatter.related_projects).toEqual([
      { project: '2026-04-10-db', description: 'depends on db' },
    ]);
  });

  it('defaults a missing related project description to empty', () => {
    const content = `---
name: Migration
created: 2026-05-02T14:30
related_projects:
  - project: 2026-04-15-infra
---
body`;
    const project = parseProjectFile(content).value;
    expect(project.frontMatter.related_projects).toEqual([
      { project: '2026-04-15-infra', description: '' },
    ]);
  });
});

describe('parseActionFile', () => {
  it('parses scheduled action', () => {
    const content = `---
name: Deploy DB
created: 2026-05-02T14:30
scheduled: 2026-05-15T10:00
deadline: 2026-05-20T17:00
---

Deploy the database.
`;
    const action = parseActionFile(content).value;
    expect(action.frontMatter.name).toBe('Deploy DB');
    expect(action.frontMatter.created).toBe('2026-05-02T14:30');
    expect(action.frontMatter.scheduled).toBe('2026-05-15T10:00');
    expect(action.frontMatter.deadline).toBe('2026-05-20T17:00');
    expect(action.frontMatter.resolution).toBeUndefined();
  });

  it('parses a resolved (cancelled) action', () => {
    const content = `---
name: Review
created: 2026-05-02T10:00
resolution: cancelled
---

No longer needed.
`;
    const action = parseActionFile(content).value;
    expect(action.frontMatter.resolution).toBe('cancelled');
    expect(action.frontMatter.scheduled).toBeUndefined();
  });

  it('drops an invalid resolution value with a warning', () => {
    const { value, issues } = parseActionFile('---\nname: X\ncreated: 2026-05-02T10:00\nresolution: maybe\n---\nbody');
    expect(value.frontMatter.resolution).toBeUndefined();
    expect(issues.some((i) => i.field === 'resolution')).toBe(true);
  });
});

describe('parseIndex', () => {
  it('parses timestamp-id index entries (notes)', () => {
    const content = `- id: 2026-05-05T14:00
  description: Meeting about migration
- id: 2026-05-04T09:00
  description: Morning standup
`;
    const items = parseIndex(content).value;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('2026-05-05T14:00');
    expect(items[0].description).toBe('Meeting about migration');
    expect(items[1].id).toBe('2026-05-04T09:00');
  });

  it('parses slug-id index entries (projects/actions)', () => {
    const content = `- id: 2026-05-02-migration
  description: Database migration project
- id: 2026-04-15-infra
  description: Infrastructure buildout
`;
    const items = parseIndex(content).value;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('2026-05-02-migration');
    expect(items[0].description).toBe('Database migration project');
  });

  it('skips non-object index items instead of crashing', () => {
    const content = `- id: 2026-05-05T14:00
  description: Meeting about migration
- just a bare string
- null
`;
    const items = parseIndex(content).value;
    expect(items).toEqual([
      { id: '2026-05-05T14:00', description: 'Meeting about migration' },
    ]);
  });
});

describe('parseManifest', () => {
  it('parses a full manifest', () => {
    const content = `---
id: personal
version: 0.1.0
name: Personal
description: My personal productivity instance.
---

Some freeform notes about this instance.
`;
    const { value, issues } = parseManifest(content);
    expect(value).toEqual({
      id: 'personal',
      version: '0.1.0',
      name: 'Personal',
      description: 'My personal productivity instance.',
    });
    expect(issues).toEqual([]);
  });

  it('treats version, name, and description as optional', () => {
    const { value, issues } = parseManifest('---\nid: work\nname: Work\n---\n');
    expect(value).toEqual({ id: 'work', name: 'Work' });
    expect(issues).toEqual([]);
  });

  it('flags a missing id', () => {
    const { value, issues } = parseManifest('---\nname: Work\n---\n');
    expect(value.id).toBe('');
    expect(issues.some((i) => i.code === 'missing_field' && i.field === 'id')).toBe(true);
  });

  it('flags a missing id when there is no front matter', () => {
    const { value, issues } = parseManifest('Just a description, no front matter.');
    expect(value.id).toBe('');
    expect(issues.some((i) => i.code === 'missing_field' && i.field === 'id')).toBe(true);
  });

  it('coerces a numeric version to a string', () => {
    const { value, issues } = parseManifest('---\nid: x\nversion: 1\nname: X\n---\n');
    expect(value.version).toBe('1');
    expect(issues).toEqual([]);
  });

  it('parses a manifest with a leading blank line (agrees with isAsideDir)', () => {
    const { value, issues } = parseManifest('\n---\nid: work\n---\n');
    expect(value.id).toBe('work');
    expect(issues).toEqual([]);
  });

  it('parses a manifest with a leading BOM', () => {
    const { value, issues } = parseManifest('\uFEFF---\nid: work\n---\n');
    expect(value.id).toBe('work');
    expect(issues).toEqual([]);
  });

  it('does not close front matter on a ----prefixed line that is not a fence', () => {
    const content = '---\nid: work\ndescription: |\n  --- draft\n  ----\n---\nBody.\n';
    const { value, issues } = parseManifest(content);
    expect(value.id).toBe('work');
    expect(value.description).toBe('--- draft\n----\n');
    expect(issues).toEqual([]);
  });

  it('treats a ----typo closing fence as no front matter rather than mis-splitting at it', () => {
    // A `----` line is never a fence. With no real closing fence the whole file
    // is body and every field is reported missing — fail-loud beats silently
    // truncating the front matter at the typo.
    const { value, issues } = parseManifest('---\nid: work\n----\nBody.\n');
    expect(value.id).toBe('');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('distinguishes an empty front-matter block from no front matter', () => {
    expect(splitFrontMatter('---\n\n---\nbody\n')).toEqual({ yaml: '', body: 'body\n', present: true });
    expect(splitFrontMatter('just text\n')).toEqual({ yaml: '', body: 'just text\n', present: false });
  });

  it('reads calendar title prefixes from the config block', () => {
    const { value, issues } = parseManifest('---\nid: work\nconfig:\n  scheduledEventTitlePrefix: "▢ "\n  doneEventTitlePrefix: "✅ "\n---\n');
    expect(value.config).toEqual({ scheduledEventTitlePrefix: '▢ ', doneEventTitlePrefix: '✅ ' });
    expect(issues).toEqual([]);
  });

  it('keeps an explicit empty prefix, distinct from an absent one', () => {
    expect(parseManifest('---\nid: work\nconfig:\n  doneEventTitlePrefix: ""\n---\n').value.config).toEqual({ doneEventTitlePrefix: '' });
    expect(parseManifest('---\nid: work\n---\n').value.config).toBeUndefined();
  });

  it('warns on an unknown config key (catches typos) and ignores it', () => {
    const { value, issues } = parseManifest('---\nid: work\nconfig:\n  doneEventTitlePrefx: "✅"\n---\n');
    expect(value.config).toBeUndefined(); // the typo is not applied
    expect(issues.some((i) => i.code === 'unknown_field' && i.field === 'config.doneEventTitlePrefx')).toBe(true);
  });
});

describe('parseConfig', () => {
  it('parses pointers and a default', () => {
    const content = `default: /data/work
pointers:
  - /data/work
  - /data/personal
`;
    const { value, issues } = parseConfig(content);
    expect(value).toEqual({
      default: '/data/work',
      pointers: ['/data/work', '/data/personal'],
    });
    expect(issues).toEqual([]);
  });

  it('treats every field as optional', () => {
    expect(parseConfig('pointers: [/data/a]').value).toEqual({ pointers: ['/data/a'] });
    expect(parseConfig('default: /data/a').value).toEqual({ default: '/data/a' });
  });

  it('yields an empty config with no issues for an empty file', () => {
    const { value, issues } = parseConfig('');
    expect(value).toEqual({});
    expect(issues).toEqual([]);
  });

  it('tolerates a scalar where a pointer list is expected', () => {
    const { value, issues } = parseConfig('pointers: /data/solo');
    expect(value.pointers).toEqual(['/data/solo']);
    expect(issues.some((i) => i.code === 'wrong_type' && i.field === 'pointers')).toBe(true);
  });

  it('keeps a default that is not among the pointers', () => {
    const { value, issues } = parseConfig('default: /data/other\npointers:\n  - /data/work\n');
    expect(value).toEqual({ default: '/data/other', pointers: ['/data/work'] });
    expect(issues).toEqual([]);
  });
});

describe('parser issue reporting', () => {
  it('reports a coerced scalar-where-list as a warning', () => {
    const { issues } = parseEntryBlock('created: 2026-05-05T14:00\nprojects: my-project\n');
    expect(issues.some((i) => i.code === 'wrong_type' && i.field === 'projects')).toBe(true);
  });

  it('reports each dropped malformed related project', () => {
    const content = `---
name: X
created: 2026-05-05T14:00
related_projects:
  - null
  - bare-string
  - project: 2026-04-15-infra
---
body`;
    const { value, issues } = parseProjectFile(content);
    expect(value.frontMatter.related_projects).toEqual([{ project: '2026-04-15-infra', description: '' }]);
    expect(issues.filter((i) => i.code === 'dropped_item')).toHaveLength(2);
  });

  it('reports invalid YAML as an error and still recovers a value', () => {
    const { value, issues } = parseActionFile('---\nname: [unclosed\n  bad: yaml\n---\nbody');
    expect(issues.some((i) => i.code === 'invalid_yaml' && i.severity === 'error')).toBe(true);
    expect(value).toBeDefined();
  });

  it('reports missing required fields', () => {
    const { issues } = parseActionFile('---\nscheduled: 2026-05-10T10:00\n---\nbody');
    const missing = issues.filter((i) => i.code === 'missing_field').map((i) => i.field);
    expect(missing).toContain('name');
    expect(missing).toContain('created');
  });

  it('records nothing for clean data', () => {
    const content = `---
name: Clean
created: 2026-05-05T14:00
---
A clean project.`;
    expect(parseProjectFile(content).issues).toEqual([]);
  });
});

// The systematic guarantee: parsing is total. No input — however malformed —
// may throw. A deterministic fuzzer mutates a valid template plus a corpus of
// adversarial inputs across every parser entry point.
describe('parser totality (never throws)', () => {
  const seeds = [
    '',
    '   ',
    '\n\n',
    '---\n---\n',
    'not yaml at all',
    'name: [unterminated',
    '- just\n- a\n- list',
    'scalar',
    '42',
    'true',
    'null',
    '{}',
    '[]',
    '---\nname:\ncreated:\n---\n',
    '---\nrelated_projects: not-a-list\n---\n',
    '---\nrelated_projects:\n  - 5\n  - null\n---\n',
    'created: 2026-05-05T14:00\nprojects: {a: 1}\nactions: 3\n',
    '```entry\ncreated:\n```',
    '- id:\n  description:',
    ' ￿',
    '---\nname: "\\u',
    ':::::',
    '\t- \t:\n  -',
  ];

  // Deterministic byte mutations of a valid file (no Math.random — reproducible).
  const template = '---\nname: Base\ncreated: 2026-05-05T14:00\n---\nbody text';
  const mutated: string[] = [];
  for (let i = 0; i < template.length; i++) {
    mutated.push(template.slice(0, i) + template.slice(i + 1)); // deletion
    mutated.push(template.slice(0, i) + '\x00' + template.slice(i)); // insertion
    mutated.push(template.slice(0, i) + '[' + template.slice(i + 1)); // corruption
  }

  const parsers: ((s: string) => unknown)[] = [
    (s) => parseEntryBlock(s),
    (s) => parseWeeklyFile(s, 'f.md'),
    (s) => parseProjectFile(s),
    (s) => parseActionFile(s),
    (s) => parseManifest(s),
    (s) => parseConfig(s),
    (s) => parseIndex(s),
    (s) => extractEntryBlocks(s),
  ];

  it('survives an adversarial corpus and byte-level mutations', () => {
    for (const input of [...seeds, ...mutated]) {
      for (const parse of parsers) {
        expect(() => parse(input)).not.toThrow();
      }
    }
  });
});
