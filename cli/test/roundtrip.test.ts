import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateEntry } from '../src/mcp/tools/update.js';
import { readTextBlock } from './framed-output.js';
import {
  handleQueryEntries,
  handleQueryActions,
  handleQueryProjects,
} from '../src/mcp/tools/query.js';

// End-to-end: capture writes Markdown files, the Store re-reads them from disk
// (rebuild() is the synchronous form of the watcher-driven reload the MCP server
// uses), and query renders them back. These tests assert content survives the
// full write → parse → render round trip byte-for-byte.
describe('capture → query round trip', () => {
  let tempDir: string;
  let store: Store;

  beforeEach(() => {
    tempDir = join(tmpdir(), `aside-roundtrip-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(join(tempDir, 'notes', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'projects', '2026'), { recursive: true });
    mkdirSync(join(tempDir, 'actions', '2026'), { recursive: true });
    store = new Store(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const PROJECT_ID = '2026-05-06-schema-migration';
  const ACTION_ID = '2026-05-06-backfill-archive';

  // Deliberately exercises the tricky bits: multiple paragraphs, a bullet list,
  // YAML/Markdown indicator characters (: # * [] " ->), a fenced code block
  // (whose ``` must not be confused with the entry metadata fence), unicode
  // em-dashes/arrows, inline #mentions, AND a bare `---` horizontal rule — content
  // is free to contain anything except a `---` line directly followed by ```entry.
  const ENTRY_CONTENT = [
    '## Migration review — phase 1 complete',
    '',
    'Shipped the **schema migration** to staging. Key results:',
    '',
    '- Latency p99 dropped from 120ms → 48ms',
    '- Zero downtime during cutover',
    '- Edge cases: "quoted", a colon: here, [brackets], *stars*, #hash',
    '',
    '---',
    '',
    'Verification script:',
    '',
    '```bash',
    'psql -c "SELECT count(*) FROM events"  # expect 1,240,002',
    'echo "done ✓"',
    '```',
    '',
    `Coordinated with #project/${PROJECT_ID} on #action/${ACTION_ID}. Next: backfill.`,
  ].join('\n');

  const PROJECT_BODY = [
    'Long-running effort to migrate the events schema with zero downtime.',
    '',
    '- Owner: platform team',
    '- Risk: medium — rollback plan documented',
  ].join('\n');

  const ACTION_BODY = [
    'Backfill the archive table after cutover.',
    '',
    'Use the batched job: 10k rows per transaction, throttled to off-peak.',
  ].join('\n');

  it('captures an entry plus a new project and action, then queries all three back faithfully', async () => {
    const now = new Date(2026, 4, 6, 14, 30); // Wed May 6, 2026 14:30
    const result = handleCapture(store, {
      content: ENTRY_CONTENT,
      description: 'Entry headline',
      projects: [{ name: 'Schema Migration', description: 'Migrate the events schema', body: PROJECT_BODY }],
      actions: [{ name: 'Backfill Archive', description: 'Backfill the archive table', body: ACTION_BODY, scheduled: '2026-05-10', deadline: '2026-05-20' }],
    }, now);

    expect(result.text).toContain('entry: 2026-05-06T14:30');
    expect(result.text).toContain(`projects_created: [${PROJECT_ID}]`);
    expect(result.text).toContain(`actions_created: [${ACTION_ID}]`);

    // Reload from disk — this is what the agent sees on the next query.
    store.rebuild();

    // --- Entry: parsed content is byte-identical to what was captured ---
    const entries = store.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe(ENTRY_CONTENT);
    expect(entries[0].meta.created).toBe('2026-05-06T14:30');
    expect(entries[0].meta.projects).toEqual([PROJECT_ID]);
    expect(entries[0].meta.actions).toEqual([ACTION_ID]);

    // --- query_entries (full) renders the exact content and links ---
    const full = handleQueryEntries(store, { detail: 'full' });
    expect(full).toContain('1 of 1');
    expect(full.match(/^id: (.+)$/m)?.[1]).toBe('2026-05-06T14:30');
    expect(full).toContain(`projects: [${PROJECT_ID}]`);
    expect(full).toContain(`actions: [${ACTION_ID}]`);
    expect(readTextBlock(full)).toBe(ENTRY_CONTENT);
    expect(full).toContain('```bash'); // code fence preserved, not swallowed

    // --- query_entries filters resolve against the captured metadata ---
    expect(handleQueryEntries(store, { projects: [PROJECT_ID] })).toContain('1 of 1');
    expect(handleQueryEntries(store, { actions: [ACTION_ID] })).toContain('1 of 1');
    expect((await handleQueryEntries(store, { search: 'p99 dropped' }))).toContain('1 of 1');
    expect((await handleQueryEntries(store, { search: 'nonexistent-term' }))).toContain('0 of 0');

    // --- query_projects (full) renders the project body faithfully ---
    const proj = handleQueryProjects(store, { ids: [PROJECT_ID], detail: 'full' });
    expect(proj).toContain('1 of 1');
    expect(proj).toContain('name: Schema Migration');
    expect(proj).toContain('status: open');
    expect(readTextBlock(proj)).toBe(PROJECT_BODY);

    // --- query_actions (full) renders the action body and dates faithfully ---
    const act = handleQueryActions(store, { ids: [ACTION_ID], detail: 'full' });
    expect(act).toContain('1 of 1');
    expect(act).toContain('name: Backfill Archive');
    expect(act).toContain('scheduled: 2026-05-10');
    expect(act).toContain('deadline: 2026-05-20');
    expect(readTextBlock(act)).toBe(ACTION_BODY);

    // Action is reachable via its project link, and is in the backlog/scheduled set.
    expect(handleQueryActions(store, { projects: [PROJECT_ID] })).toContain(ACTION_ID);
    expect(handleQueryActions(store, { status: ['scheduled'] })).toContain(ACTION_ID);
  });

  it('round-trips an action with calendar sync fields', () => {
    const now = new Date(2026, 4, 6, 14, 30); // Wed May 6, 2026
    handleCapture(store, {
      content: 'Scheduling the deploy.',
      description: 'Scheduling note',
      actions: [{ name: 'Deploy DB', description: 'Deploy the database', scheduled: '2026-05-10T10:00', duration: 'PT1H', timezone: 'Asia/Tokyo', calendar: 'Work' }],
    }, now);
    store.rebuild();

    const action = store.getAction('2026-05-06-deploy-db');
    expect(action?.frontMatter.duration).toBe('PT1H');
    expect(action?.frontMatter.timezone).toBe('Asia/Tokyo');
    expect(action?.frontMatter.calendar).toBe('Work');

    const full = handleQueryActions(store, { ids: ['2026-05-06-deploy-db'], detail: 'full' });
    expect(full).toContain('duration: PT1H');
    expect(full).toContain('timezone: Asia/Tokyo');
    expect(full).toContain('calendar: Work');
  });

  it('round-trips multiple entries and an amend without disturbing the others', async () => {
    const SECOND = 'Second entry — beta\n\nWith a second paragraph and a `code span`.';

    handleCapture(store, { content: 'First entry — alpha', description: 'First note' }, new Date(2026, 4, 6, 9, 0));
    store.rebuild();
    handleCapture(store, { content: SECOND, description: 'Second note' }, new Date(2026, 4, 6, 11, 0));
    store.rebuild();

    // Both present, reverse-chronological, each content faithful.
    let entries = store.getEntries();
    expect(entries.map(e => e.meta.created)).toEqual(['2026-05-06T11:00', '2026-05-06T09:00']);
    const byId = (id: string) => entries.find(e => e.meta.created === id)!;
    expect(byId('2026-05-06T09:00').content).toBe('First entry — alpha');
    expect(byId('2026-05-06T11:00').content).toBe(SECOND);

    // Amend the OLDER entry; the newer one must stay byte-identical.
    handleUpdateEntry(store, { id: '2026-05-06T09:00', content: 'First entry — AMENDED', description: 'Revised note' });
    store.rebuild();

    entries = store.getEntries();
    expect(entries).toHaveLength(2);
    expect(byId('2026-05-06T09:00').content).toBe('First entry — AMENDED');
    expect(byId('2026-05-06T11:00').content).toBe(SECOND);

    // Query reflects the amendment; the old content is gone.
    expect((await handleQueryEntries(store, { search: 'AMENDED', detail: 'full' }))).toContain('First entry — AMENDED');
    expect((await handleQueryEntries(store, { search: '\\balpha\\b' }))).toContain('0 of 0');
    expect(readTextBlock(handleQueryEntries(store, { detail: 'full' }))).toBe(SECOND);
  });
});
