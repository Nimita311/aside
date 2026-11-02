import { AUTOMATION_INSPECTION_LIMIT } from '../core/system-config.js';
import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AutomationScheduler, type AutomationSource, type ScheduledJob } from './scheduler.js';
import { AutomationRunner } from './execution.js';
import { RunStorage } from './storage.js';
import { AutomationModelWarmup } from './model-warmup.js';
import { compileDelegation, delegationKey, nextDelegation } from './delegation.js';
import type { DelegationDispatchResult, PreparedDelegation } from './delegation-protocol.js';
import { AUTOMATION_WORKER_TIMEOUT_MS } from '../core/system-config.js';
import { scheduleInstant } from '../core/scheduling.js';

const port = parentPort!;
const storage = new RunStorage(workerData.storage);
let warning: string | undefined;
const changed = () => port.postMessage({ type: 'status', jobs: delegationStatus(), warning, modelWarnings: warmup.warnings() });
const runner = new AutomationRunner(storage, changed);
const scheduler = new AutomationScheduler({ run: async (job, at) => {
  if (job.delegation) await dispatchDelegation(job, at, true); else await runner.run(job, at);
}, claim: (key, at) => {
  let identity: string[] = [];
  try {identity = JSON.parse(key);} catch {}
  // One automatic attempt per immutable recurrence occurrence, even if its
  // saved schedule moves or the local timezone changes after a failed run.
  const occurrence = identity[1]?.startsWith('#action/~') && identity[2] === 'delegation';
  return storage.claim(key, occurrence ? Number.MAX_SAFE_INTEGER : at);
}, lastClaim: key => storage.lastClaim(key), changed });
const warmup = new AutomationModelWarmup(changed);
const activeDelegations = new Map<string, string>();
const delegationErrors = new Map<string, string>();
function delegationStatus() {
  return scheduler.status().map(job => ({...job,
    running: job.running || activeDelegations.has(job.key) || [...activeDelegations.values()].includes(job.key),
    ...(delegationErrors.has(job.key) ? {error: delegationErrors.get(job.key)} : {})}));
}
const completingDelegations = new Set<Promise<void>>();
let delegationRequest = 0;
const delegationReplies = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
function hostRequest(message: Record<string, unknown>): Promise<any> {
  const requestId = ++delegationRequest;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {delegationReplies.delete(requestId); reject(new Error('Delegation host did not answer within 5 seconds.'));}, AUTOMATION_WORKER_TIMEOUT_MS);
    delegationReplies.set(requestId, {resolve, reject, timer});
    port.postMessage({type: 'delegation-request', requestId, ...message});
  });
}
function dispatchDelegation(source: AutomationSource, at: number, automatic: false): Promise<DelegationDispatchResult>;
function dispatchDelegation(source: AutomationSource, at: number, automatic: true): Promise<DelegationDispatchResult | undefined>;
async function dispatchDelegation(source: AutomationSource, at: number, automatic: boolean): Promise<DelegationDispatchResult | undefined> {
  let prepared: PreparedDelegation | undefined, key: string | undefined, reserved = false;
  try {
    if (stopping || source.blocked) throw new Error(source.blocked ?? 'Delegation runtime is shutting down.');
    compileDelegation(source);
    const target = automatic ? nextDelegation(source.delegation!, at - 1)
      : {id: source.delegation!.id, action: source.delegation!.action, at};
    if (!target || automatic && target.at !== at) throw new Error('Delegation occurrence is no longer scheduled.');
    key = delegationKey(source.root, target.id, target.action);
    if (activeDelegations.has(key)) throw new Error('This action delegation is already running.');
    activeDelegations.set(key, source.key); reserved = true;
    const scheduled = target.action.frontMatter.scheduled;
    const claimAt = scheduled ? scheduleInstant(scheduled, target.action.frontMatter.timezone) : at;
    // The scheduler already claimed its source. Template occurrences additionally
    // share a durable identity claim with saved occurrences and manual dispatch.
    if (claimAt !== undefined && (!automatic || key !== source.key)) {
      const claimed = storage.claim(key, target.action.frontMatter.occurrence ? Number.MAX_SAFE_INTEGER : claimAt);
      if (automatic && !claimed) {
        // A forced run already consumed this occurrence. Reaching its scheduled
        // deadline is an expected skip, including when the run left it unsaved.
        activeDelegations.delete(key); changed(); return undefined;
      }
    }
    delegationErrors.delete(source.key);
    // Scheduled jobs also carry executable schedule functions. Only source
    // metadata may cross the worker/host boundary.
    const requestSource: AutomationSource = {key: source.key, root: source.root, instance: source.instance,
      definedIn: source.definedIn, declaration: source.declaration, blocked: source.blocked, delegation: source.delegation};
    prepared = await hostRequest({operation: 'prepare', request: {source: requestSource, target, automatic}});
    const job: ScheduledJob = {...prepared!.source, ...compileDelegation(prepared!.source)};
    job.definition.schedule = {at: new Date(at).toISOString()};
    const launched = runner.launch(job, at);
    const release = storage.protect(launched.record);
    const work = launched.done.then(async run => {
      if (run.status === 'succeeded') {
        try {run.actionId = await hostRequest({operation: 'complete', source: prepared!.source, run}); storage.save(run);}
        catch (error) {run.completionError = (error as Error).message; storage.save(run);}
      }
    }).catch(error => port.postMessage({type: 'error', error: (error as Error).message})).finally(() => {
      release(); activeDelegations.delete(key!); completingDelegations.delete(work);
      try {storage.prune(launched.record.key);}
      catch (error) {port.postMessage({type: 'error', error: (error as Error).message});}
      changed();
    });
    completingDelegations.add(work);
    return {run: {...structuredClone(launched.record), directory: launched.directory}, actionId: launched.record.actionId!};
  } catch (error) {
    if (reserved && key && activeDelegations.get(key) === source.key) activeDelegations.delete(key);
    if (automatic) {delegationErrors.set(source.key, (error as Error).message); changed();}
    throw error;
  }
}
let helper: ReturnType<typeof spawn> | undefined;
let stopping = false;
if (process.platform === 'darwin') {
  if (existsSync(workerData.wakeBinary)) {
    helper = spawn(workerData.wakeBinary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    helper.stdout!.on('data', chunk => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const [event, zone] = buffer.slice(0, newline).split('\t'); buffer = buffer.slice(newline + 1);
        if (event === 'sleep') scheduler.sleep();
        else if (event === 'wake' || event === 'ready') scheduler.wake(zone);
        else if (event === 'clock' || event === 'timezone') scheduler.discontinuity(zone);
      }
    });
    const unavailable = () => { if (!stopping) { warning = 'Native wake/clock notifications are unavailable; rebuild the CLI. Timer accuracy is limited across sleep and clock changes.'; changed(); } };
    helper.on('error', unavailable); helper.on('exit', unavailable);
  } else warning = 'Native wake/clock helper is missing; rebuild the CLI.';
}
port.on('message', async message => {
  try {
    if (message.type === 'delegation-response') {
      const pending = delegationReplies.get(message.requestId);
      if (pending) {clearTimeout(pending.timer); delegationReplies.delete(message.requestId);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);}
    }
    if (message.type === 'delegate') {
      try {
        const result = await dispatchDelegation(message.source, Date.now(), false);
        port.postMessage({type: 'delegated', id: message.id, result});
      } catch (error) {port.postMessage({type: 'delegated', id: message.id, error: (error as Error).message});}
    }
    if (message.type === 'replace') {
      for (const key of delegationErrors.keys()) if (!message.sources.some((source: AutomationSource) => source.key === key)) delegationErrors.delete(key);
      scheduler.replace(message.sources as AutomationSource[]);
      warmup.replace(message.sources as AutomationSource[]);
    }
    if (message.type === 'inspect') {
      const history = storage.history();
      // Scope before paging so another instance's newer runs cannot hide this
      // instance's retained history. Legacy daemon inspection keeps its cap.
      const runs = typeof message.root === 'string' ? history.filter(run => run.root === message.root) : history.slice(0, AUTOMATION_INSPECTION_LIMIT);
      port.postMessage({ type: 'inspection', id: message.id, jobs: delegationStatus(), warning, modelWarnings: warmup.warnings(), runs });
    }
    if (message.type === 'cleanup' || message.type === 'purge') {
      const result = message.type === 'cleanup' ? storage.cleanup() : storage.purge(message.root);
      port.postMessage({type: 'maintenance', id: message.id, result});
    }
    if (message.type === 'close') {
      stopping = true; scheduler.close(); helper?.stdin!.end();
      await Promise.all([runner.close(), warmup.close()]);
      await Promise.allSettled([...completingDelegations]);
      port.postMessage({ type: 'closed' }); port.close();
    }
  } catch (error) { port.postMessage({ type: 'error', id: message.id, error: (error as Error).message }); }
});
changed();
