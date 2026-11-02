import type { CalAuthStatus } from './protocol.js';

export interface CalendarDiagnostic {
  category: string;
  reason: string;
  recovery: string;
  helper_path?: string;
  log_path?: string;
  stderr?: string;
  command?: string;
  exit_code?: number;
  signal?: string;
  auth?: CalAuthStatus;
}

export function authorizationDiagnostic(status: CalAuthStatus): CalendarDiagnostic | undefined {
  if (status === 'fullAccess') return undefined;
  const recovery: Record<Exclude<CalAuthStatus, 'fullAccess'>, string> = {
    notDetermined: 'Call calendar_info to request full access. If the request returns undecided, retry from an interactive macOS session and inspect the permission dialog; its cause is unknown.',
    denied: 'Enable Aside calendar access in System Settings → Privacy & Security → Calendars, then call calendar_info. Rebuilding the source helper may require granting access again.',
    restricted: 'The operating system reports restricted calendar access. Ask the device administrator about policy or parental restrictions; ordinary permission re-prompting cannot remove them.',
    writeOnly: 'Call calendar_info to request an upgrade to full access; write-only permission cannot support reverse sync.',
    unknown: 'Inspect the daemon log and call calendar_info again; the helper returned an unrecognized authorization state.',
  };
  return { category: `authorization-${status}`, auth: status, reason: `Calendar authorization is ${status}; sync requires fullAccess.`, recovery: recovery[status] };
}

export function diagnoseCalEnvironment(os: string, kernel: string, helper: string, present: boolean): CalendarDiagnostic | undefined {
  if (os !== 'darwin') return { category: 'platform-unsupported', reason: `Calendar sync requires macOS 14+; this platform is ${os}.`, recovery: 'Use Aside records normally; enable calendar sync on a supported Mac.' };
  const major = Number(kernel.split('.')[0]);
  if (Number.isFinite(major) && major > 0 && major < 23) return { category: 'platform-unsupported', reason: `Calendar sync requires macOS 14+; Darwin kernel ${kernel} is older.`, recovery: 'Upgrade macOS before building and enabling the calendar helper.' };
  if (!present) return { category: 'helper-missing', helper_path: helper, reason: 'The source calendar helper is missing.', recovery: 'From the Aside clone, run bash cli/native/build.sh with Xcode Command Line Tools installed. Then close connected agent sessions and webapp tabs and restart the shared daemon; helper detection is cached at daemon startup. A rebuilt source helper may need a new calendar grant. Check calendar_info afterwards.' };
  return undefined;
}
