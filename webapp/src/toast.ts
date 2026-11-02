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
// stays above an open reader without taking focus or intercepting pointer input.
export function showActionFailure(message: string): void {
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
  current = host;
  timer = setTimeout(dismissActionToast, ACTION_TOAST_MS);
}
