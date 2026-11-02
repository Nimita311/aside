import DOMPurify from 'dompurify';

type Mermaid = (typeof import('mermaid'))['default'];
type Theme = 'dark' | 'default';
interface Diagram {
  host: HTMLElement;
  output: HTMLElement;
  source: string;
  details: HTMLDetailsElement;
  message: HTMLElement;
  retry: HTMLButtonElement;
  theme?: Theme;
  pending?: Promise<void>;
}
export interface DiagramOptions {
  current?: () => boolean;
  // The caller owns scroll anchoring and can wrap the synchronous DOM swap.
  commit?: (paint: () => void) => void;
}

// Weak registration prevents authored HTML from impersonating app-owned views.
const diagrams = new WeakMap<HTMLElement, Diagram>();
let runtime: Promise<Mermaid> | undefined;
let queue = Promise.resolve();
let nextId = 0;
const MAX_TEXT_SIZE = 50_000;
const theme = (): Theme => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';

function loadMermaid(): Promise<Mermaid> {
  return runtime ??= import('mermaid').then(module => module.default).catch(error => {
    runtime = undefined;
    throw new Error('The diagram renderer could not load. Retry or reload the page.', { cause: error });
  });
}

// Register only after Markdown sanitization and reference processing. Until
// mounted and hydrated, a diagram is still readable as ordinary source code.
export function prepareDiagrams(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
    if (code.closest('.mermaid-diagram')) continue;
    const pre = code.parentElement!;
    const host = document.createElement('div'); host.className = 'mermaid-diagram';
    const output = document.createElement('div'); output.className = 'mermaid-output'; output.hidden = true;
    const details = document.createElement('details'); details.className = 'mermaid-source'; details.open = true;
    const summary = document.createElement('summary'); summary.textContent = 'Diagram source';
    const message = document.createElement('p'); message.className = 'mermaid-message'; message.hidden = true;
    message.setAttribute('role', 'status');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'mermaid-retry';
    retry.textContent = 'Retry diagram'; retry.hidden = true;
    const diagram: Diagram = { host, output, source: code.textContent ?? '', details, message, retry };
    pre.replaceWith(host);
    details.append(summary, pre);
    host.append(output, message, retry, details);
    diagrams.set(host, diagram);
  }
}

function sanitizeDiagram(svg: string, id: string): string {
  const template = document.createElement('template');
  // Math labels use foreignObject even with htmlLabels disabled. Sanitize its
  // HTML/MathML children too, instead of silently deleting legitimate labels.
  template.innerHTML = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: ['foreignobject', 'div', 'span', 'p', 'br', 'em', 'strong', 'b', 'i'],
    ADD_ATTR: ['data-look', 'data-color-id'],
    HTML_INTEGRATION_POINTS: { foreignobject: true }, ALLOW_DATA_ATTR: false,
  });
  const drawing = template.content.querySelector('svg');
  if (!drawing) throw new Error('The renderer did not produce a diagram.');
  // Mermaid prefixes markers, but some diagram types also emit generic IDs
  // such as actor0/root-0. Namespace those for simultaneous flow/reader copies.
  // Keep the root ID, which Mermaid uses to scope all of its CSS selectors.
  const identified = Array.from(drawing.querySelectorAll('[id]'));
  const ids = new Map(identified.map(node => [node.id, `${id}-${node.id}`]));
  const reserved = new Set(ids.values());
  const assigned = new Set([drawing.id]);
  for (const node of identified) {
    const canonical = ids.get(node.id)!;
    let unique = canonical;
    // Mindmaps can repeat an ID on a group and its child path. References
    // keep pointing to the first element; later copies get unused IDs.
    if (assigned.has(unique)) {
      let suffix = 2;
      do { unique = `${canonical}-${suffix++}`; } while (reserved.has(unique) || assigned.has(unique));
    }
    node.id = unique;
    assigned.add(unique);
  }
  const urls = (value: string) => value.replace(/url\(\s*(['"]?)#([^\s)'"]+)\1\s*\)/g,
    (match, _quote: string, target: string) => ids.has(target) ? `url(#${ids.get(target)})` : match);
  for (const node of [drawing, ...drawing.querySelectorAll('*')]) {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name === 'href' || attr.name === 'xlink:href') {
        const target = attr.value.startsWith('#') ? ids.get(attr.value.slice(1)) : undefined;
        if (target) node.setAttribute(attr.name, `#${target}`);
      } else if (attr.name === 'aria-labelledby' || attr.name === 'aria-describedby') {
        node.setAttribute(attr.name, attr.value.split(/\s+/).map(target => ids.get(target) ?? target).join(' '));
      } else if (attr.name !== 'id') node.setAttribute(attr.name, urls(attr.value));
    }
    if (node.tagName.toLowerCase() === 'style') node.textContent = urls(node.textContent ?? '');
  }
  drawing.setAttribute('role', 'img');
  if (!drawing.hasAttribute('aria-labelledby') && !drawing.hasAttribute('aria-label')) {
    drawing.setAttribute('aria-label', 'Mermaid diagram');
  }
  // Keep text readable on wide diagrams. The surrounding output scrolls
  // horizontally rather than shrinking an entire graph into a narrow column.
  const width = Number(drawing.getAttribute('viewBox')?.trim().split(/[\s,]+/)[2]);
  if (Number.isFinite(width) && width > 0) {
    drawing.style.width = `${width}px`;
    drawing.style.maxWidth = 'none';
  }
  return template.innerHTML;
}

async function draw(diagram: Diagram, appearance: Theme): Promise<string> {
  if (diagram.source.length > MAX_TEXT_SIZE) throw new Error('Diagram exceeds the 50,000 character limit.');
  const mermaid = await loadMermaid();
  // Jobs are serialized, including initialization, so a theme change cannot
  // change another diagram's configuration halfway through its async render.
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    theme: appearance, htmlLabels: false, arrowMarkerAbsolute: false,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-body').trim() || 'sans-serif',
    maxTextSize: MAX_TEXT_SIZE, maxEdges: 500,
    // Preserve Mermaid's protected settings, and keep authored frontmatter
    // from opting into HTML labels or injecting application-wide theme CSS.
    // Fragment-only markers remain valid after ID namespacing and navigation.
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
      'suppressErrorRendering', 'htmlLabels', 'arrowMarkerAbsolute', 'flowchart', 'theme', 'themeVariables', 'themeCSS', 'fontFamily'],
    flowchart: { htmlLabels: false },
  });
  // SVG text measurement needs connected, laid-out DOM. An offscreen host
  // isolates temporary Mermaid markup from the flow and the document reader.
  const scratch = document.createElement('div');
  scratch.className = 'mermaid-measure';
  scratch.setAttribute('aria-hidden', 'true');
  Object.assign(scratch.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden',
    width: `${diagram.host.getBoundingClientRect().width || 800}px`, pointerEvents: 'none' });
  document.body.append(scratch);
  try {
    const id = `aside-mermaid-${++nextId}`;
    const { svg } = await mermaid.render(id, diagram.source, scratch);
    return sanitizeDiagram(svg, id);
  } finally {
    scratch.remove();
  }
}

async function hydrate(diagram: Diagram, root: HTMLElement, options: DiagramOptions): Promise<void> {
  const current = () => root.isConnected && root.contains(diagram.host) &&
    !diagram.host.closest('.flow-ghosts') && (options.current?.() ?? true);
  if (!current()) return;
  if (diagram.pending) {
    await diagram.pending;
    // A concurrent theme refresh may have joined an older request.
    if (current() && diagram.theme !== theme()) await hydrate(diagram, root, options);
    return;
  }
  if (diagram.theme === theme()) return;
  const commit = (paint: () => void) => {
    if (current()) (options.commit ?? (fn => fn()))(() => { if (current()) paint(); });
  };
  diagram.retry.onclick = () => {
    if (!current() || diagram.pending) return;
    diagram.theme = undefined;
    void hydrate(diagram, root, options);
  };
  const work = async () => {
    while (current() && diagram.theme !== theme()) {
      const appearance = theme();
      let svg: string | undefined;
      let failure: unknown;
      try { svg = await draw(diagram, appearance); } catch (error) { failure = error; }
      if (!current()) return;
      if (appearance !== theme()) continue;
      commit(() => {
        diagram.theme = appearance;
        diagram.host.dataset.diagramState = svg ? 'ready' : 'error';
        if (svg) {
          const firstRender = !diagram.output.hasChildNodes();
          diagram.output.innerHTML = svg;
          diagram.output.hidden = false;
          // Preserve the reader's source disclosure choice on theme refresh.
          if (firstRender) diagram.details.open = false;
          diagram.message.hidden = true;
          const retryFocused = document.activeElement === diagram.retry;
          diagram.retry.hidden = true;
          if (retryFocused) diagram.details.querySelector('summary')?.focus({ preventScroll: true });
        } else {
          diagram.output.replaceChildren(); diagram.output.hidden = true;
          diagram.details.open = true;
          const reason = failure instanceof Error ? failure.message : String(failure ?? 'Unknown error');
          diagram.message.textContent = `Could not render diagram: ${reason.slice(0, 400)}`;
          diagram.message.hidden = false;
          diagram.retry.hidden = false;
        }
      });
    }
  };
  diagram.pending = queue.then(work);
  // A failed job must never prevent another diagram from rendering.
  queue = diagram.pending.catch(() => {});
  try { await diagram.pending; } finally { diagram.pending = undefined; }
}

// The app awaits this after mounting a view and before measuring navigation
// geometry. Normal Markdown never loads Mermaid. Stale views cannot be painted.
export async function renderDiagrams(root: HTMLElement, options: DiagramOptions = {}): Promise<void> {
  const hosts = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-diagram'));
  if (diagrams.has(root)) hosts.unshift(root);
  await Promise.all(hosts.map(host => {
    const diagram = diagrams.get(host);
    return diagram ? hydrate(diagram, root, options) : undefined;
  }));
}
