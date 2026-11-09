// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { alignWideBlocks, wrapWideBlock } from '../src/wide-content';

afterEach(() => document.body.replaceChildren());

function fixture(natural: number, left = 200, right = 200) {
  const root = document.createElement('div');
  const content = document.createElement('pre');
  root.append(content);
  document.body.append(root);
  const viewport = wrapWideBlock(content);
  let width = 1200;
  const setPadding = () => { viewport.style.paddingLeft = `${left}px`; viewport.style.paddingRight = `${right}px`; };
  setPadding();
  Object.defineProperty(viewport, 'clientWidth', { get: () => width });
  Object.defineProperty(viewport, 'scrollWidth', { get: () => Math.max(width, left + natural + right) });
  content.getBoundingClientRect = () => ({ width: natural } as DOMRect);
  return {
    root, viewport,
    position() {
      alignWideBlocks(root);
      return {
        fits: viewport.classList.contains('is-fit'),
        contentLeft: left + Number.parseFloat(viewport.style.getPropertyValue('--wide-offset')) - viewport.scrollLeft,
        scroll: viewport.scrollLeft,
      };
    },
    resize(nextWidth: number, nextNatural = natural) {
      width = nextWidth; natural = nextNatural;
      // Native scrolling clamps its current offset when the range shrinks.
      viewport.scrollLeft = Math.min(viewport.scrollLeft, viewport.scrollWidth - width);
    },
  };
}

describe('initial wide-content positioning', () => {
  it('keeps a block that fits the prose aligned to the prose left edge', () => {
    expect(fixture(700).position()).toEqual({ fits: true, contentLeft: 200, scroll: 0 });
  });

  it.each([[200, 200], [300, 100], [100, 300]])('centers a fully visible wide block with %ipx/%ipx margins', (left, right) => {
    expect(fixture(1000, left, right).position()).toEqual({ fits: true, contentLeft: 100, scroll: 0 });
  });

  it('starts overflowing content at the available left edge and retains the prose-right endpoint', () => {
    const f = fixture(1500);
    expect(f.position()).toEqual({ fits: false, contentLeft: 0, scroll: 200 });
    const max = f.viewport.scrollWidth - f.viewport.clientWidth;
    expect(200 + 1500 - max).toBe(1000); // prose right: viewport width minus right margin
  });

  it('repositions untouched blocks after resizing, including native scroll clamping', () => {
    const f = fixture(1500);
    f.position();
    f.resize(1600, 1000);
    expect(f.position()).toEqual({ fits: true, contentLeft: 200, scroll: 0 });
    f.resize(1200, 1000);
    expect(f.position()).toEqual({ fits: true, contentLeft: 100, scroll: 0 });
    f.resize(1200, 1500);
    expect(f.position()).toEqual({ fits: false, contentLeft: 0, scroll: 200 });
  });

  it('preserves a user pan when later layout passes or resizing occur', () => {
    const f = fixture(1500);
    f.position();
    f.viewport.scrollLeft = 350;
    expect(f.position().scroll).toBe(350);
    f.resize(1100);
    expect(f.position().scroll).toBe(350);
  });

  it('defers closed disclosure contents until they are shown', () => {
    const f = fixture(1500);
    const details = document.createElement('details');
    f.root.append(details); details.append(f.viewport);
    alignWideBlocks(f.root);
    expect(f.viewport.style.getPropertyValue('--wide-offset')).toBe('');
    details.open = true;
    expect(f.position().contentLeft).toBe(0);
  });
});
