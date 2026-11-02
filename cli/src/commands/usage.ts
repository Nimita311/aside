import { constants, realpathSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { isAsideDir, InstancePathError } from '../core/instance.js';
import { usageDirectory, usageBaseDirectory, legacyUsageDirectory, type UsageEvent, type EffectCounts } from '../graphql/usage.js';
import { daemonPaths } from '../daemon/paths.js';
import { parseCommand, type CommandInput } from './options.js';
import { publishReport } from './output.js';

const FILE = /^\d{4}-\d{2}-\d{2}-\d{3,}\.jsonl$/;
function percentile(values: number[], fraction: number): number | null {
  return values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
}
function isEvent(event: any): event is UsageEvent {
  return event?.schemaVersion === 1 && typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp))
    && typeof event.requestId === 'string' && ['query', 'mutation'].includes(event.operation)
    && ['success', 'partial', 'failure', 'cancelled'].includes(event.outcome)
    && Number.isFinite(event.durationMs) && event.durationMs >= 0 && Array.isArray(event.fields)
    && event.fields.every((field: unknown) => typeof field === 'string')
    && (event.shapeHash === null || typeof event.shapeHash === 'string') && (event.shape === null || typeof event.shape === 'string')
    && ['created', 'updated', 'removed'].every(key => Number.isSafeInteger(event.effects?.[key]) && event.effects[key] >= 0);
}

/** Offline inspection: never start a daemon, load records, or log this command. */
export async function summarizeUsage(root: string, since: Date, now = new Date(), logs = daemonPaths().logs) {
  const directory = usageDirectory(root, logs);
  const files: string[] = [];
  const directories: string[] = [];
  // Preserve visibility of logs written by the earlier instance-local version.
  // Inspection neither migrates nor modifies these files.
  for (const [parent, collection] of [[usageBaseDirectory(logs), directory], [join(root, '.aside-logs'), legacyUsageDirectory(root)]]) {
    try {
      for (const path of [parent, collection]) if (!(await lstat(path)).isDirectory()) throw new Error('Invalid usage directory');
      files.push(...(await readdir(collection)).filter(name => FILE.test(name)).sort().map(name => join(collection, name)));
      directories.push(collection);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const operations = {query: 0, mutation: 0};
  const outcomes = {success: 0, partial: 0, failure: 0, cancelled: 0};
  const effects: EffectCounts = {created: 0, updated: 0, removed: 0};
  const fields = new Map<string, number>();
  const shapes = new Map<string, {hash: string; shape: string; count: number}>();
  const durations: number[] = [];
  let malformedLines = 0, introspection = 0;
  for (const path of files) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; // Retention can prune during inspection.
      throw error;
    });
    if (!file) continue;
    try {
      if (!(await file.stat()).isFile()) throw new Error('Invalid usage file');
      const lines = createInterface({input: file.createReadStream({autoClose: false}), crlfDelay: Infinity});
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          let event: unknown;
          try { event = JSON.parse(line); } catch { malformedLines++; continue; }
          if (!isEvent(event)) { malformedLines++; continue; }
          const time = Date.parse(event.timestamp);
          if (time < since.getTime() || time > now.getTime()) continue;
          operations[event.operation]++; outcomes[event.outcome]++; durations.push(event.durationMs);
          for (const key of ['created', 'updated', 'removed'] as const) effects[key] += event.effects[key];
          for (const field of new Set(event.fields)) fields.set(field, (fields.get(field) ?? 0) + 1);
          if (event.fields.some(field => field === '__schema' || field === '__type')) introspection++;
          if (event.shapeHash && event.shape) {
            const shape = shapes.get(event.shapeHash) ?? {hash: event.shapeHash, shape: event.shape, count: 0};
            shape.count++; shapes.set(event.shapeHash, shape);
          }
        }
      } finally { lines.close(); }
    } finally { await file.close(); }
  }
  durations.sort((a, b) => a - b);
  return {directory, directories, since: since.toISOString(), until: now.toISOString(), total: durations.length, operations, outcomes,
    introspection, effects, latencyMs: {p50: percentile(durations, 0.5), p95: percentile(durations, 0.95)}, malformedLines,
    fields: [...fields].map(([field, count]) => ({field, count})).sort((a, b) => b.count - a.count || a.field.localeCompare(b.field)),
    shapes: [...shapes.values()].sort((a, b) => b.count - a.count || a.hash.localeCompare(b.hash))};
}

export async function runUsage(input: CommandInput, cwd = process.cwd(), out: (text: string) => void = console.log): Promise<void> {
  const options = parseCommand('usage', input);
  const path = resolve(cwd, options.get('--dir') ?? '.');
  if (!isAsideDir(path)) throw new InstancePathError(`Not an aside directory (no aside.md manifest): ${path}`);
  const root = realpathSync(path);
  const now = new Date();
  const days = Number((options.get('--since') ?? '7d').slice(0, -1));
  const result = await summarizeUsage(root, new Date(now.getTime() - days * 86_400_000), now);
  publishReport({title: 'GraphQL usage', data: result, checks: [], sections: [
    {name: 'Requests', fields: {Instance: root, Logs: result.directory, Since: result.since, Total: result.total,
      Reads: result.operations.query, Mutations: result.operations.mutation, Introspection: result.introspection,
      Outcomes: result.outcomes, 'p50 daemon execution (ms)': result.latencyMs.p50, 'p95 daemon execution (ms)': result.latencyMs.p95,
      'Confirmed writes': result.effects, 'Malformed lines skipped': result.malformedLines}},
    {name: 'Common operations', entries: result.shapes.slice(0, 10).map(shape => ({name: shape.shape, fields: {Requests: shape.count}}))},
    {name: 'Common fields', entries: result.fields.slice(0, 20).map(field => ({name: field.field, fields: {Requests: field.count}}))},
  ]}, 'usage summary', options.has('--json'), out);
}
