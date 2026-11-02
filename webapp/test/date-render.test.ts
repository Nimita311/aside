// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderEntry, renderAssetDetail, type RenderOptions } from '../src/render';
import { refreshDisplay } from '../src/display';
import { loadApp } from './app-harness';

const previousZone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function options(): RenderOptions {
  return { timeFormat: '24h', now: '2026-10-04T09:00', nowDate: new Date('2026-10-04T09:00'), expandProjects: false, expandActions: false,
    activeFilter: null, resolveName: (_type, id) => id, refMarks: () => [], onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(),
    onDateClick: vi.fn(), routeHref: route => '/work/' + route };
}
function mount(content: string, opts = options()) {
  return renderEntry({ meta: { created: '2026-10-04T09:00' }, weekFile: '2026-09-28', content }, opts, document.body.appendChild(document.createElement('main')));
}

describe('bare date smart elements', () => {
  it('preserves complete named-zone candidates when a Markdown reference definition has the same name', () => {
    const handle = '#date/2026-10-15T09:30[Asia/Tokyo]';
    const card = mount(`Meet (${handle}). Invalid #date/2026-10-15T09:30[Mars/Olympus].\n\n[Asia/Tokyo]: https://example.com\n[Mars/Olympus]: https://example.com\n`);
    expect(card.querySelectorAll('.inline-tag-date')).toHaveLength(1);
    expect(card.querySelector<HTMLAnchorElement>('.inline-tag-date')?.dataset.dateHandle).toBe(handle);
    expect(card.querySelector('.inline-tag-date time')?.textContent).toBe('Oct 14, 2026, 17:30');
    expect(card.textContent).toContain('#date/2026-10-15T09:30[Mars/Olympus]');
    expect(card.querySelector('a[href="https://example.com"]')).toBeNull();
  });
  it('renders natural prose and all ISO value kinds with original hover values and native routes', () => {
    const opts = options(); opts.activeFilter = { type: 'project', id: '2026-10-04-work' };
    const card = mount('Meet on Thursday morning (#date/2026-10-15T09:30). Due #date/2026-10-15. Trip #date/2026-10-15/2026-10-18. Call #date/2026-10-15T01:30:12.125+09:00.', opts);
    const chips = [...card.querySelectorAll<HTMLAnchorElement>('a.inline-tag-date')];
    expect(chips).toHaveLength(4);
    expect(chips.map(chip => chip.querySelector('time')!.textContent)).toEqual([
      'Oct 15, 2026, 09:30', 'Oct 15, 2026', 'Oct 15, 2026 – Oct 18, 2026', 'Oct 14, 2026, 09:30',
    ]);
    expect(chips[3].title).toContain('2026-10-15T01:30:12.125+09:00 (Thu)');
    expect(chips[2].title).toContain('Jump to range start');
    expect(chips[0].getAttribute('href')).toBe('/work/project/2026-10-04-work/date/2026-10-15T09:30');
    expect(chips[0].getAttribute('aria-describedby')).toBeTruthy();
    expect(card.textContent).toContain('Meet on Thursday morning (');
    expect(card.textContent).toContain('). Due');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    chips[0].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(opts.onDateClick).toHaveBeenCalledWith({ start: '2026-10-15T09:30' });
    expect(opts.onTagClick).not.toHaveBeenCalled();
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    chips[0].addEventListener('click', event => { expect(event.defaultPrevented).toBe(false); event.preventDefault(); }, { once: true });
    chips[0].dispatchEvent(modified);
    expect(opts.onDateClick).toHaveBeenCalledTimes(1);
  });

  it('leaves code, escaped hashes, labeled links, and invalid date candidates ordinary', () => {
    const handle = '#date/2026-10-15';
    const card = mount(`\`${handle}\`\n\n\`\`\`md\n${handle}\n\`\`\`\n\n\\${handle} &#35;date/2026-10-15 [Thursday](${handle}) [${handle}](https://example.com) #date/2026-02-31 #date/2026-10-15bad`);
    expect(card.querySelectorAll('.inline-tag-date')).toHaveLength(0);
    expect(card.querySelector('a[href="#date/2026-10-15"]')?.textContent).toBe('Thursday');
    expect(card.querySelector('code')?.textContent).toBe(handle);
  });

  it('renders supporting Markdown and updates times in place without changing saved values or focus', () => {
    const opts = options();
    const reader = renderAssetDetail('assets/plan.md', { kind: 'markdown', text: 'Meet Thursday (#date/2026-10-15T16:30:12Z).' }, opts, []);
    document.body.append(reader);
    const chip = reader.querySelector<HTMLAnchorElement>('.inline-tag-date')!;
    const label = chip.querySelector('time')!;
    chip.focus();
    refreshDisplay(document.body, { ...opts, timeFormat: '12h' });
    expect(chip.querySelector('time')).toBe(label);
    expect(label.textContent).toBe('Oct 15, 2026, 9:30 AM');
    expect(document.activeElement).toBe(chip);
    expect(chip.dataset.dateHandle).toBe('#date/2026-10-15T16:30:12Z');
    expect(label.getAttribute('datetime')).toBe('2026-10-15T16:30:12Z');
  });

  it('renders named zones as local clocks while retaining zone names in hover, copy handles, and native routes', () => {
    const opts = options();
    const handle = '#date/2026-10-15T09:30[Asia/Tokyo]';
    const interval = `${handle}/2026-10-15T10:30[Asia/Tokyo]`;
    const card = mount(`Meet (${handle}). Window ${interval}.`, opts);
    const chips = [...card.querySelectorAll<HTMLAnchorElement>('.inline-tag-date')];
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector('time')?.textContent).toBe('Oct 14, 2026, 17:30');
    expect(chips[1].querySelector('time')?.textContent).toBe('Oct 14, 2026, 17:30 – Oct 14, 2026, 18:30');
    expect(chips[0].querySelector('time')?.getAttribute('datetime')).toBe('2026-10-15T00:30:00.000Z');
    expect(chips[0].title).toContain('2026-10-15T09:30[Asia/Tokyo]');
    expect(chips[0].dataset.dateHandle).toBe(handle);
    expect(chips[0].getAttribute('href')).toBe('/work/date/2026-10-15T09:30%5BAsia/Tokyo%5D');
    chips[0].click();
    expect(opts.onDateClick).toHaveBeenCalledWith({ start: '2026-10-15T09:30[Asia/Tokyo]' });
    refreshDisplay(document.body, { ...opts, timeFormat: '12h' });
    expect(chips[0].querySelector('time')?.textContent).toBe('Oct 14, 2026, 5:30 PM');
    expect(chips[0].dataset.dateHandle).toBe(handle);
  });

  it('copies visible chips back to their exact ISO Markdown handles', async () => {
    await loadApp('state'); // Register the application's copy handler.
    const card = mount('Meet on Thursday morning (#date/2026-10-15T09:30[America/Los_Angeles]).');
    const paragraph = card.querySelector('.rendered-content')!;
    const range = document.createRange(); range.selectNodeContents(paragraph);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const event = new Event('copy', { bubbles: true, cancelable: true });
    const setData = vi.fn(); Object.defineProperty(event, 'clipboardData', { value: { setData } });
    document.dispatchEvent(event);
    expect(setData).toHaveBeenCalledWith('text/plain', 'Meet on Thursday morning (#date/2026-10-15T09:30[America/Los_Angeles]).\n');
    expect(event.defaultPrevented).toBe(true);
    const label = card.querySelector('.inline-tag-date time')!;
    range.selectNodeContents(label); selection.removeAllRanges(); selection.addRange(range);
    const chipCopy = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(chipCopy, 'clipboardData', { value: { setData } });
    setData.mockClear(); document.dispatchEvent(chipCopy);
    expect(setData).toHaveBeenCalledWith('text/plain', '#date/2026-10-15T09:30[America/Los_Angeles]');
    expect(chipCopy.defaultPrevented).toBe(true);
    range.setStart(label.firstChild!, 0); range.setEnd(label.firstChild!, 4);
    selection.removeAllRanges(); selection.addRange(range);
    const partialCopy = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(partialCopy, 'clipboardData', { value: { setData } });
    setData.mockClear(); document.dispatchEvent(partialCopy);
    expect(setData).not.toHaveBeenCalled();
    expect(partialCopy.defaultPrevented).toBe(false);
  });
});
