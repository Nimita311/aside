/** Keep native app links usable when copied or opened outside the preview frame. */
export function preserveSessionNavigation(id: string): () => void {
  const withSession = (value?: string | URL | null): string | URL | null | undefined => {
    if (value === undefined || value === null) return value;
    const raw = String(value);
    if (!raw.trim() || raw.trimStart().startsWith('#')) return value;
    let url: URL;
    try { url = new URL(raw, location.href); } catch { return value; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin
      || url.pathname === '/-' || url.pathname.startsWith('/-/')
      || url.pathname === '/__mock' || url.pathname.startsWith('/__mock/')) return value;
    url.searchParams.set('mockSession', id);
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const originalPush = history.pushState, originalReplace = history.replaceState;
  history.pushState = (data, unused, url) => originalPush.call(history, data, unused, withSession(url));
  history.replaceState = (data, unused, url) => originalReplace.call(history, data, unused, withSession(url));

  const decorate = (link: HTMLAnchorElement) => {
    const authored = link.getAttribute('href');
    if (authored === null) return;
    const destination = withSession(authored);
    if (typeof destination === 'string' && destination !== authored) link.setAttribute('href', destination);
  };
  const decorateTree = (root: ParentNode) => {
    if (root instanceof HTMLAnchorElement) decorate(root);
    for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) decorate(link);
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLAnchorElement) decorate(record.target);
      else for (const node of record.addedNodes) if (node instanceof Element) decorateTree(node);
    }
  });
  // Rewrite hrefs before native context menus or clipboard commands read them.
  decorateTree(document);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  const preserveLink = (event: Event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (link) decorate(link);
  };
  // Cover synchronous activation immediately after insertion, before the
  // observer's microtask, without preventing any native or app event behavior.
  for (const type of ['click', 'auxclick', 'contextmenu']) document.addEventListener(type, preserveLink, true);
  return () => {
    observer.disconnect();
    for (const type of ['click', 'auxclick', 'contextmenu']) document.removeEventListener(type, preserveLink, true);
    history.pushState = originalPush; history.replaceState = originalReplace;
  };
}
