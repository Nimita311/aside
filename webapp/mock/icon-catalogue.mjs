import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const defaultWebappDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const labels = {
  instance: 'Instance', entry: 'Entry', project: 'Project', action: 'Action', asset: 'Artifact / file', date: 'Date',
  WAITING_CLOCK: 'Slipped clock', EMPTY_SLOT: 'Backlog slot', OPEN_DETAIL_ICON: 'Open details',
  CALENDAR_OFF_ICON: 'Calendar unavailable', WARNING_ICON: 'Instance warning', WORKTREE_ICON: 'Git worktree',
  ARROW_UP: 'Previous period', ARROW_DOWN: 'Next period',
  'btn-instance-switch': 'Instance menu', 'connection-status': 'Offline connection', 'btn-settings': 'Settings',
  'btn-theme-toggle': 'Theme', 'btn-add-instance': 'Add instance', 'btn-panel-retract': 'Retract panel',
  'btn-panel-close': 'Close', 'btn-doc-close': 'Close', 'btn-modal-close': 'Close', remove: 'Forget instance',
};
const humanize = name => name.replace(/^btn-/, '').replace(/_ICON$/, '').replace(/[-_]+/g, ' ')
  .toLowerCase().replace(/^./, letter => letter.toUpperCase());

// Ignore only accessibility metadata. Native size, strokes, fill, and geometry
// remain in the key: the same path at 9px and 18px are distinct app specimens.
function geometryKey(svg) {
  return svg.replace(/<\/?[a-z][^>]*>/gi, tag => {
    const match = /^<(\/?)([\w:-]+)([\s\S]*?)(\/?)>$/.exec(tag);
    if (!match) return tag;
    const [, closing, name, body, selfClosing] = match;
    const attributes = [...body.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .filter(([, key]) => !/^aria-/i.test(key) && !['role', 'focusable', 'tabindex'].includes(key.toLowerCase()))
      .map(([, key, double, single]) => [key, (double ?? single).trim().replace(/\s+/g, ' ')])
      .sort(([a], [b]) => a.localeCompare(b));
    return `<${closing}${name}${attributes.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`).join('')}${selfClosing}>`;
  }).replace(/>\s+</g, '><').trim();
}

function staticText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left), right = staticText(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
}

function expressionLabel(node) {
  for (let current = node; current; current = current.parent) {
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(current.left)) {
      const receiver = current.left.expression.getText();
      if (labels[receiver]) return labels[receiver];
    }
    if ((ts.isVariableDeclaration(current) || ts.isPropertyAssignment(current)) && current.name) {
      const name = current.name.getText().replace(/^['"]|['"]$/g, '');
      return labels[name] ?? humanize(name);
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      if (current.name.text === 'showNotice') return 'Notice warning';
      if (current.name.text === 'render') return 'Close instance';
      return humanize(current.name.text);
    }
  }
  return 'Interface icon';
}

function htmlLabel(text, offset) {
  const prefix = text.slice(0, offset);
  const button = [...prefix.matchAll(/<button\b([^>]*)>/gi)].at(-1);
  if (button && !prefix.slice(button.index).includes('</button>')) {
    const attribute = name => new RegExp(`\\b${name}="([^"]*)"`).exec(button[1])?.[1];
    const id = attribute('id');
    return labels[id] ?? attribute('aria-label') ?? attribute('title') ?? humanize(id ?? 'Interface icon');
  }
  return 'Interface icon';
}

async function discover(directory, files, directories) {
  directories.push(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await discover(filename, files, directories);
    else if (/\.tsx?$/.test(entry.name)) files.push(filename);
  }
}

/** Read actual production sources on every build; no copied icon paths live here. */
export async function collectProductionIcons({ webappDir = defaultWebappDir } = {}) {
  const files = [], directories = [];
  await discover(path.join(webappDir, 'src'), files, directories);
  files.push(path.join(webappDir, 'index.html'));
  files.sort();
  const collected = new Map();
  const add = (svg, label, filename, line) => {
    const key = geometryKey(svg);
    const source = `${path.relative(webappDir, filename).split(path.sep).join('/')}:${line}`;
    const existing = collected.get(key);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    collected.set(key, { id: `${slug}-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`, label, svg, sources: [source] });
  };
  for (const filename of files) {
    const text = await readFile(filename, 'utf8');
    if (filename.endsWith('.html')) {
      for (const match of text.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
        add(match[0], htmlLabel(text, match.index), filename, text.slice(0, match.index).split('\n').length);
      }
      continue;
    }
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    const visit = node => {
      const value = staticText(node);
      if (value !== undefined && value.includes('<svg') && staticText(node.parent) === undefined) {
        for (const match of value.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
          add(match[0], expressionLabel(node), filename, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { icons: [...collected.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)), files, directories };
}

export function iconCataloguePlugin(options = {}) {
  return {
    name: 'production-icon-catalogue',
    setup(build) {
      build.onResolve({ filter: /^mock:icons$/ }, () => ({ path: 'catalogue', namespace: 'mock-icons' }));
      build.onLoad({ filter: /.*/, namespace: 'mock-icons' }, async () => {
        const { icons, files, directories } = await collectProductionIcons(options);
        return { contents: `export default ${JSON.stringify(icons)};`, loader: 'js', watchFiles: files, watchDirs: directories };
      });
    },
  };
}
