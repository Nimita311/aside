// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settlePreview } from '../settle';

let frames: FrameRequestCallback[];
const originalAnimations = document.getAnimations;
const animations = vi.fn<() => Animation[]>();

async function advanceFrames(count = 1): Promise<void> {
  for (let index = 0; index < count; index++) {
    const callbacks = frames.splice(0);
    callbacks.forEach(callback => callback(performance.now()));
    await Promise.resolve();
  }
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  document.getAnimations = animations;
  animations.mockReturnValue([]);
  document.body.innerHTML = '<div id="flow-scroll"><article class="entry-card"></article></div>';
});
afterEach(() => {
  document.getAnimations = originalAnimations;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('preview setup readiness', () => {
  it('holds the new preview through startup, diagram rendering, entrance motion, and changing scroll position', async () => {
    const target = document.querySelector<HTMLElement>('.entry-card')!;
    const scroller = document.getElementById('flow-scroll')!;
    const startup = document.createElement('div'); startup.className = 'instance-startup-notice';
    const diagram = document.createElement('div'); diagram.className = 'mermaid-diagram';
    target.append(diagram); document.body.append(startup);
    const motion = { pending: false, playState: 'running', effect: { getComputedTiming: () => ({ endTime: 300 }) } };
    animations.mockReturnValue([motion as unknown as Animation]);
    let ready = false;
    const settled = settlePreview(target).then(() => { ready = true; });
    await advanceFrames(3);
    expect(ready).toBe(false);
    startup.remove();
    await advanceFrames(3);
    expect(ready).toBe(false);
    diagram.dataset.diagramState = 'ready';
    await advanceFrames(3);
    expect(ready).toBe(false);
    motion.playState = 'finished';
    scroller.scrollTop = 100;
    await advanceFrames();
    scroller.scrollTop = 200;
    await advanceFrames();
    expect(ready).toBe(false);
    await advanceFrames(2);
    await settled;
    expect(ready).toBe(true);
  });

  it('reveals an intentional loading scenario while its infinite spinner continues', async () => {
    const startup = document.createElement('div'); startup.className = 'instance-startup-notice';
    const notice = document.createElement('p'); notice.textContent = 'Loading instance…';
    startup.append(notice); document.body.append(startup);
    animations.mockReturnValue([{
      pending: false, playState: 'running', effect: { getComputedTiming: () => ({ endTime: Infinity }) },
    } as unknown as Animation]);
    let ready = false;
    const settled = settlePreview(notice).then(() => { ready = true; });
    await advanceFrames(2);
    await settled;
    expect(ready).toBe(true);
    expect(startup.isConnected).toBe(true);
  });

  it('waits for a visible image to load and decode before accepting its settled dimensions', async () => {
    const image = document.createElement('img'); image.src = '/illustration.svg'; document.body.append(image);
    let complete = false;
    let decode!: () => void;
    Object.defineProperties(image, {
      complete: { configurable: true, get: () => complete },
      naturalWidth: { configurable: true, get: () => complete ? 300 : 0 },
      decode: { configurable: true, value: () => new Promise<void>(resolve => { decode = resolve; }) },
    });
    const rect = () => new DOMRect(10, 10, complete ? 300 : 0, complete ? 200 : 0);
    vi.spyOn(image, 'getBoundingClientRect').mockImplementation(rect);
    vi.spyOn(image, 'getClientRects').mockImplementation(() => [rect()] as unknown as DOMRectList);
    let ready = false;
    const settled = settlePreview(image).then(() => { ready = true; });
    await advanceFrames(3); expect(ready).toBe(false);
    complete = true; image.dispatchEvent(new Event('load'));
    await advanceFrames(3); expect(ready).toBe(false);
    decode(); await Promise.resolve(); await Promise.resolve();
    await advanceFrames(2); await settled;
    expect(ready).toBe(true);
  });

  it('allows a failed image to settle without waiting for a successful decode', async () => {
    const image = document.createElement('img'); image.src = '/missing.svg'; document.body.append(image);
    let complete = false;
    const decode = vi.fn();
    Object.defineProperties(image, {
      complete: { configurable: true, get: () => complete },
      naturalWidth: { configurable: true, value: 0 },
      decode: { configurable: true, value: decode },
    });
    const rect = new DOMRect(10, 10, 0, 0);
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(image, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList);
    let ready = false;
    const settled = settlePreview(image).then(() => { ready = true; });
    await advanceFrames(3); expect(ready).toBe(false);
    complete = true; image.dispatchEvent(new Event('error'));
    await advanceFrames(2); await settled;
    expect(ready).toBe(true); expect(decode).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'error'])('waits for visible video %s before revealing its preview', async terminal => {
    const video = document.createElement('video'); video.src = '/orbit.mp4'; document.body.append(video);
    let metadata = false, failed = false;
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => metadata ? 1 : 0 },
      error: { configurable: true, get: () => failed ? { code: 4 } : null },
    });
    const rect = new DOMRect(10, 10, 300, 150);
    vi.spyOn(video, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(video, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList);
    let ready = false;
    const settled = settlePreview(video).then(() => { ready = true; });
    await advanceFrames(3); expect(ready).toBe(false);
    if (terminal === 'metadata') { metadata = true; video.dispatchEvent(new Event('loadedmetadata')); }
    else { failed = true; video.dispatchEvent(new Event('error')); }
    await advanceFrames(2); await settled;
    expect(ready).toBe(true);
  });

  it('does not wait for an offscreen lazy image that the browser has not requested', async () => {
    const target = document.querySelector<HTMLElement>('.entry-card')!;
    const image = document.createElement('img'); image.src = '/later.svg'; image.loading = 'lazy'; target.append(image);
    Object.defineProperty(image, 'complete', { configurable: true, value: false });
    const rect = new DOMRect(10, 5000, 300, 200);
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(rect);
    vi.spyOn(image, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList);
    let ready = false;
    const settled = settlePreview(target).then(() => { ready = true; });
    await advanceFrames(2); await settled;
    expect(ready).toBe(true);
  });
});
