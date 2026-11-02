import { AUTOMATION_DEFAULT_TIMEOUT, AUTOMATION_MAX_TIMER_MS } from './system-config.js';
import type { IssueLog } from './coerce.js';
import { assertArtifactId, parseArtifactHandle } from './artifact-reference.js';

export type AutomationSchedule =
  | { cron: string; timezone?: string }
  | { rrule: string; dtstart: string; timezone?: string }
  | { at: string };
export type ModelDefinition = { model: string } | { command: string; args?: string[] };
export type ResolvedModel = { engine: 'codex' | 'claude'; model: string } | { command: string; args?: string[] };
export interface ExecutionConfig { cwd?: string; models?: Record<string, ModelDefinition> }
export interface AutomationDefinition {
  schedule: AutomationSchedule;
  run: { script: string; args?: string[] } | { model: string; prompt: string };
  enabled?: boolean;
  timeout?: string;
  overlap?: 'latest' | 'skip';
}
// Preserve declarations, including invalid siblings, across ordinary record edits.
// The execution worker validates each declaration independently before arming it.
export type AutomationDeclarations = Record<string, unknown>;

export function automationName(key: string): string {
  try {
    const parts = JSON.parse(key);
    if (Array.isArray(parts) && parts.length === 3 && typeof parts[2] === 'string') return parts[2];
  } catch { /* Retained legacy runs may use opaque keys. */ }
  return key;
}

export function automationDeclarations(value: unknown, log: IssueLog): AutomationDeclarations | undefined {
  if (value === undefined) return undefined;
  try {
    const declarations = mapping(value, 'automations');
    for (const [name, declaration] of Object.entries(declarations)) {
      try { validateDefinition(declaration); }
      catch (error) { log.error('invalid_automation', (error as Error).message, `automations.${name}`); }
    }
    return declarations;
  }
  catch (error) { log.error('invalid_automation', String((error as Error).message), 'automations'); return undefined; }
}

export function mapping(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be a mapping`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${field}.${key}`);
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${field} must be nonblank text`);
}
function args(value: unknown, field: string): void {
  if (value !== undefined && (!Array.isArray(value) || value.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw new Error(`${field} must be a list of strings`);
}
export function modelSelector(value: unknown, field = 'model'): asserts value is string {
  text(value, field);
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(value) || value.startsWith('__') || ['true', 'false', 'null'].includes(value)) {
    throw new Error(`${field} must be a GraphQL enum name other than a reserved value`);
  }
}
export function isBuiltinModelName(value: string): boolean { return /^(CODEX|CLAUDE)_/.test(value); }
export function assertArtifactPrompt(value: unknown, field = 'run.prompt'): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${field} must be a primary artifact handle (#artifact/YYYY-MM-DD-slug)`);
  text(value, field);
  const ref = parseArtifactHandle(value);
  if (!ref || ref.filename !== undefined) throw new Error(`${field} must be a primary artifact handle (#artifact/YYYY-MM-DD-slug)`);
  try { assertArtifactId(ref.id); }
  catch { throw new Error(`${field} must be a primary artifact handle (#artifact/YYYY-MM-DD-slug)`); }
}
function validateModelDefinition(value: unknown, field: string): void {
  const model = mapping(value, field);
  if ((model.model !== undefined) === (model.command !== undefined)) throw new Error(`${field} must specify exactly one of model or command`);
  if (model.model !== undefined) {
    keys(model, ['model'], field);
    modelSelector(model.model, `${field}.model`);
    if (!isBuiltinModelName(model.model)) throw new Error(`${field}.model must reference a built-in model`);
  } else {
    keys(model, ['command', 'args'], field);
    text(model.command, `${field}.command`); args(model.args, `${field}.args`);
  }
}
export function timeoutMs(value = AUTOMATION_DEFAULT_TIMEOUT): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  const ms = match ? (+match[1] || 0) * 86400000 + (+match[2] || 0) * 3600000 + (+match[3] || 0) * 60000 + (+match[4] || 0) * 1000 : 0;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > AUTOMATION_MAX_TIMER_MS || /T$/.test(value)) throw new Error('timeout must be a positive fixed ISO duration up to 2147483647ms');
  return ms;
}
export function validateTimeout(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  text(value, 'timeout');
  timeoutMs(value);
  return value;
}
export function validateRunDefinition(value: unknown): AutomationDefinition['run'] {
  const run = mapping(value, 'run');
  if ((run.script !== undefined) === (run.model !== undefined)) throw new Error('run must specify exactly one of script or model');
  if (run.script !== undefined) {
    keys(run, ['script', 'args'], 'run'); text(run.script, 'run.script'); args(run.args, 'run.args');
  } else {
    keys(run, ['model', 'prompt'], 'run');
    modelSelector(run.model, 'run.model');
    assertArtifactPrompt(run.prompt);
  }
  return structuredClone(value) as AutomationDefinition['run'];
}
export function validateDefinition(value: unknown): AutomationDefinition {
  const def = mapping(value, 'automation');
  keys(def, ['schedule', 'run', 'enabled', 'timeout', 'overlap'], 'automation');
  if (def.enabled !== undefined && typeof def.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  validateTimeout(def.timeout);
  if (def.overlap !== undefined && def.overlap !== 'latest' && def.overlap !== 'skip') throw new Error('overlap must be latest or skip');
  const schedule = mapping(def.schedule, 'schedule');
  if (['cron', 'rrule', 'at'].filter(key => schedule[key] !== undefined).length !== 1) throw new Error('schedule must specify exactly one of cron, rrule, at');
  const kind = schedule.cron !== undefined ? 'cron' : schedule.rrule !== undefined ? 'rrule' : 'at';
  keys(schedule, kind === 'cron' ? ['cron', 'timezone'] : kind === 'rrule' ? ['rrule', 'dtstart', 'timezone'] : ['at'], 'schedule');
  text(schedule[kind], `schedule.${kind}`);
  if (kind === 'rrule') text(schedule.dtstart, 'schedule.dtstart');
  if (schedule.timezone !== undefined) {
    text(schedule.timezone, 'schedule.timezone');
    if (/^[+-]/.test(schedule.timezone)) throw new Error('timezone must be an IANA time zone');
    new Intl.DateTimeFormat('en', { timeZone: schedule.timezone });
  }
  validateRunDefinition(def.run);
  return structuredClone(value) as AutomationDefinition;
}
export function validateExecutionConfig(value: unknown): ExecutionConfig {
  const config = mapping(value, 'execution');
  keys(config, ['cwd', 'models'], 'execution');
  if (config.cwd !== undefined) text(config.cwd, 'execution.cwd');
  if (config.models !== undefined) {
    for (const [name, raw] of Object.entries(mapping(config.models, 'execution.models'))) {
      modelSelector(name, 'execution.models name');
      if (isBuiltinModelName(name)) throw new Error(`execution.models.${name} uses a reserved built-in name`);
      validateModelDefinition(raw, `execution.models.${name}`);
    }
  }
  return config as ExecutionConfig;
}
