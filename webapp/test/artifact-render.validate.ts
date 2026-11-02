// Bundle for a real-browser check, then call validateArtifactRendering().
// This exercises DOMPurify, Markdown parsing, link events, and previews together;
// the regular vitest suite covers the DOM-free reference/route/store helpers.
import { artifactContentFilename, artifactHandle } from '../../cli/src/core/artifact-reference';
import { renderArtifactDetail, renderEntryDetail, type RenderOptions } from '../src/render';
import { parseRoute } from '../src/route';

export function validateArtifactRendering(): { checks: number; failures: string[] } {
  const id = '2026-10-02-design-review';
  const other = '2026-10-02-related-doc';
  const filename = 'Desktop 100% (final).png';
  const calls: { id: string; filename?: string }[] = [];
  const opts: RenderOptions = {
    timeFormat: '24h', now: '2026-10-02T12:00', nowDate: new Date('2026-10-02T12:00'), expandProjects: false, expandActions: false,
    activeFilter: { type: 'project', id: '2026-10-02-product' },
    resolveName: (_type, value) => value, onTagClick: () => {}, onAssetClick: () => {},
    onEntryTimeClick: () => {}, routeHref: (route) => `/${route}`, refMarks: () => [],
    resolveArtifactName: (value) => value === id ? 'Design review' : 'Related document',
    onArtifactClick: (value, file) => calls.push({ id: value, filename: file }),
    artifactHref: (value, file) => `/project/2026-10-02-product/artifact/${value}${file ? `/${encodeURIComponent(file)}` : ''}`,
    artifactFileUrl: (value, file) => file ? `/data/artifacts/${value.slice(0, 4)}/${value}/${encodeURIComponent(file)}?v=1` : null,
  };
  const failures: string[] = [];
  let checks = 0;
  const check = (name: string, actual: unknown) => { checks++; if (!actual) failures.push(name); };
  const entry = (body: string, renderOpts = opts) => renderEntryDetail({
    meta: { created: '2026-10-02T12:00' }, content: body, weekFile: '2026-09-28',
  }, renderOpts);

  const mediaBody = '<video controls src="../../assets/talk.mp4" poster="../../assets/cover.png"><source src="../../assets/talk.webm"><track kind="captions" src="../../assets/talk%20English.vtt" srclang="en" label="English"><track kind="subtitles" src="https://example.com/subtitles.vtt" srclang="fr"></video>';
  const mediaUrl = (path: string) => `/-/api/instances/work/files/${path.split('/').map(encodeURIComponent).join('/')}`;
  const media = entry(mediaBody, { ...opts, assetFileUrl: mediaUrl });
  check('local video, source and poster use their containing instance', media.querySelector('video')?.getAttribute('src') === mediaUrl('assets/talk.mp4') && media.querySelector('video')?.getAttribute('poster') === mediaUrl('assets/cover.png') && media.querySelector('source')?.getAttribute('src') === mediaUrl('assets/talk.webm'));
  check('supplied local captions use their containing instance and retain language metadata', media.querySelector('track[kind="captions"]')?.getAttribute('src') === mediaUrl('assets/talk English.vtt') && media.querySelector('track[kind="captions"]')?.getAttribute('srclang') === 'en');
  check('external subtitles retain their authored destination', media.querySelector('track[kind="subtitles"]')?.getAttribute('src') === 'https://example.com/subtitles.vtt');
  const unresolvedMedia = entry(mediaBody);
  check('unresolved local captions cannot resolve against a browser route', unresolvedMedia.querySelector('track[kind="captions"]')?.hasAttribute('src') === false && unresolvedMedia.querySelector('track[kind="subtitles"]')?.getAttribute('src') === 'https://example.com/subtitles.vtt');

  const plain = entry(`Read ${artifactHandle(id)}. Open ${artifactHandle(id, filename)}!`);
  const links = [...plain.querySelectorAll<HTMLAnchorElement>('a.artifact-link')];
  check('bare handles show name and exact filename', links.length === 2 && links[0].textContent === 'Design review' && links[1].textContent === filename);
  check('bare-handle punctuation stays outside the link', links[0].nextSibling?.textContent?.startsWith('.') && links[1].nextSibling?.textContent?.startsWith('!'));
  check('links retain the timeline scope in their href', links[0].pathname.startsWith('/project/2026-10-02-product/artifact/'));
  links[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  check('plain click opens the selected attachment', calls.at(-1)?.id === id && calls.at(-1)?.filename === filename);
  const prior = calls.length;
  let modifiedWasPrevented = true;
  links[1].addEventListener('click', (event) => {
    modifiedWasPrevented = event.defaultPrevented;
    event.preventDefault(); // Keep the validation tab open after observing the app handler.
  }, { once: true });
  links[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
  check('modified click retains native link behavior', calls.length === prior && !modifiedWasPrevented);

  const rich = entry(`[**Review**](${artifactHandle(id)}) [${artifactHandle(other)}](https://example.com) ![Desktop](${artifactHandle(id, filename)})`);
  check('authored link label is preserved', rich.querySelector('a.artifact-link strong')?.textContent === 'Review');
  check('existing link labels do not produce nested anchors', rich.querySelectorAll('a').length === 2 && !rich.querySelector('a a'));
  check('external links retain their normal behavior', rich.querySelector('a[href="https://example.com"]')?.getAttribute('target') === '_blank');
  const image = rich.querySelector<HTMLImageElement>('img');
  check('image resolves the exact file and exposes its stable identity', image?.getAttribute('src')?.includes('Desktop%20100%25%20(final).png') && image.dataset.artifactHandle === artifactHandle(id, filename));

  const code = entry(`\`${artifactHandle(id)}\`\n\n\`\`\`md\n${artifactHandle(id)}\n\`\`\`\n\n<pre>${artifactHandle(id)}</pre>`);
  check('inline, fenced, and HTML code stay literal', code.querySelectorAll('a.artifact-link').length === 0 && code.querySelector('code')?.textContent === artifactHandle(id));
  const escaped = entry(`Literal \\${artifactHandle(id)} and real ${artifactHandle(id)}.`);
  check('escaped hashes stay literal beside an identical real reference', escaped.querySelectorAll('a.artifact-link').length === 1 && escaped.textContent?.includes(`Literal ${artifactHandle(id)} and real Design review.`));
  const entities = entry(`&#35;artifact/${id} &#x23;artifact/${id} &num;artifact/${id}`);
  check('entity-spelled hashes stay literal', entities.querySelectorAll('a.artifact-link').length === 0 && entities.textContent?.includes(artifactHandle(id)));
  const literalHtml = entry(`<div>&#35;artifact/${id}</div>\n\n[encoded fragment](&#35;artifact/${id})`);
  check('entity hashes in raw HTML and link destinations do not create artifact references', literalHtml.querySelectorAll('.artifact-link, .asset-link').length === 0 && literalHtml.querySelector('a')?.getAttribute('href') === artifactHandle(id));
  const entityCode = entry(`\`&#35;artifact/${id}\``);
  check('code preserves the authored entity spelling', entityCode.querySelector('code')?.textContent === `&#35;artifact/${id}`);
  const invalid = entry('#artifact/2026-02-30-invalid #artifact/2026-10-02-design-review/../file.png');
  check('invalid ids and filenames remain ordinary text', invalid.querySelectorAll('a.artifact-link').length === 0);
  const traversal = entry(`[bad](#artifact/${id}/%2E%2E%2Fsecret) ![bad](#artifact/${id}/%2Fetc%2Fpasswd)`);
  check('encoded separators cannot resolve artifact links or files', !traversal.querySelector('a.artifact-link, img[data-artifact-handle]'));
  const injection = entry('<span data-entry-id="fake" data-artifact-handle="fake">text</span>');
  check('authored application attributes are stripped', !injection.querySelector('[data-entry-id], [data-artifact-handle]'));

  const artifact = { frontMatter: { name: 'Design review', created: '2026-10-02T12:00' }, body: '' };
  const empty = renderArtifactDetail(id, artifact, undefined, opts);
  check('empty artifact stays an empty Markdown document', empty.querySelector('.rendered-content')?.textContent === '' && !empty.querySelector('.asset-binary'));
  const fileArtifact = renderArtifactDetail(id, { ...artifact, frontMatter: { ...artifact.frontMatter, attachments: ['report.pdf'] } }, undefined, opts,
    { projects: [], actions: [], backlinks: [artifactHandle(other, 'notes.md')] }, { kind: 'pdf', url: '/data/report.pdf' });
  check('sole attachment uses the existing file preview with artifact identity', fileArtifact.querySelector('iframe')?.getAttribute('src') === '/data/report.pdf' && fileArtifact.querySelector('.asset-path')?.textContent === artifactHandle(id));
  const fileBacklink = fileArtifact.querySelector<HTMLAnchorElement>('[data-section="Linked from"] + ul a');
  check('attachment backlinks show filename pills with their exact source handle', fileBacklink?.matches('.tag.tag-artifact') && fileBacklink.querySelector('svg') && fileBacklink.textContent === 'notes.md' && fileBacklink.title === artifactHandle(other, 'notes.md'));
  fileBacklink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  check('attachment backlink pills open the exact source attachment', calls.at(-1)?.id === other && calls.at(-1)?.filename === 'notes.md');
  const listedFile = fileArtifact.querySelector<HTMLAnchorElement>('[data-section="Attachments"] + ul a');
  check('selected file is listed with its exact name and canonical handle', listedFile?.textContent === 'report.pdf' && listedFile.title === artifactHandle(id, 'report.pdf'));
  listedFile?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  check('listed attachment opens its direct file handle', calls.at(-1)?.id === id && calls.at(-1)?.filename === 'report.pdf');

  const files = { ...artifact, frontMatter: { ...artifact.frontMatter, attachments: ['report.pdf', filename, 'unused.md'] } };
  const collection = renderArtifactDetail(id, files, undefined, opts, undefined, { kind: 'pdf', url: '/data/report.pdf' });
  const listed = [...collection.querySelectorAll<HTMLAnchorElement>('[data-section="Attachments"] + ul a')];
  check('multiple indexed attachments are browsable without an inline reference', listed.length === 3 && listed.every((link, index) => link.textContent === files.frontMatter.attachments[index] && link.title === artifactHandle(id, files.frontMatter.attachments[index])));
  check('multiple files do not retain an old preview or fetch attachment contents', !collection.querySelector('iframe, img, audio, video') && collection.querySelector('.rendered-content')?.textContent === '');
  const withBody = renderArtifactDetail(id, { ...files, body: 'Current document.', frontMatter: { ...files.frontMatter, attachments: ['report.pdf'] } }, undefined, opts, undefined, { kind: 'pdf', url: '/data/report.pdf' });
  check('Markdown body takes precedence over a sole attachment', withBody.querySelector('.rendered-content')?.textContent?.trim() === 'Current document.' && !withBody.querySelector('iframe'));
  check('body content retains supporting attachment links', withBody.querySelector('[data-section="Attachments"] + ul a')?.textContent === 'report.pdf');

  let imageArtifact = { ...artifact, frontMatter: { ...artifact.frontMatter, attachments: [filename] } };
  const imageOpts = { ...opts, artifactFileUrl: (value: string, file?: string) => {
    if (value !== id) return null;
    const selected = file ?? artifactContentFilename(imageArtifact);
    return selected === undefined ? null : `/data/${encodeURIComponent(selected)}`;
  } };
  const rootImage = () => entry(`![Architecture](${artifactHandle(id)})`, imageOpts).querySelector<HTMLImageElement>('img');
  const implicitImage = rootImage();
  check('root image handle embeds sole file content with stable identity', implicitImage?.getAttribute('src') === `/data/${encodeURIComponent(filename)}` && implicitImage.dataset.artifactHandle === artifactHandle(id));
  imageArtifact.frontMatter.attachments = [filename, 'chart.png'];
  check('adding a second attachment removes root image selection', !rootImage()?.hasAttribute('src'));
  imageArtifact.frontMatter.attachments = ['replacement.png'];
  check('changing the sole attachment updates the root image', rootImage()?.getAttribute('src') === '/data/replacement.png');
  imageArtifact.body = 'Current document.';
  check('adding a body removes root image selection', !rootImage()?.hasAttribute('src'));
  check('direct attachment images remain available with a body', entry(`![Architecture](${artifactHandle(id, filename)})`, imageOpts).querySelector('img')?.getAttribute('src') === `/data/${encodeURIComponent(filename)}`);
  imageArtifact.body = '';
  imageArtifact.frontMatter.attachments = [];
  check('removing the indexed attachment removes root image selection', !rootImage()?.hasAttribute('src'));
  const sourceEntry = '2026-10-02T10:00';
  const entryScoped = renderArtifactDetail(id, artifact, undefined,
    { ...opts, activeFilter: { type: 'entry', id: '2026-10-02T12:00' } },
    { projects: [], actions: [], backlinks: [`#entry/${sourceEntry}`] });
  const entryBacklink = entryScoped.querySelector<HTMLAnchorElement>('[data-section="Linked from"] + ul a');
  check('entry backlinks use the shared pill label, icon, and hover identity', entryBacklink?.matches('.tag.tag-entry') && entryBacklink.querySelector('svg') && entryBacklink.querySelector('.tag-text')?.textContent === opts.resolveName('entry', sourceEntry) && entryBacklink.dataset.refType === 'entry' && entryBacklink.dataset.refId === sourceEntry && entryBacklink.title === `#entry/${sourceEntry}`);
  const entryHref = entryBacklink?.getAttribute('href');
  const entryRoute = entryHref && parseRoute(entryHref.replace(/^\//, ''));
  check('entry backlinks leave entry-detail scope in native hrefs', entryRoute && entryRoute.filter === null && entryRoute.doc === null && entryRoute.jump === sourceEntry);
  const projectScoped = renderArtifactDetail(id, artifact, undefined, opts,
    { projects: [], actions: [], backlinks: [`#entry/${sourceEntry}`] });
  const projectHref = projectScoped.querySelector('a')?.getAttribute('href');
  const projectRoute = projectHref && parseRoute(projectHref.replace(/^\//, ''));
  check('entry backlink hrefs preserve a project timeline scope', projectRoute && projectRoute.filter?.type === 'project' && projectRoute.filter.id === opts.activeFilter!.id && projectRoute.jump === sourceEntry);
  const clicked: { type: string; id: string }[] = [];
  const sourceProject = '2026-10-02-product';
  const sourceAction = '2026-10-02-review';
  const pillSources = renderArtifactDetail(id, artifact, undefined, {
    ...opts, resolveName: (_type, value) => value === sourceProject ? 'Product' : 'Review',
    refMarks: (type) => type === 'action' ? ['done'] : [],
    onTagClick: (ref) => clicked.push(ref),
  }, { projects: [], actions: [], backlinks: [`#project/${sourceProject}`, `#action/${sourceAction}`, artifactHandle(other)] });
  const sourcePills = [...pillSources.querySelectorAll<HTMLAnchorElement>('[data-section="Linked from"] + ul a')];
  check('project and action backlink pills retain names, active state, and lifecycle marks', sourcePills[0].matches('.tag.tag-project.is-active') && sourcePills[0].querySelector('.tag-text')?.textContent === 'Product' && sourcePills[1].matches('.tag.tag-action.tag-status-done.tag-status-closed') && sourcePills[1].querySelector('.tag-text')?.textContent === 'Review');
  check('artifact backlink pills resolve their name and retain the canonical handle', sourcePills[2].matches('.tag.tag-artifact') && sourcePills[2].textContent === 'Related document' && sourcePills[2].title === artifactHandle(other));
  sourcePills[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  check('entity backlink pills retain primary-click navigation', clicked.at(-1)?.type === 'action' && clicked.at(-1)?.id === sourceAction);
  const beforeModified = clicked.length;
  let preventedModified = true;
  sourcePills[1].addEventListener('click', (event) => { preventedModified = event.defaultPrevented; event.preventDefault(); }, { once: true });
  sourcePills[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
  check('entity backlink pills retain native modifier-click navigation', clicked.length === beforeModified && !preventedModified);
  const actionRoute = parseRoute(sourcePills[1].getAttribute('href')!.replace(/^\//, ''));
  check('entity backlink hrefs open the source filtered view', actionRoute.filter?.type === 'action' && actionRoute.filter.id === sourceAction && actionRoute.doc === null);
  const attachment = renderArtifactDetail(id, artifact, undefined, opts, undefined,
    { kind: 'markdown', text: `---\nowner: "${artifactHandle(other)}"\n---\n\nBody ${artifactHandle(id)}.` }, 'notes.md');
  check('attachment title and parent name stay distinct', attachment.querySelector('h2')?.textContent === 'notes.md' && attachment.querySelector('.artifact-parent a')?.textContent === 'Design review');
  check('attachment metadata does not render as inline content', !attachment.textContent?.includes('owner:') && attachment.querySelectorAll('.rendered-content a.artifact-link').length === 1);
  const binary = renderArtifactDetail(id, artifact, undefined, opts, undefined, { kind: 'binary', url: '/data/archive.zip' }, 'archive.zip');
  check('binary download retains the full exact filename', binary.querySelector('a.asset-download')?.getAttribute('download') === 'archive.zip');
  return { checks, failures };
}

(window as Window & { validateArtifactRendering?: typeof validateArtifactRendering }).validateArtifactRendering = validateArtifactRendering;
