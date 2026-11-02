import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { daemonPaths } from '../../daemon/paths.js';
import { writeFileCrashSafe } from '../tools/index-file.js';
import type { OccurrenceIdentity } from '../../core/recurrence.js';
import { assertOccurrence, assertRecurrence } from '../../core/recurrence.js';
import type { CalEvent } from './protocol.js';
import type { NativeSeries } from './recurrence-rule.js';
import { isCalendarDate, isWallMinute } from '../../core/scheduling.js';

export interface FamilyMirror {
  template: string; family: NativeSeries; definition?: string;
  eventId?: string; externalId?: string;
  observed: { event: CalEvent; identity: OccurrenceIdentity; source?: string }[];
}

// Integration state is kept with the daemon, outside Aside records. Keeping
// superseded anchors and native lookup hints lets a restart finish replacement
// without leaving the old series active or interpreting our own removals as edits.
export class RecurrenceMirror {
  readonly families = new Map<string, FamilyMirror>();
  readonly pendingOrdinary = new Set<string>();
  readonly pendingNative = new Set<string>();
  readonly ordinaryEvents = new Map<string, string>();
  readonly ordinaryStarts = new Map<string, string>();
  private path: string;
  constructor(dataDir: string, instance: string) {
    const directory = join(daemonPaths().state, 'calendar');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, createHash('sha256').update(JSON.stringify([realpathSync(dataDir), instance])).digest('hex') + '.json');
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Calendar recurrence mirror is unreadable; preserve Calendar events until it is repaired.', { cause: error }); }
    if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 || !('families' in raw) || !Array.isArray(raw.families)) throw new Error('Calendar recurrence mirror is malformed; preserve Calendar events until it is repaired.');
    if ('pendingOrdinary' in raw) {
      if (!Array.isArray(raw.pendingOrdinary) || raw.pendingOrdinary.some(id => typeof id !== 'string' || !id)) throw new Error('Calendar recurrence mirror is malformed; preserve Calendar events until it is repaired.');
      for (const id of raw.pendingOrdinary) this.pendingOrdinary.add(id);
    }
    if ('pendingNative' in raw) {
      if (!Array.isArray(raw.pendingNative) || raw.pendingNative.some(id => typeof id !== 'string' || !id)) throw new Error('Calendar recurrence mirror is malformed; preserve Calendar events until it is repaired.');
      for (const id of raw.pendingNative) this.pendingNative.add(id);
    }
    if ('ordinaryEvents' in raw) {
      if (!Array.isArray(raw.ordinaryEvents) || raw.ordinaryEvents.some(item => !Array.isArray(item) || item.length !== 2 || item.some(value => typeof value !== 'string' || !value))) throw new Error('Calendar recurrence mirror is malformed; preserve Calendar events until it is repaired.');
      for (const [id, eventId] of raw.ordinaryEvents) this.ordinaryEvents.set(id, eventId);
    }
    if ('ordinaryStarts' in raw) {
      if (!Array.isArray(raw.ordinaryStarts) || raw.ordinaryStarts.some(item => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !item[0] || typeof item[1] !== 'string' || !isCalendarDate(item[1]) && !isWallMinute(item[1]))) throw new Error('Calendar recurrence mirror is malformed; preserve Calendar events until it is repaired.');
      for (const [id, start] of raw.ordinaryStarts) this.ordinaryStarts.set(id, start);
    }
    for (const item of raw.families) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1]?.template !== 'string' || !item[1]?.family?.schedule || !item[1].family.rule || !Array.isArray(item[1].observed)) throw new Error('Calendar recurrence mirror is malformed.');
      try { assertRecurrence([item[1].family.schedule]); for (const witness of item[1].observed) { assertOccurrence(witness.identity); if (!witness.event || typeof witness.event.id !== 'string') throw new Error('Invalid witness.'); } }
      catch (error) { throw new Error('Calendar recurrence mirror is malformed; preserve Calendar events until it is repaired.', { cause: error }); }
      this.families.set(item[0], item[1]);
    }
  }
  save(): void { writeFileCrashSafe(this.path, JSON.stringify({ version: 1, families: [...this.families], pendingOrdinary: [...this.pendingOrdinary], pendingNative: [...this.pendingNative], ordinaryEvents: [...this.ordinaryEvents], ordinaryStarts: [...this.ordinaryStarts] })); }
}
