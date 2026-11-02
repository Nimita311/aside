// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preserveSessionNavigation } from '../session-navigation';

let stop: (() => void) | undefined;
beforeEach(() => {
  history.replaceState(null, '', '/showcase/?mockSession=preview-session');
  document.body.replaceChildren();
});
afterEach(() => { stop?.(); stop = undefined; document.body.replaceChildren(); });

describe('native mock session links', () => {
  it('decorates existing, inserted, and updated anchors before copying or opening a context menu', async () => {
    document.body.innerHTML = '<a href="/showcase/project/aurora?view=detail#notes">Project</a>';
    stop = preserveSessionNavigation('preview-session');
    const existing = document.querySelector('a')!;
    expect(existing.getAttribute('href')).toBe('/showcase/project/aurora?view=detail&mockSession=preview-session#notes');

    const group = document.createElement('div');
    group.innerHTML = '<a href="/empty/">Empty instance</a>';
    document.body.append(group);
    const inserted = group.querySelector('a')!;
    await vi.waitFor(() => expect(inserted.getAttribute('href')).toBe('/empty/?mockSession=preview-session'));
    inserted.setAttribute('href', '/showcase/action/review?mockSession=another-session');
    await vi.waitFor(() => expect(inserted.getAttribute('href')).toBe('/showcase/action/review?mockSession=preview-session'));
  });

  it('leaves non-app destinations and fragment-only links unchanged', async () => {
    const destinations = ['#section', '', '/-/api/instances', '/-/files/signed/image.svg', '/__mock/', '/__mock',
      'https://example.com/showcase/', 'blob:http://localhost/id', 'mailto:hello@example.com', 'javascript:void(0)'];
    for (const destination of destinations) {
      const link = document.createElement('a'); link.setAttribute('href', destination); document.body.append(link);
    }
    stop = preserveSessionNavigation('preview-session');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect([...document.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(destinations);
  });

  it('retains the session in app history and does not repeatedly mutate decorated links', async () => {
    stop = preserveSessionNavigation('preview-session');
    history.pushState({ detail: true }, '', '/showcase/detail?view=full#title');
    expect(location.pathname + location.search + location.hash).toBe('/showcase/detail?view=full&mockSession=preview-session#title');
    history.replaceState(null, '', '#section');
    expect(location.hash).toBe('#section');
    expect(new URL(location.href).searchParams.get('mockSession')).toBe('preview-session');

    const link = document.createElement('a'); link.href = '/showcase/'; document.body.append(link);
    await vi.waitFor(() => expect(link.getAttribute('href')).toBe('/showcase/?mockSession=preview-session'));
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver(records => mutations.push(...records));
    observer.observe(link, { attributes: true, attributeFilter: ['href'] });
    link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    link.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    observer.disconnect();
    expect(mutations).toEqual([]);
  });
});
