import { scheduleInstant, wallTimeAt } from '../src/core/scheduling.js';
import type { CalEvent, UpsertEventArgs } from '../src/mcp/calendar/protocol.js';

// A saved fake event reflects the helper's effective clock, rather than echoing
// an authored floating gap that Foundation normalizes during save.
export function savedEvent(args: UpsertEventArgs, id = 'event'): CalEvent {
  const zone = args.timezone, startInstant = scheduleInstant(args.start, zone)!;
  const endInstant = args.allDay ? startInstant : startInstant + args.durationMinutes! * 60000;
  return { id, url: args.marker, title: args.title, calendar: args.calendar, calendar_account: args.calendar_account,
    start: wallTimeAt(startInstant, zone), end: wallTimeAt(endInstant, zone), timezone: zone ?? null, allDay: args.allDay,
    startInstant, endInstant, durationMinutes: args.durationMinutes };
}

// Fake helpers report the same timing metadata as EventKit. Tests may override
// an instant to model a repeated-hour occurrence or malformed helper response.
export function eventTimes<T extends { start: string; end: string; allDay?: boolean; durationMinutes?: number; timezone?: string | null; startInstant?: number; endInstant?: number }>(event: T, zone: string | null = null): T & { timezone: string | null; startInstant: number; endInstant: number } {
  const timezone = event.timezone === undefined ? zone : event.timezone;
  const startInstant = event.startInstant ?? scheduleInstant(event.start, event.allDay ? undefined : timezone ?? undefined) ?? NaN;
  const endInstant = event.endInstant ?? (event.durationMinutes === undefined
    ? scheduleInstant(event.end, event.allDay ? undefined : timezone ?? undefined) ?? NaN
    : startInstant + event.durationMinutes * 60000);
  return { ...event, timezone, startInstant, endInstant };
}
