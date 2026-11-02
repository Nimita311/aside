import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { createArtifact } from '../src/mcp/tools/artifact.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { projectionId } from '../src/core/recurrence.js';
import * as models from '../src/automation/models.js';

// Exercise the actual worker deadlines without waiting for the next wall minute.
const workerClock = vi.hoisted(() => ({beforeDeadlineMs: undefined as number | undefined}));
vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return {...actual, Worker: class extends actual.Worker {
    constructor(url: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      const offset = workerClock.beforeDeadlineMs;
      const code = `const RealDate = Date; const start = RealDate.now();
        const base = RealDate.parse('2099-01-01T09:00:00Z') - ${offset};
        global.Date = class extends RealDate {
          constructor(...args) {super(...(args.length ? args : [base + RealDate.now() - start]));}
          static now() {return base + RealDate.now() - start;}
        };
        import(${JSON.stringify(url.toString())});`;
      super(offset === undefined ? url : code, offset === undefined ? options : {...options, eval: true});
    }
  }};
});

let dir: string, store: Store, host: InstanceHost, prompt: string;
beforeEach(() => {
  workerClock.beforeDeadlineMs = undefined;
  dir = mkdtempSync('/tmp/aside-delegation-'); init(dir, {name: 'Delegations', description: 'Tests'});
  store = new Store(dir); prompt = createArtifact(store, {name: 'Instructions', description: 'Instructions', body: 'Perform the action.'}).id;
  vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
  vi.spyOn(models, 'catalogFor').mockResolvedValue({models: [{name: 'external', label: 'external', builtin: false, availability: 'AVAILABLE'}], diagnostics: [], revision: 'test'});
  agent("console.log('Result');");
  host = new InstanceHost(new CalClient(null)); host.configureAutomation(join(dir, 'runs'));
});
afterEach(async () => {await host.stopAutomation(); await host.close(); store.close(); vi.restoreAllMocks(); rmSync(dir, {recursive: true, force: true});});
function agent(body: string) {
  const path = join(dir, 'agent.cjs');
  writeFileSync(path, `let prompt=''; process.stdin.on('data', chunk=>prompt+=chunk); process.stdin.on('end',()=>{${body}});`);
  writeFileSync(join(dir, '.aside'), JSON.stringify({execution: {models: {external: {command: process.execPath, args: [path]}}}}));
}
const declaration = () => ({run: {model: 'external', prompt: `#artifact/${prompt}`}});
function task(fields: Record<string, any> = {}) {return handleCapture(host.load(dir).store, {content: 'Context', description: 'Context', actions: [{name: 'Delegated work', description: 'Work', body: 'Action-specific context.', delegation: declaration(), ...fields}]}).createdActionIds[0];}
async function graph(document: string, mode = 'query', variables?: Record<string, unknown>) {return JSON.parse((await host.tool(dir, mode, {document, variables})).text);}
async function dispatch(id: string) {return graph('mutation($id: ID!) {runDelegation(id: $id) {__typename id name status filePath stdoutLog stderrLog latenessMs action {id status occurrence {projected}} automation {name}}}', 'mutate', {id});}
async function finished(id: string) {
  let result: any;
  await vi.waitFor(async () => {
    result = await graph(`{action(id: "${id}") {status delegation {running} delegationLog {nodes {id status error completionError prompt output(stream: STDOUT) {text}}}}}`);
    expect(result.errors).toBeUndefined();
    expect((result.data.action.delegation?.running ?? false)).toBe(false);
    const run = result.data.action.delegationLog.nodes[0];
    expect(run.status).not.toBe('RUNNING');
    if (run.status === 'SUCCEEDED' && run.completionError === null) expect(result.data.action.status).toBe('DONE');
  }, {timeout: 5000});
  return result.data.action;
}
describe('delegation execution through GraphQL and the worker', () => {
  it('forces backlog work, records output and marks it done without leaking runs into instance automation history', async () => {
    const id = task();
    const launched = await dispatch(id);
    expect(launched.errors).toBeUndefined();
    const receipt = launched.data.runDelegation;
    expect(receipt).toMatchObject({__typename: 'AutomationRun', name: 'delegation', automation: {name: 'delegation'}});
    expect(JSON.parse(readFileSync(receipt.filePath, 'utf8')).id).toBe(receipt.id);
    expect(receipt.stdoutLog).toBe(join(receipt.filePath.slice(0, -'run.json'.length), 'stdout.log'));
    expect(receipt.stderrLog).toBe(join(receipt.filePath.slice(0, -'run.json'.length), 'stderr.log'));
    expect(receipt.latenessMs).toBeGreaterThanOrEqual(0);
    const action = await finished(id);
    expect(action.status).toBe('DONE');
    expect(action.delegationLog.nodes[0]).toMatchObject({status: 'SUCCEEDED', completionError: null, output: {text: 'Result\n'}});
    expect(action.delegationLog.nodes[0].prompt).toBe(`This is an Aside action delegation. The user has delegated an action to you to complete. A successful exit marks this action done. Follow the user's instructions autonomously.

Instance: ${host.load(dir).store.getManifest().id}
Action: #action/${id}
User's instruction: #artifact/${prompt}`);
    expect((await graph('{activeInstance {automationLog {totalCount}}}')).data.activeInstance.automationLog.totalCount).toBe(0);
  });
  it('leaves a future projection unsaved at launch and materializes it on completion', async () => {
    agent("setTimeout(()=>console.log('Result'), 300);");
    const template = task({recurrence: [{dtstart: '2099-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY;COUNT=2'}]});
    const id = projectionId({template, original: '2099-01-01T09:00:00Z'});
    const result = await dispatch(id);
    expect(result.errors).toBeUndefined();
    expect(result.data.runDelegation.action).toMatchObject({id, occurrence: {projected: true}});
    expect(JSON.parse(readFileSync(result.data.runDelegation.filePath, 'utf8')).prompt).toContain(`Instance: ${host.load(dir).store.getManifest().id}
Action: #action/${id}`);
    expect(host.load(dir).store.getActions().size).toBe(1);
    expect(result.extensions.mutations[0].changes).toEqual([]);
    expect((await finished(id)).status).toBe('DONE');
    const saved = (await graph('{action(id: "'+id+'") {id occurrence {projected} delegationLog {nodes {action {id}}}}}')).data.action;
    expect(saved.occurrence.projected).toBe(false); expect(saved.id).not.toBe(id);
    expect(saved.delegationLog.nodes[0].action.id).toBe(saved.id);
    const state = await graph(`{action(id: "${template}") {status delegation {log {totalCount}}}}`);
    expect(state.data.action).toEqual({status: null, delegation: {log: {totalCount: 1}}});
    store.rebuild(); expect(store.getActions().size).toBe(2);
    expect(store.getAction(template)!.frontMatter).not.toHaveProperty('resolution');
  });
  it('automatically executes an unsaved projection at its deadline and saves only completion', async () => {
    workerClock.beforeDeadlineMs = 2000;
    agent("setTimeout(()=>console.log('Result'), 600);");
    const template = task({recurrence: [{dtstart: '2099-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY;COUNT=1'}]});
    const id = projectionId({template, original: '2099-01-01T09:00:00Z'});
    await vi.waitFor(async () => {
      const observed = await graph('{action(id: "'+template+'") {delegation {running log {nodes {status action {id occurrence {projected}}}}}}}');
      expect(observed.errors).toBeUndefined();
      const failure = observed.extensions.diagnostics.find((issue: any) => issue.severity === 'error');
      if (failure) throw new Error(failure.message);
      expect(observed.data.action.delegation).toMatchObject({running: true,
        log: {nodes: [{status: 'RUNNING', action: {id, occurrence: {projected: true}}}]}});
    }, {timeout: 5000});
    expect(host.load(dir).store.getActions().size).toBe(1);
    expect((await finished(id)).status).toBe('DONE');
    expect(host.load(dir).store.getActions().size).toBe(2);
  }, 10000);
  it('silently skips an automatic deadline consumed by a failed forced projection run', async () => {
    workerClock.beforeDeadlineMs = 3000;
    agent('process.exit(7);');
    const template = task({recurrence: [{dtstart: '2099-01-01T09:00', timezone: 'UTC', rrule: 'FREQ=DAILY;COUNT=1'}]});
    const id = projectionId({template, original: '2099-01-01T09:00:00Z'});
    await dispatch(id);
    expect((await finished(id)).delegationLog.nodes[0].status).toBe('FAILED');
    await vi.waitFor(async () => {
      const observed = await graph('{action(id: "'+template+'") {delegation {next running log {totalCount nodes {status}}}}}');
      expect(observed.errors).toBeUndefined();
      expect(observed.data.action.delegation).toEqual({next: null, running: false,
        log: {totalCount: 1, nodes: [{status: 'FAILED'}]}});
      expect(observed.extensions.diagnostics.some((issue: any) => issue.code === 'delegation_error')).toBe(false);
    }, {timeout: 5000});
    expect(host.load(dir).store.getActions().size).toBe(1);
  }, 10000);
  it('keeps failures and timeouts unresolved', async () => {
    agent('process.exit(7);');
    const id = task({scheduled: '2099-01-01T09:00', timezone: 'UTC'});
    const launched = await dispatch(id);
    expect(launched.errors).toBeUndefined();
    expect(launched.data.runDelegation.id).toBeTruthy();
    const failed = await finished(id); expect(failed.status).toBe('SCHEDULED');
    expect(failed.delegationLog.nodes[0].status).toBe('FAILED');
    agent('setInterval(()=>{}, 10000);');
    await graph(`mutation {updateAction(id: "${id}", input: {delegation: {run: {model: "external", prompt: {existingId: "${prompt}"}}, timeout: "PT0.1S"}}) {error}}`, 'mutate');
    await dispatch(id); expect((await finished(id)).delegationLog.nodes[0].status).toBe('TIMED_OUT');
  });
  it('rejects concurrent launches and marks an action done even if cancelled during the run', async () => {
    agent("setTimeout(()=>console.log('Result'), 300);");
    const id = task(); const first = await dispatch(id); expect(first.errors).toBeUndefined();
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await dispatch(id);
      expect(rejected.data.runDelegation).toBeNull();
      expect(rejected.errors).toEqual([expect.objectContaining({message: expect.stringContaining('already running'), path: ['runDelegation']})]);
      expect(rejected.extensions.mutations).toEqual([]);
    }
    await graph(`mutation {updateAction(id: "${id}", input: {status: CANCELLED}) {action {status}}}`, 'mutate');
    expect((await finished(id)).status).toBe('DONE');
    expect((await graph(`{action(id: "${id}") {delegation {log {totalCount}}}}`)).data.action.delegation.log.totalCount).toBe(1);
  });
  it.each(['schedule', 'body', 'delegation', 'clear'])('marks an action done after successful execution while preserving edits: %s', async field => {
    agent("setTimeout(()=>console.log('Result'), 300);"); const id = task(); await dispatch(id);
    const input = field === 'schedule' ? {scheduled: '2099-01-01T09:00'} : field === 'body' ? {body: 'New work to perform.'}
      : field === 'clear' ? {delegation: null} : {delegation: {run: {model: 'external', prompt: {existingId: prompt}}, timeout: 'PT1M'}};
    const changed = await graph('mutation($id: ID!, $input: UpdateActionInput!) {updateAction(id: $id, input: $input) {error}}', 'mutate', {id, input});
    expect(changed.errors).toBeUndefined();
    const state = await finished(id); expect(state.status).toBe('DONE');
    expect(state.delegationLog.nodes[0].completionError).toBeNull();
    const action = host.load(dir).store.getAction(id)!;
    if (field === 'schedule') expect(action.frontMatter.scheduled).toBe(input.scheduled);
    if (field === 'body') expect(action.body).toBe(input.body);
    if (field === 'delegation') expect(action.frontMatter.delegation?.timeout).toBe('PT1M');
    if (field === 'clear') expect(action.frontMatter).not.toHaveProperty('delegation');
  });
  it.each(['done', 'cancelled'] as const)('marks a forced %s action done after a successful exit', async resolution => {
    const id = task({resolution});
    await dispatch(id);
    const state = await finished(id);
    expect(state.status).toBe('DONE');
    expect(state.delegationLog.nodes[0]).toMatchObject({status: 'SUCCEEDED', completionError: null});
  });
  it('does not dispatch a done action automatically and rejects templates as manual targets', async () => {
    const id = task({scheduled: '2099-01-01T09:00'}); handleUpdateAction(host.load(dir).store, {id, resolution: 'done'});
    expect((await graph(`{action(id: "${id}") {delegation {next running log {totalCount}}}}`)).data.action.delegation).toEqual({next: null, running: false, log: {totalCount: 0}});
    const template = task({name: 'Template', recurrence: []});
    expect((await dispatch(template)).errors[0].message).toContain('projected occurrence');
  });
  it('mirrors automation run details, recent-run paging and outcome filters', async () => {
    const id = task();
    const first = await dispatch(id); await finished(id);
    agent('process.exit(7);');
    const second = await dispatch(id); await finished(id);
    const result = await graph(`{action(id: "${id}") {
      recent: delegationLog(limit: 1) {totalCount offset count nodes {
        id status started finished occurrence latenessMs model prompt cwd command args pid exitCode signal
        filePath stdoutLog stderrLog automation {name timeout run {model}} action {id}
        output(stream: STDERR) {text offset nextOffset totalBytes}
      }}
      older: delegationLog(limit: 1, offset: 1) {totalCount offset count nodes {id status}}
      failed: delegationLog(where: {name: "delegation", status: [FAILED]}) {totalCount nodes {id exitCode}}
      selected: delegationLog(where: {id: "${first.data.runDelegation.id}"}) {totalCount nodes {id}}
      empty: delegationLog(where: {status: []}) {totalCount nodes {id}}
      declaration: delegation {log(limit: 1) {nodes {id}}}
    }}`);
    expect(result.errors).toBeUndefined();
    const recent = result.data.action.recent;
    expect(recent).toMatchObject({totalCount: 2, offset: 0, count: 1});
    expect(recent.nodes[0]).toMatchObject({id: second.data.runDelegation.id, status: 'FAILED', model: 'external',
      cwd: realpathSync(dir), command: process.execPath, args: [join(dir, 'agent.cjs')], pid: expect.any(Number), exitCode: 7,
      signal: null, latenessMs: expect.any(Number), started: expect.any(String), finished: expect.any(String),
      occurrence: expect.any(String), prompt: expect.stringContaining(`User's instruction: #artifact/${prompt}`),
      action: {id}, automation: {name: 'delegation', timeout: 'PT30M', run: {model: 'external'}},
      output: {text: '', offset: 0, nextOffset: 0, totalBytes: 0}});
    expect(JSON.parse(readFileSync(recent.nodes[0].filePath, 'utf8')).exitCode).toBe(7);
    expect(recent.nodes[0].stdoutLog).toBe(second.data.runDelegation.stdoutLog);
    expect(recent.nodes[0].stderrLog).toBe(second.data.runDelegation.stderrLog);
    expect(result.data.action.older).toEqual({totalCount: 2, offset: 1, count: 1, nodes: [{id: first.data.runDelegation.id, status: 'SUCCEEDED'}]});
    expect(result.data.action.failed).toEqual({totalCount: 1, nodes: [{id: second.data.runDelegation.id, exitCode: 7}]});
    expect(result.data.action.selected).toEqual({totalCount: 1, nodes: [{id: first.data.runDelegation.id}]});
    expect(result.data.action.empty).toEqual({totalCount: 0, nodes: []});
    expect(result.data.action.declaration.log.nodes).toEqual([{id: second.data.runDelegation.id}]);
  });
  it('retains queryable history after clearing delegation', async () => {
    const id = task(); await dispatch(id); await finished(id);
    await graph(`mutation {updateAction(id: "${id}", input: {delegation: null}) {error}}`, 'mutate');
    const result = await graph(`{action(id: "${id}") {delegation {timeout} delegationLog {totalCount nodes {status automation {timeout} action {id}}}}}`);
    expect(result.errors).toBeUndefined();
    expect(result.data.action).toEqual({delegation: null, delegationLog: {totalCount: 1, nodes: [{status: 'SUCCEEDED', automation: null, action: {id}}]}});
  });
  it('leaves failed projection executions unsaved and queryable outside lookahead', async () => {
    agent('process.exit(7);');
    const template = task({recurrence: [{dtstart: '2099-01-01', rrule: 'FREQ=DAILY;COUNT=2'}]});
    const id = projectionId({template, original: '2099-01-01'});
    const result = await dispatch(id);
    expect(result.errors).toBeUndefined();
    expect(result.data.runDelegation.action).toMatchObject({id, occurrence: {projected: true}});
    const state = await finished(id);
    expect(state.status).toBe('SCHEDULED');
    expect(state.delegationLog.nodes[0].status).toBe('FAILED');
    expect(host.load(dir).store.getActions().size).toBe(1);
    const history = await graph('{action(id: "'+template+'") {delegationLog {nodes {action {id occurrence {projected}}}}}}');
    expect(history.data.action.delegationLog.nodes[0].action).toEqual({id, occurrence: {projected: true}});
  });
  it('materializes on the agent first edit and reuses that identity for completion and concurrency', async () => {
    agent("setTimeout(()=>console.log('Result'), 500);");
    const template = task({recurrence: [{dtstart: '2099-01-01', rrule: 'FREQ=DAILY;COUNT=2'}]});
    const id = projectionId({template, original: '2099-01-01'});
    await dispatch(id);
    const edit = await graph('mutation($id: ID!) {updateAction(id: $id, input: {name: "Agent edited", body: "Agent updated the action while working."}) {error action {id occurrence {projected}}}}', 'mutate', {id});
    expect(edit.errors).toBeUndefined(); expect(edit.data.updateAction.error).toBeNull();
    const saved = edit.data.updateAction.action;
    expect(saved.occurrence.projected).toBe(false); expect(saved.id).not.toBe(id);
    expect(host.load(dir).store.getActions().size).toBe(2);
    expect((await dispatch(saved.id)).errors[0].message).toContain('already running');
    expect((await dispatch(id)).errors[0].message).toContain('already running');
    expect((await finished(id)).status).toBe('DONE');
    expect(host.load(dir).store.getAction(saved.id)!.body).toBe('Agent updated the action while working.');
    const secondEdit = await graph('mutation($id: ID!) {updateAction(id: $id, input: {name: "Edited again"}) {error action {id}}}', 'mutate', {id});
    expect(secondEdit.data.updateAction.action.id).toBe(saved.id);
    expect(host.load(dir).store.getActions().size).toBe(2);
  });
  it('reports completion write failures on the retained run without editing at launch', async () => {
    agent("setTimeout(()=>console.log('Result'), 300);");
    const template = task({recurrence: [{dtstart: '2099-01-01', rrule: 'FREQ=DAILY;COUNT=2'}]});
    const id = projectionId({template, original: '2099-01-01'});
    const failing = vi.spyOn(Store.prototype, 'addIndexEntry').mockImplementation(() => {throw new Error('Index write failed');});
    const result = await dispatch(id);
    expect(result.errors).toBeUndefined();
    expect(result.extensions.mutations[0].changes).toEqual([]);
    expect(host.load(dir).store.getActions().size).toBe(1);
    const state = await finished(id);
    expect(state.delegationLog.nodes[0]).toMatchObject({status: 'SUCCEEDED', completionError: expect.stringContaining('Index write failed')});
    failing.mockRestore();
  });
});
