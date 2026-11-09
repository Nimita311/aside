import { CalClient } from './client.js';
import type { CalCalendar, CalAuthStatus } from './protocol.js';
import type { CalendarSyncStatus } from './sync.js';
import { authorizationDiagnostic, type CalendarDiagnostic } from './diagnostics.js';

// Per-instance sync reporting that calendarSync surfaces, kept structural so
// this module needn't depend on CalSync.
export interface SyncReporter {
  report(): Array<{ id: string; reason: string }>;
  changesSinceStart(): Array<{ id: string; summary: string }>;
  statuses?(): CalendarSyncStatus[];
  failureDiagnostics?(): Array<{ id: string; diagnostic: CalendarDiagnostic }>;
}

export interface CalendarSystemInfo {
  authorization: CalAuthStatus | 'unavailable' | 'error';
  helperPath?: string;
  calendars: CalCalendar[] | null;
  diagnostics: CalendarDiagnostic[];
}

export interface CalendarSyncInfo {
  syncStates: CalendarSyncStatus[];
  failures: Array<{ id: string; diagnostic: CalendarDiagnostic }>;
  issues: Array<{ id: string; reason: string }>;
  changes: Array<{ id: string; summary: string }>;
}

/** Inspect global Calendar state without requesting permission or inspecting an instance. */
export function collectCalendarStatus(cal: CalClient): Promise<CalendarSystemInfo> {
  return collectCalendarInfo(cal, {requestAccess: false});
}

export function collectCalendarSyncInfo(sync: SyncReporter): CalendarSyncInfo {
  const syncStates = sync.statuses?.() ?? [];
  const represented = new Map(syncStates.filter(state => state.diagnostic).map(state => [state.id, JSON.stringify(state.diagnostic)]));
  const failures = (sync.failureDiagnostics?.() ?? []).filter(item => represented.get(item.id) !== JSON.stringify(item.diagnostic));
  return {syncStates, failures, issues: sync.report(), changes: sync.changesSinceStart()};
}

// TCC auth and the available calendars. When access is undecided or write-only it
// requests full access, surfacing the OS permission prompt, unless told not to; it
// never reads or writes events.
export async function collectCalendarInfo(cal: CalClient, options: {requestAccess?: boolean} = {}): Promise<CalendarSystemInfo> {
  const diagnostics: CalendarDiagnostic[] = [];
  let calendars: CalCalendar[] | null = null;
  const finish = (authorization: CalendarSystemInfo['authorization'], helperPath?: string): CalendarSystemInfo =>
    ({authorization, helperPath, calendars, diagnostics});
  if (!cal.available()) {
    const diagnostic = cal.availabilityDiagnostic();
    if (diagnostic) diagnostics.push(diagnostic);
    return finish('unavailable');
  }
  let status: CalAuthStatus;
  try { status = (await cal.authStatus()).status; }
  catch (e) {
    diagnostics.push(cal.diagnosticForError(e, 'auth-status'));
    return finish('error');
  }

  if (options.requestAccess !== false && (status === 'notDetermined' || status === 'writeOnly')) {
    try { status = (await cal.requestAccess()).status; }
    catch (e) {
      const diagnostic = cal.diagnosticForError(e, 'request-access');
      // Communication failures retain their process category; a responding helper
      // failing the authorization command reports authorization-request-failed.
      if (diagnostic.category === 'helper-command-failed') diagnostic.category = 'authorization-request-failed';
      diagnostics.push(diagnostic);
      return finish(status);
    }
  }
  const diagnostic = authorizationDiagnostic(status);
  if (diagnostic) diagnostics.push(diagnostic);
  if (status === 'fullAccess') {
    try { calendars = (await cal.listCalendars()).calendars; }
    catch (e) { diagnostics.push(cal.diagnosticForError(e, 'list-calendars')); }
  }
  return finish(status, cal.helperPath());
}
