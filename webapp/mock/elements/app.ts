import icons from 'mock:icons';
import { renderPills } from './pills';
import { showNotice } from '../../src/notice';
import { showActionFailure } from '../../src/toast';
import { setupInstanceTooltips, setInstanceTooltip, CALENDAR_OFF_ICON } from '../../src/instance-catalogue';

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element specimen: ${id}`);
  return element;
};
const text = (tag: string, value: string, className?: string): HTMLElement => {
  const element = document.createElement(tag); element.textContent = value;
  if (className) element.className = className;
  return element;
};

document.documentElement.dataset.theme = localStorage.getItem('darkMode') === 'true' ? 'dark' : 'light';

for (const icon of icons) {
  const item = document.createElement('li'); item.className = 'element-icon'; item.dataset.icon = icon.id;
  item.title = icon.label; item.tabIndex = 0;
  const glyphs = document.createElement('div'); glyphs.className = 'element-icon-glyphs'; glyphs.setAttribute('aria-hidden', 'true');
  glyphs.innerHTML = icon.svg;
  item.append(glyphs, text('span', icon.label, 'element-sr-only'));
  $('icon-list').append(item);
}

$('pill-specimens').append(renderPills());

for (const [label, disabled] of [['Settings', false], ['Add instance', false], ['Close', false], ['Settings', true]] as const) {
  const icon = icons.find(item => item.label.toLowerCase() === label.toLowerCase())
    ?? icons.find(item => item.label.toLowerCase().includes(label.toLowerCase()));
  if (!icon) continue;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'btn-icon'; button.disabled = disabled;
  button.setAttribute('aria-label', `${label}${disabled ? ' (disabled specimen)' : ' specimen'}`); button.title = label;
  button.innerHTML = icon.svg; button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  $('icon-buttons').append(button);
}

const calendarStates = [
  ['Default', ''], ['Today', 'is-today'], ['Selected', 'is-selected'],
  ['Viewing', 'is-current'], ['Combined', 'is-today is-selected is-current'],
] as const;
for (const [label, classes] of calendarStates) {
  const sample = document.createElement('div'); sample.className = 'element-calendar-state';
  const button = text('button', '18', `cal-day ${classes}`) as HTMLButtonElement; button.type = 'button';
  button.setAttribute('aria-label', `October 18 · ${label.toLowerCase()}`);
  if (classes.includes('is-today')) button.setAttribute('aria-current', 'date');
  button.setAttribute('aria-pressed', String(classes.includes('is-selected')));
  sample.append(button, text('span', label, 'element-label')); $('calendar-states').append(sample);
}
for (const button of document.querySelectorAll<HTMLButtonElement>('.date-jump-unit')) {
  button.addEventListener('click', () => {
    for (const sibling of document.querySelectorAll('.date-jump-unit')) {
      sibling.classList.toggle('is-active', sibling === button);
      sibling.setAttribute('aria-pressed', String(sibling === button));
    }
  });
}

for (const [kind, message, description] of [
  ['loading', 'Loading workspace…', 'Your records are on their way.'],
  ['warning', 'Calendar access is unavailable.', 'Your records remain readable.'],
  ['error', 'Could not load this file.', 'Try again when the connection is restored.'],
] as const) {
  const host = document.createElement('div'); host.dataset.specimen = `notice-${kind}`;
  const retry = text('button', 'Retry') as HTMLButtonElement; retry.type = 'button';
  retry.addEventListener('click', () => showActionFailure('Could not complete that action. Try again.'));
  showNotice(host, { kind, message, description,
    ...(kind === 'error' ? { details: 'The requested file is temporarily unavailable.', actions: [retry] } : {}),
  });
  $('notice-specimens').append(host);
}
$('preview-toast').addEventListener('click', () => showActionFailure('Could not complete that action. Try again.'));
$('tooltip-trigger').innerHTML = CALENDAR_OFF_ICON;
setInstanceTooltip($('tooltip-trigger'), 'Calendar sync is disabled for Git worktrees.');
setupInstanceTooltips();

for (const [label, token] of [
  ['Background', 'bg'], ['Secondary surface', 'bg-secondary'], ['Text', 'text'], ['Secondary text', 'text-secondary'],
  ['Accent', 'accent'], ['Project', 'tag-project-fg'], ['Project field', 'tag-project-bg'],
  ['Action', 'tag-action-fg'], ['Action field', 'tag-action-bg'], ['Neutral field', 'tag-entry-bg'],
  ['Due', 'status-due'], ['Overdue', 'status-overdue'], ['Border', 'border'], ['Subtle border', 'border-subtle'],
] as const) {
  const item = document.createElement('li'); item.title = `${label} · --color-${token}`; item.tabIndex = 0;
  const swatch = document.createElement('span'); swatch.className = 'element-swatch'; swatch.style.backgroundColor = `var(--color-${token})`; swatch.setAttribute('aria-hidden', 'true');
  item.append(swatch, text('span', label, 'element-sr-only')); $('color-tokens').append(item);
}
const style = getComputedStyle(document.documentElement);
for (const size of ['xs', 'sm', 'base', 'md', 'lg', 'xl']) {
  const row = document.createElement('div'); row.className = 'element-type-row';
  const example = text('span', 'Aa');
  example.style.fontSize = `var(--font-size-${size})`; example.style.lineHeight = `var(--line-height-${size})`;
  const label = `${style.getPropertyValue(`--font-size-${size}`).trim()} / ${style.getPropertyValue(`--line-height-${size}`).trim()}`;
  row.title = label; row.append(example, text('span', label, 'element-sr-only'));
  $('type-tokens').append(row);
}
for (const [label, token] of [['Small', 'sm'], ['Medium', 'md'], ['Large', 'lg'], ['Pill', 'pill']]) {
  const sample = document.createElement('div'); sample.className = 'element-radius';
  const box = document.createElement('span'); box.className = 'element-radius-box'; box.style.borderRadius = `var(--radius-${token})`; box.setAttribute('aria-hidden', 'true');
  sample.append(box, text('span', label, 'element-label')); $('radius-tokens').append(sample);
}
$('element-gallery').dataset.ready = 'true';
