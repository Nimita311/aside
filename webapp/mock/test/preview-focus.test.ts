// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { deferPreviewFocus } from '../preview-focus';

let release: (() => void) | undefined;
afterEach(() => { release?.(); release = undefined; document.body.replaceChildren(); });

describe('hidden preview focus', () => {
  it('keeps keyboard input with the current control until the new frame is revealed', () => {
    document.body.innerHTML = '<input id="catalogue"><input id="preview">';
    const catalogue = document.getElementById('catalogue')!;
    const preview = document.getElementById('preview')!;
    catalogue.focus();
    release = deferPreviewFocus();
    preview.focus();
    expect(document.activeElement).toBe(catalogue);
    release(); release = undefined;
    expect(document.activeElement).toBe(preview);
  });

  it('defers native dialog autofocus and restores ordinary focus after reveal', () => {
    document.body.innerHTML = '<input id="catalogue"><dialog><button>Close</button></dialog>';
    const catalogue = document.getElementById('catalogue')!;
    const dialog = document.querySelector('dialog')!;
    const close = dialog.querySelector('button')!;
    catalogue.focus();
    release = deferPreviewFocus();
    dialog.showModal();
    close.focus();
    expect(dialog.open).toBe(true);
    expect(dialog.inert).toBe(false);
    expect(document.activeElement).toBe(catalogue);
    release(); release = undefined;
    expect(document.activeElement).toBe(close);
    dialog.close(); catalogue.focus();
    expect(document.activeElement).toBe(catalogue);
  });

  it('discards a queued control that was removed during setup', () => {
    document.body.innerHTML = '<input id="catalogue"><input id="preview">';
    const catalogue = document.getElementById('catalogue')!;
    const preview = document.getElementById('preview')!;
    catalogue.focus();
    release = deferPreviewFocus();
    preview.focus(); preview.remove();
    release(); release = undefined;
    expect(document.activeElement).toBe(catalogue);
  });
});
