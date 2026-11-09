import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {init} from '../src/source/bootstrap.js';
import {Store} from '../src/source/store.js';
import type {ParseIssue} from '../src/core/types.js';
import type {SourceHealth} from '../src/source/source-health.js';
import {assertSearchSourceReadable} from '../src/semantic/source-version.js';
import {prepareAutomationPrompts} from '../src/graphql/automation-prompts.js';
import {normalizeMutationArguments} from '../src/graphql/inputs.js';
import {createArtifact} from '../src/mcp/tools/artifact.js';
import {handleCapture} from '../src/mcp/tools/capture.js';
import {handleUpdateAction} from '../src/mcp/tools/update.js';
import {CalClient} from '../src/mcp/calendar/client.js';
import {CalSync, storeAction} from '../src/mcp/calendar/sync.js';
import {CalendarSyncFixture} from './calendar-fixture.js';

let directory: string, store: Store;
const clients: CalClient[] = [], syncers: CalSync[] = [];
const ownerIssue: ParseIssue = {severity: 'error', code: 'source-observation-unavailable', message: 'Owner cannot certify this source generation'};
const unavailable: SourceHealth = {complete: false, issue: ownerIssue, issues: [ownerIssue]};
const complete: SourceHealth = {complete: true, issues: []};
const now = new Date(2026, 9, 8, 12);
beforeEach(() => {
  directory = mkdtempSync('/private/tmp/aside-source-health-consumers-');
  vi.stubEnv('ASIDE_DAEMON_HOME', join(directory, 'daemon'));
  const root = join(directory, 'instance');
  init(root, {name: 'Health consumers', description: 'Owner readiness'});
  store = new Store(root);
});
afterEach(() => {
  for (const sync of syncers.splice(0)) sync.dispose();
  for (const client of clients.splice(0)) client.close();
  store.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(directory, {recursive: true, force: true});
});
function forbidRawDiagnostics() {
  return vi.spyOn(store, 'getIssues').mockImplementation(() => {throw new Error('Feature reread raw source diagnostics');});
}
describe('features consume lifecycle source health', () => {
  it('uses owner completeness even for an unknown owner failure', () => {
    const health = vi.spyOn(store, 'getSourceHealth').mockReturnValue(unavailable);
    const diagnostics = forbidRawDiagnostics();
    expect(() => assertSearchSourceReadable(store)).toThrow('source-observation-unavailable');
    health.mockReturnValue(complete);
    expect(() => assertSearchSourceReadable(store)).not.toThrow();
    expect(diagnostics).not.toHaveBeenCalled();
  });
  it('validates a prompt using owner-classified artifact diagnostics', () => {
    const artifact = createArtifact(store, {name: 'Prompt', description: 'Prompt', body: 'Published instructions.'}, now);
    const health = vi.spyOn(store, 'getRecordSourceHealth').mockReturnValue(unavailable);
    const diagnostics = forbidRawDiagnostics();
    const input = normalizeMutationArguments('updateInstance', {input: {automations: {upsert: [{name: 'task', schedule: {at: '2099-01-01T00:00:00Z'}, run: {model: 'CUSTOM', prompt: {existingId: artifact.id}}}]}}}, {now});
    expect(() => prepareAutomationPrompts(store, input)).toThrow(ownerIssue.message);
    health.mockReturnValue(complete);
    expect(() => prepareAutomationPrompts(store, input)).not.toThrow();
    expect(health).toHaveBeenCalledWith('artifact', artifact.id);
    expect(diagnostics).not.toHaveBeenCalled();
  });
  it('gates recurrence edits on owner load health and retains recurrence domain diagnostics', () => {
    const id = handleCapture(store, {content: 'Template', description: 'Template', actions: [{name: 'Routine', description: 'Routine', recurrence: [{dtstart: '2099-01-01', rrule: 'FREQ=DAILY'}]}]}, now).createdActionIds[0];
    const health = vi.spyOn(store, 'getRecordSourceHealth').mockReturnValue(unavailable);
    const diagnostics = forbidRawDiagnostics();
    const update = () => handleUpdateAction(store, {id, recurrence: {append: {dtstart: '2099-02-01', rrule: 'FREQ=DAILY'}}}, now);
    expect(update).toThrow(ownerIssue.message);
    health.mockReturnValue(complete);
    vi.spyOn(store, 'getRecordIssues').mockReturnValue([{severity: 'error', code: 'invalid_recurrence_relationship', message: 'Occurrence provenance is invalid'}]);
    expect(update).toThrow('Occurrence provenance is invalid');
    expect(diagnostics).not.toHaveBeenCalled();
  });
  it('reports owner manifest uncertainty without reinterpreting raw diagnostics', () => {
    const cal = new CalClient(null); clients.push(cal);
    const sync = new CalendarSyncFixture(cal, '', store); syncers.push(sync);
    vi.spyOn(store, 'getManifestSourceHealth').mockReturnValue(unavailable);
    const diagnostics = forbidRawDiagnostics();
    expect(sync.status('missing')).toMatchObject({status: 'disabled', reason: ownerIssue.message});
    expect(diagnostics).not.toHaveBeenCalled();
  });
  it('withdraws a positive Calendar receipt when the owner cannot certify that record', async () => {
    const id = handleCapture(store, {content: 'Task', description: 'Task', actions: [{name: 'Task', description: 'Task', scheduled: '2099-01-01', calendar: 'Work'}]}, now).createdActionIds[0];
    const cal = new CalClient(null); clients.push(cal);
    vi.spyOn(cal, 'available').mockReturnValue(true);
    vi.spyOn(cal, 'authStatus').mockResolvedValue({status: 'fullAccess'});
    vi.spyOn(cal, 'listCalendars').mockResolvedValue({calendars: [{id: 'work', name: 'Work', account: 'Local', writable: true, type: 'local'}]});
    vi.spyOn(cal, 'listEvents').mockResolvedValue({events: []});
    vi.spyOn(cal, 'upsertEvent').mockResolvedValue({eventId: 'event'});
    const sync = new CalendarSyncFixture(cal, '', store); syncers.push(sync);
    const action = storeAction(store, id)!;
    expect(await sync.syncActions([action], [action])).toEqual([expect.objectContaining({status: 'synced'})]);
    expect(sync.status(id)).toMatchObject({status: 'synced'});
    vi.spyOn(store, 'getRecordSourceHealth').mockReturnValue(unavailable);
    const diagnostics = forbidRawDiagnostics();
    expect(sync.status(id)).toMatchObject({status: 'failed', reason: ownerIssue.message});
    expect(diagnostics).not.toHaveBeenCalled();
  });
});
