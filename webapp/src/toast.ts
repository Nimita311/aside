import { activeModal } from './modal';

export const ACTION_TOAST_MS = 4000;
let timer: ReturnType<typeof setTimeout> | undefined;
let current: HTMLElement | undefined;

export function dismissActionToast(): void {
  clearTimeout(timer);
  if (!current) return;
  if (current.isConnected) current.hidePopover?.();
  current.hidden = true;
  current.replaceChildren();
  current = undefined;
}

// Call only for a current, explicitly initiated operation. The manual popover
// stays above an open reader without taking focus. An explicit navigation
// action remains available until used or dismissed by later navigation.
export function showActionFailure(message: string, action?: { label: string; run(): void }): void {
  dismissActionToast();
  const host = document.getElementById('action-toast') ?? document.createElement('div');
  host.id = 'action-toast'; host.className = 'action-toast';
  host.setAttribute('popover', 'manual');
  host.setAttribute('role', 'status'); host.setAttribute('aria-atomic', 'true');
  // A native modal makes its outside document inert, including live regions.
  // Keep the status within the active dialog while the popover handles placement.
  (activeModal() ?? document.body).append(host);
  host.hidden = false;
  host.showPopover?.();
  host.textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'notice-action'; button.textContent = action.label;
    button.addEventListener('click', () => { dismissActionToast(); action.run(); });
    host.append(' ', button);
  }
  current = host;
  if (!action) timer = setTimeout(dismissActionToast, ACTION_TOAST_MS);
}
