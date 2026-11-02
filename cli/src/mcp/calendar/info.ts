import { CalClient } from './client.js';
import type { CalCalendar, CalAuthStatus } from './protocol.js';
import type { CalendarSyncStatus } from './sync.js';
import { formatScalar, quotedScalar } from '../format.js';
import { authorizationDiagnostic, type CalendarDiagnostic } from './diagnostics.js';

export function diagnosticLines(diagnostic: CalendarDiagnostic, indent = ''): string[] {
  return Object.entries(diagnostic).map(([key, value]) => `${indent}${key}: ${typeof value === 'number' ? value : quotedScalar(String(value))}`);
}

// The `calendar_sync:` block — one item per action state — as calendar_info
// and the mutation receipts both render it.
export function formatSyncStatusLines(states: CalendarSyncStatus[]): string[] {
  const lines = ['calendar_sync:'];
  for (const { id, status, reason, eventId, retry, diagnostic } of states) {
    lines.push(`  - id: ${formatScalar(id)}`, `    status: ${status}`);
    if (reason) lines.push(`    reason: ${quotedScalar(reason)}`);
    if (eventId) lines.push(`    event_id: ${quotedScalar(eventId)}`);
    if (retry) lines.push('    retry: true');
    if (diagnostic) lines.push(...diagnosticLines(diagnostic, '    ').filter(line => !line.startsWith('    reason:')));
  }
  return lines;
}

// Per-instance sync reporting that calendar_info surfaces, kept structural so
// this module needn't depend on CalSync.
export interface SyncReporter {
  report(): Array<{ id: string; reason: string }>;
  changesSinceStart(): Array<{ id: string; summary: string }>;
  statuses?(): CalendarSyncStatus[];
  failureDiagnostics?(): Array<{ id: string; diagnostic: CalendarDiagnostic }>;
}

export interface CalendarInfo {
  authorization: CalAuthStatus | 'unavailable' | 'error';
  helperPath?: string;
  calendars: CalCalendar[] | null;
  diagnostics: CalendarDiagnostic[];
  syncStates: CalendarSyncStatus[];
  failures: Array<{ id: string; diagnostic: CalendarDiagnostic }>;
  issues: Array<{ id: string; reason: string }>;
  changes: Array<{ id: string; summary: string }>;
  receipt: string;
}

// `calendar_info` — calendar state for the agent. It reports TCC auth, the
// available calendars, and (for the active instance) actions left unsynced plus
// reverse-sync changes applied since it loaded. When access is undecided or
// write-only it requests full access, surfacing the OS permission prompt; it never reads
// or writes events.
export async function handleCalendarInfo(cal: CalClient, sync?: SyncReporter): Promise<string> {
  return (await collectCalendarInfo(cal, sync)).receipt;
}

export async function collectCalendarInfo(cal: CalClient, sync?: SyncReporter): Promise<CalendarInfo> {
  const diagnostics: CalendarDiagnostic[] = [];
  let calendars: CalCalendar[] | null = null;
  const finish = (authorization: CalendarInfo['authorization'], lines: string[], helperPath?: string): CalendarInfo => ({
    authorization, helperPath, calendars, diagnostics, ...appendSyncInfo(lines, sync),
  });
  if (!cal.available()) {
    const diagnostic = cal.availabilityDiagnostic();
    if (diagnostic) diagnostics.push(diagnostic);
    return finish('unavailable', ['auth: unavailable', ...(diagnostic ? diagnosticLines(diagnostic) : [])]);
  }
  let status: CalAuthStatus;
  try { status = (await cal.authStatus()).status; }
  catch (e) {
    const diagnostic = cal.diagnosticForError(e, 'auth-status'); diagnostics.push(diagnostic);
    return finish('error', ['auth: error', ...diagnosticLines(diagnostic)]);
  }

  if (status === 'notDetermined' || status === 'writeOnly') {
    try { status = (await cal.requestAccess()).status; }
    catch (e) {
      const diagnostic = cal.diagnosticForError(e, 'request-access');
      // Communication failures retain their process category; a responding helper
      // failing the authorization command reports authorization-request-failed.
      if (diagnostic.category === 'helper-command-failed') diagnostic.category = 'authorization-request-failed';
      diagnostics.push(diagnostic);
      return finish(status, [`auth: ${formatScalar(status)}`, ...diagnosticLines(diagnostic)]);
    }
  }
  const lines = [`auth: ${formatScalar(status)}`, `helper_path: ${quotedScalar(cal.helperPath())}`];
  const diagnostic = authorizationDiagnostic(status);
  if (diagnostic) {
    diagnostics.push(diagnostic);
    lines.push(...diagnosticLines(diagnostic).filter(line => !line.startsWith('auth:')));
  }
  if (status === 'fullAccess') {
    try {
      calendars = (await cal.listCalendars()).calendars;
      lines.push(`calendars: ${formatCalendars(calendars)}`);
    } catch (e) {
      const diagnostic = cal.diagnosticForError(e, 'list-calendars'); diagnostics.push(diagnostic);
      lines.push('calendars: (unavailable)', ...diagnosticLines(diagnostic).filter(line => !line.startsWith('helper_path:')));
    }
  }
  return finish(status, lines, cal.helperPath());
}

function appendSyncInfo(lines: string[], sync?: SyncReporter): Pick<CalendarInfo, 'receipt' | 'syncStates' | 'failures' | 'issues' | 'changes'> {
  const statuses = sync?.statuses?.() ?? [];
  if (statuses.length > 0) lines.push(...formatSyncStatusLines(statuses));
  const represented = new Map(statuses.filter(state => state.diagnostic).map(state => [state.id, JSON.stringify(state.diagnostic)]));
  const diagnostics = (sync?.failureDiagnostics?.() ?? []).filter(item => represented.get(item.id) !== JSON.stringify(item.diagnostic));
  if (diagnostics.length) {
    lines.push('calendar_diagnostics:');
    for (const { id, diagnostic } of diagnostics) lines.push(`  - scope: ${quotedScalar(id)}`, ...diagnosticLines(diagnostic, '    '));
  }
  // Sync failures and reverse edits are surfaced whatever the auth status — a
  // failure like a missing instance id is real even before access is granted — so
  // calendar_info is the one place every failure shows.
  const issues = sync?.report() ?? [];
  if (issues.length > 0) {
    lines.push('issues:');
    for (const { id, reason } of issues) lines.push(`  ${formatScalar(id)} — ${formatScalar(reason)}`);
  }
  const changes = sync?.changesSinceStart() ?? [];
  if (changes.length > 0) {
    lines.push('changes:');
    for (const { id, summary } of changes) lines.push(`  ${formatScalar(id)} — ${formatScalar(summary)}`);
  }
  return { receipt: lines.join('\n'), syncStates: statuses, failures: diagnostics, issues, changes };
}

function formatCalendars(calendars: CalCalendar[]): string {
  if (calendars.length === 0) return '(none)';
  return calendars
    .map((c) => `${formatScalar(c.name)} (${formatScalar(c.account || 'local')}, ${c.writable ? 'writable' : 'read-only'})`)
    .join(', ');
}
