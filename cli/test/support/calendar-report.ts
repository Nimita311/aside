import type {CalClient} from '../../src/mcp/calendar/client.js';
import {collectCalendarInfo, collectCalendarSyncInfo, type SyncReporter} from '../../src/mcp/calendar/info.js';

/** The system status and instance sync state an agent reads together. */
export async function calendarReport(cal: CalClient, sync?: SyncReporter, options?: {requestAccess?: boolean}) {
  return {...await collectCalendarInfo(cal, options), ...(sync ? collectCalendarSyncInfo(sync) : {syncStates: [], failures: [], issues: [], changes: []})};
}
