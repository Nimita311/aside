import { isSchedulingDate, parseDurationMinutes, DEFAULT_DURATION_MIN } from '../../core/scheduling.js';
import { formatUtcTimestamp } from '../../core/date.js';

// Marker URLs are the sole action↔event link (event `url` field) and the
// lifecycle signal in both directions. Pure helpers here; forward/reverse logic
// builds on them. See design/calendar.md (Linking).
import { isInstanceId, INSTANCE_ID_RULE } from '../../core/identity.js';

// The lifecycle a marker encodes. `active` (scheduled, unresolved) is the bare
// marker; the rest carry a suffix.
export type MarkerState = 'active' | 'done' | 'cancelled' | 'backlog';

export function buildMarker(instance: string, actionId: string, state: MarkerState): string {
  if (!isInstanceId(instance)) throw new Error(INSTANCE_ID_RULE);
  const base = `aside://${instance}/action/${encodeURIComponent(actionId)}`;
  return state === 'active' ? base : `${base}/${state}`;
}

export interface ParsedMarker {
  instance: string;
  actionId: string;
  state: MarkerState;
}

// A user may hand-edit a suffix with a common spelling; normalize to canonical.
const SUFFIX_ALIASES: Record<string, MarkerState> = {
  done: 'done',
  complete: 'done',
  completed: 'done',
  cancel: 'cancelled',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  backlog: 'backlog',
  deschedule: 'backlog',
  descheduled: 'backlog',
};

// Parse an `aside://<instance>/action/<id>[/<suffix>]` marker, percent-decoding
// the action id. Returns null
// for non-aside URLs, malformed encoding, or an unrecognized suffix. Suffix
// matching is case-insensitive.
export function parseMarker(url: string): ParsedMarker | null {
  const m = url.match(/^aside:\/\/([^/]+)\/action\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!m) return null;
  const [, encInstance, encActionId, rawSuffix] = m;
  let instance: string;
  let actionId: string;
  try {
    instance = encInstance;
    if (!isInstanceId(instance)) return null;
    actionId = decodeURIComponent(encActionId);
  } catch {
    return null; // malformed percent-encoding
  }
  let state: MarkerState = 'active';
  if (rawSuffix) {
    const norm = SUFFIX_ALIASES[rawSuffix.toLowerCase()];
    if (!norm) return null;
    state = norm;
  }
  return { instance, actionId, state };
}

// The default applies only to an omitted duration. Invalid values never fall
// back to a different event length.
export function durationMinutes(iso?: string): number {
  if (iso === undefined) return DEFAULT_DURATION_MIN;
  const minutes = parseDurationMinutes(iso);
  if (minutes === undefined) throw new Error(`duration: invalid or unsupported ISO duration "${iso}"`);
  return minutes;
}

// Add minutes to a floating wall-clock string, returning the same format. Done
// as UTC calendar math so it rolls over hours/days/months without DST effects —
// the zone is reapplied downstream by the helper.
export function addMinutesWall(wall: string, minutes: number): string {
  const m = wall.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m || !isSchedulingDate(wall)) throw new Error(`scheduled: invalid wall time "${wall}"`);
  const dt = new Date(wall + ':00Z');
  dt.setUTCMinutes(dt.getUTCMinutes() + minutes);
  return formatUtcTimestamp(dt);
}

// Minutes → ISO 8601 duration, e.g. 45 → PT45M, 90 → PT1H30M, 120 → PT2H.
export function durationIso(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return 'PT' + (h ? `${h}H` : '') + (m || !h ? `${m}M` : '');
}

// Minute-normalize a scheduled value for comparison: keep the date for a
// date-only value, else trim to YYYY-MM-DDTHH:MM. Lets the reverse diff compare
// an action's `scheduled` against an event's start without spurious differences.
export function normalizeScheduled(scheduled: string): string {
  return scheduled.includes('T') ? scheduled.slice(0, 16) : scheduled.slice(0, 10);
}

// Normalize a scheduled value to a minute-precision wall-clock start. Returns
// the all-day flag too: a date-only `scheduled` (no time) becomes an all-day
// event anchored at midnight.
export function startFromScheduled(scheduled: string): { start: string; allDay: boolean } {
  if (!isSchedulingDate(scheduled)) throw new Error(`scheduled: invalid date or wall time "${scheduled}"`);
  if (scheduled.includes('T')) {
    const m = scheduled.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
    return { start: m ? m[1] : scheduled, allDay: false };
  }
  return { start: `${scheduled}T00:00`, allDay: true };
}
