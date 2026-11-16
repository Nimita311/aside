// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupRefCoHover } from '../src/ref-hover';

let cleanup: () => void;
beforeEach(() => { cleanup = setupRefCoHover(); });
afterEach(() => { cleanup(); document.body.replaceChildren(); });
const hover = (node: Element, pointerType = 'mouse') => node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }));
const highlighted = () => Array.from(document.querySelectorAll('.is-cohovered'));

describe('reference hover feedback', () => {
  it('matches complete entity identity and folded metadata without conflating types', () => {
    document.body.innerHTML = '<a data-ref-type="project" data-ref-id="same">Project</a><a data-ref-type="action" data-ref-id="same">Action</a><a data-ref-type="project" data-ref-id="same">Project in prose</a><button data-ref-hidden="project:same">+1</button>';
    const [project, action, prose, bubble] = document.body.children;
    hover(project);
    expect(highlighted()).toEqual([project, prose, bubble]);
    hover(action);
    expect(highlighted()).toEqual([action]);
    action.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    expect(highlighted()).toEqual([]);
  });

  it('shares file and smart-element feedback by hover-only handles and clears it for touch', () => {
    document.body.innerHTML = '<a data-ref-hover="asset:notes.txt">File</a><a data-ref-hover="asset:notes.txt">File in prose</a><a data-ref-hover="date:#date/2026-10-15">Day</a>';
    const [file, prose, date] = document.body.children;
    hover(file);
    expect(highlighted()).toEqual([file, prose]);
    hover(date, 'touch');
    expect(highlighted()).toEqual([]);
    // Compatibility mouse events after a tap must not restore hover.
    date.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(highlighted()).toEqual([]);
  });

  it('reapplies feedback after a reference is replaced and clears it when the window loses focus', () => {
    document.body.innerHTML = '<a data-ref-type="action" data-ref-id="review">Review</a>';
    hover(document.body.firstElementChild!);
    document.body.innerHTML = '<a data-ref-type="action" data-ref-id="review">Renamed review</a>';
    hover(document.body.firstElementChild!);
    expect(highlighted()).toEqual([document.body.firstElementChild]);
    window.dispatchEvent(new Event('blur'));
    expect(highlighted()).toEqual([]);
  });

  it('highlights references loaded or repainted under a stationary pointer', async () => {
    document.body.innerHTML = '<a data-ref-type="project" data-ref-id="launch">Launch</a>';
    hover(document.body.firstElementChild!);
    document.body.insertAdjacentHTML('beforeend', '<a data-ref-type="project" data-ref-id="launch">Launch in history</a><a data-ref-type="action" data-ref-id="launch">Different kind</a>');
    await vi.waitFor(() => expect(highlighted()).toHaveLength(2));
    document.body.firstElementChild!.outerHTML = '<a data-ref-type="project" data-ref-id="launch">Repainted metadata</a>';
    await vi.waitFor(() => expect(highlighted()).toHaveLength(2));
    window.dispatchEvent(new Event('blur'));
    document.body.insertAdjacentHTML('beforeend', '<a data-ref-type="project" data-ref-id="launch">Later</a>');
    await vi.waitFor(() => expect(highlighted()).toEqual([]));
  });
});
