import { locationDisplay, parseLocationHandle } from '../../core/location-reference.js';
import type { CalLocation } from './protocol.js';

export function actionLocationIssues(location: unknown): string[] {
  return location === undefined || typeof location === 'string' && parseLocationHandle(location)
    ? [] : ['location: must be a complete #location/? handle with geo, postal, or both.'];
}

/**
 * Export a 2D venue: Calendar stores can discard CLLocation altitude on save.
 * Keep altitude/uncertainty in the action handle rather than requiring their
 * readback. Explicit null removes the venue; labels/body mentions supply no data.
 */
export function calendarLocation(handle: string | undefined): CalLocation | null {
  if (handle === undefined) return null;
  const reference = typeof handle === 'string' ? parseLocationHandle(handle) : null;
  if (!reference) throw new Error(actionLocationIssues(handle)[0]);
  return {
    title: locationDisplay(reference),
    ...(reference.geo ? {
      latitude: reference.geo.latitude,
      longitude: reference.geo.longitude,
    } : {}),
  };
}

/** Readback only verifies our export. Calendar never supplies the action value. */
export function sameCalendarLocation(expected: CalLocation | null | undefined, actual: CalLocation | null | undefined): boolean {
  if (!expected || !actual) return !expected && !actual;
  return expected.title === actual.title
    && expected.latitude === actual.latitude && expected.longitude === actual.longitude
    && (expected.altitude === undefined || expected.altitude === actual.altitude);
}
