// @vitest-environment happy-dom
import { referenceLabel } from './reference-label';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import type { DataSource, FileRead } from '../lib/io';
import { entityKey, entryReferences, type EntityRef } from '../lib/types';
import { renderEntry, type RenderOptions } from '../src/render';
import { entityAssets, entityStats } from '../src/entity-relations';
import { groupOpenActions } from '../src/instance';
import { search } from '../src/search';

const ID = '2026-10-04-release', WEEK = '2026-09-28';
const PROJECT = entityKey('project', ID), ACTION = entityKey('action', ID);

class MemorySource implements DataSource {
  files: Record<string, string> = {
    'aside.md': '---\nid: work\nname: Work\n---\n',
    'projects/2026/index.yaml': `- id: ${ID}\n  description: Program work\n`,
    'actions/2026/index.yaml': `- id: ${ID}\n  description: Ship public pages\n`,
    'notes/2026/index.yaml': ['13:00', '12:00', '11:00', '10:00'].map(time => `- id: 2026-10-04T${time}\n  description: Note at ${time}`).join('\n'),
    [`projects/2026/${ID}.md`]: '---\nname: Release program\ncreated: 2026-10-04T09:00\n---\n[Program](../../assets/program.md)\n',
    [`actions/2026/${ID}.md`]: '---\nname: Publish website\ncreated: 2026-10-04T09:00\n---\n[Website](../../assets/website.md)\n',
    [`notes/2026/${WEEK}.md`]: [
      '---', 'week: 40', `week_start: ${WEEK}`, 'week_end: 2026-10-04', '---',
      '---', '```entry', 'created: 2026-10-04T13:00', '```', `Mention #project/${ID}.`,
      '---', '```entry', 'created: 2026-10-04T12:00', `projects: [${ID}]`, `actions: [${ID}]`, '```', 'Shared follow-up.',
      '---', '```entry', 'created: 2026-10-04T11:00', `actions: [${ID}]`, '```', '[Action note](../../assets/action-note.md)',
      '---', '```entry', 'created: 2026-10-04T10:00', `projects: [${ID}]`, '```', '[Project note](../../assets/project-note.md)',
    ].join('\n'),
  };

  async read(path: string): Promise<FileRead | null> {
    const text = this.files[path];
    return text === undefined ? null : { text, version: text };
  }
  async revalidate(path: string, version: string): Promise<FileRead | 'unchanged' | null> {
    const file = await this.read(path);
    return file?.version === version ? 'unchanged' : file;
  }
  assetUrl(): null { return null; }
  async listYears(): Promise<string[]> { return ['2026']; }
}

async function fixture() {
  const source = new MemorySource(), store = new Store(source);
  await store.init();
  return { source, store, relations: await store.getRelations() };
}

afterEach(() => document.body.replaceChildren());

describe('complete entity identity', () => {
  it('renders and searches independently renamed project/action records with the same stable ID', async () => {
    const { store } = await fixture();
    const resolveName: RenderOptions['resolveName'] = (type, id) => type === 'entry' ? id : store.getDisplayName(type, id);
    const opts: RenderOptions = {
      timeFormat: '24h', now: '2026-10-04T14:00', nowDate: new Date('2026-10-04T14:00'),
      activeFilter: null, expandProjects: false, expandActions: false, resolveName,
      onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(),
      routeHref: route => `/work/${route}`, refMarks: () => [],
    };
    const host = document.body.appendChild(document.createElement('main'));
    const card = renderEntry({
      meta: { created: '2026-10-04T14:00', projects: [ID], actions: [ID] }, weekFile: WEEK,
      content: `#project/${ID} and #action/${ID}`,
    }, opts, host);
    for (const [type, name] of [['project', 'Release program'], ['action', 'Publish website']]) {
      const links = Array.from(card.querySelectorAll<HTMLAnchorElement>(`a[data-ref-type="${type}"]`));
      expect(links).toHaveLength(2);
      expect(links.every(link => referenceLabel(link) === name && link.getAttribute('href') === `/work/${type}/${ID}`)).toBe(true);
    }
    const run = (query: string) => search(query, store.getNoteIndex(), store.getProjectIndex(), store.getActionIndex(), { resolveName });
    expect(run('project:Release program').results).toEqual([{ type: 'project', id: ID, description: 'Program work' }]);
    expect(run('action:Publish website').results).toEqual([{ type: 'action', id: ID, description: 'Ship public pages' }]);
    expect(run('Publish website').results.map(result => result.type)).toEqual(['action']);
    expect(run('action:Release program').results).toEqual([]);
  });

  it('keeps filtered entries, activity, statistics and both body/note assets scoped to their type', async () => {
    const { store, relations } = await fixture();
    const entries = await store.getWeekEntries(WEEK);
    const idsFor = (ref: EntityRef) => entries.filter(entry => entryReferences(entry, ref)).map(entry => entry.meta.created);
    expect(relations.entriesByEntity.get(PROJECT)).toEqual(idsFor({ type: 'project', id: ID }));
    expect(relations.entriesByEntity.get(ACTION)).toEqual(idsFor({ type: 'action', id: ID }));
    expect((entityStats('project', ID, relations)[0][1] as (o: RenderOptions) => string)({ timeFormat: '24h' } as RenderOptions)).toBe('3 · latest Oct 4, 2026');
    expect((entityStats('action', ID, relations)[0][1] as (o: RenderOptions) => string)({ timeFormat: '24h' } as RenderOptions)).toBe('2 · latest Oct 4, 2026');
    expect(relations.entriesByEntity.get(PROJECT)?.[0]).toBe('2026-10-04T13:00');
    expect(relations.entriesByEntity.get(ACTION)?.[0]).toBe('2026-10-04T12:00');
    expect(relations.actionsByProject.get(ID)).toEqual([ID]);
    expect(relations.projectsByAction.get(ID)).toEqual([ID]);
    expect(entityAssets('project', ID, relations).map(asset => asset.path)).toEqual(['assets/project-note.md', 'assets/program.md']);
    expect(entityAssets('action', ID, relations).map(asset => asset.path)).toEqual(['assets/action-note.md', 'assets/website.md']);
    const actions = [{ id: ID, action: await store.getAction(ID) }];
    expect(groupOpenActions(actions, id => relations.entriesByEntity.get(entityKey('action', id))?.[0]).backlog)
      .toEqual([{ id: ID, updated: '2026-10-04T12:00' }]);
  });

  it('reports a changed/deleted record by complete identity without displacing the other type', async () => {
    const { source, store } = await fixture();
    source.files[`actions/2026/${ID}.md`] = source.files[`actions/2026/${ID}.md`].replace('Publish website', 'Publish public site');
    const changed = await store.check('full', { weeks: [], entities: [], assets: [] });
    expect(changed?.summary.entities).toEqual(new Set([ACTION]));
    changed!.apply();
    expect(store.getDisplayName('action', ID)).toBe('Publish public site');
    expect(store.getDisplayName('project', ID)).toBe('Release program');
    delete source.files[`actions/2026/${ID}.md`];
    const removed = await store.check('full', { weeks: [], entities: [], assets: [] });
    expect(removed?.summary.entities).toEqual(new Set([ACTION]));
    removed!.apply();
    expect(store.getDisplayName('action', ID)).toBe(ID);
    expect(store.getDisplayName('project', ID)).toBe('Release program');
    expect((entityStats('project', ID, await store.getRelations())[0][1] as (o: RenderOptions) => string)({ timeFormat: '24h' } as RenderOptions)).toBe('3 · latest Oct 4, 2026');
  });
});
