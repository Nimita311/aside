import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validate } from '../src/core/validator.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `aside-test-validate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeValidDataset(dir: string): void {
  mkdirSync(join(dir, 'notes', '2026'), { recursive: true });
  mkdirSync(join(dir, 'projects', '2026'), { recursive: true });
  mkdirSync(join(dir, 'actions', '2026'), { recursive: true });

  writeFileSync(
    join(dir, 'aside.md'),
    `---
id: "test"
version: "0.1.0"
name: "Test"
---

Test instance.
`,
  );

  writeFileSync(
    join(dir, 'notes', '2026', '2026-05-04.md'),
    `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Test entry content.
`,
  );

  writeFileSync(
    join(dir, 'notes', '2026', 'index.yaml'),
    `- id: 2026-05-05T14:00
  description: Test entry
`,
  );

  writeFileSync(
    join(dir, 'projects', '2026', '2026-05-05-test-project.md'),
    `---
name: Test Project
created: 2026-05-05T14:00
---

A test project.
`,
  );

  writeFileSync(
    join(dir, 'projects', '2026', 'index.yaml'),
    `- id: 2026-05-05-test-project
  description: A test project
`,
  );

  writeFileSync(
    join(dir, 'actions', '2026', '2026-05-05-test-action.md'),
    `---
name: Test Action
created: 2026-05-05T14:00
scheduled: 2026-05-10T10:00
---

A test action.
`,
  );

  writeFileSync(
    join(dir, 'actions', '2026', 'index.yaml'),
    `- id: 2026-05-05-test-action
  description: A test action
`,
  );
}

describe('validate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('passes on a valid dataset', () => {
    writeValidDataset(tmpDir);
    const result = validate(tmpDir);
    const failures = result.checks.filter((c) => !c.passed);
    if (failures.length > 0) {
      console.log('Unexpected failures:', failures.map((f) => `${f.name}: ${f.details?.join(', ')}`));
    }
    expect(result.passed).toBe(true);
  });

  it.each([
    "created: '2026-05-06T12:00'",
    'created: "2026-05-06T12:00" # timestamp',
    'created: "\\u0032026-05-06T12:00"',
    'created: |-\n  2026-05-06T12:00',
  ])('validates decoded timestamps and ordering (%j)', (created) => {
    writeValidDataset(tmpDir);
    writeFileSync(join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---\nweek: 18\nweek_start: 2026-05-04\nweek_end: 2026-05-10\n---\n\n` +
      `---\n\`\`\`entry\n${created}\n\`\`\`\n\nLatest note.\n\n` +
      `---\n\`\`\`entry\ncreated: 2026-05-05T14:00\nprojects: [2026-05-05-test-project]\nactions: [2026-05-05-test-action]\n\`\`\`\n\nEarlier note.\n`);
    writeFileSync(join(tmpDir, 'notes', '2026', 'index.yaml'),
      '- id: 2026-05-06T12:00\n  description: Latest note\n- id: 2026-05-05T14:00\n  description: Earlier note\n');
    expect(validate(tmpDir).checks.filter(check => !check.passed)).toEqual([]);
  });

  it('detects incorrect entry order regardless of YAML timestamp quoting', () => {
    writeValidDataset(tmpDir);
    writeFileSync(join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---\nweek: 18\nweek_start: 2026-05-04\nweek_end: 2026-05-10\n---\n\n` +
      `---\n\`\`\`entry\ncreated: 2026-05-05T14:00\n\`\`\`\n\nEarlier note.\n\n` +
      `---\n\`\`\`entry\ncreated: "2026-05-06T12:00"\n\`\`\`\n\nLatest note.\n`);
    const result = validate(tmpDir);
    expect(result.checks.find(check => check.name === 'Created timestamps are ISO 8601 minute precision')?.passed).toBe(true);
    expect(result.checks.find(check => check.name === 'Entries in reverse chronological order')).toMatchObject({
      passed: false,
      details: ["2026-05-04.md: '2026-05-05T14:00' before '2026-05-06T12:00'"],
    });
  });

  it('detects a missing aside.md manifest', () => {
    writeValidDataset(tmpDir);
    rmSync(join(tmpDir, 'aside.md'));
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Instance has an aside.md manifest');
    expect(check?.passed).toBe(false);
    expect(result.dataChecksRun).toBe(false);
    expect(result.checks).toHaveLength(1);
  });

  it('rejects an aside.md with no front matter (agrees with isAsideDir)', () => {
    writeValidDataset(tmpDir);
    writeFileSync(join(tmpDir, 'aside.md'), '# Notes\nJust prose, no front matter.\n');
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Instance has an aside.md manifest');
    expect(check?.passed).toBe(false);
    expect(result.dataChecksRun).toBe(false);
    expect(result.checks).toHaveLength(1);
  });

  it.each(['empty directory', 'nonexistent directory', 'unreadable manifest'])('blocks data checks for an %s', reason => {
    let dir = tmpDir;
    if (reason === 'nonexistent directory') dir = join(tmpDir, 'missing');
    // A directory in place of the file produces a deterministic read failure.
    if (reason === 'unreadable manifest') mkdirSync(join(tmpDir, 'aside.md'));
    const result = validate(dir);
    expect(result).toMatchObject({ passed: false, dataChecksRun: false });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: 'Instance has an aside.md manifest', passed: false });
    expect(result.checks[0].details?.length).toBeGreaterThan(0);
  });

  it('fails when the manifest is missing the required id', () => {
    writeValidDataset(tmpDir);
    writeFileSync(join(tmpDir, 'aside.md'), '---\nname: "Test"\n---\n');
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Instance has an aside.md manifest');
    expect(check?.passed).toBe(false);
    expect(result.dataChecksRun).toBe(true);
    expect(result.checks.length).toBeGreaterThan(1);
  });

  it('reports data problems alongside invalid manifest metadata in a recognized instance', () => {
    writeValidDataset(tmpDir);
    writeFileSync(join(tmpDir, 'aside.md'), '---\nid: INVALID\n---\n');
    rmSync(join(tmpDir, 'actions', '2026', '2026-05-05-test-action.md'));
    const result = validate(tmpDir);
    expect(result).toMatchObject({ passed: false, dataChecksRun: true });
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'Instance has an aside.md manifest', passed: false }));
    expect(result.checks).toContainEqual(expect.objectContaining({ name: 'Referenced actions have files', passed: false }));
  });

  // --- Consistency checks ---

  it('detects missing action file', () => {
    writeValidDataset(tmpDir);
    rmSync(join(tmpDir, 'actions', '2026', '2026-05-05-test-action.md'));
    const result = validate(tmpDir);
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.name === 'Referenced actions have files');
    expect(check?.passed).toBe(false);
    expect(check?.details).toEqual(expect.arrayContaining([expect.stringContaining('references missing action 2026-05-05-test-action')]));
  });

  it('detects missing project file', () => {
    writeValidDataset(tmpDir);
    rmSync(join(tmpDir, 'projects', '2026', '2026-05-05-test-project.md'));
    const result = validate(tmpDir);
    expect(result.passed).toBe(false);
    const check = result.checks.find((c) => c.name === 'Referenced projects have files');
    expect(check?.passed).toBe(false);
  });

  it('detects unreferenced action files', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'actions', '2026', '2026-05-06-orphan-action.md'),
      `---
name: Orphan Action
created: 2026-05-06T10:00
---

Nobody references me.
`,
    );
    writeFileSync(
      join(tmpDir, 'actions', '2026', 'index.yaml'),
      `- id: 2026-05-05-test-action
  description: A test action
- id: 2026-05-06-orphan-action
  description: Nobody references me
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'All action files referenced by entries');
    expect(check?.passed).toBe(false);
    expect(check?.details).toContain('2026-05-06-orphan-action');
  });

  it('treats missing index files as an empty index (parity with the parser)', () => {
    // The Store reads a missing index.yaml as zero indexed entries — "no index =
    // no entry". An instance with no notes/projects/actions and no index files is
    // therefore valid: the (empty) index trivially matches the (empty) files.
    mkdirSync(join(tmpDir, 'notes'), { recursive: true });
    mkdirSync(join(tmpDir, 'projects'), { recursive: true });
    mkdirSync(join(tmpDir, 'actions'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'aside.md'),
      `---
id: "test"
version: "0.1.0"
name: "Test"
---

Empty instance.
`,
    );
    const result = validate(tmpDir);
    for (const name of [
      'Notes index count matches entries',
      'Notes index IDs match entries',
      'Project index matches files',
      'Action index matches files',
    ]) {
      const check = result.checks.find((c) => c.name === name);
      expect(check?.passed, `${name} should pass for an empty instance`).toBe(true);
    }
  });

  it('still flags entries present with no index file at all', () => {
    // A missing index is only valid when there is nothing to index; if entries
    // exist, the empty index no longer matches and the check must fail.
    writeValidDataset(tmpDir);
    rmSync(join(tmpDir, 'notes', '2026', 'index.yaml'));
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Notes index count matches entries');
    expect(check?.passed).toBe(false);
  });

  it('detects note index count mismatch', () => {
    writeValidDataset(tmpDir);
    writeFileSync(join(tmpDir, 'notes', '2026', 'index.yaml'), '');
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Notes index count matches entries');
    expect(check?.passed).toBe(false);
  });

  it('detects note index ID mismatch', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', 'index.yaml'),
      `- id: 2026-05-05T99:99
  description: Wrong ID
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Notes index IDs match entries');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('In index but not files'))).toBe(true);
  });

  it('detects project index mismatch with files', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', 'index.yaml'),
      `- id: 2026-05-05-nonexistent
  description: Ghost project
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Project index matches files');
    expect(check?.passed).toBe(false);
  });

  it('detects duplicate timestamps', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-04-27.md'),
      `---
week: 17
week_start: 2026-04-27
week_end: 2026-05-03
---

---
\`\`\`entry
created: 2026-05-05T14:00
\`\`\`

Duplicate!
`,
    );
    writeFileSync(
      join(tmpDir, 'notes', '2026', 'index.yaml'),
      `- id: 2026-05-05T14:00
  description: Test entry
- id: 2026-05-05T14:00
  description: Duplicate
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'No duplicate entry IDs');
    expect(check?.passed).toBe(false);
  });

  it('detects entry in wrong weekly file', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-12T10:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Wrong week.
`,
    );
    writeFileSync(
      join(tmpDir, 'notes', '2026', 'index.yaml'),
      `- id: 2026-05-12T10:00
  description: Wrong week entry
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Entries in correct weekly file');
    expect(check?.passed).toBe(false);
  });

  it('detects weekly front matter inconsistency', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-05
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Content.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Weekly front matter is self-consistent');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('week_start='))).toBe(true);
  });

  it('detects project created date mismatch with date code', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-test-project.md'),
      `---
name: Test Project
created: 2026-05-01T10:00
---

Date code says 05-05 but created says 05-01.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Project date codes match created dates');
    expect(check?.passed).toBe(false);
  });

  it('detects inline mentions referencing non-existent entities', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Check out #project/2026-01-01-ghost and #action/2026-01-01-phantom for details.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Inline mentions reference existing entities');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('#project/2026-01-01-ghost'))).toBe(true);
    expect(check?.details?.some((d) => d.includes('#action/2026-01-01-phantom'))).toBe(true);
  });

  it('matches inline mentions of Unicode slugs whole (no truncation)', () => {
    // toKebabCase deliberately produces Unicode slugs; the mention pattern must
    // capture the full slug, not stop at the first non-ASCII character.
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-café-plan.md'),
      `---
name: Café Plan
created: 2026-05-05T15:00
---

A project with a Unicode slug.
`,
    );
    writeFileSync(
      join(tmpDir, 'projects', '2026', 'index.yaml'),
      `- id: 2026-05-05-café-plan
  description: A project with a Unicode slug
- id: 2026-05-05-test-project
  description: A test project
`,
    );
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

See #project/2026-05-05-café-plan for details.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Inline mentions reference existing entities');
    expect(check?.passed).toBe(true);
  });

  it('matches inline mentions of underscored ids whole (hand-created files)', () => {
    // toKebabCase never emits `_`, but a hand-created file's id is its filename
    // stem; a mention of it must not truncate at the underscore.
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-foo_bar.md'),
      `---
name: Foo Bar
created: 2026-05-05T15:00
---

A hand-created project with an underscore.
`,
    );
    writeFileSync(
      join(tmpDir, 'projects', '2026', 'index.yaml'),
      `- id: 2026-05-05-foo_bar
  description: A hand-created project
- id: 2026-05-05-test-project
  description: A test project
`,
    );
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

See #project/2026-05-05-foo_bar for details.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Inline mentions reference existing entities');
    expect(check?.passed).toBe(true);
  });

  it('does not misread a quoted entry example after a --- rule as an entry', () => {
    // A bare `---` rule followed (after prose) by an indented ```entry example is
    // ordinary content: no phantom entry, no false format failures.
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Documenting the format.

---

An entry looks like this:

    \`\`\`entry
    created: 2020-01-01T00:00
    projects:
      - not-a-real-project
    \`\`\`

End of example.
`,
    );
    const result = validate(tmpDir);
    const failures = result.checks.filter((c) => !c.passed);
    if (failures.length > 0) {
      console.log('Unexpected failures:', failures.map((f) => `${f.name}: ${f.details?.join(', ')}`));
    }
    expect(result.passed).toBe(true);
  });

  it('detects related projects referencing non-existent projects', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-test-project.md'),
      `---
name: Test Project
created: 2026-05-05T14:00
related_projects:
  - project: 2026-01-01-does-not-exist
    description: This project does not exist
---

A test project.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Related projects reference existing projects');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('2026-01-01-does-not-exist'))).toBe(true);
  });

  it('ignores "project:" in prose — only parsed related_projects count', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-test-project.md'),
      `---
name: Test Project
created: 2026-05-05T14:00
---

Notes to self: the legacy config had a line like \`project: 2026-01-01-ghost\`
and another line saying project: 2026-05-05-test-project — neither is a
related-projects declaration.
`,
    );
    const result = validate(tmpDir);
    expect(result.checks.find((c) => c.name === 'Related projects reference existing projects')?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === 'No self-references')?.passed).toBe(true);
  });

  it('detects self-references in projects', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-test-project.md'),
      `---
name: Test Project
created: 2026-05-05T14:00
related_projects:
  - project: 2026-05-05-test-project
    description: I reference myself
---

A test project.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'No self-references');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('references itself'))).toBe(true);
  });

  it('does not flag a block-style related_projects as an empty field', () => {
    writeValidDataset(tmpDir);
    // `related_projects:` on its own line is a block-sequence parent, not an
    // empty field — its value is the indented items below it.
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-test-project.md'),
      `---
name: Test Project
created: 2026-05-05T14:00
related_projects:
  - project: 2026-05-05-test-project-b
    description: A sibling project
---

A test project.
`,
    );
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-test-project-b.md'),
      `---
name: Test Project B
created: 2026-05-05T14:00
---

A sibling.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'No empty fields in project front matter');
    expect(check?.passed).toBe(true);
  });

  it('still flags a bare key with no block beneath it as empty', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-test-project.md'),
      `---
name: Test Project
created: 2026-05-05T14:00
related_projects:
---

A test project.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'No empty fields in project front matter');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('related_projects'))).toBe(true);
  });

  // --- Format checks ---

  it('detects non-Monday weekly filename', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-05.md'),
      `---
week: 18
week_start: 2026-05-05
week_end: 2026-05-11
---
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Weekly filenames are Monday dates');
    expect(check?.passed).toBe(false);
  });

  it('detects bad created format', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Content.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Created timestamps are ISO 8601 minute precision');
    expect(check?.passed).toBe(false);
  });

  it('detects out-of-range created timestamps that pass the shape check', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-13-40T25:61
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Right shape, impossible date.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Created timestamps are ISO 8601 minute precision');
    expect(check?.passed).toBe(false);
  });

  it('detects a day out of range for its month (2026-02-31)', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-02-31T10:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

February has no 31st; per-field bounds alone miss this.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Created timestamps are ISO 8601 minute precision');
    expect(check?.passed).toBe(false);
  });

  it('detects entries out of reverse chronological order', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-04T09:00
projects: [2026-05-05-test-project]
\`\`\`

Earlier entry first (wrong order).

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Later entry second (wrong order).
`,
    );
    writeFileSync(
      join(tmpDir, 'notes', '2026', 'index.yaml'),
      `- id: 2026-05-04T09:00
  description: Earlier entry
- id: 2026-05-05T14:00
  description: Test entry
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Entries in reverse chronological order');
    expect(check?.passed).toBe(false);
  });

  it('orders the action index by created timestamp to the minute (same-day)', () => {
    // Two actions created the same day. The index id (`date-slug`) only reveals
    // the day, so order is judged by each file's `created` minute. Here the newer
    // action ("apple", 15:00) is listed above the older ("zebra", 14:00) — correct
    // newest-first, even though "apple" sorts earlier alphabetically.
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'actions', '2026', '2026-05-05-apple-task.md'),
      `---\nname: Apple Task\ncreated: 2026-05-05T15:00\n---\n\nApple.\n`,
    );
    writeFileSync(
      join(tmpDir, 'actions', '2026', '2026-05-05-zebra-task.md'),
      `---\nname: Zebra Task\ncreated: 2026-05-05T14:00\n---\n\nZebra.\n`,
    );
    writeFileSync(
      join(tmpDir, 'actions', '2026', 'index.yaml'),
      `- id: 2026-05-05-apple-task\n  description: Apple\n- id: 2026-05-05-zebra-task\n  description: Zebra\n`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Action index in reverse chronological order');
    expect(check?.passed).toBe(true);
  });

  it('detects a same-day action index out of created order (minute inversion)', () => {
    // Same day, but the OLDER action (14:00) is listed above the newer one (15:00).
    // The day-level id can't reveal this; resolving to `created` must catch it.
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'actions', '2026', '2026-05-05-apple-task.md'),
      `---\nname: Apple Task\ncreated: 2026-05-05T14:00\n---\n\nApple.\n`,
    );
    writeFileSync(
      join(tmpDir, 'actions', '2026', '2026-05-05-zebra-task.md'),
      `---\nname: Zebra Task\ncreated: 2026-05-05T15:00\n---\n\nZebra.\n`,
    );
    writeFileSync(
      join(tmpDir, 'actions', '2026', 'index.yaml'),
      `- id: 2026-05-05-apple-task\n  description: Apple\n- id: 2026-05-05-zebra-task\n  description: Zebra\n`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Action index in reverse chronological order');
    expect(check?.passed).toBe(false);
  });

  it('still detects cross-day action index entries out of reverse-chron order', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'actions', '2026', '2026-05-04-old-task.md'),
      `---\nname: Old Task\ncreated: 2026-05-04T09:00\n---\n\nOld.\n`,
    );
    // Older date listed ABOVE the newer one — a genuine reverse-chron violation.
    writeFileSync(
      join(tmpDir, 'actions', '2026', 'index.yaml'),
      `- id: 2026-05-04-old-task\n  description: Old\n- id: 2026-05-05-test-action\n  description: A test action\n`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Action index in reverse chronological order');
    expect(check?.passed).toBe(false);
  });

  it('detects a notes index out of reverse chronological order (minute precision)', () => {
    // Two entries one minute apart. A note's index id IS its created timestamp,
    // so the index must list 14:01 before 14:00; here it is reversed and must be
    // flagged — the same minute-accurate rule applied to projects and actions.
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:01
\`\`\`

Newer entry first.

---
\`\`\`entry
created: 2026-05-05T14:00
\`\`\`

Older entry second.
`,
    );
    // Index has both ids but in the wrong (oldest-first) order.
    writeFileSync(
      join(tmpDir, 'notes', '2026', 'index.yaml'),
      `- id: 2026-05-05T14:00
  description: Older
- id: 2026-05-05T14:01
  description: Newer
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Notes index in reverse chronological order');
    expect(check?.passed).toBe(false);
  });

  it('accepts a notes index in reverse chronological order', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:01
\`\`\`

Newer entry first.

---
\`\`\`entry
created: 2026-05-05T14:00
\`\`\`

Older entry second.
`,
    );
    writeFileSync(
      join(tmpDir, 'notes', '2026', 'index.yaml'),
      `- id: 2026-05-05T14:01
  description: Newer
- id: 2026-05-05T14:00
  description: Older
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Notes index in reverse chronological order');
    expect(check?.passed).toBe(true);
  });

  it('detects action created date mismatch with date code', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'actions', '2026', '2026-05-05-test-action.md'),
      `---
name: Test Action
created: 2026-05-01T10:00
scheduled: 2026-05-10T10:00
---

Date code mismatch.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Action date codes match created dates');
    expect(check?.passed).toBe(false);
  });

  it('detects action filename without date prefix', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'actions', '2026', 'no-date-prefix.md'),
      `---
name: No Date Prefix
created: 2026-05-05T10:00
---

Missing the date prefix.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Action filenames have date prefix');
    expect(check?.passed).toBe(false);
    expect(check?.details).toContain('no-date-prefix.md');
  });

  it('detects missing weekly front matter fields', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Content.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Weekly files have required front matter');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('week_start') && d.includes('week_end'))).toBe(true);
  });

  it('treats an empty required front-matter field as missing', () => {
    writeValidDataset(tmpDir);
    // week_start is present as a key but has no value — an empty field reads as absent.
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start:
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Content.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Weekly files have required front matter');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('week_start'))).toBe(true);
  });

  it('detects empty fields in entry metadata', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: []
actions: [2026-05-05-test-action]
\`\`\`

Empty projects list should be omitted.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'No empty fields in entry metadata');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('projects: []'))).toBe(true);
  });

  it('detects multi-line list syntax in entry metadata', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects:
  - 2026-05-05-test-project
actions: [2026-05-05-test-action]
\`\`\`

Multi-line list should be inline.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Entry metadata uses inline YAML list syntax');
    expect(check?.passed).toBe(false);
  });

  it('detects entity date code mismatch with earliest entry', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-07T10:00
projects: [2026-05-05-test-project]
actions: [2026-05-05-test-action]
\`\`\`

Entry date is 05-07 but action date code is 05-05.
`,
    );
    writeFileSync(
      join(tmpDir, 'notes', '2026', 'index.yaml'),
      `- id: 2026-05-07T10:00
  description: Mismatched date
`,
    );
    const result = validate(tmpDir);
    // The action's created date (05-05) still matches its date code — this is valid
    // The entry referencing it on 05-07 is fine (actions can be referenced after creation)
    const actionCheck = result.checks.find((c) => c.name === 'Action date codes match created dates');
    expect(actionCheck?.passed).toBe(true);
  });

  // --- Parse/validation parity ---
  // The validator and the live Store share one parser, so anything the parser
  // tolerates is surfaced here rather than silently passing.

  it('reports invalid YAML as a structural error without crashing', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-test-project.md'),
      `---
name: [unterminated
  created: 2026-05-05T14:00
---

Broken front matter.
`,
    );
    let result!: ReturnType<typeof validate>;
    expect(() => { result = validate(tmpDir); }).not.toThrow();
    const check = result.checks.find((c) => c.name === 'Files load without structural errors');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('2026-05-05-test-project.md'))).toBe(true);
  });

  it('reports a coerced scalar-where-list as a recovered-value warning', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
created: 2026-05-05T14:00
projects: 2026-05-05-test-project
\`\`\`

Scalar where a list belongs.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Front matter parses without recovery');
    expect(check?.passed).toBe(false);
  });

  it('reports a missing required field as a structural error (parity with the Store)', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'notes', '2026', '2026-05-04.md'),
      `---
week: 18
week_start: 2026-05-04
week_end: 2026-05-10
---

---
\`\`\`entry
projects: [2026-05-05-test-project]
\`\`\`

Entry with no created field.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Files load without structural errors');
    expect(check?.passed).toBe(false);
    expect(check?.details?.some((d) => d.includes('created'))).toBe(true);
  });

  it('reports a dropped malformed related project', () => {
    writeValidDataset(tmpDir);
    writeFileSync(
      join(tmpDir, 'projects', '2026', '2026-05-05-test-project.md'),
      `---
name: Test Project
created: 2026-05-05T14:00
related_projects:
  - null
---

Malformed related project entry.
`,
    );
    const result = validate(tmpDir);
    const check = result.checks.find((c) => c.name === 'Front matter parses without recovery');
    expect(check?.passed).toBe(false);
  });
});
