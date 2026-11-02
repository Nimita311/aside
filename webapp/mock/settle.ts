/** Wait for setup motion and layout, without waiting on intentional loading spinners. */
export async function settlePreview(target: HTMLElement, timeout = 15_000): Promise<void> {
  const doc = target.ownerDocument;
  const deadline = performance.now() + timeout;
  const decodedImages = new WeakMap<HTMLImageElement, { source: string; pending: boolean }>();
  const visibleMedia = (media: HTMLElement): boolean => {
    if (media.hidden || media.closest('[hidden]') || !media.getClientRects().length) return false;
    const style = getComputedStyle(media);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = media.getBoundingClientRect();
    const width = doc.defaultView?.innerWidth ?? Infinity, height = doc.defaultView?.innerHeight ?? Infinity;
    // An image can still have zero intrinsic size while its request is pending.
    return rect.bottom >= 0 && rect.top < height && rect.right >= 0 && rect.left < width;
  };
  const mediaPending = (): boolean => {
    let pending = false;
    for (const image of doc.querySelectorAll<HTMLImageElement>('img[src], img[srcset]')) {
      if (!visibleMedia(image)) continue;
      if (!image.complete) { pending = true; continue; }
      // Failed images are terminal too; their normal error UI can settle.
      if (!image.naturalWidth || typeof image.decode !== 'function') continue;
      const source = image.currentSrc || image.src;
      let decoding = decodedImages.get(image);
      if (!decoding || decoding.source !== source) {
        decoding = { source, pending: true }; decodedImages.set(image, decoding);
        const current = decoding;
        void image.decode().catch(() => {}).finally(() => { current.pending = false; });
      }
      pending ||= decoding.pending;
    }
    for (const video of doc.querySelectorAll<HTMLVideoElement>('video')) {
      const source = video.currentSrc || video.getAttribute('src') || video.querySelector('source[src]')?.getAttribute('src');
      if (source && visibleMedia(video) && !video.error && video.readyState < 1) pending = true;
    }
    return pending;
  };
  let previous = '';
  let stableFrames = 0;
  do {
    const startup = doc.querySelector('.instance-startup-notice');
    const starting = !!startup && !startup.contains(target);
    const drawing = !!doc.querySelector('.mermaid-diagram:not([data-diagram-state="ready"]):not([data-diagram-state="error"])');
    const moving = doc.getAnimations().some(animation => {
      const end = animation.effect?.getComputedTiming().endTime;
      return (animation.pending || animation.playState === 'running') && typeof end === 'number' && Number.isFinite(end);
    });
    const loadingMedia = mediaPending() || doc.fonts?.status === 'loading';
    const surfaces = [target, ...doc.querySelectorAll<HTMLElement>('#flow-scroll, #doc-body, #side-panel')];
    const geometry = surfaces.map(element => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height, element.scrollTop, element.scrollHeight].join(',');
    }).join(';');
    if (starting || drawing || moving || loadingMedia || geometry !== previous) stableFrames = 0;
    else if (++stableFrames >= 2) return;
    previous = geometry;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  } while (performance.now() < deadline);
  throw new Error('The preview layout did not settle. Reset to retry.');
}
