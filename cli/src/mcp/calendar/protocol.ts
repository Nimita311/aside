// Wire protocol between the MCP (Node) and the aside-cal Swift helper. One JSON
// object per line each way; every request is answered by exactly one response
// carrying the same `id`. See cli/calendar-impl.md.

// Machine-readable failure classes the helper attaches to error responses
// (`{ id, ok: false, error, code? }`), so the MCP classifies failures without
// parsing the English message; `error` stays for display. Uncoded failures are
// transient.
export type CalErrorCode = 'calendar-not-found' | 'calendar-ambiguous' | 'calendar-read-only' | 'invalid-scheduling' | 'authorization-request-failed' | 'event-recurring' | 'event-time-unrepresentable';

// TCC access level, mirrored from EKAuthorizationStatus.
export type CalAuthStatus =
  | 'notDetermined'
  | 'restricted'
  | 'denied'
  | 'writeOnly'
  | 'fullAccess'
  | 'unknown';

export interface CalCalendar {
  id: string;
  name: string;
  account: string;
  writable: boolean;
  type: string;
  color?: string;
}

// A request line: a correlation id, the command, and any command arguments.
export interface CalRequest {
  id: string;
  cmd: string;
  [arg: string]: unknown;
}

// Result payloads, keyed by command.
export interface AuthStatusResult {
  status: CalAuthStatus;
}

export interface RequestAccessResult {
  granted: boolean;
  status: CalAuthStatus;
}

export interface ListCalendarsResult {
  calendars: CalCalendar[];
}

// An Aside-marked event: wall-clock strings in its explicit named zone (null
// means floating), plus actual epoch milliseconds. `url` is the marker. `recurring`
// marks an event in a recurring series. Ordinary action sync refuses these;
// template series use the separate recurrence adapter and native commands.
export interface CalEvent {
  id: string;
  url: string;
  calendar: string;
  calendar_account?: string; // readable account name
  title: string;
  start: string;
  end: string;
  timezone: string | null;
  startInstant: number;
  endInstant: number;
  durationMinutes?: number; // actual elapsed minutes for timed events
  allDay?: boolean;
  recurring?: boolean;
  detached?: boolean;
  original?: string;
  originalInstant?: number;
  originalLocal?: string;
  seriesRule?: NativeRecurrenceRule;
  externalId?: string; // provider family lookup hint, never an occurrence identity
  seriesHead?: boolean; // first occurrence of a stored, non-detached series item
}

export interface UpsertEventArgs {
  calendar: string; // readable calendar name
  calendar_account?: string; // optional readable account qualifier
  marker: string; // aside:// marker URL → the event's url field
  title: string;
  start: string; // wall-clock YYYY-MM-DDTHH:MM
  end: string; // nominal wall end for helpers without elapsed-duration support
  durationMinutes?: number; // positive whole elapsed minutes; timed events only
  timezone?: string; // IANA; omitted = floating
  notes?: string;
  allDay?: boolean;
  eventId?: string; // update this event when known; otherwise create
  allowTimeReplacement?: boolean; // explicit unambiguous start edit resolves a timing block
}

export interface UpsertEventResult {
  eventId: string;
  externalId?: string;
}

export interface DeleteEventArgs {
  eventId: string;
  marker: string; // identity check: only delete if the event still carries it
}

export interface DeleteEventResult {
  deleted: boolean;
}

export interface ListEventsArgs {
  start: string;
  end: string;
  calendars?: string[]; // restrict to these calendar names; omitted = all
}

export interface ListEventsResult {
  events: CalEvent[];
}

export interface GetEventsArgs {
  eventIds: string[];
}

// Only events that still exist and are still Aside-marked; a requested id absent
// from the result was deleted or unmarked.
export interface GetEventsResult {
  events: CalEvent[];
}

export interface NativeRecurrenceRule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval: number;
  days?: { day: number; week: number }[]; monthDays?: number[]; months?: number[];
  weeks?: number[]; yearDays?: number[]; positions?: number[]; count?: number; until?: number;
}
export interface UpsertSeriesArgs extends UpsertEventArgs { seriesRule: NativeRecurrenceRule }
export interface UpsertOccurrenceArgs extends UpsertEventArgs { original: string; originalTimezone?: string; originalAllDay?: boolean; anchor: string; remove?: boolean }

// Fetch the stored family and its detached items by native identifiers, plus
// exact occurrence witnesses. Identifiers are hints; every returned item is
// checked against marker ownership and its original occurrence date.
export interface GetSeriesArgs {
  marker: string; start: string; timezone?: string; allDay?: boolean;
  eventId?: string; externalId?: string;
  occurrences: { original: string; timezone?: string; eventId?: string; start?: string }[];
}
