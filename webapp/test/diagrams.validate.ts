// Real-browser companion to diagrams.test.ts. Bundle this as a browser ESM
// entry with splitting and load it after style.css in a blank HTML page.
// It exercises Mermaid's actual SVG layout, IDs and DOMPurify namespaces;
// Happy DOM cannot faithfully validate those browser APIs.
import { renderEntryDetail, type RenderOptions } from '../src/render';
import { renderDiagrams } from '../src/diagrams';
import { preserveReadingPosition } from '../src/display';

const opts: RenderOptions = {
  timeFormat: '24h', now: '2026-10-04T12:00', nowDate: new Date('2026-10-04T12:00'),
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, id) => id, onTagClick() {}, onAssetClick() {}, onEntryTimeClick() {},
  routeHref: route => `/${route}`, refMarks: () => [],
};
const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;

export async function validateDiagrams(): Promise<{ checks: number; failures: string[] }> {
  const fixtures = document.createElement('main');
  fixtures.style.cssText = 'max-width:700px;margin:24px auto;padding:24px;overflow:auto;height:80vh';
  document.body.append(fixtures);
  const failures: string[] = [];
  let checks = 0;
  const check = (name: string, result: unknown) => { checks++; if (!result) failures.push(name); };
  const mount = (source: string) => {
    const root = renderEntryDetail({ meta: { created: '2026-10-04T12:00' }, weekFile: '2026-09-28', content: source }, opts);
    fixtures.append(root); return root;
  };
  const sequence = 'sequenceDiagram\n participant A\n participant B\n A->>B: Hello';
  const source = 'flowchart LR\n accTitle: Release workflow\n accDescr: Draft becomes published.\n A[Draft] --> B[Published]';
  const flow = mount(fence(source));
  const first = mount(fence(sequence)), second = mount(fence(sequence));
  const absolute = mount(fence('---\nconfig:\n arrowMarkerAbsolute: true\n sequence:\n  arrowMarkerAbsolute: true\n---\nsequenceDiagram\n A<<->>B: Both arrowheads remain visible'));
  const extra = [
    ['state', 'stateDiagram-v2\n [*] --> Draft\n Draft --> Published\n Published --> [*]'],
    ['ER', 'erDiagram\n AUTHOR ||--o{ NOTE : writes\n NOTE {\n  string title\n }'],
    ['mindmap', 'mindmap\n root((Aside))\n  Notes\n  Projects'],
    ['class', 'classDiagram\n class Note {\n  +String title\n  +render()\n }'],
    ['Gantt', 'gantt\n title Delivery\n dateFormat YYYY-MM-DD\n section Release\n Build :2026-10-04, 2d'],
  ].map(([name, source]) => ({ name, root: mount(fence(source)) }));
  const math = mount(fence('sequenceDiagram\n A->>B: $$x^2 + y^2$$'));
  const bad = mount(fence('flowchart LR\n A --> [broken'));
  const safe = mount(fence('---\nconfig:\n securityLevel: loose\n htmlLabels: true\n themeCSS: "body { display: none; }"\n---\nflowchart LR\n A["<img src=x onerror=alert(1)>"] --> B["#project/2026-10-04-test"]\n click A "javascript:alert(1)"'));
  const ordinary = mount('```js\nconst mermaid = "plain code";\n```');
  const last = mount(fence('pie title Results\n "Pass": 3\n "Retry": 1'));
  await renderDiagrams(fixtures);
  check('a standalone Mermaid fence renders', !!flow.querySelector('.mermaid-output > svg'));
  check('source survives byte-for-byte', flow.querySelector('pre code')?.textContent === `${source}\n`);
  check('source is collapsed after successful rendering', !flow.querySelector('details')?.open);
  check('two sequence diagrams render', !!first.querySelector('.mermaid-output > svg') && !!second.querySelector('.mermaid-output > svg'));
  for (const { name, root } of extra) check(`${name} renders`, !!root.querySelector('.mermaid-output > svg'));
  check('bidirectional sequence retains both markers', !!absolute.querySelector('[marker-start][marker-end]'));
  const ids = Array.from(fixtures.querySelectorAll('.mermaid-output [id]')).map(node => node.id);
  check('all generated IDs are unique across diagram copies', new Set(ids).size === ids.length);
  for (const svg of fixtures.querySelectorAll<SVGSVGElement>('.mermaid-output > svg')) {
    const local = new Set(Array.from(svg.querySelectorAll('[id]')).map(node => node.id));
    for (const attr of ['aria-labelledby', 'aria-describedby']) {
      const values = svg.getAttribute(attr)?.split(/\s+/) ?? [];
      check(`${attr} references resolve in ${svg.id}`, values.every(value => local.has(value)));
    }
    check(`layout has real bounds for ${svg.id}`, svg.getBoundingClientRect().width > 0 && svg.getBoundingClientRect().height > 0);
    for (const node of svg.querySelectorAll('*')) {
      for (const attr of Array.from(node.attributes)) {
        const references = [...attr.value.matchAll(/url\(["']?[^#)]*#([^)'"\s]+)["']?\)/g)].map(match => match[1]);
        if (references.length) check(`fragment references resolve in ${svg.id}`, references.every(value => local.has(value)));
      }
    }
  }
  check('math labels retain MathML inside a foreignObject', !!math.querySelector('foreignObject math'));
  check('invalid syntax keeps readable source and a retry', bad.querySelector('details')?.open && !bad.querySelector<HTMLButtonElement>('button.mermaid-retry')?.hidden);
  check('a malformed diagram does not block following diagrams', !!last.querySelector('.mermaid-output > svg'));
  check('ordinary code remains ordinary code', !ordinary.querySelector('.mermaid-diagram') && ordinary.textContent?.includes('const mermaid'));
  check('untrusted labels and directives still render safely', !!safe.querySelector('.mermaid-output > svg') && getComputedStyle(document.body).display !== 'none');
  const output = safe.querySelector('.mermaid-output')!;
  check('no HTML event handlers, scripts, or app-routing metadata', !output.querySelector('script, img, [onerror], [onload], [onclick], [data-entry-id], [data-ref-id]'));
  check('javascript links stay disabled', !Array.from(output.querySelectorAll('a')).some(a => /javascript:/i.test(a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? '')));
  const before = flow.querySelector('.mermaid-output > svg')!.id;
  const previousTheme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = 'dark';
  await renderDiagrams(fixtures);
  check('theme change replaces the mounted SVG', flow.querySelector('.mermaid-output > svg')!.id !== before);
  if (previousTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = previousTheme;
  await renderDiagrams(fixtures);
  const reading = document.createElement('div');
  reading.style.cssText = 'height:120px;overflow:auto;width:300px;overflow-anchor:none';
  reading.innerHTML = '<article class="detail-body"><div class="mermaid-diagram" style="height:200px"></div>'
    + '<p>' + 'A long paragraph keeps the current line in view. '.repeat(40) + '</p></article>';
  fixtures.append(reading);
  reading.scrollTop = 230;
  const paragraph = reading.querySelector('p')!;
  const readingTop = paragraph.getBoundingClientRect().top;
  preserveReadingPosition([reading], () => { reading.querySelector<HTMLElement>('.mermaid-diagram')!.style.height = '350px'; });
  check('a resized diagram preserves the reading position inside its containing body', Math.abs(paragraph.getBoundingClientRect().top - readingTop) < 1);
  reading.remove();
  return { checks, failures };
}

void validateDiagrams().then(report => {
  const result = document.createElement('pre'); result.id = 'diagram-validation';
  result.textContent = JSON.stringify(report, null, 2); document.body.prepend(result);
}).catch(error => {
  const result = document.createElement('pre'); result.id = 'diagram-validation';
  result.textContent = `FAILED: ${error instanceof Error ? error.stack : String(error)}`; document.body.prepend(result);
});
