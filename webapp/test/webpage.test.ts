// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderAssetDetail, renderArtifactDetail, renderEntryDetail, type RenderOptions } from '../src/render';
import { webpageSources } from '../src/webpage';

const id = '2026-10-02-dashboard';
const opts: RenderOptions = {
  timeFormat: '24h', now: '2026-10-02T12:00', nowDate: new Date('2026-10-02T12:00'),
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, value) => value, onTagClick: () => {}, onAssetClick: () => {},
  onEntryTimeClick: () => {}, routeHref: route => route, refMarks: () => [],
  assetFileUrl: path => `http://localhost/files/${path.split('/').map(encodeURIComponent).join('/')}`,
  artifactFileUrl: (value, filename) => filename ? `http://localhost/files/artifacts/${value}/${encodeURIComponent(filename)}` : null,
};
const entry = (content: string, options = opts) => renderEntryDetail({
  meta: { created: opts.now }, weekFile: '2026-09-28', content: `Page example.\n\n${content}`,
}, options);
// Browser isolation is checked in real-browser QA. The DOM shim must not
// navigate authored destinations while parsing inert template fixtures.
beforeEach(() => {
  (window as unknown as { happyDOM: { settings: { navigation: { disableChildFrameNavigation: boolean } } } })
    .happyDOM.settings.navigation.disableChildFrameNavigation = true;
});
afterEach(() => document.body.replaceChildren());

describe('webpage previews', () => {
  it('embeds a sole HTML attachment and an explicit attachment with the same isolation', () => {
    const artifact = { frontMatter: { name: 'Dashboard', created: opts.now, attachments: ['index.html'] }, body: '' };
    for (const filename of [undefined, 'index.html']) {
      const root = renderArtifactDetail(id, artifact, undefined, opts, undefined,
        { kind: 'webpage', url: 'http://localhost/files/index.html' }, filename);
      const frame = root.querySelector('iframe')!;
      expect(frame.getAttribute('src')).toBe('http://localhost/files/index.html');
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(frame.title).toBe('index');
    }
  });

  it('supports non-addressable HTML sources without executing their markup in the host', () => {
    const html = '<h1>Dashboard</h1><script>window.dashboard = true;</script>';
    const root = renderAssetDetail('assets/index.html', { kind: 'webpage', text: html }, opts, []);
    const frame = root.querySelector('iframe')!;
    expect(frame.srcdoc).toBe(html);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(root.querySelector('script')).toBeNull();
  });

  it('replaces authored iframe privileges, handlers and source documents', () => {
    const root = entry('<iframe src="https://example.com/dashboard" title="Metrics" height="450" '
      + 'sandbox="allow-same-origin allow-popups allow-top-navigation" allow="camera; microphone" '
      + 'srcdoc="<script>unsafe()</script>" onload="unsafe()" style="position:fixed" data-entry-id="fake"></iframe>');
    const frame = root.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('https://example.com/dashboard');
    expect(frame.title).toBe('Metrics');
    expect(frame.style.height).toBe('450px');
    expect(frame.style.position).toBe('');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('loading')).toBe('lazy');
    expect(frame.hasAttribute('allow')).toBe(false);
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.hasAttribute('onload')).toBe(false);
    expect(frame.hasAttribute('data-entry-id')).toBe(false);
  });

  it('resolves relative pages and artifact attachments against the containing instance', () => {
    const root = entry(`<iframe src="../../assets/my%20page.html"></iframe>\n\n<iframe src="#artifact/${id}/index.html"></iframe>`);
    expect([...root.querySelectorAll('iframe')].map(frame => frame.getAttribute('src'))).toEqual([
      'http://localhost/files/assets/my%20page.html', `http://localhost/files/artifacts/${id}/index.html`,
    ]);
    const unresolved = entry('<iframe src="../../assets/index.html"></iframe>', { ...opts, assetFileUrl: undefined });
    expect(unresolved.querySelector('iframe')).toBeNull();
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>unsafe()</script>', 'file:///etc/passwd',
    '//example.com/page', '../../../outside.html', 'https://user:password@example.com/', 'https://[invalid'])('rejects destination %s', src => {
    expect(entry(`<iframe src="${src}"></iframe>`).querySelector('iframe')).toBeNull();
  });

  it('does not activate source documents or iframe examples quoted in code', () => {
    expect(entry('<iframe srcdoc="<h1>Inline page</h1>"></iframe>').querySelector('iframe')).toBeNull();
    const code = '<iframe src="https://example.com/"></iframe>';
    const root = entry(`\`${code}\`\n\n\`\`\`html\n${code}\n\`\`\``);
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('code')?.textContent).toBe(code);
  });

  it('tracks only renderer-owned local frames for refresh', () => {
    const root = entry(`<iframe src="#artifact/${id}/index.html"></iframe>\n\n<iframe src="https://example.com/page"></iframe>`);
    expect(webpageSources(root)).toEqual([
      { path: `artifacts/2026/${id}/index.html`, artifactId: id },
      { path: undefined, artifactId: undefined },
    ]);
    const forged = document.createElement('iframe');
    forged.className = 'asset-webpage'; forged.dataset.artifactHandle = `#artifact/${id}/other.html`;
    root.append(forged);
    expect(webpageSources(root)).toHaveLength(2);
  });
});
