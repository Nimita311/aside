import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { daemonPaths } from '../daemon/paths.js';
import { assertRecurrence, type RecurrenceSchedule } from '../core/recurrence.js';
import { writeFileCrashSafe } from './tools/index-file.js';

// Accepted schedules are daemon metadata, independent of instance records and
// .aside launch configuration. Checkouts with the same instance ID keep separate
// baselines; a symlink to a checkout shares its baseline.
export function recurrenceHistoryPath(dataDir: string, instanceId: string): string {
  let root: string;
  try { root = realpathSync(dataDir); } catch { root = resolve(dataDir); }
  const key = createHash('sha256').update(root + '\0' + instanceId).digest('hex');
  return join(daemonPaths().state, 'recurrence-history', key + '.json');
}

export function readRecurrenceHistory(file: string): Map<string, RecurrenceSchedule[]> {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); throw error; }
  const value = JSON.parse(text);
  if (!value || value.version !== 1 || !Array.isArray(value.schedules)) throw new Error('Invalid recurrence history state.');
  const schedules = new Map<string, RecurrenceSchedule[]>();
  for (const entry of value.schedules) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || schedules.has(entry[0])) throw new Error('Invalid recurrence history state.');
    schedules.set(entry[0], assertRecurrence(entry[1]));
  }
  return schedules;
}

export function writeRecurrenceHistory(file: string, schedules: Map<string, RecurrenceSchedule[]>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileCrashSafe(file, JSON.stringify({ version: 1, schedules: [...schedules] }) + '\n');
}
