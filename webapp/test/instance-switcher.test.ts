// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceSwitcher } from '../src/instance-switcher';
import type { AvailableInstance } from '../src/backend';

const checkout = { root: '/primary', commonDir: '/primary/.git', primaryPath: '/primary/data', linked: false, label: 'main' };
const primary = { id: 'work', name: 'Work', description: 'Daily log', path: '/primary/data', worktree: checkout };
const linked = { ...primary, path: '/picker/data', address: 'work~1111111111111111', worktree: { ...checkout, root: '/picker', linked: true, label: 'feature/picker' } };
const sibling = { ...linked, path: '/review/data', address: 'work~2222222222222222', worktree: { ...linked.worktree, label: 'feature/review' } };
let switcher: InstanceSwitcher;
afterEach(() => { switcher?.dispose(); document.body.replaceChildren(); });

function setup(instances: AvailableInstance[] = [primary, linked, sibling]) {
  document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  const root = document.querySelector<HTMLElement>('#instance-switcher')!;
  const select = vi.fn(), all = vi.fn(), request = vi.fn().mockResolvedValue(instances);
  switcher = new InstanceSwitcher(root, select, all, request);
  switcher.setCatalogue(instances); switcher.setActive(linked);
  return { root, select, all, request, trigger: root.querySelector<HTMLButtonElement>('#btn-instance-switch')!, search: root.querySelector<HTMLInputElement>('#instance-switch-search')! };
}

describe('instance switcher', () => {
  it('selects a focused option with Space while allowing spaces in search', () => {
    const { root, trigger, search, select } = setup(); trigger.click();
    const typing = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }); search.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
    const row = root.querySelector<HTMLAnchorElement>(`[data-path="${sibling.path}"]`)!;
    row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(select).toHaveBeenCalledWith(sibling);
  });

  it('keeps full title and description on the representative and compact branches on children', () => {
    const { root, trigger } = setup(); trigger.click();
    const rows = [...root.querySelectorAll<HTMLAnchorElement>('.instance-menu-item')];
    expect(rows.map(row => row.dataset.path)).toEqual([primary.path, linked.path, sibling.path]);
    expect(rows[0].textContent).toContain('WorkmainDaily log');
    expect(rows[1].querySelector('strong')?.textContent).toBe('feature/picker');
    expect(rows[1].querySelector('.instance-description')).toBeNull();
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
    expect(rows[0].querySelector('.instance-menu-calendar svg')).toBeNull();
    expect(rows[1].querySelector('.instance-menu-calendar svg')).not.toBeNull();
  });

  it('gives an orphan worktree the full row and retains that group context when searching a sibling', () => {
    const { root, trigger, search } = setup([sibling, linked]); trigger.click();
    expect(root.querySelector('.instance-menu-item')?.getAttribute('data-path')).toBe(linked.path);
    expect(root.querySelector('.instance-description')?.textContent).toBe('Daily log');
    search.value = 'feature/review'; search.dispatchEvent(new Event('input'));
    expect(root.querySelectorAll('.instance-menu-item')).toHaveLength(2);
    switcher.setCatalogue([primary, linked, sibling]);
    expect(root.querySelector('.instance-menu-item')?.getAttribute('data-path')).toBe(primary.path);
    expect(root.querySelector('.instance-switch-trigger')?.textContent).toContain('feature/picker');
  });

  it('selects exact worktree addresses without changing modified-click navigation', () => {
    const { root, trigger, select } = setup(); trigger.click();
    const row = root.querySelector<HTMLAnchorElement>(`[data-path="${sibling.path}"]`)!;
    expect(row.getAttribute('href')).toBe(`/${sibling.address}/`);
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }); row.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false); expect(select).not.toHaveBeenCalled();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true }); row.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); expect(select).toHaveBeenCalledWith(sibling);
    expect(root.querySelector<HTMLElement>('#instance-switch-menu')!.hidden).toBe(true);
  });

  it('shows one ID marker per group and explains the external conflicting path', () => {
    const copy = { id: 'work', name: 'Work', path: '/copy', description: 'Copy' };
    const instances = [primary, linked, copy].map(instance => ({ ...instance, duplicatePaths: [primary.path, linked.path, copy.path] }));
    const { root, trigger } = setup(instances); trigger.click();
    expect(root.querySelectorAll('.instance-duplicate-error')).toHaveLength(2);
    const warning = root.querySelector<HTMLElement>('.instance-duplicate-error')!;
    expect(warning.textContent).toBe('work'); expect(warning.dataset.instanceTooltip).toContain('/copy');
    expect(warning.dataset.instanceTooltip).not.toContain(linked.path);
  });

  it('supports arrow navigation, Escape focus restoration, and ignores late discovery after closing', async () => {
    const { root, trigger, search, request } = setup();
    let finish!: (instances: AvailableInstance[]) => void;
    request.mockReturnValueOnce(new Promise<AvailableInstance[]>(resolve => { finish = resolve; }));
    trigger.click(); expect(document.activeElement).toBe(search);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.path).toBe(primary.path);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(trigger);
    finish([]); await Promise.resolve();
    expect(root.querySelector<HTMLElement>('#instance-switch-menu')!.hidden).toBe(true);
    expect(trigger.textContent).toContain('Work');
  });
});
