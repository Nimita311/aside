import type { AvailableInstance } from './backend';
import { entityIcon } from './render';

export const CALENDAR_OFF_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4a2 2 0 0 0-1 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 1.4-.6M21 17V6a2 2 0 0 0-2-2h-7M16 2v4M8 2v2M3 10h7m4 0h7M2 2l20 20"/></svg>';
export const WARNING_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></svg>';
export const WORKTREE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v12m12-9a6 6 0 0 1-6 6H6"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="3" r="3"/></svg>';

export function instanceGroup(instance: AvailableInstance): string {
  return JSON.stringify([instance.id, instance.worktree?.commonDir, instance.worktree?.primaryPath ?? instance.path]);
}

export function catalogueRows(instances: AvailableInstance[]) {
  const families = new Map<string, AvailableInstance[]>();
  for (const instance of instances) {
    const key = instanceGroup(instance), group = families.get(key) ?? [];
    group.push(instance); families.set(key, group);
  }
  return [...families.values()].sort((a, b) => Number(!!a[0].duplicatePaths?.length) - Number(!!b[0].duplicatePaths?.length))
    .flatMap(group => {
      // Path order keeps an orphan group's representative stable across edits
      // and discovery order changes. It remains a worktree for calendar policy.
      const ordered = [...group].sort((a, b) => Number(!!a.worktree?.linked) - Number(!!b.worktree?.linked) || a.path.localeCompare(b.path));
      return ordered.map((instance, index) => ({ instance, compact: index > 0 && !!instance.worktree?.linked }));
    });
}

export function instanceIdentity(instance: AvailableInstance, instances: AvailableInstance[], compact = false): HTMLElement {
  const identity = document.createElement('span'); identity.className = 'instance-identity';
  const icon = document.createElement('span'); icon.className = 'instance-type-icon';
  icon.innerHTML = instance.worktree?.linked ? WORKTREE_ICON : entityIcon('instance');
  identity.append(icon);
  const text = document.createElement('span'); text.className = 'instance-identity-text'; identity.append(text);
  const label = document.createElement('strong');
  label.textContent = compact ? instance.worktree!.label : instance.name || instance.id || 'Unavailable instance';
  text.append(label);
  const detail = (value: string) => { const span = document.createElement('span'); span.className = 'instance-checkout'; span.textContent = value; text.append(span); };
  if (!compact && instance.worktree) detail(instance.worktree.label);
  const ambiguousName = instances.some(other => other.path !== instance.path && (other.name || other.id) === (instance.name || instance.id) && instanceGroup(other) !== instanceGroup(instance));
  const ambiguousBranch = compact && instances.some(other => other.path !== instance.path && instanceGroup(other) === instanceGroup(instance) && other.worktree?.label === instance.worktree?.label);
  if ((!compact && (instance.duplicatePaths?.length || ambiguousName || instance.error)) || ambiguousBranch) detail(instance.path);
  return identity;
}

export function duplicateTooltip(instance: AvailableInstance, instances: AvailableInstance[]): string {
  const peers = new Map(instances.map(other => [other.path, other]));
  const paths = instance.duplicatePaths?.filter(path => path !== instance.path && (!peers.has(path) || instanceGroup(peers.get(path)!) !== instanceGroup(instance))) ?? [];
  return `Another instance uses ID '${instance.id}'. Calendar sync is paused for primary instances.${paths.length ? ` Conflicting paths: ${paths.join(', ')}.` : ''}`;
}

export function calendarTooltip(instance: AvailableInstance): string | undefined {
  return instance.worktree?.linked ? 'Calendar sync is disabled for Git worktrees.' : instance.calendarWarning || (instance.duplicatePaths?.length ? 'Calendar sync is paused because another instance uses this ID.' : undefined);
}

export function setInstanceTooltip(control: HTMLElement, text: string): void {
  control.dataset.instanceTooltip = text;
  control.setAttribute('aria-description', text);
}

// Shared by cards and the switcher. Native controls retain their normal focus
// order; hover and keyboard focus reveal the same explanation.
export function setupInstanceTooltips(): void {
  const tooltip = document.createElement('div'); tooltip.className = 'instance-tooltip'; tooltip.hidden = true;
  tooltip.id = 'instance-tooltip'; tooltip.setAttribute('role', 'tooltip'); document.body.append(tooltip);
  let current: HTMLElement | null = null;
  const hide = () => { current?.removeAttribute('aria-describedby'); current = null; tooltip.hidden = true; };
  const show = (target: EventTarget | null) => {
    const control = target instanceof Element ? target.closest<HTMLElement>('[data-instance-tooltip]') : null;
    if (!control) { hide(); return; }
    current?.removeAttribute('aria-describedby'); current = control;
    tooltip.textContent = control.dataset.instanceTooltip!; tooltip.hidden = false;
    control.setAttribute('aria-describedby', tooltip.id);
    const rect = control.getBoundingClientRect(), bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8))}px`;
    tooltip.style.top = `${rect.bottom + bounds.height + 8 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - bounds.height - 6)}px`;
  };
  document.addEventListener('mouseover', event => show(event.target));
  document.addEventListener('focusin', event => show(event.target));
  document.addEventListener('mouseout', event => { if (!(event.relatedTarget instanceof Node) || !current?.contains(event.relatedTarget)) hide(); });
  document.addEventListener('focusout', hide);
  document.addEventListener('click', hide);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  document.addEventListener('scroll', hide, true);
}
