// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeModal, createModal } from '../src/modal';
import { createReaderPage } from '../src/reader-page';

afterEach(() => document.body.replaceChildren());

function fixture(dialog = false) {
  document.body.innerHTML = '<button id="workspace-control">Views</button>'
    + '<div id="flow-scroll"><a id="record-link" href="/work/detail">Open record</a></div>';
  const host = document.createElement(dialog ? 'dialog' : 'section');
  const body = document.createElement('main');
  body.innerHTML = '<h2>Project brief</h2><a href="/work/asset/notes.md">Notes</a>';
  host.hidden = true;
  host.append(body);
  document.body.append(host);
  const flow = document.getElementById('flow-scroll')!;
  const launcher = document.getElementById('record-link')!;
  const control = document.getElementById('workspace-control')!;
  const beforeOpen = vi.fn(), changed = vi.fn();
  const reader = createReaderPage(host, body, { beforeOpen, changed, fallback: () => control });
  return { host, body, flow, launcher, control, beforeOpen, changed, reader };
}

describe('normal Reader page', () => {
  it('replaces the visible flow without entering a modal or trapping workspace navigation', () => {
    const f = fixture();
    f.launcher.focus(); f.reader.open();
    expect(f.flow.hidden).toBe(true);
    expect(f.flow.inert).toBe(true);
    expect(f.host.hidden).toBe(false);
    expect(document.activeElement).toBe(f.body.querySelector('h2'));
    expect(activeModal()).toBeUndefined();
    expect(f.control.closest('[inert]')).toBeNull();
    f.control.focus();
    expect(document.activeElement).toBe(f.control);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    f.control.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    f.reader.close();
    expect(document.activeElement).toBe(f.control);
    expect(f.flow.hidden).toBe(false);
    expect(f.flow.inert).toBe(false);
  });

  it('preserves a user focus move during an asynchronous reader refresh', () => {
    const f = fixture();
    f.reader.open();
    f.control.focus();
    f.body.innerHTML = '<h2>Updated brief</h2>';
    f.reader.ensureFocus();
    expect(document.activeElement).toBe(f.control);
    f.body.querySelector<HTMLElement>('h2')!.tabIndex = -1;
    f.body.querySelector<HTMLElement>('h2')!.focus();
    f.body.innerHTML = '<h2>Newly loaded brief</h2>';
    f.reader.ensureFocus();
    expect(document.activeElement).toBe(f.body.querySelector('h2'));
  });

  it('restores the surviving flow launcher without resetting its scroll position', () => {
    const f = fixture();
    f.flow.scrollTop = 243;
    f.launcher.focus(); f.reader.open();
    f.launcher.remove();
    const replacement = document.createElement('a');
    replacement.href = '/work/detail'; replacement.textContent = 'Open current record';
    f.flow.append(replacement);
    f.reader.close();
    expect(document.activeElement).toBe(replacement);
    expect(f.flow.scrollTop).toBe(243);
    expect(f.host.inert).toBe(true);
  });

  it('restores the flow position after the native frame returns from full-page HTML', () => {
    const f = fixture();
    let scrollTop = 643;
    Object.defineProperty(f.flow, 'scrollTop', {
      configurable: true,
      get: () => f.flow.hidden ? 0 : scrollTop,
      set: value => { scrollTop = value; },
    });
    f.changed.mockImplementation(() => {
      // Model the browser clamping scroll while the capped native layout is
      // restored after the document's full-viewport layout.
      if (f.host.hidden) f.flow.scrollTop = 0;
    });
    f.launcher.focus(); f.reader.open();
    expect(f.flow.scrollTop).toBe(0);
    // Visiting another document must retain the original visible-flow anchor,
    // rather than replacing it with the hidden scroller's zero reading.
    f.reader.open();
    f.reader.close();
    expect(f.flow.hidden).toBe(false);
    expect(f.flow.scrollTop).toBe(643);
    expect(f.control.closest('[inert]')).toBeNull();
  });

  it('uses the visible control fallback when the original record is no longer present', () => {
    const f = fixture();
    f.launcher.focus(); f.reader.open(); f.launcher.remove();
    f.reader.close();
    expect(document.activeElement).toBe(f.control);
  });

  it('restores focus when a compact launcher disappears as the native layout returns', () => {
    const f = fixture();
    f.launcher.focus(); f.reader.open(); f.control.focus();
    f.changed.mockImplementation(() => { if (f.host.hidden) f.control.hidden = true; });
    f.reader.close();
    expect(document.activeElement).toBe(f.launcher);
  });

  it('does not steal focus from an active Settings dialog', () => {
    const f = fixture();
    f.reader.open();
    const dialog = document.createElement('dialog');
    dialog.hidden = true;
    dialog.append(document.createElement('button'));
    document.body.append(dialog);
    const modal = createModal(dialog, { beforeOpen() {}, fallback: () => f.control, duration: () => 0, dismiss() {} });
    modal.open();
    f.body.innerHTML = '<h2>Reloaded page</h2>';
    f.reader.ensureFocus();
    expect(document.activeElement).toBe(dialog.querySelector('button'));
    modal.close(0);
  });

  it('opens legacy dialog fixtures nonmodally and restores prior hidden flow state', () => {
    const f = fixture(true);
    f.flow.hidden = true; f.flow.inert = true; f.flow.setAttribute('aria-hidden', 'true');
    const dialog = f.host as HTMLDialogElement;
    const show = vi.spyOn(dialog, 'show'), modal = vi.spyOn(dialog, 'showModal');
    f.reader.open();
    expect(show).toHaveBeenCalledOnce();
    expect(modal).not.toHaveBeenCalled();
    expect(activeModal()).toBeUndefined();
    f.reader.close();
    expect(dialog.open).toBe(false);
    expect(f.flow.hidden).toBe(true);
    expect(f.flow.inert).toBe(true);
    expect(f.flow.getAttribute('aria-hidden')).toBe('true');
  });
});
