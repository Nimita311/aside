// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DOMPurify from 'dompurify';
import { prepareDiagrams, renderDiagrams } from '../src/diagrams';
import { renderAssetDetail, renderEntryDetail, type RenderOptions } from '../src/render';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, source: string, container: HTMLElement) => Promise<{ svg: string }>>(),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

const opts: RenderOptions = {
  now: '2026-10-04T09:00', nowDate: new Date('2026-10-04T09:00'), timeFormat: '24h',
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, id) => id, refMarks: () => [], routeHref: route => route,
  onTagClick: vi.fn(), onAssetClick: vi.fn(), onEntryTimeClick: vi.fn(),
};
const source = 'flowchart LR\n  A[Start] --> B[Finish]\n';
const fence = (text = source) => `\`\`\`mermaid\n${text}\`\`\``;
// Leading whitespace also avoids Happy DOM dropping a first top-level SVG.
const svg = (id: string, label = 'Diagram') => `\n<svg id="${id}" viewBox="0 0 100 50"><text>${label}</text></svg>`;
function mount(markdown = fence(), asset = false): HTMLElement {
  // Happy DOM's HTML parser loses a leading <pre> during DOMPurify's import.
  // A prose lead-in exercises the real Markdown pipeline without that DOM shim bug.
  markdown = `Diagram example.\n\n${markdown}`;
  const root = asset
    ? renderAssetDetail('assets/diagram.md', { kind: 'markdown', text: markdown }, opts, [])
    : renderEntryDetail({ meta: { created: opts.now }, weekFile: '2026-09-28', content: markdown }, opts);
  return document.body.appendChild(root);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mermaid.render.mockReset().mockImplementation(async id => ({ svg: svg(id) }));
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('Mermaid Markdown diagrams', () => {
  it('keeps ordinary code and unregistered authored markup out of the renderer', async () => {
    const root = mount('```js\nconst mermaid = true;\n```\n\n'
      + '<div class="mermaid-diagram"><div class="mermaid-output">Authored HTML</div></div>');
    await renderDiagrams(root);
    expect(mermaid.initialize).not.toHaveBeenCalled();
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(root.querySelector('code')?.textContent).toBe('const mermaid = true;\n');
    expect(root.querySelector('.mermaid-output')?.textContent).toBe('Authored HTML');
  });

  it.each([false, true])('preserves exact code source through Markdown references (asset: %s)', async asset => {
    const original = 'flowchart LR\n  A["#project/2026-10-04-work &amp; &#35; \\#literal"]\n'
      + '  B["<b>#artifact/2026-10-04-document</b> #entry/2026-10-04T09:00"]\n';
    const root = mount(fence(original), asset);
    const disclosure = root.querySelector('details')!;
    expect(disclosure.open).toBe(true);
    expect(root.querySelector('code')?.textContent).toBe(original);
    expect(root.querySelector('.mermaid-diagram a')).toBeNull();
    prepareDiagrams(root);
    expect(root.querySelectorAll('.mermaid-diagram')).toHaveLength(1);
    await renderDiagrams(root);
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), original, expect.any(HTMLElement));
    expect(disclosure.open).toBe(false);
    expect(root.querySelector('code')?.textContent).toBe(original);
    expect(root.querySelector<HTMLElement>('.mermaid-output')?.hidden).toBe(false);
  });

  it('passes SVG through strict sanitation before committing it from an isolated temporary container', async () => {
    const unsafe = '<svg onload="alert(1)" data-entry-id="injected">'
      + '<foreignObject><div>Unsafe HTML</div></foreignObject>'
      + '<a href="javascript:alert(1)"><text onclick="alert(1)">Label</text></a></svg>';
    mermaid.render.mockImplementation(async (id, _text, container) => {
      expect(container.isConnected).toBe(true);
      expect(container.getAttribute('aria-hidden')).toBe('true');
      expect(container.closest('.rendered-content')).toBeNull();
      return { svg: unsafe };
    });
    const root = mount();
    // Happy DOM is not supported by DOMPurify. Verify this boundary here;
    // actual malicious-SVG sanitization requires the browser validation.
    const sanitized = '<svg id="sanitized" viewBox="0 0 100 50">'
      + '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span>Safe label</span>'
      + '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></div></foreignObject></svg>';
    const sanitize = vi.spyOn(DOMPurify, 'sanitize').mockReturnValueOnce(sanitized);
    const commit = vi.fn((paint: () => void) => paint());
    await renderDiagrams(root, { commit });
    const output = root.querySelector('.mermaid-output')!;
    expect(sanitize).toHaveBeenCalledWith(unsafe, expect.objectContaining({
      USE_PROFILES: { svg: true, svgFilters: true, mathMl: true },
      ADD_TAGS: ['foreignobject', 'div', 'span', 'p', 'br', 'em', 'strong', 'b', 'i'],
      HTML_INTEGRATION_POINTS: { foreignobject: true }, ALLOW_DATA_ATTR: false,
    }));
    expect(output.querySelector('svg')?.id).toBe('sanitized');
    expect(output.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 100 50');
    expect(output.querySelector('script, [onload], [onclick], [data-entry-id], [data-ref-id], [href]')).toBeNull();
    expect(output.querySelector('foreignObject span')?.textContent).toBe('Safe label');
    expect(output.querySelector('foreignObject math mi')?.textContent).toBe('x');
    expect(output.querySelector('svg')?.getAttribute('role')).toBe('img');
    expect(output.querySelector('svg')?.getAttribute('aria-label')).toBe('Mermaid diagram');
    expect(document.querySelector('.mermaid-measure')).toBeNull();
    expect(commit).toHaveBeenCalledOnce();
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      htmlLabels: false, arrowMarkerAbsolute: false, theme: 'default', maxTextSize: 50_000, maxEdges: 500,
      secure: expect.arrayContaining(['securityLevel', 'htmlLabels', 'arrowMarkerAbsolute', 'flowchart', 'themeCSS']),
    }));
  });

  it('prevents authored configuration from switching markers to absolute URLs', async () => {
    const root = mount(fence('---\nconfig:\n  arrowMarkerAbsolute: true\n  sequence:\n    arrowMarkerAbsolute: true\n---\nsequenceDiagram\n A<<->>B: hello\n'));
    await renderDiagrams(root);
    // Exercise Mermaid's real directive sanitization without relying on Happy
    // DOM for SVG text measurement or marker rendering.
    const actual = (await vi.importActual<typeof import('mermaid')>('mermaid')).default;
    actual.initialize(mermaid.initialize.mock.calls[0][0]);
    await actual.parse(mermaid.render.mock.calls[0][1]);
    const configuration = actual.mermaidAPI.getConfig();
    expect(configuration.arrowMarkerAbsolute).toBe(false);
    expect(configuration.sequence?.arrowMarkerAbsolute).toBeFalsy();
  });

  it('retains malformed source, continues with other diagrams, and allows a successful retry', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('Parse error <b>at line 2</b>'));
    const root = mount(`${fence('invalid diagram\n')}\n\n${fence()}`);
    await renderDiagrams(root);
    const [failed, succeeded] = root.querySelectorAll<HTMLElement>('.mermaid-diagram');
    expect(failed.dataset.diagramState).toBe('error');
    expect(failed.querySelector('details')?.open).toBe(true);
    expect(failed.querySelector('code')?.textContent).toBe('invalid diagram\n');
    expect(failed.querySelector('.mermaid-message')?.textContent).toContain('Parse error <b>at line 2</b>');
    expect(failed.querySelector('.mermaid-message b')).toBeNull();
    expect(succeeded.dataset.diagramState).toBe('ready');
    expect(document.querySelector('.mermaid-measure')).toBeNull();
    failed.querySelector<HTMLButtonElement>('.mermaid-retry')!.click();
    await renderDiagrams(root);
    expect(failed.dataset.diagramState).toBe('ready');
    expect(failed.querySelector<HTMLElement>('.mermaid-message')?.hidden).toBe(true);
    expect(failed.querySelector<HTMLButtonElement>('.mermaid-retry')?.hidden).toBe(true);
    expect(mermaid.render).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])('restores retry focus only if the reader has not moved it (moved: %s)', async moved => {
    mermaid.render.mockRejectedValueOnce(new Error('Transient rendering failure'));
    const root = mount();
    await renderDiagrams(root);
    const retry = root.querySelector<HTMLButtonElement>('.mermaid-retry')!;
    const summary = root.querySelector('summary')!;
    const focusSummary = vi.spyOn(summary, 'focus');
    const outside = document.body.appendChild(document.createElement('button'));
    const result = deferred<{ svg: string }>();
    mermaid.render.mockReturnValueOnce(result.promise);
    retry.focus(); retry.click();
    const retrying = renderDiagrams(root);
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    if (moved) outside.focus();
    result.resolve({ svg: svg('retried') });
    await retrying;
    expect(retry.hidden).toBe(true);
    expect(document.activeElement).toBe(moved ? outside : summary);
    if (moved) expect(focusSummary).not.toHaveBeenCalled();
    else expect(focusSummary).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('uses different SVG IDs when the same diagram appears in simultaneous views', async () => {
    const flow = mount(`${fence()}\n\n${fence()}`);
    const reader = mount(fence(), true);
    await Promise.all([renderDiagrams(flow), renderDiagrams(reader)]);
    const ids = mermaid.render.mock.calls.map(([id]) => id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(document.querySelectorAll('.mermaid-output svg')).toHaveLength(3);
  });

  it('namespaces internal SVG IDs and their references independently in two mounted copies', async () => {
    mermaid.render.mockImplementation(async id => ({ svg:
      `<svg id="${id}" viewBox="0 0 100 50" aria-labelledby="title0" aria-describedby="desc0">`
      + '<title id="title0">Example</title><desc id="desc0">Description</desc>'
      + '<defs><filter id="shadow"><feGaussianBlur stdDeviation="2"/></filter>'
      + '<marker id="arrow"><path d="M0 0L10 5"/></marker><path id="shape" d="M0 0L10 10"/></defs>'
      + '<g id="actor0" aria-labelledby="title0 external-title" aria-describedby="desc0">'
      + '<use class="modern" href="#shape"/><use class="legacy" xlink:href="#shape"/>'
      + '<rect filter="url(#shadow)" marker-end="url(\'#arrow\')" style="filter:url(&quot;#shadow&quot;)"/>'
      + '</g></svg>',
    }));
    const flow = mount(), reader = mount(fence(), true);
    // Isolate post-sanitization reference rewriting from Happy DOM's sanitizer incompatibility.
    vi.spyOn(DOMPurify, 'sanitize').mockImplementation(input => String(input));
    await Promise.all([renderDiagrams(flow), renderDiagrams(reader)]);
    const roots = [flow, reader].map(root => root.querySelector<SVGSVGElement>('.mermaid-output svg')!);
    expect(roots).toHaveLength(2);
    for (const [index, drawing] of roots.entries()) {
      const prefix = mermaid.render.mock.calls[index][0];
      expect(drawing.id).toBe(prefix);
      expect(drawing.getAttribute('aria-labelledby')).toBe(`${prefix}-title0`);
      expect(drawing.getAttribute('aria-describedby')).toBe(`${prefix}-desc0`);
      expect(drawing.hasAttribute('aria-label')).toBe(false);
      expect(Array.from(drawing.querySelectorAll('[id]'), node => node.id)).toEqual(
        ['title0', 'desc0', 'shadow', 'arrow', 'shape', 'actor0'].map(id => `${prefix}-${id}`));
      expect(drawing.querySelector('g')?.getAttribute('aria-labelledby')).toBe(`${prefix}-title0 external-title`);
      expect(drawing.querySelector('g')?.getAttribute('aria-describedby')).toBe(`${prefix}-desc0`);
      expect(drawing.querySelector('.modern')?.getAttribute('href')).toBe(`#${prefix}-shape`);
      expect(drawing.querySelector('.legacy')?.getAttribute('xlink:href')).toBe(`#${prefix}-shape`);
      expect(drawing.querySelector('rect')?.getAttribute('filter')).toBe(`url(#${prefix}-shadow)`);
      expect(drawing.querySelector('rect')?.getAttribute('marker-end')).toBe(`url(#${prefix}-arrow)`);
      expect(drawing.querySelector('rect')?.getAttribute('style')).toContain(`url(#${prefix}-shadow)`);
    }
    const ids = roots.flatMap(root => [root.id, ...Array.from(root.querySelectorAll('[id]'), node => node.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('deduplicates generated IDs without stealing another ID or changing the first reference target', async () => {
    mermaid.render.mockImplementation(async id => ({ svg:
      `<svg id="${id}" viewBox="0 0 100 50">`
      + '<g id="node_1" class="first"><path id="node_1" class="duplicate"/></g>'
      + '<path id="node_1" class="another-duplicate"/><path id="node_1-2" class="reserved"/>'
      + '<use href="#node_1"/><use href="#node_1-2"/></svg>',
    }));
    const root = mount();
    vi.spyOn(DOMPurify, 'sanitize').mockImplementation(input => String(input));
    await renderDiagrams(root);
    const drawing = root.querySelector('.mermaid-output svg')!;
    const allIds = [drawing.id, ...Array.from(drawing.querySelectorAll('[id]'), node => node.id)];
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(drawing.querySelector('.first')?.id).toBe(`${drawing.id}-node_1`);
    expect(drawing.querySelector('.reserved')?.id).toBe(`${drawing.id}-node_1-2`);
    const references = Array.from(drawing.querySelectorAll('use'), node => node.getAttribute('href')!);
    expect(document.querySelector(references[0])).toBe(drawing.querySelector('.first'));
    expect(document.querySelector(references[1])).toBe(drawing.querySelector('.reserved'));
  });

  it.each(['stale', 'detached', 'ghost'] as const)('discards an async result when its view becomes %s', async change => {
    const result = deferred<{ svg: string }>();
    mermaid.render.mockReturnValueOnce(result.promise);
    const root = mount();
    let current = true;
    const commit = vi.fn((paint: () => void) => paint());
    const pending = renderDiagrams(root, { current: () => current, commit });
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    if (change === 'stale') current = false;
    else if (change === 'detached') root.remove();
    else {
      const ghosts = document.body.appendChild(document.createElement('div'));
      ghosts.className = 'flow-ghosts';
      ghosts.append(root);
    }
    result.resolve({ svg: svg('obsolete') });
    await pending;
    expect(root.querySelector('.mermaid-output svg')).toBeNull();
    expect(root.querySelector('details')?.open).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(document.querySelector('.mermaid-measure')).toBeNull();
  });

  it('coalesces concurrent requests and paints only the latest theme while preserving source disclosure', async () => {
    const first = deferred<{ svg: string }>();
    mermaid.render.mockReturnValueOnce(first.promise);
    const root = mount();
    const commit = vi.fn((paint: () => void) => paint());
    const initial = renderDiagrams(root, { commit });
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    const duplicate = renderDiagrams(root, { commit });
    expect(mermaid.render).toHaveBeenCalledOnce();
    document.documentElement.dataset.theme = 'dark';
    const refresh = renderDiagrams(root, { commit });
    first.resolve({ svg: svg('obsolete-light') });
    await Promise.all([initial, duplicate, refresh]);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(mermaid.initialize.mock.calls.map(([config]) => config.theme)).toEqual(['default', 'dark']);
    expect(root.querySelector('#obsolete-light')).toBeNull();
    expect(commit).toHaveBeenCalledOnce();
    await renderDiagrams(root);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    root.querySelector('details')!.open = true;
    document.documentElement.dataset.theme = 'light';
    await renderDiagrams(root);
    expect(mermaid.render).toHaveBeenCalledTimes(3);
    expect(root.querySelector('details')?.open).toBe(true);
  });
});
