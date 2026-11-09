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
vi.mock('../../../cli/src/source/store.ts', () => ({ Store: forbidden.writableStore }));
vi.mock('../../../cli/src/source/recurrence-history.ts', () => ({
  recurrenceHistoryPath: forbidden.recurrencePath,
  readRecurrenceHistory: forbidden.readHistory,
  writeRecurrenceHistory: forbidden.writeHistory,
}));
vi.mock('../../../cli/src/daemon/paths.ts', async importOriginal => ({
  ...await importOriginal(), daemonPaths: forbidden.daemonPaths,
}));

import { loadFixture, MOCK_NOW, queryFixture, SHOWCASE_IDS, updateFixtureSidebar } from '../runtime.mjs';
import { Store } from '../../../cli/src/source/store.js';
import { parseEntrySource, parseSourcePage, sourceRequest } from '../../src/entry-source.ts';

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

it('replaces a preview sidebar only in memory without writable stores or fixture file changes', async () => {
  const fixture = await loadFixture('showcase');
  const before = await snapshotFiles(fixture.root);
  const sidebar = [{ title: 'Focus', items: [{ timeline: '#artifact/2026-10-12-recent-decisions/decisions.json' }] }];
  const expectedSidebar = structuredClone(fixture.snapshot.instance.manifest.config.webapp.sidebar);
  expect(updateFixtureSidebar(fixture, sidebar, expectedSidebar)).toEqual(sidebar);
  expect(fixture.snapshot.instance.manifest.config.webapp.sidebar).toEqual(sidebar);
  expect(() => updateFixtureSidebar(fixture, [{ items: [{ timeline: 'one', entity: 'two' }] }], sidebar)).toThrow();
  expect(() => updateFixtureSidebar(fixture, [], expectedSidebar)).toThrow('changed elsewhere');
  expect(fixture.snapshot.instance.manifest.config.webapp.sidebar).toEqual(sidebar);
  expect(await snapshotFiles(fixture.root)).toEqual(before);
  for (const guard of Object.values(forbidden)) expect(guard).not.toHaveBeenCalled();
});

it('retains a malformed preview declaration and parser diagnostics instead of overwriting them with a pin', async () => {
  const fixture = await loadFixture('showcase');
  const malformed = [{ items: [{ timeline: 'one', entity: 'two' }] }];
  fixture.snapshot.instance.manifest.config.webapp.sidebar = malformed;
  const before = structuredClone(fixture.snapshot);
  expect(() => updateFixtureSidebar(fixture, [], [])).toThrow('current sidebar declaration is invalid');
  expect(fixture.snapshot).toEqual(before);
  fixture.snapshot.instance.manifest.config.webapp.sidebar = [];
  fixture.snapshot.diagnostics.push({ path: 'aside.md', issues: [{ severity: 'error', code: 'invalid_webapp_sidebar', message: 'Malformed declaration' }] });
  const diagnosed = structuredClone(fixture.snapshot);
  expect(() => updateFixtureSidebar(fixture, [], [])).toThrow('cannot be verified');
  expect(fixture.snapshot).toEqual(diagnosed);
  for (const guard of Object.values(forbidden)) expect(guard).not.toHaveBeenCalled();
});

it('runs the entry-view fixture through GraphQL with native browsing before pagination', async () => {
  const fixture = await loadFixture('showcase');
  const text = await readFile(join(fixture.root, 'artifacts/2026', SHOWCASE_IDS.entrySource, 'decisions.json'), 'utf8');
  const definition = parseEntrySource(text);
  const request = sourceRequest(definition, {
    filter: { type: 'project', id: SHOWCASE_IDS.project }, search: 'calmer', offset: 0, limit: 1,
  });
  const response = await queryFixture(fixture, request, MOCK_NOW);
  expect(response.errors).toBeUndefined();
  const first = parseSourcePage(definition, response, { offset: 0, limit: 1 });
  expect(first.ids).toEqual(['2026-10-18T08:15']);
  expect(first.totalCount).toBeGreaterThanOrEqual(1);
  const all = await queryFixture(fixture, sourceRequest(definition, {
    filter: { type: 'project', id: SHOWCASE_IDS.project }, search: 'calmer', offset: 0, limit: 50,
  }), MOCK_NOW);
  const complete = parseSourcePage(definition, all, { offset: 0, limit: 50 });
  expect(complete.ids[0]).toBe(first.ids[0]);
  expect(complete.totalCount).toBe(first.totalCount);
  for (const guard of Object.values(forbidden)) expect(guard).not.toHaveBeenCalled();
});
