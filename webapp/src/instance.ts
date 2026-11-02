// Derivations behind the instance views (DOM-free): the summary panel's
// open-work grouping, timeline windowing, and activity ordering.

import { scheduleInstant, wallTimeAt, parseDurationMinutes, DEFAULT_DURATION_MIN } from '../../cli/src/core/scheduling';
import { toDateStr, type Action, type ActionFrontMatter, type ProjectFrontMatter } from '../lib/types';

// The lifecycle status a reference carries — one model shared by the pill
// status marks, the summary stage pills, and the open-action grouping below.
// 'backlog' and 'slipped' are the two faces of the waiting mark: a time
// never set versus a set time that lapsed.
export type RefStatus = 'due' | 'overdue' | 'scheduled' | 'backlog' | 'slipped' | 'done' | 'cancelled' | 'open' | 'ended';

// Production clocks retain their actual instant, including repeated hours.
export type ClockNow = string | Date;
export interface ScheduleStamp { stamp: string; timezone?: string }

function clockStamp(now: ClockNow): string { return now instanceof Date ? wallTimeAt(now.getTime()) : now; }
export function clockInstant(now: ClockNow): number { return now instanceof Date ? now.getTime() : scheduleInstant(now) ?? NaN; }
export function stampInstant(value: string | ScheduleStamp): number {
  return (typeof value === 'string' ? scheduleInstant(value) : scheduleInstant(value.stamp, value.timezone)) ?? NaN;
}
// Deadlines stay floating; date-only deadlines are breached after their day.
function breached(deadline: string, now: ClockNow): boolean {
  return deadline.length > 10 ? stampInstant(deadline) < clockInstant(now) : deadline < clockStamp(now).slice(0, 10);
}

// Whether an open action has no time ahead on the calendar — unscheduled, or
// its scheduled event already over (scheduled plus duration; a date-only
// stamp lapses when its day ends). The waiting mark's condition: such an
// action is waiting to be scheduled, first time or again.
export function waiting(fm: ActionFrontMatter, now: ClockNow): boolean {
  if (!fm.scheduled) return true;
  if (fm.scheduled.length <= 10) return fm.scheduled < clockStamp(now).slice(0, 10);
  const duration = fm.duration === undefined ? DEFAULT_DURATION_MIN : parseDurationMinutes(fm.duration);
  const start = scheduleInstant(fm.scheduled, fm.timezone);
  return start !== undefined && duration !== undefined && start + duration * 60_000 <= clockInstant(now);
}

// The marks a reference chip carries, most significant first. An open
// action's marks are orthogonal: a deadline makes it due — the commitment
// wins over any scheduled time — escalating to overdue once breached, and no
// time ahead on the calendar leaves it waiting; deadline and waiting can
// apply together. The waiting mark keeps its cause: 'backlog' when a time
// was never set, 'slipped' when a set one lapsed — the glyph splits on it.
// A resolution stands alone, as does a project's ended; the live states
// carry no mark.
export function actionMarks(fm: ActionFrontMatter, now: ClockNow): RefStatus[] {
  if (fm.recurrence) return [];
  if (fm.resolution) return [fm.resolution];
  const marks: RefStatus[] = [];
  if (fm.deadline) marks.push(breached(fm.deadline, now) ? 'overdue' : 'due');
  if (waiting(fm, now)) marks.push(fm.scheduled ? 'slipped' : 'backlog');
  return marks;
}

export function projectMarks(fm: ProjectFrontMatter): RefStatus[] {
  return fm.ended ? ['ended'] : [];
}

// The single grouping status, from the front matter alone: an open action
// files by its place on the calendar — Scheduled or Backlog. A deadline never
// regroups it: due is orthogonal to both, and the chip's due ring already
// shows it. The panel files a dated action under Scheduled whether or not
// the date has passed — the waiting mark is time-aware, the grouping is
// not, so a lapsed scheduled action stays in Scheduled (below the now tick)
// while its chip regains the clock.
export function actionStatus(fm: ActionFrontMatter): RefStatus {
  if (fm.resolution) return fm.resolution;
  return fm.scheduled ? 'scheduled' : 'backlog';
}

export function projectStatus(fm: ProjectFrontMatter): RefStatus {
  return projectMarks(fm)[0] ?? 'open';
}

// A status pill on the panel summary and the record detail — a lifecycle
// state or an exception, never a fact. The label carries time only as the
// distance to a pending event, because that distance is the magnitude of the
// status (due in 3 hours and due in 2 months are different states); time
// since a past event is a fact and reads in the updated line instead. `marks`
// are the chip channels the pill paints (the due ring, the calendar-slot glyph,
// the closed mute); an `exception` pill flags an anomaly rather than a
// state, and styles as an absence.
export interface SummaryPill {
  label: string;
  marks: RefStatus[];
  exception?: boolean;
  // The absolute stamp behind the label, spelled out on hover — the label
  // carries the distance, the hover the calendar fact. A prefix naming the
  // fact, the stamp (formatted render-side), and an optional suffix a
  // Scheduled stamp carries: its timezone and duration.
  hover?: { prefix: string; stamp: string; timezone?: string; suffix?: string };
}

// The pill row of an action: the deadline and the calendar are independent
// states, each its own pill — never merged, so each state reads on its own
// field. A deadline reads 'Due in 3d', escalating to 'Overdue 3d' once
// breached (relativeDate's bare past count reads wrong after 'Due'). The
// calendar pill reads 'Scheduled in 2h' while the event is ahead or running
// ('Scheduled 2h ago' mid-event); once it lapses unresolved it is its own
// state — 'Slipped 2mo', wearing the slipped clock: waiting to be
// rescheduled; never scheduled at all reads 'Backlog', wearing the empty
// slot — beside the due pill, not riding it. A resolution stands alone. A
// live schedule synced to no calendar adds the one exception pill; a
// slipped one doesn't — rescheduling, not syncing, is its fix (the synced
// norm shows nothing either way).
export function actionPills(fm: ActionFrontMatter, now: ClockNow): SummaryPill[] {
  if (fm.recurrence) return [{ label: 'Recurrence template', marks: [] }];
  // The hover behind any pill stating the scheduled time — a resolution's
  // stamp is the scheduled time too, the design's done time.
  const scheduledHover = (prefix: string) => {
    const suffix = fm.duration ? ` · ${formatDuration(fm.duration)}` : '';
    return { prefix, stamp: fm.scheduled!, ...(fm.timezone && fm.scheduled!.includes('T') && { timezone: fm.timezone }), ...(suffix && { suffix }) };
  };
  if (fm.resolution) {
    const label = fm.resolution === 'done' ? 'Done' : 'Cancelled';
    return [{ label, marks: [fm.resolution], ...(fm.scheduled && { hover: scheduledHover(label) }) }];
  }
  const pills: SummaryPill[] = [];
  if (fm.deadline) {
    const rel = relativeDate(fm.deadline, now);
    const distance = rel.replace(/^in /, '');
    const label = rel === 'unknown time' ? 'Deadline time unavailable' : rel === 'today' ? 'Due today'
      : breached(fm.deadline, now) ? `Overdue ${distance}`
      : rel === 'now' ? 'Due now' : `Due in ${distance}`;
    pills.push({ label, marks: [breached(fm.deadline, now) ? 'overdue' : 'due'], hover: { prefix: 'Deadline', stamp: fm.deadline } });
  }
  if (fm.scheduled) {
    const rel = relativeDate(fm.scheduled, now, fm.timezone);
    if (waiting(fm, now)) {
      pills.push({ label: rel === 'today' ? 'Slipped today' : `Slipped ${rel}`, marks: ['slipped'], hover: scheduledHover('Scheduled') });
    } else {
      const distance = rel.replace(/^in /, '');
      const start = stampInstant({ stamp: fm.scheduled, timezone: fm.timezone });
      const label = rel === 'unknown time' ? 'Scheduled time unavailable' : rel === 'today' ? 'Scheduled today'
        : start === clockInstant(now) ? 'Scheduled now'
        : start > clockInstant(now) ? `Scheduled in ${distance}` : `Scheduled ${distance} ago`;
      pills.push({ label, marks: [], hover: scheduledHover('Scheduled') });
      if (!fm.calendar) pills.push({ label: 'No calendar', marks: [], exception: true });
    }
  } else {
    pills.push({ label: 'Backlog', marks: ['backlog'] });
  }
  return pills;
}

export function projectPills(fm: ProjectFrontMatter): SummaryPill[] {
  return fm.ended
    ? [{ label: 'Ended', marks: ['ended'], hover: { prefix: 'Ended', stamp: fm.ended } }]
    : [{ label: 'Open', marks: [], hover: { prefix: 'Created', stamp: fm.created } }];
}

// The calendar's supported fixed durations, rendered in compact elapsed units.
function formatDuration(iso: string): string {
  const minutes = parseDurationMinutes(iso);
  if (minutes === undefined) return iso;
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, rest && `${rest}m`].filter(Boolean).join(' ');
}

// A past-relative stamp in prose — relativeDate's bare gutter count ('3d')
// carries an 'ago' when it reads in a sentence; 'today' and (clock-skew)
// future forms pass through.
export function ago(stamp: string, now: ClockNow): string {
  const rel = relativeDate(stamp, now);
  return rel === 'unknown time' || rel === 'today' || rel === 'now' || stampInstant(stamp) > clockInstant(now) ? rel : `${rel} ago`;
}

// The instance summary's action grouping — each open action files under its
// status, carrying the date that section reads by:
//
//   scheduled  by scheduled time
//   backlog    by last update — the latest entry, else created
//
// Both groups read chronologically. Scheduled is the plan ahead, soonest
// first; backlog leads with its longest-quiet rows — no action is ever
// written off as stale, so one going quiet rises to attract attention:
// revive it, schedule it, or resolve it.
export interface OpenActionGroups {
  scheduled: { id: string; scheduled: string; timezone?: string }[];
  backlog: { id: string; updated: string }[];
  loadMore?: () => Promise<OpenActionGroups>;
  issues?: string[];
  planning?: { pages: number; signature: string };
}

// Group the open (unresolved) actions for the summary panel.
export function groupOpenActions(
  actions: { id: string; action: Action }[],
  latestEntry: (id: string) => string | undefined,
): OpenActionGroups {
  const scheduled: OpenActionGroups['scheduled'] = [];
  const backlog: { id: string; updated: string }[] = [];

  for (const { id, action } of actions) {
    const fm = action.frontMatter;
    if (fm.recurrence) continue;
    switch (actionStatus(fm)) {
      case 'scheduled': scheduled.push({ id, scheduled: fm.scheduled!, ...(fm.timezone && { timezone: fm.timezone }) }); break;
      case 'backlog': backlog.push({ id, updated: latestEntry(id) ?? fm.created }); break;
    }
  }

  scheduled.sort((a, b) => stampInstant({ stamp: a.scheduled, timezone: a.timezone }) - stampInstant({ stamp: b.scheduled, timezone: b.timezone }) || a.id.localeCompare(b.id));
  backlog.sort((a, b) => a.updated.localeCompare(b.updated));
  return { scheduled, backlog };
}

const HORIZON_DAYS = 7;
// The minimum rows kept visible on each side of now by default.
const PREVIEW = 3;

// `days` away from `now`, as a date string. Date math runs on local-time
// parts (never Date-parsing the string — that reads date-only strings as
// UTC).
function shiftDays(now: string, days: number): string {
  const [y, m, d] = now.slice(0, 10).split('-').map(Number);
  return toDateStr(new Date(y, m - 1, d + days));
}

// The default visible slice [from, to) of a chronological dated timeline:
// the week ahead — today through seven days out, inclusive — and, either
// side of now, at least the PREVIEW nearest rows; the rest expands from the
// timeline's two ends. Qualified schedules compare by instant; date-only
// stamps count from their local day's start.
export function timelineWindow(stamps: (string | ScheduleStamp)[], now: ClockNow): { from: number; to: number } {
  const ahead = shiftDays(clockStamp(now), HORIZON_DAYS);
  const indexOr = (found: number) => (found === -1 ? stamps.length : found);
  const instants = stamps.map(stampInstant);
  const horizonEnd = indexOr(instants.findIndex((ms) => Number.isFinite(ms) && wallTimeAt(ms).slice(0, 10) > ahead));
  const futureStart = indexOr(instants.findIndex((ms) => ms > clockInstant(now)));
  const pastEnd = indexOr(instants.findIndex((ms) => ms >= clockInstant(now)));
  const to = Math.min(stamps.length, Math.max(horizonEnd, futureStart + PREVIEW));
  return { from: Math.max(0, pastEnd - PREVIEW), to };
}

// Calendar days between two stamps, compared as local days
// (midnight-to-midnight, DST-proof by rounding).
function calendarDays(stamp: string, now: string): number {
  return Math.round((stampInstant(stamp.slice(0, 10)) - stampInstant(now.slice(0, 10))) / 86_400_000);
}

// One rounded unit for a day count — days near, then weeks, months, years;
// each unit hands over when its count grows awkward (15 days reads as
// 2 weeks).
function scale(days: number): [number, 'day' | 'week' | 'month' | 'year'] {
  if (Math.abs(days) < 7) return [days, 'day'];
  const weeks = Math.round(days / 7);
  if (Math.abs(weeks) < 5) return [weeks, 'week'];
  const months = Math.round(days / 30.44);
  if (Math.abs(months) < 12) return [months, 'month'];
  return [Math.round(days / 365.25), 'year'];
}

// A stamp's date relative to `now`, for the timeline gutter — always
// relative, always one compact rounded unit: hours while a timed stamp is
// within a day of a timed now ('3h', 'in 3h'); under an hour, minutes, then
// days, weeks, months, years ('3d', '2w', '4mo', '2y'). Timed stamps hand
// hours to days the way days hand to weeks — rounding the true distance, so
// 41 hours reads as 2 days; date-only stamps count calendar days, the day
// itself 'today'. A bare count reads as time since; time ahead carries an
// 'in' ('in 3d').
export function relativeDate(stamp: string, now: ClockNow, timezone?: string): string {
  let days: number;
  if (stamp.length > 10 && (now instanceof Date || now.length > 10)) {
    const instant = stampInstant({ stamp, timezone }), current = clockInstant(now);
    if (!Number.isFinite(instant) || !Number.isFinite(current)) return 'unknown time';
    const diff = (instant - current) / 3_600_000;
    if (diff === 0) return 'now';
    if (Math.abs(diff) < 1) {
      const minutes = Math.abs(instant - current) / 60_000;
      const count = minutes < 1 ? '<1m' : `${diff > 0 ? Math.ceil(minutes) : Math.floor(minutes)}m`;
      return diff > 0 ? `in ${count}` : count;
    }
    const hours = Math.round(Math.abs(diff));
    if (hours < 24) {
      const count = `${Math.max(1, hours)}h`;
      return diff > 0 ? `in ${count}` : count;
    }
    days = Math.sign(diff) * Math.round(Math.abs(diff) / 24);
  } else {
    days = calendarDays(stamp, clockStamp(now));
    if (!Number.isFinite(days)) return 'unknown time';
    if (days === 0) return 'today';
  }
  const [n, unit] = scale(days);
  const count = `${Math.abs(n)}${{ day: 'd', week: 'w', month: 'mo', year: 'y' }[unit]}`;
  return n > 0 ? `in ${count}` : count;
}

// Items reordered by their latest entry, most recently active first; items
// with no entries keep their given order at the tail. Entry ids are
// timestamps, so the latest entry compares lexically.
export function orderByActivity<T extends { id: string }>(
  items: T[],
  latestEntry: (id: string) => string | undefined,
): T[] {
  return items
    .map((item, i) => ({ item, i, latest: latestEntry(item.id) ?? '' }))
    .sort((a, b) => b.latest.localeCompare(a.latest) || a.i - b.i)
    .map((x) => x.item);
}
