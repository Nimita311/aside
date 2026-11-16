// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import type { DataSource } from '../lib/io';
import { getMondayOfWeek, toDateStr, weekFilePath } from '../lib/types';
import { loadApp } from './app-harness';
import type { ViewState } from '../src/route';

interface App {
  state: { store: Store | null; loadedWeeks: number; animSpeed: number; instanceId: string | null; doc: ViewState['doc'] };
  applyView(view: ViewState): Promise<void>;
  handleLocationChange(event?: Event): Promise<void>;
  renderFlow(): Promise<void>;
  jumpToDate(date: string): Promise<void>;
  updateLatchNow(): void;
}

async function setup(ids: string[]) {
  document.body.innerHTML = '<div id="flow-scroll"><main id="flow"></main></div>';
  const files: Record<string, string> = {
    'aside.md': '---\nid: work\nname: Work\n---',
    'notes/2026/index.yaml': ids.map(id => `- id: "${id}"`).join('\n'),
  };
  for (const id of ids) {
    const week = getMondayOfWeek(new Date(id.slice(0, 10) + 'T00:00:00'));
    const path = weekFilePath(week);
    const end = new Date(week + 'T00:00:00'); end.setDate(end.getDate() + 6);
    files[path] ??= `---\nweek: 1\nweek_start: ${week}\nweek_end: ${toDateStr(end)}\n---\n`;
    files[path] += '\n---\n```entry\ncreated: ' + id + '\n```\nA timeline entry.\n';
  }
  const source: DataSource = {
    read: async path => files[path] === undefined ? null : { text: files[path], version: files[path] },
    revalidate: async () => 'unchanged',
    listYears: async () => ['2026'],
    assetUrl: () => null,
  };
  const store = new Store(source); await store.init();
  const app = await loadApp<App>('state, renderFlow, jumpToDate, updateLatchNow, applyView, handleLocationChange');
  app.state.store = store; app.state.animSpeed = 0;
  app.state.instanceId = 'work';
  await app.renderFlow();
  return app;
}

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe('date picker landing in the application', () => {
  it('lands on a seconds-precision entry at the same clock as a minute-precision target', async () => {
    const app = await setup(['2026-10-15T10:00', '2026-10-15T09:30:00', '2026-10-15T09:00']);
    await app.applyView({ filter: null, doc: null, date: { start: '2026-10-15T09:30' } });
    expect(document.querySelector('.is-target')?.getAttribute('data-entry-id')).toBe('2026-10-15T09:30:00');
  });
  it('converts a named-zone target before landing and preserves its authored zone in the route', async () => {
    const previousZone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      history.replaceState({}, '', '/work/');
      const app = await setup(['2026-10-15T09:00', '2026-10-14T18:00', '2026-10-14T17:00']);
      await app.applyView({ filter: null, doc: null, date: { start: '2026-10-15T09:30[Asia/Tokyo]' } });
      expect(location.pathname).toBe('/work/date/2026-10-15T09:30%5BAsia/Tokyo%5D');
      expect(document.querySelector('.is-target')?.getAttribute('data-entry-id')).toBe('2026-10-14T17:00');
      document.querySelectorAll('.is-target').forEach(node => node.classList.remove('is-target'));
      await app.handleLocationChange(new PopStateEvent('popstate'));
      expect(document.querySelector('.is-target')?.getAttribute('data-entry-id')).toBe('2026-10-14T17:00');
    } finally {
      if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone;
    }
  });
  it('filters intervals, closes the reader, and restores single-date jumps', async () => {
    history.replaceState({}, '', '/work/');
    const app = await setup(['2026-10-04T10:00', '2026-10-03T17:00', '2026-10-03T09:00']);
    app.state.doc = { kind: 'asset', path: 'assets/plan.md' };
    await app.applyView({ filter: null, doc: null, date: { start: '2026-10-03T12:00', end: '2026-10-04T12:00' } });
    expect(app.state.doc).toBeNull();
    expect(location.pathname).toBe('/work/');
    expect(new URLSearchParams(location.search).get('range')).toBe('#date/2026-10-03T12:00/2026-10-04T12:00');
    expect(Array.from(document.querySelectorAll<HTMLElement>('#flow [data-entry-id]')).map(node => node.dataset.entryId)).toEqual(['2026-10-04T10:00', '2026-10-03T17:00']);
    document.querySelectorAll('.is-target').forEach(node => node.classList.remove('is-target'));
    history.replaceState({}, '', '/work/date/2026-10-03');
    await app.handleLocationChange(new PopStateEvent('popstate'));
    expect(document.querySelector('.is-target')?.getAttribute('data-entry-id')).toBe('2026-10-03T17:00');
  });
  // Content can begin with pills, prose, headings, code, or tables. Its first
  // baseline never changes the metadata line or the entry-border landing.
  it.each([12, 12.5, 13.5, 13.75, 16, 23, 28.5, 30])('lands on the entry border regardless of its %s px content offset', async contentOffset => {
    const app = await setup(['2026-10-04T10:00', '2026-10-03T09:00']);
    const scroller = document.getElementById('flow-scroll')!;
    const flow = document.getElementById('flow')!;
    const row = document.querySelector<HTMLElement>('.latch-date-row')!;
    row.style.paddingTop = '12.5px';
    const cards = Array.from(flow.querySelectorAll<HTMLElement>('.entry-card'));
    const rect = (top: number) => ({ top, bottom: top + 20 } as DOMRect);
    Object.defineProperties(scroller, { clientHeight: { value: 500 }, scrollHeight: { value: 1500 } });
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => rect(80));
    vi.spyOn(flow, 'getBoundingClientRect').mockImplementation(() => rect(80 - scroller.scrollTop));
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rect(80));
    cards.forEach((card, index) => {
      const top = () => 80 + index * 250 - scroller.scrollTop;
      vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => rect(top()));
      for (const line of card.querySelectorAll<HTMLElement>('.entry-margin, .date-marker')) {
        vi.spyOn(line, 'getBoundingClientRect').mockImplementation(() => rect(top() + 12.5));
      }
      vi.spyOn(card.querySelector<HTMLElement>('.entry-content')!, 'getBoundingClientRect').mockImplementation(() => rect(top() + contentOffset));
    });
    app.updateLatchNow();
    expect(document.getElementById('date-latch')!.dataset.date).toBe('2026-10-04');
    await app.jumpToDate('2026-10-03');
    expect(scroller.scrollTop).toBe(250);
    expect(document.getElementById('date-latch')!.dataset.date).toBe('2026-10-03');
    expect(cards[1].classList.contains('is-target')).toBe(true);
  });
});
