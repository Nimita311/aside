import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/mcp/store.js';

describe('Store', () => {
  let tempDir: string;
  let store: Store;

  beforeAll(() => {
    tempDir = join(tmpdir(), `aside-store-test-${Date.now()}`);

    // Create directory structure
    mkdirSync(join(tempDir, 'notes', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'projects', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'actions', '2026'), { recursive: true });

    // Create note index
    writeFileSync(
      join(tempDir, 'notes', '2026', 'index.yaml'),
      `- id: w18\n  description: "Week 18 notes"\n`
    );

    // Create a weekly file with an entry referencing a project and action
    writeFileSync(
      join(tempDir, 'notes', '2026', 'w18.md'),
      `---
week: 18
week_start: "2026-04-27"
week_end: "2026-05-03"
---

\`\`\`entry
created: "2026-04-28T10:00:00"
projects:
  - my-project
actions:
  - my-action
\`\`\`

Worked on the project task today.

---

\`\`\`entry
created: "2026-04-29T14:00:00"
projects:
  - my-project
  - other-project
actions:
  - other-action
\`\`\`

Did some more work across projects.
`
    );

    // Create project index
    writeFileSync(
      join(tempDir, 'projects', '2026', 'index.yaml'),
      `- id: my-project\n  description: "My test project"\n- id: other-project\n  description: "Another project"\n`
    );

    // Create project files
    writeFileSync(
      join(tempDir, 'projects', '2026', 'my-project.md'),
      `---
name: "My Project"
created: "2026-01-01"
---

This is the project body.
`
    );

    writeFileSync(
      join(tempDir, 'projects', '2026', 'other-project.md'),
      `---
name: "Other Project"
created: "2026-02-15"
---

Another project body.
`
    );

    // Create action index
    writeFileSync(
      join(tempDir, 'actions', '2026', 'index.yaml'),
      `- id: my-action\n  description: "My test action"\n- id: other-action\n  description: "Another action"\n`
    );

    // Create action files
    writeFileSync(
      join(tempDir, 'actions', '2026', 'my-action.md'),
      `---
name: "My Action"
created: "2026-04-28"
scheduled: "2026-05-01"
---

Action body content.
`
    );

    writeFileSync(
      join(tempDir, 'actions', '2026', 'other-action.md'),
      `---
name: "Other Action"
created: "2026-04-29"
---

Other action body.
`
    );

    writeFileSync(
      join(tempDir, 'aside.md'),
      `---
version: "0.1.0"
name: "Test Instance"
description: "A store fixture."
---

Body.
`
    );

    store = new Store(tempDir);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('basic loading', () => {
    it('loads entries from weekly files', () => {
      const entries = store.getEntries();
      expect(entries).toHaveLength(2);
    });

    it('sorts entries reverse chronologically', () => {
      const entries = store.getEntries();
      expect(entries[0].meta.created).toBe('2026-04-29T14:00:00');
      expect(entries[1].meta.created).toBe('2026-04-28T10:00:00');
    });

    it('loads projects', () => {
      expect(store.getProjectIds()).toContain('my-project');
      expect(store.getProjectIds()).toContain('other-project');
      const proj = store.getProject('my-project');
      expect(proj).toBeDefined();
      expect(proj!.frontMatter.name).toBe('My Project');
      expect(proj!.body).toBe('This is the project body.');
    });

    it('loads actions', () => {
      expect(store.getActionIds()).toContain('my-action');
      expect(store.getActionIds()).toContain('other-action');
      const action = store.getAction('my-action');
      expect(action).toBeDefined();
      expect(action!.frontMatter.name).toBe('My Action');
      expect(action!.frontMatter.scheduled).toBe('2026-05-01');
    });

    it('returns undefined for unknown project/action', () => {
      expect(store.getProject('nonexistent')).toBeUndefined();
      expect(store.getAction('nonexistent')).toBeUndefined();
    });

    it('loads note index', () => {
      const index = store.getNoteIndex();
      expect(index).toHaveLength(1);
      expect(index[0].id).toBe('w18');
    });

    it('loads project index', () => {
      const index = store.getProjectIndex();
      expect(index).toHaveLength(2);
      expect(index[0].id).toBe('my-project');
    });

    it('loads action index', () => {
      const index = store.getActionIndex();
      expect(index).toHaveLength(2);
      expect(index[0].id).toBe('my-action');
    });

    it('returns the data directory', () => {
      expect(store.getDataDir()).toBe(tempDir);
    });

    it('exposes the instance manifest', () => {
      const m = store.getManifest();
      expect(m.version).toBe('0.1.0');
      expect(m.name).toBe('Test Instance');
      expect(m.description).toBe('A store fixture.');
    });
  });

  describe('relationship maps', () => {
    it('derives actions for a project from entry co-occurrence', () => {
      // Entry 1 has my-project + my-action
      // Entry 2 has my-project + other-action
      const actions = store.getActionsForProject('my-project');
      expect(actions).toContain('my-action');
      expect(actions).toContain('other-action');
      expect(actions).toHaveLength(2);
    });

    it('derives projects for an action from entry co-occurrence', () => {
      // Entry 1 has my-action + my-project
      const projects = store.getProjectsForAction('my-action');
      expect(projects).toContain('my-project');
      expect(projects).toHaveLength(1);
    });

    it('derives multiple projects for an action', () => {
      // Entry 2 has other-action + my-project + other-project
      const projects = store.getProjectsForAction('other-action');
      expect(projects).toContain('my-project');
      expect(projects).toContain('other-project');
      expect(projects).toHaveLength(2);
    });

    it('returns empty array for project with no actions', () => {
      expect(store.getActionsForProject('nonexistent')).toEqual([]);
    });

    it('returns empty array for action with no projects', () => {
      expect(store.getProjectsForAction('nonexistent')).toEqual([]);
    });
  });

  describe('rebuild', () => {
    it('reloads data from disk', () => {
      // Add a new entry file
      writeFileSync(
        join(tempDir, 'notes', '2026', 'w19.md'),
        `---
week: 19
week_start: "2026-05-04"
week_end: "2026-05-10"
---

\`\`\`entry
created: "2026-05-05T09:00:00"
projects:
  - my-project
actions:
  - my-action
\`\`\`

New week entry.
`
      );

      store.rebuild();
      const entries = store.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0].meta.created).toBe('2026-05-05T09:00:00');
    });
  });
});

describe('Store parse issues', () => {
  it('loads malformed files best-effort and records tagged issues', () => {
    const dir = join(tmpdir(), `aside-store-issues-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, 'projects', '2026'), { recursive: true });
    // A project missing its required name, with a malformed related_projects item.
    writeFileSync(
      join(dir, 'projects', '2026', '2026-05-05-broken.md'),
      `---
created: 2026-05-05T14:00
related_projects:
  - null
---
body`,
    );

    let store!: Store;
    expect(() => { store = new Store(dir); }).not.toThrow();

    // The project still loads (best-effort), just without a name.
    expect(store.getProject('2026-05-05-broken')).toBeDefined();

    const issues = store.getIssues();
    expect(issues.some((i) => i.code === 'missing_field' && i.field === 'name')).toBe(true);
    expect(issues.some((i) => i.code === 'dropped_item')).toBe(true);
    // Issues are tagged with the file they came from.
    expect(issues.every((i) => typeof i.file === 'string' && i.file.length > 0)).toBe(true);

    store.close();
    rmSync(dir, { recursive: true });
  });

  it('reports no issues for clean data', () => {
    const dir = join(tmpdir(), `aside-store-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, 'projects', '2026'), { recursive: true });
    writeFileSync(
      join(dir, 'projects', '2026', '2026-05-05-clean.md'),
      `---\nname: Clean\ncreated: 2026-05-05T14:00\n---\nbody`,
    );
    const store = new Store(dir);
    expect(store.getIssues()).toEqual([]);
    store.close();
    rmSync(dir, { recursive: true });
  });

  it('surfaces files the reader could not read as issues', () => {
    // Root can read anything, so the chmod trick is meaningless there (CI).
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const dir = join(tmpdir(), `aside-store-unreadable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, 'projects', '2026'), { recursive: true });
    writeFileSync(
      join(dir, 'projects', '2026', '2026-05-05-ok.md'),
      `---\nname: OK\ncreated: 2026-05-05T14:00\n---\nbody`,
    );
    const blocked = join(dir, 'projects', '2026', '2026-05-06-blocked.md');
    writeFileSync(blocked, `---\nname: Blocked\ncreated: 2026-05-06T14:00\n---\nbody`);
    chmodSync(blocked, 0o000);
    try {
      const store = new Store(dir);
      // The readable file still loads; the unreadable one is an issue, not a crash.
      expect(store.getProject('2026-05-05-ok')).toBeDefined();
      expect(store.getIssues().some((i) => i.code === 'read_error' && i.file?.includes('2026-05-06-blocked'))).toBe(true);
      store.close();
    } finally {
      chmodSync(blocked, 0o644);
      rmSync(dir, { recursive: true });
    }
  });
});

describe('Store synchronous updates', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = join(tmpdir(), `aside-store-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    store = new Store(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves a project to disk and memory, with its index entry', () => {
    const file = join(dir, 'projects', '2026', 'p1.md');
    store.saveProject('p1', { name: 'P One', created: '2026-05-05T10:00' }, '  body  ', file);
    store.addIndexEntry('projects', file, 'p1', 'First project');
    // Memory.
    expect(store.getProject('p1')?.frontMatter.name).toBe('P One');
    expect(store.getProject('p1')?.body).toBe('body'); // trimmed, as the parser would
    expect(store.getProjectFile('p1')).toBe(file);
    expect(store.getProjectIndex()[0]).toEqual({ id: 'p1', description: 'First project' });
    // Disk: a rebuild from the just-written files agrees with memory.
    store.rebuild();
    expect(store.getProject('p1')?.frontMatter.name).toBe('P One');
    expect(store.getProjectIndex().find(i => i.id === 'p1')?.description).toBe('First project');
  });

  it('saves an action, replacing it on a second save', () => {
    const file = join(dir, 'actions', '2026', 'a1.md');
    store.saveAction('a1', { name: 'A One', created: '2026-05-05T10:00', scheduled: '2026-05-10' }, 'do it', file);
    expect(store.getAction('a1')?.frontMatter.scheduled).toBe('2026-05-10');
    store.saveAction('a1', { name: 'A One', created: '2026-05-05T10:00' }, 'done', file);
    expect(store.getAction('a1')?.frontMatter.scheduled).toBeUndefined(); // replaced, not merged
    expect(store.getActionIds().filter(id => id === 'a1')).toHaveLength(1);
  });

  it('saves an entry, deriving relationships and keeping reverse order', () => {
    const file = join(dir, 'notes', '2026', '2026-05-04.md');
    store.saveEntry('2026-05-05T09:00', ['proj'], ['act'], 'first', file, weekly('2026-05-05T09:00', 'first', ['proj'], ['act']));
    store.saveEntry('2026-05-06T09:00', ['proj'], [], 'second', file, weekly('2026-05-06T09:00', 'second', ['proj']));
    expect(store.getEntries().map(e => e.meta.created)).toEqual(['2026-05-06T09:00', '2026-05-05T09:00']);
    expect(store.getActionsForProject('proj')).toEqual(['act']);
    expect(store.getProjectsForAction('act')).toEqual(['proj']);
  });

  it('re-derives relationships when an entry is amended', () => {
    const file = join(dir, 'notes', '2026', '2026-05-04.md');
    store.saveEntry('2026-05-05T09:00', ['proj'], ['act-old'], 'v1', file, weekly('2026-05-05T09:00', 'v1', ['proj'], ['act-old']));
    expect(store.getActionsForProject('proj')).toEqual(['act-old']);
    // Amend the same entry (same created) with a different action — the stale link drops.
    store.saveEntry('2026-05-05T09:00', ['proj'], ['act-new'], 'v2', file, weekly('2026-05-05T09:00', 'v2', ['proj'], ['act-new']));
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].content).toBe('v2');
    expect(store.getActionsForProject('proj')).toEqual(['act-new']);
  });

  it('updates an index description in place, collapsing newlines', () => {
    const file = join(dir, 'actions', '2026', 'a1.md');
    store.saveAction('a1', { name: 'A One', created: '2026-05-05T10:00' }, 'body', file);
    store.addIndexEntry('actions', file, 'a1', 'old');
    store.setIndexEntry('actions', 'a1', 'new\ndescription');
    expect(store.getActionIndex()[0].description).toBe('new description');
    store.setIndexEntry('actions', 'missing', 'noop'); // no-op when absent
    expect(store.getActionIndex()).toHaveLength(1);
  });

  const indexLayouts = [
    { name: 'single-quoted ID and inline comments', render: (id: string) => `- id: '${id}' # identity\n  description: Old description # summary\n` },
    { name: 'reordered fields', render: (id: string) => `- description: Old description\n  id: '${id}'\n` },
    { name: 'literal block description', render: (id: string) => `- id: '${id}'\n  description: |- # summary\n    Old\n    description\n` },
    { name: 'folded block description', render: (id: string) => `- description: >-\n    Old\n    description\n  id: '${id}'\n` },
    { name: 'flow mapping', render: (id: string) => `- {description: Old description, id: '${id}'}\n` },
  ];
  for (const kind of ['actions', 'projects', 'artifacts', 'notes'] as const) {
    it.each(indexLayouts)(`persists ${kind} description updates with $name across rebuild`, ({ render }) => {
      const id = kind === 'notes' ? '2026-05-05T09:00' : '2026-05-05-record';
      const file = join(dir, kind, '2026', kind === 'notes' ? '2026-05-04.md' : `${id}.md`);
      const fm = { name: 'Record', created: '2026-05-05T09:00' };
      if (kind === 'notes') store.saveEntry(id, [], [], 'body', file, weekly(id, 'body'));
      else if (kind === 'actions') store.saveAction(id, fm, 'body', file);
      else if (kind === 'projects') store.saveProject(id, fm, 'body', file);
      else store.saveArtifact(id, fm, 'body', file);
      const indexPath = join(dir, kind, '2026', 'index.yaml');
      const unrelated = "- id: unrelated\n  description: 'Keep this formatting' # untouched\n";
      writeFileSync(indexPath, render(id) + unrelated);
      store.rebuild();
      expect(store.setIndexEntry(kind, id, 'New\ndescription: ready #1')).toBe(true);
      expect(readFileSync(indexPath, 'utf8')).toContain(unrelated);
      store.rebuild();
      const index = kind === 'notes' ? store.getNoteIndex() : kind === 'actions' ? store.getActionIndex()
        : kind === 'projects' ? store.getProjectIndex() : store.getArtifactIndex();
      expect(index.find((item) => item.id === id)?.description).toBe('New description: ready #1');
    });
  }

  it.each(['missing file', 'missing item'])('keeps cached descriptions unchanged when the disk index has a %s', (type) => {
    const file = join(dir, 'actions', '2026', 'a1.md');
    const index = join(dir, 'actions', '2026', 'index.yaml');
    store.saveAction('a1', { name: 'A One', created: '2026-05-05T10:00' }, 'body', file);
    store.addIndexEntry('actions', file, 'a1', 'Old description');
    if (type === 'missing file') rmSync(index);
    else writeFileSync(index, '- id: other\n  description: Keep me\n');
    expect(store.setIndexEntry('actions', 'a1', 'New description')).toBe(false);
    expect(store.getActionIndex().find((item) => item.id === 'a1')?.description).toBe('Old description');
  });

  it('does not claim a cached index-only entity was persisted without an entity file', () => {
    mkdirSync(join(dir, 'actions', '2026'), { recursive: true });
    writeFileSync(join(dir, 'actions', '2026', 'index.yaml'), '- id: absent\n  description: Old description\n');
    store.rebuild();
    expect(store.setIndexEntry('actions', 'absent', 'New description')).toBe(false);
    expect(store.getActionIndex()[0].description).toBe('Old description');
  });

  it('preserves disk and cached descriptions when malformed YAML prevents an update', () => {
    const file = join(dir, 'actions', '2026', 'a1.md');
    const index = join(dir, 'actions', '2026', 'index.yaml');
    store.saveAction('a1', { name: 'A One', created: '2026-05-05T10:00' }, 'body', file);
    store.addIndexEntry('actions', file, 'a1', 'Old description');
    const malformed = "- id: a1\n  description: [unterminated\n";
    writeFileSync(index, malformed);
    expect(store.setIndexEntry('actions', 'a1', 'New description')).toBe(false);
    expect(readFileSync(index, 'utf8')).toBe(malformed);
    expect(store.getActionIndex()[0].description).toBe('Old description');
  });

  it('collapses newlines when adding an index entry, same as an update', () => {
    const file = join(dir, 'actions', '2026', 'a2.md');
    store.saveAction('a2', { name: 'A Two', created: '2026-05-05T10:00' }, 'body', file);
    store.addIndexEntry('actions', file, 'a2', 'multi\nline\ndescription');
    expect(store.getActionIndex()[0].description).toBe('multi line description');
    // Disk agrees: the index is one line per field.
    store.rebuild();
    expect(store.getActionIndex().find(i => i.id === 'a2')?.description).toBe('multi line description');
  });

  it('keeps the previous state when a rebuild fails mid-load', () => {
    const file = join(dir, 'projects', '2026', 'p1.md');
    store.saveProject('p1', { name: 'P One', created: '2026-05-05T10:00' }, 'body', file);
    store.addIndexEntry('projects', file, 'p1', 'First project');
    store.rebuild();
    expect(store.getProject('p1')).toBeDefined();

    const spy = vi.spyOn(store as any, 'load').mockImplementation(() => {
      throw new Error('disk went away');
    });
    expect(() => store.rebuild()).toThrow('disk went away');
    // The store still serves the last good state instead of going empty.
    expect(store.getProject('p1')?.frontMatter.name).toBe('P One');
    expect(store.getProjectIndex().find(i => i.id === 'p1')?.description).toBe('First project');
    spy.mockRestore();
  });
});

// Minimal canonical weekly-file content for one entry, matching what capture writes.
function weekly(created: string, content: string, projects: string[] = [], actions: string[] = []): string {
  const links = `${projects.length ? `\nprojects: [${projects.join(', ')}]` : ''}${actions.length ? `\nactions: [${actions.join(', ')}]` : ''}`;
  return `---\nweek: 19\nweek_start: 2026-05-04\nweek_end: 2026-05-10\n---\n\n---\n\`\`\`entry\ncreated: ${created}${links}\n\`\`\`\n\n${content}\n`;
}
