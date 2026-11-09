import { VERSION, BUILT_AT } from '../version.js';
import type { SemanticAvailability } from '../semantic/availability.js';
import type { CalendarSystemInfo, CalendarSyncInfo } from '../mcp/calendar/info.js';
import type { CalendarDiagnostic } from '../mcp/calendar/diagnostics.js';
import type { SystemDaemonSnapshot } from './system-daemon.js';
import type { SystemInstallationSnapshot } from './system-installation.js';

export interface SystemInfoOptions {
  signal?: AbortSignal;
  semanticAvailability?: (options?: {signal?: AbortSignal}) => Promise<SemanticAvailability>;
  systemDaemon?: () => SystemDaemonSnapshot;
  systemInstallation?: (options: {signal?: AbortSignal}) => Promise<SystemInstallationSnapshot>;
  calendarStatus?: () => Promise<CalendarSystemInfo>;
}

// Generated recovery names the global Calendar report. Action progress belongs to
// the owning instance's synchronization report; choosing a destination stays
// global. Authored content never passes here.
const syncRecovery = (text: string) => text.includes('systemInfo.calendar through query and choose')
  ? text : text.replaceAll('systemInfo.calendar through query', 'Instance.calendarSync through query');

const syncDiagnostic = (value: CalendarDiagnostic): CalendarDiagnostic => ({...value, recovery: syncRecovery(value.recovery)});
const diagnosticMessage = (value: CalendarDiagnostic) => `${value.reason} Recovery: ${value.recovery}`;

export function calendarSystemPayload(value: CalendarSystemInfo) {
  const {diagnostics} = value;
  return {...value, error: diagnostics.length ? [...new Set(diagnostics.map(diagnosticMessage))].join('\n') : null};
}

export function calendarSyncPayload(value: CalendarSyncInfo) {
  const payload = {...value,
    syncStates: value.syncStates.map(state => ({...state, diagnostic: state.diagnostic ? syncDiagnostic(state.diagnostic) : undefined})),
    failures: value.failures.map(failure => ({...failure, diagnostic: syncDiagnostic(failure.diagnostic)})),
  };
  const problems = [...payload.failures, ...payload.syncStates.flatMap(state =>
    state.diagnostic && state.diagnostic.category !== 'sync-pending'
      && !(state.status === 'disabled' && ['no calendar', 'action no longer exists'].includes(state.reason ?? ''))
      ? [{id: state.id, diagnostic: state.diagnostic}] : [])];
  const messages = problems.map(value => `${value.id}: ${diagnosticMessage(value.diagnostic)}`);
  for (const state of payload.syncStates) {
    if (state.status === 'failed' && (!state.diagnostic || state.diagnostic.category === 'sync-pending')) {
      messages.push(`${state.id}: ${state.reason ?? 'Calendar sync failed.'}`);
    }
  }
  for (const issue of payload.issues) {
    if (issue.reason === 'no calendar') continue;
    if (payload.syncStates.some(state => state.id === issue.id && state.status === 'pending'
      && state.diagnostic?.category === 'sync-pending' && state.reason === issue.reason)) continue;
    if (!problems.some(value => value.id === issue.id && value.diagnostic.reason === issue.reason)
      && !payload.syncStates.some(state => state.id === issue.id && state.status === 'failed' && state.reason === issue.reason)) {
      messages.push(`${issue.id}: ${issue.reason}`);
    }
  }
  return {...payload, error: messages.length ? [...new Set(messages)].join('\n') : null};
}

/** Each selected section is collected once per request, including aliases/fragments. */
export function systemInfoView(options: SystemInfoOptions) {
  const once = <T>(read: () => T) => {
    let value: Promise<T> | undefined;
    return () => {
      options.signal?.throwIfAborted();
      return value ??= Promise.resolve().then(() => { options.signal?.throwIfAborted(); return read(); });
    };
  };
  return {
    build: {version: VERSION, builtAt: BUILT_AT},
    daemon: once(() => options.systemDaemon?.() ?? null),
    installation: once(() => options.systemInstallation?.({signal: options.signal}) ?? null),
    search: {semantic: once(() => options.semanticAvailability
      ? options.semanticAvailability({signal: options.signal})
      : {available: false, reason: 'INDEX_UNAVAILABLE', model: process.env.ASIDE_EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b',
        message: 'Semantic search availability requires the Aside daemon.', recovery: 'Run this query through the Aside daemon.'})},
    calendar: once(async () => options.calendarStatus ? calendarSystemPayload(await options.calendarStatus()) : null),
  };
}
