import {describe, expect, it} from 'vitest';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, posix} from 'node:path';
import ts from 'typescript';
import {sourceAccessSites} from './support/source-ownership-architecture.js';

const root = join(import.meta.dirname, '../src');
const featureAdapter = /^(?:automation|commands|mcp|graphql|semantic|web)(?:\/|$)/;
const ownerOrRuntime = /^(?:source|storage|runtime|daemon)(?:\/|$)/;
const featureRoots = ['automation', 'commands', 'graphql', 'mcp', 'runtime', 'semantic', 'web'];
const lifecycleCoordinator = /^daemon\/(?:instance-lifecycle|calendar-lifecycle|semantic-lifecycle)$/;
const pureCoreFiles = [...['metadata', 'description', 'yaml', 'text', 'automation-edits', 'link-edits', 'execution-context', 'catalogue']
  .map(file => `core/${file}.ts`), 'semantic/types.ts'];

function files(directory: string): string[] {
  return readdirSync(join(root, directory), {withFileTypes: true}).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(file) : file.endsWith('.ts') ? [file] : [];
  });
}

/** Include type-only dependencies and re-exports: neither may hide a reversed
 * ownership edge. Dynamic imports must have an inspectable module specifier. */
function dependencyErrors(file: string, text: string, boundary: 'source' | 'pure' | 'feature' = 'source'): string[] {
  const document = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errors: string[] = [];
  const feature = boundary === 'feature';
  const noTimers = feature && (file.startsWith('semantic/')
    || file.startsWith('mcp/calendar/') && !['mcp/calendar/client.ts', 'mcp/calendar/lock.ts'].includes(file));
  const check = (node: ts.Node, module: ts.Expression | undefined) => {
    const location = `${file}:${document.getLineAndCharacterOfPosition(node.getStart(document)).line + 1}`;
    if (!module || !(ts.isStringLiteral(module) || ts.isNoSubstitutionTemplateLiteral(module))) {
      errors.push(`${location}: module dependency must use a literal specifier`);
      return;
    }
    const target = module.text.startsWith('.')
      ? posix.normalize(posix.join(dirname(file), module.text)).replace(/\.[cm]?[jt]s$/, '')
      : module.text.replace(/^node:/, '');
    // These existing automation validators are pure domain transforms. Keep
    // the exception tied to their one shared authoring caller.
    const pureAutomation = boundary === 'pure' && file === 'core/automation-edits.ts'
      && ['automation/declaration', 'automation/schedule'].includes(target);
    if (feature ? lifecycleCoordinator.test(target) || noTimers && /^timers(?:\/|$)/.test(target)
      : featureAdapter.test(target) && !pureAutomation
        || boundary === 'pure' && (ownerOrRuntime.test(target) || /^(?:fs(?:\/|$)|chokidar$)/.test(target))) {
      errors.push(`${location}: forbidden dependency on ${target}`);
    }
  };
  const visit = (node: ts.Node) => {
    // These operation adapters may request owner work, but cannot own timer
    // capabilities, including captured globals or namespaced timer aliases.
    if (noTimers && (ts.isIdentifier(node) || ts.isStringLiteral(node))
      && /^(?:set|clear)(?:Timeout|Interval)$/.test(node.text)) {
      errors.push(`${file}:${document.getLineAndCharacterOfPosition(node.getStart(document)).line + 1}: timers belong to lifecycle management`);
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node, node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) check(node, node.moduleReference.expression);
    else if (ts.isImportTypeNode(node)) {
      check(node, ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) ? node.argument.literal : undefined);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === 'require')) check(node, node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(document);
  return errors;
}

describe('source layer architecture', () => {
  it('keeps source storage independent of feature and protocol adapters', () => {
    const owners = [...files('source'), 'daemon/instance-operations.ts'];
    expect(owners.flatMap(file => dependencyErrors(file, readFileSync(join(root, file), 'utf8')))).toEqual([]);
  });

  it('keeps shared metadata transforms independent of source I/O and MCP', () => {
    expect(pureCoreFiles.flatMap(file => dependencyErrors(file, readFileSync(join(root, file), 'utf8'), 'pure'))).toEqual([]);
    expect(pureCoreFiles.flatMap(file => sourceAccessSites(file, readFileSync(join(root, file), 'utf8')))).toEqual([]);
  });

  it('keeps feature code independent of lifecycle coordinators and their retry scheduling', () => {
    expect(featureRoots.flatMap(files).flatMap(file => dependencyErrors(file, readFileSync(join(root, file), 'utf8'), 'feature'))).toEqual([]);
  });

  it.each([
    'mcp/store.ts', 'mcp/artifact-source.ts', 'mcp/recurrence-history.ts',
    'mcp/tools/front-matter.ts', 'mcp/tools/index-file.ts', 'mcp/tools/serialize.ts', 'mcp/tools/mutation-result.ts',
    'mcp/tools/automation-edits.ts', 'mcp/tools/link-edits.ts', 'mcp/tools/yaml.ts', 'automation/execution-context.ts',
    'semantic/reconciler.ts', 'web/catalogue.ts',
  ])('does not restore the historical owner path or a compatibility shim: %s', file => {
    expect(existsSync(join(root, file))).toBe(false);
  });

  it.each([
    "import {formatScalar} from '../mcp/format.js';",
    "import type {GraphQLResult} from '../graphql/schema.js';",
    "import {SemanticSearchService} from '../semantic/search.js';",
    "import {AutomationController} from '../automation/controller.js';",
    "import {init} from '../commands/init.js';",
    "export {availableInstances} from '../web/catalogue.js';",
    "export type {AvailableInstance} from '../web/catalogue.js';",
    "async function load(){return import('../mcp/store.js');}",
    "const server = require('../mcp/server.js');",
    "import server = require('../mcp/server.js');",
    "type Query = import('../graphql/query.js').QueryView;",
  ])('rejects a dependency from an owner back into an adapter: %s', source => {
    expect(dependencyErrors('source/new-owner.ts', source)).toEqual([expect.stringContaining('forbidden dependency')]);
  });

  it.each([
    "import {readFileSync} from 'node:fs';",
    "import type {Store} from '../source/store.js';",
    "import {assertExecutionCwd} from '../runtime/execution-cwd.js';",
  ])('rejects I/O dependencies in shared pure transforms: %s', source => {
    expect(dependencyErrors('core/new-transform.ts', source, 'pure')).toEqual([expect.stringContaining('forbidden dependency')]);
  });

  it.each([
    "import {InstanceSemanticLifecycle} from '../daemon/semantic-lifecycle.js';",
    "import type {InstanceLifecycleFeature} from '../daemon/instance-lifecycle.js';",
    "export {InstanceCalendarLifecycle} from '../daemon/calendar-lifecycle.js';",
    "const owner = require('../daemon/semantic-lifecycle.js');",
    "async function load(){return import('../daemon/calendar-lifecycle.js');}",
  ])('rejects lifecycle coordinator dependencies from features: %s', source => {
    expect(dependencyErrors('semantic/new-feature.ts', source, 'feature')).toEqual([expect.stringContaining('forbidden dependency')]);
  });

  it.each([
    'setTimeout(() => reconcile(snapshot), 1000);',
    'const later = setTimeout; later(reconcile, 1000);',
    'globalThis.setInterval(reconcile, 1000);',
    "globalThis['setTimeout'](reconcile, 1000);",
    "import {setTimeout as later} from 'node:timers'; later(reconcile, 1000);",
    "import * as clock from 'node:timers/promises'; clock.setTimeout(1000).then(reconcile);",
  ])('rejects instance retry timers inside semantic and Calendar operation adapters: %s', source => {
    for (const file of ['semantic/new-feature.ts', 'mcp/calendar/sync.ts', 'mcp/calendar/recurrence-sync.ts']) {
      expect(dependencyErrors(file, source, 'feature')).toEqual(expect.arrayContaining([
        expect.stringMatching(/timers belong to lifecycle|forbidden dependency on timers/),
      ]));
    }
  });

  it('allows bounded external requests and owner retry notifications in feature adapters', () => {
    expect(dependencyErrors('mcp/calendar/sync.ts', `
      const signal = AbortSignal.timeout(5000);
      await helper.request({signal});
      requestReconciliation({reason: 'outbox'});
    `, 'feature')).toEqual([]);
  });

  it.each([
    "import {checkoutInfo} from './worktree.js'; function catalogue(root){return checkoutInfo(root);}",
    "import {readManifestResult} from './instance.js'; function catalogue(root){return readManifestResult(root);}",
  ])('detects indirect file inspection in a shared pure catalogue: %s', source => {
    expect(sourceAccessSites('core/catalogue.ts', source)).toHaveLength(1);
  });

  it('rejects an opaque dynamic dependency in source storage', () => {
    expect(dependencyErrors('source/new-owner.ts', 'async function load(path){return import(path);}'))
      .toEqual([expect.stringContaining('literal specifier')]);
  });

  it('allows domain models, source adapters, and shared storage in source code', () => {
    expect(dependencyErrors('source/new-owner.ts', `
      import type {Action} from '../core/types.js';
      import {writeFileCrashSafe} from '../storage/atomic-file.js';
      import {Store} from './store.js';
    `)).toEqual([]);
  });
});
