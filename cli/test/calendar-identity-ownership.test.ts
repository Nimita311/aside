import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
import {InstanceCalendarLifecycle} from '../src/daemon/calendar-lifecycle.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {CalSync, storeAction} from '../src/mcp/calendar/sync.js';
import {buildMarker} from '../src/mcp/calendar/markers.js';
import type {CalEvent} from '../src/mcp/calendar/protocol.js';
import {Store} from '../src/source/store.js';
import {calendarMutationFixture, savedEvent} from './calendar-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks();});
const id = '2026-06-01-existing';

function fixture(initialManifest?: string) {
  const root = mkdtempSync('/private/tmp/aside-calendar-identity-owner-');
  mkdirSync(join(root, 'actions', '2026'), {recursive: true});
  const manifest = join(root, 'aside.md');
  const identity = (name: string) => writeFileSync(manifest, `---\nid: ${name}\n---\n`);
  if (initialManifest === undefined) identity('previous');
  else writeFileSync(manifest, initialManifest);
  writeFileSync(join(root, 'actions', '2026', `${id}.md`),
    '---\nname: Existing\ncreated: 2026-06-01\nscheduled: 2026-06-01T09:00\ncalendar: Work\n---\nBody.\n');
  writeFileSync(join(root, 'actions', '2026', '2026-06-01-unpinned.md'),
    '---\nname: Unpinned\ncreated: 2026-06-01\nscheduled: 2026-06-01T09:00\n---\nBody.\n');
  const store = new Store(root), cal = new CalClient(null);
  const events = new Map<string, CalEvent>([['old-event', savedEvent({
    calendar: 'Work', marker: buildMarker('previous', id, 'active'), title: '▢ Existing',
    start: '2026-06-01T09:00', end: '2026-06-01T09:30', durationMinutes: 30,
  }, 'old-event')]]);
  vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({status: 'fullAccess'});
  vi.spyOn(cal, 'listCalendars').mockResolvedValue({calendars: [{id: 'work', name: 'Work', account: 'local', writable: true, type: 'local'}]});
  vi.spyOn(cal, 'listEvents').mockImplementation(async () => ({events: [...events.values()]}));
  vi.spyOn(cal, 'getEvents').mockImplementation(async ({eventIds}) => ({events: eventIds.flatMap(key => events.has(key) ? [events.get(key)!] : [])}));
  let sequence = 0;
  const upsert = vi.spyOn(cal, 'upsertEvent').mockImplementation(async args => {
    const eventId = args.eventId ?? `new-event-${++sequence}`;
    events.set(eventId, savedEvent(args, eventId));
    return {eventId};
  });
  vi.spyOn(cal, 'deleteEvent').mockImplementation(async ({eventId}) => ({deleted: events.delete(eventId)}));
  const requested = vi.fn(), owner = new InstanceCalendarLifecycle(requested);
  const sync = new CalSync(cal, '', store, undefined, undefined, calendarMutationFixture(store));
  owner.register(store, sync);
  cleanup.push(() => {owner.unregister(store); sync.dispose(); cal.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  const changeIdentity = (name: string) => {identity(name); store.rebuild();};
  return {root, manifest, store, cal, sync, owner, events, upsert, requested, changeIdentity};
}

describe('Calendar identity transition ownership', () => {
  it('replays the owner-selected current actions despite a receipt from the previous identity', async () => {
    const f = fixture();
    await f.owner.reconcile(f.store);
    expect(f.sync.status(id)).toMatchObject({status: 'synced', eventId: 'old-event'});
    expect(f.upsert).not.toHaveBeenCalled();
    const forward = vi.spyOn(f.sync, 'syncActions');
    f.changeIdentity('current');
    // Even an adapter receipt observed before its private identity reset cannot
    // acknowledge the owner's new-generation replay intent.
    vi.spyOn(f.sync, 'status').mockReturnValueOnce({id, status: 'synced', eventId: 'old-event'});
    await f.owner.reconcile(f.store);
    expect(forward.mock.calls[0][0].map(action => action.id)).toEqual([id]);
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.upsert.mock.calls[0][0]).toMatchObject({marker: buildMarker('current', id, 'active')});
    expect(f.upsert.mock.calls[0][0].eventId).toBeUndefined();
    expect(f.events.get('old-event')?.url).toBe(buildMarker('previous', id, 'active'));
    expect(f.sync.status(id)).toMatchObject({status: 'synced', eventId: 'new-event-1'});
  });

  it('does not create replay intents when only the protocol adapter observes a new identity', async () => {
    const f = fixture();
    await f.sync.syncActions([storeAction(f.store, id)!], [storeAction(f.store, id)!]);
    const writes = f.upsert.mock.calls.length;
    f.changeIdentity('current');
    const enumerate = vi.spyOn(f.store, 'getActionIds');
    f.requested.mockClear();
    await f.sync.syncActions([], [storeAction(f.store, id)!]);
    expect(enumerate).not.toHaveBeenCalled();
    expect(f.upsert).toHaveBeenCalledTimes(writes);
    expect(f.requested).not.toHaveBeenCalled();
  });

  it('selects the latest identity again when it changes during a helper write', async () => {
    const f = fixture();
    await f.owner.reconcile(f.store);
    const save = f.upsert.getMockImplementation()!;
    f.upsert.mockImplementationOnce(async args => {
      const result = await save(args);
      f.changeIdentity('latest');
      return result;
    });
    f.changeIdentity('intermediate');
    await f.owner.reconcile(f.store);
    expect(f.upsert.mock.calls.map(([args]) => args.marker)).toEqual([
      buildMarker('intermediate', id, 'active'), buildMarker('latest', id, 'active'),
    ]);
    expect(f.upsert.mock.calls.every(([args]) => args.eventId === undefined)).toBe(true);
    expect(f.sync.status(id)).toMatchObject({status: 'synced', eventId: 'new-event-2'});
    expect(f.store.getAction(id)!.frontMatter.scheduled).toBe('2026-06-01T09:00');
  });

  it('preserves the identity baseline through a failed manifest read and its repair', async () => {
    const f = fixture();
    await f.owner.reconcile(f.store);
    const forward = vi.spyOn(f.sync, 'syncActions');
    rmSync(f.manifest); mkdirSync(f.manifest); f.store.rebuild();
    await f.owner.reconcile(f.store);
    expect(forward).not.toHaveBeenCalled();
    expect(f.upsert).not.toHaveBeenCalled();
    rmSync(f.manifest, {recursive: true}); f.changeIdentity('previous');
    await f.owner.reconcile(f.store);
    expect(forward.mock.calls[0][0]).toEqual([]);
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.store.getAction(id)!.frontMatter.scheduled).toBe('2026-06-01T09:00');
  });

  it('establishes the first healthy identity after cold manifest repair without replaying an offline deletion', async () => {
    const f = fixture('---\nid: [invalid\n---\n');
    f.events.clear();
    const forward = vi.spyOn(f.sync, 'syncActions');
    await f.owner.reconcile(f.store);
    expect(f.store.getManifestSourceHealth().complete).toBe(false);
    expect(forward).not.toHaveBeenCalled();

    f.changeIdentity('previous');
    await f.owner.reconcile(f.store);

    expect(forward.mock.calls[0][0]).toEqual([]);
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.store.getAction(id)!.frontMatter.scheduled).toBeUndefined();
    expect(f.sync.changesSinceStart()).toContainEqual({id, summary: 'descheduled (event deleted)'});
  });

  it('still forwards action edits observed while the initial manifest identity was unknown', async () => {
    const f = fixture('---\nid: [invalid\n---\n');
    const forward = vi.spyOn(f.sync, 'syncActions');
    await f.owner.reconcile(f.store);
    const action = f.store.getAction(id)!;
    f.store.saveAction(id, {...action.frontMatter, scheduled: '2026-06-01T12:00'}, action.body, f.store.getActionFile(id)!);
    f.changeIdentity('previous');

    await f.owner.reconcile(f.store);

    expect(forward.mock.calls[0][0].map(action => action.id)).toEqual([id]);
    expect(f.upsert).toHaveBeenCalledOnce();
    expect(f.upsert.mock.calls[0][0].start).toBe('2026-06-01T12:00');
    expect(f.store.getAction(id)!.frontMatter.scheduled).toBe('2026-06-01T12:00');
  });
});

// Follow local helper calls so extracting the old scan into another CalSync
// method cannot hide whole-instance selection inside identity cache handling.
function identitySelectionErrors(text: string): string[] {
  const source = ts.createSourceFile('calendar.ts', text, ts.ScriptTarget.Latest, true);
  const methods = new Map<string, ts.Node>();
  const names = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression) => ts.isPropertyAccessExpression(node)
    ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
  const collect = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'CalSync') {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) methods.set(member.name.text, member);
        else if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.initializer
          && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) methods.set(member.name.text, member.initializer);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const errors: string[] = [], checked = new Set<string>();
  function check(name: string) {
    if (checked.has(name)) return;
    checked.add(name);
    const method = methods.get(name); if (!method) return;
    const visit = (node: ts.Node) => {
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const member = node.propertyName ?? node.name;
        if ((ts.isIdentifier(member) || ts.isStringLiteral(member)) && /^(getActions|getActionIds|getAction|requestOutboxRetry|requestReconciliation)$/.test(member.text)) errors.push(`${name}: ${member.text}`);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const member = names(node);
        if (member && /^(getActions|getActionIds|getAction|requestOutboxRetry|requestReconciliation)$/.test(member)) errors.push(`${name}: ${member}`);
        if (member === 'set' && /(?:\.|\[['"])outbox(?:['"]\])?$/.test(node.expression.getText(source))) errors.push(`${name}: outbox.set`);
        if (node.expression.kind === ts.SyntaxKind.ThisKeyword && member && methods.has(member)) check(member);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'storeAction') errors.push(`${name}: storeAction`);
      ts.forEachChild(node, visit);
    };
    visit(method);
  }
  check('refreshIdentity');
  return errors;
}

describe('Calendar identity selection architecture', () => {
  it('keeps adapter identity handling limited to private state and operation guards', () => {
    const text = readFileSync(join(import.meta.dirname, '../src/mcp/calendar/sync.ts'), 'utf8');
    expect(identitySelectionErrors(text)).toEqual([]);
  });

  it.each([
    'this.store.getActionIds();',
    'const select = this.store.getActions.bind(this.store); select();',
    'this.outbox.set(id, action);',
    'this.requestOutboxRetry();',
    'this.queue(); } private queue(){ this.store.getActions();',
    'const {getActionIds: select} = this.store; select();',
    'this.queue(); } private queue = () => { this.store.getActions();',
  ])('rejects adapter-owned replay selection: %s', operation => {
    expect(identitySelectionErrors(`class CalSync { private refreshIdentity(){ ${operation} } }`)).not.toEqual([]);
  });

  it('allows private cache reset and a use-time identity guard', () => {
    expect(identitySelectionErrors('class CalSync { private refreshIdentity(){ this.cache.clear(); this.recurrenceSync.reset(); this.store.assertSourceIdentity(id); } }')).toEqual([]);
  });
});
