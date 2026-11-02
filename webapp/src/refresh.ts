// Catch-up scheduling — when to check the data source for external changes
// and when to land what a check found. The store knows how to check
// (StoreView.check()); this module owns the policy: a light check on tab
// focus and on a timer while visible, a full sweep every few checks, and a
// staged update applied only once the app is quiet. See "Catch-up" in spec.md.
import type { CheckScope, PendingUpdate } from '../../cli/src/core/data-snapshot';

export interface RefreshHooks {
  check(scope: CheckScope, changedPaths?: string[]): Promise<PendingUpdate | null>;
  // No interaction, week loads, or transitions in flight — safe to apply.
  isQuiet(): boolean;
  apply(update: PendingUpdate): Promise<void> | void;
  // A validator-less source re-downloads every file a check touches, so its
  // full sweeps run at a stretched cadence.
  hasValidators(): boolean;
  // Server-published change notifications (DataSource.watch) — best-effort;
  // pushed paths fold into an immediate targeted check.
  watch?(onChange: (paths: string[]) => void): () => void;
}

const LIGHT_MS = 60_000;
const FULL_EVERY = 10;
const FULL_EVERY_NO_VALIDATORS = 30;
// How often a staged update re-tries to land while the app stays busy.
const APPLY_POLL_MS = 300;
// Hidden longer than this and the return check is a full sweep — enough time
// away for edits beyond what the indexes show.
const LONG_AWAY_MS = 10 * 60_000;
// Pushed paths coalesce for this long before checking — a save often lands as
// a burst of events (the file, then its index).
const PUSH_DEBOUNCE_MS = 200;

// Start checking; returns a stop function (called when the source is switched).
export function startRefresh(hooks: RefreshHooks): () => void {
  let stopped = false;
  let ticks = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let applyTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenAt: number | null = null;
  let running = false;
  let pending: PendingUpdate | null = null;
  // Pushed paths waiting for a check — buffered while one runs or an update
  // waits to land, so a notification is never dropped.
  const pushBuffer = new Set<string>();
  let pushTimer: ReturnType<typeof setTimeout> | null = null;

  async function runCheck(scope: CheckScope, changedPaths: string[] = []): Promise<void> {
    // One check at a time, and none while an update waits to land — its
    // findings would go stale under the pending apply.
    if (stopped || running || pending) return;
    running = true;
    try {
      const update = await hooks.check(scope, changedPaths);
      if (update && !stopped) {
        pending = update;
        scheduleApply();
      }
    } catch (err) {
      // Never let a failed check kill its trigger — the next one retries.
      console.error('Catch-up check failed:', err);
    } finally {
      running = false;
    }
  }

  // A push notification: coalesce briefly, then fold the paths into a light
  // check. While a check runs or an apply is pending the buffer holds and the
  // timer re-arms — checked as soon as the pipeline frees up.
  function onPush(paths: string[]): void {
    for (const path of paths) pushBuffer.add(path);
    schedulePushCheck();
  }

  function schedulePushCheck(): void {
    if (pushTimer != null || stopped) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (stopped) return;
      if (running || pending) {
        schedulePushCheck();
        return;
      }
      const paths = [...pushBuffer];
      pushBuffer.clear();
      void runCheck('light', paths);
    }, PUSH_DEBOUNCE_MS);
  }

  function scheduleApply(): void {
    if (applyTimer != null) return;
    applyTimer = setTimeout(() => {
      applyTimer = null;
      if (stopped || !pending) return;
      if (!hooks.isQuiet()) {
        scheduleApply();
        return;
      }
      const update = pending;
      pending = null;
      // The store patch inside apply is synchronous; a failure here is a
      // render error — the data landed, and the next check re-renders.
      Promise.resolve(hooks.apply(update)).catch((err) => {
        console.error('Failed to apply catch-up update:', err);
      });
    }, APPLY_POLL_MS);
  }

  function startTimer(): void {
    if (timer != null) return;
    timer = setInterval(() => {
      ticks++;
      const fullEvery = hooks.hasValidators() ? FULL_EVERY : FULL_EVERY_NO_VALIDATORS;
      void runCheck(ticks % fullEvery === 0 ? 'full' : 'light');
    }, LIGHT_MS);
  }

  function stopTimer(): void {
    if (timer != null) clearInterval(timer);
    timer = null;
  }

  // Checks pause while the tab is hidden; the return runs one immediately —
  // the dominant real case is writing elsewhere and switching back.
  function onVisibility(): void {
    if (document.hidden) {
      hiddenAt = performance.now();
      stopTimer();
      return;
    }
    const away = hiddenAt != null ? performance.now() - hiddenAt : 0;
    hiddenAt = null;
    startTimer();
    void runCheck(away > LONG_AWAY_MS ? 'full' : 'light');
  }

  // Focus without a visibility change (switching windows, not tabs) also
  // means the user may have been writing elsewhere.
  function onFocus(): void {
    if (!document.hidden) void runCheck('light');
  }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  if (!document.hidden) startTimer();
  const unwatch = hooks.watch?.(onPush);

  return () => {
    stopped = true;
    stopTimer();
    if (applyTimer != null) clearTimeout(applyTimer);
    applyTimer = null;
    if (pushTimer != null) clearTimeout(pushTimer);
    pushTimer = null;
    pending = null;
    unwatch?.();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
  };
}
