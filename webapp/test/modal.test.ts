// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeModal, createModal } from '../src/modal';

const controllers: ReturnType<typeof createModal>[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.close(0); document.body.replaceChildren(); vi.useRealTimers(); });
function fixture() {
  const trigger = document.createElement('button');
  trigger.id = 'launcher';
  const fallback = document.createElement('button');
  const dialog = document.createElement('dialog');
  dialog.hidden = true;
  const button = document.createElement('button');
  dialog.append(button);
  document.body.append(trigger, fallback, dialog);
  const dismiss = vi.fn(() => controller.close());
  const beforeOpen = vi.fn();
  const controller = createModal(dialog, { dismiss, beforeOpen, fallback: () => fallback, duration: () => 200 });
  controllers.push(controller);
  return { trigger, fallback, dialog, button, dismiss, beforeOpen, controller };
}

function tab(target: HTMLElement, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event); return event;
}

describe('native modal lifecycle', () => {
  it('uses native modal opening, moves focus inside and restores its launcher', () => {
    const f = fixture();
    const showModal = vi.spyOn(f.dialog, 'showModal');
    f.trigger.focus(); f.controller.open();
    expect(showModal).toHaveBeenCalledOnce();
    expect(f.beforeOpen).toHaveBeenCalledOnce();
    expect(activeModal()).toBe(f.dialog);
    expect(document.activeElement).toBe(f.button);
    f.controller.close();
    expect(f.dialog.open).toBe(false);
    expect(f.dialog.inert).toBe(true);
    expect(f.dialog.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(f.trigger);
  });

  it('dismisses only the topmost modal and returns focus inside the underlying reader', () => {
    const reader = fixture(); reader.controller.open(); reader.button.focus();
    const settings = fixture(); settings.controller.open();
    const underneathCancel = new Event('cancel', { cancelable: true });
    reader.dialog.dispatchEvent(underneathCancel);
    expect(reader.dismiss).not.toHaveBeenCalled();
    const cancel = new Event('cancel', { cancelable: true });
    settings.dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(settings.dismiss).toHaveBeenCalledOnce();
    expect(reader.dialog.open).toBe(true);
    expect(document.activeElement).toBe(reader.button);
  });

  it('uses a replacement launcher or visible fallback when opening deep links', () => {
    const f = fixture(); f.trigger.focus(); f.controller.open(); f.trigger.remove();
    const replacement = document.createElement('button'); replacement.id = 'launcher'; document.body.append(replacement);
    f.controller.close(0); expect(document.activeElement).toBe(replacement);
    replacement.remove(); document.body.focus(); f.controller.open(); f.controller.close(0);
    expect(document.activeElement).toBe(f.fallback);
  });

  it('wraps both modal boundaries while allowing native Tab between interior stops', () => {
    const f = fixture(); const last = document.createElement('input'); last.type = 'checkbox'; f.dialog.append(last);
    f.controller.open(); last.focus();
    expect(tab(last).defaultPrevented).toBe(true); expect(document.activeElement).toBe(f.button);
    expect(tab(f.button, true).defaultPrevented).toBe(true); expect(document.activeElement).toBe(last);
    f.button.focus(); expect(tab(f.button).defaultPrevented).toBe(false);
    const shortcut = new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }); last.focus(); last.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
  });

  it('skips hidden/disabled/negative stops and closed disclosures while including native summary/media stops', () => {
    const f = fixture();
    const disabled = document.createElement('button'); disabled.disabled = true;
    const negative = document.createElement('button'); negative.tabIndex = -1;
    const hidden = document.createElement('div'); hidden.style.display = 'none'; hidden.append(document.createElement('button'));
    const inert = document.createElement('div'); inert.inert = true; inert.append(document.createElement('button'));
    const details = document.createElement('details'); const summary = document.createElement('summary');
    const body = document.createElement('button'); details.append(summary, body);
    const video = document.createElement('video'); video.controls = true; video.tabIndex = 0;
    f.dialog.append(disabled, negative, hidden, inert, details, video); f.controller.open();
    video.focus(); expect(tab(video).defaultPrevented).toBe(false); expect(document.activeElement).toBe(video);
    f.button.focus(); expect(tab(f.button, true).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(f.dialog.lastElementChild);
    video.remove(); summary.focus(); expect(tab(summary).defaultPrevented).toBe(true); expect(document.activeElement).toBe(f.button);
    details.open = true; body.focus(); expect(tab(body).defaultPrevented).toBe(true); expect(document.activeElement).toBe(f.button);
  });

  // happy-dom cannot traverse browser-owned media controls or nested documents.
  // Assert that we preserve their native Tab action; real-browser checks cover
  // internal traversal and eventual modal boundary wrapping.
  it.each(['audio', 'video', 'iframe', 'object', 'embed'])('leaves native %s traversal intact at both DOM boundaries', tag => {
    const f = fixture(); const native = document.createElement(tag); native.tabIndex = 0;
    if (native instanceof HTMLMediaElement) native.controls = true;
    // happy-dom's UA stylesheet hides audio even with controls enabled.
    if (tag === 'audio') native.style.display = 'block';
    f.dialog.prepend(native); f.controller.open(); native.focus();
    expect(tab(native, true).defaultPrevented).toBe(false);
    expect(tab(native).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(native);
    f.dialog.append(native); native.focus();
    expect(tab(native).defaultPrevented).toBe(false);
    expect(tab(native, true).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(native);
    // Before the native Shift+Tab action, focus sits just beyond the destination
    // so the browser enters its last internal control rather than the host.
    f.button.focus(); expect(tab(f.button, true).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(f.dialog.lastElementChild);
  });

  it('does not defer ordinary media hosts when their native controls are removed', () => {
    const f = fixture(); const audio = document.createElement('audio'); audio.controls = true; audio.tabIndex = 0;
    audio.style.display = 'block';
    f.dialog.append(audio); f.controller.open(); audio.focus();
    expect(tab(audio).defaultPrevented).toBe(false);
    audio.controls = false;
    expect(tab(audio).defaultPrevented).toBe(true); expect(document.activeElement).toBe(f.button);
    f.dialog.prepend(audio); audio.focus();
    expect(tab(audio, true).defaultPrevented).toBe(true); expect(document.activeElement).toBe(f.button);
  });

  it('keeps browser-owned traversal for an interior media host and preserves its focused launcher', () => {
    const f = fixture(); const audio = document.createElement('audio'); audio.controls = true; audio.tabIndex = 0;
    audio.style.display = 'block';
    const last = document.createElement('button'); f.dialog.append(audio, last); f.trigger.focus(); f.controller.open();
    audio.focus(); expect(tab(audio).defaultPrevented).toBe(false); expect(tab(audio, true).defaultPrevented).toBe(false);
    last.focus(); expect(tab(last).defaultPrevented).toBe(true); expect(document.activeElement).toBe(f.button);
    f.controller.close(0); expect(document.activeElement).toBe(f.trigger);
  });

  it('wraps natural traversal that reaches either guard without exposing them as modal content', () => {
    const f = fixture(); const audio = document.createElement('audio'); audio.controls = true; audio.tabIndex = 0; audio.style.display = 'block';
    f.dialog.append(audio); f.controller.open();
    const [start, end] = Array.from(f.dialog.querySelectorAll<HTMLElement>('.modal-focus-guard'));
    expect(start.getAttribute('aria-hidden')).toBe('true'); expect(end.getAttribute('aria-hidden')).toBe('true');
    expect(start.style.position).toBe('fixed'); expect(end.style.opacity).toBe('0');
    end.focus(); expect(document.activeElement).toBe(f.button);
    start.focus(); expect(document.activeElement).toBe(audio);
    f.controller.close(0);
    expect(start.tabIndex).toBe(-1); expect(end.tabIndex).toBe(-1);
    f.controller.open(); expect(document.activeElement).toBe(f.button);
    expect(f.dialog.querySelectorAll('.modal-focus-guard')).toHaveLength(2);
  });

  it('places guards at current boundaries and preserves positive tabindex ordering', () => {
    const f = fixture(); const first = document.createElement('button'); first.tabIndex = 1;
    const later = document.createElement('button'); later.tabIndex = 2;
    f.dialog.append(later, first); f.controller.open();
    const [start, end] = Array.from(f.dialog.querySelectorAll<HTMLElement>('.modal-focus-guard'));
    expect(start.tabIndex).toBe(1); expect(end.tabIndex).toBe(0);
    end.focus(); expect(document.activeElement).toBe(first);
    const last = document.createElement('button'); f.dialog.append(last);
    last.focus(); expect(tab(last).defaultPrevented).toBe(true); expect(document.activeElement).toBe(first);
    expect(f.dialog.lastElementChild).toBe(end);
    start.focus(); expect(document.activeElement).toBe(last);
    first.disabled = true; later.disabled = true; f.button.disabled = true; last.disabled = true;
    f.dialog.tabIndex = -1; f.controller.ensureFocus();
    start.focus(); expect(document.activeElement).toBe(f.dialog);
  });

  it('uses natural forward entry when the first boundary is native media', () => {
    const f = fixture(); const audio = document.createElement('audio'); audio.controls = true; audio.tabIndex = 0; audio.style.display = 'block';
    f.dialog.prepend(audio); f.controller.open(); f.button.focus();
    expect(tab(f.button).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(f.dialog.firstElementChild);
  });

  it('honors positive tabindex ordering and recalculates boundaries after controls change', () => {
    const f = fixture(); const later = document.createElement('button'); later.tabIndex = 2;
    const first = document.createElement('button'); first.tabIndex = 1;
    f.dialog.append(later, first); f.controller.open();
    f.button.focus(); expect(tab(f.button).defaultPrevented).toBe(true); expect(document.activeElement).toBe(first);
    expect(tab(first, true).defaultPrevented).toBe(true); expect(document.activeElement).toBe(f.button);
    first.disabled = true; f.button.focus(); tab(f.button); expect(document.activeElement).toBe(later);
  });

  it('wraps only the topmost modal and handles a modal with no tab stops', () => {
    const reader = fixture(); reader.controller.open();
    const settings = fixture(); settings.controller.open();
    expect(tab(reader.button).defaultPrevented).toBe(false);
    settings.button.focus(); expect(tab(settings.button).defaultPrevented).toBe(true); expect(document.activeElement).toBe(settings.button);
    settings.button.disabled = true; settings.dialog.tabIndex = -1; settings.dialog.focus();
    expect(tab(settings.dialog, true).defaultPrevented).toBe(true); expect(document.activeElement).toBe(settings.dialog);
    settings.controller.close(0); expect(document.activeElement).toBe(reader.button);
  });

  it('truly hides after exit and cancels stale exit callbacks on reopen', () => {
    vi.useFakeTimers();
    const f = fixture(); f.controller.open(); f.controller.close();
    vi.advanceTimersByTime(200); expect(f.dialog.hidden).toBe(true);
    f.controller.open(); f.controller.close(); f.controller.open();
    vi.advanceTimersByTime(300);
    expect(f.dialog.open).toBe(true);
    expect(f.dialog.hidden).toBe(false);
    expect(f.dialog.inert).toBe(false);
    expect(f.dialog.hasAttribute('aria-hidden')).toBe(false);
  });
});
