// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dismissActionToast } from '../src/toast';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceChooser } from '../src/instance-chooser';
import type { AvailableInstance } from '../src/backend';
import type { RenderOptions } from '../src/render';

const work = { id: 'work', name: 'Work', path: '/instances/work' };
const copy = { ...work, path: '/instances/copy' };
const conflict = [work, copy].map((instance, index) => ({ ...instance, address: `work~${String(index).repeat(16)}`, duplicatePaths: [work.path, copy.path] }));
let chooser: InstanceChooser;

function setup(instances: AvailableInstance[] = [work], open?: (instance: AvailableInstance) => void) {
  const html = readFileSync('index.html', 'utf8');
  document.body.innerHTML = html.match(/<section id="instance-chooser"[\s\S]*?<\/section>/)![0];
  const root = document.querySelector<HTMLElement>('#instance-chooser')!;
  root.hidden = false;
  const fetch = vi.fn().mockResolvedValue(Response.json(instances));
  vi.stubGlobal('fetch', fetch);
  chooser = new InstanceChooser(root, undefined, open);
  return { root, fetch, add: root.querySelector<HTMLButtonElement>('#btn-add-instance')!, notice: root.querySelector('#instance-notice')! };
}

afterEach(() => { dismissActionToast(); chooser?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('instance chooser', () => {
  it('ignores an older chooser response after newer switcher discovery', async () => {
    const { root, fetch } = setup();
    let finish!: (response: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const pending = chooser.refresh();
    chooser.setCatalogue([{ ...work, name: 'Current name' }]);
    finish(Response.json([{ ...work, name: 'Old name' }])); await pending;
    expect(root.querySelector('strong')?.textContent).toBe('Current name');
    expect(root.querySelector('#instance-list')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('keeps status-control focus through a catalogue refresh', async () => {
    const { root } = setup(conflict); await chooser.refresh();
    root.querySelector<HTMLButtonElement>('.instance-duplicate-error')!.focus();
    await chooser.refresh();
    expect(document.activeElement).toBe(root.querySelector('.instance-duplicate-error'));
    root.querySelector<HTMLButtonElement>('.instance-calendar-icon')!.focus();
    await chooser.refresh();
    expect(document.activeElement).toBe(root.querySelector('.instance-calendar-icon'));
  });

  it('defers preference redraws until opening finishes, preserving loading and disabled controls', async () => {
    const { root } = setup(); await chooser.refresh(); vi.useFakeTimers();
    const opening = chooser.showOpening(work); vi.advanceTimersByTime(200);
    const spinner = root.querySelector('.instance-loading');
    chooser.redraw();
    expect(root.querySelector('.instance-loading')).toBe(spinner);
    expect(root.querySelector<HTMLButtonElement>('.instance-remove')!.disabled).toBe(true);
    opening.finish();
    expect(root.querySelector('.instance-loading')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('.instance-remove')!.disabled).toBe(false);
  });

  it('renders an orphan group with a stable full worktree row and promotes its remaining sibling after forgetting it', async () => {
    const checkout = { root: '/linked', commonDir: '/primary/.git', primaryPath: '/primary/data', linked: true, label: 'feature/a' };
    const a = { ...work, description: 'Daily log', path: '/a/data', worktree: checkout };
    const b = { ...a, path: '/b/data', worktree: { ...checkout, label: 'feature/b' } };
    const { root, fetch } = setup([b, a]); await chooser.refresh();
    const first = root.querySelector<HTMLElement>('.instance-row')!;
    expect(first.dataset.path).toBe(a.path); expect(first.classList.contains('instance-row-worktree')).toBe(false);
    expect(first.querySelector('.instance-description')?.textContent).toBe('Daily log');
    expect(first.querySelector('.instance-calendar-icon')?.getAttribute('aria-description')).toContain('disabled for Git worktrees');
    fetch.mockResolvedValueOnce(Response.json({ instances: [b] })); first.querySelector<HTMLButtonElement>('.instance-remove')!.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(1));
    expect(root.querySelector('.instance-description')?.textContent).toBe('Daily log');
    expect(root.querySelector('.instance-row-worktree')).toBeNull();
  });

  it('uses the existing summary facts and time preference, and opens status details independently of selection', async () => {
    const summary = { projects: { open: 2, total: 3 }, actions: { open: 4, total: 6 }, entries: 12, latest: '2026-10-06T16:42', lastEdited: new Date(2026, 9, 6, 16, 42, 37).toISOString() };
    const opts: RenderOptions = { now: '2026-10-07T10:00', nowDate: new Date(2026, 9, 7, 10), timeFormat: '12h', expandProjects: false, expandActions: false, activeFilter: null, resolveName: (_type, id) => id, onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(), routeHref: route => route, refMarks: () => [] };
    const instance = { ...conflict[0], summary };
    const open = vi.fn(), status = vi.fn(); const { root } = setup([instance], open);
    chooser.dispose(); chooser = new InstanceChooser(root, undefined, open, { renderOptions: () => opts, onStatus: status });
    await chooser.refresh();
    expect(root.querySelector('.summary-facts')?.textContent).toContain('2/34/612');
    expect(root.querySelector('.instance-date')?.textContent).toContain('4:42 PM');
    root.querySelector<HTMLButtonElement>('.instance-duplicate-error')!.click();
    expect(status).toHaveBeenCalledWith(instance); expect(open).not.toHaveBeenCalled();
    opts.timeFormat = '24h'; chooser.redraw(); expect(root.querySelector('.instance-date')?.textContent).toContain('16:42');
    opts.dateFormat = 'full'; opts.timeStyle = 'full'; chooser.redraw();
    expect(root.querySelector('.instance-date time')?.textContent).toBe('Tuesday, October 6, 2026');
    expect(root.querySelector('.instance-date > span')?.textContent).toContain('16:42:37');
    expect(root.querySelector<HTMLElement>('.instance-date')?.title).toContain('Tuesday, October 6, 2026');
    expect(root.querySelector<HTMLElement>('.instance-date')?.title).toContain('16:42:37');
  });
  it('groups linked worktrees beneath their primary with informative labels and selectable links', async () => {
    const checkout = { root: '/repo', commonDir: '/repo/.git', primaryPath: work.path, linked: false, label: 'main' };
    const primary = { ...work, worktree: checkout };
    const linked = { ...copy, address: 'work~1111111111111111', worktree: { ...checkout, linked: true, label: 'Detached copy' } };
    const personal = { id: 'personal', path: '/instances/personal' };
    const { root } = setup([linked, personal, primary]);
    await chooser.refresh();
    const rows = [...root.querySelectorAll<HTMLElement>('.instance-row')];
    expect(rows.map(row => row.dataset.path)).toEqual([work.path, copy.path, personal.path]);
    expect(rows[0].querySelector('.instance-checkout')?.textContent).toBe('main');
    expect(rows[1].classList.contains('instance-row-worktree')).toBe(true);
    expect(rows[1].querySelector('strong')?.textContent).toBe('Detached copy');
    expect(rows[1].querySelector('a')?.getAttribute('href')).toBe('/work~1111111111111111/');
    expect(root.querySelector('.instance-duplicate-error')).toBeNull();
  });
  it('opens ordinary clicks in place and preserves modified link navigation', async () => {
    const open = vi.fn(); const { root } = setup([work], open);
    await chooser.refresh();
    const link = root.querySelector('a.instance-open')!;
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, [modifier]: true });
      link.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith(work);
  });

  it('cancels fast loading, superseded card timers and late completion', async () => {
    const personal = { id: 'personal', path: '/instances/personal' };
    const { root } = setup([work, personal]); await chooser.refresh(); vi.useFakeTimers();
    const fast = chooser.showOpening(work); fast.finish();
    vi.advanceTimersByTime(250); expect(root.querySelector('.instance-row [role="status"]')).toBeNull();
    const old = chooser.showOpening(work); vi.advanceTimersByTime(100);
    const next = chooser.showOpening(personal); old.fail(new Error('Old failure'));
    expect(document.querySelector('#action-toast')).toBeNull();
    vi.advanceTimersByTime(200);
    expect(root.querySelector('[data-path="/instances/work"] [role]')).toBeNull();
    expect(root.querySelector('[data-path="/instances/personal"] [role="status"]')?.textContent).toBe('Loading instance…');
    old.finish(); expect(root.querySelector('.instance-row [role="status"]')).not.toBeNull();
    next.finish(); expect(root.querySelector('.instance-row [role]')).toBeNull();
    const closed = chooser.showOpening(work); chooser.dispose();
    vi.advanceTimersByTime(250); closed.fail(new Error('Closed')); expect(root.querySelector('.instance-row [role]')).toBeNull();
  });

  it('keeps duplicate IDs selectable with suffixed links and a calendar warning', async () => {
    const personal = { id: 'personal', name: 'Work', path: '/instances/personal' };
    const invalid = { id: '', name: 'Missing ID', path: '/instances/invalid', error: 'aside.md needs a valid instance id.' };
    const { root } = setup([conflict[0], personal, conflict[1], invalid]);
    await chooser.refresh();
    const rows = [...root.querySelectorAll<HTMLElement>('.instance-row')];
    expect(rows.map(row => row.dataset.path)).toEqual([personal.path, invalid.path, work.path, copy.path]);
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/personal/');
    expect(rows[1].classList.contains('instance-row-duplicate')).toBe(false);
    for (const row of rows.slice(2)) {
      expect(row.classList.contains('instance-row-duplicate')).toBe(false);
      expect(row.querySelector('a')?.getAttribute('href')).toMatch(/^\/work~[01]{16}\/$/);
      expect(row.querySelector('.instance-duplicate-error')?.textContent).toBe('work');
      expect(row.querySelector<HTMLButtonElement>('.instance-remove')?.disabled).toBe(false);
    }
  });

  it('keeps focus on the same path when resolving a duplicate moves its card up', async () => {
    const personal = { id: 'personal', path: '/instances/personal' };
    const { root, fetch } = setup([conflict[0], personal, conflict[1]]);
    await chooser.refresh();
    root.querySelector<HTMLButtonElement>(`[data-path="${work.path}"] .instance-remove`)!.focus();
    fetch.mockResolvedValueOnce(Response.json([work, personal]));
    await chooser.refresh();
    expect(root.querySelector<HTMLElement>('.instance-row')?.dataset.path).toBe(work.path);
    expect(document.activeElement).toBe(root.querySelector(`[data-path="${work.path}"] .instance-remove`));
    expect(root.querySelector('.instance-row-duplicate')).toBeNull();
  });

  it('removes one conflicting path and opens the remaining instance', async () => {
    const { root, fetch } = setup(conflict);
    await chooser.refresh();
    expect(root.querySelectorAll('a')).toHaveLength(2);
    const remove = root.querySelector<HTMLButtonElement>('.instance-remove')!;
    expect(remove.textContent).toBe('');
    expect(remove.getAttribute('aria-label')).toBe('Forget Work at /instances/work');
    expect(remove.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    remove.focus();
    fetch.mockResolvedValueOnce(Response.json({ instances: [copy] }));
    remove.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(1));
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/-/api/instances/remove');
    expect(JSON.parse(fetch.mock.calls.at(-1)?.[1].body)).toEqual({ path: work.path });
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/work/');
    expect(root.querySelector('.instance-error')).toBeNull();
    expect(document.activeElement).toBe(root.querySelector('.instance-remove'));
  });

  it('returns focus to Add instance after the last row is removed', async () => {
    const { root, fetch, add, notice } = setup();
    await chooser.refresh();
    const remove = root.querySelector<HTMLButtonElement>('.instance-remove')!;
    remove.focus();
    fetch.mockResolvedValueOnce(Response.json({ instances: [] }));
    remove.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(0));
    expect(document.activeElement).toBe(add);
    expect(notice.textContent).toContain('No instances yet.');
  });

  it('keeps cancellation silent and ignores focus refresh while the dialog is open', async () => {
    const { root, fetch, add, notice } = setup([]);
    await chooser.refresh();
    const before = notice.textContent;
    let finish!: (value: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    add.click();
    root.querySelector<HTMLButtonElement>('#btn-browse-instance')!.click();
    expect(add.disabled).toBe(true);
    expect(notice.textContent).toBe(before);
    window.dispatchEvent(new Event('focus'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ kind: 'directory' });
    finish(Response.json({ path: null }));
    await vi.waitFor(() => expect(add.disabled).toBe(false));
    expect(notice.textContent).toBe(before);
    expect(root.textContent).not.toMatch(/native picker|Selection cancelled|Add directory|Add aside\.md|Refresh/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shows an added instance without a manual refresh', async () => {
    const { root, fetch, add } = setup([]);
    await chooser.refresh();
    fetch.mockResolvedValueOnce(Response.json({ path: work.path })).mockResolvedValueOnce(Response.json({ instance: work })).mockResolvedValueOnce(Response.json([work]));
    add.click();
    root.querySelector<HTMLButtonElement>('#btn-browse-instance')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLInputElement>('#instance-add-path')!.value).toBe(work.path));
    expect(root.querySelector('a')).toBeNull();
    await vi.waitFor(() => expect(add.disabled).toBe(false));
    root.querySelector<HTMLFormElement>('#instance-add-form')!.requestSubmit();
    await vi.waitFor(() => expect(root.querySelector('a')?.getAttribute('href')).toBe('/work/'));
    expect(add.disabled).toBe(false);
  });

  it('adds an entered path, then closes the form and restores focus', async () => {
    const { root, fetch, add } = setup([]);
    await chooser.refresh();
    add.click();
    const form = root.querySelector<HTMLFormElement>('#instance-add-form')!;
    const input = root.querySelector<HTMLInputElement>('#instance-add-path')!;
    expect(form.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(add.getAttribute('aria-expanded')).toBe('true');
    input.value = '  ~/Aside work/aside.md  ';
    fetch.mockResolvedValueOnce(Response.json({ instance: work })).mockResolvedValueOnce(Response.json([work]));
    form.requestSubmit();
    await vi.waitFor(() => expect(form.hidden).toBe(true));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ path: '~/Aside work/aside.md' });
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(add);
    expect(add.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a failed path editable and reports the failure in a toast', async () => {
    const { root, fetch, add } = setup();
    await chooser.refresh();
    add.click();
    const form = root.querySelector<HTMLFormElement>('#instance-add-form')!;
    const input = root.querySelector<HTMLInputElement>('#instance-add-path')!;
    input.value = '/missing';
    fetch.mockResolvedValueOnce(Response.json({ error: 'Not an instance' }, { status: 400 }));
    form.requestSubmit();
    await vi.waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(form.hidden).toBe(false);
    expect(input.value).toBe('/missing');
    expect(input.disabled).toBe(false);
    expect(root.querySelector('#instance-add-error')?.textContent).toBe('');
    expect(document.querySelector('#action-toast')?.textContent).toContain('Enter the full path');
    input.dispatchEvent(new Event('input'));
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(root.querySelector('#instance-add-error')?.textContent).toBe('');
  });

  it('validates an empty path locally and cancels the form with Escape', async () => {
    const { root, fetch, add } = setup();
    await chooser.refresh();
    add.click();
    const form = root.querySelector<HTMLFormElement>('#instance-add-form')!;
    const input = root.querySelector<HTMLInputElement>('#instance-add-path')!;
    form.requestSubmit();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(form.hidden).toBe(true);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(document.activeElement).toBe(add);
  });

  it('finishes initial discovery when an overlapping add dialog is cancelled', async () => {
    const { root, fetch, add, notice } = setup();
    let finish!: (value: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const initial = chooser.refresh();
    fetch.mockResolvedValueOnce(Response.json({ path: null })).mockResolvedValueOnce(Response.json([work]));
    add.click();
    root.querySelector<HTMLButtonElement>('#btn-browse-instance')!.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(1));
    finish(Response.json([]));
    await initial;
    expect(notice.textContent).toBe('');
    expect(root.querySelectorAll('.instance-row')).toHaveLength(1);
  });

  it('does not pull focus back when the user moves away during removal', async () => {
    const { root, fetch } = setup();
    await chooser.refresh();
    let finish!: (value: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const outside = document.createElement('button');
    document.body.append(outside);
    const remove = root.querySelector<HTMLButtonElement>('.instance-remove')!;
    remove.focus(); remove.click(); outside.focus();
    finish(Response.json({ instances: [] }));
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(0));
    expect(document.activeElement).toBe(outside);
  });

  it('preserves focus moved to another card while removal is pending', async () => {
    const personal = { id: 'personal', path: '/instances/personal' };
    const { root, fetch } = setup([work, personal]);
    await chooser.refresh();
    let finish!: (value: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const remove = root.querySelector<HTMLButtonElement>('.instance-remove')!;
    remove.focus(); remove.click();
    root.querySelector<HTMLAnchorElement>('a[href="/personal/"]')!.focus();
    finish(Response.json({ instances: [personal] }));
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(1));
    expect(document.activeElement).toBe(root.querySelector('a[href="/personal/"]'));
  });

  it('preserves the row when removal fails and lets the user retry', async () => {
    const { root, fetch, notice } = setup();
    await chooser.refresh();
    const remove = root.querySelector<HTMLButtonElement>('.instance-remove')!;
    fetch.mockResolvedValueOnce(Response.json({ error: 'Disk is unavailable' }, { status: 500 }));
    remove.click();
    await vi.waitFor(() => expect(document.querySelector('#action-toast')?.textContent).toContain('Could not forget'));
    expect(notice.textContent).toBe('');
    expect(root.querySelectorAll('.instance-row')).toHaveLength(1);
    expect(remove.disabled).toBe(false);
    fetch.mockResolvedValueOnce(Response.json({ instances: [] }));
    remove.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(0));
  });

  it('refreshes on focus without losing keyboard focus and skips hidden chooser refreshes', async () => {
    const { root, fetch } = setup();
    await chooser.refresh();
    const link = root.querySelector<HTMLAnchorElement>('a')!;
    link.focus();
    fetch.mockResolvedValueOnce(Response.json([{ ...work, name: 'Renamed' }, { id: 'home', path: '/instances/home' }]));
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(2));
    expect(document.activeElement).toBe(root.querySelector('a'));
    expect(document.activeElement?.textContent).toContain('Renamed');
    root.hidden = true;
    window.dispatchEvent(new Event('focus'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('discards an old catalogue response that finishes after a removal', async () => {
    const { root, fetch } = setup();
    await chooser.refresh();
    let finish!: (value: Response) => void;
    fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const refreshing = chooser.refresh();
    fetch.mockResolvedValueOnce(Response.json({ instances: [] }));
    root.querySelector<HTMLButtonElement>('.instance-remove')!.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(0));
    finish(Response.json([work]));
    await refreshing;
    expect(root.querySelectorAll('.instance-row')).toHaveLength(0);
    expect(root.querySelector('#instance-list')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('keeps automatic catalogue failures quiet and toasts a failed user retry', async () => {
    const { root, fetch, notice } = setup();
    fetch.mockRejectedValueOnce(new Error('Offline'));
    await chooser.refresh();
    const retry = root.querySelector<HTMLButtonElement>('#btn-retry-instances')!;
    expect(retry.hidden).toBe(false);
    expect(notice.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('#action-toast')).toBeNull();
    fetch.mockRejectedValueOnce(new Error('Still offline'));
    retry.click();
    await vi.waitFor(() => expect(document.querySelector('#action-toast')?.textContent).toBe('Could not load your instances. Try again.'));
    retry.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.instance-row')).toHaveLength(1));
    expect(retry.hidden).toBe(true);
    expect(notice.textContent).toBe('');
  });
});
