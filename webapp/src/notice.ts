export interface NoticeOptions {
  kind: 'loading' | 'warning' | 'error';
  message: string;
  description?: string;
  details?: string;
  actions?: HTMLElement[];
}

export const LOADING_DELAY_MS = 200;

// Fast reads finish without flashing a spinner. The owner cancels this before
// mounting content; the guard also rejects superseded or closed views.
export function delayLoading(show: () => void, current: () => boolean = () => true, delay = LOADING_DELAY_MS): () => void {
  const timer = setTimeout(() => { if (current()) show(); }, delay);
  return () => clearTimeout(timer);
}

export function showDelayedLoading(host: HTMLElement, message: string, current: () => boolean): () => void {
  return delayLoading(() => showNotice(host, { kind: 'loading', message }), current);
}

// Only the message is live; controls and authored content stay ordinary DOM.
export function showNotice(host: HTMLElement, options: NoticeOptions): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'app-notice';
  notice.dataset.kind = options.kind;
  const indicator = document.createElement('span');
  indicator.className = 'app-notice-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  if (options.kind !== 'loading') {
    indicator.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4m0 4h.01"/></svg>';
  }
  const content = document.createElement('div');
  content.className = 'app-notice-content';
  const message = document.createElement('p');
  message.className = `app-notice-message ${options.kind}`;
  message.setAttribute('role', options.kind === 'error' ? 'alert' : 'status');
  message.setAttribute('aria-atomic', 'true');
  content.append(message);
  if (options.description) {
    const description = document.createElement('p');
    description.className = 'app-notice-description';
    description.textContent = options.description;
    content.append(description);
  }
  if (options.details) {
    const details = document.createElement('details');
    details.className = 'app-notice-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    const text = document.createElement('p');
    text.textContent = options.details;
    details.append(summary, text);
    content.append(details);
  }
  if (options.actions?.length) {
    const actions = document.createElement('div');
    actions.className = 'app-notice-actions';
    for (const action of options.actions) {
      action.classList.add('notice-action');
      actions.append(action);
    }
    content.append(actions);
  }
  notice.append(indicator, content);
  host.replaceChildren(notice);
  message.textContent = options.message;
  return message;
}
