// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { renderPills } from '../elements/pills';

afterEach(() => document.body.replaceChildren());
const specimen = (root: HTMLElement, name: string) => root.querySelector<HTMLElement>(`[data-specimen="${name}"]`)!;

describe('production pill specimens', () => {
  it('retains native reference types, active states, linked hover, and accessible mark descriptions', () => {
    const root = renderPills(); document.body.append(root);
    for (const type of ['project', 'action', 'entry']) {
      const row = specimen(root, `reference-${type}`);
      expect(row.querySelector(`.tag-${type}`)).not.toBeNull();
      expect(row.querySelector(`.inline-tag-${type}`)).not.toBeNull();
      expect(row.querySelector(`.tag-${type}.is-active`)).not.toBeNull();
      expect(row.querySelector(`.tag-${type}.is-cohovered`)).not.toBeNull();
      expect(row.querySelector(`.tag-${type}`)?.closest('.rendered-content')).toBeNull();
      expect(row.querySelector(`.inline-tag-${type}`)?.closest('.rendered-content')).not.toBeNull();
    }
    expect(specimen(root, 'reference-artifact').querySelector('.artifact-link')).not.toBeNull();
    expect(specimen(root, 'reference-instance').querySelector('.entity-title .icon-instance')).not.toBeNull();
    expect(specimen(root, 'reference-instance').querySelector('.entity-title')?.closest('.rendered-content')).toBeNull();
    expect(specimen(root, 'reference-instance').querySelector('.entity-title-label')?.textContent).toBe('Studio');
    const iconStates = (row: HTMLElement, selector: string) => [...row.querySelectorAll(selector)].map(chip => chip.querySelector<SVGElement>(':scope > svg.entity-icon')?.dataset.state);
    expect(iconStates(specimen(root, 'reference-date'), '.inline-tag-date')).toEqual(['day', 'range', 'time']);
    const locations = specimen(root, 'reference-location');
    expect(iconStates(locations, '.inline-tag-location')).toEqual(['geo', 'geo', 'postal']);
    expect(locations.querySelector('.inline-tag-location.is-unresolved')?.tagName).toBe('SPAN');
    for (const chip of root.querySelectorAll<HTMLElement>('[aria-describedby]')) {
      for (const id of chip.getAttribute('aria-describedby')!.split(' ')) {
        expect(root.querySelector(`#${id}`)?.textContent?.trim()).toBeTruthy();
      }
    }
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (anchor.classList.contains('inline-tag-location')) {
        expect(new URL(anchor.href).origin).toBe('https://maps.apple.com');
        expect(anchor.target).toBe('_blank');
        continue;
      }
      expect(anchor.getAttribute('href')).toBe('#pills');
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      anchor.dispatchEvent(click); expect(click.defaultPrevented).toBe(true);
    }
  });

  it('shows actual lifecycle marks, composed deadline states, recurrence, and calendar exceptions', () => {
    const root = renderPills();
    const expected: Record<string, string[]> = {
      'project-open': [], 'project-ended': ['ended', 'closed'],
      'action-scheduled': [], 'action-backlog': ['backlog'], 'action-slipped': ['slipped'],
      'action-due': ['due'], 'action-overdue': ['overdue'], 'action-done': ['done', 'closed'],
      'action-cancelled': ['cancelled', 'closed'], 'action-due-backlog': ['due', 'backlog'],
      'action-overdue-backlog': ['overdue', 'backlog'], 'action-due-slipped': ['due', 'slipped'],
      'action-overdue-slipped': ['overdue', 'slipped'],
    };
    // The icon carries the lifecycle; a deadline rides the pill's ring instead.
    const icons: Record<string, string> = {
      'project-open': 'live', 'project-ended': 'ended',
      'action-scheduled': 'scheduled', 'action-backlog': 'backlog', 'action-slipped': 'slipped',
      'action-due': 'scheduled', 'action-overdue': 'scheduled', 'action-done': 'done',
      'action-cancelled': 'cancelled', 'action-due-backlog': 'backlog',
      'action-overdue-backlog': 'backlog', 'action-due-slipped': 'slipped',
      'action-overdue-slipped': 'slipped',
    };
    for (const [name, marks] of Object.entries(expected)) {
      const row = specimen(root, name);
      const chip = row.querySelector<HTMLElement>('a.tag')!;
      expect([...chip.classList].filter(value => value.startsWith('tag-status-')).sort(), name)
        .toEqual(marks.map(mark => `tag-status-${mark}`).sort());
      expect(row.querySelector('.status-pills .status-pill:not([hidden])'), name).not.toBeNull();
      expect(row.querySelector('.status-pills')?.closest('.rendered-content'), name).toBeNull();
      expect(chip.querySelectorAll('svg.entity-icon'), name).toHaveLength(1);
      expect(chip.querySelector<SVGElement>('svg.entity-icon')?.dataset.state, name).toBe(icons[name]);
    }
    expect(specimen(root, 'recurrence-template').querySelector('.status-pills')?.textContent).toContain('Recurrence template');
    expect(specimen(root, 'recurrence-template').querySelector<SVGElement>('a.tag svg.entity-icon')?.dataset.state).toBe('recurring');
    expect(specimen(root, 'recurrence-projected').querySelector('a.tag .pill')?.textContent).toBe('Projected');
    expect(specimen(root, 'recurrence-projected').querySelector('.status-pills')?.textContent).toContain('Projected');
    expect(specimen(root, 'calendar-exception').querySelector('.status-pill.pill-exception .tag-text')?.textContent).toBe('No calendar');
    expect(specimen(root, 'facts-zero').querySelectorAll('.summary-stat')).toHaveLength(3);
  });

  it('keeps the real compact group disclosure interactive and its controlled ID valid', () => {
    const root = renderPills(); document.body.append(root);
    for (const type of ['project', 'action']) {
      const group = specimen(root, `overflow-${type}`).querySelector<HTMLElement>('.tag-group')!;
      let button = group.querySelector<HTMLButtonElement>('.tag-bubble')!;
      expect(button.firstChild?.textContent).toBe('+2');
      expect(button.classList.contains('is-active')).toBe(true);
      expect(document.getElementById(button.getAttribute('aria-controls')!)).toBe(group);
      button.click();
      expect(group.querySelectorAll('a.tag')).toHaveLength(3);
      button = group.querySelector<HTMLButtonElement>('.tag-bubble')!;
      expect(button.getAttribute('aria-expanded')).toBe('true');
      button.click();
      expect(group.querySelectorAll('a.tag')).toHaveLength(1);
      expect(group.querySelector('.tag-bubble')?.getAttribute('aria-expanded')).toBe('false');
    }
  });
});
