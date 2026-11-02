// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModal, type ModalController } from '../src/modal';
import { ACTION_TOAST_MS, dismissActionToast, showActionFailure } from '../src/toast';

let modal: ModalController | undefined;
afterEach(() => { dismissActionToast(); modal?.close(0); modal = undefined; vi.useRealTimers(); document.body.replaceChildren(); });

describe('user action failure toast', () => {
  it('preserves focus, renders plain text and auto dismisses after four seconds', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button>Continue reading</button>';
    const button = document.querySelector('button')!; button.focus();
    showActionFailure('Could not open <script>this file</script>.');
    const toast = document.getElementById('action-toast')!;
    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-atomic')).toBe('true');
    expect(toast.getAttribute('popover')).toBe('manual');
    expect(toast.querySelector('script')).toBeNull();
    expect(toast.textContent).toContain('<script>');
    expect(document.activeElement).toBe(button);
    vi.advanceTimersByTime(ACTION_TOAST_MS - 1); expect(toast.hidden).toBe(false);
    vi.advanceTimersByTime(1); expect(toast.hidden).toBe(true);
    expect(toast.textContent).toBe(''); expect(document.activeElement).toBe(button);
  });

  it('keeps the status within the active dialog without taking focus, then reuses it outside', () => {
    document.body.innerHTML = '<dialog hidden><button>Close</button></dialog>';
    const dialog = document.querySelector('dialog')!;
    modal = createModal(dialog, { dismiss: () => {}, beforeOpen: () => {}, fallback: () => null, duration: () => 0 });
    modal.open(); const focused = document.activeElement;
    showActionFailure('Could not read this document.');
    const toast = document.getElementById('action-toast')!;
    expect(dialog.contains(toast)).toBe(true);
    expect(document.activeElement).toBe(focused);
    modal.close(0);
    showActionFailure('Could not reconnect.');
    expect(document.getElementById('action-toast')).toBe(toast);
    expect(toast.parentElement).toBe(document.body);
    expect(toast.hidden).toBe(false);
  });

  it('replaces the previous message and gives the new failure its full lifetime', () => {
    vi.useFakeTimers(); showActionFailure('First failure');
    vi.advanceTimersByTime(3000); showActionFailure('Second failure');
    expect(document.querySelectorAll('#action-toast')).toHaveLength(1);
    const toast = document.getElementById('action-toast')!;
    vi.advanceTimersByTime(1000); expect(toast.hidden).toBe(false);
    expect(toast.textContent).toBe('Second failure');
    vi.advanceTimersByTime(3000); expect(toast.hidden).toBe(true);
  });
});
