export const CALENDAR_NAME_RULE = 'calendar must be a nonblank name; omit it on creation or use null on update to stop syncing and remove the event.';

export function isCalendarName(value: string): boolean {
  return value.trim().length > 0;
}

export function assertCalendarName(value: string | null | undefined): void {
  if (value != null && !isCalendarName(value)) throw new Error(CALENDAR_NAME_RULE);
}
