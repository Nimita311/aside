import { describe, it, expect } from 'vitest';
import { actionStatus, projectStatus, actionMarks, projectMarks, waiting, actionPills, projectPills, ago, groupOpenActions, orderByActivity, relativeDate, timelineWindow } from '../src/instance';
import { buildProjectForest, HierarchyNode, RelatedProjectLink } from '../src/hierarchy';

const action = (id: string, fm: { created?: string; scheduled?: string; duration?: string; deadline?: string; calendar?: string; resolution?: 'done' | 'cancelled' }) => ({
  id,
  action: { frontMatter: { name: id, created: fm.created ?? '2026-01-01T09:00', ...fm }, body: '' },
});

const NOW = '2026-07-12'; // week ahead ends 2026-07-19, week behind starts 2026-07-05
const noEntries = () => undefined;

describe('actionStatus / projectStatus', () => {
  it('resolution wins over any dates', () => {
    expect(actionStatus(action('a', { resolution: 'done', deadline: '2026-08-01', scheduled: '2026-07-13T10:00' }).action.frontMatter)).toBe('done');
    expect(actionStatus(action('a', { resolution: 'cancelled' }).action.frontMatter)).toBe('cancelled');
  });

  it('an open action groups by its calendar place alone — a deadline never regroups it', () => {
    expect(actionStatus(action('a', { deadline: '2026-08-01', scheduled: '2026-07-13T10:00' }).action.frontMatter)).toBe('scheduled');
    expect(actionStatus(action('a', { scheduled: '2026-07-13T10:00' }).action.frontMatter)).toBe('scheduled');
    expect(actionStatus(action('a', { deadline: '2026-08-01' }).action.frontMatter)).toBe('backlog');
    expect(actionStatus(action('a', {}).action.frontMatter)).toBe('backlog');
  });

  it('a project is open until it ends', () => {
    expect(projectStatus({ name: 'p', created: '2026-01-01' })).toBe('open');
    expect(projectStatus({ name: 'p', created: '2026-01-01', ended: '2026-06-01' })).toBe('ended');
  });

  it('chip marks compose: a deadline rings, no upcoming time waits, a resolution stands alone', () => {
    expect(actionMarks(action('a', { deadline: '2026-08-01' }).action.frontMatter, NOW)).toEqual(['due', 'backlog']);
    expect(actionMarks(action('a', { deadline: '2026-08-01', scheduled: '2026-07-13T10:00' }).action.frontMatter, NOW)).toEqual(['due']);
    expect(actionMarks(action('a', { scheduled: '2026-07-13T10:00' }).action.frontMatter, NOW)).toEqual([]);
    expect(actionMarks(action('a', {}).action.frontMatter, NOW)).toEqual(['backlog']);
    expect(actionMarks(action('a', { resolution: 'done', deadline: '2026-08-01' }).action.frontMatter, NOW)).toEqual(['done']);
    expect(projectMarks({ name: 'p', created: '2026-01-01' })).toEqual([]);
    expect(projectMarks({ name: 'p', created: '2026-01-01', ended: '2026-06-01' })).toEqual(['ended']);
  });

  it('a breached deadline escalates due to overdue; a date-only one at its day\'s end', () => {
    expect(actionMarks(action('a', { deadline: '2026-07-10' }).action.frontMatter, NOW)).toEqual(['overdue', 'backlog']);
    expect(actionMarks(action('a', { deadline: '2026-07-10', scheduled: '2026-07-13T10:00' }).action.frontMatter, NOW)).toEqual(['overdue']);
    // Not breached while its day runs — even against a timed now.
    expect(actionMarks(action('a', { deadline: '2026-07-12' }).action.frontMatter, '2026-07-12T23:00')).toEqual(['due', 'backlog']);
    // A timed deadline breaches at its minute.
    expect(actionMarks(action('a', { deadline: '2026-07-12T10:00' }).action.frontMatter, '2026-07-12T11:00')).toEqual(['overdue', 'backlog']);
  });

  it('the waiting mark keeps its cause: backlog when never set, slipped once lapsed', () => {
    // Lapsed — the event (default 30m) ended well before now.
    expect(actionMarks(action('a', { scheduled: '2026-06-20T15:00' }).action.frontMatter, NOW)).toEqual(['slipped']);
    // A lapsed schedule never moves the grouping — still filed under Scheduled.
    expect(actionStatus(action('a', { scheduled: '2026-06-20T15:00' }).action.frontMatter)).toBe('scheduled');
  });

  it('waiting turns exactly at the event end — scheduled plus duration, default 30m', () => {
    const at = (fm: Parameters<typeof action>[1], now: string) => waiting(action('a', fm).action.frontMatter, now);
    expect(at({ scheduled: '2026-07-12T10:00' }, '2026-07-12T10:29')).toBe(false); // in progress
    expect(at({ scheduled: '2026-07-12T10:00' }, '2026-07-12T10:30')).toBe(true);  // default 30m over
    expect(at({ scheduled: '2026-07-12T10:00', duration: 'PT4H' }, '2026-07-12T13:00')).toBe(false);
    expect(at({ scheduled: '2026-07-12T10:00', duration: 'PT4H' }, '2026-07-12T14:00')).toBe(true);
    // A date-only stamp lapses when its day ends, not during it.
    expect(at({ scheduled: '2026-07-12' }, '2026-07-12T23:00')).toBe(false);
    expect(at({ scheduled: '2026-07-11' }, '2026-07-12T01:00')).toBe(true);
    expect(at({}, NOW)).toBe(true); // unscheduled has always been waiting
  });
});

describe('actionPills / projectPills', () => {
  it('due and scheduled are independent pills, each carrying its distance and hovering its stamp', () => {
    const fm = action('a', { deadline: '2026-07-15', scheduled: '2026-07-13T10:00', calendar: 'Work' }).action.frontMatter;
    expect(actionPills(fm, NOW)).toEqual([
      { label: 'Due in 3d', marks: ['due'], hover: { prefix: 'Deadline', stamp: '2026-07-15' } },
      { label: 'Scheduled in 1d', marks: [], hover: { prefix: 'Scheduled', stamp: '2026-07-13T10:00' } },
    ]);
  });

  it('a lapsed schedule is its own pill — Slipped, wearing the slipped clock', () => {
    // Unscheduled: the Backlog pill stands beside the due pill, never merged;
    // no stamp behind Backlog, so no hover.
    const bare = action('a', { deadline: '2026-07-15' }).action.frontMatter;
    expect(actionPills(bare, NOW)).toEqual([
      { label: 'Due in 3d', marks: ['due'], hover: { prefix: 'Deadline', stamp: '2026-07-15' } },
      { label: 'Backlog', marks: ['backlog'] },
    ]);
    // Lapsed schedule with a deadline: two states, two pills; the slip
    // carries the clock, the due pill stays clean.
    const lapsed = action('a', { deadline: '2026-07-15', scheduled: '2026-06-20T15:00', calendar: 'Work' }).action.frontMatter;
    expect(actionPills(lapsed, NOW)).toEqual([
      { label: 'Due in 3d', marks: ['due'], hover: { prefix: 'Deadline', stamp: '2026-07-15' } },
      { label: 'Slipped 3w', marks: ['slipped'], hover: { prefix: 'Scheduled', stamp: '2026-06-20T15:00' } },
    ]);
    // Lapsed schedule alone.
    const sched = action('a', { scheduled: '2026-06-20T15:00', calendar: 'Work' }).action.frontMatter;
    expect(actionPills(sched, NOW)).toEqual([{ label: 'Slipped 3w', marks: ['slipped'], hover: { prefix: 'Scheduled', stamp: '2026-06-20T15:00' } }]);
    // A slipped schedule drops the no-calendar exception — rescheduling,
    // not syncing, is its fix.
    const unsynced = action('a', { scheduled: '2026-06-20T15:00' }).action.frontMatter;
    expect(actionPills(unsynced, NOW)).toEqual([{ label: 'Slipped 3w', marks: ['slipped'], hover: { prefix: 'Scheduled', stamp: '2026-06-20T15:00' } }]);
  });

  it('past stamps read overdue and ago; the day itself reads today', () => {
    expect(actionPills(action('a', { deadline: '2026-07-10' }).action.frontMatter, NOW)[0]).toEqual({ label: 'Overdue 2d', marks: ['overdue'], hover: { prefix: 'Deadline', stamp: '2026-07-10' } });
    expect(actionPills(action('a', { deadline: '2026-07-12' }).action.frontMatter, NOW)[0]).toEqual({ label: 'Due today', marks: ['due'], hover: { prefix: 'Deadline', stamp: '2026-07-12' } });
    expect(actionPills(action('a', { scheduled: '2026-07-10T10:00', calendar: 'Work' }).action.frontMatter, NOW)[0]).toEqual({ label: 'Slipped 2d', marks: ['slipped'], hover: { prefix: 'Scheduled', stamp: '2026-07-10T10:00' } });
    // Mid-event a schedule hasn't slipped — it reads as started, clean pill;
    // the duration rides the hover in compact units.
    expect(actionPills(action('a', { scheduled: '2026-07-12T10:00', duration: 'PT4H', calendar: 'Work' }).action.frontMatter, '2026-07-12T12:00')[0]).toEqual({ label: 'Scheduled 2h ago', marks: [], hover: { prefix: 'Scheduled', stamp: '2026-07-12T10:00', suffix: ' · 4h' } });
  });

  it('a scheduled action synced to no calendar adds the exception pill', () => {
    const fm = action('a', { scheduled: '2026-07-13T10:00' }).action.frontMatter;
    expect(actionPills(fm, NOW)).toEqual([
      { label: 'Scheduled in 1d', marks: [], hover: { prefix: 'Scheduled', stamp: '2026-07-13T10:00' } },
      { label: 'No calendar', marks: [], exception: true },
    ]);
  });

  it('a resolution stands alone, hovering its scheduled stamp — the done time', () => {
    const fm = action('a', { resolution: 'done', deadline: '2026-07-15', scheduled: '2026-07-13T10:00' }).action.frontMatter;
    expect(actionPills(fm, NOW)).toEqual([{ label: 'Done', marks: ['done'], hover: { prefix: 'Done', stamp: '2026-07-13T10:00' } }]);
    expect(actionPills(action('a', { resolution: 'cancelled' }).action.frontMatter, NOW)).toEqual([{ label: 'Cancelled', marks: ['cancelled'] }]);
    expect(actionPills(action('a', {}).action.frontMatter, NOW)).toEqual([{ label: 'Backlog', marks: ['backlog'] }]);
  });

  it('a timezone rides the scheduled hover', () => {
    const fm = action('a', { scheduled: '2026-07-13T10:00', calendar: 'Work' }).action.frontMatter;
    expect(actionPills({ ...fm, timezone: 'Asia/Tokyo' }, NOW)[0].hover)
      .toEqual({ prefix: 'Scheduled', stamp: '2026-07-13T10:00', timezone: 'Asia/Tokyo' });
  });

  it('a project is Open until Ended, the pill hovering its created/ended stamp', () => {
    expect(projectPills({ name: 'p', created: '2026-01-01' })).toEqual([{ label: 'Open', marks: [], hover: { prefix: 'Created', stamp: '2026-01-01' } }]);
    expect(projectPills({ name: 'p', created: '2026-01-01', ended: '2026-06-01' })).toEqual([{ label: 'Ended', marks: ['ended'], hover: { prefix: 'Ended', stamp: '2026-06-01' } }]);
  });
});

describe('ago', () => {
  it('adds ago to bare past counts, leaving today and future forms alone', () => {
    expect(ago('2026-07-10', NOW)).toBe('2d ago');
    expect(ago('2026-07-12', NOW)).toBe('today');
    expect(ago('2026-07-13', NOW)).toBe('in 1d');
  });
});

describe('groupOpenActions', () => {
  it('partitions by date kind — scheduled soonest first, backlog stalest first — a deadline never regroups', () => {
    const groups = groupOpenActions([
      action('due-sched', { deadline: '2026-07-14', scheduled: '2026-07-13T10:00' }), // files by its scheduled time
      action('due-bare', { deadline: '2026-08-01', created: '2026-02-01T09:00' }), // no calendar place — backlog
      action('sched-past', { scheduled: '2026-06-20T15:00' }),
      action('sched-far', { scheduled: '2026-07-25T09:00' }),
      action('bare', {}),
    ], noEntries);
    expect(groups.scheduled.map((a) => a.id)).toEqual(['sched-past', 'due-sched', 'sched-far']);
    expect(groups.backlog.map((a) => a.id)).toEqual(['bare', 'due-bare']);
  });

  it('drops resolved actions', () => {
    const groups = groupOpenActions([
      action('done', { deadline: '2026-07-13', resolution: 'done' }),
      action('cancelled', { resolution: 'cancelled' }),
      action('open', {}),
    ], noEntries);
    expect(groups.scheduled).toEqual([]);
    expect(groups.backlog.map((a) => a.id)).toEqual(['open']);
  });

  it('sorts the backlog by last update, stalest first — the latest entry, else created', () => {
    const latest = new Map([['touched', '2026-07-01T10:00']]);
    const groups = groupOpenActions([
      action('touched', { created: '2026-02-01T09:00' }),
      action('untouched', { created: '2026-03-01T09:00' }),
    ], (id) => latest.get(id));
    expect(groups.backlog).toEqual([
      { id: 'untouched', updated: '2026-03-01T09:00' },
      { id: 'touched', updated: '2026-07-01T10:00' },
    ]);
  });
});

describe('timelineWindow', () => {
  it('shows at least a few rows either side of now', () => {
    const stamps = ['2026-05-01', '2026-06-20', '2026-07-01', '2026-07-08T09:00',
      '2026-07-12', '2026-07-18', '2026-08-10', '2026-09-01'];
    // The week ahead holds one future row, so the minimum pulls in the two
    // beyond it; three past rows preview and the oldest folds above.
    expect(timelineWindow(stamps, NOW)).toEqual({ from: 1, to: 8 });
  });

  it('shows the whole week ahead when it holds more than the minimum', () => {
    const stamps = ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-17', '2026-07-19', '2026-08-10'];
    // The week-ahead edge is inclusive ('2026-07-19'); only the row beyond
    // it folds.
    expect(timelineWindow(stamps, NOW)).toEqual({ from: 0, to: 5 });
  });

  it('previews fully-past and fully-future timelines', () => {
    expect(timelineWindow(['2025-08-01'], NOW)).toEqual({ from: 0, to: 1 });
    expect(timelineWindow(['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'], NOW)).toEqual({ from: 1, to: 4 });
    expect(timelineWindow(['2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01'], NOW)).toEqual({ from: 0, to: 3 });
  });
});

describe('relativeDate', () => {
  it('uses remaining minutes upward, completed minutes elapsed, explicit sub-minutes and contextual now', () => {
    const now = new Date(2026, 6, 12, 15, 0, 0);
    expect(relativeDate('2026-07-12T15:02', now)).toBe('in 2m');
    expect(relativeDate('2026-07-12T14:59', now)).toBe('1m');
    expect(relativeDate('2026-07-12T15:02', new Date(2026, 6, 12, 15, 0, 59))).toBe('in 2m');
    expect(relativeDate('2026-07-12T14:59', new Date(2026, 6, 12, 15, 0, 1))).toBe('1m');
    expect(relativeDate('2026-07-12T15:01', new Date(2026, 6, 12, 15, 0, 30))).toBe('in <1m');
    expect(relativeDate('2026-07-12T15:00', new Date(2026, 6, 12, 15, 0, 30))).toBe('<1m');
    expect(relativeDate('2026-07-12T15:00', now)).toBe('now');
    expect(actionPills(action('a', { deadline: '2026-07-12T15:00', scheduled: '2026-07-12T15:00', calendar: 'Work' }).action.frontMatter, now).map(p => p.label)).toEqual(['Due now', 'Scheduled now']);
    expect(actionPills(action('a', { deadline: '2026-07-12T15:00', scheduled: '2026-07-12T14:31', calendar: 'Work' }).action.frontMatter, new Date(2026, 6, 12, 15, 0, 30)).map(p => p.label)).toEqual(['Overdue <1m', 'Scheduled 29m ago']);
    expect(actionPills(action('a', { scheduled: '2026-07-12T14:30', calendar: 'Work' }).action.frontMatter, now)[0].label).toBe('Slipped 30m');
    expect(ago('2026-07-12T15:00', now)).toBe('now');
    expect(ago('2026-07-12T15:00', new Date(2026, 6, 12, 15, 0, 30))).toBe('<1m ago');
  });

  it('reads as one compact rounded unit', () => {
    expect(relativeDate('2026-07-12T15:00', NOW)).toBe('today');
    expect(relativeDate('2026-07-11', NOW)).toBe('1d');
    expect(relativeDate('2026-07-07T09:30', NOW)).toBe('5d');
    expect(relativeDate('2026-06-27', NOW)).toBe('2w');   // 15 days
    expect(relativeDate('2026-06-14', NOW)).toBe('4w');   // 28 days
    expect(relativeDate('2026-05-12', NOW)).toBe('2mo');  // 61 days
    expect(relativeDate('2025-08-01T17:00', NOW)).toBe('11mo');
    expect(relativeDate('2024-07-12', NOW)).toBe('2y');
  });

  it('marks time ahead with an in', () => {
    expect(relativeDate('2026-07-13', NOW)).toBe('in 1d');
    expect(relativeDate('2026-07-15', NOW)).toBe('in 3d');
    expect(relativeDate('2026-07-19', NOW)).toBe('in 1w');  // 7 days
    expect(relativeDate('2026-08-15', NOW)).toBe('in 1mo'); // 34 days
    expect(relativeDate('2027-07-12', NOW)).toBe('in 1y');
  });

  it('compares calendar days across month boundaries', () => {
    expect(relativeDate('2026-08-01', '2026-07-31')).toBe('in 1d');
    expect(relativeDate('2026-06-30', '2026-07-01')).toBe('1d');
  });

  it('reads in hours while a timed stamp is within a day of a timed now', () => {
    const now = '2026-07-12T15:00';
    expect(relativeDate('2026-07-12T18:00', now)).toBe('in 3h');
    expect(relativeDate('2026-07-12T09:30', now)).toBe('6h');       // 5.5h rounds up
    expect(relativeDate('2026-07-13T05:00', now)).toBe('in 14h');   // crosses midnight
    expect(relativeDate('2026-07-12T15:10', now)).toBe('in 10m');   // near times use minutes
    expect(relativeDate('2026-07-12T14:55', now)).toBe('5m');
    expect(relativeDate('2026-07-11T10:00', now)).toBe('1d');       // 29h is a day again
    expect(relativeDate('2026-07-12', now)).toBe('today');          // date-only stays daily
  });

  it('hands hours to days by rounding the true distance, like days to weeks', () => {
    expect(relativeDate('2026-07-13T20:00', '2026-07-12T01:00')).toBe('in 2d'); // 43h, calendar-tomorrow
    expect(relativeDate('2026-07-14T05:00', '2026-07-12T23:00')).toBe('in 1d'); // 30h, calendar day-after
    expect(relativeDate('2026-07-10T13:00', '2026-07-12T15:00')).toBe('2d');    // 50h since
    expect(relativeDate('2026-07-13', '2026-07-12T23:00')).toBe('in 1d');       // date-only: calendar
  });
});

describe('orderByActivity', () => {
  it('orders by latest entry, entry-less items keeping index order at the tail', () => {
    const items = [
      { id: 'a', description: '' },
      { id: 'b', description: '' },
      { id: 'c', description: '' },
      { id: 'd', description: '' },
    ];
    const latest = new Map([
      ['a', '2026-05-01T10:00'],
      ['c', '2026-06-01T10:00'],
    ]);
    expect(orderByActivity(items, (id) => latest.get(id)).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd']);
  });
});

// A relation map from parent→child edges, both directions — the shape
// buildRelations gives relatedProjects.
function relations(edges: [parent: string, child: string, description?: string][]) {
  const map = new Map<string, RelatedProjectLink[]>();
  const push = (key: string, link: RelatedProjectLink) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(link);
  };
  for (const [parent, child, description] of edges) {
    push(parent, { id: child, description, reverse: false });
    push(child, { id: parent, description, reverse: true });
  }
  return map;
}

function shape(nodes: HierarchyNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.id}`, ...shape(n.children, depth + 1)]);
}

describe('buildProjectForest', () => {
  it('puts every project on the forest: linked ones nested, loners as roots', () => {
    const items = [{ id: 'top' }, { id: 'lone', description: 'standalone' }, { id: 'sub' }];
    const forest = buildProjectForest(items, relations([['top', 'sub', 'part one']]));
    expect(shape(forest)).toEqual(['top', '  sub', 'lone']);
    // Roots keep their given descriptions, children the link's declared one.
    expect(forest[0].description).toBeUndefined();
    expect(forest[0].children[0].description).toBe('part one');
    expect(forest[1].description).toBe('standalone');
  });

  it('expands a shared child once and sweeps cyclic clusters up as roots', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'x' }, { id: 'y' }];
    // a and b share x; y is in a cycle with itself via a→? no: y↔a cycle-free
    const forest = buildProjectForest(items, relations([['a', 'x'], ['b', 'x'], ['x', 'y'], ['y', 'x']]));
    expect(shape(forest)).toEqual(['a', '  x', '    y', '      x', 'b', '  x']);
  });
});
