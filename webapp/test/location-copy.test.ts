// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderActionDetail, renderEntry, type RenderOptions } from '../src/render';
import { loadApp } from './app-harness';

const handle = '#location/?postal=10%20Downing%20Street/London/&geo=51.5034,-0.1276';
const options: RenderOptions = {
  timeFormat: '24h', now: '2026-10-04T09:00', nowDate: new Date('2026-10-04T09:00'), expandProjects: false, expandActions: false,
  activeFilter: null, resolveName: (_type, id) => id, refMarks: () => [], onTagClick() {}, onAssetClick() {},
  onEntryTimeClick() {}, routeHref: route => '/work/' + route,
};

beforeAll(async () => { await loadApp('state'); });
afterEach(() => { window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

function mount(content: string): HTMLElement {
  return renderEntry({ meta: { created: '2026-10-04T09:00' }, weekFile: '2026-09-28', content }, options,
    document.body.appendChild(document.createElement('main')));
}

function copy(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges(); selection.addRange(range);
  const event = new Event('copy', { bubbles: true, cancelable: true });
  const setData = vi.fn();
  Object.defineProperty(event, 'clipboardData', { value: { setData } });
  document.dispatchEvent(event);
  return { event, setData };
}

describe('copying location content', () => {
  it('round-trips postal and geo payloads with the exact authored label Markdown', () => {
    const source = `Meet [**Headquarters** & team](${handle}), then ${handle}.`;
    const card = mount(source);
    expect(card.querySelectorAll('.inline-tag-location')).toHaveLength(2);
    const range = document.createRange(); range.selectNodeContents(card.querySelector('.rendered-content')!);
    const { event, setData } = copy(range);
    expect(event.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith('text/plain', source + '\n');
  });

  it('copies a fully selected visible label as its complete location and preserves partial selections', () => {
    const card = mount(`[**Headquarters**](${handle})`);
    const label = card.querySelector('.location-label')!;
    const range = document.createRange(); range.selectNodeContents(label);
    expect(copy(range).setData).toHaveBeenCalledWith('text/plain', `[**Headquarters**](${handle})`);
    const text = label.querySelector('strong')!.firstChild!;
    range.setStart(text, 0); range.setEnd(text, 4);
    const partial = copy(range);
    expect(partial.event.defaultPrevented).toBe(false);
    expect(partial.setData).not.toHaveBeenCalled();
  });

  it('copies a postal-only chip without replacing its address with the display label', () => {
    const postal = '#location/?postal=%E6%9D%B1%E4%BA%AC/%E5%8D%83%E4%BB%A3%E7%94%B0%E5%8C%BA/';
    const card = mount(`[Office](${postal})`);
    const range = document.createRange(); range.selectNodeContents(card.querySelector('.location-label')!);
    expect(copy(range).setData).toHaveBeenCalledWith('text/plain', `[Office](${postal})`);
  });

  it('round-trips postal periods in bare and labeled mentions with surrounding punctuation', () => {
    const abbreviated = '#location/?postal=St.';
    const canonical = '#location/?postal=Office/';
    const source = `${abbreviated}, [**Street**](${abbreviated}) and ${canonical}.`;
    const card = mount(source);
    const range = document.createRange(); range.selectNodeContents(card.querySelector('.rendered-content')!);
    expect(copy(range).setData).toHaveBeenCalledWith('text/plain', source + '\n');
  });

  it('preserves a partial chip when a larger selection ends inside its label', () => {
    const card = mount(`Visit [Headquarters](${handle}) tomorrow.`);
    const paragraph = card.querySelector('.rendered-content')!;
    const label = card.querySelector('.location-label')!;
    const range = document.createRange(); range.setStart(paragraph.firstChild!, 0); range.setEnd(label.firstChild!, 4);
    expect(copy(range).setData).toHaveBeenCalledWith('text/plain', 'Visit Head');
  });

  it('copies the action metadata chip as its saved bare location handle', () => {
    const view = renderActionDetail('2026-10-31-visit', {frontMatter: {
      name: 'Visit', created: '2026-10-31T09:00', location: handle,
    }, body: ''}, undefined, options, []);
    document.body.append(view);
    const range = document.createRange(); range.selectNodeContents(view.querySelector('.detail-fields .location-label')!);
    expect(copy(range).setData).toHaveBeenCalledWith('text/plain', handle);
  });
});
