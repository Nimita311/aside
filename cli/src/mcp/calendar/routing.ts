import type { ActionFrontMatter } from '../../core/types.js';
import type { CalCalendar, CalErrorCode } from './protocol.js';

export function calendarAccount(calendar: CalCalendar): string {
  return calendar.account || 'local';
}

export function matchingCalendars(calendars: CalCalendar[], route: Pick<ActionFrontMatter, 'calendar' | 'calendar_account'>): CalCalendar[] {
  return calendars.filter(c => c.name === route.calendar &&
    (!route.calendar_account || calendarAccount(c) === route.calendar_account));
}

export function calendarRoutingError(calendars: CalCalendar[], route: Pick<ActionFrontMatter, 'calendar' | 'calendar_account'>): { code: CalErrorCode; message: string } | undefined {
  if (!route.calendar) return undefined;
  const label = route.calendar_account ? `${route.calendar} (${route.calendar_account})` : route.calendar;
  const matches = matchingCalendars(calendars, route);
  if (matches.length === 0) return { code: 'calendar-not-found', message: `calendar not found: ${label}` };
  if (matches.length > 1) return { code: 'calendar-ambiguous', message: `calendar ambiguous: ${label}. Rename a matching calendar, or set calendar_account to a unique readable account name.` };
  if (!matches[0].writable) return { code: 'calendar-read-only', message: `calendar read-only: ${label}` };
  return undefined;
}
