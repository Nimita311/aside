// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iconMarkup } from '../src/entity-icon-drawings';
import { setReferenceIcon, setupEntityIconSizing } from '../src/entity-icon-sizing';

let measured: number;
let resized: ResizeObserverCallback;
let cleanup: (() => void) | undefined;
const observed = new Set<Element>();
const frames = new Map<number, FrameRequestCallback>();
const flushFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
};

beforeEach(() => {
  measured = 18;
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe(node: Element) { observed.add(node); }
    unobserve(node: Element) { observed.delete(node); }
    disconnect() { observed.clear(); }
  });
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ width: `${measured}px` }) as CSSStyleDeclaration);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const host = document.createElement('a');
  host.href = '#action';
  host.innerHTML = iconMarkup('action', 'slipped', 10) + '<span>Final review</span>';
  return document.body.appendChild(host);
}

describe('reference artwork sizing', () => {
  it('uses mounted typography and preserves the measured size through lifecycle repaints', () => {
    const host = mount(), label = host.querySelector('span')!, text = label.firstChild!;
    host.focus();
    window.getSelection()!.setBaseAndExtent(text, 0, text, 5);
    cleanup = setupEntityIconSizing();
    flushFrames();
    const svg = host.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('18');
    expect(svg.querySelector('.m.bold')).toBeNull();
    setReferenceIcon(host, 'action', 'done', 10);
    expect(host.querySelector('svg')).toBe(svg);
    expect(svg.getAttribute('width')).toBe('18');
    expect(svg.dataset.state).toBe('done');
    expect(host.querySelector('span')).toBe(label);
    expect(document.activeElement).toBe(host);
    expect(window.getSelection()!.toString()).toBe('Final');
  });

  it('responds to typography changes and releases detached icons', async () => {
    cleanup = setupEntityIconSizing();
    const host = mount();
    await vi.waitFor(() => expect(observed.size).toBe(1));
    flushFrames();
    const svg = host.querySelector('svg')!;
    measured = 12;
    resized([{ target: svg } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    flushFrames();
    expect(host.querySelector('svg')).not.toBe(svg);
    expect(host.querySelector('svg')!.getAttribute('width')).toBe('12');
    host.remove();
    await vi.waitFor(() => expect(observed.size).toBe(0));
  });

  it('ignores authored SVGs without renderer-owned icon metadata', () => {
    document.body.innerHTML = '<svg class="entity-icon" width="10"></svg>';
    cleanup = setupEntityIconSizing();
    flushFrames();
    expect(observed.size).toBe(0);
  });
});
