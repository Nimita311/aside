import { clockSelection, formatStamp, formatTime } from './date-display';
import type { DateTimePreferences } from './preferences';
import { renderDateMarker } from './render';
import { resetReadoutPad } from './latch';

const SAMPLE = '2026-10-15T14:30:05';
let gutterKey: string | undefined;

// Localized month names and day periods can be wider than the base gutter.
// Measure with the real margin font and columns, once per locale, styles and zone.
export function refreshTimelineGutter(prefs: DateTimePreferences): void {
  const narrow = window.matchMedia('(max-width: 768px)').matches;
  const key = JSON.stringify([navigator.languages, prefs.timeFormat, prefs.dateFormat, prefs.timeStyle, new Intl.DateTimeFormat().resolvedOptions().timeZone, narrow]);
  if (key === gutterKey) return;
  const probe = document.createElement('div');
  probe.className = 'entry-margin';
  probe.setAttribute('aria-hidden', 'true');
  Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', width: 'max-content', margin: '0', pointerEvents: 'none' });
  const marker = renderDateMarker(SAMPLE.slice(0, 10), null, prefs);
  marker.classList.remove('is-first');
  const clock = document.createElement('span'); clock.className = 'em-time';
  probe.append(marker, clock); document.body.append(probe);
  const style = getComputedStyle(probe);
  const spacing = (parseFloat(style.columnGap) || 0) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  let width = 130;
  for (const month of ['01', '07']) for (const hour of ['00', '11', '23']) {
    clock.textContent = formatTime(`2026-${month}-15T${hour}:59:59`, prefs);
    width = Math.max(width, Math.ceil(marker.getBoundingClientRect().width + clock.getBoundingClientRect().width + spacing));
  }
  probe.remove();
  const root = document.documentElement;
  const layout = width > 220 || narrow ? 'stacked' : 'gutter';
  if (root.dataset.timelineLayout !== layout) resetReadoutPad();
  root.dataset.timelineLayout = layout;
  root.style.setProperty('--flow-gutter', `${layout === 'stacked' ? 16 : width}px`);
  gutterKey = key;
}

// The preview follows the same locale and preferences as the real displays.
export function refreshDateTimeSettings(prefs: DateTimePreferences): void {
  const clock = document.getElementById('setting-time-format') as HTMLSelectElement | null;
  const selected = clockSelection(prefs.timeFormat);
  if (clock && clock.value !== selected) clock.value = selected;
  const preview = document.getElementById('setting-date-time-preview');
  const text = formatStamp(SAMPLE, prefs);
  if (preview && preview.textContent !== text) preview.textContent = text;
}
