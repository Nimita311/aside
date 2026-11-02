import { isMap, isNode, stringify } from 'yaml';
import { assertAutomationDeclarations } from '../../automation/declaration.js';
import type { AutomationDeclarations } from '../../core/automation.js';
import { assertArtifactPrompt, mapping, modelSelector, timeoutMs } from '../../core/automation.js';
import { compileSchedule } from '../../automation/schedule.js';
import { Temporal } from '@js-temporal/polyfill';
import { mergeMetadata, parseMetadata } from './front-matter.js';

// GraphQL authoring lists are converted to this named map before validation.
// Only edited jobs are declarations to author; untouched jobs remain repairable.
export interface AutomationPatch {
  schedule?: Record<string, unknown>;
  run?: Record<string, unknown>;
  enabled?: boolean | null;
  timeout?: string | null;
  overlap?: 'latest' | 'skip' | null;
}
export interface AutomationEdits {
  upsert?: AutomationDeclarations | null;
  patch?: Record<string, AutomationPatch> | null;
  remove?: string[] | null;
}

function assertPatch(value: unknown): AutomationPatch {
  const patch = mapping(value, 'automation patch');
  for (const [key, child] of Object.entries(patch)) {
    if (child === undefined) continue;
    if (!['schedule', 'run', 'enabled', 'timeout', 'overlap'].includes(key)) throw new Error(`Unknown automation patch.${key}`);
    if (key === 'schedule' || key === 'run') {
      const nested = mapping(child, `automation patch.${key}`);
      const allowed = key === 'schedule' ? ['cron', 'rrule', 'dtstart', 'timezone', 'at'] : ['script', 'args', 'model', 'prompt'];
      for (const [field, entry] of Object.entries(nested)) {
        if (!allowed.includes(field)) throw new Error(`Unknown automation patch.${key}.${field}`);
        if (entry == null) continue;
        if (field === 'args') {
          if (!Array.isArray(entry) || entry.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('automation patch.run.args must be a list of strings');
        } else if (field === 'prompt') {
          assertArtifactPrompt(entry, 'automation patch.run.prompt');
        } else if (typeof entry !== 'string' || !entry.trim() || entry.includes('\0')) throw new Error(`automation patch.${key}.${field} must be nonblank text`);
        if (field === 'model') modelSelector(entry, 'automation patch.run.model');
        if (field === 'timezone') {
          if (String(entry).startsWith('+') || String(entry).startsWith('-')) throw new Error('timezone must be an IANA time zone');
          new Intl.DateTimeFormat('en', {timeZone: entry as string});
        }
        // Validate independently meaningful authored values before any root
        // mutation executes; remaining constraints require the saved job.
        if (field === 'cron') compileSchedule({cron: entry as string});
        if (field === 'at') compileSchedule({at: entry as string});
        if (field === 'rrule') compileSchedule({rrule: entry as string, dtstart: '2000-01-01T00:00', timezone: 'UTC'});
        if (field === 'dtstart') {
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(entry as string) || Temporal.PlainDateTime.from(entry as string).year < 1) throw new Error('dtstart must be a real wall time YYYY-MM-DDTHH:mm[:ss]');
        }
      }
    } else if (child != null) {
      if (key === 'enabled' && typeof child !== 'boolean') throw new Error('automation patch.enabled must be a boolean');
      if (key === 'timeout') {
        if (typeof child !== 'string') throw new Error('automation patch.timeout must be text');
        timeoutMs(child);
      }
      if (key === 'overlap' && child !== 'latest' && child !== 'skip') throw new Error('automation patch.overlap must be latest or skip');
    }
  }
  return structuredClone(patch) as AutomationPatch;
}

export function assertAutomationEdits(value: unknown): AutomationEdits {
  const input = mapping(value, 'automationEdits');
  for (const key of Object.keys(input)) if (!['upsert', 'patch', 'remove'].includes(key)) throw new Error(`Unknown automationEdits.${key}`);
  const upsert = input.upsert == null ? input.upsert as null | undefined : assertAutomationDeclarations(input.upsert);
  const patch: Record<string, AutomationPatch> = Object.create(null);
  if (input.patch != null) for (const [name, value] of Object.entries(mapping(input.patch, 'automationEdits.patch'))) {
    if (!name.trim() || name.includes('\0')) throw new Error('Automation names must be nonblank text');
    try { patch[name] = assertPatch(value); }
    catch (error) { throw new Error(`automationEdits.patch.${name}: ${(error as Error).message}`); }
  }
  const remove = input.remove;
  if (remove != null && (!Array.isArray(remove) || remove.some(name => typeof name !== 'string' || !name.trim() || name.includes('\0')))) {
    throw new Error('automationEdits.remove must be a list of nonblank automation names.');
  }
  const names = (remove ?? []) as string[];
  if (new Set(names).size !== names.length) throw new Error('automationEdits.remove must not repeat an automation name.');
  const seen = new Set<string>();
  for (const [operation, operationNames] of [['upsert', Object.keys(upsert ?? {})], ['patch', Object.keys(patch)], ['remove', names]] as const) {
    for (const name of operationNames) {
      if (seen.has(name)) throw new Error(`automationEdits cannot ${operation} automation "${name}" in more than one operation.`);
      seen.add(name);
    }
  }
  return {upsert, patch: input.patch == null ? input.patch as null | undefined : patch, remove: remove == null ? remove as null | undefined : [...names]};
}

export function hasAutomationEdits(edits: AutomationEdits | null | undefined): boolean {
  return !!edits && (!!Object.keys(edits.upsert ?? {}).length || !!Object.keys(edits.patch ?? {}).length || !!edits.remove?.length);
}

// Patch selected YAML nodes instead of round-tripping the whole declaration map.
// This keeps invalid siblings, comments, tags and exact scalar precision intact.
export function applyAutomationEditsToMetadata(source: string, edits: AutomationEdits, context: string): string {
  const normalized = assertAutomationEdits(edits);
  if (!hasAutomationEdits(normalized)) return source;
  const document = parseMetadata(source, context);
  const pairs = isMap(document.contents) ? document.contents.items.filter(pair =>
    (isNode(pair.key) ? pair.key.toJS(document, {mapAsMap: true}) : pair.key) === 'automations') : [];
  if (pairs.length > 1) throw new Error(`Cannot update ${context}: existing metadata repeats automations after resolving YAML aliases. Repair it before retrying.`);
  const current = pairs[0]?.value;
  if (pairs.length && !isMap(current)) throw new Error(`Cannot update ${context}: existing automations must be a YAML mapping. Repair it before editing individual jobs.`);
  const currentNames = new Set<string>();
  if (isMap(current)) {
    for (const pair of current.items) {
      const name = isNode(pair.key) ? pair.key.toJS(document, {mapAsMap: true}) : pair.key;
      if (typeof name !== 'string') throw new Error(`Cannot update ${context}: existing automation names must be text. Repair them before editing individual jobs.`);
      if (currentNames.has(name)) throw new Error(`Cannot update ${context}: existing automations repeats "${name}" after resolving YAML aliases. Repair it before retrying.`);
      currentNames.add(name);
    }
  }
  const upsert = normalized.upsert ?? {};
  const patch = normalized.patch ?? {};
  const remove = normalized.remove ?? [];
  const remainingNames = new Set([...currentNames].filter(name => !remove.includes(name)));
  for (const name of Object.keys(upsert)) remainingNames.add(name);
  const desired: Record<string, unknown> = Object.assign(Object.create(null), upsert);
  const fields: string[][] = [...Object.keys(upsert), ...remove.filter(name => currentNames.has(name))].map(name => ['automations', name]);
  for (const [name, changes] of Object.entries(patch)) {
    if (!currentNames.has(name)) throw new Error(`Cannot update ${context}: automation "${name}" does not exist. Use upsert to create it.`);
    const pair = isMap(current) ? current.items.find(pair => (isNode(pair.key) ? pair.key.toJS(document, {mapAsMap: true}) : pair.key) === name)! : undefined;
    if (!isMap(pair?.value)) throw new Error(`Cannot update ${context}: automation "${name}" must be a YAML mapping. Use upsert to replace it.`);
    const job = mapping(pair.value.toJS(document), `automation ${name}`);
    const merged = structuredClone(job);
    for (const [key, child] of Object.entries(changes)) {
      if (child === undefined) continue;
      if (key === 'schedule' || key === 'run') {
        const nested = {...(merged[key] === undefined ? {} : mapping(merged[key], `automation ${name}.${key}`))};
        for (const [field, value] of Object.entries(child as Record<string, unknown>)) {
          if (value === undefined) continue;
          if (value == null) delete nested[field]; else nested[field] = value;
          fields.push(['automations', name, key, field]);
        }
        merged[key] = nested;
      } else {
        if (child == null) delete merged[key]; else merged[key] = child;
        fields.push(['automations', name, key]);
      }
    }
    assertAutomationDeclarations({[name]: merged});
    desired[name] = merged;
  }
  if (!remainingNames.size && currentNames.size) return mergeMetadata(source, '{}', ['automations'], context);
  return mergeMetadata(source, stringify({automations: desired}), fields, context);
}
