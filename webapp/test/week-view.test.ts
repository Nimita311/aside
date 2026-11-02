// @vitest-environment happy-dom
import { dismissActionToast } from '../src/toast';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWeekView } from '../src/week-view';
import { fileDiagnosticNotice } from '../src/diagnostics';
import { Store } from '../lib/store';
import type { DataSource } from '../lib/io';
import type { Entry } from '../lib/types';
const entry: Entry = { meta: { created: '2026-05-22T15:30' }, weekFile: '2026-05-18', content: 'Recovered note' };
afterEach(() => { dismissActionToast(); document.body.replaceChildren(); });
function view(read: () => Promise<Entry[]>, current = () => true, focusFallback = () => null as HTMLElement | null) {
  const settled = vi.fn();
  const week = createWeekView('2026-05-18', { read, current, settled, focusFallback, render: (entries, host) => {
    for (const item of entries) {
      const card = document.createElement('article'); card.dataset.entryId = item.meta.created;
      const time = document.createElement('a'); time.href = `/work/${item.meta.created}`; time.className = 'em-time'; time.textContent = '15:30';
      card.append(time, item.content); host.append(card);
    }
  } });
  document.body.append(week.host);
  return { week, settled };
}
describe('retryable weekly gaps', () => {
  it('keeps a muted chronological gap, continues older history, and repairs it without duplicates', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue([entry]);
    const { week } = view(read);
    await week.load();
    const older = document.createElement('article'); older.textContent = 'Older history';
    const end = document.createElement('p'); end.textContent = 'The End'; document.body.append(older, end);
    expect(week.status()).toBe('failed');
    expect(document.querySelector('#action-toast')).toBeNull();
    expect(week.host.querySelector('summary')?.textContent).toContain('May 18, 2026');
    expect(week.host.textContent).toContain('HTTP 503');
    expect(week.host.querySelector('button')?.getAttribute('aria-label')).toBe('Retry week of May 18, 2026');
    await week.load(true); await week.load();
    expect(week.status()).toBe('loaded'); expect(read).toHaveBeenCalledTimes(2);
    expect(week.host.querySelectorAll('[data-entry-id]')).toHaveLength(1);
    expect(week.host.nextSibling).toBe(older); expect(end.textContent).toBe('The End');
  });
  it('keeps already recovered content visible when an explicit reload fails', async () => {
    const read = vi.fn().mockResolvedValueOnce([entry]).mockRejectedValue(new Error('Offline'));
    const { week } = view(read); await week.load(); await week.load(true);
    expect(week.status()).toBe('failed');
    expect(week.host.querySelectorAll('[data-entry-id]')).toHaveLength(1);
    expect(week.host.textContent).toContain('Recovered note'); expect(week.host.textContent).toContain('Offline');
    expect(document.querySelector('#action-toast')?.textContent).toBe('Could not load this week. Try again.');
  });
  it('keeps background navigation retries quiet after a previous user action', async () => {
    const { week } = view(vi.fn().mockRejectedValue(new Error('Offline')));
    await week.load(false, true);
    expect(document.querySelector('#action-toast')?.textContent).toContain('Could not load this week');
    dismissActionToast();
    await week.load(true, false);
    expect(document.getElementById('action-toast')?.hidden).toBe(true);
  });
  it('coalesces rapid retries and discards stale navigation results', async () => {
    let finish!: (entries: Entry[]) => void;
    let current = true;
    const read = vi.fn(() => new Promise<Entry[]>(resolve => { finish = resolve; }));
    const { week, settled } = view(read, () => current);
    const first = week.load(); expect(week.load(true)).toBe(first);
    current = false; finish([entry]); await first;
    expect(read).toHaveBeenCalledOnce(); expect(week.host.textContent).toBe(''); expect(settled).not.toHaveBeenCalled();
  });
  it('waits for mounted content to finish rendering before settling its geometry', async () => {
    let finish!: () => void;
    const rendered = new Promise<void>(resolve => { finish = resolve; });
    const settled = vi.fn();
    const render = vi.fn(async (_entries: Entry[], host: HTMLElement) => {
      expect(host.isConnected).toBe(true);
      host.textContent = 'Diagram loading';
      await rendered;
      host.textContent = 'Diagram ready';
    });
    const week = createWeekView('2026-05-18', { read: async () => [entry], current: () => true, settled, render });
    document.body.append(week.host);
    const loading = week.load();
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(week.load()).toBe(loading);
    expect(week.status()).toBe('loading'); expect(settled).not.toHaveBeenCalled();
    finish(); await loading;
    expect(week.status()).toBe('loaded'); expect(week.host.textContent).toBe('Diagram ready');
    expect(settled).toHaveBeenCalledOnce();
  });
  it('does not settle a render whose view was replaced while rendering', async () => {
    let finish!: () => void;
    let current = true;
    const rendered = new Promise<void>(resolve => { finish = resolve; });
    const settled = vi.fn(), render = vi.fn(() => rendered);
    const week = createWeekView('2026-05-18', { read: async () => [entry], current: () => current, settled, render });
    document.body.append(week.host);
    const loading = week.load();
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    current = false; finish(); await loading;
    expect(settled).not.toHaveBeenCalled();
    expect(week.host.dataset.weekStatus).toBe('loading');
  });
  it('keeps focus moved outside the week while recovered content is rendering', async () => {
    let finish!: () => void;
    const rendered = new Promise<void>(resolve => { finish = resolve; });
    const read = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([entry]);
    const render = vi.fn(async (_entries: Entry[], host: HTMLElement) => {
      host.innerHTML = '<article data-entry-id="2026-05-22T15:30"><a href="/" class="em-time">15:30</a></article>';
      await rendered;
    });
    const week = createWeekView('2026-05-18', { read, current: () => true, settled: vi.fn(), render });
    const outside = document.createElement('button'); outside.textContent = 'Outside'; document.body.append(week.host, outside);
    await week.load(); week.host.querySelector<HTMLButtonElement>('button')!.focus();
    const loading = week.load(true);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    outside.focus(); finish(); await loading;
    expect(document.activeElement).toBe(outside);
  });
  it('classifies a missing weekly file as loaded-empty but leaves actual read failures retryable', async () => {
    let fail = false;
    const source: DataSource = { listYears: async () => [], assetUrl: () => null, revalidate: async () => null, read: async () => { if (fail) throw new Error('Offline'); return null; } };
    const missing = view(() => new Store(source).getWeekEntries('2026-05-18'));
    await missing.week.load(); expect(missing.week.status()).toBe('loaded'); expect(missing.week.host.querySelector('button')).toBeNull();
    fail = true; const store = new Store(source); const broken = view(() => store.getWeekEntries('2026-05-18'));
    await broken.week.load(); expect(broken.week.status()).toBe('failed');
    fail = false; await broken.week.load(true); expect(broken.week.status()).toBe('loaded');
  });
  it('keeps keyboard focus visible during Retry and transfers it to recovered content', async () => {
    let finish!: (entries: Entry[]) => void;
    const read = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockImplementation(() => new Promise<Entry[]>(resolve => { finish = resolve; }));
    const { week } = view(read); await week.load();
    const button = week.host.querySelector<HTMLButtonElement>('button')!;
    button.focus(); button.click();
    expect(document.activeElement).toBe(week.host.querySelector('summary'));
    finish([entry]); await week.load(true);
    expect(document.activeElement).toBe(week.host.querySelector('.em-time'));
  });
  it('focuses the replacement Retry on another failure and respects focus moved elsewhere while pending', async () => {
    const read = vi.fn().mockRejectedValue(new Error('Offline'));
    const { week } = view(read); await week.load();
    const original = week.host.querySelector<HTMLButtonElement>('button')!;
    original.focus(); original.click(); await week.load(true);
    const replacement = week.host.querySelector<HTMLButtonElement>('button')!;
    expect(replacement).not.toBe(original); expect(document.activeElement).toBe(replacement);
    let finish!: (entries: Entry[]) => void;
    read.mockImplementation(() => new Promise<Entry[]>(resolve => { finish = resolve; }));
    replacement.click(); const loading = week.load(true);
    const other = document.createElement('button'); other.textContent = 'Other'; document.body.append(other); other.focus();
    finish([entry]); await loading;
    expect(document.activeElement).toBe(other);
  });
  it('uses a visible fallback when repaired content is empty and retains still-present recovered focus on failure', async () => {
    const fallback = document.createElement('a'); fallback.href = '/'; fallback.textContent = 'Aside'; document.body.append(fallback);
    const read = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([]);
    const { week } = view(read, () => true, () => fallback); await week.load();
    const retry = week.host.querySelector<HTMLButtonElement>('button')!; retry.focus(); retry.click(); await week.load(true);
    expect(document.activeElement).toBe(fallback);
    read.mockResolvedValueOnce([entry]); await week.load(true);
    const time = week.host.querySelector<HTMLElement>('.em-time')!; time.focus();
    read.mockRejectedValue(new Error('Offline')); await week.load(true);
    expect(document.activeElement).toBe(time);
  });
  it('parks focus before a shared parse-diagnostic Retry disables its button', async () => {
    let renders = 0;
    const week = createWeekView('2026-05-18', {
      read: async () => [entry], current: () => true, settled: vi.fn(),
      render: (_entries, host) => {
        const card = document.createElement('article'); card.dataset.entryId = entry.meta.created;
        const time = document.createElement('a'); time.href = '/work/2026-05-22T15:30'; time.className = 'em-time'; time.textContent = '15:30'; card.append(time); host.append(card);
        if (renders++ === 0) host.append(fileDiagnosticNotice({ path: 'notes/2026/2026-05-18.md', issues: [] }, () => week.load(true)));
      },
    });
    document.body.append(week.host); await week.load();
    const retry = week.host.querySelector<HTMLButtonElement>('button')!; retry.focus(); retry.click();
    expect(document.activeElement).toBe(week.host.querySelector('summary'));
    await week.load(true);
    expect(document.activeElement).toBe(week.host.querySelector('.em-time'));
  });
});
