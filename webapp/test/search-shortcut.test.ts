// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadApp } from './app-harness';

interface App { state: { searchShortcutEnabled: boolean } }
let app: App;
beforeAll(async () => {
  localStorage.setItem('searchShortcutEnabled', 'false');
  app = await loadApp<App>('state');
  expect(app.state.searchShortcutEnabled).toBe(false);
});
beforeEach(() => {
  document.body.innerHTML = '<input class="search-input"><button id="outside">Outside</button><textarea></textarea><select><option>One</option></select><div contenteditable="true" tabindex="0"></div>';
  app.state.searchShortcutEnabled = true;
  document.getElementById('outside')!.focus();
});
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

function slash(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true, ...init });
  document.activeElement!.dispatchEvent(event);
  return event;
}

describe('search character shortcut', () => {
  it('focuses search when enabled, including layouts that type slash with Shift', () => {
    expect(slash({ shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.search-input'));
  });
  it('leaves focus and the key untouched when disabled', () => {
    app.state.searchShortcutEnabled = false;
    expect(slash().defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('outside'));
  });
  it.each(['input', 'textarea', 'select', '[contenteditable]'])('preserves typing in %s', selector => {
    const editor = document.querySelector<HTMLElement>(selector)!; editor.focus();
    expect(slash().defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(editor);
  });
  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }])('does not intercept modifier or composition input %j', init => {
    expect(slash(init).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('outside'));
  });
  it('does not consume the shortcut when search is unavailable', () => {
    document.querySelector<HTMLInputElement>('.search-input')!.disabled = true;
    expect(slash().defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('outside'));
  });
});
