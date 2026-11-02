import { showActionFailure, dismissActionToast } from './toast';
import { activeModal, usable } from './modal';
import { toDateStr } from '../lib/types';
import { JUMP_UNITS, JumpUnit, monthStart, parseLooseDate, shiftByUnit } from './dates';
import type { DateTimePreferences } from './preferences';
import { calendarLabel, dateColumns, formatDate, formatMonth } from './date-display';
import { currentFlowDate } from './latch';

// The jump-to-date popover under the latched readout: a quick period
// navigator, a free-form date field, and an inline calendar (see spec.md).
// The date math lives in dates.ts; the flow-side landing (loading weeks,
// scrolling, flashing) is injected by app.ts through DatePickerDeps.

export interface DatePickerDeps {
  displayPreferences?(): DateTimePreferences;
  // One-time jump that dismisses the popover: scroll the flow to the day,
  // pinning it (or the nearest earlier entry) to the pane top.
  jumpToDate(dateStr: string): void;
  // The quick navigator's landing: jump to the entry closest to `targetIso`
  // on a date beyond `baseDate` in `dir` (+1 newer / −1 older), loading as
  // needed. Resolves false at the timeline boundary or in an empty view.
  jumpNear(targetIso: string, baseDate: string, dir: number): Promise<boolean>;
}

const CAL_WEEKDAYS = Array.from({ length: 7 }, (_, i) => calendarLabel(`2026-10-${String(12 + i).padStart(2, '0')}`, { weekday: 'short' }));
const ARROW_UP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
const ARROW_DOWN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

interface CalendarMarks { today: string; current: string; selected: string }

function markCalendarDay(button: HTMLElement, marks: CalendarMarks, prefs: DateTimePreferences = { timeFormat: 'locale' }): void {
  const date = button.dataset.date!;
  const selected = date === marks.selected;
  const current = date === marks.current;
  const today = date === marks.today;
  button.classList.toggle('is-selected', selected);
  button.classList.toggle('is-current', current);
  button.classList.toggle('is-today', today);
  const day = dateColumns(date, prefs).find(part => part.type === 'day')!.value;
  if (button.textContent !== day) button.textContent = day;
  button.setAttribute('aria-label', `${formatDate(date, prefs.dateFormat)}${selected ? ', selected' : ''}${current ? ', currently shown in timeline' : ''}`);
  if (today) button.setAttribute('aria-current', 'date');
  else button.removeAttribute('aria-current');
}

// Draw the inline month calendar into `container` (cleared first): a header with
// month-stepping arrows, a Mon-first weekday row, and a grid of day buttons.
// `onPick` fires with the clicked day's date; `onNav` steps the shown month.
function drawCalendar(
  container: HTMLElement,
  view: Date,
  marks: CalendarMarks,
  onPick: (dateStr: string) => void,
  onNav: (delta: number) => void,
  prefs: DateTimePreferences,
): void {
  container.innerHTML = '';
  const year = view.getFullYear();
  const month = view.getMonth();
  container.setAttribute('role', 'group');
  container.dataset.month = toDateStr(view);
  container.setAttribute('aria-label', formatMonth(toDateStr(view), prefs));

  const header = container.appendChild(document.createElement('div'));
  header.className = 'cal-header';
  const prev = header.appendChild(document.createElement('button'));
  prev.type = 'button';
  prev.className = 'cal-nav';
  prev.setAttribute('aria-label', 'Previous month');
  prev.textContent = '‹';
  prev.addEventListener('click', () => onNav(-1));
  const title = header.appendChild(document.createElement('span'));
  title.className = 'cal-title';
  title.textContent = formatMonth(toDateStr(view), prefs);
  const next = header.appendChild(document.createElement('button'));
  next.type = 'button';
  next.className = 'cal-nav';
  next.setAttribute('aria-label', 'Next month');
  next.textContent = '›';
  next.addEventListener('click', () => onNav(1));

  const weekdays = container.appendChild(document.createElement('div'));
  weekdays.className = 'cal-weekdays';
  for (const w of CAL_WEEKDAYS) weekdays.appendChild(document.createElement('span')).textContent = w;

  const grid = container.appendChild(document.createElement('div'));
  grid.className = 'cal-grid';
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Mon = 0
  const days = new Date(year, month + 1, 0).getDate();
  for (let i = 0; i < firstDow; i++) grid.appendChild(document.createElement('span'));
  for (let d = 1; d <= days; d++) {
    const dateStr = toDateStr(new Date(year, month, d));
    const btn = grid.appendChild(document.createElement('button'));
    btn.type = 'button';
    btn.className = 'cal-day';
    btn.dataset.date = dateStr;
    markCalendarDay(btn, marks, prefs);
    btn.addEventListener('click', () => onPick(dateStr));
  }
}

export function createDatePicker(deps: DatePickerDeps): { toggle(): void; close(): void; refresh(): void; isOpen(): boolean } {
  // The open popover, or null. A single element, torn down on dismiss.
  let popover: HTMLElement | null = null;
  let launcher: HTMLElement | null = null;
  let focusFrame: number | null = null;
  // The quick navigator's selected period — held across opens. Each step is
  // relative to the flow's current date, not a stored cursor, so scrolling
  // between steps re-bases the navigator.
  let pickerUnit: JumpUnit = 'week';
  // A step's load+scroll is async; ignore further clicks until it settles so
  // rapid clicks can't stack overlapping jumps.
  let quickBusy = false;
  // Stops the open popover watching the latch (which keeps its "current day"
  // marker live); set while open, run and cleared on close.
  let detachCurrentWatch: (() => void) | null = null;
  let detachViewportWatch: (() => void) | null = null;
  let reposition: (() => void) | null = null;
  // Pending dismiss-listener arming (open() schedules it a tick out).
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether the current press began outside the popover — only then does its
  // release dismiss, so a drag that starts inside (selecting text in the field)
  // and ends outside doesn't close it.
  let pressedOutside = false;

  // The popover (or its trigger chip) contains the node — a click here isn't
  // "outside".
  const isInside = (t: Node | null): boolean =>
    !!(t && (popover?.contains(t) || document.querySelector('.date-latch-chip')?.contains(t)));

  const onPointerDown = (e: Event) => {
    pressedOutside = !isInside(e.target as Node);
  };
  const onClick = (e: Event) => {
    // Dismiss only on a full click outside: both the press and the release land
    // beyond the popover, not just the mouseup.
    if (pressedOutside && !isInside(e.target as Node)) close(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || activeModal() || e.key !== 'Escape') return;
    e.preventDefault();
    // Esc steps back one level (spec): dismiss only the popover — stop the
    // event before the app's global handler would also clear the filter.
    e.stopPropagation();
    close(true);
  };

  function cancelFocusRestore(): void {
    if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    focusFrame = null;
    document.removeEventListener('pointerdown', cancelFocusRestore, true);
  }

  function restoreFocus(trigger: HTMLElement | null): void {
    if (activeModal()) return;
    const target = usable(trigger) ? trigger
      : Array.from(document.querySelectorAll<HTMLElement>('.date-latch-chip')).find(usable)
        ?? Array.from(document.querySelectorAll<HTMLElement>('.app-title a')).find(usable);
    target?.focus({ preventScroll: true });
  }

  function close(returnFocus = !!popover?.contains(document.activeElement)): void {
    cancelFocusRestore();
    const wasOpen = popover !== null;
    const trigger = launcher;
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.removeAttribute('aria-controls');
    if (armTimer !== null) { clearTimeout(armTimer); armTimer = null; }
    popover?.remove();
    popover = null;
    detachCurrentWatch?.();
    detachCurrentWatch = null;
    detachViewportWatch?.();
    detachViewportWatch = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (!wasOpen || !returnFocus) return;
    restoreFocus(trigger);
    // A flow rebuild may replace the chip immediately after dismissing us.
    // Repair only a lost focus; never displace a later keyboard or pointer target.
    document.addEventListener('pointerdown', cancelFocusRestore, true);
    focusFrame = requestAnimationFrame(() => {
      focusFrame = null;
      document.removeEventListener('pointerdown', cancelFocusRestore, true);
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !usable(focused)) restoreFocus(trigger);
    });
  }

  // Step the quick navigator one period in `dir` (+1 newer / −1 older) from the
  // flow's current date, keeping the popover open — so scrolling (or a manual
  // jump) between steps re-bases it to where the view now sits.
  async function stepQuick(dir: number, nav: HTMLElement, setStatus: (message: string) => void): Promise<void> {
    if (quickBusy) return;
    quickBusy = true;
    dismissActionToast();
    setStatus('');
    nav.setAttribute('aria-busy', 'true');
    try {
      const base = currentFlowDate();
      const target = shiftByUnit(base, pickerUnit, dir);
      await deps.jumpNear(target + 'T12:00:00', base, dir);
    } catch {
      if (nav.isConnected) showActionFailure('Unable to jump to that date. Try again.');
    } finally {
      nav.removeAttribute('aria-busy');
      quickBusy = false;
    }
  }

  // Open the popover under the latch chip. Three parts, all visible at once: a
  // quick period navigator (up/down steppers that jump without closing), a
  // date-entry field, and an always-expanded inline calendar (both a one-time
  // jump that dismisses).
  function open(): void {
    if (activeModal()) return;
    const chip = document.querySelector<HTMLElement>('.date-latch-chip');
    if (!chip) return;
    cancelFocusRestore();
    launcher = chip;
    pressedOutside = false;
    // Seeds the field and calendar; the quick navigator re-reads the current
    // date per step rather than tracking this.
    const base = currentFlowDate();

    const pop = document.createElement('div');
    pop.className = 'date-jump';
    pop.id = 'date-jump';

    // Quick navigator: period segments on the left, up/down steppers to their
    // right — the arrows sit at the popover's top-right corner.
    const nav = pop.appendChild(document.createElement('div'));
    nav.className = 'date-jump-nav';
    const units = nav.appendChild(document.createElement('div'));
    units.className = 'date-jump-units';
    const unitBtns = JUMP_UNITS.map((u) => {
      const btn = units.appendChild(document.createElement('button'));
      btn.type = 'button';
      btn.className = 'date-jump-unit';
      btn.textContent = u.label;
      btn.setAttribute('aria-pressed', String(u.key === pickerUnit));
      btn.classList.toggle('is-active', u.key === pickerUnit);
      btn.addEventListener('click', () => {
        setQuickStatus('');
        pickerUnit = u.key;
        for (const b of unitBtns) {
          b.classList.toggle('is-active', b.dataset.unit === pickerUnit);
          b.setAttribute('aria-pressed', String(b.dataset.unit === pickerUnit));
        }
      });
      btn.dataset.unit = u.key;
      return btn;
    });
    const steppers = nav.appendChild(document.createElement('div'));
    steppers.className = 'date-jump-steppers';
    const up = steppers.appendChild(document.createElement('button'));
    up.type = 'button';
    up.className = 'date-jump-step';
    up.setAttribute('aria-label', 'Jump one period newer');
    up.title = 'Newer';
    up.innerHTML = ARROW_UP;
    up.addEventListener('click', () => { void stepQuick(1, nav, setQuickStatus); });
    const down = steppers.appendChild(document.createElement('button'));
    down.type = 'button';
    down.className = 'date-jump-step';
    down.setAttribute('aria-label', 'Jump one period older');
    down.title = 'Older';
    down.innerHTML = ARROW_DOWN;
    down.addEventListener('click', () => { void stepQuick(-1, nav, setQuickStatus); });

    // Keep an empty live region mounted before the asynchronous result arrives.
    // The message is visible too, so reduced motion does not remove feedback.
    const quickStatus = pop.appendChild(document.createElement('div'));
    quickStatus.className = 'date-jump-status';
    quickStatus.setAttribute('role', 'status');
    quickStatus.setAttribute('aria-atomic', 'true');
    function setQuickStatus(message: string): void {
      if (popover !== pop) return;
      quickStatus.textContent = message;
      positionPopover();
    }

    // A rule marks the quick navigator and the date selection below it as two
    // separate ways to jump.
    pop.appendChild(document.createElement('hr')).className = 'date-jump-divider';

    // Date entry: a plain text field showing an ISO date, taking free-form input
    // parsed leniently on commit — no native date control, so its picker popup
    // never competes with the inline calendar below.
    const entry = pop.appendChild(document.createElement('label'));
    entry.className = 'date-jump-entry';
    entry.textContent = 'Jump to';
    const input = entry.appendChild(document.createElement('input'));
    input.type = 'text';
    input.className = 'date-jump-input';
    input.value = ''; // empty by default; the calendar tracks the viewing date instead
    input.placeholder = 'YYYY-MM-DD';
    input.setAttribute('aria-label', 'Jump to date');
    input.autocomplete = 'off';
    const error = entry.appendChild(document.createElement('span'));
    error.id = 'date-jump-error';
    error.hidden = true;
    error.setAttribute('role', 'alert');

    function setInvalid(invalid: boolean): void {
      input.classList.toggle('is-invalid', invalid);
      error.hidden = !invalid;
      error.textContent = invalid ? `Enter a valid date, such as ${base}.` : '';
      if (invalid) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', error.id);
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      }
      positionPopover();
    }

    // Inline calendar, always expanded. Views month-firsts so stepping never
    // overflows a short month.
    const cal = pop.appendChild(document.createElement('div'));
    cal.className = 'date-jump-cal';
    let view = monthStart(base);
    const focusedDay = (): string | undefined =>
      cal.contains(document.activeElement) && document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.date : undefined;
    const renderCal = () => {
      const focusedNav = Array.from(cal.querySelectorAll('.cal-nav')).indexOf(document.activeElement!);
      const focusedDate = focusedDay();
      drawCalendar(
        cal, view,
        { today: toDateStr(new Date()), current: currentFlowDate(), selected: parseLooseDate(input.value) ?? '' },
        (dateStr) => { deps.jumpToDate(dateStr); close(true); },
        (delta) => { view = new Date(view.getFullYear(), view.getMonth() + delta, 1); renderCal(); },
        deps.displayPreferences?.() ?? { timeFormat: 'locale' },
      );
      if (focusedNav >= 0) cal.querySelectorAll<HTMLButtonElement>('.cal-nav')[focusedNav]?.focus({ preventScroll: true });
      else if (focusedDate) cal.querySelector<HTMLButtonElement>(`.cal-day[data-date="${focusedDate}"]`)?.focus({ preventScroll: true });
      positionPopover();
    };
    renderCal();

    // Track the viewing date while the popover is open: scrolling the flow (or a
    // quick step, which scrolls it) moves where the view sits, and the latch
    // stamps that date onto its data-date each frame. Redraw when the day changes
    // — and, while the field is empty, follow the scroll to that month too, so an
    // empty picker mirrors where the flow is. (renderFlow closes the popover, so
    // the latch element is stable for the popover's lifetime.)
    const latchEl = document.getElementById('date-latch');
    let lastCurrent = base;
    const watch = new MutationObserver(() => {
      const now = currentFlowDate();
      if (now === lastCurrent) return;
      lastCurrent = now;
      // A background flow update must not replace the month under a focused
      // day. Keep its date available until the user navigates elsewhere.
      if (!input.value.trim() && !focusedDay()) view = monthStart(now);
      renderCal();
    });
    if (latchEl) watch.observe(latchEl, { attributes: true, attributeFilter: ['data-date'] });
    detachCurrentWatch = () => watch.disconnect();

    // As the field is edited, clear the error and follow a parseable value to
    // its month — or, once cleared, back to the viewing date's month.
    input.addEventListener('input', () => {
      setInvalid(false);
      const parsed = parseLooseDate(input.value);
      if (parsed) view = monthStart(parsed);
      else if (!input.value.trim()) view = monthStart(currentFlowDate());
      renderCal();
    });
    // Commit on Enter only — not on blur, so clicking the calendar's month arrows
    // (which blur the field) navigates instead of jumping and closing.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const parsed = parseLooseDate(input.value);
      if (parsed) { deps.jumpToDate(parsed); close(true); }
      else setInvalid(true);
    });

    document.body.appendChild(pop);
    popover = pop;
    chip.setAttribute('aria-expanded', 'true');
    chip.setAttribute('aria-controls', pop.id);

    // Keep the usual position under the chip when space allows. At high zoom
    // or with an onscreen keyboard, fit the visible viewport and scroll the
    // popover's contents so every calendar day remains reachable.
    const viewport = window.visualViewport;
    function positionPopover(): void {
      if (!pop.isConnected) return;
      const viewport = window.visualViewport;
      const minLeft = (viewport?.offsetLeft ?? 0) + 8;
      const minTop = (viewport?.offsetTop ?? 0) + 8;
      const availableWidth = Math.max(0, (viewport?.width ?? window.innerWidth) - 16);
      const availableHeight = Math.max(0, (viewport?.height ?? window.innerHeight) - 16);
      pop.style.maxWidth = `${availableWidth}px`;
      pop.style.maxHeight = `${availableHeight}px`;
      const rect = chip!.getBoundingClientRect();
      const size = pop.getBoundingClientRect();
      pop.style.left = `${Math.max(minLeft, Math.min(rect.right - size.width, minLeft + availableWidth - size.width))}px`;
      pop.style.top = `${Math.max(minTop, Math.min(rect.bottom + 4, minTop + availableHeight - size.height))}px`;
    }
    positionPopover();
    window.addEventListener('resize', positionPopover);
    viewport?.addEventListener('resize', positionPopover);
    viewport?.addEventListener('scroll', positionPopover);
    detachViewportWatch = () => {
      reposition = null;
      window.removeEventListener('resize', positionPopover);
      viewport?.removeEventListener('resize', positionPopover);
      viewport?.removeEventListener('scroll', positionPopover);
    };
    reposition = positionPopover;

    // Focus the field so the user can type straight away (preventScroll so
    // focusing the off-flow popover doesn't nudge the page).
    input.focus({ preventScroll: true });

    // Dismiss on a full click outside / Escape. Armed next tick so the opening
    // click (still propagating) doesn't immediately close it; close() cancels
    // the arming so a same-tick close can't leak capture listeners that would
    // swallow Escape app-wide.
    armTimer = setTimeout(() => {
      armTimer = null;
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    });
  }

  return {
    toggle(): void {
      if (popover) close();
      else open();
    },
    close,
    refresh() {
      const marks = { today: toDateStr(new Date()), current: currentFlowDate(), selected: parseLooseDate(popover?.querySelector<HTMLInputElement>('.date-jump-input')?.value ?? '') ?? '' };
      const prefs = deps.displayPreferences?.() ?? { timeFormat: 'locale' as const };
      const calendar = popover?.querySelector<HTMLElement>('.date-jump-cal');
      if (calendar?.dataset.month) {
        const label = formatMonth(calendar.dataset.month, prefs);
        calendar.setAttribute('aria-label', label);
        const title = calendar.querySelector('.cal-title');
        if (title && title.textContent !== label) title.textContent = label;
      }
      for (const button of Array.from(popover?.querySelectorAll<HTMLElement>('.cal-day') ?? [])) markCalendarDay(button, marks, prefs);
      reposition?.();
    },
    isOpen: () => popover !== null,
  };
}
