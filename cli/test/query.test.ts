import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/mcp/store.js';
import { handleQueryEntries, handleQueryActions, handleQueryProjects, handleQueryArtifacts } from '../src/mcp/tools/query.js';

describe('query handlers', () => {
  let tempDir: string;
  let store: Store;

  beforeAll(() => {
    tempDir = join(tmpdir(), `aside-query-test-${Date.now()}`);

    // Create directory structure
    mkdirSync(join(tempDir, 'notes', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'projects', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'actions', '2026'), { recursive: true });

    // Create note index
    writeFileSync(
      join(tempDir, 'notes', '2026', 'index.yaml'),
      `- id: "2026-04-28T10:00:00"\n  description: "Worked on project task"\n- id: "2026-04-29T14:00:00"\n  description: "Cross-project work"\n`
    );

    // Create weekly file with multiple entries
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
  - proj-alpha
actions:
  - action-one
\`\`\`

Worked on the alpha project task today.

---

\`\`\`entry
created: "2026-04-29T14:00:00"
projects:
  - proj-alpha
  - proj-beta
actions:
  - action-two
\`\`\`

Did some cross-project collaboration work.

---

\`\`\`entry
created: "2026-04-30T09:00:00"
projects:
  - proj-beta
actions:
  - action-one
\`\`\`

Fixed a bug in the beta system.
`
    );

    // Create w19 for more entries
    writeFileSync(
      join(tempDir, 'notes', '2026', 'w19.md'),
      `---
week: 19
week_start: "2026-05-04"
week_end: "2026-05-10"
---

\`\`\`entry
created: "2026-05-05T11:00:00"
projects:
  - proj-alpha
actions:
  - action-three
\`\`\`

Planning the next milestone for alpha.
`
    );

    // Create project index
    writeFileSync(
      join(tempDir, 'projects', '2026', 'index.yaml'),
      `- id: proj-alpha\n  description: "Alpha project"\n- id: proj-beta\n  description: "Beta project"\n`
    );

    // Create project files
    writeFileSync(
      join(tempDir, 'projects', '2026', 'proj-alpha.md'),
      `---
name: "Alpha Project"
created: "2026-01-15"
related_projects:
  - project: proj-beta
    description: "Sibling project"
---

The alpha project is our main initiative.
`
    );

    writeFileSync(
      join(tempDir, 'projects', '2026', 'proj-beta.md'),
      `---
name: "Beta Project"
created: "2026-03-01"
ended: "2026-04-30"
---

The beta project has concluded.
`
    );

    writeFileSync(
      join(tempDir, 'projects', '2026', 'proj-gamma.md'),
      `---
name: "Gamma Project"
created: "2026-04-10"
---

Gamma is a new experimental project.
`
    );

    // Create action index
    writeFileSync(
      join(tempDir, 'actions', '2026', 'index.yaml'),
      `- id: action-one\n  description: "First action item"\n- id: action-two\n  description: "Second action item"\n- id: action-three\n  description: "Third action item"\n`
    );

    // Create action files
    writeFileSync(
      join(tempDir, 'actions', '2026', 'action-one.md'),
      `---
name: "Fix the widget"
created: "2026-04-20"
scheduled: "2026-04-25"
---

Need to fix the widget component thoroughly.
`
    );

    writeFileSync(
      join(tempDir, 'actions', '2026', 'action-two.md'),
      `---
name: "Review documents"
created: "2026-04-22"
scheduled: "2026-05-10"
deadline: "2026-05-15"
---

Review all pending documents for accuracy.
`
    );

    writeFileSync(
      join(tempDir, 'actions', '2026', 'action-three.md'),
      `---
name: "Plan milestone"
created: "2026-05-01"
---

Plan the next project milestone deliverables.
`
    );

    writeFileSync(
      join(tempDir, 'actions', '2026', 'action-four.md'),
      `---
name: "Cancelled task"
created: "2026-04-15"
scheduled: "2026-04-20"
resolution: cancelled
---

This was cancelled before it started.
`
    );

    writeFileSync(
      join(tempDir, 'actions', '2026', 'action-five.md'),
      `---
name: "Ship release notes"
created: "2026-04-10"
scheduled: "2026-04-12"
resolution: done
---

Drafted and shipped the release notes.
`
    );

    store = new Store(tempDir);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('handleQueryEntries', () => {
    it('returns all entries when no filters', () => {
      const result = handleQueryEntries(store, {});
      expect(result).toContain('4 of 4');
    });

    it('filters by project', () => {
      const result = handleQueryEntries(store, { projects: ['proj-beta'] });
      expect(result).toContain('2 of 2');
      expect(result).toContain('2026-04-29T14:00:00');
      expect(result).toContain('2026-04-30T09:00:00');
    });

    it('filters by action', () => {
      const result = handleQueryEntries(store, { actions: ['action-one'] });
      expect(result).toContain('2 of 2');
    });

    it('filters by date range', () => {
      const result = handleQueryEntries(store, { created_from: '2026-04-29', created_to: '2026-04-30' });
      expect(result).toContain('2 of 2');
      expect(result).toContain('2026-04-29T14:00:00');
      expect(result).toContain('2026-04-30T09:00:00');
    });

    it('filters by search regex', async () => {
      const result = (await handleQueryEntries(store, { search: 'bug' }));
      expect(result).toContain('1 of 1');
      expect(result).toContain('2026-04-30T09:00:00');
    });

    it('handles case-insensitive search', async () => {
      const result = (await handleQueryEntries(store, { search: 'ALPHA' }));
      expect(result).toContain('2026-04-28T10:00:00');
    });

    it('paginates with offset and limit', () => {
      const result = handleQueryEntries(store, { offset: 1, limit: 2 });
      expect(result).toContain('2 of 4');
    });

    it('rejects a limit above 100', () => {
      expect(() => handleQueryEntries(store, { limit: 200 })).toThrow('limit must be an integer from 1 to 100');
    });

    it('returns full detail when requested', () => {
      const result = handleQueryEntries(store, { detail: 'full', limit: 1 });
      expect(result).toContain('id: 2026-05-05T11:00:00');
      expect(result).toContain('projects: [proj-alpha]');
      expect(result).toContain('Planning the next milestone');
    });

    it('returns index format by default', () => {
      const result = handleQueryEntries(store, { ids: ['2026-04-28T10:00:00'] });
      expect(result).toContain('1 of 1');
      // Should use the note index description
      expect(result).toContain('Worked on project task');
    });

    it('falls back to content slice when not in index', () => {
      const result = handleQueryEntries(store, { ids: ['2026-05-05T11:00:00'] });
      expect(result).toContain('1 of 1');
      expect(result).toContain('Planning the next milestone');
    });

    it('filters by multiple IDs', () => {
      const result = handleQueryEntries(store, { ids: ['2026-04-28T10:00:00', '2026-04-29T14:00:00'] });
      expect(result).toContain('2 of 2');
    });
  });

  describe('handleQueryActions', () => {
    it('returns all actions when no filters', () => {
      const result = handleQueryActions(store, {});
      expect(result).toContain('5 of 5');
    });

    it('filters by ID', () => {
      const result = handleQueryActions(store, { ids: ['action-one'] });
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-one');
    });

    it('filters by project', () => {
      // action-one is linked to proj-alpha and proj-beta via entries
      // action-two is linked to proj-alpha and proj-beta
      // action-three is linked to proj-alpha
      const result = handleQueryActions(store, { projects: ['proj-beta'] });
      // actions that have proj-beta in their projects-for-action
      expect(result).toContain('2 of 2');
      expect(result).toContain('action-one');
      expect(result).toContain('action-two');
    });

    it('filters by created date range', () => {
      const result = handleQueryActions(store, { created_from: '2026-04-20', created_to: '2026-04-22' });
      expect(result).toContain('2 of 2');
    });

    it('filters by scheduled date range', () => {
      const result = handleQueryActions(store, { scheduled_from: '2026-05-01', scheduled_to: '2026-05-15' });
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-two');
    });

    it('filters by deadline date range', () => {
      const result = handleQueryActions(store, { deadline_from: '2026-05-01' });
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-two');
    });

    it('filters by status: scheduled', () => {
      const result = handleQueryActions(store, { status: ['scheduled'] });
      // action-one and action-two: have a scheduled time, unresolved
      expect(result).toContain('2 of 2');
    });

    it('filters by status: backlog', () => {
      const result = handleQueryActions(store, { status: ['backlog'] });
      // action-three: no scheduled time, unresolved
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-three');
    });

    it('filters by status: cancelled', () => {
      const result = handleQueryActions(store, { status: ['cancelled'] });
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-four');
    });

    it('filters by status: done', () => {
      const result = handleQueryActions(store, { status: ['done'] });
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-five');
    });

    it('composes overdue as a status + deadline-bound query', () => {
      // overdue = active with a passed deadline; the caller supplies "today" as the bound
      const result = handleQueryActions(store, { status: ['scheduled', 'backlog'], deadline_to: '2026-05-20' });
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-two');
    });

    it('filters by search regex', async () => {
      const result = (await handleQueryActions(store, { search: 'widget' }));
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-one');
    });

    it('paginates with offset and limit', () => {
      const result = handleQueryActions(store, { offset: 2, limit: 2 });
      expect(result).toContain('2 of 5');
    });

    it('returns full detail when requested', () => {
      const result = handleQueryActions(store, { ids: ['action-two'], detail: 'full' });
      expect(result).toContain('id: action-two');
      expect(result).toContain('name: Review documents');
      expect(result).toContain('scheduled: 2026-05-10');
      expect(result).toContain('deadline: 2026-05-15');
      expect(result).toContain('Review all pending documents');
    });

    it('returns index format by default', () => {
      const result = handleQueryActions(store, { ids: ['action-one'] });
      expect(result).toContain('action-one — First action item');
    });

    it('falls back to name when not in index', () => {
      const result = handleQueryActions(store, { ids: ['action-four'] });
      expect(result).toContain('action-four — Cancelled task');
    });
  });

  describe('handleQueryProjects', () => {
    it('returns all projects when no filters', () => {
      const result = handleQueryProjects(store, {});
      expect(result).toContain('3 of 3');
    });

    it('filters by ID', () => {
      const result = handleQueryProjects(store, { ids: ['proj-alpha'] });
      expect(result).toContain('1 of 1');
      expect(result).toContain('proj-alpha');
    });

    it('filters by related_to', () => {
      // proj-alpha has related_projects containing proj-beta
      const result = handleQueryProjects(store, { related_to: ['proj-beta'] });
      expect(result).toContain('1 of 1');
      expect(result).toContain('proj-alpha');
    });

    it('filters by created date range', () => {
      const result = handleQueryProjects(store, { created_from: '2026-03-01', created_to: '2026-04-01' });
      expect(result).toContain('1 of 1');
      expect(result).toContain('proj-beta');
    });

    it('filters by ended date range', () => {
      const result = handleQueryProjects(store, { ended_from: '2026-04-01', ended_to: '2026-05-01' });
      expect(result).toContain('1 of 1');
      expect(result).toContain('proj-beta');
    });

    it('filters by status: open', () => {
      const result = handleQueryProjects(store, { status: 'open' });
      // proj-alpha and proj-gamma are open
      expect(result).toContain('2 of 2');
    });

    it('filters by status: closed', () => {
      const result = handleQueryProjects(store, { status: 'closed' });
      expect(result).toContain('1 of 1');
      expect(result).toContain('proj-beta');
    });

    it('filters by search regex', async () => {
      const result = (await handleQueryProjects(store, { search: 'experimental' }));
      expect(result).toContain('1 of 1');
      expect(result).toContain('proj-gamma');
    });

    it('paginates with offset and limit', () => {
      const result = handleQueryProjects(store, { offset: 1, limit: 1 });
      expect(result).toContain('1 of 3');
    });

    it('returns full detail when requested', () => {
      const result = handleQueryProjects(store, { ids: ['proj-alpha'], detail: 'full' });
      expect(result).toContain('id: proj-alpha');
      expect(result).toContain('name: Alpha Project');
      expect(result).toContain('status: open');
      expect(result).toContain('related_projects:\n  - project: proj-beta\n    description: |\n      Sibling project');
      expect(result).toContain('The alpha project is our main initiative.');
    });

    it('returns index format by default', () => {
      const result = handleQueryProjects(store, { ids: ['proj-alpha'] });
      expect(result).toContain('proj-alpha — Alpha project');
    });

    it('falls back to name when not in index', () => {
      const result = handleQueryProjects(store, { ids: ['proj-gamma'] });
      expect(result).toContain('proj-gamma — Gamma Project');
    });

    it('searches by project name, not just body', async () => {
      const result = (await handleQueryProjects(store, { search: 'Gamma' }));
      expect(result).toContain('1 of 1');
      expect(result).toContain('proj-gamma');
    });

    it('related_to: [] returns only projects with no related project', () => {
      const result = handleQueryProjects(store, { related_to: [] });
      expect(result).toContain('2 of 2');
      expect(result).toContain('proj-beta');
      expect(result).toContain('proj-gamma');
      expect(result).not.toContain('proj-alpha');
    });

    it('ids: [] matches nothing and warns', () => {
      const result = handleQueryProjects(store, { ids: [] });
      expect(result).toContain('0 of 0');
      expect(result).toContain('ids was an empty list, which matches nothing');
    });

    it('throws on invalid regex', () => {
      expect(() => handleQueryProjects(store, { search: '[invalid(' })).toThrow('Invalid regex:');
    });

    it('rejects a negative offset', () => {
      expect(() => handleQueryProjects(store, { offset: -5 })).toThrow('offset must be a nonnegative integer');
    });
  });

  describe('handleQueryActions (additional)', () => {
    it('searches by action name, not just body', async () => {
      const result = (await handleQueryActions(store, { search: 'Fix the widget' }));
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-one');
    });

    it('searches by index description, not just name and body', async () => {
      // "Second action item" is the index description of action-two; it appears
      // in neither its name ("Review documents") nor its body.
      const result = (await handleQueryActions(store, { search: 'Second action' }));
      expect(result).toContain('1 of 1');
      expect(result).toContain('action-two');
    });

    it('projects: [] returns only actions with no project (a constraint, not no-filter)', () => {
      // action-four and action-five appear in no entry, so they have no project;
      // the other three co-occur with one. [] must select exactly the orphans —
      // proving the empty set is honored rather than ignored.
      const result = handleQueryActions(store, { projects: [] });
      expect(result).toContain('2 of 2');
      expect(result).toContain('action-four');
      expect(result).toContain('action-five');
      expect(result).not.toContain('action-one');
    });

    it('omitting projects is no filter', () => {
      const result = handleQueryActions(store, {});
      expect(result).toContain('5 of 5');
    });

    it('ids: [] matches nothing and warns', () => {
      const result = handleQueryActions(store, { ids: [] });
      expect(result).toContain('0 of 0');
      expect(result).toContain('ids was an empty list, which matches nothing');
    });

    it('status: [] matches nothing and warns', () => {
      const result = handleQueryActions(store, { status: [] });
      expect(result).toContain('0 of 0');
      expect(result).toContain('status was an empty list, which matches nothing');
    });

    it('warns about both empty set-membership filters with plural grammar', () => {
      const result = handleQueryActions(store, { ids: [], status: [] });
      expect(result).toContain('0 of 0');
      expect(result).toContain('ids and status were empty lists, which match nothing');
    });

    it('throws on invalid regex', () => {
      expect(() => handleQueryActions(store, { search: '(unclosed' })).toThrow('Invalid regex:');
    });

    it('rejects a negative offset', () => {
      expect(() => handleQueryActions(store, { offset: -3 })).toThrow('offset must be a nonnegative integer');
    });
  });

  describe('handleQueryEntries (additional)', () => {
    it('searches the index description, not just content', async () => {
      // The 2026-04-28 entry's index description is "Worked on project task";
      // its content reads "Worked on the alpha project task today", so this exact
      // phrase matches only the description.
      const result = (await handleQueryEntries(store, { search: 'Worked on project task' }));
      expect(result).toContain('1 of 1');
      expect(result).toContain('2026-04-28T10:00:00');
    });

    it('ids: [] matches nothing and warns', () => {
      const result = handleQueryEntries(store, { ids: [] });
      expect(result).toContain('0 of 0');
      expect(result).toContain('ids was an empty list, which matches nothing');
    });

    it('throws on invalid regex', () => {
      expect(() => handleQueryEntries(store, { search: '*badregex' })).toThrow('Invalid regex:');
    });

    it('rejects an over-long search pattern (all handlers share the cap)', () => {
      const long = 'a'.repeat(300);
      expect(() => handleQueryEntries(store, { search: long })).toThrow('Search pattern too long');
      expect(() => handleQueryActions(store, { search: long })).toThrow('Search pattern too long');
      expect(() => handleQueryProjects(store, { search: long })).toThrow('Search pattern too long');
    });

    it('rejects a negative offset', () => {
      expect(() => handleQueryEntries(store, { offset: -1 })).toThrow('offset must be a nonnegative integer');
    });
  });

  describe('file paths in results', () => {
    it('includes the action file in metadata and full, not in index', () => {
      const meta = handleQueryActions(store, { ids: ['action-one'], detail: 'metadata' });
      expect(meta).toContain('file:');
      expect(meta).toContain('actions/2026/action-one.md');
      const full = handleQueryActions(store, { ids: ['action-one'], detail: 'full' });
      expect(full).toContain('actions/2026/action-one.md');
      const index = handleQueryActions(store, { ids: ['action-one'] });
      expect(index).not.toContain('file:');
    });

    it('includes the project file path', () => {
      const meta = handleQueryProjects(store, { ids: ['proj-alpha'], detail: 'metadata' });
      expect(meta).toContain('projects/2026/proj-alpha.md');
    });

    it('resolves an entry to its weekly file', () => {
      const meta = handleQueryEntries(store, { ids: ['2026-04-28T10:00:00'], detail: 'metadata' });
      expect(meta).toContain('notes/2026/w18.md');
    });
  });

  describe('agent follow-up contracts', () => {
    const handlers = [handleQueryEntries, handleQueryActions, handleQueryProjects, handleQueryArtifacts];

    it('returns an entry ID that can be reused without stripping display text', () => {
      const metadata = handleQueryEntries(store, { limit: 1, detail: 'metadata' });
      const id = metadata.match(/^id: (.+)$/m)![1];
      expect(id).toBe(store.getEntries()[0].meta.created);
      expect(handleQueryEntries(store, { ids: [id] }).split('\n')[0]).toBe('1 of 1');
    });

    it('follows next_offset across partial and final pages', () => {
      const first = handleQueryEntries(store, { limit: 3 });
      expect(first).toContain('offset: 0\nlimit: 3\nnext_offset: 3');
      const nextOffset = Number(first.match(/^next_offset: (.+)$/m)![1]);
      const last = handleQueryEntries(store, { offset: nextOffset, limit: 3 });
      expect(last.split('\n')[0]).toBe('1 of 4');
      expect(last).toContain('next_offset: null');
      expect(handleQueryEntries(store, { offset: 99 }).split('\n').slice(0, 4)).toEqual(['0 of 4', 'offset: 99', 'limit: 20', 'next_offset: null']);
    });

    it('includes stored descriptions at every detail level', () => {
      for (const detail of ['index', 'metadata', 'full'] as const) {
        expect(handleQueryActions(store, { ids: ['action-one'], detail })).toContain('First action item');
        expect(handleQueryProjects(store, { ids: ['proj-alpha'], detail })).toContain('Alpha project');
      }
    });

    it('rejects invalid page arguments consistently for every entity', () => {
      for (const handler of handlers) {
        for (const offset of [-1, 0.5, Infinity, NaN]) {
          expect(() => handler(store, { offset })).toThrow('offset must be a nonnegative integer');
        }
        for (const limit of [0, -1, 1.5, 101, Infinity, NaN]) {
          expect(() => handler(store, { limit })).toThrow('limit must be an integer from 1 to 100');
        }
      }
    });

    it('rejects malformed and impossible calendar dates instead of returning no matches', () => {
      for (const handler of handlers) {
        for (const created_from of ['', 'today', '2026-2-01', '2026-02-29', '2026-04-31', '2026-13-01']) {
          expect(() => handler(store, { created_from })).toThrow('created_from must be a valid date in YYYY-MM-DD format');
        }
        expect(() => handler(store, { created_from: '2026-06-01', created_to: '2026-05-01' })).toThrow('created_from must be on or before created_to');
        expect(() => handler(store, { created_from: '2028-02-29' })).not.toThrow();
      }
      expect(() => handleQueryActions(store, { scheduled_to: '2026-02-30' })).toThrow('scheduled_to must be a valid date');
      expect(() => handleQueryActions(store, { deadline_from: '2026-06-01', deadline_to: '2026-05-01' })).toThrow('deadline_from must be on or before deadline_to');
      expect(() => handleQueryProjects(store, { ended_from: '2026-06-01', ended_to: '2026-05-01' })).toThrow('ended_from must be on or before ended_to');
    });

    it('surfaces recovered parse issues once even for empty query results', () => {
      const issues = vi.spyOn(store, 'getIssues').mockReturnValue([{ severity: 'error', code: 'bad_yaml', message: 'malformed YAML recovered', file: '/data/actions/bad.md' }]);
      try {
        for (const handler of handlers) {
          const result = handler(store, { ids: [] });
          expect(result.split('\n')[0]).toBe('0 of 0');
          expect(result.match(/1 parsing issue/g)).toHaveLength(1);
          expect(result).toContain('data loaded best-effort; run validate for detail');
          expect(result).toContain('/data/actions/bad.md: malformed YAML recovered');
        }
      } finally {
        issues.mockRestore();
      }
    });
  });
});
