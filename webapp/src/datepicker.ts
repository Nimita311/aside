import { activeModal, usable } from './modal';
import { toDateStr } from '../lib/types';
import { monthStart, parseLooseDate } from './dates';
import type { DateTimePreferences } from './preferences';
import { calendarLabel, dateColumns, formatDate, formatMonth } from './date-display';
import { currentFlowDate } from './latch';

export interface CalendarContext {
  /** Identity of the retained timeline, including its record-selection filters. */
  key: string;
  current: string;
  visibleRange?: { start: string; end: string };
  retained?: boolean;
}

export interface DatePickerDeps {
  displayPreferences?(): DateTimePreferences;
  getCalendarContext?(): CalendarContext;
  /** Complete counts for the inclusive displayed grid, not just loaded cards. */
  getDayCounts?(from: string, to: string): Promise<ReadonlyMap<string, number>>;
  jumpToDate(dateStr: string): void;
  /** Compatibility for callers of the old quick navigator; unused by the calendar. */
  jumpNear?(targetIso: string, baseDate: string, dir: number): Promise<boolean>;
}

interface CalendarSurface {
  root: HTMLElement;
  calendar: HTMLElement;
  input: HTMLInputElement;
  error: HTMLElement;
  status: HTMLElement;
}

type Counts = { status: 'loading' } | { status: 'ready'; values: ReadonlyMap<string, number> } | { status: 'error' };

function gridDates(view: Date, startsOn: number): string[] {
  const first = new Date(view);
  first.setDate(1);
  first.setDate(1 - (first.getDay() - startsOn + 7) % 7);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first); date.setDate(first.getDate() + index);
    return toDateStr(date);
  });
}

function density(count: number): number {
  return count > 0 ? Math.min(0.3, 0.04 + Math.log2(count + 1) * 0.045) : 0;
}

/** Persistent inline calendar, sharing its month and draft with the optional popover. */
export function createDatePicker(deps: DatePickerDeps): {
  mountInline(host: HTMLElement): void;
  toggle(trigger?: HTMLElement): void;
  close(): void;
  refresh(options?: { invalidateCounts?: boolean; reloadCounts?: boolean }): void;
  isOpen(): boolean;
  dispose(): void;
} {
  let inline: CalendarSurface | null = null;
  let popup: CalendarSurface | null = null;
  let launcher: HTMLElement | null = null;
  let view = monthStart(currentFlowDate());
  let contextKey: string | null = null;
  let lastCurrent = '';
  let browsedMonth = false;
  let draft = '';
  let invalid = false;
  let focusFrame: number | null = null;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let pressedOutside = false;
  let detachCurrentWatch: (() => void) | null = null;
  let detachViewportWatch: (() => void) | null = null;
  let reposition: (() => void) | null = null;
  let revision = 0;
  let disposed = false;
  const counts = new Map<string, Counts>();

  const surfaces = (): CalendarSurface[] => [inline, popup].filter((surface): surface is CalendarSurface => surface !== null);
  const preferences = (): DateTimePreferences => deps.displayPreferences?.() ?? { timeFormat: 'locale' };
  const context = (): CalendarContext => deps.getCalendarContext?.() ?? { key: 'legacy', current: currentFlowDate() };
  const startsOn = (): number => {
    const day = preferences().weekStartsOn;
    return Number.isInteger(day) && day! >= 0 && day! <= 6 ? day! : 1;
  };
  const requestKey = (ctx: CalendarContext, days: string[]): string => `${ctx.key}\n${days[0]}\n${days[41]}`;

  function cancelFocusRestore(): void {
    if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    focusFrame = null;
    document.removeEventListener('pointerdown', cancelFocusRestore, true);
  }

  function restoreFocus(trigger: HTMLElement | null): void {
    if (activeModal()) return;
    const calendar = document.getElementById('btn-workspace-calendar');
    const target = usable(trigger) ? trigger : usable(calendar) ? calendar
      : Array.from(document.querySelectorAll<HTMLElement>('.date-latch-chip')).find(usable)
        ?? Array.from(document.querySelectorAll<HTMLElement>('#btn-workspace-views, #btn-instance-switch, .app-title a')).find(usable);
    target?.focus({ preventScroll: true });
  }

  const isInside = (node: Node | null): boolean => !!node && (!!popup?.root.contains(node) || !!launcher?.contains(node));
  const onPointerDown = (event: Event): void => { pressedOutside = !isInside(event.target as Node); };
  const onClick = (event: Event): void => { if (pressedOutside && !isInside(event.target as Node)) close(false); };
  const onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || activeModal() || event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); close(true);
  };

  function close(returnFocus = !!popup?.root.contains(document.activeElement)): void {
    cancelFocusRestore();
    const wasOpen = popup !== null, trigger = launcher;
    trigger?.setAttribute('aria-expanded', 'false'); trigger?.removeAttribute('aria-controls');
    if (armTimer !== null) { clearTimeout(armTimer); armTimer = null; }
    popup?.root.remove(); popup = null;
    detachCurrentWatch?.(); detachCurrentWatch = null;
    detachViewportWatch?.(); detachViewportWatch = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (!wasOpen || !returnFocus) return;
    restoreFocus(trigger);
    document.addEventListener('pointerdown', cancelFocusRestore, true);
    focusFrame = requestAnimationFrame(() => {
      focusFrame = null; document.removeEventListener('pointerdown', cancelFocusRestore, true);
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !usable(focused)) restoreFocus(trigger);
    });
  }

  function synchronizeContext(): CalendarContext {
    const ctx = context();
    if (ctx.key !== contextKey) {
      contextKey = ctx.key; view = monthStart(ctx.current); browsedMonth = false;
      draft = ''; invalid = false; counts.clear(); revision++;
    } else if (ctx.current !== lastCurrent && !browsedMonth && !draft.trim()
      && !surfaces().some(surface => surface.calendar.contains(document.activeElement)
        && (document.activeElement as HTMLElement)?.dataset.date)) {
      view = monthStart(ctx.current);
    }
    lastCurrent = ctx.current;
    return ctx;
  }

  function loadCounts(ctx: CalendarContext, days: string[]): void {
    if (!deps.getDayCounts || !ctx.key || disposed) return;
    const key = requestKey(ctx, days);
    if (counts.has(key)) return;
    if (counts.size >= 12) {
      const oldest = counts.keys().next().value;
      if (oldest !== undefined) counts.delete(oldest);
    }
    const token = revision;
    counts.set(key, { status: 'loading' });
    void Promise.resolve().then(() => deps.getDayCounts!(days[0], days[41])).then(values => {
      if (disposed || revision !== token || context().key !== ctx.key || !counts.has(key)) return;
      counts.set(key, { status: 'ready', values }); render();
    }, () => {
      if (disposed || revision !== token || context().key !== ctx.key || !counts.has(key)) return;
      counts.set(key, { status: 'error' }); render();
    });
  }

  function navigateMonth(delta: number): void {
    synchronizeContext();
    view.setDate(1); view.setMonth(view.getMonth() + delta); browsedMonth = true; render();
  }

  function jump(date: string): void {
    draft = ''; invalid = false; view = monthStart(date); browsedMonth = false;
    deps.jumpToDate(date); close(true); render();
  }

  function commit(surface: CalendarSurface): void {
    synchronizeContext();
    // Read the live field too: Enter may follow a programmatic edit without an
    // input event. The existing loose parser remains the single date grammar.
    draft = surface.input.value;
    const parsed = parseLooseDate(draft);
    if (parsed) jump(parsed);
    else { invalid = true; updateInputs(); surface.input.focus({ preventScroll: true }); reposition?.(); }
  }

  function updateInputs(): void {
    const base = context().current;
    for (const surface of surfaces()) {
      if (surface.input.value !== draft) surface.input.value = draft;
      surface.input.classList.toggle('is-invalid', invalid);
      surface.error.hidden = !invalid;
      surface.error.textContent = invalid ? `Enter a valid date, such as ${base}.` : '';
      if (invalid) {
        surface.input.setAttribute('aria-invalid', 'true'); surface.input.setAttribute('aria-describedby', surface.error.id);
      } else { surface.input.removeAttribute('aria-invalid'); surface.input.removeAttribute('aria-describedby'); }
    }
  }

  function draw(surface: CalendarSurface, ctx: CalendarContext, days: string[]): void {
    const cal = surface.calendar;
    const focused = cal.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusedDate = focused?.dataset.date, focusedAction = focused?.dataset.calendarAction;
    const prefs = preferences(), selected = parseLooseDate(draft) ?? '', today = toDateStr(new Date());
    const month = toDateStr(view).slice(0, 7), activity = counts.get(requestKey(ctx, days)), range = ctx.visibleRange;
    const rangeStart = range && (range.start < range.end ? range.start : range.end);
    const rangeEnd = range && (range.start < range.end ? range.end : range.start);
    // Preference/count/range refreshes keep the existing date controls. A
    // focused date is a durable keyboard target even when its label changes.
    const previousDays = cal.dataset.gridStart === days[0] && cal.dataset.gridEnd === days[41]
      ? new Map(Array.from(cal.querySelectorAll<HTMLButtonElement>('.cal-day')).map(button => [button.dataset.date!, button]))
      : new Map<string, HTMLButtonElement>();
    cal.replaceChildren(); cal.setAttribute('role', 'group'); cal.dataset.month = toDateStr(view);
    cal.dataset.gridStart = days[0]; cal.dataset.gridEnd = days[41];
    cal.setAttribute('aria-label', formatMonth(toDateStr(view), prefs));
    const header = cal.appendChild(document.createElement('div')); header.className = 'cal-header';
    const title = header.appendChild(document.createElement('span')); title.className = 'cal-title';
    title.textContent = formatMonth(toDateStr(view), prefs); title.title = title.textContent;
    const controls = header.appendChild(document.createElement('div')); controls.className = 'cal-controls';
    controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Calendar navigation');
    for (const [action, label, glyph, delta] of [['prev', 'Previous month', '‹', -1], ['next', 'Next month', '›', 1]] as const) {
      const button = controls.appendChild(document.createElement('button'));
      button.type = 'button'; button.className = 'cal-nav'; button.dataset.calendarAction = action;
      button.setAttribute('aria-label', label); button.textContent = glyph;
      button.addEventListener('click', () => navigateMonth(delta));
    }
    const now = controls.appendChild(document.createElement('button'));
    now.type = 'button'; now.className = 'cal-today'; now.textContent = 'Today';
    now.dataset.calendarAction = 'today'; now.setAttribute('aria-label', 'Jump to today');
    now.addEventListener('click', () => jump(toDateStr(new Date())));
    const weekdays = cal.appendChild(document.createElement('div')); weekdays.className = 'cal-weekdays'; weekdays.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 7; i++) {
      const date = `2026-10-${String(11 + (startsOn() + i) % 7).padStart(2, '0')}`;
      const label = weekdays.appendChild(document.createElement('span'));
      label.textContent = calendarLabel(date, { weekday: 'narrow' }); label.title = calendarLabel(date, { weekday: 'long' });
    }
    const grid = cal.appendChild(document.createElement('div')); grid.className = 'cal-grid';
    if (deps.getDayCounts && ctx.key && (!activity || activity.status === 'loading')) grid.setAttribute('aria-busy', 'true');
    for (const [index, date] of days.entries()) {
      const existing = previousDays.get(date);
      const button = grid.appendChild(existing ?? document.createElement('button'));
      button.type = 'button'; button.className = 'cal-day'; button.dataset.date = date;
      const isSelected = date === selected, current = date === ctx.current;
      const inRange = !!rangeStart && !!rangeEnd && date >= rangeStart && date <= rangeEnd;
      button.classList.toggle('is-selected', isSelected); button.classList.toggle('is-current', current);
      button.classList.toggle('is-adjacent', !date.startsWith(month)); button.classList.toggle('is-today', date === today);
      button.classList.toggle('is-in-range', inRange);
      button.classList.toggle('range-start', inRange && (index % 7 === 0 || date === rangeStart));
      button.classList.toggle('range-end', inRange && (index % 7 === 6 || date === rangeEnd));
      if (date === today) button.setAttribute('aria-current', 'date'); else button.removeAttribute('aria-current');
      const rawCount = activity?.status === 'ready' ? activity.values.get(date) ?? 0 : undefined;
      const count = rawCount !== undefined && Number.isFinite(rawCount) && rawCount >= 0 ? Math.floor(rawCount) : undefined;
      if (count !== undefined) { button.dataset.count = String(count); button.style.setProperty('--cal-density', String(density(count))); }
      else { delete button.dataset.count; button.style.removeProperty('--cal-density'); }
      let label = formatDate(date, prefs.dateFormat);
      if (isSelected) label += ', selected';
      if (current && !range) label += ', currently shown in timeline';
      if (inRange) label += ctx.retained ? ', last visible in timeline' : ', currently visible in timeline';
      if (count !== undefined) label += `, ${count} matching ${count === 1 ? 'entry' : 'entries'}`;
      else if (deps.getDayCounts && ctx.key) label += activity?.status === 'error' ? ', activity unavailable' : ', activity loading';
      button.setAttribute('aria-label', label); button.title = label;
      if (!existing) {
        const shade = button.appendChild(document.createElement('span')); shade.className = 'cal-day-shade'; shade.setAttribute('aria-hidden', 'true');
        const number = button.appendChild(document.createElement('span')); number.className = 'cal-day-number';
        const outline = button.appendChild(document.createElement('span')); outline.className = 'cal-range-outline'; outline.setAttribute('aria-hidden', 'true');
        button.addEventListener('click', () => jump(date));
      }
      button.querySelector<HTMLElement>('.cal-day-number')!.textContent = dateColumns(date, prefs).find(part => part.type === 'day')!.value;
    }
    surface.status.replaceChildren(); surface.status.hidden = activity?.status !== 'error';
    if (activity?.status === 'error') {
      surface.status.append('Activity unavailable. ');
      const retry = surface.status.appendChild(document.createElement('button')); retry.type = 'button';
      retry.className = 'cal-retry'; retry.textContent = 'Retry';
      retry.addEventListener('click', () => { counts.delete(requestKey(ctx, days)); render(); });
    }
    if (focusedDate) cal.querySelector<HTMLButtonElement>(`.cal-day[data-date="${focusedDate}"]`)?.focus({ preventScroll: true });
    else if (focusedAction) cal.querySelector<HTMLButtonElement>(`[data-calendar-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  }

  function render(): void {
    if (disposed) return;
    const ctx = synchronizeContext(), days = gridDates(view, startsOn());
    // Compact layouts park the persistent control until its pill page opens.
    // Preparing that hidden DOM must not issue remote activity queries.
    if (surfaces().some(surface => surface.root.isConnected && !surface.root.closest('[hidden], [inert]'))) loadCounts(ctx, days);
    for (const surface of surfaces()) draw(surface, ctx, days);
    updateInputs(); reposition?.();
  }

  function createSurface(popover: boolean): CalendarSurface {
    const root = document.createElement('div'); root.className = popover ? 'date-jump' : 'timeline-calendar date-jump-inline';
    if (popover) { root.id = 'date-jump'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Timeline calendar'); }
    const calendar = root.appendChild(document.createElement('div')); calendar.className = 'date-jump-cal';
    const entry = root.appendChild(document.createElement('div')); entry.className = 'date-jump-entry';
    const input = entry.appendChild(document.createElement('input'));
    input.type = 'text'; input.className = 'date-jump-input'; input.placeholder = 'Jump to date…'; input.setAttribute('aria-label', 'Jump to date'); input.autocomplete = 'off';
    const submit = entry.appendChild(document.createElement('button')); submit.type = 'button';
    submit.className = 'date-jump-submit'; submit.textContent = '→'; submit.setAttribute('aria-label', 'Jump to date');
    const error = root.appendChild(document.createElement('div')); error.className = 'date-jump-error';
    error.id = popover ? 'date-jump-error' : 'date-jump-error-inline'; error.hidden = true; error.setAttribute('role', 'alert');
    const status = root.appendChild(document.createElement('div')); status.className = 'date-jump-status';
    status.hidden = true; status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
    const surface = { root, calendar, input, error, status };
    input.addEventListener('input', () => {
      // Availability can change before a deferred layout refresh. Adopt that
      // context before recording this edit so its reset cannot erase the draft.
      synchronizeContext();
      draft = input.value; invalid = false;
      const parsed = parseLooseDate(draft);
      if (parsed) { view = monthStart(parsed); browsedMonth = true; }
      else if (!draft.trim()) { view = monthStart(context().current); browsedMonth = false; }
      render();
    });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); commit(surface); } });
    submit.addEventListener('click', () => commit(surface));
    return surface;
  }

  function open(trigger?: HTMLElement): void {
    if (activeModal()) return;
    const button = trigger ?? document.getElementById('btn-workspace-calendar') ?? document.querySelector<HTMLElement>('.date-latch-chip');
    if (!button) return;
    cancelFocusRestore(); launcher = button; pressedOutside = false;
    popup = createSurface(true); const pop = popup.root;
    document.body.appendChild(pop); button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-controls', pop.id);
    const viewport = window.visualViewport;
    function positionPopover(): void {
      if (!pop.isConnected) return;
      const viewport = window.visualViewport;
      const minLeft = (viewport?.offsetLeft ?? 0) + 8, minTop = (viewport?.offsetTop ?? 0) + 8;
      const width = Math.max(0, (viewport?.width ?? window.innerWidth) - 16), height = Math.max(0, (viewport?.height ?? window.innerHeight) - 16);
      pop.style.maxWidth = `${width}px`; pop.style.maxHeight = `${height}px`;
      const rect = button!.getBoundingClientRect(), size = pop.getBoundingClientRect();
      const above = button!.id === 'btn-workspace-calendar' || !!button!.closest('#control-pill');
      const top = above ? rect.top - size.height - 8 : rect.bottom + 4;
      pop.style.left = `${Math.max(minLeft, Math.min(rect.right - size.width, minLeft + width - size.width))}px`;
      pop.style.top = `${Math.max(minTop, Math.min(top, minTop + height - size.height))}px`;
    }
    reposition = positionPopover;
    window.addEventListener('resize', positionPopover); viewport?.addEventListener('resize', positionPopover); viewport?.addEventListener('scroll', positionPopover);
    detachViewportWatch = () => {
      reposition = null; window.removeEventListener('resize', positionPopover);
      viewport?.removeEventListener('resize', positionPopover); viewport?.removeEventListener('scroll', positionPopover);
    };
    const latch = document.getElementById('date-latch');
    if (latch) {
      const watch = new MutationObserver(() => render()); watch.observe(latch, { attributes: true, attributeFilter: ['data-date'] });
      detachCurrentWatch = () => watch.disconnect();
    }
    render(); popup.input.focus({ preventScroll: true });
    armTimer = setTimeout(() => {
      armTimer = null; document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('click', onClick, true); document.addEventListener('keydown', onKey, true);
    });
  }

  return {
    mountInline(host) { if (!inline) inline = createSurface(false); host.append(inline.root); render(); },
    toggle(trigger) { if (popup) close(); else open(trigger); },
    close,
    refresh(options) { if (options?.invalidateCounts || options?.reloadCounts) { counts.clear(); revision++; } if (inline || popup) render(); },
    isOpen: () => popup !== null,
    dispose() { close(false); cancelFocusRestore(); inline?.root.remove(); inline = null; disposed = true; revision++; counts.clear(); },
  };
}
