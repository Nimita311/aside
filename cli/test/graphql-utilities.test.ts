import { afterEach, describe, expect, it, vi } from 'vitest';
import {lifecycleOperationsFixture} from './lifecycle-operations-fixture.js';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/source/bootstrap.js';
import { validate } from '../src/core/validator.js';
import { InstanceHost } from '../src/daemon/host.js';
import {executeGraphQLWithOwner as executeGraphQL} from './graphql-owner-fixture.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';
import { CalClient, CalError } from '../src/mcp/calendar/client.js';
import { calendarReport } from './support/calendar-report.js';
import { CalSync } from '../src/mcp/calendar/sync.js';
import type { CalAuthStatus } from '../src/mcp/calendar/protocol.js';
import { openBrowser } from '../src/web/locate.js';
import {lifecycleMetadataFixture} from './lifecycle-metadata-fixture.js';

vi.mock('../src/web/locate.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/web/locate.js')>(), openBrowser: vi.fn(async () => true),
}));
const dirs: string[] = [], hosts: InstanceHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.mocked(openBrowser).mockClear(); vi.mocked(openBrowser).mockResolvedValue(true);
});
function fixture(selected = false) {
  const dir = realpathSync(mkdtempSync('/tmp/aside-gql-utilities-')); dirs.push(dir);
  const a = join(dir, 'a'), b = join(dir, 'b');
  init(a, { name: 'A', description: 'First' }); init(b, { name: 'B', description: 'Second' });
  const registry = new InstanceRegistry([a, b]); if (selected) registry.activate(a);
  const cal = new CalClient(null), host = new InstanceHost(cal); hosts.push(host);
  host.setKnownPaths(() => [a, b]);
  const metadata = lifecycleMetadataFixture(a, b);
  const session = new InstanceSession(registry, lifecycleOperationsFixture({ knownInstances: async () => [a, b], issues: async () => [], instanceRecord: metadata.instanceRecord }), [], false);
  return { a, b, cal, host, session, registry, metadata };
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
const calendarDocument = `mutation { requestCalendarAccess {
  authorization calendars { name account writable type } diagnostics { category recovery }
} }`;
const syncFields = `error syncStates { id status reason retry } failures { id diagnostic { category recovery } }
  issues { id reason } changes { id summary }`;
async function readSync(report: Awaited<ReturnType<typeof collectCalendarInfo>>, fields = syncFields) {
  const { session, metadata } = fixture(true);
  return executeGraphQL(() => { throw new Error('Sync observations should not load record stores'); }, 'query', {
    document: `{ activeInstance { calendarSync { ${fields} } } }`,
  }, { instances: session, loadedInstance: metadata.loadedInstance, calendarSync: () => report });
}

describe('GraphQL validation and utility mutations', () => {
  it('validates several instances without selecting or loading record stores, and reads changes on the next request', async () => {
    const { a, b, session, registry, metadata } = fixture();
    const noStore = vi.fn(() => { throw new Error('Records should not load'); });
    const args = { document: '{ instances { path validation { passed dataChecksRun checks { name passed details } } } activeInstance { path } }' };
    const first = await executeGraphQL(noStore, 'query', args, { instances: session, loadedInstance: metadata.loadedInstance });
    expect(first.errors).toBeUndefined(); expect(first.data!.activeInstance).toBeNull();
    const normalized = (path: string) => { const result = validate(path); return { ...result, checks: result.checks.map(check => ({ ...check, details: check.details ?? [] })) }; };
    expect(first.data!.instances).toEqual([{ path: a, validation: normalized(a) }, { path: b, validation: normalized(b) }]);
    writeFileSync(join(b, 'aside.md'), '---\nid: invalid ID\nname: B\n---\n');
    const second = await executeGraphQL(noStore, 'query', args, { instances: session, loadedInstance: metadata.loadedInstance });
    expect(second.errors).toBeUndefined();
    expect((second.data!.instances as any[])[1].validation.passed).toBe(false);
    expect(registry.activeInstance).toBeNull(); expect(noStore).not.toHaveBeenCalled();
  });

  it.each(['notDetermined', 'writeOnly'] as const)('requests access once from %s and returns calendars without selecting an instance', async status => {
    const { cal, host, session, registry } = fixture(); const f = calendar(cal, status);
    const result = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(result.errors).toBeUndefined();
    expect(result.data!.requestCalendarAccess).toMatchObject({ authorization: 'FULL_ACCESS', calendars: [{ name: 'Work', account: 'iCloud', writable: true, type: 'calDAV' }], diagnostics: [] });
    expect(f.request).toHaveBeenCalledOnce(); expect(f.list).toHaveBeenCalledOnce();
    expect(f.events).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
    expect(registry.activeInstance).toBeNull();
    expect(result.extensions!.mutations).toEqual([{ operation: 'requestCalendarAccess', error: null, changes: [] }]);
  });

  it('returns denied access and unavailable helpers as data with GraphQL recovery guidance', async () => {
    const { cal, host, session } = fixture();
    const unavailable = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(unavailable.errors).toBeUndefined(); expect(unavailable.data!.requestCalendarAccess).toMatchObject({ authorization: 'UNAVAILABLE', calendars: null });
    const f = calendar(cal, 'denied');
    const denied = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(denied.errors).toBeUndefined();
    expect(denied.data!.requestCalendarAccess).toMatchObject({ authorization: 'DENIED', calendars: null, diagnostics: [{ category: 'authorization-denied', recovery: expect.stringContaining('systemInfo.calendar') }] });
    expect(f.request).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
  });

  it('returns authorization and listing failures without losing sync observations', async () => {
    const { cal, host, session } = fixture(); const f = calendar(cal, 'writeOnly');
    f.request.mockRejectedValue(new CalError('Request refused', 'authorization-request-failed'));
    const failed = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(failed.errors).toBeUndefined();
    expect(failed.data!.requestCalendarAccess).toMatchObject({ authorization: 'WRITE_ONLY', calendars: null, diagnostics: [{ category: 'authorization-request-failed' }] });
    vi.mocked(cal.authStatus).mockResolvedValue({ status: 'fullAccess' });
    f.list.mockRejectedValue(new Error('Cannot list'));
    const report = await calendarReport(cal, {
      statuses: () => [{ id: 'action', status: 'pending', retry: true }],
      failureDiagnostics: () => [{ id: 'action', diagnostic: { category: 'test', reason: 'Observed', recovery: 'Retry' } }],
      report: () => [{ id: 'action', reason: 'Pending' }], changesSinceStart: () => [{ id: 'action', summary: 'Rescheduled' }],
    });
    const status = await executeGraphQL(() => { throw new Error('No store'); }, 'query', {
      document: '{systemInfo{calendar{authorization calendars{name} diagnostics{reason}}}}',
    }, {calendarStatus: async () => report});
    expect(status.errors).toBeUndefined();
    expect((status.data!.systemInfo as any).calendar).toMatchObject({authorization: 'FULL_ACCESS', calendars: null, diagnostics: [expect.objectContaining({reason: expect.stringContaining('Cannot list')})]});
    const result = await readSync(report);
    expect(result.errors).toBeUndefined();
    expect((result.data!.activeInstance as any).calendarSync).toMatchObject({ syncStates: [{ id: 'action', status: 'PENDING', retry: true }], failures: [{ id: 'action', diagnostic: { category: 'test', recovery: 'Retry' } }], issues: [{ id: 'action', reason: 'Pending' }], changes: [{ id: 'action', summary: 'Rescheduled' }] });
  });

  it('consolidates failed sync-state diagnostics even when the redundant failure is omitted', async () => {
    const { cal } = fixture(); calendar(cal, 'fullAccess');
    const diagnostic = { category: 'test', reason: 'Calendar save failed', recovery: 'Use updateAction via mutate, then systemInfo.calendar through query.' };
    const report = await calendarReport(cal, {
      statuses: () => ['action', 'other'].map(id => ({ id, status: 'failed', reason: diagnostic.reason, diagnostic })),
      failureDiagnostics: () => ['action', 'other'].map(id => ({ id, diagnostic })),
      report: () => ['action', 'other'].map(id => ({ id, reason: diagnostic.reason })), changesSinceStart: () => [],
    });
    expect(report.failures).toEqual([]);
    const result = await readSync(report);
    expect(result.errors).toBeUndefined();
    const error = (result.data!.activeInstance as any).calendarSync.error as string;
    for (const id of ['action', 'other']) expect(error).toContain(`${id}: Calendar save failed Recovery: Use updateAction`);
    expect(error.match(/Calendar save failed/g)).toHaveLength(2);
    expect(error).toContain('then Instance.calendarSync through query.');
    expect(result.extensions!.mutations).toEqual([]);
    expect(diagnostic.recovery).toBe('Use updateAction via mutate, then systemInfo.calendar through query.');
  });

  it('reports failed states without diagnostics and standalone consistency issues once', async () => {
    const { cal } = fixture(); calendar(cal, 'fullAccess');
    const report = await calendarReport(cal, {
      statuses: () => [{ id: 'action', status: 'failed', reason: 'Action file unavailable' }],
      report: () => [{ id: 'action', reason: 'Action file unavailable' }, { id: 'reverse sync', reason: 'Could not confirm an event' }],
      changesSinceStart: () => [],
    });
    const result = await readSync(report, 'error');
    const expected = 'action: Action file unavailable\nreverse sync: Could not confirm an event';
    expect(result.errors).toBeUndefined();
    expect((result.data!.activeInstance as any).calendarSync.error).toBe(expected);
    expect(result.extensions!.mutations).toEqual([]);
  });

  it('does not report ordinary pending sync, Calendar opt-out, or observed changes as errors', async () => {
    const { cal } = fixture(); calendar(cal, 'fullAccess');
    const waiting = 'calendar busy (another sync in progress), will retry';
    const report = await calendarReport(cal, {
      statuses: () => [{ id: 'action', status: 'pending', reason: 'Calendar sync in progress',
        diagnostic: { category: 'sync-pending', reason: 'Calendar sync in progress', recovery: 'Check Instance.calendarSync through query for completion.' } },
        { id: 'queued', status: 'pending', reason: waiting, retry: true,
          diagnostic: { category: 'sync-pending', reason: waiting, recovery: 'Check Instance.calendarSync through query for completion.' } },
        { id: 'unbound', status: 'disabled', reason: 'no calendar' },
        { id: 'deleted', status: 'disabled', reason: 'action no longer exists',
          diagnostic: { category: 'old-failure', reason: 'Earlier retry failed', recovery: 'Retry the action.' } }],
      report: () => [{ id: 'queued', reason: waiting }, { id: 'unbound', reason: 'no calendar' }], changesSinceStart: () => [{ id: 'other', summary: 'Rescheduled' }],
    });
    const result = await readSync(report, 'error syncStates { status } changes { summary }');
    expect(result.errors).toBeUndefined();
    expect((result.data!.activeInstance as any).calendarSync).toMatchObject({ error: null, syncStates: [{ status: 'PENDING' }, { status: 'PENDING' }, { status: 'DISABLED' }, { status: 'DISABLED' }], changes: [{ summary: 'Rescheduled' }] });
    expect(result.extensions!.mutations).toEqual([]);
  });

  it('distinguishes an authorization error, an undecided permission response, and an empty calendar list', async () => {
    const { cal, host, session } = fixture(); const f = calendar(cal, 'notDetermined');
    f.request.mockResolvedValue({ granted: false, status: 'notDetermined' });
    const undecided = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(undecided.errors).toBeUndefined();
    expect(undecided.data!.requestCalendarAccess).toMatchObject({ authorization: 'NOT_DETERMINED', calendars: null, diagnostics: [{ category: 'authorization-notDetermined' }] });
    vi.mocked(cal.authStatus).mockRejectedValueOnce(new Error('Helper failed'));
    const failed = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(failed.errors).toBeUndefined(); expect(failed.data!.requestCalendarAccess).toMatchObject({ authorization: 'ERROR', calendars: null });
    vi.mocked(cal.authStatus).mockResolvedValue({ status: 'fullAccess' }); f.list.mockResolvedValue({ calendars: [] });
    const empty = await host.graphql(session, 'mutation', { document: calendarDocument });
    expect(empty.errors).toBeUndefined(); expect(empty.data!.requestCalendarAccess).toMatchObject({ authorization: 'FULL_ACCESS', calendars: [] });
  });

  it('reports the sync state of the instance selected earlier in the same mutation', async () => {
    const { a, b, host, session } = fixture(true);
    vi.spyOn(host.load(a).sync, 'statuses').mockReturnValue([{ id: 'a-action', status: 'failed' }]);
    vi.spyOn(host.load(b).sync, 'statuses').mockReturnValue([{ id: 'b-action', status: 'synced' }]);
    const result = await host.graphql(session, 'mutation', { document: 'mutation($path: String!) { selectInstance(path: $path) { instance { path calendarSync { syncStates { id status } } } } }', variables: { path: b } });
    expect(result.errors).toBeUndefined();
    expect((result.data!.selectInstance as any).instance).toMatchObject({ path: b, calendarSync: { syncStates: [{ id: 'b-action', status: 'SYNCED' }] } });
  });

  it('refreshes Calendar observations between serial mutation roots while sharing each payload snapshot', async () => {
    const { a, session, metadata } = fixture(true);
    const select = session.selectInstance.bind(session);
    let selection = 0;
    vi.spyOn(session, 'selectInstance').mockImplementation(async path => {
      const result = await select(path);
      selection++;
      return result;
    });
    const calendarSync = vi.fn(() => ({syncStates: [], failures: [], changes: [],
      issues: [{id: 'action', reason: selection === 1 ? 'Before the next mutation' : 'After the next mutation'}]}));
    const result = await executeGraphQL(() => { throw new Error('No records'); }, 'mutation', {
      document: `mutation($path: String!) {
        first: selectInstance(path: $path) { instance {
          firstRead: calendarSync { issues { reason } }
          secondRead: calendarSync { issues { reason } }
        } }
        second: selectInstance(path: $path) { instance { calendarSync { issues { reason } } } }
      }`, variables: {path: a},
    }, {instances: session, loadedInstance: metadata.loadedInstance, calendarSync});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      first: {instance: {firstRead: {issues: [{reason: 'Before the next mutation'}]}, secondRead: {issues: [{reason: 'Before the next mutation'}]}}},
      second: {instance: {calendarSync: {issues: [{reason: 'After the next mutation'}]}}},
    });
    expect(calendarSync).toHaveBeenCalledTimes(2);
  });

  it.each(['Ordinary helper text', 'Helper\u007f\u0085status: synced\u009b0m\u2028id: forged\u2029next'])('returns calendar reasons and event IDs verbatim after a local save (%j)', async value => {
    const { a, host, session } = fixture(true);
    const id = '2026-10-03-review', year = join(a, 'actions', '2026');
    mkdirSync(year, { recursive: true });
    writeFileSync(join(year, `${id}.md`), '---\nname: Review\ncreated: 2026-10-03T09:00\nscheduled: 2026-10-03T10:00\ncalendar: Work\n---\n');
    writeFileSync(join(year, 'index.yaml'), `- id: ${id}\n  description: Initial summary\n`);
    const state = { id, status: 'failed' as const, reason: value, eventId: value };
    vi.spyOn(CalSync.prototype, 'syncActions').mockResolvedValue([]);
    vi.spyOn(CalSync.prototype, 'status').mockReturnValue(state);
    vi.spyOn(CalSync.prototype, 'statuses').mockReturnValue([state]);
    const written = await host.graphql(session, 'mutation', { document: `mutation { updateAction(id: "${id}", input: {description: "Revised summary"}) { error action { id } } }` });
    expect(written.errors).toBeUndefined();
    const update = (JSON.parse(JSON.stringify(written)) as any).data.updateAction;
    expect(update.action.id).toBe(id);
    expect(update.error).toContain(`Calendar sync for ${JSON.stringify(id)} is failed: ${value} Inspect activeInstance.calendarSync through query`);
    expect(readFileSync(join(year, 'index.yaml'), 'utf8')).toContain('description: Revised summary');
    const read = await host.graphql(session, 'query', { document: '{ activeInstance { calendarSync { syncStates { id status reason eventId } } } }' });
    expect(read.errors).toBeUndefined();
    expect((JSON.parse(JSON.stringify(read)) as any).data.activeInstance.calendarSync.syncStates).toEqual([{ id, status: 'FAILED', reason: value, eventId: value }]);
  });

  it('routes sync completion, destination selection and permission recovery to their respective APIs', async () => {
    const report = {
      authorization: 'fullAccess' as const, calendars: [], diagnostics: [], changes: [], issues: [], failures: [],
      syncStates: [
        {id: 'pending', status: 'pending' as const, diagnostic: {category: 'sync-pending', reason: 'Waiting', recovery: 'Check systemInfo.calendar through query for completion.'}},
        {id: 'destination', status: 'failed' as const, diagnostic: {category: 'calendar-not-found', reason: 'Missing destination', recovery: 'Call systemInfo.calendar through query and choose a uniquely named writable calendar.'}},
        {id: 'permission', status: 'failed' as const, diagnostic: {category: 'authorization-writeOnly', reason: 'Write only', recovery: 'Call requestCalendarAccess through mutate to request an upgrade to full access.'}},
      ],
    };
    const result = await readSync(report, 'syncStates { id diagnostic { recovery } }');
    expect(result.errors).toBeUndefined();
    expect((result.data!.activeInstance as any).calendarSync.syncStates).toEqual([
      {id: 'pending', diagnostic: {recovery: 'Check Instance.calendarSync through query for completion.'}},
      {id: 'destination', diagnostic: {recovery: 'Call systemInfo.calendar through query and choose a uniquely named writable calendar.'}},
      {id: 'permission', diagnostic: {recovery: 'Call requestCalendarAccess through mutate to request an upgrade to full access.'}},
    ]);
    expect(report.syncStates[0].diagnostic.recovery).toBe('Check systemInfo.calendar through query for completion.');
  });

  it('preserves session diagnostics on a successful selection', async () => {
    const { a, metadata } = fixture();
    const diagnosed = new InstanceSession(new InstanceRegistry([a]), lifecycleOperationsFixture({
      knownInstances: async () => [a],
      issues: async () => [{ severity: 'warning', code: 'test', file: 'aside.md', message: 'Needs validation' }],
      instanceRecord: metadata.instanceRecord,
    }), [], false);
    const selected = await executeGraphQL(() => { throw new Error('No store'); }, 'mutation', {
      document: 'mutation($path: String!) { selectInstance(path: $path) { error } }', variables: { path: a },
    }, { instances: diagnosed, loadedInstance: metadata.loadedInstance });
    expect((selected.data!.selectInstance as any).error).toBeNull();
    expect(selected.extensions).toMatchObject({complete: false, diagnostics: [expect.objectContaining({code: 'test', message: 'Needs validation'})]});
  });

  it.each([
    ['project', 'query_projects', 'projects'],
    ['action', 'query_actions', 'actions'],
    ['entry', 'query_entries', 'entries'],
    ['artifact', '2099-01-01-missing', 'artifacts'],
  ])('returns generated %s navigation guidance and preserves GraphQL error details', async (field, id, plural) => {
    const { host, session } = fixture(true);
    const input = { [field]: id };
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
      const invalid = await host.graphql(session, 'mutation', { document: `mutation { requestCalendarAccess { authorization } ${selection} }` });
      expect(invalid.errors).toBeDefined();
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(cal.authStatus).not.toHaveBeenCalled(); expect(show).not.toHaveBeenCalled(); expect(openBrowser).not.toHaveBeenCalled();
  });

  it('opens the newly selected instance and preserves outcomes when a later field fails', async () => {
    const { a, b, host, session } = fixture(true);
    const show = vi.spyOn(host, 'show').mockResolvedValue({ route: 'b/project/example/detail', port: 24800, tab: false });
    const result = await host.graphql(session, 'mutation', { document: `mutation($path: String!) {
      selectInstance(path: $path) { instance { path } }
      show(input: {project: "example", detail: true}) { url outcome }
      failed: selectInstance(path: "/nonexistent/aside-gql-test") { error }
    }`, variables: { path: b } });
    expect(result.data).toMatchObject({selectInstance: {instance: {path: b}}, show: {outcome: 'OPENED'}, failed: null});
    expect(result.errors).toHaveLength(1);
    expect(show).toHaveBeenCalledWith(b, { project: 'example', detail: true }); expect(show).not.toHaveBeenCalledWith(a, expect.anything());
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith('http://localhost:24800/b/project/example/detail');
    expect(result.extensions!.mutations).toEqual([{ operation: 'selectInstance', error: null, changes: [] }, { operation: 'show', error: null, changes: [] }]);
  });

  it.each([true, false])('opens the timeline and reports browser availability %s', async available => {
    const { a, host, session } = fixture(true);
    const show = vi.spyOn(host, 'show').mockResolvedValue({ route: 'a', port: 24800, tab: false });
    vi.mocked(openBrowser).mockResolvedValue(available);
    const result = await host.graphql(session, 'mutation', { document: 'mutation { show { url outcome } }' });
    expect(result.errors).toBeUndefined(); expect(show).toHaveBeenCalledWith(a, {});
    expect(openBrowser).toHaveBeenCalledWith('http://localhost:24800/a');
    expect(result.data!.show).toEqual({ url: 'http://localhost:24800/a', outcome: available ? 'OPENED' : 'UNAVAILABLE' });
  });

  it.each(['show', 'showUrl'])('rejects incompatible %s targets and missing records before starting the web server', async operation => {
    const { host, session } = fixture(true);
    const web = vi.spyOn(host, 'web');
    for (const input of ['{detail: true}', '{project: "missing"}', '{project: "a", action: "b"}', '{filename: "file.pdf"}', '{artifact: "example", entry: "example"}']) {
      const result = await host.graphql(session, 'mutation', { document: `mutation { ${operation}(input: ${input}) ${operation === 'show' ? '{ url }' : ''} }` });
      expect(result.errors).toHaveLength(1);
      expect(JSON.stringify(result.errors)).not.toContain('query_projects');
    }
    expect(web).not.toHaveBeenCalled(); expect(openBrowser).not.toHaveBeenCalled();
  });

  it('returns only the view URL for a caller-managed browser', async () => {
    const { a, host, session } = fixture(true);
    const show = vi.spyOn(host, 'show').mockResolvedValue({ route: 'a', port: 24800, tab: false,
      url: 'http://localhost:24800/a' });
    const result = await host.graphql(session, 'mutation', { document: 'mutation { showUrl }' });
    expect(result.errors).toBeUndefined();
    expect(result.data!.showUrl).toBe('http://localhost:24800/a');
    expect(show).toHaveBeenCalledExactlyOnceWith(a, {});
    expect(openBrowser).not.toHaveBeenCalled();
    expect(result.extensions!.mutations).toEqual([{operation: 'showUrl', error: null, changes: []}]);
  });

  it.each(['show', 'showUrl'])('passes a saved entry source and content return context through %s', async operation => {
    const { a, host, session } = fixture(true);
    const source = '#artifact/2026-10-18-review/decisions.json';
    const show = vi.spyOn(host, 'show').mockResolvedValue({ route: `a/project/example/detail?${new URLSearchParams({ source })}`, port: 24800, tab: false,
      });
    const result = await host.graphql(session, 'mutation', { document: `mutation {
      ${operation}(input: {source: "${source}", search: "release review", project: "example", detail: true}) ${operation === 'show' ? '{ url }' : ''}
    }` });
    expect(result.errors).toBeUndefined();
    expect(show).toHaveBeenCalledExactlyOnceWith(a, { source, search: 'release review', project: 'example', detail: true });
  });

  it('prepares a URL for the newly selected instance and preserves it after a later failure', async () => {
    const { b, host, session } = fixture(true);
    const show = vi.spyOn(host, 'show').mockResolvedValue({ route: 'b/project/example/detail', port: 24800, tab: false,
      });
    const result = await host.graphql(session, 'mutation', { document: `mutation($path: String!) {
      selectInstance(path: $path) { instance { path } }
      link: showUrl(input: {project: "example", detail: true})
      failed: selectInstance(path: "/nonexistent/aside-gql-test") { error }
      skipped: showUrl
    }`, variables: {path: b} });
    expect(result.data).toMatchObject({selectInstance: {instance: {path: b}}, link: 'http://localhost:24800/b/project/example/detail', failed: null, skipped: null});
    expect(result.errors).toHaveLength(2);
    expect(show).toHaveBeenCalledExactlyOnceWith(b, {project: 'example', detail: true});
    expect(openBrowser).not.toHaveBeenCalled();
    expect(result.extensions!.mutations).toEqual([
      {operation: 'selectInstance', error: null, changes: []}, {operation: 'showUrl', error: null, changes: []},
    ]);
  });

  it('requires a selected instance and returns ordinary HTTP URLs', async () => {
    const unselected = fixture();
    const web = vi.spyOn(unselected.host, 'web');
    const missing = await unselected.host.graphql(unselected.session, 'mutation', {document: 'mutation { showUrl }'});
    expect(missing.errors).toHaveLength(1);
    expect(missing.data!.showUrl).toBeNull();
    expect(web).not.toHaveBeenCalled();

    const { host, session } = fixture(true);
    vi.spyOn(host, 'show').mockResolvedValue({route: 'a', port: 24800, tab: false, url: 'http://localhost:24800/a'});
    const result = await host.graphql(session, 'mutation', {document: 'mutation { showUrl }'});
    expect(result.errors).toBeUndefined();
    expect(result.data!.showUrl).toBe('http://localhost:24800/a');
    expect(openBrowser).not.toHaveBeenCalled();
  });
});
