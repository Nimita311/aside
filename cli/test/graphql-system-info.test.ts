import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGraphQLSchema, executeGraphQL, type GraphQLExecutionOptions } from '../src/graphql/schema.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';
import { BUILT_AT, VERSION } from '../src/version.js';
import * as installationStatus from '../src/graphql/system-installation.js';

const noRecords = () => vi.fn(() => { throw new Error('System inspection must not load instance records.'); });
const ready = {available: true, reason: 'AVAILABLE' as const, message: 'Ready', recovery: null, model: 'local-embedding'};
const globalCalendar = {authorization: 'fullAccess' as const, helperPath: '/helpers/aside-cal',
  calendars: [{id: 'native-only', name: 'Work', account: 'Local', writable: true, type: 'local'}], diagnostics: []};
const daemon = {pid: 123, connections: 2, tabs: 1, logPath: '/state/daemon.log',
  startup: {path: '/jobs/aside.plist', present: true, program: ['/node', '/aside/main.js'], builtAt: 1234567890000},
  graphqlLogging: {queuedBytes: 0, dropped: 2, errors: 1}, checks: []};
const installation = {checkout: '/aside',
  information: [{group: 'CLI', name: 'aside on PATH', value: '/bin/aside'}], checks: [], agents: []};
function providers() {
  return {
    semanticAvailability: vi.fn(async () => ready),
    systemDaemon: vi.fn(() => daemon),
    systemInstallation: vi.fn(async () => installation),
    calendarStatus: vi.fn(async () => globalCalendar),
    requestCalendarAccess: vi.fn(async () => globalCalendar),
  } satisfies GraphQLExecutionOptions;
}

afterEach(() => vi.restoreAllMocks());

describe('GraphQL system information', () => {
  it('consolidates system information while keeping discovery and content APIs outside it', () => {
    const schema = buildGraphQLSchema();
    const query = schema.getQueryType()!.getFields();
    expect(query.systemInfo.type.toString()).toBe('SystemInfo!');
    expect(query.searchAvailability).toBeUndefined();
    expect(query.instances).toBeDefined();
    expect(query.activeInstance).toBeDefined();
    expect(Object.keys((schema.getType('SystemInfo') as any).getFields()).sort()).toEqual([
      'build', 'calendar', 'daemon', 'installation', 'search',
    ]);
    const mutation = schema.getMutationType()!.getFields();
    expect(mutation.calendarInfo).toBeUndefined();
    expect(mutation.requestCalendarAccess).toBeDefined();
    expect((schema.getType('Instance') as any).getFields().calendarSync).toBeDefined();
    const daemonFields = (schema.getType('SystemDaemonInfo') as any).getFields();
    for (const field of ['instances', 'known', 'loaded', 'sessions']) expect(daemonFields[field]).toBeUndefined();
    const calendarFields = (schema.getType('SystemCalendarInfo') as any).getFields();
    for (const field of ['syncStates', 'failures', 'issues', 'changes']) expect(calendarFields[field]).toBeUndefined();
  });

  it('reads build identity and schema without probing services or loading records', async () => {
    const source = noRecords(), options = providers();
    const result = await executeGraphQL(source, 'query', {document: `{
      systemInfo { build { version builtAt } calendar @skip(if: true) { authorization } }
      __type(name: "SystemInfo") { name }
    }`}, options);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({systemInfo: {build: {version: VERSION, builtAt: BUILT_AT}}, __type: {name: 'SystemInfo'}});
    expect(source).not.toHaveBeenCalled();
    for (const provider of Object.values(options)) expect(provider).not.toHaveBeenCalled();
  });

  it('collects only selected sections and reuses each snapshot across aliases in one request', async () => {
    const source = noRecords(), options = providers();
    const result = await executeGraphQL(source, 'query', {document: `{
      first: systemInfo { daemon { pid } calendar { authorization } search { semantic { available } } }
      second: systemInfo { daemon { connections } calendar { helperPath } search { semantic { model } } }
    }`}, options);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      first: {daemon: {pid: 123}, calendar: {authorization: 'FULL_ACCESS'}, search: {semantic: {available: true}}},
      second: {daemon: {connections: 2}, calendar: {helperPath: '/helpers/aside-cal'}, search: {semantic: {model: 'local-embedding'}}},
    });
    expect(options.systemDaemon).toHaveBeenCalledOnce();
    expect(options.calendarStatus).toHaveBeenCalledOnce();
    expect(options.semanticAvailability).toHaveBeenCalledExactlyOnceWith({signal: expect.any(AbortSignal)});
    expect(options.systemInstallation).not.toHaveBeenCalled();
    expect(options.requestCalendarAccess).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(result.extensions!.mutations).toEqual([]);
  });

  it('exposes existing daemon and installation diagnostics as structured data', async () => {
    const source = noRecords(), options = providers();
    const result = await executeGraphQL(source, 'query', {document: `{
      systemInfo {
        daemon { pid connections tabs logPath startup { path present program builtAt } graphqlLogging { queuedBytes dropped errors } checks { code passed } }
        installation { checkout information { group name value } checks { code passed } agents { name path } }
      }
    }`}, options);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({systemInfo: {daemon, installation}});
    expect(options.systemInstallation).toHaveBeenCalledExactlyOnceWith({signal: expect.any(AbortSignal)});
    expect(options.semanticAvailability).not.toHaveBeenCalled();
    expect(options.calendarStatus).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });

  it('contains a failed diagnostic section without discarding other system information', async () => {
    const source = noRecords(), options = providers();
    options.systemInstallation.mockRejectedValue(new Error('Vendor CLI inspection failed.'));
    const result = await executeGraphQL(source, 'query', {document: '{systemInfo{build{version} installation{checkout} daemon{pid}}}'}, options);
    expect(result.data).toEqual({systemInfo: {build: {version: VERSION}, installation: null, daemon: {pid: 123}}});
    expect(result.errors).toEqual([expect.objectContaining({path: ['systemInfo', 'installation'], message: 'Vendor CLI inspection failed.'})]);
    expect(source).not.toHaveBeenCalled();
  });

  it('reports unconfigured host sections as null without performing fallback inspection', async () => {
    const source = noRecords();
    const result = await executeGraphQL(source, 'query', {document: '{systemInfo{daemon{pid} installation{checkout} calendar{authorization}}}'});
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({systemInfo: {daemon: null, installation: null, calendar: null}});
    expect(source).not.toHaveBeenCalled();
  });

  it('inspects installation in the session workspace without pruning instance selection', async () => {
    const probe = vi.spyOn(installationStatus, 'collectSystemInstallation').mockResolvedValue(installation);
    const host = new InstanceHost(new CalClient(null));
    const load = vi.spyOn(host, 'load').mockImplementation(() => { throw new Error('No content loading'); });
    const registry = new InstanceRegistry();
    // A status read must not inspect this stale content reference or clear it.
    registry.activate('/private/tmp/aside-system-info-absent-instance');
    const selected = registry.activeInstance;
    const selection = vi.spyOn(registry, 'selection');
    const backend = {knownInstances: vi.fn(async () => []), issues: vi.fn(async () => [])};
    const session = new InstanceSession(registry, backend, [], false, '/session/workspace');
    try {
      const result = await host.graphql(session, 'query', {document: '{systemInfo{installation{checkout}}}'});
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({systemInfo: {installation: {checkout: '/aside'}}});
      expect(probe).toHaveBeenCalledExactlyOnceWith({signal: expect.any(AbortSignal), cwd: '/session/workspace'});
      expect(selection).not.toHaveBeenCalled();
      expect(registry.activeInstance).toBe(selected);
      expect(load).not.toHaveBeenCalled();
      expect(backend.knownInstances).not.toHaveBeenCalled();
      expect(backend.issues).not.toHaveBeenCalled();
    } finally { await host.close(); }
  });

  it.each(['notDetermined', 'writeOnly'] as const)('reads %s Calendar authorization without requesting access or selecting an instance', async authorization => {
    const cal = new CalClient(null), host = new InstanceHost(cal);
    vi.spyOn(cal, 'available').mockReturnValue(true);
    vi.spyOn(cal, 'authStatus').mockResolvedValue({status: authorization});
    const request = vi.spyOn(cal, 'requestAccess');
    const calendars = vi.spyOn(cal, 'listCalendars');
    const load = vi.spyOn(host, 'load').mockImplementation(() => { throw new Error('No content loading'); });
    const knownInstances = vi.fn(async () => []), issues = vi.fn(async () => []);
    const registry = new InstanceRegistry();
    const session = new InstanceSession(registry, {knownInstances, issues}, [], false);
    try {
      const result = await host.graphql(session, 'query', {document: '{systemInfo{calendar{authorization calendars{name} diagnostics{category recovery}}}}'});
      expect(result.errors).toBeUndefined();
      expect((result.data!.systemInfo as any).calendar).toMatchObject({
        authorization: authorization === 'notDetermined' ? 'NOT_DETERMINED' : 'WRITE_ONLY', calendars: null,
      });
      expect(request).not.toHaveBeenCalled(); expect(calendars).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled(); expect(knownInstances).not.toHaveBeenCalled(); expect(issues).not.toHaveBeenCalled();
      expect(registry.activeInstance).toBeNull();
      expect(result.extensions!.mutations).toEqual([]);
    } finally { await host.close(); }
  });

  it('allows Calendar permission only through its explicit mutation', async () => {
    const source = noRecords(), options = providers();
    const document = 'mutation{requestCalendarAccess{authorization}}';
    const rejected = await executeGraphQL(source, 'query', {document}, options);
    expect(rejected.errors).toEqual([expect.objectContaining({message: 'This tool accepts only query operations.'})]);
    expect(options.requestCalendarAccess).not.toHaveBeenCalled();
    const permitted = await executeGraphQL(source, 'mutation', {document}, options);
    expect(permitted.errors).toBeUndefined();
    expect(permitted.data).toEqual({requestCalendarAccess: {authorization: 'FULL_ACCESS'}});
    expect(options.requestCalendarAccess).toHaveBeenCalledOnce();
    expect(options.calendarStatus).not.toHaveBeenCalled();
    expect(permitted.extensions!.mutations).toEqual([{operation: 'requestCalendarAccess', error: null, changes: []}]);
    expect(source).not.toHaveBeenCalled();
  });
});
