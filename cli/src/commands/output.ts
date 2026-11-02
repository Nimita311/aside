import { formatScalar } from '../mcp/format.js';

export interface HealthCheck {
  code: string;
  label: string;
  passed: boolean;
  problems?: string[];
  fixes?: string[];
  path?: string;
  group?: string;
}
export interface OutputEntry {
  name: string;
  path?: string;
  annotations?: string[];
  fields?: Record<string, unknown>;
}
export interface OutputSection {
  name: string;
  fields?: Record<string, unknown>;
  entries?: OutputEntry[];
}
export interface Report {
  title: string;
  data: unknown;
  sections: OutputSection[];
  checks: HealthCheck[];
}

let jsonWritten = false;
let failedChecks = false;
export function outputState(): { jsonWritten: boolean; failedChecks: boolean } { return { jsonWritten, failedChecks }; }
export function writeOutput(text: string, json: boolean, out: (text: string) => void = console.log): void {
  out(text);
  jsonWritten ||= json;
}
export function publishReport(report: Report, command: string, json = false, out: (text: string) => void = console.log): void {
  failedChecks ||= report.checks.some(check => !check.passed);
  writeOutput(renderReport(report, command, json), json, out);
}

export function publishReceipt(report: Report, command: string, lines: string[], json = false, out: (text: string) => void = console.log): void {
  failedChecks ||= report.checks.some(check => !check.passed);
  if (json) writeOutput(jsonResult(command, report.data, report.checks), true, out);
  else if (lines.length) writeOutput(lines.join('\n'), false, out);
}

export function jsonResult(command: string, data: unknown, checks: HealthCheck[] = [], diagnostics: unknown[] = [], ok = checks.every(check => check.passed)): string {
  return JSON.stringify({ schema_version: 1, command, ok, data, checks, diagnostics }, null, 2);
}

export function renderReport(report: Report, command: string, json = false): string {
  if (json) return jsonResult(command, report.data, report.checks);
  const lines = [report.title];
  const heading = (label: string) => lines.push('', `${label} ${'─'.repeat(Math.max(3, 48 - label.length))}`);
  const fields = (values: Record<string, unknown>, indent = '') => {
    const width = Math.max(0, ...Object.keys(values).map(key => key.length)) + 2;
    for (const [label, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const text = value === null ? 'none' : typeof value === 'string' ? value : JSON.stringify(value);
      lines.push(`${indent}${label.padEnd(width)}${formatScalar(text)}`);
    }
  };
  for (const section of report.sections) {
    heading(section.name);
    if (section.fields) fields(section.fields);
    for (const entry of section.entries ?? []) {
      lines.push('', `${formatScalar(entry.name)}${entry.annotations?.length ? ` (${entry.annotations.map(formatScalar).join(', ')})` : ''}`);
      if (entry.path) lines.push(`  ${formatScalar(entry.path)}`);
      if (entry.fields) fields(entry.fields, '  ');
    }
  }
  if (report.checks.length) {
    heading('Health');
    let group: string | undefined;
    for (const check of report.checks) {
      if (check.group && check.group !== group) { lines.push('', check.group); group = check.group; }
      const color = !!process.stdout.isTTY && process.env.NO_COLOR === undefined;
      const badge = `[${check.passed ? 'OK' : 'ERROR'}]`;
      lines.push(`${color ? `\x1b[${check.passed ? '32' : '31'}m${badge}\x1b[0m` : badge} ${formatScalar(check.label)}`);
      if (check.path) lines.push(`  ${formatScalar(check.path)}`);
      for (const problem of check.problems ?? []) lines.push(`  Problem: ${formatScalar(problem)}`);
      for (const fix of check.fixes ?? []) lines.push(`  Fix: ${formatScalar(fix)}`);
    }
  }
  return lines.join('\n');
}

// Record-derived text (names, paths) reaches the terminal here. Messages are
// deliberately multi-line, so keep newlines and tabs and escape every other
// control character that a terminal would interpret.
export function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}`;
}

export function errorResult(command: string, error: unknown): string {
  return jsonResult(command, null, [], [{ code: 'command_failed', severity: 'error', message: error instanceof Error ? error.message : String(error) }], false);
}
