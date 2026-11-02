import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const forbidden = vi.hoisted(() => {
  const blocked = label => vi.fn(function () { throw new Error(`${label} is forbidden in mock queries.`); });
  return {
    writableStore: blocked('Writable Store construction'),
    daemonPaths: blocked('Daemon metadata lookup'),
    recurrencePath: blocked('Recurrence history path lookup'),
    readHistory: blocked('Recurrence history read'),
    writeHistory: blocked('Recurrence history write'),
  };
});

// The real schema may import Store, but read-only preview queries must never
// instantiate it: construction reconciles attachment YAML and daemon history.
vi.mock('../../../cli/src/mcp/store.ts', () => ({ Store: forbidden.writableStore }));
vi.mock('../../../cli/src/mcp/recurrence-history.ts', () => ({
  recurrenceHistoryPath: forbidden.recurrencePath,
  readRecurrenceHistory: forbidden.readHistory,
  writeRecurrenceHistory: forbidden.writeHistory,
}));
vi.mock('../../../cli/src/daemon/paths.ts', async importOriginal => ({
  ...await importOriginal(), daemonPaths: forbidden.daemonPaths,
}));

import { loadFixture, MOCK_NOW, queryFixture, SHOWCASE_IDS } from '../runtime.mjs';
import { Store } from '../../../cli/src/mcp/store.js';

let temporary;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
  vi.clearAllMocks();
});

async function snapshotFiles(root, directory = '') {
  const saved = [];
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) saved.push(...await snapshotFiles(root, relative));
    else saved.push([relative, createHash('sha256').update(await readFile(join(root, relative))).digest('hex')]);
  }
  return saved;
}

it('queries real fixture records, relationships and content without writable stores, reconciliation or daemon metadata', async () => {
  expect(Store).toBe(forbidden.writableStore);
  temporary = await mkdtemp(join(tmpdir(), 'aside-mock-query-'));
  const root = join(temporary, 'showcase');
  await cp(fileURLToPath(new URL('../fixtures/showcase/', import.meta.url)), root, { recursive: true });

  const mediaRecord = join(root, 'artifacts/2026', `${SHOWCASE_IDS.media}.md`);
  const original = await readFile(mediaRecord, 'utf8');
  const stale = original.replace(/^attachments:[^\n]*(?:\n[ \t]+-[^\n]*)*/m, 'attachments: [notes.md]');
  expect(stale).not.toBe(original);
  await writeFile(mediaRecord, stale);
  await writeFile(join(root, 'artifacts/2026', SHOWCASE_IDS.media, 'unindexed-regression.txt'), 'An unindexed local attachment.\n');
  const before = await snapshotFiles(root);

  const fixture = await loadFixture('showcase', { fixturesRoot: temporary });
  const result = await queryFixture(fixture, {
    query: `query ReadOnlyPreview($project: ID!, $typography: ID!, $media: ID!) {
      project(id: $project) {
        id name
        actions(limit: 3) { totalCount nodes { id name status } }
        links(limit: 8) {
          totalCount
          nodes { __typename ... on Action { id } ... on Artifact { id } }
        }
      }
      actions(limit: 2) { totalCount nodes { id name status } }
      artifact(id: $typography) {
        id
        content { __typename ... on MarkdownContent { text } }
      }
      media: artifact(id: $media) {
        id
        attachments { filename handle filePath error }
      }
    }`,
    variables: { project: SHOWCASE_IDS.project, typography: SHOWCASE_IDS.typography, media: SHOWCASE_IDS.media },
    operationName: 'ReadOnlyPreview',
  }, MOCK_NOW);

  expect(result.errors).toBeUndefined();
  expect(result.data.project).toMatchObject({ id: SHOWCASE_IDS.project, name: 'Aurora launch' });
  expect(result.data.project.actions.totalCount).toBeGreaterThan(0);
  expect(result.data.project.actions.nodes.length).toBeGreaterThan(0);
  expect(result.data.actions.totalCount).toBeGreaterThan(0);
  expect(result.data.actions.nodes).toHaveLength(2);
  expect(result.data.project.links.nodes).toEqual(expect.arrayContaining([
    { __typename: 'Action', id: SHOWCASE_IDS.action },
    { __typename: 'Artifact', id: SHOWCASE_IDS.typography },
  ]));
  expect(result.data.artifact.content.__typename).toBe('MarkdownContent');
  expect(result.data.artifact.content.text).toContain('# A bright idea, clearly expressed');
  expect(result.data.media.attachments).toEqual([{
    filename: 'notes.md', handle: `#artifact/${SHOWCASE_IDS.media}/notes.md`,
    filePath: await realpath(join(root, 'artifacts/2026', SHOWCASE_IDS.media, 'notes.md')), error: null,
  }]);
  expect(await readFile(mediaRecord, 'utf8')).toBe(stale);
  expect(await snapshotFiles(root)).toEqual(before);
  for (const guard of Object.values(forbidden)) expect(guard).not.toHaveBeenCalled();
});
