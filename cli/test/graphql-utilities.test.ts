import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { validate } from '../src/core/validator.js';
import { InstanceHost } from '../src/daemon/host.js';
import { executeGraphQL } from '../src/graphql/schema.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';
import { CalClient, CalError } from '../src/mcp/calendar/client.js';
import { collectCalendarInfo } from '../src/mcp/calendar/info.js';
import { buildShowRoute } from '../src/mcp/tools/show.js';
import type { CalAuthStatus } from '../src/mcp/calendar/protocol.js';
import { openBrowser } from '../src/web/locate.js';

vi.mock('../src/web/locate.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/web/locate.js')>(), openBrowser: vi.fn(async () => true),
}));
const dirs: string[] = [], hosts: InstanceHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.mocked(openBrowser).mockClear(); vi.mocked(openBrowser).mockResolvedValue(true);
});
function fixture(selected = false) {
  const dir = realpathSync(mkdtempSync('/tmp/aside-gql-utilities-')); dirs.push(dir);
  const a = join(dir, 'a'), b = join(dir, 'b');
  init(a, { name: 'A', description: 'First' }); init(b, { name: 'B', description: 'Second' });
  const registry = new InstanceRegistry([a, b]); if (selected) registry.activate(a);
  const cal = new CalClient(null), host = new InstanceHost(cal); hosts.push(host);
  const session = new InstanceSession(registry, { knownInstances: async () => [a, b], issues: async () => [] }, [], false, true);
  return { a, b, cal, host, session, registry };
}
function calendar(cal: CalClient, status: CalAuthStatus) {
  vi.spyOn(cal, 'available').mockReturnValue(true);
  vi.spyOn(cal, 'authStatus').mockResolvedValue({ status });
  const request = vi.spyOn(cal, 'requestAccess').mockResolvedValue({ granted: true, status: 'fullAccess' });
  const list = vi.spyOn(cal, 'listCalendars').mockResolvedValue({ calendars: [{ id: 'private', name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }] });
  const events = vi.spyOn(cal, 'listEvents');
  const upsert = vi.spyOn(cal, 'upsertEvent');
  return { request, list, events, upsert };
}
const calendarDocument = `mutation { calendarInfo {
  authorization calendars { name account writable type } diagnostics { category recovery }
  syncStates { id status reason retry } failures { id diagnostic { category recovery } }
  issues { id reason } changes { id summary }
} }`;

describe('GraphQL validation and utility mutations', () => {
  it('validates several instances without selecting or loading record stores, and reads changes on the next request', async () => {
    const { a, b, session, registry } = fixture();
    const noStore = vi.fn(() => { throw new Error('Records should not load'); });
    const args = { document: '{ instances { path validation { passed dataChecksRun checks { name passed details } } } activeInstance { path } }' };
    const first = await executeGraphQL(noStore, 'query', args, { instances: session });
    expect(first.errors).toBeUndefined(); expect(first.data!.activeInstance).toBeNull();
    const normalized = (path: string) => { const result = validate(path); return { ...result, checks: result.checks.map(check => ({ ...check, details: check.details ?? [] })) }; };
    expect(first.data!.instances).toEqual([{ path: a, validation: normalized(a) }, { path: b, validation: normalized(b) }]);
    writeFileSync(join(b, 'aside.md'), '---\nid: invalid ID\nname: B\n---\n');
    const second = await executeGraphQL(noStore, 'query', args, { instances: session });
    expect(second.errors).toBeUndefined();
    expect((second.data!.instances as any[])[1].validation.passed).toBe(false);
    expect(registry.activeInstance).toBeNull(); expect(noStore).not.toHaveBeenCalled();
  });

  it.each(['notDetermined', 'writeOnly'] as const)('requests access once from %s and returns calendars without selecting an instance', async status => {
    const { cal, host, session, registry } = fixture(); const f = calendar(cal, status);
    const result = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(result.errors).toBeUndefined();
    expect(result.data!.calendarInfo).toMatchObject({ authorization: 'FULL_ACCESS', calendars: [{ name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }], diagnostics: [], syncStates: [] });
    expect(f.request).toHaveBeenCalledOnce(); expect(f.list).toHaveBeenCalledOnce();
    expect(f.events).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
    expect(registry.activeInstance).toBeNull();
    expect(result.extensions!.mutations).toEqual([{ operation: 'calendarInfo', error: null, changes: [] }]);
  });

  it('returns denied access and unavailable helpers as data with GraphQL recovery guidance', async () => {
    const { cal, host, session } = fixture();
    const unavailable = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(unavailable.errors).toBeUndefined(); expect(unavailable.data!.calendarInfo).toMatchObject({ authorization: 'UNAVAILABLE', calendars: null });
    const f = calendar(cal, 'denied');
    const denied = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(denied.errors).toBeUndefined();
    expect(denied.data!.calendarInfo).toMatchObject({ authorization: 'DENIED', calendars: null, diagnostics: [{ category: 'authorization-denied', recovery: expect.stringContaining('calendarInfo via mutate') }] });
    expect(f.request).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
  });

  it('returns authorization and listing failures without losing sync observations', async () => {
    const { cal, host, session } = fixture(); const f = calendar(cal, 'writeOnly');
    f.request.mockRejectedValue(new CalError('Request refused', 'authorization-request-failed'));
    const failed = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(failed.errors).toBeUndefined();
    expect(failed.data!.calendarInfo).toMatchObject({ authorization: 'WRITE_ONLY', calendars: null, diagnostics: [{ category: 'authorization-request-failed' }] });
    vi.mocked(cal.authStatus).mockResolvedValue({ status: 'fullAccess' });
    f.list.mockRejectedValue(new Error('Cannot list'));
    const report = await collectCalendarInfo(cal, {
      statuses: () => [{ id: 'action', status: 'pending', retry: true }],
      failureDiagnostics: () => [{ id: 'action', diagnostic: { category: 'test', reason: 'Observed', recovery: 'Retry' } }],
      report: () => [{ id: 'action', reason: 'Pending' }], changesSinceStart: () => [{ id: 'action', summary: 'Rescheduled' }],
    });
    const result = await executeGraphQL(() => { throw new Error('No store'); }, 'mutation', { document: calendarDocument }, { calendarInfo: async () => report });
    expect(result.errors).toBeUndefined();
    expect(result.data!.calendarInfo).toMatchObject({ authorization: 'FULL_ACCESS', calendars: null, syncStates: [{ id: 'action', status: 'PENDING', retry: true }], failures: [{ id: 'action', diagnostic: { category: 'test', recovery: 'Retry' } }], issues: [{ id: 'action', reason: 'Pending' }], changes: [{ id: 'action', summary: 'Rescheduled' }] });
  });

  it('consolidates failed sync-state diagnostics even when the redundant failure is omitted', async () => {
    const { cal } = fixture(); calendar(cal, 'fullAccess');
    const diagnostic = { category: 'test', reason: 'Calendar save failed', recovery: 'Use update_action, then calendar_info.' };
    const report = await collectCalendarInfo(cal, {
      statuses: () => ['action', 'other'].map(id => ({ id, status: 'failed', reason: diagnostic.reason, diagnostic })),
      failureDiagnostics: () => ['action', 'other'].map(id => ({ id, diagnostic })),
      report: () => ['action', 'other'].map(id => ({ id, reason: diagnostic.reason })), changesSinceStart: () => [],
    });
    expect(report.failures).toEqual([]);
    const expected = ['action', 'other'].map(id => `${id}: Calendar save failed Recovery: Use updateAction via mutate, then calendarInfo via mutate.`).join('\n');
    for (const document of ['mutation { calendarInfo { error } }', 'mutation { calendarInfo { syncStates { status } } }']) {
      const result = await executeGraphQL(() => { throw new Error('No store'); }, 'mutation', { document }, { calendarInfo: async () => report });
      expect(result.errors).toBeUndefined();
      if (document.includes('{ error }')) expect((result.data!.calendarInfo as any).error).toBe(expected);
      expect(result.extensions!.mutations).toEqual([{ operation: 'calendarInfo', error: expected, changes: [] }]);
    }
    expect(diagnostic.recovery).toBe('Use update_action, then calendar_info.');
  });

  it('reports failed states without diagnostics and standalone consistency issues once', async () => {
    const { cal } = fixture(); calendar(cal, 'fullAccess');
    const report = await collectCalendarInfo(cal, {
      statuses: () => [{ id: 'action', status: 'failed', reason: 'Action file unavailable' }],
      report: () => [{ id: 'action', reason: 'Action file unavailable' }, { id: 'reverse sync', reason: 'Could not confirm an event' }],
      changesSinceStart: () => [],
    });
    const result = await executeGraphQL(() => { throw new Error('No store'); }, 'mutation', {
      document: 'mutation { calendarInfo { error } }',
    }, { calendarInfo: async () => report });
    const expected = 'action: Action file unavailable\nreverse sync: Could not confirm an event';
    expect(result.errors).toBeUndefined();
    expect((result.data!.calendarInfo as any).error).toBe(expected);
    expect(result.extensions!.mutations).toEqual([{ operation: 'calendarInfo', error: expected, changes: [] }]);
  });

  it('does not report ordinary pending sync, Calendar opt-out, or observed changes as errors', async () => {
    const { cal } = fixture(); calendar(cal, 'fullAccess');
    const waiting = 'calendar busy (another sync in progress), will retry';
    const report = await collectCalendarInfo(cal, {
      statuses: () => [{ id: 'action', status: 'pending', reason: 'Calendar sync in progress',
        diagnostic: { category: 'sync-pending', reason: 'Calendar sync in progress', recovery: 'Check calendar_info for completion.' } },
        { id: 'queued', status: 'pending', reason: waiting, retry: true,
          diagnostic: { category: 'sync-pending', reason: waiting, recovery: 'Check calendar_info for completion.' } },
        { id: 'unbound', status: 'disabled', reason: 'no calendar' },
        { id: 'deleted', status: 'disabled', reason: 'action no longer exists',
          diagnostic: { category: 'old-failure', reason: 'Earlier retry failed', recovery: 'Retry the action.' } }],
      report: () => [{ id: 'queued', reason: waiting }, { id: 'unbound', reason: 'no calendar' }], changesSinceStart: () => [{ id: 'other', summary: 'Rescheduled' }],
    });
    const result = await executeGraphQL(() => { throw new Error('No store'); }, 'mutation', {
      document: 'mutation { calendarInfo { error syncStates { status } changes { summary } } }',
    }, { calendarInfo: async () => report });
    expect(result.errors).toBeUndefined();
    expect(result.data!.calendarInfo).toMatchObject({ error: null, syncStates: [{ status: 'PENDING' }, { status: 'PENDING' }, { status: 'DISABLED' }, { status: 'DISABLED' }], changes: [{ summary: 'Rescheduled' }] });
    expect(result.extensions!.mutations).toEqual([{ operation: 'calendarInfo', error: null, changes: [] }]);
  });

  it('distinguishes an authorization error, an undecided permission response, and an empty calendar list', async () => {
    const { cal, host, session } = fixture(); const f = calendar(cal, 'notDetermined');
    f.request.mockResolvedValue({ granted: false, status: 'notDetermined' });
    const undecided = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(undecided.errors).toBeUndefined();
    expect(undecided.data!.calendarInfo).toMatchObject({ authorization: 'NOT_DETERMINED', calendars: null, diagnostics: [{ category: 'authorization-notDetermined' }] });
    vi.mocked(cal.authStatus).mockRejectedValueOnce(new Error('Helper failed'));
    const failed = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(failed.errors).toBeUndefined(); expect(failed.data!.calendarInfo).toMatchObject({ authorization: 'ERROR', calendars: null });
    vi.mocked(cal.authStatus).mockResolvedValue({ status: 'fullAccess' }); f.list.mockResolvedValue({ calendars: [] });
    const empty = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(empty.errors).toBeUndefined(); expect(empty.data!.calendarInfo).toMatchObject({ authorization: 'FULL_ACCESS', calendars: [] });
  });

  it('reports the sync state of the instance selected earlier in the same mutation', async () => {
    const { a, b, host, session } = fixture(true);
    vi.spyOn(host.load(a).sync, 'statuses').mockReturnValue([{ id: 'a-action', status: 'failed' }]);
    vi.spyOn(host.load(b).sync, 'statuses').mockReturnValue([{ id: 'b-action', status: 'synced' }]);
    const result = await host.graphql(session, 'mutation', { document: 'mutation($path: String!) { selectInstance(path: $path) { instance { path } } calendarInfo { authorization syncStates { id status } } }', variables: { path: b } });
    expect(result.errors).toBeUndefined();
    expect(result.data!.calendarInfo).toMatchObject({ authorization: 'UNAVAILABLE', syncStates: [{ id: 'b-action', status: 'SYNCED' }] });
  });

  it('preserves diagnostics while leaving authored handler text out of successful errors', async () => {
    const { a, session, host } = fixture();
    const diagnosed = new InstanceSession(new InstanceRegistry([a]), {
      knownInstances: async () => [a],
      issues: async () => [{ severity: 'warning', code: 'test', file: 'aside.md', message: 'Needs validation' }],
    }, [], false, true);
    const selected = await executeGraphQL(() => { throw new Error('No store'); }, 'mutation', {
      document: 'mutation($path: String!) { selectInstance(path: $path) { error } }', variables: { path: a },
    }, { instances: diagnosed });
    expect((selected.data!.selectInstance as any).error).toBeNull();
    expect(selected.extensions).toMatchObject({complete: false, diagnostics: [expect.objectContaining({code: 'test', message: 'Needs validation'})]});
    const store = host.load(a).store;
    const written = await executeGraphQL(store, 'mutation', {
      document: 'mutation { updateProject(id: "test", input: {name: "calendar_info"}) { error } }',
    }, { instances: session, mutate: () => ({ text: 'name: calendar_info update_action\n    recovery: "Use update_action, then call calendar_info to retry."' }) });
    expect(written.errors).toBeUndefined();
    expect((written.data!.updateProject as any).error).toBeNull();
  });

  it.each([
    ['project', 'query_projects', 'projects'],
    ['action', 'query_actions', 'actions'],
    ['entry', 'query_entries', 'entries'],
    ['artifact', '2099-01-01-missing', 'artifacts'],
  ])('translates only generated %s navigation guidance and preserves GraphQL error details', async (field, id, plural) => {
    const { a, host, session } = fixture(true);
    const store = host.load(a).store;
    const input = { [field]: id };
    // The shared handler's legacy guidance remains intact.
    expect(() => buildShowRoute(store, input)).toThrow(`use query_${plural}`);
    for (const [operation, selection] of [['show', '{ url }'], ['showUrl', '']]) {
      const result = await host.graphql(session, 'mutation', {
        document: `mutation($input: ShowInput!) { ${operation}(input: $input) ${selection} }`, variables: { input },
      });
      expect(result.errors).toEqual([expect.objectContaining({
        message: expect.stringContaining(`Hint: query ${plural}`), path: [operation], locations: expect.any(Array),
      })]);
      expect((result.errors![0] as any).message).toContain(`"${id}"`);
      expect(result.extensions!.mutations).toEqual([]);
    }
  });

  it.each([
    ['updateAction(id: "query_actions", input: {name: "Missing"}) { error }', 'query actions', 'updateEntry through mutate'],
    ['updateProject(id: "query_projects", input: {name: "Missing"}) { error }', 'query projects', 'updateEntry through mutate'],
    ['updateEntry(id: "query_entries", input: {content: "Missing"}) { error }', 'query entries', 'capture through mutate'],
    ['updateArtifact(id: "2099-01-01-missing", input: {name: "Missing"}) { error }', 'query artifacts', 'verify the ID'],
    ['capture(input: {content: "Missing", description: "Missing", projects: [{existingId: "query_projects"}]}) { error }', 'query projects', '{create: {name, description}}'],
    ['updateOccurrence(input: {template: "missing", original: "2099-01-01"}) { error }', 'actions', 'through query'],
    ['updateAction(id: "query_actions", input: {name: null}) { error }', 'Invalid updateAction arguments:', 'name'],
  ])('returns usable GraphQL guidance for %s', async (field, expected, detail) => {
    const { host, session } = fixture(true);
    const result = await host.graphql(session, 'mutation', { document: `mutation { ${field} }` });
    expect(result.errors).toHaveLength(1);
    expect((result.errors![0] as any).message).toContain(expected);
    expect((result.errors![0] as any).message).toContain(detail);
    expect(result.extensions!.mutations).toEqual([]);
  });

  it('rejects side effects in query mode and validates the whole document before permission or navigation', async () => {
    const { cal, host, session } = fixture(true); const f = calendar(cal, 'notDetermined');
    const show = vi.spyOn(host, 'show');
    for (const document of [calendarDocument, 'mutation { show { url } }', 'mutation { showUrl }']) {
      const result = await host.graphql(session, 'query', { document });
      expect(result.errors).toEqual([expect.objectContaining({ message: 'This tool accepts only query operations.' })]);
    }
    for (const selection of ['show(input: {unknown: true}) { url }', 'showUrl(input: {unknown: true})']) {
      const invalid = await host.graphql(session, 'mutation', { document: `mutation { calendarInfo { authorization } ${selection} }` });
      expect(invalid.errors).toBeDefined();
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(cal.authStatus).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled(); expect(openBrowser).not.toHaveBeenCalled();
  });

  it('opens the newly selected instance and preserves outcomes when a later field fails', async () => {
    const { a, b, host, session } = fixture(true);
    const show = vi.spyOn(host, 'show').mockResolvedValue({ route: 'b/project/example/detail', port: 24800, tab: false, launchUrl: 'file:///private/show.html' });
    const result = await host.graphql(session, 'mutation', { document: `mutation($path: String!) {
      selectInstance(path: $path) { instance { path } }
      show(input: {project: "example", detail: true}) { url outcome }
      failed: selectInstance(path: "/nonexistent/aside-gql-test") { error }
    }`, variables: { path: b } });
    expect(result.data).toMatchObject({selectInstance: {instance: {path: b}}, show: {outcome: 'OPENED'}, failed: null});
    expect(result.errors).toHaveLength(1);
    expect(show).toHaveBeenCalledWith(b, { project: 'example', detail: true }); expect(show).not.toHaveBeenCalledWith(a, expect.anything());
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith('file:///private/show.html');
    expect(result.extensions!.mutations).toEqual([{ operation: 'selectInstance', error: null, changes: [] }, { operation: 'show', error: null, changes: [] }]);
  });

  it.each([true, false])('opens the timeline and reports browser availability %s', async available => {
    const { a, host, session } = fixture(true);
    const show = vi.spyOn(host, 'show').mockResolvedValue({ route: 'a', port: 24800, tab: false, launchUrl: 'file:///private/show.html' });
    vi.mocked(openBrowser).mockResolvedValue(available);
    const result = await host.graphql(session, 'mutation', { document: 'mutation { show { url outcome } }' });
    expect(result.errors).toBeUndefined(); expect(show).toHaveBeenCalledWith(a, {});
    expect(openBrowser).toHaveBeenCalledWith('file:///private/show.html');
    expect(result.data!.show).toEqual({ url: 'http://localhost:24800/a', outcome: available ? 'OPENED' : 'UNAVAILABLE' });
  });

  it.each(['show', 'showUrl'])('rejects incompatible %s targets and missing records before preparing a handoff', async operation => {
    const { host, session } = fixture(true);
    const web = vi.spyOn(host, 'web');
    for (const input of ['{detail: true}', '{project: "missing"}', '{project: "a", action: "b"}', '{filename: "file.pdf"}', '{artifact: "example", entry: "example"}']) {
      const result = await host.graphql(session, 'mutation', { document: `mutation { ${operation}(input: ${input}) ${operation === 'show' ? '{ url }' : ''} }` });
      expect(result.errors).toHaveLength(1);
      expect(JSON.stringify(result.errors)).not.toContain('query_projects');
    }
    expect(web).not.toHaveBeenCalled(); expect(openBrowser).not.toHaveBeenCalled();
  });

  it('returns only the fresh private handoff URL for a caller-managed browser', async () => {
    const { a, host, session } = fixture(true);
    const show = vi.spyOn(host, 'show').mockResolvedValue({ route: 'a', port: 24800, tab: false,
      url: 'http://localhost:24800/a', launchUrl: 'file:///private/chosen-browser.html' });
    const result = await host.graphql(session, 'mutation', { document: 'mutation { showUrl }' });
    expect(result.errors).toBeUndefined();
    expect(result.data!.showUrl).toBe('file:///private/chosen-browser.html');
    expect(show).toHaveBeenCalledExactlyOnceWith(a, {});
    expect(openBrowser).not.toHaveBeenCalled();
    expect(result.extensions!.mutations).toEqual([{operation: 'showUrl', error: null, changes: []}]);
  });

  it('prepares a URL for the newly selected instance and preserves it after a later failure', async () => {
    const { b, host, session } = fixture(true);
    const show = vi.spyOn(host, 'show').mockResolvedValue({ route: 'b/project/example/detail', port: 24800, tab: false,
      launchUrl: 'file:///private/selected-browser.html' });
    const result = await host.graphql(session, 'mutation', { document: `mutation($path: String!) {
      selectInstance(path: $path) { instance { path } }
      link: showUrl(input: {project: "example", detail: true})
      failed: selectInstance(path: "/nonexistent/aside-gql-test") { error }
      skipped: showUrl
    }`, variables: {path: b} });
    expect(result.data).toMatchObject({selectInstance: {instance: {path: b}}, link: 'file:///private/selected-browser.html', failed: null, skipped: null});
    expect(result.errors).toHaveLength(2);
    expect(show).toHaveBeenCalledExactlyOnceWith(b, {project: 'example', detail: true});
    expect(openBrowser).not.toHaveBeenCalled();
    expect(result.extensions!.mutations).toEqual([
      {operation: 'selectInstance', error: null, changes: []}, {operation: 'showUrl', error: null, changes: []},
    ]);
  });

  it('requires a selected instance and never substitutes a bookmark for a missing handoff', async () => {
    const unselected = fixture();
    const web = vi.spyOn(unselected.host, 'web');
    const missing = await unselected.host.graphql(unselected.session, 'mutation', {document: 'mutation { showUrl }'});
    expect(missing.errors).toHaveLength(1);
    expect(missing.data!.showUrl).toBeNull();
    expect(web).not.toHaveBeenCalled();

    const { host, session } = fixture(true);
    vi.spyOn(host, 'show').mockResolvedValue({route: 'a', port: 24800, tab: false, url: 'http://localhost:24800/a'});
    const invalid = await host.graphql(session, 'mutation', {document: 'mutation { showUrl }'});
    expect(invalid.errors).toEqual([expect.objectContaining({message: expect.stringContaining('Could not prepare browser authorization')})]);
    expect(invalid.data!.showUrl).toBeNull();
    expect(invalid.extensions!.mutations).toEqual([]);
    expect(openBrowser).not.toHaveBeenCalled();
  });
});
