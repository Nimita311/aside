import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { collectProductionIcons, iconCataloguePlugin } from '../icon-catalogue.mjs';

describe('production icon source catalogue', () => {
  it('collects shipped SVGs with human names and source locations', async () => {
    const { icons, files, directories } = await collectProductionIcons();
    expect(icons.map(icon => icon.label)).toEqual(expect.arrayContaining(['Instance', 'Project', 'Backlog slot', 'Slipped clock', 'Open details', 'Settings']));
    for (const icon of icons) {
      expect(icon.svg).toMatch(/^<svg\b[\s\S]*<\/svg>$/);
      expect(icon.sources.length).toBeGreaterThan(0);
      expect(icon.sources.every(source => /^(?:src\/.*\.tsx?|index\.html):\d+$/.test(source))).toBe(true);
    }
    expect(files.some(file => file.endsWith('index.html'))).toBe(true);
    expect(directories.some(directory => directory.endsWith('/src'))).toBe(true);
  });

  it('deduplicates formatting while preserving native size/stroke variants and discovers later source files', async () => {
    const webappDir = await mkdtemp(path.join(os.tmpdir(), 'aside-icon-catalogue-'));
    try {
      await mkdir(path.join(webappDir, 'src'));
      await writeFile(path.join(webappDir, 'index.html'), '<button id="btn-settings"><svg width="12" height="12" stroke-width="2"><path d="M0 0L1 1"/></svg></button>');
      await writeFile(path.join(webappDir, 'src/icons.ts'), String.raw`const ICONS = { project: '<svg height="12" stroke-width="2" width="12">\n<path d="M0 0L1 1"/>\n</svg>' };`);
      const initial = await collectProductionIcons({ webappDir });
      expect(initial.icons).toHaveLength(1);
      expect(initial.icons[0].sources).toHaveLength(2);
      await mkdir(path.join(webappDir, 'src/new'));
      await writeFile(path.join(webappDir, 'src/new/sizes.ts'), `const LARGE = '<svg width="24" height="24" stroke-width="2">' + '<path d="M0 0L1 1"/></svg>'; const HEAVY = '<svg width="12" height="12" stroke-width="3"><path d="M0 0L1 1"/></svg>';`);
      const modified = await collectProductionIcons({ webappDir });
      expect(modified.icons).toHaveLength(3);
      expect(modified.directories).toContain(path.join(webappDir, 'src/new'));
      expect(modified.files).toContain(path.join(webappDir, 'src/new/sizes.ts'));

      const result = await build({ stdin: { contents: "import icons from 'mock:icons'; export default icons;" }, bundle: true,
        write: false, format: 'esm', plugins: [iconCataloguePlugin({ webappDir })], logLevel: 'silent' });
      const bundled = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
      expect(bundled.default).toEqual(modified.icons);
    } finally { await rm(webappDir, { recursive: true, force: true }); }
  });
});
