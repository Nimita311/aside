import {describe, expect, it} from 'vitest';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
import {checkSourceAccess, type SourceAccessException, type SourceAccessSite} from './support/source-ownership-architecture.js';

const root = join(import.meta.dirname, '../src');
const feature = /^(?:automation|commands|graphql|mcp|runtime|semantic|web)\//;
const rawHealthCodes = /read_error|rebuild_failed|invalid_yaml|missing_field|unterminated_entry_block|artifact_attachment_read_error|artifact_reference_/g;
const exceptions: SourceAccessException[] = [
  {file: 'mcp/tools/query.ts', scope: 'handleQueryArtifacts', operations: {'source.getIssues': 1},
    reason: 'Copy published diagnostics into explicit query output; this does not classify operation readiness.'},
  {file: 'graphql/query.ts', scope: 'QuerySnapshot.constructor', operations: {'source.getIssues': 1},
    reason: 'Copy published diagnostics into the request snapshot for query response presentation.'},
  {file: 'mcp/instance-session.ts', scope: 'InstanceSession.formatInfo', operations: {'source.healthCode:read_error': 1},
    reason: 'Show the owner-reported manifest read problem next to a session instance label.'},
  {file: 'mcp/instance-session.ts', scope: 'InstanceSession.instances', operations: {'source.healthCode:read_error': 1},
    reason: 'Filter unreadable labels and omit optional issue inspection in the session listing; authoritative instance eligibility remains with the daemon.'},
];

function scopeAt(node: ts.Node): string {
  const names: string[] = [];
  const name = (value: ts.PropertyName | ts.BindingName | undefined) => value && (ts.isIdentifier(value) || ts.isStringLiteral(value)) ? value.text : undefined;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isClassDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
      const label = name(current.name); if (label) names.unshift(label);
    } else if (ts.isConstructorDeclaration(current)) names.unshift('constructor');
    else if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
        const label = name(parent.name); if (label) names.unshift(label);
      }
    }
  }
  return names.join('.') || '<module>';
}

/** Scan every feature helper, so moving a classifier cannot avoid the boundary.
 * These are static capability review gates; runtime contracts verify behavior. */
function healthAccessSites(file: string, text: string): SourceAccessSite[] {
  if (!feature.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: SourceAccessSite[] = [];
  const add = (node: ts.Node, operation: string) => sites.push({file, scope: scopeAt(node), operation,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1});
  const visit = (node: ts.Node) => {
    // Getter invocation, alias capture, destructuring, and type capabilities all
    // need the same reviewed presentation exception.
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text === 'getIssues') add(node, 'source.getIssues');
      if (node.text === 'sourceHealthPublication') add(node, 'source.healthClassifier');
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isRegularExpressionLiteral(node)) {
      for (const match of node.text.matchAll(rawHealthCodes)) add(node, `source.healthCode:${match[0]}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}
const healthBoundaryErrors = (file: string, text: string, permitted: SourceAccessException[] = []) =>
  checkSourceAccess(healthAccessSites(file, text), permitted);
function files(directory = ''): string[] {
  return readdirSync(join(root, directory), {withFileTypes: true}).flatMap(entry => {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('source health ownership boundary', () => {
  it('requires all feature helpers to consume published health with only scoped presentation exceptions', () => {
    const sites = files().flatMap(file => healthAccessSites(file, readFileSync(join(root, file), 'utf8')));
    expect(checkSourceAccess(sites, exceptions)).toEqual([]);
  });
  it.each([
    "store.getIssues().find(issue => issue.code === 'invalid_yaml');",
    "const issues = store.getIssues.bind(store); issues();",
    "const {getIssues: issues} = store; issues();",
    "store['getIssues']().some(issue => issue.code === 'read_error');",
    "const incomplete = new Set(['read_error', 'rebuild_failed']);",
    "store[`getIssues`]();",
    "const incomplete = new Set([`invalid_yaml`]);",
    "import {sourceHealthPublication as classify} from '../source/source-health.js'; classify(root, issues, files);",
    "store.getRecordIssues('action', id).find(issue => /invalid_yaml|read_error/.test(issue.code));",
    "issues.filter(issue => !issue.code.startsWith('artifact_reference_'));",
  ])('rejects raw source-health policy even after moving it into another feature helper: %s', text => {
    for (const file of ['semantic/health.ts', 'mcp/calendar/sync.ts', 'graphql/source-check.ts', 'automation/source-check.ts', 'mcp/tools/helper.ts', 'web/source-check.ts']) {
      expect(healthBoundaryErrors(file, text)).not.toEqual([]);
    }
  });
  it.each([
    "const {complete, issue} = store.getSourceHealth(); if (!complete) throw new Error(issue?.message);",
    "const issue = store.getRecordSourceHealth('artifact', id).issues.find(issue => issue.severity === 'error');",
    "store.getRecordIssues('action', id).find(issue => /recurrence|occurrence/.test(issue.code));",
    "const diagnostics = store.getManifestSourceHealth(); render(diagnostics.issue?.message);",
  ])('allows owner health and feature domain validation: %s', text => {
    expect(healthBoundaryErrors('graphql/source-check.ts', text)).toEqual([]);
  });
  it('permits only the approved presentation scope, count and code', () => {
    const approved = exceptions.filter(item => item.file === 'mcp/tools/query.ts' && item.scope === 'handleQueryArtifacts');
    const presentation = 'function handleQueryArtifacts(store){return {issues:store.getIssues()};}';
    expect(healthBoundaryErrors('mcp/tools/query.ts', presentation, approved)).toEqual([]);
    expect(healthBoundaryErrors('mcp/tools/helper.ts', presentation, approved)).not.toEqual([]);
    expect(healthBoundaryErrors('mcp/tools/query.ts', presentation.replace('handleQueryArtifacts', 'readiness'), approved)).not.toEqual([]);
    expect(healthBoundaryErrors('mcp/tools/query.ts', presentation.replace('return {', 'store.getIssues(); return {'), approved)).not.toEqual([]);
    expect(healthBoundaryErrors('mcp/tools/query.ts', presentation.replace('store.getIssues()', 'store.getSourceHealth()'), approved)).not.toEqual([]);
    const label = exceptions.filter(item => item.scope === 'InstanceSession.formatInfo');
    const code = "class InstanceSession {formatInfo(){return issue.code === 'read_error';}}";
    expect(healthBoundaryErrors('mcp/instance-session.ts', code, label)).toEqual([]);
    expect(healthBoundaryErrors('mcp/instance-session.ts', code.replace('read_error', 'invalid_yaml'), label)).not.toEqual([]);
  });
});
