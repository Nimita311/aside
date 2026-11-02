// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadApp } from './app-harness';
import type { DateTimePreferences } from '../src/preferences';

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-GB']);
  document.body.innerHTML = readFileSync('index.html', 'utf8').match(/<dialog class="modal-backdrop"[\s\S]*?<\/dialog>/)![0];
});
afterEach(() => { localStorage.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); });
type App = { state: DateTimePreferences; setupDateTimeSettings(): void };
function select(id: string, value: string): void {
  const input = document.getElementById(id) as HTMLSelectElement;
  input.value = value; input.dispatchEvent(new Event('change'));
}

describe('date and time settings', () => {
  it('uses a localized preview with plain option labels and persists independent choices', async () => {
    const app = await loadApp<App>('state, setupDateTimeSettings');
    app.setupDateTimeSettings();
    expect(app.state).toMatchObject({ dateFormat: 'medium', timeStyle: 'short', timeFormat: 'locale' });
    expect(document.getElementById('setting-date-time-preview')?.textContent).toBe('15 Oct 2026, 14:30');
    expect([...document.querySelectorAll('#setting-date-format option')].map(option => option.textContent)).toEqual(['Short', 'Medium', 'Long', 'Full', 'ISO']);
    select('setting-time-format', '12h');
    expect([...document.querySelectorAll('#setting-time-style option')].map(option => option.textContent)).toEqual(['Short', 'Medium', 'Long', 'Full']);
    expect([...document.querySelectorAll('#setting-time-format option')].map(option => option.textContent)).toEqual(['12-hour', '24-hour']);
    select('setting-date-format', 'iso'); select('setting-time-style', 'medium');
    expect(document.getElementById('setting-date-time-preview')?.textContent).toBe('2026-10-15 02:30:05 pm');
    expect(localStorage.getItem('timeFormat')).toBe('12h');
    expect(localStorage.getItem('dateFormat')).toBe('iso');
    expect(localStorage.getItem('timeStyle')).toBe('medium');
    const reloaded = await loadApp<App>('state, setupDateTimeSettings');
    reloaded.setupDateTimeSettings();
    expect(reloaded.state).toMatchObject({ dateFormat: 'iso', timeStyle: 'medium', timeFormat: '12h' });
    expect((document.getElementById('setting-date-format') as HTMLSelectElement).value).toBe('iso');
  });
  it.each([['en-US', '12h'], ['en-GB', '24h']] as const)('selects the %s locale clock without a default option or saved override', async (locale, clock) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([locale]);
    const app = await loadApp<App>('state, setupDateTimeSettings'); app.setupDateTimeSettings();
    expect((document.getElementById('setting-time-format') as HTMLSelectElement).value).toBe(clock);
    expect(localStorage.getItem('timeFormat')).toBeNull();
    expect(document.querySelector('#setting-time-format option[value="locale"]')).toBeNull();
  });
  it.each(['12h', '24h'])('retains an existing %s clock choice on upgrade', async clock => {
    localStorage.setItem('timeFormat', clock);
    const app = await loadApp<App>('state, setupDateTimeSettings'); app.setupDateTimeSettings();
    expect(app.state.timeFormat).toBe(clock);
    expect((document.getElementById('setting-time-format') as HTMLSelectElement).value).toBe(clock);
  });
});
