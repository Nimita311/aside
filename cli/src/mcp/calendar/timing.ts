import { isSchedulingDate, scheduleInstant, schedulingIssues, wallTimeAt } from '../../core/scheduling.js';
import type { CalEvent } from './protocol.js';
import type { CalendarDiagnostic } from './diagnostics.js';

// The wall-time record can encode the first occurrence and a whole-minute
// elapsed length. Never round a calendar gesture into a different event.
export function eventTimingDiagnostic(event: CalEvent): CalendarDiagnostic | undefined {
  let reason: string | undefined;
  if (event.timezone !== null && (typeof event.timezone !== 'string' || !event.timezone)) {
    reason = 'timezone: calendar helper must report a named zone or explicit floating null.';
  } else if (typeof event.start !== 'string' || typeof event.end !== 'string' || !event.start.includes('T') || !event.end.includes('T') || !isSchedulingDate(event.start) || !isSchedulingDate(event.end)) {
    reason = 'scheduled: calendar event has an unsupported wall-clock start or end.';
  } else if (schedulingIssues({ scheduled: event.start, timezone: event.allDay ? undefined : event.timezone ?? undefined }).length) {
    reason = schedulingIssues({ scheduled: event.start, timezone: event.allDay ? undefined : event.timezone ?? undefined }).join(' ');
  } else if (!event.allDay && event.durationMinutes !== undefined && (!Number.isSafeInteger(event.durationMinutes) || event.durationMinutes <= 0)) {
    reason = 'duration: calendar event length must be positive whole elapsed minutes.';
  } else if (!Number.isSafeInteger(event.startInstant) || !Number.isSafeInteger(event.endInstant) || !Number.isFinite(new Date(event.startInstant).getTime()) || !Number.isFinite(new Date(event.endInstant).getTime())) {
    reason = 'Calendar helper did not report finite, precise start/end instants.';
  } else if (event.allDay !== undefined && typeof event.allDay !== 'boolean') {
    reason = 'Calendar helper reported an invalid all-day flag.';
  } else if (event.allDay) {
    if (event.endInstant < event.startInstant) reason = 'Calendar all-day event ends before it starts.';
  } else {
    const zone = event.timezone ?? undefined;
    const invalid = schedulingIssues({ scheduled: event.start, timezone: zone });
    const elapsed = (event.endInstant - event.startInstant) / 60000;
    if (invalid.length) reason = invalid.join(' ');
    else if (wallTimeAt(event.startInstant, zone) !== event.start) {
      reason = 'Calendar start wall time disagrees with its actual instant and timezone.';
    } else if (scheduleInstant(event.start, zone) !== event.startInstant) {
      reason = `scheduled: calendar start ${event.start} (${zone ?? 'floating'}) cannot be represented faithfully: it is a later occurrence of a repeated hour or has sub-minute precision.`;
    } else if (!Number.isSafeInteger(elapsed) || elapsed <= 0 || event.durationMinutes !== undefined && event.durationMinutes !== elapsed) {
      reason = 'duration: calendar event must have a positive whole-minute elapsed length consistent with its actual start/end instants.';
    } else if (wallTimeAt(event.endInstant, zone) !== event.end) {
      reason = 'Calendar end wall time disagrees with its actual instant and timezone.';
    }
  }
  return reason ? {
    category: 'event-time-unrepresentable', reason,
    recovery: 'Sync is blocked for this action in both directions; its record and calendar event are preserved. Correct the Calendar event to a first-occurrence whole-minute time, or explicitly change scheduled/timezone to an unambiguous start through update_action (UTC can express a repeated-hour instant). Name, notes, and duration-only edits do not unblock it. If timing metadata is missing, rebuild the calendar helper and restart the daemon, then check calendar_info.',
  } : undefined;
}

// Explicit rescheduling can replace a real, precisely reported event time; it
// cannot repair missing or contradictory helper metadata.
export function canReplaceEventTime(event: CalEvent): boolean {
  if (event.timezone !== null && typeof event.timezone !== 'string' ||
      schedulingIssues({ timezone: event.timezone ?? undefined }).length ||
      typeof event.start !== 'string' || typeof event.end !== 'string' ||
      !isSchedulingDate(event.start) || !isSchedulingDate(event.end) ||
      !Number.isSafeInteger(event.startInstant) || !Number.isSafeInteger(event.endInstant) || event.endInstant <= event.startInstant) return false;
  try {
    const zone = event.timezone ?? undefined;
    return wallTimeAt(event.startInstant, zone) === event.start && wallTimeAt(event.endInstant, zone) === event.end &&
      (event.durationMinutes === undefined || event.durationMinutes === (event.endInstant - event.startInstant) / 60000);
  } catch { return false; }
}
