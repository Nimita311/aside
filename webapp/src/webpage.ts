import { parseArtifactHandle } from '../../cli/src/core/artifact-reference';

interface WebpageSource { path?: string; artifactId?: string }
const sources = new WeakMap<HTMLIFrameElement, WebpageSource>();

export function webpageSource(frame: HTMLIFrameElement): Readonly<WebpageSource> | undefined { return sources.get(frame); }

// Authored classes cannot register files for refresh or impersonate a preview.
export function webpageSources(root: ParentNode | null): WebpageSource[] {
  return Array.from(root?.querySelectorAll<HTMLIFrameElement>('iframe') ?? []).flatMap(frame => {
    const source = sources.get(frame);
    return source ? [source] : [];
  });
}

// All webpage previews use the same boundary. Authored attributes never grant
// same-origin access, popups, top navigation, forms, or device permissions.
export function webpageFrame(title: string, path?: string, artifactId?: string): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.className = 'asset-media asset-webpage';
  frame.title = title || 'Embedded webpage';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('loading', 'lazy');
  const attachment = path?.match(/^artifacts\/(\d{4})\/([^/]+)\/[^/]+$/);
  if (!artifactId && attachment && attachment[1] === attachment[2].slice(0, 4)) {
    artifactId = parseArtifactHandle(`#artifact/${attachment[2]}`)?.id;
  }
  sources.set(frame, { path, artifactId });
  return frame;
}
