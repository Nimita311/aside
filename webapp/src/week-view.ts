import type { Entry } from '../lib/types';
import { showActionFailure } from './toast';
import { bindDisplay, setDisplayText } from './display';
import { formatDate } from './date-display';
import type { RenderOptions } from './render';

export interface WeekView {
  host: HTMLElement;
  status(): 'idle' | 'loading' | 'loaded' | 'failed';
  load(retry?: boolean, userInitiated?: boolean): Promise<void>;
}

// Traversal can continue past a failed week. This independent slot retains
// the chronological gap and owns one explicit, coalesced retry at a time.
export function createWeekView(monday: string, options: {
  read(): Promise<Entry[]>;
  render(entries: Entry[], host: HTMLElement): void | Promise<void>;
  current(): boolean;
  settled(retry: boolean): void;
  focusFallback?(): HTMLElement | null;
  renderOpts?(): RenderOptions;
}): WeekView {
  const host = document.createElement('div');
  host.className = 'week-view';
  host.dataset.week = monday;
  let status: ReturnType<WeekView['status']> = 'idle';
  let pending: Promise<void> | null = null;
  function parkRetryFocus(): void {
    const focused = document.activeElement as HTMLElement | null;
    if (focused?.matches('button.history-retry') && host.contains(focused)) {
      focused.closest('.history-notice')?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    }
  }
  // Parse-issue notices also disable their Retry before invoking load(). Keep
  // a stable, visible focus destination before either notice starts its read.
  host.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('button.history-retry')) parkRetryFocus();
  }, { capture: true });
  function restoreFocus(): void {
    const target = host.querySelector<HTMLElement>('button.history-retry')
      ?? host.querySelector<HTMLElement>('[data-entry-id] a.em-time')
      ?? options.focusFallback?.();
    if (target && !target.closest('[hidden], [inert]') && !target.matches(':disabled')) target.focus({ preventScroll: true });
  }
  function failure(error: unknown): void {
    if (!host.querySelector('[data-entry-id]')) host.replaceChildren();
    else for (const old of host.querySelectorAll(':scope > .history-notice')) old.remove();
    const notice = document.createElement('div'); notice.className = 'history-notice';
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = `Week of ${formatDate(monday)} could not load`;
    if (options.renderOpts) bindDisplay(summary, options.renderOpts(), (node, current) => setDisplayText(node, `Week of ${formatDate(monday, current.dateFormat)} could not load`));
    const text = document.createElement('p'); text.textContent = error instanceof Error ? error.message : String(error);
    details.append(summary, text);
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'history-retry notice-action'; retry.textContent = 'Retry';
    retry.setAttribute('aria-label', `Retry week of ${formatDate(monday)}`);
    if (options.renderOpts) bindDisplay(retry, options.renderOpts(), (node, current) => node.setAttribute('aria-label', `Retry week of ${formatDate(monday, current.dateFormat)}`));
    retry.addEventListener('click', () => { void load(true); });
    notice.append(details, retry); host.append(notice);
  }
  function load(retry = false, userInitiated = retry): Promise<void> {
    if (pending) return pending;
    if (status === 'loaded' && !retry) return Promise.resolve();
    parkRetryFocus();
    status = 'loading'; host.dataset.weekStatus = status;
    const button = host.querySelector<HTMLButtonElement>('button.history-retry');
    if (button) { button.disabled = true; button.textContent = 'Retrying…'; }
    pending = (async () => {
      try {
        const entries = await options.read();
        if (!options.current() || !host.isConnected) return;
        const retained = host.contains(document.activeElement);
        host.replaceChildren();
        const rendering = options.render(entries, host);
        const focusAfterRender = document.activeElement;
        await rendering;
        if (!options.current() || !host.isConnected) return;
        status = 'loaded';
        if (retained && document.activeElement === focusAfterRender && !host.contains(document.activeElement)) restoreFocus();
      } catch (error) {
        if (!options.current() || !host.isConnected) return;
        const retained = host.contains(document.activeElement);
        status = 'failed'; failure(error);
        if (userInitiated) showActionFailure('Could not load this week. Try again.');
        if (retained && !host.contains(document.activeElement)) restoreFocus();
      } finally {
        pending = null;
        if (options.current() && host.isConnected) {
          host.dataset.weekStatus = status;
          options.settled(retry);
        }
      }
    })();
    return pending;
  }
  return { host, status: () => status, load };
}
