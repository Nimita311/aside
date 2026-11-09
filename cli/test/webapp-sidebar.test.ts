import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { parseManifest, splitFrontMatter } from '../src/core/parser.js';
import { assertWebappSidebar } from '../src/core/webapp-config.js';
import type { WebappSidebarSection } from '../src/core/types.js';
import { handleUpdateInstance, type UpdateInstanceArgs } from '../src/mcp/tools/instance.js';
import { validateToolArgs } from '../src/mcp/schemas.js';
import { Store } from '../src/source/store.js';
import {executeGraphQLWithOwner as executeGraphQL} from './graphql-owner-fixture.js';

const sidebar: WebappSidebarSection[] = [
  { title: 'Focus', items: [
    { timeline: '#artifact/2026-10-12-decisions/focus.json', label: 'Recent decisions' },
    { timeline: '#project/2026-10-12-launch' },
  ] },
  { items: [{ entity: '#action/2026-10-12-review' },
    { entity: 'aside://sidebar-settings/project/2026-10-12-launch/detail?search=calmer', label: 'Project overview' }] },
];
let directory: string | undefined, store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });
function fixture(text = '---\nid: sidebar-settings\nname: Sidebar fixture\n---\n\nInstructions.\n') {
  directory = mkdtempSync('/private/tmp/aside-sidebar-settings-');
  const file = join(directory, 'aside.md'); writeFileSync(file, text);
  store = new Store(directory);
  return file;
}
const metadata = (file: string) => parse(splitFrontMatter(readFileSync(file, 'utf8')).yaml);

describe('instance-owned sidebar declarations', () => {
  it('reads ordered sections and literal target strings from manifest settings', () => {
    const manifest = parseManifest(`---\nid: sidebar-settings\nconfig:\n  recurrenceLookaheadDays: 12\n  webapp:\n    futureSetting: keep\n    sidebar: ${JSON.stringify(sidebar)}\n---\n`);
    expect(manifest.issues).toEqual([]);
    expect(manifest.value.config).toEqual({ webapp: { sidebar } });
    expect(assertWebappSidebar([{ items: [{ timeline: 'a future smart element' }] }]))
      .toEqual([{ items: [{ timeline: 'a future smart element' }] }]);
  });

  it('rejects a whole malformed declaration while reporting its validation issue', () => {
    const declaration = [...sidebar, { items: [{ timeline: 'entries', entity: '#project/example' }] }];
    const manifest = parseManifest(`---\nid: sidebar-settings\nconfig:\n  recurrenceLookaheadDays: 12\n  webapp:\n    sidebar: ${JSON.stringify(declaration)}\n---\n`);
    expect(manifest.value.config).toBeUndefined();
    expect(manifest.issues).toContainEqual(expect.objectContaining({ code: 'invalid_webapp_sidebar', field: 'config.webapp.sidebar' }));
  });

  it('changes only the owned sidebar path, preserving custom settings, aliases and exact body bytes', () => {
    const body = '\n\nUser instructions.  \n\n';
    const original = '---\nid: sidebar-settings\nname: Fixture # keep comment\nconfig:\n  recurrenceLookaheadDays: 12\n  custom: keep\n  webapp: &webapp\n    sidebar: &oldSidebar [{items: [{timeline: entries}]}]\n    appearance: {accent: teal}\nprevious_webapp: *webapp\nprevious_sidebar: *oldSidebar\ncustom_number: 9007199254740993\n---' + body;
    const file = fixture(original);
    handleUpdateInstance(store!, { webapp: { sidebar } });
    const saved = readFileSync(file, 'utf8');
    const value = parseDocument(splitFrontMatter(saved).yaml, { intAsBigInt: true }).toJS();
    expect(value.config.webapp).toEqual({ sidebar, appearance: { accent: 'teal' } });
    expect(value.config).toMatchObject({ recurrenceLookaheadDays: 12n, custom: 'keep' });
    expect(value.previous_webapp).toEqual({ sidebar: [{ items: [{ timeline: 'entries' }] }], appearance: { accent: 'teal' } });
    expect(value.previous_sidebar).toEqual([{ items: [{ timeline: 'entries' }] }]);
    expect(value.custom_number).toBe(9007199254740993n);
    expect(saved).toContain('name: Fixture # keep comment'); expect(saved.endsWith(`---${body}`)).toBe(true);
    expect(store!.getManifest().config?.webapp?.sidebar).toEqual(sidebar);
  });

  it.each(['', 'config: null\n', 'config: {webapp: null, doneEventTitlePrefix: "Done "}\n'])('creates the sidebar under absent or null mappings: %j', config => {
    const file = fixture(`---\nid: sidebar-settings\n${config}---\n\nInstructions.\n`);
    handleUpdateInstance(store!, { webapp: { sidebar } });
    expect(metadata(file).config.webapp.sidebar).toEqual(sidebar);
    expect(readFileSync(file, 'utf8')).toContain('Instructions.');
  });

  it('clears with an explicit empty declaration and preserves omitted settings without rewriting the file', () => {
    const file = fixture();
    handleUpdateInstance(store!, { webapp: { sidebar } });
    const before = readFileSync(file, 'utf8');
    handleUpdateInstance(store!, { webapp: {} });
    expect(readFileSync(file, 'utf8')).toBe(before);
    handleUpdateInstance(store!, { doneEventTitlePrefix: 'Delivered ' });
    expect(metadata(file).config.webapp.sidebar).toEqual(sidebar);
    handleUpdateInstance(store!, { webapp: { sidebar: [] } });
    expect(metadata(file).config).toEqual({ webapp: { sidebar: [] }, doneEventTitlePrefix: 'Delivered ' });
  });

  it.each([
    null, {}, [{ items: 'not-an-array' }], [{ items: [{}] }],
    [{ items: [{ timeline: 'entries', entity: '#project/example' }] }],
    [{ title: ' ', items: [] }], [{ items: [{ timeline: ' ' }] }],
    [{ items: [{ entity: '#project/example', label: null }] }],
    [{ items: [{ timeline: 'entries', id: 'not-supported' }] }],
  ])('validates all sidebar edits before changing any instance field: %j', invalid => {
    const file = fixture(); const before = readFileSync(file, 'utf8');
    const args = { body: 'Must not save.', doneEventTitlePrefix: 'Must not save ', webapp: { sidebar: invalid } };
    expect(() => validateToolArgs('update_instance', args)).toThrow();
    expect(() => handleUpdateInstance(store!, args as unknown as UpdateInstanceArgs)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses malformed existing webapp mappings before saving other valid settings', () => {
    const file = fixture('---\nid: sidebar-settings\nconfig: {webapp: not-a-mapping}\n---\n\nInstructions.\n');
    const before = readFileSync(file, 'utf8');
    expect(() => handleUpdateInstance(store!, { doneEventTitlePrefix: 'No save ', webapp: { sidebar } })).toThrow(/config.webapp must be a YAML mapping/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('round-trips the public GraphQL settings API and rejects invalid declarations atomically', async () => {
    const file = fixture();
    const selection = 'settings { webapp { sidebar { title items { label timeline entity } } } }';
    const read = () => executeGraphQL(store!, 'query', { document: `{ activeInstance { ${selection} } }` });
    const mutate = (input: Record<string, unknown>) => executeGraphQL(store!, 'mutation', {
      document: `mutation($input: UpdateInstanceInput!) { updateInstance(input: $input) { error instance { ${selection} } } }`, variables: { input },
    }, { mutate: (operation, args) => { expect(operation).toBe('update_instance'); handleUpdateInstance(store!, args); return {}; } });
    expect((await read()).data).toMatchObject({ activeInstance: { settings: { webapp: { sidebar: [] } } } });
    const changed = await mutate({ settings: { webapp: { sidebar } } });
    expect(changed.errors).toBeUndefined();
    expect(changed.data).toMatchObject({ updateInstance: { error: null, instance: { settings: { webapp: { sidebar } } } } });
    const before = readFileSync(file, 'utf8');
    for (const invalid of [null, [{ items: [{ timeline: 'entries', entity: 'both' }] }]]) {
      const rejected = await mutate({ body: 'Must not save.', settings: { webapp: { sidebar: invalid } } });
      expect(rejected.errors).toHaveLength(1); expect(rejected.extensions!.mutations).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(before);
    }
    expect((await mutate({ settings: { doneEventTitlePrefix: 'Delivered ' } })).errors).toBeUndefined();
    expect(metadata(file).config.webapp.sidebar).toEqual(sidebar);
    expect((await mutate({ settings: { webapp: { sidebar: [] } } })).errors).toBeUndefined();
    expect((await read()).data).toMatchObject({ activeInstance: { settings: { webapp: { sidebar: [] } } } });
  });
});
