import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/source/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateEntry } from '../src/mcp/tools/update.js';
import { executeGraphQL } from '../src/graphql/schema.js';

// End-to-end: capture writes Markdown files, the Store re-reads them from disk
// (rebuild() is the synchronous form of the watcher-driven reload the MCP server
// uses), and GraphQL reads them back. These tests assert content survives the
// full write → parse → read round trip byte-for-byte.
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

  const read = async (document: string, variables?: Record<string, unknown>) => {
    const result = await executeGraphQL(store, 'query', { document, variables });
    expect(result.errors).toBeUndefined();
    return result.data as any;
  };
  const entryIds = async (where: Record<string, unknown>) =>
    (await read('query($where: EntryWhere) { entries(where: $where) { nodes { id } } }', { where })).entries.nodes.map((node: { id: string }) => node.id);
  const actionIds = async (where: Record<string, unknown>) =>
    (await read('query($where: ActionWhere) { actions(where: $where) { nodes { id } } }', { where })).actions.nodes.map((node: { id: string }) => node.id);

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

    expect(result).toEqual({ entryId: '2026-05-06T14:30', createdProjectIds: [PROJECT_ID], createdActionIds: [ACTION_ID] });

    // Reload from disk — this is what the agent sees on the next query.
    store.rebuild();

    // --- Entry: parsed content is byte-identical to what was captured ---
    const entries = store.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe(ENTRY_CONTENT);
    expect(entries[0].meta.created).toBe('2026-05-06T14:30');
    expect(entries[0].meta.projects).toEqual([PROJECT_ID]);
    expect(entries[0].meta.actions).toEqual([ACTION_ID]);

    // --- entries read back the exact content and links ---
    const { entries: { nodes: [entry], totalCount } } = await read('{ entries { totalCount nodes { id content projects { nodes { id } } actions { nodes { id } } } } }');
    expect(totalCount).toBe(1);
    expect(entry).toEqual({ id: '2026-05-06T14:30', content: ENTRY_CONTENT, projects: { nodes: [{ id: PROJECT_ID }] }, actions: { nodes: [{ id: ACTION_ID }] } });
    expect(entry.content).toContain('```bash'); // code fence preserved, not swallowed

    // --- entry filters resolve against the captured metadata ---
    expect(await entryIds({ projectIds: [PROJECT_ID] })).toEqual([entry.id]);
    expect(await entryIds({ actionIds: [ACTION_ID] })).toEqual([entry.id]);
    expect(await entryIds({ regex: 'p99 dropped' })).toEqual([entry.id]);
    expect(await entryIds({ regex: 'nonexistent-term' })).toEqual([]);

    // --- projects read back the body faithfully ---
    expect((await read(`{ project(id: "${PROJECT_ID}") { name status body } }`)).project)
      .toEqual({ name: 'Schema Migration', status: 'OPEN', body: PROJECT_BODY });

    // --- actions read back the body and dates faithfully ---
    expect((await read(`{ action(id: "${ACTION_ID}") { name scheduled deadline body } }`)).action)
      .toEqual({ name: 'Backfill Archive', scheduled: '2026-05-10', deadline: '2026-05-20', body: ACTION_BODY });

    // Action is reachable via its project link, and is in the backlog/scheduled set.
    expect(await actionIds({ projectIds: [PROJECT_ID] })).toEqual([ACTION_ID]);
    expect(await actionIds({ status: ['SCHEDULED'] })).toEqual([ACTION_ID]);
  });

  it('round-trips an action with calendar sync fields', async () => {
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

    expect((await read('{ action(id: "2026-05-06-deploy-db") { duration timezone calendar } }')).action)
      .toEqual({ duration: 'PT1H', timezone: 'Asia/Tokyo', calendar: 'Work' });
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
    const amended = await read('{ entries(where: {regex: "AMENDED"}) { nodes { content } } }');
    expect(amended.entries.nodes).toEqual([{ content: 'First entry — AMENDED' }]);
    expect(await entryIds({ regex: '\\balpha\\b' })).toEqual([]);
    expect((await read('{ entries { nodes { content } } }')).entries.nodes.map((node: { content: string }) => node.content))
      .toEqual([SECOND, 'First entry — AMENDED']);
  });
});
