import { parseDocument } from 'yaml';
import type { ParseIssue, IssueSeverity } from './types.js';

// Collects issues during a single parse. Field access in parsers goes through
// the coercion helpers below, all of which take an IssueLog — so there is no
// way to read a field without also having a place to record what went wrong.
export class IssueLog {
  readonly issues: ParseIssue[] = [];

  private add(severity: IssueSeverity, code: string, message: string, field?: string): void {
    this.issues.push(field ? { severity, code, message, field } : { severity, code, message });
  }

  error(code: string, message: string, field?: string): void {
    this.add('error', code, message, field);
  }

  warn(code: string, message: string, field?: string): void {
    this.add('warning', code, message, field);
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value;
}

// Parse YAML without ever throwing. Syntax errors become issues and we still
// return the document's best-effort JS value (`parseDocument` recovers partial
// structure where `parse` would throw).
export function safeParseYaml(text: string, log: IssueLog): unknown {
  if (!text.trim()) return undefined;
  const doc = parseDocument(text);
  for (const err of doc.errors) {
    log.error('invalid_yaml', err.message.split('\n')[0]);
  }
  try {
    return doc.toJS();
  } catch {
    return undefined;
  }
}

// A YAML document's top level should be a mapping. Anything else (list, scalar)
// is unusable as front matter, so we record it and fall back to an empty record.
export function asRecord(value: unknown, log: IssueLog): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (value != null) {
    log.warn('not_a_mapping', `Expected a mapping but found ${describe(value)}`);
  }
  return {};
}

function toScalarString(value: unknown, field: string, log: IssueLog): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // A list or mapping where a scalar was expected (e.g. malformed YAML that
  // nested a block under a scalar key). Record it and recover with '' rather
  // than a useless `String(value)` like "[object Object]" — callers treat ''
  // as missing (required → error) or absent (optional → undefined).
  log.warn('wrong_type', `Field "${field}" should be text but found ${describe(value)}`, field);
  return '';
}

// Required scalar field. Missing or empty is an error; the caller still gets a
// string ('') so it can keep building a value.
export function reqString(value: unknown, field: string, log: IssueLog): string {
  const s = value == null ? '' : toScalarString(value, field, log);
  if (s === '') log.error('missing_field', `Missing required field "${field}"`, field);
  return s;
}

// Optional scalar field. Absent or empty → undefined with no issue (the spec
// treats an empty field as absent), mirroring reqString's empty handling.
export function optString(value: unknown, field: string, log: IssueLog): string | undefined {
  if (value == null) return undefined;
  const s = toScalarString(value, field, log);
  return s === '' ? undefined : s;
}

// Optional boolean field. Absent → undefined; a real boolean passes through; a
// non-boolean is recorded and treated as absent so the caller falls back to the
// field's default rather than coercing a surprising truthiness.
export function optBool(value: unknown, field: string, log: IssueLog): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  log.warn('wrong_type', `Field "${field}" should be true or false but found ${describe(value)}`, field);
  return undefined;
}

// Required numeric field. Accepts an actual number or a string that spells one
// (`/^-?\d+(\.\d+)?$/` — quoted YAML like "18"); anything else is recorded and
// falls back, never coerced through Number()'s quiet conversions (''→0, []→0,
// true→1). Missing or empty is an error, mirroring reqString.
export function reqNumber(value: unknown, field: string, log: IssueLog, fallback = 0): number {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    log.error('missing_field', `Missing required field "${field}"`, field);
    return fallback;
  }
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  log.warn('wrong_type', `Field "${field}" should be a number but found ${describe(value)}`, field);
  return fallback;
}

// Tolerant list of strings. Accepts the canonical inline list, treats a bare
// scalar as a single item (recording it), drops null/empty items, and returns
// [] for an absent field.
export function asStringList(value: unknown, field: string, log: IssueLog): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    log.warn('wrong_type', `Field "${field}" should be a list; treating the scalar as one item`, field);
    return [toScalarString(value, field, log)];
  }
  const out: string[] = [];
  for (const item of value) {
    if (item == null) {
      log.warn('dropped_item', `Dropped an empty item in "${field}"`, field);
      continue;
    }
    out.push(toScalarString(item, field, log));
  }
  return out;
}

// Tolerant list of mappings. Drops non-object items (recording each) and
// returns [] for an absent field.
export function asObjectList(value: unknown, field: string, log: IssueLog): Record<string, unknown>[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    log.warn('wrong_type', `Field "${field}" should be a list`, field);
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>);
    } else {
      log.warn('dropped_item', `Dropped a malformed item in "${field}"`, field);
    }
  }
  return out;
}
