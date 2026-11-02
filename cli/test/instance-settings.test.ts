import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { splitFrontMatter } from '../src/core/parser.js';
import { Store } from '../src/mcp/store.js';
import { handleUpdateInstance, type UpdateInstanceArgs } from '../src/mcp/tools/instance.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { CalSync } from '../src/mcp/calendar/sync.js';
import { serializeAction } from '../src/mcp/tools/serialize.js';
import * as indexFile from '../src/mcp/tools/index-file.js';

describe('instance instruction and Calendar title prefix edits', () => {
  let directory: string | undefined;
  let store: Store | undefined;
  let host: InstanceHost | undefined;
  const fixture = (source: string) => {
    directory = mkdtempSync('/private/tmp/aside-instance-settings-');
    const file = join(directory, 'aside.md');
    writeFileSync(file, source);
    store = new Store(directory);
    return file;
  };
  const manifest = (file: string) => parse(splitFrontMatter(readFileSync(file, 'utf8')).yaml.replace(/\r(?=\n|$)/g, ''));
  const publicInput = (input: Record<string, unknown>) => {
    const settings = Object.fromEntries(Object.entries(input).filter(([key]) => ['recurrenceLookaheadDays', 'scheduledEventTitlePrefix', 'doneEventTitlePrefix'].includes(key)));
    const rest = Object.fromEntries(Object.entries(input).filter(([key]) => !(key in settings)));
    return {...rest, ...(Object.keys(settings).length ? {settings} : {})};
  };
  const calendarFixture = async (config = '') => {
    const file = fixture(`---\nid: instance-settings\n${config}---\n\nInstructions.\n`);
    const actionDirectory = join(directory!, 'actions', '2026');
    mkdirSync(actionDirectory, { recursive: true });
    const actions = [
      { id: '2026-10-11-scheduled', fields: { scheduled: '2026-10-12T09:00', calendar: 'Work' } },
      { id: '2026-10-11-done', fields: { scheduled: '2026-10-11T09:00', calendar: 'Work', resolution: 'done' as const } },
      { id: '2026-10-11-template', fields: { recurrence: [{ dtstart: '2099-10-11T09:00', rrule: 'FREQ=DAILY', timezone: 'UTC' }], calendar: 'Work' } },
      { id: '2026-10-11-backlog', fields: {} },
    ];
    for (const { id, fields } of actions) writeFileSync(join(actionDirectory, `${id}.md`), serializeAction({ name: id, created: '2026-10-11T08:00', ...fields }, ''));
    writeFileSync(join(actionDirectory, 'index.yaml'), actions.map(({ id }) => `- id: ${id}\n  description: Fixture\n`).join(''));
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    const forward = vi.spyOn(CalSync.prototype, 'syncActions').mockResolvedValue([]);
    vi.spyOn(CalSync.prototype, 'reconcile').mockResolvedValue(undefined);
    vi.spyOn(CalSync.prototype, 'status').mockImplementation(id => ({ id, status: 'pending' }));
    host = new InstanceHost(new CalClient(null));
    host.load(directory!);
    await host.flush();
    forward.mockClear();
    const update = async (input: Record<string, unknown>, graphql = true) => {
      const result = await host!.tool(directory!, graphql ? 'mutate' : 'update_instance', graphql ? {
        document: 'mutation($input: UpdateInstanceInput!) { updateInstance(input: $input) { error } }', variables: { input: publicInput(input) },
      } : input);
      return graphql ? JSON.parse(result.text) : result.text;
    };
    return { file, forward, update };
  };
  afterEach(async () => {
    await host?.close(); host = undefined;
    store?.close(); store = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    vi.restoreAllMocks();
  });

  it.each(['\n', '\r\n'])('replaces instructions while preserving the original metadata bytes with %j newlines and a BOM', eol => {
    const header = [
      '\ufeff---',
      'id: instance-settings',
      'name: Fixture # keep comment',
      'custom: &details {ticket: 9007199254740993}',
      'custom_copy: *details',
      'custom_text: |+',
      '  Preserve trailing scalar whitespace.',
      '', '',
      '---',
    ].join(eol);
    const file = fixture(`${header}${eol}${eol}Old instructions.  ${eol}`);

    const receipt = handleUpdateInstance(store!, { body: '# Instructions\nKeep literal $HOME and ---\n' });
    const saved = readFileSync(file, 'utf8');
    expect(saved).toBe(`${header}${eol}${eol}# Instructions${eol}Keep literal $HOME and ---${eol}`);
    expect(store!.getInstance()?.body).toBe('# Instructions\nKeep literal $HOME and ---'.replace(/\n/g, eol));
    expect(JSON.parse(receipt.split('\n\n')[1]).body).toBe(store!.getInstance()?.body);
    expect(parseDocument(splitFrontMatter(saved).yaml.replace(/\r(?=\n|$)/g, ''), { intAsBigInt: true }).toJS().custom.ticket).toBe(9007199254740993n);
  });

  it('clears instructions with an empty string and leaves manifest fields unchanged', () => {
    const file = fixture('---\nid: instance-settings\nconfig: {doneEventTitlePrefix: "Delivered "}\n---\n\nOld instructions.\n');
    handleUpdateInstance(store!, { body: '' });
    expect(store!.getInstance()?.body).toBe('');
    expect(manifest(file)).toEqual({ id: 'instance-settings', config: { doneEventTitlePrefix: 'Delivered ' } });
  });

  it('sets empty and nonempty prefixes while preserving custom config, aliases, comments, precision, and the omitted body', () => {
    const body = '\r\n\r\nKeep these instructions.  \r\n\r\n';
    const source = '\ufeff---\r\nid: instance-settings\r\nconfig: &settings\r\n  recurrenceLookaheadDays: 12 # keep lookahead\r\n  doneEventTitlePrefix: &done "Old " # keep prefix comment\r\n  custom: &detail {ticket: 9007199254740993}\r\ncustom_config: *settings\r\ncustom_prefix: *done\r\ncustom_detail: *detail\r\n---' + body;
    const file = fixture(source);

    handleUpdateInstance(store!, { scheduledEventTitlePrefix: '', doneEventTitlePrefix: 'Delivered ' });

    const saved = readFileSync(file, 'utf8');
    const metadata = parseDocument(splitFrontMatter(saved).yaml.replace(/\r(?=\n|$)/g, ''), { intAsBigInt: true }).toJS();
    expect(metadata.config).toMatchObject({ recurrenceLookaheadDays: 12n, doneEventTitlePrefix: 'Delivered ', scheduledEventTitlePrefix: '', custom: { ticket: 9007199254740993n } });
    expect(metadata.custom_config.doneEventTitlePrefix).toBe('Old ');
    expect(metadata.custom_prefix).toBe('Old ');
    expect(metadata.custom_detail.ticket).toBe(9007199254740993n);
    expect(saved).toContain('# keep lookahead');
    expect(saved).toContain('# keep prefix comment');
    expect(splitFrontMatter(saved).body).toBe(splitFrontMatter(source).body);
    expect(store!.getManifest().config).toEqual({ recurrenceLookaheadDays: 12, scheduledEventTitlePrefix: '', doneEventTitlePrefix: 'Delivered ' });
  });

  it('restores each default with null without changing the other prefix or lookahead', () => {
    const file = fixture('---\nid: instance-settings\nconfig: {scheduledEventTitlePrefix: "Plan ", doneEventTitlePrefix: "Delivered ", recurrenceLookaheadDays: 12}\n---\n\nInstructions.\n');
    handleUpdateInstance(store!, { scheduledEventTitlePrefix: null });
    expect(manifest(file).config).toEqual({ doneEventTitlePrefix: 'Delivered ', recurrenceLookaheadDays: 12 });
    handleUpdateInstance(store!, { doneEventTitlePrefix: null });
    expect(manifest(file).config).toEqual({ recurrenceLookaheadDays: 12 });
    expect(store!.getManifest().config).toEqual({ recurrenceLookaheadDays: 12 });
    expect(store!.getInstance()?.body).toBe('Instructions.');
  });

  it('creates configuration for a prefix when config is absent', () => {
    const file = fixture('---\nid: instance-settings\n---\n');
    handleUpdateInstance(store!, { scheduledEventTitlePrefix: 'Work ' });
    expect(manifest(file).config).toEqual({ scheduledEventTitlePrefix: 'Work ' });
  });

  it('replaces an explicit null config and preserves aliased config keys', () => {
    const file = fixture('---\nid: instance-settings\nconfig_key: &key config\n*key : null\n---\n\nInstructions.\n');
    handleUpdateInstance(store!, { doneEventTitlePrefix: '' });
    expect(manifest(file).config).toEqual({ doneEventTitlePrefix: '' });
    expect(store!.getManifest().config).toEqual({ doneEventTitlePrefix: '' });
  });

  it('preserves newer disk instructions and prefixes when the Store has not rebuilt', () => {
    const file = fixture('---\nid: instance-settings\nconfig: {doneEventTitlePrefix: "Old "}\n---\n\nOld instructions.\n');
    writeFileSync(file, '---\nid: instance-settings\nconfig: {doneEventTitlePrefix: "New ", recurrenceLookaheadDays: 10}\n---\n\nNew instructions.\n');
    handleUpdateInstance(store!, { scheduledEventTitlePrefix: '' });
    expect(store!.getManifest().config).toEqual({ recurrenceLookaheadDays: 10, scheduledEventTitlePrefix: '', doneEventTitlePrefix: 'New ' });
    expect(store!.getInstance()?.body).toBe('New instructions.');
  });

  it.each([
    { body: null },
    { scheduledEventTitlePrefix: 10 },
    { doneEventTitlePrefix: false },
    { recurrenceLookaheadDays: null },
  ])('rejects invalid settings before applying any valid edits: %j', invalid => {
    const source = '---\nid: instance-settings\n---\n\nOld instructions.\n';
    const file = fixture(source);
    expect(() => handleUpdateInstance(store!, { body: 'Changed instructions.', ...invalid } as unknown as UpdateInstanceArgs)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(source);
    expect(store!.getInstance()?.body).toBe('Old instructions.');
  });

  it('refuses to modify aliased configuration rather than change another field through a shared anchor', () => {
    const source = '---\nid: instance-settings\ncustom: &settings {doneEventTitlePrefix: "Old "}\nconfig: *settings\n---\n\nOld instructions.\n';
    const file = fixture(source);
    expect(() => handleUpdateInstance(store!, { doneEventTitlePrefix: 'New ', body: 'Changed instructions.' })).toThrow(/Resolve aliased or malformed config/);
    expect(readFileSync(file, 'utf8')).toBe(source);
  });

  it('rejects unresolved aliases before an instruction-only write', () => {
    const source = '---\nid: instance-settings\ncustom: *missing\n---\n\nOld instructions.\n';
    const file = fixture(source);
    expect(() => handleUpdateInstance(store!, { body: 'Changed instructions.' })).toThrow(/aliases cannot be resolved/);
    expect(readFileSync(file, 'utf8')).toBe(source);
  });

  it('round-trips instructions and prefix set/reset through GraphQL and daemon validation', async () => {
    const file = fixture('---\nid: instance-settings\nconfig: {doneEventTitlePrefix: "Old "}\n---\n\nOld instructions.\n');
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    host = new InstanceHost(new CalClient(null));
    const graph = async (input: Record<string, unknown>) => JSON.parse((await host!.tool(directory!, 'mutate', {
      document: 'mutation($input: UpdateInstanceInput!) { updateInstance(input: $input) { instance { body settings { scheduledEventTitlePrefix doneEventTitlePrefix } } } }',
      variables: { input: publicInput(input) },
    })).text);

    const changed = await graph({ body: 'Only user-stated instructions.', scheduledEventTitlePrefix: '', doneEventTitlePrefix: 'Delivered ' });
    expect(changed.errors).toBeUndefined();
    expect(changed.data.updateInstance.instance).toEqual({ body: 'Only user-stated instructions.', settings: { scheduledEventTitlePrefix: '', doneEventTitlePrefix: 'Delivered ' } });

    const reset = await graph({ doneEventTitlePrefix: null });
    expect(reset.errors).toBeUndefined();
    expect(reset.data.updateInstance.instance).toEqual({ body: 'Only user-stated instructions.', settings: { scheduledEventTitlePrefix: '', doneEventTitlePrefix: '✓ ' } });
    const before = readFileSync(file, 'utf8');
    const invalid = await graph({ body: null, doneEventTitlePrefix: 'Must not save ' });
    expect(invalid.errors).toBeDefined();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each([true, false])('immediately queues ordinary, completed, and template Calendar updates after a prefix edit (GraphQL: %s)', async graphql => {
    const { file, forward, update } = await calendarFixture();
    const result = await update({ scheduledEventTitlePrefix: 'Planned ' }, graphql);
    expect(forward).toHaveBeenCalledOnce();
    const [changed, allScheduled] = forward.mock.calls[0];
    expect(changed.map(action => action.id).sort()).toEqual(['2026-10-11-done', '2026-10-11-scheduled', '2026-10-11-template']);
    expect(allScheduled).toBe(changed);
    expect(changed.find(action => action.id === '2026-10-11-template')?.frontMatter.recurrence).toEqual([{ dtstart: '2099-10-11T09:00', rrule: 'FREQ=DAILY', timezone: 'UTC' }]);
    expect(manifest(file).config.scheduledEventTitlePrefix).toBe('Planned ');
    if (graphql) {
      expect(result.errors).toBeUndefined();
      expect(result.data.updateInstance.error).toBeNull();
    } else {
      expect(result).toContain('calendar_sync:');
      expect(result).toContain('status: pending');
    }
  });

  it('queues Calendar work when null changes a custom prefix, but skips reset of an explicit default', async () => {
    const { forward, update } = await calendarFixture('config: {scheduledEventTitlePrefix: "Custom ", doneEventTitlePrefix: "✓ "}\n');
    expect((await update({ scheduledEventTitlePrefix: null })).errors).toBeUndefined();
    expect(forward).toHaveBeenCalledOnce();
    forward.mockClear();
    expect((await update({ doneEventTitlePrefix: null })).errors).toBeUndefined();
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    { body: 'New instructions.' },
    { recurrenceLookaheadDays: 12 },
    { scheduledEventTitlePrefix: '▢ ' },
    { doneEventTitlePrefix: null },
  ])('does not queue Calendar writes when effective prefixes stay unchanged: %j', async input => {
    const { forward, update } = await calendarFixture();
    expect((await update(input)).errors).toBeUndefined();
    expect(forward).not.toHaveBeenCalled();
  });

  it('does not queue Calendar work when saving a prefix fails', async () => {
    const { file, forward, update } = await calendarFixture();
    const before = readFileSync(file, 'utf8');
    vi.spyOn(indexFile, 'writeFileCrashSafe').mockImplementation(() => { throw new Error('Fixture write failure'); });
    const result = await update({ doneEventTitlePrefix: 'Delivered ' });
    expect(result.errors[0].message).toContain('Fixture write failure');
    expect(forward).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
